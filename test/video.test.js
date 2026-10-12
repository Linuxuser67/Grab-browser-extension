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
      remove: async (id) => calls.push(["menus.remove", id]),
      removeAll: async () => calls.push(["menus.removeAll"]),
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

function loadBackground(chrome) {
  delete require.cache[require.resolve(BG_PATH)];
  globalThis.chrome = chrome;
  return require(BG_PATH);
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
    const L = chrome._listeners;
    await L["tabs.onActivated"]({ tabId: 5 });
    L["webRequest.onResponseStarted"]({ tabId: 5, url: "https://a.example.com/a.mp4", responseHeaders: [] });
    await new Promise((r) => setTimeout(r, 30));
    L["menus.onClicked"]({ menuItemId: "grabVideo:0" }, { id: -1 });
    const call = chrome._calls.find(([n]) => n === "tabs.update");
    assert.ok(call, "navigated");
    assert.equal(call[2], undefined, "no tab id passed for TAB_ID_NONE");
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
    assert.equal(
      bg.classifyStream("https://cdn.example.com/s/playlist", "application/vnd.apple.mpegurl"),
      "manifest"
    );
    assert.equal(
      bg.classifyStream("https://cdn.example.com/s/playlist", "application/dash+xml"),
      "manifest"
    );
  });

  test("direct video extensions classify as media", () => {
    for (const ext of ["mp4", "m4v", "webm", "ogv", "mov", "mkv"]) {
      assert.equal(bg.classifyStream(`https://cdn.example.com/v/clip.${ext}`, ""), "media", ext);
    }
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

  test("extensionless video content types are not guessed (DASH segments look like this)", () => {
    assert.equal(bg.classifyStream("https://cdn.example.com/s/seg", "video/mp4"), null);
  });

  test("garbage URLs classify as null", () => {
    assert.equal(bg.classifyStream("not a url", ""), null);
    assert.equal(bg.classifyStream("", ""), null);
  });
});

describe("videoMenuTitle", () => {
  let bg;
  beforeEach(() => {
    bg = loadBackground(makeChrome());
  });

  test("uses the file name from the path", () => {
    assert.equal(bg.videoMenuTitle("https://cdn.example.com/v/clip.mp4", 0), "clip.mp4");
  });

  test("drops query strings and decodes escapes", () => {
    assert.equal(
      bg.videoMenuTitle("https://cdn.example.com/v/my%20clip.mp4?token=abc", 0),
      "my clip.mp4"
    );
  });

  test("truncates long names with an ellipsis", () => {
    const long = "a".repeat(60) + ".mp4";
    const title = bg.videoMenuTitle(`https://cdn.example.com/v/${long}`, 0);
    assert.ok(title.length <= 41);
    assert.ok(title.endsWith("…"));
  });

  test("falls back to Video N when there is no file name", () => {
    assert.equal(bg.videoMenuTitle("https://cdn.example.com/", 2), "Video 3");
    assert.equal(bg.videoMenuTitle("not a url", 0), "Video 1");
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

  test("empty finds merge to empty", () => {
    assert.deepEqual(bg.mergeVideoFinds([], []), []);
    assert.deepEqual(bg.mergeVideoFinds(null, null), []);
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
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ width: opts.w || 0, height: opts.h || 0 }),
  });
  const fakeDoc = (videos) => ({
    querySelectorAll: (sel) => (sel === "video" ? videos : []),
  });

  test("collects direct http(s) sources", () => {
    const videos = content.collectVideos(
      fakeDoc([fakeVideo({ src: "https://cdn.example.com/v.mp4", w: 640, h: 360 })])
    );
    assert.deepEqual(videos, [{ src: "https://cdn.example.com/v.mp4", blob: false }]);
  });

  test("prefers currentSrc and scans <source> children", () => {
    const withSource = {
      ...fakeVideo({ w: 640, h: 360 }),
      currentSrc: "",
      src: "",
      querySelectorAll: (sel) =>
        sel === "source" ? [{ src: "https://cdn.example.com/s.webm" }] : [],
    };
    const videos = content.collectVideos(fakeDoc([withSource]));
    assert.deepEqual(videos, [{ src: "https://cdn.example.com/s.webm", blob: false }]);
  });

  test("blob: sources are flagged, not collected", () => {
    const videos = content.collectVideos(
      fakeDoc([fakeVideo({ src: "blob:https://example.com/uuid", w: 640, h: 360 })])
    );
    assert.deepEqual(videos, [{ src: null, blob: true }]);
  });

  test("tiny players are ignored (ads, trackers)", () => {
    const videos = content.collectVideos(
      fakeDoc([fakeVideo({ src: "https://cdn.example.com/ad.mp4", w: 60, h: 40 })])
    );
    assert.deepEqual(videos, []);
  });

  test("no videos gives an empty list", () => {
    assert.deepEqual(content.collectVideos(fakeDoc([])), []);
    assert.deepEqual(content.collectVideos(null), []);
  });
});

describe("detection wiring", () => {
  const tick = () => new Promise((r) => setTimeout(r, 30));

  test("a sniffed manifest appears in the menu and badge, and clicks hand off", async () => {
    const chrome = makeChrome();
    loadBackground(chrome);
    const L = chrome._listeners;

    await L["tabs.onActivated"]({ tabId: 5 });
    L["webRequest.onResponseStarted"]({
      tabId: 5,
      url: "https://cdn.example.com/s/stream.m3u8",
      responseHeaders: [],
    });
    await tick();

    const created = chrome._calls.filter(([n]) => n === "menus.create").map(([, id]) => id);
    assert.ok(created.includes("grabVideos"), "parent menu created");
    assert.ok(created.includes("grabVideo:0"), "child menu created");

    const badge = chrome._calls.find(([n]) => n === "action.setBadgeText");
    assert.deepEqual(badge[1], { tabId: 5, text: "1" });

    L["menus.onClicked"]({ menuItemId: "grabVideo:0" }, null);
    assert.ok(
      chrome._calls.some(
        ([n, arg]) => n === "tabs.update" && arg.url === "grab://https/cdn.example.com/s/stream.m3u8"
      ),
      "click navigates the active tab to the grab: URL"
    );
  });

  test("a click resolves against the list the menu was built from (other window focused)", async () => {
    const chrome = makeChrome();
    loadBackground(chrome);
    const L = chrome._listeners;
    await L["tabs.onActivated"]({ tabId: 5 });
    L["webRequest.onResponseStarted"]({ tabId: 5, url: "https://a.example.com/a.mp4", responseHeaders: [] });
    await tick();
    // Second window: its active tab becomes the menu's tab.
    await L["tabs.onActivated"]({ tabId: 6 });
    L["webRequest.onResponseStarted"]({ tabId: 6, url: "https://b.example.com/b.mp4", responseHeaders: [] });
    L["webRequest.onResponseStarted"]({ tabId: 6, url: "https://b.example.com/c.mp4", responseHeaders: [] });
    await tick();
    // Right-click lands in tab 5 (window 1 focused again, no onActivated fired).
    L["menus.onClicked"]({ menuItemId: "grabVideo:1" }, { id: 5 });
    assert.ok(
      chrome._calls.some(([n, arg]) => n === "tabs.update" && arg.url === "grab://https/b.example.com/c.mp4"),
      "the labelled item (second entry of the menu) is what gets sent"
    );
  });

  test("a click after master-playlist filtering sends the master, not the hidden child", async () => {
    const chrome = makeChrome();
    loadBackground(chrome);
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
    await tick();
    await tick();
    L["menus.onClicked"]({ menuItemId: "grabVideo:0" }, { id: 5 });
    assert.ok(
      chrome._calls.some(([n, arg]) => n === "tabs.update" && arg.url === "grab://https/cdn.example.com/v/master.m3u8"),
      "master playlist is sent"
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
    L["menus.onClicked"]({ menuItemId: "grabVideo:0" }, null);
    assert.ok(
      chrome._calls.some(
        ([n, arg]) => n === "tabs.update" && arg.url === "grab://https/cdn.example.com/v/clip.mp4"
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

    L["menus.onClicked"]({ menuItemId: "grabVideo:1" }, null);
    assert.ok(
      chrome._calls.some(
        ([n, arg]) => n === "tabs.update" && arg.url === "grab://https/cdn.example.com/v/b.mp4"
      )
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
      chrome._calls.some(([n]) => n === "action.setBadgeText"),
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
  test("worker starts using only permitted chrome namespaces", () => {
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
    assert.doesNotThrow(() => loadBackground(guarded));
  });
});

describe("excluded hosts", () => {
  const tick = () => new Promise((r) => setTimeout(r, 30));

  test("hostExcluded matches hosts and subdomains only", () => {
    const bg = loadBackground(makeChrome());
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

  test("content script hostExcluded agrees with the worker's", () => {
    const bg = loadBackground(makeChrome());
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
    loadBackground(chrome);
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
      chrome._calls.some(([n]) => n === "action.setBadgeText"),
      false,
      "no badge on excluded host"
    );
  });

  test("non-excluded hosts still get the menu", async () => {
    const chrome = makeChrome();
    loadBackground(chrome);
    const L = chrome._listeners;

    await L["tabs.onActivated"]({ tabId: 9 });
    L["webRequest.onResponseStarted"]({
      tabId: 9,
      url: "https://cdn.example.com/s/stream.m3u8",
      responseHeaders: [],
    });
    await tick();
    await tick();
    assert.ok(
      chrome._calls.some(([n, id]) => n === "menus.create" && id === "grabVideo:0"),
      "menu shown on ordinary hosts"
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

  beforeEach(() => {
    bg = loadBackground(makeChrome());
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
    bg = loadBackground(makeChrome());
    const out = await bg.preferMasterPlaylists([VIDEO_PL, AUDIO_PL]);
    assert.deepEqual(out, [VIDEO_PL, AUDIO_PL]);
  });

  test("returns everything when the fetch fails", async () => {
    globalThis.fetch = async () => { throw new Error("denied"); };
    bg = loadBackground(makeChrome());
    const out = await bg.preferMasterPlaylists([MASTER, VIDEO_PL]);
    assert.deepEqual(out, [MASTER, VIDEO_PL]);
  });

  test("isMasterPlaylist caches its result", async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return { ok: true, text: async () => MASTER_BODY };
    };
    bg = loadBackground(makeChrome());
    assert.equal(await bg.isMasterPlaylist(MASTER), true);
    assert.equal(await bg.isMasterPlaylist(MASTER), true);
    assert.equal(calls, 1, "second call served from cache");
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

  test("empty when no og:title", () => {
    const doc = { querySelector: () => null };
    assert.equal(content.pageVideoTitle(doc), "");
  });

  test("empty on missing document", () => {
    assert.equal(content.pageVideoTitle(null), "");
  });
});

describe("videoMenuTitle with video title", () => {
  let bg;
  beforeEach(() => {
    bg = loadBackground(makeChrome());
  });

  test("uses the video title when present", () => {
    assert.equal(
      bg.videoMenuTitle("https://cdn.example.com/hls/master.m3u8", 0, "My Video", 1),
      "My Video"
    );
  });

  test("truncates long titles", () => {
    const long = "A".repeat(50);
    assert.equal(bg.videoMenuTitle("https://x/y.m3u8", 0, long, 1), "A".repeat(40) + "…");
  });

  test("numbers duplicates", () => {
    assert.equal(
      bg.videoMenuTitle("https://cdn.example.com/a.m3u8", 1, "My Video", 2),
      "My Video (2)"
    );
  });

  test("falls back to filename without a title", () => {
    assert.equal(
      bg.videoMenuTitle("https://cdn.example.com/hls/master.m3u8", 0, "", 1),
      "master.m3u8"
    );
  });
});

describe("parseHlsVariants", () => {
  let bg;
  const BASE = "https://cdn.example.com/hls/master.m3u8";

  beforeEach(() => {
    bg = loadBackground(makeChrome());
  });

  test("extracts resolution and bandwidth per variant", () => {
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

  test("handles missing resolution gracefully", () => {
    const body = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nindex-v1.m3u8\n";
    const out = bg.parseHlsVariants(body, BASE);
    assert.equal(out.length, 1);
    assert.equal(out[0].height, null);
    assert.equal(out[0].bandwidth, 800000);
  });

  test("returns empty for media playlists", () => {
    const body = "#EXTM3U\n#EXT-X-TARGETDURATION=6\n#EXTINF:6.0,\nseg1.ts\n";
    assert.deepEqual(bg.parseHlsVariants(body, BASE), []);
  });

  test("resolves relative URIs against the master", () => {
    const body = "#EXTM3U\n#EXT-X-STREAM-INF:RESOLUTION=1280x720\n../other/v.m3u8\n";
    const out = bg.parseHlsVariants(body, BASE);
    assert.equal(out[0].url, "https://cdn.example.com/other/v.m3u8");
  });
});

describe("variantMenuTitle", () => {
  let bg;

  beforeEach(() => {
    bg = loadBackground(makeChrome());
  });

  test("shows height as 720p-style label", () => {
    assert.equal(bg.variantMenuTitle({ url: "https://x/y.m3u8", height: 720 }, 0), "720p");
    assert.equal(bg.variantMenuTitle({ url: "https://x/y.m3u8", height: 1080 }, 0), "1080p");
  });

  test("falls back to bandwidth when height is absent", () => {
    assert.equal(
      bg.variantMenuTitle({ url: "https://x/y.m3u8", height: null, bandwidth: 2500000 }, 0),
      "2.5 Mbps"
    );
  });
});

describe("getHlsVariants muxed-audio filter", () => {
  let bg;
  const MASTER = "https://cdn.example.com/hls/master.m3u8";

  beforeEach(() => {
    bg = loadBackground(makeChrome());
  });

  test("keeps only variants without an AUDIO group", async () => {
    const body = [
      "#EXTM3U",
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a1",NAME="English",DEFAULT=YES,URI="audio.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,AUDIO="a1"',
      "index-v1.m3u8",
      '#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720',
      "index-v2.m3u8",
    ].join("\n");
    globalThis.fetch = async () => ({ ok: true, text: async () => body });
    const out = await bg.getHlsVariants(MASTER);
    assert.equal(out.length, 1);
    assert.equal(out[0].height, 720);
    assert.equal(out[0].url, "https://cdn.example.com/hls/index-v2.m3u8");
  });

  test("returns null when all variants use separate audio", async () => {
    const body = [
      "#EXTM3U",
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a1",NAME="English",URI="audio.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,AUDIO="a1"',
      "index-v1.m3u8",
    ].join("\n");
    globalThis.fetch = async () => ({ ok: true, text: async () => body });
    assert.equal(await bg.getHlsVariants(MASTER), null);
  });

  test("parseHlsVariants captures the audio group", () => {
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
    const bg = loadBackground(chrome);
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
    const bg = loadBackground(chrome);
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
