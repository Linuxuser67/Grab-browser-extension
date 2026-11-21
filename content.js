// Grab video detector (content script, isolated world, all frames).
//
// Reports sufficiently large <video> elements that are actively playing,
// regardless of whether playback was started by the user or by the site.
// Pause/end reports retire the entry from the background worker's right-click
// menu ("Download video with Grab"). Videos whose source is a blob: URL (MSE
// players) have no file behind them; those are flagged and the worker pairs
// them with the stream manifests it sniffed via webRequest, the same approach
// FDM/IDM-style downloaders use.

const MIN_VIDEO_PX = 120; // ignore tiny players (ads, trackers)
// The worker and content script use one shared host exclusion list.
// In the browser these come from shared.js globals; under Node tests, from require.
const sharedModule = typeof SHARED_EXCLUDED_HOSTS !== "undefined"
  ? { SHARED_EXCLUDED_HOSTS, sharedHostExcluded }
  : require("./shared.js");
const excludedHostList = sharedModule.SHARED_EXCLUDED_HOSTS;
const isExcludedHost = sharedModule.sharedHostExcluded;

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

/// Only actively playing videos stay in the menu. Sites may start primary
/// playback automatically, and transient user activation is not a reliable
/// signal for distinguishing a real video from autoplay.
function isActiveVideo(v) {
  return !!v && !v.paused && !v.ended;
}

/// All <video> elements under `root`, piercing open shadow roots (custom
/// players). Closed roots are unreachable by design, and their media events
/// never reach the document listener. `onShadowRoot`, when given, sees each
/// open root during the same walk, so the caller needs no second traversal.
function allVideos(root, onShadowRoot) {
  const out = [];
  if (!root || !root.querySelectorAll) return out;
  for (const v of root.querySelectorAll("video")) out.push(v);
  for (const el of root.querySelectorAll("*")) {
    if (el.shadowRoot) {
      if (onShadowRoot) onShadowRoot(el.shadowRoot);
      out.push(...allVideos(el.shadowRoot, onShadowRoot));
    }
  }
  return out;
}

/// Pure over a document-like: [{src, blob, height?}] for each qualifying <video>.
/// `isActive` decides which videos count as active; the live wiring passes
/// `isActiveVideo`. Tests pass explicit predicates. Pierces shadow roots via allVideos.
function collectVideos(doc, isActive, onShadowRoot, onVideo, getVideoMetadata) {
  const out = [];
  for (const v of allVideos(doc, onShadowRoot)) {
    if (onVideo) onVideo(v);
    if (!isBigEnough(v)) continue;
    if (isActive && !isActive(v)) continue;
    const src = usableVideoSrc(v);
    const blob = !src && isBlobVideo(v);
    const entry = { src, blob };
    // Preserve the clicked element identity for the background context-menu
    // handler. This opaque URL is never used as the URL handed to Grab.
    if (isBlobVideo(v)) entry.blobUrl = v.currentSrc || v.src;
    // Decoded height (known after metadata loads): labels direct files.
    if (v.videoHeight > 0) entry.height = v.videoHeight;
    const metadata = getVideoMetadata ? getVideoMetadata(v) : null;
    if (metadata && Number.isSafeInteger(metadata.elementId) && metadata.elementId > 0) {
      entry.elementId = metadata.elementId;
    }
    if (metadata && Number.isFinite(metadata.loadStartedAt) && metadata.loadStartedAt >= 0) {
      entry.loadStartedAt = metadata.loadStartedAt;
    }
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
// Currently-playing detection: the menu offers actively playing videos,
// whether playback was started by the site or the user. Pause/end retire entries.

if (
  typeof chrome !== "undefined" &&
  chrome.runtime &&
  typeof document !== "undefined" &&
  // No reporting where detection can't produce a downloadable URL; the
  // worker applies the same gate to sniffed manifests.
  (typeof location === "undefined" || !isExcludedHost(location.hostname))
) {
  let pendingFrameLifecycle = null;
  let pendingFrameLifecycleSource = null;
  let pendingFrameLifecycleAt = null;
  let lastSent = "";
  const lastVideoSource = new WeakMap();
  const videoIds = new WeakMap();
  const videoLoadStartedAt = new WeakMap();
  let nextVideoId = 0;
  const frameLifecyclePriority = { pause: 1, ended: 2, reset: 3 };

  function currentVideoSource(video) {
    const direct = usableVideoSrc(video);
    if (direct) return direct;
    const candidate = video && (video.currentSrc || video.src);
    return typeof candidate === "string" && candidate.startsWith("blob:")
      ? candidate
      : null;
  }

  function rememberVideoSource(video) {
    const current = currentVideoSource(video);
    if (current) lastVideoSource.set(video, current);
    return current || lastVideoSource.get(video) || null;
  }

  function rememberVideoLoadStart(video, replace = false) {
    if (!video) return;
    if (replace || !Number.isFinite(videoLoadStartedAt.get(video))) {
      videoLoadStartedAt.set(video, Date.now());
    }
  }

  function videoReportMetadata(video) {
    let elementId = videoIds.get(video);
    if (!Number.isSafeInteger(elementId)) {
      elementId = ++nextVideoId;
      videoIds.set(video, elementId);
    }
    rememberVideoLoadStart(video);
    return {
      elementId,
      loadStartedAt: videoLoadStartedAt.get(video),
    };
  }

  function report(lifecycleOverride = null, lifecycleSourceOverride = null, lifecycleAtOverride = null) {
    // Full scans happen on startup, media events, and worker rescan requests,
    // not on every pointer/click interaction.
    const videos = collectVideos(
      document,
      isActiveVideo,
      wireShadowRoot,
      rememberVideoSource,
      videoReportMetadata,
    );
    const title = pageVideoTitle(document);
    // Keep the strongest lifecycle event when media events coalesce during
    // the debounce window (a reset must not be downgraded to a pause).
    const pendingPriority = frameLifecyclePriority[pendingFrameLifecycle] || 0;
    const overridePriority = frameLifecyclePriority[lifecycleOverride] || 0;
    const samePriorityLifecycle = overridePriority > 0 && overridePriority === pendingPriority;
    const lifecycle = overridePriority > pendingPriority || samePriorityLifecycle
      ? lifecycleOverride
      : pendingFrameLifecycle;
    const lifecycleSource = samePriorityLifecycle
      ? (lifecycleSourceOverride === pendingFrameLifecycleSource
        ? lifecycleSourceOverride
        : null)
      : (overridePriority > pendingPriority
        ? lifecycleSourceOverride
        : pendingFrameLifecycleSource);
    const lifecycleTimes = [lifecycleAtOverride, pendingFrameLifecycleAt].filter(Number.isFinite);
    const lifecycleAt = lifecycleTimes.length ? Math.min(...lifecycleTimes) : null;
    pendingFrameLifecycle = null;
    pendingFrameLifecycleSource = null;
    pendingFrameLifecycleAt = null;
    const replaceFrame = lifecycle !== null;
    // The title is part of the snapshot: an SPA can change it with no new
    // video, and the menu labels must follow.
    const snapshot = JSON.stringify([videos, title]);
    if (snapshot === lastSent && !replaceFrame) return;
    lastSent = snapshot;
    const message = {
      type: "grab-videos-detected",
      videos,
      title,
      replaceFrame,
    };
    if (lifecycle) message.lifecycle = lifecycle;
    if (typeof lifecycleSource === "string") message.lifecycleSource = lifecycleSource;
    if (Number.isFinite(lifecycleAt)) message.lifecycleAt = lifecycleAt;
    const sent = chrome.runtime.sendMessage(message);
    // Rejects when no receiver is listening (worker restarting, or a stale
    // script after an extension update). Nothing to recover.
    if (sent && typeof sent.catch === "function") sent.catch(() => {});
  }

  let timer = null;
  function scheduleReport(lifecycle = null, lifecycleSource = null, lifecycleAt = null) {
    const incomingPriority = frameLifecyclePriority[lifecycle] || 0;
    const pendingPriority = frameLifecyclePriority[pendingFrameLifecycle] || 0;
    if (lifecycle && incomingPriority > pendingPriority) {
      pendingFrameLifecycle = lifecycle;
      pendingFrameLifecycleSource = lifecycleSource;
      pendingFrameLifecycleAt = lifecycleAt;
    } else if (lifecycle && incomingPriority === pendingPriority) {
      pendingFrameLifecycleAt =
        Number.isFinite(lifecycleAt) && Number.isFinite(pendingFrameLifecycleAt)
          ? Math.min(lifecycleAt, pendingFrameLifecycleAt)
          : (Number.isFinite(lifecycleAt) ? lifecycleAt : pendingFrameLifecycleAt);
      if (lifecycleSource !== pendingFrameLifecycleSource) {
        // Coalesced events from different elements are ambiguous. Do not attribute
        // the frame-level manifest to whichever element happened to fire last.
        pendingFrameLifecycleSource = null;
      }
    }
    if (timer) clearTimeout(timer);
    timer = setTimeout(report, 400);
  }

  function onPlay(e) {
    const t = e && e.target;
    if (!t || t.tagName !== "VIDEO") return;
    // Site-initiated playback is valid media too. The report scan checks the
    // live paused/ended state and the existing size threshold filters tiny
    // inline previews and trackers.
    rememberVideoSource(t);
    rememberVideoLoadStart(t);
    scheduleReport();
  }

  function onLoadStart(e) {
    const t = e && e.target;
    if (!t || t.tagName !== "VIDEO") return;
    rememberVideoSource(t);
    // loadstart begins a new resource timeline for this element.
    rememberVideoLoadStart(t, true);
    scheduleReport();
  }

  function onStopped(e) {
    const t = e && e.target;
    if (t && t.tagName === "VIDEO") {
      scheduleReport(
        e.type === "ended" ? "ended" : "pause",
        rememberVideoSource(t),
        Date.now(),
      );
    }
  }

  function onEmptied(e) {
    const t = e && e.target;
    if (!t || t.tagName !== "VIDEO") return;
    // Use the pre-reset source identity: currentSrc may already be empty.
    const source = lastVideoSource.get(t) || currentVideoSource(t);
    lastVideoSource.delete(t);
    videoLoadStartedAt.delete(t);
    // Reset immediately so the old manifest is retired before replacement
    // source requests normally arrive. Pause/end remain debounced.
    if (timer) clearTimeout(timer);
    timer = null;
    report("reset", source, Date.now());
  }

  function onLoadedMetadata(e) {
    const t = e && e.target;
    if (t && t.tagName === "VIDEO") {
      rememberVideoSource(t);
      rememberVideoLoadStart(t);
    }
    scheduleReport();
  }

  // Media events don't bubble and aren't composed, so they never leave a
  // shadow root. Attach the same capture listeners to each open shadow root
  // found during a sweep; events fired inside a root are visible there.
  const shadowRootsWired = new WeakSet();
  function wireShadowRoot(sr) {
    if (!sr || shadowRootsWired.has(sr)) return;
    shadowRootsWired.add(sr);
    sr.addEventListener("loadstart", onLoadStart, true);
    sr.addEventListener("play", onPlay, true);
    sr.addEventListener("playing", onPlay, true);
    sr.addEventListener("pause", onStopped, true);
    sr.addEventListener("ended", onStopped, true);
    sr.addEventListener("emptied", onEmptied, true);
    sr.addEventListener("loadedmetadata", onLoadedMetadata, true);
  }

  // play/playing don't bubble; capture at the document.
  document.addEventListener("loadstart", onLoadStart, true);
  document.addEventListener("play", onPlay, true);
  document.addEventListener("playing", onPlay, true);
  document.addEventListener("pause", onStopped, true);
  document.addEventListener("ended", onStopped, true);
  document.addEventListener("emptied", onEmptied, true);
  // The decoded height only exists once metadata has loaded.
  document.addEventListener("loadedmetadata", onLoadedMetadata, true);

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
  module.exports = { collectVideos, usableVideoSrc, sharedHostExcluded: isExcludedHost, SHARED_EXCLUDED_HOSTS: excludedHostList, MIN_VIDEO_PX, pageVideoTitle, isActiveVideo };
}
