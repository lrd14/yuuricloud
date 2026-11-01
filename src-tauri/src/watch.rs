//! Notice songs being added to, changed in or removed from the library folders, so the library
//! updates by itself (computers only). The frontend gets "library-changed" a couple of seconds
//! after the last change and rescans, quietly.

use std::path::Path;
use std::sync::mpsc::{channel, RecvTimeoutError};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter};

/// Changes closer together than this are one change (copying an album is hundreds of events).
const QUIET: Duration = Duration::from_secs(3);

static WATCH: OnceLock<Mutex<Option<(Vec<String>, RecommendedWatcher)>>> = OnceLock::new();

/// Watch these folders (and stop watching any others). Does nothing when they're the same.
pub fn watch(app: &AppHandle, folders: &[String]) {
    let slot = WATCH.get_or_init(|| Mutex::new(None));
    let mut slot = slot.lock().unwrap();
    if slot.as_ref().is_some_and(|(f, _)| f == folders) {
        return;
    }
    *slot = None; // drops the old watcher, which stops it
    if folders.is_empty() {
        return;
    }
    let (tx, rx) = channel::<()>();
    let Ok(mut watcher) = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(event) = res else { return };
        if matches!(event.kind, EventKind::Access(_)) {
            return;
        }
        // a song, or a folder (moving a folder in or out of the library only tells about the folder)
        if event.paths.iter().any(|p| is_song(p) || p.extension().is_none()) {
            let _ = tx.send(());
        }
    }) else {
        return;
    };
    for f in folders {
        let _ = watcher.watch(Path::new(f), RecursiveMode::Recursive);
    }
    let app = app.clone();
    std::thread::spawn(move || {
        // wait for a change, then for things to go quiet, then say so; ends when the watcher goes
        while rx.recv().is_ok() {
            loop {
                match rx.recv_timeout(QUIET) {
                    Ok(()) => continue,
                    Err(RecvTimeoutError::Timeout) => break,
                    Err(RecvTimeoutError::Disconnected) => return,
                }
            }
            let _ = app.emit("library-changed", ());
        }
    });
    *slot = Some((folders.to_vec(), watcher));
}

fn is_song(p: &Path) -> bool {
    p.extension().is_some_and(|e| crate::library::AUDIO_EXTS.contains(&e.to_string_lossy().to_lowercase().as_str()))
}
