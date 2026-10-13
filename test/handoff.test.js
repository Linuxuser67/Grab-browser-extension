import { test } from "node:test";
import assert from "node:assert/strict";

/// Tests for E1 async confirm: awaitDecision polls /status until Grab decides.
async function loadHandoff() {
  const handoff = await import("../handoff.js");
  return handoff;
}

test("pending then approved resolves 200", async () => {
  const { awaitDecision } = await loadHandoff();
  const states = ["pending", "pending", "approved"];
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ state: states.shift() }),
  });
  const status = await awaitDecision("0".repeat(32), Date.now() + 60_000);
  assert.equal(status, 200);
});

test("declined resolves 409", async () => {
  const { awaitDecision } = await loadHandoff();
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ state: "declined" }),
  });
  assert.equal(await awaitDecision("a".repeat(32), Date.now() + 60_000), 409);
});

test("timeout resolves 408", async () => {
  const { awaitDecision } = await loadHandoff();
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ state: "timeout" }),
  });
  assert.equal(await awaitDecision("b".repeat(32), Date.now() + 60_000), 408);
});

test("unknown id leaves the browser download alone", async () => {
  const { awaitDecision } = await loadHandoff();
  globalThis.fetch = async () => ({ ok: false, status: 404 });
  assert.equal(await awaitDecision("c".repeat(32), Date.now() + 60_000), 0);
});

test("malformed id is rejected before any request", async () => {
  const { awaitDecision } = await loadHandoff();
  let called = false;
  globalThis.fetch = async () => {
    called = true;
  };
  assert.equal(await awaitDecision("../../x", Date.now() + 60_000), 0);
  assert.equal(called, false);
});

test("unreachable Grab returns 0", async () => {
  const { awaitDecision } = await loadHandoff();
  globalThis.fetch = async () => {
    throw new Error("connection refused");
  };
  assert.equal(await awaitDecision("d".repeat(32), Date.now() + 60_000), 0);
});
