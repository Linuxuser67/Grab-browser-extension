#!/usr/bin/env python3
"""Install the Grab native messaging host for Chromium- and Firefox-based browsers.

Copies the host script to ~/.local/share/grab-native-host/ and writes the
host manifest JSON into every detected browser's NativeMessagingHosts dir:

  Chromium: ~/.config/<profile>/NativeMessagingHosts/io.github.linuxuser67.grab.json
            (manifest_version 3 "allowed_origins" with the extension ID)
  Firefox:  ~/.mozilla/native-messaging-hosts/io.github.linuxuser67.grab.json
            ("allowed_extensions" with the add-on ID)

Chromium extension IDs for unpacked installs vary, so pass them explicitly:
  ./install.py --chromium-id <id> [--chromium-id <id> ...]

The Firefox add-on ID is fixed (grab@linuxuser67.github.io).
"""

import argparse
import json
import os
import shutil
import sys

HOST_NAME = "io.github.linuxuser67.grab"
FIREFOX_ADDON_ID = "grab@linuxuser67.github.io"

HERE = os.path.dirname(os.path.abspath(__file__))
HOST_SRC = os.path.join(HERE, "grab-host")
INSTALL_DIR = os.path.expanduser("~/.local/share/grab-native-host")
HOST_DST = os.path.join(INSTALL_DIR, "grab-host")

# Chromium config dirs to probe (Brave variants, Chrome, Chromium, Edge...).
CHROMIUM_CONFIG_DIRS = [
    "~/.config/BraveSoftware/Brave-Browser",
    "~/.config/BraveSoftware/Brave-Browser-Beta",
    "~/.config/BraveSoftware/Brave-Browser-Dev",
    "~/.config/BraveSoftware/Brave-Browser-Nightly",
    "~/.config/BraveSoftware/Brave-Origin-Beta",
    "~/.config/google-chrome",
    "~/.config/google-chrome-beta",
    "~/.config/google-chrome-unstable",
    "~/.config/chromium",
    "~/.config/microsoft-edge",
    "~/.config/microsoft-edge-beta",
    "~/.config/vivaldi",
    "~/.config/opera",
]


def chromium_manifest(host_path, extension_ids):
    return {
        "name": HOST_NAME,
        "description": "Grab download manager native host",
        "path": host_path,
        "type": "stdio",
        "allowed_origins": [
            f"chrome-extension://{eid}/" for eid in extension_ids
        ],
    }


def firefox_manifest(host_path):
    return {
        "name": HOST_NAME,
        "description": "Grab download manager native host",
        "path": host_path,
        "type": "stdio",
        "allowed_extensions": [FIREFOX_ADDON_ID],
    }


def write_manifest(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(data, f, indent=2)
        f.write("\n")
    print(f"wrote {path}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--chromium-id", action="append", default=[],
                    help="Chromium extension ID to allow (repeatable)")
    ap.add_argument("--no-firefox", action="store_true",
                    help="skip the Firefox manifest")
    args = ap.parse_args()

    os.makedirs(INSTALL_DIR, exist_ok=True)
    shutil.copy2(HOST_SRC, HOST_DST)
    os.chmod(HOST_DST, 0o755)
    print(f"installed host to {HOST_DST}")

    installed = 0

    if args.chromium_id:
        for cfg in CHROMIUM_CONFIG_DIRS:
            d = os.path.expanduser(cfg)
            if not os.path.isdir(d):
                continue
            target = os.path.join(
                d, "NativeMessagingHosts", HOST_NAME + ".json")
            write_manifest(target,
                           chromium_manifest(HOST_DST, args.chromium_id))
            installed += 1

    if not args.no_firefox:
        target = os.path.expanduser(
            "~/.mozilla/native-messaging-hosts/" + HOST_NAME + ".json")
        write_manifest(target, firefox_manifest(HOST_DST))
        installed += 1

    if installed == 0:
        print("warning: no browser config dir found; "
              "host installed but no manifest written", file=sys.stderr)
    print("done")


if __name__ == "__main__":
    main()
