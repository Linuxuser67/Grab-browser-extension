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
const VALID_CODE = "ab".repeat(32);

function makeElement(id) {
  return {
    id,
    value: "",
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

function makeOptions({ storedCode = VALID_CODE, cookiePermission = true } = {}) {
  const elements = new Map();
  const pendingMessages = [];
  let savedCode = storedCode;

  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, makeElement(id));
      return elements.get(id);
    },
  };

  const chrome = {
    runtime: {
      sendMessage(message) {
        return new Promise((resolve, reject) => {
          pendingMessages.push({ message, resolve, reject });
        });
      },
    },
    permissions: {
      request: async () => cookiePermission,
      contains: async () => cookiePermission,
      remove: async () => true,
    },
  };

  const normalizePairingCode = (raw) =>
    String(raw || "").replaceAll(" ", "").replaceAll("\n", "").replaceAll("\t", "").toLowerCase();
  const pairingCodePattern = /^[0-9a-f]{64}$/;
  const context = vm.createContext({
    document,
    chrome,
    SHARED_PAIRING_CODE_RE: pairingCodePattern,
    normalizePairingCode,
    bindSettingsForm() {},
    async loadPairingCode() {
      return savedCode;
    },
    async savePairingCode(raw) {
      const code = normalizePairingCode(raw);
      if (code !== "" && !pairingCodePattern.test(code)) return false;
      savedCode = code;
      return true;
    },
  });

  vm.runInContext(OPTIONS_SOURCE, context, { filename: "options.js" });

  return {
    elements,
    pendingMessages,
    get savedCode() {
      return savedCode;
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
    "Verified — cookie access is not granted, so handoffs are URL-only.",
  );
});
