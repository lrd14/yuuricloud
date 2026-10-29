//! Music library: walks folders, reads tags, and infers artist/album from folder layout.
//!
//! Expected (but not required) layout under a library folder:
//!     <root>/<Artist>/<Album (Year)>/[CD1/]<01 - Title>.ext
//! Tags fill in whatever the folder structure can't tell us.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::UNIX_EPOCH;

use lofty::prelude::*;
use lofty::tag::ItemKey;
use regex::Regex;
use serde::{Deserialize, Serialize};
use walkdir::WalkDir;

/// Formats every desktop webview (WebView2, WebKit, WebKitGTK) can usually decode.
const AUDIO_EXTS: &[&str] = &["mp3", "flac", "m4a", "mp4", "aac", "ogg", "oga", "opus", "wav", "webm"];
const IMAGE_EXTS: &[&str] = &["jpg", "jpeg", "png", "webp", "bmp", "gif"];
const COVER_NAMES: &[&str] = &["cover", "folder", "front", "album", "albumart", "albumartsmall"];

pub const UNKNOWN_ARTIST: &str = "Unknown Artist";
pub const UNKNOWN_ALBUM: &str = "Unknown Album";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub path: String,
    pub root: String,
    pub mtime: u64,
    pub title: String,
    /// Performer shown in the song list.
    pub artist: String,
    /// Artist the album is grouped under.
    pub album_artist: String,
    pub album: String,
    pub track_no: u32,
    pub disc_no: u32,
    pub year: String,
    pub duration: f64,
    pub cover: String,
    /// Small copy of `cover` for the album and song grids.
    #[serde(default)]
    pub thumb: String,
}

impl Track {
    fn album_key(&self) -> String {
        format!("{}\u{0}{}", self.album_artist.to_lowercase(), self.album.to_lowercase())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub folders: Vec<String>,
    pub volume: f64,
    /// Name artists/albums from file tags first (true) or from folder names first (false).
    pub prefer_tags: bool,
    /// The `prefer_tags` value the cached library was built with; a mismatch forces a full rescan.
    pub scanned_with_tags: Option<bool>,
    /// Appearance and behaviour preferences; owned entirely by the frontend.
    pub ui: serde_json::Value,
    pub lastfm: crate::integrations::LastfmConfig,
    pub discord: crate::integrations::DiscordConfig,
    pub soundcloud: crate::soundcloud::ScConfig,
    /// Paths of songs marked as favourites.
    pub favorites: Vec<String>,
    pub downloads: crate::downloads::DownloadConfig,
    pub soulseek: crate::slsk::SlskConfig,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            folders: Vec::new(),
            volume: 0.7,
            prefer_tags: true,
            scanned_with_tags: None,
            ui: serde_json::Value::Null,
            lastfm: Default::default(),
            discord: Default::default(),
            soundcloud: Default::default(),
            favorites: Vec::new(),
            downloads: Default::default(),
            soulseek: Default::default(),
        }
    }
}

// ----------------------------------------------------------------------- tags

#[derive(Default)]
struct Tags {
    title: Option<String>,
    artist: Option<String>,
    album_artist: Option<String>,
    album: Option<String>,
    track_no: Option<u32>,
    disc_no: Option<u32>,
    year: Option<String>,
    duration: f64,
}

fn non_empty(s: Option<impl AsRef<str>>) -> Option<String> {
    s.map(|s| s.as_ref().trim().to_string()).filter(|s| !s.is_empty())
}

fn read_tags(path: &Path) -> Tags {
    let mut out = Tags::default();
    let Ok(file) = lofty::read_from_path(path) else { return out };
    out.duration = file.properties().duration().as_secs_f64();
    let Some(tag) = file.primary_tag().or_else(|| file.first_tag()) else { return out };
    out.title = non_empty(tag.title());
    out.artist = non_empty(tag.artist());
    out.album = non_empty(tag.album());
    out.album_artist = non_empty(tag.get_string(ItemKey::AlbumArtist));
    out.track_no = tag.track().filter(|n| *n > 0);
    out.disc_no = tag.disk().filter(|n| *n > 0);
    out.year = [ItemKey::Year, ItemKey::RecordingDate, ItemKey::OriginalReleaseDate]
        .into_iter()
        .filter_map(|k| tag.get_string(k))
        .find_map(|s| YEAR_ANYWHERE.find(s).map(|m| m.as_str().to_string()));
    out
}

fn embedded_cover(path: &Path) -> Option<Vec<u8>> {
    let file = lofty::read_from_path(path).ok()?;
    file.tags()
        .iter()
        .flat_map(|t| t.pictures())
        .next()
        .map(|p| p.data().to_vec())
}

// -------------------------------------------------------------- folder layout

static DISC_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^(?:cd|disc|disk)\s*[-_.]?\s*(\d+)\b").unwrap());
static YEAR_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s*[(\[]\s*((?:19|20)\d{2})\s*[)\]]").unwrap());
static LEAD_YEAR_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^((?:19|20)\d{2})\s*[-–.]\s*").unwrap());
static TRAILING_TAG_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s*\[[^\]]*\]\s*$").unwrap()); // "[FLAC]"
static TRACK_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\s*(?:(\d)[-.](\d{1,3})|(\d{1,3}))(?:\s*[-–._)]\s*|\s+)(\S.*)$").unwrap());
static YEAR_ANYWHERE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\d{4}").unwrap());

#[derive(Default, Debug)]
struct FolderInfo {
    artist: Option<String>,
    album: Option<String>,
    year: Option<String>,
    disc_no: Option<u32>,
    track_no: Option<u32>,
    title: String,
    /// True when the folders clearly name both an artist and an album.
    strong: bool,
}

fn clean_album_folder(name: &str) -> (String, Option<String>) {
    let mut name = name.to_string();
    let mut year = YEAR_RE.captures(&name).map(|c| c[1].to_string());
    name = YEAR_RE.replace_all(&name, "").into_owned();
    if let Some(c) = LEAD_YEAR_RE.captures(&name) {
        year = year.or_else(|| Some(c[1].to_string()));
        name = name[c.get(0).unwrap().end()..].to_string();
    }
    while TRAILING_TAG_RE.is_match(&name) {
        name = TRAILING_TAG_RE.replace(&name, "").into_owned();
    }
    let name = name.split_whitespace().collect::<Vec<_>>().join(" ");
    (name.trim_matches(|c| " -–_".contains(c)).to_string(), year)
}

fn folder_info(path: &Path, root: &Path) -> FolderInfo {
    let rel = path.strip_prefix(root).unwrap_or(path);
    let mut dirs: Vec<String> = rel
        .parent()
        .map(|p| p.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect())
        .unwrap_or_default();
    let mut info = FolderInfo::default();

    if let Some(c) = dirs.last().and_then(|d| DISC_RE.captures(d)) {
        info.disc_no = c[1].parse().ok();
        dirs.pop();
    }

    if dirs.len() >= 2 {
        let (album, year) = clean_album_folder(&dirs[dirs.len() - 1]);
        info.artist = Some(dirs[dirs.len() - 2].clone());
        info.album = Some(album);
        info.year = year;
        info.strong = true;
    } else if let Some(dir) = dirs.first() {
        let (mut album, year) = clean_album_folder(dir);
        if let Some((artist, rest)) = album.split_once(" - ") {
            // "Artist - Album"
            info.artist = Some(artist.trim().to_string());
            album = rest.trim().to_string();
            info.strong = true;
        }
        info.album = Some(album);
        info.year = year;
    }

    let mut stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    if let Some(c) = TRACK_RE.captures(&stem) {
        if let (Some(disc), Some(track)) = (c.get(1), c.get(2)) {
            info.disc_no = info.disc_no.or(disc.as_str().parse().ok());
            info.track_no = track.as_str().parse().ok();
        } else {
            info.track_no = c[3].parse().ok();
        }
        stem = c[4].to_string();
    }

    match &info.artist {
        Some(artist) => {
            let prefix = format!("{} - ", artist.to_lowercase());
            let n = artist.len() + 3;
            if stem.get(..n).is_some_and(|p| p.to_lowercase() == prefix) {
                stem = stem[n..].to_string();
            }
        }
        None => {
            // loose "Artist - Title.mp3"
            if let Some((artist, title)) = stem.split_once(" - ") {
                info.artist = Some(artist.trim().to_string());
                stem = title.trim().to_string();
            }
        }
    }

    info.title = if stem.trim().is_empty() {
        path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default()
    } else {
        stem.trim().to_string()
    };
    info
}

fn build_track(path: &Path, root: &Path, mtime: u64, prefer_tags: bool) -> Track {
    let tags = read_tags(path);
    let folder = folder_info(path, root);

    let (album_artist, album) = if prefer_tags || !folder.strong {
        (
            tags.album_artist.clone().or(tags.artist.clone()).or(folder.artist.clone()),
            tags.album.clone().or(folder.album.clone()),
        )
    } else {
        (
            folder.artist.clone().or(tags.album_artist.clone()).or(tags.artist.clone()),
            folder.album.clone().or(tags.album.clone()),
        )
    };
    let album_artist = album_artist.unwrap_or_else(|| UNKNOWN_ARTIST.into());

    Track {
        path: path.to_string_lossy().into_owned(),
        root: root.to_string_lossy().into_owned(),
        mtime,
        title: tags.title.unwrap_or(folder.title),
        artist: tags.artist.unwrap_or_else(|| album_artist.clone()),
        album_artist,
        album: album.unwrap_or_else(|| UNKNOWN_ALBUM.into()),
        track_no: tags.track_no.or(folder.track_no).unwrap_or(0),
        disc_no: tags.disc_no.or(folder.disc_no).unwrap_or(1),
        year: tags.year.or(folder.year).unwrap_or_default(),
        duration: tags.duration,
        cover: String::new(),
        thumb: String::new(),
    }
}

// ------------------------------------------------------------------- scanning

fn has_ext(path: &Path, exts: &[&str]) -> bool {
    path.extension()
        .map(|e| exts.contains(&e.to_string_lossy().to_lowercase().as_str()))
        .unwrap_or(false)
}

fn folder_cover(dir: &Path, cache: &mut HashMap<PathBuf, Option<PathBuf>>) -> Option<PathBuf> {
    if let Some(hit) = cache.get(dir) {
        return hit.clone();
    }
    let images: Vec<PathBuf> = fs::read_dir(dir)
        .map(|rd| {
            rd.flatten()
                .map(|e| e.path())
                .filter(|p| p.is_file() && has_ext(p, IMAGE_EXTS) && !is_hidden(p))
                .collect()
        })
        .unwrap_or_default();
    let stem = |p: &PathBuf| p.file_stem().map(|s| s.to_string_lossy().to_lowercase()).unwrap_or_default();
    let found = COVER_NAMES
        .iter()
        .find_map(|name| images.iter().find(|p| stem(p) == *name).cloned())
        // a lone image in an album folder is almost always the cover
        .or_else(|| if images.len() == 1 { images.first().cloned() } else { None });
    cache.insert(dir.to_path_buf(), found.clone());
    found
}

/// Hidden or system files: Windows Media Player writes a hidden Folder.jpg / AlbumArtSmall.jpg
/// into music folders and overwrites it with whatever it showed last, so it isn't a real cover.
fn is_hidden(p: &Path) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const HIDDEN_OR_SYSTEM: u32 = 0x2 | 0x4;
        if fs::metadata(p).is_ok_and(|m| m.file_attributes() & HIDDEN_OR_SYSTEM != 0) {
            return true;
        }
    }
    p.file_name().is_some_and(|n| n.to_string_lossy().starts_with('.'))
}

pub fn hash_hex(s: &str) -> String {
    // FNV-1a: stable across runs, unlike std's DefaultHasher
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{h:016x}")
}

fn assign_covers(tracks: &mut [Track], cover_dir: &Path) {
    let _ = fs::create_dir_all(cover_dir);
    let mut albums: HashMap<String, Vec<usize>> = HashMap::new();
    for (i, t) in tracks.iter().enumerate() {
        albums.entry(t.album_key()).or_default().push(i);
    }

    // A folder's picture is only an album's cover when the folder holds just that album. Folders
    // of loose songs (like the SoundCloud download folder) would otherwise give every song the
    // same picture; those songs keep their own embedded art instead.
    let mut dir_albums: HashMap<PathBuf, HashSet<String>> = HashMap::new();
    for t in tracks.iter() {
        if let Some(d) = Path::new(&t.path).parent() {
            dir_albums.entry(d.to_path_buf()).or_default().insert(t.album_key());
        }
    }
    let one_album = |d: &Path| dir_albums.get(d).is_none_or(|a| a.len() <= 1);

    let mut dir_cache = HashMap::new();
    for idx in albums.into_values() {
        let mut dirs: Vec<PathBuf> = Vec::new();
        for &i in &idx {
            let Some(d) = Path::new(&tracks[i].path).parent() else { continue };
            let mut candidates = vec![d.to_path_buf()];
            let is_disc = d.file_name().map(|n| DISC_RE.is_match(&n.to_string_lossy())).unwrap_or(false);
            if let (true, Some(up)) = (is_disc, d.parent()) {
                candidates.push(up.to_path_buf());
            }
            for c in candidates {
                if !dirs.contains(&c) {
                    dirs.push(c);
                }
            }
        }

        // Art embedded in the songs comes first (it's what the song editor sets), then a picture in
        // the album's folder. Embedded art is cached per source file (and its mtime), not per
        // album: albums get regrouped when tags change, and a stale entry would show another song's art.
        let mut cover = idx.iter().take(3).find_map(|&i| {
            let t = &tracks[i];
            let cached = cover_dir.join(format!("{}.img", hash_hex(&format!("{}|{}", t.path, t.mtime))));
            if cached.exists() {
                return Some(cached);
            }
            let data = embedded_cover(Path::new(&t.path))?;
            fs::write(&cached, data).ok().map(|_| cached)
        });
        if cover.is_none() {
            cover = dirs.iter().filter(|d| one_album(d)).find_map(|d| folder_cover(d, &mut dir_cache));
        }
        let cover = cover.map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
        for &i in &idx {
            tracks[i].cover = cover.clone();
        }
    }

    // Thumbnails take a moment each the first time, so spread them over the cores.
    let mut covers: Vec<String> = tracks.iter().map(|t| t.cover.clone()).filter(|c| !c.is_empty()).collect();
    covers.sort();
    covers.dedup();
    let threads = std::thread::available_parallelism().map_or(4, |n| n.get()).min(8);
    let thumbs: HashMap<String, String> = std::thread::scope(|s| {
        let jobs: Vec<_> = covers
            .chunks(covers.len().div_ceil(threads).max(1))
            .map(|chunk| {
                s.spawn(move || {
                    chunk.iter().map(|c| (c.clone(), make_thumb(c, cover_dir).unwrap_or_else(|| c.clone()))).collect::<Vec<_>>()
                })
            })
            .collect();
        jobs.into_iter().flat_map(|j| j.join().unwrap_or_default()).collect()
    });
    for t in tracks.iter_mut() {
        t.thumb = thumbs.get(&t.cover).cloned().unwrap_or_default();
    }
}

/// Longest side of a grid thumbnail, in pixels. Big enough for large cover cards on hi-dpi screens.
const THUMB_PX: u32 = 360;

/// A small JPEG copy of `cover`, cached in `cover_dir`. Grids with hundreds of cards would
/// otherwise decode every full-size cover (often several megabytes each) and stutter.
/// Returns `cover` itself when it is already small.
fn make_thumb(cover: &str, cover_dir: &Path) -> Option<String> {
    let mtime = fs::metadata(cover).and_then(|m| m.modified()).ok()?.duration_since(UNIX_EPOCH).ok()?.as_secs();
    let out = cover_dir.join(format!("{}.thumb", hash_hex(&format!("{cover}|{mtime}|{THUMB_PX}"))));
    if out.exists() {
        return Some(out.to_string_lossy().into_owned());
    }
    let reader = image::ImageReader::open(cover).ok()?.with_guessed_format().ok()?;
    let (w, h) = reader.into_dimensions().ok()?;
    if w <= THUMB_PX && h <= THUMB_PX {
        return Some(cover.to_string());
    }
    let img = image::ImageReader::open(cover).ok()?.with_guessed_format().ok()?.decode().ok()?;
    let small = img.thumbnail(THUMB_PX, THUMB_PX).to_rgb8();
    let mut buf = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, 86).encode_image(&small).ok()?;
    fs::write(&out, buf).ok()?;
    Some(out.to_string_lossy().into_owned())
}

/// Scan every audio file under `folders`. Files whose mtime matches `cache` are reused.
pub fn scan(
    folders: &[String],
    prefer_tags: bool,
    cache: HashMap<String, Track>,
    cover_dir: &Path,
    progress: impl Fn(usize, usize),
) -> Vec<Track> {
    let mut files = Vec::new();
    for root in folders {
        let walker = WalkDir::new(root).follow_links(true).sort_by(|a, b| {
            a.file_name().to_ascii_lowercase().cmp(&b.file_name().to_ascii_lowercase())
        });
        for entry in walker.into_iter().flatten() {
            if entry.file_type().is_file() && has_ext(entry.path(), AUDIO_EXTS) {
                files.push((entry.into_path(), PathBuf::from(root)));
            }
        }
    }

    let total = files.len();
    let mut seen = HashSet::new();
    let mut tracks = Vec::with_capacity(total);
    for (i, (path, root)) in files.iter().enumerate() {
        if i % 25 == 0 || i + 1 == total {
            progress(i + 1, total);
        }
        let key = path.to_string_lossy().into_owned();
        if !seen.insert(key.clone()) {
            continue; // overlapping library folders
        }
        let Ok(mtime) = fs::metadata(path).and_then(|m| m.modified()) else { continue };
        let mtime = mtime.duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        match cache.get(&key) {
            Some(old) if old.mtime == mtime && Path::new(&old.root) == root.as_path() => tracks.push(old.clone()),
            _ => tracks.push(build_track(path, root, mtime, prefer_tags)),
        }
    }

    unify_album_artists(&mut tracks);
    assign_covers(&mut tracks, cover_dir);
    // drop cached art no song uses any more
    let used: std::collections::HashSet<&str> = tracks.iter().flat_map(|t| [t.cover.as_str(), t.thumb.as_str()]).collect();
    if let Ok(entries) = fs::read_dir(cover_dir) {
        for e in entries.flatten() {
            let p = e.path();
            if p.extension().is_some_and(|x| x == "img" || x == "thumb") && !used.contains(p.to_string_lossy().as_ref()) {
                let _ = fs::remove_file(p);
            }
        }
    }
    tracks
}

/// Tracks of one album often carry different artist tags ("A", "A feat. B", "A & C"), which
/// would split the album across several artists. Within each folder, give every track of an
/// album the artist most of its tracks share.
fn unify_album_artists(tracks: &mut [Track]) {
    let mut groups: HashMap<(String, String), Vec<usize>> = HashMap::new();
    for (i, t) in tracks.iter().enumerate() {
        let dir = Path::new(&t.path).parent().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
        groups.entry((dir, t.album.to_lowercase())).or_default().push(i);
    }
    // "Unknown Album" is a bucket for songs without an album, not one release: leave its artists be
    groups.retain(|(_, album), _| !album.eq_ignore_ascii_case(UNKNOWN_ALBUM));
    for idx in groups.into_values().filter(|idx| idx.len() > 1) {
        let mut counts: Vec<(String, usize)> = Vec::new();
        for &i in &idx {
            let name = &tracks[i].album_artist;
            match counts.iter_mut().find(|(n, _)| n.eq_ignore_ascii_case(name)) {
                Some((_, c)) => *c += 1,
                None => counts.push((name.clone(), 1)),
            }
        }
        if counts.len() < 2 {
            continue;
        }
        // most common wins; on a tie, the one that appears first in track order
        let best = counts.iter().max_by(|a, b| a.1.cmp(&b.1).then(std::cmp::Ordering::Greater)).unwrap().0.clone();
        for &i in &idx {
            tracks[i].album_artist = best.clone();
        }
    }
}

// ---------------------------------------------------------------- persistence

pub fn load_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Option<T> {
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

pub fn save_json<T: Serialize>(path: &Path, value: &T) {
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    let tmp = path.with_extension("tmp");
    if let Ok(bytes) = serde_json::to_vec(value) {
        if fs::write(&tmp, bytes).is_ok() {
            let _ = fs::rename(&tmp, path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info(rel: &str) -> FolderInfo {
        folder_info(&Path::new("/music").join(rel), Path::new("/music"))
    }

    #[test]
    fn artist_album_year() {
        let i = info("Radiohead/OK Computer (1997)/02 - Paranoid Android.mp3");
        assert_eq!(i.artist.as_deref(), Some("Radiohead"));
        assert_eq!(i.album.as_deref(), Some("OK Computer"));
        assert_eq!(i.year.as_deref(), Some("1997"));
        assert_eq!(i.track_no, Some(2));
        assert_eq!(i.title, "Paranoid Android");
        assert!(i.strong);
    }

    #[test]
    fn leading_year_and_disc_folders() {
        let i = info("Radiohead/2000 - Kid A/01 Everything In Its Right Place.flac");
        assert_eq!((i.album.as_deref(), i.year.as_deref()), (Some("Kid A"), Some("2000")));
        let i = info("The Beatles/Abbey Road [FLAC]/CD2/2-01 Something.flac");
        assert_eq!(i.album.as_deref(), Some("Abbey Road"));
        assert_eq!((i.disc_no, i.track_no), (Some(2), Some(1)));
        assert_eq!(i.title, "Something");
    }

    #[test]
    fn single_folder_and_loose_files() {
        let i = info("Daft Punk - Discovery/03. Digital Love.mp3");
        assert_eq!((i.artist.as_deref(), i.album.as_deref()), (Some("Daft Punk"), Some("Discovery")));
        assert_eq!(i.track_no, Some(3));
        let i = info("Some Artist - Single Song.mp3");
        assert_eq!((i.artist.as_deref(), i.title.as_str()), (Some("Some Artist"), "Single Song"));
        assert!(!i.strong);
    }

    #[test]
    fn folder_pictures_only_cover_single_album_folders() {
        let base = std::env::temp_dir().join(format!("yuuricloud-covers-{}", std::process::id()));
        let (mixed, album, covers) = (base.join("mixed"), base.join("album"), base.join("covers"));
        for d in [&mixed, &album] {
            fs::create_dir_all(d).unwrap();
            fs::write(d.join("folder.jpg"), b"not really a jpeg").unwrap();
        }
        let p = |d: &Path, f: &str| d.join(f).to_string_lossy().into_owned();
        let mut tracks = vec![
            loose(&p(&mixed, "a.mp3"), "A", "Song A"),
            loose(&p(&mixed, "b.mp3"), "B", "Song B"),
            loose(&p(&album, "1.mp3"), "C", "Album"),
            loose(&p(&album, "2.mp3"), "C", "Album"),
        ];
        assign_covers(&mut tracks, &covers);
        // two different songs in one folder: the folder's picture is no one's cover
        assert_eq!(tracks[0].cover, "");
        assert_eq!(tracks[1].cover, "");
        // one album in its own folder: it is
        assert_eq!(tracks[2].cover, p(&album, "folder.jpg"));
        assert_eq!(tracks[3].cover, tracks[2].cover);
        let _ = fs::remove_dir_all(&base);
    }

    fn loose(path: &str, artist: &str, album: &str) -> Track {
        Track {
            path: path.into(), root: String::new(), mtime: 0, title: "t".into(), artist: artist.into(),
            album_artist: artist.into(), album: album.into(), track_no: 0, disc_no: 1, year: String::new(),
            duration: 0.0, cover: String::new(), thumb: String::new(),
        }
    }

    #[test]
    fn keeps_artists_of_loose_songs_apart() {
        let mut tracks = vec![
            loose("/m/sc/a.m4a", "bbyglo", UNKNOWN_ALBUM),
            loose("/m/sc/b.wav", "lycoris", UNKNOWN_ALBUM),
            loose("/m/x/1.mp3", "Band", "LP"),
            loose("/m/x/2.mp3", "Band feat. Guest", "LP"),
            loose("/m/x/3.mp3", "Band", "LP"),
        ];
        unify_album_artists(&mut tracks);
        assert_eq!(tracks[0].album_artist, "bbyglo");
        assert_eq!(tracks[1].album_artist, "lycoris");
        assert_eq!(tracks[3].album_artist, "Band"); // a real album still gets one artist
    }
}
