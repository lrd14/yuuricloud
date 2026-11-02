//! The lock screen, Control Center and headphone controls on the iPhone (see
//! ios/Sources/MediaControls). The web view's own version of them can't show next and previous
//! song, so this takes them over: the frontend tells it what's playing with `update`, and gets a
//! "command" event when a control is pressed. Does nothing on other systems.

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
