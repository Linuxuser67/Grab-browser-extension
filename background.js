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

const DEFAULTS = {
  interceptDownloads: false,
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
/// native messaging — no host manifest, no extension IDs, works from Flatpak.
const GRAB_HTTP_URL = "http://127.0.0.1:9412/add";

/// Delays before retrying when Grab answers 429 (its handoff queue is full).
const HANDOFF_RETRY_DELAYS_MS = [300, 900];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/// POST one URL to Grab. Resolves to the HTTP status, or 0 when Grab can't be
/// reached (not running).
async function postToGrab(url) {
  try {
    // Include the site's cookies so Grab's yt-dlp can pass bot challenges
    // (Cloudflare etc.). Scoped to the URL's domain only. Full attributes
    // preserve the browser's scope (host-only vs subdomain, path, secure,
    // expiry); Grab falls back gracefully when they're absent.
    let cookies = [];
    try {
      const all = await chrome.cookies.getAll({ url });
      cookies = all.map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        host_only: c.hostOnly,
        path: c.path,
        secure: c.secure,
        expiration_date: c.expirationDate,
      }));
    } catch {
      // Cookies unavailable (permission denied): send URL alone.
    }
    const resp = await fetch(GRAB_HTTP_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, cookies }),
    });
    return resp.status;
  } catch {
    return 0;
  }
}

/// Send the URL to Grab via HTTP. Resolves to true only when Grab accepted it.
/// A 429 means Grab's queue is momentarily full, so retry briefly first. Any
/// other outcome (Grab not running, 403, 414, …) is a failure: the caller must
/// leave the browser's own download alone. The caller validates the URL with
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
  if (/\.(mp4|m4v|webm|ogv|mov|mkv)$/.test(path)) return "media";
  return null;
}

const NAME_MAX = 40;
const shorten = (text) =>
  text.length > NAME_MAX ? text.slice(0, NAME_MAX) + "…" : text;

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
    if (title) return shorten(title);
  }
  return file ? shorten(file) : `Video ${index + 1}`;
}

// --- Master playlist preference ------------------------------------------
//
// HLS serves a master (multivariant) playlist plus per-rendition media
// playlists. Handing yt-dlp a media playlist directly yields a video-only
// (or audio-only) download — the master is what ties renditions to their
// audio tracks. When a master is confirmed among the detected manifests,
// its child media playlists are hidden from the menu so the only offered
// entry is the correct one.

/// Cache: playlist url -> text (capped). Masters are small; the cap keeps a
/// huge media playlist from bloating the worker. Failures stay uncached so a
/// later rebuild can retry.
const playlistCache = new Map();
const PLAYLIST_TEXT_CAP = 256 * 1024;

/// GET a text resource from the worker (5 s timeout), truncated to `cap`
/// characters. Null on any failure (network, non-2xx, abort).
async function fetchText(url, cap) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  let reader;
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return null;
    // Streaming path: bound memory by reading at most cap bytes.
    if (response.body && typeof response.body.getReader === "function") {
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let text = "";
      let bytesRead = 0;
      while (bytesRead < cap) {
        const { done, value } = await reader.read();
        if (done) break;
        const remaining = cap - bytesRead;
        const chunk = value.subarray(0, remaining);
        bytesRead += chunk.byteLength;
        text += decoder.decode(chunk, { stream: true });
        if (chunk.byteLength < value.byteLength || bytesRead >= cap) {
          await reader.cancel().catch(() => {});
          break;
        }
      }
      text += decoder.decode();
      return text;
    }
    // Fallback for environments without streaming body (tests).
    return (await response.text()).slice(0, cap);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    if (reader) reader.releaseLock();
  }
}

/// Fetch a playlist once and cache it. Null on any failure.
async function fetchPlaylistText(url) {
  if (playlistCache.has(url)) return playlistCache.get(url);
  const text = await fetchText(url, PLAYLIST_TEXT_CAP);
  if (text === null) return null;
  playlistCache.set(url, text);
  // Bounded: oldest entries go first (Map keeps insertion order).
  if (playlistCache.size > 200) {
    playlistCache.delete(playlistCache.keys().next().value);
  }
  return text;
}

/// True when the fetched playlist is a master (multivariant) playlist.
/// Null when the fetch failed or the content couldn't be read: the caller
/// treats that as "unknown", never as a media playlist.
async function isMasterPlaylist(url) {
  const text = await fetchPlaylistText(url);
  if (text === null) return null;
  // The marker lives in the header lines; cap the scan.
  return text.slice(0, 4096).includes("#EXT-X-STREAM-INF");
}

/// Origin + directory of a URL, for grouping a master with its children.
function urlDirectory(u) {
  try {
    const p = new URL(u);
    return p.origin + p.pathname.slice(0, p.pathname.lastIndexOf("/") + 1);
  } catch {
    return null;
  }
}

/// Resolve a possibly-relative playlist URI against the master playlist URL.
function absoluteUrl(uri, base) {
  try {
    return new URL(uri.trim(), base).toString();
  } catch {
    return null;
  }
}

// --- HLS variant parsing ---------------------------------------------------
//
// A master playlist lists its renditions as #EXT-X-STREAM-INF lines, each
// followed by the variant playlist URI. Parsing them lets the context menu
// offer per-quality entries ("1080p", "720p") instead of one opaque master
// URL — the Media Grabber pattern. Variants are cached alongside the master
// check so the playlist is fetched once.

/// Every rendition a master playlist references (resolved absolute URLs),
/// muxed and audio-grouped alike. Null when the fetch fails or no variants
/// are found.
async function fetchAllVariants(masterUrl) {
  const text = await fetchPlaylistText(masterUrl);
  const all = text === null ? [] : parseHlsVariants(text, masterUrl);
  return all.length > 0 ? all : null;
}

/// The EXT-X-MEDIA playlist URIs (audio, subtitles) a master references,
/// resolved absolute. Null when the fetch fails or none are found.
async function fetchAllMediaUris(masterUrl) {
  const text = await fetchPlaylistText(masterUrl);
  const uris = text === null ? [] : parseHlsMediaUris(text, masterUrl);
  return uris.length > 0 ? uris : null;
}

/// Parse EXT-X-MEDIA URI attributes from master playlist text. Returns
/// [url], resolved absolute against the master URL.
function parseHlsMediaUris(text, baseUrl) {
  const uris = [];
  const re = /#EXT-X-MEDIA:[^\r\n]*?URI="([^"]+)"/g;
  for (const m of text.matchAll(re)) {
    const url = absoluteUrl(m[1], baseUrl);
    if (url) uris.push(url);
  }
  return uris;
}

/// Parse HLS variants from master playlist text. Returns [{url, height,
/// bandwidth, audioGroup, fps, audioOnly}], height/bandwidth null when the
/// attributes are absent, audioGroup null when the variant has muxed audio
/// (no AUDIO= attribute pointing at an EXT-X-MEDIA group), audioOnly true
/// when CODECS lists no video codec.
function parseHlsVariants(text, baseUrl) {
  const variants = [];
  const re = /#EXT-X-STREAM-INF:([^\n\r]*)[\r\n]+([^\s#][^\r\n]*)/g;
  for (const m of text.matchAll(re)) {
    const attrs = m[1];
    const url = absoluteUrl(m[2], baseUrl);
    if (!url) continue;
    const res = /RESOLUTION=(\d+)x(\d+)/i.exec(attrs);
    const bw = /BANDWIDTH=(\d+)/i.exec(attrs);
    const audio = /AUDIO="([^"]+)"/i.exec(attrs);
    const fps = /FRAME-RATE=([\d.]+)/i.exec(attrs);
    const codecs = /CODECS="([^"]*)"/i.exec(attrs);
    variants.push({
      url,
      height: res ? parseInt(res[2], 10) : null,
      bandwidth: bw ? parseInt(bw[1], 10) : null,
      audioGroup: audio ? audio[1] : null,
      fps: fps ? parseFloat(fps[1]) : null,
      audioOnly:
        !!codecs && !/(avc|hvc|hev|vp0?9|vp8|av01|dvh)/i.test(codecs[1]),
    });
  }
  return variants;
}

/// Menu label for a variant, media-bridge's format:
/// "1080p • 8.00 Mbps • 60 fps". Falls back to the file name when no
/// quality attributes are present.
/// (Ported from jvillegasd/media-bridge, MIT, Copyright (c) 2026 Johnny Villegas.)
function variantMenuTitle(variant, index) {
  const parts = [];
  if (variant.height) {
    parts.push(`${variant.height}p`);
  }
  if (variant.bandwidth) {
    parts.push(`${(variant.bandwidth / 1000000).toFixed(2)} Mbps`);
  }
  if (variant.fps) {
    parts.push(`${variant.fps} fps`);
  }
  if (parts.length > 0) return parts.join(" • ");
  try {
    const name = decodeURIComponent(
      new URL(variant.url).pathname.split("/").filter(Boolean).pop() || "",
    );
    if (name) return name.length > 30 ? name.slice(0, 30) + "…" : name;
  } catch {
    // Fall through.
  }
  return `Variant ${index + 1}`;
}

const MANIFEST_RE = /\.(m3u8|m3u)([?#]|$)/i;

// --- DASH ------------------------------------------------------------------
//
// MPD manifests list video and audio as separate AdaptationSets, so a DASH
// stream is always "audio is separate". Service workers have no DOMParser;
// the few attributes needed are read with regexes.

/// Cache: mpd url -> [{height, bandwidth, fps}] (null when unreadable).
const dashCache = new Map();
const DASH_TEXT_CAP = 2 * 1024 * 1024;

/// Value of attribute `name` inside one tag's attribute text, or null.
function xmlAttr(attrs, name) {
  const m = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attrs || "");
  return m ? m[1] : null;
}

/// "30000/1001" -> 29.97, "25" -> 25, junk -> null.
function parseFrameRate(value) {
  if (!value) return null;
  const [n, d] = String(value).split("/");
  const num = parseFloat(n);
  const den = d === undefined ? 1 : parseFloat(d);
  if (!(num > 0) || !(den > 0)) return null;
  return Math.round((num / den) * 100) / 100;
}

/// Video representations of an MPD, best first: [{height, bandwidth, fps}].
/// Audio, subtitle and image sets are skipped; duplicates (same height and
/// bandwidth, e.g. across periods) collapse.
function parseDashRepresentations(text) {
  const out = [];
  const seen = new Set();
  const sets = String(text).matchAll(
    /<AdaptationSet\b([^>]*)>([\s\S]*?)<\/AdaptationSet>/gi,
  );
  for (const set of sets) {
    const setAttrs = set[1];
    for (const rep of set[2].matchAll(/<Representation\b([^>]*)>/gi)) {
      const a = rep[1];
      const mime =
        xmlAttr(a, "mimeType") ||
        xmlAttr(setAttrs, "mimeType") ||
        xmlAttr(setAttrs, "contentType") ||
        "";
      const height = parseInt(
        xmlAttr(a, "height") || xmlAttr(setAttrs, "height"),
        10,
      );
      if (!(/^video/i.test(mime) || (!mime && height > 0))) continue;
      const bandwidth = parseInt(xmlAttr(a, "bandwidth"), 10);
      const key = `${height}:${bandwidth}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        height: height > 0 ? height : null,
        bandwidth: bandwidth > 0 ? bandwidth : null,
        fps: parseFrameRate(
          xmlAttr(a, "frameRate") || xmlAttr(setAttrs, "frameRate"),
        ),
      });
    }
  }
  return out.sort(byQuality);
}

/// Fetch and parse an MPD once. Null when the fetch fails or no video
/// representation is found.
async function fetchDashRepresentations(url) {
  if (dashCache.has(url)) return dashCache.get(url);
  const text = await fetchText(url, DASH_TEXT_CAP);
  if (text === null) return null; // uncached: a later rebuild may retry
  const reps = parseDashRepresentations(text);
  const result = reps.length > 0 ? reps : null;
  dashCache.set(url, result);
  if (dashCache.size > 200) dashCache.delete(dashCache.keys().next().value);
  return result;
}

// --- Menu rows -------------------------------------------------------------
//
// One flat submenu ("Videos detected by Grab") holds every row, so sending a
// video to Grab is one click away. A row is {quality, url} and is shown as
// "<name> • <quality>". Grab takes exactly one URL, so:
//   - muxed HLS renditions get one row per quality, each handing its own
//     variant URL (video and audio in one);
//   - HLS with separate audio, and every DASH stream, can't pin a quality from
//     here: one row lists the qualities and hands over the master/MPD, which
//     Grab's yt-dlp merges with the audio and offers its own picker for;
//   - a direct file is one row handing the file.

const PICK_IN_GRAB = "pick in Grab";

/// Best quality first: height, then bandwidth.
const byQuality = (a, b) =>
  (b.height || 0) - (a.height || 0) || (b.bandwidth || 0) - (a.bandwidth || 0);

/// "1080p / 720p / 360p" from variants already sorted best first; at most
/// five heights, "…" when there are more. Empty when none has a height.
function heightList(variants) {
  const heights = [
    ...new Set(variants.map((v) => v.height).filter((h) => h > 0)),
  ];
  const shown = heights.slice(0, 5).map((h) => `${h}p`);
  if (heights.length > 5) shown.push("…");
  return shown.join(" / ");
}

const pickRowQuality = (variants) =>
  [heightList(variants), PICK_IN_GRAB].filter(Boolean).join(" • ");

/// Rows for an HLS URL. A media playlist (or an unreadable master) is one
/// plain row.
async function hlsMenuRows(url) {
  const all = await fetchAllVariants(url);
  const plain = [{ quality: "", url }];
  if (!all) return plain;
  const video = all.filter((v) => !v.audioOnly);
  const muxed = video.filter((v) => v.audioGroup === null).sort(byQuality);
  const bestMuxed = muxed.length > 0 ? muxed[0].height || 0 : 0;
  // Separate-audio renditions are listed only when they add something the
  // muxed ones don't (everything, or taller than the best muxed one).
  const split = video
    .filter((v) => v.audioGroup !== null)
    .filter((v) => muxed.length === 0 || (v.height || 0) > bestMuxed)
    .sort(byQuality);
  // A lone rendition hands the master: it is what ties the video to its audio.
  const rows =
    muxed.length === 1 && split.length === 0
      ? [{ quality: variantMenuTitle(muxed[0], 0), url }]
      : muxed.map((v, i) => ({ quality: variantMenuTitle(v, i), url: v.url }));
  if (split.length > 0) rows.push({ quality: pickRowQuality(split), url });
  return rows.length > 0 ? rows : plain;
}

/// One row for a DASH manifest: its qualities, handing the MPD to Grab.
async function dashMenuRows(url) {
  const reps = await fetchDashRepresentations(url);
  if (!reps) return [{ quality: "", url }];
  return [{ quality: pickRowQuality(reps), url }];
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

/// "hls", "dash" or null (a direct file). The extension decides; a manifest
/// sniffed by content type with no telling extension is read to find out.
async function manifestKind(url, sniffedKind) {
  let path;
  try {
    path = new URL(url).pathname;
  } catch {
    return null;
  }
  if (/\.(m3u8|m3u)$/i.test(path)) return "hls";
  if (/\.mpd$/i.test(path)) return "dash";
  if (sniffedKind !== "manifest") return null;
  const text = await fetchPlaylistText(url);
  if (text === null) return null;
  if (text.trimStart().startsWith("#EXTM3U")) return "hls";
  if (/<MPD\b/i.test(text.slice(0, 4096))) return "dash";
  return null;
}

/// Menu model for one detected URL: {url, kind, rows}. `ctx.sniffedKind` is
/// the classifyStream result when the URL came from webRequest; `ctx.height`
/// the height the player reported for a direct file.
async function buildVideoEntry(url, ctx = {}) {
  const kind = await manifestKind(url, ctx.sniffedKind);
  let rows;
  if (kind === "hls") rows = await hlsMenuRows(url);
  else if (kind === "dash") rows = await dashMenuRows(url);
  else rows = [directMenuRow(url, ctx.height)];
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

/// From the detected manifest URLs, drop media playlists that belong to a
/// confirmed master playlist: renditions the master references (wherever
/// they live) plus anything under the master's directory. Masters
/// themselves, non-manifest URLs, and manifests with no confirmed master
/// nearby are kept as-is.
async function preferMasterPlaylists(urls) {
  const manifests = urls.filter((u) => MANIFEST_RE.test(u));
  if (manifests.length === 0) return urls;
  const checks = await Promise.all(manifests.map(isMasterPlaylist));
  const masters = new Set();
  const masterDirs = new Set();
  // Renditions a confirmed master references: dropped even when they live
  // outside the master's directory (CDN-split deployments). Matched by
  // exact URL and by path key, so rotated tokens don't break grouping.
  // (Path-key technique ported from jvillegasd/media-bridge, MIT,
  // Copyright (c) 2026 Johnny Villegas.)
  const childUrls = new Set();
  const childPathKeys = new Set();
  // Manifests whose fetch failed: they may be masters the worker couldn't
  // read (expiring tokens), so a directory group with a failed fetch among
  // confirmed non-masters is probably one stream, not several.
  const fetchFailed = new Set();
  for (let i = 0; i < manifests.length; i++) {
    const u = manifests[i];
    if (checks[i] === true) {
      masters.add(u);
      const d = urlDirectory(u);
      if (d) masterDirs.add(d);
      const variants = await fetchAllVariants(u);
      for (const v of variants || []) {
        childUrls.add(v.url);
        childPathKeys.add(urlPathKey(v.url));
      }
      const mediaUris = await fetchAllMediaUris(u);
      for (const m of mediaUris || []) {
        childUrls.add(m);
        childPathKeys.add(urlPathKey(m));
      }
    } else if (checks[i] === null) {
      fetchFailed.add(u);
    }
  }
  // Group manifests by directory, in sniff order.
  const byDir = new Map();
  for (const u of manifests) {
    const d = urlDirectory(u);
    if (!d) continue;
    if (!byDir.has(d)) byDir.set(d, []);
    byDir.get(d).push(u);
  }
  // Fallback directories: several manifests, no confirmed master, but the
  // earliest-sniffed fetch failed among confirmed non-masters. The player
  // must fetch the master before its variants, so a failed fetch that
  // wasn't first is a different (dead) video, not this group's master.
  const fallbackKeep = new Set();
  for (const [, group] of byDir) {
    if (group.length < 2) continue;
    if (group.some((u) => masters.has(u))) continue;
    if (!fetchFailed.has(group[0])) continue;
    if (!group.slice(1).some((u) => !fetchFailed.has(u) && !masters.has(u))) {
      continue;
    }
    fallbackKeep.add(group[0]);
  }
  // The rest of each fallback group is dropped.
  const fallbackDrop = new Set();
  for (const [, group] of byDir) {
    const keeper = [...fallbackKeep].find((k) => group.includes(k));
    if (!keeper) continue;
    for (const u of group) {
      if (u !== keeper) fallbackDrop.add(u);
    }
  }
  return urls.filter((u) => {
    if (!MANIFEST_RE.test(u)) return true;
    if (masters.has(u)) return true;
    if (childUrls.has(u) || childPathKeys.has(urlPathKey(u))) return false;
    if (fallbackKeep.has(u)) return true;
    if (fallbackDrop.has(u)) return false;
    const d = urlDirectory(u);
    if (!d) return true;
    if (masterDirs.has(d)) return false;
    return true;
  });
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
/// The URLs behind the submenu items as last built (after filtering): a
/// click index resolves here, never against a fresh, differently-ordered list.
let menuUrls = [];
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
    // Prefer master playlists: hides child media playlists whose direct
    // download would miss the audio track.
    urls = await preferMasterPlaylists(urls);
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
        await buildVideoEntry(u, {
          sniffedKind: finds && finds.kinds && finds.kinds.get(urlPathKey(u)),
          height: heights.get(u),
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
      if (Number.isInteger(tabId) && tabId >= 0) {
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
  if (!detectVideosOn) return;
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
    removeAllContextMenus,
    removeContextMenu,
    pendingKey,
    hostExcluded,
    handOff,
    postToGrab,
    YTDLP_EXCLUSIVE_HOSTS,
    DEFAULTS,
    SIZE_WAIT_MS,
    GRAB_SCHEME,
    // Test hook: inspect per-tab detections.
    _videoFinds: videoFinds,
  };
}
