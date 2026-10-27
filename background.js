// Grab browser extension (MV3) — background entry point.
//
// The worker's code is split by job:
//   - handoff.js: pairing, cookies, HTTP/grab:// handoff, explicit sends.
//   - intercept.js: automatic download interception.
//   - video-menu.js: video detection and the right-click menu.
// This file holds the shared helpers and the runtime message dispatcher.
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

// The Chrome MV3 service worker loads its sibling scripts here. Firefox lists
// them in manifest.firefox.json before this file, so the globals already
// exist there (importScripts only exists in workers).
if (
  typeof SHARED_DEFAULTS === "undefined" &&
  typeof importScripts === "function"
) {
  importScripts("shared.js", "handoff.js", "intercept.js", "video-menu.js");
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

/// Keep URL and body limits aligned with Grab's server-side validation.
/// The body limit is measured as UTF-8 bytes over the exact JSON string sent.
const MAX_GRAB_URL_BYTES = 2048;
// Bound menu creation and per-tab DOM snapshots while retaining many videos.
const MAX_VIDEO_ITEMS = 50;
/// Grab rejects longer URLs (HTTP 414), so they are never worth tracking.
const fitsGrabUrl = (u) =>
  typeof u === "string" && new TextEncoder().encode(u).length <= MAX_GRAB_URL_BYTES;

/// Tabs showing the "unverified Grab" warning badge. Warned tabs keep their
/// "!" until Grab verifies successfully.
const warnedTabs = new Set();

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

getSettings().then((s) => {
  videoUi.detectVideosOn = s.detectVideos !== false;
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "grab-status") {
    grabStatus().then(sendResponse);
    return true; // Keep the channel open for the async answer.
  }
  return onVideoReport(msg, sender);
});

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
    _setSleep,
    postToGrab,
    resolveStoreId,
    requestRescan,
    postToGrabWithRetry,
    explicitSend,
    wakeGrabAndWait,
    _setWakeTimeout,
    verifyGrab,
    grabStatus,
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
