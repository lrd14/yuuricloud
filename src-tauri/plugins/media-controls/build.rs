const COMMANDS: &[&str] = &["set_queue", "play", "pause", "seek", "set_volume", "set_rate", "stop", "register_listener", "remove_listener"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).ios_path("ios").build();
}
