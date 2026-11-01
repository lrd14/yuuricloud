//! The listening history behind the stats page: one line of JSON per song listened to, in
//! history.jsonl, so adding to it never rewrites the file.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;

use serde::{Deserialize, Serialize};

const FILE: &str = "history.jsonl";

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Listen {
    /// unix time the song started
    pub at: i64,
    /// seconds actually listened (seeking doesn't count)
    pub secs: u32,
    pub path: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    /// a SoundCloud song rather than one in the library
    pub sc: bool,
}

pub fn append(dir: &Path, listen: &Listen) -> Result<(), String> {
    let mut line = serde_json::to_string(listen).map_err(|e| e.to_string())?;
    line.push('\n');
    let _ = fs::create_dir_all(dir);
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join(FILE))
        .and_then(|mut f| f.write_all(line.as_bytes()))
        .map_err(|e| e.to_string())
}

/// Every listen, oldest first. Lines that don't read (say, cut short by a crash) are skipped.
pub fn read(dir: &Path) -> Vec<Listen> {
    fs::read_to_string(dir.join(FILE))
        .unwrap_or_default()
        .lines()
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn appends_and_reads_back() {
        let dir = std::env::temp_dir().join(format!("yuuricloud-history-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let a = Listen { at: 1, secs: 30, path: "/a.mp3".into(), title: "A".into(), ..Default::default() };
        let b = Listen { at: 2, secs: 200, path: "sc:1".into(), sc: true, ..Default::default() };
        append(&dir, &a).unwrap();
        // a half-written line in the middle doesn't lose the rest
        fs::OpenOptions::new().append(true).open(dir.join(FILE)).unwrap().write_all(b"{\"at\":").unwrap();
        fs::OpenOptions::new().append(true).open(dir.join(FILE)).unwrap().write_all(b"\n").unwrap();
        append(&dir, &b).unwrap();
        assert_eq!(read(&dir), vec![a, b]);
        let _ = fs::remove_dir_all(&dir);
    }
}
