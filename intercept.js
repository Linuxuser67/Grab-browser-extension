// Grab browser extension: automatic download interception.
// Loaded by background.js (Chrome importScripts) or listed before it
// in manifest.firefox.json; all files share one global scope.

/// How long to wait for a server to report the size before treating an
/// unknown size as big enough to intercept (streams rarely send one, and they
/// belong in Grab).
const SIZE_WAIT_MS = 10_000;

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

/// Remove the browser's own copy of a download Grab has taken over.
async function removeBrowserCopy(id) {
  try {
    await chrome.downloads.removeFile(id);
  } catch {
    // Already gone.
  }
  try {
    await chrome.downloads.erase({ id });
  } catch {
    // Already gone.
  }
}

async function interceptDownload(item) {
  // Cancelling a browser download is only safe when a verified Grab took it.
  // Unpaired, any process listening on the port could answer 200 and make the
  // file disappear, so automatic interception requires pairing.
  if (!(await getPairingCode())) return;
  // Prefer the post-redirect URL only when Grab can accept its length.
  // Otherwise preserve the original URL so Grab can follow the redirect.
  const finalUrl = toGrabUrl(item.finalUrl) ? item.finalUrl : null;
  const url = finalUrl &&
    new TextEncoder().encode(finalUrl).length <= MAX_GRAB_URL_BYTES
      ? finalUrl
      : item.url;
  // Non-http(s) URLs (blob:, data:) and URLs with credentials can't be
  // handed over.
  if (!toGrabUrl(url)) return;
  // Hand off over Grab's local HTTP endpoint. If Grab isn't running or
  // refuses the request, the download is left to the browser.
  // Only cancel the browser download on HTTP 200 (queued). HTTP 202 means
  // Grab opened the New Download card (nothing queued yet) — the user may
  // not complete it, so the browser copy must stay.
  const ctx = {
    incognito: item.incognito === true,
    cookieStoreId: item.cookieStoreId,
    requirePairing: true,
  };
  const status = await postToGrabWithRetry(url, ctx);
  if (status !== 200) return;
  if (ctx.cookieWarning) await showCookieWarning(ctx);

  try {
    await claimDownload(item.id);
  } catch {
    // Continue: the cancel below still stops the browser copy. Only the
    // onChanged cleanup for a tiny finished download may be missed.
  }
  // A tiny download can finish while the handoff is in flight, before the
  // claim exists, so onChanged skipped it: clean up here instead.
  const [current] = await chrome.downloads.search({ id: item.id });
  if (current && current.state === "complete") {
    await removeBrowserCopy(item.id);
    await unclaimDownload(item.id);
    return;
  }
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

async function parkForSize(item, deadline = Date.now() + SIZE_WAIT_MS) {
  // The alarm is only the worker-wakeup: the stored deadline is the real
  // timer. Packaged Chrome fires alarms no earlier than ~30s out, so the
  // effective wait in packaged builds is >= 30s even though the deadline is
  // sooner; the deadline still decides, so unpacked builds keep the short
  // wait for development.
  await chrome.storage.session.set({ [pendingKey(item.id)]: deadline });
  await chrome.alarms.create(alarmName(item.id), { when: deadline });
}

async function dropPending(id) {
  await chrome.alarms.clear(alarmName(id)).catch(() => {});
  await chrome.storage.session.remove(pendingKey(id));
}

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

    const settings = await getSettings();
    const items = await chrome.downloads.search({ id });
    const item = items[0];
    if (!item) {
      await dropPending(id);
      return;
    }
    // The download finished or failed while parked (or in the async gap
    // between deciding to park and persisting the pending state): too late
    // to hand over — leave the browser copy alone.
    if (item.state === "complete" || item.state === "interrupted") {
      await dropPending(id);
      return;
    }
    // The user may have changed their mind while we waited.
    if (
      !settings.interceptDownloads ||
      isSkipped(item.url, settings.skipTypes) ||
      isSkipped(item.finalUrl, settings.skipTypes) ||
      !toGrabUrl(item.url)
    ) {
      await dropPending(id);
      return;
    }
    if (item.fileSize >= 0) {
      // Size is known: small enough stays in the browser, big enough is
      // intercepted now.
      if (item.fileSize < minSizeBytes(settings)) {
        await dropPending(id);
        return;
      }
    } else if (Date.now() < deadline) {
      // Size still unknown but the deadline hasn't passed: this call came
      // too early (the alarm is only the wakeup). Re-park and wait for the
      // real deadline instead of intercepting early. Don't drop: parkForSize
      // refreshes the pending entry.
      await parkForSize(item, deadline);
      return;
    }
    // Unknown size past the deadline: streams rarely report one, and they
    // belong in Grab (see SIZE_WAIT_MS).
    // Drop the pending entry AFTER the handoff starts, so a worker death
    // in between doesn't lose the download silently.
    await interceptDownload(item);
    await dropPending(id);
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
  // Ignore downloads from a previous browser session (Varia pattern):
  // onCreated can re-fire on startup for old downloads. Missing startTime
  // or a missing browserStartTime (no startup seen) is treated as new.
  if (item.startTime) {
    const { browserStartTime } = await chrome.storage.session.get(
      "browserStartTime",
    );
    if (
      browserStartTime !== undefined &&
      new Date(item.startTime).getTime() < browserStartTime
    ) {
      return;
    }
  }
  // Extension installs/updates must never be intercepted.
  if (item.mime === "application/x-chrome-extension") return;
  if (isSkipped(item.url, settings.skipTypes) || isSkipped(item.finalUrl, settings.skipTypes)) return;
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
    await removeBrowserCopy(delta.id);
  }
  if (state === "complete" || state === "interrupted") {
    await unclaimDownload(delta.id);
  }
});

