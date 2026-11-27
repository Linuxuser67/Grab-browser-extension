// Tests for the shared settings controls: opt-in video detection and the
// optional permissions it and pairing own. Run with: node --test test/*.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SETTINGS_SOURCE = fs.readFileSync(path.join(__dirname, "..", "settings.js"), "utf8");
const SHARED_SOURCE = fs.readFileSync(path.join(__dirname, "..", "shared.js"), "utf8");
const ORIGINS = ["http://*/*", "https://*/*"];
const tick = () => new Promise((resolve) => setImmediate(resolve));

function makeElement() {
  return {
    checked: false,
    value: "",
    textContent: "",
    style: {},
    classList: { add() {}, remove() {} },
    listeners: new Map(),
    addEventListener(type, fn) {
      this.listeners.set(type, fn);
    },
  };
}

/// Load settings.js against a fake chrome. `grant` is what permissions.contains
/// and request report; `sync`/`local` are the stored values.
function setup({
  sync = {},
  local = {},
  grant = false,
  requestResult,
  rejectSyncSet = false,
} = {}) {
  const state = {
    sync: { ...sync },
    local: { ...local },
    grant,
    requests: [],
    removals: [],
    optionsOpened: 0,
  };
  const chrome = {
    storage: {
      sync: {
        get: async (defaults) => ({ ...defaults, ...state.sync }),
        set: async (obj) => {
          if (rejectSyncSet) throw new Error("sync storage quota exceeded");
          Object.assign(state.sync, obj);
        },
      },
      local: {
        get: async (defaults) => ({ ...defaults, ...state.local }),
        set: async (obj) => Object.assign(state.local, obj),
      },
    },
    permissions: {
      contains: async () => state.grant,
      request: async (query) => {
        state.requests.push(JSON.parse(JSON.stringify(query)));
        const ok = requestResult === undefined ? true : requestResult;
        if (ok) state.grant = true;
        return ok;
      },
      remove: async (query) => {
        state.removals.push(JSON.parse(JSON.stringify(query)));
        return true;
      },
    },
    runtime: {
      openOptionsPage: () => {
        state.optionsOpened += 1;
      },
    },
  };
  const elements = new Map();
  const doc = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, makeElement());
      return elements.get(id);
    },
  };
  const context = vm.createContext({ chrome, document: doc, setTimeout, clearTimeout });
  vm.runInContext(SHARED_SOURCE, context, { filename: "shared.js" });
  vm.runInContext(SETTINGS_SOURCE, context, { filename: "settings.js" });
  return { state, elements, context, doc, chrome };
}

test("shared.js declares the optional page origins once", () => {
  const { context } = setup();
  // Top-level const is not a property of the context object; evaluate it.
  const origins = vm.runInContext("SHARED_PAGE_ORIGINS", context);
  assert.deepEqual(JSON.parse(JSON.stringify(origins)), ORIGINS);
});

test("cookie forwarding defaults to on and round-trips through local storage", async () => {
  const { state, context } = setup({ local: {} });
  assert.equal(await context.loadForwardCookies(), true, "forwarding stays on until the user turns it off");
  await context.saveForwardCookies(false);
  assert.equal(state.local.forwardCookies, false);
  assert.equal(await context.loadForwardCookies(), false);
});

test("releaseUnusedPermissions: nothing in use drops everything optional", async () => {
  const { state, context } = setup({ sync: { detectVideos: false } });
  await context.releaseUnusedPermissions();
  assert.deepEqual(state.removals, [{ permissions: ["webRequest", "cookies"], origins: ORIGINS }]);
});

test("releaseUnusedPermissions: pairing keeps page access and cookies", async () => {
  const { state, context } = setup({
    sync: { detectVideos: false },
    local: { pairingCode: "ab".repeat(32) },
  });
  await context.releaseUnusedPermissions();
  assert.deepEqual(state.removals, [{ permissions: ["webRequest"] }]);
});

test("releaseUnusedPermissions: video detection keeps page access and webRequest", async () => {
  const { state, context } = setup({ sync: { detectVideos: true } });
  await context.releaseUnusedPermissions();
  assert.deepEqual(state.removals, [{ permissions: ["cookies"] }]);
});

test("releaseUnusedPermissions: both features in use removes nothing", async () => {
  const { state, context } = setup({
    sync: { detectVideos: true },
    local: { pairingCode: "ab".repeat(32) },
  });
  await context.releaseUnusedPermissions();
  assert.deepEqual(state.removals, []);
});

test("a failed sync save is reported and does not reject the change listener", async () => {
  const { elements, context, doc } = setup({ rejectSyncSet: true });
  context.bindSettingsForm(doc);
  await tick();

  const intercept = elements.get("interceptDownloads");
  intercept.checked = true;
  const result = await intercept.listeners.get("change")();

  assert.equal(result, false);
  assert.equal(elements.get("saved").textContent, "Could not save settings");
});

test("detection stored as on but without page access shows as off, with a note", async () => {
  const { elements, context, doc } = setup({ sync: { detectVideos: true }, grant: false });
  context.bindSettingsForm(doc);
  await tick();
  await tick();
  assert.equal(elements.get("detectVideos").checked, false);
  assert.match(elements.get("detectVideosNote").textContent, /Needs access/);
});

test("detection stored as on with access granted shows as on", async () => {
  const { elements, context, doc } = setup({ sync: { detectVideos: true }, grant: true });
  context.bindSettingsForm(doc);
  await tick();
  await tick();
  assert.equal(elements.get("detectVideos").checked, true);
});

test("turning detection on asks for page access and webRequest, then saves", async () => {
  const { state, elements, context, doc } = setup({ sync: { detectVideos: false } });
  context.bindSettingsForm(doc);
  await tick();
  const box = elements.get("detectVideos");
  box.checked = true;
  await box.listeners.get("change")();
  assert.deepEqual(state.requests, [{ permissions: ["webRequest"], origins: ORIGINS }]);
  assert.equal(state.sync.detectVideos, true);
  assert.equal(box.checked, true);
});

test("declining the permission leaves detection off and says why", async () => {
  const { state, elements, context, doc } = setup({
    sync: { detectVideos: false },
    requestResult: false,
  });
  context.bindSettingsForm(doc);
  await tick();
  const box = elements.get("detectVideos");
  box.checked = true;
  await box.listeners.get("change")();
  assert.equal(box.checked, false);
  assert.equal(state.sync.detectVideos, false);
  assert.match(elements.get("detectVideosNote").textContent, /not granted/);
});

test("turning detection off saves it and releases what only it used", async () => {
  const { state, elements, context, doc } = setup({
    sync: { detectVideos: true },
    grant: true,
  });
  context.bindSettingsForm(doc);
  await tick();
  const box = elements.get("detectVideos");
  box.checked = false;
  await box.listeners.get("change")();
  assert.equal(state.sync.detectVideos, false);
  assert.deepEqual(state.removals, [
    { permissions: ["webRequest", "cookies"], origins: ORIGINS },
  ]);
});

test("the popup never prompts: it opens Options and leaves the box unchecked", async () => {
  const { state, elements, context, doc } = setup({ sync: { detectVideos: false } });
  context.bindSettingsForm(doc, { deferPermissionPrompt: true });
  await tick();
  const box = elements.get("detectVideos");
  box.checked = true;
  await box.listeners.get("change")();
  assert.equal(state.requests.length, 0);
  assert.equal(state.optionsOpened, 1);
  assert.equal(box.checked, false);
  assert.equal(state.sync.detectVideos, false);
});

test("the popup saves normally when access is already granted", async () => {
  const { state, elements, context, doc } = setup({
    sync: { detectVideos: false },
    grant: true,
  });
  context.bindSettingsForm(doc, { deferPermissionPrompt: true });
  await tick();
  const box = elements.get("detectVideos");
  box.checked = true;
  await box.listeners.get("change")();
  assert.equal(state.requests.length, 0);
  assert.equal(state.optionsOpened, 0);
  assert.equal(state.sync.detectVideos, true);
});


test("video and cookie permission checks share the canonical queries", async () => {
  const { context, chrome } = setup({ grant: true });
  const queries = [];
  chrome.permissions.contains = async (query) => {
    queries.push(query);
    return true;
  };

  assert.equal(await context.hasVideoAccess(), true);
  assert.equal(await context.hasCookiePermission(), true);
  assert.deepEqual(JSON.parse(JSON.stringify(queries)), [
    { permissions: ["webRequest"], origins: ORIGINS },
    { permissions: ["cookies"], origins: ORIGINS },
  ]);
});

test("cookie permission callers can distinguish denied from unknown", async () => {
  const { context, chrome } = setup();
  chrome.permissions.contains = async () => {
    throw new Error("permission state unavailable");
  };

  assert.equal(await context.hasCookiePermission(), false);
  assert.equal(await context.hasCookiePermission(null), null);
});

test("missing Permissions API preserves cookie-read fallback but disables video access", async () => {
  const { context, chrome } = setup();
  chrome.permissions.contains = undefined;

  assert.equal(await context.hasCookiePermission(), true);
  assert.equal(await context.hasCookiePermission(null), null);
  assert.equal(await context.hasVideoAccess(), false);
});
