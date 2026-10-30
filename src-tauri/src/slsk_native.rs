//! Soulseek without slskd, for iOS: apps there can't start other programs, so the Soulseek client
//! runs inside the app (the `soulseek-rs-lib` crate). It answers the same questions `slsk::Conn`
//! asks slskd, in the same shapes, so the Soulseek tab and Downloads page work unchanged.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use soulseek_rs::{Client, ClientSettings, DownloadStatus, UploadStatus};

use crate::slsk::{QueueFile, SearchFile, SearchResults, SlskConfig, TransferInfo};

/// How long a search collects answers, like the 15 seconds slskd is asked for.
const SEARCH_TIME: Duration = Duration::from_secs(15);

/// Soulseek file attribute codes in search results.
const ATTR_BITRATE: u32 = 0;
const ATTR_LENGTH: u32 = 1;
const ATTR_VBR: u32 = 2;
const ATTR_SAMPLE_RATE: u32 = 4;
const ATTR_BIT_DEPTH: u32 = 5;

struct SearchJob {
    query: String,
    stop: Arc<AtomicBool>,
    done: Arc<AtomicBool>,
}

pub struct Native {
    /// Searches read it for their whole window, so it's shared rather than locked per call; only
    /// disconnecting needs it to itself.
    client: Arc<RwLock<Client>>,
    username: String,
    downloads: PathBuf,
    listen_port: Option<u16>,
    searches: Mutex<HashMap<String, SearchJob>>,
    /// download token -> when it was asked for, for ordering the list like slskd does
    requested: Mutex<HashMap<u32, String>>,
    /// finished uploads "Clear finished" hid: (username, filename)
    hidden_uploads: Mutex<HashSet<(String, String)>>,
}

impl Drop for Native {
    fn drop(&mut self) {
        for job in self.searches.get_mut().unwrap().values() {
            job.stop.store(true, Ordering::Relaxed);
        }
        if let Ok(mut client) = self.client.write() {
            client.disconnect();
        }
    }
}

/// Log in to Soulseek, sharing `shares` and saving downloads under `downloads`.
pub fn connect(cfg: &SlskConfig, downloads: &Path, shares: &[String]) -> Result<Native, String> {
    if cfg.username.trim().is_empty() || cfg.password.is_empty() {
        return Err("Enter your Soulseek username and password first".into());
    }
    std::fs::create_dir_all(downloads).map_err(|e| format!("Couldn't create {}: {e}", downloads.display()))?;
    let mut settings = ClientSettings::new(cfg.username.trim(), cfg.password.clone());
    settings.shared_directories = shares.to_vec();
    if cfg.listen_port != 0 {
        settings.listen_port = cfg.listen_port;
    }
    let mut client = Client::with_settings(settings);
    client.connect().map_err(|e| format!("Couldn't reach the Soulseek server: {e}"))?;
    match client.login() {
        Ok(true) => {}
        Ok(false) => {
            client.disconnect();
            return Err("Soulseek refused the username or password".into());
        }
        Err(e) => {
            client.disconnect();
            return Err(format!("Couldn't log in to Soulseek: {e}"));
        }
    }
    Ok(Native {
        listen_port: client.listen_port(),
        client: Arc::new(RwLock::new(client)),
        username: cfg.username.trim().to_string(),
        downloads: downloads.to_path_buf(),
        searches: Mutex::new(HashMap::new()),
        requested: Mutex::new(HashMap::new()),
        hidden_uploads: Mutex::new(HashSet::new()),
    })
}

impl Native {
    fn client(&self) -> std::sync::RwLockReadGuard<'_, Client> {
        self.client.read().unwrap_or_else(|e| e.into_inner())
    }

    pub fn alive(&self) -> bool {
        self.client().session_loss().is_none()
    }

    pub fn downloads_dir(&self) -> &Path {
        &self.downloads
    }

    pub fn status(&self) -> Value {
        let loss = self.client().session_loss();
        json!({
            "connected": loss.is_none(),
            "loggedIn": loss.is_none(),
            "busy": false,
            "state": loss.map_or_else(|| "Connected, LoggedIn".to_string(), |l| l.to_string()),
            "username": self.username,
            "listenPort": self.listen_port,
        })
    }

    /// Start a search in the background; returns its id. Answers collect for `SEARCH_TIME`.
    pub fn search(&self, text: &str) -> Result<String, String> {
        let id = format!("{:x}-{}", now_millis(), self.searches.lock().unwrap().len());
        let job = SearchJob { query: text.to_string(), stop: Arc::default(), done: Arc::default() };
        let (client, query, stop, done) = (self.client.clone(), job.query.clone(), job.stop.clone(), job.done.clone());
        self.searches.lock().unwrap().insert(id.clone(), job);
        std::thread::spawn(move || {
            if let Ok(client) = client.read() {
                let _ = client.search_with_cancel(&query, SEARCH_TIME, Some(stop));
            }
            done.store(true, Ordering::Relaxed);
        });
        Ok(id)
    }

    pub fn search_results(&self, id: &str) -> Result<SearchResults, String> {
        let (query, done) = {
            let searches = self.searches.lock().unwrap();
            let job = searches.get(id).ok_or("That search is gone")?;
            (job.query.clone(), job.done.load(Ordering::Relaxed))
        };
        let mut files = Vec::new();
        for r in self.client().get_search_results(&query) {
            for f in &r.files {
                let ext = crate::slsk::extension(&f.name);
                if !crate::slsk::AUDIO_EXTS.contains(&ext.as_str()) {
                    continue;
                }
                let attr = |code| f.attribs.get(&code).map(|v| u64::from(*v));
                files.push(SearchFile {
                    username: r.username.clone(),
                    filename: f.name.clone(),
                    ext,
                    size: f.size,
                    bit_rate: attr(ATTR_BITRATE),
                    bit_depth: attr(ATTR_BIT_DEPTH),
                    sample_rate: attr(ATTR_SAMPLE_RATE),
                    length: attr(ATTR_LENGTH).map(|s| s as f64),
                    is_variable_bit_rate: attr(ATTR_VBR) == Some(1),
                    free_slot: r.slots > 0,
                    queue_length: 0,
                    upload_speed: u64::from(r.speed),
                });
            }
        }
        Ok(SearchResults { complete: done, state: if done { "Completed" } else { "InProgress" }.into(), files })
    }

    pub fn stop_search(&self, id: &str) {
        if let Some(job) = self.searches.lock().unwrap().get(id) {
            job.stop.store(true, Ordering::Relaxed);
        }
    }

    /// Queue files from one user. Each lands in a folder named after the one it came from, the
    /// way slskd saves them.
    pub fn download(&self, username: &str, files: &[QueueFile]) -> Result<(), String> {
        let client = self.client();
        for f in files {
            let dir = download_dir(&self.downloads, &f.filename);
            // a failed earlier try of the same file would otherwise stay on the list next to this one
            let _ = client.remove_download(username, &f.filename);
            let (download, _status) = client
                .download(f.filename.clone(), username.to_string(), f.size, dir.to_string_lossy().into_owned())
                .map_err(|e| e.to_string())?;
            self.requested.lock().unwrap().insert(download.token, timestamp());
        }
        Ok(())
    }

    pub fn transfers(&self) -> Vec<TransferInfo> {
        let requested = self.requested.lock().unwrap();
        let mut out: Vec<TransferInfo> = self
            .client()
            .get_all_downloads()
            .into_iter()
            .map(|d| {
                let (state, bytes, speed, error) = download_state(&d.status, d.queue_position);
                let path = (state == "Completed, Succeeded")
                    .then(|| Path::new(&d.download_directory).join(crate::slsk::base_name(&d.filename)))
                    .filter(|p| p.exists())
                    .map(|p| p.to_string_lossy().into_owned());
                TransferInfo {
                    id: d.token.to_string(),
                    username: d.username,
                    filename: d.filename,
                    size: d.size,
                    state: state.into(),
                    bytes: if state == "Completed, Succeeded" { d.size } else { bytes },
                    speed,
                    place_in_queue: d.queue_position.map(u64::from),
                    error,
                    requested_at: requested.get(&d.token).cloned().unwrap_or_default(),
                    path,
                }
            })
            .collect();
        out.sort_by(|a, b| b.requested_at.cmp(&a.requested_at));
        out
    }

    fn find_download(&self, username: &str, id: &str) -> Option<String> {
        let token: u32 = id.parse().ok()?;
        self.client().get_all_downloads().into_iter().find(|d| d.token == token && d.username == username).map(|d| d.filename)
    }

    pub fn queue_position(&self, username: &str, id: &str) -> Option<u64> {
        let token: u32 = id.parse().ok()?;
        self.client()
            .get_all_downloads()
            .into_iter()
            .find(|d| d.token == token && d.username == username)
            .and_then(|d| d.queue_position.map(u64::from))
    }

    pub fn cancel(&self, username: &str, id: &str, remove: bool) {
        let Some(filename) = self.find_download(username, id) else { return };
        let client = self.client();
        let _ = client.cancel_download(username, &filename);
        if remove {
            let _ = client.remove_download(username, &filename);
        }
    }

    pub fn clear_finished(&self) {
        let client = self.client();
        for d in client.get_all_downloads().into_iter().filter(|d| d.is_finished()) {
            let _ = client.remove_download(&d.username, &d.filename);
        }
    }

    pub fn uploads(&self) -> Vec<TransferInfo> {
        let hidden = self.hidden_uploads.lock().unwrap();
        self.client()
            .uploads()
            .into_iter()
            .filter(|u| !hidden.contains(&(u.username.clone(), u.filename.clone())))
            .map(|u| {
                let (state, place, error) = match &u.status {
                    UploadStatus::Queued(n) => ("Queued, Locally", Some(u64::from(*n)), None),
                    UploadStatus::InProgress => ("InProgress", None, None),
                    UploadStatus::Completed => ("Completed, Succeeded", None, None),
                    UploadStatus::Cancelled => ("Completed, Cancelled", None, None),
                    UploadStatus::Failed(why) => ("Completed, Errored", None, Some(why.clone())),
                };
                TransferInfo {
                    // the client tells uploads apart by who and what, so that's the id too
                    id: u.filename.clone(),
                    username: u.username,
                    filename: u.filename,
                    size: u.size,
                    state: state.into(),
                    bytes: u.bytes_sent,
                    speed: u.speed_bytes_per_sec,
                    place_in_queue: place,
                    error,
                    requested_at: String::new(),
                    path: None,
                }
            })
            .collect()
    }

    pub fn cancel_upload(&self, username: &str, filename: &str, remove: bool) {
        let _ = self.client().cancel_upload(username, filename);
        if remove {
            self.hidden_uploads.lock().unwrap().insert((username.to_string(), filename.to_string()));
        }
    }

    pub fn clear_finished_uploads(&self) {
        let mut hidden = self.hidden_uploads.lock().unwrap();
        for u in self.client().uploads() {
            if matches!(u.status, UploadStatus::Completed | UploadStatus::Cancelled | UploadStatus::Failed(_)) {
                hidden.insert((u.username, u.filename));
            }
        }
    }
}

/// slskd's state names, which the Downloads page reads: (state, bytes, speed, error).
fn download_state(status: &DownloadStatus, queue_position: Option<u32>) -> (&'static str, u64, f64, Option<String>) {
    match status {
        // a place in the other user's queue means they have it and we're waiting on them
        DownloadStatus::Queued if queue_position.is_some() => ("Queued, Remotely", 0, 0.0, None),
        DownloadStatus::Queued => ("Queued, Locally", 0, 0.0, None),
        DownloadStatus::InProgress { bytes_downloaded, speed_bytes_per_sec, .. } => ("InProgress", *bytes_downloaded, *speed_bytes_per_sec, None),
        DownloadStatus::Paused { bytes_downloaded, .. } => ("Queued, Locally", *bytes_downloaded, 0.0, None),
        DownloadStatus::Completed => ("Completed, Succeeded", 0, 0.0, None),
        DownloadStatus::Cancelled => ("Completed, Cancelled", 0, 0.0, None),
        DownloadStatus::Failed(why) => ("Completed, Errored", 0, 0.0, why.clone()),
        DownloadStatus::TimedOut => ("Completed, TimedOut", 0, 0.0, None),
    }
}

/// `<downloads>/<the folder the file was in>`, like slskd: "...\Artist\Album\01 Song.flac" goes
/// to `<downloads>/Album/`.
fn download_dir(downloads: &Path, remote: &str) -> PathBuf {
    let parts: Vec<&str> = remote.split(['\\', '/']).filter(|s| !s.is_empty()).collect();
    match parts.len() {
        0 | 1 => downloads.to_path_buf(),
        n => downloads.join(sanitize(parts[n - 2])),
    }
}

/// A folder name from another computer, made safe to use here.
fn sanitize(name: &str) -> String {
    let clean: String = name.chars().map(|c| if c.is_control() || r#"<>:"|?*"#.contains(c) { '_' } else { c }).collect();
    let clean = clean.trim().trim_matches('.').to_string();
    if clean.is_empty() { "_".into() } else { clean }
}

fn now_millis() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
}

/// Sortable like slskd's ISO times: zero-padded milliseconds since 1970.
fn timestamp() -> String {
    format!("{:020}", now_millis())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn downloads_go_into_their_album_folder() {
        let base = Path::new("/d");
        assert_eq!(download_dir(base, r"@@abc\Music\Artist\Album\01 Song.flac"), base.join("Album"));
        assert_eq!(download_dir(base, "song.mp3"), base.to_path_buf());
        assert_eq!(download_dir(base, r"x\..\a.mp3"), base.join("_"));
        assert_eq!(download_dir(base, r"x\Wh?t: now\a.mp3"), base.join("Wh_t_ now"));
    }

    #[test]
    fn download_states_read_like_slskd() {
        assert_eq!(download_state(&DownloadStatus::Queued, Some(3)).0, "Queued, Remotely");
        assert_eq!(download_state(&DownloadStatus::Queued, None).0, "Queued, Locally");
        let going = DownloadStatus::InProgress { bytes_downloaded: 5, total_bytes: 10, speed_bytes_per_sec: 2.0 };
        assert_eq!(download_state(&going, None), ("InProgress", 5, 2.0, None));
        assert_eq!(download_state(&DownloadStatus::Failed(Some("x".into())), None), ("Completed, Errored", 0, 0.0, Some("x".into())));
    }
}
