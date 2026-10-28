//! SoundCloud through the official API.
//!
//! By default the app signs in through yuuricloud's shared SoundCloud app: its Client ID is built
//! in, and the two requests that need its Client Secret (sign-in and token refresh) go through a
//! small proxy that holds the secret (see `soundcloud-proxy/`). Users can instead paste the keys of
//! their own SoundCloud app (registering one needs Artist Pro). Signing in uses OAuth 2.1 with PKCE: the browser opens SoundCloud's approval page and
//! redirects back to a tiny one-shot HTTP listener on the redirect URI (by default
//! `DEFAULT_REDIRECT_URI`; the user can change it to match their app registration).
//!
//! Tracks are played from a local file: the stream (a single MP3, or an HLS playlist whose
//! segments are joined together) is downloaded into a small cache that only keeps the last few
//! songs. That avoids CORS and HLS support in the webview, and makes seeking work everywhere.

use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::integrations::unix_now;

pub const DEFAULT_REDIRECT_URI: &str = "http://127.0.0.1:8974/callback";
/// The shared app's Client ID. Public: it is part of every sign-in link anyway.
pub const BUILTIN_CLIENT_ID: &str = "ChGXzMzf6bueI7rU1XUuM0tr5c89v0Nl";
/// Where the deployed `soundcloud-proxy` Worker lives, e.g. "https://yuuricloud-soundcloud.NAME.workers.dev".
/// Empty turns the shared app off, so users need their own keys.
pub const BUILTIN_TOKEN_PROXY: &str = "https://yuuricloud-soundcloud.lrd14.workers.dev";
const API: &str = "https://api.soundcloud.com";
const AUTH_URL: &str = "https://secure.soundcloud.com/authorize";
const TOKEN_URL: &str = "https://secure.soundcloud.com/oauth/token";
/// Songs kept in the stream cache; older ones are deleted.
const CACHE_KEEP: usize = 8;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ScConfig {
    pub client_id: String,
    pub client_secret: String,
    pub access_token: String,
    pub refresh_token: String,
    /// Unix time the access token stops working.
    pub expires_at: i64,
    pub username: String,
    /// Must match the redirect URI in the SoundCloud app registration exactly. Empty = default.
    pub redirect_uri: String,
}

pub fn builtin_available() -> bool {
    !BUILTIN_CLIENT_ID.is_empty() && !BUILTIN_TOKEN_PROXY.is_empty()
}

impl ScConfig {
    /// The user pasted keys of their own SoundCloud app; otherwise the shared app is used.
    pub fn own_app(&self) -> bool {
        !self.client_id.is_empty() && !self.client_secret.is_empty()
    }
    fn app_client_id(&self) -> &str {
        if self.own_app() { &self.client_id } else { BUILTIN_CLIENT_ID }
    }
    pub fn redirect_uri(&self) -> &str {
        // the shared app only has the default registered
        if !self.own_app() || self.redirect_uri.is_empty() { DEFAULT_REDIRECT_URI } else { &self.redirect_uri }
    }

    pub fn connected(&self) -> bool {
        !self.access_token.is_empty()
    }
}

/// A SoundCloud track, shaped like a library `Track` so the frontend can treat both alike.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScTrack {
    /// "sc:<urn>", unique like a file path
    pub path: String,
    pub urn: String,
    pub sc: bool,
    pub title: String,
    pub artist: String,
    pub album_artist: String,
    pub album: String,
    pub track_no: u32,
    pub disc_no: u32,
    pub year: String,
    pub duration: f64,
    /// Artwork URL (https), or empty.
    pub cover: String,
    pub waveform_url: String,
    pub permalink_url: String,
    /// "playable", "preview" (30 seconds only) or "blocked"
    pub access: String,
    /// The artist allows downloading the original file.
    pub downloadable: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScPlaylist {
    pub urn: String,
    pub title: String,
    pub owner: String,
    pub count: u64,
    pub cover: String,
    /// A playlist the user liked rather than made.
    pub liked: bool,
}

pub(crate) fn agent(timeout_secs: u64) -> ureq::Agent {
    ureq::Agent::config_builder()
        .http_status_as_error(false)
        .timeout_global(Some(Duration::from_secs(timeout_secs)))
        .build()
        .into()
}

// ------------------------------------------------------------------ sign-in

fn base64url(bytes: &[u8]) -> String {
    const ABC: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let n = chunk.iter().enumerate().fold(0u32, |n, (i, &b)| n | (b as u32) << (16 - 8 * i));
        for i in 0..=chunk.len() {
            out.push(ABC[(n >> (18 - 6 * i) & 63) as usize] as char);
        }
    }
    out
}

fn random_string() -> Result<String, String> {
    let mut buf = [0u8; 32];
    getrandom::fill(&mut buf).map_err(|e| e.to_string())?;
    Ok(base64url(&buf))
}

fn url_encode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn url_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => match std::str::from_utf8(&bytes[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok()) {
                Some(b) => {
                    out.push(b);
                    i += 3;
                    continue;
                }
                None => out.push(b'%'),
            },
            b'+' => out.push(b' '),
            b => out.push(b),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Open SoundCloud's approval page and wait (up to 5 minutes, or until `cancel` is set) for the
/// browser to come back with a code. Returns the config with fresh tokens and the username.
pub fn connect(cfg: &ScConfig, open_url: impl Fn(&str) -> Result<(), String>, cancel: &AtomicBool) -> Result<ScConfig, String> {
    if !cfg.own_app() && !builtin_available() {
        return Err("Add your SoundCloud Client ID and Client Secret first".into());
    }
    let redirect_uri = cfg.redirect_uri().to_string();
    let (host, port, path) = parse_redirect(&redirect_uri)?;
    // "localhost" may resolve to either loopback address, so listen on both.
    let mut listeners = vec![TcpListener::bind(("127.0.0.1", port))
        .map_err(|e| format!("Couldn't listen on port {port} for the sign-in: {e}"))?];
    if host == "localhost" {
        listeners.extend(TcpListener::bind(("::1", port)).ok());
    }
    for l in &listeners {
        l.set_nonblocking(true).map_err(|e| e.to_string())?;
    }

    let verifier = random_string()?;
    let challenge = base64url(&Sha256::digest(verifier.as_bytes()));
    let state = random_string()?;
    let url = format!(
        "{AUTH_URL}?client_id={}&redirect_uri={}&response_type=code&code_challenge={challenge}&code_challenge_method=S256&state={state}",
        url_encode(cfg.app_client_id()),
        url_encode(&redirect_uri),
    );
    open_url(&url)?;

    let deadline = Instant::now() + Duration::from_secs(300);
    let code = loop {
        if cancel.load(Ordering::Relaxed) {
            return Err("Cancelled".into());
        }
        if Instant::now() > deadline {
            return Err("Timed out waiting for SoundCloud — try Connect again".into());
        }
        let accepted = listeners.iter().find_map(|l| match l.accept() {
            Ok((stream, _)) => Some(Ok(stream)),
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => None,
            Err(e) => Some(Err(e.to_string())),
        });
        let stream = match accepted {
            Some(s) => s?,
            None => {
                std::thread::sleep(Duration::from_millis(150));
                continue;
            }
        };
        let _ = stream.set_nonblocking(false);
        let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
        let mut line = String::new();
        let _ = BufReader::new(&stream).read_line(&mut line);
        // "GET /callback?code=...&state=... HTTP/1.1"
        let target = line.split_whitespace().nth(1).unwrap_or("");
        let Some(query) = target.strip_prefix(path.as_str()).and_then(|rest| rest.strip_prefix('?')) else {
            let _ = (&stream).write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            continue;
        };
        let param = |name: &str| {
            query.split('&').find_map(|kv| kv.strip_prefix(name).and_then(|v| v.strip_prefix('=')).map(url_decode))
        };
        let (title, result) = match (param("code"), param("state"), param("error")) {
            (Some(code), Some(s), _) if s == state => ("Connected to yuuricloud", Ok(code)),
            (_, _, Some(err)) => ("Sign-in was cancelled", Err(format!("SoundCloud said: {err}"))),
            _ => ("Something went wrong", Err("SoundCloud sent an unexpected reply".to_string())),
        };
        let page = format!(
            "<!doctype html><meta charset=utf-8><title>yuuricloud</title>\
             <body style=\"font:16px system-ui;background:#15161b;color:#eee;display:grid;place-items:center;height:90vh\">\
             <div style=text-align:center><h2>{title}</h2><p>You can close this tab and go back to the app.</p></div>"
        );
        let _ = (&stream).write_all(
            format!("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{page}", page.len())
                .as_bytes(),
        );
        break result?;
    };

    let mut cfg = cfg.clone();
    let token = token_request(&cfg, &[
        ("grant_type", "authorization_code"),
        ("redirect_uri", &redirect_uri),
        ("code_verifier", &verifier),
        ("code", &code),
    ])?;
    apply_token(&mut cfg, &token);
    let me = get(&mut cfg, "/me")?;
    cfg.username = me["username"].as_str().unwrap_or("").to_string();
    Ok(cfg)
}

/// Split a redirect URI into (host, port, path). Only http on this computer can be listened on.
fn parse_redirect(uri: &str) -> Result<(String, u16, String), String> {
    let bad = || format!("The redirect URI must look like {DEFAULT_REDIRECT_URI} (http, 127.0.0.1 or localhost, a port and a path)");
    let rest = uri.strip_prefix("http://").ok_or_else(bad)?;
    let (authority, path) = rest.split_at(rest.find('/').unwrap_or(rest.len()));
    let (host, port) = authority.rsplit_once(':').ok_or_else(bad)?;
    if host != "127.0.0.1" && host != "localhost" {
        return Err(bad());
    }
    let port = port.parse::<u16>().map_err(|_| bad())?;
    let path = if path.is_empty() { "/".to_string() } else { path.to_string() };
    Ok((host.to_string(), port, path))
}

fn token_request(cfg: &ScConfig, extra: &[(&str, &str)]) -> Result<Value, String> {
    // The shared app's proxy adds the client ID and secret itself.
    let (url, mut form) = if cfg.own_app() {
        (TOKEN_URL.to_string(), vec![("client_id", cfg.client_id.as_str()), ("client_secret", cfg.client_secret.as_str())])
    } else {
        (format!("{}/token", BUILTIN_TOKEN_PROXY.trim_end_matches('/')), Vec::new())
    };
    form.extend_from_slice(extra);
    let mut response = agent(20)
        .post(&url)
        .header("Accept", "application/json; charset=utf-8")
        .send_form(form)
        .map_err(|e| format!("Couldn't reach SoundCloud: {e}"))?;
    let status = response.status().as_u16();
    let json: Value = response.body_mut().read_json().unwrap_or(Value::Null);
    if status >= 400 || json["access_token"].as_str().is_none() {
        let why = json["error_description"].as_str().or(json["error"].as_str()).unwrap_or("no access token");
        return Err(format!("SoundCloud sign-in failed ({status}): {why}"));
    }
    Ok(json)
}

fn apply_token(cfg: &mut ScConfig, token: &Value) {
    cfg.access_token = token["access_token"].as_str().unwrap_or("").to_string();
    if let Some(refresh) = token["refresh_token"].as_str() {
        cfg.refresh_token = refresh.to_string();
    }
    cfg.expires_at = unix_now() + token["expires_in"].as_i64().unwrap_or(3600);
}

/// Make sure the access token is good for at least another minute.
pub fn get_fresh(cfg: &mut ScConfig) -> Result<(), String> {
    if !cfg.connected() {
        return Err("Connect SoundCloud in Settings → Integrations first".into());
    }
    if cfg.expires_at - 60 < unix_now() {
        refresh(cfg)?;
    }
    Ok(())
}

fn refresh(cfg: &mut ScConfig) -> Result<(), String> {
    if cfg.refresh_token.is_empty() {
        return Err("SoundCloud session expired — connect again in Settings".into());
    }
    let refresh_token = cfg.refresh_token.clone();
    let token = token_request(cfg, &[("grant_type", "refresh_token"), ("refresh_token", &refresh_token)])
        .map_err(|e| format!("{e} — connect again in Settings"))?;
    apply_token(cfg, &token);
    Ok(())
}

// ---------------------------------------------------------------- API calls

/// GET an API path (or a full `next_href` URL), refreshing the token when needed.
/// `cfg` may come back with new tokens; the caller saves it.
pub fn get(cfg: &mut ScConfig, path: &str) -> Result<Value, String> {
    if !cfg.connected() {
        return Err("Connect SoundCloud in Settings → Integrations first".into());
    }
    if cfg.expires_at - 60 < unix_now() {
        refresh(cfg)?;
    }
    let url = if path.starts_with("https://") { path.to_string() } else { format!("{API}{path}") };
    for attempt in 0..2 {
        let mut response = agent(20)
            .get(&url)
            .header("Authorization", &format!("OAuth {}", cfg.access_token))
            .header("Accept", "application/json; charset=utf-8")
            .call()
            .map_err(|e| format!("Couldn't reach SoundCloud: {e}"))?;
        let status = response.status().as_u16();
        if status == 401 && attempt == 0 {
            refresh(cfg)?;
            continue;
        }
        if status == 429 {
            return Err("SoundCloud is rate-limiting requests — wait a bit and try again".into());
        }
        if status >= 400 {
            return Err(format!("SoundCloud error {status}"));
        }
        let limited = response.body_mut().with_config().limit(64 * 1024 * 1024).read_to_string();
        return serde_json::from_str(&limited.map_err(|e| e.to_string())?).map_err(|e| format!("Bad reply from SoundCloud: {e}"));
    }
    Err("SoundCloud session expired — connect again in Settings".into())
}

/// Like (`on`) or unlike a track on the user's SoundCloud account.
pub fn set_like(cfg: &mut ScConfig, urn: &str, on: bool) -> Result<(), String> {
    get_fresh(cfg)?;
    let url = format!("{API}/likes/tracks/{}", url_encode(urn));
    for attempt in 0..2 {
        let auth = format!("OAuth {}", cfg.access_token);
        let request = if on { agent(20).post(&url) } else { agent(20).delete(&url).force_send_body() };
        let response = request
            .header("Authorization", &auth)
            .header("Accept", "application/json; charset=utf-8")
            .send_empty()
            .map_err(|e| format!("Couldn't reach SoundCloud: {e}"))?;
        match response.status().as_u16() {
            401 if attempt == 0 => refresh(cfg)?,
            200..=299 => return Ok(()),
            // unliking something that isn't liked is fine
            404 if !on => return Ok(()),
            401 | 403 => return Err("SoundCloud didn't allow changing likes for this login".into()),
            429 => return Err("SoundCloud is rate-limiting requests — wait a bit and try again".into()),
            status => return Err(format!("SoundCloud error {status}")),
        }
    }
    Err("SoundCloud session expired — connect again in Settings".into())
}

/// Follow `next_href` pages of a `linked_partitioning` listing, up to `max` items.
fn collect(cfg: &mut ScConfig, first: &str, max: usize) -> Result<Vec<Value>, String> {
    let mut items = Vec::new();
    let mut next = Some(first.to_string());
    while let Some(url) = next.take() {
        let page = get(cfg, &url)?;
        // Some endpoints return a bare array instead of { collection, next_href }.
        let list = page.get("collection").unwrap_or(&page);
        items.extend(list.as_array().cloned().unwrap_or_default());
        if items.len() >= max {
            items.truncate(max);
            break;
        }
        next = page["next_href"].as_str().filter(|s| !s.is_empty()).map(str::to_string);
    }
    Ok(items)
}

fn urn_of(v: &Value, kind: &str) -> String {
    v["urn"].as_str().map(str::to_string).unwrap_or_else(|| match &v["id"] {
        Value::Number(n) => format!("soundcloud:{kind}:{n}"),
        Value::String(s) => format!("soundcloud:{kind}:{s}"),
        _ => String::new(),
    })
}

/// SoundCloud's artwork URLs point at a 100px "-large" image; ask for the 500px one.
fn big_artwork(url: &str) -> String {
    url.replace("-large.", "-t500x500.")
}

fn to_track(v: &Value, album: &str) -> Option<ScTrack> {
    let urn = urn_of(v, "tracks");
    if urn.is_empty() || v["kind"].as_str().is_some_and(|k| k != "track") {
        return None;
    }
    let artist = v["user"]["username"].as_str().unwrap_or("Unknown Artist").to_string();
    let cover = v["artwork_url"].as_str().or(v["user"]["avatar_url"].as_str()).map(big_artwork).unwrap_or_default();
    let year = v["release_year"]
        .as_u64()
        .map(|y| y.to_string())
        .or_else(|| v["created_at"].as_str().map(|d| d.chars().take(4).collect()))
        .unwrap_or_default();
    let access = match (v["access"].as_str(), v["streamable"].as_bool()) {
        (Some(a), _) => a.to_string(),
        (None, Some(false)) => "blocked".into(),
        _ => "playable".into(),
    };
    Some(ScTrack {
        path: format!("sc:{urn}"),
        urn,
        sc: true,
        title: v["title"].as_str().unwrap_or("Untitled").to_string(),
        album_artist: artist.clone(),
        artist,
        album: album.to_string(),
        track_no: 0,
        disc_no: 0,
        year,
        duration: v["duration"].as_f64().unwrap_or(0.0) / 1000.0,
        cover,
        waveform_url: v["waveform_url"].as_str().unwrap_or("").to_string(),
        permalink_url: v["permalink_url"].as_str().unwrap_or("").to_string(),
        access,
        downloadable: v["downloadable"].as_bool().unwrap_or(false),
    })
}

fn to_tracks(items: &[Value], album: &str) -> Vec<ScTrack> {
    // liked-track listings sometimes wrap each track as { track: {...} }
    items.iter().filter_map(|v| to_track(v.get("track").unwrap_or(v), album)).collect()
}

pub fn likes(cfg: &mut ScConfig) -> Result<Vec<ScTrack>, String> {
    let items = collect(cfg, "/me/likes/tracks?limit=200&linked_partitioning=true&access=playable,preview,blocked", 5000)?;
    Ok(to_tracks(&items, ""))
}

pub fn playlists(cfg: &mut ScConfig) -> Result<Vec<ScPlaylist>, String> {
    let own = collect(cfg, "/me/playlists?limit=100&linked_partitioning=true&show_tracks=false", 1000)?;
    let liked = collect(cfg, "/me/likes/playlists?limit=100&linked_partitioning=true", 1000).unwrap_or_default();
    let list = |items: Vec<Value>, liked: bool| {
        items.into_iter().filter_map(move |v| {
            let v = v.get("playlist").cloned().unwrap_or(v);
            let urn = urn_of(&v, "playlists");
            (!urn.is_empty()).then(|| ScPlaylist {
                urn,
                title: v["title"].as_str().unwrap_or("Untitled playlist").to_string(),
                owner: v["user"]["username"].as_str().unwrap_or("").to_string(),
                count: v["track_count"].as_u64().unwrap_or(0),
                cover: v["artwork_url"].as_str().map(big_artwork).unwrap_or_default(),
                liked,
            })
        })
    };
    Ok(list(own, false).chain(list(liked, true)).collect())
}

pub fn playlist_tracks(cfg: &mut ScConfig, urn: &str, title: &str) -> Result<Vec<ScTrack>, String> {
    let first = format!("/playlists/{}/tracks?limit=200&linked_partitioning=true&access=playable,preview,blocked", url_encode(urn));
    Ok(to_tracks(&collect(cfg, &first, 5000)?, title))
}

pub fn search(cfg: &mut ScConfig, query: &str) -> Result<Vec<ScTrack>, String> {
    let first = format!("/tracks?q={}&limit=50&linked_partitioning=true&access=playable,preview", url_encode(query));
    Ok(to_tracks(&collect(cfg, &first, 100)?, ""))
}

// ------------------------------------------------------------------ streams

/// Download the track into `cache_dir` (or reuse it) and return the local file.
pub fn prepare(cfg: &mut ScConfig, urn: &str, cache_dir: &Path) -> Result<PathBuf, String> {
    let stem = crate::library::hash_hex(urn);
    if let Some(hit) = cached(cache_dir, &stem) {
        return Ok(hit);
    }
    std::fs::create_dir_all(cache_dir).map_err(|e| e.to_string())?;

    let streams = get(cfg, &format!("/tracks/{}/streams", url_encode(urn)))?;
    // Prefer one MP3 file, then MP3 HLS (segments join into a plain MP3), then AAC HLS.
    let order = ["http_mp3_128_url", "hls_mp3_128_url", "hls_aac_160_url", "hls_aac_96_url", "preview_mp3_128_url"];
    let mut last_error = "SoundCloud offers no stream for this track".to_string();
    for key in order {
        let Some(api_url) = streams[key].as_str() else { continue };
        let result = resolve(cfg, api_url).and_then(|url| {
            if key.starts_with("hls") {
                download_hls(&url)
            } else {
                download(&agent(600), &url)
            }
        });
        match result {
            Ok(bytes) => {
                let ext = sniff_extension(&bytes).ok_or("SoundCloud sent audio in a format the app can't play")?;
                let file = cache_dir.join(format!("{stem}.{ext}"));
                let tmp = cache_dir.join(format!("{stem}.part"));
                std::fs::write(&tmp, &bytes).map_err(|e| e.to_string())?;
                if std::fs::rename(&tmp, &file).is_err() {
                    let _ = std::fs::remove_file(&tmp); // another download of the same song won
                }
                prune(cache_dir);
                return Ok(file);
            }
            Err(e) => last_error = e,
        }
    }
    Err(last_error)
}

fn cached(dir: &Path, stem: &str) -> Option<PathBuf> {
    ["mp3", "m4a"].iter().map(|ext| dir.join(format!("{stem}.{ext}"))).find(|p| p.is_file())
}

/// Keep only the newest `CACHE_KEEP` songs.
fn prune(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut files: Vec<_> = entries
        .flatten()
        .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path())))
        .collect();
    files.sort_by(|a, b| b.0.cmp(&a.0));
    for (_, path) in files.into_iter().skip(CACHE_KEEP) {
        let _ = std::fs::remove_file(path); // fails harmlessly if the song is still open
    }
}

/// A stream URL from the API answers with a redirect to a signed CDN address.
fn resolve(cfg: &mut ScConfig, api_url: &str) -> Result<String, String> {
    if cfg.expires_at - 60 < unix_now() {
        refresh(cfg)?;
    }
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .http_status_as_error(false)
        .max_redirects(0)
        .max_redirects_will_error(false)
        .timeout_global(Some(Duration::from_secs(20)))
        .build()
        .into();
    let mut response = agent
        .get(api_url)
        .header("Authorization", &format!("OAuth {}", cfg.access_token))
        .header("Accept", "application/json; charset=utf-8")
        .call()
        .map_err(|e| format!("Couldn't reach SoundCloud: {e}"))?;
    let status = response.status().as_u16();
    if let Some(location) = response.headers().get("location").and_then(|v| v.to_str().ok()) {
        return Ok(location.to_string());
    }
    if status >= 400 {
        return Err(match status {
            401 | 403 => "This track can't be streamed by third-party apps".to_string(),
            404 => "SoundCloud has no stream for this track".to_string(),
            _ => format!("SoundCloud stream error {status}"),
        });
    }
    let json: Value = response.body_mut().read_json().map_err(|e| e.to_string())?;
    json["url"]
        .as_str()
        .or(json["location"].as_str())
        .or(json["redirectUri"].as_str())
        .map(str::to_string)
        .ok_or_else(|| "SoundCloud sent no stream address".into())
}

fn download(agent: &ureq::Agent, url: &str) -> Result<Vec<u8>, String> {
    let mut response = agent.get(url).call().map_err(|e| format!("Download failed: {e}"))?;
    let status = response.status().as_u16();
    if status >= 400 {
        return Err(format!("Download failed ({status})"));
    }
    response
        .body_mut()
        .with_config()
        .limit(1024 * 1024 * 1024)
        .read_to_vec()
        .map_err(|e| format!("Download failed: {e}"))
}

fn join_url(base: &str, rel: &str) -> String {
    if rel.starts_with("http://") || rel.starts_with("https://") {
        return rel.to_string();
    }
    let base = base.split(['?', '#']).next().unwrap_or(base);
    if rel.starts_with('/') {
        let origin_end = base.find("://").map(|i| i + 3).and_then(|i| base[i..].find('/').map(|j| i + j)).unwrap_or(base.len());
        format!("{}{rel}", &base[..origin_end])
    } else {
        format!("{}/{rel}", &base[..base.rfind('/').unwrap_or(base.len())])
    }
}

/// Fetch an HLS playlist and join its segments into one file.
fn download_hls(url: &str) -> Result<Vec<u8>, String> {
    let agent = agent(120);
    let mut url = url.to_string();
    let mut text = String::from_utf8_lossy(&download(&agent, &url)?).into_owned();
    if text.contains("#EXT-X-STREAM-INF") {
        // a master playlist: take the first variant
        let variant = text.lines().map(str::trim).find(|l| !l.is_empty() && !l.starts_with('#')).ok_or("Empty stream playlist")?;
        url = join_url(&url, variant);
        text = String::from_utf8_lossy(&download(&agent, &url)?).into_owned();
    }

    let mut parts = Vec::new();
    for line in text.lines().map(str::trim) {
        if let Some(attrs) = line.strip_prefix("#EXT-X-KEY:") {
            if !attrs.contains("METHOD=NONE") {
                return Err("This track is copy-protected and only plays on SoundCloud itself".into());
            }
        } else if let Some(attrs) = line.strip_prefix("#EXT-X-MAP:") {
            // fMP4 streams start with an init segment holding the codec setup
            if let Some(uri) = attrs.split("URI=\"").nth(1).and_then(|s| s.split('"').next()) {
                parts.push(join_url(&url, uri));
            }
        } else if !line.is_empty() && !line.starts_with('#') {
            parts.push(join_url(&url, line));
        }
    }
    if parts.is_empty() {
        return Err("Empty stream playlist".into());
    }

    // Fetch segments a few at a time; long DJ mixes have hundreds of them.
    let chunks: Vec<Result<Vec<u8>, String>> = std::thread::scope(|scope| {
        let workers = 8.min(parts.len());
        let handles: Vec<_> = (0..workers)
            .map(|w| {
                let (agent, parts) = (&agent, &parts);
                scope.spawn(move || {
                    (w..parts.len()).step_by(workers).map(|i| (i, download(agent, &parts[i]))).collect::<Vec<_>>()
                })
            })
            .collect();
        let mut all: Vec<(usize, Result<Vec<u8>, String>)> =
            handles.into_iter().flat_map(|h| h.join().unwrap_or_default()).collect();
        all.sort_by_key(|(i, _)| *i);
        all.into_iter().map(|(_, r)| r).collect()
    });
    if chunks.len() != parts.len() {
        return Err("Download failed".into());
    }
    let mut out = Vec::new();
    for chunk in chunks {
        out.extend(chunk?);
    }
    Ok(out)
}

/// The file type of downloaded audio, judged from its first bytes.
fn sniff_extension(bytes: &[u8]) -> Option<&'static str> {
    if bytes.len() < 12 {
        return None;
    }
    if &bytes[4..8] == b"ftyp" || &bytes[4..8] == b"styp" || &bytes[4..8] == b"moof" {
        Some("m4a")
    } else if bytes.starts_with(b"ID3") || (bytes[0] == 0xFF && bytes[1] & 0xE0 == 0xE0) {
        Some("mp3") // MPEG-TS (0x47) and raw ADTS AAC aren't playable in the webview
    } else {
        None
    }
}

// ----------------------------------------------------------------- extras

/// The original file of a track whose artist allows downloads.
/// Download progress: (bytes so far, total bytes when known).
pub type Progress<'a> = &'a dyn Fn(u64, Option<u64>);

/// Like `download`, reporting progress and stopping when `cancel` is set.
pub fn download_tracked(agent: &ureq::Agent, url: &str, progress: Progress, cancel: &AtomicBool) -> Result<Vec<u8>, String> {
    use std::io::Read;
    let mut response = agent.get(url).call().map_err(|e| format!("Download failed: {e}"))?;
    let status = response.status().as_u16();
    if status >= 400 {
        return Err(format!("Download failed ({status})"));
    }
    let total = response.headers().get("content-length").and_then(|v| v.to_str().ok()).and_then(|s| s.parse::<u64>().ok());
    let mut reader = response.body_mut().with_config().limit(4 * 1024 * 1024 * 1024).reader();
    let mut out = Vec::with_capacity(total.unwrap_or(0).min(512 * 1024 * 1024) as usize);
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err("Cancelled".into());
        }
        let n = reader.read(&mut buf).map_err(|e| format!("Download failed: {e}"))?;
        if n == 0 {
            break;
        }
        out.extend_from_slice(&buf[..n]);
        progress(out.len() as u64, total);
    }
    Ok(out)
}

pub fn download_original(cfg: &mut ScConfig, urn: &str, progress: Progress, cancel: &AtomicBool) -> Result<Vec<u8>, String> {
    let url = resolve(cfg, &format!("{API}/tracks/{}/download", url_encode(urn)))
        .map_err(|e| {
            if e.contains("third-party") || e.contains("no stream") { "The artist hasn't allowed downloads for this song".into() } else { e }
        })?;
    download_tracked(&agent(1800), &url, progress, cancel)
}

/// Artwork bytes, for SoundCloud's image hosts only.
pub fn fetch_artwork(url: &str) -> Option<Vec<u8>> {
    if !url.starts_with("https://") || !host_of(url).ends_with(".sndcdn.com") {
        return None;
    }
    download(&agent(20), url).ok()
}

/// SoundCloud's own waveform for a track, as `bins` values between 0 and 1.
pub fn waveform(url: &str, bins: usize) -> Result<Vec<f32>, String> {
    if !url.starts_with("https://") || !host_of(url).ends_with(".sndcdn.com") {
        return Err("Not a SoundCloud waveform".into());
    }
    let json_url = url.replace(".png", ".json");
    let json: Value = serde_json::from_slice(&download(&agent(20), &json_url)?).map_err(|e| e.to_string())?;
    let samples: Vec<f32> = json["samples"].as_array().ok_or("No waveform data")?.iter().filter_map(|v| v.as_f64()).map(|v| v as f32).collect();
    if samples.is_empty() {
        return Err("No waveform data".into());
    }
    let bins = bins.clamp(16, 2000);
    let mut out: Vec<f32> = (0..bins)
        .map(|b| {
            let from = b * samples.len() / bins;
            let to = ((b + 1) * samples.len() / bins).max(from + 1).min(samples.len());
            samples[from.min(samples.len() - 1)..to].iter().copied().fold(0.0, f32::max)
        })
        .collect();
    let max = out.iter().copied().fold(0.0, f32::max);
    if max > 0.0 {
        out.iter_mut().for_each(|v| *v /= max);
    }
    Ok(out)
}

pub fn host_of(url: &str) -> &str {
    url.split("://").nth(1).and_then(|rest| rest.split(['/', '?', ':']).next()).unwrap_or("")
}

/// Download SoundCloud artwork into `dir` (once) so its colors can be read.
pub fn artwork_file(url: &str, dir: &Path) -> Option<PathBuf> {
    if !url.starts_with("https://") || !host_of(url).ends_with(".sndcdn.com") {
        return None;
    }
    let file = dir.join(format!("{}.img", crate::library::hash_hex(url)));
    if !file.is_file() {
        let bytes = download(&agent(20), url).ok()?;
        std::fs::create_dir_all(dir).ok()?;
        std::fs::write(&file, bytes).ok()?;
    }
    Some(file)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64url_matches_rfc_examples() {
        assert_eq!(base64url(b""), "");
        assert_eq!(base64url(b"f"), "Zg");
        assert_eq!(base64url(b"fo"), "Zm8");
        assert_eq!(base64url(b"foo"), "Zm9v");
        assert_eq!(base64url(b"foobar"), "Zm9vYmFy");
        assert_eq!(base64url(&[0xfb, 0xff]), "-_8");
    }

    #[test]
    fn parses_redirect_uris() {
        assert_eq!(parse_redirect("http://127.0.0.1:8974/callback").unwrap(), ("127.0.0.1".into(), 8974, "/callback".into()));
        assert_eq!(parse_redirect("http://localhost:9000").unwrap(), ("localhost".into(), 9000, "/".into()));
        assert!(parse_redirect("https://example.com/cb").is_err());
        assert!(parse_redirect("http://127.0.0.1/cb").is_err());
    }

    #[test]
    fn decodes_query_values() {
        assert_eq!(url_decode("a%20b+c%2Fd"), "a b c/d");
        assert_eq!(url_decode("100%"), "100%");
    }

    #[test]
    fn joins_segment_urls() {
        assert_eq!(join_url("https://a.com/x/y.m3u8?s=1", "seg1.mp3"), "https://a.com/x/seg1.mp3");
        assert_eq!(join_url("https://a.com/x/y.m3u8", "/z/seg.mp3"), "https://a.com/z/seg.mp3");
        assert_eq!(join_url("https://a.com/x/y.m3u8", "https://b.com/s"), "https://b.com/s");
    }

    #[test]
    fn sniffs_audio() {
        assert_eq!(sniff_extension(b"ID3\x04\0\0\0\0\0\0\0\0"), Some("mp3"));
        assert_eq!(sniff_extension(b"\0\0\0\x18ftypM4A \0\0"), Some("m4a"));
        assert_eq!(sniff_extension(&[0x47; 16]), None);
    }
}
