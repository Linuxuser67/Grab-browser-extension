// Options page: reflects chrome.storage.sync and saves on change.
// DEFAULTS, loadSettings and saveSettings come from settings.js.

const interceptEl = document.getElementById("interceptDownloads");
const skipEl = document.getElementById("skipTypes");
const menuEl = document.getElementById("showContextMenu");
const detectEl = document.getElementById("detectVideos");
const minSizeEl = document.getElementById("minSizeMB");
const savedEl = document.getElementById("saved");

let saveTimer = null;

async function load() {
  const settings = await loadSettings();
  interceptEl.checked = settings.interceptDownloads;
  skipEl.value = settings.skipTypes;
  menuEl.checked = settings.showContextMenu;
  detectEl.checked = settings.detectVideos !== false;
  minSizeEl.value = settings.minSizeMB;
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

load();
