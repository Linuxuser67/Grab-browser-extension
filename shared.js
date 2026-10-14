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

/// 64 hex chars (a SHA-256, shown by Grab when pairing).
const SHARED_PAIRING_CODE_RE = /^[0-9a-f]{64}$/;

// Export for the test hook (Node) without breaking browser globals.
if (typeof module !== "undefined" && module.exports) {
  module.exports = { SHARED_DEFAULTS, SHARED_PAIRING_CODE_RE };
}
