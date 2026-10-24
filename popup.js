// Popup: reflects chrome.storage.sync, saves on change.
// bindSettingsForm comes from settings.js.

bindSettingsForm(document);

const STATUS_REFRESH_INTERVAL_MS = 5_000;
const STATUS_MESSAGE_TIMEOUT_MS = 4_000;
let statusCheckInFlight = false;

// The worker probes the local endpoint and verifies the pairing proof when
// a code is saved.
const STATUS_TEXT = {
  verified: ["Connected", "status ok"],
  "running-unpaired": ["Running · Not paired", "status warning"],
  unverified: ["Running · Unverified", "status warning"],
  down: ["Not running", "status down"],
  unknown: ["Status unavailable", "status neutral"],
};

async function checkGrabStatus() {
  const el = document.getElementById("grabStatus");
  if (!el || statusCheckInFlight) return;
  statusCheckInFlight = true;

  let state = "unknown";
  let timeoutId;
  try {
    const timeout = new Promise((resolve) => {
      timeoutId = setTimeout(() => resolve(null), STATUS_MESSAGE_TIMEOUT_MS);
    });
    const reply = await Promise.race([
      chrome.runtime.sendMessage({ type: "grab-status" }),
      timeout,
    ]);
    if (reply && STATUS_TEXT[reply.state]) state = reply.state;
  } catch {
    // A missing worker response is not evidence that Grab itself is down.
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    statusCheckInFlight = false;
  }

  const [text, className] = STATUS_TEXT[state];
  el.textContent = text;
  el.className = className;
}

document.getElementById("openOptions").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

checkGrabStatus();
setInterval(checkGrabStatus, STATUS_REFRESH_INTERVAL_MS);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) checkGrabStatus();
});
