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
  /// Holds the current song and the next one, already loading, so one follows the other with no gap.
  private let player = AVQueuePlayer()
  private var items: [QueueItem] = []
  private var index = 0
  private var repeatOne = false
  private var wantPlaying = false
  private var rate: Float = 1
  private var loadedPath: String?
  private var ready = false
  private var endObserver: NSObjectProtocol?
  private var itemObserver: NSKeyValueObservation?
  /// each song in the player: its file
  private var itemPaths: [ObjectIdentifier: String] = [:]
  /// the song being played (what the player's current item was last known to be)
  private var currentLoaded: AVPlayerItem?
  /// true while the queue is being rebuilt, so the player moving about isn't taken for a song ending
  private var rebuilding = false
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
      } else {
        // the same song: what follows it (shuffle, repeat, a song added) may have changed
        self.enqueueNext()
        if play != self.wantPlaying {
          play ? self.resume() : self.halt()
        } else {
          self.showNowPlaying()
          self.report()
        }
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
      self.rebuilding = true
      self.player.removeAllItems()
      self.rebuilding = false
      self.itemPaths.removeAll()
      self.currentLoaded = nil
      self.loadedPath = nil
      self.report()
      invoke.resolve()
    }
  }

  // MARK: playing

  private func load(at position: Double, play: Bool) {
    rebuilding = true
    player.removeAllItems()
    itemPaths.removeAll()
    let current = makeItem(index)
    player.insert(current, after: nil)
    currentLoaded = current
    loadedPath = items[index].path
    enqueueNext()
    rebuilding = false
    if position > 0 {
      player.seek(to: CMTime(seconds: position, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero)
    }
    wantPlaying = play
    if play { player.playImmediately(atRate: rate) } else { player.pause() }
    showNowPlaying()
    report()
  }

  private func makeItem(_ i: Int) -> AVPlayerItem {
    let item = AVPlayerItem(url: URL(fileURLWithPath: items[i].path))
    itemPaths[ObjectIdentifier(item)] = items[i].path
    return item
  }

  /// Keep the song after this one queued behind it, loading, so it starts the moment this one ends.
  /// With nothing after it (the last song, or repeat one) the player stays on this one at its end,
  /// and `itemEnded` takes it from there.
  private func enqueueNext() {
    let next = index + 1
    let want = !repeatOne && items.indices.contains(next)
    player.actionAtItemEnd = want ? .advance : .pause
    let queued = player.items()
    let behind = Array(queued.dropFirst())
    if want, behind.count == 1, itemPaths[ObjectIdentifier(behind[0])] == items[next].path { return }
    rebuilding = true
    for extra in behind {
      player.remove(extra)
      itemPaths[ObjectIdentifier(extra)] = nil
    }
    if want, let current = player.currentItem {
      player.insert(makeItem(next), after: current)
    }
    rebuilding = false
  }

  /// The player went on to the queued song by itself.
  private func currentItemChanged() {
    guard !rebuilding, let current = player.currentItem, current !== currentLoaded,
          let path = itemPaths[ObjectIdentifier(current)] else { return }
    currentLoaded = current
    if items.indices.contains(index + 1), items[index + 1].path == path {
      index += 1
    } else if let found = items.firstIndex(where: { $0.path == path }) {
      index = found
    } else {
      return
    }
    loadedPath = path
    enqueueNext()
    if wantPlaying { player.rate = rate }
    showNowPlaying()
    report()
  }

  /// A song played to its end. Moving on to the queued one is the player's own doing; this is for
  /// repeat one and for the last song.
  private func itemEnded(_ item: AVPlayerItem?) {
    guard let item = item, item === currentLoaded else { return }
    if repeatOne {
      seek(to: 0)
      player.playImmediately(atRate: rate)
      return
    }
    if items.indices.contains(index + 1) { return }
    wantPlaying = false
    showNowPlaying()
    report(ended: true)
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

    // the player moving on to the queued song, and a song reaching its end
    itemObserver = player.observe(\.currentItem, options: [.new]) { [weak self] _, _ in
      DispatchQueue.main.async { self?.currentItemChanged() }
    }
    endObserver = NotificationCenter.default.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: nil, queue: .main) { [weak self] note in
      self?.itemEnded(note.object as? AVPlayerItem)
    }

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
