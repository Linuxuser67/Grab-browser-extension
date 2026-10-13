// Handoff: pairing, HTTP POST to Grab, download interception.
// Imports shared constants from config.js.
import {
  GRAB_SCHEME,
  GRAB_BASE_URL,
  GRAB_HTTP_URL,
  HANDOFF_RETRY_DELAYS_MS,
  CONFIRM_TIMEOUT_MS,
  HELLO_TIMEOUT_MS,
  SERVER_CONTEXT,
  CLIENT_CONTEXT,
  PAIRING_CODE_RE,
  STATUS_UNVERIFIED,
  DEFAULTS,
  SIZE_WAIT_MS,
} from "./config.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function toGrabUrl(url) {
  if (typeof url !== "string") return null;
  const m = /^(https?):\/\/(.+)$/i.exec(url);
  if (!m) return null;
  // user:pass@host: Grab refuses credentials in links, and the grab: URL
  // passes through argv (xdg-open), which other local users can read.
  if (m[2].split(/[/?#]/, 1)[0].includes("@")) return null;
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
// --- Pairing ---------------------------------------------------------------
//
// Any local process can listen on 127.0.0.1:9412 before Grab does. Once the
// user has pasted Grab's pairing code into the options page, the extension
//   1. makes Grab prove it knows the code (GET /hello) before anything else,
//   2. only then sends the page's cookies, and
//   3. signs the request body, so Grab can tell this extension from any other.
// Without a code it still hands URLs off, but never sends cookies.


/// The pairing code lives in local storage, not sync: it is a secret for this
/// machine's Grab and must not follow the profile to other devices.
async function getPairingCode() {
  try {
    const { pairingCode } = await chrome.storage.local.get({ pairingCode: "" });
    const code = String(pairingCode || "").trim().toLowerCase();
    return PAIRING_CODE_RE.test(code) ? code : "";
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

/// The site's cookies in the shape Grab expects. Needs the optional `cookies`
/// permission; without it (or on any failure) the handoff is URL-only.
async function readCookies(url) {
  try {
    const all = await chrome.cookies.getAll({ url });
    return all.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      host_only: c.hostOnly,
      path: c.path,
      secure: c.secure,
      expiration_date: c.expirationDate,
    }));
  } catch {
    return [];
  }
}

/// POST one URL to Grab and wait for its answer to the confirm dialog.
/// Resolves to the HTTP status, 0 when Grab can't be reached (not running),
/// or STATUS_UNVERIFIED when the listener could not prove it is Grab.
async function postToGrab(url) {
  try {
    const secret = await getPairingCode();
    let cookies = [];
    if (secret) {
      if (!(await verifyGrab(secret))) return STATUS_UNVERIFIED;
      // Cookies let Grab's yt-dlp pass bot challenges (Cloudflare etc.).
      // They go only to a Grab that has proven it holds the pairing code.
      cookies = await readCookies(url);
    }
    const body = JSON.stringify({ url, cookies });
    const headers = { "Content-Type": "application/json" };
    if (secret) headers["X-Grab-Token"] = await hmacHex(secret, CLIENT_CONTEXT, body);
    // confirm=1: Grab answers only once the user has approved or declined, so
    // the browser's own download is cancelled only when Grab really took over.
    const resp = await fetchWithTimeout(
      `${GRAB_HTTP_URL}?confirm=1`,
      { method: "POST", headers, body },
      CONFIRM_TIMEOUT_MS,
    );
    return resp.status;
  } catch {
    return 0;
  }
}

/// Send the URL to Grab via HTTP. Resolves to true only when Grab accepted it.
/// A 429 means Grab's queue is momentarily full, so retry briefly first. Any
/// other outcome (Grab not running or not verified, declined by the user (409),
/// no answer in time (408), 403, 414, …) is a failure: the caller must leave
/// the browser's own download alone. The caller validates the URL with
/// toGrabUrl first; the raw URL is posted as-is.
async function handOff(url, retryDelays = HANDOFF_RETRY_DELAYS_MS) {
  let status = await postToGrab(url);
  for (const delay of retryDelays) {
    if (status !== 429) break;
    await sleep(delay);
    status = await postToGrab(url);
  }
  return status >= 200 && status < 300;
}

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
  return chrome.storage.sync.get(DEFAULTS);
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
  // Non-http(s) URLs (blob:, data:) and URLs with credentials can't be
  // handed over.
  if (!toGrabUrl(item.url)) return;
  // Hand off over Grab's local HTTP endpoint. If Grab isn't running or
  // refuses the request, the download is left to the browser.
  if (!(await handOff(item.url))) return;

  await claimDownload(item.id);
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

// How long to wait for a server to report the size before treating an
// unknown size as big enough to intercept (streams rarely send one, and they
// belong in Grab).

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
    await dropPending(id);

    const settings = await getSettings();
    const items = await chrome.downloads.search({ id });
    const item = items[0];
    if (!item) return;
    // The download finished or failed while parked (or in the async gap
    // between deciding to park and persisting the pending state): too late
    // to hand over — leave the browser copy alone.
    if (item.state === "complete" || item.state === "interrupted") return;
    // The user may have changed their mind while we waited.
    if (!settings.interceptDownloads) return;
    if (isSkipped(item.url, settings.skipTypes)) return;
    if (!toGrabUrl(item.url)) return;
    if (item.fileSize >= 0) {
      // Size is known: small enough stays in the browser, big enough is
      // intercepted now.
      if (item.fileSize < minSizeBytes(settings)) return;
    } else if (Date.now() < deadline) {
      // Size still unknown but the deadline hasn't passed: this call came
      // too early (the alarm is only the wakeup). Re-park and wait for the
      // real deadline instead of intercepting early.
      await parkForSize(item, deadline);
      return;
    }
    // Unknown size past the deadline: streams rarely report one, and they
    // belong in Grab (see SIZE_WAIT_MS).
    await interceptDownload(item);
  } finally {
    deciding.delete(id);
  }
}

// Size-wait deadline: decide the parked download even if the worker was
// restarted while it was parked (the pending set survived in session storage).
// --- Explicit sends -------------------------------------------------------

function createContextMenu() {
  chrome.contextMenus.create({
    id: "sendToGrab",
    title: "Download with Grab",
    contexts: ["link", "video", "audio", "image", "page"],
  });
}
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
/// Reset module state for tests (worker restart simulation).
function __resetHandoffState() {
  deciding.clear();
}

export {
  toGrabUrl,
  sendToGrab,
  updateTab,
  sleep,
  getPairingCode,
  hexToBytes,
  bytesToHex,
  hmacHex,
  constantTimeEqual,
  fetchWithTimeout,
  verifyGrab,
  readCookies,
  postToGrab,
  handOff,
  isSkipped,
  getSettings,
  claimDownload,
  unclaimDownload,
  isClaimed,
  removeBrowserCopy,
  interceptDownload,
  pendingKey,
  isPending,
  parkForSize,
  dropPending,
  minSizeBytes,
  decidePending,
  createContextMenu,
  removeAllContextMenus,
  removeContextMenu,
  __resetHandoffState,
};
