// Tests for the Grab browser extension's background service worker.
// Run with: node --test test/   (Node's built-in runner, no dependencies)
const { test, describe, beforeEach } = require("node:test");
const nodeCrypto = require("node:crypto");
const assert = require("node:assert/strict");
const path = require("node:path");

const BG_PATH = path.join(__dirname, "..", "background.js");
const SHARED_PATH = path.join(__dirname, "..", "shared.js");

/// Minimal chrome mock: captures listeners, records calls, backs
/// chrome.storage.session with a Map. Pass a shared `shared` object to
/// simulate a worker restart (new worker, same session storage).
function makeChrome(shared) {
  shared = shared || {};
  const listeners = {};
  const session = shared.session || (shared.session = new Map());
  const downloads = shared.downloads || (shared.downloads = new Map());
  const syncSettings = shared.syncSettings || (shared.syncSettings = {});
  const localSettings = shared.localSettings || (shared.localSettings = {});
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
    cookies: {
      getAll: async () => [],
    },
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
      query: (q, cb) => {
        const result = [];
        if (cb) cb(result);
        return Promise.resolve(result);
      },
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
      local: {
        get: async (defaults) => ({ ...defaults, ...localSettings }),
        set: async (obj) => Object.assign(localSettings, obj),
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

/// Load a fresh copy of background.js against the given chrome mock.
function loadBackground(chrome) {
  delete require.cache[require.resolve(BG_PATH)];
  delete require.cache[require.resolve(SHARED_PATH)];
  globalThis.chrome = chrome;
  // background.js calls importScripts("shared.js") (worker); in Node we
  // load it via require instead.
  globalThis.importScripts = () => {
    const shared = require(SHARED_PATH);
    globalThis.SHARED_DEFAULTS = shared.SHARED_DEFAULTS;
    globalThis.SHARED_PAIRING_CODE_RE = shared.SHARED_PAIRING_CODE_RE;
    globalThis.SHARED_EXCLUDED_HOSTS = shared.SHARED_EXCLUDED_HOSTS;
    globalThis.sharedHostExcluded = shared.sharedHostExcluded;
    globalThis.normalizePairingCode = shared.normalizePairingCode;
  };
  // Default: a Grab that accepts every handoff and records the URL it got.
  // Tests must not depend on a real Grab listening on 127.0.0.1:9412; the HTTP
  // handoff suite installs its own fetch for failure cases.
  globalThis.fetch = async (url, opts) => {
    chrome._calls.push(["handoff", JSON.parse(opts.body).url]);
    return { status: 200, ok: true };
  };
  return require(BG_PATH);
}

const MiB = 1024 * 1024;

describe("toGrabUrl", () => {
  let bg;
  beforeEach(() => {
    bg = loadBackground(makeChrome());
  });

  test("preserves the https scheme", () => {
    assert.equal(
      bg.toGrabUrl("https://example.com/file.zip"),
      "grab://https/example.com/file.zip"
    );
  });

  test("preserves the http scheme instead of upgrading it", () => {
    assert.equal(
      bg.toGrabUrl("http://example.com/file.zip"),
      "grab://http/example.com/file.zip"
    );
  });

  test("lowercases an uppercase scheme marker", () => {
    assert.equal(
      bg.toGrabUrl("HTTPS://example.com/A.zip"),
      "grab://https/example.com/A.zip"
    );
  });

  test("keeps query and fragment", () => {
    assert.equal(
      bg.toGrabUrl("https://example.com/f.zip?x=1#frag"),
      "grab://https/example.com/f.zip?x=1#frag"
    );
  });

  test("rejects non-http(s) URLs", () => {
    for (const url of [
      "blob:https://example.com/uuid",
      "data:text/plain,hi",
      "ftp://example.com/f.zip",
      "magnet:?xt=urn:btih:abc",
    ]) {
      assert.equal(bg.toGrabUrl(url), null, url);
    }
  });

  test("rejects non-strings and bare schemes", () => {
    assert.equal(bg.toGrabUrl(null), null);
    assert.equal(bg.toGrabUrl(undefined), null);
    assert.equal(bg.toGrabUrl("https://"), null);
  });
});

describe("isSkipped", () => {
  let bg;
  beforeEach(() => {
    bg = loadBackground(makeChrome());
  });

  test("matches extensions case-insensitively", () => {
    assert.equal(bg.isSkipped("https://example.com/a.ZIP", "zip"), true);
    assert.equal(bg.isSkipped("https://example.com/a.zip", "ZIP"), true);
  });

  test("tolerates dots and whitespace in the list", () => {
    assert.equal(bg.isSkipped("https://example.com/a.rar", " .zip, rar "), true);
  });

  test("does not match other extensions", () => {
    assert.equal(bg.isSkipped("https://example.com/a.iso", "zip, rar"), false);
  });

  test("empty list skips nothing; bad URLs are not skipped", () => {
    assert.equal(bg.isSkipped("https://example.com/a.zip", ""), false);
    assert.equal(bg.isSkipped("not a url", "zip"), false);
  });
});

describe("minSizeBytes", () => {
  let bg;
  beforeEach(() => {
    bg = loadBackground(makeChrome());
  });

  test("converts MiB to bytes, floors negatives and missing values at 0", () => {
    assert.equal(bg.minSizeBytes({ minSizeMB: 0 }), 0);
    assert.equal(bg.minSizeBytes({ minSizeMB: 5 }), 5 * MiB);
    assert.equal(bg.minSizeBytes({ minSizeMB: -3 }), 0);
    assert.equal(bg.minSizeBytes({}), 0);
  });
});

describe("size-wait interception", () => {
  let chrome;
  let bg;
  let listeners;

  const bigItem = (id) => ({
    id,
    url: "https://example.com/big.iso",
    fileSize: -1,
  });

  beforeEach(() => {
    const shared = {
      syncSettings: { interceptDownloads: true, minSizeMB: 100, skipTypes: "" },
    };
    chrome = makeChrome(shared);
    bg = loadBackground(chrome);
    listeners = chrome._listeners;
  });

  const intercepted = () =>
    chrome._calls.some(
      ([name, url]) =>
        name === "handoff" && url === "https://example.com/big.iso"
    );
  const cancelled = (id) =>
    chrome._calls.some(([name, arg]) => name === "cancel" && arg === id);

  test("parks an unknown-size download in session storage with an alarm", async () => {
    chrome._downloads.set(7, { ...bigItem(7), state: "in_progress" });
    await listeners["downloads.onCreated"](bigItem(7));
    assert.equal(chrome._session.get("pendingSize:7") !== undefined, true);
    assert.equal(chrome._alarms.has("size-wait:7"), true);
    assert.equal(intercepted(), false);
  });

  test("intercepts when the size arrives above the cap", async () => {
    chrome._downloads.set(7, { ...bigItem(7), fileSize: 200 * MiB });
    await listeners["downloads.onCreated"](bigItem(7));
    await listeners["downloads.onChanged"]({
      id: 7,
      fileSize: { current: 200 * MiB },
    });
    assert.equal(cancelled(7), true);
    assert.equal(intercepted(), true);
    // Decided downloads leave no pending state behind.
    assert.equal(chrome._session.has("pendingSize:7"), false);
    assert.equal(chrome._alarms.has("size-wait:7"), false);
  });

  test("leaves a small download in the browser", async () => {
    chrome._downloads.set(7, { ...bigItem(7), fileSize: 1 * MiB });
    await listeners["downloads.onCreated"](bigItem(7));
    await listeners["downloads.onChanged"]({
      id: 7,
      fileSize: { current: 1 * MiB },
    });
    assert.equal(cancelled(7), false);
    assert.equal(intercepted(), false);
  });

  test("drops the wait when the download finishes first", async () => {
    chrome._downloads.set(7, { ...bigItem(7), state: "in_progress" });
    await listeners["downloads.onCreated"](bigItem(7));
    await listeners["downloads.onChanged"]({
      id: 7,
      state: { current: "complete" },
    });
    assert.equal(cancelled(7), false);
    assert.equal(intercepted(), false);
    assert.equal(chrome._session.has("pendingSize:7"), false);
  });

  test("the alarm intercepts after the timeout with no size", async () => {
    chrome._downloads.set(7, bigItem(7));
    await listeners["downloads.onCreated"](bigItem(7));
    // Simulate the alarm firing after the deadline (packaged Chrome fires
    // no earlier than ~30s out; the stored deadline is the real timer).
    chrome._session.set("pendingSize:7", Date.now() - 1000);
    listeners["alarms.onAlarm"]({ name: "size-wait:7" });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(cancelled(7), true);
    assert.equal(intercepted(), true);
  });

  test("a restarted worker reconstructs the wait from session storage", async () => {
    // Worker A parks the download, then "dies".
    chrome._downloads.set(7, { ...bigItem(7), state: "in_progress" });
    await listeners["downloads.onCreated"](bigItem(7));
    assert.equal(chrome._session.has("pendingSize:7"), true);

    // Worker B starts with the same session storage but fresh memory.
    const shared = {
      session: chrome._session,
      downloads: chrome._downloads,
      syncSettings: { interceptDownloads: true, minSizeMB: 100, skipTypes: "" },
    };
    shared.downloads.set(7, { ...bigItem(7), fileSize: 200 * MiB });
    const chromeB = makeChrome(shared);
    loadBackground(chromeB);

    await chromeB._listeners["downloads.onChanged"]({
      id: 7,
      fileSize: { current: 200 * MiB },
    });
    const interceptedB = chromeB._calls.some(
      ([name, url]) =>
        name === "handoff" && url === "https://example.com/big.iso"
    );
    assert.equal(interceptedB, true);
  });
});

describe("master interception toggle", () => {
  const item = (id) => ({
    id,
    url: "https://example.com/file.zip",
    fileSize: 200 * MiB,
  });

  const intercepted = (chrome, id) =>
    chrome._calls.some(
      ([name, arg]) =>
        (name === "cancel" && arg === id) ||
        (name === "handoff" && arg === "https://example.com/file.zip")
    );

  test("onCreated leaves the download in the browser when off", async () => {
    const chrome = makeChrome({
      syncSettings: { interceptDownloads: false },
    });
    const bg = loadBackground(chrome);
    void bg;
    await chrome._listeners["downloads.onCreated"](item(9));
    assert.equal(intercepted(chrome, 9), false);
    assert.equal(chrome._session.has("pendingSize:9"), false);
  });

  test("onCreated ignores downloads from before browser startup", async () => {
    const chrome = makeChrome({
      syncSettings: { interceptDownloads: true, minSizeMB: 0, skipTypes: "" },
    });
    const bg = loadBackground(chrome);
    void bg;
    // Simulate a browser restart: startup time moves to now.
    chrome._listeners["runtime.onStartup"]();
    const oldItem = {
      ...item(9),
      url: "https://example.com/old.iso",
      startTime: new Date(Date.now() - 3600000).toISOString(),
    };
    await chrome._listeners["downloads.onCreated"](oldItem);
    assert.equal(intercepted(chrome, 9), false);
  });

  test("onCreated intercepts downloads from after browser startup", async () => {
    const chrome = makeChrome({
      syncSettings: { interceptDownloads: true, minSizeMB: 0, skipTypes: "" },
    });
    const bg = loadBackground(chrome);
    void bg;
    const newItem = {
      ...item(9),
      url: "https://example.com/new.iso",
      fileSize: 100,
      startTime: new Date().toISOString(),
    };
    await chrome._listeners["downloads.onCreated"](newItem);
    assert.equal(intercepted(chrome, 9), true);
  });

  test("the size-wait decision respects a toggle flipped off mid-wait", async () => {
    const shared = {
      syncSettings: { interceptDownloads: true, minSizeMB: 100, skipTypes: "" },
    };
    const chrome = makeChrome(shared);
    const bg = loadBackground(chrome);

    chrome._downloads.set(9, { ...item(9), fileSize: -1, state: "in_progress" });
    await chrome._listeners["downloads.onCreated"]({ ...item(9), fileSize: -1 });
    assert.equal(chrome._session.has("pendingSize:9"), true);

    // The user turns interception off while the size wait is pending.
    shared.syncSettings.interceptDownloads = false;
    shared.downloads = chrome._downloads;
    shared.downloads.set(9, item(9));
    await bg.decidePending(9);

    assert.equal(intercepted(chrome, 9), false);
    // Decided downloads leave no pending state behind.
    assert.equal(chrome._session.has("pendingSize:9"), false);
  });
});

describe("context menu toggle", () => {
  test("rapid toggles stay idempotent (removeAll before create)", async () => {
    const chrome = makeChrome();
    loadBackground(chrome);
    const onChanged = chrome._listeners["storage.onChanged"];
    await onChanged({ showContextMenu: { newValue: false } }, "sync");
    await onChanged({ showContextMenu: { newValue: true } }, "sync");
    await onChanged({ showContextMenu: { newValue: true } }, "sync");
    const creates = chrome._calls.filter(([n]) => n === "menus.create");
    const removeAlls = chrome._calls.filter(([n]) => n === "menus.removeAll");
    assert.equal(creates.length, 2);
    assert.equal(removeAlls.length, 3);
    // Every create is preceded by a removeAll.
    let ri = 0;
    for (const [i, [name]] of chrome._calls.entries()) {
      if (name === "menus.removeAll") ri = i;
      if (name === "menus.create") assert.ok(ri < i);
    }
  });
});

describe("handoff tab separation (review fix 1)", () => {
  test("automatic interception hands off over HTTP, never navigating any tab", async () => {
    const chrome = makeChrome({
      syncSettings: { interceptDownloads: true, minSizeMB: 0, skipTypes: "" },
    });
    loadBackground(chrome);
    await chrome._listeners["downloads.onCreated"]({
      id: 31,
      url: "https://example.com/big.iso",
      fileSize: -1,
    });
    const viaHttp = chrome._calls.some(
      ([name, url]) => name === "handoff" && url === "https://example.com/big.iso"
    );
    const anyTab = chrome._calls.some(
      ([name]) => name === "tabs.update" || name === "tabs.create"
    );
    assert.equal(viaHttp, true);
    assert.equal(anyTab, false);
  });

  test("explicit context-menu send uses HTTP handoff when Grab is up", async () => {
    const chrome = makeChrome();
    loadBackground(chrome);
    await chrome._listeners["menus.onClicked"](
      { menuItemId: "sendToGrab", linkUrl: "https://example.com/f.zip" },
      null
    );
    const handoffUsed = chrome._calls.some(
      ([name, url]) => name === "handoff" && url === "https://example.com/f.zip"
    );
    const navigated = chrome._calls.some(([name]) => name === "tabs.update");
    assert.equal(handoffUsed, true);
    assert.equal(navigated, false);
  });

  test("explicit context-menu send falls back to tab navigation when Grab is down", async () => {
    const chrome = makeChrome();
    loadBackground(chrome);
    globalThis.fetch = async () => {
      throw new Error("connection refused");
    };
    await chrome._listeners["menus.onClicked"](
      { menuItemId: "sendToGrab", linkUrl: "https://example.com/f.zip" },
      null
    );
    const viaSelectedTab = chrome._calls.some(
      ([name, arg]) =>
        name === "tabs.update" && arg.url === "grab://https/example.com/f.zip"
    );
    const viaBackgroundTab = chrome._calls.some(
      ([name]) => name === "tabs.create"
    );
    assert.equal(viaSelectedTab, true);
    assert.equal(viaBackgroundTab, false);
  });

  test("explicit send shows a toolbar hint after exhausted 429 retries", async () => {
    const chrome = makeChrome();
    const bg = loadBackground(chrome);
    bg._setSleep(async () => {});
    globalThis.fetch = async () => ({ status: 429, ok: false });
    await chrome._listeners["menus.onClicked"](
      { menuItemId: "sendToGrab", linkUrl: "https://example.com/f.zip" },
      { id: 5 }
    );
    assert.ok(
      chrome._calls.some(([name, args]) => name === "action.setBadgeText" && args.tabId === 5 && args.text === "!"),
      "failed explicit send should show a toolbar badge"
    );
    assert.ok(
      chrome._calls.some(([name, args]) => name === "action.setTitle" && args.tabId === 5 && /queue is full/.test(args.title)),
      "badge title should explain exhausted queue-full retries"
    );
  });

  test("explicit send does not fall back to grab:// when Grab answers 409", async () => {
    const chrome = makeChrome();
    loadBackground(chrome);
    // Grab opened the card (or the user declined): it handled the URL.
    // Falling back to grab:// would duplicate the handoff.
    globalThis.fetch = async () => ({ status: 409, ok: false });
    await chrome._listeners["menus.onClicked"](
      { menuItemId: "sendToGrab", linkUrl: "https://example.com/f.zip" },
      null
    );
    const navigated = chrome._calls.some(([name]) => name === "tabs.update");
    assert.equal(navigated, false);
  });

  test("main menu on video element uses detected video URL, not page URL", async () => {
    const chrome = makeChrome();
    loadBackground(chrome);
    // Simulate video detection for tab 1.
    const sender = { tab: { id: 1, url: "https://example.com/" }, frameId: 0 };
    await chrome._listeners["runtime.onMessage"](
      {
        type: "grab-videos-detected",
        videos: [{ src: "https://example.com/streamer/", title: "Stream" }],
      },
      sender,
      () => {}
    );
    // Right-click on the video element (blob: srcUrl), main menu item.
    let postedUrl = null;
    globalThis.fetch = async (url, opts) => {
      postedUrl = JSON.parse(opts.body).url;
      return { status: 200, ok: true };
    };
    await chrome._listeners["menus.onClicked"](
      {
        menuItemId: "sendToGrab",
        mediaType: "video",
        srcUrl: "blob:https://example.com/abc",
        pageUrl: "https://example.com/",
      },
      { id: 1 }
    );
    assert.equal(postedUrl, "https://example.com/streamer/");
  });

  test("right-click matches video by srcUrl among multiple detected", async () => {
    const chrome = makeChrome();
    loadBackground(chrome);
    const sender = { tab: { id: 2, url: "https://example.com/feed" }, frameId: 0 };
    await chrome._listeners["runtime.onMessage"](
      {
        type: "grab-videos-detected",
        videos: [
          { src: "blob:https://example.com/v1", blob: true, title: "First" },
          { src: "https://cdn.example.com/v2.mp4", title: "Second" },
        ],
      },
      sender,
      () => {}
    );
    // Right-click the second video (direct URL src).
    let postedUrl = null;
    globalThis.fetch = async (url, opts) => {
      postedUrl = JSON.parse(opts.body).url;
      return { status: 200, ok: true };
    };
    await chrome._listeners["menus.onClicked"](
      {
        menuItemId: "sendToGrab",
        mediaType: "video",
        srcUrl: "https://cdn.example.com/v2.mp4",
        pageUrl: "https://example.com/feed",
      },
      { id: 2 }
    );
    assert.equal(postedUrl, "https://cdn.example.com/v2.mp4");
  });

  test("empty re-report keeps known videos (live element swap)", async () => {
    const chrome = makeChrome();
    loadBackground(chrome);
    await chrome._listeners["tabs.onActivated"]({ tabId: 7 });
    const sender = { tab: { id: 7, url: "https://example.com/" }, frameId: 0 };
    // Initial report with a played video.
    await chrome._listeners["runtime.onMessage"](
      {
        type: "grab-videos-detected",
        videos: [{ src: "https://cdn.example.com/v/clip.mp4" }],
      },
      sender,
      () => {}
    );
    await new Promise((r) => setTimeout(r, 50));
    // Live site swaps the <video> element; the new one hasn't played yet.
    await chrome._listeners["runtime.onMessage"](
      { type: "grab-videos-detected", videos: [] },
      sender,
      () => {}
    );
    await new Promise((r) => setTimeout(r, 50));
    // The main menu fallback should still find the preserved video.
    let postedUrl = null;
    globalThis.fetch = async (url, opts) => {
      postedUrl = JSON.parse(opts.body).url;
      return { status: 200, ok: true };
    };
    await chrome._listeners["menus.onClicked"](
      {
        menuItemId: "sendToGrab",
        mediaType: "video",
        srcUrl: "blob:https://example.com/abc",
        pageUrl: "https://example.com/",
      },
      { id: 7 }
    );
    assert.equal(postedUrl, "https://cdn.example.com/v/clip.mp4");
  });

  test("authoritative empty report removes a stopped video from the context menu", async () => {
    const chrome = makeChrome();
    loadBackground(chrome);
    await chrome._listeners["tabs.onActivated"]({ tabId: 8 });
    const sender = { tab: { id: 8, url: "https://example.com/" }, frameId: 0 };
    await chrome._listeners["runtime.onMessage"](
      {
        type: "grab-videos-detected",
        videos: [{ src: "https://cdn.example.com/v/playing.mp4" }],
      },
      sender,
      () => {}
    );
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(
      chrome._calls.some(([name, id]) => name === "menus.create" && id === "grabVideos"),
      true,
      "playing video should create the detected-video menu"
    );

    const callsBeforeStop = chrome._calls.length;
    await chrome._listeners["runtime.onMessage"](
      { type: "grab-videos-detected", videos: [], replaceFrame: true },
      sender,
      () => {}
    );
    await new Promise((r) => setTimeout(r, 50));

    assert.deepEqual(chrome._calls.slice(callsBeforeStop).filter(([name]) => name === "menus.create").map(([, id]) => id).filter((id) => String(id).startsWith("grabVideo:")), []);
    assert.ok(
      chrome._calls.slice(callsBeforeStop).some(([name, id]) => name === "menus.remove" && id === "grabVideos"),
      "detected-video menu should be removed after playback stops"
    );
    assert.ok(
      chrome._calls.slice(callsBeforeStop).some(([name, args]) => name === "action.setBadgeText" && args.tabId === 8 && args.text === ""),
      "video badge should clear after playback stops"
    );
  });

  test("a blob: media URL falls back to the page URL for extraction", async () => {
    const chrome = makeChrome();
    loadBackground(chrome);
    await chrome._listeners["menus.onClicked"](
      {
        menuItemId: "sendToGrab",
        srcUrl: "blob:https://example.com/uuid",
        pageUrl: "https://example.com/room/user",
      },
      null
    );
    const sent = chrome._calls.some(
      ([name, url]) =>
        name === "handoff" && url === "https://example.com/room/user"
    );
    assert.equal(sent, true);
  });

  test("a usable media URL is still preferred over the page URL", async () => {
    const chrome = makeChrome();
    loadBackground(chrome);
    await chrome._listeners["menus.onClicked"](
      {
        menuItemId: "sendToGrab",
        srcUrl: "https://cdn.example.com/v.mp4",
        pageUrl: "https://example.com/watch/1",
      },
      null
    );
    const sent = chrome._calls.some(
      ([name, url]) => name === "handoff" && url === "https://cdn.example.com/v.mp4"
    );
    assert.equal(sent, true);
  });

  test("a magnet link passes through unwrapped", async () => {
    const chrome = makeChrome();
    loadBackground(chrome);
    chrome._listeners["menus.onClicked"](
      {
        menuItemId: "sendToGrab",
        linkUrl: "magnet:?xt=urn:btih:abc",
        pageUrl: "https://example.com/x",
      },
      null
    );
    const raw = chrome._calls.some(
      ([name, arg]) =>
        name === "tabs.update" && arg.url === "magnet:?xt=urn:btih:abc"
    );
    assert.equal(raw, true);
  });
});

describe("size-wait deadline design (review fixes 2 and 3)", () => {
  const settings = () => ({
    syncSettings: { interceptDownloads: true, minSizeMB: 100, skipTypes: "" },
  });
  const item = (id) => ({
    id,
    url: "https://example.com/big.iso",
    fileSize: -1,
    state: "in_progress",
  });
  const handedOff = (chrome) =>
    chrome._calls.some(([name]) => name === "handoff");

  test("parkForSize stores the deadline the alarm wakes for", async () => {
    const chrome = makeChrome();
    const bg = loadBackground(chrome);
    const before = Date.now();
    await bg.parkForSize({ id: 21, url: "https://example.com/x" });
    const deadline = chrome._session.get("pendingSize:21");
    assert.ok(deadline >= before + bg.SIZE_WAIT_MS);
    assert.ok(deadline <= Date.now() + bg.SIZE_WAIT_MS);
    assert.equal(chrome._alarms.get("size-wait:21").when, deadline);
  });

  test("a download finishing during parkForSize is left alone", async () => {
    const chrome = makeChrome(settings());
    loadBackground(chrome);
    chrome._downloads.set(11, item(11));
    // Race: the download completes while the pending state is being written.
    const origSet = chrome.storage.session.set;
    chrome.storage.session.set = async (obj) => {
      const dl = chrome._downloads.get(11);
      if (dl) dl.state = "complete";
      return origSet(obj);
    };
    await chrome._listeners["downloads.onCreated"](item(11));
    // onCreated re-queried after persisting and dropped the parked entry.
    assert.equal(chrome._session.has("pendingSize:11"), false);
    assert.equal(chrome._alarms.has("size-wait:11"), false);
    assert.equal(handedOff(chrome), false);
    assert.equal(
      chrome._calls.some(([name]) => name === "cancel"),
      false
    );
  });

  test("the alarm does not intercept an already-completed download", async () => {
    const chrome = makeChrome(settings());
    const bg = loadBackground(chrome);
    chrome._downloads.set(12, item(12));
    await chrome._listeners["downloads.onCreated"](item(12));
    assert.equal(chrome._session.has("pendingSize:12"), true);
    chrome._downloads.get(12).state = "complete";
    await bg.decidePending(12);
    // No handoff through any channel, and the browser download is untouched.
    assert.equal(handedOff(chrome), false);
    assert.equal(
      chrome._calls.some(
        ([name, arg]) =>
          name === "tabs.update" &&
          typeof arg.url === "string" &&
          arg.url.startsWith("grab:")
      ),
      false
    );
    assert.equal(
      chrome._calls.some(([name]) => name === "cancel" || name === "removeFile"),
      false
    );
    assert.equal(chrome._session.has("pendingSize:12"), false);
  });

  test("an early decidePending re-parks instead of intercepting", async () => {
    const chrome = makeChrome(settings());
    const bg = loadBackground(chrome);
    chrome._downloads.set(13, item(13));
    await chrome._listeners["downloads.onCreated"](item(13));
    // A stray call before the deadline with the size still unknown must not
    // intercept: the stored deadline decides.
    await bg.decidePending(13);
    assert.equal(handedOff(chrome), false);
    assert.equal(chrome._session.has("pendingSize:13"), true);
    assert.equal(chrome._alarms.has("size-wait:13"), true);
  });

  test("concurrent decidePending calls hand off only once (review finding)", async () => {
    const chrome = makeChrome(settings());
    const bg = loadBackground(chrome);
    chrome._downloads.set(14, item(14));
    // Deadline already past, so decidePending intercepts instead of re-parking.
    chrome._session.set("pendingSize:14", Date.now() - 1000);
    // An alarm and a size-change event arriving together.
    await Promise.all([bg.decidePending(14), bg.decidePending(14)]);
    const handoffs = chrome._calls.filter(
      ([name]) => name === "handoff"
    );
    assert.equal(handoffs.length, 1);
  });
});

describe("toolbar opens the popup", () => {
  test("no onClicked handler: the manifest popup hosts settings now", async () => {
    const chrome = makeChrome();
    loadBackground(chrome);
    // With default_popup set, action.onClicked never fires; the popup UI
    // (popup.html) owns the settings. There must be no grab: navigation
    // from a toolbar click path.
    assert.equal(
      chrome._listeners["action.onClicked"],
      undefined
    );
  });
});

describe("HTTP handoff to Grab", () => {
  const ENDPOINT = "http://127.0.0.1:9412/add?confirm=1";
  let chrome, bg, fetchCalls;

  /// Install a fetch that answers each call with the next status in `statuses`
  /// (the last one repeats); the string "down" rejects like a closed port.
  function mockFetch(...statuses) {
    fetchCalls = [];
    globalThis.fetch = async (url, opts) => {
      fetchCalls.push({ url, opts });
      const s = statuses[Math.min(fetchCalls.length - 1, statuses.length - 1)];
      if (s === "down") throw new Error("connection refused");
      return { status: s, ok: s >= 200 && s < 300 };
    };
  }
  const tabsCreated = () => chrome._calls.filter(([name]) => name === "tabs.create");
  const SECRET = "ab".repeat(32);
  const hmac = (context, message) =>
    nodeCrypto
      .createHmac("sha256", Buffer.from(SECRET, "hex"))
      .update(context + message)
      .digest("hex");
  const posts = () => fetchCalls.filter((c) => c.opts.method === "POST");
  const hellos = () => fetchCalls.filter((c) => c.url.includes("/hello"));

  /// A Grab that answers GET /hello like the real one (a proof computed from
  /// the shared secret) unless told otherwise, and POST /add with `addStatus`.
  function mockPairedGrab({ proof, helloStatus = 200, helloDown = false, addStatus = 200 } = {}) {
    fetchCalls = [];
    globalThis.fetch = async (url, opts = {}) => {
      fetchCalls.push({ url, opts });
      if (url.includes("/hello")) {
        if (helloDown) throw new Error("connection refused");
        const nonce = new URL(url).searchParams.get("n");
        return {
          status: helloStatus,
          ok: helloStatus >= 200 && helloStatus < 300,
          json: async () => ({ proof: proof ?? hmac("grab-server\u0000", nonce) }),
        };
      }
      return { status: addStatus, ok: addStatus >= 200 && addStatus < 300 };
    };
  }
  const pair = () => chrome.storage.local.set({ pairingCode: SECRET });

  beforeEach(() => {
    chrome = makeChrome({
      syncSettings: { interceptDownloads: true, minSizeMB: 0, skipTypes: "" },
    });
    bg = loadBackground(chrome);
  });

  test("POSTs the URL as JSON and opens no tab on success", async () => {
    mockFetch(200);
    assert.equal(await bg.handOff("https://example.com/f.zip?x=1"), true);
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].url, ENDPOINT);
    assert.equal(fetchCalls[0].opts.method, "POST");
    assert.equal(fetchCalls[0].opts.headers["Content-Type"], "application/json");
    assert.deepEqual(JSON.parse(fetchCalls[0].opts.body), {
      url: "https://example.com/f.zip?x=1",
      cookies: [],
      user_agent: navigator.userAgent,
    });
    assert.equal(tabsCreated().length, 0);
  });

  test("posts the URL untouched, including slashes in the query", async () => {
    mockFetch(200);
    await bg.handOff("https://example.com/f.zip?u=udp://t/announce");
    assert.deepEqual(JSON.parse(fetchCalls[0].opts.body), {
      url: "https://example.com/f.zip?u=udp://t/announce",
      cookies: [],
      user_agent: navigator.userAgent,
    });
  });

  test("caps the cookie jar at Grab's 100-cookie limit", async () => {
    mockPairedGrab();
    await pair();
    chrome.cookies.getAll = async () =>
      Array.from({ length: 101 }, (_, i) => ({
        name: `c${i}`,
        value: "v",
        domain: "example.com",
        hostOnly: false,
        path: "/",
        secure: true,
      }));
    assert.equal(await bg.handOff("https://example.com/f.zip"), true);
    assert.equal(posts().length, 1);
    const sent = JSON.parse(posts()[0].opts.body);
    assert.equal(sent.cookies.length, 100);
    assert.equal(sent.cookies[0].name, "c0");
  });

  test("drops cookies when they would exceed Grab's body cap", async () => {
    mockPairedGrab();
    await pair();
    let reads = 0;
    chrome.cookies.getAll = async () => {
      reads += 1;
      return Array.from({ length: 100 }, (_, i) => ({
        name: `c${i}`,
        value: "x".repeat(500),
        domain: "example.com",
        hostOnly: false,
        path: "/",
        secure: true,
      }));
    };
    assert.equal(await bg.handOff("https://example.com/f.zip"), true);
    assert.equal(reads, 1, "the cookie path ran");
    assert.equal(posts().length, 1);
    const post = posts()[0];
    const sent = JSON.parse(post.opts.body);
    assert.deepEqual(sent.cookies, []);
    assert.equal(sent.url, "https://example.com/f.zip");
    assert.equal(sent.user_agent, navigator.userAgent);
    assert.equal(
      post.opts.headers["X-Grab-Token"],
      hmac("grab-client\u0000", post.opts.body),
      "token signs the cookie-dropped body"
    );
    assert.ok(Buffer.byteLength(post.opts.body) < 32 * 1024);
  });

  test("Grab not running is a failure and opens no tab", async () => {
    mockFetch("down");
    assert.equal(await bg.handOff("https://example.com/f.zip"), false);
    assert.equal(fetchCalls.length, 1, "no retry when unreachable");
    assert.equal(tabsCreated().length, 0);
  });

  for (const status of [400, 403, 414, 500]) {
    test(`HTTP ${status} is a failure: no retry, no tab`, async () => {
      mockFetch(status);
      assert.equal(await bg.handOff("https://example.com/f.zip"), false);
      assert.equal(fetchCalls.length, 1);
      assert.equal(tabsCreated().length, 0);
    });
  }

  test("429 is retried and succeeds without opening a tab", async () => {
    mockFetch(429, 200);
    assert.equal(await bg.handOff("https://example.com/f.zip", undefined, [0, 0]), true);
    assert.equal(fetchCalls.length, 2);
    assert.equal(tabsCreated().length, 0);
  });

  test("a queue that stays full gives up after the retries", async () => {
    mockFetch(429);
    assert.equal(await bg.handOff("https://example.com/f.zip", undefined, [0, 0]), false);
    assert.equal(fetchCalls.length, 3, "1 attempt + 2 retries");
    assert.equal(tabsCreated().length, 0);
  });

  test("handOff forwards ctx to postToGrab (tabId reaches cookie lookup)", async () => {
    mockPairedGrab({ addStatus: 200 });
    await pair();
    const tabGets = [];
    const origGet = chrome.tabs.get;
    chrome.tabs.get = async (id) => {
      tabGets.push(id);
      return { id, cookieStoreId: "firefox-default" };
    };
    try {
      assert.equal(
        await bg.handOff("https://example.com/f.zip", { tabId: 42 }, [0, 0]),
        true
      );
      assert.deepEqual(tabGets, [42, 42, 42].slice(0, tabGets.length));
      assert.ok(tabGets.length > 0, "chrome.tabs.get was called with the ctx tabId");
      assert.ok(tabGets.every((id) => id === 42), "all lookups used tabId 42");
    } finally {
      chrome.tabs.get = origGet;
    }
  });

  test("resolveStoreId: Firefox tab.cookieStoreId is used directly", async () => {
    chrome.tabs.get = async (id) => ({ id, cookieStoreId: "firefox-container-1" });
    const getAllCalls = [];
    const origGetAll = chrome.cookies.getAll;
    chrome.cookies.getAll = async (opts) => {
      getAllCalls.push(opts);
      return [];
    };
    try {
      const storeId = await bg.resolveStoreId({ tabId: 7 });
      assert.equal(storeId, "firefox-container-1");
      // readCookies path: getAll called with the Firefox store ID.
      await pair();
      mockPairedGrab({ addStatus: 200 });
      await bg.handOff("https://example.com/f.zip", { tabId: 7 }, [0, 0]);
      assert.ok(
        getAllCalls.some((o) => o.storeId === "firefox-container-1"),
        "getAll used the Firefox cookieStoreId"
      );
    } finally {
      chrome.cookies.getAll = origGetAll;
    }
  });

  test("resolveStoreId: Chrome matches tabIds via getAllCookieStores", async () => {
    chrome.tabs.get = async (id) => ({ id }); // No cookieStoreId on Chrome.
    chrome.cookies.getAllCookieStores = async () => [
      { id: "0", tabIds: [1, 2] },
      { id: "1", tabIds: [7, 8] },
    ];
    const getAllCalls = [];
    const origGetAll = chrome.cookies.getAll;
    chrome.cookies.getAll = async (opts) => {
      getAllCalls.push(opts);
      return [];
    };
    try {
      const storeId = await bg.resolveStoreId({ tabId: 7 });
      assert.equal(storeId, "1");
      await pair();
      mockPairedGrab({ addStatus: 200 });
      await bg.handOff("https://example.com/f.zip", { tabId: 7 }, [0, 0]);
      assert.ok(
        getAllCalls.some((o) => o.storeId === "1"),
        "getAll used the Chrome store matched by tabIds"
      );
    } finally {
      chrome.cookies.getAll = origGetAll;
      delete chrome.cookies.getAllCookieStores;
    }
  });

  test("resolveStoreId: incognito with no resolvable store fails closed", async () => {
    chrome.tabs.get = async () => {
      throw new Error("no such tab");
    };
    chrome.cookies.getAllCookieStores = async () => [];
    await pair();
    mockPairedGrab({ addStatus: 200 });
    const ok = await bg.handOff(
      "https://example.com/f.zip",
      { tabId: 99, incognito: true },
      [0, 0]
    );
    assert.equal(ok, true);
    const post = fetchCalls.find((c) => c.opts.method === "POST");
    const body = JSON.parse(post.opts.body);
    assert.deepEqual(body.cookies, [], "incognito with no store sends no cookies");
    delete chrome.cookies.getAllCookieStores;
  });

  test("resolveStoreId: non-incognito with no tab uses the default store", async () => {
    const getAllCalls = [];
    const origGetAll = chrome.cookies.getAll;
    chrome.cookies.getAll = async (opts) => {
      getAllCalls.push(opts);
      return [];
    };
    try {
      const storeId = await bg.resolveStoreId(undefined);
      assert.equal(storeId, undefined);
      await pair();
      mockPairedGrab({ addStatus: 200 });
      await bg.handOff("https://example.com/f.zip", undefined, [0, 0]);
      assert.ok(
        getAllCalls.some((o) => o.storeId === undefined),
        "getAll used the default store"
      );
    } finally {
      chrome.cookies.getAll = origGetAll;
    }
  });

  test("interceptDownload passes incognito through to cookies: []", async () => {
    await pair();
    mockPairedGrab({ addStatus: 200 });
    // The default store has cookies; incognito interception must NOT send them.
    const origGetAll = chrome.cookies.getAll;
    chrome.cookies.getAll = async () => [
      { name: "session", value: "abc", domain: "example.com" },
    ];
    try {
      // Simulate an incognito download intercepted by the browser.
      const item = {
        id: 99,
        url: "https://example.com/big.iso",
        fileSize: 200 * 1024 * 1024,
        incognito: true,
      };
      chrome._downloads.set(99, { ...item, state: "in_progress" });
      await chrome._listeners["downloads.onCreated"](item);
      const post = fetchCalls.find((c) => c.opts.method === "POST");
      assert.ok(post, "handoff POST was sent");
      const body = JSON.parse(post.opts.body);
      assert.deepEqual(
        body.cookies,
        [],
        "incognito interception must send no cookies even when the default store has them"
      );
    } finally {
      chrome.cookies.getAll = origGetAll;
    }
  });

  test("handOff honors the retry delays (not the default 300/900)", async () => {
    mockFetch(429, 429, 200);
    const delays = [];
    const origSleep = bg._setSleep;
    bg._setSleep(async (ms) => {
      delays.push(ms);
    });
    try {
      assert.equal(
        await bg.handOff("https://example.com/f.zip", undefined, [0, 0]),
        true
      );
      assert.deepEqual(delays, [0, 0], "used the passed delays, not HANDOFF_RETRY_DELAYS_MS");
    } finally {
      bg._setSleep((ms) => new Promise((r) => setTimeout(r, ms)));
    }
    void origSleep;
  });

  test("automatic interception cancels the browser download after a 200", async () => {
    mockFetch(200);
    await chrome._listeners["downloads.onCreated"]({
      id: 77,
      url: "https://example.com/big.iso",
      fileSize: -1,
    });
    assert.equal(fetchCalls.length, 1);
    assert.equal(tabsCreated().length, 0);
    assert.ok(chrome._calls.some(([name, id]) => name === "cancel" && id === 77));
  });

  test("automatic interception leaves the download in the browser when Grab is down", async () => {
    mockFetch("down");
    await chrome._listeners["downloads.onCreated"]({
      id: 78,
      url: "https://example.com/big.iso",
      fileSize: -1,
    });
    assert.equal(tabsCreated().length, 0);
    assert.equal(chrome._calls.some(([name]) => name === "cancel"), false);
    assert.equal(chrome._calls.some(([name]) => name === "removeFile"), false);
  });

  test("sends full cookie attributes so Grab preserves browser scope", async () => {
    chrome.cookies.getAll = async () => [
      {
        name: "sess",
        value: "s3cr3t",
        domain: "videos.example.com",
        hostOnly: true,
        path: "/watch",
        secure: true,
        expirationDate: 1893456000,
      },
      {
        name: "prefs",
        value: "dark",
        domain: ".example.com",
        hostOnly: false,
        path: "/",
        secure: false,
        // No expirationDate: session cookie.
      },
    ];
    await pair();
    mockPairedGrab();
    assert.equal(await bg.handOff("https://videos.example.com/watch/1"), true);
    assert.deepEqual(JSON.parse(posts()[0].opts.body), {
      url: "https://videos.example.com/watch/1",
      cookies: [
        {
          name: "sess",
          value: "s3cr3t",
          domain: "videos.example.com",
          host_only: true,
          path: "/watch",
          secure: true,
          expiration_date: 1893456000,
        },
        {
          name: "prefs",
          value: "dark",
          domain: ".example.com",
          host_only: false,
          path: "/",
          secure: false,
          // No expiration_date: session cookie; JSON.stringify omits it.
        },
      ],
      user_agent: navigator.userAgent,
    });
  });

  test("cookie read failure falls back to a URL-only handoff", async () => {
    chrome.cookies.getAll = async () => {
      throw new Error("permission denied");
    };
    await pair();
    mockPairedGrab();
    assert.equal(await bg.handOff("https://example.com/f.zip"), true);
    assert.deepEqual(JSON.parse(posts()[0].opts.body), {
      url: "https://example.com/f.zip",
      cookies: [],
      user_agent: navigator.userAgent,
    });
  });

  // --- pairing -----------------------------------------------------------

  test("unpaired: URL only, no cookie read, no handshake, no token", async () => {
    let cookieReads = 0;
    chrome.cookies.getAll = async () => {
      cookieReads += 1;
      return [{ name: "s", value: "v", domain: "example.com", path: "/" }];
    };
    mockFetch(200);
    assert.equal(await bg.handOff("https://example.com/f.zip"), true);
    assert.equal(cookieReads, 0, "cookies must not be read without pairing");
    assert.equal(fetchCalls.length, 1, "no /hello without a pairing code");
    assert.equal(fetchCalls[0].opts.headers["X-Grab-Token"], undefined);
    assert.deepEqual(JSON.parse(fetchCalls[0].opts.body).cookies, []);
  });

  test("paired: Grab proves itself first, then the signed body carries the cookies", async () => {
    chrome.cookies.getAll = async () => [
      { name: "s", value: "v", domain: "example.com", hostOnly: true, path: "/", secure: true },
    ];
    await pair();
    mockPairedGrab();
    assert.equal(await bg.handOff("https://example.com/f.zip"), true);
    assert.equal(fetchCalls.length, 2);
    assert.match(fetchCalls[0].url, /^http:\/\/127\.0\.0\.1:9412\/hello\?n=[0-9a-f]{32}$/);
    const post = posts()[0];
    assert.equal(post.url, ENDPOINT);
    const token = post.opts.headers["X-Grab-Token"];
    assert.equal(token, hmac("grab-client\u0000", post.opts.body), "token signs the exact body");
    assert.equal(JSON.parse(post.opts.body).cookies.length, 1);
  });

  test("every handshake uses a fresh nonce", async () => {
    await pair();
    mockPairedGrab();
    await bg.handOff("https://example.com/a.zip");
    await bg.handOff("https://example.com/b.zip");
    const nonces = hellos().map((c) => new URL(c.url).searchParams.get("n"));
    assert.equal(new Set(nonces).size, 2);
  });

  test("an impostor that cannot prove the code gets nothing: no cookies, no POST", async () => {
    let cookieReads = 0;
    chrome.cookies.getAll = async () => {
      cookieReads += 1;
      return [{ name: "s", value: "v", domain: "example.com", path: "/" }];
    };
    await pair();
    mockPairedGrab({ proof: "00".repeat(32) });
    assert.equal(await bg.handOff("https://example.com/f.zip"), false);
    assert.equal(cookieReads, 0, "cookies must never be read for an unverified listener");
    assert.equal(posts().length, 0, "nothing may be sent to an unverified listener");
  });

  test("a /hello without a usable answer is a failure with no POST", async () => {
    await pair();
    for (const opts of [{ helloStatus: 503 }, { helloStatus: 403 }, { helloDown: true }]) {
      mockPairedGrab(opts);
      assert.equal(await bg.handOff("https://example.com/f.zip"), false, JSON.stringify(opts));
      assert.equal(posts().length, 0);
    }
  });

  test("a malformed stored code counts as unpaired", async () => {
    await chrome.storage.local.set({ pairingCode: "not-a-code" });
    mockFetch(200);
    assert.equal(await bg.handOff("https://example.com/f.zip"), true);
    assert.equal(fetchCalls.length, 1, "no handshake");
    assert.equal(fetchCalls[0].opts.headers["X-Grab-Token"], undefined);
  });

  // --- confirm=1 outcomes ------------------------------------------------

  for (const status of [408, 409]) {
    test(`HTTP ${status} (declined / no answer) keeps the browser download`, async () => {
      mockFetch(status);
      await chrome._listeners["downloads.onCreated"]({
        id: 90,
        url: "https://example.com/big.iso",
        fileSize: -1,
      });
      assert.equal(fetchCalls.length, 1, "no retry");
      assert.equal(chrome._calls.some(([name]) => name === "cancel"), false);
      assert.equal(chrome._calls.some(([name]) => name === "removeFile"), false);
    });
  }

  test("requests the confirm=1 answer and allows time for the dialog", async () => {
    mockFetch(200);
    await bg.handOff("https://example.com/f.zip");
    assert.ok(fetchCalls[0].url.endsWith("/add?confirm=1"));
    assert.ok(fetchCalls[0].opts.signal, "the wait is bounded by an abort signal");
  });
});

describe("interception across worker restarts and fast downloads", () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  test("a freshly woken worker still intercepts a download that began before it started", async () => {
    const shared = {
      syncSettings: { interceptDownloads: true, minSizeMB: 0, skipTypes: "" },
    };
    const first = makeChrome(shared);
    loadBackground(first);
    first._listeners["runtime.onStartup"]();
    await wait(5);
    const startTime = new Date().toISOString(); // the download begins
    await wait(5);
    // The idle worker is gone; the download event wakes a new one that
    // starts after the download did, sharing the same session storage.
    const second = makeChrome(shared);
    loadBackground(second);
    await second._listeners["downloads.onCreated"]({
      id: 4,
      url: "https://example.com/a.iso",
      fileSize: 10,
      startTime,
    });
    assert.ok(second._calls.some(([n, arg]) => n === "cancel" && arg === 4));
  });

  test("a download that completed during the handoff leaves no history entry or claim", async () => {
    const chrome = makeChrome({
      syncSettings: { interceptDownloads: true, minSizeMB: 0, skipTypes: "" },
    });
    loadBackground(chrome);
    const done = {
      id: 5,
      url: "https://example.com/tiny.bin",
      fileSize: 10,
      state: "complete",
    };
    chrome._downloads.set(5, done);
    await chrome._listeners["downloads.onCreated"](done);
    assert.ok(chrome._calls.some(([n, a]) => n === "removeFile" && a === 5));
    assert.ok(chrome._calls.some(([n, a]) => n === "erase" && a.id === 5));
    assert.equal(chrome._session.has("claimedDownload:5"), false);
  });
});

describe("P2/P3 regression tests", () => {
  test("removeAllContextMenus works with callback-style API", async () => {
    const chrome = makeChrome();
    const bg = loadBackground(chrome);
    // Mock returns undefined (old Chrome), invokes callback.
    let callbackInvoked = false;
    chrome.contextMenus.removeAll = (cb) => {
      callbackInvoked = true;
      if (typeof cb === "function") cb();
      return undefined;
    };
    await bg.removeAllContextMenus();
    assert.equal(callbackInvoked, true);
  });

  test("removeContextMenu works with callback-style API", async () => {
    const chrome = makeChrome();
    const bg = loadBackground(chrome);
    let callbackInvoked = false;
    chrome.contextMenus.remove = (id, cb) => {
      callbackInvoked = true;
      if (typeof cb === "function") cb();
      return undefined;
    };
    await bg.removeContextMenu("test-id");
    assert.equal(callbackInvoked, true);
  });

  test("parkForSize preserves existing deadline on re-park", async () => {
    const chrome = makeChrome({
      syncSettings: { interceptDownloads: true, minSizeMB: 0, skipTypes: "" },
    });
    const bg = loadBackground(chrome);
    const item = { id: 7, url: "https://example.com/file.bin" };
    const originalDeadline = Date.now() + 5000;
    await bg.parkForSize(item, originalDeadline);
    const stored1 = await chrome.storage.session.get(bg.pendingKey(7));
    assert.equal(stored1[bg.pendingKey(7)], originalDeadline);
    // Re-park with same deadline (simulates early decidePending call).
    await bg.parkForSize(item, originalDeadline);
    const stored2 = await chrome.storage.session.get(bg.pendingKey(7));
    assert.equal(stored2[bg.pendingKey(7)], originalDeadline);
  });
});
