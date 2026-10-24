// Regression tests for the compact popup header status.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const html = fs.readFileSync(path.join(__dirname, "..", "popup.html"), "utf8");
const js = fs.readFileSync(path.join(__dirname, "..", "popup.js"), "utf8");

test("Grab runtime status sits between the title and Options gear in the header", () => {
  const headerStart = html.indexOf('<header class="header">');
  const headerEnd = html.indexOf("</header>", headerStart);
  assert.ok(headerStart >= 0 && headerEnd > headerStart, "popup header should exist");
  const header = html.slice(headerStart, headerEnd);

  const titleIndex = header.indexOf("<h2>");
  const statusIndex = header.indexOf('id="grabStatus"');
  const optionsIndex = header.indexOf('id="openOptions"');

  assert.ok(titleIndex >= 0, "Grab title should be in the header");
  assert.ok(statusIndex > titleIndex, "status should follow the Grab title");
  assert.ok(optionsIndex > statusIndex, "Options gear should follow the status");
  assert.ok(header.includes('role="status"'), "status role should be accessible");
  assert.ok(header.includes('aria-live="polite"'), "status should announce changes politely");
});

test("popup status uses a compact dot and distinct semantic states", () => {
  assert.ok(html.includes(".status::before"));
  assert.ok(html.includes("border-radius: 50%"));
  assert.ok(html.includes(".status.ok"));
  assert.ok(html.includes("color: var(--status-ok)"));
  assert.ok(html.includes(".status.warning"));
  assert.ok(html.includes("color: var(--status-warning)"));
  assert.ok(html.includes(".status.down"));
  assert.ok(html.includes("color: var(--status-down)"));
  assert.ok(html.includes(".status.neutral"));
  assert.ok(html.includes("color: var(--status-neutral)"));
  assert.ok(js.includes('unverified: ["Unverified", "status warning"]'));
  assert.ok(js.includes('unpaired: ["Not paired", "status neutral"]'));
});
