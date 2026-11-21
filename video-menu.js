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

/// The HLS fetch policy needs the top-level origin to distinguish a local
/// player's own manifest from a public page's attempt to probe another host.
async function tabOriginForHlsFetch(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    return tab && typeof tab.url === "string" ? new URL(tab.url).origin : null;
  } catch {
    return null;
  }
}

/// Classify a sniffed response URL: "manifest" for HLS/DASH playlists,
/// "media" for direct video files, null for everything else (segments,
/// audio, images, pages). Manifests win on content type alone because some
/// are served extensionless; extensionless media is NOT guessed because
/// DASH segments look exactly like that.
function isAudioOnlyPlaylistUrl(url) {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    const filename = pathname.split("/").filter(Boolean).pop() || "";
    const basename = filename.replace(/\.(?:m3u8|m3u|mpd)$/i, "");
    return /^(?:audio|audioonly|audio[-_]only|audio[-_]playlist|audioplaylist)(?:[._-].*)?$/.test(basename);
  } catch {
    return false;
  }
}

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
  // Some HLS servers use audio/x-mpegurl for audio-only playlists. Reject
  // explicit audio responses and audio-named playlists before extension
  // detection, including playlists served with application/* MIME types.
  if (
    isAudioOnlyPlaylistUrl(url) ||
    (/^audio\//.test(ct) && ct !== "audio/x-mpegurl" && ct !== "audio/mpegurl")
  ) return null;
  if (/\.(m3u8|m3u|mpd)$/.test(path)) return "manifest";
  if (
    ct === "application/vnd.apple.mpegurl" ||
    ct === "application/x-mpegurl" ||
    ct === "application/mpegurl" ||
    ct === "audio/x-mpegurl" ||
    ct === "audio/mpegurl" ||
    ct === "application/dash+xml"
  ) {
    return "manifest";
  }
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
  // Menu titles give two characters special meaning: "%s" is replaced with the
  // selection and "&" marks the next character as an access key (and is not
  // shown). Page-controlled names contain both ("Tom & Jerry", "100%"), so
  // double each to display them literally.
  return (quality ? `${name} • ${quality}` : name)
    .replace(/&/g, "&&")
    .replace(/%/g, "%%");
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


/// Read HLS playlists only to distinguish multivariant masters from media
/// playlists. A failed or unsafe fetch is "unknown": never hide a candidate.
const hlsPlaylistTextCache = new Map();
const HLS_PLAYLIST_TEXT_LIMIT = 256 * 1024;
const HLS_PLAYLIST_FETCH_TIMEOUT_MS = 5000;
const HLS_PLAYLIST_FETCH_CONCURRENCY = 4;

// Public playlist inspections are read-only classifications. Keep both
// successful and failed results briefly so live-playlist re-requests and
// repeated menu rebuilds do not re-resolve the same full URL on every refresh.
const HLS_PUBLIC_INSPECTION_CACHE_TTL_MS = 10_000;
const HLS_PUBLIC_INSPECTION_CACHE_MAX_ENTRIES = 128;
const hlsPublicInspectionCache = new Map();
const hlsPublicInspectionPending = new Map();

function isHlsPlaylistUrl(value) {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") &&
      /\.(?:m3u8|m3u)$/i.test(url.pathname);
  } catch {
    return false;
  }
}

/// Normalize URL.hostname for IP and local-host checks. URL parses IPv6
/// literals with brackets, unlike ordinary DNS names.
function normalizedHlsHost(host) {
  return String(host || "").toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

/// True for address ranges that are not public destinations. The extension
/// fetch runs with host permissions, so it must not turn page-controlled media
/// URLs into blind requests to a user's LAN.
function isPrivateNetworkHost(host) {
  const value = normalizedHlsHost(host);
  if (
    value === "localhost" ||
    value.endsWith(".localhost") ||
    value.endsWith(".local") ||
    value.endsWith(".internal") ||
    value.endsWith(".home.arpa") ||
    (!value.includes(".") && !value.includes(":"))
  ) return true;

  if (value.includes(":")) {
    return (
      value === "::" ||
      value === "::1" ||
      value.startsWith("::ffff:") ||
      /^fe[89ab]/.test(value) ||
      /^fe[c-f]/.test(value) ||
      /^f[cd]/.test(value) ||
      /^ff/.test(value)
    );
  }

  const ipv4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(value);
  if (!ipv4) return false;
  const octets = ipv4.slice(1).map(Number);
  if (octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b, c, d] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    // IANA reserves 192.0.0.0/24, except the globally reachable .9/.10 anycasts.
    (a === 192 && b === 0 && c === 0 && d !== 9 && d !== 10) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
}

/// Public playlists can be inspected. A private/local target is accepted only
/// when the tab's own origin is also private; a public page cannot use the
/// extension's host permissions to probe arbitrary LAN devices.
function isHlsPlaylistFetchAllowed(value, tabOrigin = null) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password
  ) return false;

  if (!isPrivateNetworkHost(url.hostname)) return true;
  if (typeof tabOrigin !== "string" || !tabOrigin) return false;
  try {
    const origin = new URL(tabOrigin);
    return (
      (origin.protocol === "http:" || origin.protocol === "https:") &&
      isPrivateNetworkHost(origin.hostname)
    );
  } catch {
    return false;
  }
}

/// Fetch a playlist without cookies, redirects, or unbounded response bodies.
/// Null means the content could not be safely inspected; callers keep it.
async function fetchHlsPlaylistText(value, tabOrigin = null) {
  if (!isHlsPlaylistFetchAllowed(value, tabOrigin)) return null;
  if (hlsPlaylistTextCache.has(value)) {
    return hlsPlaylistTextCache.get(value);
  }

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    HLS_PLAYLIST_FETCH_TIMEOUT_MS,
  );
  let reader;
  try {
    const response = await fetch(value, {
      method: "GET",
      credentials: "omit",
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) return null;

    let text;
    if (response.body && typeof response.body.getReader === "function") {
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let bytesRead = 0;
      text = "";
      while (bytesRead < HLS_PLAYLIST_TEXT_LIMIT) {
        const { done, value: chunk } = await reader.read();
        if (done) break;
        const remaining = HLS_PLAYLIST_TEXT_LIMIT - bytesRead;
        const bounded = chunk.subarray(0, remaining);
        bytesRead += bounded.byteLength;
        text += decoder.decode(bounded, { stream: true });
        if (bounded.byteLength < chunk.byteLength || bytesRead >= HLS_PLAYLIST_TEXT_LIMIT) {
          await reader.cancel().catch(() => {});
          break;
        }
      }
      text += decoder.decode();
    } else {
      // Lightweight response mocks and older implementations may not expose
      // a readable stream. The fallback is still truncated before parsing.
      text = (await response.text()).slice(0, HLS_PLAYLIST_TEXT_LIMIT);
    }

    hlsPlaylistTextCache.set(value, text);
    if (hlsPlaylistTextCache.size > 100) {
      hlsPlaylistTextCache.delete(hlsPlaylistTextCache.keys().next().value);
    }
    return text;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    if (reader) reader.releaseLock();
  }
}

function copyHlsInspection(result) {
  return result === null
    ? null
    : { is_master: result.is_master, child_keys: [...result.child_keys] };
}

function normalizeHlsInspection(result) {
  if (
    !result ||
    typeof result.is_master !== "boolean" ||
    !Array.isArray(result.child_keys) ||
    result.child_keys.length > 256 ||
    !result.child_keys.every((key) => typeof key === "string" && key.length <= 2048)
  ) return null;
  return { is_master: result.is_master, child_keys: [...result.child_keys] };
}

/// Cache public inspections by the complete URL, including signed query
/// parameters. Null is cached too: a transient failure must not trigger another
/// loopback inspection on every menu rebuild. Concurrent callers share a read.
async function inspectPublicHlsPlaylistCached(value, inspectPublic) {
  // performance.now() is monotonic, so wall-clock adjustments cannot extend
  // a cached classification beyond its fixed TTL.
  const now = performance.now();
  const cached = hlsPublicInspectionCache.get(value);
  if (cached && cached.expiresAt > now) {
    // Refresh LRU order without extending the fixed TTL.
    hlsPublicInspectionCache.delete(value);
    hlsPublicInspectionCache.set(value, cached);
    return copyHlsInspection(cached.result);
  }
  if (cached) hlsPublicInspectionCache.delete(value);

  const pending = hlsPublicInspectionPending.get(value);
  if (pending) return copyHlsInspection(await pending);

  const request = (async () => {
    let result = null;
    if (typeof inspectPublic === "function") {
      try {
        result = normalizeHlsInspection(await inspectPublic(value));
      } catch {
        result = null;
      }
    }
    hlsPublicInspectionCache.set(value, {
      expiresAt: performance.now() + HLS_PUBLIC_INSPECTION_CACHE_TTL_MS,
      result,
    });
    while (hlsPublicInspectionCache.size > HLS_PUBLIC_INSPECTION_CACHE_MAX_ENTRIES) {
      hlsPublicInspectionCache.delete(hlsPublicInspectionCache.keys().next().value);
    }
    return result;
  })();
  hlsPublicInspectionPending.set(value, request);
  try {
    return copyHlsInspection(await request);
  } finally {
    if (hlsPublicInspectionPending.get(value) === request) {
      hlsPublicInspectionPending.delete(value);
    }
  }
}

/// Inspect a private playlist locally only when the page itself is private.
/// Public-looking hosts go through Grab's paired resolver so the extension
/// never re-resolves an observed public hostname in its own network context.
async function inspectHlsPlaylist(value, tabOrigin = null, inspectPublic = inspectHlsPlaylistWithGrab) {
  if (!isHlsPlaylistUrl(value)) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (isPrivateNetworkHost(url.hostname)) {
    const text = await fetchHlsPlaylistText(value, tabOrigin);
    if (text === null) return null;
    return {
      is_master: text.slice(0, 4096).includes("#EXT-X-STREAM-INF:"),
      child_keys: [...hlsChildPlaylistKeys(text, value)],
    };
  }
  return inspectPublicHlsPlaylistCached(value, inspectPublic);
}

/// True only for a playlist confirmed as a multivariant master.
/// Null represents an unreadable or unverified playlist and must not filter it.
async function isMasterPlaylist(value, tabOrigin = null, inspectPublic = inspectHlsPlaylistWithGrab) {
  const result = await inspectHlsPlaylist(value, tabOrigin, inspectPublic);
  return result === null ? null : result.is_master;
}

/// Resolve playlist references against the master URL. Only explicit
/// variant and EXT-X-MEDIA playlist references are considered children;
/// directory ancestry alone is not evidence that two URLs are one stream.
function hlsChildPlaylistKeys(text, masterUrl) {
  const children = new Set();
  const add = (reference) => {
    try {
      const resolved = new URL(reference.trim(), masterUrl);
      if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return;
      children.add(urlPathKey(resolved.href));
    } catch {
      // Invalid references are ignored; the candidate remains visible.
    }
  };

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith("#EXT-X-STREAM-INF:")) {
      // The URI is the next non-empty, non-comment line.
      for (let j = i + 1; j < lines.length; j++) {
        const candidate = lines[j].trim();
        if (!candidate) continue;
        if (candidate.startsWith("#")) break;
        add(candidate);
        break;
      }
    }
    if (line.startsWith("#EXT-X-MEDIA:")) {
      const uri = /\bURI\s*=\s*"([^"]+)"/i.exec(line);
      if (uri) add(uri[1]);
    }
  }
  return children;
}

/// Prefer confirmed HLS masters over only the child playlists they explicitly
/// reference. Public hosts are inspected by Grab through its guarded resolver;
/// syntactically private hosts retain the existing private-page-only local path.
/// Unknown playlists, unrelated streams, DASH manifests, and direct files stay.
function hlsPlaylistNameHints(urls) {
  const mastersByFolder = new Map();
  const childrenByFolder = new Map();
  for (const url of urls || []) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      continue;
    }
    const basename = parsed.pathname.split("/").filter(Boolean).pop() || "";
    const parent = parsed.pathname.slice(0, Math.max(1, parsed.pathname.lastIndexOf("/")));
    const folder = parsed.origin + parent;
    const key = urlPathKey(url);
    if (/^(?:master|index|playlist|hlsplaylist|stream)(?:[_-][a-z0-9]+)?\.(?:m3u8|m3u)$/i.test(basename)) {
      let masters = mastersByFolder.get(folder);
      if (!masters) mastersByFolder.set(folder, masters = new Set());
      masters.add(key);
    } else if (/^(?:chunklist|prog_index)(?:[_-].*)?\.(?:m3u8|m3u)$/i.test(basename)) {
      let children = childrenByFolder.get(folder);
      if (!children) childrenByFolder.set(folder, children = new Set());
      children.add(key);
    }
  }

  const hintedChildren = new Set();
  for (const [folder, masters] of mastersByFolder) {
    // More than one plausible master in a directory makes the hint ambiguous.
    if (masters.size !== 1) continue;
    const [master] = masters;
    for (const child of childrenByFolder.get(folder) || []) {
      if (child !== master) hintedChildren.add(child);
    }
  }
  return hintedChildren;
}

async function preferMasterPlaylists(
  urls,
  tabOrigin = null,
  sniffedUrls = [],
  inspectPublic = inspectHlsPlaylistWithGrab,
) {
  const manifests = [...new Set((sniffedUrls || []).filter(isHlsPlaylistUrl))];
  if (manifests.length === 0) return urls || [];

  let batchInspector = inspectPublic;
  if (inspectPublic === inspectHlsPlaylistWithGrab) {
    const hasPublicPlaylist = manifests.some((value) => {
      try {
        return !isPrivateNetworkHost(new URL(value).hostname);
      } catch {
        return false;
      }
    });
    if (hasPublicPlaylist) {
      batchInspector = await createHlsInspectionInspectorForBatch();
      if (!batchInspector) batchInspector = async () => null;
    }
  }

  const results = new Map();
  let next = 0;
  const workers = Array.from(
    { length: Math.min(HLS_PLAYLIST_FETCH_CONCURRENCY, manifests.length) },
    async () => {
      while (next < manifests.length) {
        const index = next++;
        const url = manifests[index];
        results.set(url, await inspectHlsPlaylist(url, tabOrigin, batchInspector));
      }
    },
  );
  await Promise.all(workers);

  const masterKeys = new Set();
  const childKeys = hlsPlaylistNameHints(manifests);
  for (const url of manifests) {
    const inspection = results.get(url);
    if (!inspection || inspection.is_master !== true) continue;
    masterKeys.add(urlPathKey(url));
    for (const key of inspection.child_keys) childKeys.add(key);
  }

  if (childKeys.size === 0) return urls || [];
  return (urls || []).filter((url) => {
    if (!isHlsPlaylistUrl(url)) return true;
    const key = urlPathKey(url);
    return masterKeys.has(key) || !childKeys.has(key);
  });
}

const AUTH_QUERY_PARAMETER_NAMES = new Set([
  "token", "access_token", "auth", "authorization", "sig", "signature",
  "expires", "expiry", "exp", "jwt", "hmac", "hdnea", "hdnts",
  "x-amz-signature", "x-amz-credential", "x-amz-date", "x-amz-expires",
  "x-amz-security-token", "x-goog-signature", "x-goog-credential",
  "x-goog-date", "x-goog-expires",
]);

/// Preserve meaningful query parameters for direct media identities while
/// ignoring the common query fields that rotate only for authentication.
function directVideoUrlIdentityKey(url) {
  try {
    const parsed = new URL(url);
    const identityParams = [...parsed.searchParams.entries()]
      .filter(([name]) => !AUTH_QUERY_PARAMETER_NAMES.has(name.toLowerCase()))
      .sort(([aName, aValue], [bName, bValue]) =>
        aName.localeCompare(bName) || aValue.localeCompare(bValue)
      );
    const path = parsed.origin + parsed.pathname;
    return identityParams.length > 0
      ? `${path}?${new URLSearchParams(identityParams).toString()}`
      : path;
  } catch {
    return String(url);
  }
}

/// Merge DOM-reported video sources with sniffed requests. Ignore rotating auth
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

  // Meaningful query parameters distinguish direct media resources such as
  // get_video.php?id=1 and get_video.php?id=2. Auth-only variants still rotate.
  const directSourceKeysByPath = new Map();
  for (const item of candidates) {
    if (!item.fromDom) continue;
    const path = urlPathKey(item.url);
    let keys = directSourceKeysByPath.get(path);
    if (!keys) {
      keys = new Set();
      directSourceKeysByPath.set(path, keys);
    }
    keys.add(directVideoUrlIdentityKey(item.url));
  }
  const groupingCandidates = candidates.filter((item) => {
    if (item.fromDom) return true;
    const directKeys = directSourceKeysByPath.get(urlPathKey(item.url));
    return !(directKeys instanceof Set && directKeys.size > 1) ||
      directKeys.has(directVideoUrlIdentityKey(item.url));
  });

  // Discover manifest families per directory. One HLS and one DASH manifest
  // in the same directory are protocol alternates of one stream; any other
  // combination stays separate.
  const byFolder = new Map();
  for (const item of groupingCandidates) {
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
  groupingCandidates.forEach((item, order) => {
    const kind = manifestKind(item.url) || item.kind;
    const path = urlPathKey(item.url);
    const directKeys = directSourceKeysByPath.get(path);
    const hasMultipleDirectSources = directKeys instanceof Set && directKeys.size > 1;
    let key;
    if (isManifestKind(kind)) {
      const folder = manifestFolderKey(item.url, kind);
      key = hasMultipleDirectSources
        ? directVideoUrlIdentityKey(item.url)
        : (folder && familyFor.get(`${folder}\\u0000${path}`)) || path;
    } else if (hasMultipleDirectSources) {
      key = directVideoUrlIdentityKey(item.url);
    } else {
      try {
        const p = new URL(item.url);
        const slash = p.pathname.lastIndexOf("/");
        const parent = slash > 0 ? p.pathname.slice(0, slash) : "/";
        const siblingFolder = `${p.origin}${parent}`;
        const families = familiesByFolder.get(siblingFolder);
        key = families && families.size === 1
          ? [...families][0]
          : path;
      } catch {
        key = path;
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

// Per-tab detections. DOM reports and network observations are retained per
// frame: a manifest fetched by an iframe must not be paired with another frame.
const MAX_VIDEO_FRAMES = 32;
const MAX_VIDEO_TITLE_LENGTH = 512;
const MAX_MANIFESTS_PER_FRAME = 20;
const MAX_MEDIA_SNIFFS_PER_FRAME = 8;
const MIN_WHOLE_VIDEO_MEDIA_BYTES = 1024 * 1024;
const RETIRED_FRAME_TTL_MS = 5 * 60 * 1000;
// A manifest must precede an element's resource start and be close enough to
// that event to be a plausible request for the same playback session.
const VIDEO_MANIFEST_ATTRIBUTION_WINDOW_MS = 30_000;
const VIDEO_MANIFEST_ATTRIBUTION_TIE_MS = 250;
const videoFinds = new Map();

function createVideoFinds() {
  return {
    frames: new Map(),
    sniffedByFrame: new Map(),
    mediaByFrame: new Map(),
    wholeMediaByFrame: new Map(),
    mediaSizesByFrame: new Map(),
    kindsByFrame: new Map(),
    sniffSequencesByFrame: new Map(),
    sniffTimesByFrame: new Map(),
    retiredFrames: new Map(),
    sniffSequence: 0,
    title: "",
  };
}

/// Frame IDs tracked for a tab, across the DOM, network, kind, and pause maps.
/// One budget covers all sources: a frame never occupies two slots.
function trackedFrameIds(f) {
  const ids = new Set();
  for (const id of f.frames.keys()) ids.add(id);
  for (const id of f.sniffedByFrame.keys()) ids.add(id);
  for (const id of f.mediaByFrame.keys()) ids.add(id);
  for (const id of f.wholeMediaByFrame.keys()) ids.add(id);
  for (const id of f.mediaSizesByFrame.keys()) ids.add(id);
  for (const id of f.kindsByFrame.keys()) ids.add(id);
  for (const id of f.sniffSequencesByFrame.keys()) ids.add(id);
  for (const id of f.sniffTimesByFrame.keys()) ids.add(id);
  for (const id of f.retiredFrames.keys()) ids.add(id);
  return ids;
}

/// Drop every trace of a frame. Chrome's frame ids grow with the frame, so
/// the smallest id is the oldest one.
function dropFrame(f, frameId) {
  f.frames.delete(frameId);
  f.sniffedByFrame.delete(frameId);
  f.mediaByFrame.delete(frameId);
  f.wholeMediaByFrame.delete(frameId);
  f.mediaSizesByFrame.delete(frameId);
  f.kindsByFrame.delete(frameId);
  f.sniffSequencesByFrame.delete(frameId);
  f.sniffTimesByFrame.delete(frameId);
  f.retiredFrames.delete(frameId);
}

/// Evict the oldest tracked frame to free a slot. The top frame is kept
/// (its title tracks SPA navigation), and so is `keepId`.
function evictOldestFrame(f, keepId) {
  let victim = null;
  for (const id of trackedFrameIds(f)) {
    if (id === 0 || id === keepId) continue;
    if (victim === null || id < victim) victim = id;
  }
  if (victim === null) return false;
  dropFrame(f, victim);
  return true;
}

/// Evict the oldest frames that hold videos until `needed` item slots are
/// free, so a new detection is never dropped for lack of room.
function freeVideoSlots(f, keepId, needed) {
  let freed = 0;
  while (freed < needed) {
    let victim = null;
    for (const [id, videos] of f.frames) {
      if (id === 0 || id === keepId) continue;
      if (!videos || videos.length === 0) continue;
      if (victim === null || id < victim) victim = id;
    }
    if (victim === null) return freed;
    freed += f.frames.get(victim).length;
    dropFrame(f, victim);
  }
  return freed;
}

/// Videos retained for the tab, excluding one frame.
function countFrameVideos(f, excludeId) {
  let total = 0;
  for (const [id, videos] of f.frames) {
    if (id === excludeId) continue;
    total += Array.isArray(videos) ? videos.length : 0;
  }
  return total;
}

/// Keep the tracked-frame set inside the budget: the top frame plus the
/// newest frames.
function pruneTrackedFrames(f) {
  const ids = trackedFrameIds(f);
  if (ids.size <= MAX_VIDEO_FRAMES) return;
  const keep = new Set([0]);
  for (const id of [...ids].filter((id) => id !== 0).sort((a, b) => b - a).slice(0, MAX_VIDEO_FRAMES - 1)) {
    keep.add(id);
  }
  for (const id of ids) {
    if (!keep.has(id)) dropFrame(f, id);
  }
}

/// The v2 key drops old tab-wide sniffed URLs: after an upgrade there is no
/// reliable way to determine which frame created them.
const videoStateKey = (tabId) => "videoFinds:v2:" + tabId;
function videoStateTabId(key) {
  const match = /^videoFinds:(?:v2:)?([0-9]+)$/.exec(key);
  return match ? Number(match[1]) : null;
}
const restoredVideoFinds = new Set();
const restoringVideoFinds = new Map();
const videoStateWrites = new Map();

function enqueueVideoStateWrite(tabId, write) {
  const previous = videoStateWrites.get(tabId) || Promise.resolve();
  const next = previous.catch(() => {}).then(write);
  videoStateWrites.set(tabId, next);
  next.finally(() => {
    if (videoStateWrites.get(tabId) === next) videoStateWrites.delete(tabId);
  }).catch(() => {});
  return next;
}

function validBlobUrl(value) {
  return typeof value === "string" && value.startsWith("blob:") && fitsGrabUrl(value)
    ? value : null;
}

function validLifecycleSource(value) {
  if (typeof value !== "string" || value.length > 4096) return null;
  return fitsGrabUrl(value) || validBlobUrl(value) ? value : null;
}

function sniffSequenceMapForFrame(finds, frameId, create = false) {
  if (!(finds.sniffSequencesByFrame instanceof Map)) {
    if (!create) return null;
    finds.sniffSequencesByFrame = new Map();
  }
  let sequences = finds.sniffSequencesByFrame.get(frameId);
  if (!sequences && create) {
    sequences = new Map();
    finds.sniffSequencesByFrame.set(frameId, sequences);
  }
  return sequences || null;
}

function sniffTimeMapForFrame(finds, frameId, create = false) {
  if (!(finds.sniffTimesByFrame instanceof Map)) {
    if (!create) return null;
    finds.sniffTimesByFrame = new Map();
  }
  let times = finds.sniffTimesByFrame.get(frameId);
  if (!times && create) {
    times = new Map();
    finds.sniffTimesByFrame.set(frameId, times);
  }
  return times || null;
}

function validLifecycleTime(value, fallback = Date.now()) {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function retiredSequenceAt(finds, frameId, lifecycleAt) {
  const cutoffTime = validLifecycleTime(lifecycleAt);
  const sequences = sniffSequenceMapForFrame(finds, frameId);
  const times = sniffTimeMapForFrame(finds, frameId);
  if (!sequences || !times) return 0;
  let retiredAtSeq = 0;
  for (const [key, sequence] of sequences) {
    const observedAt = times.get(key);
    if (
      Number.isSafeInteger(sequence) &&
      sequence >= 0 &&
      Number.isFinite(observedAt) &&
      observedAt <= cutoffTime
    ) {
      retiredAtSeq = Math.max(retiredAtSeq, sequence);
    }
  }
  return retiredAtSeq;
}

function nextSniffSequence(finds) {
  const current = Number.isSafeInteger(finds.sniffSequence) && finds.sniffSequence >= 0
    ? finds.sniffSequence
    : 0;
  finds.sniffSequence = current >= Number.MAX_SAFE_INTEGER - 1 ? 1 : current + 1;
  return finds.sniffSequence;
}

function removeFrameSniffsAtOrBefore(finds, frameId, sequence) {
  const cutoff = Number.isSafeInteger(sequence) && sequence >= 0 ? sequence : 0;
  const sequences = sniffSequenceMapForFrame(finds, frameId);
  const times = sniffTimeMapForFrame(finds, frameId);
  const lists = [
    finds.sniffedByFrame,
    finds.mediaByFrame,
  ];
  let changed = false;
  const removedKeys = new Set();
  const keptKeys = new Set();

  for (const listMap of lists) {
    const urls = listMap instanceof Map ? listMap.get(frameId) : null;
    if (!Array.isArray(urls)) continue;
    const kept = [];
    for (const url of urls) {
      const key = urlPathKey(url);
      const observedSequence = sequences && sequences.get(key);
      if (Number.isSafeInteger(observedSequence) && observedSequence > cutoff) {
        kept.push(url);
        keptKeys.add(key);
      } else {
        removedKeys.add(key);
        changed = true;
      }
    }
    if (kept.length) listMap.set(frameId, kept);
    else listMap.delete(frameId);
  }

  for (const key of keptKeys) removedKeys.delete(key);
  if (sequences) {
    for (const key of removedKeys) {
      sequences.delete(key);
      if (times) times.delete(key);
    }
    if (sequences.size === 0) finds.sniffSequencesByFrame.delete(frameId);
  }
  if (times && times.size === 0) finds.sniffTimesByFrame.delete(frameId);
  const kinds = finds.kindsByFrame.get(frameId);
  if (kinds) {
    for (const key of removedKeys) {
      const stillPresent =
        (finds.sniffedByFrame.get(frameId) || []).some((url) => urlPathKey(url) === key) ||
        (finds.mediaByFrame.get(frameId) || []).some((url) => urlPathKey(url) === key);
      if (!stillPresent) kinds.delete(key);
    }
    if (kinds.size === 0) finds.kindsByFrame.delete(frameId);
  }
  return changed;
}

function hasManifestSniffedAfter(finds, frameId, sequence) {
  const urls = finds.sniffedByFrame.get(frameId) || [];
  const sequences = sniffSequenceMapForFrame(finds, frameId);
  if (!sequences) return false;
  return urls.some((url) => (sequences.get(urlPathKey(url)) || 0) > sequence);
}

function pruneExpiredRetiredFrames(finds, now = Date.now()) {
  if (!(finds.retiredFrames instanceof Map)) return false;
  let changed = false;
  for (const [frameId, retired] of finds.retiredFrames) {
    if (
      !retired ||
      !Number.isFinite(retired.retiredAt) ||
      retired.retiredAt > now + 60_000 ||
      now - retired.retiredAt < RETIRED_FRAME_TTL_MS
    ) continue;
    // Once the grace period expires, the stream can no longer be safely
    // attributed. Drop the entire retired frame rather than resurfacing any
    // post-retirement observations as no-DOM fallback candidates.
    dropFrame(finds, frameId);
    changed = true;
  }
  return changed;
}

function recordRetiredFrame(
  finds,
  frameId,
  source,
  previousVideoCount,
  lifecycleAt = Date.now(),
) {
  if (!(finds.retiredFrames instanceof Map)) finds.retiredFrames = new Map();
  const validSource = validLifecycleSource(source);
  const existing = finds.retiredFrames.get(frameId);
  // Repeated pause/end reports must not move the sequence boundary forward:
  // manifests observed after the first retirement belong to the next stream.
  if (existing) {
    existing.source = existing.source || validSource;
    existing.videoCount = Math.max(
      Number.isInteger(existing.videoCount) ? existing.videoCount : 0,
      Number.isInteger(previousVideoCount) ? previousVideoCount : 0,
    );
    return false;
  }
  const eventTime = validLifecycleTime(lifecycleAt);
  finds.retiredFrames.set(frameId, {
    source: validSource,
    retiredAtSeq: retiredSequenceAt(finds, frameId, eventTime),
    retiredAt: Date.now(),
    videoCount: Number.isInteger(previousVideoCount) ? previousVideoCount : 0,
  });
  return true;
}

function resumeRetiredFrame(finds, frameId, videos) {
  const retired = finds.retiredFrames instanceof Map
    ? finds.retiredFrames.get(frameId)
    : null;
  if (!retired) return false;

  const sameBlobResumed =
    videos.length === 1 &&
    videos[0] &&
    videos[0].blob === true &&
    validBlobUrl(videos[0].blobUrl) !== null &&
    validBlobUrl(videos[0].blobUrl) === retired.source;
  const multiplePlayers =
    videos.length > 1 ||
    (Number.isInteger(retired.videoCount) && retired.videoCount > 1);
  const hasNewManifest = hasManifestSniffedAfter(
    finds,
    frameId,
    retired.retiredAtSeq,
  );

  // A same-blob resume keeps its observations. Otherwise, a newly observed
  // manifest proves that a new stream started: discard only pre-retirement
  // URLs. Multiple players remain conservative because frame-wide sniffing
  // cannot prove which element owns a retained manifest.
  if (!sameBlobResumed && (hasNewManifest || multiplePlayers)) {
    removeFrameSniffsAtOrBefore(finds, frameId, retired.retiredAtSeq);
  }
  finds.retiredFrames.delete(frameId);
  return true;
}


/// A blob URL is retained only as a short-lived element identity for matching
/// context-menu clicks. It is never included in a handoff to Grab.
function normalizeVideoReport(rawVideos, maximum) {
  const input = Array.isArray(rawVideos) ? rawVideos.slice(0, MAX_VIDEO_ITEMS) : [];
  const out = [];
  const seen = new Set();
  for (const video of input) {
    if (out.length >= maximum) break;
    if (!video || typeof video !== "object") continue;
    const src = typeof video.src === "string" && video.src && fitsGrabUrl(video.src) ? video.src : null;
    const blobUrl = validBlobUrl(video.blobUrl);
    if (!src && video.blob !== true) continue;
    const key = src || blobUrl;
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    const item = { src, blob: video.blob === true };
    if (blobUrl) item.blobUrl = blobUrl;
    if (Number.isFinite(video.height) && video.height > 0) item.height = video.height;
    if (Number.isSafeInteger(video.elementId) && video.elementId > 0 && video.elementId <= 1_000_000_000) {
      item.elementId = video.elementId;
    }
    if (
      Number.isFinite(video.loadStartedAt) &&
      video.loadStartedAt >= 0 &&
      video.loadStartedAt <= Date.now() + 60_000
    ) item.loadStartedAt = video.loadStartedAt;
    out.push(item);
  }
  return out;
}

function snapshotVideoFinds(finds) {
  const frames = [];
  let remainingVideos = MAX_VIDEO_ITEMS;
  for (const [frameId, videos] of finds.frames) {
    if (remainingVideos <= 0 || frames.length >= MAX_VIDEO_FRAMES) break;
    const out = [];
    const seen = new Set();
    for (const video of videos || []) {
      if (remainingVideos <= 0) break;
      if (!video || typeof video !== "object") continue;
      const src = typeof video.src === "string" && video.src && fitsGrabUrl(video.src) ? video.src : null;
      const blobUrl = validBlobUrl(video.blobUrl);
      if (!src && video.blob !== true) continue;
      const identity = src || blobUrl;
      if (identity && seen.has(identity)) continue;
      if (identity) seen.add(identity);
      const saved = { src, blob: video.blob === true };
      if (blobUrl) saved.blobUrl = blobUrl;
      if (Number.isFinite(video.height) && video.height > 0) saved.height = video.height;
      if (Number.isSafeInteger(video.elementId) && video.elementId > 0 && video.elementId <= 1_000_000_000) {
        saved.elementId = video.elementId;
      }
      if (
        Number.isFinite(video.loadStartedAt) &&
        video.loadStartedAt >= 0 &&
        video.loadStartedAt <= Date.now() + 60_000
      ) saved.loadStartedAt = video.loadStartedAt;
      out.push(saved);
      remainingVideos -= 1;
    }
    if (out.length) frames.push([frameId, out]);
  }

  const sniffedFrames = [];
  let remainingSniffed = MAX_VIDEO_ITEMS;
  for (const [frameId, urls] of finds.sniffedByFrame || []) {
    if (remainingSniffed <= 0 || sniffedFrames.length >= MAX_VIDEO_FRAMES) break;
    const out = [];
    const seen = new Set();
    for (const url of urls || []) {
      if (remainingSniffed <= 0) break;
      if (typeof url !== "string" || !fitsGrabUrl(url)) continue;
      const key = urlPathKey(url);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(url);
      remainingSniffed -= 1;
    }
    if (out.length) sniffedFrames.push([frameId, out]);
  }

  const kindsFrames = [];
  let remainingKinds = 200;
  for (const [frameId, kinds] of finds.kindsByFrame || []) {
    if (remainingKinds <= 0 || kindsFrames.length >= MAX_VIDEO_FRAMES) break;
    const out = [];
    for (const [key, kind] of kinds || []) {
      if (remainingKinds <= 0 || typeof key !== "string" ||
          (kind !== "manifest" && kind !== "media")) continue;
      out.push([key, kind]);
      remainingKinds -= 1;
    }
    if (out.length) kindsFrames.push([frameId, out]);
  }

  const mediaFrames = [];
  for (const [frameId, urls] of finds.mediaByFrame || []) {
    if (mediaFrames.length >= MAX_VIDEO_FRAMES) break;
    const out = [];
    for (const url of urls || []) {
      if (out.length >= MAX_MEDIA_SNIFFS_PER_FRAME) break;
      if (typeof url === "string" && fitsGrabUrl(url)) out.push(url);
    }
    if (out.length) mediaFrames.push([frameId, out]);
  }

  const wholeMediaFrames = [];
  for (const [frameId, urls] of finds.wholeMediaByFrame || []) {
    if (wholeMediaFrames.length >= MAX_VIDEO_FRAMES) break;
    const available = finds.mediaByFrame instanceof Map
      ? finds.mediaByFrame.get(frameId) || []
      : [];
    const out = [];
    for (const url of urls || []) {
      if (out.length >= MAX_MEDIA_SNIFFS_PER_FRAME) break;
      if (
        typeof url === "string" &&
        fitsGrabUrl(url) &&
        available.includes(url) &&
        classifyStream(url, "") === "media" &&
        !isSegmentLikeVideoUrl(url)
      ) {
        out.push(url);
      }
    }
    if (out.length) wholeMediaFrames.push([frameId, out]);
  }

  const mediaSizesFrames = [];
  for (const [frameId, sizes] of finds.mediaSizesByFrame || []) {
    if (mediaSizesFrames.length >= MAX_VIDEO_FRAMES) break;
    const wholeUrls = finds.wholeMediaByFrame instanceof Map
      ? finds.wholeMediaByFrame.get(frameId) || []
      : [];
    const out = [];
    for (const [key, size] of sizes || []) {
      if (
        out.length >= MAX_MEDIA_SNIFFS_PER_FRAME ||
        typeof key !== "string" ||
        key.length > MAX_GRAB_URL_BYTES ||
        !Number.isSafeInteger(size) ||
        size < MIN_WHOLE_VIDEO_MEDIA_BYTES ||
        !wholeUrls.some((url) => urlPathKey(url) === key)
      ) continue;
      out.push([key, size]);
    }
    if (out.length) mediaSizesFrames.push([frameId, out]);
  }

  const sniffSequences = [];
  for (const [frameId, sequences] of finds.sniffSequencesByFrame || []) {
    if (sniffSequences.length >= MAX_VIDEO_FRAMES) break;
    const out = [];
    for (const [key, sequence] of sequences || []) {
      if (
        out.length >= MAX_MANIFESTS_PER_FRAME + MAX_MEDIA_SNIFFS_PER_FRAME ||
        typeof key !== "string" ||
        key.length > MAX_GRAB_URL_BYTES ||
        !Number.isSafeInteger(sequence) ||
        sequence < 0
      ) continue;
      out.push([key, sequence]);
    }
    if (out.length) sniffSequences.push([frameId, out]);
  }

  const sniffTimes = [];
  for (const [frameId, times] of finds.sniffTimesByFrame || []) {
    if (sniffTimes.length >= MAX_VIDEO_FRAMES) break;
    const out = [];
    for (const [key, observedAt] of times || []) {
      if (
        out.length >= MAX_MANIFESTS_PER_FRAME + MAX_MEDIA_SNIFFS_PER_FRAME ||
        typeof key !== "string" ||
        key.length > MAX_GRAB_URL_BYTES ||
        !Number.isFinite(observedAt) ||
        observedAt < 0
      ) continue;
      out.push([key, observedAt]);
    }
    if (out.length) sniffTimes.push([frameId, out]);
  }

  const retiredFrames = [];
  for (const [frameId, retired] of finds.retiredFrames || []) {
    if (retiredFrames.length >= MAX_VIDEO_FRAMES) break;
    if (
      !Number.isInteger(frameId) ||
      frameId < 0 ||
      !retired ||
      !Number.isSafeInteger(retired.retiredAtSeq) ||
      retired.retiredAtSeq < 0 ||
      !Number.isFinite(retired.retiredAt)
    ) continue;
    retiredFrames.push([frameId, {
      source: validLifecycleSource(retired.source),
      retiredAtSeq: retired.retiredAtSeq,
      retiredAt: retired.retiredAt,
      videoCount: Number.isInteger(retired.videoCount) && retired.videoCount >= 0
        ? Math.min(retired.videoCount, MAX_VIDEO_ITEMS)
        : 0,
    }]);
  }

  return {
    version: 2,
    frames,
    sniffedFrames,
    mediaFrames,
    wholeMediaFrames,
    mediaSizesFrames,
    kindsFrames,
    sniffSequences,
    sniffTimes,
    sniffSequence: Number.isSafeInteger(finds.sniffSequence) && finds.sniffSequence >= 0
      ? finds.sniffSequence
      : 0,
    retiredFrames,
    title: typeof finds.title === "string" ? finds.title.slice(0, MAX_VIDEO_TITLE_LENGTH) : "",
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
      if (restoredVideoFinds.has(tabId)) return;
      const saved = result && result[key];
      if (saved && typeof saved === "object" && saved.version === 2) {
        const frames = new Map();
        let remaining = MAX_VIDEO_ITEMS;
        const savedFrames = [];
        const seenFrameIds = new Set();
        for (const pair of Array.isArray(saved.frames) ? saved.frames : []) {
          if (!Array.isArray(pair) || pair.length !== 2 ||
              !Number.isInteger(pair[0]) || pair[0] < 0 ||
              !Array.isArray(pair[1]) || seenFrameIds.has(pair[0])) continue;
          if (pair[0] === 0) {
            if (savedFrames.length >= MAX_VIDEO_FRAMES) {
              const lastNonTop = savedFrames.findIndex(([id]) => id !== 0);
              if (lastNonTop >= 0) {
                const [removed] = savedFrames.splice(lastNonTop, 1);
                seenFrameIds.delete(removed[0]);
              }
            }
            if (savedFrames.length < MAX_VIDEO_FRAMES) {
              savedFrames.unshift(pair);
              seenFrameIds.add(0);
            }
          } else if (savedFrames.length < MAX_VIDEO_FRAMES) {
            savedFrames.push(pair);
            seenFrameIds.add(pair[0]);
          }
          if (savedFrames.length >= MAX_VIDEO_FRAMES && seenFrameIds.has(0)) break;
        }
        for (const [frameId, savedVideos] of savedFrames) {
          if (remaining <= 0) break;
          if (!frames.has(frameId) && frames.size >= MAX_VIDEO_FRAMES) continue;
          const videos = [];
          const seen = new Set();
          for (const video of savedVideos.slice(0, MAX_VIDEO_ITEMS)) {
            if (remaining <= 0 || !video || typeof video !== "object") continue;
            const src = typeof video.src === "string" && video.src && fitsGrabUrl(video.src) ? video.src : null;
            const blobUrl = validBlobUrl(video.blobUrl);
            if (!src && video.blob !== true) continue;
            const identity = src || blobUrl;
            if (identity && seen.has(identity)) continue;
            if (identity) seen.add(identity);
            const item = { src, blob: video.blob === true };
            if (blobUrl) item.blobUrl = blobUrl;
            if (Number.isFinite(video.height) && video.height > 0) item.height = video.height;
            if (Number.isSafeInteger(video.elementId) && video.elementId > 0 && video.elementId <= 1_000_000_000) {
              item.elementId = video.elementId;
            }
            if (
              Number.isFinite(video.loadStartedAt) &&
              video.loadStartedAt >= 0 &&
              video.loadStartedAt <= Date.now() + 60_000
            ) item.loadStartedAt = video.loadStartedAt;
            videos.push(item);
            remaining -= 1;
          }
          if (videos.length) frames.set(frameId, videos);
        }

        const sniffedByFrame = new Map();
        let remainingSniffed = MAX_VIDEO_ITEMS;
        for (const pair of Array.isArray(saved.sniffedFrames) ? saved.sniffedFrames : []) {
          if (!Array.isArray(pair) || pair.length !== 2 ||
              !Number.isInteger(pair[0]) || pair[0] < 0 ||
              !Array.isArray(pair[1]) || sniffedByFrame.has(pair[0]) ||
              sniffedByFrame.size >= MAX_VIDEO_FRAMES || remainingSniffed <= 0) continue;
          const urls = [];
          const seen = new Set();
          for (const url of pair[1].slice(0, MAX_VIDEO_ITEMS)) {
            if (remainingSniffed <= 0) break;
            if (typeof url !== "string" || !fitsGrabUrl(url)) continue;
            const identity = urlPathKey(url);
            if (seen.has(identity)) continue;
            seen.add(identity);
            urls.push(url);
            remainingSniffed -= 1;
          }
          if (urls.length) sniffedByFrame.set(pair[0], urls);
        }

        const kindsByFrame = new Map();
        let remainingKinds = 200;
        for (const pair of Array.isArray(saved.kindsFrames) ? saved.kindsFrames : []) {
          if (!Array.isArray(pair) || pair.length !== 2 ||
              !Number.isInteger(pair[0]) || pair[0] < 0 ||
              !Array.isArray(pair[1]) || kindsByFrame.has(pair[0]) ||
              kindsByFrame.size >= MAX_VIDEO_FRAMES || remainingKinds <= 0) continue;
          const kinds = new Map();
          for (const entry of pair[1].slice(0, 200)) {
            if (remainingKinds <= 0 || !Array.isArray(entry) || entry.length !== 2 ||
                typeof entry[0] !== "string" ||
                (entry[1] !== "manifest" && entry[1] !== "media")) continue;
            kinds.set(entry[0], entry[1]);
            remainingKinds -= 1;
          }
          if (kinds.size) kindsByFrame.set(pair[0], kinds);
        }

        const mediaByFrame = new Map();
        let remainingMedia = MAX_VIDEO_FRAMES * MAX_MEDIA_SNIFFS_PER_FRAME;
        for (const pair of Array.isArray(saved.mediaFrames) ? saved.mediaFrames : []) {
          if (
            !Array.isArray(pair) ||
            pair.length !== 2 ||
            !Number.isInteger(pair[0]) ||
            pair[0] < 0 ||
            !Array.isArray(pair[1]) ||
            mediaByFrame.has(pair[0]) ||
            mediaByFrame.size >= MAX_VIDEO_FRAMES ||
            remainingMedia <= 0
          ) continue;
          const urls = [];
          const seen = new Set();
          for (const url of pair[1].slice(0, MAX_MEDIA_SNIFFS_PER_FRAME)) {
            if (remainingMedia <= 0 || typeof url !== "string" || !fitsGrabUrl(url)) continue;
            const identity = urlPathKey(url);
            if (seen.has(identity)) continue;
            seen.add(identity);
            urls.push(url);
            remainingMedia -= 1;
          }
          if (urls.length) mediaByFrame.set(pair[0], urls);
        }

        const wholeMediaByFrame = new Map();
        let remainingWholeMedia = MAX_VIDEO_FRAMES * MAX_MEDIA_SNIFFS_PER_FRAME;
        for (const pair of Array.isArray(saved.wholeMediaFrames) ? saved.wholeMediaFrames : []) {
          if (
            !Array.isArray(pair) ||
            pair.length !== 2 ||
            !Number.isInteger(pair[0]) ||
            pair[0] < 0 ||
            !Array.isArray(pair[1]) ||
            wholeMediaByFrame.has(pair[0]) ||
            wholeMediaByFrame.size >= MAX_VIDEO_FRAMES ||
            remainingWholeMedia <= 0
          ) continue;
          const available = mediaByFrame.get(pair[0]) || [];
          const urls = [];
          const seen = new Set();
          for (const url of pair[1].slice(0, MAX_MEDIA_SNIFFS_PER_FRAME)) {
            if (
              remainingWholeMedia <= 0 ||
              typeof url !== "string" ||
              !fitsGrabUrl(url) ||
              !available.includes(url) ||
              classifyStream(url, "") !== "media" ||
              isSegmentLikeVideoUrl(url)
            ) continue;
            const key = urlPathKey(url);
            if (seen.has(key)) continue;
            seen.add(key);
            urls.push(url);
            remainingWholeMedia -= 1;
          }
          if (urls.length) wholeMediaByFrame.set(pair[0], urls);
        }

        const mediaSizesByFrame = new Map();
        for (const pair of Array.isArray(saved.mediaSizesFrames) ? saved.mediaSizesFrames : []) {
          if (
            !Array.isArray(pair) ||
            pair.length !== 2 ||
            !Number.isInteger(pair[0]) ||
            pair[0] < 0 ||
            !Array.isArray(pair[1]) ||
            mediaSizesByFrame.has(pair[0]) ||
            mediaSizesByFrame.size >= MAX_VIDEO_FRAMES
          ) continue;
          const wholeUrls = wholeMediaByFrame.get(pair[0]) || [];
          const sizes = new Map();
          for (const entry of pair[1].slice(0, MAX_MEDIA_SNIFFS_PER_FRAME)) {
            if (
              !Array.isArray(entry) ||
              entry.length !== 2 ||
              typeof entry[0] !== "string" ||
              entry[0].length > MAX_GRAB_URL_BYTES ||
              !Number.isSafeInteger(entry[1]) ||
              entry[1] < MIN_WHOLE_VIDEO_MEDIA_BYTES ||
              !wholeUrls.some((url) => urlPathKey(url) === entry[0])
            ) continue;
            sizes.set(entry[0], entry[1]);
          }
          if (sizes.size) mediaSizesByFrame.set(pair[0], sizes);
        }

        let sniffSequence =
          Number.isSafeInteger(saved.sniffSequence) && saved.sniffSequence >= 0
            ? saved.sniffSequence
            : 0;
        const sniffSequencesByFrame = new Map();
        for (const pair of Array.isArray(saved.sniffSequences) ? saved.sniffSequences : []) {
          if (
            !Array.isArray(pair) ||
            pair.length !== 2 ||
            !Number.isInteger(pair[0]) ||
            pair[0] < 0 ||
            !Array.isArray(pair[1]) ||
            sniffSequencesByFrame.size >= MAX_VIDEO_FRAMES
          ) continue;
          const sequences = new Map();
          for (const entry of pair[1].slice(0, MAX_MANIFESTS_PER_FRAME + MAX_MEDIA_SNIFFS_PER_FRAME)) {
            if (
              !Array.isArray(entry) ||
              entry.length !== 2 ||
              typeof entry[0] !== "string" ||
              entry[0].length > MAX_GRAB_URL_BYTES ||
              !Number.isSafeInteger(entry[1]) ||
              entry[1] < 0
            ) continue;
            sequences.set(entry[0], entry[1]);
            sniffSequence = Math.max(sniffSequence, entry[1]);
          }
          if (sequences.size) sniffSequencesByFrame.set(pair[0], sequences);
        }
        // Older v2 snapshots only stored URL arrays. Give those observations
        // stable sequence numbers so subsequent sniffs always compare newer.
        for (const [frameId, urls] of sniffedByFrame) {
          let sequences = sniffSequencesByFrame.get(frameId);
          if (!sequences) {
            sequences = new Map();
            sniffSequencesByFrame.set(frameId, sequences);
          }
          for (const url of urls) {
            const key = urlPathKey(url);
            if (!sequences.has(key)) sequences.set(key, ++sniffSequence);
          }
        }
        for (const [frameId, urls] of mediaByFrame) {
          let sequences = sniffSequencesByFrame.get(frameId);
          if (!sequences) {
            sequences = new Map();
            sniffSequencesByFrame.set(frameId, sequences);
          }
          for (const url of urls) {
            const key = urlPathKey(url);
            if (!sequences.has(key)) sequences.set(key, ++sniffSequence);
          }
        }

        const sniffTimesByFrame = new Map();
        for (const pair of Array.isArray(saved.sniffTimes) ? saved.sniffTimes : []) {
          if (
            !Array.isArray(pair) ||
            pair.length !== 2 ||
            !Number.isInteger(pair[0]) ||
            pair[0] < 0 ||
            !Array.isArray(pair[1]) ||
            sniffTimesByFrame.size >= MAX_VIDEO_FRAMES
          ) continue;
          const times = new Map();
          for (const entry of pair[1].slice(0, MAX_MANIFESTS_PER_FRAME + MAX_MEDIA_SNIFFS_PER_FRAME)) {
            if (
              !Array.isArray(entry) ||
              entry.length !== 2 ||
              typeof entry[0] !== "string" ||
              entry[0].length > MAX_GRAB_URL_BYTES ||
              !Number.isFinite(entry[1]) ||
              entry[1] < 0
            ) continue;
            times.set(entry[0], entry[1]);
          }
          if (times.size) sniffTimesByFrame.set(pair[0], times);
        }
        // Older v2 snapshots have no observation times. Treat those sniffed
        // entries as older than future lifecycle events.
        for (const [frameId, sequences] of sniffSequencesByFrame) {
          let times = sniffTimesByFrame.get(frameId);
          if (!times) {
            times = new Map();
            sniffTimesByFrame.set(frameId, times);
          }
          for (const key of sequences.keys()) {
            if (!times.has(key)) times.set(key, 0);
          }
        }

        const retiredFrames = new Map();
        for (const pair of Array.isArray(saved.retiredFrames) ? saved.retiredFrames : []) {
          if (
            !Array.isArray(pair) ||
            pair.length !== 2 ||
            !Number.isInteger(pair[0]) ||
            pair[0] < 0 ||
            !pair[1] ||
            !Number.isSafeInteger(pair[1].retiredAtSeq) ||
            pair[1].retiredAtSeq < 0 ||
            !Number.isFinite(pair[1].retiredAt) ||
            retiredFrames.size >= MAX_VIDEO_FRAMES
          ) continue;
          retiredFrames.set(pair[0], {
            source: validLifecycleSource(pair[1].source),
            retiredAtSeq: Math.min(pair[1].retiredAtSeq, sniffSequence),
            retiredAt: pair[1].retiredAt,
            videoCount: Number.isInteger(pair[1].videoCount) && pair[1].videoCount >= 0
              ? Math.min(pair[1].videoCount, MAX_VIDEO_ITEMS)
              : 0,
          });
        }
        // PR #86 snapshots stored pausedFrames as [frameId, blobUrl]. Convert
        // them to a retirement marker at the newest restored observation.
        for (const pair of Array.isArray(saved.pausedFrames) ? saved.pausedFrames : []) {
          if (
            !Array.isArray(pair) ||
            pair.length !== 2 ||
            !Number.isInteger(pair[0]) ||
            pair[0] < 0 ||
            validBlobUrl(pair[1]) === null ||
            retiredFrames.size >= MAX_VIDEO_FRAMES ||
            retiredFrames.has(pair[0])
          ) continue;
          retiredFrames.set(pair[0], {
            source: pair[1],
            retiredAtSeq: sniffSequence,
            retiredAt: Date.now(),
            videoCount: 1,
          });
        }

        const restored = {
          frames,
          sniffedByFrame,
          mediaByFrame,
          wholeMediaByFrame,
          mediaSizesByFrame,
          kindsByFrame,
          sniffSequencesByFrame,
          sniffTimesByFrame,
          retiredFrames,
          sniffSequence,
          title: typeof saved.title === "string" ? saved.title.slice(0, MAX_VIDEO_TITLE_LENGTH) : "",
        };
        videoFinds.set(tabId, restored);
        // One budget covers every tracked frame, whatever map it lives in.
        pruneTrackedFrames(restored);
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
  return enqueueVideoStateWrite(tabId, async () => {
    await chrome.storage.session.remove(videoStateKey(tabId));
    await chrome.storage.session.remove("videoFinds:" + tabId);
  }).catch(() => {});
}

function domVideosFor(tabId) {
  const f = videoFinds.get(tabId);
  if (!f) return [];
  const out = [];
  for (const videos of f.frames.values()) out.push(...videos);
  return out;
}

function sniffedUrlsForFrame(finds, frameId) {
  if (finds.sniffedByFrame instanceof Map) return finds.sniffedByFrame.get(frameId) || [];
  return frameId === 0 && Array.isArray(finds.sniffed) ? finds.sniffed : [];
}

function mediaUrlsForFrame(finds, frameId) {
  return finds.mediaByFrame instanceof Map ? finds.mediaByFrame.get(frameId) || [] : [];
}

function kindsForFrame(finds, frameId) {
  if (finds.kindsByFrame instanceof Map) return finds.kindsByFrame.get(frameId) || new Map();
  return frameId === 0 && finds.kinds instanceof Map ? finds.kinds : new Map();
}

/// Merge only observations from the same frame. With multiple active players,
/// network requests cannot be attributed to one element, so only direct media
/// URLs reported by the elements themselves are exposed.
function mergedVideoUrlsForFrame(tabId, frameId) {
  const finds = videoFinds.get(tabId);
  if (!finds) return [];
  const videos = finds.frames.get(frameId) || [];
  if (videos.length === 0) return [];
  if (videos.length > 1) {
    return [...new Set(videos
      .filter((video) => video && typeof video.src === "string" && video.src && fitsGrabUrl(video.src))
      .map((video) => video.src))];
  }
  const video = videos[0];
  const sniffed = sniffedUrlsForFrame(finds, frameId);
  const kinds = kindsForFrame(finds, frameId);
  if (video && typeof video.src === "string" && video.src) {
    return mergeVideoFinds([video], sniffed, kinds);
  }
  if (video && video.blob === true) return mergeVideoFinds([], sniffed, kinds);
  return [];
}

function findVideoForSource(tabId, srcUrl, frameId) {
  if (typeof srcUrl !== "string" || !srcUrl) return null;
  const finds = videoFinds.get(tabId);
  if (!finds) return null;
  const frameEntries = Number.isInteger(frameId) && frameId >= 0
    ? [[frameId, finds.frames.get(frameId) || []]]
    : [...finds.frames.entries()];
  const matches = [];
  const scopedVideos = [];
  for (const [id, videos] of frameEntries) {
    for (const video of videos || []) {
      if (!video) continue;
      scopedVideos.push({ frameId: id, video });
      if (video.src === srcUrl || video.blobUrl === srcUrl) {
        matches.push({ frameId: id, video });
      }
    }
  }
  if (matches.length === 1) return matches[0];
  if (matches.length !== 0) return null;

  // Older content reports and some browser menu events omit the blob URL
  // identity. A unique video in the source frame remains an unambiguous
  // fallback; multiple players always require an exact element match.
  if ((srcUrl.startsWith("blob:") || srcUrl.startsWith("data:")) &&
      scopedVideos.length === 1 &&
      !scopedVideos[0].video.blobUrl) {
    return scopedVideos[0];
  }
  return null;
}

function sniffTimesForFrame(finds, frameId) {
  return finds.sniffTimesByFrame instanceof Map
    ? finds.sniffTimesByFrame.get(frameId) || new Map()
    : new Map();
}

function sniffedManifestsForFrame(finds, frameId) {
  const kinds = kindsForFrame(finds, frameId);
  return sniffedUrlsForFrame(finds, frameId).filter((url) => {
    const kind = manifestKind(url) || kinds.get(urlPathKey(url));
    return isManifestKind(kind);
  });
}

function videoManifestPriority(url, kinds) {
  const kind = manifestKind(url) || (kinds && kinds.get(urlPathKey(url)));
  return kind === "hls" ? 30 : kind === "manifest" ? 25 : kind === "dash" ? 20 : 0;
}

/// Attribute each manifest to the nearest element resource start that follows
/// the request. When several active videos cannot be distinguished in time,
/// the manifest is deliberately dropped instead of being guessed.
function attributedManifestUrlsForVideo(videos, targetVideo, manifests, sniffTimes) {
  if (!Array.isArray(videos) || !videos.includes(targetVideo)) return [];
  const multipleVideos = videos.length > 1;

  if (multipleVideos) {
    const elementIds = new Set();
    for (const video of videos) {
      if (
        !video ||
        !Number.isSafeInteger(video.elementId) ||
        video.elementId <= 0 ||
        !Number.isFinite(video.loadStartedAt) ||
        video.loadStartedAt < 0 ||
        elementIds.has(video.elementId)
      ) return [];
      elementIds.add(video.elementId);
    }
  }

  const attributed = [];
  for (const url of manifests) {
    const observedAt = sniffTimes.get(urlPathKey(url));
    // Old v2 reports have no element timing. Preserve their single-player
    // fallback even when the corresponding sniff timestamp was persisted.
    if (!multipleVideos && !Number.isFinite(targetVideo.loadStartedAt)) {
      attributed.push(url);
      continue;
    }
    // A single active player owns its frame's manifests, but timestamped
    // requests must still belong to that player's current resource load.
    if (!Number.isFinite(observedAt) || observedAt < 0) continue;

    const possibleOwners = videos
      .map((video) => ({
        video,
        gap: video.loadStartedAt - observedAt,
      }))
      .filter(({ gap }) =>
        Number.isFinite(gap) &&
        gap >= 0 &&
        gap <= VIDEO_MANIFEST_ATTRIBUTION_WINDOW_MS
      )
      .sort((a, b) => a.gap - b.gap);
    if (possibleOwners.length === 0) continue;
    if (
      possibleOwners.length > 1 &&
      possibleOwners[1].gap - possibleOwners[0].gap <= VIDEO_MANIFEST_ATTRIBUTION_TIE_MS
    ) continue;
    if (possibleOwners[0].video === targetVideo) attributed.push(url);
  }
  return attributed;
}

async function bestManifestForVideo(tabId, finds, frameId, candidates, targetVideo = null) {
  if (!candidates || candidates.length === 0) return null;
  const kinds = kindsForFrame(finds, frameId);
  const sniffTimes = sniffTimesForFrame(finds, frameId);
  const loadStartedAt = targetVideo && targetVideo.loadStartedAt;
  let resolved = [...candidates];
  if (resolved.length > 1) {
    resolved = await preferMasterPlaylists(
      resolved,
      await tabOriginForHlsFetch(tabId),
      resolved,
    );
  }
  const merged = mergeVideoFinds([], resolved, kinds);
  const gapToLoadStart = (url) => {
    const observedAt = sniffTimes.get(urlPathKey(url));
    return Number.isFinite(loadStartedAt) && Number.isFinite(observedAt)
      ? loadStartedAt - observedAt
      : Number.POSITIVE_INFINITY;
  };
  merged.sort((a, b) => {
    const rankDifference = videoManifestPriority(b, kinds) - videoManifestPriority(a, kinds);
    if (rankDifference !== 0) return rankDifference;
    return gapToLoadStart(a) - gapToLoadStart(b);
  });
  if (
    Number.isFinite(loadStartedAt) &&
    merged.length > 1 &&
    videoManifestPriority(merged[0], kinds) === videoManifestPriority(merged[1], kinds) &&
    gapToLoadStart(merged[0]) === gapToLoadStart(merged[1])
  ) return null;
  return merged[0] || null;
}

/// Resolve a blob element to its single best attributed stream URL. Passing the
/// element keeps right-click behavior aligned with the global menu even when
/// several players share a frame.
async function resolvedBlobVideoUrlForFrame(tabId, frameId, targetVideo = null) {
  const finds = videoFinds.get(tabId);
  if (!finds) return null;
  if (pruneExpiredRetiredFrames(finds)) await persistVideoFinds(tabId);
  if (finds.retiredFrames instanceof Map && finds.retiredFrames.has(frameId)) return null;
  const videos = finds.frames.get(frameId) || [];
  const video = targetVideo || (videos.length === 1 ? videos[0] : null);
  if (!video || video.blob !== true || !videos.includes(video)) return null;
  const manifests = sniffedManifestsForFrame(finds, frameId);
  const sniffTimes = sniffTimesForFrame(finds, frameId);
  const attributed = attributedManifestUrlsForVideo(
    videos,
    video,
    manifests,
    sniffTimes,
  );
  const best = await bestManifestForVideo(tabId, finds, frameId, attributed, video);
  if (best) return best;

  const wholeMedia = wholeMediaUrlsForFrame(finds, frameId);
  const attributedMedia = attributedManifestUrlsForVideo(
    videos,
    video,
    wholeMedia,
    sniffTimes,
  );
  const uniqueMedia = dedupeVideoUrlsByPath(attributedMedia, finds);
  return uniqueMedia.length === 1 ? uniqueMedia[0] : null;
}

function videoUrlCandidateObservedAt(finds, url) {
  const key = urlPathKey(url);
  let newest = Number.NEGATIVE_INFINITY;

  for (const [frameId, videos] of finds.frames) {
    for (const video of videos || []) {
      if (
        video &&
        video.src === url &&
        Number.isFinite(video.loadStartedAt)
      ) newest = Math.max(newest, video.loadStartedAt);
    }
    const sniffed = finds.sniffedByFrame instanceof Map
      ? finds.sniffedByFrame.get(frameId) || []
      : [];
    const media = finds.mediaByFrame instanceof Map
      ? finds.mediaByFrame.get(frameId) || []
      : [];
    const observedUrls = [...sniffed, ...media];
    if (observedUrls.includes(url)) {
      const times = finds.sniffTimesByFrame instanceof Map
        ? finds.sniffTimesByFrame.get(frameId)
        : null;
      const observedAt = times instanceof Map ? times.get(key) : null;
      if (Number.isFinite(observedAt)) newest = Math.max(newest, observedAt);
    }
  }

  // A network-only frame can hold a manifest without a DOM report.
  for (const [frameId, observedUrls] of finds.sniffedByFrame || []) {
    if (finds.frames.has(frameId) || !observedUrls.includes(url)) continue;
    const times = finds.sniffTimesByFrame instanceof Map
      ? finds.sniffTimesByFrame.get(frameId)
      : null;
    const observedAt = times instanceof Map ? times.get(key) : null;
    if (Number.isFinite(observedAt)) newest = Math.max(newest, observedAt);
  }
  return newest;
}

function videoUrlCandidatePriority(finds, url) {
  const kind = manifestKind(url) || detectedKindForUrl(finds, url);
  return kind === "hls" ? 30
    : kind === "manifest" ? 25
    : kind === "dash" ? 20
    : 10;
}

/// Deduplicate streams across frames and rotating query tokens. Keep the
/// highest-ranked URL; ties prefer the most recently observed resource URL.
function dedupeVideoUrlsByPath(urls, finds) {
  const selected = new Map();
  for (const url of urls || []) {
    if (typeof url !== "string" || !fitsGrabUrl(url)) continue;
    const directSource = finds && finds.frames instanceof Map &&
      [...finds.frames.values()].some((videos) =>
        (videos || []).some((video) => video && video.src === url)
      );
    const key = directSource ? directVideoUrlIdentityKey(url) : urlPathKey(url);
    const priority = videoUrlCandidatePriority(finds, url);
    const observedAt = videoUrlCandidateObservedAt(finds, url);
    const previous = selected.get(key);
    if (
      !previous ||
      priority > previous.priority ||
      (priority === previous.priority && observedAt > previous.observedAt)
    ) {
      selected.set(key, { url, priority, observedAt });
    }
  }
  return [...selected.values()].map((candidate) => candidate.url);
}

async function resolvedVideoUrlsForFrame(tabId, frameId) {
  const finds = videoFinds.get(tabId);
  if (!finds) return [];
  if (pruneExpiredRetiredFrames(finds)) await persistVideoFinds(tabId);
  if (finds.retiredFrames instanceof Map && finds.retiredFrames.has(frameId)) return [];
  return dedupeVideoUrlsByPath(
    await menuVideoCandidatesForFrame(finds, frameId, tabId),
    finds,
  );
}

/// Build one candidate per active DOM video. Direct sources are authoritative;
/// sniffed MP4 requests are never added as sibling entries. Blob players receive
/// only manifests attributed to their element. With no DOM video, preserve the
/// existing conservative manifest-only fallback for embedded/custom players.
async function menuVideoCandidatesForFrame(finds, frameId, tabId = null) {
  if (finds.retiredFrames instanceof Map && finds.retiredFrames.has(frameId)) return [];
  const videos = finds.frames.get(frameId) || [];
  const manifests = sniffedManifestsForFrame(finds, frameId);
  const kinds = kindsForFrame(finds, frameId);
  if (videos.length === 0) {
    let fallback = mergeVideoFinds([], manifests, kinds);
    if (fallback.length > 1) {
      fallback = await preferMasterPlaylists(
        fallback,
        await tabOriginForHlsFetch(tabId),
        manifests,
      );
    }
    return fallback;
  }

  const urls = [];
  const sniffTimes = sniffTimesForFrame(finds, frameId);
  for (const video of videos) {
    if (video && typeof video.src === "string" && fitsGrabUrl(video.src)) {
      urls.push(video.src);
      continue;
    }
    if (!video || video.blob !== true) continue;
    const attributed = attributedManifestUrlsForVideo(
      videos,
      video,
      manifests,
      sniffTimes,
    );
    const best = await bestManifestForVideo(tabId, finds, frameId, attributed, video);
    if (best) {
      urls.push(best);
      continue;
    }

    const wholeMedia = wholeMediaUrlsForFrame(finds, frameId);
    const attributedMedia = attributedManifestUrlsForVideo(
      videos,
      video,
      wholeMedia,
      sniffTimes,
    );
    const uniqueMedia = dedupeVideoUrlsByPath(attributedMedia, finds);
    if (uniqueMedia.length === 1) urls.push(uniqueMedia[0]);
  }
  return urls;
}

async function resolvedVideoUrls(tabId) {
  const finds = videoFinds.get(tabId);
  if (!finds) return [];
  if (pruneExpiredRetiredFrames(finds)) await persistVideoFinds(tabId);
  const frameIds = new Set(finds.frames.keys());
  if (finds.sniffedByFrame instanceof Map) {
    for (const frameId of finds.sniffedByFrame.keys()) frameIds.add(frameId);
  }
  if (finds.mediaByFrame instanceof Map) {
    for (const frameId of finds.mediaByFrame.keys()) frameIds.add(frameId);
  } else if (Array.isArray(finds.sniffed) && finds.sniffed.length > 0) {
    frameIds.add(0);
  }

  const urls = [];
  for (const frameId of frameIds) {
    const candidates = await menuVideoCandidatesForFrame(finds, frameId, tabId);
    urls.push(...candidates);
  }
  return dedupeVideoUrlsByPath(urls, finds).slice(0, MAX_VIDEO_ITEMS);
}

function mergedVideoUrls(tabId) {
  const finds = videoFinds.get(tabId);
  if (!finds) return [];
  const urls = [];
  for (const frameId of finds.frames.keys()) urls.push(...mergedVideoUrlsForFrame(tabId, frameId));
  return dedupeVideoUrlsByPath(urls, finds).slice(0, MAX_VIDEO_ITEMS);
}

function detectedKindForUrl(finds, url) {
  const key = urlPathKey(url);
  if (finds && finds.kindsByFrame instanceof Map) {
    for (const kinds of finds.kindsByFrame.values()) {
      const kind = kinds.get(key);
      if (kind) return kind;
    }
  }
  return finds && finds.kinds instanceof Map ? finds.kinds.get(key) || null : null;
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

function isSegmentLikeVideoUrl(url) {
  try {
    const path = new URL(url).pathname.toLowerCase();
    const basename = path.split("/").filter(Boolean).pop() || "";
    if (/(?:^|\/)(?:segments?|chunks?|fragments?|previews?|pre[-_]rolls?|prerolls?|mid[-_]rolls?|midrolls?|post[-_]rolls?|postrolls?|thumbnails?|storyboards?|sprites?|subtitles?|captions?|audioonly|audio[-_]only|prefetch(?:es)?)(?:\/|$)/.test(path)) {
      return true;
    }
    if (/^(?:preview|trailer|teaser|ad|advert|advertisement|promo|thumbnail|thumb|storyboard|sprite|preroll|midroll|postroll|prefetch)(?:[._-]|$)/.test(basename)) {
      return true;
    }
    return /^(?:seg(?:ment)?|frag(?:ment)?)[._-]?\d+(?:[._-]|$)/.test(basename) ||
      /^chunk[._-]\d{3,}(?:[._-]|$)/.test(basename);
  } catch {
    return true;
  }
}

/// Return Content-Length only for a whole-object response suitable for a
/// conservative blob-player fallback. Partial responses are never candidates.
function wholeVideoMediaSize(details) {
  if (
    !details ||
    details.statusCode !== 200 ||
    classifyStream(
      details.url,
      sniffedHeader(details.responseHeaders, "content-type"),
    ) !== "media" ||
    sniffedHeader(details.responseHeaders, "content-range") ||
    isSegmentLikeVideoUrl(details.url)
  ) return null;
  const rawLength = sniffedHeader(details.responseHeaders, "content-length");
  if (!/^\d+$/.test(rawLength)) return null;
  const length = Number(rawLength);
  return Number.isSafeInteger(length) && length >= MIN_WHOLE_VIDEO_MEDIA_BYTES
    ? length
    : null;
}

function wholeMediaUrlsForFrame(finds, frameId) {
  const urls = finds.wholeMediaByFrame instanceof Map
    ? finds.wholeMediaByFrame.get(frameId) || []
    : [];
  const media = mediaUrlsForFrame(finds, frameId);
  const sizes = finds.mediaSizesByFrame instanceof Map
    ? finds.mediaSizesByFrame.get(frameId)
    : null;
  return urls.filter((url) =>
    media.includes(url) &&
    classifyStream(url, "") === "media" &&
    !isSegmentLikeVideoUrl(url) &&
    sizes instanceof Map &&
    Number.isSafeInteger(sizes.get(urlPathKey(url))) &&
    sizes.get(urlPathKey(url)) >= MIN_WHOLE_VIDEO_MEDIA_BYTES
  );
}

function noteSniffed(tabId, frameId, url, kind, observedAt = Date.now(), wholeMediaSize = null) {
  if (!fitsGrabUrl(url) || (kind !== "manifest" && kind !== "media")) return;
  let f = videoFinds.get(tabId);
  if (!f) {
    f = createVideoFinds();
    videoFinds.set(tabId, f);
  }
  pruneExpiredRetiredFrames(f);
  const sourceFrame = Number.isInteger(frameId) && frameId >= 0 ? frameId : 0;
  const tracked = trackedFrameIds(f);
  if (!tracked.has(sourceFrame) && tracked.size >= MAX_VIDEO_FRAMES) {
    if (!evictOldestFrame(f, sourceFrame)) return;
  }

  let kinds = f.kindsByFrame.get(sourceFrame);
  if (!kinds) {
    kinds = new Map();
    f.kindsByFrame.set(sourceFrame, kinds);
  }
  const key = urlPathKey(url);
  kinds.set(key, kind);

  const listMap = kind === "manifest" ? f.sniffedByFrame : f.mediaByFrame;
  let urls = listMap.get(sourceFrame);
  if (!urls) {
    urls = [];
    listMap.set(sourceFrame, urls);
  }
  const idx = urls.findIndex((candidate) => urlPathKey(candidate) === key);
  if (idx >= 0) urls[idx] = url;
  else urls.push(url);

  if (kind === "media") {
    let wholeUrls = f.wholeMediaByFrame.get(sourceFrame);
    if (!wholeUrls) {
      wholeUrls = [];
      f.wholeMediaByFrame.set(sourceFrame, wholeUrls);
    }
    let sizes = f.mediaSizesByFrame.get(sourceFrame);
    if (!sizes) {
      sizes = new Map();
      f.mediaSizesByFrame.set(sourceFrame, sizes);
    }
    if (
      Number.isSafeInteger(wholeMediaSize) &&
      wholeMediaSize >= MIN_WHOLE_VIDEO_MEDIA_BYTES &&
      !isSegmentLikeVideoUrl(url)
    ) {
      const wholeIndex = wholeUrls.findIndex((candidate) => urlPathKey(candidate) === key);
      if (wholeIndex >= 0) wholeUrls[wholeIndex] = url;
      else wholeUrls.push(url);
      sizes.set(key, wholeMediaSize);
    } else {
      for (let i = wholeUrls.length - 1; i >= 0; i--) {
        if (urlPathKey(wholeUrls[i]) === key) wholeUrls.splice(i, 1);
      }
      sizes.delete(key);
    }
    while (wholeUrls.length > MAX_MEDIA_SNIFFS_PER_FRAME) {
      const removed = wholeUrls.shift();
      sizes.delete(urlPathKey(removed));
    }
    if (wholeUrls.length === 0) f.wholeMediaByFrame.delete(sourceFrame);
    if (sizes.size === 0) f.mediaSizesByFrame.delete(sourceFrame);
  }

  const sequences = sniffSequenceMapForFrame(f, sourceFrame, true);
  sequences.set(key, nextSniffSequence(f));
  const times = sniffTimeMapForFrame(f, sourceFrame, true);
  times.set(key, validLifecycleTime(observedAt));

  const limit = kind === "manifest"
    ? MAX_MANIFESTS_PER_FRAME
    : MAX_MEDIA_SNIFFS_PER_FRAME;
  while (urls.length > limit) {
    const removed = urls.shift();
    const removedKey = urlPathKey(removed);
    if (kind === "media") {
      const wholeUrls = f.wholeMediaByFrame.get(sourceFrame) || [];
      for (let i = wholeUrls.length - 1; i >= 0; i--) {
        if (urlPathKey(wholeUrls[i]) === removedKey) wholeUrls.splice(i, 1);
      }
      const sizes = f.mediaSizesByFrame.get(sourceFrame);
      if (sizes) {
        sizes.delete(removedKey);
        if (sizes.size === 0) f.mediaSizesByFrame.delete(sourceFrame);
      }
      if (wholeUrls.length === 0) f.wholeMediaByFrame.delete(sourceFrame);
    }
    const otherList = kind === "manifest" ? f.mediaByFrame.get(sourceFrame) : f.sniffedByFrame.get(sourceFrame);
    const stillPresent = Array.isArray(otherList) &&
      otherList.some((candidate) => urlPathKey(candidate) === removedKey);
    if (!stillPresent) {
      sequences.delete(removedKey);
      times.delete(removedKey);
      kinds.delete(removedKey);
    }
  }
  if (urls.length === 0) listMap.delete(sourceFrame);
  if (sequences.size === 0) f.sniffSequencesByFrame.delete(sourceFrame);
  if (times.size === 0) f.sniffTimesByFrame.delete(sourceFrame);
  if (kinds.size === 0) f.kindsByFrame.delete(sourceFrame);
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
    // Re-read after the awaits above: a refresh queued before the user
    // disabled detection must not publish stale menu rows or a non-empty
    // badge after the setting changes.
    if (!videoUi.detectVideosOn) {
      await removeContextMenu(VIDEO_PARENT_ID);
      videoUi.menuUrls = [];
      chrome.storage.session.set({ menuUrls: [] }).catch(() => {});
      if (Number.isInteger(tabId) && tabId >= 0 && !warnedTabs.has(tabId)) {
        const cleared = chrome.action.setBadgeText({ tabId, text: "" });
        if (cleared && typeof cleared.catch === "function") cleared.catch(() => {});
      }
      return;
    }
    // Combine active DOM video sources with network-observed manifests.
    // Playlist candidates do not require a unique or even discoverable
    // <video> element; individual element clicks remain frame-scoped below.
    let urls = tabId === videoUi.activeTabId ? await resolvedVideoUrls(tabId) : [];
    // Backstop: collection already filters excluded hosts, but a tab may
    // have navigated there after its videos were recorded.
    if (urls.length > 0 && (await isExcludedTab(tabId))) urls = [];
    // The setting can change while the manifest checks above are awaiting.
    if (!videoUi.detectVideosOn) urls = [];
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
          kind: detectedKindForUrl(finds, u),
        }),
      );
    }
    const names = uniqueLabels(
      entries.map((e, i) =>
        videoName(e.url, i, finds && finds.title, e.kind),
      ),
    );
    // Replace the menu only once the replacement is ready: candidate
    // resolution can await a playlist check, and removing the old menu first
    // would leave right-click with nothing while it runs.
    await removeContextMenu(VIDEO_PARENT_ID);
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
      text: String(entries.length),
    });
    if (badged && typeof badged.catch === "function") badged.catch(() => {});
  };
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
      const id = videoStateTabId(key);
      if (id !== null && Number.isInteger(id) && id >= 0) {
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

/// Sniff stream manifests and media responses. Registered by registerSniffer().
async function onSniffedResponse(details) {
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
  noteSniffed(
    details.tabId,
    details.frameId,
    details.url,
    kind,
    Number.isFinite(details.timeStamp) ? details.timeStamp : Date.now(),
    kind === "media" ? wholeVideoMediaSize(details) : null,
  );
  await persistVideoFinds(details.tabId);
  onVideoEvent(details.tabId);
  // A sniffed manifest may belong to a shadow-root player whose play
  // events never reach the document. Nudge the tab to re-sweep (wiring
  // shadow roots); debounced, with one retry in case the player mounts
  // just after the sniff.
  requestRescan(details.tabId);
}

/// "webRequest" is an optional permission (granted with video detection), so
/// the chrome.webRequest namespace does not exist until the user opts in. With
/// the permission absent the worker is never woken for page traffic at all.
/// Called at worker startup (the listener must exist synchronously to wake the
/// worker) and again when the permission is granted at runtime.
function registerSniffer() {
  const event = chrome.webRequest && chrome.webRequest.onResponseStarted;
  if (!event) return false;
  if (typeof event.hasListener === "function" && event.hasListener(onSniffedResponse)) {
    return true;
  }
  event.addListener(
    onSniffedResponse,
    {
      urls: ["http://*/*", "https://*/*"],
      // Players fetch streams as media or XHR/fetch requests; skip images,
      // scripts, stylesheets and documents.
      types: ["media", "xmlhttprequest", "other"],
    },
    ["responseHeaders"],
  );
  return true;
}

registerSniffer();

// --- Video detector content script ------------------------------------------
//
// Not declared in the manifest: a static content_scripts entry for every site
// is a permanent, install-time "read all your data" grant. The script is
// registered here only while video detection is on AND the user granted page
// access, and unregistered when either goes away. Runs serialized so two
// triggers cannot both see "not registered" and double-register.

const VIDEO_SCRIPT_ID = "grab-video-detector";
let videoScriptSync = Promise.resolve();

async function hasPageAccess() {
  try {
    return await chrome.permissions.contains({ origins: SHARED_PAGE_ORIGINS });
  } catch {
    return false;
  }
}

async function syncVideoScriptNow() {
  const scripting = chrome.scripting;
  if (!scripting || typeof scripting.registerContentScripts !== "function") return;
  const settings = await getSettings();
  const wanted = settings.detectVideos !== false && (await hasPageAccess());
  let registered = false;
  try {
    const found = await scripting.getRegisteredContentScripts({ ids: [VIDEO_SCRIPT_ID] });
    registered = Array.isArray(found) && found.length > 0;
  } catch {
    // Treat an unreadable registry as "not registered"; a duplicate-id error
    // below is caught as well.
  }
  try {
    if (wanted && !registered) {
      await scripting.registerContentScripts([
        {
          id: VIDEO_SCRIPT_ID,
          matches: SHARED_PAGE_ORIGINS,
          js: ["shared.js", "content.js"],
          allFrames: true,
          runAt: "document_idle",
          persistAcrossSessions: true,
        },
      ]);
    } else if (!wanted && registered) {
      await scripting.unregisterContentScripts({ ids: [VIDEO_SCRIPT_ID] });
    }
  } catch {
    // Registration can fail when the permission was revoked mid-call; the next
    // permissions/settings event runs this again.
  }
}

function syncVideoScript() {
  videoScriptSync = videoScriptSync.then(syncVideoScriptNow, syncVideoScriptNow);
  return videoScriptSync;
}

// Also run from the single onInstalled / onStartup / storage.onChanged
// listeners in handoff.js and background.js.
if (chrome.permissions && chrome.permissions.onAdded) {
  chrome.permissions.onAdded.addListener(() => {
    registerSniffer();
    syncVideoScript();
  });
}
if (chrome.permissions && chrome.permissions.onRemoved) {
  chrome.permissions.onRemoved.addListener(() => { syncVideoScript(); });
}

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
  const reportedFrameId = sender && sender.frameId != null ? sender.frameId : 0;
  const frameId =
    Number.isInteger(reportedFrameId) && reportedFrameId >= 0 ? reportedFrameId : 0;
  let f = videoFinds.get(tabId);
  if (!f) {
    f = createVideoFinds();
    videoFinds.set(tabId, f);
  }
  let changed = pruneExpiredRetiredFrames(f);
  const candidates = normalizeVideoReport(msg.videos, MAX_VIDEO_ITEMS);
  const previousVideos = f.frames.get(frameId) || [];
  const retiredBeforeReport = f.retiredFrames.get(frameId) || null;
  const lifecycle = msg.lifecycle;
  const lifecycleSource = validLifecycleSource(msg.lifecycleSource);
  const previousVideoSources = previousVideos.map((video) => {
    if (!video || typeof video !== "object") return null;
    return video.blob === true
      ? validBlobUrl(video.blobUrl)
      : (typeof video.src === "string" && fitsGrabUrl(video.src) ? video.src : null);
  }).filter(Boolean);
  const lifecycleMatchesKnownSource =
    lifecycleSource === null ||
    previousVideoSources.includes(lifecycleSource) ||
    Boolean(retiredBeforeReport && retiredBeforeReport.source === lifecycleSource);
  const unrelatedLifecycle =
    msg.replaceFrame === true &&
    lifecycleSource !== null &&
    (previousVideos.length > 0 || Boolean(retiredBeforeReport && retiredBeforeReport.source)) &&
    !lifecycleMatchesKnownSource;
  const replaceFrame = msg.replaceFrame === true && !unrelatedLifecycle;
  const previousSoleBlobSource =
    previousVideos.length === 1 && previousVideos[0].blob === true
      ? validBlobUrl(previousVideos[0].blobUrl)
      : null;
  const coalescedSameBlobResume =
    replaceFrame &&
    lifecycle !== "reset" &&
    lifecycleSource !== null &&
    (
      previousSoleBlobSource === lifecycleSource ||
      (retiredBeforeReport && retiredBeforeReport.source === lifecycleSource)
    ) &&
    candidates.length === 1 &&
    candidates[0].blob === true &&
    validBlobUrl(candidates[0].blobUrl) === lifecycleSource;

  if (candidates.length > 0) {
    // Bound frame state before accepting reports. Preserve the top frame when
    // replacing an older entry because its title tracks SPA navigation.
    const tracked = trackedFrameIds(f);
    if (!tracked.has(frameId) && tracked.size >= MAX_VIDEO_FRAMES) {
      if (evictOldestFrame(f, frameId)) changed = true;
    }
    const otherVideoCount = countFrameVideos(f, frameId);
    const overflow = otherVideoCount + candidates.length - MAX_VIDEO_ITEMS;
    if (overflow > 0) {
      const freed = freeVideoSlots(f, frameId, overflow);
      if (freed > 0) changed = true;
    }
    const currentOtherVideoCount = countFrameVideos(f, frameId);
    const allowance = Math.max(0, MAX_VIDEO_ITEMS - currentOtherVideoCount);
    const videos = candidates.slice(0, allowance);

    if (videos.length > 0) {
      if (retiredBeforeReport && (!replaceFrame || coalescedSameBlobResume)) {
        if (resumeRetiredFrame(f, frameId, videos)) changed = true;
      }
      f.frames.set(frameId, videos);
      changed = true;
    }
  } else if (replaceFrame) {
    f.frames.delete(frameId);
    changed = true;
  }

  if (replaceFrame && !coalescedSameBlobResume) {
    const retirementSource =
      lifecycleSource ||
      previousSoleBlobSource ||
      (retiredBeforeReport && retiredBeforeReport.source) ||
      null;
    const retiredChanged = recordRetiredFrame(
      f,
      frameId,
      retirementSource,
      previousVideos.length,
      msg.lifecycleAt,
    );
    if (retiredChanged) changed = true;

    // A pause/end report can be coalesced with another player's active report.
    // Apply the marker to that new snapshot immediately; reset reports stay
    // retired until a later non-lifecycle active report arrives.
    if (
      candidates.length > 0 &&
      lifecycle !== "reset" &&
      lifecycleSource !== null &&
      !candidates.some((video) =>
        video && video.blob === true &&
        validBlobUrl(video.blobUrl) === lifecycleSource
      )
    ) {
      if (resumeRetiredFrame(f, frameId, candidates)) changed = true;
    }
  }

  if (
    candidates.length > 0 &&
    !replaceFrame &&
    retiredBeforeReport &&
    resumeRetiredFrame(f, frameId, candidates)
  ) {
    changed = true;
  }

  // The video's own title for menu labels.
  // The top frame's title follows the page (SPAs change it without a
  // navigation); a subframe only fills a gap.
  if (
    typeof msg.title === "string" &&
    msg.title &&
    (frameId === 0 || !f.title)
  ) {
    f.title = msg.title.slice(0, MAX_VIDEO_TITLE_LENGTH);
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

