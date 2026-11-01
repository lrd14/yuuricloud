//! Looking up song and album info on MusicBrainz, and covers on the Cover Art Archive, to fill
//! in what a song's tags are missing (the song editor's "Find online").

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

const API: &str = "https://musicbrainz.org/ws/2";
/// MusicBrainz asks every app to say who it is.
const USER_AGENT: &str = concat!("yuuricloud/", env!("CARGO_PKG_VERSION"), " ( https://github.com/lrd14/yuuricloud )");

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .http_status_as_error(false)
        .timeout_global(Some(Duration::from_secs(15)))
        .user_agent(USER_AGENT)
        .build()
        .into()
}

fn get_json(url: &str) -> Result<Value, String> {
    let mut res = agent().get(url).call().map_err(|e| format!("Couldn't reach MusicBrainz: {e}"))?;
    match res.status().as_u16() {
        200 => res.body_mut().read_json().map_err(|e| e.to_string()),
        503 => Err("MusicBrainz is busy, try again in a moment".into()),
        s => Err(format!("MusicBrainz answered {s}")),
    }
}

/// Lucene query syntax: quote the value and escape what would end the quote.
fn quoted(s: &str) -> String {
    format!("\"{}\"", s.trim().replace('\\', "\\\\").replace('"', "\\\""))
}

fn enc(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn credit(v: &Value) -> String {
    v.as_array()
        .map(|a| a.iter().map(|c| format!("{}{}", c["name"].as_str().unwrap_or(""), c["joinphrase"].as_str().unwrap_or(""))).collect::<String>())
        .unwrap_or_default()
}

fn year(date: &Value) -> String {
    date.as_str().unwrap_or("").chars().take(4).collect()
}

/// One way a song could be tagged: the recording on one of its releases.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SongMatch {
    pub title: String,
    pub artist: String,
    pub album: String,
    pub album_artist: String,
    pub year: String,
    pub track_no: Option<u32>,
    pub disc_no: Option<u32>,
    pub release_id: String,
    /// seconds, to tell versions apart
    pub length: Option<u32>,
    /// MusicBrainz's 0-100 match score
    pub score: u32,
    /// lower is better: an official album beats a single, a compilation or a DJ mix
    #[serde(skip)]
    rank: u8,
}

/// Recordings matching a title and artist (and album, when known), one entry per release.
pub fn search_song(title: &str, artist: &str, album: &str) -> Result<Vec<SongMatch>, String> {
    let mut q = format!("recording:{}", quoted(title));
    if !artist.trim().is_empty() {
        q += &format!(" AND artist:{}", quoted(artist));
    }
    if !album.trim().is_empty() {
        // a hint, not a must: the song may be on a different release of the same music
        q += &format!(" AND (release:{} OR status:official)", quoted(album));
    }
    let v = get_json(&format!("{API}/recording?query={}&limit=10&fmt=json", enc(&q)))?;
    Ok(songs_from(&v))
}

fn songs_from(v: &Value) -> Vec<SongMatch> {
    let mut out: Vec<SongMatch> = Vec::new();
    for rec in v["recordings"].as_array().into_iter().flatten() {
        let artist = credit(&rec["artist-credit"]);
        let score = rec["score"].as_u64().unwrap_or(0) as u32;
        let length = rec["length"].as_u64().map(|ms| (ms / 1000) as u32);
        // official albums first, then the rest; at most three releases per recording
        let mut releases: Vec<&Value> = rec["releases"].as_array().map(|a| a.iter().collect()).unwrap_or_default();
        releases.sort_by_key(|r| (release_rank(r), year(&r["date"]).is_empty(), year(&r["date"])));
        for r in releases.into_iter().take(3) {
            let media = &r["media"][0];
            let m = SongMatch {
                title: rec["title"].as_str().unwrap_or("").to_string(),
                artist: artist.clone(),
                album: r["title"].as_str().unwrap_or("").to_string(),
                album_artist: Some(credit(&r["artist-credit"])).filter(|s| !s.is_empty()).unwrap_or_else(|| artist.clone()),
                year: year(&r["date"]),
                track_no: media["track"][0]["number"].as_str().and_then(|n| n.parse().ok()).or_else(|| media["track-offset"].as_u64().map(|o| o as u32 + 1)),
                disc_no: media["position"].as_u64().map(|p| p as u32),
                release_id: r["id"].as_str().unwrap_or("").to_string(),
                length,
                score,
                rank: release_rank(r),
            };
            if !out.iter().any(|o| o.album == m.album && o.title == m.title && o.year == m.year) {
                out.push(m);
            }
        }
    }
    // close matches first, and among those the proper albums
    out.sort_by_key(|m| (m.score < 90, m.rank, std::cmp::Reverse(m.score)));
    out
}

fn release_rank(r: &Value) -> u8 {
    let official = r["status"].as_str() == Some("Official");
    let kind = r["release-group"]["primary-type"].as_str().unwrap_or("");
    let secondary = r["release-group"]["secondary-types"].as_array().is_some_and(|t| !t.is_empty());
    let kind_rank = match kind {
        "Album" => 0,
        "EP" => 1,
        "Single" => 2,
        _ => 4,
    };
    kind_rank + u8::from(secondary) * 2 + u8::from(!official) * 5
}

/// One album, with its songs, to tag a whole album from.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AlbumMatch {
    pub album: String,
    pub album_artist: String,
    pub year: String,
    pub release_id: String,
    pub country: String,
    pub format: String,
    pub track_count: u32,
    pub score: u32,
}

pub fn search_album(album: &str, artist: &str) -> Result<Vec<AlbumMatch>, String> {
    let mut q = format!("release:{}", quoted(album));
    if !artist.trim().is_empty() {
        q += &format!(" AND artist:{}", quoted(artist));
    }
    let v = get_json(&format!("{API}/release?query={}&limit=12&fmt=json", enc(&q)))?;
    Ok(albums_from(&v))
}

fn albums_from(v: &Value) -> Vec<AlbumMatch> {
    v["releases"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|r| AlbumMatch {
            album: r["title"].as_str().unwrap_or("").to_string(),
            album_artist: credit(&r["artist-credit"]),
            year: year(&r["date"]),
            release_id: r["id"].as_str().unwrap_or("").to_string(),
            country: r["country"].as_str().unwrap_or("").to_string(),
            format: r["media"].as_array().map(|m| m.iter().filter_map(|x| x["format"].as_str()).collect::<Vec<_>>().join(" + ")).unwrap_or_default(),
            track_count: r["track-count"].as_u64().unwrap_or(0) as u32,
            score: r["score"].as_u64().unwrap_or(0) as u32,
        })
        .collect()
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AlbumTrack {
    pub title: String,
    pub artist: String,
    pub track_no: u32,
    pub disc_no: u32,
    pub length: Option<u32>,
}

/// The songs on a release, in order.
pub fn album_tracks(release_id: &str) -> Result<Vec<AlbumTrack>, String> {
    let v = get_json(&format!("{API}/release/{}?inc=recordings+artist-credits&fmt=json", enc(release_id)))?;
    Ok(tracks_from(&v))
}

fn tracks_from(v: &Value) -> Vec<AlbumTrack> {
    let mut out = Vec::new();
    for (i, media) in v["media"].as_array().into_iter().flatten().enumerate() {
        let disc = media["position"].as_u64().map(|p| p as u32).unwrap_or(i as u32 + 1);
        for (j, t) in media["tracks"].as_array().into_iter().flatten().enumerate() {
            out.push(AlbumTrack {
                title: t["title"].as_str().unwrap_or("").to_string(),
                artist: credit(&t["artist-credit"]),
                track_no: t["position"].as_u64().map(|p| p as u32).unwrap_or(j as u32 + 1),
                disc_no: disc,
                length: t["length"].as_u64().map(|ms| (ms / 1000) as u32),
            });
        }
    }
    out
}

/// Download a release's front cover into `dir`; None when it has none.
pub fn fetch_cover(release_id: &str, dir: &Path) -> Result<Option<PathBuf>, String> {
    let url = format!("https://coverartarchive.org/release/{}/front-1200", enc(release_id));
    let mut res = agent().get(&url).call().map_err(|e| format!("Couldn't reach the Cover Art Archive: {e}"))?;
    match res.status().as_u16() {
        200 => {}
        404 => return Ok(None),
        s => return Err(format!("The Cover Art Archive answered {s}")),
    }
    let bytes = res.body_mut().with_config().limit(30 * 1024 * 1024).read_to_vec().map_err(|e| e.to_string())?;
    let _ = std::fs::create_dir_all(dir);
    let path = dir.join(format!("{}.jpg", release_id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').collect::<String>()));
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(Some(path))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn songs_prefer_official_albums() {
        let v = json!({ "recordings": [{
            "title": "Roygbiv", "score": 100, "length": 151000,
            "artist-credit": [{ "name": "Boards of Canada", "joinphrase": "" }],
            "releases": [
                { "id": "c", "title": "Best Of", "status": "Official", "date": "2010", "release-group": { "primary-type": "Album", "secondary-types": ["Compilation"] }, "media": [{ "position": 1, "track": [{ "number": "3" }] }] },
                { "id": "b", "title": "Music Has the Right to Children", "status": "Official", "date": "1998-04-20",
                  "artist-credit": [{ "name": "Boards of Canada", "joinphrase": "" }],
                  "release-group": { "primary-type": "Album" }, "media": [{ "position": 1, "track": [{ "number": "11" }] }] },
                { "id": "a", "title": "Bootleg", "status": "Bootleg", "date": "1999", "release-group": { "primary-type": "Album" }, "media": [] }
            ]
        }]});
        let m = songs_from(&v);
        assert_eq!(m.len(), 3);
        assert_eq!(m[0].album, "Music Has the Right to Children");
        assert_eq!((m[0].year.as_str(), m[0].track_no, m[0].disc_no, m[0].length), ("1998", Some(11), Some(1), Some(151)));
        assert_eq!(m[1].album, "Best Of");
        assert_eq!(m[2].track_no, None);
    }

    #[test]
    fn album_tracks_keep_discs() {
        let v = json!({ "media": [
            { "position": 1, "tracks": [{ "title": "One", "position": 1, "length": 60000, "artist-credit": [{ "name": "A", "joinphrase": " feat. " }, { "name": "B" }] }] },
            { "position": 2, "tracks": [{ "title": "Two", "position": 1 }] }
        ]});
        let t = tracks_from(&v);
        assert_eq!(t[0].artist, "A feat. B");
        assert_eq!((t[1].disc_no, t[1].track_no, t[1].length), (2, 1, None));
    }

    #[test]
    fn queries_are_quoted() {
        assert_eq!(quoted(r#"say "hi"\"#), r#""say \"hi\"\\""#);
        assert_eq!(enc("a b&c"), "a%20b%26c");
    }
}
