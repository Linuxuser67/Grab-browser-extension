// Grab browser extension: video detection and the right-click menu.
// Loaded by background.js (Chrome importScripts) or listed before it
// in manifest.firefox.json; all files share one global scope.

/// Video-menu state shared with handoff.js's explicit sends: the active tab,
/// the URL list a click index resolves against, and the user's detect-videos
/// setting. Declared here because this module's listeners read it first.
const videoUi = {
  activeTabId: null,
  menuUrls: [],
  detectVideosOn: SHARED_DEFAULTS.detectVideos,
};

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

/// A sniffed/DOM kind that denotes a playlist rather than a direct file.
function isManifestKind(kind) {
  return kind === "hls" || kind === "dash" || kind === "manifest";
}

/// Merge user-played DOM sources with sniffed requests. Ignore rotating auth
/// query strings and group a direct rendition with its manifest directory only
/// when that directory holds a single stream family. Distinct manifests keep
/// distinct entries, so a second video in the same directory is not dropped.
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

  // Discover manifest families per directory. One HLS and one DASH manifest
  // in the same directory are protocol alternates of one stream; any other
  // combination stays separate.
  const byFolder = new Map();
  for (const item of candidates) {
    const kind = manifestKind(item.url) || item.kind;
    if (!isManifestKind(kind)) continue;
    const folder = manifestFolderKey(item.url, kind);
    if (!folder) continue;
    let bucket = byFolder.get(folder);
    if (!bucket) {
      bucket = { hls: new Set(), dash: new Set(), manifest: new Set() };
      byFolder.set(folder, bucket);
    }
    bucket[kind].add(urlPathKey(item.url));
  }

  const familyFor = new Map();
  const familiesByFolder = new Map();
  for (const [folder, bucket] of byFolder) {
    const hls = [...bucket.hls];
    const dash = [...bucket.dash];
    const paired = hls.length === 1 && dash.length === 1;
    const families = new Set();
    const familyOf = (key, family) => {
      familyFor.set(`${folder}\u0000${key}`, family);
      families.add(family);
    };
    for (const key of hls) familyOf(key, paired ? hls[0] : key);
    for (const key of dash) familyOf(key, paired ? hls[0] : key);
    for (const key of bucket.manifest) familyOf(key, key);
    familiesByFolder.set(folder, families);
  }

  const groups = new Map();
  candidates.forEach((item, order) => {
    const kind = manifestKind(item.url) || item.kind;
    let key;
    if (isManifestKind(kind)) {
      const folder = manifestFolderKey(item.url, kind);
      key =
        (folder && familyFor.get(`${folder}\u0000${urlPathKey(item.url)}`)) ||
        urlPathKey(item.url);
    } else {
      try {
        const p = new URL(item.url);
        const slash = p.pathname.lastIndexOf("/");
        const parent = slash > 0 ? p.pathname.slice(0, slash) : "/";
        const siblingFolder = `${p.origin}${parent}`;
        const families = familiesByFolder.get(siblingFolder);
        key = families && families.size === 1
          ? [...families][0]
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
      tabId === videoUi.activeTabId && domVideosFor(tabId).length > 0
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
    videoUi.menuUrls = [];
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
        // The id is the index into videoUi.menuUrls, so a click resolves
        // against the list this menu was built from.
        const idx = videoUi.menuUrls.push(row.url) - 1;
        safeMenuCreate({
          id: `${VIDEO_ITEM_PREFIX}${idx}`,
          parentId: VIDEO_PARENT_ID,
          title: menuRowTitle(names[ei], row.quality),
          contexts,
        });
      }
    });
    // Persist for worker restarts: videoUi.menuUrls is in-memory and MV3
    // suspends the worker; a click after a restart must still resolve.
    chrome.storage.session.set({ menuUrls: videoUi.menuUrls }).catch(() => {});
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
  if (tabId === videoUi.activeTabId) {
    refreshVideoMenu(tabId); // rebuild sees no finds: drops the menu
    const badged = chrome.action.setBadgeText({ tabId, text: "" });
    if (badged && typeof badged.catch === "function") {
      badged.catch(() => {});
    }
  }
}

function clearAllVideoUi() {
  const tabIds = [...new Set([...videoFinds.keys(), videoUi.activeTabId])]
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
  refreshVideoMenu(videoUi.activeTabId);
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
  if (!videoUi.detectVideosOn) return;
  if (tabId === videoUi.activeTabId) {
    refreshVideoMenu(tabId);
    return;
  }
  // The cached active tab can go stale (worker restarts, window-focus
  // races): verify against live state instead of silently dropping the
  // report — otherwise the menu never appears until the next tab switch.
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const liveActive = tabs && tabs[0] && tabs[0].id;
    if (liveActive == null) return;
    videoUi.activeTabId = liveActive; // heal the stale cache
    if (tabId === liveActive) refreshVideoMenu(tabId);
  });
}

chrome.webRequest.onResponseStarted.addListener(
  async (details) => {
    if (!videoUi.detectVideosOn) return;
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
  if (!videoUi.detectVideosOn) return;
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

chrome.tabs.onActivated.addListener((info) => {
  videoUi.activeTabId = info.tabId;
  refreshVideoMenu(info.tabId);
});

// Switching windows fires no tabs.onActivated: follow the focused window so
// the menu shows its active tab's videos.
if (chrome.windows && chrome.windows.onFocusChanged) {
  chrome.windows.onFocusChanged.addListener((windowId) => {
    if (windowId == null || windowId < 0) return; // WINDOW_ID_NONE
    chrome.tabs.query({ active: true, windowId }, (tabs) => {
      if (!tabs || !tabs[0] || tabs[0].id == null) return;
      videoUi.activeTabId = tabs[0].id;
      refreshVideoMenu(videoUi.activeTabId);
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
  videoUi.activeTabId = tabs[0].id;
  const sent = chrome.tabs.sendMessage(tabs[0].id, { type: "grab-rescan" });
  if (sent && typeof sent.catch === "function") {
    sent.catch(() => {});
  }
});

