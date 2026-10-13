#!/usr/bin/env python3
"""Generate manifest.firefox.json from manifest.json.

The Firefox manifest is derived, not hand-maintained: this keeps the two
from drifting. Run with --check in CI to fail when they're out of sync.
"""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CHROMIUM = ROOT / "manifest.json"
FIREFOX = ROOT / "manifest.firefox.json"


def generate():
    m = json.loads(CHROMIUM.read_text())
    # Firefox uses background scripts, not a service worker.
    # "type": "module" is required since background.js uses ES imports (E4 split).
    m["background"] = {"scripts": ["background.js"], "type": "module"}
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
