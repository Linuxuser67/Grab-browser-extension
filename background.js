// Grab browser extension (MV3) — service worker.
//
// Two jobs:
//   1. Automatic interception: browser downloads are cancelled and handed to
//      the Grab desktop app through the grab: URI scheme (registered by the
//      app's .desktop entry as x-scheme-handler/grab).
//   2. Explicit sends: context menu and keyboard shortcut send the current
//      tab or a link/media URL to Grab. The toolbar button opens the options
//      page instead.
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
/// file:, …) cannot be handed off and returns null. The original scheme is
/// carried as the first path segment (grab://https/host/...) so Grab can
/// restore http vs https; needs Grab 4.7.1+.
function toGrabUrl(url) {
  if (typeof url !== "string") return null;
  const m = /^(https?):\/\/(.+)$/i.exec(url);
  if (!m) return null;
  return `${GRAB_SCHEME}${m[1].toLowerCase()}/${m[2]}`;
}

/// Explicit user action (keyboard shortcut, context menu):
/// navigate the active tab to the grab: URL. The user acted on this tab, and
/// external-protocol navigations are handed to the OS without replacing the
/// page (the mailto: mechanism), so the tab is left alone. Never use this for
/// automatic interception: the download can come from any tab, or none.
function sendToGrab(url) {
  const grabUrl = toGrabUrl(url);
  if (grabUrl) chrome.tabs.update({ url: grabUrl });
}

/// Automatic interception must never repurpose the user's selected tab: the
/// download can originate from any tab, or from no tab at all. Hand off
/// through a dedicated background tab, removed once the OS has taken the URL.
async function handOffInterception(url) {
  const grabUrl = toGrabUrl(url);
  if (!grabUrl) return;
  try {
    const tab = await chrome.tabs.create({ url: grabUrl, active: false });
    // The custom-scheme navigation is handed to the OS handler; the tab
    // itself only ever shows a blank page, so drop it shortly after. The
    // unref keeps the Node test suite from waiting out the delay; in Chrome
    // setTimeout returns a number and the guard is a no-op.
    const timer = setTimeout(
      () => chrome.tabs.remove(tab.id).catch(() => {}),
      2000,
    );
    if (timer && typeof timer.unref === "function") timer.unref();
  } catch {
    // No window to open the handoff tab in; without a tab to navigate there
    // is no other IPC channel, so the cancelled download can't be handed off.
  }
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
  // Automatic path: never touch the user's selected tab (see
  // handOffInterception).
  await handOffInterception(item.url);
}

// Downloads parked while waiting for their size to become known, when the
// user set a minimum intercept size. MV3 service workers are ephemeral: an
// in-memory Map + setTimeout can die mid-wait and lose the interception, so
// the pending set lives in session storage (survives worker restarts, clears
// with the browser) and the deadline is a chrome.alarms one-shot (alarms
// wake the worker). After a restart, the next onChanged or alarm re-reads
// the pending set and decides.
const pendingKey = (id) => `pendingSize:${id}`;
const alarmName = (id) => `size-wait:${id}`;

// Best-effort guard against deciding the same download twice when an alarm
// and a size event interleave within one worker lifetime. Cross-restart
// dedup comes from dropPending's session-storage removal.
const deciding = new Set();

async function isPending(id) {
  const key = pendingKey(id);
  const result = await chrome.storage.session.get(key);
  return result[key] !== undefined;
}

async function parkForSize(item) {
  // The alarm is only the worker-wakeup: the stored deadline is the real
  // timer. Packaged Chrome fires alarms no earlier than ~30s out, so the
  // effective wait in packaged builds is >= 30s even though the deadline is
  // sooner; the deadline still decides, so unpacked builds keep the short
  // wait for development.
  const deadline = Date.now() + SIZE_WAIT_MS;
  await chrome.storage.session.set({ [pendingKey(item.id)]: deadline });
  await chrome.alarms.create(alarmName(item.id), { when: deadline });
}

async function dropPending(id) {
  await chrome.alarms.clear(alarmName(id)).catch(() => {});
  await chrome.storage.session.remove(pendingKey(id));
}

// How long to wait for a server to report the size before treating an
// unknown size as big enough to intercept (streams rarely send one, and they
// belong in Grab).
const SIZE_WAIT_MS = 10_000;

const minSizeBytes = (settings) =>
  Math.max(0, settings.minSizeMB | 0) * 1024 * 1024;

async function decidePending(id) {
  // Acquire the guard before the first await: two interleaved calls (an alarm
  // and a size event arriving together) would otherwise both pass the check
  // above before either reaches the add below, and both would intercept.
  if (deciding.has(id)) return;
  deciding.add(id);
  try {
    const stored = await chrome.storage.session.get(pendingKey(id));
    const deadline = stored[pendingKey(id)];
    if (deadline === undefined) return;
    await dropPending(id);

    const settings = await getSettings();
    const items = await chrome.downloads.search({ id });
    const item = items[0];
    if (!item) return;
    // The download finished or failed while parked (or in the async gap
    // between deciding to park and persisting the pending state): too late
    // to hand over — leave the browser copy alone.
    if (item.state === "complete" || item.state === "interrupted") return;
    // The user may have changed their mind while we waited.
    if (!settings.interceptDownloads) return;
    if (isSkipped(item.url, settings.skipTypes)) return;
    if (!toGrabUrl(item.url)) return;
    if (item.fileSize >= 0) {
      // Size is known: small enough stays in the browser, big enough is
      // intercepted now.
      if (item.fileSize < minSizeBytes(settings)) return;
    } else if (Date.now() < deadline) {
      // Size still unknown but the deadline hasn't passed: this call came
      // too early (the alarm is only the wakeup). Re-park and wait for the
      // real deadline instead of intercepting early.
      await parkForSize(item);
      return;
    }
    // Unknown size past the deadline: streams rarely report one, and they
    // belong in Grab (see SIZE_WAIT_MS).
    await interceptDownload(item);
  } finally {
    deciding.delete(id);
  }
}

// Size-wait deadline: decide the parked download even if the worker was
// restarted while it was parked (the pending set survived in session storage).
chrome.alarms.onAlarm.addListener((alarm) => {
  const m = /^size-wait:(\d+)$/.exec(alarm.name);
  if (m) decidePending(Number(m[1]));
});

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
      await parkForSize(item);
      // The download may have finished while the pending state was being
      // written (async gap between deciding to park and persisting it):
      // re-check, and drop the parked entry if it's already too late to
      // hand over. Anything finishing after this is caught by the onChanged
      // guard or by decidePending's own state check.
      const fresh = await chrome.downloads.search({ id: item.id });
      const current = fresh[0];
      if (
        !current ||
        current.state === "complete" ||
        current.state === "interrupted"
      ) {
        await dropPending(item.id);
      }
      return;
    }
  }

  await interceptDownload(item);
});

chrome.downloads.onChanged.addListener(async (delta) => {
  if (await isPending(delta.id)) {
    const state = delta.state && delta.state.current;
    if (state === "complete" || state === "interrupted") {
      // Finished or failed before the size arrived: too late to hand over.
      await dropPending(delta.id);
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

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "sync" || !changes.showContextMenu) return;
  // removeAll first: rapid toggles would otherwise stack a duplicate-id
  // create on top of an in-flight one.
  await chrome.contextMenus.removeAll().catch(() => {});
  if (changes.showContextMenu.newValue) {
    createContextMenu();
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

chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

chrome.commands.onCommand.addListener((command) => {
  if (command !== "send-tab-to-grab") return;
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0] && tabs[0].url) sendToGrab(tabs[0].url);
  });
});

// Test hook for node:test (MV3 service workers have no `module`).
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    toGrabUrl,
    isSkipped,
    minSizeBytes,
    decidePending,
    parkForSize,
    dropPending,
    isPending,
    DEFAULTS,
    SIZE_WAIT_MS,
    GRAB_SCHEME,
  };
}
