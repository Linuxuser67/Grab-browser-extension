// Grab browser extension: per-tab video state and its persistence.
// Loaded by background.js (Chrome importScripts) or listed before it
// in manifest.firefox.json; all files share one global scope.

// Per-tab detections. DOM reports and network observations are retained per
// frame: a manifest fetched by an iframe must not be paired with another frame.
const MAX_VIDEO_FRAMES = 32;
const MAX_VIDEO_TITLE_LENGTH = 512;
const MAX_MANIFESTS_PER_FRAME = 20;
const MAX_MEDIA_SNIFFS_PER_FRAME = 8;
const ADAPTIVE_QUERY_VARIANT_WINDOW_MS = 30_000;
const ADAPTIVE_QUERY_VARIANT_LIMIT = 3;
const ADAPTIVE_QUERY_PARAMETER_LIMIT = 16;
const MIN_WHOLE_VIDEO_MEDIA_BYTES = 1024 * 1024;
const RETIRED_FRAME_TTL_MS = 5 * 60 * 1000;
const videoFinds = new Map();

function boundedVideoTitle(value) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, MAX_VIDEO_TITLE_LENGTH);
}

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
    sniffFirstSeenByFrame: new Map(),
    rotatingQueryParamsByFrame: new Map(),
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
  for (const id of f.sniffFirstSeenByFrame.keys()) ids.add(id);
  for (const id of f.rotatingQueryParamsByFrame.keys()) ids.add(id);
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
  f.sniffFirstSeenByFrame.delete(frameId);
  f.rotatingQueryParamsByFrame.delete(frameId);
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

function removeFrameSniffsAtOrBefore(finds, frameId, sequence, preserveKeys = new Set()) {
  pruneExpiredAdaptiveQueryMarkers(finds, frameId);
  const cutoff = Number.isSafeInteger(sequence) && sequence >= 0 ? sequence : 0;
  const sequences = sniffSequenceMapForFrame(finds, frameId);
  const times = sniffTimeMapForFrame(finds, frameId);
  const firstSeen = finds.sniffFirstSeenByFrame instanceof Map
    ? finds.sniffFirstSeenByFrame.get(frameId)
    : null;
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
      const key = videoUrlIdentityKey(url, finds, frameId);
      const observedSequence = sequences && sequences.get(key);
      if (
        (Number.isSafeInteger(observedSequence) && observedSequence > cutoff) ||
        preserveKeys.has(key)
      ) {
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
      if (firstSeen) firstSeen.delete(key);
    }
    if (sequences.size === 0) finds.sniffSequencesByFrame.delete(frameId);
  }
  if (times && times.size === 0) finds.sniffTimesByFrame.delete(frameId);
  if (firstSeen && firstSeen.size === 0) finds.sniffFirstSeenByFrame.delete(frameId);
  const kinds = finds.kindsByFrame.get(frameId);
  if (kinds) {
    for (const key of removedKeys) {
      const stillPresent =
        (finds.sniffedByFrame.get(frameId) || []).some((url) => videoUrlIdentityKey(url, finds, frameId) === key) ||
        (finds.mediaByFrame.get(frameId) || []).some((url) => videoUrlIdentityKey(url, finds, frameId) === key);
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
  return urls.some((url) => (sequences.get(videoUrlIdentityKey(url, finds, frameId)) || 0) > sequence);
}

function pruneExpiredRetiredFrames(finds, now = Date.now()) {
  if (!(finds.retiredFrames instanceof Map)) return false;
  let changed = false;
  for (const retired of finds.retiredFrames.values()) {
    if (
      !retired ||
      !Number.isFinite(retired.retiredAt) ||
      retired.retiredAt > now + 60_000 ||
      now - retired.retiredAt < RETIRED_FRAME_TTL_MS ||
      retired.expired === true
    ) continue;
    // Expiry hides retired content but retains its source identity and network
    // evidence. A late report must be able to prove that the same blob resumed.
    retired.expired = true;
    changed = true;
  }
  return changed;
}

function recordRetiredFrame(
  finds,
  frameId,
  source,
  previousVideos,
  lifecycleAt = Date.now(),
) {
  if (!(finds.retiredFrames instanceof Map)) finds.retiredFrames = new Map();
  const validSource = validLifecycleSource(source);
  const normalizedPreviousVideos = normalizeVideoReport(previousVideos, MAX_VIDEO_ITEMS);
  const existing = finds.retiredFrames.get(frameId);
  if (existing) {
    existing.source = existing.source || validSource;
    existing.videoCount = Math.max(
      Number.isInteger(existing.videoCount) ? existing.videoCount : 0,
      normalizedPreviousVideos.length,
    );
    if (!Array.isArray(existing.previousVideos) || existing.previousVideos.length === 0) {
      existing.previousVideos = normalizedPreviousVideos;
    }
    return false;
  }
  const eventTime = validLifecycleTime(lifecycleAt);
  finds.retiredFrames.set(frameId, {
    source: validSource,
    retiredAtSeq: retiredSequenceAt(finds, frameId, eventTime),
    retiredAt: Date.now(),
    videoCount: normalizedPreviousVideos.length,
    previousVideos: normalizedPreviousVideos,
    expired: false,
  });
  return true;
}

function videoResourceIdentity(video) {
  if (!video || typeof video !== "object") return null;
  if (video.blob === true) return validBlobUrl(video.blobUrl);
  if (typeof video.src === "string" && fitsGrabUrl(video.src)) return videoUrlIdentityKey(video.src);
  return null;
}

function preservedSniffsForOtherPlayers(finds, frameId, retired, currentVideos) {
  pruneExpiredAdaptiveQueryMarkers(finds, frameId);
  const previousVideos = Array.isArray(retired.previousVideos) ? retired.previousVideos : [];
  if (previousVideos.length < 2 || !Array.isArray(currentVideos)) return new Set();

  // Preserve a previous element only when its stable element id and resource
  // identity both survive in the new report.
  const retained = previousVideos.filter((previous) => {
    if (!Number.isSafeInteger(previous.elementId)) return false;
    const identity = videoResourceIdentity(previous);
    return identity !== null && currentVideos.some((current) =>
      current &&
      current.elementId === previous.elementId &&
      videoResourceIdentity(current) === identity
    );
  });
  if (retained.length === 0) return new Set();

  const manifests = sniffedManifestsForFrame(finds, frameId);
  const sniffTimes = sniffTimesForFrame(finds, frameId);
  const firstSeenTimes = sniffFirstSeenTimesForFrame(finds, frameId);
  const preserve = new Set();
  for (const url of manifests) {
    const owners = previousVideos.filter((video) =>
      attributedManifestUrlsForVideo(
        previousVideos,
        video,
        [url],
        sniffTimes,
        firstSeenTimes,
        finds,
        frameId,
      ).length === 1
    );
    if (owners.length === 1 && retained.includes(owners[0])) {
      preserve.add(videoUrlIdentityKey(url, finds, frameId));
    }
  }
  return preserve;
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
  const previousVideos = Array.isArray(retired.previousVideos)
    ? retired.previousVideos
    : [];
  const multiplePlayers =
    videos.length > 1 ||
    previousVideos.length > 1 ||
    (Number.isInteger(retired.videoCount) && retired.videoCount > 1);
  const hasNewManifest = hasManifestSniffedAfter(
    finds,
    frameId,
    retired.retiredAtSeq,
  );

  const expired = retired.expired === true || (
    Number.isFinite(retired.retiredAt) &&
    retired.retiredAt <= Date.now() + 60_000 &&
    Date.now() - retired.retiredAt >= RETIRED_FRAME_TTL_MS
  );
  // Same-blob resume retains its observations even after the normal grace
  // period. For a different source, preserve only manifests still uniquely
  // attributed to unchanged elements from the previous multi-player report.
  if (!sameBlobResumed && (expired || hasNewManifest || multiplePlayers)) {
    const preserveKeys = multiplePlayers
      ? preservedSniffsForOtherPlayers(finds, frameId, retired, videos)
      : new Set();
    removeFrameSniffsAtOrBefore(
      finds,
      frameId,
      retired.retiredAtSeq,
      preserveKeys,
    );
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
    const title = boundedVideoTitle(video.title);
    if (title) item.title = title;
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

function snapshotVideoFindsV2(finds) {
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
      const title = boundedVideoTitle(video.title);
      if (title) saved.title = title;
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
      const key = videoUrlIdentityKey(url, finds, frameId);
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
        !wholeUrls.some((url) => videoUrlIdentityKey(url, finds, frameId) === key)
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

  const sniffFirstSeen = [];
  for (const [frameId, times] of finds.sniffFirstSeenByFrame || []) {
    if (sniffFirstSeen.length >= MAX_VIDEO_FRAMES) break;
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
    if (out.length) sniffFirstSeen.push([frameId, out]);
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
      previousVideos: normalizeVideoReport(retired.previousVideos, MAX_VIDEO_ITEMS),
      expired: retired.expired === true,
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
    sniffFirstSeen,
    sniffSequence: Number.isSafeInteger(finds.sniffSequence) && finds.sniffSequence >= 0
      ? finds.sniffSequence
      : 0,
    retiredFrames,
    title: typeof finds.title === "string" ? finds.title.slice(0, MAX_VIDEO_TITLE_LENGTH) : "",
  };
}


/// Maximum serialized session snapshot size per tab. This is deliberately
/// far below Chrome's current session-storage quota so one page cannot crowd
/// out unrelated session state.
const MAX_VIDEO_STATE_SNAPSHOT_BYTES = 256 * 1024;

/// Compact all sniff-related maps into a single URL-keyed observation tuple:
/// [url, flags, kind, sequence, observedAt, firstSeenAt, wholeMediaSize].
/// flags: 1 = manifest sniff, 2 = media sniff, 4 = whole-file media candidate.
function compactVideoObservations(snapshot, finds) {
  const byFrame = new Map();
  const ensure = (frameId, url) => {
    if (!Number.isInteger(frameId) || frameId < 0 ||
        typeof url !== "string" || !fitsGrabUrl(url)) return null;
    let records = byFrame.get(frameId);
    if (!records) byFrame.set(frameId, records = new Map());
    const key = videoUrlIdentityKey(url, finds, frameId);
    let record = records.get(key);
    if (!record) {
      record = [url, 0, null, null, null, null, null];
      records.set(key, record);
    } else {
      // Keep the most recently observed auth-token variant without changing
      // the stable resource identity or duplicating the URL in metadata maps.
      record[0] = url;
    }
    return record;
  };
  const mark = (pairs, flag) => {
    for (const [frameId, urls] of pairs) {
      for (const url of urls) {
        const record = ensure(frameId, url);
        if (record) record[1] |= flag;
      }
    }
  };
  mark(snapshot.sniffedFrames, 1);
  mark(snapshot.mediaFrames, 2);
  mark(snapshot.wholeMediaFrames, 4);

  const find = (frameId, key) => {
    const records = byFrame.get(frameId);
    if (!records) return null;
    const direct = records.get(key);
    if (direct) return direct;
    // Path-only keys can exist in older in-memory state after an upgrade.
    for (const record of records.values()) {
      if (urlPathKey(record[0]) === key) return record;
    }
    return null;
  };
  const attach = (pairs, index, valid) => {
    for (const [frameId, entries] of pairs) {
      for (const [key, value] of entries) {
        const record = find(frameId, key);
        if (record && valid(value, record)) record[index] = value;
      }
    }
  };
  attach(snapshot.kindsFrames, 2, (value) =>
    value === "manifest" || value === "media");
  attach(snapshot.sniffSequences, 3, (value) =>
    Number.isSafeInteger(value) && value >= 0);
  attach(snapshot.sniffTimes, 4, (value) =>
    Number.isFinite(value) && value >= 0);
  attach(snapshot.sniffFirstSeen, 5, (value) =>
    Number.isFinite(value) && value >= 0);
  attach(snapshot.mediaSizesFrames, 6, (value, record) =>
    (record[1] & 4) !== 0 &&
    Number.isSafeInteger(value) &&
    value >= MIN_WHOLE_VIDEO_MEDIA_BYTES);

  const observations = [];
  for (const [frameId, records] of byFrame) {
    const out = [...records.values()].filter((record) => record[1] !== 0);
    if (out.length) observations.push([frameId, out]);
  }
  return observations;
}

function videoStateSnapshotByteLength(snapshot) {
  return new TextEncoder().encode(JSON.stringify(snapshot)).byteLength;
}

/// Remove old, page-controlled records until the complete serialized object
/// fits the per-tab budget. Preserve the top frame and retirement markers as
/// long as possible; old child-frame observations go first.
function fitVideoStateSnapshot(snapshot) {
  let size = videoStateSnapshotByteLength(snapshot);
  if (size > MAX_VIDEO_STATE_SNAPSHOT_BYTES && snapshot.rotatingQueryParams.length > 0) {
    snapshot.rotatingQueryParams = [];
    size = videoStateSnapshotByteLength(snapshot);
  }
  const overageFraction = () => Math.max(
    1,
    Math.ceil(Math.max(1, size - MAX_VIDEO_STATE_SNAPSHOT_BYTES) /
      Math.max(1, size) * 100),
  ) / 100;

  while (size > MAX_VIDEO_STATE_SNAPSHOT_BYTES) {
    const candidates = [];
    for (const [frameId, records] of snapshot.observations) {
      for (const record of records) {
        candidates.push({
          frameId,
          record,
          observedAt: Number.isFinite(record[5]) ? record[5]
            : Number.isFinite(record[4]) ? record[4]
            : Number.isSafeInteger(record[3]) ? record[3] : 0,
        });
      }
    }
    if (candidates.length === 0) break;
    candidates.sort((a, b) =>
      Number(a.frameId === 0) - Number(b.frameId === 0) ||
      a.observedAt - b.observedAt);
    const count = Math.max(1, Math.ceil(candidates.length * Math.min(0.5, overageFraction())));
    const removed = new Set(candidates.slice(0, count).map((entry) => entry.record));
    snapshot.observations = snapshot.observations
      .map(([frameId, records]) => [frameId, records.filter((record) => !removed.has(record))])
      .filter(([, records]) => records.length > 0);
    size = videoStateSnapshotByteLength(snapshot);
  }

  while (size > MAX_VIDEO_STATE_SNAPSHOT_BYTES) {
    const candidates = [];
    for (const [frameId, retired] of snapshot.retiredFrames) {
      for (let index = 0; index < retired.previousVideos.length; index += 1) {
        const video = retired.previousVideos[index];
        candidates.push({
          frameId,
          retired,
          index,
          observedAt: Number.isFinite(video.loadStartedAt) ? video.loadStartedAt : 0,
        });
      }
    }
    if (candidates.length === 0) break;
    candidates.sort((a, b) =>
      Number(a.frameId === 0) - Number(b.frameId === 0) ||
      a.observedAt - b.observedAt);
    const count = Math.max(1, Math.ceil(candidates.length * Math.min(0.5, overageFraction())));
    const removed = new Map();
    for (const item of candidates.slice(0, count)) {
      let indexes = removed.get(item.retired);
      if (!indexes) removed.set(item.retired, indexes = new Set());
      indexes.add(item.index);
    }
    for (const [retired, indexes] of removed) {
      retired.previousVideos = retired.previousVideos.filter((_, index) => !indexes.has(index));
    }
    size = videoStateSnapshotByteLength(snapshot);
  }

  while (size > MAX_VIDEO_STATE_SNAPSHOT_BYTES) {
    const candidates = [];
    for (const [frameId, videos] of snapshot.frames) {
      for (let index = 0; index < videos.length; index += 1) {
        const video = videos[index];
        candidates.push({
          frameId,
          index,
          observedAt: Number.isFinite(video.loadStartedAt) ? video.loadStartedAt : 0,
        });
      }
    }
    if (candidates.length === 0) break;
    candidates.sort((a, b) =>
      Number(a.frameId === 0) - Number(b.frameId === 0) ||
      a.observedAt - b.observedAt);
    const count = Math.max(1, Math.ceil(candidates.length * Math.min(0.5, overageFraction())));
    const removed = new Map();
    for (const item of candidates.slice(0, count)) {
      let indexes = removed.get(item.frameId);
      if (!indexes) removed.set(item.frameId, indexes = new Set());
      indexes.add(item.index);
    }
    snapshot.frames = snapshot.frames
      .map(([frameId, videos]) => [
        frameId,
        videos.filter((_, index) => !(removed.get(frameId) || new Set()).has(index)),
      ])
      .filter(([, videos]) => videos.length > 0);
    size = videoStateSnapshotByteLength(snapshot);
  }

  if (size > MAX_VIDEO_STATE_SNAPSHOT_BYTES) {
    snapshot.retiredFrames = snapshot.retiredFrames.map(([frameId, retired]) => [
      frameId,
      { ...retired, previousVideos: [] },
    ]);
    size = videoStateSnapshotByteLength(snapshot);
  }
  if (size > MAX_VIDEO_STATE_SNAPSHOT_BYTES) {
    snapshot.retiredFrames = [];
    snapshot.frames = [];
    snapshot.observations = [];
    snapshot.title = "";
  }
  return snapshot;
}

function snapshotRotatingQueryParams(finds) {
  const entries = [];
  const now = Date.now();
  for (const [frameId, paths] of finds.rotatingQueryParamsByFrame || []) {
    if (entries.length >= MAX_VIDEO_FRAMES) break;
    const pathEntries = [];
    for (const [pathKey, parameters] of paths || []) {
      if (pathEntries.length >= MAX_MANIFESTS_PER_FRAME) break;
      if (
        typeof pathKey !== "string" ||
        pathKey.length > MAX_GRAB_URL_BYTES ||
        !(parameters instanceof Map)
      ) continue;
      const active = [];
      for (const [name, expiresAt] of parameters) {
        if (
          typeof name === "string" &&
          name.length > 0 &&
          name.length <= 128 &&
          Number.isFinite(expiresAt) &&
          expiresAt > now
        ) active.push([name, expiresAt]);
      }
      if (active.length) {
        pathEntries.push([pathKey, active.slice(0, ADAPTIVE_QUERY_PARAMETER_LIMIT)]);
      }
    }
    if (pathEntries.length) entries.push([frameId, pathEntries]);
  }
  return entries;
}

function restoreRotatingQueryParams(entries) {
  const restored = new Map();
  const now = Date.now();
  for (const pair of Array.isArray(entries) ? entries : []) {
    if (
      !Array.isArray(pair) ||
      pair.length !== 2 ||
      !Number.isInteger(pair[0]) ||
      pair[0] < 0 ||
      restored.size >= MAX_VIDEO_FRAMES ||
      !Array.isArray(pair[1])
    ) continue;
    const paths = new Map();
    for (const pathEntry of pair[1].slice(0, MAX_MANIFESTS_PER_FRAME)) {
      if (
        !Array.isArray(pathEntry) ||
        pathEntry.length !== 2 ||
        typeof pathEntry[0] !== "string" ||
        !Array.isArray(pathEntry[1])
      ) continue;
      let parsed;
      try {
        parsed = new URL(pathEntry[0]);
      } catch {
        continue;
      }
      const pathKey = parsed.origin + parsed.pathname;
      if (
        (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
        parsed.search ||
        parsed.hash ||
        parsed.username ||
        parsed.password ||
        pathKey !== pathEntry[0]
      ) continue;
      const parameters = new Map();
      for (const entry of pathEntry[1].slice(0, ADAPTIVE_QUERY_PARAMETER_LIMIT)) {
        if (!Array.isArray(entry) || entry.length !== 2) continue;
        const [name, expiresAt] = entry;
        if (
          typeof name !== "string" ||
          name.length === 0 ||
          name.length > 128 ||
          !Number.isFinite(expiresAt) ||
          expiresAt <= now ||
          expiresAt > now + ADAPTIVE_QUERY_VARIANT_WINDOW_MS * 2
        ) continue;
        parameters.set(name, expiresAt);
      }
      if (parameters.size) paths.set(pathKey, parameters);
    }
    if (paths.size) restored.set(pair[0], paths);
  }
  return restored;
}

function snapshotVideoFinds(finds) {
  for (const frameId of trackedFrameIds(finds)) {
    pruneExpiredAdaptiveQueryMarkers(finds, frameId);
  }
  const legacy = snapshotVideoFindsV2(finds);
  const snapshot = {
    version: 3,
    frames: legacy.frames,
    observations: compactVideoObservations(legacy, finds),
    sniffSequence: legacy.sniffSequence,
    retiredFrames: legacy.retiredFrames,
    rotatingQueryParams: snapshotRotatingQueryParams(finds),
    title: legacy.title,
  };
  return fitVideoStateSnapshot(snapshot);
}

/// Expand and validate v3 observations into the v2 in-memory representation.
/// The existing restore pipeline then applies its established per-frame,
/// per-item, URL and metadata validation before publishing state.
function expandCompactVideoSnapshot(saved) {
  const expanded = {
    ...saved,
    version: 2,
    rotatingQueryParamsByFrame: restoreRotatingQueryParams(saved.rotatingQueryParams),
    sniffedFrames: [],
    mediaFrames: [],
    wholeMediaFrames: [],
    mediaSizesFrames: [],
    kindsFrames: [],
    sniffSequences: [],
    sniffTimes: [],
    sniffFirstSeen: [],
  };
  const sniffed = new Map();
  const media = new Map();
  const whole = new Map();
  const sizes = new Map();
  const kinds = new Map();
  const sequences = new Map();
  const times = new Map();
  const firstSeen = new Map();
  const seenFrames = new Set();
  let remainingSniffed = MAX_VIDEO_ITEMS;
  let remainingMedia = MAX_VIDEO_FRAMES * MAX_MEDIA_SNIFFS_PER_FRAME;
  let remainingWhole = MAX_VIDEO_FRAMES * MAX_MEDIA_SNIFFS_PER_FRAME;
  let remainingKinds = 200;
  const setFrame = (map, frameId) => {
    let value = map.get(frameId);
    if (!value) map.set(frameId, value = []);
    return value;
  };

  for (const pair of Array.isArray(saved.observations) ? saved.observations : []) {
    if (
      !Array.isArray(pair) || pair.length !== 2 ||
      !Number.isInteger(pair[0]) || pair[0] < 0 ||
      !Array.isArray(pair[1]) || seenFrames.has(pair[0]) ||
      seenFrames.size >= MAX_VIDEO_FRAMES
    ) continue;
    const frameId = pair[0];
    seenFrames.add(frameId);
    let frameSniffed = 0;
    let frameMedia = 0;
    let frameWhole = 0;
    const seenUrls = new Set();

    for (const entry of pair[1].slice(0, MAX_MANIFESTS_PER_FRAME + MAX_MEDIA_SNIFFS_PER_FRAME)) {
      if (
        !Array.isArray(entry) || entry.length !== 7 ||
        typeof entry[0] !== "string" || !fitsGrabUrl(entry[0]) ||
        !Number.isInteger(entry[1]) || entry[1] <= 0 || entry[1] > 7
      ) continue;
      const [url, flags, kind, sequence, observedAt, firstSeenAt, size] = entry;
      const key = videoUrlIdentityKey(url, expanded, frameId);
      if (seenUrls.has(key)) continue;
      seenUrls.add(key);

      if (flags & 1) {
        if (remainingSniffed > 0 && frameSniffed < MAX_MANIFESTS_PER_FRAME) {
          setFrame(sniffed, frameId).push(url);
          remainingSniffed -= 1;
          frameSniffed += 1;
        }
      }
      if (flags & 2) {
        if (remainingMedia > 0 && frameMedia < MAX_MEDIA_SNIFFS_PER_FRAME) {
          setFrame(media, frameId).push(url);
          remainingMedia -= 1;
          frameMedia += 1;
        }
      }
      if (flags & 4) {
        if (
          (flags & 2) !== 0 && remainingWhole > 0 &&
          frameWhole < MAX_MEDIA_SNIFFS_PER_FRAME &&
          classifyStream(url, "") === "media" &&
          !isSegmentLikeVideoUrl(url) &&
          Number.isSafeInteger(size) && size >= MIN_WHOLE_VIDEO_MEDIA_BYTES
        ) {
          setFrame(whole, frameId).push(url);
          let frameSizes = sizes.get(frameId);
          if (!frameSizes) sizes.set(frameId, frameSizes = []);
          frameSizes.push([key, size]);
          remainingWhole -= 1;
          frameWhole += 1;
        }
      }
      if (kind === "manifest" || kind === "media") {
        if (remainingKinds > 0) {
          let frameKinds = kinds.get(frameId);
          if (!frameKinds) kinds.set(frameId, frameKinds = []);
          frameKinds.push([key, kind]);
          remainingKinds -= 1;
        }
      }
      if (Number.isSafeInteger(sequence) && sequence >= 0) {
        let frameSequences = sequences.get(frameId);
        if (!frameSequences) sequences.set(frameId, frameSequences = []);
        frameSequences.push([key, sequence]);
        expanded.sniffSequence = Math.max(expanded.sniffSequence || 0, sequence);
      }
      if (Number.isFinite(observedAt) && observedAt >= 0) {
        let frameTimes = times.get(frameId);
        if (!frameTimes) times.set(frameId, frameTimes = []);
        frameTimes.push([key, observedAt]);
      }
      if (Number.isFinite(firstSeenAt) && firstSeenAt >= 0) {
        let frameFirstSeen = firstSeen.get(frameId);
        if (!frameFirstSeen) firstSeen.set(frameId, frameFirstSeen = []);
        frameFirstSeen.push([key, firstSeenAt]);
      }
    }
  }

  const toPairs = (map) => [...map].map(([frameId, entries]) => [frameId, entries]);
  expanded.sniffedFrames = toPairs(sniffed);
  expanded.mediaFrames = toPairs(media);
  expanded.wholeMediaFrames = toPairs(whole);
  expanded.mediaSizesFrames = toPairs(sizes);
  expanded.kindsFrames = toPairs(kinds);
  expanded.sniffSequences = toPairs(sequences);
  expanded.sniffTimes = toPairs(times);
  expanded.sniffFirstSeen = toPairs(firstSeen);
  return expanded;
}

/// Restores one snapshot list of [frameId, payload] pairs into a Map,
/// skipping malformed or duplicate frames and stopping at the frame budget.
/// `parse` returns the value to store, or null to drop the frame.
function restoreFrameMap(saved, key, parse) {
  const out = new Map();
  for (const pair of Array.isArray(saved[key]) ? saved[key] : []) {
    if (out.size >= MAX_VIDEO_FRAMES) break;
    if (
      !Array.isArray(pair) ||
      pair.length !== 2 ||
      !Number.isInteger(pair[0]) ||
      pair[0] < 0 ||
      !Array.isArray(pair[1]) ||
      out.has(pair[0])
    ) continue;
    const value = parse(pair[0], pair[1]);
    if (value !== null) out.set(pair[0], value);
  }
  return out;
}

/// Restores a stored URL list, keeping valid unique paths up to `limit`.
function restoreUrls(candidates, limit, accept = () => true, finds = null, frameId = null) {
  const urls = [];
  const seen = new Set();
  for (const url of candidates) {
    if (urls.length >= limit) break;
    if (typeof url !== "string" || !fitsGrabUrl(url) || !accept(url)) continue;
    const identity = videoUrlIdentityKey(url, finds, frameId);
    if (seen.has(identity)) continue;
    seen.add(identity);
    urls.push(url);
  }
  return urls;
}

/// Restores [urlPathKey, value] entries into a Map, keeping up to `limit`
/// entries whose value passes `valid`.
function restoreKeyedValues(candidates, limit, valid) {
  const out = new Map();
  for (const entry of candidates) {
    if (out.size >= limit) break;
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      typeof entry[0] !== "string" ||
      entry[0].length > MAX_GRAB_URL_BYTES ||
      !valid(entry[1], entry[0])
    ) continue;
    out.set(entry[0], entry[1]);
  }
  return out;
}

function rekeyRestoredVideoMetadata(map, urlsForFrame, finds) {
  if (!(map instanceof Map)) return;
  for (const [frameId, values] of map) {
    if (!(values instanceof Map)) continue;
    const urls = urlsForFrame(frameId);
    const migrated = new Map();
    for (const [key, value] of values) {
      const url = urls.find((candidate) =>
        urlPathKey(candidate) === key || videoUrlIdentityKey(candidate, finds, frameId) === key);
      migrated.set(url ? videoUrlIdentityKey(url, finds, frameId) : key, value);
    }
    map.set(frameId, migrated);
  }
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
      const rawSaved = result && result[key];
      const saved = rawSaved && typeof rawSaved === "object" && rawSaved.version === 3
        ? expandCompactVideoSnapshot(rawSaved)
        : rawSaved;
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
            const title = boundedVideoTitle(video.title);
            if (title) item.title = title;
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

        let remainingSniffed = MAX_VIDEO_ITEMS;
        const sniffedByFrame = restoreFrameMap(saved, "sniffedFrames", (frameId, entries) => {
          const urls = restoreUrls(entries.slice(0, MAX_VIDEO_ITEMS), remainingSniffed, undefined, saved, frameId);
          remainingSniffed -= urls.length;
          return urls.length ? urls : null;
        });

        let remainingKinds = 200;
        const kindsByFrame = restoreFrameMap(saved, "kindsFrames", (frameId, entries) => {
          const kinds = restoreKeyedValues(
            entries.slice(0, 200),
            remainingKinds,
            (value) => value === "manifest" || value === "media",
          );
          remainingKinds -= kinds.size;
          return kinds.size ? kinds : null;
        });

        let remainingMedia = MAX_VIDEO_FRAMES * MAX_MEDIA_SNIFFS_PER_FRAME;
        const mediaByFrame = restoreFrameMap(saved, "mediaFrames", (frameId, entries) => {
          const urls = restoreUrls(entries.slice(0, MAX_MEDIA_SNIFFS_PER_FRAME), remainingMedia, undefined, saved, frameId);
          remainingMedia -= urls.length;
          return urls.length ? urls : null;
        });

        let remainingWholeMedia = MAX_VIDEO_FRAMES * MAX_MEDIA_SNIFFS_PER_FRAME;
        const wholeMediaByFrame = restoreFrameMap(saved, "wholeMediaFrames", (frameId, entries) => {
          const available = new Set(mediaByFrame.get(frameId) || []);
          const urls = restoreUrls(
            entries.slice(0, MAX_MEDIA_SNIFFS_PER_FRAME),
            remainingWholeMedia,
            (url) =>
              available.has(url) &&
              classifyStream(url, "") === "media" &&
              !isSegmentLikeVideoUrl(url),
            saved,
            frameId,
          );
          remainingWholeMedia -= urls.length;
          return urls.length ? urls : null;
        });

        const mediaSizesByFrame = restoreFrameMap(saved, "mediaSizesFrames", (frameId, entries) => {
          const wholeKeys = new Set((wholeMediaByFrame.get(frameId) || []).flatMap((url) => [
            urlPathKey(url), videoUrlIdentityKey(url),
          ]));
          const sizes = restoreKeyedValues(
            entries.slice(0, MAX_MEDIA_SNIFFS_PER_FRAME),
            MAX_MEDIA_SNIFFS_PER_FRAME,
            (value, key) =>
              Number.isSafeInteger(value) &&
              value >= MIN_WHOLE_VIDEO_MEDIA_BYTES &&
              wholeKeys.has(key),
          );
          return sizes.size ? sizes : null;
        });

        let sniffSequence =
          Number.isSafeInteger(saved.sniffSequence) && saved.sniffSequence >= 0
            ? saved.sniffSequence
            : 0;
        const sniffSequencesByFrame = restoreFrameMap(saved, "sniffSequences", (frameId, entries) => {
          const sequences = restoreKeyedValues(
            entries.slice(0, MAX_MANIFESTS_PER_FRAME + MAX_MEDIA_SNIFFS_PER_FRAME),
            MAX_MANIFESTS_PER_FRAME + MAX_MEDIA_SNIFFS_PER_FRAME,
            (value) => Number.isSafeInteger(value) && value >= 0,
          );
          for (const value of sequences.values()) {
            sniffSequence = Math.max(sniffSequence, value);
          }
          return sequences.size ? sequences : null;
        });
        // Older v2 snapshots only stored URL arrays. Give those observations
        // stable sequence numbers so subsequent sniffs always compare newer.
        for (const [frameId, urls] of sniffedByFrame) {
          let sequences = sniffSequencesByFrame.get(frameId);
          if (!sequences) {
            sequences = new Map();
            sniffSequencesByFrame.set(frameId, sequences);
          }
          for (const url of urls) {
            const key = videoUrlIdentityKey(url);
            if (!sequences.has(key) && !sequences.has(urlPathKey(url))) {
              sequences.set(key, ++sniffSequence);
            }
          }
        }
        for (const [frameId, urls] of mediaByFrame) {
          let sequences = sniffSequencesByFrame.get(frameId);
          if (!sequences) {
            sequences = new Map();
            sniffSequencesByFrame.set(frameId, sequences);
          }
          for (const url of urls) {
            const key = videoUrlIdentityKey(url);
            if (!sequences.has(key) && !sequences.has(urlPathKey(url))) {
              sequences.set(key, ++sniffSequence);
            }
          }
        }

        const sniffTimesByFrame = restoreFrameMap(saved, "sniffTimes", (frameId, entries) => {
          const times = restoreKeyedValues(
            entries.slice(0, MAX_MANIFESTS_PER_FRAME + MAX_MEDIA_SNIFFS_PER_FRAME),
            MAX_MANIFESTS_PER_FRAME + MAX_MEDIA_SNIFFS_PER_FRAME,
            (value) => Number.isFinite(value) && value >= 0,
          );
          return times.size ? times : null;
        });
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

        const sniffFirstSeenByFrame = restoreFrameMap(saved, "sniffFirstSeen", (frameId, entries) => {
          const available = new Set([
            ...(sniffedByFrame.get(frameId) || []),
            ...(mediaByFrame.get(frameId) || []),
          ].flatMap((url) => [urlPathKey(url), videoUrlIdentityKey(url)]));
          const times = restoreKeyedValues(
            entries.slice(0, MAX_MANIFESTS_PER_FRAME + MAX_MEDIA_SNIFFS_PER_FRAME),
            MAX_MANIFESTS_PER_FRAME + MAX_MEDIA_SNIFFS_PER_FRAME,
            (value, key) => available.has(key) && Number.isFinite(value) && value >= 0,
          );
          return times.size ? times : null;
        });

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
            previousVideos: normalizeVideoReport(pair[1].previousVideos, MAX_VIDEO_ITEMS),
            expired: pair[1].expired === true,
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
            previousVideos: [],
            expired: false,
          });
        }

        const urlsForFrame = (frameId) => [
          ...(sniffedByFrame.get(frameId) || []),
          ...(mediaByFrame.get(frameId) || []),
          ...(wholeMediaByFrame.get(frameId) || []),
        ];
        rekeyRestoredVideoMetadata(kindsByFrame, urlsForFrame, saved);
        rekeyRestoredVideoMetadata(mediaSizesByFrame, urlsForFrame, saved);
        rekeyRestoredVideoMetadata(sniffSequencesByFrame, urlsForFrame, saved);
        rekeyRestoredVideoMetadata(sniffTimesByFrame, urlsForFrame, saved);
        rekeyRestoredVideoMetadata(sniffFirstSeenByFrame, urlsForFrame, saved);

        const restored = {
          frames,
          sniffedByFrame,
          mediaByFrame,
          wholeMediaByFrame,
          mediaSizesByFrame,
          kindsByFrame,
          sniffSequencesByFrame,
          sniffTimesByFrame,
          sniffFirstSeenByFrame,
          rotatingQueryParamsByFrame: saved.rotatingQueryParamsByFrame instanceof Map
            ? saved.rotatingQueryParamsByFrame
            : new Map(),
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
