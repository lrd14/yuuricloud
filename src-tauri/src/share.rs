//! "Let your phone connect": a small HTTP server on the home network, so the phone app can copy
//! songs from this computer and use it as a remote. Off until the user turns it on.
//!
//! Every request needs the pairing token (`Authorization: Bearer …`), which only the QR code and
//! link code carry; a new token is made each time sharing is turned on. The phone side is in
//! computer.rs.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::library::{Settings, Track};
use crate::AppState;

pub const DEFAULT_PORT: u16 = 8975;

/// What the server shares: the app's library and player, or something else in tests.
pub trait Source: Send + Sync + 'static {
    fn tracks(&self) -> Vec<Track>;
    fn settings(&self) -> Settings;
    /// what's playing, for the remote
    fn now(&self) -> Value;
    fn command(&self, command: &str, value: Option<f64>);
    /// make a song a favourite (the phone has it as one)
    fn favorite(&self, path: &str);
}

struct App(AppHandle);

impl Source for App {
    fn tracks(&self) -> Vec<Track> {
        self.0.state::<AppState>().tracks.lock().unwrap().clone()
    }
    fn settings(&self) -> Settings {
        self.0.state::<AppState>().settings.lock().unwrap().clone()
    }
    fn now(&self) -> Value {
        self.0.state::<AppState>().remote.lock().unwrap().clone()
    }
    fn command(&self, command: &str, value: Option<f64>) {
        let _ = self.0.emit("remote-command", json!({ "command": command, "value": value }));
    }
    fn favorite(&self, path: &str) {
        let state = self.0.state::<AppState>();
        let mut s = state.settings.lock().unwrap();
        if !s.favorites.iter().any(|f| f == path) {
            s.favorites.push(path.to_string());
            state.save_settings(&s);
            let _ = self.0.emit("favorites-changed", s.favorites.clone());
        }
    }
}

/// A running share. Dropping it stops the server.
pub struct Share {
    stop: Arc<AtomicBool>,
    pub token: String,
    pub address: String,
    /// this computer's other network addresses (no port), for the phone to try too
    pub others: Vec<String>,
}

impl Drop for Share {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

/// A song the phone can copy, without the computer's file paths.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SharedSong {
    id: String,
    title: String,
    artist: String,
    album_artist: String,
    album: String,
    year: String,
    track_no: u32,
    disc_no: u32,
    duration: f64,
    size: u64,
    /// file name, so the copy keeps its extension
    file: String,
    has_cover: bool,
}

/// The id a song goes by over the network: a hash of its path.
pub fn song_id(path: &str) -> String {
    crate::library::hash_hex(path)
}

/// This computer's address on the home network (the one a connection to the internet would use;
/// nothing is sent).
fn lan_address() -> Option<String> {
    let socket = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("192.0.2.1:9").ok()?;
    Some(socket.local_addr().ok()?.ip().to_string())
}

/// Every address this computer has on a home network (private IPv4 ones), the likeliest first.
/// The phone tries them in turn: the "likeliest" can be a virtual network adapter's (Hyper-V,
/// WSL, VirtualBox) that the phone can't reach.
fn lan_addresses() -> Vec<String> {
    let mut out: Vec<String> = lan_address().into_iter().collect();
    for iface in if_addrs::get_if_addrs().unwrap_or_default() {
        let std::net::IpAddr::V4(ip) = iface.ip() else { continue };
        if ip.is_private() && !ip.is_loopback() && !ip.is_link_local() && !out.contains(&ip.to_string()) {
            out.push(ip.to_string());
        }
    }
    out
}

fn computer_name() -> String {
    std::env::var("COMPUTERNAME").or_else(|_| std::env::var("HOSTNAME")).unwrap_or_else(|_| "Computer".into())
}

pub fn start(app: &AppHandle) -> Result<Share, String> {
    let ips = lan_addresses();
    let ip = ips.first().ok_or("This computer doesn't seem to be on a network")?;
    let (mut share, _) = serve(Arc::new(App(app.clone())), ("0.0.0.0", DEFAULT_PORT), ip)?;
    share.others = ips[1..].to_vec();
    Ok(share)
}

/// Run the server for `source` on `bind` (falling back to any free port). Returns the share and
/// the port it got.
fn serve(source: Arc<dyn Source>, bind: (&str, u16), ip: &str) -> Result<(Share, u16), String> {
    let server = tiny_http::Server::http(bind)
        .or_else(|_| tiny_http::Server::http((bind.0, 0)))
        .map_err(|e| format!("Couldn't start sharing: {e}"))?;
    let port = server.server_addr().to_ip().map(|a| a.port()).unwrap_or(bind.1);
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|e| e.to_string())?;
    let token: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    let stop = Arc::new(AtomicBool::new(false));
    let (stop2, token2) = (stop.clone(), token.clone());
    std::thread::spawn(move || {
        while !stop2.load(Ordering::Relaxed) {
            match server.recv_timeout(Duration::from_millis(400)) {
                Ok(Some(request)) => {
                    let (source, token) = (source.clone(), token2.clone());
                    // a song download can take a while; don't hold up the remote
                    std::thread::spawn(move || answer(&*source, &token, request));
                }
                Ok(None) => {}
                Err(_) => break,
            }
        }
    });
    Ok((Share { stop, token, address: format!("{ip}:{port}"), others: Vec::new() }, port))
}

/// The link the phone opens: from the QR code, or pasted.
pub fn pair_link(share: &Share) -> String {
    let mut link = format!("yuuricloud://pair?h={}&t={}&n={}", share.address, share.token, url_encode(&computer_name()));
    if !share.others.is_empty() {
        link += &format!("&a={}", share.others.join(","));
    }
    link
}

fn url_encode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn reply_json(request: tiny_http::Request, status: u16, value: &Value) {
    let header = tiny_http::Header::from_bytes("Content-Type", "application/json").unwrap();
    let _ = request.respond(tiny_http::Response::from_string(value.to_string()).with_status_code(status).with_header(header));
}

fn authorized(request: &tiny_http::Request, token: &str) -> bool {
    let expected = format!("Bearer {token}");
    request.headers().iter().any(|h| h.field.equiv("Authorization") && h.value.as_str() == expected)
}

fn content_type(file: &str) -> &'static str {
    match std::path::Path::new(file).extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).as_deref() {
        Some("png") => "image/png",
        Some("webp") => "image/webp",
        Some("jpg" | "jpeg") => "image/jpeg",
        _ => "application/octet-stream",
    }
}

fn answer(source: &dyn Source, token: &str, request: tiny_http::Request) {
    if !authorized(&request, token) {
        return reply_json(request, 401, &json!({ "error": "Not paired with this computer" }));
    }
    let url = request.url().to_string();
    let (path, query) = url.split_once('?').unwrap_or((&url, ""));
    let param = |name: &str| query.split('&').find_map(|kv| kv.strip_prefix(name)?.strip_prefix('=').map(String::from));
    match (request.method(), path) {
        (tiny_http::Method::Get, "/hello") => reply_json(request, 200, &json!({ "name": computer_name() })),
        (tiny_http::Method::Get, "/library") => {
            let songs: Vec<SharedSong> = source
                .tracks()
                .iter()
                .map(|t| SharedSong {
                    id: song_id(&t.path),
                    title: t.title.clone(),
                    artist: t.artist.clone(),
                    album_artist: t.album_artist.clone(),
                    album: t.album.clone(),
                    year: t.year.clone(),
                    track_no: t.track_no,
                    disc_no: t.disc_no,
                    duration: t.duration,
                    size: std::fs::metadata(&t.path).map(|m| m.len()).unwrap_or(0),
                    file: std::path::Path::new(&t.path).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
                    has_cover: !t.cover.is_empty(),
                })
                .collect();
            let s = source.settings();
            let favorites: Vec<String> = s.favorites.iter().map(|p| song_id(p)).collect();
            let playlists: Vec<Value> = s.playlists.iter().map(|p| json!({ "name": p.name, "songs": p.songs.iter().map(|x| song_id(x)).collect::<Vec<_>>() })).collect();
            reply_json(request, 200, &json!({ "songs": songs, "favorites": favorites, "playlists": playlists }));
        }
        (tiny_http::Method::Get, p) if p.starts_with("/song/") || p.starts_with("/cover/") => {
            let cover = p.starts_with("/cover/");
            let id = p.rsplit('/').next().unwrap_or("");
            let Some(t) = source.tracks().into_iter().find(|t| song_id(&t.path) == id) else {
                return reply_json(request, 404, &json!({ "error": "No such song" }));
            };
            let file = if cover { t.cover } else { t.path };
            match std::fs::File::open(&file) {
                Ok(f) => {
                    let header = tiny_http::Header::from_bytes("Content-Type", content_type(&file)).unwrap();
                    let _ = request.respond(tiny_http::Response::from_file(f).with_header(header));
                }
                Err(_) => reply_json(request, 404, &json!({ "error": "The file is gone" })),
            }
        }
        // favourites and playlists, as a backup the phone can import
        (tiny_http::Method::Get, "/lists") => {
            let backup = crate::backup::make(&source.settings(), &source.tracks(), false);
            reply_json(request, 200, &serde_json::to_value(backup).unwrap_or(Value::Null));
        }
        (tiny_http::Method::Get, "/remote") => reply_json(request, 200, &source.now()),
        (tiny_http::Method::Post, p) if p.starts_with("/favorite/") => {
            let id = p.trim_start_matches("/favorite/");
            match source.tracks().into_iter().find(|t| song_id(&t.path) == id) {
                Some(t) => {
                    source.favorite(&t.path);
                    reply_json(request, 200, &json!({ "ok": true }));
                }
                None => reply_json(request, 404, &json!({ "error": "No such song" })),
            }
        }
        (tiny_http::Method::Post, p) if p.starts_with("/remote/") => {
            let value = param("value").and_then(|v| v.parse::<f64>().ok());
            source.command(p.trim_start_matches("/remote/"), value);
            reply_json(request, 200, &json!({ "ok": true }));
        }
        _ => reply_json(request, 404, &json!({ "error": "Not found" })),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::computer::{self, ComputerLink, SongToCopy};
    use std::sync::Mutex;

    struct Fake {
        tracks: Vec<Track>,
        settings: Settings,
        commands: Mutex<Vec<(String, Option<f64>)>>,
        favorited: Mutex<Vec<String>>,
    }

    impl Source for Fake {
        fn tracks(&self) -> Vec<Track> {
            self.tracks.clone()
        }
        fn settings(&self) -> Settings {
            self.settings.clone()
        }
        fn now(&self) -> Value {
            json!({ "title": "Song A", "playing": true })
        }
        fn command(&self, command: &str, value: Option<f64>) {
            self.commands.lock().unwrap().push((command.into(), value));
        }
        fn favorite(&self, path: &str) {
            self.favorited.lock().unwrap().push(path.into());
        }
    }

    /// The phone's code against the computer's server, over a real connection.
    #[test]
    fn phone_copies_songs_and_remote_controls() {
        let dir = std::env::temp_dir().join(format!("yuuricloud-share-{}", std::process::id()));
        let (pc, phone) = (dir.join("pc"), dir.join("phone"));
        std::fs::create_dir_all(pc.join("Album")).unwrap();
        let song = pc.join("Album").join("01 A.flac");
        std::fs::write(&song, vec![7u8; 300_000]).unwrap();
        std::fs::write(pc.join("Album").join("cover.png"), b"png!").unwrap();
        let track = Track {
            path: song.to_string_lossy().into_owned(),
            title: "Song A".into(),
            artist: "Band".into(),
            album_artist: "Band".into(),
            album: "Album".into(),
            cover: pc.join("Album").join("cover.png").to_string_lossy().into_owned(),
            ..Default::default()
        };
        let mut settings = Settings::default();
        settings.favorites = vec![track.path.clone()];
        let fake = Arc::new(Fake { tracks: vec![track], settings, commands: Mutex::new(Vec::new()), favorited: Mutex::new(Vec::new()) });
        let (share, port) = serve(fake.clone(), ("127.0.0.1", 0), "127.0.0.1").unwrap();

        let link = computer::from_link(&format!("yuuricloud://pair?h=127.0.0.1:{port}&t={}&n=PC", share.token)).unwrap();
        let library = computer::get_json(&link, "/library").unwrap();
        let s = &library["songs"][0];
        assert_eq!((s["title"].as_str(), s["size"].as_u64()), (Some("Song A"), Some(300_000)));
        assert_eq!(library["favorites"][0], s["id"]);

        // copy it: the file, and the album's cover picture next to it
        let want: SongToCopy = serde_json::from_value(s.clone()).unwrap();
        let cancel = AtomicBool::new(false);
        assert!(computer::copy(&link, &want, &phone, &cancel, &|_| {}).unwrap());
        let copied = computer::destination(&phone, &want);
        assert_eq!(std::fs::read(&copied).unwrap().len(), 300_000);
        assert_eq!(std::fs::read(copied.with_file_name("cover.jpg")).unwrap(), b"png!");
        assert!(!computer::copy(&link, &want, &phone, &cancel, &|_| {}).unwrap(), "already there");
        assert!(computer::cover(&link, &want.id).unwrap().starts_with("data:image/png;base64,"));

        // the remote
        assert_eq!(computer::get_json(&link, "/remote").unwrap()["title"], "Song A");
        computer::remote(&link, "seek", Some(42.5)).unwrap();
        assert_eq!(fake.commands.lock().unwrap()[0], ("seek".to_string(), Some(42.5)));

        // a favourite on the phone becomes one on the computer
        computer::favorite_there(&link, &want.id).unwrap();
        assert_eq!(*fake.favorited.lock().unwrap(), vec![fake.tracks[0].path.clone()]);
        assert!(computer::favorite_there(&link, "nosuchsong").is_err());

        // the wrong token gets nowhere
        let stranger = ComputerLink { token: "nope".into(), ..link.clone() };
        assert!(computer::get_json(&stranger, "/library").unwrap_err().contains("pair again"));
        drop(share);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
