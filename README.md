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

No native host setup needed. Everything is handed to Grab through its local
endpoint (`http://127.0.0.1:9412/add`): automatic interception, `Alt+G`, the
context menu and the video menu. If Grab isn't running, `Alt+G` and the
context menu fall back to a `grab://` URL, which the browser routes to Grab via
the OS scheme handler (that route cannot carry cookies).

### Developer mode (from source)

1. Clone the repo and open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select the repo folder.

Grab must be installed with its desktop entry (it registers as the
`x-scheme-handler/grab` handler, used by `Alt+G` and the context menu).

## What it does

- **Automatic interception** (off by default, enable in settings, requires [pairing](#pairing-with-grab)):
  downloads started in the browser are cancelled and sent to Grab over its local HTTP endpoint. If Grab isn't
  running or doesn't accept the request, the download stays in the browser.
  Grab asks for confirmation unless auto-add is enabled in its preferences.
  If a tiny download finishes before the cancel lands, the duplicate is
  removed from the browser.
- **Toolbar button**: opens a popup with the extension settings (adapts to
  your system's light/dark theme).
- **`Alt+G`**: sends the current tab to Grab (video pages open
  the New Download card, other links download normally).
- **Right-click → Download with Grab**: on links, images, video, audio, and pages.
- **Video detection** (opt-in: turning it on asks for access to web pages, see
  [Permissions](#permissions)): currently playing videos — including site-initiated
  autoplay and streams behind `blob:` players — appear under right-click →
  **Videos detected by Grab**, with one best URL per active video and a matching
  toolbar badge count. Direct `<video>` sources take priority over network-sniffed
  media requests. Direct sources with distinct meaningful query parameters (such
  as `id=1` and `id=2`) remain separate; rotating authentication parameters are
  normalized for deduplication. Blob players use the best attributable HLS/DASH
  manifest; when no manifest is available, a fallback is allowed only for a
  complete, large media response (HTTP 200, known Content-Length, no byte range,
  and no explicit segment, ad, preview, or thumbnail marker). Segment heuristics
  apply to media files, not playlist paths; a video playlist is not rejected
  merely because its parent directory is named `audio`. Attribution uses frame
  and media-load timing; ambiguous candidates are omitted rather than guessed.
  A manifest-only fallback remains for embedded or custom players with no
  discoverable active `<video>` element; it groups known playlist variants conservatively.
  Picking a menu entry opens its URL in Grab, which probes it like any other link.
  Skipped on video platforms yt-dlp handles itself (YouTube, TikTok,
  Instagram, Facebook, X, Twitch, Vimeo, …) — a detected media URL can't
  work there, so sending the page goes through yt-dlp the usual way.
- **Options page**: same settings as the popup, in a full page (via the
  gear button in the popup header or right-click → Options).

Magnet links are passed to the OS untouched — Grab already handles `magnet:`.
`blob:` and `data:` URLs can't be handed off and always stay in the browser.

## Limitations

- Downloads that need the browser's session (logged-in direct links) forward
  the site's cookies to Grab — but only after you pair the extension (see
  below) and while the cookie-forwarding toggle is on. Unpaired, explicit sends
  (`Alt+G`, context menu) are URL-only, and automatic
  interception stays off: an unverified listener on the port must never be able
  to cancel a browser download.
- When the browser provides one, the extension forwards the
  originating page's referrer with browser downloads, context-menu link/media
  sends, and detected-video sends. Grab uses it as the HTTP `Referer` header
  for sites that check the originating page; it is sent to Grab over loopback
  and may be sent to the download host. Page sends through `Alt+G` do not
  invent a self-referrer.
- POST-form downloads hand Grab the action URL, which may not resolve to the file.
- Automatic interception requires Grab to be running. URLs longer than 2048
  characters are refused by Grab and stay in the browser.
- The browser's download is cancelled once Grab confirms it took over; if you
  decline in Grab's confirmation dialog, the download is not restored.

## Pairing with Grab

Grab listens on `127.0.0.1:9412`. Any local program could pretend to be Grab,
so the extension only sends cookies to a Grab that proves it knows a shared
secret:

1. In Grab, open Preferences → Browser extension and copy the pairing code.
2. In the extension's Options page, paste it into the Pairing section and
   click Pair. Your browser will ask for the `cookies` permission — it is
   optional and only requested here, on your click.
3. The extension verifies Grab (`/hello` challenge) before every cookie
   handoff. If verification fails, the handoff is URL-only.

If you click Regenerate in Grab's Preferences, pair again — the old code
stops working immediately.

The **Share site cookies with Grab** toggle in the same section turns cookie
forwarding off: paired handoffs stay signed but carry only the URL, and the
extension never reads the cookie store. The toggle is independent of the
pairing code — pairing or unpairing never changes it.

## Permissions

Nothing broad is granted at install time.

Always on:

| Permission | Why |
|---|---|
| `downloads` | cancel downloads Grab has taken over |
| `contextMenus` | the "Download with Grab" and detected-video items |
| `storage` | settings, the pairing code (local only), session state |
| `alarms` | size-wait deadlines that survive worker restarts |
| `activeTab` | read the current tab's URL when you press `Alt+G` or use the context menu, without access to every page |
| `scripting` | register the video detector only while detection is on |
| `http://127.0.0.1/*` | POST to Grab's local `/add` and `/inspect-hls` endpoints; HLS inspection sends the full public playlist URL, including any query string, over loopback (see [Security model](#security-model)) |

Optional, requested on your click and dropped when the feature is turned off:

| Permission | Requested when | Used for |
|---|---|---|
| access to `http://*/*`, `https://*/*` | you turn on video detection, or pair | the detector content script; reading a site's cookies |
| `webRequest` | you turn on video detection | spotting stream manifests behind `blob:` players |
| `cookies` | you pair with Grab | forwarding the site's cookies to a verified Grab |

Without them, `Alt+G`, the context menu and (once paired) automatic
interception still work; only video detection and cookie forwarding are off.
The browser's extension toolbar popup cannot show a permission prompt, so
turning video detection on from the popup opens the Options page to grant it.
Open tabs need a reload after detection is turned on.

## Security model

The extension and Grab talk over unencrypted HTTP on the loopback interface.

- Grab rejects requests whose `Host` is not its loopback name or whose
  `Origin` is not a browser extension (DNS-rebinding and web-page requests).
- Pairing: before sending cookies the extension makes Grab answer a fresh
  nonce with an HMAC of the shared secret, so a program that grabbed the port
  first cannot receive them. Every paired POST body is signed and carries a
  timestamp and one-time nonce; Grab accepts a nonce once, inside a two-minute
  window, so a captured request cannot be replayed.
- Public HLS inspection: when video detection inspects a browser-observed
  public `.m3u8` or `.m3u` playlist, the extension POSTs the full playlist
  URL—including its query string, which may contain a signed or short-lived
  access token—in a paired, HMAC-signed JSON body to
  `http://127.0.0.1:9412/inspect-hls`. This is loopback traffic; the request
  contains no cookies and suppresses the `Referer` header. Grab fetches the
  playlist through its public-only DNS guard, and its response contains only
  origin/path keys, not the source query string. Inspection results are reused
  for 10 seconds only for an identical full URL. Streams that rotate query
  parameters are inspected separately; the extension does not strip those
  parameters because they may change the playlist returned by the server.
- Unpaired, URLs are still handed off but without cookies, and automatic
  interception stays off.
- Incognito cookies are never forwarded; partitioned cookies are skipped.

Not covered: the `/hello` check and the following POST are separate requests,
so they are not bound to one connection, and the body is signed but not
encrypted. A local process that can both observe loopback traffic and bind the
port after Grab verified is outside this model (it normally needs the same
privileges that could read the cookie store directly). Binding the two
requests together would need a change in Grab as well as here.

## Known limitations of the handoff

- Grab holds `?confirm=1` requests until you answer its dialog (up to 120 s).
  Chrome documents that it stops an extension service worker when a `fetch()`
  response takes more than 30 seconds to arrive. The extension pings an
  extension API during the wait, which resets the 30 s idle timer, but it is
  not verified that this also defers the fetch rule. If Chrome does stop the
  worker, the browser's own download is left untouched (it is cancelled only
  after Grab answers), so the cost is a possible duplicate, not a lost file.
  Removing the limit needs a protocol that answers before the user does and
  lets the extension poll for the result; that is a Grab change.
- Grab's port (9412) is fixed in Grab, so the extension has no setting for it.
  When another program answers on the port, a paired extension reports
  "Running · Unverified" and sends it nothing.
