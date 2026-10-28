//! "Download for me": fetch helper programs (yt-dlp, slskd) from their official GitHub releases
//! into the app's data folder, so users don't have to install them by hand.
//!
//! Every file is checked against the SHA-256 digest GitHub publishes for the release asset;
//! a file without a digest, or one that doesn't match, is rejected.

use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;

use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::soundcloud::{agent, download_tracked, Progress};

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Tool {
    YtDlp,
    Slskd,
}

impl Tool {
    pub fn parse(name: &str) -> Result<Tool, String> {
        match name {
            "yt-dlp" => Ok(Tool::YtDlp),
            "slskd" => Ok(Tool::Slskd),
            _ => Err(format!("Unknown tool {name}")),
        }
    }

    fn repo(self) -> &'static str {
        match self {
            Tool::YtDlp => "yt-dlp/yt-dlp",
            Tool::Slskd => "slskd/slskd",
        }
    }

    /// Name of the release file for this computer, or how to tell which one it is.
    fn wanted_asset(self) -> Result<AssetMatch, String> {
        let (os, arch) = (std::env::consts::OS, std::env::consts::ARCH);
        let unsupported = || Err(format!("No ready-made download for {os} {arch}; install it yourself and pick the program"));
        Ok(match self {
            Tool::YtDlp => AssetMatch::Exact(match (os, arch) {
                ("windows", _) => "yt-dlp.exe",
                ("macos", _) => "yt-dlp_macos",
                ("linux", "x86_64") => "yt-dlp_linux",
                ("linux", "aarch64") => "yt-dlp_linux_aarch64",
                _ => return unsupported(),
            }),
            Tool::Slskd => AssetMatch::Suffix(match (os, arch) {
                ("windows", "x86_64") => "-win-x64.zip",
                ("windows", "aarch64") => "-win-arm64.zip",
                ("macos", "aarch64") => "-osx-arm64.zip",
                ("macos", "x86_64") => "-osx-x64.zip",
                ("linux", "x86_64") => "-linux-x64.zip",
                ("linux", "aarch64") => "-linux-arm64.zip",
                _ => return unsupported(),
            }),
        })
    }

    /// Where the program ends up once installed.
    pub fn installed_path(self, tools_dir: &Path) -> PathBuf {
        let exe = if cfg!(windows) { ".exe" } else { "" };
        match self {
            Tool::YtDlp => tools_dir.join(format!("yt-dlp{exe}")),
            Tool::Slskd => tools_dir.join("slskd").join(format!("slskd{exe}")),
        }
    }
}

enum AssetMatch {
    Exact(&'static str),
    Suffix(&'static str),
}

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    assets: Vec<Asset>,
}

#[derive(Deserialize)]
struct Asset {
    name: String,
    browser_download_url: String,
    #[serde(default)]
    digest: Option<String>,
}

/// Download the latest release of `tool` into `tools_dir` and return the program's path.
pub fn install(tool: Tool, tools_dir: &Path, progress: Progress, cancel: &AtomicBool) -> Result<(PathBuf, String), String> {
    let agent = agent(1800);
    let url = format!("https://api.github.com/repos/{}/releases/latest", tool.repo());
    let mut res = agent
        .get(&url)
        .header("User-Agent", "yuuricloud")
        .header("Accept", "application/vnd.github+json")
        .call()
        .map_err(|e| format!("Couldn't reach GitHub: {e}"))?;
    if res.status().as_u16() >= 400 {
        return Err(format!("GitHub said {} for {}", res.status().as_u16(), tool.repo()));
    }
    let release: Release = res.body_mut().read_json().map_err(|e| format!("Unexpected answer from GitHub: {e}"))?;

    let wanted = tool.wanted_asset()?;
    let asset = release
        .assets
        .iter()
        .find(|a| match wanted {
            AssetMatch::Exact(name) => a.name == name,
            AssetMatch::Suffix(suffix) => a.name.ends_with(suffix),
        })
        .ok_or_else(|| format!("The {} release has no file for this computer", release.tag_name))?;
    let expected = asset
        .digest
        .as_deref()
        .and_then(|d| d.strip_prefix("sha256:"))
        .ok_or("GitHub didn't publish a checksum for this file, so it wasn't installed")?
        .to_ascii_lowercase();

    let bytes = download_tracked(&agent, &asset.browser_download_url, progress, cancel)?;
    let actual = format!("{:x}", Sha256::digest(&bytes));
    if actual != expected {
        return Err("The downloaded file didn't match GitHub's checksum, so it wasn't installed".into());
    }

    std::fs::create_dir_all(tools_dir).map_err(|e| e.to_string())?;
    let target = tool.installed_path(tools_dir);
    match tool {
        Tool::YtDlp => write_atomic(&target, &bytes)?,
        Tool::Slskd => unzip_into(&bytes, target.parent().unwrap())?,
    }
    make_executable(&target)?;
    if !target.exists() {
        return Err("The download didn't contain the program".into());
    }
    Ok((target, release.tag_name))
}

fn write_atomic(target: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = target.with_extension("download");
    std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    // the old copy may be running (e.g. a download in progress); then keep it and report that
    std::fs::rename(&tmp, target).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("Couldn't replace the old copy (is it running?): {e}")
    })
}

/// Unpack a release zip into `dir`, replacing what was there.
fn unzip_into(bytes: &[u8], dir: &Path) -> Result<(), String> {
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).map_err(|e| format!("Bad zip file: {e}"))?;
    let tmp = dir.with_extension("download");
    let _ = std::fs::remove_dir_all(&tmp);
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
        // enclosed_name rejects absolute paths and "..", so nothing lands outside the folder
        let Some(rel) = entry.enclosed_name() else { continue };
        let out = tmp.join(rel);
        if entry.is_dir() {
            std::fs::create_dir_all(&out).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut file = std::fs::File::create(&out).map_err(|e| e.to_string())?;
        std::io::copy(&mut entry, &mut file).map_err(|e| e.to_string())?;
    }
    if dir.exists() {
        std::fs::remove_dir_all(dir).map_err(|e| format!("Couldn't replace the old copy (is it running?): {e}"))?;
    }
    std::fs::rename(&tmp, dir).map_err(|e| e.to_string())
}

#[cfg(unix)]
fn make_executable(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())
}

#[cfg(not(unix))]
fn make_executable(_: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_a_file_for_this_computer() {
        assert!(Tool::YtDlp.wanted_asset().is_ok());
        assert!(Tool::Slskd.wanted_asset().is_ok());
    }

    #[test]
    fn unzip_keeps_files_inside_the_folder() {
        use std::io::Write;
        let mut buf = std::io::Cursor::new(Vec::new());
        {
            let mut w = zip::ZipWriter::new(&mut buf);
            let opts = zip::write::SimpleFileOptions::default();
            w.start_file("slskd.exe", opts).unwrap();
            w.write_all(b"program").unwrap();
            w.start_file("../evil.txt", opts).unwrap();
            w.write_all(b"nope").unwrap();
            w.finish().unwrap();
        }
        let base = std::env::temp_dir().join(format!("yuuricloud-unzip-{}", std::process::id()));
        let dir = base.join("slskd");
        unzip_into(buf.get_ref(), &dir).unwrap();
        assert_eq!(std::fs::read(dir.join("slskd.exe")).unwrap(), b"program");
        assert!(!base.join("evil.txt").exists());
        let _ = std::fs::remove_dir_all(&base);
    }
}
