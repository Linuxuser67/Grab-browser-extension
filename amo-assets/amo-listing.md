# AMO listing package — Grab Browser Extension

Prepared 2026-10-10 for the v1.3.8 submission. Submit
`grab-extension-firefox-v1.3.8.zip` (from the v1.3.8 GitHub release, published
2026-10-10T07:46:05Z, both zips attached).

## Summary (AMO "Summary" field, ≤250 chars)

Send Firefox downloads and playable videos straight to the Grab download
manager — no more juggling browser download folders.

## Description (AMO "Description" field)

**Grab Browser Extension**

Send browser downloads straight to the [Grab download manager](https://github.com/Linuxuser67/Grab) — no more juggling browser download folders.

**What it does:**
- **Automatic interception** (off by default): optionally route browser downloads to Grab instead, with size filters and file-type exclusions
- **Right-click menu**: "Download with Grab" on any link
- **Alt+G**: send the current tab's URL to Grab
- **Video detection**: finds playable videos on the page and offers them in the context menu

**How it works:**
The extension talks to Grab over a local HTTP endpoint (`127.0.0.1:9412`) — no setup, no native messaging host, works from Flatpak. If Grab isn't running, downloads stay in the browser.

**Requires:** Grab 5.7.0+ for automatic interception. Alt+G and context menu work with Grab 4.7.1+.

## Version notes (AMO "Release notes" for this version)

Fixed: popup status probe no longer triggers 'Invalid URL' toast in Grab.

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
