// Grab browser extension (MV3) — service worker.
//
// Three jobs:
//   1. Automatic interception: browser downloads are cancelled and handed to
//      the Grab desktop app through the grab: URI scheme (registered by the
//      app's .desktop entry as x-scheme-handler/grab).
//   2. Explicit sends: context menu and keyboard shortcut send the current
//      tab or a link/media URL to Grab. The toolbar button opens the options
//      page instead.
//   3. Video detection: <video> elements reported by the content script plus
//      stream manifests sniffed via webRequest are offered in the right-click
//      menu as "Download video with Grab", FDM-style.
//
// All listeners are registered synchronously at the top level: the worker is
// ephemeral and Chrome only wakes it for events it registered for on startup.

const GRAB_SCHEME = "grab://";

const DEFAULTS = {
  interceptDownloads: true,
  // Comma-separated file extensions the browser keeps handling itself.
  skipTypes: "",
  showContextMenu: true,
  // Detect videos playing in tabs (content script + webRequest sniffing)
  // and offer them in the right-click menu.
  detectVideos: true,
  // Minimum download size (MiB) that gets intercepted. 0 intercepts everything.
  minSizeMB: 0,
};

/// Wrap an http(s) URL for the Grab desktop app. Anything else (blob:, data:,
/// file:, …) cannot be handed off and returns null. The original scheme is
/// carried as the first path segment (grab://https/host/...) so Grab can
/// restore http vs https; needs Grab 4.7.1+.
function toGrabUrl(url) {
  if (typeof url !== "string") return null;
  const m = /^(https?):\/\/(.+)$/i.exec(url);
  if (!m) return null;
  return `${GRAB_SCHEME}${m[1].toLowerCase()}/${m[2]}`;
}

/// Explicit user action (keyboard shortcut, context menu):
/// navigate the active tab to the grab: URL. The user acted on this tab, and
/// external-protocol navigations are handed to the OS without replacing the
/// page (the mailto: mechanism), so the tab is left alone. Never use this for
/// automatic interception: the download can come from any tab, or none.
function sendToGrab(url) {
  const grabUrl = toGrabUrl(url);
  if (grabUrl) chrome.tabs.update({ url: grabUrl });
}

/// Native-messaging host name (see native-host/). The host runs outside the
/// browser sandbox and hands the grab:// URL to the OS directly — no tab,
/// no prompt, no focus steal. This bypasses the external-protocol approval
/// prompt, which Brave shows tab-modally with no "always allow": a
/// background tab's prompt is invisible to the user, so the tab-based
/// handoff silently dies there.
const NATIVE_HOST = "io.github.linuxuser67.grab";

/// Send the URL through the native host. Returns true when the host
/// accepted and launched it. The native host is the only handoff channel
/// (FDM/DownloadHelper pattern): there is no tab-based fallback — if the
/// host isn't installed, the download stays in the browser.
async function handOffNative(grabUrl) {
  try {
    const resp = await chrome.runtime.sendNativeMessage(NATIVE_HOST, {
      url: grabUrl,
    });
    return !!(resp && resp.success);
  } catch {
    // Host not installed (or failed).
    return false;
  }
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

async function interceptDownload(item) {
  const grabUrl = toGrabUrl(item.url);
  if (!grabUrl) return;
  // Hand off before cancelling: if the native host isn't installed, the
  // browser download is left alone (FDM/DownloadHelper pattern) instead of
  // being cancelled into a dead end.
  if (!(await handOffNative(grabUrl))) return;

  await claimDownload(item.id);
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

async function parkForSize(item) {
  // The alarm is only the worker-wakeup: the stored deadline is the real
  // timer. Packaged Chrome fires alarms no earlier than ~30s out, so the
  // effective wait in packaged builds is >= 30s even though the deadline is
  // sooner; the deadline still decides, so unpacked builds keep the short
  // wait for development.
  const deadline = Date.now() + SIZE_WAIT_MS;
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
const SIZE_WAIT_MS = 10_000;

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
      await parkForSize(item);
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
chrome.alarms.onAlarm.addListener((alarm) => {
  const m = /^size-wait:(\d+)$/.exec(alarm.name);
  if (m) decidePending(Number(m[1]));
});

chrome.downloads.onCreated.addListener(async (item) => {
  const settings = await getSettings();
  if (!settings.interceptDownloads) return;
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
    try {
      await chrome.downloads.removeFile(delta.id);
    } catch {
      // Already gone.
    }
    try {
      await chrome.downloads.erase({ id: delta.id });
    } catch {
      // Already gone.
    }
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
  await chrome.contextMenus.removeAll().catch(() => {});
  if (settings.showContextMenu) createContextMenu();
});

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "sync") return;
  if (changes.showContextMenu) {
    // removeAll first: rapid toggles would otherwise stack a duplicate-id
    // create on top of an in-flight one.
    await chrome.contextMenus.removeAll().catch(() => {});
    if (changes.showContextMenu.newValue) {
      createContextMenu();
    }
  }
  if (changes.detectVideos) {
    detectVideosOn = changes.detectVideos.newValue !== false;
    if (!detectVideosOn) clearAllVideoUi();
  }
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const id = info.menuItemId;
  if (typeof id === "string" && id.startsWith(VIDEO_ITEM_PREFIX)) {
    // A detected video: same explicit-send channel as the main item (the
    // user picked this tab), not the background-tab interception channel.
    const urls = mergedVideoUrls(tab && tab.id != null ? tab.id : activeTabId);
    const url = urls[Number(id.slice(VIDEO_ITEM_PREFIX.length))];
    if (url) sendToGrab(url);
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
    chrome.tabs.update({ url: magnet });
    return;
  }
  // Prefer the media/link target, but a blob:/data: media URL can't leave
  // the browser — fall back to the page URL so yt-dlp can extract it there.
  sendToGrab(candidates.find((u) => toGrabUrl(u)));
});

// The toolbar button now opens popup.html (default_popup in the manifest),
// which hosts the settings UI directly.

chrome.commands.onCommand.addListener((command) => {
  if (command !== "send-tab-to-grab") return;
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0] && tabs[0].url) sendToGrab(tabs[0].url);
  });
});

// --- Video detection ------------------------------------------------------
//
// FDM-style video menu: the content script reports <video> elements with
// direct http(s) sources, and webRequest sniffs the HLS/DASH stream
// manifests (.m3u8/.mpd) that blob:-based MSE players actually fetch.
// Detections are kept per tab and offered as right-click menu children; a
// toolbar badge shows the count. Picking an entry hands the URL to the Grab
// desktop app. Segment traffic (.ts/.m4s/...) is ignored so the menu isn't
// flooded with fragments.

const VIDEO_PARENT_ID = "grabVideos";
const VIDEO_ITEM_PREFIX = "grabVideo:";
const MAX_VIDEO_ITEMS = 8;

/// Video platforms yt-dlp extracts: their players use auth-gated/expiring
/// CDN URLs (or DRM), so a detected media URL handed to Grab can't succeed —
/// listing them only produces noise. Detection stays off on these hosts;
/// sending the page itself keeps going through yt-dlp the old way, which is
/// what handles them. Subdomains are covered by hostExcluded below.
const YTDLP_EXCLUSIVE_HOSTS = [
  "youtube.com",
  "youtu.be",
  "vimeo.com",
  "dailymotion.com",
  "dai.ly",
  "tiktok.com",
  "instagram.com",
  "facebook.com",
  "fb.com",
  "fb.watch",
  "twitter.com",
  "x.com",
  "twitch.tv",
];

/// True for the host itself and any subdomain ("www.tiktok.com"), never for
/// lookalikes ("tiktok.com.evil.com", "nottiktok.com").
function hostExcluded(host) {
  const h = String(host || "").toLowerCase();
  return YTDLP_EXCLUSIVE_HOSTS.some((d) => h === d || h.endsWith("." + d));
}

/// True when the tab lives on an excluded host. Host permissions are granted,
/// so tabs.get exposes the URL; anything odd (no tab, weird URL) is treated
/// as not excluded.
async function isExcludedTab(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    const url = tab && tab.url;
    return !!url && hostExcluded(new URL(url).hostname);
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
  if (/\.(m3u8|m3u|mpd)([?#]|$)/.test(u)) return "manifest";
  if (
    ct === "application/vnd.apple.mpegurl" ||
    ct === "application/x-mpegurl" ||
    ct === "audio/x-mpegurl" ||
    ct === "application/dash+xml"
  ) {
    return "manifest";
  }
  if (/\.(mp4|m4v|webm|ogv|mov|mkv)([?#]|$)/.test(u)) return "media";
  return null;
}

/// Menu title for a detected video: the file name, decoded and shortened.
function videoMenuTitle(url, index) {
  try {
    const name = decodeURIComponent(
      new URL(url).pathname.split("/").filter(Boolean).pop() || "",
    );
    if (name) return name.length > 40 ? name.slice(0, 40) + "…" : name;
  } catch {
    // Fall through to the numbered fallback.
  }
  return `Video ${index + 1}`;
}

/// Merge content-script reports (direct sources first) with sniffed stream
/// URLs, deduplicated. blob: entries carry no URL; they fall back to the
/// sniffed manifests.
function mergeVideoFinds(domVideos, sniffedUrls) {
  const out = [];
  const seen = new Set();
  const push = (u) => {
    if (typeof u === "string" && u && !seen.has(u)) {
      seen.add(u);
      out.push(u);
    }
  };
  for (const v of domVideos || []) push(v && v.src);
  for (const u of sniffedUrls || []) push(u);
  return out;
}

// Per-tab detections: tabId -> { frames: Map(frameId -> [{src, blob}]),
// sniffed: [url] }. Reports are tracked per frame because the content script
// runs in all frames; last-writer-wins per tab would drop other frames'
// videos whenever two frames report at different times.
const videoFinds = new Map();
let activeTabId = null;
let detectVideosOn = DEFAULTS.detectVideos;

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
  return f ? mergeVideoFinds(domVideosFor(tabId), f.sniffed).slice(0, MAX_VIDEO_ITEMS) : [];
}

function sniffedHeader(headers, name) {
  for (const h of headers || []) {
    if (h.name && h.name.toLowerCase() === name) return h.value || "";
  }
  return "";
}

function noteSniffed(tabId, url) {
  let f = videoFinds.get(tabId);
  if (!f) {
    f = { frames: new Map(), sniffed: [] };
    videoFinds.set(tabId, f);
  }
  if (!f.sniffed.includes(url)) {
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

function doRefreshVideoMenu(tabId) {
  const rebuild = async () => {
    // Re-read: the finds may have changed while the remove was in flight.
    let urls = tabId === activeTabId ? mergedVideoUrls(tabId) : [];
    if (urls.length > 0 && (await isExcludedTab(tabId))) urls = [];
    if (urls.length === 0) return;
    safeMenuCreate({
      id: VIDEO_PARENT_ID,
      title: "Videos detected by Grab",
      contexts: ["page", "video", "link"],
    });
    urls.forEach((u, i) => {
      safeMenuCreate({
        id: `${VIDEO_ITEM_PREFIX}${i}`,
        parentId: VIDEO_PARENT_ID,
        title: videoMenuTitle(u, i),
        contexts: ["page", "video", "link"],
      });
    });
    const badged = chrome.action.setBadgeText({
      tabId,
      text: String(urls.length),
    });
    if (badged && typeof badged.catch === "function") badged.catch(() => {});
  };
  // remove() drops the children too; a missing menu rejects, which is fine.
  const removed = chrome.contextMenus.remove(VIDEO_PARENT_ID);
  if (removed && typeof removed.then === "function") {
    return removed.then(rebuild, rebuild);
  }
  rebuild();
  return undefined;
}

function clearVideoUi(tabId) {
  videoFinds.delete(tabId);
  if (tabId === activeTabId) {
    refreshVideoMenu(tabId); // rebuild sees no finds: drops the menu
    const badged = chrome.action.setBadgeText({ tabId, text: "" });
    if (badged && typeof badged.catch === "function") {
      badged.catch(() => {});
    }
  }
}

function clearAllVideoUi() {
  const tabIds = [...videoFinds.keys()];
  videoFinds.clear();
  refreshVideoMenu(activeTabId);
  for (const id of tabIds) {
    const badged = chrome.action.setBadgeText({ tabId: id, text: "" });
    if (badged && typeof badged.catch === "function") {
      badged.catch(() => {});
    }
  }
}

function onVideoEvent(tabId) {
  if (!detectVideosOn) return;
  if (tabId !== activeTabId) return;
  refreshVideoMenu(tabId);
}

chrome.webRequest.onResponseStarted.addListener(
  (details) => {
    if (!detectVideosOn) return;
    if (details.tabId == null || details.tabId < 0) return;
    const kind = classifyStream(
      details.url,
      sniffedHeader(details.responseHeaders, "content-type"),
    );
    if (kind === null) return;
    noteSniffed(details.tabId, details.url);
    onVideoEvent(details.tabId);
  },
  { urls: ["http://*/*", "https://*/*"] },
  ["responseHeaders"],
);

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.type !== "grab-videos-detected") return;
  if (!detectVideosOn) return;
  const tabId = sender && sender.tab && sender.tab.id;
  if (tabId == null || tabId < 0) return;
  const frameId = sender && sender.frameId != null ? sender.frameId : 0;
  let f = videoFinds.get(tabId);
  if (!f) {
    f = { frames: new Map(), sniffed: [] };
    videoFinds.set(tabId, f);
  }
  f.frames.set(frameId, Array.isArray(msg.videos) ? msg.videos : []);
  onVideoEvent(tabId);
});

chrome.tabs.onActivated.addListener((info) => {
  activeTabId = info.tabId;
  refreshVideoMenu(info.tabId);
});

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
    videoMenuTitle,
    mergeVideoFinds,
    hostExcluded,
    handOffNative,
    NATIVE_HOST,
    YTDLP_EXCLUSIVE_HOSTS,
    DEFAULTS,
    SIZE_WAIT_MS,
    GRAB_SCHEME,
  };
}
