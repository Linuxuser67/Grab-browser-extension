import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("firefox manifest declares background as module when background.js uses imports", () => {
  const bg = fs.readFileSync(path.join(root, "background.js"), "utf8");
  const usesImports = /^\s*import\s/m.test(bg);
  const ff = JSON.parse(fs.readFileSync(path.join(root, "manifest.firefox.json"), "utf8"));
  const cr = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  if (usesImports) {
    assert.equal(ff.background?.type, "module", "manifest.firefox.json background.type must be 'module'");
    assert.equal(cr.background?.type, "module", "manifest.json background.type must be 'module'");
  }
});
