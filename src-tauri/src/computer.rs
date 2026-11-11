//! The phone's side of "Let your phone connect" (share.rs on the computer): pairing, copying songs
//! from the computer over Wi-Fi, and using the computer as something to remote-control.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The computer this phone is paired with.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ComputerLink {
    /// "192.168.1.5:8975"
    pub address: String,
    pub token: String,
    pub name: String,
    /// the computer's other addresses (no port), tried when `address` doesn't answer
    pub others: Vec<String>,
}

impl ComputerLink {
    pub fn linked(&self) -> bool {
        !self.address.is_empty() && !self.token.is_empty()
    }
}

/// A song to copy, as the computer lists it.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SongToCopy {
    pub id: String,
    pub title: String,
    pub artist: String,
    pub duration: f64,
    pub file: String,
    pub album_artist: String,
    pub album: String,
    pub size: u64,
    pub has_cover: bool,
}

fn url_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Some(v) = std::str::from_utf8(&b[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(if b[i] == b'+' { b' ' } else { b[i] });
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Read the computer's pairing link (`yuuricloud://pair?h=…&t=…&n=…`).
pub fn from_link(text: &str) -> Result<ComputerLink, String> {
    let bad = || "That isn't a yuuricloud pairing code — copy it from the computer again".to_string();
    let query = text.trim().split_once("pair?").map(|(_, q)| q).ok_or_else(bad)?;
    let param = |name: &str| query.split('&').find_map(|kv| kv.strip_prefix(name)?.strip_prefix('=').map(url_decode));
    let mut link = ComputerLink { address: param("h").ok_or_else(bad)?, token: param("t").ok_or_else(bad)?, name: param("n").unwrap_or_else(|| "Computer".into()), others: Vec::new() };
    // only an address on this network, with a port
    let host = link.address.rsplit_once(':').map(|(h, _)| h).ok_or_else(bad)?;
    if host.parse::<std::net::IpAddr>().is_err() {
        return Err(bad());
    }
    link.others = param("a").unwrap_or_default().split(',').filter(|ip| ip.parse::<std::net::Ipv4Addr>().is_ok()).map(String::from).collect();
    Ok(link)
}

fn agent(secs: u64) -> ureq::Agent {
    ureq::Agent::config_builder().http_status_as_error(false).timeout_global(Some(Duration::from_secs(secs))).build().into()
}

fn call(link: &ComputerLink, method: &str, path: &str, secs: u64) -> Result<ureq::http::Response<ureq::Body>, String> {
    call_body(link, method, path, secs, None)
}

fn call_body(
    link: &ComputerLink,
    method: &str,
    path: &str,
    secs: u64,
    body: Option<&Value>,
) -> Result<ureq::http::Response<ureq::Body>, String> {
    if !link.linked() {
        return Err("Pair with a computer first".into());
    }
    let url = format!("http://{}{path}", link.address);
    let auth = format!("Bearer {}", link.token);
    let res = match (method, body) {
        ("POST", Some(v)) => agent(secs)
            .post(&url)
            .header("Authorization", &auth)
            .header("Content-Type", "application/json")
            .send_json(v),
        ("POST", None) => agent(secs).post(&url).header("Authorization", &auth).send_empty(),
        _ => agent(secs).get(&url).header("Authorization", &auth).call(),
    }
    .map_err(|_| unreachable(link))?;
    match res.status().as_u16() {
        401 => Err(format!("{} doesn't know this phone anymore: pair again", link.name)),
        s if s >= 400 => Err(format!("{} said {s}", link.name)),
        _ => Ok(res),
    }
}

/// What to check when the computer doesn't answer.
fn unreachable(link: &ComputerLink) -> String {
    format!(
        "Can't reach {} at {}. Check that yuuricloud is open there with \"Let your phone connect\" on and both are on the same Wi-Fi. \
         On the computer, allow yuuricloud through the firewall (Settings → Integrations → Phone & computer → Allow through firewall). \
         On an iPhone, turn on Settings → Privacy & Security → Local Network → yuuricloud.",
        link.name, link.address
    )
}

/// Find the address the computer answers on: the one in the link, or one of its others. Returns
/// the link with that address, and the computer's name as it gives it.
pub fn reach(link: &ComputerLink) -> Result<ComputerLink, String> {
    let port = link.address.rsplit_once(':').map(|(_, p)| p.to_string()).unwrap_or_default();
    let mut tries = vec![link.address.clone()];
    tries.extend(link.others.iter().map(|ip| format!("{ip}:{port}")));
    let mut last = None;
    for address in tries {
        let attempt = ComputerLink { address, ..link.clone() };
        match call(&attempt, "GET", "/hello", 5).and_then(|mut r| r.body_mut().read_json::<Value>().map_err(|e| e.to_string())) {
            Ok(hello) => {
                let mut found = attempt;
                if let Some(name) = hello["name"].as_str() {
                    found.name = name.to_string();
                }
                return Ok(found);
            }
            // the computer answered but turned us down: no use trying its other addresses
            Err(e) if !e.starts_with("Can't reach") => return Err(e),
            Err(e) => last = Some(e),
        }
    }
    Err(last.unwrap_or_else(|| unreachable(link)))
}

pub fn get_json(link: &ComputerLink, path: &str) -> Result<Value, String> {
    call(link, "GET", path, 20)?.body_mut().read_json().map_err(|e| e.to_string())
}

/// POST JSON to the computer and return its JSON reply.
pub fn post_json(link: &ComputerLink, path: &str, body: &Value) -> Result<Value, String> {
    call_body(link, "POST", path, 20, Some(body))?
        .body_mut()
        .read_json()
        .map_err(|e| e.to_string())
}

pub fn remote(link: &ComputerLink, command: &str, value: Option<f64>) -> Result<(), String> {
    let query = value.map(|v| format!("?value={v}")).unwrap_or_default();
    call(link, "POST", &format!("/remote/{command}{query}"), 8).map(|_| ())
}

/// A song's cover from the computer, as a `data:` URL the webview can show.
pub fn cover(link: &ComputerLink, id: &str) -> Result<String, String> {
    use base64::Engine;
    let mut res = call(link, "GET", &format!("/cover/{id}"), 20)?;
    let mime = res.headers().get("Content-Type").and_then(|v| v.to_str().ok()).unwrap_or("image/jpeg").to_string();
    let bytes = res.body_mut().with_config().limit(20 << 20).read_to_vec().map_err(|e| e.to_string())?;
    Ok(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
}

/// A name from the other computer, made safe as a folder or file name here.
fn safe(name: &str) -> String {
    let clean: String = name.chars().map(|c| if c.is_control() || r#"<>:"/\|?*"#.contains(c) { '_' } else { c }).collect();
    let clean = clean.trim().trim_matches('.').to_string();
    if clean.is_empty() { "_".into() } else { clean }
}

/// Letters and digits only, lower case: "Lil-Darkie " and "lil darkie" are the same name.
fn name_key(s: &str) -> String {
    s.chars().filter(|c| c.is_alphanumeric()).flat_map(char::to_lowercase).collect()
}

/// The phone's copy of a song from the computer, if it has one already (wherever it is): the same
/// title by the same artist and about as long, or a file of the same name and size.
pub fn already_here<'a>(song: &SongToCopy, tracks: &'a [crate::library::Track]) -> Option<&'a crate::library::Track> {
    let title = name_key(&song.title);
    let artist = name_key(&song.artist);
    let artists = [artist.as_str(), name_key(&song.album_artist).as_str()].map(String::from);
    tracks.iter().find(|t| {
        let same_file = !song.file.is_empty()
            && Path::new(&t.path).file_name().is_some_and(|n| n.to_string_lossy().eq_ignore_ascii_case(&song.file))
            && song.size > 0
            && std::fs::metadata(&t.path).is_ok_and(|m| m.len() == song.size);
        let close = song.duration <= 0.0 || t.duration <= 0.0 || (song.duration - t.duration).abs() <= 3.0;
        let same_song = !title.is_empty()
            && name_key(&t.title) == title
            && close
            && [name_key(&t.artist), name_key(&t.album_artist)].iter().any(|a| !a.is_empty() && artists.iter().any(|b| b == a));
        same_file || same_song
    })
}

/// Tell the computer to make one of its songs a favourite.
pub fn favorite_there(link: &ComputerLink, id: &str) -> Result<(), String> {
    call(link, "POST", &format!("/favorite/{id}"), 8).map(|_| ())
}

/// Where a copied song goes: `<root>/<album artist>/<album>/<file>`.
pub fn destination(root: &Path, song: &SongToCopy) -> PathBuf {
    root.join(safe(&song.album_artist)).join(safe(&song.album)).join(safe(&song.file))
}

/// Copy one song (and its album's cover, once) into `root`. Songs already there are skipped.
/// Returns whether anything was copied.
pub fn copy(link: &ComputerLink, song: &SongToCopy, root: &Path, cancel: &AtomicBool, progress: &dyn Fn(u64)) -> Result<bool, String> {
    let dest = destination(root, song);
    if std::fs::metadata(&dest).is_ok_and(|m| m.len() == song.size) {
        return Ok(false);
    }
    let dir = dest.parent().unwrap();
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let mut res = call(link, "GET", &format!("/song/{}", song.id), 600)?;
    let part = dest.with_extension("part");
    let mut out = std::fs::File::create(&part).map_err(|e| e.to_string())?;
    let mut reader = res.body_mut().with_config().limit(4 << 30).reader();
    let mut buf = vec![0u8; 256 << 10];
    let mut done = 0u64;
    loop {
        if cancel.load(Ordering::Relaxed) {
            drop(out);
            let _ = std::fs::remove_file(&part);
            return Err("Cancelled".into());
        }
        let n = reader.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        out.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        done += n as u64;
        progress(done);
    }
    drop(out);
    std::fs::rename(&part, &dest).map_err(|e| e.to_string())?;
    // the album's cover picture, when the computer had one in the folder rather than in the songs
    let cover = dir.join("cover.jpg");
    if song.has_cover && !cover.exists() {
        if let Ok(mut res) = call(link, "GET", &format!("/cover/{}", song.id), 30) {
            if let Ok(bytes) = res.body_mut().with_config().limit(20 << 20).read_to_vec() {
                let _ = std::fs::write(cover, bytes);
            }
        }
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_pairing_links() {
        let l = from_link("yuuricloud://pair?h=192.168.1.5:8975&t=abc123&n=Noah%27s%20PC").unwrap();
        assert_eq!(l, ComputerLink { address: "192.168.1.5:8975".into(), token: "abc123".into(), name: "Noah's PC".into(), others: vec![] });
        let l = from_link("yuuricloud://pair?h=172.20.0.1:8975&t=x&n=PC&a=192.168.1.5,nope,10.0.0.2").unwrap();
        assert_eq!(l.others, vec!["192.168.1.5", "10.0.0.2"]);
        assert!(from_link("yuuricloud://pair?h=evil.example.com:80&t=x").is_err(), "only addresses on this network");
        assert!(from_link("hello").is_err());
    }

    #[test]
    fn finds_songs_already_on_the_phone() {
        use crate::library::Track;
        let here = vec![
            Track { path: "/p/x/Roygbiv.mp3".into(), title: "Roygbiv".into(), artist: "Boards of Canada".into(), album_artist: "Boards of Canada".into(), duration: 151.0, ..Default::default() },
            Track { path: "/p/y/Live.mp3".into(), title: "Olson".into(), artist: "Boards of Canada".into(), duration: 400.0, ..Default::default() },
        ];
        let song = |title: &str, artist: &str, duration: f64| SongToCopy { title: title.into(), artist: artist.into(), album_artist: artist.into(), duration, file: "01.flac".into(), ..Default::default() };
        assert_eq!(already_here(&song("roygbiv", "Boards Of Canada", 152.4), &here).map(|t| t.path.as_str()), Some("/p/x/Roygbiv.mp3"), "a FLAC of the same song counts");
        assert!(already_here(&song("Olson", "Boards of Canada", 91.0), &here).is_none(), "a different length is a different version");
        assert!(already_here(&song("Roygbiv", "Someone Else", 151.0), &here).is_none());
    }

    #[test]
    fn copies_go_into_artist_and_album_folders() {
        let s = SongToCopy { file: "01 Song.flac".into(), album_artist: "AC/DC".into(), album: "..".into(), ..Default::default() };
        assert_eq!(destination(Path::new("/r"), &s), Path::new("/r").join("AC_DC").join("_").join("01 Song.flac"));
    }
}
