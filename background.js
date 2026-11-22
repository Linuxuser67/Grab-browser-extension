// Grab browser extension (MV3) — background entry point.
//
// The worker's code is split by job:
//   - handoff.js: pairing, cookies, HTTP/grab:// handoff, explicit sends.
//   - intercept.js: automatic download interception.
//   - video-state.js: per-tab video detections and their session persistence.
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
  importScripts(
    "shared.js",
    "handoff.js",
    "intercept.js",
    "video-state.js",
    "video-menu.js",
  );
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
  syncVideoScript();
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
/// "!" until Grab verifies successfully. The badge outlives the worker, so the
/// set is written through to session storage and rebuilt on startup; without
/// that, a restarted worker forgets which tabs are warned and the next
/// handoff overwrites the warning. Session storage clears with the browser,
/// matching tab-id lifetime.
///
/// Other in-memory coordination (wakeInFlight, deciding, rescanTimers) is
/// intentionally not persisted: it only guards work inside one worker
/// lifetime, and a restart abandons that work anyway.
const WARNED_TABS_KEY = "warnedTabs";
class PersistedTabSet extends Set {
  add(tabId) {
    const had = this.has(tabId);
    super.add(tabId);
    if (!had) this._save();
    return this;
  }
  delete(tabId) {
    const removed = super.delete(tabId);
    if (removed) this._save();
    return removed;
  }
  _save() {
    try {
      const saved = chrome.storage.session.set({ [WARNED_TABS_KEY]: [...this] });
      if (saved && typeof saved.catch === "function") saved.catch(() => {});
    } catch {
      // Storage unavailable: the in-memory set still works for this lifetime.
    }
  }
  async restore() {
    try {
      const stored = await chrome.storage.session.get(WARNED_TABS_KEY);
      const ids = stored && stored[WARNED_TABS_KEY];
      if (Array.isArray(ids)) {
        // Union, not replace: a warning added while this read was in flight
        // must survive it. Calls super.add: hydration needs no write-back.
        for (const id of ids) if (Number.isInteger(id)) super.add(id);
      }
    } catch {
      // Nothing to restore.
    }
  }
}
const warnedTabs = new PersistedTabSet();
const warnedTabsReady = warnedTabs.restore();

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
  // Messages are internal to this extension. Page content scripts may report
  // detections, but the popup-only status request must never be answered to a tab.
  if (!sender || sender.id !== chrome.runtime.id) return false;
  if (msg && msg.type === "grab-status") {
    if (sender.tab) return false;
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
    withWorkerKeepAlive,
    KEEPALIVE_INTERVAL_MS,
    registerSniffer,
    syncVideoScript,
    hasPageAccess,
    VIDEO_SCRIPT_ID,
    warnedTabsReady,
    mergeVideoFinds,
    findVideoForSource,
    resolvedBlobVideoUrlForFrame,
    resolvedVideoUrlsForFrame,
    menuVideoCandidatesForFrame,
    attributedManifestUrlsForVideo,
    preservedSniffsForOtherPlayers,
    wholeVideoMediaSize,
    wholeMediaUrlsForFrame,
    isSegmentLikeVideoUrl,
    isByteRangeSliceUrl,
    isHlsRenditionPlaylistPath,
    nestedHlsPlaylistChildKeys,
    MIN_WHOLE_VIDEO_MEDIA_BYTES,
    VIDEO_MANIFEST_ATTRIBUTION_WINDOW_MS,
    resolvedVideoUrls,
    preferMasterPlaylists,
    hlsChildPlaylistKeys,
    snapshotVideoFinds,
    cookieRetentionPriority,
    limitHandoffCookies,
    fitHandoffBody,
    MAX_GRAB_URL_BYTES,
    MAX_HANDOFF_BODY_BYTES,
    MAX_VIDEO_ITEMS,
    MAX_VIDEO_FRAMES,
    MAX_VIDEO_TITLE_LENGTH,
    manifestMenuRows,
    directMenuRow,
    manifestKind,
    buildVideoEntry,
    uniqueLabels,
    removeAllContextMenus,
    removeContextMenu,
    pendingKey,
    _setSleep,
    postToGrab,
    normalizeReferer,
    inspectHlsPlaylistWithGrab,
    // Test hook: the raw playlist inspection result (is_master, child_keys).
    inspectHlsPlaylist,
    HLS_INSPECTION_HANDSHAKE_MAX_AGE_MS,
    HLS_PUBLIC_INSPECTION_CACHE_TTL_MS,
    HLS_PUBLIC_INSPECTION_CACHE_MAX_ENTRIES,
    resolveStoreId,
    requestRescan,
    postToGrabWithRetry,
    explicitSend,
    wakeGrabAndWait,
    _setWakeTimeout,
    verifyGrab,
    grabStatus,
    SIZE_WAIT_MS,
    GRAB_SCHEME,
    // Test hook: inspect per-tab detections.
    _videoFinds: videoFinds,
    _warnedTabs: warnedTabs,
    _restoreVideoFinds: restoreVideoFinds,
    _persistVideoFinds: persistVideoFinds,
  };
}
