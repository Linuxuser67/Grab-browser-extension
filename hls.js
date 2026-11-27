// Grab browser extension: HLS playlist inspection and fetch policy.
// Loaded after handoff.js and before video-menu.js; all files share one global scope.

const HLS_INSPECTION_CONTEXT = "grab-inspect-hls\u0000";

/// Paired HLS inspection is read-only and returns only path keys.
const HLS_INSPECT_TIMEOUT_MS = 5_000;
const HLS_INSPECTION_HANDSHAKE_MAX_AGE_MS = 2_000;
const MAX_HLS_INSPECT_RESPONSE_BYTES = 16 * 1024;
const MAX_HLS_INSPECT_CHILDREN = 256;

/// Share Grab's four-request HLS inspection budget across every tab and frame.
/// Page-controlled URLs must not create an unbounded wait queue or consume
/// the server's replay budget faster than its matching token bucket allows.
const HLS_INSPECTION_CONCURRENCY = 4;
const HLS_INSPECTION_QUEUE_LIMIT = 32;
const HLS_INSPECTION_RATE_PER_SECOND = 4;
const HLS_INSPECTION_BURST = 24;
let activeHlsInspections = 0;
const queuedHlsInspections = [];
let hlsInspectionTokens = HLS_INSPECTION_BURST;
let hlsInspectionTokenUpdatedAt = Date.now();

function takeHlsInspectionToken(nowMs = Date.now()) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const elapsedMs = Math.max(0, now - hlsInspectionTokenUpdatedAt);
  hlsInspectionTokens = Math.min(
    HLS_INSPECTION_BURST,
    hlsInspectionTokens + elapsedMs * HLS_INSPECTION_RATE_PER_SECOND / 1000,
  );
  hlsInspectionTokenUpdatedAt = Math.max(hlsInspectionTokenUpdatedAt, now);
  if (hlsInspectionTokens < 1) return false;
  hlsInspectionTokens -= 1;
  return true;
}

async function withHlsInspectionSlot(operation) {
  if (activeHlsInspections < HLS_INSPECTION_CONCURRENCY) {
    activeHlsInspections += 1;
  } else {
    if (queuedHlsInspections.length >= HLS_INSPECTION_QUEUE_LIMIT) return null;
    await new Promise((resolve) => queuedHlsInspections.push(resolve));
  }

  try {
    // Consume only when this request actually owns a slot. A rate-limited
    // request returns null before handshake, HMAC, or network work begins.
    if (!takeHlsInspectionToken()) return null;
    return await operation();
  } finally {
    // Hand the occupied slot directly to the oldest waiter. The active count
    // stays unchanged until the queue is empty, so no fifth request can enter.
    const next = queuedHlsInspections.shift();
    if (next) next();
    else activeHlsInspections -= 1;
  }
}


/// Ask the paired Grab process to inspect a browser-observed public HLS URL.
/// The request contains no cookies or Referer; the response contains no query
/// strings. Null means the inspection was unavailable and callers must keep
/// every candidate rather than guessing which rendition is a child.
/// Prepare one inspector for a batch. It shares a recent listener proof
/// between requests, but refreshes it after queueing has made that proof stale.
/// Verification is deferred until the request owns an inspection slot.
function createHlsInspectionInspectorForBatch() {
  let verifiedSecret = null;
  let verifiedAt = 0;
  let verificationAttempted = false;
  let verificationPromise = null;

  const getFreshVerifiedSecret = async () => {
    const now = Date.now();
    if (
      verificationAttempted &&
      now >= verifiedAt &&
      now - verifiedAt < HLS_INSPECTION_HANDSHAKE_MAX_AGE_MS
    ) return verifiedSecret;

    if (!verificationPromise) {
      verificationPromise = (async () => {
        let secret = null;
        try {
          const candidate = await getPairingCode();
          if (candidate && await verifyGrab(candidate)) secret = candidate;
        } catch {
          // A failed proof leaves the inspection unavailable; never fall back
          // to an unverified loopback POST.
        }
        verifiedSecret = secret;
        verifiedAt = Date.now();
        verificationAttempted = true;
        return secret;
      })();
    }

    const pending = verificationPromise;
    try {
      return await pending;
    } finally {
      if (verificationPromise === pending) verificationPromise = null;
    }
  };

  return (value) => inspectHlsPlaylistWithGrab(value, getFreshVerifiedSecret);
}

/// Ask the paired Grab process to inspect a browser-observed public HLS URL.
/// Standalone calls verify after acquiring a slot. Batch calls share a recent
/// proof and refresh it on-slot when queueing makes it too old.
async function inspectHlsPlaylistWithGrab(value, verifiedSecret = null) {
  if (typeof value !== "string" || new TextEncoder().encode(value).length > 2048) {
    return null;
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    !/\.(?:m3u8|m3u)$/i.test(url.pathname)
  ) return null;

  return withHlsInspectionSlot(async () => {
    // Verify the listener only after acquiring the slot. A batch shares the
    // proof briefly, but renews it if this request waited behind earlier work.
    let secret;
    try {
      if (typeof verifiedSecret === "function") {
        secret = await verifiedSecret();
      } else {
        secret = typeof verifiedSecret === "string" ? verifiedSecret : await getPairingCode();
        if (!secret || !(await verifyGrab(secret))) return null;
      }
    } catch {
      return null;
    }
    if (!secret) return null;

    // Create the timestamp, nonce, signature and deadline only after the
    // slot and a sufficiently recent listener proof are both available.
    const body = JSON.stringify({
      url: value,
      timestamp_ms: Date.now(),
      nonce: bytesToHex(crypto.getRandomValues(new Uint8Array(16))),
    });
    if (new TextEncoder().encode(body).length > 4096) return null;

    let token;
    try {
      token = await hmacHex(secret, HLS_INSPECTION_CONTEXT, body);
    } catch {
      return null;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HLS_INSPECT_TIMEOUT_MS);
    try {
      const response = await fetch(GRAB_BASE_URL + "/inspect-hls", {
        method: "POST",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        redirect: "error",
        headers: {
          "Content-Type": "application/json",
          "X-Grab-Token": token,
        },
        body,
        signal: controller.signal,
      });
      if (!response.ok) return null;
      const text = await response.text();
      if (new TextEncoder().encode(text).length > MAX_HLS_INSPECT_RESPONSE_BYTES) {
        return null;
      }
      const result = JSON.parse(text);
      if (
        !result ||
        typeof result.is_master !== "boolean" ||
        !Array.isArray(result.child_keys) ||
        result.child_keys.length > MAX_HLS_INSPECT_CHILDREN ||
        !result.child_keys.every((key) => {
          if (typeof key !== "string" || new TextEncoder().encode(key).length > 2048) return false;
          try {
            const child = new URL(key);
            return (
              (child.protocol === "http:" || child.protocol === "https:") &&
              !child.username &&
              !child.password &&
              !child.search &&
              !child.hash &&
              child.origin + child.pathname === key
            );
          } catch {
            return false;
          }
        }) ||
        (!result.is_master && result.child_keys.length !== 0)
      ) return null;
      return { is_master: result.is_master, child_keys: result.child_keys };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  });
}


/// Read HLS playlists only to distinguish multivariant masters from media
/// playlists. A failed or unsafe fetch is "unknown": never hide a candidate.
const hlsPlaylistTextCache = new Map();
const HLS_PLAYLIST_TEXT_LIMIT = 256 * 1024;
const HLS_PLAYLIST_FETCH_TIMEOUT_MS = 5000;

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
      isPrivateNetworkHost(origin.hostname) &&
      normalizedHlsHost(origin.hostname) === normalizedHlsHost(url.hostname)
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
      children.add(resolved.origin + resolved.pathname);
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

