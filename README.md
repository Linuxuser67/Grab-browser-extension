# Grab Browser Extension

Sends browser downloads and links to the [Grab](https://github.com/Linuxuser67/Grab)
download manager (MV3, Chromium and Firefox).

[![Get it on FlatPark](assets/get-it-on-flatpark.png)](https://flatpark.org/apps/io.github.linuxuser67.Grab/)
[![Get it for Firefox](assets/get-it-on-firefox.png)](https://addons.mozilla.org/en-US/firefox/addon/grab-extension/)

_Grab 5.7.0 or newer required for automatic interception (it uses Grab's local HTTP endpoint); `Alt+G` and the context menu work with 4.7.1+. Install Grab from FlatPark via the badge above._

## Install

### From a release zip

1. Download `grab-extension-<version>.zip` (Chromium/Brave) or
   `grab-extension-firefox-<version>.zip` (Firefox) from the
   [releases page](https://github.com/Linuxuser67/Grab-browser-extension/releases).
2. Extract it, then load it in your browser:
   - Chromium/Brave: open `chrome://extensions`, enable **Developer mode**,
     **Load unpacked** → select the extracted folder.
   - Firefox: open `about:debugging#/runtime/this-firefox`, **Load Temporary
     Add-on** → select the `manifest.json` inside the extracted folder.

No native host setup needed. Automatic interception posts each URL to Grab's
local endpoint (`http://127.0.0.1:9412/add`); `Alt+G` and the context menu hand
`grab://` URLs to the browser, which routes them to Grab via the OS scheme
handler.

### Developer mode (from source)

1. Clone the repo and open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select the repo folder.

Grab must be installed with its desktop entry (it registers as the
`x-scheme-handler/grab` handler, used by `Alt+G` and the context menu).

## What it does

- **Automatic interception** (off by default, enable in settings): downloads started in the browser
  are cancelled and sent to Grab over its local HTTP endpoint. If Grab isn't
  running or doesn't accept the request, the download stays in the browser.
  Grab asks for confirmation unless auto-add is enabled in its preferences.
  If a tiny download finishes before the cancel lands, the duplicate is
  removed from the browser.
- **Toolbar button**: opens a popup with the extension settings (adapts to
  your system's light/dark theme).
- **`Alt+G`**: sends the current tab to Grab (video pages open
  the New Download card, other links download normally).
- **Right-click → Download with Grab**: on links, images, video, audio, and pages.
- **Video detection** (on by default): videos playing in the tab — including
  streams behind `blob:` players — appear under right-click →
  **Videos detected by Grab**, with a count badge on the toolbar button.
  Picking one opens it in Grab, which probes it like any other link.
  Skipped on video platforms yt-dlp handles itself (YouTube, TikTok,
  Instagram, Facebook, X, Twitch, Vimeo, …) — a detected media URL can't
  work there, so sending the page goes through yt-dlp the usual way.
- **Options page**: same settings as the popup, in a full page (via the
  popup's "Full options page" link or right-click → Options).

Magnet links are passed to the OS untouched — Grab already handles `magnet:`.
`blob:` and `data:` URLs can't be handed off and always stay in the browser.

## Limitations

- Downloads that need the browser's session (logged-in direct links) may fail
  in Grab — the extension doesn't forward cookies.
- POST-form downloads hand Grab the action URL, which may not resolve to the file.
- Automatic interception requires Grab to be running. URLs longer than 2048
  characters are refused by Grab and stay in the browser.
- The browser's download is cancelled as soon as Grab accepts the URL; if you
  then decline in Grab's confirmation dialog, the download is not restored.

## Permissions

`downloads` (cancel intercepted downloads), `contextMenus`, `storage`
(settings), `alarms` (size-wait deadlines that survive worker restarts),
`activeTab` (read the current tab's URL for `Alt+G`), `webRequest` (spot
video stream manifests), host access to http/https pages (video detection;
also lets the background script POST to Grab's loopback endpoint).
