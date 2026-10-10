// Popup: mirrors options.js — reflects chrome.storage.sync, saves on change.

const DEFAULTS = {
  interceptDownloads: false,
  skipTypes: "",
  showContextMenu: true,
  minSizeMB: 0,
};

const interceptEl = document.getElementById("interceptDownloads");
const skipEl = document.getElementById("skipTypes");
const menuEl = document.getElementById("showContextMenu");
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
  const settings = await chrome.storage.sync.get(DEFAULTS);
  interceptEl.checked = settings.interceptDownloads;
  skipEl.value = settings.skipTypes;
  menuEl.checked = settings.showContextMenu;
  minSizeEl.value = settings.minSizeMB;
}

async function save() {
  await chrome.storage.sync.set({
    interceptDownloads: interceptEl.checked,
    // Normalize the skip list once, on the way in.
    skipTypes: skipEl.value
      .split(",")
      .map((s) => s.trim().toLowerCase().replace(/^\./, ""))
      .filter((s) => s !== "")
      .join(", "),
    showContextMenu: menuEl.checked,
    // Whole megabytes, never negative.
    minSizeMB: Math.max(0, Math.floor(Number(minSizeEl.value) || 0)),
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
minSizeEl.addEventListener("change", save);

document.getElementById("openOptions").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

load();
checkGrabStatus();
