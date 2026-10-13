// Popup: reflects chrome.storage.sync, saves on change.
// DEFAULTS, loadSettings and saveSettings come from settings.js.

const interceptEl = document.getElementById("interceptDownloads");
const skipEl = document.getElementById("skipTypes");
const menuEl = document.getElementById("showContextMenu");
const detectEl = document.getElementById("detectVideos");
const minSizeEl = document.getElementById("minSizeMB");
const savedEl = document.getElementById("saved");

let saveTimer = null;

async function checkGrabStatus() {
  const el = document.getElementById("grabStatus");
  // GET the root: Grab's router 404s (no route there), but any HTTP response
  // means it's listening. We avoid POSTing to /add because even an empty URL
  // would trigger Grab's "Invalid URL" toast.
  try {
    await fetch("http://127.0.0.1:9412/", { method: "GET" });
    el.textContent = "Grab is running";
    el.className = "status ok";
  } catch {
    el.textContent = "Grab isn't running — downloads will stay in the browser";
    el.className = "status down";
  }
}

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
  savedEl.classList.add("show");
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    savedEl.classList.remove("show");
  }, 1200);
}

interceptEl.addEventListener("change", save);
skipEl.addEventListener("change", save);
menuEl.addEventListener("change", save);
detectEl.addEventListener("change", save);
minSizeEl.addEventListener("change", save);

document.getElementById("openOptions").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

load();
checkGrabStatus();
