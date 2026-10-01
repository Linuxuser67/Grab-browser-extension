// Grab browser extension (MV3) — service worker.
//
// Two jobs:
//   1. Automatic interception: browser downloads are cancelled and handed to
//      the Grab desktop app through the grab: URI scheme (registered by the
//      app's .desktop entry as x-scheme-handler/grab).
//   2. Explicit sends: toolbar button, context menu, and keyboard shortcut
//      send the current tab or a link/media URL to Grab.
//
// All listeners are registered synchronously at the top level: the worker is
// ephemeral and Chrome only wakes it for events it registered for on startup.

const GRAB_SCHEME = "grab://";

const DEFAULTS = {
  interceptDownloads: true,
  // Comma-separated file extensions the browser keeps handling itself.
  skipTypes: "",
  showContextMenu: true,
  // Minimum download size (MiB) that gets intercepted. 0 intercepts everything.
  minSizeMB: 0,
};

/// Wrap an http(s) URL for the Grab desktop app. Anything else (blob:, data:,
/// file:, …) cannot be handed off and returns null.
function toGrabUrl(url) {
  if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return null;
  return GRAB_SCHEME + url.replace(/^https?:\/\//i, "");
}

/// Hand a URL to the Grab desktop app. Navigating a tab to an unknown scheme
/// delegates to the OS handler without replacing the page (same mechanism as
/// mailto: links), so the user's tab is left alone.
function sendToGrab(url) {
  const grabUrl = toGrabUrl(url);
  if (grabUrl) chrome.tabs.update({ url: grabUrl });
}

/// True when the URL's file extension is on the user's skip list.
function isSkipped(url, skipTypes) {
  if (!skipTypes) return false;
  let ext = "";
  try {
    const path = new URL(url).pathname;
    const dot = path.lastIndexOf(".");
    if (dot >= 0) ext = path.slice(dot + 1).toLowerCase();
  } catch {
    return false;
  }
  return skipTypes
    .split(",")
    .map((s) => s.trim().toLowerCase().replace(/^\./, ""))
    .some((s) => s !== "" && s === ext);
}

async function getSettings() {
  return chrome.storage.sync.get(DEFAULTS);
}

/// Per-download claim keys in session storage: one key per download id, so two
/// downloads claimed at the same moment can't clobber each other's record the
/// way a shared read-modify-write set would. Session storage survives service
/// worker restarts and clears when the browser closes.
const claimKey = (id) => `claimedDownload:${id}`;

async function claimDownload(id) {
  await chrome.storage.session.set({ [claimKey(id)]: true });
}

async function unclaimDownload(id) {
  await chrome.storage.session.remove(claimKey(id));
}

async function isClaimed(id) {
  const key = claimKey(id);
  const result = await chrome.storage.session.get(key);
  return result[key] === true;
}

// --- Automatic interception ----------------------------------------------

async function interceptDownload(item) {
  await claimDownload(item.id);

  try {
    await chrome.downloads.cancel(item.id);
  } catch {
    // Already gone; the onChanged guard below still cleans up.
  }
  try {
    await chrome.downloads.removeFile(item.id);
  } catch {
    // Nothing written yet or already removed.
  }
  sendToGrab(item.url);
}

// Downloads parked while waiting for their size to become known, when the
// user set a minimum intercept size. Maps download id -> { timer }.
const pendingSize = new Map();

// How long to wait for a server to report the size before treating an
// unknown size as big enough to intercept (streams rarely send one, and they
// belong in Grab).
const SIZE_WAIT_MS = 10_000;

const minSizeBytes = (settings) =>
  Math.max(0, settings.minSizeMB | 0) * 1024 * 1024;

async function decidePending(id) {
  const pending = pendingSize.get(id);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingSize.delete(id);

  const settings = await getSettings();
  const items = await chrome.downloads.search({ id });
  const item = items[0];
  if (!item) return;
  // The user may have changed their mind while we waited.
  if (!settings.interceptDownloads) return;
  if (isSkipped(item.url, settings.skipTypes)) return;
  if (!toGrabUrl(item.url)) return;
  // Small enough to stay in the browser; unknown size falls through to
  // interception (see SIZE_WAIT_MS).
  if (item.fileSize >= 0 && item.fileSize < minSizeBytes(settings)) return;
  await interceptDownload(item);
}

function parkForSize(item) {
  const timer = setTimeout(() => decidePending(item.id), SIZE_WAIT_MS);
  pendingSize.set(item.id, { timer });
}

chrome.downloads.onCreated.addListener(async (item) => {
  const settings = await getSettings();
  if (!settings.interceptDownloads) return;
  // Extension installs/updates must never be intercepted.
  if (item.mime === "application/x-chrome-extension") return;
  if (isSkipped(item.url, settings.skipTypes)) return;
  // Non-http(s) downloads (blob:, data:) have no server URL to hand over.
  if (!toGrabUrl(item.url)) return;

  const cap = minSizeBytes(settings);
  if (cap > 0) {
    if (item.fileSize >= 0 && item.fileSize < cap) return; // Too small: browser keeps it.
    if (item.fileSize < 0) {
      // Size not known yet (headers haven't arrived): wait for it instead of
      // guessing. The browser download proceeds normally meanwhile.
      parkForSize(item);
      return;
    }
  }

  await interceptDownload(item);
});

chrome.downloads.onChanged.addListener(async (delta) => {
  if (pendingSize.has(delta.id)) {
    const state = delta.state && delta.state.current;
    if (state === "complete" || state === "interrupted") {
      // Finished or failed before the size arrived: too late to hand over.
      const pending = pendingSize.get(delta.id);
      clearTimeout(pending.timer);
      pendingSize.delete(delta.id);
      return;
    }
    if (delta.fileSize && delta.fileSize.current >= 0) {
      await decidePending(delta.id);
      return;
    }
  }
  if (!(await isClaimed(delta.id))) return;
  const state = delta.state && delta.state.current;
  if (state === "complete") {
    // Lost the race: the browser finished before our cancel landed. Remove
    // the duplicate so only Grab's copy remains.
    try {
      await chrome.downloads.removeFile(delta.id);
    } catch {
      // Already gone.
    }
    try {
      await chrome.downloads.erase({ id: delta.id });
    } catch {
      // Already gone.
    }
  }
  if (state === "complete" || state === "interrupted") {
    await unclaimDownload(delta.id);
  }
});

// --- Explicit sends -------------------------------------------------------

function createContextMenu() {
  chrome.contextMenus.create({
    id: "sendToGrab",
    title: "Download with Grab",
    contexts: ["link", "video", "audio", "image", "page"],
  });
}

chrome.runtime.onInstalled.addListener(async () => {
  const settings = await getSettings();
  // removeAll first: onInstalled also fires on extension updates, when the
  // menu may already exist (create would throw on a duplicate id).
  await chrome.contextMenus.removeAll().catch(() => {});
  if (settings.showContextMenu) createContextMenu();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync" || !changes.showContextMenu) return;
  if (changes.showContextMenu.newValue) {
    createContextMenu();
  } else {
    chrome.contextMenus.remove("sendToGrab").catch(() => {});
  }
});

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId !== "sendToGrab") return;
  // Magnet links already open in Grab through the OS handler; pass them
  // through unwrapped.
  const url = info.linkUrl || info.srcUrl || info.pageUrl;
  if (typeof url === "string" && url.toLowerCase().startsWith("magnet:")) {
    chrome.tabs.update({ url });
    return;
  }
  // Prefer the media/link target; fall back to the page URL.
  sendToGrab(url);
});

chrome.action.onClicked.addListener((tab) => {
  if (tab && tab.url) sendToGrab(tab.url);
});

chrome.commands.onCommand.addListener((command) => {
  if (command !== "send-tab-to-grab") return;
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0] && tabs[0].url) sendToGrab(tabs[0].url);
  });
});
