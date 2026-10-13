// Shared constants for the Grab extension service worker.
// Pure values: no chrome API use, no side effects.

export const GRAB_SCHEME = "grab://";

export const DEFAULTS = {
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

/// Grab's local HTTP server. The extension POSTs URLs here instead of using
/// native messaging — no host manifest, no extension IDs, works from Flatpak.
export const GRAB_BASE_URL = "http://127.0.0.1:9412";
export const GRAB_HTTP_URL = `${GRAB_BASE_URL}/add`;

/// Delays before retrying when Grab answers 429 (its handoff queue is full).
export const HANDOFF_RETRY_DELAYS_MS = [300, 900];

/// Grab holds a `?confirm=1` request until the user answers its dialog (it
/// gives up after 120 s); wait a little longer than that.
export const CONFIRM_TIMEOUT_MS = 130_000;
/// A pairing handshake is a loopback round trip.
export const HELLO_TIMEOUT_MS = 3_000;

export const SERVER_CONTEXT = "grab-server\u0000";
export const CLIENT_CONTEXT = "grab-client\u0000";
export const PAIRING_CODE_RE = /^[0-9a-f]{64}$/;
export const STATUS_UNVERIFIED = -1;

export const VIDEO_PARENT_ID = "grabVideos";
export const VIDEO_ITEM_PREFIX = "grabVideo:";
export const MAX_VIDEO_ITEMS = 8;

export const YTDLP_EXCLUSIVE_HOSTS = [
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

export const NAME_MAX = 40;
export const PLAYLIST_TEXT_CAP = 256 * 1024;
export const MANIFEST_RE = /\.(m3u8|m3u)([?#]|$)/i;
export const DASH_TEXT_CAP = 2 * 1024 * 1024;
export const PICK_IN_GRAB = "pick in Grab";

export const SIZE_WAIT_MS = 10_000;
