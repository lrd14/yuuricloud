//! Saving SoundCloud songs as files.
//!
//! Songs the artist made downloadable come from SoundCloud's official download (often the
//! original upload). For anything else the user can opt in to yt-dlp, which they install
//! themselves; the app only runs it. Saved files get title, artist and cover tags so they slot
//! into the library like any other song.

use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};

use lofty::config::WriteOptions;
use lofty::picture::{Picture, PictureType};
use lofty::prelude::*;
use lofty::tag::{ItemKey, Tag};
use serde::{Deserialize, Serialize};

use crate::soundcloud::{self, Progress, ScConfig};

const AUDIO_EXTS: &[&str] = &["mp3", "m4a", "aac", "opus", "ogg", "flac", "wav", "aiff", "aif"];

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DownloadConfig {
    /// Where songs are saved. Empty = Music/SoundCloud.
    pub folder: String,
    /// Fall back to yt-dlp for songs the artist hasn't made downloadable.
    pub use_ytdlp: bool,
    /// The yt-dlp program. Empty = "yt-dlp" from the PATH.
    pub ytdlp_path: String,
}

/// The song to save, as the frontend has it.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadTrack {
    pub urn: String,
    pub title: String,
    pub artist: String,
    #[serde(default)]
    pub cover: String,
    #[serde(default)]
    pub permalink_url: String,
    #[serde(default)]
    pub downloadable: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Downloaded {
    pub path: String,
    /// "official", "yt-dlp", or "existing" when the file was already there
    pub via: String,
    /// File size in bytes.
    pub bytes: u64,
}

/// A file name that works on every OS: "Artist - Title".
pub fn file_stem(t: &DownloadTrack) -> String {
    let raw = if t.title.to_lowercase().contains(&t.artist.to_lowercase()) || t.artist.is_empty() {
        t.title.clone() // titles like "artist - song" already name the artist
    } else {
        format!("{} - {}", t.artist, t.title)
    };
    let clean: String = raw
        .chars()
        .map(|c| if c.is_control() || r#"<>:"/\|?*"#.contains(c) { '_' } else { c })
        .collect();
    let clean = clean.trim().trim_end_matches(['.', ' ']).to_string();
    let clean: String = clean.chars().take(150).collect();
    if clean.is_empty() { "Untitled".into() } else { clean }
}

fn existing(folder: &Path, stem: &str) -> Option<PathBuf> {
    AUDIO_EXTS.iter().map(|ext| folder.join(format!("{stem}.{ext}"))).find(|p| p.is_file())
}

pub fn download(
    cfg: &mut ScConfig,
    dl: &DownloadConfig,
    folder: &Path,
    t: &DownloadTrack,
    progress: Progress,
    cancel: &AtomicBool,
) -> Result<Downloaded, String> {
    std::fs::create_dir_all(folder).map_err(|e| format!("Can't create the download folder: {e}"))?;
    let stem = file_stem(t);
    if let Some(path) = existing(folder, &stem) {
        // fill in tags an older download may lack (e.g. a cover); existing tags are kept
        if let Err(e) = tag_file(&path, t) {
            eprintln!("couldn't tag {}: {e}", path.display());
        }
        let bytes = path.metadata().map(|m| m.len()).unwrap_or(0);
        return Ok(Downloaded { path: path.to_string_lossy().into_owned(), via: "existing".into(), bytes });
    }

    // Download and tag in a private work folder, then move the finished file in. Media players
    // and indexers watching the music folder grab new files at once, which blocks writing tags.
    let work = std::env::temp_dir().join("yuuricloud-downloads");
    std::fs::create_dir_all(&work).map_err(|e| format!("Can't create a temporary folder: {e}"))?;

    let mut official_error = None;
    if t.downloadable {
        match official(cfg, &work, &stem, t, progress, cancel) {
            Ok(path) => return finish(path, folder, "official", t),
            Err(e) if e == "Cancelled" => return Err(e),
            Err(e) => official_error = Some(e),
        }
    }
    if dl.use_ytdlp {
        let path = ytdlp(dl, &work, &stem, t, progress, cancel)?;
        return finish(path, folder, "yt-dlp", t);
    }
    Err(official_error.unwrap_or_else(|| {
        "The artist hasn't allowed downloads for this song. Turn on yt-dlp in Settings → Integrations to save it anyway".into()
    }))
}

/// Tag the file in the work folder, then move it into the download folder.
fn finish(path: PathBuf, folder: &Path, via: &str, t: &DownloadTrack) -> Result<Downloaded, String> {
    if let Err(e) = tag_file(&path, t) {
        eprintln!("couldn't tag {}: {e}", path.display()); // the song still plays, just named from the file
    }
    let dest = folder.join(path.file_name().ok_or("Bad file name")?);
    if std::fs::rename(&path, &dest).is_err() {
        // a different drive: copy across instead
        std::fs::copy(&path, &dest).map_err(|e| format!("Couldn't save the file: {e}"))?;
        let _ = std::fs::remove_file(&path);
    }
    let bytes = dest.metadata().map(|m| m.len()).unwrap_or(0);
    Ok(Downloaded { path: dest.to_string_lossy().into_owned(), via: via.into(), bytes })
}

/// SoundCloud's own download: the file the artist uploaded.
fn official(cfg: &mut ScConfig, folder: &Path, stem: &str, t: &DownloadTrack, progress: Progress, cancel: &AtomicBool) -> Result<PathBuf, String> {
    let bytes = soundcloud::download_original(cfg, &t.urn, progress, cancel)?;
    let ext = sniff_extension(&bytes).ok_or("SoundCloud sent a file the app doesn't recognise as audio")?;
    let path = folder.join(format!("{stem}.{ext}"));
    std::fs::write(&path, bytes).map_err(|e| format!("Couldn't save the file: {e}"))?;
    Ok(path)
}

pub fn sniff_extension(b: &[u8]) -> Option<&'static str> {
    if b.len() < 12 {
        return None;
    }
    Some(match () {
        _ if b.starts_with(b"RIFF") && &b[8..12] == b"WAVE" => "wav",
        _ if b.starts_with(b"fLaC") => "flac",
        _ if b.starts_with(b"OggS") => "ogg",
        _ if b.starts_with(b"FORM") => "aiff",
        _ if &b[4..8] == b"ftyp" => "m4a",
        _ if b.starts_with(b"ID3") || (b[0] == 0xFF && b[1] & 0xE0 == 0xE0) => "mp3",
        _ => return None,
    })
}

fn ytdlp_program(dl: &DownloadConfig) -> String {
    let p = dl.ytdlp_path.trim().trim_matches('"');
    if p.is_empty() { "yt-dlp".into() } else { p.into() }
}

fn command(program: &str) -> Command {
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: no console flashing up
    }
    cmd
}

/// The installed yt-dlp version, to show the user it was found.
pub fn ytdlp_version(dl: &DownloadConfig) -> Result<String, String> {
    let program = ytdlp_program(dl);
    let out = command(&program)
        .arg("--version")
        .output()
        .map_err(|e| format!("Couldn't run yt-dlp ({program}): {e}"))?;
    if !out.status.success() {
        return Err(format!("yt-dlp didn't start: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn ytdlp(dl: &DownloadConfig, folder: &Path, stem: &str, t: &DownloadTrack, progress: Progress, cancel: &AtomicBool) -> Result<PathBuf, String> {
    if t.permalink_url.is_empty() {
        return Err("This song has no SoundCloud link".into());
    }
    let program = ytdlp_program(dl);
    // yt-dlp treats % in the output name as a field; double it to keep it literal
    let template = folder.join(format!("{}.%(ext)s", stem.replace('%', "%%")));
    let mut child = command(&program)
        .args(["--no-playlist", "--no-warnings", "--no-mtime", "--no-simulate", "--newline", "--encoding", "utf-8"])
        // --print makes yt-dlp quiet; --progress keeps the progress lines coming
        .arg("--progress")
        .env("PYTHONIOENCODING", "utf-8")
        .args(["--progress-template", "download:PROGRESS %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s"])
        .args(["-f", "bestaudio/best", "--print", "after_move:filepath", "-o"])
        .arg(&template)
        .arg(t.permalink_url.split('?').next().unwrap_or(&t.permalink_url))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Couldn't run yt-dlp ({program}): {e}"))?;
    let mut stderr_pipe = child.stderr.take();
    let stderr_thread = std::thread::spawn(move || {
        let mut s = String::new();
        if let Some(pipe) = stderr_pipe.as_mut() {
            let _ = pipe.read_to_string(&mut s);
        }
        s
    });

    // stdout carries progress lines ("PROGRESS done total estimate") and finally the file path
    let mut path = None;
    if let Some(stdout) = child.stdout.take() {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            if cancel.load(Ordering::Relaxed) {
                let _ = child.kill();
                let _ = child.wait();
                return Err("Cancelled".into());
            }
            if let Some(rest) = line.trim().strip_prefix("PROGRESS ") {
                let nums: Vec<Option<u64>> = rest.split_whitespace().map(|n| n.parse::<f64>().ok().map(|v| v as u64)).collect();
                if let Some(Some(done)) = nums.first() {
                    let total = nums.get(1).copied().flatten().or(nums.get(2).copied().flatten());
                    progress(*done, total);
                }
            } else if !line.trim().is_empty() {
                path = Some(PathBuf::from(line.trim()));
            }
        }
    }
    let status = child.wait().map_err(|e| e.to_string())?;
    let stderr = stderr_thread.join().unwrap_or_default();
    // if the printed path got mangled, find the file by the name we asked for
    let path = path.filter(|p| p.is_file()).or_else(|| existing(folder, stem));
    match path {
        Some(p) if status.success() => Ok(p),
        _ => {
            let why = stderr.lines().rev().find(|l| l.contains("ERROR")).unwrap_or(stderr.trim()).trim();
            Err(format!("yt-dlp failed: {}", if why.is_empty() { "no file was saved" } else { why }))
        }
    }
}

/// Add title, artist and cover where the file doesn't have them yet.
fn tag_file(path: &Path, t: &DownloadTrack) -> Result<(), String> {
    let mut file = lofty::read_from_path(path).map_err(|e| e.to_string())?;
    if file.primary_tag().is_none() {
        let kind = file.file_type().primary_tag_type();
        file.insert_tag(Tag::new(kind));
    }
    let tag = file.primary_tag_mut().ok_or("no tag")?;
    let mut changed = false;
    if tag.title().is_none() {
        tag.set_title(t.title.clone());
        changed = true;
    }
    if tag.artist().is_none() {
        tag.set_artist(t.artist.clone());
        changed = true;
    }
    // SoundCloud songs are singles: without an album, every song in the download folder would be
    // lumped into one "Unknown Album"
    if tag.album().is_none() {
        tag.set_album(t.title.clone());
        changed = true;
    }
    if tag.get_string(ItemKey::AlbumArtist).is_none() {
        tag.insert_text(ItemKey::AlbumArtist, t.artist.clone());
        changed = true;
    }
    if tag.pictures().is_empty() && !t.cover.is_empty() {
        if let Some(bytes) = soundcloud::fetch_artwork(&t.cover) {
            if let Ok(mut picture) = Picture::from_reader(&mut &bytes[..]) {
                picture.set_pic_type(PictureType::CoverFront);
                tag.push_picture(picture);
                changed = true;
            }
        }
    }
    if changed {
        file.save_to_path(path, WriteOptions::default()).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn track(title: &str, artist: &str) -> DownloadTrack {
        DownloadTrack { urn: String::new(), title: title.into(), artist: artist.into(), cover: String::new(), permalink_url: String::new(), downloadable: false }
    }

    #[test]
    fn names_files_safely() {
        assert_eq!(file_stem(&track("Song", "Artist")), "Artist - Song");
        assert_eq!(file_stem(&track("artist - Song", "Artist")), "artist - Song");
        assert_eq!(file_stem(&track("a/b: c?", "x")), "x - a_b_ c_");
        assert_eq!(file_stem(&track("dots...", "")), "dots");
        assert_eq!(file_stem(&track("", "")), "Untitled");
    }

    #[test]
    fn sniffs_downloads() {
        assert_eq!(sniff_extension(b"RIFF\0\0\0\0WAVEfmt "), Some("wav"));
        assert_eq!(sniff_extension(b"fLaC\0\0\0\0\0\0\0\0"), Some("flac"));
        assert_eq!(sniff_extension(b"<html><body>"), None);
    }
}



