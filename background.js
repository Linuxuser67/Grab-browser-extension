// Grab browser extension (MV3) — service worker.
//
// Three jobs:
//   1. Automatic interception: browser downloads are cancelled and POSTed to
//      the Grab desktop app's local HTTP endpoint.
//   2. Explicit sends: context menu and keyboard shortcut send the current
//      tab or a link/media URL to Grab through the grab: URI scheme
//      (registered by the app's .desktop entry as x-scheme-handler/grab).
//      The toolbar button opens the options page instead.
//   3. Video detection: <video> elements reported by the content script plus
//      stream manifests sniffed via webRequest are offered in the right-click
//      menu as "Download video with Grab", FDM-style.
//
// All listeners are registered synchronously at the top level: the worker is
// ephemeral and Chrome only wakes it for events it registered for on startup.

// shared.js loads via importScripts in the Chrome MV3 service worker.
// Firefox lists it as a background script before this file, so the
// globals already exist there (importScripts only exists in workers).
if (
  typeof SHARED_DEFAULTS === "undefined" &&
  typeof importScripts === "function"
) {
  importScripts("shared.js");
}

const GRAB_SCHEME = "grab://";

// Browser startup time (Varia pattern): chrome.downloads.onCreated can re-fire
// on startup for downloads from a previous session. Anything with a startTime
// older than this is ignored so a cancelled download doesn't re-prompt on
// every browser launch. Kept in session storage, not a variable: the worker
// restarts whenever it idles, and a per-worker timestamp would postdate the
// startTime of the very download that woke it.
chrome.runtime.onStartup.addListener(() => {
  chrome.storage.session.set({ browserStartTime: Date.now() });
});

// Shared defaults live in shared.js (importScripts'd above).
/// Wrap an http(s) URL for the Grab desktop app. Anything else (blob:, data:,
/// file:, …) cannot be handed off and returns null. The original scheme is
/// carried as the first path segment (grab://https/host/...) so Grab can
/// restore http vs https; needs Grab 4.7.1+.
function toGrabUrl(url) {
  if (typeof url !== "string") return null;
  const m = /^(https?):\/\/(.+)$/i.exec(url);
  if (!m) return null;
  // user:pass@host: Grab refuses credentials in links, and the grab: URL
  // passes through argv (xdg-open), which other local users can read.
  // The WHATWG parser handles the edge cases (tab/newline stripping, etc.).
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.username || u.password) return null;
  return `${GRAB_SCHEME}${m[1].toLowerCase()}/${m[2]}`;
}

/// Explicit user action (keyboard shortcut, context menu):
/// navigate the active tab to the grab: URL. The user acted on this tab, and
/// external-protocol navigations are handed to the OS without replacing the
/// page (the mailto: mechanism), so the tab is left alone. Never use this for
/// automatic interception: the download can come from any tab, or none.
function sendToGrab(url, tabId) {
  const grabUrl = toGrabUrl(url);
  if (!grabUrl) return;
  // Name the tab the user acted on; without an id the browser picks the
  // "current window", which is the wrong one when several are open.
  updateTab(tabId, grabUrl);
}

/// Navigate `tabId` to `url`, falling back to the current window's active tab
/// when there is no real tab (TAB_ID_NONE is -1: devtools and similar). A tab
/// that closed in the meantime rejects the promise; nothing to recover.
function updateTab(tabId, url) {
  const r =
    tabId != null && tabId >= 0
      ? chrome.tabs.update(tabId, { url })
      : chrome.tabs.update({ url });
  if (r && typeof r.catch === "function") r.catch(() => {});
}

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

/// Keep URL and body limits aligned with Grab's server-side validation.
/// The body limit is measured as UTF-8 bytes over the exact JSON string sent.
const MAX_GRAB_URL_BYTES = 2048;
const MAX_HANDOFF_COOKIES = 100;
const MAX_HANDOFF_BODY_BYTES = 32 * 1024;
// Bound menu creation and per-tab DOM snapshots while retaining many videos.
const MAX_VIDEO_ITEMS = 50;
/// How long to wait for a server to report the size before treating an
/// unknown size as big enough to intercept (streams rarely send one, and they
/// belong in Grab).
const SIZE_WAIT_MS = 10_000;
/// Grab rejects longer URLs (HTTP 414), so they are never worth tracking.
const fitsGrabUrl = (u) =>
  typeof u === "string" && new TextEncoder().encode(u).length <= MAX_GRAB_URL_BYTES;

let sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/// Tabs showing the "unverified Grab" warning badge. Warned tabs keep their
/// "!" until Grab verifies successfully.
const warnedTabs = new Set();
let activeTabId = null;
/// The URLs behind the submenu items as last built (after filtering): a
/// click index resolves here, never against a fresh, differently-ordered list.
let menuUrls = [];
let detectVideosOn = SHARED_DEFAULTS.detectVideos;

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

/// True when the listener on Grab's port knows the pairing code. A squatter
/// without it cannot answer, and a Grab that regenerated its code fails too.
async function verifyGrab(secret) {
  const nonce = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
  const resp = await fetchWithTimeout(
    `${GRAB_BASE_URL}/hello?n=${nonce}`,
    { method: "GET" },
    HELLO_TIMEOUT_MS,
  );
  if (!resp.ok) return false;
  const body = await resp.json();
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

/// Keep a valid URL handoff even if a site exposes a very large cookie jar.
/// Drop lower-priority cookies first; among equal priorities, remove the
/// largest serialized cookies first. Critical auth cookies are retained unless
/// they alone prevent the body from fitting.
function fitHandoffBody(url, cookies, userAgent, requestMetadata) {
  let body = serializeHandoffBody(url, cookies, userAgent, requestMetadata);
  const byteLength = (value) => new TextEncoder().encode(value).length;
  if (byteLength(body) <= MAX_HANDOFF_BODY_BYTES) return body;

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
  return byteLength(body) <= MAX_HANDOFF_BODY_BYTES ? body : null;
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
  let body, headers;
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
    body = fitHandoffBody(url, cookies, userAgent, requestMetadata);
    if (body === null) return 413; // Do not send a body Grab will reject.
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
        const sentCount = JSON.parse(body).cookies.length;
        if (Number.isSafeInteger(accepted) && accepted >= 0 && accepted < sentCount && !ctx.cookieWarning) {
          ctx.cookieWarning = `Grab accepted the URL but discarded ${sentCount - accepted} of ${sentCount} supplied cookies.`;
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

/// Send the URL to Grab via HTTP. Resolves to true only when Grab accepted it.
/// A 429 means Grab's queue is momentarily full, so retry briefly first. Any
/// other outcome (Grab not running or not verified, declined by the user (409),
/// no answer in time (408), 403, 414, …) is a failure: the caller must leave
/// the browser's own download alone. The caller validates the URL with
/// toGrabUrl first; the raw URL is posted as-is.
async function handOff(url, ctx, retryDelays = HANDOFF_RETRY_DELAYS_MS) {
  const status = await postToGrabWithRetry(url, ctx, retryDelays);
  return status >= 200 && status < 300;
}

/// Explicit user action (context menu, video menu, Alt+G): try the HTTP
/// handoff first, but only fall back to the grab:// navigation when Grab
/// isn't reachable at all (connection failure). If Grab responded — even
/// with 409 (card opened or declined) or 408 — it handled the URL; falling
/// back would duplicate the handoff.
async function explicitSend(url, tabId, incognito) {
  if (!toGrabUrl(url)) return;
  const ctx = { tabId, incognito };
  const status = await postToGrabWithRetry(url, ctx);
  const tabArg =
    Number.isInteger(tabId) && tabId >= 0 ? { tabId } : {};
  if (status === 0) {
    // Grab not running: the OS launches it with the grab:// URL.
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
function isSkipped(url, skipTypes) {
  if (!skipTypes) return false;
  let ext = "";
  try {
    const path = new URL(url).pathname;
    const dot = path.lastIndexOf(".");
    if (dot >= 0) ext = path.slice(dot + 1).toLowerCase();
  } catch {
    return false;
  }
  return skipTypes
    .split(",")
    .map((s) => s.trim().toLowerCase().replace(/^\./, ""))
    .some((s) => s !== "" && s === ext);
}

async function getSettings() {
  return chrome.storage.sync.get(SHARED_DEFAULTS);
}

/// Per-download claim keys in session storage: one key per download id, so two
/// downloads claimed at the same moment can't clobber each other's record the
/// way a shared read-modify-write set would. Session storage survives service
/// worker restarts and clears when the browser closes.
const claimKey = (id) => `claimedDownload:${id}`;

async function claimDownload(id) {
  await chrome.storage.session.set({ [claimKey(id)]: true });
}

async function unclaimDownload(id) {
  await chrome.storage.session.remove(claimKey(id));
}

async function isClaimed(id) {
  const key = claimKey(id);
  const result = await chrome.storage.session.get(key);
  return result[key] === true;
}

// --- Automatic interception ----------------------------------------------

/// Remove the browser's own copy of a download Grab has taken over.
async function removeBrowserCopy(id) {
  try {
    await chrome.downloads.removeFile(id);
  } catch {
    // Already gone.
  }
  try {
    await chrome.downloads.erase({ id });
  } catch {
    // Already gone.
  }
}

async function interceptDownload(item) {
  // Cancelling a browser download is only safe when a verified Grab took it.
  // Unpaired, any process listening on the port could answer 200 and make the
  // file disappear, so automatic interception requires pairing.
  if (!(await getPairingCode())) return;
  // Prefer the post-redirect URL only when Grab can accept its length.
  // Otherwise preserve the original URL so Grab can follow the redirect.
  const finalUrl = toGrabUrl(item.finalUrl) ? item.finalUrl : null;
  const url = finalUrl &&
    new TextEncoder().encode(finalUrl).length <= MAX_GRAB_URL_BYTES
      ? finalUrl
      : item.url;
  // Non-http(s) URLs (blob:, data:) and URLs with credentials can't be
  // handed over.
  if (!toGrabUrl(url)) return;
  // Hand off over Grab's local HTTP endpoint. If Grab isn't running or
  // refuses the request, the download is left to the browser.
  // Only cancel the browser download on HTTP 200 (queued). HTTP 202 means
  // Grab opened the New Download card (nothing queued yet) — the user may
  // not complete it, so the browser copy must stay.
  const ctx = {
    incognito: item.incognito === true,
    cookieStoreId: item.cookieStoreId,
    requirePairing: true,
  };
  const status = await postToGrabWithRetry(url, ctx);
  if (status !== 200) return;
  if (ctx.cookieWarning) await showCookieWarning(ctx);

  try {
    await claimDownload(item.id);
  } catch {
    // Continue: the cancel below still stops the browser copy. Only the
    // onChanged cleanup for a tiny finished download may be missed.
  }
  // A tiny download can finish while the handoff is in flight, before the
  // claim exists, so onChanged skipped it: clean up here instead.
  const [current] = await chrome.downloads.search({ id: item.id });
  if (current && current.state === "complete") {
    await removeBrowserCopy(item.id);
    await unclaimDownload(item.id);
    return;
  }
  try {
    await chrome.downloads.cancel(item.id);
  } catch {
    // Already gone; the onChanged guard below still cleans up.
  }
  try {
    await chrome.downloads.removeFile(item.id);
  } catch {
    // Nothing written yet or already removed.
  }
}

// Downloads parked while waiting for their size to become known, when the
// user set a minimum intercept size. MV3 service workers are ephemeral: an
// in-memory Map + setTimeout can die mid-wait and lose the interception, so
// the pending set lives in session storage (survives worker restarts, clears
// with the browser) and the deadline is a chrome.alarms one-shot (alarms
// wake the worker). After a restart, the next onChanged or alarm re-reads
// the pending set and decides.
const pendingKey = (id) => `pendingSize:${id}`;
const alarmName = (id) => `size-wait:${id}`;

// Best-effort guard against deciding the same download twice when an alarm
// and a size event interleave within one worker lifetime. Cross-restart
// dedup comes from dropPending's session-storage removal.
const deciding = new Set();

async function isPending(id) {
  const key = pendingKey(id);
  const result = await chrome.storage.session.get(key);
  return result[key] !== undefined;
}

async function parkForSize(item, deadline = Date.now() + SIZE_WAIT_MS) {
  // The alarm is only the worker-wakeup: the stored deadline is the real
  // timer. Packaged Chrome fires alarms no earlier than ~30s out, so the
  // effective wait in packaged builds is >= 30s even though the deadline is
  // sooner; the deadline still decides, so unpacked builds keep the short
  // wait for development.
  await chrome.storage.session.set({ [pendingKey(item.id)]: deadline });
  await chrome.alarms.create(alarmName(item.id), { when: deadline });
}

async function dropPending(id) {
  await chrome.alarms.clear(alarmName(id)).catch(() => {});
  await chrome.storage.session.remove(pendingKey(id));
}

const minSizeBytes = (settings) =>
  Math.max(0, settings.minSizeMB | 0) * 1024 * 1024;

async function decidePending(id) {
  // Acquire the guard before the first await: two interleaved calls (an alarm
  // and a size event arriving together) would otherwise both pass the check
  // above before either reaches the add below, and both would intercept.
  if (deciding.has(id)) return;
  deciding.add(id);
  try {
    const stored = await chrome.storage.session.get(pendingKey(id));
    const deadline = stored[pendingKey(id)];
    if (deadline === undefined) return;

    const settings = await getSettings();
    const items = await chrome.downloads.search({ id });
    const item = items[0];
    if (!item) {
      await dropPending(id);
      return;
    }
    // The download finished or failed while parked (or in the async gap
    // between deciding to park and persisting the pending state): too late
    // to hand over — leave the browser copy alone.
    if (item.state === "complete" || item.state === "interrupted") {
      await dropPending(id);
      return;
    }
    // The user may have changed their mind while we waited.
    if (
      !settings.interceptDownloads ||
      isSkipped(item.url, settings.skipTypes) ||
      isSkipped(item.finalUrl, settings.skipTypes) ||
      !toGrabUrl(item.url)
    ) {
      await dropPending(id);
      return;
    }
    if (item.fileSize >= 0) {
      // Size is known: small enough stays in the browser, big enough is
      // intercepted now.
      if (item.fileSize < minSizeBytes(settings)) {
        await dropPending(id);
        return;
      }
    } else if (Date.now() < deadline) {
      // Size still unknown but the deadline hasn't passed: this call came
      // too early (the alarm is only the wakeup). Re-park and wait for the
      // real deadline instead of intercepting early. Don't drop: parkForSize
      // refreshes the pending entry.
      await parkForSize(item, deadline);
      return;
    }
    // Unknown size past the deadline: streams rarely report one, and they
    // belong in Grab (see SIZE_WAIT_MS).
    // Drop the pending entry AFTER the handoff starts, so a worker death
    // in between doesn't lose the download silently.
    await interceptDownload(item);
    await dropPending(id);
  } finally {
    deciding.delete(id);
  }
}

// Size-wait deadline: decide the parked download even if the worker was
// restarted while it was parked (the pending set survived in session storage).
chrome.alarms.onAlarm.addListener((alarm) => {
  const m = /^size-wait:(\d+)$/.exec(alarm.name);
  if (m) decidePending(Number(m[1]));
});

chrome.downloads.onCreated.addListener(async (item) => {
  const settings = await getSettings();
  if (!settings.interceptDownloads) return;
  // Ignore downloads from a previous browser session (Varia pattern):
  // onCreated can re-fire on startup for old downloads. Missing startTime
  // or a missing browserStartTime (no startup seen) is treated as new.
  if (item.startTime) {
    const { browserStartTime } = await chrome.storage.session.get(
      "browserStartTime",
    );
    if (
      browserStartTime !== undefined &&
      new Date(item.startTime).getTime() < browserStartTime
    ) {
      return;
    }
  }
  // Extension installs/updates must never be intercepted.
  if (item.mime === "application/x-chrome-extension") return;
  if (isSkipped(item.url, settings.skipTypes) || isSkipped(item.finalUrl, settings.skipTypes)) return;
  // Non-http(s) downloads (blob:, data:) have no server URL to hand over.
  if (!toGrabUrl(item.url)) return;

  const cap = minSizeBytes(settings);
  if (cap > 0) {
    if (item.fileSize >= 0 && item.fileSize < cap) return; // Too small: browser keeps it.
    if (item.fileSize < 0) {
      // Size not known yet (headers haven't arrived): wait for it instead of
      // guessing. The browser download proceeds normally meanwhile.
      await parkForSize(item);
      // The download may have finished while the pending state was being
      // written (async gap between deciding to park and persisting it):
      // re-check, and drop the parked entry if it's already too late to
      // hand over. Anything finishing after this is caught by the onChanged
      // guard or by decidePending's own state check.
      const fresh = await chrome.downloads.search({ id: item.id });
      const current = fresh[0];
      if (
        !current ||
        current.state === "complete" ||
        current.state === "interrupted"
      ) {
        await dropPending(item.id);
      }
      return;
    }
  }

  await interceptDownload(item);
});

chrome.downloads.onChanged.addListener(async (delta) => {
  if (await isPending(delta.id)) {
    const state = delta.state && delta.state.current;
    if (state === "complete" || state === "interrupted") {
      // Finished or failed before the size arrived: too late to hand over.
      await dropPending(delta.id);
      return;
    }
    if (delta.fileSize && delta.fileSize.current >= 0) {
      await decidePending(delta.id);
      return;
    }
  }
  if (!(await isClaimed(delta.id))) return;
  const state = delta.state && delta.state.current;
  if (state === "complete") {
    // Lost the race: the browser finished before our cancel landed. Remove
    // the duplicate so only Grab's copy remains.
    await removeBrowserCopy(delta.id);
  }
  if (state === "complete" || state === "interrupted") {
    await unclaimDownload(delta.id);
  }
});

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
      if (Number.isInteger(activeTabId) && activeTabId >= 0) {
        refreshVideoMenu(activeTabId);
      }
    }
  }
  if (changes.detectVideos) {
    detectVideosOn = changes.detectVideos.newValue !== false;
    if (!detectVideosOn) clearAllVideoUi();
  }
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const id = info.menuItemId;
  if (typeof id === "string" && id.startsWith(VIDEO_ITEM_PREFIX)) {
    // A detected video: same explicit-send channel as the main item (the
    // user picked this tab), not the background-tab interception channel.
    // Resolve against the list the menu was built from: it was filtered
    // (master playlists) and may belong to another window's tab.
    // menuUrls is in-memory; after a worker restart, read the persisted copy.
    let urls = menuUrls;
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

// --- Video detection ------------------------------------------------------
//
// FDM-style video menu: the content script reports <video> elements the user
// started playing (play-event latch; muted autoplay is noise), and webRequest
// sniffs the HLS/DASH stream manifests (.m3u8/.mpd) that blob:-based MSE
// players actually fetch. Sniffed manifests surface only alongside a played
// video. Detections are kept per tab and offered as right-click menu children;
// a toolbar badge shows the count. Picking an entry hands the URL to the Grab
// desktop app. Segment traffic (.ts/.m4s/...) is ignored so the menu isn't
// flooded with fragments.

const VIDEO_PARENT_ID = "grabVideos";
const VIDEO_ITEM_PREFIX = "grabVideo:";

/// Callback-compatible context-menu removal: manifest declares
/// minimum_chrome_version 102, but promise-returning chrome.contextMenus
/// methods need Chrome 123+. These work on both.
function removeAllContextMenus() {
  return new Promise((resolve) => {
    try {
      chrome.contextMenus.removeAll(() => {
        void chrome.runtime.lastError;
        resolve();
      });
    } catch {
      resolve();
    }
  });
}

function removeContextMenu(id) {
  return new Promise((resolve) => {
    try {
      chrome.contextMenus.remove(id, () => {
        void chrome.runtime.lastError;
        resolve();
      });
    } catch {
      resolve();
    }
  });
}

// Host exclusion domains and their predicate are defined once in shared.js.

/// True when the tab lives on an excluded host. Host permissions are granted,
/// so tabs.get exposes the URL; anything odd (no tab, weird URL) is treated
/// as not excluded.
async function isExcludedTab(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    const url = tab && tab.url;
    return !!url && sharedHostExcluded(new URL(url).hostname);
  } catch {
    return false;
  }
}

/// Classify a sniffed response URL: "manifest" for HLS/DASH playlists,
/// "media" for direct video files, null for everything else (segments,
/// audio, images, pages). Manifests win on content type alone because some
/// are served extensionless; extensionless media is NOT guessed because
/// DASH segments look exactly like that.
function classifyStream(url, contentType) {
  const u = String(url || "").toLowerCase();
  if (!/^https?:\/\//i.test(u)) return null;
  const ct = String(contentType || "").toLowerCase().split(";")[0].trim();
  // Match the extension on the path only: "?file=a.mp4" is not a media file.
  let path;
  try {
    path = new URL(u).pathname;
  } catch {
    return null;
  }
  if (/\.(m3u8|m3u|mpd)$/.test(path)) return "manifest";
  if (
    ct === "application/vnd.apple.mpegurl" ||
    ct === "application/x-mpegurl" ||
    ct === "audio/x-mpegurl" ||
    ct === "application/dash+xml"
  ) {
    return "manifest";
  }
  // Explicitly audio-typed responses are not video candidates.
  if (/^audio\//.test(ct)) return null;
  if (/\.(mp4|m4v|webm|ogv|mov|mkv)$/.test(path)) return "media";
  return null;
}

const NAME_MAX = 16;
const TITLE_MAX = 16;
const shorten = (text) =>
  text.length > NAME_MAX ? text.slice(0, NAME_MAX) + "…" : text;
const shortenTitle = (text) =>
  text.length > TITLE_MAX ? text.slice(0, TITLE_MAX) + "…" : text;

/// Last path segment of a URL, decoded ("my%20clip.mp4" -> "my clip.mp4").
/// Empty when there is none.
function fileNameOf(url) {
  let last;
  try {
    last = new URL(url).pathname.split("/").filter(Boolean).pop() || "";
  } catch {
    return "";
  }
  try {
    return decodeURIComponent(last);
  } catch {
    return last; // malformed escape: show it raw
  }
}

/// Name shown for a detected video. A direct file is named by its file name
/// ("clip.mp4"): that is what the person is about to download, and a page
/// title would name the page, not the file. A stream (HLS/DASH, whose URL is
/// usually "master.m3u8") is named by the page's video title when the content
/// script found one, else by its file name. "Video N" is the last resort.
function videoName(url, index, pageTitle, kind) {
  const file = fileNameOf(url);
  if (kind) {
    const title = String(pageTitle || "").replace(/\s+/g, " ").trim();
    if (title) return shortenTitle(title);
  }
  return file ? shorten(file) : `Video ${index + 1}`;
}

/// One row for an HLS master or DASH manifest: hand it to Grab, whose
/// yt-dlp picks the quality.
function manifestMenuRows(url) {
  return [{ quality: "", url }];
}

/// Row for a direct file: the height the player reported, when known.
function directMenuRow(url, height) {
  return { quality: height > 0 ? `${height}p` : "", url };
}

/// Text of one menu row. "%" is doubled: menu titles treat "%s" as the
/// selected text.
function menuRowTitle(name, quality) {
  return (quality ? `${name} • ${quality}` : name).replace(/%/g, "%%");
}

/// "hls", "dash" or null (a direct file), by URL extension only.
function manifestKind(url) {
  let path;
  try {
    path = new URL(url).pathname;
  } catch {
    return null;
  }
  if (/\.(m3u8|m3u)$/i.test(path)) return "hls";
  if (/\.mpd$/i.test(path)) return "dash";
  return null;
}

/// Menu model for one detected URL: {url, kind, rows}. `ctx.height` is
/// the height the player reported for a direct file.
function buildVideoEntry(url, ctx = {}) {
  const kind = manifestKind(url) || (ctx.kind === "manifest" ? "manifest" : null);
  const rows = kind
    ? manifestMenuRows(url)
    : [directMenuRow(url, ctx.height)];
  return { url, kind, rows };
}

/// Two videos can share a label (same page title word): number the repeats.
function uniqueLabels(labels) {
  const seen = new Map();
  return labels.map((label) => {
    const n = (seen.get(label) || 0) + 1;
    seen.set(label, n);
    return n > 1 ? `${label} (${n})` : label;
  });
}


/// Group HLS/DASH manifests and their sibling rendition URLs using a
/// site-agnostic stream-directory key. Exact URLs with rotating auth tokens
/// are also compared by origin + path.

/// Directory key for standard-named HLS/DASH manifests. A direct rendition
/// beside the manifest belongs to the same stream family, not a second video.
function manifestFolderKey(url, kind) {
  try {
    const p = new URL(url);
    const basename = p.pathname.split("/").filter(Boolean).pop() || "";
    const namedManifest =
      /^(?:hlsplaylist|dashplaylist|master|index|playlist|manifest|stream|dash|chunklist(?:[_-].*)?|prog_index(?:[_-].*)?)(?:[_-][a-z0-9]+)?\.(?:m3u8|m3u|mpd)$/i.test(basename);
    const extensionlessManifest =
      kind === "manifest" &&
      !/\.[a-z0-9]{2,8}$/i.test(basename);
    if (!namedManifest && !extensionlessManifest) return null;
    const slash = p.pathname.lastIndexOf("/");
    const parent = slash > 0 ? p.pathname.slice(0, slash) : "/";
    return `${p.origin}${parent}`;
  } catch {
    return null;
  }
}

/// Merge user-played DOM sources with sniffed requests. Ignore rotating auth
/// query strings and group recognized manifest/rendition siblings by directory.
function mergeVideoFinds(domVideos, sniffedUrls, kinds) {
  const candidates = [];
  for (const v of domVideos || []) {
    if (v && typeof v.src === "string" && v.src) {
      candidates.push({ url: v.src, fromDom: true, kind: null });
    }
  }
  for (const url of sniffedUrls || []) {
    if (typeof url !== "string" || !url) continue;
    const kind = (kinds && kinds.get(urlPathKey(url))) || null;
    candidates.push({ url, fromDom: false, kind });
  }

  // First discover stream directories so sibling direct-file renditions can
  // be grouped with their manifest regardless of request order.
  const manifestFolders = new Set();
  for (const item of candidates) {
    const kind = manifestKind(item.url) || item.kind;
    const folder = manifestFolderKey(item.url, kind);
    if (folder) manifestFolders.add(folder);
  }

  const groups = new Map();
  candidates.forEach((item, order) => {
    const kind = manifestKind(item.url) || item.kind;
    const folder = manifestFolderKey(item.url, kind);
    let key;
    if (folder) {
      key = `${folder}/__stream__`;
    } else {
      try {
        const p = new URL(item.url);
        const slash = p.pathname.lastIndexOf("/");
        const parent = slash > 0 ? p.pathname.slice(0, slash) : "/";
        const siblingFolder = `${p.origin}${parent}`;
        key = manifestFolders.has(siblingFolder)
          ? `${siblingFolder}/__stream__`
          : urlPathKey(item.url);
      } catch {
        key = urlPathKey(item.url);
      }
    }

    // Prefer a master playlist (HLS, then DASH) over a rendition-only MP4,
    // which may omit the audio track. When no manifest exists, keep the
    // player-reported URL ahead of a sniffed duplicate.
    const priority =
      kind === "hls" ? 30 :
      kind === "dash" ? 20 :
      kind === "manifest" ? 25 :
      item.fromDom ? 10 : 5;
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, { url: item.url, priority, order });
    } else if (priority > existing.priority) {
      existing.url = item.url;
      existing.priority = priority;
    }
  });

  return [...groups.values()]
    .sort((a, b) => a.order - b.order)
    .map((item) => item.url);
}

// Per-tab detections: tabId -> { frames: Map(frameId -> [{src, blob}]),
// sniffed: [url] }. Reports are tracked per frame because the content script
// runs in all frames; last-writer-wins per tab would drop other frames'
// videos whenever two frames report at different times.
const videoFinds = new Map();

/// Storage.session outlives an MV3 service-worker instance and is cleared when
/// the browser session ends. Persist the active discovery snapshot so a blob:
/// player still has its sniffed manifest after the worker is restarted.
const videoStateKey = (tabId) => `videoFinds:${tabId}`;
const restoredVideoFinds = new Set();
const restoringVideoFinds = new Map();
const videoStateWrites = new Map();

/// Serialize session-storage mutations per tab, so navigation cleanup cannot
/// be overtaken by a write queued for the previous document.
function enqueueVideoStateWrite(tabId, write) {
  const previous = videoStateWrites.get(tabId) || Promise.resolve();
  const next = previous.catch(() => {}).then(write);
  videoStateWrites.set(tabId, next);
  next.finally(() => {
    if (videoStateWrites.get(tabId) === next) videoStateWrites.delete(tabId);
  }).catch(() => {});
  return next;
}

function snapshotVideoFinds(finds) {
  const frames = [];
  let remaining = MAX_VIDEO_ITEMS;
  // Persist active DOM-video reports across worker restarts, with a per-tab
  // cap so pathological pages cannot grow session storage without bound.
  // Empty frame reports are omitted; sniffed URLs are bounded separately.
  for (const [frameId, videos] of finds.frames) {
    if (remaining <= 0) break;
    const out = [];
    const seen = new Set();
    let hasBlob = false;
    for (const video of videos || []) {
      if (remaining <= 0) break;
      if (video && typeof video.src === "string" && video.src && fitsGrabUrl(video.src) && !seen.has(video.src)) {
        seen.add(video.src);
        const saved = { src: video.src, blob: video.blob === true };
        if (Number.isFinite(video.height) && video.height > 0) saved.height = video.height;
        out.push(saved);
        remaining -= 1;
      } else if (video && video.blob === true && !hasBlob) {
        hasBlob = true;
        out.push({ src: null, blob: true });
        remaining -= 1;
      }
    }
    if (out.length) frames.push([frameId, out]);
  }
  return {
    frames,
    sniffed: (finds.sniffed || []).filter((url) => fitsGrabUrl(url)).slice(-50),
    kinds: [...(finds.kinds || new Map()).entries()].slice(-200),
    title: typeof finds.title === "string" ? finds.title : "",
  };
}

async function restoreVideoFinds(tabId) {
  if (!Number.isInteger(tabId) || tabId < 0 || restoredVideoFinds.has(tabId)) return;
  const current = restoringVideoFinds.get(tabId);
  if (current) {
    await current;
    return;
  }
  const restoring = (async () => {
    try {
      const queued = videoStateWrites.get(tabId);
      if (queued) await queued.catch(() => {});
      const key = videoStateKey(tabId);
      const result = await chrome.storage.session.get(key);
      // Navigation/removal may invalidate the tab while the read is pending.
      if (restoredVideoFinds.has(tabId)) return;
      const saved = result && result[key];
      if (saved && typeof saved === "object") {
        const frames = new Map();
        for (const pair of Array.isArray(saved.frames) ? saved.frames : []) {
          if (!Array.isArray(pair) || pair.length !== 2 || !Number.isInteger(pair[0]) || !Array.isArray(pair[1])) continue;
          const videos = pair[1].filter((video) => video && typeof video === "object" && (video.src == null || fitsGrabUrl(video.src))).map((video) => {
            const item = { src: typeof video.src === "string" ? video.src : null, blob: video.blob === true };
            if (Number.isFinite(video.height) && video.height > 0) item.height = video.height;
            return item;
          });
          frames.set(pair[0], videos);
        }
        const sniffed = Array.isArray(saved.sniffed)
          ? saved.sniffed.filter((url) => fitsGrabUrl(url)).slice(-50)
          : [];
        const kinds = new Map(
          (Array.isArray(saved.kinds) ? saved.kinds : []).filter((pair) =>
            Array.isArray(pair) && pair.length === 2 &&
            typeof pair[0] === "string" &&
            (pair[1] === "manifest" || pair[1] === "media")
          ).slice(-200)
        );
        videoFinds.set(tabId, {
          frames,
          sniffed,
          kinds,
          title: typeof saved.title === "string" ? saved.title : "",
        });
      }
    } catch {
      // Session storage may be unavailable; fresh reports can still recover.
    } finally {
      restoredVideoFinds.add(tabId);
      restoringVideoFinds.delete(tabId);
    }
  })();
  restoringVideoFinds.set(tabId, restoring);
  await restoring;
}

async function persistVideoFinds(tabId) {
  const finds = videoFinds.get(tabId);
  if (!finds || !Number.isInteger(tabId) || tabId < 0) return;
  restoredVideoFinds.add(tabId);
  const snapshot = snapshotVideoFinds(finds);
  try {
    await enqueueVideoStateWrite(tabId, () =>
      chrome.storage.session.set({ [videoStateKey(tabId)]: snapshot })
    );
  } catch {
    // Fresh reports can still rebuild the menu if session storage fails.
  }
}

function forgetVideoFinds(tabId) {
  if (!Number.isInteger(tabId) || tabId < 0) return;
  restoredVideoFinds.add(tabId);
  return enqueueVideoStateWrite(tabId, () =>
    chrome.storage.session.remove(videoStateKey(tabId))
  ).catch(() => {});
}
getSettings().then((s) => {
  detectVideosOn = s.detectVideos !== false;
});

function domVideosFor(tabId) {
  const f = videoFinds.get(tabId);
  if (!f) return [];
  const out = [];
  for (const videos of f.frames.values()) out.push(...videos);
  return out;
}

function mergedVideoUrls(tabId) {
  const f = videoFinds.get(tabId);
  return f ? mergeVideoFinds(domVideosFor(tabId), f.sniffed, f.kinds).slice(0, MAX_VIDEO_ITEMS) : [];
}

function sniffedHeader(headers, name) {
  for (const h of headers || []) {
    if (h.name && h.name.toLowerCase() === name) return h.value || "";
  }
  return "";
}

/// Origin + pathname of a URL, ignoring query strings and fragments.
/// Used to dedupe and match playlists whose auth tokens rotate.
/// (Path-key technique ported from jvillegasd/media-bridge, MIT,
/// Copyright (c) 2026 Johnny Villegas.)
function urlPathKey(u) {
  try {
    const p = new URL(u);
    return p.origin + p.pathname;
  } catch {
    return String(u);
  }
}

function noteSniffed(tabId, url, kind) {
  if (!fitsGrabUrl(url)) return;
  let f = videoFinds.get(tabId);
  if (!f) {
    f = { frames: new Map(), sniffed: [] };
    videoFinds.set(tabId, f);
  }
  // What classifyStream said about each URL ("manifest" | "media"), by path
  // key, so an extensionless manifest can still be recognised at menu time.
  if (!f.kinds) f.kinds = new Map();
  f.kinds.set(urlPathKey(url), kind);
  if (f.kinds.size > 200) f.kinds.delete(f.kinds.keys().next().value);
  // Dedupe by path key: re-fetches with rotated tokens update the entry
  // instead of duplicating it. Trade-off: videos distinguished only by
  // query string collapse to the latest URL (rare in HLS practice).
  const key = urlPathKey(url);
  const idx = f.sniffed.findIndex((u) => urlPathKey(u) === key);
  if (idx >= 0) {
    f.sniffed[idx] = url;
  } else {
    f.sniffed.push(url);
    // Bound the list: a long-lived tab could otherwise grow it forever.
    if (f.sniffed.length > 50) f.sniffed.splice(0, f.sniffed.length - 50);
  }
}

// Refreshes are serialized through a promise chain: burst manifest traffic
// could otherwise interleave remove/create and hit duplicate menu ids.
let menuChain = Promise.resolve();

/// Rebuild the video submenu for the active tab. Menus are global, so this
/// only renders the tab the menu would open on.
function refreshVideoMenu(tabId) {
  menuChain = menuChain.then(() => doRefreshVideoMenu(tabId)).catch(() => {});
}

function safeMenuCreate(props) {
  try {
    const r = chrome.contextMenus.create(props);
    if (r && typeof r.catch === "function") r.catch(() => {});
  } catch {
    // Duplicate id from a raced rebuild; the next event rebuilds.
  }
}

async function doRefreshVideoMenu(tabId) {
  await restoreVideoFinds(tabId);
  const rebuild = async () => {
    // Re-read: the finds may have changed while the remove was in flight.
    // Played-only menu: the content script reports just videos the user started,
    // and sniffed manifests ride along only then — without a played video
    // the tab shows no video menu at all.
    let urls =
      tabId === activeTabId && domVideosFor(tabId).length > 0
        ? mergedVideoUrls(tabId)
        : [];
    // Backstop: collection already filters excluded hosts, but a tab may
    // have navigated there after its videos were recorded.
    if (urls.length > 0 && (await isExcludedTab(tabId))) urls = [];
    // One entry per video/stream; its rows go straight into the one submenu
    // (see "Menu rows").
    const finds = videoFinds.get(tabId);
    const heights = new Map(
      domVideosFor(tabId)
        .filter((v) => v && v.src && v.height > 0)
        .map((v) => [v.src, v.height]),
    );
    const entries = [];
    for (const u of urls) {
      entries.push(
        buildVideoEntry(u, {
          height: heights.get(u),
          kind: finds && finds.kinds && finds.kinds.get(urlPathKey(u)),
        }),
      );
    }
    const names = uniqueLabels(
      entries.map((e, i) =>
        videoName(e.url, i, finds && finds.title, e.kind),
      ),
    );
    menuUrls = [];
    if (entries.length === 0) {
      chrome.storage.session.set({ menuUrls: [] }).catch(() => {});
      if (Number.isInteger(tabId) && tabId >= 0 && !warnedTabs.has(tabId)) {
        const result = chrome.action.setBadgeText({ tabId, text: "" });
        if (result && typeof result.catch === "function") {
          result.catch(() => {});
        }
      }
      return;
    }
    const contexts = ["page", "video", "link"];
    safeMenuCreate({
      id: VIDEO_PARENT_ID,
      title: "Videos detected by Grab",
      contexts,
    });
    entries.forEach((entry, ei) => {
      if (ei > 0) {
        safeMenuCreate({
          id: `${VIDEO_ITEM_PREFIX}sep-${ei}`,
          parentId: VIDEO_PARENT_ID,
          type: "separator",
          contexts,
        });
      }
      for (const row of entry.rows) {
        // The id is the index into menuUrls, so a click resolves against the
        // list this menu was built from.
        const idx = menuUrls.push(row.url) - 1;
        safeMenuCreate({
          id: `${VIDEO_ITEM_PREFIX}${idx}`,
          parentId: VIDEO_PARENT_ID,
          title: menuRowTitle(names[ei], row.quality),
          contexts,
        });
      }
    });
    // Persist for worker restarts: menuUrls is in-memory and MV3 suspends
    // the worker; a click after a restart must still resolve.
    chrome.storage.session.set({ menuUrls }).catch(() => {});
    const badged = chrome.action.setBadgeText({
      tabId,
      text: String(urls.length),
    });
    if (badged && typeof badged.catch === "function") badged.catch(() => {});
  };
  // remove() drops the children too; a missing menu is fine.
  await removeContextMenu(VIDEO_PARENT_ID);
  await rebuild();
}

function clearVideoUi(tabId) {
  videoFinds.delete(tabId);
  forgetVideoFinds(tabId);
  warnedTabs.delete(tabId);
  if (tabId === activeTabId) {
    refreshVideoMenu(tabId); // rebuild sees no finds: drops the menu
    const badged = chrome.action.setBadgeText({ tabId, text: "" });
    if (badged && typeof badged.catch === "function") {
      badged.catch(() => {});
    }
  }
}

function clearAllVideoUi() {
  const tabIds = [...new Set([...videoFinds.keys(), activeTabId])]
    .filter((id) => Number.isInteger(id) && id >= 0);
  videoFinds.clear();
  for (const id of tabIds) forgetVideoFinds(id);
  // Clear records for inactive tabs restored by a previous worker instance.
  chrome.storage.session.get(null).then((stored) => {
    for (const key of Object.keys(stored || {})) {
      if (!key.startsWith("videoFinds:")) continue;
      const id = Number(key.slice("videoFinds:".length));
      if (Number.isInteger(id) && id >= 0) {
        videoFinds.delete(id);
        forgetVideoFinds(id);
      }
    }
  }).catch(() => {});
  refreshVideoMenu(activeTabId);
  for (const id of tabIds) {
    if (warnedTabs.has(id)) continue;
    const badged = chrome.action.setBadgeText({ tabId: id, text: "" });
    if (badged && typeof badged.catch === "function") {
      badged.catch(() => {});
    }
  }
}

/// Ask a tab's content script to re-sweep for videos (wiring shadow roots).
/// Debounced per tab, with one retry at ~1.5s in case the player mounts
/// just after the manifest is sniffed.
const rescanTimers = new Map();
function requestRescan(tabId) {
  if (rescanTimers.has(tabId)) return;
  const send = () => {
    chrome.tabs.sendMessage(tabId, { type: "grab-rescan" }).catch(() => {});
  };
  send();
  const retry = setTimeout(send, 1500);
  // Debounce: ignore further sniffs for 3s, then allow a new rescan.
  const reset = setTimeout(() => rescanTimers.delete(tabId), 3000);
  rescanTimers.set(tabId, { retry, reset });
}

function onVideoEvent(tabId) {
  if (!detectVideosOn) return;
  if (tabId === activeTabId) {
    refreshVideoMenu(tabId);
    return;
  }
  // The cached active tab can go stale (worker restarts, window-focus
  // races): verify against live state instead of silently dropping the
  // report — otherwise the menu never appears until the next tab switch.
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const liveActive = tabs && tabs[0] && tabs[0].id;
    if (liveActive == null) return;
    activeTabId = liveActive; // heal the stale cache
    if (tabId === liveActive) refreshVideoMenu(tabId);
  });
}

chrome.webRequest.onResponseStarted.addListener(
  async (details) => {
    if (!detectVideosOn) return;
    if (details.tabId == null || details.tabId < 0) return;
    // Classify first: it is synchronous and rejects nearly every response,
    // so the tabs.get round trip below only runs for real stream hits.
    const kind = classifyStream(
      details.url,
      sniffedHeader(details.responseHeaders, "content-type"),
    );
    if (kind === null) return;
    // Skip yt-dlp-exclusive hosts at collection time: their players use
    // auth-gated URLs, so sniffed manifests are unusable noise. Filtering
    // here (not just at menu-build) keeps videoFinds clean.
    if (await isExcludedTab(details.tabId)) return;
    await restoreVideoFinds(details.tabId);
    noteSniffed(details.tabId, details.url, kind);
    await persistVideoFinds(details.tabId);
    onVideoEvent(details.tabId);
    // A sniffed manifest may belong to a shadow-root player whose play
    // events never reach the document. Nudge the tab to re-sweep (wiring
    // shadow roots); debounced, with one retry in case the player mounts
    // just after the sniff.
    requestRescan(details.tabId);
  },
  {
    urls: ["http://*/*", "https://*/*"],
    // Players fetch streams as media or XHR/fetch requests; skip images,
    // scripts, stylesheets and documents.
    types: ["media", "xmlhttprequest", "other"],
  },
  ["responseHeaders"],
);

/// Content-script video reports. Dispatched from the single runtime listener below.
async function onVideoReport(msg, sender) {
  if (!msg || msg.type !== "grab-videos-detected") return;
  if (!detectVideosOn) return;
  const tabId = sender && sender.tab && sender.tab.id;
  if (tabId == null || tabId < 0) return;
  // Same collection-time filter: sender.tab.url is available synchronously.
  try {
    if (sender.tab.url && sharedHostExcluded(new URL(sender.tab.url).hostname)) return;
  } catch {
    // Unparseable URL: fall through and let the menu-build check decide.
  }
  await restoreVideoFinds(tabId);
  const frameId = sender && sender.frameId != null ? sender.frameId : 0;
  let f = videoFinds.get(tabId);
  if (!f) {
    f = { frames: new Map(), sniffed: [] };
    videoFinds.set(tabId, f);
  }
  // Ordinary empty re-reports may be a live stream swapping its <video>
  // element before the replacement fires play; preserve that snapshot. Pause,
  // end, and media-reset reports are marked authoritative so stale entries
  // disappear immediately instead of lingering in the context menu.
  const videos = (Array.isArray(msg.videos) ? msg.videos : []).filter(
    (v) => !(v && typeof v.src === "string" && !fitsGrabUrl(v.src)),
  );
  const hadFrame = f.frames.has(frameId);
  let changed = false;
  if (videos.length > 0 || !hadFrame || msg.replaceFrame === true) {
    f.frames.set(frameId, videos);
    changed = true;
  }
  // The video's own title for menu labels.
  // The top frame's title follows the page (SPAs change it without a
  // navigation); a subframe only fills a gap.
  if (typeof msg.title === "string" && msg.title && (frameId === 0 || !f.title)) {
    f.title = msg.title;
    changed = true;
  }
  // Skip the menu rebuild when nothing changed: a page with many iframes
  // would otherwise rebuild the menu once per frame on every load.
  if (changed) {
    await persistVideoFinds(tabId);
    onVideoEvent(tabId);
  }
}

// One runtime listener: dispatch every runtime message from a single place.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "grab-status") {
    grabStatus().then(sendResponse);
    return true; // Keep the channel open for the async answer.
  }
  return onVideoReport(msg, sender);
});

/// Status for the popup. With a stored code, Grab must prove it knows the code;
/// a plain listener on the port is not enough.
async function grabStatus() {
  const secret = await getPairingCode();
  if (!secret) return { state: "unpaired" };
  try {
    return { state: (await verifyGrab(secret)) ? "verified" : "unverified" };
  } catch {
    return { state: "down" };
  }
}

chrome.tabs.onActivated.addListener((info) => {
  activeTabId = info.tabId;
  refreshVideoMenu(info.tabId);
});

// Switching windows fires no tabs.onActivated: follow the focused window so
// the menu shows its active tab's videos.
if (chrome.windows && chrome.windows.onFocusChanged) {
  chrome.windows.onFocusChanged.addListener((windowId) => {
    if (windowId == null || windowId < 0) return; // WINDOW_ID_NONE
    chrome.tabs.query({ active: true, windowId }, (tabs) => {
      if (!tabs || !tabs[0] || tabs[0].id == null) return;
      activeTabId = tabs[0].id;
      refreshVideoMenu(activeTabId);
    });
  });
}

chrome.tabs.onRemoved.addListener((tabId) => {
  videoFinds.delete(tabId);
  forgetVideoFinds(tabId);
  warnedTabs.delete(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // New document loading in the tab: the page's videos are gone; the content
  // script reports fresh ones once it runs. (webNavigation.onCommitted would
  // need another manifest permission; tabs.onUpdated needs none.)
  if (changeInfo && changeInfo.status === "loading") clearVideoUi(tabId);
});

// After a worker restart the in-memory finds are gone but the content
// scripts are still injected: ask the active tab to report again.
chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  if (!tabs || !tabs[0] || tabs[0].id == null) return;
  activeTabId = tabs[0].id;
  const sent = chrome.tabs.sendMessage(tabs[0].id, { type: "grab-rescan" });
  if (sent && typeof sent.catch === "function") {
    sent.catch(() => {});
  }
});

// Test hook for node:test (MV3 service workers have no `module`).
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    toGrabUrl,
    isSkipped,
    minSizeBytes,
    decidePending,
    parkForSize,
    dropPending,
    isPending,
    classifyStream,
    videoName,
    menuRowTitle,
    mergeVideoFinds,
    mergedVideoUrls,
    snapshotVideoFinds,
    cookieRetentionPriority,
    limitHandoffCookies,
    fitHandoffBody,
    MAX_GRAB_URL_BYTES,
    MAX_HANDOFF_BODY_BYTES,
    MAX_VIDEO_ITEMS,
    manifestMenuRows,
    directMenuRow,
    manifestKind,
    buildVideoEntry,
    uniqueLabels,
    removeAllContextMenus,
    removeContextMenu,
    pendingKey,
    sharedHostExcluded,
    handOff,
    _setSleep,
    postToGrab,
    resolveStoreId,
    requestRescan,
    postToGrabWithRetry,
    verifyGrab,
    SHARED_EXCLUDED_HOSTS,
    SIZE_WAIT_MS,
    GRAB_SCHEME,
    // Test hook: inspect per-tab detections.
    _videoFinds: videoFinds,
    _warnedTabs: warnedTabs,
    _restoreVideoFinds: restoreVideoFinds,
    _persistVideoFinds: persistVideoFinds,
  };
}
