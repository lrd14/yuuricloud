//! Playlists as .m3u / .m3u8 files, to take them to and from other players.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::library::Track;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub path: String,
    pub title: String,
    pub artist: String,
    pub duration: f64,
}

/// An extended M3U playlist (UTF-8, so it's really .m3u8) with absolute paths.
pub fn write(entries: &[Entry]) -> String {
    let mut out = String::from("#EXTM3U\n");
    for e in entries {
        out += &format!("#EXTINF:{},{} - {}\n{}\n", e.duration.round() as i64, e.artist, e.title, e.path);
    }
    out
}

/// The songs a playlist file lists, as paths: relative ones are taken from the file's folder,
/// and file:// URLs are turned back into paths. Streams (http…) are skipped.
pub fn parse(text: &str, base: &Path) -> Vec<PathBuf> {
    text.trim_start_matches('\u{feff}')
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .filter(|l| !l.contains("://") || l.starts_with("file://"))
        .map(|l| {
            let l = l.strip_prefix("file://").map(percent_decode).unwrap_or_else(|| l.to_string());
            // "file:///C:/x" leaves "/C:/x" on Windows
            let l = if l.len() > 2 && l.starts_with('/') && l.as_bytes()[2] == b':' { l[1..].to_string() } else { l };
            let p = PathBuf::from(l.replace(if cfg!(windows) { '/' } else { '\\' }, std::path::MAIN_SEPARATOR_STR));
            if p.is_absolute() { p } else { base.join(p) }
        })
        .collect()
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(b) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Find each listed file in the library: by its path, or else by its file name when only one
/// library song has that name (the music moved, or the list came from another computer).
/// Returns the library paths found, in order, and how many weren't.
pub fn match_library(paths: &[PathBuf], tracks: &[Track]) -> (Vec<String>, usize) {
    let norm = |p: &str| p.replace('\\', "/").to_lowercase();
    let by_path: HashMap<String, &str> = tracks.iter().map(|t| (norm(&t.path), t.path.as_str())).collect();
    let mut by_name: HashMap<String, Vec<&str>> = HashMap::new();
    for t in tracks {
        let name = Path::new(&t.path).file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
        by_name.entry(name).or_default().push(&t.path);
    }
    let mut found = Vec::new();
    let mut missing = 0;
    for p in paths {
        let s = p.to_string_lossy();
        let name = s.rsplit(['/', '\\']).next().unwrap_or("").to_lowercase();
        let hit = by_path.get(&norm(&s)).copied().or_else(|| by_name.get(&name).filter(|v| v.len() == 1).map(|v| v[0]));
        match hit {
            Some(h) if !found.iter().any(|f| f == h) => found.push(h.to_string()),
            Some(_) => {}
            None => missing += 1,
        }
    }
    (found, missing)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn track(path: &str) -> Track {
        Track { path: path.into(), ..Default::default() }
    }

    #[test]
    fn writes_and_reads_back() {
        let text = write(&[Entry { path: "/m/a/01 Song.flac".into(), title: "Song".into(), artist: "Band".into(), duration: 61.6 }]);
        assert_eq!(text, "#EXTM3U\n#EXTINF:62,Band - Song\n/m/a/01 Song.flac\n");
        if !cfg!(windows) {
            assert_eq!(parse(&text, Path::new("/x")), vec![PathBuf::from("/m/a/01 Song.flac")]);
        }
    }

    #[test]
    fn reads_relative_paths_and_urls() {
        if cfg!(windows) {
            return;
        }
        let text = "\u{feff}#EXTM3U\n\nsub\\02 Two.mp3\nfile:///m/b/Three%20(x).mp3\nhttp://radio/stream\n";
        assert_eq!(parse(text, Path::new("/lists")), vec![PathBuf::from("/lists/sub/02 Two.mp3"), PathBuf::from("/m/b/Three (x).mp3")]);
    }

    #[test]
    fn matches_by_path_then_by_unique_name() {
        let tracks = [track("/m/a/One.mp3"), track("/m/b/Two.mp3"), track("/m/c/Two.mp3"), track("/m/d/Three.mp3")];
        let listed = ["/M/A/one.mp3", "/elsewhere/Three.mp3", "/elsewhere/Two.mp3", "/nope/Four.mp3"].map(PathBuf::from);
        let (found, missing) = match_library(&listed, &tracks);
        assert_eq!(found, vec!["/m/a/One.mp3", "/m/d/Three.mp3"]);
        assert_eq!(missing, 2); // Two.mp3 is ambiguous, Four isn't there
    }
}
