// Focused tests for the Options page's pairing-status state machine.
// Run with: node --test test/*.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const OPTIONS_SOURCE = fs.readFileSync(
  path.join(__dirname, "..", "options.js"),
  "utf8",
);
const SHARED_SOURCE = fs.readFileSync(
  path.join(__dirname, "..", "shared.js"),
  "utf8",
);
const VALID_CODE = "ab".repeat(32);

function makeElement(id) {
  return {
    id,
    value: "",
    // Undefined, not false: a test that waits for `checked === false` must
    // prove the stored setting was actually applied.
    checked: undefined,
    textContent: "",
    attributes: new Map(),
    listeners: new Map(),
    addEventListener(type, callback) {
      this.listeners.set(type, callback);
    },
    removeAttribute(name) {
      this.attributes.delete(name);
    },
    setAttribute(name, value) {
      this.attributes.set(name, value);
    },
  };
}

function makeOptions({
  storedCode = VALID_CODE,
  forwardCookies = true,
  cookiePermission = true,
  delayInitialLoad = false,
  delayToggleLoad = false,
} = {}) {
  const elements = new Map();
  const pendingMessages = [];
  let savedCode = storedCode;
  let initialReadStartedResolve;
  let releaseInitialRead;
  let initialReadConsumed = false;
  const initialReadStarted = new Promise((resolve) => {
    initialReadStartedResolve = resolve;
  });
  const initialReadGate = delayInitialLoad
    ? new Promise((resolve) => {
        releaseInitialRead = resolve;
      })
    : null;
  let toggleReadStartedResolve;
  let releaseToggleRead;
  let toggleReadConsumed = false;
  const toggleReadStarted = new Promise((resolve) => {
    toggleReadStartedResolve = resolve;
  });
  const toggleReadGate = delayToggleLoad
    ? new Promise((resolve) => {
        releaseToggleRead = resolve;
      })
    : null;

  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, makeElement(id));
      return elements.get(id);
    },
  };

  const requests = [];
  let releaseCalls = 0;
  // Local storage holds the pairing code and the cookie-forwarding toggle.
  const local = { pairingCode: storedCode, forwardCookies };
  const chrome = {
    runtime: {
      sendMessage(message) {
        return new Promise((resolve, reject) => {
          pendingMessages.push({ message, resolve, reject });
        });
      },
    },
    permissions: {
      request: async (query) => {
        requests.push(query);
        return cookiePermission;
      },
      contains: async () => cookiePermission,
      remove: async () => true,
    },
    storage: {
      local: {
        get: async (defaults) => {
          // Snapshot before waiting: a delayed read must deliver the value it
          // found when it started, like a slow real storage call.
          const result = { ...defaults, ...local };
          if (
            delayToggleLoad &&
            defaults &&
            Object.hasOwn(defaults, "forwardCookies") &&
            !toggleReadConsumed
          ) {
            toggleReadConsumed = true;
            toggleReadStartedResolve();
            await toggleReadGate;
          }
          return result;
        },
        set: async (obj) => Object.assign(local, obj),
      },
    },
  };

  const normalizePairingCode = (raw) =>
    String(raw || "").replaceAll(" ", "").replaceAll("\n", "").replaceAll("\t", "").toLowerCase();
  const pairingCodePattern = /^[0-9a-f]{64}$/;
  const context = vm.createContext({
    document,
    chrome,
    // Real implementation lives in settings.js and is tested in settings.test.js.
    async releaseUnusedPermissions() {
      releaseCalls += 1;
    },
    bindSettingsForm() {},
    async loadPairingCode() {
      if (delayInitialLoad && !initialReadConsumed) {
        initialReadConsumed = true;
        initialReadStartedResolve();
        await initialReadGate;
      }
      return savedCode;
    },
    async savePairingCode(raw) {
      const code = normalizePairingCode(raw);
      if (code !== "" && !pairingCodePattern.test(code)) return false;
      savedCode = code;
      return true;
    },
  });

  // shared.js holds the storage helpers both the page and the worker use.
  vm.runInContext(SHARED_SOURCE, context, { filename: "shared.js" });
  vm.runInContext(OPTIONS_SOURCE, context, { filename: "options.js" });

  return {
    elements,
    pendingMessages,
    initialReadStarted,
    releaseInitialRead,
    toggleReadStarted,
    releaseToggleRead,
    local,
    get savedCode() {
      return savedCode;
    },
    requests,
    get releaseCalls() {
      return releaseCalls;
    },
  };
}

async function waitFor(predicate, message) {
  for (let i = 0; i < 100; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(message || "Timed out waiting for Options page state");
}


test("typing before the initial storage read completes is not overwritten", async () => {
  const ui = makeOptions({ delayInitialLoad: true });
  const codeInput = ui.elements.get("pairingCode");
  const status = ui.elements.get("pairingStatus");
  const editedCode = "cd".repeat(32);

  await ui.initialReadStarted;
  codeInput.value = editedCode;
  codeInput.listeners.get("input")();
  ui.releaseInitialRead();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(codeInput.value, editedCode);
  assert.equal(status.textContent, "Unsaved changes — save to verify or unpair.");
  assert.equal(ui.pendingMessages.length, 0, "an edited code must not be verified before saving");
});

test("saved code stays pending until the background worker verifies it", async () => {
  const ui = makeOptions();
  const status = ui.elements.get("pairingStatus");

  await waitFor(() => ui.pendingMessages.length === 1, "handshake message was not sent");
  assert.equal(ui.pendingMessages[0].message.type, "grab-status");
  assert.equal(status.textContent, "Saved; verifying with Grab…");
  assert.notEqual(status.textContent, "Verified");

  ui.pendingMessages[0].resolve({ state: "verified" });
  await waitFor(() => status.textContent.startsWith("Verified"));

  assert.equal(
    status.textContent,
    "Verified — Grab recognizes this code. Cookie access is granted.",
  );
});

test("a failed proof never labels the code Verified", async () => {
  const ui = makeOptions();
  const status = ui.elements.get("pairingStatus");

  await waitFor(() => ui.pendingMessages.length === 1);
  ui.pendingMessages[0].resolve({ state: "unverified" });
  await waitFor(() => status.textContent.startsWith("Saved, but not verified"));

  assert.match(status.textContent, /could not prove this pairing code/i);
  assert.equal(status.textContent.startsWith("Verified"), false);
});

test("an unreachable Grab remains Saved but not Verified", async () => {
  const ui = makeOptions();
  const status = ui.elements.get("pairingStatus");

  await waitFor(() => ui.pendingMessages.length === 1);
  ui.pendingMessages[0].resolve({ state: "down" });
  await waitFor(() => status.textContent.includes("not reachable"));

  assert.equal(status.textContent.startsWith("Verified"), false);
});

test("editing the code invalidates a pending successful handshake", async () => {
  const ui = makeOptions();
  const codeInput = ui.elements.get("pairingCode");
  const status = ui.elements.get("pairingStatus");

  await waitFor(() => ui.pendingMessages.length === 1);
  codeInput.value = "cd".repeat(32);
  codeInput.listeners.get("input")();
  assert.equal(status.textContent, "Unsaved changes — save to verify or unpair.");

  ui.pendingMessages[0].resolve({ state: "verified" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(status.textContent, "Unsaved changes — save to verify or unpair.");
  assert.equal(status.textContent.startsWith("Verified"), false);
});

test("saving a new code shows Saved first and then the verification result", async () => {
  const ui = makeOptions({ storedCode: "", cookiePermission: false });
  const codeInput = ui.elements.get("pairingCode");
  const saveButton = ui.elements.get("savePairing");
  const status = ui.elements.get("pairingStatus");

  await waitFor(() => status.textContent === "Not paired: links only");
  codeInput.value = VALID_CODE.toUpperCase();
  codeInput.listeners.get("input")();

  const savePromise = saveButton.listeners.get("click")();
  await waitFor(() => ui.pendingMessages.length === 1, "saved code was not checked");
  assert.equal(ui.savedCode, VALID_CODE);
  assert.equal(status.textContent, "Saved; verifying with Grab…");

  ui.pendingMessages[0].resolve({ state: "verified" });
  await savePromise;

  assert.equal(
    status.textContent,
    "Verified — Grab recognizes this code. Cookie access is not granted, so handoffs are URL-only.",
  );
});

test("pairing asks for the cookies permission together with page access", async () => {
  const ui = makeOptions({ storedCode: "", cookiePermission: true });
  const codeInput = ui.elements.get("pairingCode");
  const status = ui.elements.get("pairingStatus");
  await waitFor(() => status.textContent === "Not paired: links only");
  codeInput.value = VALID_CODE;
  codeInput.listeners.get("input")();

  const savePromise = ui.elements.get("savePairing").listeners.get("click")();
  await waitFor(() => ui.pendingMessages.length === 1, "saved code was not checked");
  ui.pendingMessages[0].resolve({ state: "verified" });
  await savePromise;

  // cookies.getAll only works for sites the extension can access, so both are
  // requested in one prompt; neither is requested at install time.
  // The page runs in a separate vm realm; compare plain JSON.
  assert.deepEqual(JSON.parse(JSON.stringify(ui.requests)), [
    { permissions: ["cookies"], origins: ["http://*/*", "https://*/*"] },
  ]);
});

test("the cookie-forwarding toggle shows the stored setting and saves changes", async () => {
  const ui = makeOptions({ forwardCookies: false });
  const toggle = ui.elements.get("forwardCookies");

  await waitFor(() => toggle.checked === false, "the stored setting was not applied");
  assert.equal(ui.local.forwardCookies, false);
  assert.equal(ui.savedCode, VALID_CODE, "the pairing code is untouched");

  toggle.checked = true;
  await toggle.listeners.get("change")();
  assert.equal(ui.local.forwardCookies, true);
  assert.equal(ui.savedCode, VALID_CODE, "the toggle must not touch the pairing code");
});

test("the cookie-forwarding toggle works without a pairing code", async () => {
  const ui = makeOptions({ storedCode: "", forwardCookies: true });
  const toggle = ui.elements.get("forwardCookies");

  await waitFor(() => toggle.checked === true, "the toggle did not load");
  toggle.checked = false;
  await toggle.listeners.get("change")();
  assert.equal(ui.local.forwardCookies, false);
  assert.equal(ui.savedCode, "");
});

test("a toggle change before the stored value loads is not overwritten", async () => {
  const ui = makeOptions({ forwardCookies: false, delayToggleLoad: true });
  const toggle = ui.elements.get("forwardCookies");

  await ui.toggleReadStarted;
  toggle.checked = true;
  await toggle.listeners.get("change")();
  ui.releaseToggleRead();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(toggle.checked, true, "the user's choice wins over the stale read");
  assert.equal(ui.local.forwardCookies, true);
});

test("unpairing and re-pairing leave the toggle alone", async () => {
  const ui = makeOptions({ storedCode: VALID_CODE, forwardCookies: false });
  const toggle = ui.elements.get("forwardCookies");
  const codeInput = ui.elements.get("pairingCode");
  const save = ui.elements.get("savePairing");
  await waitFor(() => toggle.checked === false, "the stored setting was not applied");
  ui.pendingMessages[0].resolve({ state: "verified" });

  codeInput.value = "";
  codeInput.listeners.get("input")();
  await save.listeners.get("click")();
  assert.equal(ui.savedCode, "");
  assert.equal(ui.local.forwardCookies, false, "unpairing keeps the toggle");

  codeInput.value = VALID_CODE;
  codeInput.listeners.get("input")();
  const pairing = save.listeners.get("click")();
  await waitFor(() => ui.pendingMessages.length === 2, "re-pairing was not verified");
  ui.pendingMessages[1].resolve({ state: "verified" });
  await pairing;

  assert.equal(ui.savedCode, VALID_CODE);
  assert.equal(ui.local.forwardCookies, false, "pairing keeps the toggle");
  assert.equal(toggle.checked, false);
});

test("a toggle change during pairing verification refreshes the cookie status", async () => {
  const ui = makeOptions({ forwardCookies: true });
  const toggle = ui.elements.get("forwardCookies");
  const status = ui.elements.get("pairingStatus");

  await waitFor(() => ui.pendingMessages.length === 1, "the saved code was not verified");
  toggle.checked = false;
  await toggle.listeners.get("change")();
  ui.pendingMessages[0].resolve({ state: "verified" });

  await waitFor(() => status.textContent.startsWith("Verified"));
  assert.match(status.textContent, /Cookie forwarding is off/);
});

test("unpairing releases the optional permissions it no longer needs", async () => {
  const ui = makeOptions({ storedCode: VALID_CODE });
  const codeInput = ui.elements.get("pairingCode");
  const status = ui.elements.get("pairingStatus");
  await waitFor(() => ui.pendingMessages.length === 1);
  ui.pendingMessages[0].resolve({ state: "verified" });
  await waitFor(() => status.textContent.startsWith("Verified"));

  codeInput.value = "";
  codeInput.listeners.get("input")();
  await ui.elements.get("savePairing").listeners.get("click")();

  assert.equal(ui.savedCode, "");
  assert.equal(ui.releaseCalls, 1);
  assert.equal(status.textContent, "Not paired: links only");
});
