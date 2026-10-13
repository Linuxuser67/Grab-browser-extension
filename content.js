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

// The worker gates reports by sender.tab.url against YTDLP_EXCLUSIVE_HOSTS,
// so the content script reports unconditionally — no host list to keep in
// sync here.

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

/// Pure: whether a video counts as started — played at least once (the latch)
/// and audible right now. Muted autoplay (ads, previews) is noise: the latch
/// is kept so unmuting counts immediately, but muted videos never report.
function isStartedVideo(v, played) {
  if (!v || v.muted) return false;
  if (played.has(v)) return true;
  return !v.paused && !v.ended && (v.currentTime || 0) > 0;
}

/// Pure over a document-like: [{src, blob}] for each qualifying <video>.
/// `isPlayed` decides which videos count as started by the user; the live
/// wiring passes `(v) => isStartedVideo(v, played)`. Tests pass explicit
/// predicates.
function collectVideos(doc, isPlayed) {
  const out = [];
  if (!doc || !doc.querySelectorAll) return out;
  const videos = doc.querySelectorAll("video");
  for (const v of videos) {
    if (!isBigEnough(v)) continue;
    if (isPlayed && !isPlayed(v)) continue;
    const src = usableVideoSrc(v);
    out.push({ src, blob: !src && isBlobVideo(v) });
  }
  return out;
}

/// The video's own title from the page: og:title is the video title as the
/// site describes it (no " - Site Name" suffix); empty when absent.
function pageVideoTitle(doc) {
  if (!doc || !doc.querySelector) return "";
  const og = doc.querySelector('meta[property="og:title"]');
  const t = (og && og.content) || "";
  return t.trim();
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
  typeof document !== "undefined"
) {
  const played = new WeakSet();
  let lastSent = "";

  const report = () => {
    const videos = collectVideos(document, (v) => isStartedVideo(v, played));
    const snapshot = JSON.stringify(videos);
    if (snapshot === lastSent) return;
    lastSent = snapshot;
    chrome.runtime.sendMessage({
      type: "grab-videos-detected",
      videos,
      title: pageVideoTitle(document),
    });
  };

  let timer = null;
  const scheduleReport = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(report, 400);
  };

  const onPlay = (e) => {
    const t = e && e.target;
    // Latch regardless of mute: a muted autoplay that the user later unmutes
    // must already count as started when volumechange re-reports.
    if (t && t.tagName === "VIDEO") {
      played.add(t);
      scheduleReport();
    }
  };
  const onEmptied = (e) => {
    const t = e && e.target;
    if (t && t.tagName === "VIDEO") {
      played.delete(t);
      scheduleReport();
    }
  };

  // play/playing don't bubble; capture at the document.
  document.addEventListener("play", onPlay, true);
  document.addEventListener("playing", onPlay, true);
  document.addEventListener("emptied", onEmptied, true);
  document.addEventListener("volumechange", () => scheduleReport(), true);

  // Initial sweep: latch videos already playing when this script ran; the
  // audible check happens at collect time.
  if (document.querySelectorAll) {
    for (const v of document.querySelectorAll("video")) {
      if (!v.paused && !v.ended && (v.currentTime || 0) > 0) played.add(v);
    }
  }

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
  module.exports = { collectVideos, usableVideoSrc, MIN_VIDEO_PX, pageVideoTitle, isStartedVideo };
}
