import AVFoundation
import Foundation
import MediaPlayer
import Tauri
import UIKit

struct QueueItem: Decodable {
  let path: String
  let title: String?
  let artist: String?
  let album: String?
  /// a picture file on the phone
  let artwork: String?
  let duration: Double?
}

struct QueueArgs: Decodable {
  let items: [QueueItem]
  /// which of the items is the current song
  let index: Int
  /// start the current song here (when it's a different song from the one loaded)
  let position: Double?
  /// start or stop playing; leave as it is when missing
  let play: Bool?
  let repeatOne: Bool?
}

struct SeekArgs: Decodable { let position: Double }
struct VolumeArgs: Decodable { let volume: Double }
struct RateArgs: Decodable { let rate: Double }

/// Plays the songs the frontend hands over, one after another, with AVPlayer, so that playing
/// carries on with the app in the background. The lock screen, Control Center and headphones
/// control it directly (previous and next song, play, pause, scrubbing). The frontend hears about
/// everything through "state" events: which song (index and path), where it's at, whether it's
/// playing, and `ended` when the last song handed over has finished.
class MediaControlsPlugin: Plugin {
  private let player = AVPlayer()
  private var items: [QueueItem] = []
  private var index = 0
  private var repeatOne = false
  private var wantPlaying = false
  private var rate: Float = 1
  private var loadedPath: String?
  private var ready = false
  private var endObserver: NSObjectProtocol?
  private var tickObserver: Any?
  private var artworkPath: String?
  private var artwork: MPMediaItemArtwork?

  // MARK: commands from the frontend

  @objc public func setQueue(_ invoke: Invoke) {
    guard let args = try? invoke.parseArgs(QueueArgs.self), !args.items.isEmpty else {
      invoke.reject("No songs")
      return
    }
    DispatchQueue.main.async {
      self.setUp()
      self.items = args.items
      self.index = min(max(0, args.index), args.items.count - 1)
      self.repeatOne = args.repeatOne ?? false
      let play = args.play ?? self.wantPlaying
      if self.items[self.index].path != self.loadedPath {
        self.load(at: args.position ?? 0, play: play)
      } else if play != self.wantPlaying {
        play ? self.resume() : self.halt()
      } else {
        self.showNowPlaying()
        self.report()
      }
      invoke.resolve()
    }
  }

  @objc public func play(_ invoke: Invoke) {
    DispatchQueue.main.async {
      self.resume()
      invoke.resolve()
    }
  }

  @objc public func pause(_ invoke: Invoke) {
    DispatchQueue.main.async {
      self.halt()
      invoke.resolve()
    }
  }

  @objc public func seek(_ invoke: Invoke) {
    guard let args = try? invoke.parseArgs(SeekArgs.self) else { return invoke.reject("No position") }
    DispatchQueue.main.async {
      self.seek(to: args.position)
      invoke.resolve()
    }
  }

  @objc public func setVolume(_ invoke: Invoke) {
    guard let args = try? invoke.parseArgs(VolumeArgs.self) else { return invoke.reject("No volume") }
    DispatchQueue.main.async {
      self.player.volume = Float(min(1, max(0, args.volume)))
      invoke.resolve()
    }
  }

  @objc public func setRate(_ invoke: Invoke) {
    guard let args = try? invoke.parseArgs(RateArgs.self), args.rate > 0 else { return invoke.reject("No rate") }
    DispatchQueue.main.async {
      self.rate = Float(args.rate)
      if self.wantPlaying { self.player.rate = self.rate }
      self.showNowPlaying()
      invoke.resolve()
    }
  }

  /// Let go of the song file (so it can be rewritten, say with new tags).
  @objc public func stop(_ invoke: Invoke) {
    DispatchQueue.main.async {
      self.wantPlaying = false
      self.player.pause()
      self.player.replaceCurrentItem(with: nil)
      self.loadedPath = nil
      self.report()
      invoke.resolve()
    }
  }

  // MARK: playing

  private func load(at position: Double, play: Bool) {
    let item = items[index]
    let playerItem = AVPlayerItem(url: URL(fileURLWithPath: item.path))
    if let old = endObserver { NotificationCenter.default.removeObserver(old) }
    endObserver = NotificationCenter.default.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: playerItem, queue: .main) { [weak self] _ in
      self?.finished()
    }
    player.replaceCurrentItem(with: playerItem)
    loadedPath = item.path
    if position > 0 {
      player.seek(to: CMTime(seconds: position, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero)
    }
    wantPlaying = play
    if play { player.playImmediately(atRate: rate) } else { player.pause() }
    showNowPlaying()
    report()
  }

  private func resume() {
    guard loadedPath != nil else { return }
    wantPlaying = true
    try? AVAudioSession.sharedInstance().setActive(true)
    player.playImmediately(atRate: rate)
    showNowPlaying()
    report()
  }

  private func halt() {
    wantPlaying = false
    player.pause()
    showNowPlaying()
    report()
  }

  private func seek(to position: Double) {
    let time = CMTime(seconds: max(0, position), preferredTimescale: 600)
    player.seek(to: time, toleranceBefore: .zero, toleranceAfter: .zero) { [weak self] _ in
      DispatchQueue.main.async {
        self?.showNowPlaying()
        self?.report()
      }
    }
  }

  private func finished() {
    if repeatOne {
      seek(to: 0)
      player.playImmediately(atRate: rate)
      return
    }
    if index + 1 < items.count {
      index += 1
      load(at: 0, play: true)
    } else {
      wantPlaying = false
      showNowPlaying()
      report(ended: true)
    }
  }

  private func next() {
    if index + 1 < items.count {
      index += 1
      load(at: 0, play: true)
    } else {
      // the frontend knows what comes after (repeat, a reshuffle)
      report(ended: true)
    }
  }

  private func previous() {
    if position() > 3 || index == 0 {
      seek(to: 0)
    } else {
      index -= 1
      load(at: 0, play: true)
    }
  }

  private func position() -> Double {
    let t = player.currentTime().seconds
    return t.isFinite ? max(0, t) : 0
  }

  private func duration() -> Double {
    if let d = player.currentItem?.duration.seconds, d.isFinite, d > 0 { return d }
    return items.indices.contains(index) ? items[index].duration ?? 0 : 0
  }

  // MARK: telling the frontend and the system

  private func report(ended: Bool = false) {
    var data: JSObject = [
      "index": index,
      "path": loadedPath ?? "",
      "position": position(),
      "duration": duration(),
      "playing": wantPlaying,
      "ended": ended,
    ]
    if let error = player.currentItem?.error { data["error"] = error.localizedDescription }
    trigger("state", data: data)
  }

  private func showNowPlaying() {
    guard items.indices.contains(index), loadedPath != nil else {
      MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
      return
    }
    let item = items[index]
    var info: [String: Any] = [
      MPMediaItemPropertyTitle: item.title ?? "",
      MPNowPlayingInfoPropertyElapsedPlaybackTime: position(),
      // with the rate, the system moves the time along by itself
      MPNowPlayingInfoPropertyPlaybackRate: wantPlaying ? Double(rate) : 0.0,
      MPNowPlayingInfoPropertyDefaultPlaybackRate: 1.0,
      MPNowPlayingInfoPropertyMediaType: MPNowPlayingInfoMediaType.audio.rawValue,
    ]
    if let artist = item.artist, !artist.isEmpty { info[MPMediaItemPropertyArtist] = artist }
    if let album = item.album, !album.isEmpty { info[MPMediaItemPropertyAlbumTitle] = album }
    let d = duration()
    if d > 0 { info[MPMediaItemPropertyPlaybackDuration] = d }
    if let art = loadArtwork(item.artwork) { info[MPMediaItemPropertyArtwork] = art }
    MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    MPNowPlayingInfoCenter.default().playbackState = wantPlaying ? .playing : .paused
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

  // MARK: set-up

  private func setUp() {
    if ready { return }
    ready = true
    let session = AVAudioSession.sharedInstance()
    try? session.setCategory(.playback, mode: .default)
    try? session.setActive(true)
    UIApplication.shared.beginReceivingRemoteControlEvents()
    player.automaticallyWaitsToMinimizeStalling = false

    // where it's at, for the frontend's seek bar and lyrics (the lock screen keeps time itself)
    tickObserver = player.addPeriodicTimeObserver(forInterval: CMTime(seconds: 0.5, preferredTimescale: 600), queue: .main) { [weak self] _ in
      self?.report()
    }

    // a phone call or another app's sound stops it; it stays stopped
    NotificationCenter.default.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] note in
      guard let self = self,
            let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
            AVAudioSession.InterruptionType(rawValue: raw) == .began else { return }
      self.wantPlaying = false
      self.showNowPlaying()
      self.report()
    }
    // headphones unplugged: pause, as every music app does
    NotificationCenter.default.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { [weak self] note in
      guard let self = self,
            let raw = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
            AVAudioSession.RouteChangeReason(rawValue: raw) == .oldDeviceUnavailable else { return }
      self.halt()
    }

    let center = MPRemoteCommandCenter.shared()
    // previous and next song, not "skip 10 seconds": iOS shows one pair or the other
    for command in [center.skipForwardCommand, center.skipBackwardCommand, center.seekForwardCommand, center.seekBackwardCommand] as [MPRemoteCommand] {
      command.isEnabled = false
    }
    let handlers: [(MPRemoteCommand, () -> Void)] = [
      (center.playCommand, { [weak self] in self?.resume() }),
      (center.pauseCommand, { [weak self] in self?.halt() }),
      (center.togglePlayPauseCommand, { [weak self] in
        guard let self = self else { return }
        self.wantPlaying ? self.halt() : self.resume()
      }),
      (center.nextTrackCommand, { [weak self] in self?.next() }),
      (center.previousTrackCommand, { [weak self] in self?.previous() }),
    ]
    for (command, action) in handlers {
      command.isEnabled = true
      command.addTarget { _ in
        action()
        return .success
      }
    }
    center.changePlaybackPositionCommand.isEnabled = true
    center.changePlaybackPositionCommand.addTarget { [weak self] event in
      guard let event = event as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
      self?.seek(to: event.positionTime)
      return .success
    }
  }
}

@_cdecl("init_plugin_media_controls")
func initPlugin() -> Plugin {
  return MediaControlsPlugin()
}
