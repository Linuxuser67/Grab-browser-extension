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
    // Simulate site autoplay: no transient user activation is present.
    Object.defineProperty(g.navigator, "userActivation", {
      configurable: true,
      value: { isActive: false },
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

  test("autoplay play event in a shadow root triggers a report without user activation", async () => {
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

  test("a video in a late-mounted open shadow root is detected without rescan or interaction", async () => {
    const dom = new JSDOM("<!DOCTYPE html><body></body>", { url: "https://example.com/" });
    const { messages, document, cleanup } = loadContent(dom);
    try {
      messages.length = 0;
      const host = document.createElement("custom-video-player");
      const root = host.attachShadow({ mode: "open" });
      const video = makeVideo(document, { src: "https://cdn.example.com/late.mp4" });
      root.appendChild(video);
      // The player is mounted after content.js completed its initial deep scan.
      // No click, pointer event, playlist rescan, or media event is sent.
      document.body.appendChild(host);

      await new Promise((resolve) => setTimeout(resolve, 500));
      const reports = messages.filter((message) => message.type === "grab-videos-detected");
      assert.ok(reports.length > 0, "mounting the host wires its open root and schedules a report");
      assert.ok(
        reports.at(-1).videos.some((entry) => entry.src === "https://cdn.example.com/late.mp4"),
        "the already-playing direct source is included",
      );
      await new Promise((resolve) => setTimeout(resolve, 500));
    } finally {
      cleanup();
    }
  });

  test("a new shadow-root host inside an observed root is discovered incrementally", async () => {
    const dom = new JSDOM("<!DOCTYPE html><body></body>", { url: "https://example.com/" });
    const { messages, document, cleanup } = loadContent(dom);
    try {
      messages.length = 0;
      const outerHost = document.createElement("custom-player-shell");
      const outerRoot = outerHost.attachShadow({ mode: "open" });
      document.body.appendChild(outerHost);
      // Let the document observer discover and begin observing the outer root.
      await new Promise((resolve) => setTimeout(resolve, 0));

      const innerHost = document.createElement("custom-video-player");
      const innerRoot = innerHost.attachShadow({ mode: "open" });
      innerRoot.appendChild(makeVideo(document, { src: "https://cdn.example.com/nested.mp4" }));
      outerRoot.appendChild(innerHost);

      await new Promise((resolve) => setTimeout(resolve, 500));
      const reports = messages.filter((message) => message.type === "grab-videos-detected");
      assert.ok(
        reports.some((report) => report.videos.some((entry) => entry.src === "https://cdn.example.com/nested.mp4")),
        "the mutation observer on the outer root discovers nested open roots",
      );
      await new Promise((resolve) => setTimeout(resolve, 500));
    } finally {
      cleanup();
    }
  });

  test("initial scan detects a video already playing before content-script injection", () => {
    const dom = new JSDOM("<!DOCTYPE html><body></body>", { url: "https://example.com/" });
    const video = makeVideo(dom.window.document);
    dom.window.document.body.appendChild(video);
    const { messages, cleanup } = loadContent(dom);
    try {
      const report = messages.find((m) => m.type === "grab-videos-detected");
      assert.ok(report, "the initial scan reports immediately");
      assert.equal(report.videos.length, 1, "pre-existing autoplay is detected");
      assert.equal(report.videos[0].src, "https://example.com/v.mp4");
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

  test("batches shadow discovery and skips leaf-only additions", async () => {
    const dom = new JSDOM("<!DOCTYPE html><body></body>", { url: "https://example.com/" });
    const { document, window, cleanup } = loadContent(dom);
    try {
      // Let the script's startup report finish before measuring mutation work.
      await new Promise((resolve) => setTimeout(resolve, 450));
      let wildcardQueries = 0;
      const original = window.Element.prototype.querySelectorAll;
      window.Element.prototype.querySelectorAll = function (selector) {
        if (selector === "*") wildcardQueries++;
        return original.call(this, selector);
      };

      for (let i = 0; i < 20; i++) {
        document.body.appendChild(document.createElement("div"));
      }
      await new Promise((resolve) => setTimeout(resolve, 450));
      assert.equal(wildcardQueries, 0, "leaf additions cannot contain nested shadow hosts");

      const subtree = document.createElement("div");
      subtree.appendChild(document.createElement("span"));
      document.body.appendChild(subtree);
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(wildcardQueries, 0, "the mutation callback only queues the subtree");

      await new Promise((resolve) => setTimeout(resolve, 350));
      assert.equal(wildcardQueries, 1, "the subtree is scanned once when the batch flushes");
      window.Element.prototype.querySelectorAll = original;
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

  test("media events do not walk every element on the page", async () => {
    const dom = new JSDOM("<!DOCTYPE html><body></body>", { url: "https://example.com/" });
    const { messages, document, window, cleanup } = loadContent(dom);
    try {
      messages.length = 0;
      let wildcardQueries = 0;
      const original = document.querySelectorAll.bind(document);
      document.querySelectorAll = (selector) => {
        if (selector === "*") wildcardQueries++;
        return original(selector);
      };
      const video = makeVideo(document, { muted: false });
      document.body.appendChild(video);
      video.dispatchEvent(new window.Event("play", { bubbles: false }));
      await new Promise((r) => setTimeout(r, 500));
      const reports = messages.filter((m) => m.type === "grab-videos-detected");
      assert.equal(wildcardQueries, 0, "a play event uses the shallow scan");
      assert.equal(reports[reports.length - 1].videos.length, 1, "the playing video is still reported");
      await new Promise((r) => setTimeout(r, 500));
    } finally {
      cleanup();
    }
  });

  test("pausing immediately reports no active video with a pause lifecycle", async () => {
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
      assert.equal(last.replaceFrame, true, "empty pause report replaces the frame snapshot");
      assert.equal(last.lifecycle, "pause", "pause is distinct from a source reset");
      assert.equal(last.lifecycleSource, "https://example.com/v.mp4");
      assert.ok(Number.isFinite(last.lifecycleAt), "pause includes its event timestamp");
      await new Promise((r) => setTimeout(r, 500));
    } finally {
      cleanup();
    }
  });

  test("an emptied video emits a source-reset lifecycle", async () => {
    const dom = new JSDOM("<!DOCTYPE html><body></body>", { url: "https://example.com/" });
    const { messages, document, window, cleanup } = loadContent(dom);
    try {
      const video = makeVideo(document, { muted: false });
      document.body.appendChild(video);
      video.dispatchEvent(new window.Event("play", { bubbles: false }));
      await new Promise((r) => setTimeout(r, 500));
      messages.length = 0;

      // A pending pause report must not delay or downgrade a real reset.
      video.dispatchEvent(new window.Event("pause", { bubbles: false }));
      video.dispatchEvent(new window.Event("emptied", { bubbles: false }));
      const immediateReports = messages.filter((m) => m.type === "grab-videos-detected");
      assert.ok(immediateReports.length > 0, "source reset is reported synchronously");
      assert.equal(immediateReports.at(-1).lifecycle, "reset");
      assert.equal(immediateReports.at(-1).lifecycleSource, "https://example.com/v.mp4");
      assert.ok(Number.isFinite(immediateReports.at(-1).lifecycleAt), "reset includes its event timestamp");

      await new Promise((r) => setTimeout(r, 500));
      const reports = messages.filter((m) => m.type === "grab-videos-detected");
      assert.ok(reports.length > 0, "the reset report remains observable after the debounce window");
      const last = reports.find((message) => message.lifecycle === "reset");
      assert.ok(last, "the reset lifecycle is not downgraded by the pending pause");
      assert.equal(last.replaceFrame, true);
      await new Promise((r) => setTimeout(r, 500));
    } finally {
      cleanup();
    }
  });
});
