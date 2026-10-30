<h1><img src="src-tauri/icons/128x128.png" width="72" align="center" alt=""> yuuricloud</h1>

[![build](https://img.shields.io/github/actions/workflow/status/lrd14/yuuricloud/release.yml?label=build)](https://github.com/lrd14/yuuricloud/actions/workflows/release.yml)
[![release](https://img.shields.io/github/v/release/lrd14/yuuricloud?label=release&color=0a7bbb)](https://github.com/lrd14/yuuricloud/releases/latest)
[![downloads](https://img.shields.io/github/downloads/lrd14/yuuricloud/total?label=downloads&color=44cc11)](https://github.com/lrd14/yuuricloud/releases)
[![platforms](https://img.shields.io/badge/platforms-windows%20%7C%20macos%20%7C%20linux%20%7C%20iOS-9a9a9a)](https://github.com/lrd14/yuuricloud/releases/latest)
[![built with Tauri](https://img.shields.io/badge/built%20with-Tauri%202-24c8db?logo=tauri&logoColor=white)](https://tauri.app)

A small, fast music player for your local library, your SoundCloud and Soulseek, on Windows, macOS and Linux, plus a player for iPhone and iPad.

<p align="center"><img src="docs/preview.png" alt="yuuricloud showing a music library with album covers, and the Downloads page" width="900"></p>

Built with [Tauri 2](https://tauri.app) (Rust backend, plain HTML/CSS/JS frontend).

## Requirements

- [Rust](https://rustup.rs) (stable)
- [Node.js](https://nodejs.org) (only for the Tauri CLI)
- Platform prerequisites from https://tauri.app/start/prerequisites/
  (WebView2 is built into Windows 10/11; Linux needs `webkit2gtk-4.1` and the GStreamer plugins for audio)

## Run

```
npm install
npm run dev
```

`npm run build` makes a release build plus installers (`.msi`/`.exe` on Windows, `.dmg`/`.app` on macOS,
`.deb`/`.AppImage`/`.rpm` on Linux) in `src-tauri/target/release/bundle/`. Build on each OS you want to ship for.

## Library

Use **Add folder** to point it at your music. Artists and albums come from the folder layout first:

```
<folder>/<Artist>/<Album (1997)>/[CD1/]01 - Title.mp3
<folder>/<Artist - Album>/01 Title.flac
```

File tags fill in anything the folders don't say (title, track number, year, length). In the **⋮** menu,
turn on **Prefer file tags over folder names** if your tags are cleaner than your folders.

Album covers come from `cover.jpg` / `folder.jpg` / `front.jpg` in the album folder, or from art embedded in the
files. The scanned library is cached in the app data folder, so rescans only re-read files that changed.

Supported formats: mp3, flac, m4a/aac, ogg, opus, wav (whatever the system webview can decode).

## Controls

- Double-click a song, album, or artist to play it
- Space: play/pause · Ctrl+←/→: previous/next · ↑/↓ + Enter: pick a song · Ctrl+F: search · F5: rescan · Ctrl+,: settings

## Settings

The gear button (or Ctrl+,) opens settings: accent color, background blur and darkness, cover and interface size,
compact song list, always-on-top, animation on/off and speed, ambient cover glow, a SoundCloud-style waveform seek bar, playing indicator, hover effects,
library folders and sorting, single-click play, play/pause fades, and remembering shuffle/repeat. They're saved with
the rest of the app's settings.

**Resume where you left off** (Playback tab, on by default) reopens the same song, position, queue, shuffle/repeat,
search and artist/album you had when the app closed. The song comes back paused.

### SoundCloud

The **SoundCloud** switch in the title bar shows your SoundCloud likes, your own and liked playlists, and
SoundCloud search. These play in the same player as local songs, with the same queue, shuffle, waveform, cover colors,
Last.fm and Discord.

To connect, go to Settings → Integrations and click **Connect**, then approve access in the browser. The page says
when it's done, and the app picks it up by itself.

By default this uses yuuricloud's shared SoundCloud app. Its Client Secret lives in a small Cloudflare Worker,
not in the app; see [soundcloud-proxy/README.md](soundcloud-proxy/README.md) for deploying it. Until the Worker's
address is set in `BUILTIN_TOKEN_PROXY` in `src-tauri/src/soundcloud.rs`, everyone needs their own app keys.

**Your own SoundCloud app (optional).** Registering an app needs an **Artist Pro** subscription.

1. At https://soundcloud.com/you/apps, set the app's redirect URI to `http://127.0.0.1:8974/callback`.
2. Under **Use your own SoundCloud app** in the settings, paste its Client ID and Client Secret, then click
   **Save keys**.
3. Click **Connect**.

To go back to the shared app, clear both keys and save.

**Downloading.** Right-click a SoundCloud song and choose **Download**. To save a whole list, right-click Likes, a
playlist or search results in the left panel and choose **Download all**. Files are named "Artist - Title" and get
title, artist and cover tags. They go to `Music/SoundCloud` (change it in Settings → Integrations) and show up in
your library on their own.

- **Songs the artist allows downloads for** are saved straight from SoundCloud, often as the original upload (WAV,
  FLAC and so on).
- **Any other song** needs [yt-dlp](https://github.com/yt-dlp/yt-dlp#installation). Turn on **Use yt-dlp for other
  songs**, then either click **Download for me** (yuuricloud fetches the latest yt-dlp from its GitHub releases) or
  install it yourself and paste its path. This is off by default, because saving songs the artist hasn't made
  downloadable is against SoundCloud's terms.

How it works:

- Searching: in the SoundCloud view, typing filters the list on screen, and **Enter** searches all of SoundCloud.
- Playback: each song is downloaded to a small cache before it plays, so there's a short wait at the start. The
  next song in the queue downloads ahead, and only the last 8 songs are kept.
- Go+ and region-locked songs: tracks SoundCloud marks as preview play 30 seconds. Blocked and copy-protected
  tracks are greyed out or skipped.

### Soulseek

The Soulseek tab searches the [Soulseek](https://www.slsknet.org) file-sharing network and downloads what you pick.
It works through [slskd](https://github.com/slskd/slskd), a free Soulseek program:

1. Settings → Integrations → Soulseek: click **Download for me** to get slskd (or **Browse…** to use a copy you have).
2. Enter your Soulseek username and password. A name nobody has taken yet becomes a new free account the first
   time you connect.
3. Click **Connect**. yuuricloud runs slskd hidden in the background and stops it when you quit.

Then type in the search box and press **Enter**. Results show who has each file, the folder it's in and its
quality; users with a free upload slot and fast connections come first. **Double-click** a result (or press
**Enter**) to download it, or right-click for **Download whole folder**. Downloads show on the Downloads page and
land in `Music/Soulseek`, and show up in your library on their own as they finish.

- Your Soulseek download folder is always shared, and **Share my music library** shares your library folders too.
  Many Soulseek users won't send files to people who share nothing.
- The listening port is picked automatically. If you forward a port on your router, enter it under **Listening port**.
- Already run slskd yourself? Turn off **Run slskd for me** and enter its address and an API key instead.
- Soulseek is legal, but much of what's shared on it is copyrighted. What you download or share is your
  responsibility.

"Download for me" (for yt-dlp and slskd) fetches the latest official release from GitHub into the app data folder
and checks it against the SHA-256 checksum GitHub publishes before using it.

### Last.fm

Settings → Integrations → Last.fm: click **Connect**, approve access in the browser, then click **I've approved it**.

By default this uses yuuricloud's shared Last.fm API account. Last.fm signs every scrobble with the account's shared
secret, so those calls go through the same Cloudflare Worker as SoundCloud's sign-in, which adds the signature; see
[soundcloud-proxy/README.md](soundcloud-proxy/README.md). Until `BUILTIN_LASTFM_KEY` in
`src-tauri/src/integrations.rs` is set, everyone needs their own API account.

**Your own API account (optional).** Create one at https://www.last.fm/api/account/create (any name works), then
under **Use your own Last.fm API account** paste its key and shared secret and click **Save keys**.

Songs scrobble after half their length or 4 minutes (whichever comes first); songs under 30 seconds don't count.

### Discord

1. Create an application at https://discord.com/developers/applications. Its name is what your status shows
   ("Listening to yuuricloud").
2. Settings → Integrations: paste its Application ID and turn on **Show listening status**. Discord must be running.

When Last.fm is available, the status also shows the album cover from Last.fm (Discord can't show local images).

Keys, the Last.fm session, the SoundCloud login and the Soulseek login are stored in `settings.json` in the app
data folder.
- OS media keys work where the webview supports the Media Session API

## iPhone and iPad

The iOS version plays your music and your SoundCloud. Soulseek, downloads and Discord stay on the computer.

- **Install:** each release has a `yuuricloud_x.y.z_iOS-unsigned.ipa`. Install it with [AltStore](https://altstore.io) or
  [SideStore](https://sidestore.io), which sign it with your Apple ID (with a free Apple ID, reinstall it every 7 days).
- **Music:** copy songs into yuuricloud's folder: in the Files app it's **On My iPhone → yuuricloud**; from a computer,
  drag them onto yuuricloud in the iPhone's Files tab in Finder (or the Apple Devices app on Windows). New songs show up
  when you come back to the app.
- **SoundCloud:** on the computer, open Settings → Integrations → SoundCloud and click **Link phone…**. After approving
  in the browser, scan the QR code with the iPhone's camera, or copy the code and paste it on the phone. The phone gets a
  login of its own; the computer stays signed in. Anyone with the code can use your account, so don't share it.
- On a phone the library shows one panel at a time: tap to play, hold a song for its menu. An unfolded iPhone Duo and
  iPads show all three panels.

The `iOS` workflow builds the .ipa on GitHub's Macs (also runnable by hand from the Actions tab).

## Layout

- `src/` – the UI (`index.html`, `style.css`, `main.js`)
- `src-tauri/src/library.rs` – folder scanning, tag reading, artist/album inference (`cargo test` covers the folder rules)
- `src-tauri/src/main.rs` – Tauri commands the UI calls
- `src-tauri/src/soundcloud.rs` – SoundCloud sign-in, API calls and stream downloads
- `src-tauri/src/slsk.rs` – runs slskd and talks to its API for Soulseek search and downloads
- `src-tauri/src/tools.rs` – "Download for me": installs yt-dlp and slskd from their GitHub releases
