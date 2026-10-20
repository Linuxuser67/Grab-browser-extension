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