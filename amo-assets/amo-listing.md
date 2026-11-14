# AMO listing package — Grab Browser Extension

Template for each AMO submission. Before submitting, take the version from
`manifest.json`, attach the `grab-extension-firefox-<tag>.zip` from the matching
GitHub release, and replace the release notes below. (This file previously
named a single release; it now describes the current feature set instead, so it
cannot go stale on every version bump.)

## Summary (AMO "Summary" field, ≤250 chars)

Send Firefox downloads and playable videos straight to the Grab download
manager — no more juggling browser download folders.

## Description (AMO "Description" field)

**Grab Browser Extension**

Send browser downloads straight to the [Grab download manager](https://github.com/Linuxuser67/Grab) — no more juggling browser download folders.

**What it does:**
- **Automatic interception** (off by default, needs pairing): optionally route browser downloads to Grab instead, with size filters and file-type exclusions
- **Right-click menu**: "Download with Grab" on any link
- **Alt+G**: send the current tab's URL to Grab
- **Video detection** (opt-in): finds playable videos on the page and offers them in the context menu

**How it works:**
The extension talks to Grab over a local HTTP endpoint (`127.0.0.1:9412`) — no setup, no native messaging host, works from Flatpak. If Grab isn't running, downloads stay in the browser.

**Permissions:** nothing broad is granted at install. Video detection asks for access to web pages and network requests only when you turn it on; pairing with Grab asks for access to cookies and web pages only when you pair, so a logged-in download can carry your session. Each is dropped again when the feature is turned off. No data leaves your computer: the extension only talks to Grab on 127.0.0.1.

**Requires:** Grab 5.7.0+ for automatic interception. Alt+G and context menu work with Grab 4.7.1+.

## Version notes (AMO "Release notes" for this version)

<replace with this release's notes>

## Other AMO fields

- **Icon**: `grab-icon-128.png` (128×128, in this folder)
- **Screenshots**: `screenshot-1-popup.png`, `screenshot-2-context-menu.png` (1920×1280)
- **License**: GNU GPLv3 (LICENSE file in repo root — select GPLv3 in AMO)
- **Support URL**: https://github.com/Linuxuser67/Grab
- **Homepage**: https://github.com/Linuxuser67/Grab

## Review notes (for the AMO reviewer)

Why the broad permissions: content scripts run on all frames to detect
playable videos (HLS/DASH manifest sniffing) for the context menu; host
permissions `http://*/*`/`https://*/*` plus webRequest support the optional
automatic download interception (downloads are cancelled and re-routed to
Grab, only when the user enables it — it is off by default). All network
traffic stays on the user's own machine: URLs are POSTed to Grab's local
HTTP endpoint (`127.0.0.1:9412`) or handed to the `grab://` OS scheme
handler. No data leaves the user's computer; no analytics, no remote
servers.

## Checklist

- [ ] Upload `grab-extension-firefox-v1.3.8.zip` as the new version
- [ ] Upload `grab-icon-128.png` as custom icon
- [ ] Upload both screenshots
- [ ] Paste Summary + Description + Version notes
- [ ] Set license to GPLv3, support URL to the GitHub repo
- [ ] Paste review notes
