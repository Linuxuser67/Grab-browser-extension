// Shared settings for the popup and options pages.
// Single source of truth for DEFAULTS and the save normalization.
// (background.js keeps its own copy for the worker; keep them in sync.)

// Keep in sync with DEFAULTS in background.js.
const DEFAULTS = {
  interceptDownloads: false,
  // Comma-separated file extensions the browser keeps handling itself.
  skipTypes: "",
  showContextMenu: true,
  // Detect videos playing in tabs (content script + webRequest sniffing)
  // and offer them in the right-click menu.
  detectVideos: true,
  // Minimum download size (MiB) that gets intercepted. 0 intercepts everything.
  minSizeMB: 0,
};

/// Load settings from sync storage, filling in defaults.
async function loadSettings() {
  return chrome.storage.sync.get(DEFAULTS);
}

/// Normalize raw form values into storable settings.
function normalizeSettings(raw) {
  return {
    interceptDownloads: !!raw.interceptDownloads,
    // Normalize the skip list once, on the way in.
    skipTypes: String(raw.skipTypes || "")
      .split(",")
      .map((s) => s.trim().toLowerCase().replace(/^\./, ""))
      .filter((s) => s !== "")
      .join(", "),
    showContextMenu: raw.showContextMenu !== false,
    detectVideos: raw.detectVideos !== false,
    // Whole megabytes, never negative.
    minSizeMB: Math.max(0, Math.floor(Number(raw.minSizeMB) || 0)),
  };
}

/// Save normalized settings to sync storage.
async function saveSettings(raw) {
  await chrome.storage.sync.set(normalizeSettings(raw));
}

// --- Pairing with Grab -------------------------------------------------------
// The pairing code is a secret for this machine's Grab, so it is kept in local
// storage (never sync) and is not part of normalizeSettings().

const PAIRING_CODE_RE = /^[0-9a-f]{64}$/;

/// Normalize what the user pasted: whitespace and case are forgiven.
function normalizePairingCode(raw) {
  return String(raw || "").replace(/\s+/g, "").toLowerCase();
}

async function loadPairingCode() {
  const { pairingCode } = await chrome.storage.local.get({ pairingCode: "" });
  return pairingCode;
}

/// Store a code ("" clears it). Returns false for a malformed code.
async function savePairingCode(raw) {
  const code = normalizePairingCode(raw);
  if (code !== "" && !PAIRING_CODE_RE.test(code)) return false;
  await chrome.storage.local.set({ pairingCode: code });
  return true;
}
