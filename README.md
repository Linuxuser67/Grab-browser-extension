# Grab Browser Extension

Sends browser downloads and links to the [Grab](https://github.com/Linuxuser67/Grab)
download manager (MV3, Chromium-based browsers).

## Install (developer mode)

1. Open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select this folder.
3. First use: the browser asks which app opens `grab://` links — pick Grab and
   tick **Always allow** so the prompt doesn't return.

Grab must be installed with its desktop entry (it registers as the
`x-scheme-handler/grab` handler).

## What it does

- **Automatic interception** (on by default): downloads started in the browser
  are cancelled and opened in Grab instead. If a tiny download finishes before
  the cancel lands, the duplicate is removed from the browser.
- **Toolbar button / `Alt+G`**: sends the current tab to Grab (video pages open
  the New Download card, other links download normally).
- **Right-click → Download with Grab**: on links, images, video, audio, and pages.
- **Options page**: turn interception on/off, set a minimum download size
  (smaller downloads stay in the browser), set file types the browser keeps
  handling itself (e.g. `pdf, jpg`), toggle the context menu.

Magnet links are passed to the OS untouched — Grab already handles `magnet:`.
`blob:` and `data:` URLs can't be handed off and always stay in the browser.

## Limitations

- Downloads that need the browser's session (logged-in direct links) may fail
  in Grab — the extension doesn't forward cookies.
- POST-form downloads hand Grab the action URL, which may not resolve to the file.

## Permissions

`downloads` (cancel intercepted downloads), `contextMenus`, `storage`
(settings), `activeTab` (read the current tab's URL when you click the button).
