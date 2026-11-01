//! Song lyrics from LRCLIB (https://lrclib.net), a free lyrics database that needs no key. Synced
//! lyrics come as LRC text ("[01:23.45] a line"); the frontend highlights the line being sung.
//! Answers, including "nothing found", are cached so a song is only looked up once.

use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;

const API: &str = "https://lrclib.net/api";

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Lyrics {
    /// LRC text with a time on each line, when LRCLIB has it
    pub synced: Option<String>,
    pub plain: Option<String>,
    pub instrumental: bool,
}

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .http_status_as_error(false)
        .timeout_global(Some(std::time::Duration::from_secs(12)))
        .build()
        .into()
}

fn from_json(v: &Value) -> Lyrics {
    let text = |key: &str| v[key].as_str().map(str::trim).filter(|s| !s.is_empty()).map(String::from);
    Lyrics { synced: text("syncedLyrics"), plain: text("plainLyrics"), instrumental: v["instrumental"].as_bool().unwrap_or(false) }
}

fn found(l: &Lyrics) -> bool {
    l.synced.is_some() || l.plain.is_some() || l.instrumental
}

fn query(pairs: &[(&str, &str)]) -> String {
    pairs
        .iter()
        .filter(|(_, v)| !v.is_empty())
        .map(|(k, v)| format!("{k}={}", url_encode(v)))
        .collect::<Vec<_>>()
        .join("&")
}

fn url_encode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// Ask LRCLIB: the exact song first, then a search, taking the result closest in length.
fn look_up(title: &str, artist: &str, album: &str, duration: f64) -> Result<Lyrics, String> {
    let agent = agent();
    let get = |url: String| -> Result<(u16, Value), String> {
        let mut res = agent
            .get(&url)
            .header("User-Agent", "yuuricloud (https://github.com/lrd14/yuuricloud)")
            .call()
            .map_err(|e| format!("Couldn't reach the lyrics service: {e}"))?;
        let status = res.status().as_u16();
        Ok((status, res.body_mut().read_json().unwrap_or(Value::Null)))
    };
    let secs = if duration > 0.0 { (duration.round() as i64).to_string() } else { String::new() };
    let (status, v) = get(format!("{API}/get?{}", query(&[("track_name", title), ("artist_name", artist), ("album_name", album), ("duration", &secs)])))?;
    if status == 200 && found(&from_json(&v)) {
        return Ok(from_json(&v));
    }
    let (status, v) = get(format!("{API}/search?{}", query(&[("track_name", title), ("artist_name", artist)])))?;
    if status != 200 {
        return Ok(Lyrics::default());
    }
    let best = v
        .as_array()
        .into_iter()
        .flatten()
        .filter(|r| found(&from_json(r)))
        .min_by_key(|r| if duration > 0.0 { (r["duration"].as_f64().unwrap_or(0.0) - duration).abs() as i64 } else { 0 });
    Ok(best.map(from_json).unwrap_or_default())
}

/// Lyrics for a song, from the cache in `cache_dir` or from LRCLIB.
pub fn get(title: &str, artist: &str, album: &str, duration: f64, cache_dir: &Path) -> Result<Lyrics, String> {
    let key = format!("{:x}", md5::compute(format!("{}\0{}\0{}", title.to_lowercase(), artist.to_lowercase(), album.to_lowercase())));
    let file = cache_dir.join(format!("{key}.json"));
    if let Some(cached) = crate::library::load_json::<Lyrics>(&file) {
        return Ok(cached);
    }
    let lyrics = look_up(title, artist, album, duration)?;
    let _ = std::fs::create_dir_all(cache_dir);
    crate::library::save_json(&file, &lyrics);
    Ok(lyrics)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_lrclib_answers() {
        let v = serde_json::json!({ "syncedLyrics": "[00:01.00] hi", "plainLyrics": "  ", "instrumental": false });
        let l = from_json(&v);
        assert_eq!(l.synced.as_deref(), Some("[00:01.00] hi"));
        assert_eq!(l.plain, None);
        assert!(found(&l));
        assert!(!found(&from_json(&serde_json::json!({}))));
    }

    #[test]
    #[ignore = "needs the internet"]
    fn finds_real_lyrics() {
        let l = look_up("Bohemian Rhapsody", "Queen", "", 355.0).unwrap();
        assert!(l.synced.unwrap().contains("Is this the real life"));
        // a search finds it without the album or length too
        assert!(look_up("bohemian rhapsody", "queen", "Some Other Album", 0.0).unwrap().plain.is_some());
    }

    #[test]
    fn builds_queries() {
        assert_eq!(query(&[("track_name", "Jóga"), ("artist_name", "Björk & co"), ("album_name", "")]), "track_name=J%C3%B3ga&artist_name=Bj%C3%B6rk%20%26%20co");
    }
}
