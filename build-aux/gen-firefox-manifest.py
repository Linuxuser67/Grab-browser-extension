#!/usr/bin/env python3
"""Generate manifest.firefox.json from manifest.json.

The Firefox manifest is derived, not hand-maintained: this keeps the two
from drifting. Run with --check in CI to fail when they're out of sync.
"""

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CHROMIUM = ROOT / "manifest.json"
FIREFOX = ROOT / "manifest.firefox.json"
BACKGROUND = ROOT / "background.js"


def background_scripts():
    source = BACKGROUND.read_text()
    match = re.search(
        r"const BACKGROUND_SCRIPTS = Object\.freeze\((\[[\s\S]*?\])\);",
        source,
    )
    if not match:
        raise ValueError("background.js has no canonical BACKGROUND_SCRIPTS array")
    scripts = json.loads(match.group(1))
    if not isinstance(scripts, list) or not all(isinstance(item, str) for item in scripts):
        raise ValueError("BACKGROUND_SCRIPTS must be a JSON array of paths")
    if len(scripts) != len(set(scripts)):
        raise ValueError("BACKGROUND_SCRIPTS contains duplicate paths")
    return scripts


def generate():
    m = json.loads(CHROMIUM.read_text())
    # Firefox uses background scripts, not a service worker. Keep its load
    # order aligned with Chromium's importScripts declaration in background.js.
    m["background"] = {"scripts": [*background_scripts(), "background.js"]}
    # Firefox-only metadata.
    m["browser_specific_settings"] = {
        "gecko": {
            "data_collection_permissions": {"required": ["none"]},
            "id": "grab@linuxuser67.github.io",
            "strict_min_version": "142.0",
        }
    }
    # Chromium-only key.
    m.pop("minimum_chrome_version", None)
    return json.dumps(m, indent=2) + "\n"


def main():
    generated = generate()
    if "--check" in sys.argv:
        current = FIREFOX.read_text()
        if current != generated:
            print("manifest.firefox.json is out of sync with manifest.json")
            print("Run build-aux/gen-firefox-manifest.py to regenerate it.")
            sys.exit(1)
        print("manifest.firefox.json is in sync.")
    else:
        FIREFOX.write_text(generated)
        print("Wrote", FIREFOX)


if __name__ == "__main__":
    main()
