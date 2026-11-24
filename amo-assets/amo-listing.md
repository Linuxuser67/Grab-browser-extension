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

**Permissions:** the `downloads` permission supports automatic download interception, which is off by default and only takes over when enabled and paired with Grab. Video detection requests the optional `webRequest` permission and optional site access when enabled. On every HTTP(S) site where you grant access, its content script and network listener can inspect page media and matching requests; there is currently no per-site exclusion list. Cookie forwarding requests the optional `cookies` permission and optional site access when paired. The only host permission granted at install is limited to the local Grab endpoint (`http://127.0.0.1/*`).

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

Why the permissions: the `downloads` permission lets the extension observe
and cancel browser downloads for automatic interception. Interception is off
by default and a browser download is cancelled only after the paired Grab
instance accepts it. The optional `webRequest` permission and optional
`http://*/*`/`https://*/*` host access support video detection by allowing
frame content scripts and HLS/DASH response observation. The optional
`cookies` permission plus optional site access allow the extension to read
unpartitioned site cookies for a paired handoff when cookie forwarding is
enabled. The only host permission granted at install is `http://127.0.0.1/*`,
used for the local Grab handshake and handoff. URLs are POSTed to Grab's local
HTTP endpoint (`127.0.0.1:9412`) or handed to the `grab://` OS scheme handler;
no analytics or remote extension service is used.

## Checklist

- [ ] Upload `grab-extension-firefox-<tag>.zip` as the new version
- [ ] Upload `grab-icon-128.png` as custom icon
- [ ] Upload both screenshots
- [ ] Paste Summary + Description + Version notes
- [ ] Set license to GPLv3, support URL to the GitHub repo
- [ ] Paste review notes
