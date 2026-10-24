// Popup: reflects chrome.storage.sync, saves on change.
// bindSettingsForm comes from settings.js.

bindSettingsForm(document);

// The worker does the check: it knows the pairing code and the port.
const STATUS_TEXT = {
  verified: ["Grab is running and paired", "status ok"],
  unverified: ["Something else answers on Grab's port. Pair again in Options.", "status down"],
  unpaired: ["Not paired: automatic interception is off until you pair in Options", "status down"],
  down: ["Grab isn't running — downloads will stay in the browser", "status down"],
};

async function checkGrabStatus() {
  const el = document.getElementById("grabStatus");
  let state = "down";
  try {
    const reply = await chrome.runtime.sendMessage({ type: "grab-status" });
    if (reply && STATUS_TEXT[reply.state]) state = reply.state;
  } catch {
    // No worker answer: treat as not running.
  }
  const [text, className] = STATUS_TEXT[state];
  el.textContent = text;
  el.className = className;
}

document.getElementById("openOptions").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

checkGrabStatus();
