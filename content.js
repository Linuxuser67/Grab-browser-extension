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

function videoElementTitle(video) {
  if (!video || typeof video.getAttribute !== "function") return "";
  const clean = (value) => {
    const title = String(value || "").replace(/\s+/g, " ").trim();
    if (!title || /^(?:(?:video|media|player)(?:\s+(?:\d+|player|controls))?)$/i.test(title)) return "";
    return title.slice(0, 512);
  };
  const fromAttributes = (element, names) => {
    if (!element || typeof element.getAttribute !== "function") return "";
    for (const name of names) {
      const title = clean(element.getAttribute(name));
      if (title) return title;
    }
    return "";
  };

  const direct = fromAttributes(video, ["data-video-title", "data-title", "title", "aria-label"]);
  if (direct) return direct;

  const labelledBy = video.getAttribute("aria-labelledby");
  const doc = video.ownerDocument;
  if (labelledBy && doc && typeof doc.getElementById === "function") {
    const title = clean(labelledBy.split(/\s+/)
      .map((id) => doc.getElementById(id))
      .filter(Boolean)
      .map((element) => element.textContent || "")
      .join(" "));
    if (title) return title;
  }

  // Some players put the media title on a small wrapper instead of <video>.
  let parent = video.parentElement;
  for (let depth = 0; parent && depth < 3; depth += 1, parent = parent.parentElement) {
    const title = fromAttributes(parent, ["data-video-title", "data-title"]);
    if (title) return title;
  }

  const figure = typeof video.closest === "function" ? video.closest("figure") : null;
  const caption = figure && figure.querySelector ? figure.querySelector("figcaption") : null;
  return clean(caption && caption.textContent);
}

/// Pure over a document-like: [{src, blob, height?}] for each qualifying <video>.
/// `isActive` decides which videos count as active; the live wiring passes
/// `isActiveVideo`. Tests pass explicit predicates. Pierces shadow roots via allVideos.
/// `knownRoots` switches to a shallow scan: the document plus those roots only
/// (already wired during an earlier deep walk). Null means a deep walk.
function collectVideos(doc, isActive, onShadowRoot, onVideo, getVideoMetadata, knownRoots = null) {
  const out = [];
  const videos = knownRoots === null
    ? allVideos(doc, onShadowRoot)
    : (doc && doc.querySelectorAll ? [...doc.querySelectorAll("video")] : []);
  if (knownRoots !== null) {
    for (const root of knownRoots) {
      if (!root || !root.querySelectorAll) continue;
      videos.push(...root.querySelectorAll("video"));
    }
  }
  for (const v of videos) {
    if (onVideo) onVideo(v);
    if (!isBigEnough(v)) continue;
    if (isActive && !isActive(v)) continue;
    const src = usableVideoSrc(v);
    const blob = !src && isBlobVideo(v);
    const entry = { src, blob };
    const title = videoElementTitle(v);
    if (title) entry.title = title;
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
  typeof document !== "undefined"
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

  function report(lifecycleOverride = null, lifecycleSourceOverride = null, lifecycleAtOverride = null, deep = false) {
    // Deep scans happen on startup and when the worker asks after a new
    // playlist path; ordinary media events read the document and already
    // wired shadow roots instead of walking every element on the page.
    const videos = collectVideos(
      document,
      isActiveVideo,
      wireShadowRoot,
      rememberVideoSource,
      videoReportMetadata,
      deep ? null : knownShadowRoots(),
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
  // Strong list of the roots wired so far: a shallow scan must still see
  // videos inside open shadow roots. Disconnected roots are dropped because
  // a video removed from the page must not stay in the menu.
  const wiredShadowRoots = [];
  const shadowRootObservers = new Map();
  const MutationObserverCtor = document.defaultView && document.defaultView.MutationObserver;

  function knownShadowRoots() {
    for (let i = wiredShadowRoots.length - 1; i >= 0; i--) {
      const root = wiredShadowRoots[i];
      if (!root || !root.host || !root.host.isConnected) {
        const observer = shadowRootObservers.get(root);
        if (observer) observer.disconnect();
        shadowRootObservers.delete(root);
        wiredShadowRoots.splice(i, 1);
      }
    }
    return wiredShadowRoots;
  }

  /// Inspect only a newly inserted subtree for open shadow roots. This catches
  /// players mounted after startup without returning to page-wide scans on
  /// ordinary media events. Each discovered root gets its own child observer.
  function wireShadowRootsInSubtree(node) {
    if (!node || (node.nodeType !== 1 && node.nodeType !== 11)) return false;
    let discovered = false;
    const inspectHost = (host) => {
      if (!host || !host.shadowRoot) return;
      const root = host.shadowRoot;
      if (!shadowRootsWired.has(root)) discovered = true;
      wireShadowRoot(root);
      if (wireShadowRootsInSubtree(root)) discovered = true;
    };
    if (node.nodeType === 1) inspectHost(node);
    // A leaf cannot contain another shadow host. Inspect the node itself first
    // so an ordinary element with its own open root is still discovered.
    if (node.childElementCount === 0) return discovered;
    if (typeof node.querySelectorAll === "function") {
      for (const host of node.querySelectorAll("*")) {
        if (host.shadowRoot) inspectHost(host);
      }
    }
    return discovered;
  }

  // Batch inserted subtrees instead of walking each one in the observer's
  // mutation callback. This bounds discovery work during DOM-heavy feeds and
  // avoids rescanning a descendant when its ancestor is in the same batch.
  const pendingShadowNodes = new Set();
  let shadowDiscoveryTimer = null;

  function flushPendingShadowNodes() {
    shadowDiscoveryTimer = null;
    const pending = new Set(pendingShadowNodes);
    pendingShadowNodes.clear();
    const roots = [];
    for (const node of pending) {
      let ancestor =
        node.parentNode || (node.nodeType === 11 && node.host ? node.host : null);
      let covered = false;
      while (ancestor) {
        if (pending.has(ancestor)) {
          covered = true;
          break;
        }
        ancestor =
          ancestor.parentNode ||
          (ancestor.nodeType === 11 && ancestor.host ? ancestor.host : null);
      }
      if (!covered) roots.push(node);
    }
    let discovered = false;
    for (const node of roots) {
      const connected =
        node.nodeType === 11 && node.host ? node.host.isConnected : node.isConnected;
      if (!connected) continue;
      if (wireShadowRootsInSubtree(node)) discovered = true;
    }
    if (discovered) {
      // The scan itself was delayed and batched, so don't add a second
      // 400 ms report delay. Preserve any pending lifecycle details.
      if (timer) clearTimeout(timer);
      timer = null;
      report();
    }
  }

  function queueShadowSubtree(node) {
    if (!node || (node.nodeType !== 1 && node.nodeType !== 11)) return;
    if (node.childElementCount === 0 && !(node.nodeType === 1 && node.shadowRoot)) {
      return;
    }
    pendingShadowNodes.add(node);
    // Throttle, rather than reset, so a continuously mutating page cannot
    // postpone discovery indefinitely.
    if (shadowDiscoveryTimer === null) {
      shadowDiscoveryTimer = setTimeout(flushPendingShadowNodes, 400);
    }
  }

  function observeShadowTree(root) {
    if (!MutationObserverCtor || !root || shadowRootObservers.has(root)) return;
    const observer = new MutationObserverCtor((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          queueShadowSubtree(node);
        }
      }
    });
    observer.observe(root, { childList: true, subtree: true });
    shadowRootObservers.set(root, observer);
  }

  function wireShadowRoot(sr) {
    if (!sr) return;
    if (!shadowRootsWired.has(sr)) {
      shadowRootsWired.add(sr);
      sr.addEventListener("loadstart", onLoadStart, true);
      sr.addEventListener("play", onPlay, true);
      sr.addEventListener("playing", onPlay, true);
      sr.addEventListener("pause", onStopped, true);
      sr.addEventListener("ended", onStopped, true);
      sr.addEventListener("emptied", onEmptied, true);
      sr.addEventListener("loadedmetadata", onLoadedMetadata, true);
    }
    // A previously detached root may be reattached; restore it to shallow
    // scans and reconnect its observer after knownShadowRoots pruned it.
    if (!wiredShadowRoots.includes(sr)) wiredShadowRoots.push(sr);
    observeShadowTree(sr);
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
  // Observe future additions at the document boundary. Shadow-root observers
  // are added by wireShadowRoot, so nested custom players are covered too.
  if (document.documentElement) observeShadowTree(document.documentElement);

  chrome.runtime.onMessage.addListener((msg) => {
    // The worker is ephemeral; its in-memory finds die with it, so it asks
    // tabs to report again after a restart or a tab switch.
    if (msg && msg.type === "grab-rescan") {
      lastSent = "";
      // The worker only rescans after a new playlist path or a worker restart:
      // look for shadow roots that mounted since the last deep walk.
      report(null, null, null, true);
    }
  });

  report(null, null, null, true);
}

// Test hook for node:test.
if (typeof module !== "undefined" && module.exports) {
  module.exports = { collectVideos, usableVideoSrc, MIN_VIDEO_PX, pageVideoTitle, isActiveVideo };
}
