// Options page: reflects chrome.storage.sync and saves on change.
// bindSettingsForm, loadPairingCode, savePairingCode come from settings.js.

bindSettingsForm(document);

const pairingEl = document.getElementById("pairingCode");
const pairingBtn = document.getElementById("savePairing");
const pairingStatusEl = document.getElementById("pairingStatus");

let pairingStatusRevision = 0;

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

async function hasCookiePermission() {
  try {
    return await chrome.permissions.contains({ permissions: ["cookies"] });
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
    const cookieStatus =
      cookieAccessGranted === true
        ? "Cookie access is granted."
        : cookieAccessGranted === false
          ? "Cookie access is not granted, so handoffs are URL-only."
          : "Cookie permission status is unavailable.";
    showPairingStatus(`Verified — Grab recognizes this code. ${cookieStatus}`);
  } else if (reply && reply.state === "unverified") {
    showPairingStatus(
      "Saved, but not verified — Grab could not prove this pairing code.",
    );
  } else if (reply && reply.state === "down") {
    showPairingStatus(
      "Saved, but Grab is not reachable; verification is pending.",
    );
  } else if (reply && reply.state === "unpaired") {
    showPairingStatus(
      "Saved, but the background worker found no valid pairing code.",
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
    // again while the storage operation is in flight.
    try {
      await chrome.permissions.remove({ permissions: ["cookies"] });
    } catch {
      // Permissions API unavailable, or already removed.
    }
    if (isCurrentPairingOperation(revision, "")) {
      pairingEl.value = "";
      showPairingStatus("Not paired: links only");
    }
    return;
  }

  if (!SHARED_PAIRING_CODE_RE.test(code) || !(await savePairingCode(code))) {
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
  // cookie access. Verification is separate from this permission decision.
  try {
    await chrome.permissions.request({ permissions: ["cookies"] });
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

loadPairing();
