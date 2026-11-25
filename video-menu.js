// Grab browser extension: video detection and the right-click menu.
// Loaded by background.js (Chrome importScripts) or listed before it
// in manifest.firefox.json; all files share one global scope.
//
// The per-tab detections and their session persistence live in video-state.js.

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
function isAudioOnlyPlaylistUrl(url, contentType = "") {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    const segments = pathname.split("/").filter(Boolean);
    const filename = segments.pop() || "";
    const basename = filename.replace(/\.(?:m3u8|m3u|mpd)$/i, "");
    const contentTypeIsAudioPlaylist =
      contentType === "audio/x-mpegurl" || contentType === "audio/mpegurl";
    return (
      segments.some((part) => /^(?:audioonly|audio[-_]only|audio[-_]track)$/.test(part)) ||
      (segments.includes("audio") && contentTypeIsAudioPlaylist) ||
      /^(?:audio|audioonly|audio[-_]only|audio[-_]playlist|audioplaylist)(?:[._-].*)?$/.test(basename)
    );
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
    isAudioOnlyPlaylistUrl(url, ct) ||
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

// Keep the complete context-menu name, including a truncation ellipsis,
// within 32 grapheme clusters. File/folder names and page titles share the cap.
const NAME_MAX = 32;
const TITLE_MAX = 32;
const LABEL_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function labelCharacters(text) {
  return Array.from(LABEL_SEGMENTER.segment(text), ({ segment }) => segment);
}

/// Cut `text` to at most `max` grapheme clusters, counting the ellipsis.
/// Titles may back up to the last word boundary in the final 40%; file and
/// folder names use the full available prefix.
function clipLabel(text, max, { wordBoundary = false } = {}) {
  const chars = labelCharacters(text);
  if (chars.length <= max) return text;
  const prefixLimit = Math.max(0, max - 1);
  let head = chars.slice(0, prefixLimit);
  if (wordBoundary) {
    const space = head.lastIndexOf(" ");
    if (space >= Math.floor(prefixLimit * 0.6)) head = head.slice(0, space);
    while (head.length > 0 && head[head.length - 1] === " ") head.pop();
  }
  return head.join("") + "…";
}

const shorten = (text) => clipLabel(text, NAME_MAX);
const shortenTitle = (text) => clipLabel(text, TITLE_MAX, { wordBoundary: true });

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

// File or folder names that say nothing about the video: stream entry points
// ("master.m3u8", "index.mp4") and generic folders ("hls", "videos", "cdn").
const GENERIC_NAME_BASE = /^(?:master|index|playlist|manifest|main|stream|video|videos|media|movie|output|source|default|hls|dash|vod|file|files|content|play|chunklist|prog_index|cdn|static|assets?)(?:[._-]?\d+p?)?$/i;
// Machine-generated names: UUIDs, long hex ids and long digit strings.
const OPAQUE_NAME_BASE = [
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  /^[0-9a-f]{12,}$/i,
  /^\d{5,}$/,
];

function withoutExtension(name) {
  return String(name || "").replace(/\.[a-z0-9]{2,5}$/i, "");
}

/// True when a file or folder name is generic or machine-generated and so
/// would be a poor label.
function isUninformativeName(name) {
  const base = withoutExtension(name);
  return !base || GENERIC_NAME_BASE.test(base) || OPAQUE_NAME_BASE.some((re) => re.test(base));
}

/// Nearest folder above the file whose name is descriptive, decoded
/// ("/hls/Big%20Buck/720p/index.m3u8" -> "Big Buck"); empty when none is.
function descriptiveFolderOf(url) {
  try {
    const segments = new URL(url).pathname.split("/").filter(Boolean);
    segments.pop();
    for (let i = segments.length - 1; i >= 0; i--) {
      let segment;
      try {
        segment = decodeURIComponent(segments[i]);
      } catch {
        segment = segments[i];
      }
      if (!isUninformativeName(segment) && !isHlsRenditionPlaylistPath(segment)) return segment;
    }
  } catch {
    // Not a URL: no folder name.
  }
  return "";
}

/// Prefer a title attached to the player, then a descriptive source name.
/// The shared page title is only a fallback when the source carries no name.
function videoName(url, index, pageTitle, kind, playerTitle = "") {
  const file = fileNameOf(url);
  const title = String(pageTitle || "").replace(/\s+/g, " ").trim();
  const ownTitle = String(playerTitle || "").replace(/\s+/g, " ").trim();
  const informativeFile = file && !isUninformativeName(file);

  if (ownTitle) return shortenTitle(ownTitle);
  if (informativeFile) return shorten(file);
  if (isManifestKind(kind)) {
    const folder = descriptiveFolderOf(url);
    if (folder) return shorten(folder);
  }
  if (title) return shortenTitle(title);
  return file ? shorten(file) : "Video " + (index + 1);
}

/// One row for an HLS master or DASH manifest: hand it to Grab, whose
/// yt-dlp picks the quality.
function manifestMenuRows(url) {
  return [{ quality: "", url }];
}

/// Row for a direct file: the height the player reported, when known.
function directMenuRow(url, height) {
  const boundedHeight = Number.isFinite(height) && height > 0
    ? Math.min(8640, Math.floor(height))
    : 0;
  return { quality: boundedHeight > 0 ? `${boundedHeight}p` : "", url };
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

/// Resolve playlist references against the master URL. Only explicit
/// variant and EXT-X-MEDIA references belong to this content-based helper;
/// the timing-aware nested-directory heuristic is applied during attribution.
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

const HLS_RENDITION_HEIGHTS = new Set([
  144, 240, 360, 426, 480, 540, 576, 720, 1080, 1440, 2160, 4320,
]);
// Same-directory renditions are collapsed only beneath a master-looking name
// (or a parent whose name prefixes the child's), never beneath any earlier
// playlist: a single-rendition content file may legitimately sit next to one.
const HLS_MASTER_NAME = /^(?:master|playlist|index|manifest|main|stream|hls|abr|all)(?:[._-].*)?$/i;
const MAX_NESTED_RENDITION_DEPTH = 3;

/// One path token that identifies a quality level. Bare numbers count only
/// when they are standard video heights, so ids and years (1234, 2024) and
/// ordinary words never look like renditions.
function isHlsRenditionToken(token) {
  const value = String(token || "").toLowerCase();
  if (/^(?:variant|level)\d*$/.test(value)) return true;
  if (/^\d{3,4}p$/.test(value)) return true;
  if (/^\d{2,5}k(?:bps)?$/.test(value)) return true;
  return /^\d{3,4}$/.test(value) && HLS_RENDITION_HEIGHTS.has(Number(value));
}

/// A rendition playlist must carry a recognizable quality/variant marker in
/// the path it is judged by (callers pass only the part below the parent).
function isHlsRenditionPlaylistPath(path) {
  const parts = String(path || "").split("/").filter(Boolean);
  return parts.some((part) => {
    const name = part.replace(/\.m3u8?$/i, "");
    if (/^(?:chunklist|prog_index)(?:[._-].*)?$/i.test(name)) return true;
    return name.split(/[._-]+/).some(isHlsRenditionToken);
  });
}

/// A playlist is a child when it identifies itself as a rendition and an
/// earlier-requested, non-rendition playlist on the same origin sits in the
/// same directory (master-looking or name-prefix related) or up to
/// MAX_NESTED_RENDITION_DEPTH directories above it. Request order, not
/// loadstart, is the evidence, so players that fetch renditions before
/// attaching their media element are handled. Marker evidence is taken only
/// from the path below the parent, so a marker in a shared directory cannot
/// turn an unrelated newer master into a "child".
function nestedHlsPlaylistChildKeys(urls, firstSeenTimes) {
  if (!(firstSeenTimes instanceof Map)) return new Set();
  const playlists = [];
  for (const url of urls || []) {
    if (!isHlsPlaylistUrl(url)) continue;
    try {
      const parsed = new URL(url);
      const slash = parsed.pathname.lastIndexOf("/");
      const directory = slash > 0 ? parsed.pathname.slice(0, slash + 1) : "/";
      playlists.push({
        origin: parsed.origin,
        path: parsed.pathname,
        directory,
        filename: parsed.pathname.slice(slash + 1),
        key: videoUrlIdentityKey(url),
        firstSeenAt: firstSeenTimes.get(videoUrlIdentityKey(url)),
      });
    } catch {
      // Invalid playlist URLs are not candidates.
    }
  }

  const stripExtension = (name) => name.replace(/\.m3u8?$/i, "");
  const childKeys = new Set();
  for (const parent of playlists) {
    if (
      !Number.isFinite(parent.firstSeenAt) ||
      isHlsRenditionPlaylistPath(parent.filename)
    ) continue;
    const parentBase = stripExtension(parent.filename);
    for (const child of playlists) {
      if (
        child.origin !== parent.origin ||
        child.path === parent.path ||
        !child.directory.startsWith(parent.directory) ||
        !Number.isFinite(child.firstSeenAt) ||
        child.firstSeenAt <= parent.firstSeenAt
      ) continue;

      const nestedDirectoryParts = child.directory
        .slice(parent.directory.length)
        .split("/")
        .filter(Boolean);
      if (nestedDirectoryParts.length > MAX_NESTED_RENDITION_DEPTH) continue;
      if (nestedDirectoryParts.length === 0) {
        const childBase = stripExtension(child.filename);
        const prefixRelated =
          childBase.length > parentBase.length &&
          childBase.toLowerCase().startsWith(parentBase.toLowerCase()) &&
          /[._-]/.test(childBase[parentBase.length]);
        if (!HLS_MASTER_NAME.test(parentBase) && !prefixRelated) continue;
      } else if (parent.directory === "/") {
        continue;
      }
      if (isHlsRenditionPlaylistPath([...nestedDirectoryParts, child.filename].join("/"))) {
        childKeys.add(child.key);
      }
    }
  }
  return childKeys;
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
    const kind = (kinds && kinds.get(videoUrlIdentityKey(url))) || null;
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
    bucket[kind].add(videoUrlIdentityKey(item.url));
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
        (folder && familyFor.get(`${folder}\u0000${videoUrlIdentityKey(item.url)}`)) ||
        videoUrlIdentityKey(item.url);
    } else {
      try {
        const p = new URL(item.url);
        const slash = p.pathname.lastIndexOf("/");
        const parent = slash > 0 ? p.pathname.slice(0, slash) : "/";
        const siblingFolder = `${p.origin}${parent}`;
        const families = familiesByFolder.get(siblingFolder);
        key = families && families.size === 1
          ? [...families][0]
          : videoUrlIdentityKey(item.url);
      } catch {
        key = videoUrlIdentityKey(item.url);
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

// A manifest must precede an element's resource start and be close enough to
// that event to be a plausible request for the same playback session.
const VIDEO_MANIFEST_ATTRIBUTION_WINDOW_MS = 30_000;
const VIDEO_MANIFEST_POST_LOAD_WINDOW_MS = 5_000;
const VIDEO_MANIFEST_ATTRIBUTION_TIE_MS = 250;

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

function sniffFirstSeenTimesForFrame(finds, frameId) {
  return finds.sniffFirstSeenByFrame instanceof Map
    ? finds.sniffFirstSeenByFrame.get(frameId) || new Map()
    : sniffTimesForFrame(finds, frameId);
}

function sniffedManifestsForFrame(finds, frameId) {
  const kinds = kindsForFrame(finds, frameId);
  return sniffedUrlsForFrame(finds, frameId).filter((url) => {
    const kind = manifestKind(url) || kinds.get(videoUrlIdentityKey(url));
    return isManifestKind(kind) && !isSegmentLikeVideoUrl(url);
  });
}

function videoManifestPriority(url, kinds) {
  const kind = manifestKind(url) || (kinds && kinds.get(videoUrlIdentityKey(url)));
  return kind === "hls" ? 30 : kind === "manifest" ? 25 : kind === "dash" ? 20 : 0;
}

/// A lone active player owns every manifest observed in its frame. With
/// concurrent players, use each path's first request time to disambiguate.
function attributedManifestUrlsForVideo(
  videos,
  targetVideo,
  manifests,
  sniffTimes,
  firstSeenTimes = sniffTimes,
) {
  if (!Array.isArray(videos) || !videos.includes(targetVideo)) return [];
  if (videos.length === 1) return Array.isArray(manifests) ? manifests : [];

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

  const attributed = [];
  for (const url of manifests || []) {
    const observedAt = firstSeenTimes instanceof Map
      ? firstSeenTimes.get(urlPathKey(url))
      : null;
    if (!Number.isFinite(observedAt) || observedAt < 0) continue;
    const possibleOwners = videos
      .map((video) => {
        const gap = video.loadStartedAt - observedAt;
        return { video, gap, distance: Math.abs(gap) };
      })
      .filter(({ gap }) =>
        Number.isFinite(gap) &&
        gap >= -VIDEO_MANIFEST_POST_LOAD_WINDOW_MS &&
        gap <= VIDEO_MANIFEST_ATTRIBUTION_WINDOW_MS
      )
      .sort((a, b) => a.distance - b.distance);
    if (possibleOwners.length === 0) continue;
    if (
      possibleOwners.length > 1 &&
      possibleOwners[1].distance - possibleOwners[0].distance <= VIDEO_MANIFEST_ATTRIBUTION_TIE_MS
    ) continue;
    if (possibleOwners[0].video === targetVideo) attributed.push(url);
  }
  return attributed;
}

async function bestManifestForVideo(tabId, finds, frameId, candidates, targetVideo = null) {
  if (!candidates || candidates.length === 0) return null;
  const kinds = kindsForFrame(finds, frameId);
  const firstSeenTimes = sniffFirstSeenTimesForFrame(finds, frameId);
  const loadStartedAt = targetVideo && targetVideo.loadStartedAt;
  let resolved = [...candidates];
  const nestedChildKeys = nestedHlsPlaylistChildKeys(
    resolved,
    firstSeenTimes,
  );
  if (nestedChildKeys.size > 0) {
    resolved = resolved.filter((url) => !nestedChildKeys.has(videoUrlIdentityKey(url)));
  }
  if (resolved.length > 1) {
    resolved = await preferMasterPlaylists(
      resolved,
      await tabOriginForHlsFetch(tabId),
      resolved,
    );
  }
  const merged = mergeVideoFinds([], resolved, kinds);
  const timingFor = (url) => {
    const firstSeenAt = firstSeenTimes.get(videoUrlIdentityKey(url));
    if (!Number.isFinite(firstSeenAt)) {
      return { phase: 2, distance: Number.POSITIVE_INFINITY };
    }
    if (!Number.isFinite(loadStartedAt)) {
      return { phase: 1, distance: firstSeenAt };
    }
    return firstSeenAt <= loadStartedAt
      ? { phase: 0, distance: loadStartedAt - firstSeenAt }
      : { phase: 1, distance: firstSeenAt - loadStartedAt };
  };
  merged.sort((a, b) => {
    const rankDifference = videoManifestPriority(b, kinds) - videoManifestPriority(a, kinds);
    if (rankDifference !== 0) return rankDifference;
    const aTiming = timingFor(a);
    const bTiming = timingFor(b);
    if (aTiming.phase !== bTiming.phase) return aTiming.phase - bTiming.phase;
    return aTiming.distance - bTiming.distance;
  });

  const firstTiming = merged.length > 1 ? timingFor(merged[0]) : null;
  const secondTiming = merged.length > 1 ? timingFor(merged[1]) : null;
  if (
    firstTiming &&
    secondTiming &&
    firstTiming.phase === 0 &&
    secondTiming.phase === 0 &&
    videoManifestPriority(merged[0], kinds) === videoManifestPriority(merged[1], kinds) &&
    Math.abs(firstTiming.distance - secondTiming.distance) <= VIDEO_MANIFEST_ATTRIBUTION_TIE_MS
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
  const firstSeenTimes = sniffFirstSeenTimesForFrame(finds, frameId);
  const attributed = attributedManifestUrlsForVideo(
    videos,
    video,
    manifests,
    sniffTimes,
    firstSeenTimes,
  );
  const best = await bestManifestForVideo(tabId, finds, frameId, attributed, video);
  if (best) return best;

  const wholeMedia = wholeMediaUrlsForFrame(finds, frameId);
  const attributedMedia = attributedManifestUrlsForVideo(
    videos,
    video,
    wholeMedia,
    sniffTimes,
      firstSeenTimes,
  );
  const uniqueMedia = dedupeVideoUrlsByPath(attributedMedia, finds);
  return uniqueMedia.length === 1 ? uniqueMedia[0] : null;
}

function videoUrlCandidateObservedAt(finds, url) {
  const key = videoUrlIdentityKey(url);
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

const AUTH_QUERY_PARAMETER_NAME =
  /^(?:access[-_]?token|api[-_]?token|auth|auth[-_]?key|auth[-_]?token|authorization|bearer|exp|expires|expiry|hdnea|hdnts|hmac|jwt|policy|session[-_]?token|sig|signature|token|x-amz-(?:credential|date|expires|security-token|signature)|x-goog-(?:algorithm|credential|date|expires|signature))$/i;

/// Build a stable request identity while ignoring only recognized auth-token
/// query parameters. Preserve every other parameter's spelling, encoding and order.
function videoUrlIdentityKey(url) {
  try {
    const parsed = new URL(url);
    const retainedParameters = parsed.search
      .slice(1)
      .split("&")
      .filter((parameter) => {
        if (!parameter) return true;
        const separator = parameter.indexOf("=");
        const rawName = separator < 0 ? parameter : parameter.slice(0, separator);
        let name;
        try {
          name = decodeURIComponent(rawName.replace(/\+/g, " "));
        } catch {
          return true;
        }
        return !AUTH_QUERY_PARAMETER_NAME.test(name);
      })
      .join("&");
    return parsed.origin + parsed.pathname +
      (retainedParameters ? `?${retainedParameters}` : "");
  } catch {
    return url;
  }
}

/// Deduplicate streams across frames while retaining non-auth query parameters.
/// Keep the highest-ranked URL; ties prefer the most recently observed resource.
function dedupeVideoUrlsByPath(urls, finds) {
  const selected = new Map();
  for (const url of urls || []) {
    if (typeof url !== "string" || !fitsGrabUrl(url)) continue;
    const key = videoUrlIdentityKey(url, finds);
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
    // No active <video>: collapse renditions into their earlier-requested
    // master the same way the per-video path does, so one stream is one entry.
    const nestedChildKeys = nestedHlsPlaylistChildKeys(
      manifests,
      sniffFirstSeenTimesForFrame(finds, frameId),
    );
    const candidates = nestedChildKeys.size > 0
      ? manifests.filter((url) => !nestedChildKeys.has(videoUrlIdentityKey(url)))
      : manifests;
    let fallback = mergeVideoFinds([], candidates, kinds);
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
  const firstSeenTimes = sniffFirstSeenTimesForFrame(finds, frameId);
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
      firstSeenTimes,
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
      firstSeenTimes,
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

function detectedKindForUrl(finds, url) {
  const key = videoUrlIdentityKey(url);
  if (finds && finds.kindsByFrame instanceof Map) {
    for (const kinds of finds.kindsByFrame.values()) {
      const kind = kinds.get(key);
      if (kind) return kind;
    }
  }
  return finds && finds.kinds instanceof Map ? finds.kinds.get(key) || null : null;
}

/// Resolve a player-specific title for a menu URL. Direct sources match by
/// origin/path; blob players use the same timing attribution as their manifest
/// selection, so labels cannot leak across simultaneous players.
function videoTitleForUrl(finds, url) {
  if (!finds || !(finds.frames instanceof Map)) return "";
  const key = videoUrlIdentityKey(url);
  const labels = new Set();

  for (const [frameId, videos] of finds.frames) {
    if (!Array.isArray(videos) || videos.length === 0) continue;
    const sniffed = sniffedManifestsForFrame(finds, frameId);
    const wholeMedia = wholeMediaUrlsForFrame(finds, frameId);
    const candidates = sniffed.concat(wholeMedia);
    const sniffTimes = sniffTimesForFrame(finds, frameId);
    const firstSeenTimes = sniffFirstSeenTimesForFrame(finds, frameId);

    for (const video of videos) {
      const title = typeof video?.title === "string"
        ? video.title.replace(/\s+/g, " ").trim()
        : "";
      if (!title) continue;

      let matches = typeof video.src === "string" &&
        video.src && videoUrlIdentityKey(video.src) === key;
      if (!matches && video.blob === true && candidates.length > 0) {
        matches = attributedManifestUrlsForVideo(
          videos,
          video,
          candidates,
          sniffTimes,
          firstSeenTimes,
        ).some((candidate) => videoUrlIdentityKey(candidate) === key);
      }
      if (matches) labels.add(title);
    }
  }

  return labels.size === 1 ? labels.values().next().value : "";
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

/// True for a URL that asks the server for part of a file: "bytestart" /
/// "byteend" / "byte_range" parameters (Facebook-style CDNs) or a numeric
/// "range=0-999" (googlevideo). Such a URL is a slice, not the video. Applied
/// to whole-media candidates only, never to manifests.
function isByteRangeSliceUrl(url) {
  try {
    const { searchParams } = new URL(url);
    for (const [key, value] of searchParams) {
      const name = key.toLowerCase();
      if (name === "bytestart" || name === "byteend" || /^byte_?range$/.test(name)) return true;
      if (name === "range" && /^\d+-\d*$/.test(value)) return true;
    }
    return false;
  } catch {
    return true;
  }
}

function isSegmentLikeVideoUrl(url) {
  try {
    const path = new URL(url).pathname.toLowerCase();
    const basename = path.split("/").filter(Boolean).pop() || "";
    if (/(?:^|\/)(?:segments?|chunks?|fragments?|previews?|pre[-_]rolls?|prerolls?|mid[-_]rolls?|midrolls?|post[-_]rolls?|postrolls?|thumbnails?|storyboards?|sprites?|subtitles?|captions?|audio[-_]only|audioonly|prefetch(?:es)?)(?:\/|$)/.test(path)) {
      return true;
    }
    if (/^(?:ad|advert|advertisement|promo|thumbnail|thumb|storyboard|sprite|preroll|midroll|postroll|prefetch)(?:[._-]|$)/.test(basename)) {
      return true;
    }
    return /^(?:seg(?:ment)?[._-]?\d+|(?:chunk|frag(?:ment)?)[._-]+\d+)(?:[._-]|$)/.test(basename);
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
    isSegmentLikeVideoUrl(details.url) ||
    isByteRangeSliceUrl(details.url)
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
    !isByteRangeSliceUrl(url) &&
    sizes instanceof Map &&
    Number.isSafeInteger(sizes.get(videoUrlIdentityKey(url))) &&
    sizes.get(videoUrlIdentityKey(url)) >= MIN_WHOLE_VIDEO_MEDIA_BYTES
  );
}

function noteSniffed(tabId, frameId, url, kind, observedAt = Date.now(), wholeMediaSize = null) {
  if (!fitsGrabUrl(url) || (kind !== "manifest" && kind !== "media")) return false;
  let f = videoFinds.get(tabId);
  if (!f) {
    f = createVideoFinds();
    videoFinds.set(tabId, f);
  }
  pruneExpiredRetiredFrames(f);
  const sourceFrame = Number.isInteger(frameId) && frameId >= 0 ? frameId : 0;
  const tracked = trackedFrameIds(f);
  if (!tracked.has(sourceFrame) && tracked.size >= MAX_VIDEO_FRAMES) {
    if (!evictOldestFrame(f, sourceFrame)) return false;
  }
  // Whether the menu-visible state changed. Repeat observations of the same
  // URL still refresh their last-seen time below, but no save or rebuild.
  let changed = false;

  let kinds = f.kindsByFrame.get(sourceFrame);
  if (!kinds) {
    kinds = new Map();
    f.kindsByFrame.set(sourceFrame, kinds);
  }
  const key = videoUrlIdentityKey(url);
  if (kinds.get(key) !== kind) {
    kinds.set(key, kind);
    changed = true;
  }
  const sequences = sniffSequenceMapForFrame(f, sourceFrame, true);
  const hadPriorObservation =
    sequences.has(key) ||
    (f.sniffedByFrame.get(sourceFrame) || []).some((candidate) => videoUrlIdentityKey(candidate) === key) ||
    (f.mediaByFrame.get(sourceFrame) || []).some((candidate) => videoUrlIdentityKey(candidate) === key);

  const listMap = kind === "manifest" ? f.sniffedByFrame : f.mediaByFrame;
  let urls = listMap.get(sourceFrame);
  if (!urls) {
    urls = [];
    listMap.set(sourceFrame, urls);
  }
  const idx = urls.findIndex((candidate) => videoUrlIdentityKey(candidate) === key);
  if (idx >= 0) {
    if (urls[idx] !== url) {
      urls[idx] = url;
      changed = true;
    }
  } else {
    urls.push(url);
    changed = true;
  }

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
      const wholeIndex = wholeUrls.findIndex((candidate) => videoUrlIdentityKey(candidate) === key);
      if (wholeIndex >= 0) {
        if (wholeUrls[wholeIndex] !== url) {
          wholeUrls[wholeIndex] = url;
          changed = true;
        }
      } else {
        wholeUrls.push(url);
        changed = true;
      }
      if (sizes.get(key) !== wholeMediaSize) {
        sizes.set(key, wholeMediaSize);
        changed = true;
      }
    } else {
      for (let i = wholeUrls.length - 1; i >= 0; i--) {
        if (videoUrlIdentityKey(wholeUrls[i]) === key) {
          wholeUrls.splice(i, 1);
          changed = true;
        }
      }
      if (sizes.delete(key)) changed = true;
    }
    while (wholeUrls.length > MAX_MEDIA_SNIFFS_PER_FRAME) {
      const removed = wholeUrls.shift();
      sizes.delete(videoUrlIdentityKey(removed));
      changed = true;
    }
    if (wholeUrls.length === 0) f.wholeMediaByFrame.delete(sourceFrame);
    if (sizes.size === 0) f.mediaSizesByFrame.delete(sourceFrame);
  }

  // Sequence numbers and first-seen times describe the first request for a
  // path; refreshes update only the exact URL variant and last-observed time.
  if (!hadPriorObservation) sequences.set(key, nextSniffSequence(f));
  const times = sniffTimeMapForFrame(f, sourceFrame, true);
  times.set(key, validLifecycleTime(observedAt));
  if (!(f.sniffFirstSeenByFrame instanceof Map)) f.sniffFirstSeenByFrame = new Map();
  let firstSeen = f.sniffFirstSeenByFrame.get(sourceFrame);
  if (!firstSeen) {
    firstSeen = new Map();
    f.sniffFirstSeenByFrame.set(sourceFrame, firstSeen);
  }
  // Do not reconstruct first-seen times for older v2 entries on refresh.
  if (!hadPriorObservation && !firstSeen.has(key)) {
    firstSeen.set(key, validLifecycleTime(observedAt));
  }

  const limit = kind === "manifest"
    ? MAX_MANIFESTS_PER_FRAME
    : MAX_MEDIA_SNIFFS_PER_FRAME;
  while (urls.length > limit) {
    changed = true;
    const removed = urls.shift();
    const removedKey = videoUrlIdentityKey(removed);
    if (kind === "media") {
      const wholeUrls = f.wholeMediaByFrame.get(sourceFrame) || [];
      for (let i = wholeUrls.length - 1; i >= 0; i--) {
        if (videoUrlIdentityKey(wholeUrls[i]) === removedKey) wholeUrls.splice(i, 1);
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
      otherList.some((candidate) => videoUrlIdentityKey(candidate) === removedKey);
    if (!stillPresent) {
      sequences.delete(removedKey);
      times.delete(removedKey);
      firstSeen.delete(removedKey);
      kinds.delete(removedKey);
    }
  }
  if (urls.length === 0) listMap.delete(sourceFrame);
  if (sequences.size === 0) f.sniffSequencesByFrame.delete(sourceFrame);
  if (times.size === 0) f.sniffTimesByFrame.delete(sourceFrame);
  if (firstSeen.size === 0) f.sniffFirstSeenByFrame.delete(sourceFrame);
  if (kinds.size === 0) f.kindsByFrame.delete(sourceFrame);
  return changed;
}

// Refreshes are serialized through a promise chain: burst manifest traffic
// could otherwise interleave remove/create and hit duplicate menu ids.
let menuChain = Promise.resolve();
// The last menu rendered for the active tab. Repeated refreshes with the same
// rows (live playlists, tab switches) must not remove and recreate them.
let lastMenuSignature = null;
let lastMenuSignatureTabId = null;

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
      lastMenuSignature = null;
      lastMenuSignatureTabId = null;
      chrome.storage.session.set({ menuUrls: [] }).catch(() => {});
      if (tabScope(tabId) && !warnedTabs.has(tabId)) {
        const cleared = chrome.action.setBadgeText({ tabId, text: "" });
        if (cleared && typeof cleared.catch === "function") cleared.catch(() => {});
      }
      return;
    }
    // Combine active DOM video sources with network-observed manifests.
    // Playlist candidates do not require a unique or even discoverable
    // <video> element; individual element clicks remain frame-scoped below.
    let urls = tabId === videoUi.activeTabId ? await resolvedVideoUrls(tabId) : [];
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
        videoName(e.url, i, finds && finds.title, e.kind, videoTitleForUrl(finds, e.url)),
      ),
    );
    // Menu item IDs and labels depend on the visible shape, not URL query
    // tokens. Live playlists often rotate those tokens on every request; keep
    // the menu nodes and update only the index-to-URL map in that case.
    const menuUrls = entries.flatMap((entry) => entry.rows.map((row) => row.url));
    const signature = JSON.stringify([
      tabId,
      names,
      entries.map((entry) => entry.rows.map((row) => row.quality)),
    ]);
    if (lastMenuSignatureTabId === tabId && lastMenuSignature === signature) {
      const currentUrls = videoUi.menuUrls;
      const urlsChanged =
        currentUrls.length !== menuUrls.length ||
        menuUrls.some((url, index) => url !== currentUrls[index]);
      if (urlsChanged) {
        videoUi.menuUrls = menuUrls;
        // A worker restart restores click targets from session storage. Persist
        // the latest rotating URL even though the visible menu did not change.
        chrome.storage.session.set({ menuUrls }).catch(() => {});
      }
      return;
    }
    // Replace the menu only once the replacement is ready: candidate
    // resolution can await a playlist check, and removing the old menu first
    // would leave right-click with nothing while it runs.
    await removeContextMenu(VIDEO_PARENT_ID);
    videoUi.menuUrls = menuUrls;
    if (entries.length === 0) {
      lastMenuSignatureTabId = tabId;
      lastMenuSignature = signature;
      chrome.storage.session.set({ menuUrls: [] }).catch(() => {});
      if (tabScope(tabId) && !warnedTabs.has(tabId)) {
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
    let menuUrlIndex = 0;
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
        // against the latest list even when only the source URL changed.
        const idx = menuUrlIndex++;
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
    lastMenuSignatureTabId = tabId;
    lastMenuSignature = signature;
  };
  await rebuild();
}

function clearVideoUi(tabId) {
  videoFinds.delete(tabId);
  forgetVideoFinds(tabId);
  warnedTabs.delete(tabId);
  lastMenuSignature = null;
  lastMenuSignatureTabId = null;
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
  lastMenuSignature = null;
  lastMenuSignatureTabId = null;
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
  // so unrelated traffic is discarded before touching detection state.
  const kind = classifyStream(
    details.url,
    sniffedHeader(details.responseHeaders, "content-type"),
  );
  if (kind === null) return;
  await restoreVideoFinds(details.tabId);
  const changed = noteSniffed(
    details.tabId,
    details.frameId,
    details.url,
    kind,
    Number.isFinite(details.timeStamp) ? details.timeStamp : Date.now(),
    kind === "media" ? wholeVideoMediaSize(details) : null,
  );
  // A live stream re-fetches the same playlist every few seconds. The
  // observation time was refreshed above; nothing else needs to happen.
  if (!changed) return;
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
    // Cookie pairing can grant page origins without enabling video detection.
    // The detector needs both its network permission and page access.
    return await chrome.permissions.contains({
      permissions: ["webRequest"],
      origins: SHARED_PAGE_ORIGINS,
    });
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
      previousVideos,
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

