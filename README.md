# Grab Browser Extension

Sends browser downloads and links to the [Grab](https://github.com/Linuxuser67/Grab)
download manager (MV3, Chromium and Firefox).

[![Get it on FlatPark](assets/get-it-on-flatpark.png)](https://flatpark.org/apps/io.github.linuxuser67.Grab/)
[![Get it for Firefox](assets/get-it-on-firefox.png)](https://addons.mozilla.org/en-US/firefox/addon/grab-extension/)

_Grab 4.7.1 or newer required — install it from FlatPark via the badge above._

## Install

### From a release zip

1. Download `grab-extension-v1.2.2.zip` (Chromium/Brave) or
   `grab-extension-firefox-v1.2.2.zip` (Firefox) from the
   [releases page](https://github.com/Linuxuser67/Grab-browser-extension/releases).
2. Extract it, then load it in your browser:
   - Chromium/Brave: open `chrome://extensions`, enable **Developer mode**,
     **Load unpacked** → select the extracted folder. Copy the extension ID
     shown under its name.
   - Firefox: open `about:debugging#/runtime/this-firefox`, **Load Temporary
     Add-on** → select the `manifest.json` inside the extracted folder.
3. Install the native messaging host (required for automatic interception).
   With Grab 5.2.3+, no Python needed:
   ```
   grab --install-browser-host --chromium-id <your-extension-id>
   ```
   On older Grab, use the bundled installer from the extracted folder:
   ```
   cd <extracted-folder>
   python3 ./native-host/install.py --chromium-id <your-extension-id>
   ```
   For Firefox, no ID is needed — the add-on ID is fixed
   (`grab@linuxuser67.github.io`).

### Developer mode (from source)

1. Clone the repo and open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select the repo folder. Copy the extension ID shown
   under its name (unpacked installs get a generated ID — it stays stable
   as long as the folder path doesn't change).
3. Install the native messaging host:
   - Grab 5.2.3+: `grab --install-browser-host --chromium-id <your-extension-id>`
   - Older Grab: `python3 ./native-host/install.py --chromium-id <your-extension-id>`

The host script hands `grab://` URLs to the OS directly, bypassing the
browser's external-protocol prompt.

Grab must be installed with its desktop entry (it registers as the
`x-scheme-handler/grab` handler). Requires Grab 4.7.1 or newer (the handoff
carries the original http/https scheme, which older versions don't read).

## What it does

- **Automatic interception** (on by default): downloads started in the browser
  are cancelled and opened in Grab instead via the native messaging host.
  If the host isn't installed, downloads stay in the browser untouched.
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
- Automatic interception requires the native messaging host (see Install).
  Without it, downloads stay in the browser.

## Permissions

`downloads` (cancel intercepted downloads), `contextMenus`, `storage`
(settings), `alarms` (size-wait deadlines that survive worker restarts),
`activeTab` (read the current tab's URL for `Alt+G`), `webRequest` (spot
video stream manifests), `nativeMessaging` (hand off to Grab without a
browser prompt), host access to http/https pages (video detection).
