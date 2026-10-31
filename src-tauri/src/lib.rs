//! The app itself. `main.rs` starts it on desktop; on iOS, Xcode links this library and calls
//! `run` through the mobile entry point.

mod cover_color;
mod downloads;
mod editor;
mod integrations;
mod library;
mod slsk;
mod slsk_native;
mod soundcloud;
mod tools;
mod waveform;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use integrations::{Discord, NowPlaying};
use library::{Settings, Track};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

struct AppState {
    data_dir: PathBuf,
    settings: Mutex<Settings>,
    tracks: Mutex<Vec<Track>>,
    scanning: AtomicBool,
    lastfm_token: Mutex<Option<String>>,
    discord: Mutex<Discord>,
    /// "artist\0album" -> Last.fm cover URL (None when Last.fm has no image)
    art_cache: Mutex<HashMap<String, Option<String>>>,
    /// cover path -> accent color picked from it
    cover_colors: Mutex<HashMap<String, Option<String>>>,
    /// set to stop waiting for the SoundCloud sign-in
    sc_cancel: AtomicBool,
    /// Phones: the sign-in waiting for SoundCloud to send the browser back (its state, and where
    /// to hand the reply), see `sc_connect` and `open_links`.
    #[cfg(mobile)]
    sc_phone_sign_in: Mutex<Option<(String, std::sync::mpsc::Sender<Result<String, String>>)>>,
    /// held while refreshing the SoundCloud token, so two calls don't refresh at once
    sc_auth: Mutex<()>,
    /// set to stop the SoundCloud download in progress
    dl_cancel: AtomicBool,
    /// set to stop a "Download for me" in progress
    tool_cancel: AtomicBool,
    /// the slskd yuuricloud is using for Soulseek, once connected
    slsk: Mutex<Option<std::sync::Arc<slsk::Conn>>>,
    /// held while slskd starts, so two clicks don't start two copies
    slsk_starting: Mutex<()>,
}

impl AppState {
    fn save_settings(&self, settings: &Settings) {
        library::save_json(&self.settings_file(), settings);
    }
}

impl AppState {
    fn settings_file(&self) -> PathBuf {
        self.data_dir.join("settings.json")
    }
    fn library_file(&self) -> PathBuf {
        self.data_dir.join("library.json")
    }
    fn cover_dir(&self) -> PathBuf {
        self.data_dir.join("covers")
    }
    fn sc_stream_dir(&self) -> PathBuf {
        self.data_dir.join("soundcloud-cache")
    }
    fn tools_dir(&self) -> PathBuf {
        self.data_dir.join("tools")
    }
}

#[derive(Serialize)]
struct Snapshot {
    settings: Settings,
    tracks: Vec<Track>,
}

/// Let the webview load audio and images from this folder via the asset protocol.
fn allow_dir(app: &AppHandle, dir: &Path) {
    let _ = app.asset_protocol_scope().allow_directory(dir, true);
}

#[tauri::command]
fn get_library(state: State<AppState>) -> Snapshot {
    Snapshot {
        settings: state.settings.lock().unwrap().clone(),
        tracks: state.tracks.lock().unwrap().clone(),
    }
}

/// Ask for a folder. Phones have no folder picker: their music lives in the app's own folder.
fn pick_folder(app: &AppHandle, title: &str) -> Result<Option<PathBuf>, String> {
    #[cfg(desktop)]
    {
        let Some(picked) = app.dialog().file().set_title(title).blocking_pick_folder() else {
            return Ok(None);
        };
        picked.into_path().map(Some).map_err(|e| e.to_string())
    }
    #[cfg(mobile)]
    {
        let _ = (app, title);
        Err("Folders can't be picked on a phone".into())
    }
}

#[tauri::command]
async fn add_folder(app: AppHandle, state: State<'_, AppState>) -> Result<Option<Settings>, String> {
    let Some(path) = pick_folder(&app, "Choose a music folder")? else {
        return Ok(None);
    };
    allow_dir(&app, &path);
    let folder = path.to_string_lossy().into_owned();
    let mut settings = state.settings.lock().unwrap();
    if !settings.folders.contains(&folder) {
        settings.folders.push(folder);
        library::save_json(&state.settings_file(), &*settings);
    }
    Ok(Some(settings.clone()))
}

#[tauri::command]
fn remove_folder(state: State<AppState>, folder: String) -> Snapshot {
    let mut settings = state.settings.lock().unwrap();
    settings.folders.retain(|f| *f != folder);
    library::save_json(&state.settings_file(), &*settings);
    let mut tracks = state.tracks.lock().unwrap();
    tracks.retain(|t| t.root != folder);
    library::save_json(&state.library_file(), &*tracks);
    Snapshot { settings: settings.clone(), tracks: tracks.clone() }
}

#[tauri::command]
fn set_volume(state: State<AppState>, volume: f64) {
    let mut settings = state.settings.lock().unwrap();
    settings.volume = volume.clamp(0.0, 1.0);
    library::save_json(&state.settings_file(), &*settings);
}

#[tauri::command]
fn set_prefer_tags(state: State<AppState>, prefer: bool) {
    let mut settings = state.settings.lock().unwrap();
    settings.prefer_tags = prefer;
    library::save_json(&state.settings_file(), &*settings);
}

#[tauri::command]
fn set_ui(state: State<AppState>, ui: serde_json::Value) {
    let mut settings = state.settings.lock().unwrap();
    settings.ui = ui;
    library::save_json(&state.settings_file(), &*settings);
}

// ---------------------------------------------------------------- Last.fm

/// Run blocking network work off the async runtime's worker threads.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

#[tauri::command]
fn lastfm_set_keys(state: State<AppState>, api_key: String, api_secret: String) -> Settings {
    let mut s = state.settings.lock().unwrap();
    if s.lastfm.api_key != api_key.trim() || s.lastfm.api_secret != api_secret.trim() {
        // a session belongs to the key it was made with
        s.lastfm.session_key.clear();
        s.lastfm.username.clear();
    }
    s.lastfm.api_key = api_key.trim().to_string();
    s.lastfm.api_secret = api_secret.trim().to_string();
    state.save_settings(&s);
    s.clone()
}

/// Step 1 of connecting: get a token and open the Last.fm approval page in the browser.
#[tauri::command]
async fn lastfm_begin_auth(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let cfg = state.settings.lock().unwrap().lastfm.clone();
    let token = blocking({
        let cfg = cfg.clone();
        move || integrations::lastfm_get_token(&cfg)
    })
    .await?;
    let url = integrations::lastfm_auth_url(&cfg, &token);
    *state.lastfm_token.lock().unwrap() = Some(token);
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
}

/// Step 2: after the user approved in the browser, turn the token into a session.
#[tauri::command]
async fn lastfm_finish_auth(state: State<'_, AppState>) -> Result<Settings, String> {
    let token = state.lastfm_token.lock().unwrap().clone().ok_or("Click Connect first")?;
    let cfg = state.settings.lock().unwrap().lastfm.clone();
    let (name, key) = blocking(move || integrations::lastfm_get_session(&cfg, &token)).await?;
    *state.lastfm_token.lock().unwrap() = None;
    let mut s = state.settings.lock().unwrap();
    s.lastfm.username = name;
    s.lastfm.session_key = key;
    s.lastfm.scrobble = true;
    state.save_settings(&s);
    Ok(s.clone())
}

/// Whether the shared Last.fm account is set up, so users can connect without their own keys.
#[tauri::command]
fn lastfm_builtin() -> bool {
    integrations::lastfm_builtin_available()
}

#[tauri::command]
fn lastfm_disconnect(state: State<AppState>) -> Settings {
    let mut s = state.settings.lock().unwrap();
    s.lastfm.session_key.clear();
    s.lastfm.username.clear();
    state.save_settings(&s);
    s.clone()
}

#[tauri::command]
fn lastfm_set_scrobble(state: State<AppState>, enabled: bool) {
    let mut s = state.settings.lock().unwrap();
    s.lastfm.scrobble = enabled;
    state.save_settings(&s);
}

fn scrobbling_config(state: &AppState) -> Option<integrations::LastfmConfig> {
    let cfg = state.settings.lock().unwrap().lastfm.clone();
    (cfg.scrobble && !cfg.session_key.is_empty()).then_some(cfg)
}

#[tauri::command]
async fn lastfm_now_playing(state: State<'_, AppState>, track: NowPlaying) -> Result<(), String> {
    let Some(cfg) = scrobbling_config(&state) else { return Ok(()) };
    blocking(move || integrations::lastfm_now_playing(&cfg, &track)).await
}

#[tauri::command]
async fn lastfm_scrobble(state: State<'_, AppState>, track: NowPlaying, started_at: i64) -> Result<(), String> {
    let Some(cfg) = scrobbling_config(&state) else { return Ok(()) };
    blocking(move || integrations::lastfm_scrobble(&cfg, &track, started_at)).await
}

// ---------------------------------------------------------------- Discord

#[tauri::command]
fn discord_set(state: State<AppState>, enabled: bool, client_id: String) -> Settings {
    let mut s = state.settings.lock().unwrap();
    s.discord.enabled = enabled;
    s.discord.client_id = client_id.trim().to_string();
    state.save_settings(&s);
    if !enabled {
        state.discord.lock().unwrap().disconnect();
    }
    s.clone()
}

/// Update the Discord status. `track: None` clears it.
#[tauri::command]
async fn discord_update(
    app: AppHandle,
    track: Option<NowPlaying>,
    playing: bool,
    position: f64,
) -> Result<(), String> {
    blocking(move || {
        let state = app.state::<AppState>();
        let (discord_cfg, lastfm_cfg) = {
            let s = state.settings.lock().unwrap();
            (s.discord.clone(), s.lastfm.clone())
        };
        if !discord_cfg.enabled || discord_cfg.client_id.is_empty() {
            return Ok(());
        }
        let Some(track) = track else {
            state.discord.lock().unwrap().clear();
            return Ok(());
        };

        // Discord can't show local files, so borrow the cover from Last.fm when a key is set.
        // SoundCloud songs bring their own artwork URL.
        let image = if track.image.is_some() {
            track.image.clone()
        } else if !lastfm_cfg.has_key() {
            None
        } else {
            let key = format!("{}\0{}", track.album_artist, track.album);
            let cached = state.art_cache.lock().unwrap().get(&key).cloned();
            cached.unwrap_or_else(|| {
                let url = integrations::lastfm_album_art(&lastfm_cfg, &track.album_artist, &track.album);
                state.art_cache.lock().unwrap().insert(key, url.clone());
                url
            })
        };

        let result = state.discord.lock().unwrap().show(&discord_cfg.client_id, &track, playing, position, image.as_deref());
        result
    })
    .await
}

/// Loudness peaks (0..1) for the waveform seek bar. Only songs in the library are read.
#[tauri::command]
async fn waveform(state: State<'_, AppState>, path: String, bins: usize) -> Result<Vec<f32>, String> {
    if !state.tracks.lock().unwrap().iter().any(|t| t.path == path) {
        return Err("Not a library song".into());
    }
    let cache_dir = state.data_dir.join("waveforms");
    blocking(move || waveform::load_or_compute(Path::new(&path), bins, &cache_dir)).await
}

/// An accent color (#rrggbb) taken from a cover image, or None for colorless covers.
#[tauri::command]
async fn cover_accent(app: AppHandle, cover: String) -> Result<Option<String>, String> {
    blocking(move || {
        let state = app.state::<AppState>();
        if let Some(hit) = state.cover_colors.lock().unwrap().get(&cover) {
            return Ok(hit.clone());
        }
        let color = if cover.starts_with("https://") {
            soundcloud::artwork_file(&cover, &state.data_dir.join("soundcloud-art"))
                .and_then(|file| cover_color::accent_from_cover(&file))
        } else if state.tracks.lock().unwrap().iter().any(|t| t.cover == cover) {
            cover_color::accent_from_cover(Path::new(&cover))
        } else {
            None
        };
        state.cover_colors.lock().unwrap().insert(cover, color.clone());
        Ok(color)
    })
    .await
}

/// Add (`on`) or remove a favourite song. Returns the new list.
#[tauri::command]
fn set_favorite(state: State<AppState>, path: String, on: bool) -> Vec<String> {
    let mut s = state.settings.lock().unwrap();
    s.favorites.retain(|p| *p != path);
    if on {
        s.favorites.push(path);
    }
    state.save_settings(&s);
    s.favorites.clone()
}

/// Show a library song in the system file manager.
#[tauri::command]
fn reveal_file(app: AppHandle, state: State<AppState>, path: String) -> Result<(), String> {
    if !state.tracks.lock().unwrap().iter().any(|t| t.path == path) {
        return Err("Not a library song".into());
    }
    app.opener().reveal_item_in_dir(&path).map_err(|e| e.to_string())
}

/// The app icons the user can pick between (Settings → Appearance). They live with the
/// frontend so the titlebar can show the same image.
const APP_ICONS: &[(&str, &[u8])] = &[
    ("yuuri", include_bytes!("../../src/icons/app-yuuri.png")),
    ("cloud", include_bytes!("../../src/icons/app-cloud.png")),
];

/// Swap the window and taskbar icon while the app runs.
#[tauri::command]
fn set_app_icon(app: AppHandle, name: String) -> Result<(), String> {
    let bytes = APP_ICONS.iter().find(|(n, _)| *n == name).ok_or("Unknown icon")?.1;
    let icon = tauri::image::Image::from_bytes(bytes).map_err(|e| e.to_string())?;
    let window = app.get_webview_window("main").ok_or("No main window")?;
    #[cfg(desktop)]
    return window.set_icon(icon).map_err(|e| e.to_string());
    #[cfg(mobile)]
    {
        let _ = (window, icon);
        Err("The home screen icon can't change".into())
    }
}

// ------------------------------------------------------------- SoundCloud

#[tauri::command]
fn sc_set_keys(state: State<AppState>, client_id: String, client_secret: String, redirect_uri: String) -> Settings {
    let mut s = state.settings.lock().unwrap();
    let sc = &mut s.soundcloud;
    if sc.client_id != client_id.trim() || sc.client_secret != client_secret.trim() {
        // tokens belong to the app they were made with
        *sc = soundcloud::ScConfig::default();
    }
    sc.client_id = client_id.trim().to_string();
    sc.client_secret = client_secret.trim().to_string();
    let redirect_uri = redirect_uri.trim();
    sc.redirect_uri = if redirect_uri == soundcloud::DEFAULT_REDIRECT_URI { String::new() } else { redirect_uri.to_string() };
    state.save_settings(&s);
    s.clone()
}

/// Open SoundCloud's approval page and wait for the browser to come back.
#[tauri::command]
async fn sc_connect(app: AppHandle) -> Result<Settings, String> {
    blocking(move || {
        let state = app.state::<AppState>();
        state.sc_cancel.store(false, Ordering::Relaxed);
        let open = |url: &str| app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string());
        #[cfg(desktop)]
        let cfg = soundcloud::connect(&state.settings.lock().unwrap().soundcloud.clone(), open, &state.sc_cancel)?;
        #[cfg(mobile)]
        let cfg = phone_sign_in(&state, open)?;
        let mut s = state.settings.lock().unwrap();
        s.soundcloud = cfg;
        state.save_settings(&s);
        Ok(s.clone())
    })
    .await
}

/// Phones: sign in through Safari. A phone app can't listen for the browser coming back the way
/// the computer does, so the proxy sends it back as a `yuuricloud://soundcloud-auth` link, which
/// `open_links` hands to the waiting sign-in here.
#[cfg(mobile)]
fn phone_sign_in(state: &AppState, open: impl Fn(&str) -> Result<(), String>) -> Result<soundcloud::ScConfig, String> {
    // Only the shared app can come back to a phone, so it signs in with that even when a link code
    // from a computer brought the keys of the user's own app along; they go with the old login.
    let cfg = &soundcloud::ScConfig::default();
    let sign_in = soundcloud::begin_sign_in(cfg, true)?;
    let (tx, rx) = std::sync::mpsc::channel();
    *state.sc_phone_sign_in.lock().unwrap() = Some((sign_in.state().to_string(), tx));
    let waited = (|| {
        open(&sign_in.url)?;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(300);
        loop {
            if state.sc_cancel.load(Ordering::Relaxed) {
                return Err("Cancelled".to_string());
            }
            if std::time::Instant::now() > deadline {
                return Err("Timed out waiting for SoundCloud — try Connect again".to_string());
            }
            if let Ok(reply) = rx.recv_timeout(std::time::Duration::from_millis(200)) {
                return reply;
            }
        }
    })();
    state.sc_phone_sign_in.lock().unwrap().take();
    sign_in.finish(cfg, &waited?)
}

/// Whether the shared SoundCloud app is set up, so users can connect without their own keys.
#[tauri::command]
fn sc_builtin() -> bool {
    soundcloud::builtin_available()
}

#[tauri::command]
fn sc_cancel(state: State<AppState>) {
    state.sc_cancel.store(true, Ordering::Relaxed);
}

#[tauri::command]
fn sc_disconnect(state: State<AppState>) -> Settings {
    let mut s = state.settings.lock().unwrap();
    let sc = &mut s.soundcloud;
    *sc = soundcloud::ScConfig {
        client_id: sc.client_id.clone(),
        client_secret: sc.client_secret.clone(),
        redirect_uri: sc.redirect_uri.clone(),
        ..Default::default()
    };
    state.save_settings(&s);
    s.clone()
}

#[derive(Serialize)]
struct PhoneLink {
    /// `yuuricloud://soundcloud/...`, to paste on the phone
    code: String,
    /// the same code as a QR code (`data:` URL), for the phone's camera
    qr: String,
}

/// Sign a phone in to SoundCloud from this computer: a second sign-in in the browser here, handed
/// over as a link code instead of being kept. The computer's own login stays as it is.
#[tauri::command]
async fn sc_link_phone(app: AppHandle) -> Result<PhoneLink, String> {
    blocking(move || {
        let state = app.state::<AppState>();
        state.sc_cancel.store(false, Ordering::Relaxed);
        let own = state.settings.lock().unwrap().soundcloud.clone();
        let fresh = soundcloud::ScConfig {
            client_id: own.client_id,
            client_secret: own.client_secret,
            redirect_uri: own.redirect_uri,
            ..Default::default()
        };
        let open = |url: &str| app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string());
        let phone = soundcloud::connect(&fresh, open, &state.sc_cancel)?;
        let code = soundcloud::link_code(&phone)?;
        Ok(PhoneLink { qr: soundcloud::qr_svg(&code)?, code })
    })
    .await
}

/// Use a SoundCloud login handed over from a computer (see `sc_link_phone`).
#[tauri::command]
fn sc_link(state: State<AppState>, code: String) -> Result<Settings, String> {
    link_soundcloud(&state, &code)
}

fn link_soundcloud(state: &AppState, code: &str) -> Result<Settings, String> {
    let cfg = soundcloud::from_link_code(code)?;
    let mut s = state.settings.lock().unwrap();
    s.soundcloud = cfg;
    state.save_settings(&s);
    Ok(s.clone())
}

/// Phones: scanning the computer's QR code opens the app with a `yuuricloud://soundcloud/...` link.
#[cfg(mobile)]
fn open_links(app: &tauri::App) {
    use tauri_plugin_deep_link::DeepLinkExt;
    fn apply(app: &AppHandle, urls: Vec<tauri::Url>) {
        for url in urls.iter().filter(|u| u.scheme() == "yuuricloud") {
            // SoundCloud's approval coming back for the sign-in `phone_sign_in` is waiting on
            if url.host_str() == Some("soundcloud-auth") {
                let state = app.state::<AppState>();
                let pending = state.sc_phone_sign_in.lock().unwrap();
                let param = |name: &str| url.query_pairs().find(|(k, _)| k == name).map(|(_, v)| v.into_owned());
                if let Some((_, tx)) = pending.as_ref().filter(|(expected, _)| param("state").as_deref() == Some(expected.as_str())) {
                    let reply = match (param("code"), param("error")) {
                        (Some(code), _) => Ok(code),
                        (None, Some(err)) => Err(format!("SoundCloud said: {err}")),
                        (None, None) => Err("SoundCloud sent an unexpected reply".to_string()),
                    };
                    let _ = tx.send(reply);
                }
                continue;
            }
            match link_soundcloud(&app.state::<AppState>(), url.as_str()) {
                Ok(settings) => drop(app.emit("sc-linked", settings)),
                Err(e) => drop(app.emit("sc-link-failed", e)),
            }
        }
    }
    if let Ok(Some(urls)) = app.deep_link().get_current() {
        apply(app.handle(), urls);
    }
    let handle = app.handle().clone();
    app.deep_link().on_open_url(move |event| apply(&handle, event.urls()));
}

/// Run a SoundCloud call off the async runtime with the saved login, keeping any refreshed token.
async fn with_sc<T: Send + 'static>(
    app: AppHandle,
    f: impl FnOnce(&mut soundcloud::ScConfig, &AppState) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    blocking(move || {
        let state = app.state::<AppState>();
        let mut cfg = state.settings.lock().unwrap().soundcloud.clone();
        let before = cfg.access_token.clone();
        let result = {
            let _auth = state.sc_auth.lock().unwrap();
            // re-read: another call may have refreshed the token while this one waited
            cfg = state.settings.lock().unwrap().soundcloud.clone();
            soundcloud::get_fresh(&mut cfg)
        };
        let result = result.and_then(|_| f(&mut cfg, &state));
        if cfg.access_token != before {
            let mut s = state.settings.lock().unwrap();
            s.soundcloud.access_token = cfg.access_token.clone();
            s.soundcloud.refresh_token = cfg.refresh_token.clone();
            s.soundcloud.expires_at = cfg.expires_at;
            state.save_settings(&s);
        }
        result
    })
    .await
}

#[tauri::command]
async fn sc_likes(app: AppHandle) -> Result<Vec<soundcloud::ScTrack>, String> {
    with_sc(app, |cfg, _| soundcloud::likes(cfg)).await
}

#[tauri::command]
async fn sc_playlists(app: AppHandle) -> Result<Vec<soundcloud::ScPlaylist>, String> {
    with_sc(app, |cfg, _| soundcloud::playlists(cfg)).await
}

#[tauri::command]
async fn sc_playlist_tracks(app: AppHandle, urn: String, title: String) -> Result<Vec<soundcloud::ScTrack>, String> {
    with_sc(app, move |cfg, _| soundcloud::playlist_tracks(cfg, &urn, &title)).await
}

#[tauri::command]
async fn sc_search(app: AppHandle, query: String) -> Result<Vec<soundcloud::ScTrack>, String> {
    with_sc(app, move |cfg, _| soundcloud::search(cfg, &query)).await
}

/// Download a SoundCloud track for playback and return the local file.
#[tauri::command]
async fn sc_prepare(app: AppHandle, urn: String) -> Result<String, String> {
    with_sc(app, move |cfg, state| {
        soundcloud::prepare(cfg, &urn, &state.sc_stream_dir()).map(|p| p.to_string_lossy().into_owned())
    })
    .await
}

#[tauri::command]
async fn sc_like(app: AppHandle, urn: String, on: bool) -> Result<(), String> {
    with_sc(app, move |cfg, _| soundcloud::set_like(cfg, &urn, on)).await
}

/// Where downloads go: the chosen folder, or Music/SoundCloud.
fn download_folder(app: &AppHandle, cfg: &downloads::DownloadConfig) -> PathBuf {
    if !cfg.folder.is_empty() {
        return PathBuf::from(&cfg.folder);
    }
    let music = app.path().audio_dir().unwrap_or_else(|_| app.path().home_dir().unwrap_or_default().join("Music"));
    music.join("SoundCloud")
}

/// Folders that are always part of the library: where SoundCloud and Soulseek downloads go,
/// once they exist, or on iOS the app's own folder. Returned as (path, label).
fn auto_folders(app: &AppHandle, s: &Settings) -> Vec<(PathBuf, &'static str)> {
    // iOS keeps Soulseek downloads inside the app's folder, so that one folder covers them
    #[cfg(target_os = "ios")]
    let all = {
        let _ = s;
        [(phone_music_folder(app), "yuuricloud folder in the Files app")]
    };
    #[cfg(not(target_os = "ios"))]
    let all = [(download_folder(app, &s.downloads), "SoundCloud downloads"), (slsk_download_folder(app, &s.soulseek), "Soulseek downloads")];
    all.into_iter().filter(|(p, _)| p.is_dir()).collect()
}

/// iOS: the app's Documents folder. The Files app shows it under On My iPhone → yuuricloud, and a
/// computer can copy music into it through Finder or iTunes file sharing.
#[cfg(target_os = "ios")]
fn phone_music_folder(app: &AppHandle) -> PathBuf {
    app.path().document_dir().unwrap_or_default()
}

/// Every folder a scan looks in: the user's folders plus the download folders, leaving out any
/// download folder that is already inside one of the user's folders.
fn library_roots(app: &AppHandle, s: &Settings) -> Vec<String> {
    let mut roots = s.folders.clone();
    for (p, _) in auto_folders(app, s) {
        if !s.folders.iter().any(|f| p.starts_with(f)) {
            roots.push(p.to_string_lossy().into_owned());
        }
    }
    roots
}

#[derive(Serialize)]
struct AutoFolder {
    path: String,
    label: &'static str,
}

#[derive(Serialize)]
struct AutoFolders {
    /// The user's own folders, after dropping any that are now automatic.
    folders: Vec<String>,
    auto: Vec<AutoFolder>,
}

#[tauri::command]
fn library_auto_folders(app: AppHandle, state: State<AppState>) -> AutoFolders {
    let mut s = state.settings.lock().unwrap();
    let auto = auto_folders(&app, &s);
    // download folders added by hand before they were automatic: they're included anyway now
    let before = s.folders.len();
    s.folders.retain(|f| !auto.iter().any(|(p, _)| Path::new(f) == p.as_path()));
    if s.folders.len() != before {
        state.save_settings(&s);
    }
    AutoFolders {
        folders: s.folders.clone(),
        auto: auto.into_iter().map(|(p, label)| AutoFolder { path: p.to_string_lossy().into_owned(), label }).collect(),
    }
}

#[tauri::command]
fn dl_folder(app: AppHandle, state: State<AppState>) -> String {
    let cfg = state.settings.lock().unwrap().downloads.clone();
    download_folder(&app, &cfg).to_string_lossy().into_owned()
}

#[tauri::command]
async fn dl_pick_folder(app: AppHandle, state: State<'_, AppState>) -> Result<Option<Settings>, String> {
    let Some(path) = pick_folder(&app, "Choose where to save SoundCloud songs")? else {
        return Ok(None);
    };
    let mut s = state.settings.lock().unwrap();
    s.downloads.folder = path.to_string_lossy().into_owned();
    state.save_settings(&s);
    Ok(Some(s.clone()))
}

#[tauri::command]
fn dl_open_folder(app: AppHandle, state: State<AppState>) -> Result<(), String> {
    let cfg = state.settings.lock().unwrap().downloads.clone();
    let folder = download_folder(&app, &cfg);
    std::fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
    app.opener().open_path(folder.to_string_lossy(), None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
fn dl_set_ytdlp(state: State<AppState>, enabled: bool, path: String) -> Settings {
    let mut s = state.settings.lock().unwrap();
    s.downloads.use_ytdlp = enabled;
    s.downloads.ytdlp_path = path.trim().trim_matches('"').to_string();
    state.save_settings(&s);
    s.clone()
}

#[tauri::command]
async fn dl_ytdlp_version(state: State<'_, AppState>) -> Result<String, String> {
    let cfg = state.settings.lock().unwrap().downloads.clone();
    blocking(move || downloads::ytdlp_version(&cfg)).await
}

/// Save one SoundCloud song into the download folder.
#[tauri::command]
async fn sc_download(app: AppHandle, track: downloads::DownloadTrack) -> Result<downloads::Downloaded, String> {
    let handle = app.clone();
    with_sc(app, move |cfg, state| {
        state.dl_cancel.store(false, Ordering::Relaxed);
        let dl = state.settings.lock().unwrap().downloads.clone();
        // tell the Downloads page how far along the song is, a few times a second
        let last = Mutex::new(std::time::Instant::now() - std::time::Duration::from_secs(1));
        let report = |done: u64, total: Option<u64>| {
            let mut last = last.lock().unwrap();
            if last.elapsed().as_millis() >= 150 || Some(done) == total {
                *last = std::time::Instant::now();
                let _ = handle.emit("dl-progress", serde_json::json!({ "urn": track.urn, "done": done, "total": total }));
            }
        };
        downloads::download(cfg, &dl, &download_folder(&handle, &dl), &track, &report, &state.dl_cancel)
    })
    .await
}

/// Stop the download in progress.
#[tauri::command]
fn dl_cancel(state: State<AppState>) {
    state.dl_cancel.store(true, Ordering::Relaxed);
}

/// Show a downloaded file in the file manager (only files in the download folder).
#[tauri::command]
fn dl_reveal(app: AppHandle, state: State<AppState>, path: String) -> Result<(), String> {
    let cfg = state.settings.lock().unwrap().downloads.clone();
    if !Path::new(&path).starts_with(download_folder(&app, &cfg)) {
        return Err("Not in the download folder".into());
    }
    app.opener().reveal_item_in_dir(&path).map_err(|e| e.to_string())
}

// ------------------------------------------------------------- helper programs

/// "Download for me": install yt-dlp or slskd from its GitHub release and start using it.
#[tauri::command]
async fn tool_install(app: AppHandle, name: String) -> Result<Settings, String> {
    let tool = tools::Tool::parse(&name)?;
    blocking(move || {
        let state = app.state::<AppState>();
        state.tool_cancel.store(false, Ordering::Relaxed);
        let last = Mutex::new(std::time::Instant::now() - std::time::Duration::from_secs(1));
        let report = |done: u64, total: Option<u64>| {
            let mut last = last.lock().unwrap();
            if last.elapsed().as_millis() >= 150 || Some(done) == total {
                *last = std::time::Instant::now();
                let _ = app.emit("tool-progress", serde_json::json!({ "name": name, "done": done, "total": total }));
            }
        };
        if tool == tools::Tool::Slskd && state.slsk.lock().unwrap().as_ref().is_some_and(|c| c.managed()) {
            return Err("Disconnect from Soulseek first; slskd is running".into());
        }
        let (path, _version) = tools::install(tool, &state.tools_dir(), &report, &state.tool_cancel)?;
        let path = path.to_string_lossy().into_owned();
        let mut s = state.settings.lock().unwrap();
        match tool {
            tools::Tool::YtDlp => {
                s.downloads.ytdlp_path = path;
                s.downloads.use_ytdlp = true;
            }
            tools::Tool::Slskd => s.soulseek.exe_path = path,
        }
        state.save_settings(&s);
        Ok(s.clone())
    })
    .await
}

#[tauri::command]
fn tool_cancel(state: State<AppState>) {
    state.tool_cancel.store(true, Ordering::Relaxed);
}

// ---------------------------------------------------------------- Soulseek

/// Where Soulseek downloads go: the chosen folder, or Music/Soulseek. On iOS, a Soulseek folder in
/// the app's own folder, so downloads are in the library and the Files app.
fn slsk_download_folder(app: &AppHandle, cfg: &slsk::SlskConfig) -> PathBuf {
    #[cfg(target_os = "ios")]
    {
        let _ = cfg;
        phone_music_folder(app).join("Soulseek")
    }
    #[cfg(not(target_os = "ios"))]
    {
        if !cfg.folder.is_empty() {
            return PathBuf::from(&cfg.folder);
        }
        let music = app.path().audio_dir().unwrap_or_else(|_| app.path().home_dir().unwrap_or_default().join("Music"));
        music.join("Soulseek")
    }
}

/// Folders to share: the download folder plus, if wanted, the library folders. Folders inside
/// another shared folder are left out, since slskd would list their files twice.
fn slsk_shares(settings: &Settings, downloads: &Path) -> Vec<String> {
    let mut all: Vec<PathBuf> = vec![downloads.to_path_buf()];
    if settings.soulseek.share_library {
        all.extend(settings.folders.iter().map(PathBuf::from));
    }
    let mut out: Vec<PathBuf> = Vec::new();
    for p in all {
        if out.iter().any(|o| p.starts_with(o)) {
            continue;
        }
        out.retain(|o| !o.starts_with(&p));
        out.push(p);
    }
    out.into_iter().map(|p| p.to_string_lossy().into_owned()).collect()
}

/// What the built-in Soulseek client shares. On iOS "share my library" means the app's whole
/// folder, which the downloads are inside of.
fn builtin_shares(app: &AppHandle, settings: &Settings, downloads: &Path) -> Vec<String> {
    #[cfg(target_os = "ios")]
    {
        let folder = if settings.soulseek.share_library { phone_music_folder(app) } else { downloads.to_path_buf() };
        vec![folder.to_string_lossy().into_owned()]
    }
    #[cfg(not(target_os = "ios"))]
    {
        let _ = app;
        slsk_shares(settings, downloads)
    }
}

/// Run `f` with the slskd connection, or say that Soulseek isn't connected.
async fn with_slsk<T: Send + 'static>(
    app: AppHandle,
    f: impl FnOnce(&slsk::Conn) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    blocking(move || {
        let state = app.state::<AppState>();
        // hold the lock only to pick up the connection, not for the request itself
        let conn = {
            let mut guard = state.slsk.lock().unwrap();
            let Some(conn) = guard.clone() else { return Err("Soulseek isn't connected".into()) };
            if !conn.alive() {
                guard.take();
                return Err("slskd stopped unexpectedly — connect again".into());
            }
            conn
        };
        f(&conn)
    })
    .await
}

#[tauri::command]
fn slsk_set_config(state: State<AppState>, config: slsk::SlskConfig) -> Settings {
    let mut s = state.settings.lock().unwrap();
    s.soulseek = slsk::SlskConfig {
        url: config.url.trim().to_string(),
        api_key: config.api_key.trim().to_string(),
        exe_path: config.exe_path.trim().trim_matches('"').to_string(),
        username: config.username.trim().to_string(),
        // the folder is only changed with the folder picker
        folder: s.soulseek.folder.clone(),
        ..config
    };
    state.save_settings(&s);
    s.clone()
}

/// Start slskd (or reach the user's own) and log in to Soulseek.
#[tauri::command]
async fn slsk_connect(app: AppHandle) -> Result<serde_json::Value, String> {
    blocking(move || {
        let state = app.state::<AppState>();
        let _starting = state.slsk_starting.lock().unwrap();
        state.slsk.lock().unwrap().take(); // stop the old one first: it holds the Soulseek port
        let settings = state.settings.lock().unwrap().clone();
        let cfg = &settings.soulseek;
        // iOS can't run slskd, so the app is the Soulseek client itself there
        let conn = if cfg!(target_os = "ios") || cfg.builtin {
            let downloads = slsk_download_folder(&app, cfg);
            slsk::connect_native(cfg, &downloads, &builtin_shares(&app, &settings, &downloads))?
        } else if cfg.external {
            slsk::connect_external(cfg)?
        } else {
            let downloads = slsk_download_folder(&app, cfg);
            let exe = if cfg.exe_path.is_empty() {
                tools::Tool::Slskd.installed_path(&state.tools_dir())
            } else {
                PathBuf::from(&cfg.exe_path)
            };
            let shares = slsk_shares(&settings, &downloads);
            slsk::start_managed(
                cfg,
                slsk::Launch { exe: &exe, app_dir: &state.data_dir.join("slskd"), downloads: &downloads, shares: &shares },
            )?
        };
        let status = conn.status().unwrap_or_default();
        *state.slsk.lock().unwrap() = Some(std::sync::Arc::new(conn));
        Ok(status)
    })
    .await
}

#[tauri::command]
async fn slsk_disconnect(app: AppHandle) -> Result<(), String> {
    blocking(move || {
        let conn = app.state::<AppState>().slsk.lock().unwrap().take();
        drop(conn); // stops a managed slskd
        Ok(())
    })
    .await
}

/// Whether slskd is running and logged in to Soulseek. Null when not connected.
#[tauri::command]
async fn slsk_status(app: AppHandle) -> Result<serde_json::Value, String> {
    let connected = app.state::<AppState>().slsk.lock().unwrap().is_some();
    if !connected {
        return Ok(serde_json::Value::Null);
    }
    with_slsk(app, |c| c.status()).await
}

#[tauri::command]
async fn slsk_search(app: AppHandle, text: String) -> Result<String, String> {
    with_slsk(app, move |c| c.search(text.trim())).await
}

#[tauri::command]
async fn slsk_search_results(app: AppHandle, id: String) -> Result<slsk::SearchResults, String> {
    with_slsk(app, move |c| c.search_results(&id)).await
}

#[tauri::command]
async fn slsk_search_stop(app: AppHandle, id: String) -> Result<(), String> {
    with_slsk(app, move |c| c.stop_search(&id)).await
}

#[tauri::command]
async fn slsk_download(app: AppHandle, username: String, files: Vec<slsk::QueueFile>) -> Result<(), String> {
    with_slsk(app, move |c| c.download(&username, &files)).await
}

#[tauri::command]
async fn slsk_transfers(app: AppHandle) -> Result<Vec<slsk::TransferInfo>, String> {
    with_slsk(app, |c| c.transfers()).await
}

#[tauri::command]
async fn slsk_uploads(app: AppHandle) -> Result<Vec<slsk::TransferInfo>, String> {
    with_slsk(app, |c| c.uploads()).await
}

#[tauri::command]
async fn slsk_cancel_upload(app: AppHandle, username: String, id: String, remove: bool) -> Result<(), String> {
    with_slsk(app, move |c| c.cancel_upload(&username, &id, remove)).await
}

#[tauri::command]
async fn slsk_queue_position(app: AppHandle, username: String, id: String) -> Result<Option<u64>, String> {
    with_slsk(app, move |c| c.queue_position(&username, &id)).await
}

#[tauri::command]
async fn slsk_cancel(app: AppHandle, username: String, id: String, remove: bool) -> Result<(), String> {
    with_slsk(app, move |c| c.cancel(&username, &id, remove)).await
}

#[tauri::command]
async fn slsk_clear_finished(app: AppHandle) -> Result<(), String> {
    with_slsk(app, |c| c.clear_finished().and(c.clear_finished_uploads())).await
}

#[tauri::command]
fn slsk_folder(app: AppHandle, state: State<AppState>) -> String {
    let cfg = state.settings.lock().unwrap().soulseek.clone();
    slsk_download_folder(&app, &cfg).to_string_lossy().into_owned()
}

#[tauri::command]
async fn slsk_pick_folder(app: AppHandle, state: State<'_, AppState>) -> Result<Option<Settings>, String> {
    let Some(path) = pick_folder(&app, "Choose where to save Soulseek downloads")? else {
        return Ok(None);
    };
    let mut s = state.settings.lock().unwrap();
    s.soulseek.folder = path.to_string_lossy().into_owned();
    state.save_settings(&s);
    Ok(Some(s.clone()))
}

#[tauri::command]
fn slsk_open_folder(app: AppHandle, state: State<AppState>) -> Result<(), String> {
    let folder = state.slsk.lock().unwrap().as_ref().and_then(|c| c.downloads_dir.clone());
    let folder = folder.unwrap_or_else(|| slsk_download_folder(&app, &state.settings.lock().unwrap().soulseek));
    std::fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
    app.opener().open_path(folder.to_string_lossy(), None::<&str>).map_err(|e| e.to_string())
}

/// Show a finished Soulseek download in the file manager (only files in the download folder).
#[tauri::command]
fn slsk_reveal(app: AppHandle, state: State<AppState>, path: String) -> Result<(), String> {
    let dir = state.slsk.lock().unwrap().as_ref().and_then(|c| c.downloads_dir.clone());
    if !dir.is_some_and(|d| Path::new(&path).starts_with(d)) {
        return Err("Not in the Soulseek download folder".into());
    }
    app.opener().reveal_item_in_dir(&path).map_err(|e| e.to_string())
}

#[tauri::command]
async fn slsk_pick_exe(app: AppHandle) -> Result<Option<String>, String> {
    let Some(picked) = app.dialog().file().set_title("Find the slskd program").blocking_pick_file() else {
        return Ok(None);
    };
    Ok(Some(picked.into_path().map_err(|e| e.to_string())?.to_string_lossy().into_owned()))
}

// ---------------------------------------------------------------- updates

const RELEASES_API: &str = "https://api.github.com/repos/lrd14/yuuricloud/releases/latest";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateInfo {
    current: String,
    latest: String,
    /// The release page, where the downloads are.
    url: String,
    newer: bool,
}

/// "0.10.2" > "0.9.9": compare version numbers part by part.
fn version_parts(v: &str) -> Vec<u64> {
    v.trim().trim_start_matches(['v', 'V']).split(['.', '-', '+']).map_while(|p| p.parse().ok()).collect()
}

fn is_newer(latest: &str, current: &str) -> bool {
    let (a, b) = (version_parts(latest), version_parts(current));
    !a.is_empty() && a > b
}

/// Ask GitHub for the newest published release. `pretend` (for testing) replaces this app's version.
#[tauri::command]
async fn check_update(app: AppHandle, pretend: Option<String>) -> Result<UpdateInfo, String> {
    let current = pretend.unwrap_or_else(|| app.package_info().version.to_string());
    blocking(move || {
        let mut res = soundcloud::agent(20)
            .get(RELEASES_API)
            .header("User-Agent", "yuuricloud")
            .header("Accept", "application/vnd.github+json")
            .call()
            .map_err(|e| format!("Couldn't reach GitHub: {e}"))?;
        let status = res.status().as_u16();
        if status == 404 {
            return Err("No releases yet".into());
        }
        if status >= 400 {
            return Err(format!("GitHub said {status}"));
        }
        let r: serde_json::Value = res.body_mut().read_json().map_err(|e| e.to_string())?;
        let latest = r["tag_name"].as_str().unwrap_or("").trim_start_matches(['v', 'V']).to_string();
        let url = r["html_url"].as_str().unwrap_or("https://github.com/lrd14/yuuricloud/releases/latest").to_string();
        // only ever send people to this project's own GitHub page
        let url = if url.starts_with("https://github.com/lrd14/yuuricloud/") { url } else { "https://github.com/lrd14/yuuricloud/releases/latest".into() };
        Ok(UpdateInfo { newer: is_newer(&latest, &current), current, latest, url })
    })
    .await
}

#[cfg(test)]
mod update_tests {
    use super::*;

    #[test]
    fn compares_versions_by_number() {
        assert!(is_newer("0.2.0", "0.1.0"));
        assert!(is_newer("v0.10.0", "0.9.9"));
        assert!(is_newer("1.0.0", "0.99.0"));
        assert!(!is_newer("0.1.0", "0.1.0"));
        assert!(!is_newer("0.1.0", "0.2.0"));
        assert!(!is_newer("", "0.1.0"));
    }
}

// ------------------------------------------------------------ song editor

/// The editor only touches songs that are in the library.
fn library_song(state: &AppState, path: &str) -> Result<PathBuf, String> {
    if state.tracks.lock().unwrap().iter().any(|t| t.path == path) {
        Ok(PathBuf::from(path))
    } else {
        Err("That song isn't in your library".into())
    }
}

#[tauri::command]
async fn song_tags(app: AppHandle, path: String) -> Result<editor::SongTags, String> {
    blocking(move || editor::read(&library_song(&app.state::<AppState>(), &path)?)).await
}

#[derive(Serialize)]
struct PickedImage {
    path: String,
    preview: String,
}

#[tauri::command]
async fn pick_cover_image(app: AppHandle) -> Result<Option<PickedImage>, String> {
    let picked = app
        .dialog()
        .file()
        .set_title("Choose a cover picture")
        .add_filter("Pictures", &["jpg", "jpeg", "png", "webp", "gif", "bmp"])
        .blocking_pick_file();
    let Some(picked) = picked else { return Ok(None) };
    let path = picked.into_path().map_err(|e| e.to_string())?;
    blocking(move || {
        let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
        Ok(Some(PickedImage { preview: editor::preview(&bytes)?, path: path.to_string_lossy().into_owned() }))
    })
    .await
}

/// Save the editor's changes into the song, and the cover into `cover_also` too (the rest of its album).
#[tauri::command]
async fn save_song_tags(
    app: AppHandle,
    path: String,
    edit: editor::TagEdit,
    cover: editor::CoverEdit,
    cover_also: Vec<String>,
) -> Result<(), String> {
    blocking(move || {
        let state = app.state::<AppState>();
        let main = library_song(&state, &path)?;
        let others = cover_also.iter().filter(|p| **p != path).map(|p| library_song(&state, p)).collect::<Result<Vec<_>, _>>()?;
        editor::write(&main, &edit, &cover)?;
        let mut failed = 0;
        for p in &others {
            if editor::write_cover(p, &cover).is_err() {
                failed += 1;
            }
        }
        if failed > 0 {
            return Err(format!("Saved, but the cover couldn't be written to {failed} other song{} of the album", if failed == 1 { "" } else { "s" }));
        }
        Ok(())
    })
    .await
}

#[tauri::command]
async fn sc_waveform(url: String, bins: usize) -> Result<Vec<f32>, String> {
    blocking(move || soundcloud::waveform(&url, bins)).await
}

/// Rescan all library folders. `full` ignores the cache and re-reads every file.
#[tauri::command]
async fn scan(app: AppHandle, state: State<'_, AppState>, full: bool) -> Result<Vec<Track>, String> {
    if state.scanning.swap(true, Ordering::SeqCst) {
        return Err("A scan is already running".into());
    }
    let (folders, prefer_tags, mode_changed) = {
        let s = state.settings.lock().unwrap();
        (library_roots(&app, &s), s.prefer_tags, s.scanned_with_tags != Some(s.prefer_tags))
    };
    for folder in &folders {
        allow_dir(&app, Path::new(folder));
    }
    let cache: HashMap<String, Track> = if full || mode_changed {
        HashMap::new()
    } else {
        state.tracks.lock().unwrap().iter().map(|t| (t.path.clone(), t.clone())).collect()
    };
    let cover_dir = state.cover_dir();
    let emitter = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        library::scan(&folders, prefer_tags, cache, &cover_dir, |done, total| {
            let _ = emitter.emit("scan-progress", (done, total));
        })
    })
    .await;
    state.scanning.store(false, Ordering::SeqCst);

    let tracks = result.map_err(|e| e.to_string())?;
    library::save_json(&state.library_file(), &tracks);
    {
        let mut s = state.settings.lock().unwrap();
        s.scanned_with_tags = Some(prefer_tags);
        state.save_settings(&s);
    }
    *state.tracks.lock().unwrap() = tracks.clone();
    Ok(tracks)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default().plugin(tauri_plugin_dialog::init()).plugin(tauri_plugin_opener::init());
    #[cfg(mobile)]
    let builder = builder.plugin(tauri_plugin_deep_link::init());
    builder
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            let settings: Settings =
                library::load_json(&data_dir.join("settings.json")).unwrap_or_default();
            let tracks: Vec<Track> = library::load_json(&data_dir.join("library.json")).unwrap_or_default();

            let handle = app.handle();
            #[cfg(target_os = "ios")]
            let _ = std::fs::create_dir_all(phone_music_folder(handle));
            // the download folders too: their songs must play before the first scan has run
            for folder in library_roots(handle, &settings) {
                allow_dir(handle, Path::new(&folder));
            }
            allow_dir(handle, &data_dir.join("covers"));
            let _ = std::fs::create_dir_all(data_dir.join("soundcloud-cache"));
            allow_dir(handle, &data_dir.join("soundcloud-cache"));

            app.manage(AppState {
                data_dir,
                settings: Mutex::new(settings),
                tracks: Mutex::new(tracks),
                scanning: AtomicBool::new(false),
                lastfm_token: Mutex::new(None),
                discord: Mutex::new(Discord::new()),
                art_cache: Mutex::new(HashMap::new()),
                cover_colors: Mutex::new(HashMap::new()),
                sc_cancel: AtomicBool::new(false),
                #[cfg(mobile)]
                sc_phone_sign_in: Mutex::new(None),
                sc_auth: Mutex::new(()),
                dl_cancel: AtomicBool::new(false),
                tool_cancel: AtomicBool::new(false),
                slsk: Mutex::new(None),
                slsk_starting: Mutex::new(()),
            });
            #[cfg(mobile)]
            open_links(app);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_library,
            add_folder,
            remove_folder,
            set_volume,
            set_prefer_tags,
            set_ui,
            lastfm_set_keys,
            lastfm_begin_auth,
            lastfm_finish_auth,
            lastfm_disconnect,
            lastfm_builtin,
            lastfm_set_scrobble,
            lastfm_now_playing,
            lastfm_scrobble,
            discord_set,
            discord_update,
            waveform,
            cover_accent,
            set_app_icon,
            set_favorite,
            reveal_file,
            sc_like,
            sc_download,
            dl_cancel,
            dl_reveal,
            dl_folder,
            dl_pick_folder,
            dl_set_ytdlp,
            dl_open_folder,
            dl_ytdlp_version,
            sc_set_keys,
            sc_connect,
            sc_cancel,
            sc_builtin,
            sc_disconnect,
            sc_link_phone,
            sc_link,
            sc_likes,
            sc_playlists,
            sc_playlist_tracks,
            sc_search,
            sc_prepare,
            sc_waveform,
            library_auto_folders,
            song_tags,
            pick_cover_image,
            save_song_tags,
            check_update,
            tool_install,
            tool_cancel,
            slsk_set_config,
            slsk_connect,
            slsk_disconnect,
            slsk_status,
            slsk_search,
            slsk_search_results,
            slsk_search_stop,
            slsk_download,
            slsk_transfers,
            slsk_uploads,
            slsk_cancel_upload,
            slsk_cancel,
            slsk_queue_position,
            slsk_clear_finished,
            slsk_folder,
            slsk_pick_folder,
            slsk_open_folder,
            slsk_reveal,
            slsk_pick_exe,
            scan
        ])
        .build(tauri::generate_context!())
        .expect("error while running yuuricloud")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                // stop the slskd we started; dropping the connection kills it
                app.state::<AppState>().slsk.lock().unwrap().take();
            }
        });
}
