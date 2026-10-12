// Tests for the Grab browser extension's background service worker.
// Run with: node --test test/   (Node's built-in runner, no dependencies)
const { test, describe, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const BG_PATH = path.join(__dirname, "..", "background.js");

/// Minimal chrome mock: captures listeners, records calls, backs
/// chrome.storage.session with a Map. Pass a shared `shared` object to
/// simulate a worker restart (new worker, same session storage).
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
      sendNativeMessage: async (host, msg) => {
        calls.push(["runtime.sendNativeMessage", host, msg]);
        // Simulate missing host by default — tests cover the tab fallback.
        // Specific tests override this to test native messaging.
        throw new Error("No such native application");
      },
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

/// Load a fresh copy of background.js against the given chrome mock.
function loadBackground(chrome) {
  delete require.cache[require.resolve(BG_PATH)];
  globalThis.chrome = chrome;
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
      ([name, props]) =>
        name === "tabs.create" &&
        props.url === "grab://https/example.com/big.iso"
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
      ([name, props]) =>
        name === "tabs.create" &&
        props.url === "grab://https/example.com/big.iso"
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
        (name === "tabs.create" &&
          arg.url === "grab://https/example.com/file.zip" &&
          arg.active === false)
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
  test("automatic interception uses grab:// URL in background tab, never the selected tab", async () => {
    const chrome = makeChrome({
      syncSettings: { interceptDownloads: true, minSizeMB: 0, skipTypes: "" },
    });
    loadBackground(chrome);
    await chrome._listeners["downloads.onCreated"]({
      id: 31,
      url: "https://example.com/big.iso",
      fileSize: -1,
    });
    const viaBackgroundTab = chrome._calls.some(
      ([name, props]) =>
        name === "tabs.create" &&
        props.url === "grab://https/example.com/big.iso" &&
        props.active === false
    );
    const viaSelectedTab = chrome._calls.some(
      ([name, arg]) =>
        name === "tabs.update" &&
        typeof arg.url === "string" &&
        arg.url.startsWith("grab:")
    );
    assert.equal(viaBackgroundTab, true);
    assert.equal(viaSelectedTab, false);
  });

  test("explicit context-menu send still navigates the active tab", async () => {
    const chrome = makeChrome();
    loadBackground(chrome);
    chrome._listeners["menus.onClicked"](
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

  test("a blob: media URL falls back to the page URL for extraction", async () => {
    const chrome = makeChrome();
    loadBackground(chrome);
    chrome._listeners["menus.onClicked"](
      {
        menuItemId: "sendToGrab",
        srcUrl: "blob:https://example.com/uuid",
        pageUrl: "https://example.com/room/user",
      },
      null
    );
    const sent = chrome._calls.some(
      ([name, arg]) =>
        name === "tabs.update" &&
        arg.url === "grab://https/example.com/room/user"
    );
    assert.equal(sent, true);
  });

  test("a usable media URL is still preferred over the page URL", async () => {
    const chrome = makeChrome();
    loadBackground(chrome);
    chrome._listeners["menus.onClicked"](
      {
        menuItemId: "sendToGrab",
        srcUrl: "https://cdn.example.com/v.mp4",
        pageUrl: "https://example.com/watch/1",
      },
      null
    );
    const sent = chrome._calls.some(
      ([name, arg]) =>
        name === "tabs.update" && arg.url === "grab://https/cdn.example.com/v.mp4"
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
    chrome._calls.some(([name]) => name === "tabs.create");

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
      ([name, props]) =>
        name === "tabs.create" &&
        typeof props.url === "string" &&
        props.url.startsWith("grab:")
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
