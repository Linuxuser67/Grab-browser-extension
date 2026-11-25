// Tests for video detection (content.js + background.js helpers).
// Run with: node --test test/   (Node's built-in runner, no dependencies)
const { test, describe, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const BG_PATH = path.join(__dirname, "..", "background.js");
const SHARED_PATH = path.join(__dirname, "..", "shared.js");
const HANDOFF_PATH = path.join(__dirname, "..", "handoff.js");
const INTERCEPT_PATH = path.join(__dirname, "..", "intercept.js");
const VIDEO_STATE_PATH = path.join(__dirname, "..", "video-state.js");
const VIDEO_PATH = path.join(__dirname, "..", "video-menu.js");
const CONTENT_PATH = path.join(__dirname, "..", "content.js");

// Scripts share one global scope in the browser. Concatenating them into one
// function reproduces that, including the final `module.exports` hook, without
// leaking top-level consts across reloads.
const BG_SOURCE = [
  SHARED_PATH,
  HANDOFF_PATH,
  INTERCEPT_PATH,
  VIDEO_STATE_PATH,
  VIDEO_PATH,
  BG_PATH,
]
  .map((file) => fs.readFileSync(file, "utf8"))
  .join("\n");

// Default fetch mock: manifests read as plain media playlists (not masters),
// so the pre-existing menu tests see unchanged behavior. Tests for master
// detection override this per-test.
globalThis.fetch = async () => ({
  ok: true,
  text: async () => "#EXTM3U\n#EXT-X-TARGETDURATION=6\n",
});

/// Chrome mock extended for video detection: webRequest,
/// tabs.onActivated/onRemoved/onUpdated/sendMessage, runtime.onMessage, action badges.
// (Deliberately no webNavigation: the manifest doesn't request it, so the
// mock must not provide it either — see the permission-mirror test below.)
function makeChrome(shared) {
  shared = shared || {};
  const listeners = {};
  const session = shared.session || (shared.session = new Map());
  const downloads = shared.downloads || (shared.downloads = new Map());
  const syncSettings = shared.syncSettings || (shared.syncSettings = {});
  const localSettings = shared.localSettings || {};
  const alarms = new Map();
  const calls = [];

  const capture = (name) => ({
    addListener: (fn) => {
      listeners[name] = fn;
    },
  });

  const chrome = {
    _listeners: listeners,
    _calls: calls,
    _alarms: alarms,
    _session: session,
    _downloads: downloads,
    downloads: {
      onCreated: capture("downloads.onCreated"),
      onChanged: capture("downloads.onChanged"),
      cancel: async (id) => calls.push(["cancel", id]),
      removeFile: async (id) => calls.push(["removeFile", id]),
      erase: async (q) => calls.push(["erase", q]),
      search: async (q) => {
        const item = downloads.get(q.id);
        return item ? [item] : [];
      },
    },
    tabs: {
      update: (a, b) => calls.push(["tabs.update", b !== undefined ? b : a, b !== undefined ? a : undefined]),
      create: async (props) => {
        calls.push(["tabs.create", props]);
        return { id: 987 };
      },
      remove: async (id) => calls.push(["tabs.remove", id]),
      query: (q, cb) => cb([]),
      get: async (id) => ({ id, url: "https://example.com/" }),
      sendMessage: async (id, msg) => calls.push(["tabs.sendMessage", id, msg]),
      onActivated: capture("tabs.onActivated"),
      onRemoved: capture("tabs.onRemoved"),
      onUpdated: capture("tabs.onUpdated"),
    },
    alarms: {
      create: async (name, info) => {
        alarms.set(name, info);
        calls.push(["alarms.create", name]);
      },
      clear: async (name) => {
        calls.push(["alarms.clear", name]);
        return alarms.delete(name);
      },
      onAlarm: capture("alarms.onAlarm"),
    },
    storage: {
      onChanged: capture("storage.onChanged"),
      local: {
        get: async (defaults) => ({ ...defaults, ...localSettings }),
      },
      sync: {
        get: async (defaults) => ({ ...defaults, ...syncSettings }),
      },
      session: {
        get: async (key) => {
          if (key === null) return Object.fromEntries(session.entries());
          const v = session.get(key);
          return v === undefined ? {} : { [key]: v };
        },
        set: async (obj) => {
          for (const [k, v] of Object.entries(obj)) session.set(k, v);
        },
        remove: async (key) => {
          session.delete(key);
        },
      },
    },
    contextMenus: {
      create: (props) => calls.push(["menus.create", props.id]),
      remove: (id, cb) => { calls.push(["menus.remove", id]); if (typeof cb === "function") cb(); return Promise.resolve(); },
      removeAll: (cb) => { calls.push(["menus.removeAll"]); if (typeof cb === "function") cb(); return Promise.resolve(); },
      onClicked: capture("menus.onClicked"),
    },
    runtime: {
      onInstalled: capture("runtime.onInstalled"),
      onMessage: capture("runtime.onMessage"),
      onStartup: capture("runtime.onStartup"),
      openOptionsPage: async () => calls.push(["runtime.openOptionsPage"]),
    },
    action: {
      onClicked: capture("action.onClicked"),
      setBadgeText: async (args) => calls.push(["action.setBadgeText", args]),
      setBadgeBackgroundColor: async (args) =>
        calls.push(["action.setBadgeBackgroundColor", args]),
      setTitle: async (args) => calls.push(["action.setTitle", args]),
    },
    commands: { onCommand: capture("commands.onCommand") },
    webRequest: {
      onResponseStarted: capture("webRequest.onResponseStarted"),
    },
  };
  return chrome;
}

function loadBackground(chrome) {
  globalThis.chrome = chrome;
  // Mock Grab's HTTP handoff: accept every handoff, record the URL.
  // If the test already set a fetch mock (for playlist content), wrap it
  // so POSTs are handled as handoffs and other requests go to the test's mock.
  const testFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (opts && opts.method === "POST" && opts.body) {
      chrome._calls.push(["handoff", JSON.parse(opts.body).url]);
      return { status: 200, ok: true };
    }
    if (testFetch) return testFetch(url, opts);
    return { status: 404, ok: false, text: async () => "" };
  };
  const worker = { exports: {} };
  // Bind the mock to this worker. Pending async callbacks from earlier tests
  // must not start writing into whichever mock happens to be global later.
  new Function("module", "chrome", BG_SOURCE)(worker, chrome);
  return worker.exports;
}

/// Wrap a GET-only fetch mock to also handle handoff POSTs.
/// Use when a test overrides fetch for playlist content but also clicks menu items.
function withHandoff(chrome, getMock) {
  return async (url, opts) => {
    if (opts && opts.method === "POST" && opts.body) {
      chrome._calls.push(["handoff", JSON.parse(opts.body).url]);
      return { status: 200, ok: true };
    }
    return getMock(url, opts);
  };
}

function loadContent() {
  delete require.cache[require.resolve(CONTENT_PATH)];
  delete globalThis.chrome;
  delete globalThis.document;
  return require(CONTENT_PATH);
}

describe("classifyStream", () => {
  let bg;
  beforeEach(() => {
    bg = loadBackground(makeChrome());
  });

  test("an extension in the query string is not a media file", () => {
    assert.equal(bg.classifyStream("https://example.com/page?file=a.mp4", ""), null);
    assert.equal(bg.classifyStream("https://example.com/watch?u=x.m3u8#t", ""), null);
    assert.equal(bg.classifyStream("https://cdn.example.com/v/clip.mp4?token=1", ""), "media");
    assert.equal(bg.classifyStream("https://cdn.example.com/s/a.m3u8?sig=2#x", ""), "manifest");
  });

  test("a click without a real tab falls back to the active tab", async () => {
    const chrome = makeChrome();
    loadBackground(chrome);
    // Grab down: handoff fails, falls back to tab navigation.
    globalThis.fetch = async () => {
      throw new Error("connection refused");
    };
    const L = chrome._listeners;
    await L["tabs.onActivated"]({ tabId: 5 });
    L["webRequest.onResponseStarted"]({ tabId: 5, url: "https://a.example.com/a.mp4", responseHeaders: [] });
    // Direct-media sniffing remains associated with an observed video; the
    // independent network-only path is reserved for HLS/DASH manifests.
    L["runtime.onMessage"](
      { type: "grab-videos-detected", videos: [{ src: "https://a.example.com/v.mp4", blob: false }] },
      { tab: { id: 5 } }
    );
    await new Promise((r) => setTimeout(r, 30));
    await L["menus.onClicked"]({ menuItemId: "grabVideo:0" }, { id: -1 });
    const call = chrome._calls.find(([n]) => n === "tabs.update");
    assert.ok(call, "navigated");
    assert.equal(call[2], undefined, "no tab id passed for TAB_ID_NONE");
  });

  test("the top frame's title follows the page; a subframe only fills a gap", async () => {
    const chrome = makeChrome();
    const bg2 = loadBackground(chrome);
    const L = chrome._listeners;
    await L["tabs.onActivated"]({ tabId: 5 });
    const report = (frameId, title) =>
      L["runtime.onMessage"](
        { type: "grab-videos-detected", videos: [{ src: "https://a.example.com/v.mp4", blob: false }], title },
        { tab: { id: 5 }, frameId }
      );
    await report(3, "From iframe");
    assert.equal(bg2._videoFinds.get(5).title, "From iframe", "gap filled by a subframe");
    await report(0, "First page title");
    assert.equal(bg2._videoFinds.get(5).title, "First page title", "top frame wins");
    await report(3, "Another iframe");
    assert.equal(bg2._videoFinds.get(5).title, "First page title", "subframe does not override");
    await report(0, "Next video after SPA navigation");
    assert.equal(bg2._videoFinds.get(5).title, "Next video after SPA navigation");
  });

  test("links carrying credentials are not handed off", () => {
    assert.equal(bg.toGrabUrl("https://u:p@example.com/f.zip"), null);
    assert.equal(bg.toGrabUrl("https://u@example.com/f.zip"), null);
    // An @ later in the path or query is not userinfo.
    assert.equal(bg.toGrabUrl("https://example.com/a@b?x=y@z"), "grab://https/example.com/a@b?x=y@z");
  });

  test("manifest extensions classify without a content type", () => {
    assert.equal(bg.classifyStream("https://cdn.example.com/s/manifest.m3u8", ""), "manifest");
    assert.equal(bg.classifyStream("https://cdn.example.com/s/manifest.m3u", ""), "manifest");
    assert.equal(bg.classifyStream("https://cdn.example.com/s/manifest.mpd", ""), "manifest");
  });

  test("manifest content types classify without an extension", () => {
    for (const contentType of [
      "application/vnd.apple.mpegurl",
      "application/x-mpegurl",
      "application/mpegurl",
    ]) {
      assert.equal(
        bg.classifyStream("https://cdn.example.com/s/playlist", contentType),
        "manifest",
        contentType,
      );
    }
    assert.equal(
      bg.classifyStream("https://cdn.example.com/s/playlist", "application/dash+xml"),
      "manifest"
    );
  });

  test("audio-typed HLS responses and non-video thumbnails are ignored", () => {
    assert.equal(
      bg.classifyStream("https://cdn.example.com/audio/playlist.m3u8", "audio/x-mpegurl"),
      null,
    );
    assert.equal(
      bg.classifyStream("https://cdn.example.com/audio/playlist", "audio/mpegurl"),
      null,
    );
    for (const mime of ["audio/x-mpegurl", "audio/mpegurl"]) {
      assert.equal(
        bg.classifyStream("https://cdn.example.com/hls/playlist.m3u8", mime),
        "manifest",
        mime,
      );
      assert.equal(
        bg.classifyStream("https://cdn.example.com/hls/playlist", mime),
        "manifest",
        mime,
      );
    }
    assert.equal(
      bg.classifyStream("https://cdn.example.com/audio-only/master.m3u8", "application/vnd.apple.mpegurl"),
      null,
    );
    assert.equal(
      bg.classifyStream("https://cdn.example.com/hls/audio-track-1.m3u8", "application/vnd.apple.mpegurl"),
      null,
    );
    for (const url of [
      "https://cdn.example.com/subtitles/captions.vtt",
      "https://cdn.example.com/thumbnails/storyboard.jpg",
      "https://cdn.example.com/thumbnails/poster.webp",
    ]) assert.equal(bg.classifyStream(url, ""), null, url);
  });

  test("direct video extensions classify as media", () => {
    for (const ext of ["mp4", "m4v", "webm", "ogv", "mov", "mkv"]) {
      assert.equal(bg.classifyStream(`https://cdn.example.com/v/clip.${ext}`, ""), "media", ext);
    }
  });

  test("MP4 URLs with an audio content type are not classified as video", () => {
    assert.equal(
      bg.classifyStream("https://cdn.example.com/video-42/audio.mp4", "audio/mp4"),
      null
    );
  });

  test("extension matching is case-insensitive and ignores query strings", () => {
    assert.equal(bg.classifyStream("https://cdn.example.com/v/CLIP.MP4?token=abc", ""), "media");
  });

  test("segments, audio, images and junk classify as null", () => {
    assert.equal(bg.classifyStream("https://cdn.example.com/s/seg1.ts", "video/mp2t"), null);
    assert.equal(bg.classifyStream("https://cdn.example.com/s/seg1.m4s", "video/mp4"), null);
    assert.equal(bg.classifyStream("https://cdn.example.com/a/song.mp3", "audio/mpeg"), null);
    assert.equal(bg.classifyStream("https://cdn.example.com/i/pic.png", "image/png"), null);
    assert.equal(bg.classifyStream("https://cdn.example.com/page", "text/html"), null);
  });

  test("a generic audio directory does not hide an HLS manifest", () => {
    assert.equal(
      bg.classifyStream(
        "https://cdn.example.com/audio/master.m3u8",
        "application/vnd.apple.mpegurl",
      ),
      "manifest",
    );
  });

  test("extensionless video content types are not guessed (DASH segments look like this)", () => {
    assert.equal(bg.classifyStream("https://cdn.example.com/s/seg", "video/mp4"), null);
  });

  test("garbage URLs classify as null", () => {
    assert.equal(bg.classifyStream("not a url", ""), null);
    assert.equal(bg.classifyStream("", ""), null);
  });
});

describe("mergeVideoFinds", () => {
  let bg;
  beforeEach(() => {
    bg = loadBackground(makeChrome());
  });

  test("direct sources come first, then sniffed manifests, deduped", () => {
    const merged = bg.mergeVideoFinds(
      [{ src: "https://a.example/1.mp4", blob: false }],
      ["https://a.example/1.mp4", "https://a.example/s.m3u8"]
    );
    assert.deepEqual(merged, ["https://a.example/1.mp4", "https://a.example/s.m3u8"]);
  });

  test("blob-only videos fall back to the sniffed manifests", () => {
    const merged = bg.mergeVideoFinds(
      [{ src: null, blob: true }],
      ["https://a.example/s.m3u8"]
    );
    assert.deepEqual(merged, ["https://a.example/s.m3u8"]);
  });

  test("HLS, DASH, and direct renditions produce one entry for a stream", () => {
    const merged = bg.mergeVideoFinds(
      [{ src: "https://cdn.example.com/clip-abc/DASH_720.mp4?source=fallback", blob: false }],
      [
        "https://cdn.example.com/clip-abc/DASH_360.mp4",
        "https://cdn.example.com/clip-abc/DASHPlaylist.mpd",
        "https://cdn.example.com/clip-abc/HLSPlaylist.m3u8",
      ]
    );
    assert.deepEqual(merged, ["https://cdn.example.com/clip-abc/HLSPlaylist.m3u8"]);
  });

  test("separate stream directories remain separate entries", () => {
    const merged = bg.mergeVideoFinds([], [
      "https://cdn.example.com/clip-a/DASHPlaylist.mpd",
      "https://cdn.example.com/clip-b/HLSPlaylist.m3u8",
      "https://cdn.example.com/clip-a/DASH_1080.mp4",
      "https://cdn.example.com/clip-b/DASH_720.mp4",
    ]);
    assert.deepEqual(merged, [
      "https://cdn.example.com/clip-a/DASHPlaylist.mpd",
      "https://cdn.example.com/clip-b/HLSPlaylist.m3u8",
    ]);
  });

  test("sibling HLS, DASH, and direct renditions collapse by stream folder", () => {
    const merged = bg.mergeVideoFinds(
      [{ src: "https://cdn.example.com/video-42/720p.mp4", blob: false }],
      [
        "https://cdn.example.com/video-42/manifest.mpd",
        "https://cdn.example.com/video-42/master.m3u8",
        "https://cdn.example.com/video-42/480p.mp4",
        "https://cdn.example.com/video-43/master.m3u8",
      ]
    );
    assert.deepEqual(merged, [
      "https://cdn.example.com/video-42/master.m3u8",
      "https://cdn.example.com/video-43/master.m3u8",
    ]);
  });

  test("distinct same-protocol manifests in one directory stay separate entries", () => {
    const merged = bg.mergeVideoFinds([], [
      "https://cdn.example.com/v/a/master.m3u8",
      "https://cdn.example.com/v/a/index.m3u8",
    ]);
    assert.deepEqual(merged, [
      "https://cdn.example.com/v/a/master.m3u8",
      "https://cdn.example.com/v/a/index.m3u8",
    ]);
  });

  test("non-auth query parameters distinguish manifests", () => {
    const merged = bg.mergeVideoFinds([], [
      "https://site.example/hls/playlist.m3u8?id=alpha",
      "https://site.example/hls/playlist.m3u8?id=beta",
    ]);
    assert.deepEqual(merged, [
      "https://site.example/hls/playlist.m3u8?id=alpha",
      "https://site.example/hls/playlist.m3u8?id=beta",
    ]);
  });

  test("preserves e and ts stream identifiers before adaptive rotation is observed", () => {
    const merged = bg.mergeVideoFinds([], [
      "https://site.example/hls/playlist.m3u8?e=episode-one",
      "https://site.example/hls/playlist.m3u8?e=episode-two",
      "https://site.example/hls/playlist.m3u8?ts=100",
      "https://site.example/hls/playlist.m3u8?ts=200",
    ]);
    assert.equal(merged.length, 4);
  });

  test("rotating auth query parameters still collapse manifests", () => {
    const merged = bg.mergeVideoFinds([], [
      "https://site.example/hls/playlist.m3u8?id=alpha&token=old",
      "https://site.example/hls/playlist.m3u8?id=alpha&token=new",
    ]);
    assert.equal(merged.length, 1);
  });

  test("a directory with two families does not absorb a direct rendition", () => {
    const merged = bg.mergeVideoFinds(
      [{ src: "https://cdn.example.com/v/a/720p.mp4", blob: false }],
      [
        "https://cdn.example.com/v/a/master.m3u8",
        "https://cdn.example.com/v/a/index.m3u8",
      ]
    );
    assert.deepEqual(merged, [
      "https://cdn.example.com/v/a/720p.mp4",
      "https://cdn.example.com/v/a/master.m3u8",
      "https://cdn.example.com/v/a/index.m3u8",
    ]);
  });

  test("extensionless manifests group sibling renditions and keep manifest menu treatment", () => {
    const kinds = new Map([
      ["https://cdn.example.com/live/playlist", "manifest"],
    ]);
    const merged = bg.mergeVideoFinds(
      [],
      [
        "https://cdn.example.com/live/720p.mp4",
        "https://cdn.example.com/live/playlist",
      ],
      kinds
    );
    assert.deepEqual(merged, ["https://cdn.example.com/live/playlist"]);
    assert.equal(bg.buildVideoEntry(merged[0], { kind: "manifest" }).rows.length, 1);
  });

  test("empty finds merge to empty", () => {
    assert.deepEqual(bg.mergeVideoFinds([], []), []);
    assert.deepEqual(bg.mergeVideoFinds(null, null), []);
  });
});

describe("per-video menu candidates", () => {
  let bg;
  let chrome;

  beforeEach(() => {
    chrome = makeChrome();
    bg = loadBackground(chrome);
  });

  const pathKey = (url) => bg.videoUrlIdentityKey(url);

  const makeFinds = (videos, manifests = [], times = new Map(), media = []) => ({
    frames: new Map([[0, videos]]),
    sniffedByFrame: new Map([[0, manifests]]),
    mediaByFrame: new Map([[0, media]]),
    kindsByFrame: new Map([[0, new Map()]]),
    sniffTimesByFrame: new Map([[0, times]]),
    sniffFirstSeenByFrame: new Map([[0, new Map(times)]]),
    retiredFrames: new Map(),
  });

  test("a direct video uses its DOM source and ignores sniffed MP4s and unrelated manifests", async () => {
    const direct = "https://cdn.example.com/watch/main.mp4";
    const findings = makeFinds(
      [{ src: direct, blob: false, elementId: 1, loadStartedAt: 1000 }],
      ["https://ads.example.com/pre-roll/master.m3u8"],
      new Map([[pathKey("https://ads.example.com/pre-roll/master.m3u8"), 900]]),
      [
        "https://cdn.example.com/watch/segment-001.mp4",
        "https://ads.example.com/pre-roll/ad.mp4",
      ],
    );

    assert.deepEqual(await bg.menuVideoCandidatesForFrame(findings, 0), [direct]);
  });

  test("direct sources with distinct resource IDs remain separate", async () => {
    const first = "https://cdn.example.com/get_video.php?id=1";
    const second = "https://cdn.example.com/get_video.php?id=2";
    const findings = makeFinds([
      { src: first, blob: false, elementId: 1, loadStartedAt: 1000 },
      { src: second, blob: false, elementId: 2, loadStartedAt: 2000 },
    ]);
    bg._videoFinds.set(190, findings);

    assert.deepEqual(await bg.resolvedVideoUrls(190), [first, second]);
  });

  test("direct menu heights are finite positive integers capped at 8640p", () => {
    const bg = loadBackground(makeChrome());
    const url = "https://cdn.example.com/video.mp4";
    assert.equal(bg.directMenuRow(url, 720.9).quality, "720p");
    assert.equal(bg.directMenuRow(url, 1e21).quality, "8640p");
    assert.equal(bg.directMenuRow(url, 0.5).quality, "");
    assert.equal(bg.directMenuRow(url, Infinity).quality, "");
  });

  test("direct-source dedupe preserves the exact order of non-auth query parameters", async () => {
    const first = "https://cdn.example.com/get_video.php?id=1&format=mp4";
    const second = "https://cdn.example.com/get_video.php?format=mp4&id=1";
    const findings = makeFinds([
      { src: first, blob: false, elementId: 1, loadStartedAt: 1000 },
      { src: second, blob: false, elementId: 2, loadStartedAt: 2000 },
    ]);
    bg._videoFinds.set(193, findings);

    assert.deepEqual(await bg.resolvedVideoUrls(193), [first, second]);
  });

  test("direct-source dedupe still ignores rotating auth-token values", async () => {
    const oldUrl = "https://cdn.example.com/get_video.php?token=old";
    const newUrl = "https://cdn.example.com/get_video.php?token=new";
    const findings = makeFinds([
      { src: oldUrl, blob: false, elementId: 1, loadStartedAt: 1000 },
      { src: newUrl, blob: false, elementId: 2, loadStartedAt: 2000 },
    ]);
    bg._videoFinds.set(191, findings);

    assert.deepEqual(await bg.resolvedVideoUrls(191), [newUrl]);
  });

  test("a manifest under /audio/ is recorded and remains a menu candidate", async () => {
    const tabId = 192;
    const manifest = "https://cdn.example.com/audio/master.m3u8";
    await chrome._listeners["webRequest.onResponseStarted"]({
      tabId,
      frameId: 0,
      url: manifest,
      timeStamp: Date.now(),
      responseHeaders: [
        { name: "content-type", value: "application/vnd.apple.mpegurl" },
      ],
    });

    const findings = bg._videoFinds.get(tabId);
    assert.ok(findings);
    assert.deepEqual(findings.sniffedByFrame.get(0), [manifest]);
    assert.deepEqual(await bg.menuVideoCandidatesForFrame(findings, 0), [manifest]);
  });

  test("a blob video chooses its HLS master and ignores sniffed media files", async () => {
    const master = "http://192.168.1.20/hls/master.m3u8";
    const child = "http://192.168.1.20/hls/variant.m3u8";
    chrome.tabs.get = async (id) => ({ id, url: "http://192.168.1.10/watch" });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => ({
      ok: true,
      text: async () => String(url) === master
        ? "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100000\nvariant.m3u8\n"
        : "#EXTM3U\n#EXT-X-TARGETDURATION=6\n",
    });
    try {
      const findings = makeFinds(
        [{
          src: null, blob: true, blobUrl: "blob:https://example.com/player",
          elementId: 1, loadStartedAt: 1000,
        }],
        [master, child],
        new Map([[pathKey(master), 900], [pathKey(child), 950]]),
        ["http://192.168.1.20/hls/chunk-001.mp4"],
      );

      assert.deepEqual(await bg.menuVideoCandidatesForFrame(findings, 0, 5), [master]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("HLS outranks DASH for the same element even when the manifests use different folders", async () => {
    const hls = "http://192.168.1.20/hls/master.m3u8";
    const dash = "http://192.168.1.20/dash/manifest.mpd";
    chrome.tabs.get = async (id) => ({ id, url: "http://192.168.1.10/watch" });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      text: async () => "#EXTM3U\\n#EXT-X-TARGETDURATION=6\\n",
    });
    try {
      const findings = makeFinds(
        [{
          src: null, blob: true, blobUrl: "blob:https://example.com/player",
          elementId: 1, loadStartedAt: 1000,
        }],
        [dash, hls],
        new Map([[pathKey(hls), 900], [pathKey(dash), 920]]),
      );

      assert.deepEqual(await bg.menuVideoCandidatesForFrame(findings, 0, 5), [hls]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("a blob video ignores obvious advertisement and preview manifests", async () => {
    const main = "https://cdn.example.com/hls/master.m3u8";
    const ad = "https://ads.example.com/pre-roll/master.m3u8";
    const preview = "https://cdn.example.com/previews/teaser.m3u8";
    const findings = makeFinds(
      [{
        src: null, blob: true, blobUrl: "blob:https://example.com/main",
        elementId: 1, loadStartedAt: 2000,
      }],
      [ad, preview, main],
      new Map([
        [pathKey(ad), 1900],
        [pathKey(preview), 1920],
        [pathKey(main), 1950],
      ]),
    );
    assert.deepEqual(await bg.menuVideoCandidatesForFrame(findings, 0), [main]);
  });

  test("equal-rank manifests observed at the same time stay ambiguous", async () => {
    const first = "https://cdn.example.com/first/master.m3u8";
    const second = "https://cdn.example.com/second/master.m3u8";
    const findings = makeFinds(
      [{
        src: null, blob: true, blobUrl: "blob:https://example.com/player",
        elementId: 1, loadStartedAt: 2000,
      }],
      [first, second],
      new Map([[pathKey(first), 1900], [pathKey(second), 1900]]),
    );
    assert.deepEqual(await bg.menuVideoCandidatesForFrame(findings, 0), []);
  });

  test("equal-rank manifests without usable observation timing preserve first-seen order", async () => {
    const first = "https://cdn.example.com/first/master.m3u8";
    const second = "https://cdn.example.com/second/master.m3u8";
    const findings = makeFinds(
      [{
        src: null, blob: true, blobUrl: "blob:https://example.com/player",
        elementId: 1, loadStartedAt: 2000,
      }],
      [first, second],
      new Map(),
    );
    assert.deepEqual(await bg.menuVideoCandidatesForFrame(findings, 0), [first]);
  });

  test("a blob video prefers the manifest observed closest before its load start", async () => {
    const older = "https://cdn.example.com/prefetched/master.m3u8";
    const current = "https://cdn.example.com/current/master.m3u8";
    const findings = makeFinds(
      [{
        src: null, blob: true, blobUrl: "blob:https://example.com/player",
        elementId: 1, loadStartedAt: 2000,
      }],
      [older, current],
      new Map([[pathKey(older), 1000], [pathKey(current), 1980]]),
    );
    assert.deepEqual(
      await bg.menuVideoCandidatesForFrame(findings, 0),
      [current],
    );
  });

  test("a pre-load master beats its nested child when both requests precede loadstart", async () => {
    const master = "http://192.168.1.20/abc/playlist.m3u8";
    const child = "http://192.168.1.20/abc/720p/stream.m3u8";
    chrome.tabs.get = async (id) => ({ id, url: "https://page.example/watch" });
    const findings = makeFinds(
      [{
        src: null, blob: true, blobUrl: "blob:https://page.example/player",
        elementId: 1, loadStartedAt: 10_000,
      }],
      [master, child],
      new Map([[pathKey(master), 9_450], [pathKey(child), 9_800]]),
    );
    findings.sniffFirstSeenByFrame.set(0, new Map([
      [pathKey(master), 9_200],
      [pathKey(child), 9_700],
    ]));

    assert.deepEqual(await bg.menuVideoCandidatesForFrame(findings, 0), [master]);
  });

  test("a later nested master is not discarded beneath an unrelated earlier playlist", async () => {
    const earlier = "http://192.168.1.20/vod/a.m3u8";
    const current = "http://192.168.1.20/vod/b/master.m3u8";
    chrome.tabs.get = async (id) => ({ id, url: "https://page.example/watch" });
    const findings = makeFinds(
      [{
        src: null, blob: true, blobUrl: "blob:https://page.example/player",
        elementId: 1, loadStartedAt: 20_000,
      }],
      [earlier, current],
      new Map([[pathKey(earlier), 1_000], [pathKey(current), 19_800]]),
    );
    findings.sniffFirstSeenByFrame.set(0, new Map([
      [pathKey(earlier), 1_000],
      [pathKey(current), 19_800],
    ]));

    assert.deepEqual(await bg.menuVideoCandidatesForFrame(findings, 0), [current]);
  });

  test("an unnamed earlier playlist does not hide a nested content master", async () => {
    const anonymousAd = "http://192.168.1.20/vod/8f31a.m3u8";
    const contentMaster = "http://192.168.1.20/vod/title-42/master.m3u8";
    chrome.tabs.get = async (id) => ({ id, url: "https://page.example/watch" });
    const findings = makeFinds(
      [{
        src: null, blob: true, blobUrl: "blob:https://page.example/player",
        elementId: 1, loadStartedAt: 20_000,
      }],
      [anonymousAd, contentMaster],
      new Map([[pathKey(anonymousAd), 900], [pathKey(contentMaster), 19_900]]),
    );
    findings.sniffFirstSeenByFrame.set(0, new Map([
      [pathKey(anonymousAd), 900],
      [pathKey(contentMaster), 19_900],
    ]));

    assert.deepEqual(await bg.menuVideoCandidatesForFrame(findings, 0), [contentMaster]);
  });

  // Picks the single menu link for one blob player whose playlists were first
  // requested at the given times (ms) relative to loadstart at 20_000.
  async function pickedPlaylist(requests) {
    chrome.tabs.get = async (id) => ({ id, url: "https://page.example/watch" });
    const urls = requests.map(([path]) => `http://192.168.1.20${path}`);
    const firstSeen = new Map(requests.map(([path, at]) => [pathKey(`http://192.168.1.20${path}`), at]));
    const findings = makeFinds(
      [{
        src: null, blob: true, blobUrl: "blob:https://page.example/player",
        elementId: 1, loadStartedAt: 20_000,
      }],
      urls,
      new Map(firstSeen),
    );
    findings.sniffFirstSeenByFrame.set(0, firstSeen);
    return bg.menuVideoCandidatesForFrame(findings, 0);
  }

  test("a rendition up to three directories below a master collapses into it", async () => {
    assert.deepEqual(
      await pickedPlaylist([["/vod/playlist.m3u8", 19_200], ["/vod/hls/720p/stream.m3u8", 19_700]]),
      ["http://192.168.1.20/vod/playlist.m3u8"],
    );
    assert.deepEqual(
      await pickedPlaylist([["/v/abc/master.m3u8", 19_200], ["/v/abc/hls/720p/index.m3u8", 19_700]]),
      ["http://192.168.1.20/v/abc/master.m3u8"],
    );
  });

  test("renditions deeper than the depth limit are not collapsed by ancestry", async () => {
    assert.deepEqual(
      await pickedPlaylist([["/vod/playlist.m3u8", 19_200], ["/vod/a/b/c/d/720p/stream.m3u8", 19_700]]),
      ["http://192.168.1.20/vod/a/b/c/d/720p/stream.m3u8"],
    );
  });

  test("a same-directory rendition collapses into a master-named playlist before loadstart", async () => {
    assert.deepEqual(
      await pickedPlaylist([["/v/master.m3u8", 19_200], ["/v/720p.m3u8", 19_700]]),
      ["http://192.168.1.20/v/master.m3u8"],
    );
  });

  test("a same-directory rendition collapses into a name-prefix parent", async () => {
    assert.deepEqual(
      await pickedPlaylist([["/vod/movie.m3u8", 19_200], ["/vod/movie_1080p.m3u8", 19_700]]),
      ["http://192.168.1.20/vod/movie.m3u8"],
    );
  });

  test("a single-rendition content file is not hidden by an unrelated same-directory playlist", async () => {
    assert.deepEqual(
      await pickedPlaylist([["/vod/promo.m3u8", 1_000], ["/vod/movie_1080p.m3u8", 19_800]]),
      ["http://192.168.1.20/vod/movie_1080p.m3u8"],
    );
  });

  test("a rendition-named playlist never acts as the parent of another rendition", () => {
    const low = "http://192.168.1.20/v/720p.m3u8";
    const high = "http://192.168.1.20/v/1080p.m3u8";
    const keys = bg.nestedHlsPlaylistChildKeys(
      [low, high],
      new Map([[pathKey(low), 1_000], [pathKey(high), 2_000]]),
    );
    assert.equal(keys.size, 0);
  });

  test("ids, years and video-prefixed directories do not look like renditions", async () => {
    for (const dir of ["1234", "2024", "video-abc", "video_12345", "title-42"]) {
      assert.deepEqual(
        await pickedPlaylist([["/vod/a.m3u8", 1_000], [`/vod/${dir}/master.m3u8`, 19_800]]),
        [`http://192.168.1.20/vod/${dir}/master.m3u8`],
        dir,
      );
    }
  });

  test("rendition markers are standard heights, p-suffixed heights, bitrates and level names", () => {
    for (const path of [
      "720p/stream.m3u8", "1080/index.m3u8", "video_720p/index.m3u8", "variant2/x.m3u8",
      "level3/x.m3u8", "800k/index.m3u8", "1500kbps/index.m3u8", "chunklist_w1.m3u8",
      "prog_index.m3u8", "stream_480p.m3u8",
    ]) assert.equal(bg.isHlsRenditionPlaylistPath(path), true, path);
    for (const path of [
      "1234/master.m3u8", "2024/master.m3u8", "video-abc/master.m3u8", "title-42/master.m3u8",
      "master.m3u8", "playlist.m3u8", "abc/index.m3u8",
    ]) assert.equal(bg.isHlsRenditionPlaylistPath(path), false, path);
  });

  // No active <video>: the manifest-only fallback collapses renditions too.
  async function fallbackPlaylists(requests) {
    chrome.tabs.get = async (id) => ({ id, url: "https://page.example/watch" });
    const urls = requests.map(([path]) => `http://192.168.1.20${path}`);
    const firstSeen = new Map(requests.map(([path, at]) => [pathKey(`http://192.168.1.20${path}`), at]));
    const findings = makeFinds([], urls, new Map(firstSeen));
    findings.sniffFirstSeenByFrame.set(0, firstSeen);
    return bg.menuVideoCandidatesForFrame(findings, 0);
  }

  test("the no-video fallback collapses renditions into their earlier master", async () => {
    assert.deepEqual(
      await fallbackPlaylists([
        ["/v/master.m3u8", 1_000],
        ["/v/720p/index.m3u8", 1_300],
        ["/v/1080p/index.m3u8", 1_600],
      ]),
      ["http://192.168.1.20/v/master.m3u8"],
    );
  });

  test("the no-video fallback keeps unrelated manifests and renditions requested before their parent", async () => {
    assert.deepEqual(
      await fallbackPlaylists([
        ["/a/main/master.m3u8", 1_000],
        ["/b/other/master.m3u8", 1_300],
      ]),
      ["http://192.168.1.20/a/main/master.m3u8", "http://192.168.1.20/b/other/master.m3u8"],
    );
    // A rendition seen before the playlist above it is not that playlist's child.
    const early = await fallbackPlaylists([
      ["/v/720p/index.m3u8", 1_000],
      ["/v/master.m3u8", 1_300],
    ]);
    assert.ok(early.includes("http://192.168.1.20/v/master.m3u8"));
  });

  test("byte-range slice URLs are never whole-file candidates", () => {
    for (const url of [
      "https://video.fbcdn.net/o1/v/abc.mp4?bytestart=0&byteend=2999999&sig=1",
      "https://rr1---sn-abc.googlevideo.com/videoplayback?itag=137&range=0-4999999",
      "https://cdn.example.com/v/clip.mp4?byte_range=0-1048575",
    ]) assert.equal(bg.isByteRangeSliceUrl(url), true, url);
    for (const url of [
      "https://cdn.example.com/v/clip.mp4?token=abc&expires=1",
      "https://cdn.example.com/v/clip.mp4?rangefinder=1",
      "https://cdn.example.com/v/clip.mp4?range=high",
      "https://cdn.example.com/v/clip.mp4?rn=4",
      "https://cdn.example.com/v/clip.mp4",
    ]) assert.equal(bg.isByteRangeSliceUrl(url), false, url);
    // Manifests are never judged by this rule.
    assert.equal(bg.isSegmentLikeVideoUrl("https://cdn.example.com/v/master.m3u8?range=0-5&rn=1"), false);
  });

  test("a sniffed 200 response for a byte-range slice is not recorded as whole media", () => {
    const details = (url) => ({
      url, statusCode: 200,
      responseHeaders: [
        { name: "content-type", value: "video/mp4" },
        { name: "content-length", value: String(3 * 1024 * 1024) },
      ],
    });
    assert.equal(bg.wholeVideoMediaSize(details("https://video.fbcdn.net/o1/v/abc.mp4?bytestart=0&byteend=2999999")), null);
    assert.equal(bg.wholeVideoMediaSize(details("https://cdn.example.com/v/clip.mp4")), 3 * 1024 * 1024);
  });

  test("a rendition marker in the parent directory does not classify a nested master as a child", async () => {
    const earlier = "http://192.168.1.20/vod/1080/a.m3u8";
    const current = "http://192.168.1.20/vod/1080/b/master.m3u8";
    chrome.tabs.get = async (id) => ({ id, url: "https://page.example/watch" });
    const findings = makeFinds(
      [{
        src: null, blob: true, blobUrl: "blob:https://page.example/player",
        elementId: 1, loadStartedAt: 20_000,
      }],
      [earlier, current],
      new Map([[pathKey(earlier), 1_000], [pathKey(current), 19_800]]),
    );
    findings.sniffFirstSeenByFrame.set(0, new Map([
      [pathKey(earlier), 1_000],
      [pathKey(current), 19_800],
    ]));

    assert.deepEqual(await bg.menuVideoCandidatesForFrame(findings, 0), [current]);
  });

  test("separate nested episode directories remain attributed to their own players", async () => {
    const episodeA = "http://192.168.1.20/abc/episode-a/playlist.m3u8";
    const episodeB = "http://192.168.1.20/abc/episode-b/720p/stream.m3u8";
    chrome.tabs.get = async (id) => ({ id, url: "https://page.example/watch" });
    const findings = makeFinds(
      [
        {
          src: null, blob: true, blobUrl: "blob:https://page.example/player-a",
          elementId: 1, loadStartedAt: 10_000,
        },
        {
          src: null, blob: true, blobUrl: "blob:https://page.example/player-b",
          elementId: 2, loadStartedAt: 20_000,
        },
      ],
      [episodeA, episodeB],
      new Map([[pathKey(episodeA), 9_500], [pathKey(episodeB), 19_800]]),
    );
    findings.sniffFirstSeenByFrame.set(0, new Map([
      [pathKey(episodeA), 9_200],
      [pathKey(episodeB), 19_700],
    ]));

    assert.deepEqual(
      await bg.menuVideoCandidatesForFrame(findings, 0),
      [episodeA, episodeB],
    );
  });

  test("a pre-load master beats its nested post-load child when inspection is unavailable", async () => {
    const master = "http://192.168.1.20/abc/playlist.m3u8";
    const child = "http://192.168.1.20/abc/720p/stream.m3u8";
    chrome.tabs.get = async (id) => ({ id, url: "https://page.example/watch" });
    const findings = makeFinds(
      [{
        src: null, blob: true, blobUrl: "blob:https://page.example/player",
        elementId: 1, loadStartedAt: 10_000,
      }],
      [master, child],
      new Map([[pathKey(master), 20_000], [pathKey(child), 30_000]]),
    );
    findings.sniffFirstSeenByFrame.set(0, new Map([
      [pathKey(master), 9_000],
      [pathKey(child), 10_100],
    ]));

    assert.deepEqual(await bg.menuVideoCandidatesForFrame(findings, 0), [master]);
  });

  test("a pre-load manifest outranks a sibling post-load manifest", async () => {
    const earlier = "http://192.168.1.20/first/master.m3u8";
    const later = "http://192.168.1.20/second/master.m3u8";
    chrome.tabs.get = async (id) => ({ id, url: "https://page.example/watch" });
    const findings = makeFinds(
      [{
        src: null, blob: true, blobUrl: "blob:https://page.example/player",
        elementId: 1, loadStartedAt: 10_000,
      }],
      [earlier, later],
      new Map([[pathKey(earlier), 20_000], [pathKey(later), 30_000]]),
    );
    findings.sniffFirstSeenByFrame.set(0, new Map([
      [pathKey(earlier), 9_000],
      [pathKey(later), 10_100],
    ]));

    assert.deepEqual(await bg.menuVideoCandidatesForFrame(findings, 0), [earlier]);
  });

  test("among post-load manifests, the earliest first-seen request wins over a later refresh", async () => {
    const earliest = "http://192.168.1.20/first/master.m3u8";
    const refreshed = "http://192.168.1.20/second/master.m3u8";
    chrome.tabs.get = async (id) => ({ id, url: "https://page.example/watch" });
    const findings = makeFinds(
      [{
        src: null, blob: true, blobUrl: "blob:https://page.example/player",
        elementId: 1, loadStartedAt: 10_000,
      }],
      [earliest, refreshed],
      new Map([[pathKey(earliest), 15_000], [pathKey(refreshed), 30_000]]),
    );
    findings.sniffFirstSeenByFrame.set(0, new Map([
      [pathKey(earliest), 10_100],
      [pathKey(refreshed), 10_300],
    ]));

    assert.deepEqual(await bg.menuVideoCandidatesForFrame(findings, 0), [earliest]);
  });

  test("a manifest requested a few seconds after loadstart can belong to one of multiple players", async () => {
    const direct = "https://cdn.example.com/earlier/direct.mp4";
    const manifest = "https://cdn.example.com/later/master.m3u8?id=live-stream";
    const findings = makeFinds(
      [
        { src: direct, blob: false, elementId: 12, loadStartedAt: 1_000 },
        {
          src: null, blob: true, blobUrl: "blob:https://example.com/later",
          elementId: 13, loadStartedAt: 6_000,
        },
      ],
      [manifest],
      new Map([[pathKey(manifest), 8_000]]),
    );

    assert.deepEqual(await bg.menuVideoCandidatesForFrame(findings, 0), [direct, manifest]);
  });

  test("multiple active elements receive only manifests nearest to their own load start", async () => {
    const direct = "https://cdn.example.com/main/direct.mp4";
    const adManifest = "https://ads.example.com/ad/master.m3u8";
    const mainManifest = "https://cdn.example.com/main/master.m3u8";
    const findings = makeFinds(
      [
        { src: direct, blob: false, elementId: 1, loadStartedAt: 1000 },
        {
          src: null, blob: true, blobUrl: "blob:https://example.com/main",
          elementId: 2, loadStartedAt: 3000,
        },
      ],
      [adManifest, mainManifest],
      new Map([[pathKey(adManifest), 950], [pathKey(mainManifest), 2950]]),
    );

    assert.deepEqual(
      await bg.menuVideoCandidatesForFrame(findings, 0),
      [direct, mainManifest],
    );
  });

  test("ambiguous multi-video timing produces no blob candidate", async () => {
    const first = "https://cdn.example.com/first/master.m3u8";
    const findings = makeFinds(
      [
        {
          src: null, blob: true, blobUrl: "blob:https://example.com/first",
          elementId: 1, loadStartedAt: 1000,
        },
        {
          src: null, blob: true, blobUrl: "blob:https://example.com/second",
          elementId: 2, loadStartedAt: 1000,
        },
      ],
      [first],
      new Map([[pathKey(first), 900]]),
    );

    assert.deepEqual(await bg.menuVideoCandidatesForFrame(findings, 0), []);
  });

  test("a manifest requested shortly after loadstart resolves for a single player", async () => {
    const manifest = "https://cdn.example.com/main/master.m3u8";
    const findings = makeFinds(
      [{
        src: null, blob: true, blobUrl: "blob:https://example.com/main",
        elementId: 1, loadStartedAt: 2000,
      }],
      [manifest],
      new Map([[pathKey(manifest), 2100]]),
    );

    assert.deepEqual(await bg.menuVideoCandidatesForFrame(findings, 0), [manifest]);
  });

  test("a manifest more than 30 seconds before loadstart resolves for a single player", async () => {
    const manifest = "https://cdn.example.com/prefetched/master.m3u8";
    const findings = makeFinds(
      [{
        src: null, blob: true, blobUrl: "blob:https://example.com/old-prefetch",
        elementId: 1, loadStartedAt: 50_000,
      }],
      [manifest],
      new Map([[pathKey(manifest), 1_000]]),
    );

    assert.deepEqual(await bg.menuVideoCandidatesForFrame(findings, 0), [manifest]);
  });

  test("network-only fallback remains manifest-only and collapses sibling HLS/DASH", async () => {
    const hls = "https://cdn.example.com/one/master.m3u8";
    const dash = "https://cdn.example.com/one/manifest.mpd";
    const second = "https://cdn.example.com/two/master.m3u8";
    const completeMedia = "https://cdn.example.com/one/full.mp4";
    const findings = makeFinds(
      [],
      [hls, dash, second],
      new Map([[pathKey(completeMedia), 1000]]),
      [completeMedia, "https://cdn.example.com/one/preview.mp4"],
    );
    findings.wholeMediaByFrame = new Map([[0, [completeMedia]]]);
    findings.mediaSizesByFrame = new Map([[0, new Map([[pathKey(completeMedia), 8 * 1024 * 1024]])]]);

    const candidates = await bg.menuVideoCandidatesForFrame(findings, 0);
    assert.deepEqual(candidates, [hls, second]);
  });

  test("a blob video falls back only to one complete large MP4 response", async () => {
    const media = "https://cdn.example.com/video/full-file.mp4?token=ok";
    const findings = makeFinds(
      [{
        src: null, blob: true, blobUrl: "blob:https://example.com/full",
        elementId: 1, loadStartedAt: 2000,
      }],
      [],
      new Map([[pathKey(media), 1900]]),
      [media],
    );
    findings.wholeMediaByFrame = new Map([[0, [media]]]);
    findings.mediaSizesByFrame = new Map([[0, new Map([[pathKey(media), 8 * 1024 * 1024]])]]);
    assert.deepEqual(await bg.menuVideoCandidatesForFrame(findings, 0), [media]);
  });

  test("blob right-click resolves the same complete-file fallback as the menu", async () => {
    const chrome = makeChrome();
    const bg = loadBackground(chrome);
    const tabId = 176;
    const url = "https://cdn.example.com/video/full.mp4";
    await chrome._listeners["webRequest.onResponseStarted"]({
      tabId,
      frameId: 0,
      url,
      statusCode: 200,
      timeStamp: 1900,
      responseHeaders: [
        { name: "content-type", value: "video/mp4" },
        { name: "content-length", value: "8388608" },
      ],
    });
    await chrome._listeners["runtime.onMessage"](
      {
        type: "grab-videos-detected",
        videos: [{
          src: null,
          blob: true,
          blobUrl: "blob:https://example.com/clicked",
          elementId: 9,
          loadStartedAt: 2000,
        }],
      },
      { tab: { id: tabId, url: "https://example.com/" }, frameId: 0 },
    );

    const findings = bg._videoFinds.get(tabId);
    const video = findings.frames.get(0)[0];
    assert.deepEqual(await bg.resolvedVideoUrls(tabId), [url]);
    assert.equal(await bg.resolvedBlobVideoUrlForFrame(tabId, 0, video), url);
  });

  test("a blob video does not use ordinary or multiple complete media sniffs", async () => {
    const ordinary = "https://cdn.example.com/video/unknown.mp4";
    const first = "https://cdn.example.com/video/first.mp4";
    const second = "https://cdn.example.com/video/second.mp4";
    const video = [{
      src: null, blob: true, blobUrl: "blob:https://example.com/player",
      elementId: 1, loadStartedAt: 2000,
    }];
    const ordinaryFinds = makeFinds(
      video,
      [],
      new Map([[pathKey(ordinary), 1900]]),
      [ordinary],
    );
    assert.deepEqual(await bg.menuVideoCandidatesForFrame(ordinaryFinds, 0), []);

    const multipleFinds = makeFinds(
      video,
      [],
      new Map([[pathKey(first), 1900], [pathKey(second), 1950]]),
      [first, second],
    );
    multipleFinds.wholeMediaByFrame = new Map([[0, [first, second]]]);
    multipleFinds.mediaSizesByFrame = new Map([[
      0,
      new Map([
        [pathKey(first), 8 * 1024 * 1024],
        [pathKey(second), 12 * 1024 * 1024],
      ]),
    ]]);
    assert.deepEqual(await bg.menuVideoCandidatesForFrame(multipleFinds, 0), []);
  });

  test("whole-file fallback rejects small, partial and segment-like responses", () => {
    const base = "https://cdn.example.com/video/";
    const details = (url, statusCode, responseHeaders) => ({ url, statusCode, responseHeaders });
    const full = [{ name: "content-length", value: "8388608" }];
    assert.equal(bg.wholeVideoMediaSize(details(base + "clip.mp4", 200, full)), 8388608);
    assert.equal(bg.wholeVideoMediaSize(details(base + "preview.mp4", 200, [
      { name: "content-length", value: "120000" },
    ])), null);
    assert.equal(bg.wholeVideoMediaSize(details(base + "segment12.mp4", 200, [
      { name: "content-length", value: "120000" },
    ])), null);
    assert.equal(bg.wholeVideoMediaSize(details(base + "clip.mp4", 206, full)), null);
    assert.equal(bg.wholeVideoMediaSize(details(base + "clip.mp4", 200, [
      ...full, { name: "content-range", value: "bytes 0-999/8388608" },
    ])), null);
    for (const url of [
      base + "segment-12.mp4",
      base + "segment12.mp4",
      base + "chunk_001.mp4",
      base + "ad-video.mp4",
      base + "promo-clip.mp4",
      "https://cdn.example.com/segments/0001.mp4",
      "https://cdn.example.com/previews/preview.mp4",
    ]) assert.equal(bg.wholeVideoMediaSize(details(url, 200, full)), null, url);

    for (const url of [
      base + "lecture-part-2.mp4",
      base + "chunk1.mp4",
    ]) assert.equal(bg.wholeVideoMediaSize(details(url, 200, full)), 8388608, url);

    for (const url of [
      base + "preview.mp4",
      base + "preview-720p.mp4",
      base + "trailer.mp4",
      "https://cdn.example.com/ad/episode.mp4",
    ]) {
      assert.equal(
        bg.wholeVideoMediaSize(details(url, 200, full)),
        8388608,
        `${url} is a possible full media resource`,
      );
    }
  });

  test("serialized video snapshots stay within 256 KiB with adversarial URL volume", () => {
    const bg = loadBackground(makeChrome());
    const frames = new Map();
    const sniffedByFrame = new Map();
    const mediaByFrame = new Map();
    const wholeMediaByFrame = new Map();
    const kindsByFrame = new Map();
    const mediaSizesByFrame = new Map();
    const sniffSequencesByFrame = new Map();
    const sniffTimesByFrame = new Map();
    const sniffFirstSeenByFrame = new Map();
    const padding = "x".repeat(1700);

    for (let frameId = 0; frameId < bg.MAX_VIDEO_FRAMES; frameId += 1) {
      const manifests = [];
      const media = [];
      const kinds = new Map();
      const sizes = new Map();
      const sequences = new Map();
      const times = new Map();
      const firstSeen = new Map();
      for (let index = 0; index < 20; index += 1) {
        const url = "https://cdn.example.com/" + frameId + "/master-" + index + ".m3u8?id=" + index + "&pad=" + padding;
        manifests.push(url);
        const key = bg.videoUrlIdentityKey(url);
        kinds.set(key, "manifest");
        sequences.set(key, frameId * 28 + index + 1);
        times.set(key, Date.now() - index * 1000);
        firstSeen.set(key, Date.now() - index * 1000);
      }
      for (let index = 0; index < 8; index += 1) {
        const url = "https://cdn.example.com/" + frameId + "/file-" + index + ".mp4?id=" + index + "&pad=" + padding;
        media.push(url);
        const key = bg.videoUrlIdentityKey(url);
        kinds.set(key, "media");
        sizes.set(key, 8 * 1024 * 1024);
        sequences.set(key, frameId * 28 + index + 21);
        times.set(key, Date.now() - index * 1000);
        firstSeen.set(key, Date.now() - index * 1000);
      }
      frames.set(frameId, []);
      sniffedByFrame.set(frameId, manifests);
      mediaByFrame.set(frameId, media);
      wholeMediaByFrame.set(frameId, media);
      kindsByFrame.set(frameId, kinds);
      mediaSizesByFrame.set(frameId, sizes);
      sniffSequencesByFrame.set(frameId, sequences);
      sniffTimesByFrame.set(frameId, times);
      sniffFirstSeenByFrame.set(frameId, firstSeen);
    }

    const snapshot = bg.snapshotVideoFinds({
      frames, sniffedByFrame, mediaByFrame, wholeMediaByFrame,
      kindsByFrame, mediaSizesByFrame, sniffSequencesByFrame,
      sniffTimesByFrame, sniffFirstSeenByFrame,
      retiredFrames: new Map(), sniffSequence: 896, title: "stress",
    });
    const byteLength = new TextEncoder().encode(JSON.stringify(snapshot)).byteLength;
    assert.equal(snapshot.version, 3);
    assert.ok(byteLength <= bg.MAX_VIDEO_STATE_SNAPSHOT_BYTES,
      "snapshot is bounded: " + byteLength + " bytes");
    for (const [, records] of snapshot.observations) {
      const keys = records.map(([url]) => bg.videoUrlIdentityKey(url));
      assert.equal(new Set(keys).size, keys.length, "each URL identity occurs once per frame");
      for (const record of records) assert.equal(record.length, 7);
    }
  });

  test("a whole-file fallback survives session restore", async () => {
    const shared = {};
    const first = makeChrome(shared);
    const bg = loadBackground(first);
    const tabId = 175;
    const url = "https://cdn.example.com/video/full.mp4";
    await first._listeners["webRequest.onResponseStarted"]({
      tabId,
      frameId: 0,
      url,
      timeStamp: 1000,
      statusCode: 200,
      responseHeaders: [
        { name: "content-type", value: "video/mp4" },
        { name: "content-length", value: "8388608" },
      ],
    });
    await first._listeners["runtime.onMessage"](
      {
        type: "grab-videos-detected",
        videos: [{
          src: null, blob: true, blobUrl: "blob:https://example.com/full",
          elementId: 4, loadStartedAt: 1100,
        }],
      },
      { tab: { id: tabId, url: "https://example.com/" }, frameId: 0 },
    );
    await bg._persistVideoFinds(tabId);
    const saved = shared.session.get("videoFinds:v2:" + tabId);
    const observation = saved.observations[0][1].find(([candidate]) => candidate === url);
    assert.ok(observation, "whole-media URL is serialized once");
    assert.equal(observation[1] & 6, 6, "flags preserve media and whole-file state");
    assert.equal(observation[6], 8388608, "size metadata is co-located with its URL");

    const restarted = makeChrome(shared);
    const restoredBg = loadBackground(restarted);
    await restoredBg._restoreVideoFinds(tabId);
    assert.deepEqual(await restoredBg.resolvedVideoUrls(tabId), [url]);
  });
});

describe("cross-frame video URL deduplication", () => {
  test("rotating query tokens for the same direct video keep the latest frame URL", async () => {
    const chrome = makeChrome();
    const bg = loadBackground(chrome);
    const tabId = 173;
    await chrome._listeners["tabs.onActivated"]({ tabId });
    await chrome._listeners["runtime.onMessage"](
      {
        type: "grab-videos-detected",
        videos: [{
          src: "https://cdn.example.com/watch/main.mp4?token=old",
          blob: false,
          elementId: 1,
          loadStartedAt: 1000,
        }],
      },
      { tab: { id: tabId, url: "https://example.com/" }, frameId: 0 },
    );
    await chrome._listeners["runtime.onMessage"](
      {
        type: "grab-videos-detected",
        videos: [{
          src: "https://cdn.example.com/watch/main.mp4?token=new",
          blob: false,
          elementId: 1,
          loadStartedAt: 2000,
        }],
      },
      { tab: { id: tabId, url: "https://example.com/" }, frameId: 7 },
    );

    assert.deepEqual(
      await bg.resolvedVideoUrls(tabId),
      ["https://cdn.example.com/watch/main.mp4?token=new"],
    );
    const badges = chrome._calls.filter(([name]) => name === "action.setBadgeText");
    assert.equal(badges.at(-1)[1].text, "1");
  });

  test("rotating non-auth query parameters on the same manifest deduplicate across frames", async () => {
    const chrome = makeChrome();
    const bg = loadBackground(chrome);
    const tabId = 175;
    await chrome._listeners["tabs.onActivated"]({ tabId });
    const observations = [
      {
        frameId: 0,
        url: "https://cdn.example.com/live/master.m3u8?md5=old&e=old&ts=100&_=old&cb=old",
        timeStamp: 1000,
      },
      {
        frameId: 8,
        url: "https://cdn.example.com/live/master.m3u8?md5=new&e=new&ts=200&_=new&cb=new",
        timeStamp: 2000,
      },
    ];
    for (const observation of observations) {
      await chrome._listeners["webRequest.onResponseStarted"]({
        tabId,
        ...observation,
        responseHeaders: [{ name: "content-type", value: "application/vnd.apple.mpegurl" }],
      });
      await chrome._listeners["runtime.onMessage"](
        {
          type: "grab-videos-detected",
          videos: [{
            src: null,
            blob: true,
            blobUrl: "blob:https://example.com/player-" + observation.frameId,
          }],
        },
        { tab: { id: tabId, url: "https://example.com/" }, frameId: observation.frameId },
      );
    }

    assert.deepEqual(
      await bg.resolvedVideoUrls(tabId),
      [observations[1].url],
    );
  });

  test("rotating manifest tokens across frames keep the latest observed URL", async () => {
    const chrome = makeChrome();
    const bg = loadBackground(chrome);
    const tabId = 174;
    await chrome._listeners["tabs.onActivated"]({ tabId });
    const observations = [
      { frameId: 0, url: "https://cdn.example.com/live/master.m3u8?token=old", timeStamp: 1000 },
      { frameId: 8, url: "https://cdn.example.com/live/master.m3u8?token=new", timeStamp: 2000 },
    ];
    for (const observation of observations) {
      await chrome._listeners["webRequest.onResponseStarted"]({
        tabId,
        ...observation,
        responseHeaders: [{ name: "content-type", value: "application/vnd.apple.mpegurl" }],
      });
      await chrome._listeners["runtime.onMessage"](
        {
          type: "grab-videos-detected",
          videos: [{
            src: null,
            blob: true,
            blobUrl: "blob:https://example.com/player-" + observation.frameId,
          }],
        },
        { tab: { id: tabId, url: "https://example.com/" }, frameId: observation.frameId },
      );
    }

    assert.deepEqual(
      await bg.resolvedVideoUrls(tabId),
      ["https://cdn.example.com/live/master.m3u8?token=new"],
    );
    assert.equal(
      await bg.resolvedBlobVideoUrlForFrame(tabId, 0),
      "https://cdn.example.com/live/master.m3u8?token=old",
      "frame-scoped right-click resolution retains its own observed token",
    );
  });
});

describe("collectVideos (content script)", () => {
  let content;
  beforeEach(() => {
    content = loadContent();
  });

  const fakeVideo = (opts) => ({
    currentSrc: opts.currentSrc !== undefined ? opts.currentSrc : opts.src || "",
    src: opts.src || "",
    videoWidth: opts.w || 0,
    videoHeight: opts.h || 0,
    paused: opts.paused === undefined ? true : opts.paused,
    ended: opts.ended === undefined ? false : opts.ended,
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ width: opts.w || 0, height: opts.h || 0 }),
  });
  const fakeDoc = (videos) => ({
    querySelectorAll: (sel) => (sel === "video" ? videos : []),
  });

  test("collects direct http(s) sources", () => {
    const videos = content.collectVideos(
      fakeDoc([fakeVideo({ src: "https://cdn.example.com/v.mp4", w: 640, h: 360 })]),
      () => true
    );
    assert.deepEqual(videos, [{ src: "https://cdn.example.com/v.mp4", blob: false, height: 360 }]);
  });

  test("prefers currentSrc and scans <source> children", () => {
    const withSource = {
      ...fakeVideo({ w: 640, h: 360 }),
      currentSrc: "",
      src: "",
      querySelectorAll: (sel) =>
        sel === "source" ? [{ src: "https://cdn.example.com/s.webm" }] : [],
    };
    const videos = content.collectVideos(fakeDoc([withSource]), () => true);
    assert.deepEqual(videos, [{ src: "https://cdn.example.com/s.webm", blob: false, height: 360 }]);
  });

  test("blob: sources are flagged, not collected", () => {
    const videos = content.collectVideos(
      fakeDoc([fakeVideo({ src: "blob:https://example.com/uuid", w: 640, h: 360 })]),
      () => true
    );
    assert.deepEqual(videos, [{
      src: null, blob: true,
      blobUrl: "blob:https://example.com/uuid",
      height: 360,
    }]);
  });

  test("includes bounded element identity and load-start metadata when provided", () => {
    const videos = content.collectVideos(
      fakeDoc([fakeVideo({ src: "blob:https://example.com/uuid", w: 640, h: 360 })]),
      () => true,
      null,
      null,
      () => ({ elementId: 7, loadStartedAt: 1234 }),
    );
    assert.deepEqual(videos, [{
      src: null,
      blob: true,
      blobUrl: "blob:https://example.com/uuid",
      height: 360,
      elementId: 7,
      loadStartedAt: 1234,
    }]);
  });

  test("tiny players are ignored (ads, trackers)", () => {
    const videos = content.collectVideos(
      fakeDoc([fakeVideo({ src: "https://cdn.example.com/ad.mp4", w: 60, h: 40 })]),
      () => true
    );
    assert.deepEqual(videos, []);
  });

  test("no videos gives an empty list", () => {
    assert.deepEqual(content.collectVideos(fakeDoc([]), () => true), []);
    assert.deepEqual(content.collectVideos(null, () => true), []);
  });

  test("a shallow scan reads the document and only the supplied shadow roots", () => {
    const light = fakeVideo({ src: "https://cdn.example.com/light.mp4", w: 640, h: 360 });
    const wired = fakeVideo({ src: "https://cdn.example.com/wired.mp4", w: 640, h: 360 });
    const doc = {
      querySelectorAll: (sel) => (sel === "video" ? [light] : []),
    };
    const root = {
      querySelectorAll: (sel) => (sel === "video" ? [wired] : []),
    };
    const videos = content.collectVideos(doc, () => true, null, null, null, [root]);
    assert.deepEqual(videos.map((v) => v.src), [
      "https://cdn.example.com/light.mp4",
      "https://cdn.example.com/wired.mp4",
    ]);
  });

  test("includes active user-started and autoplay videos but excludes idle videos", () => {
    const userStarted = fakeVideo({
      src: "https://cdn.example.com/user.mp4", w: 640, h: 360, paused: false,
    });
    const autoplay = {
      ...fakeVideo({
        src: "https://cdn.example.com/autoplay.mp4", w: 640, h: 360, paused: false,
      }),
      muted: true,
    };
    const idle = fakeVideo({
      src: "https://cdn.example.com/idle.mp4", w: 640, h: 360, paused: true,
    });
    const videos = content.collectVideos(
      fakeDoc([userStarted, autoplay, idle]),
      content.isActiveVideo
    );
    assert.deepEqual(videos, [
      { src: "https://cdn.example.com/user.mp4", blob: false, height: 360 },
      { src: "https://cdn.example.com/autoplay.mp4", blob: false, height: 360 },
    ]);
  });

  test("a video with no decoded height yet reports none", () => {
    const videos = content.collectVideos(
      fakeDoc([{ ...fakeVideo({ src: "https://cdn.example.com/n.mp4", w: 640, h: 360 }), videoHeight: 0 }]),
      () => true
    );
    assert.deepEqual(videos, [{ src: "https://cdn.example.com/n.mp4", blob: false }]);
  });
});

describe("isActiveVideo (content script)", () => {
  let content;
  beforeEach(() => {
    content = loadContent();
  });

  const pv = (opts) => ({
    muted: false,
    paused: true,
    ended: false,
    currentTime: 0,
    readyState: 4,
    ...opts,
  });

  test("user-started videos stay listed while actively playing", () => {
    assert.equal(content.isActiveVideo(pv({ paused: false, currentTime: 42 })), true);
  });

  test("unmuted autoplay is detected without user activation", () => {
    assert.equal(
      content.isActiveVideo(pv({ muted: false, paused: false, currentTime: 5 })),
      true
    );
  });

  test("muted autoplay is detected without user activation", () => {
    assert.equal(
      content.isActiveVideo(pv({ muted: true, paused: false, currentTime: 5 })),
      true
    );
  });

  test("paused and ended videos are excluded immediately", () => {
    assert.equal(content.isActiveVideo(pv({ paused: true, currentTime: 42 })), false);
    assert.equal(content.isActiveVideo(pv({ paused: false, ended: true })), false);
  });

  test("missing videos do not count", () => {
    assert.equal(content.isActiveVideo(null), false);
  });
});

describe("detection wiring", () => {
  const tick = () => new Promise((r) => setTimeout(r, 30));

  test("a network-observed HLS manifest appears without a DOM video and can be handed off", async () => {
    const chrome = makeChrome();
    loadBackground(chrome);
    const L = chrome._listeners;
    const manifest = "https://cdn.example.com/s/stream.m3u8";

    await L["tabs.onActivated"]({ tabId: 5 });
    await L["webRequest.onResponseStarted"]({
      tabId: 5,
      frameId: 4,
      url: manifest,
      responseHeaders: [],
    });
    await L["webRequest.onResponseStarted"]({
      tabId: 5,
      frameId: 4,
      url: "https://cdn.example.com/s/preview.mp4",
      responseHeaders: [],
    });
    await tick();
    await tick();

    const created = chrome._calls.filter(([n]) => n === "menus.create").map(([, id]) => id);
    assert.ok(created.includes("grabVideos"), "parent menu created from network observation");
    assert.ok(created.includes("grabVideo:0"), "manifest is available without a <video> report");
    assert.deepEqual(
      [...new Set(created.filter((id) => String(id).startsWith("grabVideo:")))],
      ["grabVideo:0"],
      "a network-only frame exposes manifests, not unrelated direct-media requests",
    );
    const badges = chrome._calls.filter(([n]) => n === "action.setBadgeText");
    assert.deepEqual(badges.at(-1)[1], { tabId: 5, text: "1" });

    await L["menus.onClicked"]({ menuItemId: "grabVideo:0" }, null);
    assert.ok(
      chrome._calls.some(([n, url]) => n === "handoff" && url === manifest),
      "the selected playlist is handed off through HTTP"
    );
  });

  test("a repeated identical sniff does not rewrite state or rebuild the menu", async () => {
    const chrome = makeChrome();
    loadBackground(chrome);
    const L = chrome._listeners;
    const tabId = 51;
    const manifest = "https://cdn.example.com/s/live.m3u8";
    let writes = 0;
    const set = chrome.storage.session.set;
    chrome.storage.session.set = async (obj) => {
      writes += 1;
      return set(obj);
    };
    await L["tabs.onActivated"]({ tabId });
    const sniff = () => L["webRequest.onResponseStarted"]({
      tabId,
      frameId: 0,
      url: manifest,
      responseHeaders: [],
    });

    await sniff();
    await tick();
    await tick();
    const createdAfterFirst = chrome._calls.filter(([n]) => n === "menus.create").length;
    const removedAfterFirst = chrome._calls.filter(([n]) => n === "menus.remove").length;
    const writesAfterFirst = writes;
    assert.ok(createdAfterFirst > 0, "the first sniff builds the menu");
    assert.ok(writesAfterFirst > 0, "the first sniff persists state");

    await sniff();
    await tick();
    await tick();
    assert.equal(
      chrome._calls.filter(([n]) => n === "menus.create").length,
      createdAfterFirst,
      "a repeat sniff does not create menu items",
    );
    assert.equal(
      chrome._calls.filter(([n]) => n === "menus.remove").length,
      removedAfterFirst,
      "a repeat sniff does not remove the menu",
    );
    assert.equal(writes, writesAfterFirst, "a repeat sniff does not persist state again");

    // Re-rendering the same active tab is also a no-op.
    await L["tabs.onActivated"]({ tabId });
    await tick();
    await tick();
    assert.equal(
      chrome._calls.filter(([n]) => n === "menus.create").length,
      createdAfterFirst,
      "an unchanged tab activation does not rebuild the menu",
    );
  });

  test("rotating playlist query tokens update click targets without rebuilding menu rows", async () => {
    const shared = {};
    const chrome = makeChrome(shared);
    loadBackground(chrome);
    const L = chrome._listeners;
    const tabId = 176;
    const menuUrlWrites = [];
    const originalSet = chrome.storage.session.set;
    chrome.storage.session.set = async (obj) => {
      if (Object.hasOwn(obj, "menuUrls")) menuUrlWrites.push(obj.menuUrls);
      return originalSet(obj);
    };

    await L["tabs.onActivated"]({ tabId });
    const playlistUrl = (sequence) =>
      `https://cdn.example.com/live/master.m3u8?_HLS_msn=${sequence}&_HLS_part=0`;
    let latestUrl = "";
    let initialCreateCount = 0;
    let initialRemoveCount = 0;
    for (let sequence = 0; sequence < 30; sequence += 1) {
      latestUrl = playlistUrl(sequence);
      await L["webRequest.onResponseStarted"]({
        tabId,
        frameId: 0,
        url: latestUrl,
        timeStamp: 1000 + sequence,
        responseHeaders: [{ name: "content-type", value: "application/vnd.apple.mpegurl" }],
      });
      // Drain the first refresh fully before recording the baseline: it may
      // remove a previously empty submenu as part of initial population.
      for (let turn = 0; turn < (sequence === 0 ? 8 : 2); turn += 1) await tick();
      if (sequence === 0) {
        initialCreateCount = chrome._calls.filter(([name]) => name === "menus.create").length;
        initialRemoveCount = chrome._calls.filter(([name]) => name === "menus.remove").length;
      }
    }

    const creates = chrome._calls.filter(([name]) => name === "menus.create");
    const removes = chrome._calls.filter(([name]) => name === "menus.remove");
    assert.equal(creates.filter(([, id]) => id === "grabVideos").length, 1);
    assert.equal(creates.filter(([, id]) => id === "grabVideo:0").length, 1);
    assert.equal(creates.length, initialCreateCount, "query-token rotations do not recreate menu items");
    assert.equal(removes.length, initialRemoveCount, "query-token rotations do not remove the populated menu");
    assert.deepEqual(shared.session.get("menuUrls"), [latestUrl]);
    assert.deepEqual(menuUrlWrites.at(-1), [latestUrl]);

    await L["menus.onClicked"]({ menuItemId: "grabVideo:0" }, { id: tabId });
    assert.ok(
      chrome._calls.some(([name, url]) => name === "handoff" && url === latestUrl),
      "the unchanged menu row hands off the newest playlist URL",
    );
  });

  test("a direct video remains the only entry when an unrelated manifest is sniffed", async () => {
    const chrome = makeChrome();
    // Private host: playlist inspection is local (no Grab pairing round trip).
    chrome.tabs.get = async (id) => ({ id, url: "http://192.168.1.5/" });
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    globalThis.fetch = async (url, opts) => {
      if (opts && opts.method === "GET") {
        await gate;
        return { ok: false, text: async () => "" };
      }
      return { ok: false, text: async () => "" };
    };
    loadBackground(chrome);
    const L = chrome._listeners;
    const tabId = 5;
    await L["tabs.onActivated"]({ tabId });
    await L["runtime.onMessage"](
      { type: "grab-videos-detected", videos: [{ src: "http://192.168.1.5/v/clip.mp4", blob: false }] },
      { tab: { id: tabId, url: "http://192.168.1.5/" } },
    );
    await tick();
    assert.ok(
      chrome._calls.some(([n, id]) => n === "menus.create" && id === "grabVideo:0"),
      "initial menu exists",
    );

    chrome._calls.length = 0;
    await L["webRequest.onResponseStarted"]({
      tabId,
      frameId: 0,
      url: "http://192.168.1.5/live/master.m3u8",
      responseHeaders: [],
    });
    release();
    await tick();
    await tick();

    assert.equal(
      chrome._calls.some(([n]) => n === "menus.remove"),
      false,
      "an unchanged candidate list keeps the existing menu",
    );
    await L["menus.onClicked"]({ menuItemId: "grabVideo:0" }, { id: tabId });
    assert.ok(
      chrome._calls.some(([n, url]) => n === "handoff" && url === "http://192.168.1.5/v/clip.mp4"),
      "the direct DOM source remains the sole menu candidate",
    );
  });

  test("a click resolves against the list the menu was built from (other window focused)", async () => {
    const chrome = makeChrome();
    loadBackground(chrome);
    const L = chrome._listeners;
    await L["tabs.onActivated"]({ tabId: 5 });
    L["webRequest.onResponseStarted"]({ tabId: 5, url: "https://a.example.com/a.mp4", responseHeaders: [] });
    // Played-only menu: the sniffed URL needs a started video to surface.
    L["runtime.onMessage"](
      { type: "grab-videos-detected", videos: [{ src: "https://a.example.com/v.mp4", blob: false }] },
      { tab: { id: 5 } }
    );
    await tick();
    // Second window: its active tab becomes the menu's tab.
    await L["tabs.onActivated"]({ tabId: 6 });
    L["webRequest.onResponseStarted"]({ tabId: 6, url: "https://b.example.com/b.mp4", responseHeaders: [] });
    L["webRequest.onResponseStarted"]({ tabId: 6, url: "https://b.example.com/c.mp4", responseHeaders: [] });
    L["runtime.onMessage"](
      { type: "grab-videos-detected", videos: [{ src: "https://b.example.com/v.mp4", blob: false }] },
      { tab: { id: 6 } }
    );
    await tick();
    // Right-click lands in tab 5 (window 1 focused again, no onActivated fired).
    // The direct DOM source is authoritative; sniffed MP4s are not extra menu rows.
    await L["menus.onClicked"]({ menuItemId: "grabVideo:0" }, { id: 5 });
    assert.ok(
      chrome._calls.some(([n, url]) => n === "handoff" && url === "https://b.example.com/v.mp4"),
      "the sole direct-video entry is what gets sent"
    );
  });

  test("content-script reports reach the menu", async () => {
    const chrome = makeChrome();
    loadBackground(chrome);
    const L = chrome._listeners;

    await L["tabs.onActivated"]({ tabId: 7 });
    L["runtime.onMessage"](
      {
        type: "grab-videos-detected",
        videos: [{ src: "https://cdn.example.com/v/clip.mp4", blob: false }],
      },
      { tab: { id: 7 } }
    );
    await tick();

    const created = chrome._calls.filter(([n]) => n === "menus.create").map(([, id]) => id);
    assert.ok(created.includes("grabVideo:0"));
    await L["menus.onClicked"]({ menuItemId: "grabVideo:0" }, null);
    assert.ok(
      chrome._calls.some(
        ([n, url]) => n === "handoff" && url === "https://cdn.example.com/v/clip.mp4"
      )
    );
  });

  test("reports from two frames merge instead of overwriting", async () => {
    const chrome = makeChrome();
    loadBackground(chrome);
    const L = chrome._listeners;

    await L["tabs.onActivated"]({ tabId: 11 });
    L["runtime.onMessage"](
      {
        type: "grab-videos-detected",
        videos: [{ src: "https://cdn.example.com/v/a.mp4", blob: false }],
      },
      { tab: { id: 11 }, frameId: 0 }
    );
    // A subframe reports later; the main frame's video must survive.
    L["runtime.onMessage"](
      {
        type: "grab-videos-detected",
        videos: [{ src: "https://cdn.example.com/v/b.mp4", blob: false }],
      },
      { tab: { id: 11 }, frameId: 7 }
    );
    await tick();

    const created = chrome._calls.filter(([n]) => n === "menus.create").map(([, id]) => id);
    assert.ok(created.includes("grabVideo:0"));
    assert.ok(created.includes("grabVideo:1"));

    await L["menus.onClicked"]({ menuItemId: "grabVideo:1" }, null);
    assert.ok(
      chrome._calls.some(
        ([n, url]) => n === "handoff" && url === "https://cdn.example.com/v/b.mp4"
      )
    );
  });

  test("all simultaneously playing videos appear beyond the old eight-item cap", async () => {
    const chrome = makeChrome();
    loadBackground(chrome);
    const L = chrome._listeners;
    const tabId = 12;

    await L["tabs.onActivated"]({ tabId });
    L["runtime.onMessage"](
      {
        type: "grab-videos-detected",
        videos: Array.from({ length: 10 }, (_, i) => ({
          src: "https://cdn.example.com/v/video-" + i + ".mp4",
          blob: false,
        })),
      },
      { tab: { id: tabId, url: "https://example.com/" }, frameId: 0 }
    );
    await tick();

    const itemIds = [
      ...new Set(
        chrome._calls
          .filter(([name, id]) => name === "menus.create" && /^grabVideo:\d+$/.test(String(id)))
          .map(([, id]) => id)
      ),
    ];
    assert.deepEqual(
      itemIds,
      Array.from({ length: 10 }, (_, i) => "grabVideo:" + i),
      "every distinct actively playing video gets a menu entry"
    );

    const saved = chrome._session.get("videoFinds:v2:" + tabId);
    assert.equal(saved.frames[0][1].length, 10, "all active videos survive worker persistence");
  });

  test("restoring oversized legacy video state caps frames and entries", async () => {
    const chrome = makeChrome();
    const tabId = 122;
    chrome._session.set("videoFinds:v2:" + tabId, {
      version: 2,
      frames: Array.from({ length: 128 }, (_, frameId) => [
        frameId,
        Array.from({ length: 8 }, (_, index) => ({
          src: `https://legacy.example.com/${frameId}-${index}.mp4`,
          blob: false,
        })),
      ]),
      sniffedFrames: [],
      kindsFrames: [],
      title: "persisted".repeat(500),
    });
    const bg = loadBackground(chrome);
    await chrome._listeners["runtime.onMessage"](
      {
        type: "grab-videos-detected",
        videos: [{ src: "https://fresh.example.com/top.mp4", blob: false }],
        title: "fresh title",
      },
      { tab: { id: tabId, url: "https://example.com/" }, frameId: 0 }
    );

    const findings = bg._videoFinds.get(tabId);
    const total = [...findings.frames.values()].reduce((sum, videos) => sum + videos.length, 0);
    assert.ok(findings.frames.size <= bg.MAX_VIDEO_FRAMES, "restored frames stay bounded");
    assert.ok(total <= bg.MAX_VIDEO_ITEMS, "restored entries stay bounded");
    assert.ok(findings.frames.has(0), "the top frame is retained");
    assert.ok(findings.frames.get(0).some((video) => video.src === "https://fresh.example.com/top.mp4"));
    assert.ok(findings.title.length <= bg.MAX_VIDEO_TITLE_LENGTH, "restored title stays bounded");
  });

  test("video report intake caps retained frames, entries, and titles", async () => {
    const chrome = makeChrome();
    const bg = loadBackground(chrome);
    const L = chrome._listeners;
    const tabId = 121;
    await L["tabs.onActivated"]({ tabId });

    await L["runtime.onMessage"](
      {
        type: "grab-videos-detected",
        videos: Array.from({ length: bg.MAX_VIDEO_ITEMS * 4 }, (_, i) => ({
          src: `https://cdn.example.com/v/${i}.mp4`,
          blob: false,
        })),
        title: "x".repeat(bg.MAX_VIDEO_TITLE_LENGTH * 4),
      },
      { tab: { id: tabId, url: "https://example.com/" }, frameId: 0 }
    );

    for (let frameId = 1; frameId < bg.MAX_VIDEO_FRAMES + 10; frameId++) {
      await L["runtime.onMessage"](
        {
          type: "grab-videos-detected",
          videos: [{ src: `https://cdn.example.com/frame-${frameId}.mp4`, blob: false }],
        },
        { tab: { id: tabId, url: "https://example.com/" }, frameId }
      );
    }

    const findings = bg._videoFinds.get(tabId);
    const total = [...findings.frames.values()].reduce((sum, videos) => sum + videos.length, 0);
    assert.ok(findings.frames.size <= bg.MAX_VIDEO_FRAMES, "frame IDs stay bounded");
    assert.ok(total <= bg.MAX_VIDEO_ITEMS, "DOM video entries stay bounded per tab");
    assert.ok(findings.title.length <= bg.MAX_VIDEO_TITLE_LENGTH, "page titles stay bounded");

    const saved = chrome._session.get("videoFinds:v2:" + tabId);
    assert.ok(saved.frames.length <= bg.MAX_VIDEO_FRAMES, "persisted frame IDs stay bounded");
    assert.ok(
      saved.frames.reduce((sum, pair) => sum + pair[1].length, 0) <= bg.MAX_VIDEO_ITEMS,
      "persisted DOM entries stay bounded"
    );
  });

  test("frames without videos do not consume the frame budget", async () => {
    // A page with ad and analytics iframes: every frame reports, but most
    // have no video. Those empty reports must not use up the frame budget,
    // or videos in later frames stop being detected.
    const chrome = makeChrome();
    const bg = loadBackground(chrome);
    const L = chrome._listeners;
    const tabId = 161;
    await L["tabs.onActivated"]({ tabId });

    for (let frameId = 0; frameId < bg.MAX_VIDEO_FRAMES + 8; frameId++) {
      await L["runtime.onMessage"](
        { type: "grab-videos-detected", videos: [] },
        { tab: { id: tabId, url: "https://example.com/" }, frameId },
      );
    }
    assert.equal(
      bg._videoFinds.get(tabId).frames.size,
      0,
      "frames without videos are not tracked at all"
    );
    const lateFrame = bg.MAX_VIDEO_FRAMES + 9;
    await L["runtime.onMessage"](
      {
        type: "grab-videos-detected",
        videos: [{ src: "https://cdn.example.com/late.mp4", blob: false }],
      },
      { tab: { id: tabId, url: "https://example.com/" }, frameId: lateFrame },
    );

    const findings = bg._videoFinds.get(tabId);
    const late = findings.frames.get(lateFrame) || [];
    assert.deepEqual(
      late.map((video) => video.src),
      ["https://cdn.example.com/late.mp4"],
      "a video in a late frame is still detected"
    );
  });

  test("a new frame evicts the oldest frame when the frame budget is full", async () => {
    const chrome = makeChrome();
    const bg = loadBackground(chrome);
    const L = chrome._listeners;
    const tabId = 162;
    await L["tabs.onActivated"]({ tabId });

    // The top frame's video must survive every eviction.
    await L["runtime.onMessage"](
      {
        type: "grab-videos-detected",
        videos: [{ src: "https://cdn.example.com/top.mp4", blob: false }],
      },
      { tab: { id: tabId, url: "https://example.com/" }, frameId: 0 },
    );
    for (let frameId = 1; frameId < bg.MAX_VIDEO_FRAMES; frameId++) {
      await L["runtime.onMessage"](
        {
          type: "grab-videos-detected",
          videos: [{ src: `https://cdn.example.com/v/${frameId}.mp4`, blob: false }],
        },
        { tab: { id: tabId, url: "https://example.com/" }, frameId },
      );
    }
    const newest = bg.MAX_VIDEO_FRAMES;
    await L["runtime.onMessage"](
      {
        type: "grab-videos-detected",
        videos: [{ src: `https://cdn.example.com/v/${newest}.mp4`, blob: false }],
      },
      { tab: { id: tabId, url: "https://example.com/" }, frameId: newest },
    );

    const findings = bg._videoFinds.get(tabId);
    assert.ok(findings.frames.size <= bg.MAX_VIDEO_FRAMES, "frame IDs stay bounded");
    const newestVideos = findings.frames.get(newest) || [];
    assert.deepEqual(
      newestVideos.map((video) => video.src),
      [`https://cdn.example.com/v/${newest}.mp4`],
      "the newest frame is detected even when the budget was full"
    );
    assert.equal(findings.frames.get(1), undefined, "the oldest frame was evicted");
    assert.deepEqual(
      (findings.frames.get(0) || []).map((video) => video.src),
      ["https://cdn.example.com/top.mp4"],
      "the top frame is never evicted"
    );
  });

  test("an empty report from a new frame leaves existing detections untouched", async () => {
    const chrome = makeChrome();
    const bg = loadBackground(chrome);
    const L = chrome._listeners;
    const tabId = 163;
    await L["tabs.onActivated"]({ tabId });

    const manifest = "https://cdn.example.com/one/master.m3u8";
    await L["webRequest.onResponseStarted"]({
      tabId, frameId: 1, url: manifest,
      responseHeaders: [{ name: "content-type", value: "application/vnd.apple.mpegurl" }],
    });
    await L["runtime.onMessage"](
      { type: "grab-videos-detected", videos: [{
        src: null, blob: true, blobUrl: "blob:https://example.com/one",
      }] },
      { tab: { id: tabId, url: "https://example.com/" }, frameId: 1 },
    );
    // Fill the frame budget.
    for (let frameId = 2; frameId <= bg.MAX_VIDEO_FRAMES; frameId++) {
      await L["runtime.onMessage"](
        {
          type: "grab-videos-detected",
          videos: [{ src: `https://cdn.example.com/v/${frameId}.mp4`, blob: false }],
        },
        { tab: { id: tabId, url: "https://example.com/" }, frameId },
      );
    }
    // An empty report from a frame nobody knows must evict nothing.
    await L["runtime.onMessage"](
      { type: "grab-videos-detected", videos: [] },
      { tab: { id: tabId, url: "https://example.com/" }, frameId: 999 },
    );

    const findings = bg._videoFinds.get(tabId);
    assert.equal(
      (findings.frames.get(1) || []).length,
      1,
      "the detected video survives an empty report"
    );
    assert.deepEqual(
      findings.sniffedByFrame.get(1),
      [manifest],
      "the sniffed manifest survives an empty report"
    );
  });

  test("a new frame takes the room of an older frame when the item cap is full", async () => {
    const chrome = makeChrome();
    const bg = loadBackground(chrome);
    const L = chrome._listeners;
    const tabId = 164;
    await L["tabs.onActivated"]({ tabId });

    // The top frame holds nearly every item slot.
    await L["runtime.onMessage"](
      {
        type: "grab-videos-detected",
        videos: Array.from({ length: bg.MAX_VIDEO_ITEMS - 1 }, (_, i) => ({
          src: `https://cdn.example.com/top/${i}.mp4`, blob: false,
        })),
      },
      { tab: { id: tabId, url: "https://example.com/" }, frameId: 0 },
    );
    // One older frame holds the last slot.
    await L["runtime.onMessage"](
      { type: "grab-videos-detected", videos: [{ src: "https://cdn.example.com/old.mp4", blob: false }] },
      { tab: { id: tabId, url: "https://example.com/" }, frameId: 2 },
    );
    // A new frame must still be detected: the older frame yields its slot.
    await L["runtime.onMessage"](
      { type: "grab-videos-detected", videos: [{ src: "https://cdn.example.com/new.mp4", blob: false }] },
      { tab: { id: tabId, url: "https://example.com/" }, frameId: 3 },
    );

    const findings = bg._videoFinds.get(tabId);
    assert.deepEqual(
      (findings.frames.get(3) || []).map((video) => video.src),
      ["https://cdn.example.com/new.mp4"],
      "the new video is detected even though the item cap was full"
    );
    assert.equal(findings.frames.get(2), undefined, "the older frame yielded its slot");
  });

  test("a manifest sniffed before its report survives when the frame budget is full", async () => {
    const chrome = makeChrome();
    const bg = loadBackground(chrome);
    const L = chrome._listeners;
    const tabId = 165;
    await L["tabs.onActivated"]({ tabId });

    for (let frameId = 1; frameId <= bg.MAX_VIDEO_FRAMES; frameId++) {
      await L["webRequest.onResponseStarted"]({
        tabId, frameId, url: `https://cdn.example.com/${frameId}/master.m3u8`,
        responseHeaders: [{ name: "content-type", value: "application/vnd.apple.mpegurl" }],
      });
      await L["runtime.onMessage"](
        { type: "grab-videos-detected", videos: [{
          src: null, blob: true, blobUrl: `blob:https://example.com/${frameId}`,
        }] },
        { tab: { id: tabId, url: "https://example.com/" }, frameId },
      );
    }
    // A new player fetches its manifest before its video element reports.
    const manifest = "https://cdn.example.com/new/master.m3u8";
    await L["webRequest.onResponseStarted"]({
      tabId, frameId: 999, url: manifest,
      responseHeaders: [{ name: "content-type", value: "application/vnd.apple.mpegurl" }],
    });
    await L["runtime.onMessage"](
      { type: "grab-videos-detected", videos: [{
        src: null, blob: true, blobUrl: "blob:https://example.com/new",
      }] },
      { tab: { id: tabId, url: "https://example.com/" }, frameId: 999 },
    );

    assert.deepEqual(
      await bg.resolvedBlobVideoUrlForFrame(tabId, 999),
      manifest,
      "the blob video still resolves to its manifest"
    );
  });

  test("a blob: video is paired with the tab's sniffed manifest", async () => {
    const chrome = makeChrome();
    loadBackground(chrome);
    const L = chrome._listeners;

    await L["tabs.onActivated"]({ tabId: 9 });
    L["webRequest.onResponseStarted"]({
      tabId: 9,
      url: "https://cdn.example.com/s/stream.m3u8",
      responseHeaders: [],
    });
    L["runtime.onMessage"](
      { type: "grab-videos-detected", videos: [{
        src: null, blob: true, blobUrl: "blob:https://example.com/uuid"
      }] },
      { tab: { id: 9 } }
    );
    await tick();

    await L["menus.onClicked"]({ menuItemId: "grabVideo:0" }, null);
    assert.ok(
      chrome._calls.some(
        ([n, url]) => n === "handoff" && url === "https://cdn.example.com/s/stream.m3u8"
      )
    );
  });

  test("blob-video menu survives a worker restart", async () => {
    const shared = {};
    const first = makeChrome(shared);
    loadBackground(first);
    await first._listeners["tabs.onActivated"]({ tabId: 9 });
    await first._listeners["webRequest.onResponseStarted"]({
      tabId: 9,
      url: "https://cdn.example.com/s/stream.m3u8",
      responseHeaders: [],
    });
    await first._listeners["runtime.onMessage"](
      { type: "grab-videos-detected", videos: [{
        src: null, blob: true, blobUrl: "blob:https://example.com/uuid",
        title: "Player-specific title",
      }], title: "Live stream" },
      { tab: { id: 9 }, frameId: 0 }
    );
    await tick();
    const saved = shared.session.get("videoFinds:v2:9");
    assert.ok(saved, "per-tab findings are persisted in session storage");
    assert.equal(saved.version, 3);
    assert.ok(saved.observations[0][1].some(([url, flags, kind]) =>
      url === "https://cdn.example.com/s/stream.m3u8" && (flags & 1) === 1 && kind === "manifest"));
    assert.equal(saved.frames[0][1][0].blobUrl, "blob:https://example.com/uuid");

    const restarted = makeChrome(shared);
    restarted.tabs.query = (q, cb) => cb([{ id: 9 }]);
    const restartedBg = loadBackground(restarted);
    await restartedBg._restoreVideoFinds(9);
    assert.equal(
      restartedBg._videoFinds.get(9).frames.get(0)[0].title,
      "Player-specific title",
      "per-video title is restored before the next page report",
    );
    await restarted._listeners["runtime.onMessage"](
      { type: "grab-videos-detected", videos: [{
        src: null, blob: true, blobUrl: "blob:https://example.com/uuid"
      }], title: "Live stream" },
      { tab: { id: 9 }, frameId: 0 }
    );
    await tick();
    assert.ok(
      restarted._calls.some(([name, id]) => name === "menus.create" && id === "grabVideo:0"),
      "the menu retains the stream URL after restart"
    );
    await restarted._listeners["menus.onClicked"]({ menuItemId: "grabVideo:0" }, { id: 9 });
    assert.ok(
      restarted._calls.some(([name, url]) => name === "handoff" && url === "https://cdn.example.com/s/stream.m3u8"),
      "the restored menu entry hands the manifest to Grab"
    );
  });



  test("legacy blob click fallback requires one video in the source frame", () => {
    const bg = loadBackground(makeChrome());
    bg._videoFinds.set(146, {
      frames: new Map([[4, [
        { src: "https://cdn.example.com/only.mp4", blob: false },
      ]]]),
      sniffedByFrame: new Map(),
      kindsByFrame: new Map(),
      title: "",
    });
    assert.equal(
      bg.findVideoForSource(146, "blob:https://example.com/legacy", 4).video.src,
      "https://cdn.example.com/only.mp4",
    );

    bg._videoFinds.set(147, {
      frames: new Map([[4, [
        { src: "https://cdn.example.com/one.mp4", blob: false },
        { src: "https://cdn.example.com/two.mp4", blob: false },
      ]]]),
      sniffedByFrame: new Map(),
      kindsByFrame: new Map(),
      title: "",
    });
    assert.equal(bg.findVideoForSource(147, "blob:https://example.com/ambiguous", 4), null);
  });


  test("anonymous blob reports remain separate and cannot be treated as one player", async () => {
    const chrome = makeChrome();
    const bg = loadBackground(chrome);
    const L = chrome._listeners;
    const tabId = 149;
    await L["runtime.onMessage"](
      {
        type: "grab-videos-detected",
        videos: [
          { src: null, blob: true },
          { src: null, blob: true },
        ],
      },
      { tab: { id: tabId, url: "https://example.com/" }, frameId: 0 },
    );

    const videos = bg._videoFinds.get(tabId).frames.get(0);
    assert.equal(videos.length, 2);
    assert.equal(await bg.resolvedBlobVideoUrlForFrame(tabId, 0), null);
    assert.equal(bg.findVideoForSource(tabId, "blob:https://example.com/unknown", 0), null);
  });

  test("network manifests stay associated with their originating frame", async () => {
    const chrome = makeChrome();
    const bg = loadBackground(chrome);
    const L = chrome._listeners;
    const tabId = 141;
    const manifest = "https://cdn.example.com/frame-7/master.m3u8";
    await L["tabs.onActivated"]({ tabId });
    await L["webRequest.onResponseStarted"]({
      tabId, frameId: 7, url: manifest,
      responseHeaders: [{ name: "content-type", value: "application/vnd.apple.mpegurl" }],
    });
    await L["runtime.onMessage"](
      { type: "grab-videos-detected", videos: [{
        src: null, blob: true, blobUrl: "blob:https://example.com/top"
      }] },
      { tab: { id: tabId, url: "https://example.com/" }, frameId: 0 },
    );
    assert.deepEqual(await bg.resolvedVideoUrlsForFrame(tabId, 0), []);
    await L["runtime.onMessage"](
      { type: "grab-videos-detected", videos: [{
        src: null, blob: true, blobUrl: "blob:https://embed.example.com/player"
      }] },
      { tab: { id: tabId, url: "https://example.com/" }, frameId: 7 },
    );
    assert.deepEqual(await bg.resolvedVideoUrlsForFrame(tabId, 7), [manifest]);
    assert.deepEqual(await bg.resolvedVideoUrls(tabId), [manifest]);
  });


  test("pause hides a blob manifest without discarding it, and resume restores it", async () => {
    const chrome = makeChrome();
    const bg = loadBackground(chrome);
    const L = chrome._listeners;
    const tabId = 145;
    const manifest = "https://cdn.example.com/session/master.m3u8";
    const video = {
      src: null, blob: true, blobUrl: "blob:https://example.com/first"
    };
    const sender = { tab: { id: tabId, url: "https://example.com/" }, frameId: 0 };

    await L["webRequest.onResponseStarted"]({
      tabId, frameId: 0, url: manifest,
      responseHeaders: [{ name: "content-type", value: "application/vnd.apple.mpegurl" }],
    });
    await L["runtime.onMessage"](
      { type: "grab-videos-detected", videos: [video] },
      sender,
    );
    assert.deepEqual(await bg.resolvedBlobVideoUrlForFrame(tabId, 0), manifest);

    await L["runtime.onMessage"](
      { type: "grab-videos-detected", videos: [], replaceFrame: true, lifecycle: "pause", lifecycleSource: "blob:https://example.com/first" },
      sender,
    );
    const finds = bg._videoFinds.get(tabId);
    assert.equal(finds.frames.has(0), false, "paused DOM snapshot is retired");
    assert.ok(finds.retiredFrames.has(0), "frame is marked retired");
    assert.deepEqual(finds.sniffedByFrame.get(0), [manifest], "manifest is retained");
    assert.deepEqual(await bg.resolvedVideoUrls(tabId), [], "paused stream is hidden from the menu");

    await L["runtime.onMessage"](
      { type: "grab-videos-detected", videos: [video] },
      sender,
    );
    assert.equal(finds.retiredFrames.has(0), false, "resume clears the paused marker");
    assert.deepEqual(await bg.resolvedBlobVideoUrlForFrame(tabId, 0), manifest);
    assert.deepEqual(await bg.resolvedVideoUrls(tabId), [manifest]);
  });

  test("a re-sniff of the same manifest path keeps the first request time and latest URL", async () => {
    const shared = {};
    const chrome = makeChrome(shared);
    const bg = loadBackground(chrome);
    const L = chrome._listeners;
    const tabId = 188;
    const first = "https://cdn.example.com/player/master.m3u8?token=first";
    const refreshed = "https://cdn.example.com/player/master.m3u8?token=rotated";
    const firstSeenAt = Date.now() - 90_000;
    const video = {
      src: null,
      blob: true,
      blobUrl: "blob:https://example.com/refreshed",
      elementId: 31,
      loadStartedAt: Date.now(),
    };
    const sender = { tab: { id: tabId, url: "https://example.com/" }, frameId: 0 };

    await L["webRequest.onResponseStarted"]({
      tabId, frameId: 0, url: first, timeStamp: firstSeenAt,
      responseHeaders: [{ name: "content-type", value: "application/vnd.apple.mpegurl" }],
    });
    await L["runtime.onMessage"](
      { type: "grab-videos-detected", videos: [video] }, sender,
    );
    const finds = bg._videoFinds.get(tabId);
    const key = bg.videoUrlIdentityKey(first);
    const initialSequence = finds.sniffSequencesByFrame.get(0).get(key);
    assert.equal(finds.sniffFirstSeenByFrame.get(0).get(key), firstSeenAt);
    assert.equal(await bg.resolvedBlobVideoUrlForFrame(tabId, 0), first);

    await L["webRequest.onResponseStarted"]({
      tabId, frameId: 0, url: refreshed, timeStamp: Date.now(),
      responseHeaders: [{ name: "content-type", value: "application/vnd.apple.mpegurl" }],
    });
    assert.deepEqual(finds.sniffedByFrame.get(0), [refreshed]);
    assert.equal(finds.sniffTimesByFrame.get(0).get(key) > firstSeenAt, true);
    assert.equal(finds.sniffFirstSeenByFrame.get(0).get(key), firstSeenAt);
    assert.equal(finds.sniffSequencesByFrame.get(0).get(key), initialSequence);
    assert.equal(await bg.resolvedBlobVideoUrlForFrame(tabId, 0), refreshed);

    await bg._persistVideoFinds(tabId);
    const restoredBg = loadBackground(makeChrome(shared));
    await restoredBg._restoreVideoFinds(tabId);
    assert.equal(
      restoredBg._videoFinds.get(tabId).sniffFirstSeenByFrame.get(0).get(key),
      firstSeenAt,
    );
  });

  test("pause and resume of the same blob before the debounced report keeps the manifest", async () => {
    const chrome = makeChrome();
    const bg = loadBackground(chrome);
    const L = chrome._listeners;
    const tabId = 168;
    const manifest = "https://cdn.example.com/session/master.m3u8";
    const video = { src: null, blob: true, blobUrl: "blob:https://example.com/debounce" };
    const sender = { tab: { id: tabId, url: "https://example.com/" }, frameId: 0 };

    await L["webRequest.onResponseStarted"]({
      tabId, frameId: 0, url: manifest,
      responseHeaders: [{ name: "content-type", value: "application/vnd.apple.mpegurl" }],
    });
    await L["runtime.onMessage"]({ type: "grab-videos-detected", videos: [video] }, sender);
    // pause then play within the 400 ms content-script debounce is represented
    // by one active report carrying the coalesced pause lifecycle.
    await L["runtime.onMessage"](
      {
        type: "grab-videos-detected",
        videos: [video],
        replaceFrame: true,
        lifecycle: "pause",
        lifecycleSource: video.blobUrl,
        lifecycleAt: Date.now(),
      },
      sender,
    );
    assert.deepEqual(await bg.resolvedBlobVideoUrlForFrame(tabId, 0), manifest);
    assert.equal(bg._videoFinds.get(tabId).retiredFrames.has(0), false);
  });

  test("pause and resume of the same blob after the debounced report keeps the manifest", async () => {
    const chrome = makeChrome();
    const bg = loadBackground(chrome);
    const L = chrome._listeners;
    const tabId = 169;
    const manifest = "https://cdn.example.com/session/master.m3u8";
    const video = { src: null, blob: true, blobUrl: "blob:https://example.com/delayed" };
    const sender = { tab: { id: tabId, url: "https://example.com/" }, frameId: 0 };

    await L["webRequest.onResponseStarted"]({
      tabId, frameId: 0, url: manifest,
      responseHeaders: [{ name: "content-type", value: "application/vnd.apple.mpegurl" }],
    });
    await L["runtime.onMessage"]({ type: "grab-videos-detected", videos: [video] }, sender);
    await L["runtime.onMessage"](
      {
        type: "grab-videos-detected",
        videos: [],
        replaceFrame: true,
        lifecycle: "pause",
        lifecycleSource: video.blobUrl,
        lifecycleAt: Date.now(),
      },
      sender,
    );
    await new Promise((resolve) => setTimeout(resolve, 425));
    await L["runtime.onMessage"]({ type: "grab-videos-detected", videos: [video] }, sender);
    assert.deepEqual(await bg.resolvedBlobVideoUrlForFrame(tabId, 0), manifest);
  });

  test("a repeated pause report preserves the already-paused blob manifest", async () => {
    const chrome = makeChrome();
    const bg = loadBackground(chrome);
    const L = chrome._listeners;
    const tabId = 157;
    const manifest = "https://cdn.example.com/session/master.m3u8";
    const video = {
      src: null, blob: true, blobUrl: "blob:https://example.com/repeated-pause"
    };
    const sender = { tab: { id: tabId, url: "https://example.com/" }, frameId: 0 };
    const pause = {
      type: "grab-videos-detected",
      videos: [],
      replaceFrame: true,
      lifecycle: "pause",
      lifecycleSource: video.blobUrl,
    };

    await L["webRequest.onResponseStarted"]({
      tabId, frameId: 0, url: manifest,
      responseHeaders: [{ name: "content-type", value: "application/vnd.apple.mpegurl" }],
    });
    await L["runtime.onMessage"]({ type: "grab-videos-detected", videos: [video] }, sender);
    await L["runtime.onMessage"](pause, sender);
    await L["runtime.onMessage"](pause, sender);

    const finds = bg._videoFinds.get(tabId);
    assert.equal(finds.retiredFrames.get(0).source, video.blobUrl);
    assert.deepEqual(finds.sniffedByFrame.get(0), [manifest]);
    assert.deepEqual(await bg.resolvedVideoUrls(tabId), []);
  });

  test("a coalesced pause report preserves the same still-active blob player", async () => {
    const chrome = makeChrome();
    const bg = loadBackground(chrome);
    const L = chrome._listeners;
    const tabId = 153;
    const manifest = "https://cdn.example.com/session/master.m3u8";
    const video = {
      src: null, blob: true, blobUrl: "blob:https://example.com/same-player"
    };
    const sender = { tab: { id: tabId, url: "https://example.com/" }, frameId: 0 };

    await L["webRequest.onResponseStarted"]({
      tabId, frameId: 0, url: manifest,
      responseHeaders: [{ name: "content-type", value: "application/vnd.apple.mpegurl" }],
    });
    await L["runtime.onMessage"](
      { type: "grab-videos-detected", videos: [video] }, sender,
    );

    await L["runtime.onMessage"](
      { type: "grab-videos-detected", videos: [video], replaceFrame: true, lifecycle: "pause", lifecycleSource: "blob:https://example.com/same-player" },
      sender,
    );
    const finds = bg._videoFinds.get(tabId);
    assert.deepEqual(finds.sniffedByFrame.get(0), [manifest]);
    assert.equal(finds.retiredFrames.has(0), false, "the same active player is not left hidden");
    assert.deepEqual(await bg.resolvedBlobVideoUrlForFrame(tabId, 0), manifest);
  });

  test("a pause in a multi-player frame does not retain ambiguous manifests", async () => {
    const chrome = makeChrome();
    const bg = loadBackground(chrome);
    const L = chrome._listeners;
    const tabId = 154;
    const pausedManifest = "https://cdn.example.com/paused/master.m3u8";
    const activeManifest = "https://cdn.example.com/active/master.m3u8";
    const pausedVideo = {
      src: null, blob: true, blobUrl: "blob:https://example.com/paused"
    };
    const activeVideo = {
      src: null, blob: true, blobUrl: "blob:https://example.com/active"
    };
    const sender = { tab: { id: tabId, url: "https://example.com/" }, frameId: 0 };

    for (const url of [pausedManifest, activeManifest]) {
      await L["webRequest.onResponseStarted"]({
        tabId, frameId: 0, url,
        responseHeaders: [{ name: "content-type", value: "application/vnd.apple.mpegurl" }],
      });
    }
    await L["runtime.onMessage"](
      { type: "grab-videos-detected", videos: [pausedVideo, activeVideo] }, sender,
    );
    await L["runtime.onMessage"](
      {
        type: "grab-videos-detected",
        videos: [activeVideo],
        replaceFrame: true,
        lifecycle: "pause",
        lifecycleSource: pausedVideo.blobUrl,
      },
      sender,
    );

    const finds = bg._videoFinds.get(tabId);
    assert.deepEqual(finds.frames.get(0), [activeVideo]);
    assert.equal(finds.sniffedByFrame.has(0), false, "ambiguous frame manifests are discarded");
    assert.equal(finds.retiredFrames.has(0), false);
  });

  test("an unrelated video reset does not clear the sole active blob player's manifest", async () => {
    const chrome = makeChrome();
    const bg = loadBackground(chrome);
    const L = chrome._listeners;
    const tabId = 155;
    const manifest = "https://cdn.example.com/session/master.m3u8";
    const blobVideo = {
      src: null, blob: true, blobUrl: "blob:https://example.com/main-player"
    };
    const sender = { tab: { id: tabId, url: "https://example.com/" }, frameId: 0 };

    await L["webRequest.onResponseStarted"]({
      tabId, frameId: 0, url: manifest,
      responseHeaders: [{ name: "content-type", value: "application/vnd.apple.mpegurl" }],
    });
    await L["runtime.onMessage"]({ type: "grab-videos-detected", videos: [blobVideo] }, sender);
    await L["runtime.onMessage"](
      {
        type: "grab-videos-detected",
        videos: [blobVideo],
        replaceFrame: true,
        lifecycle: "reset",
        lifecycleSource: "https://cdn.example.com/preview-ad.mp4",
      },
      sender,
    );

    const finds = bg._videoFinds.get(tabId);
    assert.deepEqual(finds.sniffedByFrame.get(0), [manifest]);
    assert.deepEqual(finds.frames.get(0), [blobVideo]);
    assert.deepEqual(await bg.resolvedBlobVideoUrlForFrame(tabId, 0), manifest);
  });

  test("a source reset still clears retained frame manifests", async () => {
    const chrome = makeChrome();
    const bg = loadBackground(chrome);
    const L = chrome._listeners;
    const tabId = 150;
    const manifest = "https://cdn.example.com/session/master.m3u8";
    const sender = { tab: { id: tabId, url: "https://example.com/" }, frameId: 0 };

    await L["webRequest.onResponseStarted"]({
      tabId, frameId: 0, url: manifest,
      responseHeaders: [{ name: "content-type", value: "application/vnd.apple.mpegurl" }],
    });
    await L["runtime.onMessage"](
      { type: "grab-videos-detected", videos: [{
        src: null, blob: true, blobUrl: "blob:https://example.com/first"
      }] },
      sender,
    );
    await L["runtime.onMessage"](
      { type: "grab-videos-detected", videos: [], replaceFrame: true, lifecycle: "pause", lifecycleSource: "blob:https://example.com/first" },
      sender,
    );
    assert.deepEqual(bg._videoFinds.get(tabId).sniffedByFrame.get(0), [manifest]);

    await L["runtime.onMessage"](
      { type: "grab-videos-detected", videos: [], replaceFrame: true, lifecycle: "reset", lifecycleSource: "blob:https://example.com/first" },
      sender,
    );
    const finds = bg._videoFinds.get(tabId);
    assert.deepEqual(finds.sniffedByFrame.get(0), [manifest]);
    assert.ok(finds.retiredFrames.has(0), "reset retains observations but retires the frame");
    assert.deepEqual(await bg.resolvedVideoUrls(tabId), []);
  });

  test("paused frame markers remain within the shared frame budget", async () => {
    const chrome = makeChrome();
    const bg = loadBackground(chrome);
    const L = chrome._listeners;
    const tabId = 152;
    const sender = { tab: { id: tabId, url: "https://example.com/" } };

    for (let frameId = 0; frameId <= bg.MAX_VIDEO_FRAMES + 2; frameId += 1) {
      const source = `blob:https://example.com/player-${frameId}`;
      const frameSender = { ...sender, frameId };
      await L["runtime.onMessage"](
        {
          type: "grab-videos-detected",
          videos: [{ src: null, blob: true, blobUrl: source }],
        },
        frameSender,
      );
      await L["runtime.onMessage"](
        {
          type: "grab-videos-detected",
          videos: [],
          replaceFrame: true,
          lifecycle: "pause",
          lifecycleSource: source,
        },
        frameSender,
      );
    }

    const finds = bg._videoFinds.get(tabId);
    assert.equal(finds.retiredFrames.size, bg.MAX_VIDEO_FRAMES);
    assert.ok(finds.retiredFrames.has(0), "the top frame remains tracked");
    assert.ok(finds.retiredFrames.has(bg.MAX_VIDEO_FRAMES + 2), "the newest frame is retained");
    assert.ok(!finds.retiredFrames.has(1), "the oldest non-top frame is evicted");
  });

  test("a different blob URL without a new manifest retains the previous stream candidate", async () => {
    const chrome = makeChrome();
    const bg = loadBackground(chrome);
    const L = chrome._listeners;
    const tabId = 156;
    const manifest = "https://cdn.example.com/old/master.m3u8";
    const oldVideo = {
      src: null, blob: true, blobUrl: "blob:https://example.com/old-player"
    };
    const newVideo = {
      src: null, blob: true, blobUrl: "blob:https://example.com/new-player"
    };
    const sender = { tab: { id: tabId, url: "https://example.com/" }, frameId: 0 };

    await L["webRequest.onResponseStarted"]({
      tabId, frameId: 0, url: manifest,
      responseHeaders: [{ name: "content-type", value: "application/vnd.apple.mpegurl" }],
    });
    await L["runtime.onMessage"](
      { type: "grab-videos-detected", videos: [oldVideo] }, sender,
    );
    await L["runtime.onMessage"](
      {
        type: "grab-videos-detected",
        videos: [],
        replaceFrame: true,
        lifecycle: "pause",
        lifecycleSource: oldVideo.blobUrl,
      },
      sender,
    );
    assert.deepEqual(bg._videoFinds.get(tabId).sniffedByFrame.get(0), [manifest]);

    await L["runtime.onMessage"](
      { type: "grab-videos-detected", videos: [newVideo] }, sender,
    );
    const finds = bg._videoFinds.get(tabId);
    assert.equal(finds.retiredFrames.has(0), false);
    assert.deepEqual(finds.sniffedByFrame.get(0), [manifest]);
    assert.deepEqual(await bg.resolvedVideoUrls(tabId), [manifest]);
  });

  test("paused blob manifest state survives a worker restart and resumes cleanly", async () => {
    const shared = {};
    const tabId = 151;
    const manifest = "https://cdn.example.com/session/master.m3u8";
    const video = {
      src: null, blob: true, blobUrl: "blob:https://example.com/first"
    };
    const sender = { tab: { id: tabId, url: "https://example.com/" }, frameId: 0 };
    const first = makeChrome(shared);
    loadBackground(first);

    await first._listeners["webRequest.onResponseStarted"]({
      tabId, frameId: 0, url: manifest,
      responseHeaders: [{ name: "content-type", value: "application/vnd.apple.mpegurl" }],
    });
    await first._listeners["runtime.onMessage"](
      { type: "grab-videos-detected", videos: [video] }, sender,
    );
    await first._listeners["runtime.onMessage"](
      { type: "grab-videos-detected", videos: [], replaceFrame: true, lifecycle: "pause", lifecycleSource: "blob:https://example.com/first" },
      sender,
    );
    await tick();
    const saved = shared.session.get("videoFinds:v2:" + tabId);
    assert.deepEqual(saved.retiredFrames.map(([frameId, retired]) => [
      frameId, retired.source, retired.retiredAtSeq,
    ]), [[0, video.blobUrl, saved.sniffSequence]]);
    assert.ok(saved.observations[0][1].some(([url, flags]) =>
      url === manifest && (flags & 1) === 1));

    const restarted = makeChrome(shared);
    const restartedBg = loadBackground(restarted);
    await restartedBg._restoreVideoFinds(tabId);
    assert.equal(restartedBg._videoFinds.get(tabId).retiredFrames.get(0).source, video.blobUrl);
    assert.deepEqual(await restartedBg.resolvedVideoUrls(tabId), []);

    await restarted._listeners["runtime.onMessage"](
      { type: "grab-videos-detected", videos: [video] }, sender,
    );
    assert.deepEqual(await restartedBg.resolvedVideoUrls(tabId), [manifest]);
  });

  test("reset with no new manifest keeps the previous manifest for a reattached blob", async () => {
    const chrome = makeChrome();
    const bg = loadBackground(chrome);
    const L = chrome._listeners;
    const tabId = 160;
    const manifest = "https://cdn.example.com/old/master.m3u8";
    const oldVideo = {
      src: null, blob: true, blobUrl: "blob:https://example.com/old"
    };
    const newVideo = {
      src: null, blob: true, blobUrl: "blob:https://example.com/reattached"
    };
    const sender = { tab: { id: tabId, url: "https://example.com/" }, frameId: 0 };
    const resetAt = Date.now();

    await L["webRequest.onResponseStarted"]({
      tabId, frameId: 0, url: manifest, timeStamp: resetAt - 100,
      responseHeaders: [{ name: "content-type", value: "application/vnd.apple.mpegurl" }],
    });
    await L["runtime.onMessage"]({ type: "grab-videos-detected", videos: [oldVideo] }, sender);
    await L["runtime.onMessage"](
      {
        type: "grab-videos-detected",
        videos: [],
        replaceFrame: true,
        lifecycle: "reset",
        lifecycleSource: oldVideo.blobUrl,
        lifecycleAt: resetAt,
      },
      sender,
    );

    assert.deepEqual(await bg.resolvedVideoUrls(tabId), []);
    await L["runtime.onMessage"](
      { type: "grab-videos-detected", videos: [newVideo] }, sender,
    );
    assert.equal(bg._videoFinds.get(tabId).retiredFrames.has(0), false);
    assert.deepEqual(await bg.resolvedBlobVideoUrlForFrame(tabId, 0), manifest);
  });

  test("reset drops pre-reset manifest but keeps a manifest sniffed before the new blob reports", async () => {
    const chrome = makeChrome();
    const bg = loadBackground(chrome);
    const L = chrome._listeners;
    const tabId = 161;
    const oldManifest = "https://cdn.example.com/old/master.m3u8";
    const newManifest = "https://cdn.example.com/new/master.m3u8";
    const oldVideo = {
      src: null, blob: true, blobUrl: "blob:https://example.com/old"
    };
    const newVideo = {
      src: null, blob: true, blobUrl: "blob:https://example.com/new"
    };
    const sender = { tab: { id: tabId, url: "https://example.com/" }, frameId: 0 };

    await L["webRequest.onResponseStarted"]({
      tabId, frameId: 0, url: oldManifest,
      responseHeaders: [{ name: "content-type", value: "application/vnd.apple.mpegurl" }],
    });
    await L["runtime.onMessage"]({ type: "grab-videos-detected", videos: [oldVideo] }, sender);
    const resetAt = Date.now();
    await L["runtime.onMessage"](
      {
        type: "grab-videos-detected",
        videos: [],
        replaceFrame: true,
        lifecycle: "reset",
        lifecycleSource: oldVideo.blobUrl,
        lifecycleAt: resetAt,
      },
      sender,
    );

    await L["webRequest.onResponseStarted"]({
      tabId, frameId: 0, url: newManifest, timeStamp: resetAt + 25,
      responseHeaders: [{ name: "content-type", value: "application/vnd.apple.mpegurl" }],
    });
    await L["runtime.onMessage"](
      { type: "grab-videos-detected", videos: [newVideo] }, sender,
    );
    assert.deepEqual(bg._videoFinds.get(tabId).sniffedByFrame.get(0), [newManifest]);
    assert.deepEqual(await bg.resolvedBlobVideoUrlForFrame(tabId, 0), newManifest);
  });

  test("pause A, sniff B, then play B keeps B and drops A", async () => {
    const chrome = makeChrome();
    const bg = loadBackground(chrome);
    const L = chrome._listeners;
    const tabId = 162;
    const manifestA = "https://cdn.example.com/a/master.m3u8";
    const manifestB = "https://cdn.example.com/b/master.m3u8";
    const videoA = { src: null, blob: true, blobUrl: "blob:https://example.com/player-a" };
    const videoB = { src: null, blob: true, blobUrl: "blob:https://example.com/player-b" };
    const sender = { tab: { id: tabId, url: "https://example.com/" }, frameId: 0 };

    await L["webRequest.onResponseStarted"]({
      tabId, frameId: 0, url: manifestA, timeStamp: Date.now() - 100,
      responseHeaders: [{ name: "content-type", value: "application/vnd.apple.mpegurl" }],
    });
    await L["runtime.onMessage"]({ type: "grab-videos-detected", videos: [videoA] }, sender);

    const pauseAt = Date.now();
    await L["webRequest.onResponseStarted"]({
      tabId, frameId: 0, url: manifestB, timeStamp: pauseAt + 25,
      responseHeaders: [{ name: "content-type", value: "application/vnd.apple.mpegurl" }],
    });
    await L["runtime.onMessage"](
      {
        type: "grab-videos-detected",
        videos: [],
        replaceFrame: true,
        lifecycle: "pause",
        lifecycleSource: videoA.blobUrl,
        lifecycleAt: pauseAt,
      },
      sender,
    );
    await L["runtime.onMessage"]({ type: "grab-videos-detected", videos: [videoB] }, sender);

    assert.deepEqual(bg._videoFinds.get(tabId).sniffedByFrame.get(0), [manifestB]);
    assert.deepEqual(await bg.resolvedBlobVideoUrlForFrame(tabId, 0), manifestB);
  });

  test("60 mp4 media sniffs cannot evict the manifest and remain in a bounded ring", async () => {
    const chrome = makeChrome();
    const bg = loadBackground(chrome);
    const L = chrome._listeners;
    const tabId = 163;
    const manifest = "https://cdn.example.com/live/master.m3u8";
    const sender = { tab: { id: tabId, url: "https://example.com/" }, frameId: 0 };

    await L["webRequest.onResponseStarted"]({
      tabId, frameId: 0, url: manifest,
      responseHeaders: [{ name: "content-type", value: "application/vnd.apple.mpegurl" }],
    });
    for (let i = 0; i < 60; i += 1) {
      await L["webRequest.onResponseStarted"]({
        tabId,
        frameId: 0,
        url: `https://cdn.example.com/live/segment-${i}.mp4`,
        responseHeaders: [{ name: "content-type", value: "video/mp4" }],
      });
    }

    const finds = bg._videoFinds.get(tabId);
    assert.deepEqual(finds.sniffedByFrame.get(0), [manifest]);
    assert.equal(finds.mediaByFrame.get(0).length, 8);
    assert.equal(finds.sniffSequence, 61);
  });

  test("retired frame markers expire and remove only pre-retirement observations", async () => {
    const chrome = makeChrome();
    const bg = loadBackground(chrome);
    const L = chrome._listeners;
    const tabId = 164;
    const oldManifest = "https://cdn.example.com/old/master.m3u8";
    const newManifest = "https://cdn.example.com/new/master.m3u8";
    const video = {
      src: null, blob: true, blobUrl: "blob:https://example.com/old"
    };
    const sender = { tab: { id: tabId, url: "https://example.com/" }, frameId: 0 };

    await L["webRequest.onResponseStarted"]({
      tabId, frameId: 0, url: oldManifest,
      responseHeaders: [{ name: "content-type", value: "application/vnd.apple.mpegurl" }],
    });
    await L["runtime.onMessage"]({ type: "grab-videos-detected", videos: [video] }, sender);
    await L["runtime.onMessage"](
      {
        type: "grab-videos-detected",
        videos: [],
        replaceFrame: true,
        lifecycle: "reset",
        lifecycleSource: video.blobUrl,
        lifecycleAt: Date.now(),
      },
      sender,
    );
    const finds = bg._videoFinds.get(tabId);
    const retired = finds.retiredFrames.get(0);
    finds.retiredFrames.set(0, { ...retired, retiredAt: Date.now() - 6 * 60 * 1000 });
    await L["webRequest.onResponseStarted"]({
      tabId, frameId: 0, url: newManifest,
      responseHeaders: [{ name: "content-type", value: "application/vnd.apple.mpegurl" }],
    });
    assert.equal(finds.retiredFrames.has(0), true,
      "expired retirement metadata is kept until a new video report arrives");
    assert.equal(finds.retiredFrames.get(0).expired, true);
    assert.deepEqual(finds.sniffedByFrame.get(0), [oldManifest, newManifest]);

    const replacement = {
      src: null, blob: true, blobUrl: "blob:https://example.com/replacement",
    };
    await L["runtime.onMessage"](
      { type: "grab-videos-detected", videos: [replacement] },
      sender,
    );
    assert.equal(finds.retiredFrames.has(0), false);
    assert.deepEqual(finds.sniffedByFrame.get(0), [newManifest]);
  });

  test("a same-blob resume after more than five minutes keeps its manifest", async () => {
    const chrome = makeChrome();
    const bg = loadBackground(chrome);
    const L = chrome._listeners;
    const tabId = 170;
    const manifest = "https://cdn.example.com/live/master.m3u8";
    const video = { src: null, blob: true, blobUrl: "blob:https://example.com/expired" };
    const sender = { tab: { id: tabId, url: "https://example.com/" }, frameId: 0 };

    await L["webRequest.onResponseStarted"]({
      tabId, frameId: 0, url: manifest,
      responseHeaders: [{ name: "content-type", value: "application/vnd.apple.mpegurl" }],
    });
    await L["runtime.onMessage"](
      { type: "grab-videos-detected", videos: [video] }, sender,
    );
    await L["runtime.onMessage"](
      {
        type: "grab-videos-detected",
        videos: [],
        replaceFrame: true,
        lifecycle: "pause",
        lifecycleSource: video.blobUrl,
        lifecycleAt: Date.now(),
      },
      sender,
    );

    const finds = bg._videoFinds.get(tabId);
    finds.retiredFrames.get(0).retiredAt = Date.now() - 6 * 60 * 1000;
    assert.deepEqual(await bg.resolvedVideoUrls(tabId), [],
      "the paused video remains hidden after expiry");
    assert.equal(finds.retiredFrames.get(0).expired, true);
    assert.deepEqual(finds.sniffedByFrame.get(0), [manifest],
      "the manifest is retained while identity is unknown");

    await L["runtime.onMessage"](
      { type: "grab-videos-detected", videos: [video] }, sender,
    );
    assert.equal(finds.retiredFrames.has(0), false);
    assert.deepEqual(await bg.resolvedBlobVideoUrlForFrame(tabId, 0), manifest);
    assert.deepEqual(await bg.resolvedVideoUrls(tabId), [manifest]);
  });

  test("pausing one player preserves the uniquely attributed manifest of another active player", async () => {
    const chrome = makeChrome();
    const bg = loadBackground(chrome);
    const L = chrome._listeners;
    const tabId = 189;
    const now = Date.now();
    const manifestA = "https://cdn.example.com/player-a/master.m3u8";
    const manifestB = "https://cdn.example.com/player-b/master.m3u8";
    const pathKey = (url) => {
      const parsed = new URL(url);
      return parsed.origin + parsed.pathname;
    };
    const videoA = {
      src: null, blob: true, blobUrl: "blob:https://example.com/player-a",
      elementId: 41, loadStartedAt: now - 3_000,
    };
    const videoB = {
      src: null, blob: true, blobUrl: "blob:https://example.com/player-b",
      elementId: 42, loadStartedAt: now - 1_000,
    };
    const sender = { tab: { id: tabId, url: "https://example.com/" }, frameId: 0 };

    for (const [url, timeStamp] of [
      [manifestA, now - 2_900],
      [manifestB, now - 900],
    ]) {
      await L["webRequest.onResponseStarted"]({
        tabId, frameId: 0, url, timeStamp,
        responseHeaders: [{ name: "content-type", value: "application/vnd.apple.mpegurl" }],
      });
    }
    await L["runtime.onMessage"](
      { type: "grab-videos-detected", videos: [videoA, videoB] }, sender,
    );
    const beforePause = bg._videoFinds.get(tabId);
    const previousVideos = beforePause.frames.get(0);
    const firstSeen = beforePause.sniffFirstSeenByFrame.get(0);
    assert.equal(firstSeen.get(pathKey(manifestA)), now - 2_900);
    assert.equal(firstSeen.get(pathKey(manifestB)), now - 900);
    assert.deepEqual(
      bg.attributedManifestUrlsForVideo(
        previousVideos, previousVideos[0], [manifestA],
        beforePause.sniffTimesByFrame.get(0), firstSeen,
      ),
      [manifestA],
    );
    assert.deepEqual(
      bg.attributedManifestUrlsForVideo(
        previousVideos, previousVideos[1], [manifestB],
        beforePause.sniffTimesByFrame.get(0), firstSeen,
      ),
      [manifestB],
    );
    assert.deepEqual(
      [...bg.preservedSniffsForOtherPlayers(
        beforePause, 0,
        { source: videoA.blobUrl, previousVideos },
        [previousVideos[1]],
      )],
      [pathKey(manifestB)],
    );
    await L["runtime.onMessage"](
      {
        type: "grab-videos-detected",
        videos: [videoB],
        replaceFrame: true,
        lifecycle: "pause",
        lifecycleSource: videoA.blobUrl,
        lifecycleAt: now,
      },
      sender,
    );

    const finds = bg._videoFinds.get(tabId);
    assert.deepEqual(finds.frames.get(0), [videoB]);
    assert.equal(finds.retiredFrames.has(0), false);
    assert.deepEqual(finds.sniffedByFrame.get(0), [manifestB]);
    assert.deepEqual(await bg.resolvedBlobVideoUrlForFrame(tabId, 0, finds.frames.get(0)[0]), manifestB);
  });

  test("pause with multiple active videos deliberately drops ambiguous retained manifests", async () => {
    const chrome = makeChrome();
    const bg = loadBackground(chrome);
    const L = chrome._listeners;
    const tabId = 165;
    const manifest = "https://cdn.example.com/ambiguous/master.m3u8";
    const videoA = { src: null, blob: true, blobUrl: "blob:https://example.com/a" };
    const videoB = { src: null, blob: true, blobUrl: "blob:https://example.com/b" };
    const sender = { tab: { id: tabId, url: "https://example.com/" }, frameId: 0 };

    await L["webRequest.onResponseStarted"]({
      tabId, frameId: 0, url: manifest,
      responseHeaders: [{ name: "content-type", value: "application/vnd.apple.mpegurl" }],
    });
    await L["runtime.onMessage"](
      { type: "grab-videos-detected", videos: [videoA, videoB] }, sender,
    );
    await L["runtime.onMessage"](
      {
        type: "grab-videos-detected",
        videos: [],
        replaceFrame: true,
        lifecycle: "pause",
        lifecycleSource: videoA.blobUrl,
      },
      sender,
    );
    await L["runtime.onMessage"](
      { type: "grab-videos-detected", videos: [videoB] }, sender,
    );

    assert.equal(bg._videoFinds.get(tabId).sniffedByFrame.has(0), false);
    assert.deepEqual(await bg.resolvedVideoUrls(tabId), []);
  });

  test("retirement marker and sequence/time maps survive restore; legacy v2 restores", async () => {
    const shared = {};
    const chrome = makeChrome(shared);
    const bg = loadBackground(chrome);
    const L = chrome._listeners;
    const tabId = 166;
    const manifest = "https://cdn.example.com/old/master.m3u8";
    const video = { src: null, blob: true, blobUrl: "blob:https://example.com/old" };
    const sender = { tab: { id: tabId, url: "https://example.com/" }, frameId: 0 };
    const sniffAt = Date.now() - 100;
    const pauseAt = Date.now();

    await L["webRequest.onResponseStarted"]({
      tabId, frameId: 0, url: manifest, timeStamp: sniffAt,
      responseHeaders: [{ name: "content-type", value: "application/vnd.apple.mpegurl" }],
    });
    await L["runtime.onMessage"]({ type: "grab-videos-detected", videos: [video] }, sender);
    await L["runtime.onMessage"](
      {
        type: "grab-videos-detected",
        videos: [],
        replaceFrame: true,
        lifecycle: "reset",
        lifecycleSource: video.blobUrl,
        lifecycleAt: pauseAt,
      },
      sender,
    );
    await bg._persistVideoFinds(tabId);

    const saved = shared.session.get("videoFinds:v2:" + tabId);
    assert.equal(saved.sniffSequence, 1);
    assert.deepEqual(saved.retiredFrames.map(([frameId, retired]) => [
      frameId, retired.source, retired.retiredAtSeq,
    ]), [[0, video.blobUrl, 1]]);
    const savedObservation = saved.observations[0][1].find(([url]) =>
      url === "https://cdn.example.com/old/master.m3u8");
    assert.deepEqual(savedObservation.slice(3, 6), [1, sniffAt, sniffAt]);
    assert.deepEqual(saved.retiredFrames[0][1].previousVideos, [video]);

    const restoredChrome = makeChrome(shared);
    const restoredBg = loadBackground(restoredChrome);
    await restoredBg._restoreVideoFinds(tabId);
    const restored = restoredBg._videoFinds.get(tabId);
    assert.equal(restored.sniffSequence, 1);
    assert.equal(restored.retiredFrames.get(0).retiredAtSeq, 1);
    assert.equal(restored.sniffTimesByFrame.get(0).get("https://cdn.example.com/old/master.m3u8"), sniffAt);
    assert.deepEqual(await restoredBg.resolvedVideoUrls(tabId), []);
    await restoredChrome._listeners["runtime.onMessage"](
      { type: "grab-videos-detected", videos: [video] }, sender,
    );
    assert.equal(restored.retiredFrames.has(0), false);
    assert.deepEqual(await restoredBg.resolvedBlobVideoUrlForFrame(tabId, 0), manifest);

    const legacyShared = {
      session: new Map([["videoFinds:v2:167", {
        version: 2,
        frames: [[0, [video]]],
        sniffedFrames: [[0, [manifest]]],
        kindsFrames: [[0, [[manifest, "manifest"]]]],
        pausedFrames: [[0, video.blobUrl]],
        title: "Legacy",
      }]]),
    };
    const legacyBg = loadBackground(makeChrome(legacyShared));
    await legacyBg._restoreVideoFinds(167);
    const legacy = legacyBg._videoFinds.get(167);
    assert.deepEqual(legacy.sniffedByFrame.get(0), [manifest]);
    assert.equal(legacy.sniffSequence, 1);
    assert.equal(legacy.retiredFrames.get(0).source, video.blobUrl);
    assert.equal(legacy.retiredFrames.get(0).retiredAtSeq, 1);
  });

  test("per-element identity and load-start timing survive a session round trip", async () => {
    const shared = {};
    const first = makeChrome(shared);
    const firstBg = loadBackground(first);
    const tabId = 172;
    const sniffedAt = Date.now() - 500;
    const video = {
      src: null,
      blob: true,
      blobUrl: "blob:https://example.com/player",
      elementId: 12,
      loadStartedAt: sniffedAt + 100,
    };
    await first._listeners["webRequest.onResponseStarted"]({
      tabId,
      frameId: 0,
      url: "https://cdn.example.com/player/master.m3u8",
      timeStamp: sniffedAt,
      responseHeaders: [{ name: "content-type", value: "application/vnd.apple.mpegurl" }],
    });
    await first._listeners["runtime.onMessage"](
      {
        type: "grab-videos-detected",
        videos: [video],
      },
      { tab: { id: tabId, url: "https://example.com/" }, frameId: 0 },
    );
    await firstBg._persistVideoFinds(tabId);

    const saved = shared.session.get("videoFinds:v2:" + tabId);
    assert.equal(saved.frames[0][1][0].elementId, 12);
    assert.equal(saved.frames[0][1][0].loadStartedAt, video.loadStartedAt);

    const restoredChrome = makeChrome(shared);
    const restoredBg = loadBackground(restoredChrome);
    await restoredBg._restoreVideoFinds(tabId);
    const restoredVideo = restoredBg._videoFinds.get(tabId).frames.get(0)[0];
    assert.equal(restoredVideo.elementId, 12);
    assert.equal(restoredVideo.loadStartedAt, video.loadStartedAt);
    assert.equal(
      await restoredBg.resolvedBlobVideoUrlForFrame(tabId, 0),
      "https://cdn.example.com/player/master.m3u8",
    );
  });

  test("multiple players expose separate network candidates without guessing an element match", async () => {
    const chrome = makeChrome();
    const bg = loadBackground(chrome);
    const L = chrome._listeners;
    const tabId = 142;
    const manifests = [
      "https://cdn.example.com/a/master.m3u8",
      "https://cdn.example.com/b/master.m3u8",
    ];
    await L["tabs.onActivated"]({ tabId });
    for (const url of manifests) {
      await L["webRequest.onResponseStarted"]({ tabId, frameId: 0, url, responseHeaders: [] });
    }
    await L["runtime.onMessage"](
      { type: "grab-videos-detected", videos: [
        { src: null, blob: true, blobUrl: "blob:https://example.com/one" },
        { src: null, blob: true, blobUrl: "blob:https://example.com/two" },
      ] },
      { tab: { id: tabId, url: "https://example.com/" }, frameId: 0 },
    );
    assert.deepEqual(
      await bg.resolvedVideoUrlsForFrame(tabId, 0),
      [],
      "element-specific resolution remains conservative with multiple players",
    );
    assert.deepEqual(
      await bg.resolvedVideoUrls(tabId),
      [],
      "frame-level manifests are not guessed across multiple active elements without timing metadata",
    );
  });

  test("one blob player collapses unrelated manifests to one best candidate", async () => {
    const chrome = makeChrome();
    const bg = loadBackground(chrome);
    const L = chrome._listeners;
    const tabId = 143;
    await L["tabs.onActivated"]({ tabId });
    for (const url of ["https://cdn.example.com/a/master.m3u8", "https://cdn.example.com/b/master.m3u8"]) {
      await L["webRequest.onResponseStarted"]({ tabId, frameId: 0, url, responseHeaders: [] });
    }
    await L["runtime.onMessage"](
      { type: "grab-videos-detected", videos: [{
        src: null, blob: true, blobUrl: "blob:https://example.com/player"
      }] },
      { tab: { id: tabId, url: "https://example.com/" }, frameId: 0 },
    );
    assert.equal(
      await bg.resolvedBlobVideoUrlForFrame(tabId, 0),
      "https://cdn.example.com/a/master.m3u8",
    );
  });

  test("blob identity and frame-scoped manifests survive worker restart", async () => {
    const shared = {};
    const first = makeChrome(shared);
    loadBackground(first);
    const tabId = 144;
    const blobUrl = "blob:https://embed.example.com/frame";
    const manifest = "https://cdn.example.com/embed/master.m3u8";
    await first._listeners["webRequest.onResponseStarted"]({ tabId, frameId: 9, url: manifest, responseHeaders: [] });
    await first._listeners["runtime.onMessage"](
      { type: "grab-videos-detected", videos: [{ src: null, blob: true, blobUrl }] },
      { tab: { id: tabId, url: "https://example.com/" }, frameId: 9 },
    );
    const saved = shared.session.get("videoFinds:v2:" + tabId);
    assert.ok(saved);
    assert.equal(saved.version, 3);
    assert.equal(saved.frames.find(([id]) => id === 9)[1][0].blobUrl, blobUrl);

    const restarted = makeChrome(shared);
    const bg = loadBackground(restarted);
    await restarted._listeners["runtime.onMessage"](
      { type: "grab-videos-detected", videos: [{ src: null, blob: true, blobUrl }] },
      { tab: { id: tabId, url: "https://example.com/" }, frameId: 9 },
    );
    assert.equal(bg.findVideoForSource(tabId, blobUrl, 9).video.blobUrl, blobUrl);
    assert.equal(await bg.resolvedBlobVideoUrlForFrame(tabId, 9), manifest);
  });


  test("disabling detection clears legacy and v2 snapshots from inactive tabs", async () => {
    const shared = {
      session: new Map([
        ["videoFinds:99", { frames: [], sniffed: [] }],
        ["videoFinds:v2:100", {
          version: 2, frames: [], sniffedFrames: [], kindsFrames: [], title: ""
        }],
      ]),
    };
    const chrome = makeChrome(shared);
    loadBackground(chrome);
    await chrome._listeners["storage.onChanged"](
      { detectVideos: { newValue: false } },
      "sync",
    );
    await tick();
    assert.equal(shared.session.has("videoFinds:99"), false);
    assert.equal(shared.session.has("videoFinds:v2:100"), false);
  });

  test("detection off stays silent", async () => {
    const chrome = makeChrome({ syncSettings: { detectVideos: false } });
    loadBackground(chrome);
    const L = chrome._listeners;
    await L["storage.onChanged"]({ detectVideos: { newValue: false } }, "sync");

    await L["tabs.onActivated"]({ tabId: 5 });
    L["webRequest.onResponseStarted"]({
      tabId: 5,
      url: "https://cdn.example.com/s/stream.m3u8",
      responseHeaders: [],
    });
    L["runtime.onMessage"](
      {
        type: "grab-videos-detected",
        videos: [{ src: "https://cdn.example.com/v/clip.mp4", blob: false }],
      },
      { tab: { id: 5 } }
    );
    await tick();

    assert.equal(
      chrome._calls.some(([n, id]) => n === "menus.create" && String(id).startsWith("grabVideo")),
      false
    );
    assert.equal(
      chrome._calls.some(([n, arg]) => n === "action.setBadgeText" && arg.text !== ""),
      false
    );
  });

  test("navigation clears the tab's finds", async () => {
    const chrome = makeChrome();
    loadBackground(chrome);
    const L = chrome._listeners;

    await L["tabs.onActivated"]({ tabId: 5 });
    L["webRequest.onResponseStarted"]({
      tabId: 5,
      url: "https://cdn.example.com/s/stream.m3u8",
      responseHeaders: [],
    });
    // Played-only menu: the sniffed manifest needs a started video to surface.
    L["runtime.onMessage"](
      { type: "grab-videos-detected", videos: [{ src: "https://cdn.example.com/v/clip.mp4", blob: false }] },
      { tab: { id: 5 } }
    );
    await tick();
    assert.ok(chrome._calls.some(([n, id]) => n === "menus.create" && id === "grabVideo:0"));

    chrome._calls.length = 0;
    await L["tabs.onUpdated"](5, { status: "loading" });
    await tick();
    assert.equal(
      chrome._calls.some(([n, id]) => n === "menus.create" && String(id).startsWith("grabVideo")),
      false,
      "no video menu after navigation"
    );
  });
});

describe("manifest permission mirror", () => {
  const fs = require("node:fs");
  const readManifest = () =>
    JSON.parse(fs.readFileSync(path.join(__dirname, "..", "manifest.json"), "utf8"));

  test("worker starts using only permitted chrome namespaces", () => {
    // Regression: 1.0.5 called chrome.webNavigation.onCommitted at the top
    // level without declaring the permission. In a real browser that namespace
    // is undefined, so the whole service worker died on startup — no context
    // menu at all. The Node mock had always provided webNavigation, so the
    // suite stayed green. This test wraps the mock in a Proxy that throws on
    // any top-level chrome namespace the manifest doesn't grant (plus the
    // namespaces Chrome exposes without a permission), so the same class of
    // bug fails here instead of in the user's browser.
    //
    // Optional permissions (cookies, webRequest) are not granted at startup:
    // the Proxy answers undefined for them, exactly like a fresh install, so
    // this also proves the worker starts and registers its listeners without
    // them and only touches them behind an existence check.
    const manifest = readManifest();
    const optional = new Set(manifest.optional_permissions);
    const allowed = new Set([
      ...manifest.permissions,
      // Exposed without a permission: runtime/action always; tabs as a
      // namespace (url/title stay hidden without the "tabs" permission, which
      // the worker doesn't need); commands via manifest key bindings.
      "runtime",
      "tabs",
      "action",
      "commands",
      // permissions: the Permissions API needs no manifest entry.
      "permissions",
      // windows: no manifest permission needed (only used for focus events,
      // behind an existence check).
      "windows",
    ]);
    const chrome = makeChrome();
    const guarded = new Proxy(chrome, {
      get(target, prop, receiver) {
        if (typeof prop === "string" && !prop.startsWith("_")) {
          if (optional.has(prop)) return undefined;
          if (!allowed.has(prop)) {
            throw new Error(`chrome.${prop} used but not in manifest permissions`);
          }
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    assert.doesNotThrow(() => loadBackground(guarded));
  });

  test("manifest asks for no page access at install time", () => {
    const manifest = readManifest();
    // Broad access is optional and requested when the user opts in.
    assert.deepEqual(manifest.host_permissions, ["http://127.0.0.1/*"]);
    assert.deepEqual(manifest.optional_host_permissions, ["http://*/*", "https://*/*"]);
    assert.ok(manifest.optional_permissions.includes("webRequest"));
    assert.ok(manifest.optional_permissions.includes("cookies"));
    assert.equal(manifest.permissions.includes("webRequest"), false);
    assert.equal(manifest.permissions.includes("cookies"), false);
    // A static content script on every site would be an install-time grant.
    assert.equal(manifest.content_scripts, undefined);
    // The detector is registered dynamically, which needs this permission.
    assert.ok(manifest.permissions.includes("scripting"));
    // activeTab keeps Alt+G and the context menu working without page access.
    assert.ok(manifest.permissions.includes("activeTab"));
  });
});

describe("video detection on formerly excluded sites", () => {
  const tick = () => new Promise((r) => setTimeout(r, 30));
  const hosts = [
    "www.youtube.com",
    "youtu.be",
    "player.vimeo.com",
    "www.dailymotion.com",
    "dai.ly",
    "www.tiktok.com",
    "www.instagram.com",
    "www.facebook.com",
    "fb.com",
    "fb.watch",
    "twitter.com",
    "x.com",
    "www.twitch.tv",
  ];

  test("accepts DOM video reports from every formerly excluded site", async () => {
    for (const [index, host] of hosts.entries()) {
      const chrome = makeChrome();
      const bg = loadBackground(chrome);
      const tabId = index + 1;
      const src = `https://cdn.example.com/${index}/clip.mp4`;
      const L = chrome._listeners;

      await L["tabs.onActivated"]({ tabId });
      await L["runtime.onMessage"](
        {
          type: "grab-videos-detected",
          videos: [{ src, blob: false, height: 360 }],
        },
        { tab: { id: tabId, url: `https://${host}/watch` }, frameId: 0 },
      );
      await tick();

      const findings = bg._videoFinds.get(tabId);
      assert.ok(findings, `video report retained for ${host}`);
      assert.deepEqual(findings.frames.get(0).map((video) => video.src), [src], host);
    }
  });

  test("collects HLS manifests from every formerly excluded site", async () => {
    for (const [index, host] of hosts.entries()) {
      const chrome = makeChrome();
      const bg = loadBackground(chrome);
      const tabId = index + 1;
      const manifest = `https://cdn.example.com/${index}/master.m3u8`;
      const L = chrome._listeners;

      await L["tabs.onActivated"]({ tabId });
      L["webRequest.onResponseStarted"]({
        tabId,
        frameId: 0,
        url: manifest,
        responseHeaders: [
          { name: "content-type", value: "application/vnd.apple.mpegurl" },
        ],
      });
      await tick();
      await tick();

      const findings = bg._videoFinds.get(tabId);
      assert.ok(findings, `network manifest retained for ${host}`);
      assert.deepEqual(findings.sniffedByFrame.get(0), [manifest], host);
    }
  });

  test("a formerly excluded YouTube tab still gets the video menu", async () => {
    const chrome = makeChrome();
    chrome.tabs.get = async (id) => ({ id, url: "https://www.youtube.com/watch?v=x" });
    loadBackground(chrome);
    const L = chrome._listeners;

    await L["tabs.onActivated"]({ tabId: 9 });
    L["webRequest.onResponseStarted"]({
      tabId: 9,
      url: "https://cdn.example.com/s/stream.m3u8",
      responseHeaders: [],
    });
    L["runtime.onMessage"](
      {
        type: "grab-videos-detected",
        videos: [{ src: "https://cdn.example.com/v/clip.mp4", blob: false }],
      },
      { tab: { id: 9, url: "https://www.youtube.com/watch?v=x" } },
    );
    await tick();
    await tick();
    assert.ok(
      chrome._calls.some(([name, id]) => name === "menus.create" && id === "grabVideo:0"),
      "YouTube tab exposes the detected video menu",
    );
  });

  test("a report with a stale active-tab cache still builds the menu", async () => {
    const chrome = makeChrome();
    loadBackground(chrome);
    const L = chrome._listeners;
    chrome.tabs.query = (query, callback) => callback([{ id: 5 }]);

    L["runtime.onMessage"](
      {
        type: "grab-videos-detected",
        videos: [{ src: "https://cdn.example.com/v/clip.mp4", blob: false }],
      },
      { tab: { id: 5 } },
    );
    await tick();
    await tick();
    assert.ok(
      chrome._calls.some(([name, id]) => name === "menus.create" && id === "grabVideo:0"),
      "menu built after live verification, without a tab switch",
    );
  });

  test("a report from a background tab stays silent with a stale cache", async () => {
    const chrome = makeChrome();
    loadBackground(chrome);
    const L = chrome._listeners;
    chrome.tabs.query = (query, callback) => callback([{ id: 9 }]);

    L["runtime.onMessage"](
      {
        type: "grab-videos-detected",
        videos: [{ src: "https://cdn.example.com/v/clip.mp4", blob: false }],
      },
      { tab: { id: 5 } },
    );
    await tick();
    await tick();
    assert.equal(
      chrome._calls.some(([name, id]) => name === "menus.create" && String(id).startsWith("grabVideo")),
      false,
      "no menu for a tab that is not live-active",
    );
  });
});

describe("pageVideoTitle", () => {
  let content;
  beforeEach(() => {
    content = loadContent();
  });

  test("reads og:title", () => {
    const doc = {
      querySelector: (sel) =>
        sel === 'meta[property="og:title"]' ? { content: "  My Video  " } : null,
    };
    assert.equal(content.pageVideoTitle(doc), "My Video");
  });

  test("empty when no title anywhere", () => {
    const doc = { querySelector: () => null };
    assert.equal(content.pageVideoTitle(doc), "");
  });

  test("falls back to twitter:title, then the page title minus its site suffix", () => {
    const twitter = {
      querySelector: (sel) =>
        sel === 'meta[name="twitter:title"]' ? { content: "From Twitter" } : null,
      title: "ignored",
    };
    assert.equal(content.pageVideoTitle(twitter), "From Twitter");
    const at = (title) => content.pageVideoTitle({ querySelector: () => null, title });
    assert.equal(at("How to bake bread - YouTube"), "How to bake bread");
    assert.equal(at("How to bake bread | Some Site"), "How to bake bread");
    assert.equal(at("Part A - Part B - Site"), "Part A - Part B");
    // Too short to be a title plus suffix: kept whole.
    assert.equal(at("Home | Site"), "Home | Site");
    assert.equal(at("  Plain   title  "), "Plain title");
  });

  test("empty on missing document", () => {
    assert.equal(content.pageVideoTitle(null), "");
  });
});

describe("videoElementTitle", () => {
  let content;
  beforeEach(() => {
    content = loadContent();
  });

  test("collectVideos carries a player-specific title into the report", () => {
    const video = {
      currentSrc: "https://cdn.example.com/player-a/master.m3u8",
      videoWidth: 640,
      videoHeight: 360,
      paused: false,
      ended: false,
      querySelectorAll: () => [],
      getAttribute: (name) => name === "aria-label" ? "Episode One" : null,
    };
    const doc = {
      querySelectorAll: (selector) => selector === "video" ? [video] : [],
    };

    assert.deepEqual(
      content.collectVideos(doc, () => true).map((entry) => entry.title),
      ["Episode One"],
    );
  });

  test("uses a labelled-by title and ignores generic player labels", () => {
    const labelled = {
      currentSrc: "https://cdn.example.com/player-b/master.m3u8",
      videoWidth: 640,
      paused: false,
      ended: false,
      querySelectorAll: () => [],
      getAttribute: (name) => name === "aria-labelledby" ? "episode-title" : null,
      ownerDocument: {
        getElementById: (id) => id === "episode-title" ? { textContent: "  Episode   Two " } : null,
      },
    };
    const labelledDoc = {
      querySelectorAll: (selector) => selector === "video" ? [labelled] : [],
    };
    assert.deepEqual(
      content.collectVideos(labelledDoc, () => true).map((entry) => entry.title),
      ["Episode Two"],
    );

    const generic = {
      currentSrc: "https://cdn.example.com/player-c/master.m3u8",
      videoWidth: 640,
      paused: false,
      ended: false,
      querySelectorAll: () => [],
      getAttribute: (name) => name === "aria-label" ? "Video player" : null,
    };
    const genericDoc = {
      querySelectorAll: (selector) => selector === "video" ? [generic] : [],
    };
    assert.equal(content.collectVideos(genericDoc, () => true)[0].title, undefined);
  });
});

describe("videoName", () => {
  let bg;
  beforeEach(() => {
    bg = loadBackground(makeChrome());
  });

  test("a direct file is named by its file name, whatever the page title", () => {
    assert.equal(bg.videoName("https://cdn.example.com/v/clip.mp4?t=1", 0, "Some Page Title", null), "clip.mp4");
    assert.equal(bg.videoName("https://cdn.example.com/v/clip.mp4", 0, "", null), "clip.mp4");
  });

  test("a stream falls back to the page title when its URL has no descriptive name", () => {
    assert.equal(
      bg.videoName("https://cdn.example.com/hls/master.m3u8", 0, "  Example   Video Title ", "hls"),
      "Example Video Title"
    );
  });

  test("player-specific titles take priority for manifests and direct media", () => {
    assert.equal(
      bg.videoName("https://cdn.example.com/hls/master.m3u8", 0, "Shared page title", "hls", "Episode One"),
      "Episode One",
    );
    assert.equal(
      bg.videoName("https://cdn.example.com/video.mp4", 0, "Shared page title", null, "Episode Two"),
      "Episode Two",
    );
  });

  test("a descriptive manifest path is preferred over the shared page title", () => {
    assert.equal(
      bg.videoName("https://cdn.example.com/series/episode-two/master.m3u8", 0, "Shared page title", "hls"),
      "episode-two",
    );
  });

  test("long titles stay within 32 grapheme clusters including the ellipsis", () => {
    const long = "The Complete History of Mechanical Watches From the First Pocket Clocks to Modern Tourbillons";
    const name = bg.videoName("https://cdn.example.com/hls/master.m3u8", 0, long, "hls");
    const count = (value) =>
      Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)).length;
    assert.ok(name.endsWith("…"));
    assert.ok(count(name) <= 32, name);
    assert.ok(long.startsWith(name.slice(0, -1)), name);
    assert.ok(/[a-z]…$/i.test(name) && long.charAt(name.length - 1) === " ", name);
    const exactly32 = "x".repeat(32);
    assert.equal(bg.videoName("https://c.example.com/hls/master.m3u8", 0, exactly32, "hls"), exactly32);
    const overLimit = "x".repeat(33);
    assert.equal(bg.videoName("https://c.example.com/hls/master.m3u8", 0, overLimit, "hls"), `${"x".repeat(31)}…`);
  });

  test("file names stay within 32 grapheme clusters and never split a character", () => {
    const longFile = `${"a".repeat(60)}.mp4`;
    assert.equal(bg.videoName(`https://c.example.com/${longFile}`, 0, "", null), `${"a".repeat(31)}…`);
    const exactly32File = `${"x".repeat(28)}.mp4`;
    assert.equal(bg.videoName(`https://c.example.com/${exactly32File}`, 0, "", null), exactly32File);
    const overLimitFile = `${"x".repeat(29)}.mp4`;
    assert.equal(bg.videoName(`https://c.example.com/${overLimitFile}`, 0, "", null), `${"x".repeat(29)}.m…`);
    const spacedFile = `${"a ".repeat(30)}file.mp4`;
    assert.equal(bg.videoName(`https://c.example.com/${encodeURIComponent(spacedFile)}`, 0, "", null), `${"a ".repeat(15)}a…`);
    const emoji = "👨‍👩‍👧‍👦".repeat(60);
    const cut = bg.videoName("https://c.example.com/hls/master.m3u8", 0, emoji, "hls");
    assert.equal(cut, `${"👨‍👩‍👧‍👦".repeat(31)}…`);
    assert.equal(
      Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(cut)).length,
      32,
    );
  });

  test("a generic stream file name falls back to the nearest descriptive folder", () => {
    assert.equal(bg.videoName("https://cdn.example.com/hls/my-show-ep1/master.m3u8", 0, "", "hls"), "my-show-ep1");
    assert.equal(bg.videoName("https://cdn.example.com/videos/Big%20Buck/720p/index.m3u8", 0, "", "hls"), "Big Buck");
    assert.equal(bg.videoName("https://cdn.example.com/hls/master.m3u8", 0, "", "hls"), "master.m3u8");
  });

  test("a descriptive stream file name is preferred over the shared page title", () => {
    assert.equal(bg.videoName("https://cdn.example.com/hls/my-talk.m3u8", 0, "", "hls"), "my-talk.m3u8");
    assert.equal(bg.videoName("https://cdn.example.com/hls/my-talk.m3u8", 0, "Page Title", "hls"), "my-talk.m3u8");
  });

  test("a generic or machine-generated direct file name yields to the page title", () => {
    for (const file of ["video.mp4", "index.mp4", "3f2a9c1e7b4d5a60.mp4", "123456789.mp4", "9b1d6f0e-3c1a-4e57-8b2f-0c6d9a1e4f7b.mp4"]) {
      assert.equal(bg.videoName(`https://cdn.example.com/v/${file}`, 0, "Great Talk", null), "Great Talk", file);
      const withoutTitle = bg.videoName(`https://cdn.example.com/v/${file}`, 0, "", null);
      const expectedWithoutTitle = file.length <= 32 ? file : `${file.slice(0, 31)}…`;
      assert.equal(withoutTitle, expectedWithoutTitle, file);
    }
    assert.equal(bg.videoName("https://cdn.example.com/v/lecture-2024.mp4", 0, "Great Talk", null), "lecture-2024.mp4");
  });

  test("Video N is the last resort", () => {
    assert.equal(bg.videoName("https://cdn.example.com/", 2, "", null), "Video 3");
    assert.equal(bg.videoName("not a url", 0, "", null), "Video 1");
  });

  test("menuRowTitle joins name and quality and escapes %", () => {
    assert.equal(bg.menuRowTitle("clip.mp4", "1080p"), "clip.mp4 • 1080p");
    assert.equal(bg.menuRowTitle("clip.mp4", ""), "clip.mp4");
    assert.equal(bg.menuRowTitle("100%s", ""), "100%%s");
  });
});

describe("context menu: one flat submenu, one click to Grab", () => {
  const MUXED = [
    "#EXTM3U",
    "#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360",
    "v360.m3u8",
    "#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720",
    "v720.m3u8",
    "#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080",
    "v1080.m3u8",
  ].join("\n");
  const SPLIT = [
    "#EXTM3U",
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a1",NAME="en",URI="audio.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720,AUDIO="a1"',
    "v720.m3u8",
    '#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,AUDIO="a1"',
    "v1080.m3u8",
  ].join("\n");

  /// One played direct file (with a page title set) plus one sniffed manifest.
  /// Returns the chrome mock and every menu item created (last rebuild wins).
  async function build({ manifestUrl, videos, title }) {
    const chrome = makeChrome();
    const created = new Map();
    const orig = chrome.contextMenus.create;
    chrome.contextMenus.create = (props) => {
      created.set(props.id, props);
      return orig(props);
    };
    loadBackground(chrome);
    const L = chrome._listeners;
    await L["tabs.onActivated"]({ tabId: 3 });
    L["runtime.onMessage"](
      { type: "grab-videos-detected", videos, title },
      { tab: { id: 3 } }
    );
    if (manifestUrl) {
      await L["webRequest.onResponseStarted"]({ tabId: 3, url: manifestUrl, responseHeaders: [] });
    }
    for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
    return { chrome, items: [...created.values()] };
  }
  const rowsOf = (items) =>
    items.filter((i) => i.parentId === "grabVideos" && i.type !== "separator");
  const click = async (chrome, id) =>
    await chrome._listeners["menus.onClicked"]({ menuItemId: id }, { id: 3 });
  const sent = (chrome) =>
    chrome._calls.filter(([n]) => n === "handoff").map(([, url]) => url);

  test("every row sits directly under the single submenu", async () => {
    const { items } = await build({
      manifestUrl: "https://cdn.example.com/hls/master.m3u8",
      videos: [{ src: "https://cdn.example.com/v/clip.mp4", blob: false, height: 1080 }],
      title: "Example …",
    });
    // Nothing is nested deeper than the root submenu.
    const ids = new Set(items.map((i) => i.id));
    assert.ok(items.every((i) => i.parentId === undefined || i.parentId === "grabVideos"));
    assert.ok(ids.has("grabVideos"));
    assert.deepEqual(rowsOf(items).map((i) => i.title), [
      "clip.mp4 • 1080p",
    ]);
    assert.ok(items.every((i) => i.enabled !== false));
  });

  test("a direct media row uses its player title instead of the URL basename", async () => {
    const { items } = await build({
      manifestUrl: null,
      videos: [{
        src: "https://cdn.example.com/media/opaque-file.mp4",
        blob: false,
        title: "Lecture Two",
      }],
      title: "Shared page title",
    });
    assert.deepEqual(rowsOf(items).map((item) => item.title), ["Lecture Two"]);
  });

  test("a click on a row sends that row's URL to Grab", async () => {
    const { chrome, items } = await build({
      manifestUrl: "https://cdn.example.com/hls/master.m3u8",
      videos: [{ src: "https://cdn.example.com/v/clip.mp4", blob: false, height: 1080 }],
      title: "Example …",
    });
    const rows = rowsOf(items);
    assert.equal(rows.length, 1);
    await click(chrome, rows[0].id);
    assert.deepEqual(sent(chrome), [
      "https://cdn.example.com/v/clip.mp4",
    ]);
  });

  test("a plain mp4 with no page title still shows x.mp4", async () => {
    const { items, chrome } = await build({
      manifestUrl: null,
      videos: [{ src: "https://cdn.example.com/v/x.mp4", blob: false }],
      title: "",
    });
    const rows = rowsOf(items);
    assert.deepEqual(rows.map((i) => i.title), ["x.mp4"]);
    await click(chrome, rows[0].id);
    assert.deepEqual(sent(chrome), ["https://cdn.example.com/v/x.mp4"]);
  });

  test("a page title never renames a direct file", async () => {
    const { items } = await build({
      manifestUrl: null,
      videos: [{ src: "https://cdn.example.com/v/x.mp4", blob: false }],
      title: "Watch Now Free HD",
    });
    assert.deepEqual(rowsOf(items).map((i) => i.title), ["x.mp4"]);
  });

  test("separate-audio streams are one row that hands over the master", async () => {
    const { chrome, items } = await build({
      manifestUrl: "https://cdn.example.com/hls/master.m3u8",
      videos: [{ src: null, blob: true }],
      title: "My Show",
    });
    const rows = rowsOf(items);
    assert.deepEqual(rows.map((i) => i.title), ["My Show"]);
    await click(chrome, rows[0].id);
    assert.deepEqual(sent(chrome), ["https://cdn.example.com/hls/master.m3u8"]);
  });

  test("the main Download with Grab item still works with videos detected", async () => {
    const { chrome } = await build({
      manifestUrl: null,
      videos: [{ src: "https://cdn.example.com/v/x.mp4", blob: false }],
      title: "",
    });
    await chrome._listeners["menus.onClicked"](
      { menuItemId: "sendToGrab", linkUrl: "https://example.com/file.zip" },
      { id: 3 }
    );
    assert.deepEqual(sent(chrome), ["https://example.com/file.zip"]);
  });

  test("videos are separated, repeats are numbered", async () => {
    const { items } = await build({
      manifestUrl: null,
      videos: [
        { src: "https://a.example.com/x.mp4", blob: false },
        { src: "https://b.example.com/x.mp4", blob: false },
      ],
      title: "",
    });
    assert.deepEqual(rowsOf(items).map((i) => i.title), ["x.mp4", "x.mp4 (2)"]);
    assert.equal(items.filter((i) => i.type === "separator").length, 1);
  });

  test("two HLS players use their own titles instead of the shared page title", async () => {
    const shared = {};
    const chrome = makeChrome(shared);
    const created = new Map();
    const originalCreate = chrome.contextMenus.create;
    chrome.contextMenus.create = (props) => {
      created.set(props.id, props);
      return originalCreate(props);
    };
    loadBackground(chrome);
    const L = chrome._listeners;
    const tabId = 57;
    const now = Date.now();
    const first = "https://cdn.example.com/player-a/master.m3u8";
    const second = "https://cdn.example.com/player-b/master.m3u8";
    await L["tabs.onActivated"]({ tabId });

    for (const [url, timeStamp] of [
      [first, now - 4_000],
      [second, now - 1_000],
    ]) {
      await L["webRequest.onResponseStarted"]({
        tabId,
        frameId: 0,
        url,
        timeStamp,
        responseHeaders: [{ name: "content-type", value: "application/vnd.apple.mpegurl" }],
      });
    }

    await L["runtime.onMessage"](
      {
        type: "grab-videos-detected",
        videos: [
          {
            src: null, blob: true, blobUrl: "blob:https://example.com/player-a",
            title: "Episode One", elementId: 1, loadStartedAt: now - 3_900,
          },
          {
            src: null, blob: true, blobUrl: "blob:https://example.com/player-b",
            title: "Episode Two", elementId: 2, loadStartedAt: now - 900,
          },
        ],
        title: "Shared page title",
      },
      { tab: { id: tabId, url: "https://example.com/watch" }, frameId: 0 },
    );

    for (let i = 0; i < 12; i += 1) await new Promise((resolve) => setImmediate(resolve));
    const rows = [...created.values()].filter((item) => item.parentId === "grabVideos" && item.type !== "separator");
    assert.deepEqual(rows.map((item) => item.title), ["Episode One", "Episode Two"]);
    const saved = shared.session.get("videoFinds:v2:" + tabId);
    assert.deepEqual(
      saved.frames[0][1].map((video) => video.title),
      ["Episode One", "Episode Two"],
      "player titles survive the session snapshot",
    );

    await L["menus.onClicked"]({ menuItemId: rows[1].id }, { id: tabId });
    assert.ok(
      chrome._calls.some(([name, url]) => name === "handoff" && url === second),
      "the second label still targets the second player's manifest",
    );
  });

  test("requestRescan sends grab-rescan and debounces", async () => {
    const chrome = makeChrome({});
    const bg = loadBackground(chrome);
    const sent = [];
    chrome.tabs.sendMessage = async (tabId, msg) => {
      sent.push({ tabId, msg });
    };
    // First call sends immediately.
    bg.requestRescan(42);
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0], { tabId: 42, msg: { type: "grab-rescan" } });
    // Debounced: second call within 3s is ignored.
    bg.requestRescan(42);
    assert.equal(sent.length, 1, "debounced");
    // Different tab is not debounced.
    bg.requestRescan(43);
    assert.equal(sent.length, 2);
  });
});



describe("HLS master playlist filtering", () => {
  const MASTER = [
    "#EXTM3U",
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="English",URI="https://audio.example.com/v/42/audio/en.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720,AUDIO="audio"',
    "renditions/720/chunklist.m3u8",
  ].join("\n");
  const MEDIA = "#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nsegment.ts\n";

  async function filterWithPlaylists(urls, playlists) {
    const bg = loadBackground(makeChrome());
    const inspect = async (url) => {
      const body = playlists.get(String(url));
      if (body === undefined) return null;
      const isMaster = body.slice(0, 4096).includes("#EXT-X-STREAM-INF:");
      return {
        is_master: isMaster,
        child_keys: isMaster ? [...bg.hlsChildPlaylistKeys(body, url)] : [],
      };
    };
    return bg.preferMasterPlaylists(urls, null, urls, inspect);
  }

  test("drops only explicit variant and audio playlist references", async () => {
    const master = "https://cdn.example.com/v/42/master.m3u8";
    const variant = "https://cdn.example.com/v/42/renditions/720/chunklist.m3u8";
    const audio = "https://audio.example.com/v/42/audio/en.m3u8";
    const unrelated = "https://cdn.example.com/v/42/episode-b/chunklist.m3u8";
    const playlists = new Map([
      [master, MASTER],
      [variant, MEDIA],
      [audio, MEDIA],
      [unrelated, MEDIA],
    ]);
    assert.deepEqual(
      await filterWithPlaylists([master, variant, audio, unrelated], playlists),
      [master, unrelated],
    );
  });

  test("uses chunklist and prog_index filenames as child hints beside one master", async () => {
    const bg = loadBackground(makeChrome());
    const master = "https://cdn.example.com/hls/master.m3u8";
    const chunklist = "https://cdn.example.com/hls/chunklist_b123.m3u8";
    const progIndex = "https://cdn.example.com/hls/prog_index_123.m3u8";
    const result = await bg.preferMasterPlaylists(
      [master, chunklist, progIndex],
      "https://page.example/watch",
      [master, chunklist, progIndex],
      async () => null,
    );
    assert.deepEqual(result, [master]);
  });

  test("rotating master tokens do not disable chunklist filename hints", async () => {
    const bg = loadBackground(makeChrome());
    const masterOld = "https://cdn.example.com/hls/master.m3u8?token=old";
    const masterNew = "https://cdn.example.com/hls/master.m3u8?token=new";
    const child = "https://cdn.example.com/hls/chunklist_b123.m3u8";
    const result = await bg.preferMasterPlaylists(
      [masterOld, masterNew, child],
      "https://page.example/watch",
      [masterOld, masterNew, child],
      async () => null,
    );
    assert.deepEqual(result, [masterOld, masterNew]);
  });

  test("does not classify an ordinary non-standard media playlist as a master", async () => {
    const ordinary = "https://cdn.example.com/v/42/720p.m3u8";
    const chunk = "https://cdn.example.com/v/42/chunklist.m3u8";
    assert.deepEqual(
      await filterWithPlaylists([ordinary, chunk], new Map([
        [ordinary, MEDIA],
        [chunk, MEDIA],
      ])),
      [ordinary, chunk],
    );
  });

  test("does not suppress a media playlist merely because it shares a directory", async () => {
    const master = "https://cdn.example.com/v/42/master.m3u8";
    const unrelated = "https://cdn.example.com/v/42/other.m3u8";
    assert.deepEqual(
      await filterWithPlaylists([master, unrelated], new Map([
        [master, MASTER],
        [unrelated, MEDIA],
      ])),
      [master, unrelated],
    );
  });

  test("uses conservative filename hints when playlist fetching fails", async () => {
    const master = "https://cdn.example.com/v/42/master.m3u8";
    const chunk = "https://cdn.example.com/v/42/chunklist.m3u8";
    assert.deepEqual(
      await filterWithPlaylists([master, chunk], new Map()),
      [master],
    );
  });

  test("uses filename hints when the paired Grab inspector cannot classify a master", async () => {
    const master = "https://cdn.example.com/v/42/master.m3u8";
    const child = "https://cdn.example.com/v/42/chunklist.m3u8";
    const bg = loadBackground(makeChrome());
    assert.deepEqual(
      await bg.preferMasterPlaylists(
        [master, child],
        null,
        [master, child],
        async () => null,
      ),
      [master],
    );
  });

  test("does not let DASH manifests suppress HLS playlists", async () => {
    const dash = "https://cdn.example.com/v/42/manifest.mpd";
    const hls = "https://cdn.example.com/v/42/chunklist.m3u8";
    assert.deepEqual(
      await filterWithPlaylists([dash, hls], new Map([[hls, MEDIA]])),
      [dash, hls],
    );
  });

  test("preserves direct files and duplicate-independent streams", async () => {
    const master = "https://cdn.example.com/v/42/master.m3u8";
    const child = "https://cdn.example.com/v/42/renditions/720/chunklist.m3u8";
    const direct = "https://cdn.example.com/v/42/video.mp4";
    const other = "https://cdn.example.com/v/43/chunklist.m3u8";
    assert.deepEqual(
      await filterWithPlaylists([direct, master, child, other], new Map([
        [master, MASTER],
        [child, MEDIA],
        [other, MEDIA],
      ])),
      [direct, master, other],
    );
  });

  test("multiple master files still make same-directory hints ambiguous", async () => {
    const bg = loadBackground(makeChrome());
    const master = "https://cdn.example.com/live/master.m3u8?id=alpha";
    const alternateMaster = "https://cdn.example.com/live/index.m3u8?id=alpha";
    const child = "https://cdn.example.com/live/chunklist.m3u8?id=alpha";
    const candidates = [master, alternateMaster, child];

    assert.deepEqual(
      await bg.preferMasterPlaylists(
        candidates,
        "https://page.example/watch",
        candidates,
        async () => null,
      ),
      candidates,
    );
  });

  test("coalesces an unlisted rotating query parameter before the manifest FIFO fills", async () => {
    const tabId = 211;
    const chrome = makeChrome();
    const bg = loadBackground(chrome);
    const base = "https://cdn.example.com/live/master.m3u8";
    const start = Date.now();

    for (let value = 1; value <= 5; value += 1) {
      const url = `${base}?playSessionId=${value}`;
      await chrome._listeners["webRequest.onResponseStarted"]({
        tabId,
        frameId: 0,
        url,
        timeStamp: start + value * 1000,
        responseHeaders: [
          { name: "content-type", value: "application/vnd.apple.mpegurl" },
        ],
      });
      const observed = bg._videoFinds.get(tabId).sniffedByFrame.get(0) || [];
      assert.equal(observed.length, value < 4 ? value : 1);
      if (value >= 4) assert.equal(observed[0], url);
    }
    assert.deepEqual(
      await bg.resolvedVideoUrlsForFrame(tabId, 0),
      [`${base}?playSessionId=5`],
    );
  });

  test("adaptive rotation ignores only the volatile parameter and keeps episode IDs separate", async () => {
    const tabId = 212;
    const chrome = makeChrome();
    const bg = loadBackground(chrome);
    const base = "https://cdn.example.com/live/master.m3u8";
    const start = Date.now();

    for (const episode of ["alpha", "beta"]) {
      for (let value = 1; value <= 4; value += 1) {
        const url = `${base}?episode=${episode}&rnd=${value}`;
        await chrome._listeners["webRequest.onResponseStarted"]({
          tabId,
          frameId: 0,
          url,
          timeStamp: start + (episode === "beta" ? 5_000 : 0) + value * 500,
          responseHeaders: [
            { name: "content-type", value: "application/vnd.apple.mpegurl" },
          ],
        });
      }
    }

    const findings = bg._videoFinds.get(tabId);
    const observed = findings.sniffedByFrame.get(0) || [];
    assert.equal(observed.length, 2);
    assert.deepEqual(
      observed.map((url) => new URL(url).searchParams.get("episode")).sort(),
      ["alpha", "beta"],
    );
    assert.deepEqual(await bg.resolvedVideoUrlsForFrame(tabId, 0), observed);

    const stored = await chrome.storage.session.get("videoFinds:v2:" + tabId);
    assert.equal(stored["videoFinds:v2:" + tabId].rotatingQueryParams.length, 1);

    const restartedChrome = makeChrome({ session: chrome._session });
    const restarted = loadBackground(restartedChrome);
    await restarted._restoreVideoFinds(tabId);
    assert.deepEqual(await restarted.resolvedVideoUrlsForFrame(tabId, 0), observed);
  });

  test("expires adaptive identities and restores full query keys after an idle window", async () => {
    const originalNow = Date.now;
    let now = 1_800_000_000_000;
    Date.now = () => now;
    try {
      const tabId = 213;
      const chrome = makeChrome();
      const bg = loadBackground(chrome);
      const base = "https://cdn.example.com/live/master.m3u8";
      const observe = async (value) => {
        now += 1_000;
        await chrome._listeners["webRequest.onResponseStarted"]({
          tabId,
          frameId: 0,
          url: `${base}?playSessionId=${value}`,
          timeStamp: now,
          responseHeaders: [
            { name: "content-type", value: "application/vnd.apple.mpegurl" },
          ],
        });
      };

      for (let value = 1; value <= 4; value += 1) await observe(value);
      let findings = bg._videoFinds.get(tabId);
      assert.equal(findings.sniffedByFrame.get(0).length, 1);
      assert.ok(findings.rotatingQueryParamsByFrame.get(0).has(base));

      now += 31_000;
      await observe(5);
      findings = bg._videoFinds.get(tabId);
      assert.equal(findings.rotatingQueryParamsByFrame.has(0), false);
      assert.deepEqual(
        findings.sniffedByFrame.get(0),
        [
          `${base}?playSessionId=4`,
          `${base}?playSessionId=5`,
        ],
      );
      assert.deepEqual(
        await bg.resolvedVideoUrlsForFrame(tabId, 0),
        findings.sniffedByFrame.get(0),
      );
    } finally {
      Date.now = originalNow;
    }
  });

  test("query values outside the adaptive window remain separate", async () => {
    const originalNow = Date.now;
    let now = 1_800_000_000_000;
    Date.now = () => now;
    try {
      const tabId = 214;
      const chrome = makeChrome();
      const bg = loadBackground(chrome);
      const base = "https://cdn.example.com/live/master.m3u8";

      for (let value = 1; value <= 4; value += 1) {
        now += 20_000;
        await chrome._listeners["webRequest.onResponseStarted"]({
          tabId,
          frameId: 0,
          url: `${base}?t=${value}`,
          timeStamp: now,
          responseHeaders: [
            { name: "content-type", value: "application/vnd.apple.mpegurl" },
          ],
        });
      }
      assert.equal(bg._videoFinds.get(tabId).sniffedByFrame.get(0).length, 4);
    } finally {
      Date.now = originalNow;
    }
  });

  test("HLS child filtering preserves separate query-identified streams", async () => {
    const bg = loadBackground(makeChrome());
    const master = "https://cdn.example.com/live/master.m3u8?id=alpha";
    const matchingChild = "https://cdn.example.com/live/chunklist.m3u8?id=alpha";
    const separateChild = "https://cdn.example.com/live/chunklist.m3u8?id=beta";
    const candidates = [master, matchingChild, separateChild];
    const inspector = async (url) => url === master
      ? {
          is_master: true,
          child_keys: ["https://cdn.example.com/live/chunklist.m3u8"],
        }
      : { is_master: false, child_keys: [] };

    assert.deepEqual(
      await bg.preferMasterPlaylists(
        candidates,
        "https://page.example/watch",
        candidates,
        inspector,
      ),
      [master, separateChild],
    );
  });

  test("only browser-sniffed public playlists use the paired Grab inspector", async () => {
    const pageReportedMaster = "https://page-selected.example/private/master.m3u8";
    const browserSniffedMaster = "https://cdn.example.com/observed/master.m3u8";
    const browserSniffedChild = "https://cdn.example.com/observed/rendition.m3u8";
    const inspections = [];
    const candidates = [pageReportedMaster, browserSniffedMaster, browserSniffedChild];
    const inspector = async (url) => {
      inspections.push(url);
      return url === browserSniffedMaster
        ? {
            is_master: true,
            child_keys: ["https://cdn.example.com/observed/rendition.m3u8"],
          }
        : { is_master: false, child_keys: [] };
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error("public playlist inspection must not fetch from the extension");
    };
    try {
      const bg = loadBackground(makeChrome());
      const result = await bg.preferMasterPlaylists(
        candidates,
        "https://public.example/watch",
        [browserSniffedMaster, browserSniffedChild],
        inspector,
      );
      assert.deepEqual(inspections, [browserSniffedMaster, browserSniffedChild]);
      assert.deepEqual(result, [pageReportedMaster, browserSniffedMaster]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("verifies Grab once for a batch of public HLS playlists", async () => {
    const secret = "1a".repeat(32);
    const candidates = [
      "https://cdn.example.com/one/master.m3u8",
      "https://cdn.example.com/two/master.m3u8",
      "https://cdn.example.com/three/master.m3u8",
    ];
    const chrome = makeChrome({ localSettings: { pairingCode: secret } });
    const bg = loadBackground(chrome);
    const originalFetch = globalThis.fetch;
    let helloRequests = 0;
    let inspectRequests = 0;
    const hmac = async (context, message) => {
      const keyBytes = new Uint8Array(
        secret.match(/.{2}/g).map((byte) => Number.parseInt(byte, 16)),
      );
      const key = await crypto.subtle.importKey(
        "raw",
        keyBytes,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      const signature = await crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(context + message),
      );
      return Array.from(new Uint8Array(signature), (byte) =>
        byte.toString(16).padStart(2, "0")
      ).join("");
    };
    globalThis.fetch = async (value, options = {}) => {
      const url = new URL(String(value));
      if (url.pathname === "/hello") {
        helloRequests += 1;
        const nonce = url.searchParams.get("n");
        return {
          ok: true,
          json: async () => ({ proof: await hmac("grab-server\0", nonce) }),
        };
      }
      if (url.pathname === "/inspect-hls") {
        inspectRequests += 1;
        assert.equal(
          options.headers["X-Grab-Token"],
          await hmac("grab-inspect-hls\0", options.body),
        );
        return {
          ok: true,
          text: async () => JSON.stringify({ is_master: false, child_keys: [] }),
        };
      }
      throw new Error("unexpected request: " + String(value));
    };
    try {
      assert.deepEqual(
        await bg.preferMasterPlaylists(candidates, "https://page.example/watch", candidates),
        candidates,
      );
      assert.equal(helloRequests, 1);
      assert.equal(inspectRequests, candidates.length);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("caches successful public inspections by full URL and shares in-flight reads", async () => {
    const bg = loadBackground(makeChrome());
    const masterA = "https://cdn.example.com/v/42/master.m3u8?token=alpha";
    const masterB = "https://cdn.example.com/v/42/master.m3u8?token=beta";
    const child = "https://cdn.example.com/v/42/chunklist.m3u8";
    const inspected = [];
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let started;
    const bothStarted = new Promise((resolve) => { started = resolve; });
    const inspector = async (url) => {
      inspected.push(url);
      if (inspected.length === 2) started();
      await gate;
      return url === masterA || url === masterB
        ? { is_master: true, child_keys: [child] }
        : { is_master: false, child_keys: [] };
    };

    const candidatesA = [masterA, child];
    const first = bg.preferMasterPlaylists(candidatesA, null, candidatesA, inspector);
    const concurrent = bg.preferMasterPlaylists(candidatesA, null, candidatesA, inspector);
    await bothStarted;
    release();
    const [firstResult, concurrentResult] = await Promise.all([first, concurrent]);
    assert.deepEqual(firstResult, [masterA]);
    assert.deepEqual(concurrentResult, [masterA]);
    assert.equal(inspected.length, 2, "concurrent menu rebuilds share the same two inspections");

    assert.deepEqual(
      await bg.preferMasterPlaylists(candidatesA, null, candidatesA, inspector),
      [masterA],
    );
    assert.equal(inspected.length, 2, "a cached success avoids another public inspection");

    const candidatesB = [masterB, child];
    assert.deepEqual(
      await bg.preferMasterPlaylists(candidatesB, null, candidatesB, inspector),
      [masterB],
    );
    assert.deepEqual(
      inspected.sort(),
      [masterA, masterB, child].sort(),
      "a different signed query string gets a distinct cache entry",
    );
  });

  test("negative-caches public inspection failures with a monotonic TTL", async () => {
    const originalMonotonicNow = performance.now;
    const originalWallClockNow = Date.now;
    let monotonicNow = 1_000;
    let wallClockNow = 1_000;
    performance.now = () => monotonicNow;
    Date.now = () => wallClockNow;
    try {
      const bg = loadBackground(makeChrome());
      const url = "https://cdn.example.com/v/42/master.m3u8?token=temporary";
      let attempts = 0;
      const inspector = async () => {
        attempts += 1;
        throw new Error("Grab inspection unavailable");
      };
      const inspect = () => bg.preferMasterPlaylists([url], null, [url], inspector);

      assert.deepEqual(await inspect(), [url]);
      assert.deepEqual(await inspect(), [url]);
      assert.equal(attempts, 1, "failed reads are cached rather than retried per rebuild");

      // A wall-clock rollback must not extend the cache entry.
      wallClockNow -= 60_000;
      monotonicNow += bg.HLS_PUBLIC_INSPECTION_CACHE_TTL_MS - 1;
      assert.deepEqual(await inspect(), [url]);
      assert.equal(attempts, 1, "wall-clock changes do not expire a still-fresh entry");

      // The monotonic deadline still expires it at the configured TTL.
      wallClockNow += 120_000;
      monotonicNow += 2;
      assert.deepEqual(await inspect(), [url]);
      assert.equal(attempts, 2, "the monotonic TTL expires the negative entry");
    } finally {
      performance.now = originalMonotonicNow;
      Date.now = originalWallClockNow;
    }
  });

  test("shares the four-request HLS inspection limit across concurrent menu builds", async () => {
    const secret = "1a".repeat(32);
    const firstBatch = Array.from({ length: 4 }, (_, index) =>
      `https://cdn.example.com/first/${index}/master.m3u8`
    );
    const secondBatch = Array.from({ length: 4 }, (_, index) =>
      `https://cdn.example.com/second/${index}/master.m3u8`
    );
    const bg = loadBackground(makeChrome({ localSettings: { pairingCode: secret } }));
    const originalFetch = globalThis.fetch;
    let helloRequests = 0;
    let inspectRequests = 0;
    let activeInspections = 0;
    let maximumActiveInspections = 0;
    const hmac = async (context, message) => {
      const keyBytes = new Uint8Array(
        secret.match(/.{2}/g).map((byte) => Number.parseInt(byte, 16)),
      );
      const key = await crypto.subtle.importKey(
        "raw",
        keyBytes,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      const signature = await crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(context + message),
      );
      return Array.from(new Uint8Array(signature), (byte) =>
        byte.toString(16).padStart(2, "0")
      ).join("");
    };
    globalThis.fetch = async (value, options = {}) => {
      const url = new URL(String(value));
      if (url.pathname === "/hello") {
        helloRequests += 1;
        const nonce = url.searchParams.get("n");
        return {
          ok: true,
          json: async () => ({ proof: await hmac("grab-server\0", nonce) }),
        };
      }
      if (url.pathname === "/inspect-hls") {
        inspectRequests += 1;
        activeInspections += 1;
        maximumActiveInspections = Math.max(maximumActiveInspections, activeInspections);
        assert.equal(
          options.headers["X-Grab-Token"],
          await hmac("grab-inspect-hls\0", options.body),
        );
        // Keep requests overlapped so independent per-batch limits would
        // exceed Grab's process-wide four-request semaphore.
        await new Promise((resolve) => setTimeout(resolve, 25));
        activeInspections -= 1;
        return {
          ok: true,
          text: async () => JSON.stringify({ is_master: false, child_keys: [] }),
        };
      }
      throw new Error("unexpected request: " + String(value));
    };

    try {
      const [first, second] = await Promise.all([
        bg.preferMasterPlaylists(firstBatch, "https://page.example/watch", firstBatch),
        bg.preferMasterPlaylists(secondBatch, "https://page.example/watch", secondBatch),
      ]);
      assert.deepEqual(first, firstBatch);
      assert.deepEqual(second, secondBatch);
      assert.equal(helloRequests, 2);
      assert.equal(inspectRequests, 8);
      assert.equal(activeInspections, 0);
      assert.ok(
        maximumActiveInspections <= 4,
        `observed ${maximumActiveInspections} simultaneous HLS inspections`,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("refreshes the Grab proof after inspections wait beyond the batch freshness window", async () => {
    const secret = "1a".repeat(32);
    const candidates = Array.from({ length: 6 }, (_, index) =>
      `https://cdn.example.com/queued/${index}/master.m3u8`
    );
    const bg = loadBackground(makeChrome({ localSettings: { pairingCode: secret } }));
    const originalFetch = globalThis.fetch;
    const originalNow = Date.now;
    let now = originalNow();
    Date.now = () => now;
    let helloRequests = 0;
    let inspectRequests = 0;
    let activeInspections = 0;
    let maximumActiveInspections = 0;
    let releaseFirstWave;
    const firstWaveGate = new Promise((resolve) => { releaseFirstWave = resolve; });
    let signalFirstWave;
    const firstWaveStarted = new Promise((resolve) => { signalFirstWave = resolve; });
    const hmac = async (context, message) => {
      const keyBytes = new Uint8Array(
        secret.match(/.{2}/g).map((byte) => Number.parseInt(byte, 16)),
      );
      const key = await crypto.subtle.importKey(
        "raw",
        keyBytes,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      const signature = await crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(context + message),
      );
      return Array.from(new Uint8Array(signature), (byte) =>
        byte.toString(16).padStart(2, "0")
      ).join("");
    };
    globalThis.fetch = async (value, options = {}) => {
      const url = new URL(String(value));
      if (url.pathname === "/hello") {
        helloRequests += 1;
        const nonce = url.searchParams.get("n");
        return {
          ok: true,
          json: async () => ({ proof: await hmac("grab-server\0", nonce) }),
        };
      }
      if (url.pathname === "/inspect-hls") {
        inspectRequests += 1;
        activeInspections += 1;
        maximumActiveInspections = Math.max(maximumActiveInspections, activeInspections);
        assert.equal(
          options.headers["X-Grab-Token"],
          await hmac("grab-inspect-hls\0", options.body),
        );
        if (inspectRequests === 4) signalFirstWave();
        if (inspectRequests <= 4) await firstWaveGate;
        activeInspections -= 1;
        return {
          ok: true,
          text: async () => JSON.stringify({ is_master: false, child_keys: [] }),
        };
      }
      throw new Error("unexpected request: " + String(value));
    };

    try {
      const pending = bg.preferMasterPlaylists(
        candidates,
        "https://page.example/watch",
        candidates,
      );
      await firstWaveStarted;
      assert.equal(helloRequests, 1, "the first four concurrent requests share one fresh proof");
      now += bg.HLS_INSPECTION_HANDSHAKE_MAX_AGE_MS + 1;
      releaseFirstWave();
      assert.deepEqual(await pending, candidates);
      assert.equal(inspectRequests, candidates.length);
      assert.equal(
        helloRequests,
        2,
        "the queued second wave obtains a fresh proof after the first proof ages out",
      );
      assert.ok(
        maximumActiveInspections <= 4,
        `observed ${maximumActiveInspections} simultaneous HLS inspections`,
      );
    } finally {
      releaseFirstWave();
      Date.now = originalNow;
      globalThis.fetch = originalFetch;
    }
  });

  test("unknown Grab inspection preserves every candidate", async () => {
    const candidates = [
      "https://cdn.example.com/observed/master.m3u8",
      "https://cdn.example.com/observed/rendition.m3u8",
    ];
    const bg = loadBackground(makeChrome());
    const result = await bg.preferMasterPlaylists(
      candidates,
      "https://public.example/watch",
      candidates,
      async () => null,
    );
    assert.deepEqual(result, candidates);
  });

  test("uses the paired HMAC endpoint and omits browser credentials", async () => {
    const secret = "1a".repeat(32);
    const chrome = makeChrome({ localSettings: { pairingCode: secret } });
    const bg = loadBackground(chrome);
    const originalFetch = globalThis.fetch;
    const requests = [];
    const hmac = async (context, message) => {
      const keyBytes = new Uint8Array(
        secret.match(/.{2}/g).map((byte) => Number.parseInt(byte, 16)),
      );
      const key = await crypto.subtle.importKey(
        "raw",
        keyBytes,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      const signature = await crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(context + message),
      );
      return Array.from(new Uint8Array(signature), (byte) =>
        byte.toString(16).padStart(2, "0")
      ).join("");
    };
    globalThis.fetch = async (value, options = {}) => {
      const url = new URL(String(value));
      if (url.pathname === "/hello") {
        const nonce = url.searchParams.get("n");
        return {
          ok: true,
          json: async () => ({ proof: await hmac("grab-server\0", nonce) }),
        };
      }
      if (url.pathname === "/inspect-hls") {
        requests.push({ url: String(value), options });
        const body = JSON.parse(options.body);
        assert.equal(options.headers["X-Grab-Token"], await hmac("grab-inspect-hls\0", options.body));
        assert.equal(body.url, "https://cdn.example.com/master.m3u8?sig=secret");
        assert.equal(typeof body.timestamp_ms, "number");
        assert.match(body.nonce, /^[0-9a-f]{32}$/);
        return {
          ok: true,
          text: async () => JSON.stringify({
            is_master: true,
            child_keys: ["https://cdn.example.com/rendition.m3u8"],
          }),
        };
      }
      throw new Error("unexpected request: " + String(value));
    };
    try {
      const result = await bg.inspectHlsPlaylistWithGrab(
        "https://cdn.example.com/master.m3u8?sig=secret",
      );
      assert.deepEqual(result, {
        is_master: true,
        child_keys: ["https://cdn.example.com/rendition.m3u8"],
      });
      assert.equal(requests.length, 1);
      assert.equal(requests[0].url, "http://127.0.0.1:9412/inspect-hls");
      assert.equal(requests[0].options.credentials, "omit");
      assert.equal(requests[0].options.referrerPolicy, "no-referrer");
      assert.equal(requests[0].options.redirect, "error");
      assert.equal(
        Object.keys(requests[0].options.headers).some((key) => key.toLowerCase() === "cookie"),
        false,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("rejects loopback and credential-bearing playlist fetches", async () => {
    const bg = loadBackground(makeChrome());
    assert.equal(await bg.inspectHlsPlaylist("http://127.0.0.1/master.m3u8"), null);
    assert.equal(await bg.inspectHlsPlaylist("http://localhost/master.m3u8"), null);
    assert.equal(await bg.inspectHlsPlaylist("https://user:pass@example.com/master.m3u8"), null);
  });

  test("rejects private, carrier-grade NAT, and IPv6 ULA playlist targets from public tabs", async () => {
    const bg = loadBackground(makeChrome());
    const targets = [
      "http://10.0.0.1/master.m3u8",
      "http://172.16.0.1/master.m3u8",
      "http://192.168.1.1/master.m3u8",
      "http://100.64.0.1/master.m3u8",
      "http://192.0.0.8/master.m3u8",
      "http://198.18.0.1/master.m3u8",
      "http://198.19.255.255/master.m3u8",
      "http://224.0.0.1/master.m3u8",
      "http://240.0.0.1/master.m3u8",
      "http://[fd00::1]/master.m3u8",
      "http://[fc00::1]/master.m3u8",
      "http://[ff02::1]/master.m3u8",
      "http://[fec0::1]/master.m3u8",
      "http://[fed0::1]/master.m3u8",
      "http://[fee0::1]/master.m3u8",
      "http://[fef0::1]/master.m3u8",
    ];
    for (const target of targets) {
      assert.equal(await bg.inspectHlsPlaylist(target), null, target);
    }
  });

  test("allows globally reachable 192.0.0.9/.10 and hosts outside the IETF /24", async () => {
    const bg = loadBackground(makeChrome());
    const targets = [
      "http://192.0.0.9/master.m3u8",
      "http://192.0.0.10/master.m3u8",
      "http://192.0.66.1/master.m3u8",
    ];
    const inspected = [];
    const inspector = async (value) => {
      inspected.push(value);
      return { is_master: true, child_keys: [] };
    };
    for (const target of targets) {
      const result = await bg.inspectHlsPlaylist(target, null, inspector);
      assert.equal(result && result.is_master, true, target);
    }
    assert.deepEqual(inspected, targets);
  });

  test("allows private playlists when the tab's own origin is private", async () => {
    const bg = loadBackground(makeChrome());
    const originalFetch = globalThis.fetch;
    const requests = [];
    globalThis.fetch = async (value) => {
      requests.push(String(value));
      return {
        ok: true,
        text: async () => "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nrendition.m3u8",
      };
    };
    try {
      const sameHost = "http://192.168.1.20/master.m3u8";
      const anotherLanHost = "http://192.168.1.21/master.m3u8";
      const privateTab = "http://192.168.1.20/watch";
      const isMaster = async (value, origin) => {
        const result = await bg.inspectHlsPlaylist(value, origin);
        return result === null ? null : result.is_master;
      };
      assert.equal(await isMaster(sameHost, privateTab), true);
      assert.equal(await isMaster(anotherLanHost, privateTab), true);
      assert.equal(
        await isMaster(anotherLanHost, "https://public.example/watch"),
        null,
      );
      assert.deepEqual(requests, [sameHost, anotherLanHost]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("opt-in video access", () => {
  const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

  /// Permissions + scripting mocks. `state.granted` is the page-access answer.
  function withPermissionApis(chrome, granted) {
    const state = {
      granted,
      webRequest: granted,
      registered: [],
      registerCalls: 0,
      unregisterCalls: 0,
    };
    chrome.permissions = {
      contains: async (query) =>
        query && query.permissions && query.permissions.includes("webRequest")
          ? state.webRequest && state.granted
          : state.granted,
      onAdded: { addListener: (fn) => { state.onAdded = fn; } },
      onRemoved: { addListener: (fn) => { state.onRemoved = fn; } },
    };
    chrome.scripting = {
      getRegisteredContentScripts: async ({ ids }) =>
        state.registered.filter((s) => ids.includes(s.id)),
      registerContentScripts: async (scripts) => {
        state.registerCalls += 1;
        await tick(5); // A real call is async: lets concurrent syncs interleave.
        for (const script of scripts) {
          if (state.registered.some((r) => r.id === script.id)) {
            throw new Error("Duplicate script ID: " + script.id);
          }
          state.registered.push(script);
        }
      },
      unregisterContentScripts: async ({ ids }) => {
        state.unregisterCalls += 1;
        state.registered = state.registered.filter((s) => !ids.includes(s.id));
      },
    };
    return state;
  }

  test("the detector is registered only with page access and detection on", async () => {
    const shared = {};
    const chrome = makeChrome(shared);
    const state = withPermissionApis(chrome, false);
    const bg = loadBackground(chrome);

    await bg.syncVideoScript();
    assert.equal(state.registered.length, 0, "no page access: nothing registered");

    state.granted = true;
    state.webRequest = true;
    await bg.syncVideoScript();
    assert.equal(state.registered.length, 1);
    const [script] = state.registered;
    assert.equal(script.id, bg.VIDEO_SCRIPT_ID);
    assert.deepEqual(script.matches, ["http://*/*", "https://*/*"]);
    assert.deepEqual(script.js, ["shared.js", "content.js"]);
    assert.equal(script.allFrames, true);

    shared.syncSettings.detectVideos = false;
    await bg.syncVideoScript();
    assert.equal(state.registered.length, 0, "detection off: unregistered");

    shared.syncSettings.detectVideos = true;
    state.granted = false;
    state.webRequest = false;
    await bg.syncVideoScript();
    assert.equal(state.registered.length, 0, "page access revoked: stays unregistered");
  });

  test("cookie-only page access does not enable video detection", async () => {
    const chrome = makeChrome();
    const state = withPermissionApis(chrome, false);
    const bg = loadBackground(chrome);

    // Pairing for cookie forwarding grants host access, but not webRequest.
    state.granted = true;
    state.webRequest = false;
    await bg.syncVideoScript();
    assert.equal(state.registered.length, 0, "site access alone is not video consent");

    state.webRequest = true;
    await bg.syncVideoScript();
    assert.equal(state.registered.length, 1, "video permission plus site access enables the detector");

    state.webRequest = false;
    await bg.syncVideoScript();
    assert.equal(state.registered.length, 0, "revoking webRequest unregisters the detector");
  });

  test("concurrent triggers register the script once", async () => {
    const chrome = makeChrome();
    const state = withPermissionApis(chrome, true);
    const bg = loadBackground(chrome);

    await Promise.all([bg.syncVideoScript(), bg.syncVideoScript(), bg.syncVideoScript()]);
    assert.equal(state.registerCalls, 1);
    assert.equal(state.registered.length, 1);
  });

  test("without the scripting namespace sync does nothing and does not throw", async () => {
    const chrome = makeChrome();
    loadBackground(chrome);
    const bg = loadBackground(chrome);
    await assert.doesNotReject(() => bg.syncVideoScript());
  });

  test("the worker starts without webRequest and registers the sniffer once it is granted", () => {
    const chrome = makeChrome();
    const state = withPermissionApis(chrome, false);
    delete chrome.webRequest; // A fresh install: optional permission not granted.
    const bg = loadBackground(chrome);
    assert.equal(bg.registerSniffer(), false, "no namespace, nothing to register");

    const event = {
      count: 0,
      addListener(fn, filter, extra) {
        this.count += 1;
        this.fn = fn;
        this.filter = filter;
        this.extra = extra;
      },
      hasListener(fn) {
        return this.fn === fn;
      },
    };
    chrome.webRequest = { onResponseStarted: event }; // The user granted it.
    state.onAdded({ permissions: ["webRequest"] });
    assert.equal(event.count, 1);
    assert.deepEqual(event.filter.types, ["media", "xmlhttprequest", "other"]);
    assert.deepEqual(event.extra, ["responseHeaders"]);

    state.onAdded({ origins: ["https://*/*"] }); // Another grant must not stack a duplicate.
    assert.equal(event.count, 1);
  });
});

describe("menu row titles", () => {
  test("ampersands and percent signs are escaped so page titles display literally", () => {
    const bg = loadBackground(makeChrome());
    // "&" would otherwise be swallowed as an access-key marker, "%s" replaced.
    assert.equal(bg.menuRowTitle("Tom & Jerry", ""), "Tom && Jerry");
    assert.equal(bg.menuRowTitle("100% pure", "720p"), "100%% pure • 720p");
    assert.equal(bg.menuRowTitle("Q&A: 50%s off", "1080p"), "Q&&A: 50%%s off • 1080p");
  });
});

describe("worker keep-alive during long handoff waits", () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  test("pings an extension API while the task runs and stops afterwards", async () => {
    const chrome = makeChrome();
    let pings = 0;
    chrome.runtime.getPlatformInfo = async () => {
      pings += 1;
      return {};
    };
    const bg = loadBackground(chrome);

    const result = await bg.withWorkerKeepAlive(async () => {
      await sleep(80);
      return "done";
    }, 10);
    assert.equal(result, "done");
    assert.ok(pings >= 3, `expected repeated pings, got ${pings}`);

    const after = pings;
    await sleep(50);
    assert.equal(pings, after, "the timer is cleared when the task ends");
  });

  test("stops pinging when the task rejects", async () => {
    const chrome = makeChrome();
    let pings = 0;
    chrome.runtime.getPlatformInfo = async () => {
      pings += 1;
      return {};
    };
    const bg = loadBackground(chrome);

    await assert.rejects(
      bg.withWorkerKeepAlive(async () => {
        await sleep(30);
        throw new Error("boom");
      }, 10),
      /boom/,
    );
    const after = pings;
    await sleep(50);
    assert.equal(pings, after);
  });

  test("runs the task unchanged where getPlatformInfo does not exist", async () => {
    const bg = loadBackground(makeChrome());
    assert.equal(await bg.withWorkerKeepAlive(async () => 42, 10), 42);
  });

  test("the keep-alive interval stays under Chrome's 30 s idle limit", () => {
    const bg = loadBackground(makeChrome());
    assert.ok(bg.KEEPALIVE_INTERVAL_MS < 30_000);
  });
});

describe("warned tabs survive a worker restart", () => {
  const tick = () => new Promise((r) => setTimeout(r, 30));

  test("additions and removals are written through and restored", async () => {
    const shared = {};
    const bg1 = loadBackground(makeChrome(shared));
    await bg1.warnedTabsReady;
    bg1._warnedTabs.add(7);
    bg1._warnedTabs.add(9);
    await tick();
    assert.deepEqual(shared.session.get("warnedTabs"), [7, 9]);

    // A new worker instance over the same session storage.
    const bg2 = loadBackground(makeChrome(shared));
    await bg2.warnedTabsReady;
    assert.equal(bg2._warnedTabs.has(7), true);
    assert.equal(bg2._warnedTabs.has(9), true);

    bg2._warnedTabs.delete(7);
    await tick();
    assert.deepEqual(shared.session.get("warnedTabs"), [9]);
  });

  test("ignores corrupt stored data", async () => {
    const shared = {};
    makeChrome(shared);
    shared.session.set("warnedTabs", ["x", 3, null, { a: 1 }]);
    const bg = loadBackground(makeChrome(shared));
    await bg.warnedTabsReady;
    assert.deepEqual([...bg._warnedTabs], [3]);
  });
});
