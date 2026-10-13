// Options page: reflects chrome.storage.sync and saves on change.
// DEFAULTS, loadSettings and saveSettings come from settings.js.

const interceptEl = document.getElementById("interceptDownloads");
const skipEl = document.getElementById("skipTypes");
const menuEl = document.getElementById("showContextMenu");
const detectEl = document.getElementById("detectVideos");
const minSizeEl = document.getElementById("minSizeMB");
const savedEl = document.getElementById("saved");
const pairingEl = document.getElementById("pairingCode");
const pairingBtn = document.getElementById("savePairing");
const pairingStatusEl = document.getElementById("pairingStatus");

let saveTimer = null;

async function load() {
  const settings = await loadSettings();
  interceptEl.checked = settings.interceptDownloads;
  skipEl.value = settings.skipTypes;
  menuEl.checked = settings.showContextMenu;
  detectEl.checked = settings.detectVideos !== false;
  minSizeEl.value = settings.minSizeMB;
  pairingEl.value = await loadPairingCode();
  showPairingStatus(pairingEl.value ? "Paired" : "Not paired: links only");
}

function showPairingStatus(text) {
  pairingStatusEl.textContent = text;
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

async function save() {
  await saveSettings({
    interceptDownloads: interceptEl.checked,
    skipTypes: skipEl.value,
    showContextMenu: menuEl.checked,
    detectVideos: detectEl.checked,
    minSizeMB: minSizeEl.value,
  });
  savedEl.style.opacity = "1";
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    savedEl.style.opacity = "0";
  }, 1200);
}

interceptEl.addEventListener("change", save);
skipEl.addEventListener("change", save);
menuEl.addEventListener("change", save);
detectEl.addEventListener("change", save);
minSizeEl.addEventListener("change", save);
pairingBtn.addEventListener("click", savePairing);

load();
