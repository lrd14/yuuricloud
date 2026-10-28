//! Last.fm scrobbling and Discord Rich Presence.
//!
//! Both need credentials from the user: a Last.fm API account (key + secret) and a Discord
//! application (client ID). Calls here block, so commands run them off the main thread.

use std::collections::BTreeMap;
use std::time::{SystemTime, UNIX_EPOCH};

use discord_rich_presence::activity::{Activity, ActivityType, Assets, StatusDisplayType, Timestamps};
use discord_rich_presence::{DiscordIpc, DiscordIpcClient};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LastfmConfig {
    pub api_key: String,
    pub api_secret: String,
    pub session_key: String,
    pub username: String,
    pub scrobble: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DiscordConfig {
    pub enabled: bool,
    pub client_id: String,
}

/// What the frontend sends about the current song.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NowPlaying {
    pub title: String,
    pub artist: String,
    pub album: String,
    pub album_artist: String,
    pub duration: f64,
    /// Cover URL to show on Discord (SoundCloud artwork); local songs have none.
    #[serde(default)]
    pub image: Option<String>,
}

pub fn unix_now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

// --------------------------------------------------------------------- Last.fm

const LASTFM_API: &str = "https://ws.audioscrobbler.com/2.0/";

fn agent() -> ureq::Agent {
    // Last.fm reports errors as JSON with a 4xx status; read the body instead of failing early.
    ureq::Agent::config_builder()
        .http_status_as_error(false)
        .timeout_global(Some(std::time::Duration::from_secs(15)))
        .build()
        .into()
}

/// Call a Last.fm API method. Signed calls add `api_sig` as the API docs describe.
fn lastfm_call(cfg: &LastfmConfig, method: &str, mut params: BTreeMap<&str, String>, signed: bool) -> Result<Value, String> {
    if cfg.api_key.is_empty() {
        return Err("Add your Last.fm API key first".into());
    }
    params.insert("method", method.to_string());
    params.insert("api_key", cfg.api_key.clone());
    if signed {
        let mut base: String = params.iter().map(|(k, v)| format!("{k}{v}")).collect();
        base.push_str(&cfg.api_secret);
        params.insert("api_sig", format!("{:x}", md5::compute(base)));
    }
    params.insert("format", "json".into());

    let mut response = agent()
        .post(LASTFM_API)
        .send_form(params.iter().map(|(k, v)| (*k, v.as_str())))
        .map_err(|e| format!("Couldn't reach Last.fm: {e}"))?;
    let json: Value = response.body_mut().read_json().map_err(|e| format!("Bad reply from Last.fm: {e}"))?;
    if let Some(message) = json.get("message").and_then(Value::as_str).filter(|_| json.get("error").is_some()) {
        return Err(format!("Last.fm: {message}"));
    }
    Ok(json)
}

pub fn lastfm_get_token(cfg: &LastfmConfig) -> Result<String, String> {
    let json = lastfm_call(cfg, "auth.getToken", BTreeMap::new(), true)?;
    json["token"].as_str().map(str::to_string).ok_or_else(|| "Last.fm sent no token".into())
}

pub fn lastfm_auth_url(cfg: &LastfmConfig, token: &str) -> String {
    format!("https://www.last.fm/api/auth/?api_key={}&token={}", cfg.api_key, token)
}

/// Exchange an approved token for a session. Returns (username, session key).
pub fn lastfm_get_session(cfg: &LastfmConfig, token: &str) -> Result<(String, String), String> {
    let json = lastfm_call(cfg, "auth.getSession", BTreeMap::from([("token", token.to_string())]), true)?;
    let session = &json["session"];
    match (session["name"].as_str(), session["key"].as_str()) {
        (Some(name), Some(key)) => Ok((name.to_string(), key.to_string())),
        _ => Err("Last.fm didn't return a session — approve access in the browser first".into()),
    }
}

fn track_params(track: &NowPlaying, session_key: &str) -> BTreeMap<&'static str, String> {
    let mut p = BTreeMap::from([
        ("artist", track.artist.clone()),
        ("track", track.title.clone()),
        ("sk", session_key.to_string()),
    ]);
    if !track.album.is_empty() && track.album != crate::library::UNKNOWN_ALBUM {
        p.insert("album", track.album.clone());
    }
    if track.album_artist != track.artist && track.album_artist != crate::library::UNKNOWN_ARTIST {
        p.insert("albumArtist", track.album_artist.clone());
    }
    if track.duration > 0.0 {
        p.insert("duration", (track.duration.round() as i64).to_string());
    }
    p
}

pub fn lastfm_now_playing(cfg: &LastfmConfig, track: &NowPlaying) -> Result<(), String> {
    lastfm_call(cfg, "track.updateNowPlaying", track_params(track, &cfg.session_key), true).map(|_| ())
}

pub fn lastfm_scrobble(cfg: &LastfmConfig, track: &NowPlaying, started_at: i64) -> Result<(), String> {
    let mut p = track_params(track, &cfg.session_key);
    p.insert("timestamp", started_at.to_string());
    lastfm_call(cfg, "track.scrobble", p, true).map(|_| ())
}

/// Largest album cover URL Last.fm knows for this album (used as the Discord image).
pub fn lastfm_album_art(cfg: &LastfmConfig, artist: &str, album: &str) -> Option<String> {
    let params = BTreeMap::from([("artist", artist.to_string()), ("album", album.to_string())]);
    let json = lastfm_call(cfg, "album.getInfo", params, false).ok()?;
    json["album"]["image"]
        .as_array()?
        .iter()
        .rev()
        .filter_map(|img| img["#text"].as_str())
        .find(|url| !url.is_empty())
        .map(str::to_string)
}

// --------------------------------------------------------------------- Discord

pub struct Discord {
    client: Option<DiscordIpcClient>,
    client_id: String,
}

impl Discord {
    pub fn new() -> Self {
        Self { client: None, client_id: String::new() }
    }

    fn connected(&mut self, client_id: &str) -> Result<&mut DiscordIpcClient, String> {
        if self.client.is_none() || self.client_id != client_id {
            self.disconnect();
            let mut client = DiscordIpcClient::new(client_id);
            client.connect().map_err(|e| format!("Couldn't connect to Discord (is it running?): {e}"))?;
            self.client = Some(client);
            self.client_id = client_id.to_string();
        }
        Ok(self.client.as_mut().unwrap())
    }

    pub fn disconnect(&mut self) {
        if let Some(mut client) = self.client.take() {
            let _ = client.clear_activity();
            let _ = client.close();
        }
    }

    /// Show the song as "Listening to …". `position` is seconds into the song.
    pub fn show(&mut self, client_id: &str, track: &NowPlaying, playing: bool, position: f64, image: Option<&str>) -> Result<(), String> {
        let large_text = if track.album.is_empty() { track.title.clone() } else { track.album.clone() };
        let mut activity = Activity::new()
            .activity_type(ActivityType::Listening)
            .status_display_type(StatusDisplayType::Details)
            .details(track.title.as_str())
            .state(if playing { track.artist.clone() } else { format!("{} · paused", track.artist) });
        let mut assets = Assets::new().large_text(large_text.as_str());
        if let Some(url) = image {
            assets = assets.large_image(url);
        }
        activity = activity.assets(assets);
        if playing && track.duration > 0.0 {
            let start = unix_now() - position as i64;
            activity = activity.timestamps(Timestamps::new().start(start).end(start + track.duration as i64));
        }

        let client = self.connected(client_id)?;
        if client.set_activity(activity.clone()).is_err() {
            // Discord was restarted: reconnect once and retry.
            client.reconnect().map_err(|e| format!("Lost connection to Discord: {e}"))?;
            client.set_activity(activity).map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    pub fn clear(&mut self) {
        if let Some(client) = self.client.as_mut() {
            let _ = client.clear_activity();
        }
    }
}
