// Grab video detector (content script, isolated world, all frames).
//
// Reports <video> elements with usable http(s) sources to the background
// worker, which offers them in the right-click menu ("Download video with
// Grab"). Videos whose source is a blob: URL (MSE players) have no file
// behind them; those are flagged and the worker pairs them with the stream
// manifests it sniffed via webRequest — the same trick FDM/IDM-style
// downloaders use.

const MIN_VIDEO_PX = 120; // ignore tiny players (ads, trackers)

// Hosts where handing a detected media URL to Grab can't succeed
// (auth-gated/expiring CDN URLs): detection only produces noise there.
// Keep in sync with VIDEO_DETECT_EXCLUDED_HOSTS in background.js — the
// worker gates the menu too, for manifests sniffed without a page report.
const DETECT_EXCLUDED_HOSTS = ["instagram.com", "tiktok.com"];

/// True for the host itself and any subdomain, never for lookalikes.
function hostExcluded(host) {
  const h = String(host || "").toLowerCase();
  return DETECT_EXCLUDED_HOSTS.some((d) => h === d || h.endsWith("." + d));
}

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

/// Pure over a document-like: [{src, blob}] for each qualifying <video>.
function collectVideos(doc) {
  const out = [];
  if (!doc || !doc.querySelectorAll) return out;
  const videos = doc.querySelectorAll("video");
  for (const v of videos) {
    if (!isBigEnough(v)) continue;
    const src = usableVideoSrc(v);
    out.push({ src, blob: !src && isBlobVideo(v) });
  }
  return out;
}

// --- Live wiring (browser only; the pure helpers above are unit-tested) ---

if (
  typeof chrome !== "undefined" &&
  chrome.runtime &&
  typeof document !== "undefined" &&
  // No reporting where detection can't produce a downloadable URL; the
  // worker applies the same gate to sniffed manifests.
  (typeof location === "undefined" || !hostExcluded(location.hostname))
) {
  let lastSent = "";

  function report() {
    const videos = collectVideos(document);
    const snapshot = JSON.stringify(videos);
    if (snapshot === lastSent) return;
    lastSent = snapshot;
    chrome.runtime.sendMessage({ type: "grab-videos-detected", videos });
  }

  let timer = null;
  function scheduleReport() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(report, 400);
  }

  if (document.documentElement) {
    new MutationObserver(scheduleReport).observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["src"],
    });
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
  module.exports = { collectVideos, usableVideoSrc, hostExcluded, MIN_VIDEO_PX };
}
