//! The song editor: read a song's own tags for editing, and write changes back into the file
//! (title, artists, album, numbers, year and cover picture), so other players see them too.

use std::io::Cursor;
use std::path::Path;

use base64::Engine;
use lofty::config::WriteOptions;
use lofty::picture::{MimeType, Picture, PictureType};
use lofty::prelude::*;
use lofty::tag::{ItemKey, Tag};
use serde::{Deserialize, Serialize};

/// Longest side of a cover written into a file; bigger pictures are scaled down to this.
const COVER_MAX_PX: u32 = 1400;
/// Pictures at most this big (and already JPEG or PNG) are written as they are.
const COVER_KEEP_BYTES: usize = 2 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SongTags {
    pub title: String,
    pub artist: String,
    pub album_artist: String,
    pub album: String,
    pub track_no: Option<u32>,
    pub disc_no: Option<u32>,
    pub year: String,
    /// The embedded cover as a small data: URL, for the editor's preview.
    pub cover: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagEdit {
    pub title: String,
    pub artist: String,
    pub album_artist: String,
    pub album: String,
    pub track_no: Option<u32>,
    pub disc_no: Option<u32>,
    pub year: String,
}

/// What to do with the cover picture.
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CoverEdit {
    Keep,
    Remove,
    /// Use this image file.
    File { path: String },
}

fn open(path: &Path) -> Result<lofty::file::TaggedFile, String> {
    lofty::read_from_path(path).map_err(|e| format!("Couldn't read the song's tags: {e}"))
}

pub fn read(path: &Path) -> Result<SongTags, String> {
    let file = open(path)?;
    let tag = file.primary_tag().or_else(|| file.first_tag());
    let text = |f: &dyn Fn(&Tag) -> Option<String>| tag.and_then(f).unwrap_or_default();
    let picture = file.tags().iter().flat_map(|t| t.pictures()).next().map(|p| p.data().to_vec());
    Ok(SongTags {
        title: text(&|t| t.title().map(|s| s.to_string())),
        artist: text(&|t| t.artist().map(|s| s.to_string())),
        album_artist: text(&|t| t.get_string(ItemKey::AlbumArtist).map(String::from)),
        album: text(&|t| t.album().map(|s| s.to_string())),
        track_no: tag.and_then(|t| t.track()).filter(|n| *n > 0),
        disc_no: tag.and_then(|t| t.disk()).filter(|n| *n > 0),
        year: text(&|t| {
            [ItemKey::Year, ItemKey::RecordingDate, ItemKey::OriginalReleaseDate].into_iter().find_map(|k| t.get_string(k).map(String::from))
        }),
        cover: picture.and_then(|b| preview(&b).ok()),
    })
}

/// A small JPEG of an image, as a data: URL the webview can show without file access.
pub fn preview(bytes: &[u8]) -> Result<String, String> {
    let img = image::load_from_memory(bytes).map_err(|_| "That file isn't a picture yuuricloud can read".to_string())?;
    let small = img.thumbnail(320, 320).to_rgb8();
    let mut out = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 85).encode_image(&small).map_err(|e| e.to_string())?;
    Ok(format!("data:image/jpeg;base64,{}", base64::engine::general_purpose::STANDARD.encode(out)))
}

/// The picture to embed: the file as it is when it's a reasonably sized JPEG or PNG, otherwise
/// a JPEG no larger than COVER_MAX_PX.
fn cover_picture(path: &Path) -> Result<Picture, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("Couldn't open the picture: {e}"))?;
    let format = image::guess_format(&bytes).map_err(|_| "That file isn't a picture yuuricloud can read".to_string())?;
    let keep = matches!(format, image::ImageFormat::Jpeg | image::ImageFormat::Png) && bytes.len() <= COVER_KEEP_BYTES;
    let (data, mime) = if keep {
        (bytes, if format == image::ImageFormat::Png { MimeType::Png } else { MimeType::Jpeg })
    } else {
        let img = image::load_from_memory(&bytes).map_err(|e| format!("Couldn't read the picture: {e}"))?;
        let img = if img.width().max(img.height()) > COVER_MAX_PX { img.thumbnail(COVER_MAX_PX, COVER_MAX_PX) } else { img };
        let mut out = Cursor::new(Vec::new());
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 90).encode_image(&img.to_rgb8()).map_err(|e| e.to_string())?;
        (out.into_inner(), MimeType::Jpeg)
    };
    Ok(Picture::unchecked(data).pic_type(PictureType::CoverFront).mime_type(mime).build())
}

fn save(file: &lofty::file::TaggedFile, path: &Path) -> Result<(), String> {
    file.save_to_path(path, WriteOptions::default()).map_err(|e| {
        let msg = e.to_string();
        if msg.contains("os error 32") || msg.contains("os error 5") || msg.to_lowercase().contains("denied") {
            "Couldn't save: the file is open in another program (like Windows Media Player). Close it and try again.".into()
        } else {
            format!("Couldn't save the song: {msg}")
        }
    })
}

/// Make sure the file has a tag to write into, and return it.
fn tag_mut(file: &mut lofty::file::TaggedFile) -> &mut Tag {
    if file.primary_tag().is_none() {
        let kind = file.file_type().primary_tag_type();
        file.insert_tag(Tag::new(kind));
    }
    file.primary_tag_mut().expect("just inserted")
}

/// Put `value` under `key`, or take the field out when it's empty.
fn set_text(tag: &mut Tag, key: ItemKey, value: &str) {
    let value = value.trim();
    if value.is_empty() {
        tag.remove_key(key);
    } else {
        tag.insert_text(key, value.to_string());
    }
}

/// Write the text fields (and, unless it's Keep, the cover) into one song.
pub fn write(path: &Path, edit: &TagEdit, cover: &CoverEdit) -> Result<(), String> {
    let picture = match cover {
        CoverEdit::File { path } => Some(cover_picture(Path::new(path))?),
        _ => None,
    };
    let mut file = open(path)?;
    let tag = tag_mut(&mut file);
    set_text(tag, ItemKey::TrackTitle, &edit.title);
    set_text(tag, ItemKey::TrackArtist, &edit.artist);
    set_text(tag, ItemKey::AlbumArtist, &edit.album_artist);
    set_text(tag, ItemKey::AlbumTitle, &edit.album);
    match edit.track_no.filter(|n| *n > 0) {
        Some(n) => tag.set_track(n),
        None => tag.remove_track(),
    }
    match edit.disc_no.filter(|n| *n > 0) {
        Some(n) => tag.set_disk(n),
        None => tag.remove_disk(),
    }
    // ID3 (MP3, WAV) and MP4 keep the year in the recording date; Vorbis comments (FLAC) have
    // both. Write it to each the format supports, so no stale date is left to win on reading.
    set_text(tag, ItemKey::RecordingDate, &edit.year);
    set_text(tag, ItemKey::Year, &edit.year);
    apply_cover(tag, cover, picture);
    save(&file, path)
}

/// Write only the cover into a song (for "use for the whole album").
pub fn write_cover(path: &Path, cover: &CoverEdit) -> Result<(), String> {
    let picture = match cover {
        CoverEdit::Keep => return Ok(()),
        CoverEdit::File { path } => Some(cover_picture(Path::new(path))?),
        CoverEdit::Remove => None,
    };
    let mut file = open(path)?;
    apply_cover(tag_mut(&mut file), cover, picture);
    save(&file, path)
}

fn apply_cover(tag: &mut Tag, cover: &CoverEdit, picture: Option<Picture>) {
    if matches!(cover, CoverEdit::Keep) {
        return;
    }
    while !tag.pictures().is_empty() {
        tag.remove_picture(0);
    }
    if let Some(p) = picture {
        tag.push_picture(p);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Writes into a copy of a real song when YUURI_TEST_SONG points at one.
    #[test]
    #[ignore]
    fn edits_round_trip() {
        let src = std::env::var("YUURI_TEST_SONG").expect("set YUURI_TEST_SONG");
        let ext = Path::new(&src).extension().unwrap().to_string_lossy().into_owned();
        let copy = std::env::temp_dir().join(format!("yuuricloud-edit-{}.{ext}", std::process::id()));
        std::fs::copy(&src, &copy).unwrap();
        let pic = std::env::temp_dir().join(format!("yuuricloud-edit-{}.png", std::process::id()));
        image::RgbImage::from_pixel(64, 64, image::Rgb([200, 30, 90])).save(&pic).unwrap();

        let edit = TagEdit {
            title: "New Title".into(),
            artist: "Some Artist".into(),
            album_artist: "Some Artist".into(),
            album: "An Album".into(),
            track_no: Some(7),
            disc_no: None,
            year: "2021".into(),
        };
        write(&copy, &edit, &CoverEdit::File { path: pic.to_string_lossy().into_owned() }).unwrap();
        let back = read(&copy).unwrap();
        assert_eq!((back.title.as_str(), back.artist.as_str(), back.album.as_str()), ("New Title", "Some Artist", "An Album"));
        assert_eq!((back.track_no, back.year.as_str()), (Some(7), "2021"));
        assert!(back.cover.is_some());

        write_cover(&copy, &CoverEdit::Remove).unwrap();
        assert!(read(&copy).unwrap().cover.is_none());
        let _ = std::fs::remove_file(&copy);
        let _ = std::fs::remove_file(&pic);
    }
}
