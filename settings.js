// Shared settings for the popup and options pages.
// Single source of truth for the save normalization.

// Shared defaults live in shared.js (loaded via <script> before this file).
/// Load settings from sync storage, filling in defaults.
async function loadSettings() {
  return chrome.storage.sync.get(SHARED_DEFAULTS);
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

/// Ask for what video detection needs: page access (so the detector can run)
/// and webRequest (so streams behind blob: players can be sniffed). Must run
/// from a click/change handler with no await ahead of it, to keep the user
/// gesture. Resolves true without a prompt when both are already granted.
async function requestVideoAccess() {
  try {
    return !!(await chrome.permissions.request({
      permissions: ["webRequest"],
      origins: SHARED_PAGE_ORIGINS,
    }));
  } catch {
    return false;
  }
}

/// Drop optional permissions nothing uses any more. Video detection owns
/// webRequest, pairing owns cookies, and page access stays while either needs
/// it. Called after turning video detection off or unpairing.
async function releaseUnusedPermissions() {
  let settings;
  let code;
  try {
    [settings, code] = await Promise.all([loadSettings(), loadPairingCode()]);
  } catch {
    return; // Unknown state: keep what is granted rather than break a feature.
  }
  const videoOn = settings.detectVideos !== false;
  const paired = code !== "";
  const permissions = [];
  if (!videoOn) permissions.push("webRequest");
  if (!paired) permissions.push("cookies");
  const origins = !videoOn && !paired ? [...SHARED_PAGE_ORIGINS] : [];
  if (permissions.length === 0 && origins.length === 0) return;
  const toRemove = {};
  if (permissions.length > 0) toRemove.permissions = permissions;
  if (origins.length > 0) toRemove.origins = origins;
  try {
    await chrome.permissions.remove(toRemove);
  } catch {
    // Already removed, or the Permissions API is unavailable.
  }
}

/// Wire the five shared settings controls in `doc` (popup or options page):
/// load from sync storage, save on change, flash the "saved" indicator.
/// Returns the element handles for page-specific use.
///
/// Video detection is opt-in: its checkbox shows the stored setting only while
/// page access is also granted, and turning it on requests that access.
/// `options.deferPermissionPrompt` (popup): a permission prompt closes a
/// browser-action popup, so the popup hands the request to the Options page
/// instead of asking itself.
function bindSettingsForm(doc, options = {}) {
  const els = {
    intercept: doc.getElementById("interceptDownloads"),
    skip: doc.getElementById("skipTypes"),
    menu: doc.getElementById("showContextMenu"),
    detect: doc.getElementById("detectVideos"),
    minSize: doc.getElementById("minSizeMB"),
    saved: doc.getElementById("saved"),
    detectNote: doc.getElementById("detectVideosNote"),
  };
  let saveTimer = null;

  function setDetectNote(text) {
    if (els.detectNote) els.detectNote.textContent = text;
  }

  async function load() {
    const settings = await loadSettings();
    els.intercept.checked = settings.interceptDownloads;
    els.skip.value = settings.skipTypes;
    els.menu.checked = settings.showContextMenu;
    // "On" with no page access detects nothing, so show it as off.
    const access = await hasVideoAccess();
    els.detect.checked = settings.detectVideos !== false && access;
    if (settings.detectVideos !== false && !access) {
      setDetectNote("Needs access to web pages. Turn on to grant it.");
    }
    els.minSize.value = settings.minSizeMB;
  }

  async function save() {
    try {
      await saveSettings({
        interceptDownloads: els.intercept.checked,
        skipTypes: els.skip.value,
        showContextMenu: els.menu.checked,
        detectVideos: els.detect.checked,
        minSizeMB: els.minSize.value,
      });
    } catch {
      clearTimeout(saveTimer);
      els.saved.classList.remove("show");
      els.saved.classList.add("error");
      els.saved.textContent = "Could not save settings";
      els.saved.classList.add("show");
      els.saved.style.opacity = "1";
      return false;
    }
    // Populate the live region only after a save so it does not announce
    // "Saved" when the popup or Options page first opens.
    els.saved.classList.remove("error");
    els.saved.textContent = "Saved";
    // Flash the "saved" indicator. popup.html styles #saved.show,
    // options.html styles #saved's inline opacity; set both, the unused
    // one is harmless.
    els.saved.classList.add("show");
    els.saved.style.opacity = "1";
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      els.saved.classList.remove("show");
      els.saved.style.opacity = "0";
    }, 1200);
    return true;
  }

  async function onDetectChange() {
    if (els.detect.checked) {
      setDetectNote("");
      if (options.deferPermissionPrompt) {
        // Popup: never prompt here (the prompt would close the popup).
        if (!(await hasVideoAccess())) {
          els.detect.checked = false;
          setDetectNote("Opening Options to grant access to web pages.");
          chrome.runtime.openOptionsPage();
          return;
        }
      } else if (!(await requestVideoAccess())) {
        // Nothing awaited before the request: the change event's gesture holds.
        els.detect.checked = false;
        setDetectNote("Access to web pages was not granted, so video detection stays off.");
      }
      await save();
      return;
    }
    if (!(await save())) return;
    await releaseUnusedPermissions();
  }

  for (const key of ["intercept", "skip", "menu", "minSize"]) {
    els[key].addEventListener("change", save);
  }
  els.detect.addEventListener("change", onDetectChange);
  load();
  return els;
}

// --- Pairing with Grab -------------------------------------------------------
// The pairing code is a secret for this machine's Grab, so it is kept in local
// storage (never sync) and is not part of normalizeSettings().

async function loadPairingCode() {
  const { pairingCode } = await chrome.storage.local.get({ pairingCode: "" });
  return pairingCode;
}

/// Store a code ("" clears it). Returns false for a malformed code.
async function savePairingCode(raw) {
  const code = normalizePairingCode(raw);
  if (code !== "" && !SHARED_PAIRING_CODE_RE.test(code)) return false;
  await chrome.storage.local.set({ pairingCode: code });
  return true;
}
