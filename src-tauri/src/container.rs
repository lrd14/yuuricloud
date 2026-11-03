//! iOS keeps each app's files in a folder named by a random id
//! (`/var/mobile/Containers/Data/Application/<id>/`), and can give the app a new id when it's
//! updated or reinstalled. The files move along, but every path saved before then (favourites,
//! playlists, ratings and play counts, which are kept by the song's path) points at the old
//! folder. `rebase` moves such a path to the app's folder as it is now.

const MARK: &str = "/Containers/Data/Application/";

/// The app's own folder in `path`: everything up to and including the id.
fn home_of(path: &str) -> Option<&str> {
    let at = path.find(MARK)? + MARK.len();
    let end = path[at..].find('/').map(|i| at + i).unwrap_or(path.len());
    Some(&path[..end])
}

/// `path` inside `home` (the app's folder now), if it was saved inside an earlier one.
pub fn rebase(path: &str, home: &str) -> Option<String> {
    let old = home_of(path)?;
    if old == home {
        return None;
    }
    Some(format!("{home}{}", &path[old.len()..]))
}

/// The app's folder now, from any folder inside it (like its Documents folder).
pub fn current_home(inside: &std::path::Path) -> Option<String> {
    home_of(&inside.to_string_lossy()).map(String::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn moves_paths_to_the_new_app_folder() {
        let home = "/private/var/mobile/Containers/Data/Application/NEW-1111";
        let old = "/private/var/mobile/Containers/Data/Application/OLD-2222/Documents/Band/Album/01 Song.flac";
        assert_eq!(rebase(old, home).as_deref(), Some("/private/var/mobile/Containers/Data/Application/NEW-1111/Documents/Band/Album/01 Song.flac"));
        // without /private, as iOS sometimes gives it
        assert_eq!(
            rebase("/var/mobile/Containers/Data/Application/OLD-2222/Documents/a.mp3", home).as_deref(),
            Some("/private/var/mobile/Containers/Data/Application/NEW-1111/Documents/a.mp3")
        );
        assert_eq!(rebase(&format!("{home}/Documents/a.mp3"), home), None, "already right");
        assert_eq!(rebase("/Users/noah/Music/a.mp3", home), None, "not an iPhone path");
        assert_eq!(current_home(std::path::Path::new("/var/mobile/Containers/Data/Application/X/Documents")).as_deref(), Some("/var/mobile/Containers/Data/Application/X"));
    }
}
