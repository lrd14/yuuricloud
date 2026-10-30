//! Soulseek through slskd (https://github.com/slskd/slskd).
//!
//! Either yuuricloud runs slskd itself ("managed": a hidden background process that only listens
//! on 127.0.0.1, with a fresh random API key each start), or it talks to an slskd the user
//! already runs ("external": their URL and API key). Searching, downloading and sharing all
//! happen in slskd; this module starts it and turns its REST API into what the UI needs.

use std::io::Read;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::soundcloud::agent;


#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SlskConfig {
    /// Use an slskd the user runs themselves instead of starting one.
    pub external: bool,
    /// The external slskd, e.g. http://localhost:5030.
    pub url: String,
    /// API key for the external slskd.
    pub api_key: String,
    /// The slskd program for the managed mode. Empty = the copy "Download for me" installs.
    pub exe_path: String,
    /// Soulseek network login (managed mode).
    pub username: String,
    pub password: String,
    /// Where downloads go (managed mode). Empty = Music/Soulseek.
    pub folder: String,
    /// Share the library folders with other Soulseek users (managed mode).
    pub share_library: bool,
    /// Port other Soulseek users connect to (managed mode). 0 = pick a free one.
    pub listen_port: u16,
    /// Start Soulseek when yuuricloud opens.
    pub auto_connect: bool,
}

impl Default for SlskConfig {
    fn default() -> Self {
        SlskConfig {
            external: false,
            url: "http://localhost:5030".into(),
            api_key: String::new(),
            exe_path: String::new(),
            username: String::new(),
            password: String::new(),
            folder: String::new(),
            share_library: true,
            listen_port: 0,
            auto_connect: false,
        }
    }
}

/// A running (or reachable) slskd. Shared between requests, so a slow one (asking another user
/// something can take seconds) doesn't hold up the rest.
pub struct Conn {
    base: String,
    key: String,
    child: std::sync::Mutex<Option<Child>>,
    pid_file: Option<PathBuf>,
    /// Where finished downloads land, when known.
    pub downloads_dir: Option<PathBuf>,
    /// The port other Soulseek users connect to (managed mode).
    listen_port: Option<u16>,
    /// iOS: the Soulseek client built into the app, in place of slskd.
    native: Option<crate::slsk_native::Native>,
}

impl Drop for Conn {
    fn drop(&mut self) {
        if let Some(child) = self.child.get_mut().unwrap().as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
        if let Some(p) = &self.pid_file {
            let _ = std::fs::remove_file(p);
        }
    }
}

/// What the managed slskd needs besides the config.
pub struct Launch<'a> {
    pub exe: &'a Path,
    pub app_dir: &'a Path,
    pub downloads: &'a Path,
    pub shares: &'a [String],
}

fn random_hex(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    getrandom::fill(&mut buf).expect("no system randomness");
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

/// A YAML single-quoted string: only `'` needs escaping (as `''`).
fn yaml_str(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// Stop an slskd left over from a run of yuuricloud that didn't shut down cleanly; it would
/// still hold the Soulseek port.
fn stop_stale(pid_file: &Path) {
    let Some(pid) = std::fs::read_to_string(pid_file).ok().and_then(|s| s.trim().parse::<u32>().ok()) else { return };
    let pid = sysinfo::Pid::from_u32(pid);
    let mut sys = sysinfo::System::new();
    sys.refresh_processes(sysinfo::ProcessesToUpdate::Some(&[pid]), true);
    if let Some(p) = sys.process(pid) {
        // pids get reused, so only stop it if it really is slskd
        if p.name().to_string_lossy().to_lowercase().starts_with("slskd") {
            p.kill();
            std::thread::sleep(Duration::from_millis(500));
        }
    }
    let _ = std::fs::remove_file(pid_file);
}

fn port_free(port: u16) -> bool {
    TcpListener::bind(("0.0.0.0", port)).is_ok()
}

/// The port other Soulseek users connect to. "Automatic" prefers Soulseek's usual ports; slskd's
/// own default (50300) sits in the range Windows hands out to other programs, so it's often taken.
fn listen_port(wanted: u16) -> Result<u16, String> {
    if wanted != 0 {
        return if port_free(wanted) {
            Ok(wanted)
        } else {
            Err(format!("Listening port {wanted} is in use by another program; pick another or clear it for automatic"))
        };
    }
    (2234..=2244).chain(50300..=50310).find(|&p| port_free(p)).map(Ok).unwrap_or_else(|| {
        let l = TcpListener::bind("0.0.0.0:0").map_err(|e| e.to_string())?;
        Ok(l.local_addr().map_err(|e| e.to_string())?.port())
    })
}

fn free_port() -> Result<u16, String> {
    let l = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    Ok(l.local_addr().map_err(|e| e.to_string())?.port())
}

/// Start slskd in the background and wait until its API answers.
pub fn start_managed(cfg: &SlskConfig, launch: Launch) -> Result<Conn, String> {
    if cfg.username.trim().is_empty() || cfg.password.is_empty() {
        return Err("Enter a Soulseek username and password first".into());
    }
    if !launch.exe.is_file() {
        return Err("slskd isn't installed yet — click \"Download for me\" or pick the program".into());
    }
    std::fs::create_dir_all(launch.app_dir).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(launch.downloads).map_err(|e| format!("Couldn't create the download folder: {e}"))?;
    let pid_file = launch.app_dir.join("yuuricloud.pid");
    stop_stale(&pid_file);

    let port = free_port()?;
    let listen = listen_port(cfg.listen_port)?;
    let key = random_hex(24);
    let shares = if launch.shares.is_empty() {
        " []".to_string()
    } else {
        launch.shares.iter().map(|s| format!("\n    - {}", yaml_str(s))).collect()
    };
    // The web UI and its login are never used, but give them random credentials so nothing
    // else on this computer can sign in with slskd's well-known defaults.
    let config = format!(
        "soulseek:
  username: {user}
  password: {pass}
  listen_port: {listen}
  description: 'Listening with yuuricloud'
directories:
  downloads: {downloads}
  incomplete: {incomplete}
shares:
  directories:{shares}
web:
  port: {port}
  ip_address: 127.0.0.1
  https:
    disabled: true
  authentication:
    username: {web_user}
    password: {web_pass}
headless: true
flags:
  no_logo: true
  no_version_check: true
",
        user = yaml_str(cfg.username.trim()),
        pass = yaml_str(&cfg.password),
        listen = listen,
        downloads = yaml_str(&launch.downloads.to_string_lossy()),
        incomplete = yaml_str(&launch.app_dir.join("incomplete").to_string_lossy()),
        shares = shares,
        web_user = yaml_str(&random_hex(8)),
        web_pass = yaml_str(&random_hex(16)),
    );
    let config_file = launch.app_dir.join("slskd.yml");
    write_private(&config_file, &config)?;

    let log_file = launch.app_dir.join("yuuricloud-slskd.log");
    let log = std::fs::File::create(&log_file).map_err(|e| e.to_string())?;
    let mut cmd = Command::new(launch.exe);
    cmd.arg("--app-dir")
        .arg(launch.app_dir)
        .arg("--config")
        .arg(&config_file)
        .env("SLSKD_API_KEY", &key)
        .current_dir(launch.exe.parent().unwrap_or(launch.app_dir))
        .stdin(Stdio::null())
        .stdout(log.try_clone().map_err(|e| e.to_string())?)
        .stderr(log);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let child = cmd.spawn().map_err(|e| format!("Couldn't start slskd: {e}"))?;
    stop_with_us(&child);
    let _ = std::fs::write(&pid_file, child.id().to_string());

    let conn = Conn {
        base: format!("http://127.0.0.1:{port}"),
        key,
        child: std::sync::Mutex::new(Some(child)),
        pid_file: Some(pid_file),
        downloads_dir: Some(launch.downloads.to_path_buf()),
        listen_port: Some(listen),
        native: None,
    };
    let started = Instant::now();
    loop {
        let exited = conn.child.lock().unwrap().as_mut().unwrap().try_wait().map_err(|e| e.to_string())?;
        if let Some(status) = exited {
            let tail = log_tail(&log_file);
            return Err(format!("slskd stopped ({status}){}", if tail.is_empty() { String::new() } else { format!(": {tail}") }));
        }
        if conn.get("/api/v0/application").is_ok() {
            return Ok(conn);
        }
        if started.elapsed() > Duration::from_secs(60) {
            return Err("slskd didn't start within a minute".into());
        }
        std::thread::sleep(Duration::from_millis(400));
    }
}

/// Make sure slskd stops when yuuricloud does, even if yuuricloud crashes or is ended from Task
/// Manager: Windows closes our "kill on close" job when this process goes away, and every
/// process in the job goes with it. (Elsewhere the normal shutdown and the stale-pid check cover it.)
#[cfg(windows)]
fn stop_with_us(child: &Child) {
    use std::os::windows::io::AsRawHandle;
    use std::sync::OnceLock;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    // the job handle is deliberately never closed: it closes when this process exits
    static JOB: OnceLock<usize> = OnceLock::new();
    let job = *JOB.get_or_init(|| unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            return 0;
        }
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const std::ffi::c_void,
            std::mem::size_of_val(&info) as u32,
        );
        job as usize
    });
    if job != 0 {
        unsafe {
            AssignProcessToJobObject(job as _, child.as_raw_handle() as _);
        }
    }
}

#[cfg(not(windows))]
fn stop_with_us(_: &Child) {}

/// The config holds the Soulseek password, so keep it readable by this user only where possible.
fn write_private(path: &Path, text: &str) -> Result<(), String> {
    std::fs::write(path, text).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

/// Last meaningful line of slskd's log, to explain why it stopped.
fn log_tail(path: &Path) -> String {
    let mut text = String::new();
    if let Ok(mut f) = std::fs::File::open(path) {
        let _ = f.read_to_string(&mut text);
    }
    text.lines().rev().map(str::trim).find(|l| !l.is_empty()).unwrap_or("").chars().take(300).collect()
}

/// Connect to an slskd the user runs themselves.
pub fn connect_external(cfg: &SlskConfig) -> Result<Conn, String> {
    let base = cfg.url.trim().trim_end_matches('/').to_string();
    if !base.starts_with("http://") && !base.starts_with("https://") {
        return Err("The slskd address should start with http:// or https://".into());
    }
    let mut conn = Conn { base, key: cfg.api_key.trim().to_string(), child: std::sync::Mutex::new(None), pid_file: None, downloads_dir: None, listen_port: None, native: None };
    conn.get("/api/v0/application")?;
    // ask slskd where it saves downloads, so finished files can be shown in their folder
    conn.downloads_dir = conn
        .get("/api/v0/options")
        .ok()
        .and_then(|o| o["directories"]["downloads"].as_str().map(PathBuf::from));
    Ok(conn)
}

/// iOS: log in with the Soulseek client built into the app (see `slsk_native`).
#[cfg_attr(not(target_os = "ios"), allow(dead_code))]
pub fn connect_native(cfg: &SlskConfig, downloads: &Path, shares: &[String]) -> Result<Conn, String> {
    let native = crate::slsk_native::connect(cfg, downloads, shares)?;
    Ok(Conn {
        base: String::new(),
        key: String::new(),
        child: std::sync::Mutex::new(None),
        pid_file: None,
        downloads_dir: Some(native.downloads_dir().to_path_buf()),
        listen_port: None,
        native: Some(native),
    })
}

impl Conn {
    fn request(&self, method: &str, path: &str, body: Option<Value>) -> Result<Value, String> {
        let agent = agent(30);
        let url = format!("{}{}", self.base, path);
        let mut res = match (method, body) {
            ("GET", _) => agent.get(&url).header("X-API-Key", &self.key).call(),
            ("DELETE", _) => agent.delete(&url).header("X-API-Key", &self.key).call(),
            ("PUT", None) => agent.put(&url).header("X-API-Key", &self.key).send_empty(),
            ("POST", Some(b)) => agent.post(&url).header("X-API-Key", &self.key).send_json(b),
            ("PUT", Some(b)) => agent.put(&url).header("X-API-Key", &self.key).send_json(b),
            _ => unreachable!(),
        }
        .map_err(|e| format!("Couldn't reach slskd: {e}"))?;
        let status = res.status().as_u16();
        let text = res.body_mut().read_to_string().unwrap_or_default();
        if status == 401 || status == 403 {
            return Err("slskd refused the API key".into());
        }
        if status >= 400 {
            let msg = serde_json::from_str::<Value>(&text)
                .ok()
                .and_then(|v| v.as_str().map(String::from).or_else(|| v["title"].as_str().map(String::from)))
                .unwrap_or(text);
            return Err(if msg.is_empty() { format!("slskd error {status}") } else { msg });
        }
        Ok(serde_json::from_str(&text).unwrap_or(Value::Null))
    }

    fn get(&self, path: &str) -> Result<Value, String> {
        self.request("GET", path, None)
    }

    pub fn managed(&self) -> bool {
        self.child.lock().unwrap().is_some()
    }

    /// Whether slskd is still running (managed mode), or the built-in client still logged in.
    pub fn alive(&self) -> bool {
        if let Some(n) = &self.native {
            return n.alive();
        }
        match self.child.lock().unwrap().as_mut() {
            Some(c) => matches!(c.try_wait(), Ok(None)),
            None => true,
        }
    }

    pub fn status(&self) -> Result<Value, String> {
        if let Some(n) = &self.native {
            return Ok(n.status());
        }
        let s = self.get("/api/v0/server")?;
        Ok(json!({
            "connected": s["isConnected"].as_bool().unwrap_or(false),
            "loggedIn": s["isLoggedIn"].as_bool().unwrap_or(false),
            "busy": s["isConnecting"].as_bool().unwrap_or(false) || s["isLoggingIn"].as_bool().unwrap_or(false) || s["isTransitioning"].as_bool().unwrap_or(false),
            "state": s["state"],
            "username": s["username"],
            "listenPort": self.listen_port,
        }))
    }

    /// Start a search; returns its id.
    pub fn search(&self, text: &str) -> Result<String, String> {
        if let Some(n) = &self.native {
            return n.search(text);
        }
        let id = uuid_v4();
        self.request(
            "POST",
            "/api/v0/searches",
            Some(json!({ "id": id, "searchText": text, "searchTimeout": 15000, "responseLimit": 300, "fileLimit": 10000, "filterResponses": true })),
        )?;
        Ok(id)
    }

    /// The search's progress and the audio files found so far.
    pub fn search_results(&self, id: &str) -> Result<SearchResults, String> {
        if let Some(n) = &self.native {
            return n.search_results(id);
        }
        let s = self.get(&format!("/api/v0/searches/{id}"))?;
        let responses = self.get(&format!("/api/v0/searches/{id}/responses"))?;
        let mut files = Vec::new();
        for r in responses.as_array().into_iter().flatten() {
            let user = r["username"].as_str().unwrap_or("").to_string();
            for f in r["files"].as_array().into_iter().flatten() {
                let filename = f["filename"].as_str().unwrap_or("").to_string();
                let ext = extension(&filename);
                if !AUDIO_EXTS.contains(&ext.as_str()) {
                    continue;
                }
                files.push(SearchFile {
                    username: user.clone(),
                    filename,
                    ext,
                    size: f["size"].as_u64().unwrap_or(0),
                    bit_rate: f["bitRate"].as_u64(),
                    bit_depth: f["bitDepth"].as_u64(),
                    sample_rate: f["sampleRate"].as_u64(),
                    length: f["length"].as_f64(),
                    is_variable_bit_rate: f["isVariableBitRate"].as_bool().unwrap_or(false),
                    free_slot: r["hasFreeUploadSlot"].as_bool().unwrap_or(false),
                    queue_length: r["queueLength"].as_u64().unwrap_or(0),
                    upload_speed: r["uploadSpeed"].as_u64().unwrap_or(0),
                });
            }
        }
        Ok(SearchResults {
            complete: s["isComplete"].as_bool().unwrap_or(false),
            state: s["state"].as_str().unwrap_or("").to_string(),
            files,
        })
    }

    pub fn stop_search(&self, id: &str) -> Result<(), String> {
        if let Some(n) = &self.native {
            n.stop_search(id);
            return Ok(());
        }
        self.request("PUT", &format!("/api/v0/searches/{id}"), None).map(|_| ())
    }

    pub fn download(&self, username: &str, files: &[QueueFile]) -> Result<(), String> {
        if let Some(n) = &self.native {
            return n.download(username, files);
        }
        let body = serde_json::to_value(files).map_err(|e| e.to_string())?;
        self.request("POST", &format!("/api/v0/transfers/downloads/{}", url_part(username)), Some(body)).map(|_| ())
    }

    /// Every download slskd knows about, newest first.
    pub fn transfers(&self) -> Result<Vec<TransferInfo>, String> {
        if let Some(n) = &self.native {
            return Ok(n.transfers());
        }
        self.transfer_list("downloads", true)
    }

    /// Every file other users are downloading (or have downloaded) from our shares, newest first.
    pub fn uploads(&self) -> Result<Vec<TransferInfo>, String> {
        if let Some(n) = &self.native {
            return Ok(n.uploads());
        }
        self.transfer_list("uploads", false)
    }

    fn transfer_list(&self, direction: &str, local_paths: bool) -> Result<Vec<TransferInfo>, String> {
        let users = self.get(&format!("/api/v0/transfers/{direction}"))?;
        let mut out = Vec::new();
        for u in users.as_array().into_iter().flatten() {
            for d in u["directories"].as_array().into_iter().flatten() {
                for f in d["files"].as_array().into_iter().flatten() {
                    let filename = f["filename"].as_str().unwrap_or("").to_string();
                    let state = f["state"].as_str().unwrap_or("").to_string();
                    let path = if local_paths && state.contains("Succeeded") { self.local_path(&filename) } else { None };
                    out.push(TransferInfo {
                        id: f["id"].as_str().unwrap_or("").to_string(),
                        username: f["username"].as_str().unwrap_or("").to_string(),
                        filename,
                        size: f["size"].as_u64().unwrap_or(0),
                        state,
                        bytes: f["bytesTransferred"].as_u64().unwrap_or(0),
                        speed: f["averageSpeed"].as_f64().unwrap_or(0.0),
                        place_in_queue: f["placeInQueue"].as_u64(),
                        error: f["exception"].as_str().map(String::from),
                        requested_at: f["requestedAt"].as_str().unwrap_or("").to_string(),
                        path: path.map(|p| p.to_string_lossy().into_owned()),
                    });
                }
            }
        }
        out.sort_by(|a, b| b.requested_at.cmp(&a.requested_at));
        Ok(out)
    }

    /// slskd saves "...\Artist\Album\01 Song.flac" as <downloads>/Album/01 Song.flac.
    fn local_path(&self, remote: &str) -> Option<PathBuf> {
        let dir = self.downloads_dir.as_ref()?;
        let parts: Vec<&str> = remote.split(['\\', '/']).filter(|s| !s.is_empty()).collect();
        let name = parts.last()?;
        let path = match parts.len() {
            0 | 1 => dir.join(name),
            n => dir.join(parts[n - 2]).join(name),
        };
        path.exists().then_some(path)
    }

    /// Ask the user we're downloading from where we are in their upload queue.
    pub fn queue_position(&self, username: &str, id: &str) -> Result<Option<u64>, String> {
        if let Some(n) = &self.native {
            return Ok(n.queue_position(username, id));
        }
        let t = self.get(&format!("/api/v0/transfers/downloads/{}/{}/position", url_part(username), url_part(id)))?;
        Ok(t["placeInQueue"].as_u64().or_else(|| t.as_u64()))
    }

    /// Cancel a download; `remove` also takes it off the list.
    pub fn cancel(&self, username: &str, id: &str, remove: bool) -> Result<(), String> {
        if let Some(n) = &self.native {
            n.cancel(username, id, remove);
            return Ok(());
        }
        self.request("DELETE", &format!("/api/v0/transfers/downloads/{}/{}?remove={remove}", url_part(username), url_part(id)), None)
            .map(|_| ())
    }

    pub fn clear_finished(&self) -> Result<(), String> {
        if let Some(n) = &self.native {
            n.clear_finished();
            return Ok(());
        }
        self.request("DELETE", "/api/v0/transfers/downloads/all/completed", None).map(|_| ())
    }

    /// Stop sending a file to another user; `remove` also takes it off the list.
    pub fn cancel_upload(&self, username: &str, id: &str, remove: bool) -> Result<(), String> {
        if let Some(n) = &self.native {
            n.cancel_upload(username, id, remove);
            return Ok(());
        }
        self.request("DELETE", &format!("/api/v0/transfers/uploads/{}/{}?remove={remove}", url_part(username), url_part(id)), None)
            .map(|_| ())
    }

    pub fn clear_finished_uploads(&self) -> Result<(), String> {
        if let Some(n) = &self.native {
            n.clear_finished_uploads();
            return Ok(());
        }
        self.request("DELETE", "/api/v0/transfers/uploads/all/completed", None).map(|_| ())
    }
}

pub(crate) const AUDIO_EXTS: &[&str] = &["mp3", "flac", "m4a", "aac", "ogg", "oga", "opus", "wav", "aiff", "aif", "alac", "wma", "ape", "wv"];

/// The file name at the end of a Soulseek path (`…\Album\01 Song.flac`).
pub(crate) fn base_name(path: &str) -> &str {
    path.rsplit(['\\', '/']).next().unwrap_or(path)
}

pub(crate) fn extension(filename: &str) -> String {
    let name = base_name(filename);
    name.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default()
}

fn uuid_v4() -> String {
    let h = random_hex(16);
    format!("{}-{}-4{}-a{}-{}", &h[0..8], &h[8..12], &h[13..16], &h[17..20], &h[20..32])
}

/// Percent-encode one URL path segment.
fn url_part(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResults {
    pub complete: bool,
    pub state: String,
    pub files: Vec<SearchFile>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchFile {
    pub username: String,
    pub filename: String,
    pub ext: String,
    pub size: u64,
    pub bit_rate: Option<u64>,
    pub bit_depth: Option<u64>,
    pub sample_rate: Option<u64>,
    pub length: Option<f64>,
    pub is_variable_bit_rate: bool,
    pub free_slot: bool,
    pub queue_length: u64,
    pub upload_speed: u64,
}

#[derive(Serialize, Deserialize)]
pub struct QueueFile {
    pub filename: String,
    pub size: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferInfo {
    pub id: String,
    pub username: String,
    pub filename: String,
    pub size: u64,
    pub state: String,
    pub bytes: u64,
    pub speed: f64,
    pub place_in_queue: Option<u64>,
    pub error: Option<String>,
    pub requested_at: String,
    pub path: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn yaml_strings_escape_quotes() {
        assert_eq!(yaml_str(r"C:\Music\Bob's"), r"'C:\Music\Bob''s'");
    }

    #[test]
    fn extensions_from_remote_paths() {
        assert_eq!(extension(r"@@abc\Music\Album\01 Song.FLAC"), "flac");
        assert_eq!(extension("no-extension"), "");
    }

    #[test]
    fn url_parts_are_encoded() {
        assert_eq!(url_part("a b/c"), "a%20b%2Fc");
    }

    /// Starts a real slskd from our generated config, without going online.
    /// Run with YUURI_TEST_SLSKD=<path to slskd> cargo test -- --ignored managed_slskd
    #[test]
    #[ignore]
    fn managed_slskd_starts_and_answers() {
        let exe = PathBuf::from(std::env::var("YUURI_TEST_SLSKD").expect("set YUURI_TEST_SLSKD"));
        std::env::set_var("SLSKD_NO_CONNECT", "true"); // inherited by slskd: never log in to the network
        let base = std::env::temp_dir().join(format!("yuuricloud-slskd-test-{}", std::process::id()));
        let (app_dir, downloads, shared) = (base.join("app"), base.join("down's"), base.join("shared"));
        std::fs::create_dir_all(&shared).unwrap();
        let cfg = SlskConfig { username: "nobody".into(), password: "x'y".into(), ..Default::default() };
        let shares = vec![shared.to_string_lossy().into_owned()];
        let conn = start_managed(&cfg, Launch { exe: &exe, app_dir: &app_dir, downloads: &downloads, shares: &shares }).unwrap();
        let status = conn.status().unwrap();
        assert_eq!(status["loggedIn"], false);
        assert!(conn.transfers().unwrap().is_empty());
        assert!(conn.search("test").unwrap_err().contains("logged in"));
        // without the key, slskd turns requests away
        let open = Conn { base: conn.base.clone(), key: "wrong".into(), child: std::sync::Mutex::new(None), pid_file: None, downloads_dir: None, listen_port: None, native: None };
        assert!(open.status().unwrap_err().contains("API key"));
        drop(open);
        drop(conn);
        let _ = std::fs::remove_dir_all(&base);
    }

    /// Leaves slskd running without shutting it down; afterwards no slskd from YUURI_TEST_SLSKD
    /// should be left, because the job object ends it with this test process.
    #[test]
    #[ignore]
    fn managed_slskd_dies_with_us() {
        let exe = PathBuf::from(std::env::var("YUURI_TEST_SLSKD").expect("set YUURI_TEST_SLSKD"));
        std::env::set_var("SLSKD_NO_CONNECT", "true");
        let base = std::env::temp_dir().join(format!("yuuricloud-slskd-orphan-{}", std::process::id()));
        let cfg = SlskConfig { username: "nobody".into(), password: "x".into(), ..Default::default() };
        let conn = start_managed(&cfg, Launch { exe: &exe, app_dir: &base.join("app"), downloads: &base.join("down"), shares: &[] }).unwrap();
        std::mem::forget(conn); // no clean shutdown
    }

    #[test]
    fn uuids_look_like_uuids() {
        let id = uuid_v4();
        assert_eq!(id.len(), 36);
        assert_eq!(&id[14..15], "4");
    }
}
