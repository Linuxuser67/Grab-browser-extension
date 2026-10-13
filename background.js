// Grab browser extension (MV3) — service worker entry point.
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

import {
  GRAB_SCHEME,
  DEFAULTS,
  VIDEO_ITEM_PREFIX,
  YTDLP_EXCLUSIVE_HOSTS,
  SIZE_WAIT_MS,
} from "./config.js";
import {
  toGrabUrl,
  sendToGrab,
  updateTab,
  postToGrab,
  verifyGrab,
  handOff,
  isSkipped,
  getSettings,
  claimDownload,
  unclaimDownload,
  isClaimed,
  removeBrowserCopy,
  interceptDownload,
  isPending,
  parkForSize,
  dropPending,
  minSizeBytes,
  decidePending,
  pendingKey,
  createContextMenu,
  removeAllContextMenus,
  removeContextMenu,
  __resetHandoffState,
} from "./handoff.js";
import {
  hostExcluded,
  isExcludedTab,
  sniffedHeader,
  classifyStream,
  videoName,
  menuRowTitle,
  mergeVideoFinds,
  isMasterPlaylist,
  preferMasterPlaylists,
  urlDirectory,
  parseHlsVariants,
  fetchAllVariants,
  parseDashRepresentations,
  hlsMenuRows,
  dashMenuRows,
  directMenuRow,
  manifestKind,
  buildVideoEntry,
  uniqueLabels,
  variantMenuTitle,
  fetchText,
  isFetchAllowed,
  refreshVideoMenu,
  clearVideoUi,
  clearAllVideoUi,
  onVideoEvent,
  noteSniffed,
  videoFinds,
  setDetectVideosOn,
  getDetectVideosOn,
  getMenuUrls,
  setActiveTabId,
  __resetVideoState,
} from "./video.js";

// --- Startup ---------------------------------------------------------------

// Browser startup time (Varia pattern): chrome.downloads.onCreated can re-fire
// on startup for downloads from a previous session. Anything with a startTime
// older than this is ignored so a cancelled download doesn't re-prompt on
// every browser launch. Kept in session storage, not a variable: the worker
// restarts whenever it idles, and a per-worker timestamp would postdate the
// startTime of the very download that woke it.
chrome.runtime.onStartup.addListener(() => {
  chrome.storage.session.set({ browserStartTime: Date.now() });
});

// --- Download interception listeners ---------------------------------------

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
  if (isSkipped(item.url, settings.skipTypes)) return;
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

// --- Explicit sends --------------------------------------------------------

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
    }
  }
  if (changes.detectVideos) {
    const on = changes.detectVideos.newValue !== false;
    setDetectVideosOn(on);
    if (!on) clearAllVideoUi();
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
    let urls = getMenuUrls();
    if (urls.length === 0) {
      try {
        const stored = await chrome.storage.session.get("menuUrls");
        if (Array.isArray(stored.menuUrls)) urls = stored.menuUrls;
      } catch {
        // Fall through with the empty list.
      }
    }
    const url = urls[Number(id.slice(VIDEO_ITEM_PREFIX.length))];
    if (url) sendToGrab(url, tab && tab.id);
    return;
  }
  if (id !== "sendToGrab") return;
  const candidates = [info.linkUrl, info.srcUrl, info.pageUrl];
  // Magnet links already open in Grab through the OS handler; pass them
  // through unwrapped.
  const magnet = candidates.find(
    (u) => typeof u === "string" && u.toLowerCase().startsWith("magnet:"),
  );
  if (magnet) {
    updateTab(tab && tab.id, magnet);
    return;
  }
  // Prefer the media/link target, but a blob:/data: media URL can't leave
  // the browser — fall back to the page URL so yt-dlp can extract it there.
  sendToGrab(candidates.find((u) => toGrabUrl(u)), tab && tab.id);
});

// The toolbar button now opens popup.html (default_popup in the manifest),
// which hosts the settings UI directly.

chrome.commands.onCommand.addListener((command) => {
  if (command !== "send-tab-to-grab") return;
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0] && tabs[0].url) sendToGrab(tabs[0].url, tabs[0].id);
  });
});

// --- Video detection listeners ---------------------------------------------

chrome.webRequest.onResponseStarted.addListener(
  async (details) => {
    if (!getDetectVideosOn()) return;
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
    noteSniffed(details.tabId, details.url, kind);
    onVideoEvent(details.tabId);
  },
  {
    urls: ["http://*/*", "https://*/*"],
    // Players fetch streams as media or XHR/fetch requests; skip images,
    // scripts, stylesheets and documents.
    types: ["media", "xmlhttprequest", "other"],
  },
  ["responseHeaders"],
);

chrome.runtime.onMessage.addListener(async (msg, sender) => {
  if (!msg || msg.type !== "grab-videos-detected") return;
  if (!getDetectVideosOn()) return;
  const tabId = sender && sender.tab && sender.tab.id;
  if (tabId == null || tabId < 0) return;
  // Same collection-time filter: sender.tab.url is available synchronously.
  try {
    if (sender.tab.url && hostExcluded(new URL(sender.tab.url).hostname)) return;
  } catch {
    // Unparseable URL: fall through and let the menu-build check decide.
  }
  const frameId = sender && sender.frameId != null ? sender.frameId : 0;
  let f = videoFinds.get(tabId);
  if (!f) {
    f = { frames: new Map(), sniffed: [] };
    videoFinds.set(tabId, f);
  }
  f.frames.set(frameId, Array.isArray(msg.videos) ? msg.videos : []);
  // The video's own title (og:title) for menu labels; first report wins.
  if (typeof msg.title === "string" && msg.title && !f.title) {
    f.title = msg.title;
  }
  onVideoEvent(tabId);
});

chrome.tabs.onActivated.addListener((info) => {
  setActiveTabId(info.tabId);
  refreshVideoMenu(info.tabId);
});

// Switching windows fires no tabs.onActivated: follow the focused window so
// the menu shows its active tab's videos.
if (chrome.windows && chrome.windows.onFocusChanged) {
  chrome.windows.onFocusChanged.addListener((windowId) => {
    if (windowId == null || windowId < 0) return; // WINDOW_ID_NONE
    chrome.tabs.query({ active: true, windowId }, (tabs) => {
      if (!tabs || !tabs[0] || tabs[0].id == null) return;
      setActiveTabId(tabs[0].id);
      refreshVideoMenu(tabs[0].id);
    });
  });
}

chrome.tabs.onRemoved.addListener((tabId) => {
  videoFinds.delete(tabId);
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
  setActiveTabId(tabs[0].id);
  const sent = chrome.tabs.sendMessage(tabs[0].id, { type: "grab-rescan" });
  if (sent && typeof sent.catch === "function") {
    sent.catch(() => {});
  }
});

// --- Test hooks ------------------------------------------------------------
// Re-exported for node:test.

function __resetForTests() {
  __resetHandoffState();
  __resetVideoState();
}

export {
  // config
  GRAB_SCHEME,
  DEFAULTS,
  YTDLP_EXCLUSIVE_HOSTS,
  SIZE_WAIT_MS,
  // handoff
  toGrabUrl,
  isSkipped,
  minSizeBytes,
  decidePending,
  parkForSize,
  dropPending,
  isPending,
  handOff,
  postToGrab,
  verifyGrab,
  pendingKey,
  removeAllContextMenus,
  removeContextMenu,
  // video
  classifyStream,
  videoName,
  menuRowTitle,
  mergeVideoFinds,
  isMasterPlaylist,
  preferMasterPlaylists,
  urlDirectory,
  parseHlsVariants,
  fetchAllVariants,
  parseDashRepresentations,
  hlsMenuRows,
  dashMenuRows,
  directMenuRow,
  manifestKind,
  buildVideoEntry,
  uniqueLabels,
  variantMenuTitle,
  hostExcluded,
  isFetchAllowed,
  fetchText,
  // Test hook: inspect per-tab detections.
  videoFinds as _videoFinds,
  __resetForTests,
};
