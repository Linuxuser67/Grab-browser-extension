// Tests for video detection (content.js + background.js helpers).
// Run with: node --test test/   (Node's built-in runner, no dependencies)
const { test, describe, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const BG_PATH = path.join(__dirname, "..", "background.js");
const CONTENT_PATH = path.join(__dirname, "..", "content.js");

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
      sync: {
        get: async (defaults) => ({ ...defaults, ...syncSettings }),
      },
      session: {
        get: async (key) => {
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
    },
    commands: { onCommand: capture("commands.onCommand") },
    webRequest: {
      onResponseStarted: capture("webRequest.onResponseStarted"),
    },
  };
  return chrome;
}

let bgLoadCount = 0;
async function loadBackground(chrome) {
  globalThis.chrome = chrome;
  // Cache-bust for fresh background.js state per test; sub-modules
  // are shared so reset their state explicitly.
  const bg = await import(BG_PATH + `?t=${++bgLoadCount}`);
  bg.__resetForTests();
  return bg;
}

function loadContent() {
  delete require.cache[require.resolve(CONTENT_PATH)];
  delete globalThis.chrome;
  delete globalThis.document;
  return require(CONTENT_PATH);
}

describe("classifyStream", () => {
  let bg;
  beforeEach(async () => {
    bg = await loadBackground(makeChrome());
  });

  test("an extension in the query string is not a media file", async () => {
    assert.equal(bg.classifyStream("https://example.com/page?file=a.mp4", ""), null);
    assert.equal(bg.classifyStream("https://example.com/watch?u=x.m3u8#t", ""), null);
    assert.equal(bg.classifyStream("https://cdn.example.com/v/clip.mp4?token=1", ""), "media");
    assert.equal(bg.classifyStream("https://cdn.example.com/s/a.m3u8?sig=2#x", ""), "manifest");
  });

  test("a click without a real tab falls back to the active tab", async () => {
    const chrome = makeChrome();
    await loadBackground(chrome);
    const L = chrome._listeners;
    await L["tabs.onActivated"]({ tabId: 5 });
    L["webRequest.onResponseStarted"]({ tabId: 5, url: "https://a.example.com/a.mp4", responseHeaders: [] });
    // Played-only menu: the sniffed URL needs a started video to surface.
    L["runtime.onMessage"](
      { type: "grab-videos-detected", videos: [{ src: "https://a.example.com/v.mp4", blob: false }] },
      { tab: { id: 5 } }
    );
    await new Promise((r) => setTimeout(r, 30));
    L["menus.onClicked"]({ menuItemId: "grabVideo:0" }, { id: -1 });
    const call = chrome._calls.find(([n]) => n === "tabs.update");
    assert.ok(call, "navigated");
    assert.equal(call[2], undefined, "no tab id passed for TAB_ID_NONE");
  });

  test("links carrying credentials are not handed off", async () => {
    assert.equal(bg.toGrabUrl("https://u:p@example.com/f.zip"), null);
    assert.equal(bg.toGrabUrl("https://u@example.com/f.zip"), null);
    // An @ later in the path or query is not userinfo.
    assert.equal(bg.toGrabUrl("https://example.com/a@b?x=y@z"), "grab://https/example.com/a@b?x=y@z");
  });

  test("manifest extensions classify without a content type", async () => {
    assert.equal(bg.classifyStream("https://cdn.example.com/s/manifest.m3u8", ""), "manifest");
    assert.equal(bg.classifyStream("https://cdn.example.com/s/manifest.m3u", ""), "manifest");
    assert.equal(bg.classifyStream("https://cdn.example.com/s/manifest.mpd", ""), "manifest");
  });

  test("manifest content types classify without an extension", async () => {
    assert.equal(
      bg.classifyStream("https://cdn.example.com/s/playlist", "application/vnd.apple.mpegurl"),
      "manifest"
    );
    assert.equal(
      bg.classifyStream("https://cdn.example.com/s/playlist", "application/dash+xml"),
      "manifest"
    );
  });

  test("direct video extensions classify as media", async () => {
    for (const ext of ["mp4", "m4v", "webm", "ogv", "mov", "mkv"]) {
      assert.equal(bg.classifyStream(`https://cdn.example.com/v/clip.${ext}`, ""), "media", ext);
    }
  });

  test("extension matching is case-insensitive and ignores query strings", async () => {
    assert.equal(bg.classifyStream("https://cdn.example.com/v/CLIP.MP4?token=abc", ""), "media");
  });

  test("segments, audio, images and junk classify as null", async () => {
    assert.equal(bg.classifyStream("https://cdn.example.com/s/seg1.ts", "video/mp2t"), null);
    assert.equal(bg.classifyStream("https://cdn.example.com/s/seg1.m4s", "video/mp4"), null);
    assert.equal(bg.classifyStream("https://cdn.example.com/a/song.mp3", "audio/mpeg"), null);
    assert.equal(bg.classifyStream("https://cdn.example.com/i/pic.png", "image/png"), null);
    assert.equal(bg.classifyStream("https://cdn.example.com/page", "text/html"), null);
  });

  test("extensionless video content types are not guessed (DASH segments look like this)", async () => {
    assert.equal(bg.classifyStream("https://cdn.example.com/s/seg", "video/mp4"), null);
  });

  test("garbage URLs classify as null", async () => {
    assert.equal(bg.classifyStream("not a url", ""), null);
    assert.equal(bg.classifyStream("", ""), null);
  });
});

describe("mergeVideoFinds", () => {
  let bg;
  beforeEach(async () => {
    bg = await loadBackground(makeChrome());
  });

  test("direct sources come first, then sniffed manifests, deduped", async () => {
    const merged = bg.mergeVideoFinds(
      [{ src: "https://a.example/1.mp4", blob: false }],
      ["https://a.example/1.mp4", "https://a.example/s.m3u8"]
    );
    assert.deepEqual(merged, ["https://a.example/1.mp4", "https://a.example/s.m3u8"]);
  });

  test("blob-only videos fall back to the sniffed manifests", async () => {
    const merged = bg.mergeVideoFinds(
      [{ src: null, blob: true }],
      ["https://a.example/s.m3u8"]
    );
    assert.deepEqual(merged, ["https://a.example/s.m3u8"]);
  });

  test("empty finds merge to empty", async () => {
    assert.deepEqual(bg.mergeVideoFinds([], []), []);
    assert.deepEqual(bg.mergeVideoFinds(null, null), []);
  });
});

describe("collectVideos (content script)", () => {
  let content;
  beforeEach(async () => {
    content = loadContent();
  });

  const fakeVideo = (opts) => ({
    currentSrc: opts.currentSrc !== undefined ? opts.currentSrc : opts.src || "",
    src: opts.src || "",
    videoWidth: opts.w || 0,
    videoHeight: opts.h || 0,
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ width: opts.w || 0, height: opts.h || 0 }),
  });
  const fakeDoc = (videos) => ({
    querySelectorAll: (sel) => (sel === "video" ? videos : []),
  });

  test("collects direct http(s) sources", async () => {
    const videos = content.collectVideos(
      fakeDoc([fakeVideo({ src: "https://cdn.example.com/v.mp4", w: 640, h: 360 })]),
      () => true
    );
    assert.deepEqual(videos, [{ src: "https://cdn.example.com/v.mp4", blob: false, height: 360 }]);
  });

  test("prefers currentSrc and scans <source> children", async () => {
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

  test("blob: sources are flagged, not collected", async () => {
    const videos = content.collectVideos(
      fakeDoc([fakeVideo({ src: "blob:https://example.com/uuid", w: 640, h: 360 })]),
      () => true
    );
    assert.deepEqual(videos, [{ src: null, blob: true, height: 360 }]);
  });

  test("tiny players are ignored (ads, trackers)", async () => {
    const videos = content.collectVideos(
      fakeDoc([fakeVideo({ src: "https://cdn.example.com/ad.mp4", w: 60, h: 40 })]),
      () => true
    );
    assert.deepEqual(videos, []);
  });

  test("no videos gives an empty list", async () => {
    assert.deepEqual(content.collectVideos(fakeDoc([]), () => true), []);
    assert.deepEqual(content.collectVideos(null, () => true), []);
  });

  test("unstarted videos are excluded by the played predicate", async () => {
    const started = {
      ...fakeVideo({ src: "https://cdn.example.com/a.mp4", w: 640, h: 360 }),
      _started: true,
    };
    const idle = {
      ...fakeVideo({ src: "https://cdn.example.com/b.mp4", w: 640, h: 360 }),
      _started: false,
    };
    const videos = content.collectVideos(
      fakeDoc([started, idle]),
      (v) => v._started === true
    );
    assert.deepEqual(videos, [{ src: "https://cdn.example.com/a.mp4", blob: false, height: 360 }]);
  });

  test("a video with no decoded height yet reports none", async () => {
    const videos = content.collectVideos(
      fakeDoc([{ ...fakeVideo({ src: "https://cdn.example.com/n.mp4", w: 640, h: 360 }), videoHeight: 0 }]),
      () => true
    );
    assert.deepEqual(videos, [{ src: "https://cdn.example.com/n.mp4", blob: false }]);
  });
});

describe("isStartedVideo (content script)", () => {
  let content;
  beforeEach(async () => {
    content = loadContent();
  });

  const playedSet = (videos) => {
    const s = new WeakSet();
    for (const v of videos) s.add(v);
    return s;
  };
  const pv = (opts) => ({
    muted: false,
    paused: true,
    ended: false,
    currentTime: 0,
    ...opts,
  });

  test("latched videos count even when paused (pause to right-click)", async () => {
    const video = pv({ paused: true, currentTime: 42 });
    assert.equal(content.isStartedVideo(video, playedSet([video])), true);
  });

  test("muted videos never count, latched or not", async () => {
    const latched = pv({ muted: true, paused: true, currentTime: 42 });
    assert.equal(content.isStartedVideo(latched, playedSet([latched])), false);
    const autoplaying = pv({ muted: true, paused: false, currentTime: 5 });
    assert.equal(content.isStartedVideo(autoplaying, playedSet([])), false);
  });

  test("audibly playing videos count without a latch (autoplay)", async () => {
    assert.equal(
      content.isStartedVideo(pv({ paused: false, currentTime: 5 }), playedSet([])),
      true
    );
  });

  test("paused, ended, or unstarted videos do not count", async () => {
    const empty = playedSet([]);
    assert.equal(content.isStartedVideo(pv({ paused: true, currentTime: 0 }), empty), false);
    assert.equal(
      content.isStartedVideo(pv({ paused: false, ended: true, currentTime: 5 }), empty),
      false
    );
    assert.equal(content.isStartedVideo(pv({ paused: false, currentTime: 0 }), empty), false);
    assert.equal(content.isStartedVideo(null, empty), false);
  });
});

describe("detection wiring", () => {
  const tick = () => new Promise((r) => setTimeout(r, 30));

  test("a sniffed manifest appears in the menu and badge once a video is played, and clicks hand off", async () => {
    const chrome = makeChrome();
    await loadBackground(chrome);
    const L = chrome._listeners;

    await L["tabs.onActivated"]({ tabId: 5 });
    L["webRequest.onResponseStarted"]({
      tabId: 5,
      url: "https://cdn.example.com/s/stream.m3u8",
      responseHeaders: [],
    });
    await tick();
    // Sniffing alone shows nothing: no video was started.
    assert.equal(
      chrome._calls.some(([n, id]) => n === "menus.create" && String(id).startsWith("grabVideo")),
      false,
      "no menu from sniffing alone"
    );
    // She presses play: the content script reports the started video.
    L["runtime.onMessage"](
      {
        type: "grab-videos-detected",
        videos: [{ src: "https://cdn.example.com/v/clip.mp4", blob: false }],
      },
      { tab: { id: 5 } }
    );
    await tick();

    const created = chrome._calls.filter(([n]) => n === "menus.create").map(([, id]) => id);
    assert.ok(created.includes("grabVideos"), "parent menu created");
    assert.ok(created.includes("grabVideo:0"), "child menu created");
    assert.ok(created.includes("grabVideo:1"), "sniffed manifest rides along");

    const badges = chrome._calls.filter(([n]) => n === "action.setBadgeText");
    const badge = badges[badges.length - 1];
    assert.deepEqual(badge[1], { tabId: 5, text: "2" });

    L["menus.onClicked"]({ menuItemId: "grabVideo:1" }, null);
    assert.ok(
      chrome._calls.some(
        ([n, arg]) => n === "tabs.update" && arg.url === "grab://https/cdn.example.com/s/stream.m3u8"
      ),
      "click navigates the active tab to the grab: URL"
    );
  });

  test("a click resolves against the list the menu was built from (other window focused)", async () => {
    const chrome = makeChrome();
    await loadBackground(chrome);
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
    // The menu was built from tab 6: [v.mp4, b.mp4, c.mp4], so index 2 is c.mp4.
    L["menus.onClicked"]({ menuItemId: "grabVideo:2" }, { id: 5 });
    assert.ok(
      chrome._calls.some(([n, arg]) => n === "tabs.update" && arg.url === "grab://https/b.example.com/c.mp4"),
      "the labelled item (third entry of the menu) is what gets sent"
    );
  });

  test("a click after master-playlist filtering sends the master, not the hidden child", async () => {
    const chrome = makeChrome();
    await loadBackground(chrome);
    globalThis.fetch = async (url) => ({
      ok: true,
      text: async () =>
        String(url).endsWith("master.m3u8")
          ? "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n720/index.m3u8\n"
          : "#EXTM3U\n#EXT-X-TARGETDURATION=6\n",
    });
    const L = chrome._listeners;
    await L["tabs.onActivated"]({ tabId: 5 });
    L["webRequest.onResponseStarted"]({ tabId: 5, url: "https://cdn.example.com/v/index.m3u8", responseHeaders: [] });
    L["webRequest.onResponseStarted"]({ tabId: 5, url: "https://cdn.example.com/v/master.m3u8", responseHeaders: [] });
    // Played-only menu: the sniffed manifests need a started video to surface.
    L["runtime.onMessage"](
      { type: "grab-videos-detected", videos: [{ src: "https://cdn.example.com/v/clip.mp4", blob: false }] },
      { tab: { id: 5 } }
    );
    await tick();
    await tick();
    // Menu is [clip.mp4, master.m3u8]: the direct source first, then the
    // filtered master.
    L["menus.onClicked"]({ menuItemId: "grabVideo:1" }, { id: 5 });
    assert.ok(
      chrome._calls.some(([n, arg]) => n === "tabs.update" && arg.url === "grab://https/cdn.example.com/v/master.m3u8"),
      "master playlist is sent"
    );
  });

  test("content-script reports reach the menu", async () => {
    const chrome = makeChrome();
    await loadBackground(chrome);
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
    L["menus.onClicked"]({ menuItemId: "grabVideo:0" }, null);
    assert.ok(
      chrome._calls.some(
        ([n, arg]) => n === "tabs.update" && arg.url === "grab://https/cdn.example.com/v/clip.mp4"
      )
    );
  });

  test("reports from two frames merge instead of overwriting", async () => {
    const chrome = makeChrome();
    await loadBackground(chrome);
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

    L["menus.onClicked"]({ menuItemId: "grabVideo:1" }, null);
    assert.ok(
      chrome._calls.some(
        ([n, arg]) => n === "tabs.update" && arg.url === "grab://https/cdn.example.com/v/b.mp4"
      )
    );
  });

  test("a blob: video is paired with the tab's sniffed manifest", async () => {
    const chrome = makeChrome();
    await loadBackground(chrome);
    const L = chrome._listeners;

    await L["tabs.onActivated"]({ tabId: 9 });
    L["webRequest.onResponseStarted"]({
      tabId: 9,
      url: "https://cdn.example.com/s/stream.m3u8",
      responseHeaders: [],
    });
    L["runtime.onMessage"](
      { type: "grab-videos-detected", videos: [{ src: null, blob: true }] },
      { tab: { id: 9 } }
    );
    await tick();

    L["menus.onClicked"]({ menuItemId: "grabVideo:0" }, null);
    assert.ok(
      chrome._calls.some(
        ([n, arg]) => n === "tabs.update" && arg.url === "grab://https/cdn.example.com/s/stream.m3u8"
      )
    );
  });

  test("detection off stays silent", async () => {
    const chrome = makeChrome({ syncSettings: { detectVideos: false } });
    await loadBackground(chrome);
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
    await loadBackground(chrome);
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
  test("worker starts using only permitted chrome namespaces", async () => {
    // Regression: 1.0.5 called chrome.webNavigation.onCommitted at the top
    // level without declaring the permission. In a real browser that namespace
    // is undefined, so the whole service worker died on startup — no context
    // menu at all. The Node mock had always provided webNavigation, so the
    // suite stayed green. This test wraps the mock in a Proxy that throws on
    // any top-level chrome namespace the manifest doesn't grant (plus the
    // namespaces Chrome exposes without a permission), so the same class of
    // bug fails here instead of in the user's browser.
    const fs = require("node:fs");
    const manifest = JSON.parse(
      fs.readFileSync(path.join(__dirname, "..", "manifest.json"), "utf8")
    );
    const allowed = new Set([
      ...manifest.permissions,
      // Exposed without a permission: runtime/action always; tabs as a
      // namespace (url/title stay hidden without the "tabs" permission, which
      // the worker doesn't need); commands via manifest key bindings.
      "runtime",
      "tabs",
      "action",
      "commands",
      // windows: no manifest permission needed (only used for focus events,
      // behind an existence check).
      "windows",
    ]);
    const chrome = makeChrome();
    const guarded = new Proxy(chrome, {
      get(target, prop, receiver) {
        if (typeof prop === "string" && !prop.startsWith("_") && !allowed.has(prop)) {
          throw new Error(`chrome.${prop} used but not in manifest permissions`);
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    assert.doesNotThrow(async () => await loadBackground(guarded));
  });
});

describe("excluded hosts", () => {
  const tick = () => new Promise((r) => setTimeout(r, 30));

  test("hostExcluded matches hosts and subdomains only", async () => {
    const bg = await loadBackground(makeChrome());
    for (const h of [
      "instagram.com",
      "www.tiktok.com",
      "vm.tiktok.com",
      "youtube.com",
      "www.youtube.com",
      "youtu.be",
      "vimeo.com",
      "www.dailymotion.com",
      "dai.ly",
      "facebook.com",
      "fb.watch",
      "twitter.com",
      "x.com",
      "www.twitch.tv",
      "INSTAGRAM.COM",
    ]) {
      assert.ok(bg.hostExcluded(h), h);
    }
    for (const h of [
      "example.com",
      "rumble.com",
      "tiktok.com.evil.com",
      "nottiktok.com",
      "x.com.evil.com",
      "",
    ]) {
      assert.equal(bg.hostExcluded(h), false, h);
    }
    assert.equal(bg.hostExcluded(null), false);
  });

  test("content script hostExcluded agrees with the worker's", async () => {
    const bg = await loadBackground(makeChrome());
    const content = loadContent();
    assert.deepEqual(
      [...content.DETECT_EXCLUDED_HOSTS].sort(),
      [...bg.YTDLP_EXCLUSIVE_HOSTS].sort(),
      "the two exclusion lists must stay in sync"
    );
    for (const h of ["instagram.com", "www.tiktok.com", "youtube.com", "x.com", "example.com"]) {
      assert.equal(content.hostExcluded(h), bg.hostExcluded(h), h);
    }
  });

  test("no menu or badge on excluded hosts, even with finds", async () => {
    const chrome = makeChrome();
    // The tab lives on TikTok: direct sources and sniffed manifests exist,
    // but nothing may be shown.
    chrome.tabs.get = async (id) => ({ id, url: "https://www.tiktok.com/@u/video/1" });
    await loadBackground(chrome);
    const L = chrome._listeners;

    await L["tabs.onActivated"]({ tabId: 7 });
    L["webRequest.onResponseStarted"]({
      tabId: 7,
      url: "https://cdn.example.com/s/stream.m3u8",
      responseHeaders: [],
    });
    await tick();
    await tick();
    assert.equal(
      chrome._calls.some(([n, id]) => n === "menus.create" && String(id).startsWith("grabVideo")),
      false,
      "no video menu on excluded host"
    );
    assert.equal(
      chrome._calls.some(([n, arg]) => n === "action.setBadgeText" && arg.text !== ""),
      false,
      "no badge on excluded host"
    );
  });

  test("non-excluded hosts still get the menu", async () => {
    const chrome = makeChrome();
    await loadBackground(chrome);
    const L = chrome._listeners;

    await L["tabs.onActivated"]({ tabId: 9 });
    L["webRequest.onResponseStarted"]({
      tabId: 9,
      url: "https://cdn.example.com/s/stream.m3u8",
      responseHeaders: [],
    });
    // Played-only menu: the sniffed manifest needs a started video to surface.
    L["runtime.onMessage"](
      { type: "grab-videos-detected", videos: [{ src: "https://cdn.example.com/v/clip.mp4", blob: false }] },
      { tab: { id: 9 } }
    );
    await tick();
    await tick();
    assert.ok(
      chrome._calls.some(([n, id]) => n === "menus.create" && id === "grabVideo:0"),
      "menu shown on ordinary hosts"
    );
  });

  test("a report with a stale active-tab cache still builds the menu", async () => {
    // Simulates a worker restart: the in-memory activeTabId is gone (no
    // onActivated fired), but the tab is live. The old code dropped the
    // report and the menu never appeared until the next tab switch.
    const chrome = makeChrome();
    await loadBackground(chrome);
    const L = chrome._listeners;
    chrome.tabs.query = (q, cb) => cb([{ id: 5 }]);

    L["runtime.onMessage"](
      {
        type: "grab-videos-detected",
        videos: [{ src: "https://cdn.example.com/v/clip.mp4", blob: false }],
      },
      { tab: { id: 5 } }
    );
    await tick();
    await tick();
    assert.ok(
      chrome._calls.some(([n, id]) => n === "menus.create" && id === "grabVideo:0"),
      "menu built after live verification, no tab switch needed"
    );
  });

  test("a report from a background tab stays silent with a stale cache", async () => {
    const chrome = makeChrome();
    await loadBackground(chrome);
    const L = chrome._listeners;
    chrome.tabs.query = (q, cb) => cb([{ id: 9 }]);

    L["runtime.onMessage"](
      {
        type: "grab-videos-detected",
        videos: [{ src: "https://cdn.example.com/v/clip.mp4", blob: false }],
      },
      { tab: { id: 5 } }
    );
    await tick();
    await tick();
    assert.equal(
      chrome._calls.some(([n, id]) => n === "menus.create" && String(id).startsWith("grabVideo")),
      false,
      "no menu for a tab that is not live-active"
    );
  });
});

describe("preferMasterPlaylists", () => {
  let bg;
  const MASTER = "https://cdn.example.com/hls/master.m3u8";
  const VIDEO_PL = "https://cdn.example.com/hls/index-v1.m3u8";
  const AUDIO_PL = "https://cdn.example.com/hls/index-v1-a1.m3u8";
  const OTHER_DIR = "https://cdn.example.com/other/clip.m3u8";
  const MP4 = "https://cdn.example.com/v/clip.mp4";

  const MASTER_BODY = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360\nindex-v1.m3u8\n";
  const MEDIA_BODY = "#EXTM3U\n#EXT-X-TARGETDURATION=6\n#EXTINF:6.0,\nseg1.ts\n";

  beforeEach(async () => {
    bg = await loadBackground(makeChrome());
    // Mock fetch: master for MASTER, media playlist for the rest.
    globalThis.fetch = async (url) => ({
      ok: true,
      text: async () => (String(url).includes("master.m3u8") ? MASTER_BODY : MEDIA_BODY),
    });
  });

  test("keeps only the master when its children are detected", async () => {
    const out = await bg.preferMasterPlaylists([MASTER, VIDEO_PL, AUDIO_PL]);
    assert.deepEqual(out, [MASTER]);
  });

  test("keeps manifests outside the master directory", async () => {
    const out = await bg.preferMasterPlaylists([MASTER, VIDEO_PL, OTHER_DIR]);
    assert.deepEqual(out, [MASTER, OTHER_DIR]);
  });

  test("keeps non-manifest URLs untouched", async () => {
    const out = await bg.preferMasterPlaylists([MASTER, VIDEO_PL, MP4]);
    assert.deepEqual(out, [MASTER, MP4]);
  });

  test("returns everything when no master is confirmed", async () => {
    globalThis.fetch = async () => ({ ok: true, text: async () => MEDIA_BODY });
    // Fresh module so the cache from beforeEach doesn't leak.
    bg = await loadBackground(makeChrome());
    const out = await bg.preferMasterPlaylists([VIDEO_PL, AUDIO_PL]);
    assert.deepEqual(out, [VIDEO_PL, AUDIO_PL]);
  });

  test("returns everything when the fetch fails", async () => {
    globalThis.fetch = async () => { throw new Error("denied"); };
    bg = await loadBackground(makeChrome());
    const out = await bg.preferMasterPlaylists([MASTER, VIDEO_PL]);
    assert.deepEqual(out, [MASTER, VIDEO_PL]);
  });

  test("isMasterPlaylist caches its result", async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return { ok: true, text: async () => MASTER_BODY };
    };
    bg = await loadBackground(makeChrome());
    assert.equal(await bg.isMasterPlaylist(MASTER), true);
    assert.equal(await bg.isMasterPlaylist(MASTER), true);
    assert.equal(calls, 1, "second call served from cache");
  });

  test("drops master-referenced variants outside the master directory", async () => {
    // CDN-split deployment: the rendition lives under /videos/, not /hls/.
    const body = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360\n../videos/v1.m3u8\n";
    globalThis.fetch = async (url) => ({
      ok: true,
      text: async () => (String(url).includes("master.m3u8") ? body : MEDIA_BODY),
    });
    bg = await loadBackground(makeChrome());
    const CROSS_DIR = "https://cdn.example.com/videos/v1.m3u8";
    const out = await bg.preferMasterPlaylists([MASTER, CROSS_DIR]);
    assert.deepEqual(out, [MASTER]);
  });

  test("matches variants by path key when tokens rotate", async () => {
    // The master references ?session=AAA but the player fetched ?session=BBB,
    // and the variant lives outside the master's directory (only the path
    // key matches, not the directory heuristic).
    const body = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360\n../videos/v1.m3u8?session=AAA\n";
    globalThis.fetch = async (url) => ({
      ok: true,
      text: async () => (String(url).includes("master.m3u8") ? body : MEDIA_BODY),
    });
    bg = await loadBackground(makeChrome());
    const ROTATED = "https://cdn.example.com/videos/v1.m3u8?session=BBB";
    const out = await bg.preferMasterPlaylists([MASTER, ROTATED]);
    assert.deepEqual(out, [MASTER]);
  });

  test("drops audio-grouped variants referenced by the master", async () => {
    // fetchAllVariants (used for filtering) sees every rendition, unlike
    // getHlsVariants which keeps muxed-only for the submenu.
    const body = [
      "#EXTM3U",
      '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,AUDIO="a1"',
      "../videos/v1.m3u8",
    ].join("\n");
    globalThis.fetch = async (url) => ({
      ok: true,
      text: async () => (String(url).includes("master.m3u8") ? body : MEDIA_BODY),
    });
    bg = await loadBackground(makeChrome());
    const CROSS_DIR = "https://cdn.example.com/videos/v1.m3u8";
    const out = await bg.preferMasterPlaylists([MASTER, CROSS_DIR]);
    assert.deepEqual(out, [MASTER]);
  });

  test("drops EXT-X-MEDIA audio playlists outside the master directory", async () => {
    const body = [
      "#EXTM3U",
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a1",NAME="English",URI="/audio/en.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,AUDIO="a1"',
      "index-v1.m3u8",
    ].join("\n");
    globalThis.fetch = async (url) => ({
      ok: true,
      text: async () => (String(url).includes("master.m3u8") ? body : MEDIA_BODY),
    });
    bg = await loadBackground(makeChrome());
    const AUDIO_PL = "https://cdn.example.com/audio/en.m3u8";
    const out = await bg.preferMasterPlaylists([MASTER, VIDEO_PL, AUDIO_PL]);
    assert.deepEqual(out, [MASTER]);
  });

  test("collapses to the unfetchable master when its variants are confirmed non-masters", async () => {
    // The master URL can't be read (expiring token) but its 7 chunklists
    // can: 5 video + 2 audio, all confirmed media playlists. The failed
    // fetch among confirmed non-masters marks this as one stream.
    const DIR = "https://cdn.example.com/s/origin.stream123";
    const UNFETCHABLE = `${DIR}/llhls.m3u8?token=ABC`;
    const chunks = Array.from({ length: 7 }, (_, i) => `${DIR}/chunklist_${i}_llhls.m3u8?session=S1`);
    globalThis.fetch = async (url) => {
      if (String(url).includes("llhls.m3u8?token=")) throw new Error("403");
      return { ok: true, text: async () => MEDIA_BODY };
    };
    bg = await loadBackground(makeChrome());
    const out = await bg.preferMasterPlaylists([UNFETCHABLE, ...chunks]);
    assert.deepEqual(out, [UNFETCHABLE]);
  });

  test("keeps both when the failed fetch wasn't sniffed first", async () => {
    // A dead video's playlist (failed fetch) sniffed AFTER a working one:
    // the failure is a different video, not this group's master.
    const DIR = "https://cdn.example.com/s";
    const WORKING = `${DIR}/b.m3u8`;
    const DEAD = `${DIR}/a.m3u8`;
    globalThis.fetch = async (url) => {
      if (String(url).endsWith("/a.m3u8")) throw new Error("403");
      return { ok: true, text: async () => MEDIA_BODY };
    };
    bg = await loadBackground(makeChrome());
    const out = await bg.preferMasterPlaylists([WORKING, DEAD]);
    assert.deepEqual(out, [WORKING, DEAD]);
  });

});

describe("pageVideoTitle", () => {
  let content;
  beforeEach(async () => {
    content = loadContent();
  });

  test("reads og:title", async () => {
    const doc = {
      querySelector: (sel) =>
        sel === 'meta[property="og:title"]' ? { content: "  My Video  " } : null,
    };
    assert.equal(content.pageVideoTitle(doc), "My Video");
  });

  test("empty when no og:title", async () => {
    const doc = { querySelector: () => null };
    assert.equal(content.pageVideoTitle(doc), "");
  });

  test("empty on missing document", async () => {
    assert.equal(content.pageVideoTitle(null), "");
  });
});

describe("parseHlsVariants", () => {
  let bg;
  const BASE = "https://cdn.example.com/hls/master.m3u8";

  beforeEach(async () => {
    bg = await loadBackground(makeChrome());
  });

  test("extracts resolution and bandwidth per variant", async () => {
    const body = [
      "#EXTM3U",
      '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360',
      "index-v1.m3u8",
      '#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720',
      "index-v2.m3u8",
      '#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080',
      "index-v3.m3u8",
    ].join("\n");
    const out = bg.parseHlsVariants(body, BASE);
    assert.equal(out.length, 3);
    assert.equal(out[0].height, 360);
    assert.equal(out[0].bandwidth, 800000);
    assert.equal(out[0].url, "https://cdn.example.com/hls/index-v1.m3u8");
    assert.equal(out[2].height, 1080);
  });

  test("handles missing resolution gracefully", async () => {
    const body = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nindex-v1.m3u8\n";
    const out = bg.parseHlsVariants(body, BASE);
    assert.equal(out.length, 1);
    assert.equal(out[0].height, null);
    assert.equal(out[0].bandwidth, 800000);
  });

  test("returns empty for media playlists", async () => {
    const body = "#EXTM3U\n#EXT-X-TARGETDURATION=6\n#EXTINF:6.0,\nseg1.ts\n";
    assert.deepEqual(bg.parseHlsVariants(body, BASE), []);
  });

  test("resolves relative URIs against the master", async () => {
    const body = "#EXTM3U\n#EXT-X-STREAM-INF:RESOLUTION=1280x720\n../other/v.m3u8\n";
    const out = bg.parseHlsVariants(body, BASE);
    assert.equal(out[0].url, "https://cdn.example.com/other/v.m3u8");
  });
});

describe("variantMenuTitle", () => {
  let bg;

  beforeEach(async () => {
    bg = await loadBackground(makeChrome());
  });

  test("shows height as 720p-style label", async () => {
    assert.equal(bg.variantMenuTitle({ url: "https://x/y.m3u8", height: 720 }, 0), "720p");
    assert.equal(bg.variantMenuTitle({ url: "https://x/y.m3u8", height: 1080 }, 0), "1080p");
  });

  test("combines height, bitrate and fps", async () => {
    assert.equal(
      bg.variantMenuTitle(
        { url: "https://x/y.m3u8", height: 1080, bandwidth: 8000000, fps: 60 },
        0
      ),
      "1080p • 8.00 Mbps • 60 fps"
    );
  });

  test("falls back to bandwidth when height is absent", async () => {
    assert.equal(
      bg.variantMenuTitle({ url: "https://x/y.m3u8", height: null, bandwidth: 2500000 }, 0),
      "2.50 Mbps"
    );
  });
});

describe("HLS variant parsing", () => {
  let bg;
  const MASTER = "https://cdn.example.com/hls/master.m3u8";

  beforeEach(async () => {
    bg = await loadBackground(makeChrome());
  });

  test("parseHlsVariants captures the audio group", async () => {
    const body = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=640x360,AUDIO="a1"\nv.m3u8\n';
    const out = bg.parseHlsVariants(body, MASTER);
    assert.equal(out[0].audioGroup, "a1");
    const body2 = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=640x360\nv.m3u8\n";
    assert.equal(bg.parseHlsVariants(body2, MASTER)[0].audioGroup, null);
  });
});

describe("collection-time exclusion", () => {
  const tick = () => new Promise((r) => setTimeout(r, 30));

  test("webRequest sniffer skips yt-dlp-exclusive hosts", async () => {
    const chrome = makeChrome();
    // Mock tabs.get to return a YouTube URL.
    chrome.tabs.get = async (id) => ({ id, url: "https://www.youtube.com/watch?v=x" });
    const bg = await loadBackground(chrome);
    const L = chrome._listeners;
    await L["tabs.onActivated"]({ tabId: 5 });
    // Sniff a manifest on the YouTube tab.
    await L["webRequest.onResponseStarted"]({
      tabId: 5,
      url: "https://cdn.example.com/hls/master.m3u8",
      responseHeaders: [{ name: "content-type", value: "application/vnd.apple.mpegurl" }],
    });
    await tick();
    await tick();
    // The URL was never stored: collection-time filter, not just menu-build.
    assert.equal(bg._videoFinds.has(5), false, "no finds stored for excluded host");
    const menuCreates = chrome._calls.filter(([n]) => n === "contextMenus.create");
    assert.equal(menuCreates.length, 0, "no menu items for excluded host");
  });

  test("content-script reports are dropped on excluded hosts", async () => {
    const chrome = makeChrome();
    const bg = await loadBackground(chrome);
    const L = chrome._listeners;
    await L["tabs.onActivated"]({ tabId: 5 });
    // Simulate a content-script message from a YouTube tab.
    await L["runtime.onMessage"](
      { type: "grab-videos-detected", videos: [{ src: "https://cdn.example.com/v.mp4" }] },
      { tab: { id: 5, url: "https://www.youtube.com/watch?v=x" }, frameId: 0 }
    );
    await tick();
    await tick();
    assert.equal(bg._videoFinds.has(5), false, "no finds stored for excluded host");
    const menuCreates = chrome._calls.filter(([n]) => n === "contextMenus.create");
    assert.equal(menuCreates.length, 0, "no menu items for excluded host");
  });
});

describe("videoName", () => {
  let bg;
  beforeEach(async () => {
    bg = await loadBackground(makeChrome());
  });

  test("a direct file is named by its file name, whatever the page title", async () => {
    assert.equal(bg.videoName("https://cdn.example.com/v/clip.mp4?t=1", 0, "Some Page Title", null), "clip.mp4");
    assert.equal(bg.videoName("https://cdn.example.com/v/clip.mp4", 0, "", null), "clip.mp4");
  });

  test("decodes escapes and survives a malformed one", async () => {
    assert.equal(bg.videoName("https://cdn.example.com/v/my%20clip.mp4", 0, "", null), "my clip.mp4");
    assert.equal(bg.videoName("https://cdn.example.com/v/bad%E0%A4%A.mp4", 0, "", null), "bad%E0%A4%A.mp4");
  });

  test("truncates long names with an ellipsis", async () => {
    const name = bg.videoName(`https://cdn.example.com/v/${"a".repeat(60)}.mp4`, 0, "", null);
    assert.ok(name.length <= 17);
    assert.ok(name.endsWith(".mp4"));
  });

  test("a stream is named by the whole page video title", async () => {
    assert.equal(
      bg.videoName("https://cdn.example.com/hls/master.m3u8", 0, "  Example   Video Title ", "hls"),
      "Example Video T…"
    );
    assert.equal(
      bg.videoName("https://cdn.example.com/d/manifest.mpd", 0, "My Show", "dash"),
      "My Show"
    );
  });

  test("a stream without a title falls back to its file name", async () => {
    assert.equal(bg.videoName("https://cdn.example.com/hls/master.m3u8", 0, "", "hls"), "master.m3u8");
  });

  test("Video N is the last resort", async () => {
    assert.equal(bg.videoName("https://cdn.example.com/", 2, "", null), "Video 3");
    assert.equal(bg.videoName("not a url", 0, "", null), "Video 1");
  });

  test("menuRowTitle joins name and quality and escapes %", async () => {
    assert.equal(bg.menuRowTitle("clip.mp4", "1080p"), "clip.mp4 • 1080p");
    assert.equal(bg.menuRowTitle("clip.mp4", ""), "clip.mp4");
    assert.equal(bg.menuRowTitle("100%s", ""), "100%%s");
  });
});

describe("menu rows", () => {
  let bg;
  const MASTER = "https://cdn.example.com/hls/master.m3u8";
  const withFetch = async (body, fn) => {
    const prev = globalThis.fetch;
    globalThis.fetch = async () =>
      body === null ? { ok: false } : { ok: true, text: async () => body };
    try {
      return await fn();
    } finally {
      globalThis.fetch = prev;
    }
  };

  beforeEach(async () => {
    bg = await loadBackground(makeChrome());
  });

  test("muxed HLS renditions hand their own URL, best first", async () => {
    const body = [
      "#EXTM3U",
      "#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360",
      "v360.m3u8",
      "#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080",
      "v1080.m3u8",
      "#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720",
      "v720.m3u8",
    ].join("\n");
    const rows = await withFetch(body, () => bg.hlsMenuRows(MASTER));
    assert.deepEqual(
      rows.map((r) => r.quality),
      ["1080p • 5.00 Mbps", "720p • 2.00 Mbps", "360p • 0.80 Mbps"]
    );
    assert.equal(rows[0].url, "https://cdn.example.com/hls/v1080.m3u8");
  });

  test("a lone muxed rendition hands the master", async () => {
    const body = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720\nv720.m3u8\n";
    const rows = await withFetch(body, () => bg.hlsMenuRows(MASTER));
    assert.deepEqual(rows, [{ quality: "720p • 2.00 Mbps", height: 720, url: MASTER }]);
  });

  test("separate-audio HLS is one row listing the qualities, handing the master", async () => {
    const body = [
      "#EXTM3U",
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a1",NAME="en",URI="audio.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,AUDIO="a1"',
      "v360.m3u8",
      '#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720,AUDIO="a1"',
      "v720.m3u8",
    ].join("\n");
    const rows = await withFetch(body, () => bg.hlsMenuRows(MASTER));
    assert.deepEqual(rows, [{ quality: "720p / 360p • pick in Grab", height: 720, url: MASTER }]);
  });

  test("mixed master: muxed rows plus one pick row for the taller split ones", async () => {
    const body = [
      "#EXTM3U",
      "#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360",
      "m360.m3u8",
      "#EXT-X-STREAM-INF:BANDWIDTH=1500000,RESOLUTION=1280x720",
      "m720.m3u8",
      '#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080,AUDIO="a1"',
      "s1080.m3u8",
      '#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=640x360,AUDIO="a1"',
      "s360.m3u8",
    ].join("\n");
    const rows = await withFetch(body, () => bg.hlsMenuRows(MASTER));
    assert.deepEqual(rows, [
      { quality: "720p • 1.50 Mbps", height: 720, url: "https://cdn.example.com/hls/m720.m3u8" },
      { quality: "360p • 0.80 Mbps", height: 360, url: "https://cdn.example.com/hls/m360.m3u8" },
      { quality: "1080p • pick in Grab", height: 1080, url: MASTER },
    ]);
  });

  test("audio-only renditions are never listed", async () => {
    const body = [
      "#EXTM3U",
      '#EXT-X-STREAM-INF:BANDWIDTH=64000,CODECS="mp4a.40.2"',
      "audio.m3u8",
      '#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2"',
      "v720.m3u8",
    ].join("\n");
    const rows = await withFetch(body, () => bg.hlsMenuRows(MASTER));
    assert.deepEqual(rows, [{ quality: "720p • 2.00 Mbps", height: 720, url: MASTER }]);
  });

  test("a media playlist or unreadable master is one plain row", async () => {
    const plain = [{ quality: "", url: MASTER, height: 0 }];
    assert.deepEqual(
      await withFetch("#EXTM3U\n#EXT-X-TARGETDURATION=6\n", () => bg.hlsMenuRows(MASTER)),
      plain
    );
    bg = await loadBackground(makeChrome());
    assert.deepEqual(await withFetch(null, () => bg.hlsMenuRows(MASTER)), plain);
  });

  const MPD = `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011"><Period>
  <AdaptationSet contentType="video" mimeType="video/mp4" frameRate="30000/1001">
    <Representation id="v1" bandwidth="800000" width="640" height="360" codecs="avc1.4d401e"/>
    <Representation id="v2" bandwidth="5000000" width="1920" height="1080" codecs="avc1.640028">
      <SegmentTemplate media="v2-$Number$.m4s"/>
    </Representation>
    <Representation id="v2b" bandwidth="5000000" height="1080"/>
  </AdaptationSet>
  <AdaptationSet contentType="audio" mimeType="audio/mp4">
    <Representation id="a1" bandwidth="128000" codecs="mp4a.40.2"/>
  </AdaptationSet>
  <AdaptationSet contentType="image" mimeType="image/jpeg">
    <Representation id="t1" bandwidth="1000" height="90"/>
  </AdaptationSet>
</Period></MPD>`;

  test("parseDashRepresentations keeps video only, best first, deduplicated", async () => {
    assert.deepEqual(bg.parseDashRepresentations(MPD), [
      { height: 1080, bandwidth: 5000000, fps: 29.97 },
      { height: 360, bandwidth: 800000, fps: 29.97 },
    ]);
    assert.deepEqual(bg.parseDashRepresentations("not xml"), []);
  });

  test("DASH is one row listing the qualities, handing the MPD", async () => {
    const url = "https://cdn.example.com/d/manifest.mpd";
    assert.deepEqual(await withFetch(MPD, () => bg.dashMenuRows(url)), [
      { quality: "1080p30 / 360p30 • pick in Grab", url, height: 1080 },
    ]);
    bg = await loadBackground(makeChrome());
    assert.deepEqual(await withFetch(null, () => bg.dashMenuRows(url)), [{ quality: "", url, height: 0 }]);
  });

  test("direct files carry the reported height", async () => {
    assert.deepEqual(bg.directMenuRow("https://c.example.com/clip.mp4", 1080), {
      quality: "1080p",
      url: "https://c.example.com/clip.mp4",
      height: 1080,
    });
    assert.equal(bg.directMenuRow("https://c.example.com/clip.mp4", 0).quality, "");
  });

  test("manifestKind: extension first, content sniff for extensionless manifests", async () => {
    assert.equal(await bg.manifestKind("https://x.example/a.m3u8?t=1", null), "hls");
    assert.equal(await bg.manifestKind("https://x.example/a.mpd", null), "dash");
    assert.equal(await bg.manifestKind("https://x.example/a.mp4", "media"), null);
    assert.equal(await bg.manifestKind("https://x.example/play", null), null);
    assert.equal(
      await withFetch("#EXTM3U\n", () => bg.manifestKind("https://x.example/play1", "manifest")),
      "hls"
    );
    assert.equal(
      await withFetch(MPD, () => bg.manifestKind("https://x.example/play2", "manifest")),
      "dash"
    );
    assert.equal(
      await withFetch("<html/>", () => bg.manifestKind("https://x.example/play3", "manifest")),
      null
    );
  });

  test("uniqueLabels numbers repeats only", async () => {
    assert.deepEqual(bg.uniqueLabels(["Show", "Clip", "Show", "Show"]), [
      "Show",
      "Clip",
      "Show (2)",
      "Show (3)",
    ]);
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
  async function build({ manifestBody, manifestUrl, videos, title }) {
    const prev = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, text: async () => manifestBody });
    try {
      const chrome = makeChrome();
      const created = new Map();
      const orig = chrome.contextMenus.create;
      chrome.contextMenus.create = (props) => {
        created.set(props.id, props);
        return orig(props);
      };
      await loadBackground(chrome);
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
    } finally {
      globalThis.fetch = prev;
    }
  }
  const rowsOf = (items) =>
    items.filter((i) => i.parentId === "grabVideos" && i.type !== "separator");
  const click = (chrome, id) =>
    chrome._listeners["menus.onClicked"]({ menuItemId: id }, { id: 3 });
  const sent = (chrome) =>
    chrome._calls.filter(([n]) => n === "tabs.update").map(([, a]) => a.url);

  test("every row sits directly under the single submenu", async () => {
    const { items } = await build({
      manifestBody: MUXED,
      manifestUrl: "https://cdn.example.com/hls/master.m3u8",
      videos: [{ src: "https://cdn.example.com/v/clip.mp4", blob: false, height: 1080 }],
      title: "Example Video Title",
    });
    // Nothing is nested deeper than the root submenu.
    const ids = new Set(items.map((i) => i.id));
    assert.ok(items.every((i) => i.parentId === undefined || i.parentId === "grabVideos"));
    assert.ok(ids.has("grabVideos"));
    assert.deepEqual(rowsOf(items).map((i) => i.title), [
      "clip.mp4 • 1080p",
      "Example Video T… • 1080p • 5.00 Mbps",
      "Example Video T… • 720p • 2.00 Mbps",
      "Example Video T… • 360p • 0.80 Mbps",
    ]);
    assert.ok(items.every((i) => i.enabled !== false));
  });

  test("a click on a row sends that row's URL to Grab", async () => {
    const { chrome, items } = await build({
      manifestBody: MUXED,
      manifestUrl: "https://cdn.example.com/hls/master.m3u8",
      videos: [{ src: "https://cdn.example.com/v/clip.mp4", blob: false, height: 1080 }],
      title: "Example Video Title",
    });
    const rows = rowsOf(items);
    click(chrome, rows[0].id);
    click(chrome, rows[2].id);
    assert.deepEqual(sent(chrome), [
      "grab://https/cdn.example.com/v/clip.mp4",
      "grab://https/cdn.example.com/hls/v720.m3u8",
    ]);
  });

  test("a plain mp4 with no page title still shows x.mp4", async () => {
    const { items, chrome } = await build({
      manifestBody: "",
      manifestUrl: null,
      videos: [{ src: "https://cdn.example.com/v/x.mp4", blob: false }],
      title: "",
    });
    const rows = rowsOf(items);
    assert.deepEqual(rows.map((i) => i.title), ["x.mp4"]);
    click(chrome, rows[0].id);
    assert.deepEqual(sent(chrome), ["grab://https/cdn.example.com/v/x.mp4"]);
  });

  test("a page title never renames a direct file", async () => {
    const { items } = await build({
      manifestBody: "",
      manifestUrl: null,
      videos: [{ src: "https://cdn.example.com/v/x.mp4", blob: false }],
      title: "Watch Now Free HD",
    });
    assert.deepEqual(rowsOf(items).map((i) => i.title), ["x.mp4"]);
  });

  test("separate-audio streams are one row that hands over the master", async () => {
    const { chrome, items } = await build({
      manifestBody: SPLIT,
      manifestUrl: "https://cdn.example.com/hls/master.m3u8",
      videos: [{ src: null, blob: true }],
      title: "My Show",
    });
    const rows = rowsOf(items);
    assert.deepEqual(rows.map((i) => i.title), ["My Show • 1080p / 720p • pick in Grab"]);
    click(chrome, rows[0].id);
    assert.deepEqual(sent(chrome), ["grab://https/cdn.example.com/hls/master.m3u8"]);
  });

  test("the main Download with Grab item still works with videos detected", async () => {
    const { chrome } = await build({
      manifestBody: "",
      manifestUrl: null,
      videos: [{ src: "https://cdn.example.com/v/x.mp4", blob: false }],
      title: "",
    });
    chrome._listeners["menus.onClicked"](
      { menuItemId: "sendToGrab", linkUrl: "https://example.com/file.zip" },
      { id: 3 }
    );
    assert.deepEqual(sent(chrome), ["grab://https/example.com/file.zip"]);
  });

  test("videos are separated, repeats are numbered", async () => {
    const { items } = await build({
      manifestBody: "",
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
});
