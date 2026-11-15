// Options page: reflects chrome.storage.sync and saves on change.
// bindSettingsForm, loadPairingCode, savePairingCode, releaseUnusedPermissions
// come from settings.js; SHARED_PAGE_ORIGINS from shared.js.

bindSettingsForm(document);

const pairingEl = document.getElementById("pairingCode");
const pairingBtn = document.getElementById("savePairing");
const pairingStatusEl = document.getElementById("pairingStatus");
const forwardCookiesEl = document.getElementById("forwardCookies");
const forwardCookiesStatusEl = document.getElementById("forwardCookiesStatus");

let pairingStatusRevision = 0;
// Bumped whenever the user changes the toggle, so a slow initial read cannot
// overwrite their choice.
let forwardCookiesRevision = 0;

function showPairingStatus(text) {
  pairingStatusEl.textContent = text;
}

function invalidatePairingStatus() {
  pairingStatusRevision += 1;
  return pairingStatusRevision;
}

function isCurrentPairingOperation(revision, code) {
  return (
    revision === pairingStatusRevision &&
    normalizePairingCode(pairingEl.value) === code
  );
}

/// Cookie forwarding needs the optional "cookies" permission and access to web
/// pages (cookies.getAll is limited to sites the extension can access).
async function hasCookiePermission() {
  try {
    return await chrome.permissions.contains({
      permissions: ["cookies"],
      origins: SHARED_PAGE_ORIGINS,
    });
  } catch {
    // The permission state is unknown, not necessarily denied.
    return null;
  }
}

/// The background worker runs the same nonce/HMAC handshake used before a
/// paired handoff. A saved or well-formed code alone is never "Verified".
async function verifySavedPairing(code, cookieAccessGranted, revision) {
  let reply;
  try {
    reply = await chrome.runtime.sendMessage({ type: "grab-status" });
  } catch {
    // The worker may be restarting or unavailable.
  }

  if (!isCurrentPairingOperation(revision, code)) return;

  // Protect against the code being changed from another Options page while
  // the handshake was in flight.
  let storedCode;
  try {
    storedCode = normalizePairingCode(await loadPairingCode());
  } catch {
    if (isCurrentPairingOperation(revision, code)) {
      showPairingStatus("Saved, but verification status is unavailable.");
    }
    return;
  }

  if (!isCurrentPairingOperation(revision, code)) return;
  if (storedCode !== code) {
    showPairingStatus("Pairing code changed elsewhere; reload before verifying.");
    return;
  }

  if (reply && reply.state === "verified") {
    // Read the toggle after the handshake: the user may have changed it while
    // verification was pending, and the status must reflect the stored value.
    const forwardCookies = await loadForwardCookies();
    if (!isCurrentPairingOperation(revision, code)) return;
    const cookieStatus = forwardCookies
      ? cookieAccessGranted === true
        ? "Cookie access is granted."
        : cookieAccessGranted === false
          ? "Cookie access is not granted, so handoffs are URL-only."
          : "Cookie permission status is unavailable."
      : "Cookie forwarding is off, so handoffs stay URL-only.";
    showPairingStatus(`Verified — Grab recognizes this code. ${cookieStatus}`);
  } else if (reply && reply.state === "unverified") {
    showPairingStatus(
      "Saved, but not verified — Grab could not prove this pairing code.",
    );
  } else if (reply && reply.state === "down") {
    showPairingStatus(
      "Saved, but Grab is not reachable; verification is pending.",
    );
  } else {
    showPairingStatus("Saved, but verification status is unavailable.");
  }
}

async function loadPairing() {
  // Capture the revision before storage access. If the user starts editing
  // before the asynchronous read completes, don't overwrite their input.
  const revision = invalidatePairingStatus();
  let code;
  try {
    code = normalizePairingCode(await loadPairingCode());
  } catch {
    if (revision === pairingStatusRevision) {
      showPairingStatus("Could not load the saved pairing code.");
    }
    return;
  }
  if (revision !== pairingStatusRevision) return;

  pairingEl.value = code;
  if (!code) {
    showPairingStatus("Not paired: links only");
    return;
  }
  if (!SHARED_PAIRING_CODE_RE.test(code)) {
    showPairingStatus("Saved code has an invalid format; enter it again.");
    return;
  }

  showPairingStatus("Saved; verifying with Grab…");
  const cookieAccessGranted = await hasCookiePermission();
  if (!isCurrentPairingOperation(revision, code)) return;
  await verifySavedPairing(code, cookieAccessGranted, revision);
}

/// Save a code (or unpair when empty), request optional cookie access, then
/// ask the background worker to cryptographically verify the saved code.
async function savePairing() {
  const revision = invalidatePairingStatus();
  pairingEl.removeAttribute("aria-invalid");
  const code = normalizePairingCode(pairingEl.value);

  if (code === "") {
    await savePairingCode("");
    // Always revoke cookie access when unpairing, even if the input is edited
    // again while the storage operation is in flight. Page access goes too
    // unless video detection still uses it.
    await releaseUnusedPermissions();
    if (isCurrentPairingOperation(revision, "")) {
      pairingEl.value = "";
      showPairingStatus("Not paired: links only");
    }
    return;
  }

  // savePairingCode enforces the 64-hex-digit format.
  if (!(await savePairingCode(code))) {
    if (revision === pairingStatusRevision) {
      pairingEl.setAttribute("aria-invalid", "true");
      showPairingStatus("That isn't a pairing code (64 hexadecimal characters).");
    }
    return;
  }

  if (!isCurrentPairingOperation(revision, code)) return;
  pairingEl.value = code;
  showPairingStatus("Saved; verifying with Grab…");

  // The click is the user gesture the browser requires to grant optional
  // cookie access, which also needs access to web pages. Verification is
  // separate from this permission decision.
  try {
    await chrome.permissions.request({
      permissions: ["cookies"],
      origins: SHARED_PAGE_ORIGINS,
    });
  } catch {
    // The code can still be verified; handoffs remain URL-only without cookies.
  }
  if (!isCurrentPairingOperation(revision, code)) return;

  const cookieAccessGranted = await hasCookiePermission();
  await verifySavedPairing(code, cookieAccessGranted, revision);
}

pairingEl.addEventListener("input", () => {
  invalidatePairingStatus();
  pairingEl.removeAttribute("aria-invalid");
  showPairingStatus("Unsaved changes — save to verify or unpair.");
});

pairingBtn.addEventListener("click", savePairing);

/// The cookie-forwarding toggle is stored beside the pairing code and is
/// independent of it: pairing, unpairing and the code itself never change it.
async function loadForwardCookiesToggle() {
  const revision = forwardCookiesRevision;
  const enabled = await loadForwardCookies();
  if (revision === forwardCookiesRevision) forwardCookiesEl.checked = enabled;
}

forwardCookiesEl.addEventListener("change", async () => {
  forwardCookiesRevision += 1;
  const enabled = forwardCookiesEl.checked;
  try {
    await saveForwardCookies(enabled);
  } catch {
    forwardCookiesEl.checked = !enabled;
    forwardCookiesStatusEl.textContent = "Could not save this setting.";
    return;
  }
  forwardCookiesStatusEl.textContent = enabled
    ? "Cookie forwarding is on."
    : "Cookie forwarding is off; handoffs stay URL-only.";
});

loadPairing();
loadForwardCookiesToggle();
