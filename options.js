// Options page: reflects chrome.storage.sync and saves on change.
// bindSettingsForm, loadPairingCode, savePairingCode come from settings.js.

bindSettingsForm(document);

const pairingEl = document.getElementById("pairingCode");
const pairingBtn = document.getElementById("savePairing");
const pairingStatusEl = document.getElementById("pairingStatus");

function showPairingStatus(text) {
  pairingStatusEl.textContent = text;
}

async function loadPairing() {
  pairingEl.value = await loadPairingCode();
  showPairingStatus(pairingEl.value ? "Paired" : "Not paired: links only");
}

/// Pair (or unpair, with an empty field). The click is the user gesture the
/// browser requires to grant the optional cookies permission, which is asked
/// for only when a code is being stored.
async function savePairing() {
  const code = normalizePairingCode(pairingEl.value);
  if (code === "") {
    await savePairingCode("");
    showPairingStatus("Not paired: links only");
    return;
  }
  if (!(await savePairingCode(code))) {
    showPairingStatus("That isn't a pairing code (64 letters and digits).");
    return;
  }
  pairingEl.value = code;
  let granted = false;
  try {
    granted = await chrome.permissions.request({ permissions: ["cookies"] });
  } catch {
    // Permission API unavailable: pair anyway; handoffs stay URL-only.
  }
  showPairingStatus(
    granted
      ? "Paired: cookies are shared with Grab"
      : "Paired, but cookie access was not granted: links only",
  );
}

pairingBtn.addEventListener("click", savePairing);

loadPairing();
