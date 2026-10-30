// Grab browser extension: pairing, cookies, and URL handoff.
// Loaded by background.js (Chrome importScripts) or listed before it
// in manifest.firefox.json; all files share one global scope.

/// Grab's local HTTP server. The extension POSTs URLs here instead of using
/// native messaging — no host manifest, no extension IDs, works from Flatpak.
const GRAB_BASE_URL = "http://127.0.0.1:9412";
const GRAB_HTTP_URL = `${GRAB_BASE_URL}/add`;

/// Delays before retrying when Grab answers 429 (its handoff queue is full).
const HANDOFF_RETRY_DELAYS_MS = [300, 900];

/// Grab holds a `?confirm=1` request until the user answers its dialog (it
/// gives up after 120 s); wait a little longer than that.
const CONFIRM_TIMEOUT_MS = 130_000;
/// A pairing handshake is a loopback round trip.
const HELLO_TIMEOUT_MS = 3_000;

/// Launches Grab in a temporary background tab without handing it a download.
/// A cold start cannot use the grab:// URL fallback when cookies must travel —
/// that channel has no way to carry them. The user's current tab must remain
/// untouched when the cookie-bearing HTTP retry succeeds.
const GRAB_WAKE_URL = "grab://https/";
/// How long to wait for a cold-started Grab to answer its local server.
const WAKE_TIMEOUT_MS = 12_000;
const WAKE_POLL_MS = 250;

// Test hook: shorten the cold-start wait.
let wakeTimeoutMs = WAKE_TIMEOUT_MS;
function _setWakeTimeout(ms) {
  wakeTimeoutMs = ms;
}

const MAX_HANDOFF_COOKIES = 100;
const MAX_HANDOFF_BODY_BYTES = 32 * 1024;

let sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Test hook: swap the sleep implementation to observe retry delays.
function _setSleep(fn) {
  sleep = fn;
}

// --- Pairing ---------------------------------------------------------------
//
// Any local process can listen on 127.0.0.1:9412 before Grab does. Once the
// user has pasted Grab's pairing code into the options page, the extension
//   1. makes Grab prove it knows the code (GET /hello) before anything else,
//   2. only then sends the page's cookies, and
//   3. signs the request body, so Grab can tell this extension from any other.
// Without a code it still hands URLs off, but never sends cookies.

const SERVER_CONTEXT = "grab-server\u0000";
const CLIENT_CONTEXT = "grab-client\u0000";
// Shared pattern lives in shared.js.
const STATUS_UNVERIFIED = -1;
/// The POST was sent but the answer never arrived (timeout or connection
/// drop): Grab may have accepted it. Never fall back to grab:// here —
/// that would duplicate the download.
const STATUS_MAYBE_SENT = -2;

/// The pairing code lives in local storage, not sync: it is a secret for this
/// machine's Grab and must not follow the profile to other devices.
async function getPairingCode() {
  try {
    const { pairingCode } = await chrome.storage.local.get({ pairingCode: "" });
    const code = normalizePairingCode(pairingCode);
    return SHARED_PAIRING_CODE_RE.test(code) ? code : "";
  } catch {
    return "";
  }
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/// HMAC-SHA256(secret, context || message) as lowercase hex.
async function hmacHex(secretHex, context, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    hexToBytes(secretHex),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const data = new TextEncoder().encode(context + message);
  return bytesToHex(new Uint8Array(await crypto.subtle.sign("HMAC", key, data)));
}

function constantTimeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/// fetch() with a deadline.
async function fetchWithTimeout(url, opts, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/// GET a JSON body under one deadline. The controller covers the body read:
/// a listener that sends headers and then stalls must not hold a handoff open.
/// A malformed body yields null, which callers treat as unverified.
async function fetchJsonWithTimeout(url, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const resp = await fetch(url, { method: "GET", signal: controller.signal });
    if (!resp.ok) return { ok: false, body: null };
    try {
      return { ok: true, body: await resp.json() };
    } catch {
      return { ok: true, body: null };
    }
  } finally {
    clearTimeout(timer);
  }
}

/// True when the listener on Grab's port knows the pairing code. A squatter
/// without it cannot answer, and a Grab that regenerated its code fails too.
async function verifyGrab(secret) {
  const nonce = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
  const { ok, body } = await fetchJsonWithTimeout(
    `${GRAB_BASE_URL}/hello?n=${nonce}`,
    HELLO_TIMEOUT_MS,
  );
  if (!ok) return false;
  const expected = await hmacHex(secret, SERVER_CONTEXT, nonce);
  return constantTimeEqual(body && body.proof, expected);
}

/// Prefer cookies most likely to carry authentication when the 100-cookie
/// server cap forces a choice. The original order breaks ties deterministically.
function cookieRetentionPriority(cookie) {
  const name = typeof cookie?.name === "string" ? cookie.name : "";
  if (name.toLowerCase() === "cf_clearance") return 0;
  if (name.startsWith("__Host-")) return 1;
  if (name.startsWith("__Secure-")) return 2;
  if (
    /(session|sessid|auth|token|csrf|xsrf|login|jwt|clearance)/i.test(name) ||
    /(?:^|[^a-z0-9])sid(?:$|[^a-z0-9])/i.test(name)
  ) return 3;
  return 4;
}

function limitHandoffCookies(cookies) {
  return cookies
    .map((cookie, index) => ({ cookie, index }))
    .sort((a, b) =>
      cookieRetentionPriority(a.cookie) - cookieRetentionPriority(b.cookie) ||
      a.index - b.index
    )
    .slice(0, MAX_HANDOFF_COOKIES)
    .sort((a, b) => a.index - b.index)
    .map(({ cookie }) => cookie);
}

function serializeHandoffBody(url, cookies, userAgent, requestMetadata) {
  return JSON.stringify({
    url,
    cookies,
    user_agent: userAgent,
    ...(requestMetadata || {}),
  });
}

/// Fit a handoff body into the server's byte budget, dropping the least
/// valuable cookies first. Returns { body, count } (count = cookies actually
/// serialized) or null when even the URL alone is too large.
function fitHandoffBody(url, cookies, userAgent, requestMetadata) {
  const byteLength = (value) => new TextEncoder().encode(value).length;
  const fit = (body, count) =>
    byteLength(body) <= MAX_HANDOFF_BODY_BYTES ? { body, count } : null;
  let body = serializeHandoffBody(url, cookies, userAgent, requestMetadata);
  if (byteLength(body) <= MAX_HANDOFF_BODY_BYTES) {
    return fit(body, cookies.length);
  }

  const dropOrder = cookies
    .map((cookie, index) => ({
      index,
      priority: cookieRetentionPriority(cookie),
      size: byteLength(JSON.stringify(cookie)),
    }))
    .sort((a, b) =>
      b.priority - a.priority || b.size - a.size || b.index - a.index
    );
  const retained = new Set(cookies.map((_, index) => index));
  for (const candidate of dropOrder) {
    retained.delete(candidate.index);
    body = serializeHandoffBody(
      url,
      cookies.filter((_, index) => retained.has(index)),
      userAgent,
      requestMetadata
    );
    if (byteLength(body) <= MAX_HANDOFF_BODY_BYTES) break;
  }
  return fit(body, retained.size);
}

/// The cookies permission is optional and can be declined or revoked. When the
/// Permissions API is unavailable, assume it is granted and let the read decide.
async function hasCookiePermission() {
  if (typeof chrome.permissions?.contains !== "function") return true;
  try {
    return await chrome.permissions.contains({ permissions: ["cookies"] });
  } catch {
    return false;
  }
}

/// Read cookies in the shape Grab expects. Partitioned cookies are detected but
/// deliberately excluded: Grab's Netscape cookie jar cannot preserve their
/// partition key, so exporting them as ordinary cookies would widen their scope.
/// Errors propagate so the URL-only fallback can be accompanied by a warning.
async function readCookies(url, storeId, ctx) {
  const filter = storeId ? { url, storeId } : { url };
  let all;
  try {
    // With partitionKey={} modern browsers return partitioned and unpartitioned
    // cookies. Older browser versions may reject this filter; fall back to the
    // supported unpartitioned-only query.
    all = await chrome.cookies.getAll({ ...filter, partitionKey: {} });
  } catch {
    all = await chrome.cookies.getAll(filter);
  }

  const partitioned = all.filter((cookie) => cookie.partitionKey != null);
  if (partitioned.length > 0 && ctx && typeof ctx === "object" && !ctx.cookieWarning) {
    ctx.cookieWarning =
      `${partitioned.length} partitioned cookie(s) were not forwarded because Grab's cookie-file format cannot preserve their partition isolation.`;
  }
  const cookies = all.filter((cookie) => cookie.partitionKey == null).map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    host_only: c.hostOnly,
    path: c.path,
    secure: c.secure,
    expiration_date: c.expirationDate,
  }));
  return limitHandoffCookies(cookies);
}

/// Resolve the cookie store for a handoff context. Returns a store ID string,
/// undefined for the default store, or null when cookies must not be sent.
/// Incognito cookie forwarding is intentionally disabled. Firefox download items
/// carry cookieStoreId, preserving non-private container isolation without a
/// tab ID; Chrome tabs can still be resolved through their store list.
async function resolveStoreId(ctx) {
  if (ctx && ctx.incognito === true) return null;

  const explicitStoreId = ctx && ctx.cookieStoreId;
  if (typeof explicitStoreId === "string" && explicitStoreId) {
    return explicitStoreId;
  }

  const tabId = ctx && ctx.tabId;
  if (Number.isInteger(tabId) && tabId >= 0) {
    let tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      tab = undefined;
    }
    // A tab lookup can reveal a private context even when the caller lacked
    // incognito metadata; never read that store's cookies.
    if (tab && tab.incognito === true) return null;
    if (tab && tab.cookieStoreId) return tab.cookieStoreId; // Firefox containers.

    // Chrome: match the tab against the stores' tabIds.
    try {
      const stores = await chrome.cookies.getAllCookieStores();
      if (Array.isArray(stores)) {
        const match = stores.find(
          (s) => Array.isArray(s.tabIds) && s.tabIds.includes(tabId)
        );
        if (match) return match.id;
      }
    } catch {}
  }
  return undefined; // Default store.
}

/// POST one URL to Grab and wait for its answer to the confirm dialog.
/// Resolves to the HTTP status, 0 when Grab can't be reached (not running),
/// STATUS_UNVERIFIED when the listener could not prove it is Grab, or
/// STATUS_MAYBE_SENT when the POST may have reached Grab but the answer
/// was lost (timeout). The caller must not fall back to grab:// on
/// STATUS_MAYBE_SENT — that would risk a duplicate download.
async function postToGrab(url, ctx) {
  if (ctx && typeof ctx === "object") delete ctx.cookieWarning;
  // Match Grab's Rust String::len() check (UTF-8 bytes), avoiding a network
  // round trip for URLs that Grab will reject with HTTP 414.
  if (typeof url !== "string" || new TextEncoder().encode(url).length > MAX_GRAB_URL_BYTES) {
    return 414;
  }
  let secret;
  try {
    secret = await getPairingCode();
  } catch {
    return 0; // Storage unreachable; treat as Grab not running.
  }
  // Explicit sends may remain URL-only, but automatic interception must never
  // accept an unsigned POST if the user unpairs between the outer guard and here.
  if (ctx && ctx.requirePairing === true && !secret) return STATUS_UNVERIFIED;
  let cookies = [];
  if (secret) {
    let verified;
    try {
      verified = await verifyGrab(secret);
    } catch {
      return 0; // Grab not reachable.
    }
    if (!verified) return STATUS_UNVERIFIED;
    // Cookies let Grab's yt-dlp pass bot challenges (Cloudflare etc.).
    // They go only to a Grab that has proven it holds the pairing code.
    // Never export incognito cookies; retain Firefox container scoping for
    // ordinary downloads using DownloadItem.cookieStoreId.
    if (!(await hasCookiePermission())) {
      // Declined or revoked: URL only, and not an error, so no warning.
      cookies = [];
    } else try {
      const storeId = await resolveStoreId(ctx);
      if (storeId === null) {
        cookies = [];
        if (ctx && typeof ctx === "object") {
          ctx.cookieWarning = "Incognito cookie forwarding is disabled; Grab received the URL without cookies.";
        }
      } else {
        cookies = await readCookies(url, storeId, ctx);
      }
    } catch {
      cookies = [];
      if (ctx && typeof ctx === "object") {
        ctx.cookieWarning = "Grab could not read this site's cookies. Check the extension's optional Cookies permission or Firefox first-party isolation; the URL was sent without cookies.";
      }
    }
  }
  let body, headers, sentCookieCount = 0;
  try {
    // userAgent travels with the cookies: cf_clearance is UA-bound, so Grab
    // applies it to its HTTP client and yt-dlp alongside the jar.
    const userAgent =
      typeof navigator !== "undefined" && navigator.userAgent
        ? navigator.userAgent
        : undefined;
    // Preserve the URL and retain the highest-value auth cookies within the
    // payload budget; don't drop the whole jar as the first fallback.
    // Every authenticated POST gets fresh signed metadata. Retrying postToGrab
    // generates a new nonce, so a network retry can never replay an earlier body.
    const requestMetadata = secret
      ? {
          timestamp_ms: Date.now(),
          nonce: bytesToHex(crypto.getRandomValues(new Uint8Array(16))),
        }
      : undefined;
    const fitted = fitHandoffBody(url, cookies, userAgent, requestMetadata);
    if (fitted === null) return 413; // Do not send a body Grab will reject.
    body = fitted.body;
    sentCookieCount = fitted.count;
    headers = { "Content-Type": "application/json" };
    if (secret) headers["X-Grab-Token"] = await hmacHex(secret, CLIENT_CONTEXT, body);
  } catch {
    return 0; // Crypto failed; POST never sent, safe to fall back.
  }
  const start = Date.now();
  try {
    // confirm=1: Grab answers only once the user has approved or declined, so
    // the browser's own download is cancelled only when Grab really took over.
    const resp = await fetchWithTimeout(
      `${GRAB_HTTP_URL}?confirm=1`,
      { method: "POST", headers, body },
      CONFIRM_TIMEOUT_MS,
    );
    if (resp.status >= 200 && resp.status < 300 && ctx && typeof ctx === "object") {
      const acceptedHeader = resp.headers?.get?.("x-grab-cookies-accepted");
      if (acceptedHeader !== null && acceptedHeader !== undefined) {
        const accepted = Number(acceptedHeader);
        if (Number.isSafeInteger(accepted) && accepted >= 0 && accepted < sentCookieCount && !ctx.cookieWarning) {
          ctx.cookieWarning = `Grab accepted the URL but discarded ${sentCookieCount - accepted} of ${sentCookieCount} supplied cookies.`;
        }
      }
    }
    return resp.status;
  } catch {
    // Fast failure (connection refused): Grab isn't running, the POST never
    // left. Slow failure (timeout): Grab may have accepted it.
    // Heuristic: a fast failure is treated as "never sent". A connection reset
    // after Grab accepted the POST looks the same and can duplicate a download;
    // a grab:// fallback is not attempted for STATUS_MAYBE_SENT for that reason.
    return Date.now() - start < 10000 ? 0 : STATUS_MAYBE_SENT;
  }
}

/// POST to Grab, retrying briefly on 429 (queue full). Resolves to the final
/// HTTP status, or 0 when Grab isn't reachable.
async function postToGrabWithRetry(url, ctx, retryDelays = HANDOFF_RETRY_DELAYS_MS) {
  let status = await postToGrab(url, ctx);
  for (const delay of retryDelays) {
    if (status !== 429) break;
    await sleep(delay);
    status = await postToGrab(url, ctx);
  }
  return status;
}

/// Set while a cold start is in progress: concurrent sends share one launch
/// instead of each navigating the tab to the wake URL.
let wakeInFlight = null;

/// True when the retried POST would carry at least one cookie. Incognito
/// stores and unreadable jars yield none, so the wake would buy nothing.
async function hasHandoffCookies(url, tabId) {
  try {
    const storeId = await resolveStoreId({ tabId });
    if (storeId === null) return false;
    return (await readCookies(url, storeId)).length > 0;
  } catch {
    return false;
  }
}

/// Launch Grab without a URL, then wait until its local server answers.
/// Returns true when a retry can carry the cookies over HTTP; false when the
/// app never came up, the user never granted the Cookies permission, Grab is
/// unpaired, the send is incognito, or the site has no cookies — all cases
/// where the wake buys nothing and the caller must use the URL fallback now.
async function wakeGrabAndWait(url, tabId, incognito) {
  // The wake exists only to carry cookies over the retried POST.
  if (incognito === true) return false;
  const secret = await getPairingCode();
  if (!secret || !(await hasCookiePermission())) return false;
  if (!(await hasHandoffCookies(url, tabId))) return false;
  // Check after the jar read: two sends that entered together both await it,
  // and only the first may start a launch.
  if (wakeInFlight) return wakeInFlight;
  const tabArg = Number.isInteger(tabId) && tabId >= 0 ? { tabId } : {};
  // A warned tab keeps its "!" until a handoff verifies: overwriting it here
  // would clear the visible warning without clearing warnedTabs.
  const keepWarning =
    Number.isInteger(tabId) && tabId >= 0 && warnedTabs.has(tabId);
  const run = (async () => {
    try {
      if (!keepWarning) {
        try {
          await chrome.action.setBadgeText({ ...tabArg, text: "…" });
          await chrome.action.setTitle({ ...tabArg, title: "Starting Grab…" });
        } catch {}
      }
      // Launch through the tab the user acted on. The browser delegates the
      // grab:// navigation to the OS handler; no background tab is created.
      updateTab(tabId, GRAB_WAKE_URL);
      const deadline = Date.now() + wakeTimeoutMs;
      while (Date.now() < deadline) {
        await sleep(WAKE_POLL_MS);
        try {
          if (await verifyGrab(secret)) return true;
        } catch {
          // Not up yet.
        }
      }
      return false;
    } finally {
      if (!keepWarning) {
        try {
          await chrome.action.setBadgeText({ ...tabArg, text: "" });
          await chrome.action.setTitle({ ...tabArg, title: "" });
        } catch {}
      }
    }
  })();
  wakeInFlight = run;
  try {
    return await run;
  } finally {
    if (wakeInFlight === run) wakeInFlight = null;
  }
}

/// Explicit user action (context menu, video menu, Alt+G): try the HTTP
/// handoff first, but only fall back to the grab:// navigation when Grab
/// isn't reachable at all (connection failure). If Grab responded — even
/// with 409 (card opened or declined) or 408 — it handled the URL; falling
/// back would duplicate the handoff.
async function explicitSend(url, tabId, incognito) {
  if (!toGrabUrl(url)) return;
  const ctx = { tabId, incognito };
  let status = await postToGrabWithRetry(url, ctx);
  if (status === 0 && (await wakeGrabAndWait(url, tabId, incognito))) {
    // Grab was closed and has just started: retry over HTTP so the browser
    // cookies still ride along. The grab:// fallback cannot carry them.
    status = await postToGrabWithRetry(url, ctx);
  }
  const tabArg =
    Number.isInteger(tabId) && tabId >= 0 ? { tabId } : {};
  if (status === 0) {
    // Grab never came up: the OS launches it with the grab:// URL.
    sendToGrab(url, tabId);
  } else if (status === STATUS_UNVERIFIED) {
    // Something else answers on Grab's port. Don't hand the URL to a
    // stranger; flag it on the toolbar instead.
    try {
      await chrome.action.setBadgeText({ ...tabArg, text: "!" });
      await chrome.action.setBadgeBackgroundColor({ ...tabArg, color: "#cc0000" });
      await chrome.action.setTitle({ ...tabArg, title: "Grab not recognised. Pair again in Options." });
      if (Number.isInteger(tabId) && tabId >= 0) warnedTabs.add(tabId);
    } catch {}
  } else if (status >= 200 && status < 300) {
    if (ctx.cookieWarning) {
      await showCookieWarning(ctx);
    } else {
      // Success: clear any earlier warning.
      try {
        await chrome.action.setBadgeText({ ...tabArg, text: "" });
        await chrome.action.setTitle({ ...tabArg, title: "" });
        if (Number.isInteger(tabId) && tabId >= 0) warnedTabs.delete(tabId);
      } catch {}
    }
  } else if (status !== STATUS_MAYBE_SENT) {
    // Concrete HTTP rejections (especially exhausted 429 retries, 408, or
    // 409) need visible feedback. Never fall back to grab:// after a response.
    const title = status === 408
      ? "Grab did not respond in time (HTTP 408). Check Grab before retrying."
      : status === 409
        ? "Grab did not queue this URL (HTTP 409). Check the Grab dialog."
        : status === 414
          ? "URL exceeds Grab's 2048-byte handoff limit; the original download was not handed off."
          : status === 429
            ? "Grab's queue is full after retries (HTTP 429). Try again after a download finishes."
            : `Grab could not accept this URL (HTTP ${status}).`;
    try {
      await chrome.action.setBadgeText({ ...tabArg, text: "!" });
      await chrome.action.setBadgeBackgroundColor({ ...tabArg, color: "#cc0000" });
      await chrome.action.setTitle({ ...tabArg, title });
    } catch {}
  }
  // STATUS_MAYBE_SENT may have been accepted; never fall back because that
  // risks a duplicate download.
}

/// Show why a handoff was accepted without a fully usable cookie jar.
async function showCookieWarning(ctx) {
  const tabId = ctx && ctx.tabId;
  const tabArg = Number.isInteger(tabId) && tabId >= 0 ? { tabId } : {};
  const title = ctx && ctx.cookieWarning;
  if (!title) return;
  try {
    await chrome.action.setBadgeText({ ...tabArg, text: "!" });
    await chrome.action.setBadgeBackgroundColor({ ...tabArg, color: "#cc0000" });
    await chrome.action.setTitle({ ...tabArg, title });
    if (Number.isInteger(tabId) && tabId >= 0) warnedTabs.add(tabId);
  } catch {}
}

/// True when the URL's file extension is on the user's skip list.

// --- Explicit sends -------------------------------------------------------

function createContextMenu() {
  chrome.contextMenus.create({
    id: "sendToGrab",
    title: "Download with Grab",
    contexts: ["link", "video", "audio", "image", "page"],
  });
}

chrome.runtime.onInstalled.addListener(async () => {
  const settings = await getSettings();
  // removeAll first: onInstalled also fires on extension updates, when the
  // menu may already exist (create would throw on a duplicate id).
  await removeAllContextMenus();
  if (settings.showContextMenu) createContextMenu();
});

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "sync") return;
  if (changes.showContextMenu) {
    // removeAll first: rapid toggles would otherwise stack a duplicate-id
    // create on top of an in-flight one.
    await removeAllContextMenus();
    if (changes.showContextMenu.newValue) {
      createContextMenu();
      // removeAll also dropped the video submenu; rebuild it.
      if (Number.isInteger(videoUi.activeTabId) && videoUi.activeTabId >= 0) {
        refreshVideoMenu(videoUi.activeTabId);
      }
    }
  }
  if (changes.detectVideos) {
    videoUi.detectVideosOn = changes.detectVideos.newValue !== false;
    if (!videoUi.detectVideosOn) clearAllVideoUi();
  }
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const id = info.menuItemId;
  if (typeof id === "string" && id.startsWith(VIDEO_ITEM_PREFIX)) {
    // A detected video: same explicit-send channel as the main item (the
    // user picked this tab), not the background-tab interception channel.
    // Resolve against the list the menu was built from: it was filtered
    // (master playlists) and may belong to another window's tab.
    // videoUi.menuUrls is in-memory; after a worker restart, read the persisted copy.
    let urls = videoUi.menuUrls;
    if (urls.length === 0) {
      try {
        const stored = await chrome.storage.session.get("menuUrls");
        if (Array.isArray(stored.menuUrls)) urls = stored.menuUrls;
      } catch {
        // Fall through with the empty list.
      }
    }
    const url = urls[Number(id.slice(VIDEO_ITEM_PREFIX.length))];
    // Try the paired HTTP handoff first (sends cookies, waits for Grab's
    // real answer); fall back to the grab:// navigation only when Grab isn't
    // reachable at all.
    if (url) await explicitSend(url, tab && tab.id, tab && tab.incognito === true);
    return;
  }
  if (id !== "sendToGrab") return;
  // Prefer the top-level tab URL: some context-menu invocations report only
  // a frame/origin URL in info.pageUrl, which is not enough for site extractors.
  // Keep info.pageUrl as a fallback when the browser omits tab.url.
  const pageUrl = tab && typeof tab.url === "string" ? tab.url : info.pageUrl;
  const candidates = [info.linkUrl, info.srcUrl, pageUrl];
  // Magnet links already open in Grab through the OS handler; pass them
  // through unwrapped.
  const magnet = candidates.find(
    (u) => typeof u === "string" && u.toLowerCase().startsWith("magnet:"),
  );
  if (magnet) {
    updateTab(tab && tab.id, magnet);
    return;
  }
  // Right-clicked on a video element whose srcUrl is unusable (blob:/data:):
  // try to find the detected video matching the clicked element's src.
  // If the tab has exactly one detected video, that's the one the user
  // meant — don't fall back to the generic page URL.
  let target = candidates.find((u) => toGrabUrl(u));
  if (
    info.mediaType === "video" &&
    tab &&
    Number.isInteger(tab.id) &&
    target === pageUrl
  ) {
    const detected = mergedVideoUrls(tab.id);
    // Try to match the clicked video's srcUrl against detected videos.
    // info.srcUrl is the video element's src (may be blob:).
    let matched = null;
    if (info.srcUrl) {
      const videos = domVideosFor(tab.id);
      for (const v of videos) {
        if (v && v.src === info.srcUrl) {
          matched = v;
          break;
        }
      }
    }
    if (matched && toGrabUrl(matched.src) && matched.src !== pageUrl) {
      // Direct URL: use it.
      target = matched.src;
    } else if (detected.length === 1 && toGrabUrl(detected[0])) {
      // Single detected video: use it.
      target = detected[0];
    } else if (matched && matched.blob && detected.length > 0) {
      // Blob video matched but no direct URL: use first detected (likely paired manifest).
      const first = detected.find((u) => toGrabUrl(u));
      if (first) target = first;
    }
  }
  // Prefer the media/link target, but a blob:/data: media URL can't leave
  // the browser — fall back to the page URL so yt-dlp can extract it there.
  // Try the paired HTTP handoff first (sends cookies); fall back to grab://
  // only when Grab isn't reachable at all.
  if (target) await explicitSend(target, tab && tab.id, tab && tab.incognito === true);
});

// The toolbar button now opens popup.html (default_popup in the manifest),
// which hosts the settings UI directly.

chrome.commands.onCommand.addListener((command) => {
  if (command !== "send-tab-to-grab") return;
  chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
    const url = tabs[0] && tabs[0].url;
    // Paired HTTP handoff first (sends cookies); grab:// fallback only when
    // Grab isn't reachable at all.
    if (url) await explicitSend(url, tabs[0].id, tabs[0].incognito === true);
  });
});


async function grabStatus() {
  const secret = await getPairingCode();
  let nonce;
  let response;

  // Probe even when no pairing code is saved: reachability and identity are
  // separate states. Only a matching HMAC earns the "Connected" status.
  try {
    nonce = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
    response = await fetchJsonWithTimeout(
      `${GRAB_BASE_URL}/hello?n=${nonce}`,
      HELLO_TIMEOUT_MS,
    );
  } catch {
    return { state: "down" };
  }

  // A response means the local endpoint is reachable, even if it cannot be
  // authenticated. Do not mistake an HTTP/protocol error for a stopped app.
  if (!response.ok) return { state: "unverified" };

  const body = response.body;
  const proof = body && body.proof;
  if (typeof proof !== "string" || !/^[0-9a-f]{64}$/i.test(proof)) {
    return { state: "unverified" };
  }

  // The extension can report reachability without a saved code, but cannot
  // claim an authenticated connection until the proof matches that code.
  if (!secret) return { state: "running-unpaired" };

  try {
    const expected = await hmacHex(secret, SERVER_CONTEXT, nonce);
    return {
      state: constantTimeEqual(proof, expected) ? "verified" : "unverified",
    };
  } catch {
    // Crypto/response failures are not proof that the app is stopped.
    return { state: "unverified" };
  }
}

