// Video detection: HLS/DASH parsing, sniffing, menu building.
import {
  DEFAULTS,
  VIDEO_PARENT_ID,
  VIDEO_ITEM_PREFIX,
  MAX_VIDEO_ITEMS,
  YTDLP_EXCLUSIVE_HOSTS,
  NAME_MAX,
  PLAYLIST_TEXT_CAP,
  MANIFEST_RE,
  DASH_TEXT_CAP,
  PICK_IN_GRAB,
} from "./config.js";
import {
  sendToGrab,
  toGrabUrl,
  getSettings,
  removeAllContextMenus,
  removeContextMenu,
} from "./handoff.js";

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


/// Video platforms yt-dlp extracts: their players use auth-gated/expiring
/// CDN URLs (or DRM), so a detected media URL handed to Grab can't succeed —
/// listing them only produces noise. Detection stays off on these hosts;
/// sending the page itself keeps going through yt-dlp the old way, which is
/// what handles them. Subdomains are covered by hostExcluded below.

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

const shorten = (text, max = NAME_MAX) => {
  if (text.length <= max) return text;
  const dot = text.lastIndexOf(".");
  const ext = dot > 0 && text.length - dot <= 5 ? text.slice(dot) : "";
  const head = text.slice(0, max - ext.length - 1);
  return head + "…" + ext;
};

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
  // Short human-readable differentiator: Video 1, Video 2, ...
  // Quality and fps (in the row) do the rest of the differentiating.
  return `Video ${index + 1}`;
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

/// Whether the worker may fetch `url` on a page's behalf. The worker's host
/// permission bypasses CORS, so a page that makes the browser request a
/// playlist-looking URL could otherwise get this extension to read loopback
/// services or a cloud metadata endpoint. http(s) only; loopback, unspecified,
/// link-local and IPv4-mapped IPv6 hosts are refused. Ordinary LAN hosts stay
/// allowed (home media servers). URL parsing has already normalized decimal,
/// octal and hex IPv4 spellings to dotted form.
function isFetchAllowed(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) return false;
  if (host.includes(":")) {
    return !(
      host === "::" ||
      host === "::1" ||
      host.startsWith("::ffff:") ||
      /^fe[89ab]/.test(host)
    );
  }
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 127 || a === 0 || (a === 169 && b === 254)) return false;
  }
  return true;
}

/// GET a text resource from the worker (5 s timeout), truncated to `cap`
/// characters. Null on any failure (network, non-2xx, abort).
async function fetchText(url, cap) {
  if (!isFetchAllowed(url)) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  let reader;
  try {
    // No credentials: the worker must not replay the user's session at a URL
    // that only a web page chose.
    const response = await fetch(url, {
      signal: controller.signal,
      credentials: "omit",
    });
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
    if (name) return shorten(name);
  } catch {
    // Fall through.
  }
  return `Variant ${index + 1}`;
}


// --- DASH ------------------------------------------------------------------
//
// MPD manifests list video and audio as separate AdaptationSets, so a DASH
// stream is always "audio is separate". Service workers have no DOMParser;
// the few attributes needed are read with regexes.

/// Cache: mpd url -> [{height, bandwidth, fps}] (null when unreadable).
const dashCache = new Map();

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


/// Best quality first: height, then bandwidth.
const byQuality = (a, b) =>
  (b.height || 0) - (a.height || 0) || (b.bandwidth || 0) - (a.bandwidth || 0);

/// "1080p / 720p / 360p" from variants already sorted best first; at most
/// five heights, "…" when there are more. Empty when none has a height.
function heightList(variants) {
  const seen = new Map();
  for (const v of variants) {
    if (v.height > 0) {
      const key = `${v.height}p${v.fps ? Math.round(v.fps) : ""}`;
      if (!seen.has(key)) seen.set(key, v);
    }
  }
  const shown = [...seen.values()]
    .slice(0, 5)
    .map((v) => `${v.height}p${v.fps ? Math.round(v.fps) : ""}`);
  if (seen.size > 5) shown.push("…");
  return shown.join(" / ");
}

const pickRowQuality = (variants) =>
  [heightList(variants), PICK_IN_GRAB].filter(Boolean).join(" • ");

/// Rows for an HLS URL. A media playlist (or an unreadable master) is one
/// plain row.
async function hlsMenuRows(url) {
  const all = await fetchAllVariants(url);
  const plain = [{ quality: "", url, height: 0 }];
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
      ? [{ quality: variantMenuTitle(muxed[0], 0), url, height: muxed[0].height || 0 }]
      : muxed.map((v, i) => ({ quality: variantMenuTitle(v, i), url: v.url, height: v.height || 0 }));
  if (split.length > 0) {
    const bestSplit = Math.max(...split.map((v) => v.height || 0), 0);
    rows.push({ quality: pickRowQuality(split), url, height: bestSplit });
  }
  return rows.length > 0 ? rows : plain;
}

/// One row for a DASH manifest: its qualities, handing the MPD to Grab.
async function dashMenuRows(url) {
  const reps = await fetchDashRepresentations(url);
  if (!reps) return [{ quality: "", url, height: 0 }];
  const bestHeight = Math.max(...reps.map((r) => r.height || 0), 0);
  return [{ quality: pickRowQuality(reps), url, height: bestHeight }];
}

/// Row for a direct file: the height the player reported, when known.
function directMenuRow(url, height) {
  return { quality: height > 0 ? `${height}p` : "", url, height: height || 0 };
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
  const bestHeight = Math.max(...rows.map((r) => r.height || 0), ctx.height || 0);
  return { url, kind, rows, bestHeight };
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
    // Quality-order the menu: best height first, so the 8-item cap keeps the
    // best videos, not the first ones found.
    entries.sort((a, b) => (b.bestHeight || 0) - (a.bestHeight || 0));
    const capped = entries.slice(0, MAX_VIDEO_ITEMS);
    const names = uniqueLabels(
      capped.map((e, i) =>
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
    capped.forEach((entry, ei) => {
      const name = names[ei];
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
          title: menuRowTitle(name, row.quality),
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

function setDetectVideosOn(value) {
  detectVideosOn = value;
}

function getDetectVideosOn() {
  return detectVideosOn;
}

function getMenuUrls() {
  return menuUrls;
}

function setActiveTabId(id) {
  activeTabId = id;
}

/// Reset module state for tests (worker restart simulation).
function __resetVideoState() {
  videoFinds.clear();
  playlistCache.clear();
  dashCache.clear();
  activeTabId = null;
  menuUrls = [];
  detectVideosOn = DEFAULTS.detectVideos;
  menuChain = Promise.resolve();
}

export {
  hostExcluded,
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
  domVideosFor,
  mergedVideoUrls,
  videoFinds,
  setDetectVideosOn,
  getDetectVideosOn,
  getMenuUrls,
  setActiveTabId,
  isExcludedTab,
  sniffedHeader,
  __resetVideoState,
};
