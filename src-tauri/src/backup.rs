//! Backups: settings and favourites in a file, to restore later or move to another device.
//!
//! Favourites are saved by title, artist and album rather than by file, since the same song lives
//! somewhere else on every device. Ones that aren't in the library yet wait in
//! `Settings::pending_favorites` and are matched when a scan finds them.
//!
//! Logins go in only when asked for. The SoundCloud login never does: SoundCloud replaces its
//! refresh token on every use, so two devices sharing one would sign each other out.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::integrations::{DiscordConfig, LastfmConfig};
use crate::library::{Settings, Track};

/// A favourite song, described so another library can find it.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SongRef {
    pub title: String,
    pub artist: String,
    pub album: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Logins {
    pub lastfm: LastfmConfig,
    pub discord: DiscordConfig,
    pub soulseek_username: String,
    pub soulseek_password: String,
    /// The user's own SoundCloud app, if they use one (not their login; see the module docs).
    pub soundcloud_client_id: String,
    pub soundcloud_client_secret: String,
    pub soundcloud_redirect_uri: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Backup {
    /// "yuuricloud", so a stray JSON file isn't taken for a backup
    pub app: String,
    pub version: u32,
    pub prefs: Value,
    pub favorites: Vec<SongRef>,
    pub logins: Option<Logins>,
}

const APP: &str = "yuuricloud";

/// What an import did, for the message the app shows.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Imported {
    pub prefs: bool,
    /// favourites found in this library
    pub favorites: usize,
    /// favourites waiting for their songs to turn up here
    pub waiting: usize,
    pub logins: bool,
}

pub fn make(settings: &Settings, tracks: &[Track], include_logins: bool) -> Backup {
    let mut favorites: Vec<SongRef> = settings
        .favorites
        .iter()
        .filter_map(|path| tracks.iter().find(|t| t.path == *path))
        .map(|t| SongRef { title: t.title.clone(), artist: t.artist.clone(), album: t.album.clone() })
        .collect();
    favorites.extend(settings.pending_favorites.iter().cloned());
    let logins = include_logins.then(|| Logins {
        lastfm: settings.lastfm.clone(),
        discord: settings.discord.clone(),
        soulseek_username: settings.soulseek.username.clone(),
        soulseek_password: settings.soulseek.password.clone(),
        soundcloud_client_id: settings.soundcloud.client_id.clone(),
        soundcloud_client_secret: settings.soundcloud.client_secret.clone(),
        soundcloud_redirect_uri: settings.soundcloud.redirect_uri.clone(),
    });
    Backup { app: APP.into(), version: 1, prefs: settings.ui.clone(), favorites, logins }
}

pub fn parse(text: &str) -> Result<Backup, String> {
    let backup: Backup = serde_json::from_str(text).map_err(|_| "That isn't a yuuricloud backup file".to_string())?;
    if backup.app != APP {
        return Err("That isn't a yuuricloud backup file".into());
    }
    Ok(backup)
}

/// Put a backup's settings, favourites and logins into `settings`.
pub fn apply(backup: Backup, settings: &mut Settings, tracks: &[Track]) -> Imported {
    let prefs = match (backup.prefs, &mut settings.ui) {
        (Value::Object(new), Value::Object(current)) => {
            current.extend(new);
            true
        }
        (Value::Object(new), ui) => {
            *ui = Value::Object(new);
            true
        }
        _ => false,
    };

    let mut waiting = settings.pending_favorites.len();
    let before = settings.favorites.len();
    for song in backup.favorites {
        match find(&song, tracks) {
            Some(path) if !settings.favorites.contains(&path) => settings.favorites.push(path),
            Some(_) => {}
            None if !settings.pending_favorites.contains(&song) => settings.pending_favorites.push(song),
            None => {}
        }
    }
    let favorites = settings.favorites.len() - before;
    waiting = settings.pending_favorites.len() - waiting;

    let logins = backup.logins.is_some();
    if let Some(l) = backup.logins {
        settings.lastfm = l.lastfm;
        settings.discord = l.discord;
        settings.soulseek.username = l.soulseek_username;
        settings.soulseek.password = l.soulseek_password;
        let sc = &mut settings.soundcloud;
        if sc.client_id != l.soundcloud_client_id || sc.client_secret != l.soundcloud_client_secret {
            // a login belongs to the app it was made with
            *sc = crate::soundcloud::ScConfig::default();
        }
        sc.client_id = l.soundcloud_client_id;
        sc.client_secret = l.soundcloud_client_secret;
        sc.redirect_uri = l.soundcloud_redirect_uri;
    }
    Imported { prefs, favorites, waiting, logins }
}

/// Favourites still waiting that are in the library now. Returns whether any were found.
pub fn match_pending(settings: &mut Settings, tracks: &[Track]) -> bool {
    let before = settings.pending_favorites.len();
    let mut found = Vec::new();
    settings.pending_favorites.retain(|song| match find(song, tracks) {
        Some(path) => {
            found.push(path);
            false
        }
        None => true,
    });
    for path in found {
        if !settings.favorites.contains(&path) {
            settings.favorites.push(path);
        }
    }
    settings.pending_favorites.len() != before
}

/// Letters and digits only, lowercased: "The Beatles – Let It Be (Remastered)" and
/// "the beatles - let it be (remastered)" are the same song.
fn key(s: &str) -> String {
    s.chars().filter(|c| c.is_alphanumeric()).flat_map(char::to_lowercase).collect()
}

/// The song in this library: same title and artist, and the same album when there's one with it.
fn find(song: &SongRef, tracks: &[Track]) -> Option<String> {
    let (title, artist, album) = (key(&song.title), key(&song.artist), key(&song.album));
    if title.is_empty() {
        return None;
    }
    let same = |t: &&Track| key(&t.title) == title && (key(&t.artist) == artist || key(&t.album_artist) == artist);
    let mut matches = tracks.iter().filter(same);
    let first = matches.next()?;
    let on_album = std::iter::once(first).chain(matches).find(|t| key(&t.album) == album);
    Some(on_album.unwrap_or(first).path.clone())
}

/// "2026-10-31", for the backup's file name.
pub fn today() -> String {
    // days since 1970 to a calendar date (Howard Hinnant's civil_from_days)
    let z = crate::integrations::unix_now().div_euclid(86_400) + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn track(path: &str, title: &str, artist: &str, album: &str) -> Track {
        Track {
            path: path.into(),
            title: title.into(),
            artist: artist.into(),
            album_artist: artist.into(),
            album: album.into(),
            ..Default::default()
        }
    }

    #[test]
    fn favourites_move_by_title_and_artist() {
        let pc = vec![track("C:/m/a.mp3", "Let It Be", "The Beatles", "Let It Be"), track("C:/m/b.mp3", "Yesterday", "The Beatles", "Help!")];
        let mut from = Settings { favorites: vec!["C:/m/a.mp3".into(), "C:/m/b.mp3".into()], ..Default::default() };
        from.ui = serde_json::json!({ "accent": "#ff0000" });
        let text = serde_json::to_string(&make(&from, &pc, false)).unwrap();

        // the phone has one of them, in another folder and spelled a little differently
        let phone = vec![
            track("/doc/x.flac", "let it be", "the beatles", "Let It Be (Remastered)"),
            track("/doc/y.flac", "Let It Be", "The Beatles", "Let It Be"),
        ];
        let mut to = Settings { ui: serde_json::json!({ "compact": true }), ..Default::default() };
        let done = apply(parse(&text).unwrap(), &mut to, &phone);
        assert_eq!((done.prefs, done.favorites, done.waiting, done.logins), (true, 1, 1, false));
        assert_eq!(to.favorites, vec!["/doc/y.flac".to_string()]); // the one on the same album
        assert_eq!(to.ui, serde_json::json!({ "compact": true, "accent": "#ff0000" }));

        // the missing song turns up later
        let later = [phone, vec![track("/doc/z.flac", "Yesterday", "The Beatles", "Help!")]].concat();
        assert!(match_pending(&mut to, &later));
        assert!(to.pending_favorites.is_empty());
        assert!(to.favorites.contains(&"/doc/z.flac".to_string()));
    }

    #[test]
    fn logins_only_when_asked() {
        let mut s = Settings::default();
        s.lastfm.session_key = "sk".into();
        s.soundcloud.access_token = "secret".into();
        assert!(make(&s, &[], false).logins.is_none());
        let with = serde_json::to_string(&make(&s, &[], true)).unwrap();
        assert!(with.contains("\"sk\""));
        assert!(!with.contains("secret"), "the SoundCloud login never goes in a backup");
    }

    #[test]
    fn other_files_are_refused() {
        assert!(parse("{\"favorites\": []}").is_err());
        assert!(parse("not json").is_err());
    }

    #[test]
    fn dates() {
        assert_eq!(today().len(), 10);
    }
}
