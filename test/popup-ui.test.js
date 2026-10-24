// Regression tests for the compact popup header status.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const html = fs.readFileSync(path.join(__dirname, "..", "popup.html"), "utf8");
const js = fs.readFileSync(path.join(__dirname, "..", "popup.js"), "utf8");

test("Grab runtime status sits between the title and Options gear in the header", () => {
  const header = html.match(/<header class="header">([\\s\\S]*?)<\\/header>/);
  assert.ok(header, "popup header should exist");
  const titleIndex = header[1].indexOf("<h2>");
  const statusIndex = header[1].indexOf('id="grabStatus"');
  const optionsIndex = header[1].indexOf('id="openOptions"');

  assert.ok(titleIndex >= 0, "Grab title should be in the header");
  assert.ok(statusIndex > titleIndex, "status should follow the Grab title");
  assert.ok(optionsIndex > statusIndex, "Options gear should follow the status");
  assert.match(
    header[1],
    /id="grabStatus"[^>]*role="status"[^>]*aria-live="polite"/,
    "status remains available to assistive technology",
  );
});

test("popup status uses a compact dot and distinct semantic states", () => {
  assert.match(html, /\.status::before[\\s\\S]*?border-radius: 50%/);
  assert.match(html, /\.status\.ok[\\s\\S]*?color: var\\(--status-ok\\)/);
  assert.match(html, /\.status\.warning[\\s\\S]*?color: var\\(--status-warning\\)/);
  assert.match(html, /\.status\.down[\\s\\S]*?color: var\\(--status-down\\)/);
  assert.match(html, /\.status\.neutral[\\s\\S]*?color: var\\(--status-neutral\\)/);
  assert.match(js, /unverified: \\["Unverified", "status warning"\\]/);
  assert.match(js, /unpaired: \\["Not paired", "status neutral"\\]/);
});
