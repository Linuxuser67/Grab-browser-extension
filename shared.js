/// Shared between the background worker and the settings pages.
/// Loaded via importScripts in background.js, and via <script> in
/// popup.html / options.html before their own scripts.

const SHARED_DEFAULTS = {
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

/// Page access is an optional permission: it is requested when the user turns
/// on video detection or pairs for cookie forwarding, never at install time.
/// Together with the optional "webRequest" (video detection) and "cookies"
/// (pairing) permissions it is the only broad access the extension asks for.
const SHARED_PAGE_ORIGINS = ["http://*/*", "https://*/*"];

/// Scope an action API call to a real tab; null means use the global default.
function tabScope(tabId) {
  return Number.isInteger(tabId) && tabId >= 0 ? { tabId } : null;
}

/// 64 hex chars (a SHA-256, shown by Grab when pairing).
const SHARED_PAIRING_CODE_RE = /^[0-9a-f]{64}$/;

/// Normalize a pasted pairing code; validation is kept separate.
function normalizePairingCode(raw) {
  return String(raw || "").replace(/\s+/g, "").toLowerCase();
}

/// Whether the extension may forward site cookies to Grab. The toggle lives
/// in local storage beside the pairing code and is independent of it, so
/// pairing and unpairing never changes it. Forwarding is on unless the stored
/// value says otherwise.
async function loadForwardCookies() {
  try {
    const stored = await chrome.storage.local.get({ forwardCookies: true });
    return stored.forwardCookies !== false;
  } catch {
    return false; // Unknown state: do not forward cookies.
  }
}

/// Store the cookie-forwarding toggle.
async function saveForwardCookies(enabled) {
  await chrome.storage.local.set({ forwardCookies: !!enabled });
}

// Export for the test hook (Node) without breaking browser globals.
if (typeof module !== "undefined" && module.exports) {
  module.exports = { SHARED_DEFAULTS, SHARED_PAGE_ORIGINS, SHARED_PAIRING_CODE_RE, normalizePairingCode, loadForwardCookies, saveForwardCookies };
}
