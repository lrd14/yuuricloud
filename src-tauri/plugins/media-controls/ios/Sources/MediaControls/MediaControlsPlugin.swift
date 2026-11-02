import AVFoundation
import Foundation
import MediaPlayer
import Tauri
import UIKit

/// What's playing, from the frontend.
struct NowPlayingArgs: Decodable {
  let title: String?
  let artist: String?
  let album: String?
  /// seconds
  let duration: Double?
  let position: Double?
  let playing: Bool?
  let rate: Double?
  /// a picture file on the phone
  let artwork: String?
}

/// The lock screen, Control Center and headphone controls. The song itself still plays in the
/// web view; this only says what's playing and passes the buttons on to the frontend as
/// "command" events: play, pause, toggle, next, previous and seek (with a position).
class MediaControlsPlugin: Plugin {
  private var registered = false
  private var artworkPath: String?
  private var artwork: MPMediaItemArtwork?

  @objc public func update(_ invoke: Invoke) {
    let args = try? invoke.parseArgs(NowPlayingArgs.self)
    DispatchQueue.main.async {
      self.registerCommands()
      let playing = args?.playing ?? false
      let rate = args?.rate ?? 1.0
      var info: [String: Any] = [
        MPMediaItemPropertyTitle: args?.title ?? "",
        MPNowPlayingInfoPropertyElapsedPlaybackTime: max(0, args?.position ?? 0),
        // with the rate, the system moves the time along by itself between updates
        MPNowPlayingInfoPropertyPlaybackRate: playing ? rate : 0.0,
        MPNowPlayingInfoPropertyDefaultPlaybackRate: 1.0,
        MPNowPlayingInfoPropertyMediaType: MPNowPlayingInfoMediaType.audio.rawValue,
      ]
      if let artist = args?.artist, !artist.isEmpty { info[MPMediaItemPropertyArtist] = artist }
      if let album = args?.album, !album.isEmpty { info[MPMediaItemPropertyAlbumTitle] = album }
      if let duration = args?.duration, duration.isFinite, duration > 0 { info[MPMediaItemPropertyPlaybackDuration] = duration }
      if let artwork = self.loadArtwork(args?.artwork) { info[MPMediaItemPropertyArtwork] = artwork }
      let center = MPNowPlayingInfoCenter.default()
      center.nowPlayingInfo = info
      center.playbackState = playing ? .playing : .paused
      invoke.resolve()
    }
  }

  @objc public func clear(_ invoke: Invoke) {
    DispatchQueue.main.async {
      MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
      MPNowPlayingInfoCenter.default().playbackState = .stopped
      invoke.resolve()
    }
  }

  private func loadArtwork(_ path: String?) -> MPMediaItemArtwork? {
    guard let path = path, !path.isEmpty else {
      artworkPath = nil
      artwork = nil
      return nil
    }
    if path == artworkPath { return artwork }
    artworkPath = path
    if let image = UIImage(contentsOfFile: path) {
      artwork = MPMediaItemArtwork(boundsSize: image.size) { _ in image }
    } else {
      artwork = nil
    }
    return artwork
  }

  private func send(_ action: String, _ position: Double? = nil) {
    var data: JSObject = ["action": action]
    if let position = position { data["position"] = position }
    trigger("command", data: data)
  }

  private func registerCommands() {
    if registered { return }
    registered = true
    let session = AVAudioSession.sharedInstance()
    try? session.setCategory(.playback, mode: .default)
    try? session.setActive(true)
    UIApplication.shared.beginReceivingRemoteControlEvents()

    let center = MPRemoteCommandCenter.shared()
    // previous and next song, not "skip 10 seconds": iOS shows one pair or the other
    for command in [center.skipForwardCommand, center.skipBackwardCommand, center.seekForwardCommand, center.seekBackwardCommand] {
      command.isEnabled = false
      command.removeTarget(nil)
    }
    let buttons: [(MPRemoteCommand, String)] = [
      (center.playCommand, "play"),
      (center.pauseCommand, "pause"),
      (center.togglePlayPauseCommand, "toggle"),
      (center.nextTrackCommand, "next"),
      (center.previousTrackCommand, "previous"),
    ]
    for (command, action) in buttons {
      command.isEnabled = true
      command.addTarget { [weak self] _ in
        self?.send(action)
        return .success
      }
    }
    center.changePlaybackPositionCommand.isEnabled = true
    center.changePlaybackPositionCommand.addTarget { [weak self] event in
      guard let event = event as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
      self?.send("seek", event.positionTime)
      return .success
    }
  }
}

@_cdecl("init_plugin_media_controls")
func initPlugin() -> Plugin {
  return MediaControlsPlugin()
}
