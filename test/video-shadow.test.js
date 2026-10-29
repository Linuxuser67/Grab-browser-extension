// Shadow-root video detection tests (jsdom).
// CI installs a pinned jsdom version before running this suite.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const CONTENT_PATH = path.join(__dirname, "..", "content.js");

const { JSDOM } = require("jsdom");

describe("shadow-root video detection (jsdom)", () => {

  function loadContent(dom) {
    const messages = [];
    let messageListener = null;
    const chrome = {
      runtime: {
        sendMessage: (msg) => messages.push(msg),
        onMessage: { addListener: (fn) => { messageListener = fn; } },
      },
    };
    // content.js runs its init at load time against globals.
    const g = dom.window;
    // jsdom does not implement user activation; expose the property consumed
    // by content.js on the window's Navigator instance.
    Object.defineProperty(g.navigator, "userActivation", {
      configurable: true,
      value: { isActive: true },
    });
    // Fresh module per test: the init block wires listeners on load.
    delete require.cache[require.resolve(CONTENT_PATH)];
    // Keep globals set for the test duration (reports are async).
    // Node 22 also exposes a read-only global navigator, so save its property
    // descriptor and replace it explicitly instead of assigning to the getter.
    const prevNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    const prev = {
      chrome: globalThis.chrome,
      document: globalThis.document,
      location: globalThis.location,
    };
    globalThis.chrome = chrome;
    globalThis.document = g.document;
    globalThis.location = g.location;
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      enumerable: prevNavigator ? prevNavigator.enumerable : true,
      writable: true,
      value: g.navigator,
    });
    require(CONTENT_PATH);
    const cleanup = () => {
      // Install a dummy: pending debounce timers from this instance may
      // still fire after the test ends; they must not throw.
      globalThis.chrome = {
        runtime: { sendMessage: () => {}, onMessage: { addListener: () => {} } },
      };
      globalThis.document = prev.document;
      globalThis.location = prev.location;
      if (prevNavigator) {
        Object.defineProperty(globalThis, "navigator", prevNavigator);
      } else {
        delete globalThis.navigator;
      }
    };
    return { messages, document: g.document, window: g, messageListener, cleanup };
  }

  function makeVideo(doc, { muted = false, src = "https://example.com/v.mp4" } = {}) {
    const v = doc.createElement("video");
    v.src = src;
    v.muted = muted;
    // jsdom doesn't implement media playback; fake the "started" state.
    Object.defineProperty(v, "paused", { value: false, configurable: true });
    Object.defineProperty(v, "ended", { value: false, configurable: true });
    Object.defineProperty(v, "readyState", { value: 4, configurable: true });
    Object.defineProperty(v, "videoWidth", { value: 640, configurable: true });
    Object.defineProperty(v, "videoHeight", { value: 360, configurable: true });
    return v;
  }

  test("play event in a shadow root triggers a video report", async () => {
    const dom = new JSDOM("<!DOCTYPE html><body></body>", { url: "https://example.com/" });
    const { messages, document, window, messageListener, cleanup } = loadContent(dom);
    try {
      messages.length = 0;
      // Player lives inside an open shadow root, like Reddit's.
      const host = document.createElement("div");
      document.body.appendChild(host);
      const root = host.attachShadow({ mode: "open" });
      const video = makeVideo(document, { muted: false });
      root.appendChild(video);
      // Worker rescan (after sniffing a manifest) wires the shadow root.
      messageListener({ type: "grab-rescan" });
      // Play inside the shadow root: the event never leaves it, but the
      // root-level capture listener must see it and latch the video.
      video.dispatchEvent(new window.Event("play", { bubbles: false }));
      await new Promise((r) => setTimeout(r, 500));
      const reports = messages.filter((m) => m.type === "grab-videos-detected");
      assert.ok(reports.length > 0, "a report was sent");
      const last = reports[reports.length - 1];
      assert.equal(last.videos.length, 1, "shadow-root video was detected");
      assert.equal(last.videos[0].src, "https://example.com/v.mp4");
      // Let the debounce timer settle before restoring globals.
      await new Promise((r) => setTimeout(r, 500));
    } finally {
      cleanup();
    }
  });

  test("ordinary pointer/click events do not trigger a page-wide DOM sweep", () => {
    const dom = new JSDOM("<!DOCTYPE html><body><div id='outside'></div></body>", { url: "https://example.com/" });
    const { document, window, cleanup } = loadContent(dom);
    try {
      let wildcardQueries = 0;
      const original = document.querySelectorAll.bind(document);
      document.querySelectorAll = (selector) => {
        if (selector === "*") wildcardQueries++;
        return original(selector);
      };
      document.dispatchEvent(new window.MouseEvent("pointerdown", { bubbles: true, composed: true }));
      document.dispatchEvent(new window.MouseEvent("click", { bubbles: true, composed: true }));
      assert.equal(wildcardQueries, 0, "interaction handlers should inspect the event path only");
    } finally {
      cleanup();
    }
  });

  test("light-DOM video still reports (control)", async () => {
    const dom = new JSDOM("<!DOCTYPE html><body></body>", { url: "https://example.com/" });
    const { messages, document, window, cleanup } = loadContent(dom);
    try {
      messages.length = 0;
      const video = makeVideo(document, { muted: false });
      document.body.appendChild(video);
      video.dispatchEvent(new window.Event("play", { bubbles: false }));
      await new Promise((r) => setTimeout(r, 500));
      const reports = messages.filter((m) => m.type === "grab-videos-detected");
      assert.ok(reports.length > 0, "a report was sent");
      assert.equal(reports[reports.length - 1].videos.length, 1);
      await new Promise((r) => setTimeout(r, 500));
    } finally {
      cleanup();
    }
  });

  test("pausing immediately reports no active video and replaces stale frame state", async () => {
    const dom = new JSDOM("<!DOCTYPE html><body></body>", { url: "https://example.com/" });
    const { messages, document, window, cleanup } = loadContent(dom);
    try {
      messages.length = 0;
      const video = makeVideo(document, { muted: false });
      document.body.appendChild(video);
      video.dispatchEvent(new window.Event("play", { bubbles: false }));
      await new Promise((r) => setTimeout(r, 500));
      let reports = messages.filter((m) => m.type === "grab-videos-detected");
      assert.equal(reports[reports.length - 1].videos.length, 1, "playing video is reported");

      Object.defineProperty(video, "paused", { value: true, configurable: true });
      video.dispatchEvent(new window.Event("pause", { bubbles: false }));
      await new Promise((r) => setTimeout(r, 500));
      reports = messages.filter((m) => m.type === "grab-videos-detected");
      const last = reports[reports.length - 1];
      assert.deepEqual(last.videos, [], "paused video is no longer offered");
      assert.equal(last.replaceFrame, true, "empty pause report clears the background cache");
      await new Promise((r) => setTimeout(r, 500));
    } finally {
      cleanup();
    }
  });
});
