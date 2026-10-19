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

/// Domains whose media URLs are poor candidates for direct downloading because
/// their players require site authentication, short-lived tokens, or DRM.
const SHARED_EXCLUDED_HOSTS = [
  "youtube.com",
  "youtu.be",
  "vimeo.com",
  "dailymotion.com",
  "dai.ly",
  "tiktok.com",
  "instagram.com",
  "facebook.com",
  "fb.com",
  "fb.watch",
  "twitter.com",
  "x.com",
  "twitch.tv",
];

/// True for a listed host and its subdomains, never for lookalikes.
function sharedHostExcluded(host) {
  const h = String(host || "").toLowerCase();
  return SHARED_EXCLUDED_HOSTS.some((domain) =>
    h === domain || h.endsWith("." + domain)
  );
}

/// Normalize a pasted pairing code; validation is kept separate.
function normalizePairingCode(raw) {
  return String(raw || "").replace(/\s+/g, "").toLowerCase();
}

// Export for the test hook (Node) without breaking browser globals.
if (typeof module !== "undefined" && module.exports) {
  module.exports = { SHARED_DEFAULTS, SHARED_PAIRING_CODE_RE, SHARED_EXCLUDED_HOSTS, sharedHostExcluded, normalizePairingCode };
}
