//! Playing songs on the iPhone (see ios/Sources/MediaControls). A song playing in the web view
//! gets the web view's own lock screen controls, which can only skip 10 seconds and fight with
//! anything else, and the web view can't start the next song while the app is in the background.
//! So on the iPhone the songs play here, natively: the frontend hands over the current song and
//! the ones after it (`set_queue`), this plays through them, keeps the lock screen, Control Center
//! and headphone controls, and reports back with "state" events. Does nothing on other systems.

use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_media_controls);

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("media-controls")
        .setup(|_app, _api| {
            #[cfg(target_os = "ios")]
            _api.register_ios_plugin(init_plugin_media_controls)?;
            Ok(())
        })
        .build()
}
