// Grab video detector (content script, isolated world, all frames).
//
// Reports <video> elements the user started playing (play-event latch; pause never
// unlatches, a media reset does; muted autoplay is noise) that have usable
// http(s) sources, to the background worker, which offers them in the
// right-click menu ("Download video with Grab"). Videos whose source is a
// blob: URL (MSE players) have no file behind them; those are flagged and the
// worker pairs them with the stream manifests it sniffed via webRequest — the
// same trick FDM/IDM-style downloaders use.

const MIN_VIDEO_PX = 120; // ignore tiny players (ads, trackers)

// The worker and content script use one shared host exclusion list.
const contentShared = typeof SHARED_EXCLUDED_HOSTS !== "undefined"
  ? null
  : (typeof module !== "undefined" && module.exports ? require("./shared.js") : null);
const excludedHostList = typeof SHARED_EXCLUDED_HOSTS !== "undefined"
  ? SHARED_EXCLUDED_HOSTS
  : contentShared.SHARED_EXCLUDED_HOSTS;
const isExcludedHost = typeof sharedHostExcluded === "function"
  ? sharedHostExcluded
  : contentShared.sharedHostExcluded;

/// First http(s) candidate among currentSrc, src and <source> children.
function usableVideoSrc(video) {
  const candidates = [];
  if (video.currentSrc) candidates.push(video.currentSrc);
  if (video.src) candidates.push(video.src);
  const sources = video.querySelectorAll ? video.querySelectorAll("source") : [];
  for (const s of sources) {
    if (s.src) candidates.push(s.src);
  }
  for (const c of candidates) {
    if (typeof c === "string" && /^(https?):\/\//i.test(c)) return c;
  }
  return null;
}

function isBlobVideo(video) {
  const s = video.currentSrc || video.src || "";
  return typeof s === "string" && s.startsWith("blob:");
}

function isBigEnough(video) {
  if ((video.videoWidth || 0) >= MIN_VIDEO_PX) return true;
  if ((video.videoHeight || 0) >= MIN_VIDEO_PX) return true;
  if (video.getBoundingClientRect) {
    const r = video.getBoundingClientRect();
    if (r.width >= MIN_VIDEO_PX || r.height >= MIN_VIDEO_PX) return true;
  }
  return false;
}

/// Whether a video counts as started — latched after play, or actively
/// playing with usable data. Muted autoplay (ads, previews) is noise: the latch
/// is kept so unmuting counts immediately, but muted videos never report.
function isStartedVideo(v, played) {
  if (!v) return false;
  // Latched (fired play): the user started it, count even if muted — a
  // muted autoplay they later unmute must already be reported.
  if (played.has(v)) return true;
  // Not latched: muted autoplay is noise (ads), unmuted playing is real.
  if (v.muted) return false;
  // readyState > 2 (HAVE_FUTURE_DATA): playback actually proceeds, not
  // stalled on buffering with a stale currentTime.
  return !v.paused && !v.ended && (v.readyState || 0) > 2 && (v.currentTime || 0) > 0;
}

/// All <video> elements under `root`, piercing open shadow roots (custom
/// players). Closed roots are unreachable by design, and their media events
/// never reach the document listener.
function allVideos(root) {
  const out = [];
  if (!root || !root.querySelectorAll) return out;
  for (const v of root.querySelectorAll("video")) out.push(v);
  for (const el of root.querySelectorAll("*")) {
    if (el.shadowRoot) out.push(...allVideos(el.shadowRoot));
  }
  return out;
}

/// Pure over a document-like: [{src, blob, height?}] for each qualifying <video>.
/// `isPlayed` decides which videos count as started by the user; the live
/// wiring passes `(v) => isStartedVideo(v, played)`. Tests pass explicit
/// predicates. Pierces shadow roots via allVideos.
function collectVideos(doc, isPlayed) {
  const out = [];
  for (const v of allVideos(doc)) {
    if (!isBigEnough(v)) continue;
    if (isPlayed && !isPlayed(v)) continue;
    const src = usableVideoSrc(v);
    const entry = { src, blob: !src && isBlobVideo(v) };
    // Decoded height (known after metadata loads): labels direct files.
    if (v.videoHeight > 0) entry.height = v.videoHeight;
    out.push(entry);
  }
  return out;
}

/// A page <title> without its trailing " - Site" / " | Site" suffix.
function cleanDocTitle(title) {
  const t = String(title || "").replace(/\s+/g, " ").trim();
  const m = /^(.{8,}?)\s+[-–—|·]\s+[^-–—|·]{1,30}$/.exec(t);
  return m ? m[1] : t;
}

/// The video's own title from the page: og:title is the video title as the
/// site describes it (no " - Site Name" suffix), then twitter:title, then
/// the page <title> minus its site suffix; empty when none exists.
function pageVideoTitle(doc) {
  if (!doc || !doc.querySelector) return "";
  const meta = (selector) => {
    const el = doc.querySelector(selector);
    return ((el && el.content) || "").trim();
  };
  return (
    meta('meta[property="og:title"]') ||
    meta('meta[name="twitter:title"]') ||
    cleanDocTitle(doc.title)
  );
}

// --- Live wiring (browser only; the pure helpers above are unit-tested) ---
//
// Played-only detection: the menu offers a video only once the user started it.
// A WeakSet latches each <video> on its first play event and never unlatches
// on pause — the user pauses to right-click. A media reset (emptied) unlatches:
// the new load is a video the user hasn't started. Muted videos are filtered at
// collect time (muted autoplay is ad/preview noise); unmuting re-reports via
// volumechange.

if (
  typeof chrome !== "undefined" &&
  chrome.runtime &&
  typeof document !== "undefined" &&
  // No reporting where detection can't produce a downloadable URL; the
  // worker applies the same gate to sniffed manifests.
  (typeof location === "undefined" || !isExcludedHost(location.hostname))
) {
  const played = new WeakSet();
  let lastSent = "";

  function report() {
    // Full scans happen on startup, media events, and worker rescan requests,
    // not on every pointer/click interaction.
    wireOpenShadowRoots(document);
    const videos = collectVideos(document, (v) => isStartedVideo(v, played));
    const title = pageVideoTitle(document);
    // The title is part of the snapshot: an SPA can change it with no new
    // video, and the menu labels must follow.
    const snapshot = JSON.stringify([videos, title]);
    if (snapshot === lastSent) return;
    lastSent = snapshot;
    chrome.runtime.sendMessage({
      type: "grab-videos-detected",
      videos,
      title,
    });
  }

  let timer = null;
  function scheduleReport() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(report, 400);
  }

  function onPlay(e) {
    const t = e && e.target;
    if (!t || t.tagName !== "VIDEO") return;
    // Latch unmuted play outright. Latch muted play too when the user just
    // interacted (userActivation.isActive, ~5s after click/tap/key): a muted
    // video the user started is intent, not autoplay noise. Muted autoplay
    // with no recent interaction stays unlatched until unmute (volumechange).
    const userActive =
      typeof navigator !== "undefined" &&
      navigator.userActivation &&
      navigator.userActivation.isActive;
    if (!t.muted || userActive) {
      played.add(t);
      scheduleReport();
    }
  }
  function onEmptied(e) {
    const t = e && e.target;
    if (t && t.tagName === "VIDEO") {
      played.delete(t);
      scheduleReport();
    }
  }

  // Media events don't bubble and aren't composed, so they never leave a
  // shadow root. Attach the same capture listeners to each open shadow root
  // found during a sweep; events fired inside a root are visible there.
  const shadowRootsWired = new WeakSet();
  function wireShadowRoot(sr) {
    if (!sr || shadowRootsWired.has(sr)) return;
    shadowRootsWired.add(sr);
    sr.addEventListener("play", onPlay, true);
    sr.addEventListener("playing", onPlay, true);
    sr.addEventListener("emptied", onEmptied, true);
    sr.addEventListener("volumechange", onVolumeChange, true);
    sr.addEventListener("loadedmetadata", () => scheduleReport(), true);
  }

  function onVolumeChange(e) {
    const t = e && e.target;
    // Unmuting is user intent: latch it even if paused.
    if (t && t.tagName === "VIDEO" && !t.muted) played.add(t);
    scheduleReport();
  }

  // play/playing don't bubble; capture at the document.
  document.addEventListener("play", onPlay, true);
  document.addEventListener("playing", onPlay, true);
  document.addEventListener("emptied", onEmptied, true);
  document.addEventListener("volumechange", onVolumeChange, true);
  // The decoded height only exists once metadata has loaded.
  document.addEventListener("loadedmetadata", () => scheduleReport(), true);

  /// Discover roots during a deliberate scan, separately from pure collection.
  function wireOpenShadowRoots(root) {
    if (!root || !root.querySelectorAll) return;
    for (const el of root.querySelectorAll("*")) {
      if (el.shadowRoot) {
        wireShadowRoot(el.shadowRoot);
        wireOpenShadowRoots(el.shadowRoot);
      }
    }
  }

  // Pointer/click events expose the open shadow roots on the event path. Wire
  // only those roots; don't walk every node on the page for each interaction.
  function wireShadowRootsOnPath(event) {
    if (!event || typeof event.composedPath !== "function") return;
    for (const node of event.composedPath()) {
      if (!node) continue;
      if (node.nodeType === 11 && node.host) wireShadowRoot(node);
      if (node.shadowRoot) wireShadowRoot(node.shadowRoot);
    }
  }
  document.addEventListener("click", wireShadowRootsOnPath, true);
  document.addEventListener("pointerdown", wireShadowRootsOnPath, true);

  chrome.runtime.onMessage.addListener((msg) => {
    // The worker is ephemeral; its in-memory finds die with it, so it asks
    // tabs to report again after a restart or a tab switch.
    if (msg && msg.type === "grab-rescan") {
      lastSent = "";
      report();
    }
  });

  report();
}

// Test hook for node:test.
if (typeof module !== "undefined" && module.exports) {
  module.exports = { collectVideos, usableVideoSrc, hostExcluded: isExcludedHost, DETECT_EXCLUDED_HOSTS: excludedHostList, MIN_VIDEO_PX, pageVideoTitle, isStartedVideo };
}
