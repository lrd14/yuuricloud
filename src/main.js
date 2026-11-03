"use strict";

const { invoke, convertFileSrc } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const UNKNOWN_ARTIST = "Unknown Artist";
const REPEAT_OFF = 0, REPEAT_ALL = 1, REPEAT_ONE = 2;
// Shuffle plays every song once in a random order; random picks each next song afresh, so songs can
// come up again before the rest have played.
const SHUFFLE_OFF = 0, SHUFFLE_ON = 1, SHUFFLE_RANDOM = 2;
/** Saved shuffle settings from before random mode were true/false. */
const shuffleMode = (v) => (v === true ? SHUFFLE_ON : [SHUFFLE_ON, SHUFFLE_RANDOM].includes(v) ? v : SHUFFLE_OFF);

const $ = (id) => document.getElementById(id);
const el = {
  search: $("search"), artistList: $("artist-list"), albumGrid: $("album-grid"),
  songBody: $("song-body"), songTable: $("song-table"), songGrid: $("song-grid"), empty: $("empty"), library: $("library"),
  artistsTitle: $("artists-title"), albumsTitle: $("albums-title"), songsTitle: $("songs-title"),
  folderList: $("folder-list"), preferTags: $("prefer-tags"), status: $("status"),
  settings: $("settings"), ambient: $("ambient"), nowText: document.querySelector(".now-text"),
  nowCover: $("now-cover"), nowTitle: $("now-title"), nowArtist: $("now-artist"),
  play: $("play"), playIcon: $("play-icon"), shuffle: $("shuffle"), repeat: $("repeat"),
  repeatIcon: $("repeat-icon"), seek: $("seek"), pos: $("pos"), dur: $("dur"),
  volume: $("volume"), volIcon: $("vol-icon"),
};

const state = {
  settings: { folders: [], volume: 0.7, preferTags: false },
  tracks: [],
  autoFolders: [], // download folders that are always scanned: [{ path, label }]
  favorites: new Set(), // paths of favourite library songs
  stats: {}, // song path -> { plays, last }
  playlists: [], // [{ id, name, songs: [paths] }]
  query: "",
  artist: null,   // artist key, null = all artists
  album: null,    // album key, null = every album of the artist
  visible: [],    // tracks passing the search
  shown: [],      // tracks in the song table
  albumKeys: [],  // album keys in grid order
  selected: -1,   // selected row in the song table
  queue: [], order: [], pos: -1,
  shuffle: SHUFFLE_OFF, repeat: REPEAT_OFF,
  scanning: false, rescanQueued: false,
  source: "local", // "local" library or "sc" (SoundCloud)
  // Soulseek through slskd: connection status, recent searches and slskd's download list
  slsk: { status: null, searches: [], current: null, filter: "", transfers: [], uploads: [], connecting: false, error: "", collapsed: new Set(), extraFiles: [] },
  sc: {
    playlists: [],
    liked: new Set(),  // urns of liked tracks, known once Likes has loaded
    tracks: new Map(), // list key ("likes", "search", "pl:<urn>") -> tracks
    current: "likes",  // list shown in the song table
    searchQuery: "",   // last SoundCloud-wide search
    filter: "",        // search box text, filtering the shown list
    loaded: false, loadingKey: null, error: "",
  },
};

// iPhone: songs play natively (plugins/media-controls), not in the web view. The web view's own
// player gets iOS's "skip 10 seconds" lock screen controls that fight with everything else, and it
// can't start the next song while the app is in the background. NativePlayer stands in for an
// <audio> element, so the rest of the app doesn't need to know: it hands the native player the
// current song and the ones after it, and turns its reports back into the usual media events.
const onIPhone = /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Mac/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
const nativeCall = (cmd, args) => window.__TAURI__.core.invoke(`plugin:media-controls|${cmd}`, args);
class NativePlayer extends EventTarget {
  constructor(inert = false) {
    super();
    this.inert = inert; // the second player: never used, as songs follow each other natively
    this._path = null;
    this._paused = true;
    this._pos = 0;
    this._at = performance.now();
    this._dur = NaN;
    this._vol = 1;
    this._muted = false;
    this._rate = 1;
    this.error = null;
    this.preload = "auto";
    this.preservesPitch = true;
  }
  get paused() { return this._paused; }
  get duration() { return this._dur; }
  get readyState() { return this._path && isFinite(this._dur) ? 4 : 0; }
  get currentTime() {
    return this._paused ? this._pos : Math.min(this._pos + ((performance.now() - this._at) / 1000) * this._rate, isFinite(this._dur) ? this._dur : Infinity);
  }
  set currentTime(v) {
    this._pos = Math.max(0, v);
    this._at = performance.now();
    if (this.inert || !this._path) return;
    nativeCall("seek", { position: this._pos }).catch(() => {});
    this.dispatchEvent(new Event("seeked"));
    this.dispatchEvent(new Event("timeupdate"));
  }
  get volume() { return this._vol; }
  set volume(v) {
    this._vol = v;
    if (!this.inert) nativeCall("set_volume", { volume: this._muted ? 0 : v }).catch(() => {});
    this.dispatchEvent(new Event("volumechange"));
  }
  get muted() { return this._muted; }
  set muted(m) {
    this._muted = m;
    this.volume = this._vol;
  }
  get playbackRate() { return this._rate; }
  set playbackRate(r) {
    this._rate = r;
    if (!this.inert) nativeCall("set_rate", { rate: r }).catch(() => {});
    this.dispatchEvent(new Event("ratechange"));
  }
  get defaultPlaybackRate() { return this._rate; }
  set defaultPlaybackRate(r) { this.playbackRate = r; }
  /** A song file to play (not a URL). */
  setPath(path) {
    if (path === this._path) return;
    this._path = path;
    this._pos = 0;
    this._dur = NaN;
    this.error = null;
    if (!this.inert) nativeSync({ play: !this._paused });
  }
  getAttribute(name) { return name === "src" ? this._path : null; }
  removeAttribute(name) {
    if (name !== "src" || !this._path) return;
    this._path = null;
    this._pos = 0;
    if (!this.inert) nativeCall("stop").catch(() => {});
  }
  load() {}
  play() {
    if (this.inert || !this._path) return Promise.resolve();
    if (this._paused) {
      this._paused = false;
      this._at = performance.now();
      this.dispatchEvent(new Event("play"));
    }
    return nativeSync({ play: true });
  }
  pause() {
    if (this.inert || this._paused) return;
    this._pos = this.currentTime;
    this._paused = true;
    nativeCall("pause").catch(() => {});
    this.dispatchEvent(new Event("pause"));
  }
  /** A report from the native player. */
  report(s) {
    const wasPaused = this._paused, hadDur = isFinite(this._dur);
    this._pos = s.position;
    this._at = performance.now();
    if (s.duration > 0) this._dur = s.duration;
    if (s.error && s.path === this._path && !this.error) {
      this.error = { message: s.error };
      this.dispatchEvent(new Event("error"));
    }
    if (!hadDur && isFinite(this._dur)) this.dispatchEvent(new Event("loadedmetadata"));
    if (s.ended) {
      this._paused = true;
      this.dispatchEvent(new Event("pause"));
      this.dispatchEvent(new Event("ended"));
      return;
    }
    this._paused = !s.playing;
    if (wasPaused && s.playing) this.dispatchEvent(new Event("play"));
    if (!wasPaused && !s.playing) this.dispatchEvent(new Event("pause"));
    this.dispatchEvent(new Event("timeupdate"));
  }
}
const nativeWin = { start: 0, paths: [] }; // which songs of the queue the native player has
/** Hand the native player the current song and the ones after it (and a few before, for
 * Previous). `play` starts or stops it; left out, it keeps doing what it's doing. */
function nativeSync({ play } = {}) {
  const p = players[0];
  if (!p._path) return Promise.resolve();
  const order = state.order, here = state.pos;
  const at = (i) => state.queue[order[i]];
  // the current song as loaded (a SoundCloud song's downloaded file); others only when they're
  // library songs, as SoundCloud ones are downloaded when it's their turn
  let start = here;
  while (start > 0 && here - start < 10 && at(start - 1) && !at(start - 1).sc) start--;
  const item = (t, path) => ({ path, title: t?.title || "", artist: t?.artist || "", album: t?.album || "", artwork: t && !t.sc ? t.cover || t.thumb || null : null, duration: t?.duration || 0 });
  const items = [];
  for (let i = start; i < here; i++) items.push(item(at(i), at(i).path));
  items.push(item(current(), p._path));
  for (let i = here + 1; i < order.length && i <= here + 60 && at(i) && !at(i).sc; i++) items.push(item(at(i), at(i).path));
  nativeWin.start = start;
  nativeWin.paths = items.map((x) => x.path);
  return nativeCall("set_queue", { items, index: here - start, position: p._pos || 0, play, repeatOne: state.repeat === REPEAT_ONE }).catch((e) => {
    p.error = { message: String(e) };
    p.dispatchEvent(new Event("error"));
  });
}
let nativeResync = 0;
/** The queue changed (a song added, shuffle switched…): tell the native player, in a moment. */
function nativeQueueChanged() {
  if (!onIPhone) return;
  clearTimeout(nativeResync);
  nativeResync = setTimeout(() => nativeSync(), 300);
}
if (onIPhone) {
  window.__TAURI__.core.addPluginListener?.("media-controls", "state", (s) => {
    const p = players[0];
    // the native player went on to another song by itself: at the end of one, or from the lock screen
    if (s.path && p._path && s.path !== p._path && nativeWin.paths[s.index] === s.path) {
      const pos = nativeWin.start + s.index;
      if (state.queue[state.order[pos]]?.path === s.path) {
        p._path = s.path; // already playing there: don't load it again
        p._dur = NaN;
        state.pos = pos;
        if (state.shuffle === SHUFFLE_RANDOM) fillRandom();
        playCurrent(s.playing);
      }
    }
    if (s.path === p._path || !s.path) p.report(s);
  })?.catch?.(() => {});
}

// Two players: the song that's playing, and the next one loading in the other, so it can start
// without a gap or fade in over the end of this one. `audio` is whichever is playing.
const players = onIPhone ? [new NativePlayer(), new NativePlayer(true)] : [new Audio(), new Audio()];
for (const p of players) p.preload = "auto";
let audio = players[0];
const spare = () => (audio === players[0] ? players[1] : players[0]);
/** Listen to the player that's playing (events from the other one are ignored). */
function onAudio(type, fn) {
  for (const p of players) p.addEventListener(type, (e) => e.target === audio && fn(e));
}
let baseVolume = 0.7; // the volume slider's value; fades move audio.volume around it
/** "Normalize volume": how far this song is turned down (1 = not at all). */
let trackGain = 1;
const vol = () => baseVolume * trackGain;

// ------------------------------------------------------------- preferences

const ACCENTS = ["#8b7cff", "#5b8cff", "#2fb7c4", "#3fbf7f", "#e2b33c", "#f0864a", "#ef5a6f", "#e06ad0"];
const DEFAULT_PREFS = {
  accent: ACCENTS[0], blur: true, tint: 0.55, coverSize: "medium", scale: "1", compact: false,
  showCounts: true, onTop: false, theme: "dark",
  animations: true, speed: "1", ambient: true, equalizer: true, hoverLift: true, waveform: true,
  waveHeight: 34, waveStyle: "bars", waveBars: 240, coverColors: true, coverTint: true,
  appIcon: "yuuri", scView: "list", onboarded: false, checkUpdates: true, skipVersion: "",
  ignoreThe: true, scanOnStart: true,
  crossfade: 0, normalize: false, eq: false, eqPreset: "flat", eqCustom: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  keys: {}, smartLists: [], renamePattern: "", closeToTray: false, trayHintShown: false, visualizer: "off", keepPitch: true,
  singleClick: false, fade: true, rememberModes: false, shuffle: SHUFFLE_OFF, repeat: REPEAT_OFF, resume: true,
};
const COVER_SIZES = { small: "120px", medium: "156px", large: "200px" };
let prefs = { ...DEFAULT_PREFS };

const appWindow = window.__TAURI__.window.getCurrentWindow();
// iPads say they're Macs; only a touch screen tells them apart
const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Mac/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
const android = /Android/.test(navigator.userAgent);
/** iPhones, iPads and Android: touch screens, the app's own music folder, no windows. */
const phone = ios || android;
const platform = ios ? "ios" : android ? "android" : /Mac/.test(navigator.userAgent) ? "mac" : /Linux/.test(navigator.userAgent) ? "linux" : "windows";
document.body.classList.add(platform);
document.documentElement.classList.add(platform);
if (phone) {
  document.body.classList.add("phone");
  document.documentElement.classList.add("phone");
}
// The iPhone Duo's screens are nearly square, both folded and open; other iPhones are about 2:1
const duo = /iPhone/.test(navigator.userAgent) && Math.max(screen.width, screen.height) / Math.min(screen.width, screen.height) < 1.7;
document.body.classList.toggle("duo", duo);
/** Touch screens play a song on the first tap; there's no double-click there. */
const tapPlays = () => prefs.singleClick || phone;
/** iOS doesn't let pages change the volume, so there's nothing to fade. */
const fades = () => prefs.fade && !ios;

// ------------------------------------------------------------------ helpers

const artistKey = (t) => t.albumArtist.toLowerCase();
const FAV_KEY = ":fav"; // the "Favourites" entry in the artist list
const PL_PREFIX = ":pl:"; // playlists in the artist list: ":pl:<id>"
const playlistOf = (key) => (key?.startsWith(PL_PREFIX) ? state.playlists.find((p) => PL_PREFIX + p.id === key) : null);
const SMART_PREFIX = ":smart:"; // smart lists: ":smart:<id>"
/** Favourites, playlists and smart lists: lists of songs rather than an artist. */
const specialList = (key) => key === FAV_KEY || !!playlistOf(key) || !!smartOf(key);
const plSets = new Map(); // playlist id -> Set of its song paths
function plSet(p) {
  if (!plSets.has(p.id)) plSets.set(p.id, new Set(p.songs));
  return plSets.get(p.id);
}
const inArtist = (t) =>
  state.artist === null ||
  (state.artist === FAV_KEY ? state.favorites.has(t.path)
    : state.artist.startsWith(PL_PREFIX) ? !!playlistOf(state.artist) && plSet(playlistOf(state.artist)).has(t.path)
    : state.artist.startsWith(SMART_PREFIX) ? smartSet(state.artist).has(t.path)
    : artistKey(t) === state.artist);

// Smart lists, made from how often and when songs were played (see record_play in lib.rs)
const plays = (t) => state.stats?.[t.path]?.plays || 0;
const lastPlayed = (t) => state.stats?.[t.path]?.last || 0;
const SMART = [
  { id: "added", name: "Recently added", list: (ts) => [...ts].sort((a, b) => b.mtime - a.mtime).slice(0, 100) },
  { id: "most", name: "Most played", list: (ts) => ts.filter(plays).sort((a, b) => plays(b) - plays(a) || lastPlayed(b) - lastPlayed(a)).slice(0, 100) },
  { id: "recent", name: "Recently played", list: (ts) => ts.filter(lastPlayed).sort((a, b) => lastPlayed(b) - lastPlayed(a)).slice(0, 100) },
  { id: "never", name: "Never played", list: (ts) => ts.filter((t) => !plays(t)).sort(cmpTracks) },
  { id: "forgotten", name: "Forgotten favourites", list: (ts) => ts.filter((t) => state.favorites.has(t.path) && Date.now() / 1000 - lastPlayed(t) > 60 * 86400).sort(cmpTracks) },
];
/** The built-in smart lists and the user's own (prefs.smartLists: a name and a search). */
function allSmart() {
  return [...SMART, ...(prefs.smartLists || []).map((c) => ({ ...c, custom: true, list: (ts) => {
    const m = trackMatcher(c.query.toLowerCase());
    return (m ? ts.filter(m) : []).sort(cmpTracks);
  } }))];
}
const smartOf = (key) => (key?.startsWith(SMART_PREFIX) ? allSmart().find((x) => SMART_PREFIX + x.id === key) : null);
const rating = (t) => state.stats?.[t.path]?.rating || 0;

// ------------------------------------------------------------- search syntax
// Besides plain words, the search box takes filters: artist:, album:, title:, genre:, folder:,
// year:1998 (or 1990-1999), plays>10, rating>=4, length<3:00, added<30 (days ago), played<7,
// fav:yes, format:flac (or just flac). "Quotes" keep words together; a leading - excludes.

const FIELDS = {
  artist: "artist", by: "artist", album: "album", title: "title", song: "title", genre: "genre", folder: "folder", path: "folder",
  year: "year", plays: "plays", played: "played", rating: "rating", stars: "rating", length: "length", time: "length",
  added: "added", fav: "fav", favourite: "fav", favorite: "fav", format: "format", ext: "format", type: "format",
};
const unquote = (s) => s.replace(/^"(.*)"$/, "$1");
function parseQuery(q) {
  return (q.match(/-?[a-z]+(?::|[<>]=?|=)"[^"]*"?|-?"[^"]*"?|\S+/gi) || []).map((part) => {
    const neg = part.length > 1 && part.startsWith("-");
    if (neg) part = part.slice(1);
    const m = part.match(/^([a-z]+)(:|[<>]=?|=)(.*)$/i);
    if (m && FIELDS[m[1].toLowerCase()]) return { neg, field: FIELDS[m[1].toLowerCase()], op: m[2], value: unquote(m[3]).replace(/"/g, "").toLowerCase() };
    return { neg, word: unquote(part).replace(/"/g, "").toLowerCase() };
  }).filter((x) => (x.word ?? x.value) !== "");
}
/** "3:30" → 210 for lengths; otherwise a plain number. */
const queryNumber = (v) => (/^\d+:\d{1,2}$/.test(v) ? Number(v.split(":")[0]) * 60 + Number(v.split(":")[1]) : parseFloat(v));
function compareNum(x, op, v) {
  const range = op === ":" && v.match(/^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/);
  if (range) return x >= Number(range[1]) && x <= Number(range[2]);
  const n = queryNumber(v);
  if (isNaN(n)) return false;
  return op === ">" ? x > n : op === ">=" ? x >= n : op === "<" ? x < n : op === "<=" ? x <= n : Math.round(x) === n;
}
const fileFormat = (t) => (t.path.match(/\.([a-z0-9]+)$/i)?.[1] || "").toLowerCase();
function termMatches(term, t) {
  if (term.word != null) {
    return [t.title, t.artist, t.albumArtist, t.album, t.genre || ""].some((s) => s.toLowerCase().includes(term.word)) || fileFormat(t) === term.word;
  }
  const v = term.value, num = (x) => compareNum(x, term.op, v), now = Date.now() / 1000;
  switch (term.field) {
    case "artist": return `${t.artist}\n${t.albumArtist}`.toLowerCase().includes(v);
    case "album": return t.album.toLowerCase().includes(v);
    case "title": return t.title.toLowerCase().includes(v);
    case "genre": return (t.genre || "").toLowerCase().includes(v);
    case "folder": return t.path.toLowerCase().includes(v);
    case "format": return fileFormat(t) === v.replace(/^\./, "");
    case "fav": return state.favorites.has(t.path) === !/^(no|false|0|n)$/.test(v);
    case "year": return num(parseInt(t.year) || 0);
    case "plays": return num(plays(t));
    case "rating": return num(rating(t));
    case "length": return num(t.duration || 0);
    case "added": return num((now - t.mtime) / 86400);
    case "played": return lastPlayed(t) ? num((now - lastPlayed(t)) / 86400) : /^(no|never|false|0)$/.test(v) && term.op === ":";
  }
  return false;
}
/** A test for songs matching a search, or null for an empty one. */
function trackMatcher(q) {
  const terms = parseQuery(q);
  return terms.length ? (t) => terms.every((term) => term.neg !== termMatches(term, t)) : null;
}
const smartLists = new Map(); // key -> songs, for the current search; cleared on every redraw
function smartList(key) {
  if (!smartLists.has(key)) smartLists.set(key, smartOf(key)?.list(state.visible) || []);
  return smartLists.get(key);
}
const smartSets = new Map();
function smartSet(key) {
  if (!smartSets.has(key)) smartSets.set(key, new Set(smartList(key).map((t) => t.path)));
  return smartSets.get(key);
}
/** Favourite (library) or liked (SoundCloud). */
const isFav = (t) => (t.sc ? state.sc.liked.has(t.urn) : state.favorites.has(t.path));
const albumKey = (t) => artistKey(t) + "\0" + t.album.toLowerCase();

function sortName(name) {
  const s = name.toLowerCase().trim();
  return prefs.ignoreThe && s.startsWith("the ") ? s.slice(4) : s;
}
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const cmpName = (a, b) =>
  (a === UNKNOWN_ARTIST) - (b === UNKNOWN_ARTIST) || collator.compare(sortName(a), sortName(b));
const cmpYear = (a, b) => (a || "9999").localeCompare(b || "9999");

function fmtTime(sec) {
  sec = Math.floor(sec || 0);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

/** Something the webview can load: web and data: URLs as they are, local files through the asset protocol. */
const mediaSrc = (p) => (/^(https?:\/\/|data:)/.test(p) ? p : convertFileSrc(p));

/**
 * A small version of a song's cover for grids and lists: the library's cached thumbnail, or a
 * smaller size of SoundCloud artwork. Full-size covers decoded by the hundred make grids lag.
 */
function thumbOf(t, px = 300) {
  if (t.thumb) return t.thumb;
  const size = px <= 100 ? "large" : "t300x300";
  return /^https?:/.test(t.cover || "") ? t.cover.replace("-t500x500.", `-${size}.`) : t.cover;
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function hue(name) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return h % 360;
}

/** Cover art, or a gradient tile coloured from the album name. */
function coverHtml(cover, name) {
  const h = hue(name);
  const bg = `background:linear-gradient(135deg,hsl(${h} 35% 42%),hsl(${(h + 40) % 360} 45% 22%))`;
  const img = cover ? `<img src="${esc(mediaSrc(cover))}" loading="lazy" decoding="async" alt="" onerror="this.remove()">` : "";
  return `<div class="cover" style="${bg}"><svg viewBox="0 0 24 24"><use href="#i-note"/></svg>${img}</div>`;
}

let statusTimer;
function setStatus(text, ms = 0) {
  clearTimeout(statusTimer);
  el.status.textContent = text;
  if (ms) statusTimer = setTimeout(() => (el.status.textContent = ""), ms);
}

function setRangeFill(input) {
  const min = Number(input.min) || 0, max = Number(input.max) || 0;
  input.style.setProperty("--p", max > min ? `${((input.value - min) / (max - min)) * 100}%` : "0%");
}

/** Scroll only `container` so `child` is visible. scrollIntoView would also shift the whole window. */
function reveal(container, child, center = false) {
  if (!container || !child) return;
  const c = container.getBoundingClientRect(), r = child.getBoundingClientRect();
  if (center) {
    container.scrollTop += r.top - c.top - (c.height - r.height) / 2;
  } else if (r.top < c.top + 32) { // leave room for the sticky table header
    container.scrollTop -= c.top + 32 - r.top;
  } else if (r.bottom > c.bottom) {
    container.scrollTop += r.bottom - c.bottom;
  }
}

// ------------------------------------------------------------------ library

async function load() {
  const snap = await invoke("get_library");
  state.settings = snap.settings;
  state.tracks = snap.tracks;
  state.favorites = new Set(snap.settings.favorites || []);
  state.playlists = snap.settings.playlists || [];
  state.stats = (await invoke("get_stats").catch(() => null)) || {};
  const linuxDefaults = platform === "linux" ? { blur: false, tint: 0.96 } : {}; // no compositor blur there
  prefs = { ...DEFAULT_PREFS, ...linuxDefaults, ...(snap.settings.ui || {}) };
  applyPrefs();
  if (prefs.rememberModes) {
    setShuffle(shuffleMode(prefs.shuffle));
    setRepeat(prefs.repeat);
  }
  baseVolume = state.settings.volume;
  audio.volume = vol();
  el.volume.value = baseVolume;
  setRangeFill(el.volume);
  el.preferTags.checked = state.settings.preferTags;
  renderFolders();
  applySearch();
  if (prefs.resume) restoreSession();
  sessionReady = true;
  if (state.settings.soulseek?.autoConnect && slskConfigured()) slskConnect();
  discordSync();
  // libraries scanned before grid thumbnails existed get them on this scan
  const needThumbs = state.tracks.some((t) => t.cover && !t.thumb);
  await refreshAutoFolders();
  const hasFolders = state.settings.folders.length || state.autoFolders.length;
  if (hasFolders && (prefs.scanOnStart || !state.tracks.length || needThumbs)) rescan(false);
  if (prefs.checkUpdates) checkForUpdate();
  // first start: walk through setting things up
  if (!phone && !prefs.onboarded && !state.settings.folders.length && !state.tracks.length) openOnboarding();
}

/** `quiet`: a check in the background, which only speaks up (and redraws) when something changed. */
// a song was added to, changed in or taken out of a library folder (watch.rs): pick it up
listen("library-changed", () => state.tracks && rescan(false, true));

async function rescan(full, quiet = false) {
  if (state.scanning) {
    state.rescanQueued = true;
    return;
  }
  state.scanning = true;
  quietScan = quiet;
  if (!quiet) setStatus("Scanning…");
  try {
    const tracks = await invoke("scan", { full });
    const changed = !quiet || JSON.stringify(tracks) !== JSON.stringify(state.tracks);
    state.tracks = tracks;
    if (changed) {
      applySearch();
      setStatus(summary(), 4000);
    }
  } catch (e) {
    if (!quiet) setStatus(`Scan failed: ${e}`, 6000);
  } finally {
    state.scanning = false;
    quietScan = false;
  }
  if (state.rescanQueued) {
    state.rescanQueued = false;
    rescan(false);
  }
}

let quietScan = false;

function summary() {
  const artists = new Set(state.tracks.map(artistKey)).size;
  const albums = new Set(state.tracks.map(albumKey)).size;
  return `${artists} artists · ${albums} albums · ${state.tracks.length} songs`;
}

async function addFolder() {
  const settings = await invoke("add_folder");
  if (!settings) return;
  state.settings = settings;
  renderFolders();
  applySearch();
  rescan(false);
}

async function removeFolder(folder) {
  const snap = await invoke("remove_folder", { folder });
  state.settings = snap.settings;
  state.tracks = snap.tracks;
  renderFolders();
  applySearch();
  if (state.autoFolders.length) rescan(false);
}

function renderFolders() {
  const folders = state.settings.folders;
  const auto = state.autoFolders.filter((a) => !folders.some((f) => a.path.toLowerCase().startsWith(f.toLowerCase())));
  el.folderList.innerHTML =
    folders.map((f, i) => `<li><span title="${esc(f)}">${esc(f)}</span><button data-i="${i}" title="Remove from library">Remove</button></li>`).join("") +
    auto.map((a) => `<li class="auto"><span title="${esc(a.path)}">${esc(a.path)}</span><em>${esc(a.label)} · automatic</em></li>`).join("") ||
    `<li class="none">No folders yet</li>`;
  renderLocalHint();
  $("ob-folders").innerHTML = el.folderList.innerHTML;
}

/** The download folders that are always in the library (once they exist). */
async function refreshAutoFolders() {
  try {
    const r = await invoke("library_auto_folders");
    state.autoFolders = r.auto;
    state.settings.folders = r.folders;
  } catch {
    state.autoFolders = [];
  }
  renderFolders();
}

/** Offer to add a folder while the library only has downloads in it. */
function renderLocalHint() {
  $("local-hint").hidden = !!state.settings.folders.length || !state.tracks.length || !!prefs.hideLocalHint || state.source !== "local";
}
$("local-hint-add").addEventListener("click", addFolder);
$("local-hint-close").addEventListener("click", () => {
  setPref("hideLocalHint", true);
  renderLocalHint();
});

// -------------------------------------------------------------- rendering

function applySearch() {
  const match = trackMatcher(state.query);
  state.visible = match ? state.tracks.filter(match) : state.tracks;
  if (state.source !== "local") return; // the SoundCloud view owns the panels
  const hasLibrary = state.tracks.length || state.settings.folders.length;
  el.empty.hidden = !!hasLibrary;
  el.library.hidden = !hasLibrary;
  renderLocalHint();
  renderArtists();
}

function renderArtists() {
  smartLists.clear();
  smartSets.clear();
  const artists = new Map(); // key -> { name, albums }
  for (const t of state.visible) {
    const k = artistKey(t);
    if (!artists.has(k)) artists.set(k, { name: t.albumArtist, albums: new Set() });
    artists.get(k).albums.add(albumKey(t));
  }
  const favCount = state.visible.filter((t) => state.favorites.has(t.path)).length;
  if (state.artist === FAV_KEY ? !favCount : state.artist !== null && !artists.has(state.artist) && !playlistOf(state.artist) && !smartOf(state.artist)) state.artist = null;
  const keys = [...artists.keys()].sort((a, b) => cmpName(artists.get(a).name, artists.get(b).name));

  let n = 0;
  const item = (key, name, count) =>
    `<li data-key="${esc(key ?? "")}" class="${key === state.artist ? "sel" : ""}" title="${esc(name)}" style="--i:${n++}">` +
    `<span class="count">${count}</span>${esc(name)}</li>`;
  const group = (name) => `<li class="group" style="--i:${n++}">${esc(name)}</li>`;
  const lists = state.playlists.map((p) => item(PL_PREFIX + p.id, p.name, state.visible.filter((t) => plSet(p).has(t.path)).length)).join("");
  el.artistList.innerHTML =
    item(null, "All artists", new Set(state.visible.map(albumKey)).size) +
    (favCount ? item(FAV_KEY, "♥ Favourites", favCount) : "") +
    group("Smart lists") +
    allSmart().map((x) => [x, smartList(SMART_PREFIX + x.id).length]).filter(([x, count]) => count || x.id === "added" || x.custom)
      .map(([x, count]) => item(SMART_PREFIX + x.id, x.name, count)).join("") +
    `<li class="new-playlist" data-new-smart style="--i:${n++}">＋ New smart list</li>` +
    `<li class="new-playlist" data-open-page="stats" style="--i:${n++}">Listening stats</li>` +
    `<li class="new-playlist" data-open-page="dupes" style="--i:${n++}">Find duplicates</li>` +
    `<li class="new-playlist" data-open-page="genres" style="--i:${n++}">Genres</li>` +
    `<li class="new-playlist" data-open-page="folders" style="--i:${n++}">Folders</li>` +
    group("Playlists") + lists + `<li class="new-playlist" data-new-playlist style="--i:${n++}">＋ New playlist</li>` +
    (phone ? "" : `<li class="new-playlist" data-import-m3u style="--i:${n++}">＋ Open an .m3u playlist…</li>`) +
    group("Artists") +
    keys.map((k) => item(k, artists.get(k).name, artists.get(k).albums.size)).join("");
  if (state.artist === null) el.artistList.firstElementChild?.classList.add("sel");
  el.artistsTitle.textContent = `Artists · ${keys.length}`;
  renderAlbums();
}

function renderAlbums() {
  const groups = new Map();
  for (const t of state.visible) {
    if (!inArtist(t)) continue;
    const k = albumKey(t);
    let g = groups.get(k);
    if (!g) groups.set(k, (g = { album: t.album, artist: t.albumArtist, year: t.year, cover: thumbOf(t), count: 0 }));
    g.count++;
    g.year ||= t.year;
    g.cover ||= thumbOf(t);
  }
  if (state.album !== null && !groups.has(state.album)) state.album = null;

  const oneArtist = state.artist !== null && !specialList(state.artist);
  const keys = [...groups.keys()].sort((a, b) => {
    const x = groups.get(a), y = groups.get(b);
    return (!oneArtist ? cmpName(x.artist, y.artist) : 0) ||
      cmpYear(x.year, y.year) || collator.compare(sortName(x.album), sortName(y.album));
  });

  // Cards refer to albums by index: album keys contain "\0", which HTML attributes can't hold.
  state.albumKeys = keys;
  el.albumGrid.innerHTML = keys.length
    ? keys.map((k, i) => {
        const g = groups.get(k);
        const sub = !oneArtist ? g.artist : g.year || `${g.count} song${g.count === 1 ? "" : "s"}`;
        const tip = `${g.album}\n${g.artist}${g.year ? " · " + g.year : ""} · ${g.count} song${g.count === 1 ? "" : "s"}`;
        return `<div class="album${k === state.album ? " sel" : ""}" data-i="${i}" title="${esc(tip)}" style="--i:${i}">` +
          `${coverHtml(g.cover, g.album)}<div class="name">${esc(g.album)}</div><div class="sub">${esc(sub)}</div></div>`;
      }).join("")
    : `<div class="empty-note">${state.query ? "No matches." : "No albums yet."}</div>`;
  el.albumsTitle.textContent = `Albums · ${keys.length}`;
  renderSongs();
}

/** Library order: artist, album (by year), disc, track. */
const cmpTracks = (a, b) =>
  cmpName(a.albumArtist, b.albumArtist) || cmpYear(a.year, b.year) ||
  collator.compare(sortName(a.album), sortName(b.album)) ||
  a.discNo - b.discNo || a.trackNo - b.trackNo || collator.compare(a.title, b.title);

function renderSongs() {
  const tracks = state.visible.filter((t) =>
    inArtist(t) &&
    (state.album === null || albumKey(t) === state.album));
  const pl = state.album === null ? playlistOf(state.artist) : null;
  const smart = state.album === null ? smartOf(state.artist) : null;
  if (pl || smart) {
    // playlists and smart lists play in their own order
    const order = pl ? pl.songs : smartList(state.artist).map((t) => t.path);
    const at = new Map(order.map((p, i) => [p, i]));
    tracks.sort((a, b) => at.get(a.path) - at.get(b.path));
  } else {
    tracks.sort(cmpTracks);
  }
  const multiDisc = state.album !== null && new Set(tracks.map((t) => t.discNo)).size > 1;
  // phones leave out the artist column when it would say the same thing on every row
  el.songTable.classList.toggle("one-artist", state.artist !== null && !specialList(state.artist));
  fillSongs(tracks, { multiDisc, hideAlbum: state.album !== null, title: pl?.name || smart?.name || "Songs", numbered: !!(pl || smart) });
}

/** Put `tracks` in the song table. Shared by the library and SoundCloud views. */
function fillSongs(tracks, { multiDisc = false, hideAlbum = false, title = "Songs", numbered = false } = {}) {
  songTable.numbered = numbered;
  state.shown = tracks;
  state.selected = -1;
  const playing = current()?.path;
  songTable.multiDisc = multiDisc;
  tableWrap().scrollTop = 0;
  renderSongRows(true);
  el.songTable.classList.toggle("no-album", hideAlbum);
  renderSongGrid(tracks, playing);
  // every song in Likes or Favourites has a heart, so they'd only add clutter there
  const allFav = state.source === "sc" ? state.sc.current === "likes" : state.artist === FAV_KEY;
  el.songBody.closest(".panel").classList.toggle("all-fav", allFav);
  const total = tracks.reduce((s, t) => s + t.duration, 0);
  el.songsTitle.textContent = `${title} · ${tracks.length} · ${fmtTime(total)}`;
  saveSession();
}

const EQ_HTML = '<span class="eq"><i></i><i></i><i></i></span>';

// The song table only holds the rows in view plus a margin, with spacer rows standing in for
// the rest. Thousands of real rows made every click, search and scroll in the window slow.
const songTable = { rowH: 0, start: 0, end: 0, multiDisc: false, numbered: false };
const ROW_MARGIN = 24; // rows drawn above and below the visible ones
const ROW_STEP = 16; // redraw only after scrolling this many rows
const tableWrap = () => el.songBody.closest(".table-wrap");

function songRowHtml(t, i, playing) {
  if (t.group) return slskGroupHtml(t, i);
  const num = t.slsk ? t.num : t.sc || songTable.numbered ? i + 1 : songTable.multiDisc ? `${t.discNo}-${t.trackNo}` : t.trackNo || "";
  const isPlaying = t.path === playing;
  const cls = [isPlaying && "playing", i === state.selected && "sel", t.access === "blocked" && "unplayable", isFav(t) && "fav"].filter(Boolean).join(" ");
  const badge = t.access === "preview" ? '<span class="badge" title="SoundCloud only allows a 30-second preview">PREVIEW</span>'
    : t.badge ? `<span class="badge">${esc(t.badge)}</span>` : "";
  return `<tr data-i="${i}" data-num="${num}"${cls ? ` class="${cls}"` : ""} title="${esc(t.tip || (t.sc ? t.permalinkUrl : t.path))}"${i < 40 ? ` style="--i:${i}"` : ""}>` +
    `<td class="num">${isPlaying && prefs.equalizer ? EQ_HTML : num}</td><td>${esc(t.title)}<svg class="heart"><use href="#i-heart" /></svg>${badge}</td><td>${esc(t.artist)}</td>` +
    `<td class="col-album">${esc(t.album)}</td><td class="time">${fmtTime(t.duration)}</td></tr>`;
}

const spacerRow = (px) => (px > 0 ? `<tr class="spacer"><td colspan="5" style="height:${px}px"></td></tr>` : "");

/** Draw the rows around the scroll position. `fresh` means a new list, which animates in. */
function renderSongRows(fresh = false) {
  const tracks = state.shown, wrap = tableWrap();
  const h = songTable.rowH || 32;
  const top = Math.max(0, wrap.scrollTop - (el.songTable.tHead?.offsetHeight || 0));
  const first = Math.floor(top / h);
  const start = Math.max(0, Math.floor((first - ROW_MARGIN) / ROW_STEP) * ROW_STEP);
  const last = first + Math.ceil((wrap.clientHeight || 900) / h) + ROW_MARGIN;
  const end = Math.min(tracks.length, Math.ceil(last / ROW_STEP) * ROW_STEP);
  if (!fresh && start === songTable.start && end === songTable.end) return;
  Object.assign(songTable, { start, end });
  const playing = current()?.path;
  let html = spacerRow(start * h);
  for (let i = start; i < end; i++) html += songRowHtml(tracks[i], i, playing);
  el.songBody.innerHTML = html + spacerRow((tracks.length - end) * h);
  el.songBody.classList.toggle("still", !fresh);

  // measure the real row height (it changes with compact mode) and redraw if the guess was off
  const rows = el.songBody.querySelectorAll("tr[data-i]");
  if (rows.length > 1) {
    const real = (rows[rows.length - 1].getBoundingClientRect().bottom - rows[0].getBoundingClientRect().top) / rows.length;
    if (real > 0 && Math.abs(real - songTable.rowH) > 0.25) {
      songTable.rowH = real;
      renderSongRows(fresh);
    }
  }
}

tableWrap().addEventListener("scroll", () => renderSongRows(), { passive: true });
new ResizeObserver(() => renderSongRows()).observe(tableWrap());

/** Scroll the song table or covers so song `i` sits in the middle, and return its row or card. */
function revealSong(i) {
  if (gridShown()) {
    const card = el.songGrid.children[i];
    reveal(el.songGrid, card, true);
    return card;
  }
  const wrap = tableWrap(), h = songTable.rowH || 32;
  wrap.scrollTop = (el.songTable.tHead?.offsetHeight || 0) + i * h - (wrap.clientHeight - h) / 2;
  renderSongRows();
  return el.songBody.querySelector(`tr[data-i="${i}"]`);
}

const gridShown = () => state.source === "sc" && prefs.scView === "grid";

/** The SoundCloud covers view: the same songs as the table, as cover cards. */
function renderSongGrid(tracks, playing) {
  if (!gridShown()) {
    el.songGrid.innerHTML = "";
    return;
  }
  el.songGrid.innerHTML = tracks.map((t, i) => {
    const cls = ["album", t.path === playing && "playing", t.access === "blocked" && "unplayable", isFav(t) && "fav"].filter(Boolean).join(" ");
    const sub = t.access === "preview" ? `<span class="badge">PREVIEW</span> ${esc(t.artist)}` : esc(t.artist);
    return `<div class="${cls}" data-i="${i}" title="${esc(`${t.title}\n${t.artist} · ${fmtTime(t.duration)}`)}" style="--i:${i}">` +
      `${coverHtml(thumbOf(t), t.title)}<div class="name"><svg class="heart"><use href="#i-heart" /></svg>${esc(t.title)}</div><div class="sub">${sub}</div></div>`;
  }).join("");
}

function highlightPlaying() {
  const path = current()?.path;
  for (const row of el.songBody.querySelectorAll("tr[data-i]")) {
    const playing = state.shown[row.dataset.i]?.path === path;
    const wasPlaying = row.classList.contains("playing");
    row.classList.toggle("playing", playing);
    if (playing || wasPlaying) row.cells[0].innerHTML = playing && prefs.equalizer ? EQ_HTML : row.dataset.num;
  }
  for (const card of el.songGrid.children) card.classList.toggle("playing", state.shown[card.dataset.i]?.path === path);
}

function selectRow(i) {
  el.songBody.querySelector("tr.sel")?.classList.remove("sel");
  state.selected = i;
  const row = el.songBody.querySelector(`tr[data-i="${i}"]`) || (!gridShown() && revealSong(i));
  if (row) {
    row.classList.add("sel");
    reveal(tableWrap(), row);
  }
  el.songGrid.querySelector(".album.sel")?.classList.remove("sel");
  const card = el.songGrid.children[i];
  if (card?.dataset.i) {
    card.classList.add("sel");
    reveal(el.songGrid, card);
  }
}

// ---------------------------------------------------------------- playback

const current = () => (state.pos >= 0 && state.pos < state.order.length ? state.queue[state.order[state.pos]] : null);

function shuffled(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function playShown(index) {
  if (index < 0 || index >= state.shown.length) return;
  const pick = state.shown[index];
  if (pick.group || pick.slsk) {
    slskDownload(pick.group ? pick.all : [pick]); // not on this computer yet: double-click downloads
    return;
  }
  playTracks(state.shown, index);
}

/** Play `tracks` from song `index`, in the current shuffle mode. */
function playTracks(tracks, index, keepRadio = false) {
  if (!keepRadio) radio.on = false;
  state.queue = [...tracks];
  state.order = state.queue.map((_, i) => i);
  if (state.shuffle === SHUFFLE_RANDOM) {
    state.order = [index];
    state.pos = 0;
    fillRandom();
  } else if (state.shuffle) {
    state.order = [index, ...shuffled(state.order.filter((i) => i !== index))];
    state.pos = 0;
  } else {
    state.pos = index;
  }
  playCurrent();
}

// Random mode keeps the songs already played (so Previous goes back through them) and picks the
// next RANDOM_AHEAD songs in advance, so the queue can show what's coming and "Play next" works.
const RANDOM_AHEAD = 25;
const RANDOM_HISTORY = 500;
function fillRandom() {
  const n = state.queue.length;
  if (!n) return;
  if (state.pos > RANDOM_HISTORY) {
    state.order.splice(0, state.pos - RANDOM_HISTORY);
    state.pos = RANDOM_HISTORY;
  }
  while (state.order.length - state.pos - 1 < RANDOM_AHEAD) {
    // any song can come up again, just not the same one twice in a row
    const last = state.order[state.order.length - 1];
    let pick = Math.floor(Math.random() * n);
    if (n > 1 && pick === last) pick = (pick + 1 + Math.floor(Math.random() * (n - 1))) % n;
    state.order.push(pick);
  }
}

function playCurrent(autoplay = true) {
  const t = current();
  if (!t) return;
  if (pre.path === t.path && !spare().error) {
    scLoadId++;
    handOff(autoplay);
  } else {
    xfade.pending = false;
    spare().pause(); // a song still fading out, or one loaded ahead for something else
    pre.path = null;
    trackGain = 1;
    if (t.sc) {
      loadScAudio(t, autoplay);
    } else {
      scLoadId++; // drop a SoundCloud download still on its way
      setSrc(audio, t.path);
      measureGain(t, t.path);
      if (autoplay) startPlayback();
    }
  }
  el.nowTitle.textContent = t.title;
  el.nowArtist.textContent = t.album ? `${t.artist} — ${t.album}` : t.artist;
  el.nowTitle.title = t.title;
  el.nowArtist.title = el.nowArtist.textContent;
  setNowCover(t.cover, t.album);
  el.nowText.classList.remove("changed");
  void el.nowText.offsetWidth; // restart the slide-in animation
  el.nowText.classList.add("changed");
  el.ambient.innerHTML = t.cover ? `<img src="${esc(mediaSrc(t.cover))}" alt="" onerror="this.remove()">` : "";
  document.title = `${t.title} · ${t.artist} — yuuricloud`;
  if (!phone) invoke("tray_tooltip", { text: `${t.title} · ${t.artist}`.slice(0, 120) }).catch(() => {});
  highlightPlaying();
  updateMediaSession(t);
  loadWaveform(t);
  updateAccent();
  $("locate").hidden = false;
  renderNowFav();
  renderQueue();
  renderNowPlaying();
  saveSession();
}

function setNowCover(cover, name) {
  el.nowCover.outerHTML = coverHtml(cover, name).replace('class="cover"', 'id="now-cover" class="cover small"');
  el.nowCover = $("now-cover");
}

/**
 * Ramp audio.volume to `target`; a newer fade or a volume-slider change cancels it.
 *
 * Uses timers rather than requestAnimationFrame: animation frames stop entirely while the window
 * is minimized or covered, which used to leave a song stuck at volume 0 after it faded in.
 */
let fadeId = 0;
function fadeTo(target, ms) {
  const id = ++fadeId;
  if (document.hidden) {
    audio.volume = target; // nobody is watching, and background timers are throttled anyway
    return Promise.resolve(true);
  }
  const from = audio.volume, start = performance.now();
  return new Promise((resolve) => {
    const step = () => {
      if (id !== fadeId) return resolve(false);
      const k = Math.min(1, (performance.now() - start) / ms);
      audio.volume = from + (target - from) * k;
      if (k < 1) setTimeout(step, 16);
      else resolve(true);
    };
    step();
  });
}

// If the window gets hidden mid-fade, finish the fade at once instead of waiting on throttled timers.
document.addEventListener("visibilitychange", () => {
  if (!document.hidden || audio.paused || audio.volume === vol()) return;
  fadeId++;
  if (pausing) {
    pausing = false;
    audio.pause();
  }
  audio.volume = vol();
});

function startPlayback() {
  fadeId++;
  audio.volume = fades() ? 0 : vol();
  audio.play()
    .then(() => fades() && fadeTo(vol(), 300))
    .catch(() => (audio.volume = vol()));
}

let pausing = false;
async function pausePlayback() {
  pausing = true;
  const faded = !fades() || (await fadeTo(0, 180));
  pausing = false;
  if (!faded) return; // cancelled by a play in the meantime
  audio.pause();
  audio.volume = vol();
}

function togglePlay() {
  if (current()) {
    audio.paused ? startPlayback() : pausePlayback();
  } else {
    playShown(Math.max(state.selected, 0));
  }
}

function next(auto = false) {
  if (!state.order.length) return;
  radioTopUp();
  if (auto && state.repeat === REPEAT_ONE) {
    audio.currentTime = 0;
    audio.play().catch(() => {});
    return;
  }
  if (state.pos + 1 < state.order.length) {
    state.pos++;
    if (state.shuffle === SHUFFLE_RANDOM) fillRandom();
  } else if (state.repeat === REPEAT_ALL) {
    if (state.shuffle) shuffled(state.order);
    state.pos = 0;
  } else {
    return; // end of the queue
  }
  playCurrent();
}

function prev() {
  if (!state.order.length) return;
  if (audio.currentTime > 3 || (state.pos === 0 && state.repeat !== REPEAT_ALL)) {
    audio.currentTime = 0;
    return;
  }
  state.pos = state.pos > 0 ? state.pos - 1 : state.order.length - 1;
  playCurrent();
}

/** Off → shuffle → random → off. */
const cycleShuffle = () => setShuffle((state.shuffle + 1) % 3);

function setShuffle(mode) {
  state.shuffle = mode;
  el.shuffle.classList.toggle("on", mode !== SHUFFLE_OFF);
  $("shuffle-icon").setAttribute("href", mode === SHUFFLE_RANDOM ? "#i-random" : "#i-shuffle");
  el.shuffle.title = ["Shuffle: off", "Shuffle: on", "Random: songs can come up again"][mode];
  if (prefs.rememberModes && prefs.shuffle !== mode) setPref("shuffle", mode);
  if (!state.order.length) return;
  const cur = state.order[state.pos];
  if (mode === SHUFFLE_RANDOM) {
    state.order = [cur];
    state.pos = 0;
    fillRandom();
  } else if (mode === SHUFFLE_ON) {
    state.order = [cur, ...shuffled(state.queue.map((_, i) => i).filter((i) => i !== cur))];
    state.pos = 0;
  } else {
    state.order = state.queue.map((_, i) => i);
    state.pos = cur;
  }
  renderQueue();
}

const cycleRepeat = () => setRepeat((state.repeat + 1) % 3);

function setRepeat(mode) {
  state.repeat = mode;
  el.repeat.classList.toggle("on", state.repeat !== REPEAT_OFF);
  el.repeatIcon.setAttribute("href", state.repeat === REPEAT_ONE ? "#i-repeat-one" : "#i-repeat");
  el.repeat.title = `Repeat: ${["off", "all", "one"][state.repeat]}`;
  if (prefs.rememberModes && prefs.repeat !== state.repeat) setPref("repeat", state.repeat);
  nativeQueueChanged();
}

/** OS media keys and the system's now-playing controls (Windows' media overlay, macOS Now
 * Playing, Linux MPRIS, the phone lock screen) where the webview supports them. */
// On the iPhone the web view's own version of these can't show next and previous song, so a small
// native player takes them over instead (plugins/media-controls, NativePlayer above).
const mediaSession = !ios && "mediaSession" in navigator ? navigator.mediaSession : null;
let artFor = null;
function updateMediaSession(t) {
  if (!mediaSession) return;
  const meta = { title: t.title, artist: t.artist, album: t.album };
  mediaSession.metadata = new MediaMetadata({ ...meta, artwork: [] });
  // the system fetches the artwork itself and can't always read app files, so hand it a picture
  const pic = t.thumb || t.cover;
  artFor = t;
  if (pic) {
    coverDataUrl(pic).then((src) => {
      if (artFor === t && src) mediaSession.metadata = new MediaMetadata({ ...meta, artwork: [{ src, sizes: "256x256", type: "image/jpeg" }] });
    });
  }
}
/** A cover as a 256 px JPEG data: URL (null if it can't be loaded). */
function coverDataUrl(pic) {
  return new Promise((done) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      try {
        const c = Object.assign(document.createElement("canvas"), { width: 256, height: 256 });
        c.getContext("2d").drawImage(img, 0, 0, 256, 256);
        done(c.toDataURL("image/jpeg", 0.85));
      } catch {
        done(mediaSrc(pic));
      }
    };
    img.onerror = () => done(null);
    img.src = mediaSrc(pic);
  });
}
function syncMediaPosition() {
  if (!mediaSession?.setPositionState || !isFinite(audio.duration) || !audio.duration) return;
  try {
    mediaSession.setPositionState({ duration: audio.duration, position: Math.min(audio.currentTime, audio.duration), playbackRate: audio.playbackRate || 1 });
  } catch {}
}
if (mediaSession) {
  // Play and pause act on the player at once, without the fade: the system's controls (the lock
  // screen, a headset, the keyboard) expect it to happen while they wait.
  const handlers = {
    play: () => {
      fadeId++;
      audio.volume = vol();
      audio.play().catch(() => {});
    },
    pause: () => {
      fadeId++;
      audio.pause();
      audio.volume = vol();
    },
    stop: () => audio.pause(),
    previoustrack: () => prev(),
    nexttrack: () => next(),
    seekto: (d) => {
      if (isFinite(d.seekTime)) audio.currentTime = d.seekTime;
      syncMediaPosition();
    },
  };
  // On a phone, offering "skip 10 seconds" makes the lock screen show those instead of the
  // previous and next song buttons, so they're only offered on a computer.
  if (!phone) {
    handlers.seekbackward = (d) => seekBy(-(d.seekOffset || 10));
    handlers.seekforward = (d) => seekBy(d.seekOffset || 10);
  }
  for (const [name, fn] of Object.entries(handlers)) {
    try {
      mediaSession.setActionHandler(name, fn);
    } catch {} // not every webview knows every action
  }
  if (phone) {
    for (const name of ["seekbackward", "seekforward"]) {
      try {
        mediaSession.setActionHandler(name, null);
      } catch {}
    }
  }
}

// ------------------------------------------------- gapless, crossfade, volume

/** Load a song file into a player. With the equalizer on, the player must ask for it the way the
 * audio engine is allowed to read it. */
function setSrc(p, file) {
  if (p instanceof NativePlayer) return p.setPath(file);
  if (graph) p.crossOrigin = "anonymous";
  else p.removeAttribute("crossorigin");
  p.src = convertFileSrc(file);
}

/** The song after this one, if one follows by itself. */
function upcoming() {
  if (state.repeat === REPEAT_ONE) return null;
  if (state.pos + 1 < state.order.length) return state.queue[state.order[state.pos + 1]];
  // repeating the list in order starts over; a shuffled one is reshuffled first, so it can't be known
  return state.repeat === REPEAT_ALL && !state.shuffle ? state.queue[state.order[0]] : null;
}

const pre = { path: null, gain: 1 }; // the next song, loaded in the spare player
let preloading = null;
async function preloadNext() {
  // iOS won't let a second player start while the app is in the background, so on the iPhone the
  // next song loads into the same player when it's time
  if (ios) return;
  const n = upcoming();
  if (!n || n.access === "blocked" || pre.path === n.path || preloading === n.path) return;
  preloading = n.path;
  try {
    const file = n.sc ? await invoke("sc_prepare", { urn: n.urn }) : n.path;
    const gain = await gainOf(file);
    if (upcoming()?.path !== n.path || xfade.pending) return; // the queue changed meanwhile
    const p = spare();
    p.pause();
    setSrc(p, file);
    p.load();
    Object.assign(pre, { path: n.path, gain });
  } catch {} finally {
    preloading = null;
  }
}

const crossfadeSecs = () => (ios ? 0 : Math.max(0, Number(prefs.crossfade) || 0));
const xfade = { pending: false };

/** Near the end of a song: load the next one, and start fading into it when crossfading. */
function lookAhead() {
  if (audio.paused || !audio.duration) return;
  const left = audio.duration - audio.currentTime, xf = crossfadeSecs();
  if (left < Math.max(20, xf + 10)) preloadNext();
  if (xf > 0 && left <= xf && !xfade.pending && pre.path && pre.path === upcoming()?.path && spare().readyState >= 2) {
    xfade.pending = true;
    xfade.ms = left * 1000;
    scrob.track = null;
    next(true);
  }
}

/** Switch to the song loaded in the spare player: right away, or fading over the old one. */
function handOff(autoplay) {
  const old = audio;
  audio = spare();
  pre.path = null;
  trackGain = pre.gain;
  setMuted(old.muted);
  showDuration();
  if (xfade.pending) {
    xfade.pending = false;
    fadeOut(old, xfade.ms);
    audio.currentTime = 0;
    audio.volume = 0;
    audio.play().catch(() => {});
    fadeTo(vol(), xfade.ms);
    return;
  }
  old.pause();
  if (!autoplay) return;
  fadeId++;
  audio.currentTime = 0;
  audio.volume = vol();
  audio.play().catch(() => {});
}

/** Fade a player that's no longer the current one out, then stop it. */
function fadeOut(p, ms) {
  const from = p.volume, start = performance.now();
  const step = () => {
    if (p === audio) return; // it was picked again
    const k = Math.min(1, (performance.now() - start) / ms);
    p.volume = from * (1 - k);
    if (k < 1 && !p.paused) setTimeout(step, 30);
    else p.pause();
  };
  step();
}

const gains = new Map(); // file -> volume factor
/** How far "Normalize volume" turns a song down (1 when it's off or can't tell). */
async function gainOf(file) {
  if (!prefs.normalize || ios) return 1;
  if (!gains.has(file)) gains.set(file, await invoke("loudness", { path: file }).then((db) => 10 ** (db / 20), () => 1));
  return gains.get(file);
}
async function measureGain(t, file) {
  const g = await gainOf(file);
  if (current() !== t || g === trackGain) return;
  trackGain = g;
  if (!xfade.pending) fadeTo(vol(), 400);
}

// The equalizer runs the players through the browser's audio engine. That only starts once it's
// turned on, so with it off nothing about playback changes.
const EQ_BANDS = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const EQ_PRESETS = {
  flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  bass: [6, 5, 4, 2, 0, 0, 0, 0, 0, 0],
  treble: [0, 0, 0, 0, 0, 1, 2, 4, 5, 6],
  vocal: [-2, -2, -1, 1, 3, 3, 2, 1, 0, -1],
  rock: [4, 3, 2, 0, -1, -1, 1, 2, 3, 4],
  electronic: [5, 4, 1, 0, -2, 1, 0, 1, 4, 5],
  acoustic: [3, 3, 2, 1, 1, 1, 2, 2, 2, 1],
  loudness: [5, 4, 2, 0, -1, 0, 0, 2, 4, 5],
};
let graph = null, graphTrying = false;
const eqGains = () => (prefs.eqPreset === "custom" && Array.isArray(prefs.eqCustom) ? prefs.eqCustom : EQ_PRESETS[prefs.eqPreset] || EQ_PRESETS.flat);

/** The audio engine is needed for the equalizer and the visualizer. */
const wantGraph = () => prefs.eq || (prefs.visualizer !== "off" && npOpen());
async function startEqualizer() {
  if (graph || graphTrying || phone) return;
  const src = audio.getAttribute("src");
  if (!src) return; // tried again when a song loads
  graphTrying = true;
  // the audio engine may only read songs the player was allowed to fetch; check that works here first
  const stop = new AbortController();
  const ok = await fetch(src, { signal: stop.signal }).then((r) => r.ok, () => false);
  stop.abort(); // the headers were all it needed
  graphTrying = false;
  if (!ok) {
    if (prefs.eq) setPref("eq", false);
    if (prefs.visualizer !== "off") setPref("visualizer", "off");
    setStatus("The equalizer and visualizer can't be used on this system", 6000);
    return;
  }
  const ctx = new AudioContext();
  const filters = EQ_BANDS.map((f, i) => {
    const b = ctx.createBiquadFilter();
    b.type = i === 0 ? "lowshelf" : i === EQ_BANDS.length - 1 ? "highshelf" : "peaking";
    b.frequency.value = f;
    b.Q.value = 1.1;
    return b;
  });
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.78;
  filters.reduce((a, b) => (a.connect(b), b)).connect(analyser);
  analyser.connect(ctx.destination);
  graph = { ctx, filters, analyser };
  for (const p of players) {
    // reload with the audio engine's permission, keeping the place and whether it was playing
    const was = p.getAttribute("src");
    p.crossOrigin = "anonymous";
    if (was) {
      const at = p.currentTime, playing = !p.paused;
      p.src = was;
      p.addEventListener("loadedmetadata", () => {
        p.currentTime = at;
        if (playing) p.play().catch(() => {});
      }, { once: true });
    }
    ctx.createMediaElementSource(p).connect(filters[0]);
  }
  applyEq();
}
function applyEq() {
  if (wantGraph() && !graph) startEqualizer();
  if (!graph) return;
  const g = prefs.eq ? eqGains() : EQ_PRESETS.flat;
  graph.filters.forEach((f, i) => (f.gain.value = g[i] || 0));
}
onAudio("play", () => {
  graph?.ctx.resume();
  if (wantGraph() && !graph) startEqualizer();
});

// ------------------------------------------------------------------ events

onAudio("play", () => {
  if (mediaSession) mediaSession.playbackState = "playing";
  syncMediaPosition();
  el.playIcon.setAttribute("href", "#i-pause");
  document.body.classList.remove("paused");
  if (scrob.track !== current()) beginScrobble(current());
  discordSync();
});
onAudio("pause", () => {
  if (mediaSession) mediaSession.playbackState = "paused";
  syncMediaPosition();
  el.playIcon.setAttribute("href", "#i-play");
  document.body.classList.add("paused");
  discordSync();
  saveSession();
});
onAudio("seeked", () => {
  syncMediaPosition();
  scrob.lastTime = audio.currentTime;
  discordSync();
});
onAudio("ended", () => {
  if (mediaSession) mediaSession.playbackState = "paused"; // until the next song starts
  scrob.track = null; // so a repeated song scrobbles again
  next(true);
});
function showDuration() {
  el.seek.max = audio.duration || 0;
  el.dur.textContent = fmtTime(audio.duration);
}
onAudio("loadedmetadata", showDuration);
onAudio("loadedmetadata", syncMediaPosition);
let seeking = false;
onAudio("timeupdate", () => {
  trackListening();
  lookAhead();
  if (seeking) return;
  el.seek.value = audio.currentTime;
  el.pos.textContent = fmtTime(audio.currentTime);
  setRangeFill(el.seek);
});
onAudio("error", () => {
  if (!audio.getAttribute("src")) return; // cleared while a SoundCloud song downloads
  const t = current();
  // a song the scan couldn't read any length from is almost always an empty or cut-off file,
  // such as a download that never finished
  const why = t && !t.sc && !t.duration ? "the file is empty or damaged (maybe a download that didn't finish)" : "format not supported here";
  setStatus(`Can't play “${t?.title ?? "file"}” — ${why}`, 7000);
  if (state.pos + 1 < state.order.length) setTimeout(() => next(true), 400);
});

el.seek.addEventListener("input", () => {
  seeking = true;
  el.pos.textContent = fmtTime(el.seek.value);
  setRangeFill(el.seek);
  kickWave();
});
el.seek.addEventListener("change", () => {
  audio.currentTime = Number(el.seek.value);
  seeking = false;
});

// ------------------------------------------------------- waveform seek bar

const wave = { canvas: $("wave"), peaks: null, path: null, bins: 0, shownAt: 0, hover: -1, looping: false };
const waveBars = () => Math.min(2000, Math.max(16, Math.round(Number(prefs.waveBars) || 240)));

async function loadWaveform(t) {
  const bins = waveBars();
  wave.path = t?.path ?? null;
  wave.bins = bins;
  wave.peaks = null;
  kickWave();
  if (!t || !prefs.waveform) return;
  try {
    const peaks = t.sc
      ? await invoke("sc_waveform", { url: t.waveformUrl, bins })
      : await invoke("waveform", { path: t.path, bins });
    if (wave.path !== t.path || wave.bins !== bins) return; // song or detail changed while decoding
    // Loud, compressed masters sit near the top the whole way through; stretch the range
    // between the quietest and loudest part so the shape of the song stays visible.
    const sorted = [...peaks].sort((a, b) => a - b);
    const lo = sorted[Math.floor(sorted.length * 0.05)] ?? 0;
    wave.peaks = peaks.map((v) => 0.12 + 0.88 * Math.max(0, (v - lo) / (1 - lo || 1)));
    wave.shownAt = performance.now();
    kickWave();
  } catch {} // unsupported format: the bar stays a flat line
}

function drawWave() {
  const c = wave.canvas;
  if (!prefs.waveform || !c.clientWidth) return;
  const dpr = window.devicePixelRatio || 1, w = c.clientWidth, h = c.clientHeight;
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
  }
  const ctx = c.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  // One bar per waveform value; the gap disappears once bars get too thin for one.
  const n = wave.peaks ? wave.peaks.length : waveBars();
  const slot = w / n;
  const barW = slot >= 2 ? slot * 0.66 : slot;
  const duration = Number(el.seek.max) || 0;
  const time = seeking ? Number(el.seek.value) : audio.currentTime;
  const progress = duration ? time / duration : 0;
  const speed = Number(prefs.speed) || 1;
  const since = prefs.animations ? (performance.now() - wave.shownAt) / speed : Infinity;
  const played = getComputedStyle(c).color;

  // Height of the waveform at `frac` (0..1 along the song), including the left-to-right grow-in.
  const level = (frac) => {
    if (!wave.peaks) return 0.06; // flat line while loading or when decoding failed
    const k = Math.min(1, Math.max(0, (since - frac * 250) / 350));
    return Math.max(0.06, wave.peaks[Math.min(wave.peaks.length - 1, Math.floor(frac * wave.peaks.length))] * (1 - (1 - k) ** 3));
  };
  const fg = lightTheme() ? "0,0,0" : "255,255,255";
  const unplayed = `rgba(${fg},0.2)`, hovered = `rgba(${fg},0.42)`;

  if (prefs.waveStyle === "smooth") {
    // one mirrored shape through evenly spaced points, softened twice with a 3-point average
    const count = Math.max(2, n);
    let vals = Array.from({ length: count }, (_, i) => level(i / (count - 1)));
    for (let pass = 0; pass < 2; pass++) {
      vals = vals.map((v, i) => (vals[Math.max(0, i - 1)] + v * 2 + vals[Math.min(count - 1, i + 1)]) / 4);
    }
    const step = w / (count - 1), mid = h / 2, amp = (h / 2) * 0.95;
    const shape = new Path2D();
    const point = (i, sign) => [i * step, mid + sign * Math.max(1, vals[i] * amp)];
    // trace one edge (top: sign -1, bottom: +1), curving through the midpoints between samples
    const trace = (sign, from, to, dir) => {
      let [px, py] = point(from, sign);
      shape.lineTo(px, py);
      for (let i = from + dir; i !== to + dir; i += dir) {
        const [x, y] = point(i, sign);
        shape.quadraticCurveTo(px, py, (px + x) / 2, (py + y) / 2);
        [px, py] = [x, y];
      }
      shape.lineTo(px, py);
    };
    shape.moveTo(0, mid);
    trace(-1, 0, count - 1, 1);
    trace(1, count - 1, 0, -1);
    shape.closePath();
    const fillUpTo = (x, color) => {
      if (x <= 0) return;
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, x, h);
      ctx.clip();
      ctx.fillStyle = color;
      ctx.fill(shape);
      ctx.restore();
    };
    ctx.fillStyle = unplayed;
    ctx.fill(shape);
    if (wave.hover > progress) fillUpTo(wave.hover * w, hovered);
    fillUpTo(progress * w, played);
    return;
  }

  for (let i = 0; i < n; i++) {
    const frac = (i + 0.5) / n;
    const barH = Math.max(2, level(frac) * h * 0.95);
    ctx.fillStyle = frac <= progress ? played : wave.hover >= 0 && frac <= wave.hover ? hovered : unplayed;
    ctx.fillRect(i * slot, (h - barH) / 2, barW, barH);
  }
}

/** Redraw every frame while something is moving: playback, the grow-in, or a drag. */
function kickWave() {
  if (wave.looping || !prefs.waveform) return;
  wave.looping = true;
  const loop = () => {
    drawWave();
    const growing = wave.peaks && prefs.animations && performance.now() - wave.shownAt < 900 * (Number(prefs.speed) || 1);
    if (!audio.paused || growing || seeking) requestAnimationFrame(loop);
    else wave.looping = false;
  };
  requestAnimationFrame(loop);
}

const seekWrap = el.seek.parentElement;
seekWrap.addEventListener("mousemove", (e) => {
  const r = seekWrap.getBoundingClientRect();
  wave.hover = (e.clientX - r.left) / r.width;
  kickWave();
});
seekWrap.addEventListener("mouseleave", () => {
  wave.hover = -1;
  kickWave();
});
onAudio("play", kickWave);
onAudio("seeked", kickWave);
onAudio("loadedmetadata", kickWave);
window.addEventListener("resize", kickWave);

let volumeSave;
el.volume.addEventListener("input", () => {
  fadeId++; // cancel any running fade
  baseVolume = Number(el.volume.value);
  audio.volume = vol();
  setMuted(false);
  setRangeFill(el.volume);
  clearTimeout(volumeSave);
  volumeSave = setTimeout(() => invoke("set_volume", { volume: baseVolume }), 400);
});
onAudio("volumechange", () =>
  el.volIcon.setAttribute("href", audio.muted || audio.volume === 0 ? "#i-mute" : "#i-volume"));
const setMuted = (on) => players.forEach((p) => (p.muted = on));
$("mute").addEventListener("click", () => setMuted(!audio.muted));

el.play.addEventListener("click", togglePlay);
$("next").addEventListener("click", () => next());
$("prev").addEventListener("click", prev);
el.shuffle.addEventListener("click", cycleShuffle);
el.repeat.addEventListener("click", cycleRepeat);

let searchTimer;
el.search.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    if (state.source === "sc") {
      state.sc.filter = el.search.value.trim().toLowerCase();
      renderScSongs();
      return;
    }
    if (state.source === "slsk") {
      state.slsk.filter = el.search.value.trim().toLowerCase();
      renderSlskSongs();
      return;
    }
    state.query = el.search.value.trim().toLowerCase();
    applySearch();
  }, 120);
});
el.search.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || !el.search.value.trim()) return;
  if (state.source === "slsk") state.slsk.collapsed.clear();
  if (state.source === "sc") scSearch(el.search.value.trim());
  if (state.source === "slsk" && slskLoggedIn()) slskSearch(el.search.value.trim());
});

el.artistList.addEventListener("click", (e) => {
  const li = e.target.closest("li");
  if (!li) return;
  if (state.source === "sc") {
    if (li.dataset.key) {
      scSelect(li.dataset.key);
      showPane("songs");
    }
    return;
  }
  if (state.source === "slsk") {
    if (li.dataset.key) slskSelect(li.dataset.key);
    return;
  }
  if (li.dataset.newPlaylist !== undefined) return newPlaylist();
  if (li.dataset.newSmart !== undefined) return editSmartList();
  if (li.dataset.importM3u !== undefined) return importM3u();
  if (li.dataset.openPage) return openPage(li.dataset.openPage);
  state.artist = li.dataset.key || null;
  state.album = null;
  for (const x of el.artistList.children) x.classList.toggle("sel", x === li);
  renderAlbums();
  showPane(playlistOf(state.artist) || smartOf(state.artist) ? "songs" : "albums");
});
el.artistList.addEventListener("dblclick", (e) => e.target.closest("li") && state.source !== "slsk" && playShown(0));

el.albumGrid.addEventListener("click", (e) => {
  const card = e.target.closest(".album");
  if (!card) return;
  // clicking the selected album again goes back to all of the artist's songs (on phones, where
  // only the songs show after a tap, "All songs" does that)
  const key = state.albumKeys[card.dataset.i];
  state.album = key === state.album && !phoneLayout() ? null : key;
  for (const x of el.albumGrid.children) x.classList.toggle("sel", x === card && state.album !== null);
  renderSongs();
  showPane("songs");
});
el.albumGrid.addEventListener("dblclick", (e) => {
  const card = e.target.closest(".album");
  if (!card) return;
  state.album = state.albumKeys[card.dataset.i];
  for (const x of el.albumGrid.children) x.classList.toggle("sel", x === card);
  renderSongs();
  playShown(0);
});

el.songBody.addEventListener("click", (e) => {
  const row = e.target.closest("tr");
  if (!row) return;
  const t = state.shown[row.dataset.i];
  if (t?.group && e.target.closest("td.num")) {
    slskToggleGroup(t.key); // the arrow folds the folder
    return;
  }
  selectRow(Number(row.dataset.i));
  if (tapPlays()) playShown(Number(row.dataset.i));
});
el.songBody.addEventListener("dblclick", (e) => {
  const row = e.target.closest("tr");
  if (row && !tapPlays()) playShown(Number(row.dataset.i));
});
el.songGrid.addEventListener("click", (e) => {
  const card = e.target.closest(".album");
  if (!card) return;
  selectRow(Number(card.dataset.i));
  if (tapPlays()) playShown(Number(card.dataset.i));
});
el.songGrid.addEventListener("dblclick", (e) => {
  const card = e.target.closest(".album");
  if (card && !tapPlays()) playShown(Number(card.dataset.i));
});
$("sc-view").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-view]");
  if (b) setPref("scView", b.dataset.view);
});

$("add-folder").addEventListener("click", addFolder);
$("empty-add").addEventListener("click", addFolder);
$("rescan").addEventListener("click", () => rescan(false));
$("full-rescan").addEventListener("click", () => rescan(true));
el.folderList.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-i]");
  if (btn) removeFolder(state.settings.folders[Number(btn.dataset.i)]);
});
el.preferTags.addEventListener("change", async () => {
  state.settings.preferTags = el.preferTags.checked;
  await invoke("set_prefer_tags", { prefer: el.preferTags.checked });
  rescan(true);
});

// Keyboard shortcuts. The ones in SHORTCUTS can be changed in Settings → Shortcuts (saved as
// prefs.keys, only the changed ones); Escape, the arrow keys up and down, and Enter can't.
const SHORTCUTS = [
  { id: "playPause", label: "Play / pause", keys: "Space", run: togglePlay },
  { id: "next", label: "Next song", keys: "Ctrl+ArrowRight", run: () => next() },
  { id: "prev", label: "Previous song", keys: "Ctrl+ArrowLeft", run: () => prev() },
  { id: "seekFwd", label: "Forward 5 seconds", keys: "ArrowRight", run: () => seekBy(5) },
  { id: "seekBack", label: "Back 5 seconds", keys: "ArrowLeft", run: () => seekBy(-5) },
  { id: "volUp", label: "Volume up", keys: "Ctrl+ArrowUp", run: () => nudgeVolume(0.05) },
  { id: "volDown", label: "Volume down", keys: "Ctrl+ArrowDown", run: () => nudgeVolume(-0.05) },
  { id: "mute", label: "Mute", keys: "M", run: () => setMuted(!audio.muted) },
  { id: "like", label: "Favourite the playing song", keys: "L", run: () => $("now-fav").click() },
  { id: "shuffle", label: "Shuffle", keys: "S", run: cycleShuffle },
  { id: "repeat", label: "Repeat", keys: "R", run: cycleRepeat },
  { id: "nowPlaying", label: "Now playing", keys: "N", run: () => current() && showNowPlaying(!npOpen()) },
  { id: "queue", label: "Queue", keys: "Q", run: () => showQueue(!queueOpen()) },
  { id: "mini", label: "Mini player", keys: "Ctrl+M", run: () => toggleMini(), desktop: true },
  { id: "jump", label: "Go to the playing song", keys: "Ctrl+L", run: () => jumpToCurrent(), anywhere: true },
  { id: "search", label: "Search", keys: "Ctrl+F", run: () => (el.search.focus(), el.search.select()), anywhere: true },
  { id: "settings", label: "Settings", keys: "Ctrl+,", run: () => (el.settings.hidden ? openSettings() : closeSettings()), anywhere: true },
  { id: "stats", label: "Listening stats", keys: "Ctrl+I", run: () => openStats(), anywhere: true },
  { id: "rescan", label: "Rescan the library", keys: "F5", run: () => rescan(false), anywhere: true },
];
const MODIFIERS = ["Control", "Meta", "Alt", "Shift", "AltGraph", "CapsLock"];

/** "Ctrl+Shift+K" for a key press (Ctrl means ⌘ on a Mac), or "" for a lone modifier key. */
function keyCombo(e) {
  if (MODIFIERS.includes(e.key)) return "";
  const key = e.key === " " ? "Space" : e.key.length === 1 ? e.key.toUpperCase() : e.key;
  return [e.ctrlKey || e.metaKey ? "Ctrl" : "", e.altKey ? "Alt" : "", e.shiftKey && key.length > 1 ? "Shift" : "", key].filter(Boolean).join("+");
}
const shortcutKeys = (s) => (prefs.keys && s.id in prefs.keys ? prefs.keys[s.id] : s.keys);
/** How a key combination is written on this computer. */
function showCombo(combo) {
  if (!combo) return "—";
  const names = { ArrowRight: "→", ArrowLeft: "←", ArrowUp: "↑", ArrowDown: "↓", Ctrl: platform === "mac" ? "⌘" : "Ctrl", Alt: platform === "mac" ? "⌥" : "Alt", Shift: "Shift" };
  return combo.split("+").map((k) => names[k] || k).join(platform === "mac" ? "" : "+");
}
function seekBy(secs) {
  if (!current() || !isFinite(audio.duration)) return;
  audio.currentTime = Math.max(0, Math.min(audio.duration - 0.1, audio.currentTime + secs));
}
function nudgeVolume(by) {
  el.volume.value = Math.max(0, Math.min(1, baseVolume + by));
  el.volume.dispatchEvent(new Event("input"));
}

let capturing = null; // the Settings → Shortcuts button waiting for a key
document.addEventListener("keydown", (e) => {
  if (capturing) return captureKey(e);
  const typing = e.target === el.search || e.target.matches?.("input:not([type=range]):not([type=checkbox]), textarea, select");
  const combo = keyCombo(e);
  const action = combo && SHORTCUTS.find((s) => shortcutKeys(s) === combo && (!s.desktop || !phone));
  // shortcuts that work while typing need a modifier key, so typing a letter never triggers one
  if (action && (action.anywhere || !typing) && (!typing || /^(Ctrl|Alt)\+|^F\d/.test(combo))) {
    if (!action.anywhere && (!el.settings.hidden || !$("editor").hidden || !$("ask").hidden)) return;
    e.preventDefault();
    action.run();
  } else if (e.key === "Escape") {
    if (!$("editor-find-panel").hidden) return ($("editor-find-panel").hidden = true);
    if (!$("editor").hidden) return closeEditor();
    closeSettings();
    if (typing) e.target.blur();
  } else if (typing || !el.settings.hidden || !$("editor").hidden) {
    return;
  } else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    const n = state.shown.length;
    if (n) selectRow(Math.min(n - 1, Math.max(0, state.selected + (e.key === "ArrowDown" ? 1 : -1))));
  } else if (e.key === "Enter" && state.selected >= 0) {
    playShown(state.selected);
  }
});

/** Settings → Shortcuts: one row per shortcut, click the key to change it. */
function renderShortcuts() {
  $("shortcut-list").innerHTML = SHORTCUTS.filter((s) => !s.desktop || !phone).map((s) =>
    `<div class="row"><div class="label">${esc(s.label)}</div>` +
    `<button class="btn key-btn${capturing === s.id ? " capturing" : ""}${shortcutKeys(s) !== s.keys ? " changed" : ""}" data-key="${s.id}">` +
    `${capturing === s.id ? "Press keys…" : esc(showCombo(shortcutKeys(s)))}</button></div>`).join("");
}
function captureKey(e) {
  e.preventDefault();
  e.stopPropagation();
  const id = capturing;
  if (e.key === "Escape") {
    capturing = null;
    return renderShortcuts();
  }
  const combo = e.key === "Backspace" || e.key === "Delete" ? "" : keyCombo(e);
  if (combo === "" && MODIFIERS.includes(e.key)) return; // wait for the rest of the combination
  capturing = null;
  const keys = { ...(prefs.keys || {}) };
  // one key does one thing: take it away from whatever had it
  for (const s of SHORTCUTS) if (combo && s.id !== id && shortcutKeys(s) === combo) keys[s.id] = "";
  keys[id] = combo;
  for (const s of SHORTCUTS) if (keys[s.id] === s.keys) delete keys[s.id];
  setPref("keys", keys);
  renderShortcuts();
}
$("shortcut-list").addEventListener("click", (e) => {
  const b = e.target.closest(".key-btn");
  if (!b) return;
  capturing = capturing === b.dataset.key ? null : b.dataset.key;
  renderShortcuts();
});
$("shortcuts-reset").addEventListener("click", () => {
  capturing = null;
  setPref("keys", {});
  renderShortcuts();
});

// ------------------------------------------------------------ window chrome

$("win-min").addEventListener("click", () => appWindow.minimize());
$("win-max").addEventListener("click", () => appWindow.toggleMaximize());
let closeArmed = 0;
$("win-close").addEventListener("click", () => {
  if (slskActive() && Date.now() - closeArmed > 5000) {
    closeArmed = Date.now();
    setStatus(`${slskActive()} Soulseek download${slskActive() === 1 ? " is" : "s are"} still going — closing stops ${slskActive() === 1 ? "it" : "them"}. Click close again to quit.`, 5000);
    return;
  }
  if (prefs.closeToTray && !quitting) {
    saveSession();
    appWindow.hide();
    if (!prefs.trayHintShown) {
      setPref("trayHintShown", true);
      // shown once, as a system notification can't be relied on: the status shows when it's opened again
      setStatus("yuuricloud kept playing in the tray. Right-click its icon → Quit to close it.", 8000);
    }
    return;
  }
  quitApp();
});
let quitting = false;
function quitApp() {
  quitting = true;
  saveSession();
  logListen();
  invoke("discord_update", { track: null, playing: false, position: 0 })
    .finally(() => (prefs.closeToTray ? invoke("quit_app") : appWindow.close()));
}

// the tray icon's menu (lib.rs make_tray)
listen("tray", ({ payload }) => {
  if (payload === "playPause") togglePlay();
  else if (payload === "next") next();
  else if (payload === "prev") prev();
  else if (payload === "quit") quitApp();
});

async function syncMaximized() {
  const max = await appWindow.isMaximized();
  document.body.classList.toggle("maximized", max); // square corners when filling the screen
  $("win-max-icon").setAttribute("d", max ? "M3.5 1.5h7v7M1.5 3.5h7v7h-7z" : "M2 2h8v8H2z");
  $("win-max").title = max ? "Restore" : "Maximize";
}
if (!phone) {
  appWindow.onResized(syncMaximized);
  syncMaximized();
}

// ------------------------------------------------------------- mini player
// The window shrinks to just the player and stays on top; the same button (or Ctrl+M) makes it
// big again, at the size it was.

let mini = null; // while small: the size to go back to
const FULL_MIN = { w: 900, h: 560 }; // keep in sync with minWidth/minHeight in tauri.conf.json
async function toggleMini(on = !mini) {
  if (phone || on === !!mini) return;
  const { LogicalSize } = window.__TAURI__.dpi;
  const w = appWindow;
  try {
    if (on) {
      mini = { size: await w.innerSize(), max: await w.isMaximized() };
      showNowPlaying(false);
      showQueue(false);
      closeSettings();
      if (mini.max) await w.unmaximize();
      document.body.classList.add("mini");
      await w.setMinSize(new LogicalSize(320, 116));
      await w.setSize(new LogicalSize(440, 136));
      await w.setAlwaysOnTop(true);
    } else {
      const was = mini;
      mini = null;
      document.body.classList.remove("mini");
      await w.setAlwaysOnTop(prefs.onTop);
      await w.setSize(was.size);
      await w.setMinSize(new LogicalSize(FULL_MIN.w, FULL_MIN.h));
      if (was.max) await w.maximize();
    }
  } catch (e) {
    console.warn("mini player:", e);
  }
  $("mini-icon").setAttribute("href", mini ? "#i-expand" : "#i-mini");
  $("mini-btn").title = mini ? "Back to the full window" : "Mini player";
  document.querySelector(".player").toggleAttribute("data-tauri-drag-region", !!mini);
  document.querySelector(".now").toggleAttribute("data-tauri-drag-region", !!mini);
  kickWave();
}
$("mini-btn").addEventListener("click", () => toggleMini());

// ---------------------------------------------------------- resume session

const SESSION_KEY = "yuuricloud.session";
let sessionReady = false; // don't overwrite the saved session before it has been restored

function saveSession() {
  if (!prefs.resume || !sessionReady) return;
  const session = {
    query: state.source === "local" ? el.search.value : "", artist: state.artist, album: state.album,
    source: state.source, scList: state.sc.current, scSearch: state.sc.searchQuery,
    // SoundCloud songs aren't in the library, so they are saved whole
    queue: state.queue.map((t) => (t.sc ? t : t.path)), order: state.order, pos: state.pos,
    time: audio.currentTime || 0, shuffle: state.shuffle, repeat: state.repeat,
  };
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {}
}
setInterval(() => !audio.paused && saveSession(), 5000);
window.addEventListener("beforeunload", saveSession);

function restoreSession() {
  let s;
  try {
    s = JSON.parse(localStorage.getItem(SESSION_KEY));
  } catch {}
  if (!s) return;

  el.search.value = s.query || "";
  state.query = el.search.value.trim().toLowerCase();
  state.artist = s.artist ?? null;
  state.album = s.album ?? null;
  applySearch(); // drops an artist/album that's no longer in the library
  reveal(el.artistList, el.artistList.querySelector(".sel"), true);
  reveal(el.albumGrid, el.albumGrid.querySelector(".sel"), true);
  setShuffle(shuffleMode(s.shuffle));
  setRepeat(s.repeat || REPEAT_OFF);

  state.sc.current = s.scList || "likes";
  state.sc.searchQuery = s.scSearch || "";
  if (s.source === "sc" || s.source === "slsk") setSource(s.source);

  const byPath = new Map(state.tracks.map((t) => [t.path, t]));
  const queue = (s.queue || []).map((p) => (typeof p === "string" ? byPath.get(p) : p?.sc && scConnected() ? p : undefined));
  const cur = queue[s.order?.[s.pos]];
  if (!cur) return;
  if (queue.every(Boolean)) {
    Object.assign(state, { queue, order: s.order, pos: s.pos });
  } else {
    Object.assign(state, { queue: [cur], order: [0], pos: 0 }); // some songs were removed
  }
  playCurrent(false);
  audio.addEventListener("loadedmetadata", () => (audio.currentTime = Math.min(s.time || 0, audio.duration || 0)), { once: true });
  const i = state.shown.findIndex((x) => x.path === cur.path);
  if (i >= 0) revealSong(i);
}

// ------------------------------------------------------- Last.fm & Discord

const trackInfo = (t) => ({
  title: t.title, artist: t.artist, album: t.album, albumArtist: t.albumArtist, duration: t.duration,
  image: t.sc && t.cover ? t.cover : null,
  url: t.sc && t.permalinkUrl ? t.permalinkUrl.split("?")[0] : null,
});
const scrob = { track: null, startedAt: 0, listened: 0, lastTime: 0, done: false };

function lastfmEnabled() {
  const lf = state.settings.lastfm;
  return lf && lf.scrobble && lf.sessionKey;
}

/** Put the song that was playing into the listening history (Stats), if it played a while. */
function logListen() {
  const t = scrob.track;
  if (!t || scrob.listened < 10 || scrob.logged) return;
  scrob.logged = true;
  const listen = { at: scrob.startedAt, secs: Math.round(scrob.listened), path: t.path, title: t.title, artist: t.artist, album: t.album || "", sc: !!t.sc };
  invoke("log_listen", { listen }).then(() => stats.history?.push(listen), () => {});
}

function beginScrobble(t) {
  logListen();
  scrob.logged = false;
  Object.assign(scrob, { track: t, startedAt: Math.floor(Date.now() / 1000), listened: 0, lastTime: audio.currentTime, done: false });
  if (t && lastfmEnabled()) invoke("lastfm_now_playing", { track: trackInfo(t) }).catch(() => {});
}

/** Count real listening time (not seeks) and scrobble once enough has played. */
function trackListening() {
  if (audio.paused || !scrob.track) return;
  const delta = audio.currentTime - scrob.lastTime;
  scrob.lastTime = audio.currentTime;
  if (delta > 0 && delta < 2) scrob.listened += delta;
  const t = scrob.track;
  const needed = Math.min((t.duration || audio.duration || 0) / 2, 240);
  if (!scrob.done && (t.duration || audio.duration) > 30 && scrob.listened >= needed) {
    scrob.done = true;
    // counts toward the smart lists, for library songs
    if (!t.sc) invoke("record_play", { path: t.path }).then((stat) => (state.stats[t.path] = stat), () => {});
    if (lastfmEnabled()) {
      invoke("lastfm_scrobble", { track: trackInfo(t), startedAt: scrob.startedAt })
        .catch((e) => setStatus(String(e), 5000));
    }
  }
}

let discordTimer, discordError = "";
function discordSync() {
  if (!state.settings.discord?.enabled) return;
  clearTimeout(discordTimer);
  discordTimer = setTimeout(async () => {
    const t = current();
    try {
      await invoke("discord_update", {
        track: t ? trackInfo(t) : null, playing: !audio.paused, position: audio.currentTime || 0,
      });
      discordError = "";
    } catch (e) {
      discordError = String(e);
    }
    renderIntegrations();
  }, 300);
}

let lastfmPending = false;
let lastfmBuiltin = false; // the shared Last.fm account is available, no own keys needed
invoke("lastfm_builtin").then((on) => {
  lastfmBuiltin = on;
  renderIntegrations();
});
function renderIntegrations() {
  const lf = state.settings.lastfm || {}, dc = state.settings.discord || {};
  const connected = !!lf.sessionKey;
  const ownKeys = !!(lf.apiKey && lf.apiSecret);
  const status = $("lfm-status");
  status.className = "hint" + (connected ? " ok" : "");
  status.textContent = connected ? `Connected as ${lf.username}${ownKeys ? " (your own API account)" : ""}`
    : lastfmPending ? "Approve access in the browser window that opened, then click “I've approved it”."
    : ownKeys ? "Not connected — using your own API account" : lastfmBuiltin ? "Not connected" : "Add your API key and shared secret below first.";
  if (!lastfmBuiltin && !ownKeys) $("lfm-own").open = true;
  $("lfm-connect").hidden = connected;
  $("lfm-connect").disabled = !ownKeys && !lastfmBuiltin;
  $("lfm-finish").hidden = connected || !lastfmPending;
  $("lfm-disconnect").hidden = !connected;
  $("lfm-scrobble").checked = !!lf.scrobble;
  $("lfm-scrobble").disabled = !connected;

  const dStatus = $("discord-status");
  dStatus.className = "hint" + (discordError ? " err" : dc.enabled ? " ok" : "");
  dStatus.textContent = !dc.enabled ? "Off" : !dc.clientId ? "Paste your Application ID above." : discordError || "On — shows while a song is loaded";
  $("discord-enabled").checked = !!dc.enabled;
  renderScSettings();
  renderDownloadSettings();
  renderSlskSettings();
  renderPcSettings();
}

function fillIntegrationFields() {
  const lf = state.settings.lastfm || {}, dc = state.settings.discord || {};
  $("lfm-key").value = lf.apiKey || "";
  $("lfm-secret").value = lf.apiSecret || "";
  $("discord-id").value = dc.clientId || "";
  $("sc-id").value = state.settings.soundcloud?.clientId || "";
  $("sc-secret").value = state.settings.soundcloud?.clientSecret || "";
  $("sc-redirect").value = state.settings.soundcloud?.redirectUri || SC_DEFAULT_REDIRECT;
  renderIntegrations();
}

async function lastfmAction(command, args) {
  try {
    const settings = await invoke(command, args);
    if (settings) state.settings = settings;
  } catch (e) {
    $("lfm-status").className = "hint err";
    $("lfm-status").textContent = String(e);
    return false;
  }
  renderIntegrations();
  return true;
}

$("lfm-save").addEventListener("click", () => {
  lastfmPending = false;
  lastfmAction("lastfm_set_keys", { apiKey: $("lfm-key").value, apiSecret: $("lfm-secret").value });
});
$("lfm-connect").addEventListener("click", async () => {
  lastfmPending = true;
  if (!(await lastfmAction("lastfm_begin_auth"))) lastfmPending = false;
});
$("lfm-finish").addEventListener("click", async () => {
  if (await lastfmAction("lastfm_finish_auth")) {
    lastfmPending = false;
    renderIntegrations();
  }
});
$("lfm-disconnect").addEventListener("click", () => lastfmAction("lastfm_disconnect"));
$("lfm-scrobble").addEventListener("change", (e) => {
  state.settings.lastfm.scrobble = e.target.checked;
  invoke("lastfm_set_scrobble", { enabled: e.target.checked });
});

async function saveDiscord() {
  const enabled = $("discord-enabled").checked;
  state.settings = await invoke("discord_set", { enabled, clientId: $("discord-id").value });
  discordError = "";
  renderIntegrations();
  if (enabled) discordSync();
}
$("discord-enabled").addEventListener("change", saveDiscord);
$("discord-id").addEventListener("change", saveDiscord);

// --------------------------------------------------------------- settings

let prefsSave;
function setPref(key, value) {
  prefs[key] = value;
  applyPrefs();
  clearTimeout(prefsSave);
  prefsSave = setTimeout(() => invoke("set_ui", { ui: prefs }), 300);
}

let blurApplied = null;
let scViewShown = null;
// ------------------------------------------------- cover colors & jump-to

const coverAccents = new Map(); // cover path -> "#rrggbb" or null

/** Use the playing song's cover color as the accent, or the chosen accent otherwise. */
async function updateAccent() {
  const root = document.documentElement.style;
  const cover = current()?.cover;
  let color = prefs.accent;
  if (prefs.coverColors && cover) {
    if (!coverAccents.has(cover)) {
      coverAccents.set(cover, await invoke("cover_accent", { cover }).catch(() => null));
    }
    if (current()?.cover !== cover) return; // the song changed while we were looking
    color = coverAccents.get(cover) || prefs.accent;
  }
  root.setProperty("--accent-base", color);
}

function flash(node) {
  node.classList.remove("flash");
  void node.offsetWidth; // restart the animation
  node.classList.add("flash");
}

/** Show the playing song: select its artist and album, scroll to it and flash it. */
function jumpToCurrent(albumToo = true) {
  const t = current();
  if (!t) return;
  if (t.sc) return jumpToScTrack(t);
  if (state.source !== "local") setSource("local");
  showPane("songs");
  if (!state.visible.some((x) => x.path === t.path)) {
    el.search.value = ""; // the search is hiding it
    state.query = "";
  }
  state.artist = artistKey(t);
  state.album = albumToo ? albumKey(t) : null;
  closeSettings();
  applySearch();

  reveal(el.artistList, el.artistList.querySelector(".sel"), true);
  const card = el.albumGrid.children[state.albumKeys.indexOf(albumKey(t))];
  if (card) {
    reveal(el.albumGrid, card, true);
    flash(card);
  }
  const i = state.shown.findIndex((x) => x.path === t.path);
  if (i >= 0) {
    selectRow(i);
    const row = revealSong(i);
    if (row) flash(row);
  }
}

$("locate").addEventListener("click", () => jumpToCurrent());
el.nowTitle.addEventListener("click", () => jumpToCurrent());
el.nowArtist.addEventListener("click", () => jumpToCurrent(false));

const APP_ICONS = ["yuuri", "cloud"];
let appliedIcon = null;
function applyAppIcon() {
  if (phone) return; // the home screen icon is fixed
  const name = APP_ICONS.includes(prefs.appIcon) ? prefs.appIcon : APP_ICONS[0];
  if (name === appliedIcon) return;
  appliedIcon = name;
  $("brand-icon").src = `icons/app-${name}.png`;
  invoke("set_app_icon", { name }).catch(() => {});
}

const systemLight = matchMedia("(prefers-color-scheme: light)");
const lightTheme = () => prefs.theme === "light" || (prefs.theme === "system" && systemLight.matches);
systemLight.addEventListener("change", () => prefs.theme === "system" && applyTheme());
let themeApplied = null;
/** Light or dark: the page's colors, and the window's own (the blur behind it, on Windows and macOS). */
function applyTheme() {
  const light = lightTheme();
  document.documentElement.classList.toggle("light", light);
  if (!phone && themeApplied !== prefs.theme) {
    themeApplied = prefs.theme;
    appWindow.setTheme?.(prefs.theme === "system" ? null : prefs.theme).catch(() => {});
  }
  kickWave();
}

function applyPrefs() {
  const root = document.documentElement.style;
  const body = document.body.classList;
  applyTheme();
  updateAccent();
  body.toggle("cover-tint", prefs.coverTint);
  applyAppIcon();
  root.setProperty("--tint-alpha", prefs.tint);
  root.setProperty("--cover-min", COVER_SIZES[prefs.coverSize] || COVER_SIZES.medium);
  root.setProperty("--speed", prefs.speed);
  applyInterfaceSize();
  body.toggle("no-anim", !prefs.animations);
  body.toggle("compact", prefs.compact);
  body.toggle("hide-counts", !prefs.showCounts);
  body.toggle("ambient-on", prefs.ambient);
  body.toggle("hover-lift", prefs.hoverLift);
  body.toggle("waveform", prefs.waveform);
  body.toggle("sc-grid", prefs.scView === "grid");
  for (const b of $("sc-view").children) b.classList.toggle("on", b.dataset.view === prefs.scView);
  if (scViewShown !== prefs.scView) {
    scViewShown = prefs.scView;
    if (state.source === "sc") renderScSongs();
  }
  root.setProperty("--wave-h", `${prefs.waveHeight}px`);
  if (prefs.waveform && current() && (wave.path !== current().path || wave.bins !== waveBars())) loadWaveform(current());
  else kickWave();
  if (platform !== "linux" && !phone && blurApplied !== prefs.blur) {
    blurApplied = prefs.blur;
    const done = prefs.blur
      ? appWindow.setEffects({ effects: ["acrylic", "underWindowBackground"], radius: 16 })
      : appWindow.clearEffects();
    done.catch(() => {});
  }
  if (!phone) appWindow.setAlwaysOnTop(prefs.onTop).catch(() => {});
  highlightPlaying();
  applyEq();
  if (normalizeShown !== prefs.normalize) {
    normalizeShown = prefs.normalize;
    const t = current();
    if (t && !t.sc) measureGain(t, t.path);
  }
  if (!el.settings.hidden) syncSettingsUI();
}

let normalizeShown = null;

/** Settings → Sound: the equalizer's preset and bands. */
function syncSoundUI() {
  const xf = crossfadeSecs();
  $("crossfade-value").textContent = xf ? `· ${xf} s` : "· off (no gap)";
  $("eq-preset").value = prefs.eqPreset in EQ_PRESETS || prefs.eqPreset === "custom" ? prefs.eqPreset : "flat";
  const g = eqGains();
  for (const b of document.querySelectorAll("#eq-bands input")) {
    b.value = g[b.dataset.band] || 0;
    setRangeFill(b);
  }
  $("eq-bands").classList.toggle("off", !prefs.eq);
}
$("eq-preset").addEventListener("change", (e) => setPref("eqPreset", e.target.value));
$("eq-bands").addEventListener("input", (e) => {
  const b = e.target.closest("input[data-band]");
  if (!b) return;
  // dragging a band starts a custom curve from the one shown
  const custom = [...eqGains()];
  custom[b.dataset.band] = Number(b.value);
  prefs.eqCustom = custom;
  if (!prefs.eq) prefs.eq = true;
  setPref("eqPreset", "custom");
});

function syncSettingsUI() {
  renderShortcuts();
  for (const input of el.settings.querySelectorAll("input[data-pref]")) {
    const value = prefs[input.dataset.pref];
    if (input.type === "checkbox") {
      input.checked = !!value;
    } else {
      input.value = value;
      setRangeFill(input);
    }
  }
  syncSoundUI();
  for (const group of el.settings.querySelectorAll(".segmented[data-pref]")) {
    for (const b of group.children) b.classList.toggle("on", b.dataset.value === String(prefs[group.dataset.pref]));
  }
  el.settings.querySelector('input[data-pref="blur"]').disabled = platform === "linux";
  for (const b of el.settings.querySelectorAll(".icon-choice")) b.classList.toggle("on", b.dataset.icon === prefs.appIcon);
  const custom = !ACCENTS.includes(prefs.accent);
  $("accent-swatches").innerHTML =
    ACCENTS.map((c) => `<button class="swatch${c === prefs.accent ? " on" : ""}" style="--c:${c}" data-color="${c}" title="${c}"></button>`).join("") +
    `<label class="swatch custom${custom ? " on" : ""}" style="--c:${custom ? prefs.accent : "#fff"}" title="Custom color">` +
    `<input type="color" value="${custom ? prefs.accent : ACCENTS[0]}"></label>`;
}

function openSettings() {
  el.settings.classList.remove("closing");
  el.settings.hidden = false;
  syncSettingsUI();
  fillIntegrationFields();
}

function closeSettings() {
  if (el.settings.hidden) return;
  capturing = null;
  // closing during the setup guide counts as skipping the rest of it
  const hidden = () => {
    el.settings.hidden = true;
    el.settings.classList.remove("closing");
    endOnboarding();
  };
  if (!prefs.animations) return hidden();
  el.settings.classList.add("closing");
  setTimeout(hidden, 240 * Number(prefs.speed));
}

$("settings-btn").addEventListener("click", openSettings);
$("settings-close").addEventListener("click", closeSettings);
$("settings-add-folder").addEventListener("click", addFolder);
el.settings.addEventListener("mousedown", (e) => e.target === el.settings && closeSettings());

el.settings.addEventListener("change", (e) => {
  const key = e.target.dataset.pref;
  if (key && e.target.type === "checkbox") setPref(key, e.target.checked);
  if (key === "ignoreThe") applySearch(); // re-sort
  if (e.target.type === "color") setPref("accent", e.target.value);
});
let numberTimer;
el.settings.addEventListener("input", (e) => {
  const key = e.target.dataset.pref;
  if (key && e.target.type === "range") setPref(key, Number(e.target.value));
  if (key && e.target.type === "number") {
    // wait for typing to settle; each new count decodes the song again
    clearTimeout(numberTimer);
    numberTimer = setTimeout(() => {
      const { min, max } = e.target;
      const v = Math.min(Number(max), Math.max(Number(min), Math.round(Number(e.target.value)) || Number(min)));
      setPref(key, v);
    }, 500);
  }
});
el.settings.addEventListener("click", (e) => {
  const link = e.target.closest("a[data-open]");
  if (link) {
    e.preventDefault();
    window.__TAURI__.opener.openUrl(link.dataset.open);
    return;
  }
  const tab =e.target.closest(".settings-tabs button");
  if (tab) {
    for (const b of tab.parentElement.children) b.classList.toggle("on", b === tab);
    for (const t of el.settings.querySelectorAll(".tab")) t.hidden = t.dataset.tab !== tab.dataset.tab;
    return;
  }
  const seg = e.target.closest(".segmented[data-pref] button");
  if (seg) return setPref(seg.parentElement.dataset.pref, seg.dataset.value);
  const iconChoice = e.target.closest(".icon-choice");
  if (iconChoice) return setPref("appIcon", iconChoice.dataset.icon);
  const swatch = e.target.closest(".swatch[data-color]");
  if (swatch) setPref("accent", swatch.dataset.color);
});
// Backups: settings and favourites to a file and back (see backup.rs)
function backupStatus(text, ok = true) {
  $("backup-status").className = "hint" + (text ? (ok ? " ok" : " err") : "");
  $("backup-status").textContent = text;
}
$("backup-export").addEventListener("click", async () => {
  try {
    const file = await invoke("export_backup", { includeLogins: $("backup-logins").checked });
    if (file) backupStatus(`Saved to ${phone ? `yuuricloud's folder as “${baseName(file)}”` : file}`);
  } catch (e) {
    backupStatus(String(e), false);
  }
});
$("backup-import").addEventListener("click", async () => {
  let r;
  try {
    r = await invoke("import_backup");
  } catch (e) {
    return backupStatus(String(e), false);
  }
  if (!r) return;
  state.settings = r.settings;
  state.favorites = new Set(r.settings.favorites || []);
  state.playlists = r.settings.playlists || [];
  plSets.clear();
  const linuxDefaults = platform === "linux" ? { blur: false, tint: 0.96 } : {};
  prefs = { ...DEFAULT_PREFS, ...linuxDefaults, ...(r.settings.ui || {}) };
  applyPrefs();
  applySearch();
  renderNowFav();
  fillIntegrationFields();
  const i = r.imported;
  const parts = [i.prefs && "settings", `${i.favorites} favourite${i.favorites === 1 ? "" : "s"}`,
    i.playlists && `${i.playlists} playlist${i.playlists === 1 ? "" : "s"}`, i.logins && "logins"].filter(Boolean);
  backupStatus(`Imported ${parts.join(", ")} from “${r.file}”` + (i.waiting ? `. ${i.waiting} more become favourites once those songs are in your library.` : ".") +
    (i.playlistMissing ? ` ${i.playlistMissing} playlist song${i.playlistMissing === 1 ? " isn't" : "s aren't"} in this library.` : ""));
});
listen("favorites-changed", ({ payload }) => {
  state.favorites = new Set(payload);
  state.settings.favorites = payload;
  if (state.source === "local") applySearch();
  renderNowFav();
});

$("reset-prefs").addEventListener("click", () => {
  const linuxDefaults = platform === "linux" ? { blur: false, tint: 0.96 } : {};
  prefs = { ...DEFAULT_PREFS, ...linuxDefaults };
  setPref("accent", prefs.accent);
  applySearch();
});

// --------------------------------------------------------------- SoundCloud

const SC_DEFAULT_REDIRECT = "http://127.0.0.1:8974/callback";
const scConnected = () => !!state.settings.soundcloud?.accessToken;

/** Switch the panels between the local library and SoundCloud. */
function setSource(source) {
  state.source = source;
  showPane("artists");
  document.body.classList.toggle("sc", source === "sc");
  document.body.classList.toggle("slsk", source === "slsk");
  $("th-artist").textContent = source === "slsk" ? "Size" : "Artist";
  $("th-album").textContent = source === "slsk" ? "Quality" : "Album";
  $("slsk-sort").value = prefs.slskSort || "best";
  for (const b of $("source").children) b.classList.toggle("on", b.dataset.source === source);
  el.search.placeholder = source === "sc" ? "Filter, or press Enter to search SoundCloud"
    : source === "slsk" ? "Press Enter to search Soulseek, or type to filter" : "Search artists, albums, songs";
  el.search.value = "";
  state.query = "";
  state.sc.filter = "";
  state.slsk.filter = "";
  if (source !== "sc") $("sc-empty").hidden = true;
  if (source !== "slsk") $("slsk-empty").hidden = true;
  if (source === "sc") {
    renderSc();
    if (scConnected() && !state.sc.loaded) scLoad();
  } else if (source === "slsk") {
    renderSlsk();
  } else {
    applySearch();
  }
  saveSession();
}

$("source").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-source]");
  if (b && b.dataset.source !== state.source) setSource(b.dataset.source);
});

function scListName(key) {
  if (key === "likes") return "Likes";
  if (key === "search") return `Search: ${state.sc.searchQuery}`;
  return state.sc.playlists.find((p) => "pl:" + p.urn === key)?.title || "Playlist";
}

function renderSc() {
  const connected = scConnected();
  el.empty.hidden = true;
  $("sc-empty").hidden = connected;
  document.body.classList.toggle("sc-connected", connected);
  el.library.hidden = !connected;
  if (!connected) return;
  const sc = state.sc;
  if (sc.current.startsWith("pl:") && sc.playlists.length && !sc.playlists.some((p) => "pl:" + p.urn === sc.current)) {
    sc.current = "likes"; // the playlist is gone
  }
  if (sc.current === "search" && !sc.searchQuery) sc.current = "likes";

  let n = 0;
  const item = (key, count) =>
    `<li data-key="${esc(key)}" class="${key === sc.current ? "sel" : ""}" title="${esc(scListName(key))}" style="--i:${n++}">` +
    `${count != null ? `<span class="count">${count}</span>` : ""}${esc(scListName(key))}</li>`;
  const group = (name) => `<li class="group" style="--i:${n++}">${esc(name)}</li>`;
  const own = sc.playlists.filter((p) => !p.liked), liked = sc.playlists.filter((p) => p.liked);
  el.artistList.innerHTML =
    (sc.searchQuery ? item("search", sc.tracks.get("search")?.length) : "") +
    item("likes", sc.tracks.get("likes")?.length) +
    (own.length ? group("Your playlists") + own.map((p) => item("pl:" + p.urn, p.count)).join("") : "") +
    (liked.length ? group("Liked playlists") + liked.map((p) => item("pl:" + p.urn, p.count)).join("") : "");
  el.artistsTitle.textContent = `SoundCloud · ${state.settings.soundcloud.username || "you"}`;
  renderScSongs();
}

function renderScSongs() {
  if (state.source !== "sc") return;
  const sc = state.sc;
  const list = sc.tracks.get(sc.current);
  const q = sc.filter;
  const tracks = (list || []).filter((t) => !q || [t.title, t.artist].some((s) => s.toLowerCase().includes(q)));
  el.songTable.classList.remove("one-artist");
  fillSongs(tracks, { hideAlbum: true, title: scListName(sc.current) });
  const note = !list ? (sc.loadingKey === sc.current ? "Loading from SoundCloud…" : sc.error || "Nothing here.")
    : !tracks.length ? (q ? "No matches." : "No songs here.") : "";
  if (note) {
    el.songBody.innerHTML = `<tr><td colspan="5" class="empty-note">${esc(note)}</td></tr>`;
    if (gridShown()) el.songGrid.innerHTML = `<div class="empty-note">${esc(note)}</div>`;
  }
}

function scSelect(key) {
  const sc = state.sc;
  sc.current = key;
  for (const x of el.artistList.children) x.classList.toggle("sel", x.dataset.key === key);
  renderScSongs();
  if (!sc.tracks.has(key) && sc.loadingKey !== key) scFetch(key);
}

async function scFetch(key) {
  const sc = state.sc;
  sc.loadingKey = key;
  sc.error = "";
  renderScSongs();
  try {
    let tracks;
    if (key === "likes") tracks = await invoke("sc_likes");
    else if (key === "search") tracks = await invoke("sc_search", { query: sc.searchQuery });
    else tracks = await invoke("sc_playlist_tracks", { urn: key.slice(3), title: scListName(key) });
    for (const t of tracks) t.scList = key;
    sc.tracks.set(key, tracks);
    if (key === "likes") {
      sc.liked = new Set(tracks.map((t) => t.urn));
      renderNowFav();
    }
  } catch (e) {
    sc.error = String(e);
    setStatus(String(e), 6000);
  } finally {
    if (sc.loadingKey === key) sc.loadingKey = null;
  }
  if (state.source === "sc") renderSc();
}

/** (Re)load the playlists and the list being shown. */
async function scLoad() {
  const sc = state.sc;
  sc.loaded = true;
  for (const key of [...sc.tracks.keys()]) if (key !== "search") sc.tracks.delete(key);
  setStatus("Loading SoundCloud…");
  try {
    sc.playlists = await invoke("sc_playlists");
    setStatus("", 0);
  } catch (e) {
    setStatus(String(e), 6000);
  }
  if (state.source === "sc") renderSc();
  if (!sc.tracks.has(sc.current)) await scFetch(sc.current);
  if (!sc.tracks.has("likes")) scFetch("likes"); // to know which songs are liked
}

function scSearch(query) {
  const sc = state.sc;
  sc.searchQuery = query;
  sc.tracks.delete("search");
  sc.filter = "";
  el.search.value = "";
  sc.current = "search";
  renderSc();
  scFetch("search");
}

function scReset() {
  Object.assign(state.sc, { liked: new Set(), playlists: [], current: "likes", searchQuery: "", filter: "", loaded: false, loadingKey: null, error: "" });
  state.sc.tracks.clear();
}

$("sc-refresh").addEventListener("click", () => scLoad());
$("sc-open-settings").addEventListener("click", () => showIntegration("sc"));

/** Show the playing SoundCloud song in its list. */
function jumpToScTrack(t) {
  closeSettings();
  if (state.source !== "sc") setSource("sc");
  showPane("songs");
  const sc = state.sc;
  sc.filter = "";
  el.search.value = "";
  if (sc.tracks.get(t.scList)?.some((x) => x.path === t.path)) sc.current = t.scList;
  renderSc();
  reveal(el.artistList, el.artistList.querySelector(".sel"), true);
  const i = state.shown.findIndex((x) => x.path === t.path);
  if (i >= 0) {
    selectRow(i);
    const node = revealSong(i);
    if (node) flash(node);
  }
}

// Playback: SoundCloud songs are downloaded to a local file first (see soundcloud.rs).
let scLoadId = 0;
async function loadScAudio(t, autoplay) {
  const id = ++scLoadId;
  audio.pause();
  audio.removeAttribute("src");
  audio.load();
  el.seek.max = t.duration || 0;
  el.dur.textContent = fmtTime(t.duration);
  if (t.access === "blocked") {
    setStatus(`“${t.title}” can only be played on SoundCloud itself`, 6000);
    if (autoplay && state.pos + 1 < state.order.length) setTimeout(() => next(true), 800);
    return;
  }
  document.body.classList.add("sc-loading");
  setStatus(`Loading “${t.title}”…`);
  try {
    const file = await invoke("sc_prepare", { urn: t.urn });
    if (id !== scLoadId) return; // another song was picked meanwhile
    setSrc(audio, file);
    measureGain(t, file);
    setStatus("", 0);
    if (autoplay) startPlayback();
    prefetchNext();
  } catch (e) {
    if (id !== scLoadId) return;
    setStatus(`Can't play “${t.title}”: ${e}`, 6000);
    if (autoplay && state.pos + 1 < state.order.length) setTimeout(() => next(true), 800);
  } finally {
    if (id === scLoadId) document.body.classList.remove("sc-loading");
  }
}

/** Start downloading the next SoundCloud song so it plays without a wait. */
function prefetchNext() {
  const n = state.queue[state.order[state.pos + 1]];
  if (n?.sc && n.access !== "blocked") invoke("sc_prepare", { urn: n.urn }).catch(() => {});
}

// Settings → Integrations → SoundCloud
let scWaiting = false;
let scBuiltin = false; // the shared SoundCloud app is available, no own keys needed
invoke("sc_builtin").then((on) => {
  scBuiltin = on;
  renderScSettings();
});
function renderScSettings() {
  const sc = state.settings.soundcloud || {};
  const connected = !!sc.accessToken;
  const ownKeys = !!(sc.clientId && sc.clientSecret);
  const status = $("sc-status");
  status.className = "hint" + (connected ? " ok" : "");
  status.textContent = connected ? `Connected as ${sc.username}${ownKeys ? " (your own app)" : ""}`
    : scWaiting ? (phone ? "Approve access in the browser, then come back here…" : "Approve access in the browser window that opened…")
    : ownKeys ? "Not connected — using your own app" : scBuiltin ? "Not connected" : "Add your Client ID and Client Secret below first.";
  if (!scBuiltin && !ownKeys && !phone) $("sc-own").open = true;
  $("sc-connect").hidden = connected || scWaiting;
  $("sc-connect").disabled = !ownKeys && !scBuiltin;
  $("sc-cancel").hidden = !scWaiting;
  $("sc-disconnect").hidden = !connected;
}

function scError(e) {
  $("sc-status").className = "hint err";
  $("sc-status").textContent = String(e);
}

$("sc-save").addEventListener("click", async () => {
  state.settings = await invoke("sc_set_keys", {
    clientId: $("sc-id").value, clientSecret: $("sc-secret").value, redirectUri: $("sc-redirect").value || SC_DEFAULT_REDIRECT,
  });
  if (!scConnected()) scReset();
  renderIntegrations();
  if (state.source === "sc") renderSc();
});
$("sc-connect").addEventListener("click", async () => {
  scWaiting = true;
  renderScSettings();
  try {
    state.settings = await invoke("sc_connect");
    scWaiting = false;
    scReset();
    renderIntegrations();
    if (state.source === "sc") setSource("sc");
  } catch (e) {
    scWaiting = false;
    renderScSettings();
    if (String(e) !== "Cancelled") scError(e);
  }
});
$("sc-cancel").addEventListener("click", () => invoke("sc_cancel"));
$("sc-disconnect").addEventListener("click", async () => {
  state.settings = await invoke("sc_disconnect");
  scReset();
  renderIntegrations();
  if (state.source === "sc") renderSc();
});
$("sc-copy-redirect").addEventListener("click", () => {
  navigator.clipboard.writeText($("sc-redirect").value || SC_DEFAULT_REDIRECT).then(() => setStatus("Redirect URI copied", 2000), () => $("sc-redirect").select());
});

// ----------------------------------- SoundCloud on a phone, signed in from a computer

// Computer: sign in once more in the browser, and show that login as a QR code for the phone.
const PHONE_HINT = $("sc-phone-status").textContent;
let phoneLinking = false;
function renderPhoneLink() {
  $("sc-phone").hidden = phoneLinking;
  $("sc-phone-cancel").hidden = !phoneLinking;
  if (phoneLinking) {
    $("sc-phone-status").className = "hint";
    $("sc-phone-status").textContent = "Approve access in the browser window that opened…";
  }
}
$("sc-phone").addEventListener("click", async () => {
  phoneLinking = true;
  renderPhoneLink();
  try {
    const link = await invoke("sc_link_phone");
    $("sc-phone-qr").src = link.qr;
    $("sc-phone-code").dataset.code = link.code;
    $("sc-phone-code").hidden = false;
    $("sc-phone-status").className = "hint ok";
    $("sc-phone-status").textContent = "Ready — scan the code with your phone.";
  } catch (e) {
    $("sc-phone-status").className = String(e) === "Cancelled" ? "hint" : "hint err";
    $("sc-phone-status").textContent = String(e) === "Cancelled" ? PHONE_HINT : String(e);
  } finally {
    phoneLinking = false;
    renderPhoneLink();
  }
});
$("sc-phone-cancel").addEventListener("click", () => invoke("sc_cancel"));
$("sc-phone-copy").addEventListener("click", () => copyText($("sc-phone-code").dataset.code, "Code copied — paste it in yuuricloud on your phone"));
$("sc-phone-done").addEventListener("click", () => {
  // the code is a login: don't leave it lying around
  $("sc-phone-code").hidden = true;
  $("sc-phone-qr").removeAttribute("src");
  delete $("sc-phone-code").dataset.code;
  $("sc-phone-status").className = "hint";
  $("sc-phone-status").textContent = PHONE_HINT;
});

// Phone: take the code, pasted here or from the camera opening a yuuricloud:// link.
function scLinked() {
  scReset();
  renderIntegrations();
  setStatus(`Signed in to SoundCloud as ${state.settings.soundcloud.username || "you"}`, 4000);
  if (state.source === "sc") setSource("sc");
}
$("sc-link").addEventListener("click", async () => {
  try {
    state.settings = await invoke("sc_link", { code: $("sc-link-code").value });
    $("sc-link-code").value = "";
    scLinked();
  } catch (e) {
    scError(e);
  }
});
listen("sc-linked", ({ payload }) => {
  state.settings = payload;
  scLinked();
});
listen("sc-link-failed", ({ payload }) => setStatus(String(payload), 6000));

// ------------------------------------------------------------- phone layout

/** Phones show one panel at a time: artists (or SoundCloud lists), then albums, then songs. */
const phoneQuery = matchMedia("(max-width: 599px), (max-width: 700px) and (max-height: 540px)"); // same as style.css
const phoneLayout = () => phone && phoneQuery.matches;
function showPane(pane) {
  document.body.dataset.pane = pane;
}
showPane("artists");
$("albums-back").addEventListener("click", () => showPane("artists"));
$("songs-back").addEventListener("click", () => showPane(state.source === "local" ? "albums" : "artists"));
$("albums-all").addEventListener("click", () => {
  state.album = null;
  for (const x of el.albumGrid.children) x.classList.remove("sel");
  renderSongs();
  showPane("songs");
});

if (phone) {
  // Music copied in with the Files app or Finder shows up when you come back to the app.
  document.addEventListener("visibilitychange", () => !document.hidden && sessionReady && rescan(false, true));

  // Hold a song (or a SoundCloud list) for the menu a right-click opens on a computer.
  let press = null;
  document.addEventListener("touchstart", (e) => {
    clearTimeout(press?.timer);
    press = null;
    const target = e.touches.length === 1 && e.target.closest("tr[data-i], .album[data-i], #artist-list li[data-key]");
    if (!target) return;
    const { clientX: x, clientY: y } = e.touches[0];
    press = { x, y, fired: false };
    press.timer = setTimeout(() => {
      press.fired = true;
      target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: x, clientY: y }));
    }, 500);
  }, { passive: true });
  document.addEventListener("touchmove", (e) => {
    const t = e.touches[0];
    if (press && Math.hypot(t.clientX - press.x, t.clientY - press.y) > 10) clearTimeout(press.timer);
  }, { passive: true });
  document.addEventListener("touchend", (e) => {
    clearTimeout(press?.timer);
    if (press?.fired) e.preventDefault(); // the menu is open: lifting the finger isn't a tap
    press = null;
  });
}

listen("scan-progress",({ payload: [done, total] }) => !quietScan && setStatus(`Scanning… ${done} / ${total}`));
document.addEventListener("contextmenu", (e) => e.preventDefault());

setNowCover("", "");
document.body.classList.add("paused");
load();

// ------------------------------------------------------- right-click menu

const ctx = $("ctx");
document.documentElement.appendChild(ctx);

/**
 * Interface size: zoom the whole webview, like Ctrl + / Ctrl − in a browser. (CSS zoom on the
 * page left the layout sized for 100%, so bigger sizes pushed the player bar off the window.)
 */
let appliedScale = 1;
function applyInterfaceSize() {
  if (phone) return; // pinch-free fixed size; the system text size applies instead
  const scale = Number(prefs.scale) || 1;
  if (scale === appliedScale) return;
  appliedScale = scale;
  window.__TAURI__.webview.getCurrentWebview().setZoom(scale).catch((e) => console.warn("Couldn't set the interface size", e));
}

/** Show a menu at (x, y). `items` are { label, icon, on, disabled, action } or "-" for a divider. */
function openMenu(x, y, title, items) {
  ctx.innerHTML = `<div class="title">${esc(title)}</div>` + items.map((it, i) => it === "-" ? "<hr>"
    : it.stars != null ? `<div class="menu-stars" data-i="${i}">${[1, 2, 3, 4, 5].map((n) => `<button data-star="${n}" class="${n <= it.stars ? "on" : ""}" title="${n} star${n > 1 ? "s" : ""}">★</button>`).join("")}</div>`
    : `<button data-i="${i}"${it.disabled ? " disabled" : ""}><svg class="${it.on ? "on" : ""}" viewBox="0 0 24 24"><use href="#${it.icon}"/></svg>${esc(it.label)}</button>`).join("");
  ctx.hidden = false;
  ctx.onclick = (e) => {
    const star = e.target.closest("[data-star]");
    if (star) {
      const it = items[star.parentElement.dataset.i], n = Number(star.dataset.star);
      closeMenu();
      return it.action(n === it.stars ? 0 : n);
    }
    const b = e.target.closest("button[data-i]");
    if (!b) return;
    closeMenu();
    items[b.dataset.i].action();
  };
  // keep it on screen
  const r = ctx.getBoundingClientRect();
  ctx.style.left = `${Math.max(4, Math.min(x, innerWidth - r.width - 4))}px`;
  ctx.style.top = `${Math.max(4, Math.min(y, innerHeight - r.height - 4))}px`;
}

function closeMenu() {
  ctx.hidden = true;
}
document.addEventListener("mousedown", (e) => !ctx.hidden && !ctx.contains(e.target) && closeMenu(), true);
document.addEventListener("keydown", (e) => e.key === "Escape" && closeMenu());
window.addEventListener("blur", closeMenu);
window.addEventListener("resize", closeMenu);
document.addEventListener("wheel", closeMenu, { passive: true });

function songMenu(t, i) {
  const items = [
    { label: "Play", icon: "i-play", disabled: t.access === "blocked", action: () => playShown(i) },
    { label: "Play next", icon: "i-queue", disabled: t.access === "blocked", action: () => playNext(t) },
    "-",
  ];
  if (t.sc) {
    const liked = state.sc.liked.has(t.urn);
    items.push(
      { label: liked ? "Unlike on SoundCloud" : "Like on SoundCloud", icon: liked ? "i-heart" : "i-heart-outline", on: liked, action: () => scToggleLike(t) },
      { label: "Open in browser", icon: "i-globe", disabled: !t.permalinkUrl, action: () => window.__TAURI__.opener.openUrl(t.permalinkUrl.split("?")[0]) },
      { label: "Copy link", icon: "i-link", disabled: !t.permalinkUrl, action: () => copyText(t.permalinkUrl.split("?")[0], "Link copied") },
    );
    if (!phone) {
      items.push(
        "-",
        canDownload(t)
          ? { label: t.downloadable ? "Download" : "Download with yt-dlp", icon: "i-download", action: () => queueDownloads([t]) }
          : { label: "Download (not allowed by the artist)", icon: "i-download", disabled: true },
      );
    }
    if (dl.current) items.push({ label: "Pause downloads", icon: "i-stop", action: stopDownloads });
  } else {
    const fav = state.favorites.has(t.path);
    items.push(
      { label: fav ? "Remove from favourites" : "Add to favourites", icon: fav ? "i-heart" : "i-heart-outline", on: fav, action: () => toggleFavorite(t) },
      ...(phone ? [] : [{ label: "Open file location", icon: "i-folder", action: () => invoke("reveal_file", { path: t.path }).catch((e) => setStatus(String(e), 5000)) }]),
      "-",
      ...playlistMenu([t]),
    );
    const pl = playlistOf(state.artist);
    if (pl && state.album === null) {
      const at = pl.songs.indexOf(t.path);
      items.push(
        { label: `Remove from “${pl.name}”`, icon: "i-stop", action: () => removeFromPlaylist(pl, t) },
        { label: "Move up", icon: "i-to-top", disabled: at <= 0, action: () => movePlaylistSong(pl, at, at - 1) },
        { label: "Move down", icon: "i-to-top", disabled: at < 0 || at >= pl.songs.length - 1, action: () => movePlaylistSong(pl, at, at + 1) },
      );
    }
    items.push("-", { label: "Start radio", icon: "i-random", action: () => startRadio(t) }, { stars: rating(t), action: (n) => setRating(t, n) },
      "-", { label: "Edit song info…", icon: "i-edit", action: () => openEditor(t) });
  }
  return items;
}

function onSongContextMenu(e) {
  const node = e.target.closest("tr[data-i], .album[data-i]");
  if (!node) return;
  e.preventDefault();
  const i = Number(node.dataset.i);
  const t = state.shown[i];
  if (!t) return;
  selectRow(i);
  const title = t.group ? `${t.username} · ${t.folder}` : t.slsk ? t.title : `${t.title} · ${t.artist}`;
  openMenu(e.clientX, e.clientY, title, t.slsk || t.group ? slskSongMenu(t) : songMenu(t, i));
}
el.songBody.addEventListener("contextmenu", onSongContextMenu);
el.songGrid.addEventListener("contextmenu", onSongContextMenu);

/** Put a song right after the playing one in the queue. */
function playNext(t) {
  if (!current()) {
    Object.assign(state, { queue: [t], order: [0], pos: 0 });
    playCurrent();
    return;
  }
  state.queue.push(t);
  state.order.splice(state.pos + 1, 0, state.queue.length - 1);
  setStatus(`“${t.title}” plays next`, 2500);
  if (t.sc) prefetchNext();
  renderQueue();
  saveSession();
}

// ------------------------------------------------------------- rename files
// Name song files from their info: "{track} - {title}" → "03 - Roygbiv.flac".

const renaming = { tracks: [], plan: [] };
const fileStem = (p) => baseName(p).replace(/\.[^.]+$/, "");
function renameTo(t, pattern) {
  const pad = (n) => (n ? String(n).padStart(2, "0") : "");
  const fields = { track: pad(t.trackNo), disc: t.discNo || 1, title: t.title, artist: t.artist, album: t.album, albumartist: t.albumArtist, year: t.year };
  return pattern.replace(/\{(\w+)\}/g, (m, k) => fields[k.toLowerCase()] ?? m)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/^[\s\-.]+|[\s.]+$/g, "").replace(/\s{2,}/g, " ").slice(0, 180);
}
function openRename(tracks) {
  closeMenu();
  renaming.tracks = [...tracks].sort(cmpTracks);
  $("rename-pattern").value = prefs.renamePattern || "{track} - {title}";
  $("rename-preset").value = "";
  $("rename").hidden = false;
  renderRename();
  $("rename-pattern").focus();
}
function renderRename() {
  const pattern = $("rename-pattern").value;
  const seen = new Map();
  renaming.plan = renaming.tracks.map((t) => {
    const name = renameTo(t, pattern);
    const key = (parentDir(t.path) + "/" + name + "." + fileFormat(t)).toLowerCase();
    seen.set(key, (seen.get(key) || 0) + 1);
    return { t, name, key };
  });
  let changes = 0, clashes = 0;
  $("rename-list").innerHTML = renaming.plan.map(({ t, name, key }) => {
    const same = name === fileStem(t.path), clash = !name || seen.get(key) > 1;
    if (clash) clashes++;
    else if (!same) changes++;
    return `<div class="rename-item${same ? " same" : ""}${clash ? " clash" : ""}"><span class="old" title="${esc(t.path)}">${esc(baseName(t.path))}</span><span class="arrow">→</span>` +
      `<span class="new">${esc(name ? `${name}.${fileFormat(t)}` : "(empty)")}</span></div>`;
  }).join("");
  $("rename-note").textContent = clashes ? `${countOf(clashes, "file")} would get the same name — add {track} or {disc}` : changes ? `${countOf(changes, "file")} to rename` : "Nothing to change";
  $("rename-ok").disabled = !!clashes || !changes;
}
$("rename-pattern").addEventListener("input", renderRename);
$("rename-preset").addEventListener("change", (e) => {
  if (!e.target.value) return;
  $("rename-pattern").value = e.target.value;
  e.target.value = "";
  renderRename();
});
$("rename-cancel").addEventListener("click", () => ($("rename").hidden = true));
$("rename").addEventListener("mousedown", (e) => e.target === $("rename") && ($("rename").hidden = true));
$("rename").addEventListener("keydown", (e) => e.key === "Escape" && ($("rename").hidden = true));
$("rename-ok").addEventListener("click", async () => {
  const renames = renaming.plan.filter(({ t, name }) => name && name !== fileStem(t.path)).map(({ t, name }) => ({ path: t.path, name }));
  if (!renames.length) return;
  setPref("renamePattern", $("rename-pattern").value);
  $("rename-ok").disabled = true;
  const playing = current();
  const resume = releasePlaying(renames.map((r) => r.path));
  let r;
  try {
    r = await invoke("rename_songs", { renames });
  } catch (e) {
    $("rename-note").textContent = String(e);
    $("rename-ok").disabled = false;
    return resume();
  }
  $("rename").hidden = true;
  // the songs now live at their new paths: follow them everywhere the app holds a path
  const moved = new Map(r.moved);
  for (const t of [...state.tracks, ...state.queue]) if (moved.has(t.path)) t.path = moved.get(t.path);
  state.favorites = new Set(r.settings.favorites || []);
  state.playlists = r.settings.playlists || [];
  plSets.clear();
  for (const [a, b] of moved) if (state.stats[a]) (state.stats[b] = state.stats[a]), delete state.stats[a];
  if (playing && moved.has(playing.path ?? "")) playing.path = moved.get(playing.path);
  resume();
  setStatus(r.failed.length ? `Renamed ${r.moved.length}; ${r.failed.length} couldn't be: ${r.failed[0]}` : `Renamed ${countOf(r.moved.length, "file")}`, 6000);
  await rescan(false);
});

// --------------------------------------------------------------- song radio
// Endless play from one song or artist: their songs, and songs by similar artists in the library
// (Last.fm's similar artists, or the same genre when Last.fm doesn't know them).

const radio = { on: false, pool: [], recent: [], name: "" };

async function startRadio(seed) {
  if (!seed || seed.sc) return;
  closeMenu();
  setStatus(`Starting ${seed.albumArtist} radio…`);
  const byArtist = new Map();
  for (const t of state.tracks) {
    const k = artistKey(t);
    if (!byArtist.has(k)) byArtist.set(k, []);
    byArtist.get(k).push(t);
  }
  const weights = new Map([[artistKey(seed), 4]]);
  try {
    const about = await invoke("about", { artist: seed.albumArtist, album: null });
    about.similar.forEach((n, i) => byArtist.has(n.toLowerCase()) && weights.set(n.toLowerCase(), Math.max(1, 3 - i / 4)));
  } catch {}
  if (weights.size < 3 && seed.genre) {
    for (const t of state.tracks) if (t.genre === seed.genre && !weights.has(artistKey(t))) weights.set(artistKey(t), 1);
  }
  radio.pool = [...weights].flatMap(([k, w]) => (byArtist.get(k) || []).map((t) => ({ t, w })));
  radio.recent = [seed.path];
  radio.name = seed.albumArtist;
  const first = [seed, ...radioPicks(9, seed)];
  playTracks(first, 0, true);
  radio.on = true;
  radio.queue = state.queue;
  setStatus(`${seed.albumArtist} radio · ${countOf(new Set(radio.pool.map((x) => artistKey(x.t))).size, "artist")}`, 4000);
}

/** `n` more songs: weighted by artist, no song again within 40, no artist twice in a row. */
function radioPicks(n, last) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const prevArtist = artistKey(out[out.length - 1] || last || { albumArtist: "" });
    let options = radio.pool.filter((x) => !radio.recent.includes(x.t.path) && artistKey(x.t) !== prevArtist);
    if (!options.length) options = radio.pool.filter((x) => !radio.recent.slice(-5).includes(x.t.path));
    if (!options.length) break;
    let r = Math.random() * options.reduce((s, x) => s + x.w, 0);
    const pick = options.find((x) => (r -= x.w) <= 0) || options[options.length - 1];
    out.push(pick.t);
    radio.recent.push(pick.t.path);
    if (radio.recent.length > 40) radio.recent.shift();
  }
  return out;
}

/** Near the end of a radio queue, add more. */
function radioTopUp() {
  if (!radio.on || state.queue !== radio.queue || state.pos < state.order.length - 3) return;
  for (const t of radioPicks(10, state.queue[state.order[state.order.length - 1]])) {
    state.queue.push(t);
    state.order.push(state.queue.length - 1);
  }
  renderQueue();
}

// ---------------------------------------------------------------- playlists

/** Ask for a name (or a yes) in a small dialog. Resolves to the text, true, or null if cancelled. */
function ask({ title, text = "", value = null, ok = "OK", danger = false }) {
  const box = $("ask");
  $("ask-title").textContent = title;
  $("ask-text").textContent = text;
  $("ask-text").hidden = !text;
  const input = $("ask-input");
  input.hidden = value === null;
  input.value = value ?? "";
  $("ask-ok").textContent = ok;
  $("ask-ok").classList.toggle("danger-accent", danger);
  box.hidden = false;
  setTimeout(() => (value === null ? $("ask-ok") : input).focus({ preventScroll: true }), 30);
  if (value !== null) input.select();
  return new Promise((resolve) => {
    const done = (answer) => {
      box.hidden = true;
      $("ask-ok").onclick = $("ask-cancel").onclick = input.onkeydown = box.onmousedown = null;
      resolve(answer);
    };
    $("ask-ok").onclick = () => (value === null ? done(true) : input.value.trim() && done(input.value.trim()));
    $("ask-cancel").onclick = () => done(null);
    input.onkeydown = (e) => {
      if (e.key === "Enter" && input.value.trim()) done(input.value.trim());
      if (e.key === "Escape") done(null);
    };
    box.onmousedown = (e) => e.target === box && done(null);
  });
}

async function savePlaylists() {
  state.playlists = await invoke("set_playlists", { playlists: state.playlists });
  plSets.clear();
  if (state.source !== "local") return;
  const scroll = [el.artistList.scrollTop, tableWrap().scrollTop];
  renderArtists();
  [el.artistList.scrollTop, tableWrap().scrollTop] = scroll;
}

/** "Add to …" items for a song menu (or an album's or artist's): one per playlist, and a new one. */
function playlistMenu(tracks) {
  const local = tracks.filter((t) => !t.sc && !t.slsk);
  if (!local.length) return [];
  const all = (p) => local.every((t) => plSet(p).has(t.path));
  return [
    ...state.playlists.map((p) => ({ label: `Add to “${p.name}”`, icon: "i-list", disabled: all(p), action: () => addToPlaylist(p, local) })),
    { label: "New playlist…", icon: "i-queue", action: () => newPlaylist(local) },
  ];
}

async function newPlaylist(tracks = []) {
  const name = await ask({ title: "New playlist", value: "", ok: "Create" });
  if (!name) return;
  const p = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name, songs: [] };
  state.playlists.push(p);
  if (tracks.length) await addToPlaylist(p, tracks, false);
  else await savePlaylists();
  setStatus(`Made the playlist “${name}”`, 2500);
}

// .m3u files, for other players
async function exportM3u(name, tracks) {
  const songs = tracks.filter((t) => !t.sc).map((t) => ({ path: t.path, title: t.title, artist: t.artist, duration: t.duration || 0 }));
  if (!songs.length) return setStatus("Nothing to save", 3000);
  try {
    const where = await invoke("export_m3u", { name, songs });
    if (where) setStatus(`Saved ${countOf(songs.length, "song")} to ${where}`, 5000);
  } catch (e) {
    setStatus(String(e), 5000);
  }
}
async function importM3u() {
  let r;
  try {
    r = await invoke("import_m3u");
  } catch (e) {
    return setStatus(String(e), 5000);
  }
  if (!r) return;
  if (!r.songs.length) return setStatus(`None of the ${countOf(r.missing, "song")} in “${r.name}” are in your library`, 6000);
  const p = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: r.name, songs: r.songs };
  state.playlists.push(p);
  await savePlaylists();
  state.artist = PL_PREFIX + p.id;
  renderArtists();
  showPane("songs");
  setStatus(`Made “${r.name}” with ${countOf(r.songs.length, "song")}` + (r.missing ? ` · ${r.missing} weren't found in your library` : ""), 6000);
}

async function addToPlaylist(p, tracks, say = true) {
  const have = plSet(p);
  const added = tracks.filter((t) => !have.has(t.path));
  p.songs.push(...added.map((t) => t.path));
  await savePlaylists();
  if (say) setStatus(added.length === 1 ? `Added “${added[0].title}” to “${p.name}”` : `Added ${added.length} songs to “${p.name}”`, 2500);
}

async function removeFromPlaylist(p, t) {
  p.songs = p.songs.filter((x) => x !== t.path);
  await savePlaylists();
  setStatus(`Removed “${t.title}” from “${p.name}”`, 2500);
}

async function movePlaylistSong(p, from, to) {
  const [song] = p.songs.splice(from, 1);
  p.songs.splice(to, 0, song);
  await savePlaylists();
  const i = state.shown.findIndex((t) => t.path === song);
  if (i >= 0) selectRow(i);
}

async function renamePlaylist(p) {
  const name = await ask({ title: "Rename playlist", value: p.name, ok: "Rename" });
  if (!name) return;
  p.name = name;
  await savePlaylists();
}

async function deletePlaylist(p) {
  if (!(await ask({ title: `Delete “${p.name}”?`, text: "The songs stay in your library.", ok: "Delete", danger: true }))) return;
  state.playlists = state.playlists.filter((x) => x !== p);
  if (state.artist === PL_PREFIX + p.id) state.artist = null;
  await savePlaylists();
}

/** The library songs of an album (by its index in the grid), in album order. */
const albumTracks = (i) => state.visible.filter((t) => albumKey(t) === state.albumKeys[i]).sort(cmpTracks);

// right-click (hold on a phone) an album
el.albumGrid.addEventListener("contextmenu", (e) => {
  const card = e.target.closest(".album[data-i]");
  if (!card || state.source !== "local") return;
  e.preventDefault();
  const tracks = albumTracks(Number(card.dataset.i));
  if (!tracks.length) return;
  openMenu(e.clientX, e.clientY, tracks[0].album, [
    { label: "Play", icon: "i-play", action: () => {
      state.album = state.albumKeys[card.dataset.i];
      renderSongs();
      showPane("songs");
      playShown(0);
    } },
    { label: "Play next", icon: "i-queue", action: () => [...tracks].reverse().forEach((t) => playNext(t)) },
    { label: "Album page", icon: "i-grid", action: () => openPage("album", state.albumKeys[card.dataset.i]) },
    "-",
    ...playlistMenu(tracks),
    "-",
    { label: "Edit album info…", icon: "i-edit", action: () => openAlbumEditor(tracks) },
    { label: "Rename files…", icon: "i-edit", action: () => openRename(tracks) },
  ]);
});

// right-click (hold) an artist or a playlist in the list on the left
el.artistList.addEventListener("contextmenu", (e) => {
  if (state.source !== "local") return;
  const li = e.target.closest("li[data-key]");
  if (!li || !li.dataset.key) return;
  e.preventDefault();
  const key = li.dataset.key;
  const songs = () => smartOf(key) ? [...smartList(key)] : state.visible.filter((t) => key === FAV_KEY ? state.favorites.has(t.path) : playlistOf(key) ? plSet(playlistOf(key)).has(t.path) : artistKey(t) === key).sort(cmpTracks);
  const play = { label: "Play", icon: "i-play", action: () => {
    li.click();
    showPane("songs");
    playShown(0);
  } };
  const p = playlistOf(key), smart = smartOf(key);
  const exportM3u = { label: "Save as .m3u…", icon: "i-download", action: () => exportM3u(li.title, songs()) };
  openMenu(e.clientX, e.clientY, li.title, p
    ? [play, "-", { label: "Rename…", icon: "i-edit", action: () => renamePlaylist(p) }, ...(phone ? [] : [exportM3u]), { label: "Delete playlist…", icon: "i-stop", action: () => deletePlaylist(p) }]
    : smart?.custom
    ? [play, "-", { label: "Change…", icon: "i-edit", action: () => editSmartList(smart) }, ...(phone ? [] : [exportM3u]), { label: "Delete smart list", icon: "i-stop", action: () => deleteSmartList(smart) }]
    : [play, ...(specialList(key) ? [] : [{ label: "Artist page", icon: "i-note", action: () => openPage("artist", key) }, { label: "Start radio", icon: "i-random", action: () => startRadio(songs()[0]) }]),
      "-", ...playlistMenu(songs())]);
});

/** Make a smart list from a search (or change one): any search the search box takes. */
async function editSmartList(old) {
  const query = await ask({
    title: old ? `Change “${old.name}”` : "New smart list",
    text: "The songs that match a search, kept up to date. For example: genre:jazz plays:0 · year:1990-1999 rating>=4 · added<30 flac · artist:\"Boards of Canada\" -live",
    value: old?.query ?? el.search.value.trim(), ok: "Next",
  });
  if (!query?.trim()) return;
  const name = await ask({ title: "Name it", value: old?.name ?? query.trim(), ok: old ? "Save" : "Create" });
  if (!name?.trim()) return;
  const lists = [...(prefs.smartLists || [])];
  if (old) lists[lists.findIndex((c) => c.id === old.id)] = { id: old.id, name: name.trim(), query: query.trim() };
  else lists.push({ id: "c" + Date.now().toString(36), name: name.trim(), query: query.trim() });
  setPref("smartLists", lists);
  if (!old) state.artist = SMART_PREFIX + lists[lists.length - 1].id;
  renderArtists();
  showPane("songs");
}
async function deleteSmartList(smart) {
  if (!(await ask({ title: `Delete “${smart.name}”?`, text: "The songs stay in your library.", ok: "Delete", danger: true }))) return;
  setPref("smartLists", (prefs.smartLists || []).filter((c) => c.id !== smart.id));
  if (state.artist === SMART_PREFIX + smart.id) state.artist = null;
  renderArtists();
}

async function setRating(t, n) {
  if (!t || t.sc) return;
  try {
    state.stats[t.path] = await invoke("set_rating", { path: t.path, rating: n });
  } catch (e) {
    return setStatus(String(e), 4000);
  }
  smartLists.clear();
  smartSets.clear();
  if (current()?.path === t.path) renderNowStars();
  setStatus(n ? `Rated ${t.title} ${"★".repeat(n)}` : `Took the rating off ${t.title}`, 2500);
}
// ------------------------------------------- now playing: speed, A–B loop, visualizer

const SPEEDS = [0.5, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 2];
let speed = 1;
function setSpeed(x) {
  speed = x;
  for (const p of players) {
    p.defaultPlaybackRate = p.playbackRate = x; // the default survives loading the next song
    p.preservesPitch = p.webkitPreservesPitch = prefs.keepPitch !== false;
  }
  renderNpTools();
  syncMediaPosition();
}

const ab = { a: null, b: null, path: null };
function cycleLoop() {
  const t = current();
  if (!t) return;
  if (ab.path !== t.path || (ab.a != null && ab.b != null)) Object.assign(ab, { a: null, b: null, path: t.path });
  if (ab.a == null) ab.a = audio.currentTime;
  else if (audio.currentTime > ab.a + 0.5) ab.b = audio.currentTime;
  else ab.a = audio.currentTime; // B must come after A: move A instead
  renderNpTools();
}
function clearLoop() {
  Object.assign(ab, { a: null, b: null, path: null });
  renderNpTools();
}
onAudio("timeupdate", () => {
  if (ab.b != null && ab.path === current()?.path && audio.currentTime >= ab.b) audio.currentTime = ab.a;
});

function renderNpTools() {
  const t = current();
  const looping = ab.path === t?.path && ab.a != null;
  $("np-speed").textContent = `${speed}×`;
  $("np-speed").classList.toggle("on", speed !== 1);
  $("np-loop").textContent = !looping ? "A–B loop" : ab.b == null ? `A ${fmtTime(ab.a)} → set B` : `${fmtTime(ab.a)} – ${fmtTime(ab.b)}`;
  $("np-loop").classList.toggle("on", looping);
  $("np-loop-clear").hidden = !looping;
  $("np-vis-btn").textContent = { off: "Visualizer: off", bars: "Visualizer: bars", wave: "Visualizer: wave" }[prefs.visualizer] || "Visualizer: off";
  $("np-vis-btn").classList.toggle("on", prefs.visualizer !== "off");
  $("np-lyr-edit").hidden = !t || !!t.sc;
}
$("np-speed").addEventListener("click", (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  openMenu(r.left, r.bottom + 4, "Speed", [
    ...SPEEDS.map((x) => ({ label: `${x}×${x === 1 ? " (normal)" : ""}`, icon: x === speed ? "i-check" : "i-blank", action: () => setSpeed(x) })),
    "-",
    { label: "Keep the pitch", icon: prefs.keepPitch !== false ? "i-check" : "i-blank", action: () => (setPref("keepPitch", prefs.keepPitch === false), setSpeed(speed)) },
  ]);
});
$("np-loop").addEventListener("click", cycleLoop);
$("np-loop-clear").addEventListener("click", clearLoop);
$("np-vis-btn").addEventListener("click", () => {
  const order = ["off", "bars", "wave"];
  setPref("visualizer", order[(order.indexOf(prefs.visualizer) + 1) % order.length]);
  applyEq();
  renderNpTools();
  drawVisualizer();
});

let visFrame = 0;
function drawVisualizer() {
  cancelAnimationFrame(visFrame);
  const c = $("np-vis");
  const on = npOpen() && prefs.visualizer !== "off" && graph?.analyser;
  c.hidden = !on;
  if (!on) return;
  const g = c.getContext("2d"), an = graph.analyser;
  const freq = new Uint8Array(an.frequencyBinCount), wave = new Uint8Array(an.fftSize);
  const frame = () => {
    if (!npOpen() || prefs.visualizer === "off") return (c.hidden = true);
    const dpr = devicePixelRatio || 1, w = c.clientWidth, h = c.clientHeight;
    if (c.width !== Math.round(w * dpr)) [c.width, c.height] = [Math.round(w * dpr), Math.round(h * dpr)];
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const color = getComputedStyle(document.documentElement).getPropertyValue("--accent-base").trim() || "#8b7cff";
    g.fillStyle = g.strokeStyle = color;
    if (prefs.visualizer === "bars") {
      an.getByteFrequencyData(freq);
      const n = Math.max(16, Math.min(96, Math.floor(w / 9))), gap = 2, bw = w / n - gap;
      const maxBin = Math.floor(freq.length * 0.75); // above ~16 kHz there's little to see
      for (let i = 0; i < n; i++) {
        // log-spaced, so the bass doesn't take a single bar
        const from = Math.floor(Math.pow(maxBin, i / n)), to = Math.max(from + 1, Math.floor(Math.pow(maxBin, (i + 1) / n)));
        let v = 0;
        for (let j = from; j < to; j++) v = Math.max(v, freq[j]);
        const bh = Math.max(2, (v / 255) ** 1.4 * h);
        g.globalAlpha = 0.35 + 0.55 * (v / 255);
        g.beginPath();
        g.roundRect(i * (bw + gap), h - bh, bw, bh, [Math.min(4, bw / 2), Math.min(4, bw / 2), 0, 0]);
        g.fill();
      }
    } else {
      an.getByteTimeDomainData(wave);
      g.globalAlpha = 0.8;
      g.lineWidth = 2;
      g.beginPath();
      for (let i = 0; i < wave.length; i += 4) {
        const x = (i / (wave.length - 1)) * w, y = h / 2 + ((wave[i] - 128) / 128) * (h / 2) * 0.9;
        i ? g.lineTo(x, y) : g.moveTo(x, y);
      }
      g.stroke();
    }
    g.globalAlpha = 1;
    visFrame = requestAnimationFrame(frame);
  };
  frame();
}

function renderNowStars() {
  const t = current();
  $("np-stars").hidden = !t || !!t.sc;
  if (!t || t.sc) return;
  const r = rating(t);
  $("np-stars").innerHTML = [1, 2, 3, 4, 5].map((n) => `<button data-star="${n}" class="${n <= r ? "on" : ""}" title="${n} star${n > 1 ? "s" : ""}">★</button>`).join("");
}
$("np-stars").addEventListener("click", (e) => {
  const b = e.target.closest("[data-star]");
  if (b) setRating(current(), Number(b.dataset.star) === rating(current()) ? 0 : Number(b.dataset.star));
});

/** Use a search, as if typed in the search box. */
function searchFor(q) {
  if (state.source !== "local") setSource("local");
  el.search.value = q;
  state.query = q.toLowerCase();
  applySearch();
  showPage(false);
}

/** Browse the library by its folders: `dir` is a folder in it, or empty for the top. */
function renderFoldersPage(dir) {
  const body = $("page-body");
  body.dataset.all = "folders";
  const roots = [...new Set(state.tracks.map((t) => t.root))].sort(collator.compare);
  if (!dir && roots.length === 1) dir = roots[0];
  const under = (t) => dir && t.path.length > dir.length && t.path.startsWith(dir) && /[\\/]/.test(t.path[dir.length]);
  const inside = dir ? state.tracks.filter(under) : state.tracks;
  const folders = new Map(); // folder path -> songs under it
  const here = [];
  for (const t of inside) {
    if (!dir) {
      if (!folders.has(t.root)) folders.set(t.root, 0);
      folders.set(t.root, folders.get(t.root) + 1);
      continue;
    }
    const rest = t.path.slice(dir.length + 1), cut = rest.search(/[\\/]/);
    if (cut < 0) here.push(t);
    else {
      const sub = dir + t.path[dir.length] + rest.slice(0, cut);
      folders.set(sub, (folders.get(sub) || 0) + 1);
    }
  }
  here.sort((a, b) => collator.compare(baseName(a.path), baseName(b.path)));
  pageSongs = here;
  pageAll = [...inside].sort((a, b) => collator.compare(a.path, b.path));
  pageAlbums = [];
  const name = dir ? baseName(dir) : "Folders";
  const subs = [...folders].sort((a, b) => collator.compare(a[0], b[0]));
  body.innerHTML =
    `<h1 class="page-h1">${esc(name)}</h1>` +
    (dir ? `<div class="hint path" title="${esc(dir)}">${esc(dir)}</div>` : "") +
    `<div class="page-actions"><button class="btn accent" data-act="play">Play all</button><button class="btn" data-act="shuffle">Shuffle</button>` +
    (dir && !phone ? `<button class="btn" data-folder-reveal>Open folder</button>` : "") + `</div>` +
    (subs.length ? `<div class="folder-rows">${subs.map(([f, n]) =>
      `<button class="folder-row" data-folder="${esc(f)}"><svg viewBox="0 0 24 24"><use href="#i-folder" /></svg><span>${esc(dir ? baseName(f) : f)}</span><small>${countOf(n, "song")}</small></button>`).join("")}</div>` : "") +
    (here.length ? `<div class="page-songs">${here.map((t, i) => pageSongRow(t, i, i + 1)).join("")}</div>` : "") +
    (!subs.length && !here.length ? `<p class="stat-empty">No songs here.</p>` : "");
  body.dataset.dir = dir || "";
}
$("page-body").addEventListener("click", (e) => {
  const f = e.target.closest("[data-folder]");
  if (f) return openPage("folders", f.dataset.folder);
  if (e.target.closest("[data-folder-reveal]")) {
    const t = pageAll[0];
    if (t) invoke("reveal_file", { path: t.path }).catch((err) => setStatus(String(err), 4000));
  }
});

function renderGenresPage() {
  const body = $("page-body");
  body.dataset.all = "genres";
  const counts = new Map();
  for (const t of state.tracks) if (t.genre) counts.set(t.genre, (counts.get(t.genre) || 0) + 1);
  const genres = [...counts].sort((a, b) => b[1] - a[1] || collator.compare(a[0], b[0]));
  const without = state.tracks.filter((t) => !t.genre).length;
  body.innerHTML = `<h1 class="page-h1">Genres</h1>` + (genres.length
    ? `<div class="genre-tiles">${genres.map(([g, n]) => `<button class="genre-tile" data-genre="${esc(g)}"><span>${esc(g)}</span><small>${countOf(n, "song")}</small></button>`).join("")}</div>` +
      (without ? `<p class="hint">${countOf(without, "song")} ${without === 1 ? "has" : "have"} no genre. <a href="#" data-genre="">Show them</a> — right-click an album → Edit album info to add one.</p>` : "")
    : `<p class="stat-empty">None of your songs have a genre in their tags yet. Right-click an album → Edit album info… to add one.</p>`);
}
$("page-body").addEventListener("click", (e) => {
  const g = e.target.closest("[data-genre]");
  if (!g) return;
  e.preventDefault();
  searchFor(g.dataset.genre ? `genre:"${g.dataset.genre}"` : `-genre:""`);
});

// ------------------------------------------------------ phone & computer

// Computer: "Let your phone connect" (share.rs), and reporting what's playing for the remote
let share = null; // { address, link, qr } while it's on
let shareTimer = null;
function renderPcSettings() {
  const pc = state.settings.computer || {};
  const status = $("pc-status");
  if (phone) {
    status.textContent = pc.address ? `Paired with ${pc.name}` : "Not paired";
    status.className = "hint" + (pc.address ? " ok" : "");
    $("pc-status-phone").textContent = pc.address ? `${pc.name} · ${pc.address}` : "Not paired";
    $("pc-status-phone").className = status.className;
    $("pc-unlink").hidden = !pc.address;
    $("pc-pair").hidden = !!pc.address;
    $("pc-actions").hidden = !pc.address;
    $("pc-favs-row").hidden = !pc.address;
    $("remote-btn").hidden = !pc.address;
    document.body.classList.toggle("paired", !!pc.address);
    return;
  }
  status.textContent = share ? `On · ${share.address}` : "Off";
  status.className = "hint" + (share ? " ok" : "");
  $("share-on").checked = !!share;
  $("share-code").hidden = !share;
  if (share) $("share-qr").src = share.qr;
}
$("share-on").addEventListener("change", async (e) => {
  try {
    share = await invoke("share_set", { on: e.target.checked });
  } catch (err) {
    share = null;
    setStatus(String(err), 6000);
  }
  clearInterval(shareTimer);
  if (share) {
    reportNow();
    shareTimer = setInterval(reportNow, 1000);
  }
  renderIntegrations();
});
$("share-copy").addEventListener("click", () => share && copyText(share.link, "Code copied — paste it in yuuricloud on your phone"));
function reportNow() {
  const t = current();
  invoke("remote_report", { now: t ? {
    path: t.path, title: t.title, artist: t.artist, album: t.album || "", cover: t.sc ? t.cover : "",
    playing: !audio.paused, position: audio.currentTime || 0, duration: audio.duration || t.duration || 0, volume: baseVolume,
    queue: remoteQueue(),
  } : {} }).catch(() => {});
}
/** The queue for the phone's remote: a few songs that played, the one playing and what's next. */
function remoteQueue() {
  const from = Math.max(0, state.pos - 3), to = Math.min(state.order.length, state.pos + 41);
  const items = [];
  for (let i = from; i < to; i++) {
    const t = state.queue[state.order[i]];
    if (t) items.push({ at: i, title: t.title, artist: t.artist });
  }
  return { pos: state.pos, total: state.order.length, items };
}
listen("remote-command", ({ payload: { command, value } }) => {
  if (command === "toggle") togglePlay();
  if (command === "next") next();
  if (command === "prev") prev();
  if (command === "seek" && value != null && current()) audio.currentTime = value;
  // a song in the queue, by its place in the playing order
  if (command === "jump" && value != null && value >= 0 && value < state.order.length && value !== state.pos) {
    state.pos = value;
    playCurrent();
  }
  if (command === "volume" && value != null) {
    baseVolume = Math.min(1, Math.max(0, value));
    el.volume.value = baseVolume;
    setRangeFill(el.volume);
    fadeId++;
    audio.volume = vol();
    invoke("set_volume", { volume: baseVolume });
  }
  setTimeout(reportNow, 150);
});

// Phone: pairing
async function pairComputer(code) {
  try {
    state.settings = await invoke("computer_link", { code });
    $("pc-code").value = "";
    setStatus(`Paired with ${state.settings.computer.name}`, 3000);
  } catch (e) {
    $("pc-status-phone").className = "hint err";
    $("pc-status-phone").textContent = String(e);
    return;
  }
  renderIntegrations();
}
$("pc-link").addEventListener("click", () => pairComputer($("pc-code").value));
$("pc-unlink").addEventListener("click", async () => {
  state.settings = await invoke("computer_unlink");
  renderIntegrations();
});
listen("computer-linked", ({ payload }) => {
  state.settings = payload;
  setStatus(`Paired with ${payload.computer.name}`, 3000);
  renderIntegrations();
});

// Phone: copying music from the computer
const copy = { library: null, picks: new Map(), busy: false }; // picks: key -> songs
const fmtSize = (n) => fmtBytes(n);
// The full-window views (a library page, copying music, the remote, now playing, downloads) take
// turns: opening one closes the others, so they never show on top of each other.
function closeViewsExcept(keep) {
  if (keep !== "page" && pageOpen()) showPage(false);
  if (keep !== "copy" && !$("copy").hidden) showCopy(false);
  if (keep !== "remote" && !$("remote").hidden) showRemote(false);
  if (keep !== "np" && npOpen()) showNowPlaying(false);
  if (keep !== "downloads" && !$("downloads").hidden) showDownloads(false);
}
/** The body classes that hide the library behind whichever view is open. */
function syncViewClasses() {
  const open = (id) => !$(id).hidden;
  document.body.classList.toggle("show-page", open("page") || open("copy") || open("remote"));
  document.body.classList.toggle("show-np", open("np"));
  document.body.classList.toggle("show-downloads", open("downloads"));
}

function showCopy(open) {
  if (open) closeViewsExcept("copy");
  const wasOpen = !$("copy").hidden;
  $("copy").hidden = !open;
  syncViewClasses();
  // a copy still going keeps its list: it's what's being copied
  if (open && !wasOpen && !copy.busy) loadCopyList();
}
$("pc-copy").addEventListener("click", () => {
  closeSettings();
  showCopy(true);
});
$("copy-close").addEventListener("click", () => !copy.busy && showCopy(false));

async function loadCopyList() {
  copy.picks.clear();
  $("copy-list").innerHTML = "";
  $("copy-note").textContent = `Looking at ${state.settings.computer.name}…`;
  try {
    copy.library = await invoke("computer_library");
  } catch (e) {
    $("copy-note").textContent = String(e);
    return;
  }
  const lib = copy.library, byId = new Map(lib.songs.map((t) => [t.id, t]));
  const ids = (list) => list.map((id) => byId.get(id)).filter(Boolean);
  const albums = new Map();
  for (const t of lib.songs) {
    const k = `${t.albumArtist}\0${t.album}`;
    if (!albums.has(k)) albums.set(k, []);
    albums.get(k).push(t);
  }
  copy.groups = [
    ...(lib.favorites.length ? [{ key: "fav", name: "♥ Favourites", songs: ids(lib.favorites) }] : []),
    ...lib.playlists.map((p, i) => ({ key: `pl${i}`, name: p.name, songs: ids(p.songs) })),
    ...[...albums.entries()].sort(([a], [b]) => collator.compare(a, b)).map(([k, songs], i) => ({ key: `al${i}`, name: songs[0].album, sub: songs[0].albumArtist, songs, album: true })),
  ];
  const row = (g) => `<label class="copy-row"><input type="checkbox" data-key="${g.key}" /><span class="copy-name">${esc(g.name)}${g.sub ? `<span class="hint"> · ${esc(g.sub)}</span>` : ""}</span>` +
    `<span class="hint">${countOf(g.songs.length, "song")} · ${fmtSize(g.songs.reduce((n, t) => n + t.size, 0))}</span></label>`;
  const lists = copy.groups.filter((g) => !g.album), albumRows = copy.groups.filter((g) => g.album);
  $("copy-list").innerHTML = (lists.length ? `<h2 class="page-section">Favourites and playlists</h2>${lists.map(row).join("")}` : "") +
    `<h2 class="page-section">Albums</h2>${albumRows.map(row).join("")}`;
  renderCopyTotal();
}
function chosenSongs() {
  const seen = new Map();
  for (const g of copy.groups || []) if (copy.picks.has(g.key)) for (const t of g.songs) seen.set(t.id, t);
  return [...seen.values()];
}
function renderCopyTotal() {
  const songs = chosenSongs();
  $("copy-note").textContent = songs.length
    ? `${countOf(songs.length, "song")} · ${fmtSize(songs.reduce((n, t) => n + t.size, 0))}. Songs already on this phone are skipped.`
    : `Pick what to copy from ${state.settings.computer.name}.`;
  $("copy-go").disabled = !songs.length && !$("copy-lists").checked;
}
$("copy-list").addEventListener("change", (e) => {
  const key = e.target.dataset.key;
  if (!key) return;
  e.target.checked ? copy.picks.set(key, true) : copy.picks.delete(key);
  renderCopyTotal();
});
$("copy-lists").addEventListener("change", renderCopyTotal);
$("copy-go").addEventListener("click", async () => {
  const songs = chosenSongs();
  copy.busy = true;
  $("copy-go").disabled = true;
  $("copy-cancel").hidden = false;
  $("copy-progress").hidden = false;
  let summary = "";
  try {
    if (songs.length) {
      const r = await invoke("computer_copy", { songs, favorites: copy.library?.favorites || [] });
      summary = `Copied ${countOf(r.copied, "song")}` + (r.skipped ? `, ${r.skipped} already on this phone` : "") + (r.failed ? `, ${r.failed} failed` : "") +
        (r.favoritedHere ? `. ${countOf(r.favoritedHere, "favourite")} from ${state.settings.computer?.name || "the computer"} marked here` : "") +
        (r.favoritedThere ? `. ${countOf(r.favoritedThere, "favourite")} from this phone marked on ${state.settings.computer?.name || "the computer"}` : "");
      await refreshAutoFolders();
      await rescan(false);
    }
    if ($("copy-lists").checked) {
      const r = await invoke("computer_lists");
      state.settings = r.settings;
      state.favorites = new Set(r.settings.favorites || []);
      state.playlists = r.settings.playlists || [];
      plSets.clear();
      applySearch();
      summary += `${summary ? ". " : ""}Brought ${countOf(r.imported.favorites, "favourite")} and ${countOf(r.imported.playlists, "playlist")}`;
    }
    $("copy-note").textContent = summary + ".";
  } catch (e) {
    $("copy-note").textContent = String(e) === "Cancelled" ? "Stopped." : String(e);
  } finally {
    copy.busy = false;
    $("copy-cancel").hidden = true;
    $("copy-progress").hidden = true;
    $("copy-go").disabled = false;
  }
});
$("copy-cancel").addEventListener("click", () => invoke("computer_cancel"));
listen("copy-progress", ({ payload: p }) => {
  $("copy-progress").firstElementChild.style.width = `${(p.bytes / Math.max(1, p.total)) * 100}%`;
  $("copy-note").textContent = `Copying song ${p.song + 1} of ${p.songs} · ${fmtSize(p.bytes)} of ${fmtSize(p.total)}`;
});

// Phone: the remote
let remoteTimer = null, remoteCover = { id: null, url: "" }, remoteSeeking = false;
function showRemote(open) {
  if (open) closeViewsExcept("remote");
  $("remote").hidden = !open;
  syncViewClasses();
  clearInterval(remoteTimer);
  if (open) {
    $("remote-from").textContent = state.settings.computer.name;
    pollRemote();
    remoteTimer = setInterval(pollRemote, 1000);
  }
}
$("pc-favs").addEventListener("click", async () => {
  const b = $("pc-favs"), status = $("pc-favs-status"), name = state.settings.computer?.name || "the computer";
  b.disabled = true;
  status.className = "hint";
  status.textContent = `Comparing with ${name}…`;
  try {
    const r = await invoke("computer_sync_favorites");
    state.favorites = new Set(r.favorites);
    state.settings.favorites = r.favorites;
    applySearch();
    renderNowFav();
    status.className = "hint ok";
    status.textContent = !r.shared ? `This phone and ${name} have no songs in common yet.`
      : !r.favoritedHere && !r.favoritedThere ? `Already in sync: ${countOf(r.shared, "song")} on both.`
      : [r.favoritedHere && `${countOf(r.favoritedHere, "favourite")} from ${name} marked here`, r.favoritedThere && `${countOf(r.favoritedThere, "favourite")} from this phone marked on ${name}`].filter(Boolean).join(" · ") + ".";
  } catch (e) {
    status.className = "hint err";
    status.textContent = String(e);
  }
  b.disabled = false;
});
$("pc-remote").addEventListener("click", () => {
  closeSettings();
  showRemote(true);
});
$("remote-btn").addEventListener("click", () => showRemote($("remote").hidden));
$("remote-close").addEventListener("click", () => showRemote(false));
// the queue starts closed every time the remote opens
new MutationObserver(() => $("remote").hidden && !$("remote-queue").hidden && showRemoteQueue(false)).observe($("remote"), { attributes: true, attributeFilter: ["hidden"] });
async function pollRemote() {
  let now;
  try {
    now = await invoke("computer_now");
  } catch (e) {
    $("remote-title").textContent = "Can't reach the computer";
    $("remote-artist").textContent = String(e);
    return;
  }
  $("remote-title").textContent = now.title || "Nothing playing";
  $("remote-artist").textContent = [now.artist, now.album].filter(Boolean).join(" — ");
  $("remote-play-icon").setAttribute("href", now.playing ? "#i-pause" : "#i-play");
  if (!remoteSeeking) {
    $("remote-seek").max = Math.round(now.duration || 0);
    $("remote-seek").value = Math.round(now.position || 0);
    setRangeFill($("remote-seek"));
  }
  $("remote-pos").textContent = fmtTime(now.position);
  $("remote-dur").textContent = fmtTime(now.duration);
  remoteNow = now;
  renderRemoteQueue();
  if (document.activeElement !== $("remote-volume")) {
    $("remote-volume").value = now.volume ?? 0.7;
    setRangeFill($("remote-volume"));
  }
  // the cover: SoundCloud artwork as it is, a library song's from the computer
  const key = now.cover || now.id || "";
  if (key !== remoteCover.id) {
    remoteCover = { id: key, url: now.cover || "" };
    if (!now.cover && now.id) remoteCover.url = await invoke("computer_cover", { id: now.id }).catch(() => "");
    $("remote-cover").innerHTML = coverHtml(remoteCover.url, now.album || now.title || "");
    $("remote-bg").innerHTML = remoteCover.url ? `<img src="${esc(remoteCover.url)}" alt="">` : "";
  }
}
// the computer's queue, on the phone
let remoteNow = null, remoteQueueShown = "";
function renderRemoteQueue() {
  if ($("remote-queue").hidden) return;
  const q = remoteNow?.queue;
  if (!q?.items?.length) {
    $("remote-queue-sub").textContent = "";
    $("remote-queue-list").innerHTML = `<p class="hint queue-empty">Nothing queued on the computer.</p>`;
    remoteQueueShown = "";
    return;
  }
  const ahead = q.total - q.pos - 1;
  $("remote-queue-sub").textContent = ahead ? `${countOf(ahead, "song")} up next` : "Last song";
  const key = JSON.stringify(q);
  if (key === remoteQueueShown) return; // unchanged: leave the list (and where it's scrolled) alone
  const first = remoteQueueShown === "";
  remoteQueueShown = key;
  $("remote-queue-list").innerHTML = q.items.map((it) =>
    `<button class="queue-item${it.at === q.pos ? " now" : it.at < q.pos ? " past" : ""}" data-at="${it.at}">` +
    `<span class="queue-text"><span class="name">${esc(it.title)}</span><span class="sub">${esc(it.artist)}</span></span>` +
    (it.at === q.pos ? `<svg viewBox="0 0 24 24"><use href="#i-play" /></svg>` : "") + `</button>`).join("") +
    (q.total > q.items[q.items.length - 1].at + 1 ? `<p class="hint queue-empty">and ${countOf(q.total - q.items[q.items.length - 1].at - 1, "more song")}</p>` : "");
  if (first) $("remote-queue-list").querySelector(".now")?.scrollIntoView({ block: "center" });
}
function showRemoteQueue(open) {
  $("remote-queue").hidden = !open;
  $("remote-queue-btn").classList.toggle("on", open);
  remoteQueueShown = "";
  renderRemoteQueue();
}
$("remote-queue-btn").addEventListener("click", () => showRemoteQueue($("remote-queue").hidden));
$("remote-queue-close").addEventListener("click", () => showRemoteQueue(false));
$("remote-queue-list").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-at]");
  if (!b || b.classList.contains("now")) return;
  await invoke("computer_remote", { command: "jump", value: Number(b.dataset.at) }).catch((err) => setStatus(String(err), 4000));
  setTimeout(pollRemote, 250);
});

$("remote").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-remote]");
  if (!b) return;
  await invoke("computer_remote", { command: b.dataset.remote, value: null }).catch((err) => setStatus(String(err), 4000));
  setTimeout(pollRemote, 200);
});
$("remote-seek").addEventListener("input", () => {
  remoteSeeking = true;
  setRangeFill($("remote-seek"));
});
$("remote-seek").addEventListener("change", async () => {
  await invoke("computer_remote", { command: "seek", value: Number($("remote-seek").value) }).catch(() => {});
  remoteSeeking = false;
});
$("remote-volume").addEventListener("change", () => invoke("computer_remote", { command: "volume", value: Number($("remote-volume").value) }).catch(() => {}));

// ------------------------------------------------------ artist & album pages

const pageStack = []; // [{ kind: "artist" | "album", key }], the last one shown
const pageOpen = () => !$("page").hidden;
function showPage(open) {
  if (open) closeViewsExcept("page");
  $("page").hidden = !open;
  syncViewClasses();
  if (!open) pageStack.length = 0;
}
function openPage(kind, key) {
  if (npOpen()) showNowPlaying(false);
  showDownloads(false);
  closeSettings();
  if (state.source !== "local") setSource("local");
  pageStack.push({ kind, key });
  showPage(true);
  renderPage();
}
function pageBack() {
  pageStack.pop();
  if (pageStack.length) renderPage();
  else showPage(false);
}
$("page-close").addEventListener("click", pageBack);
document.addEventListener("keydown", (e) => e.key === "Escape" && pageOpen() && $("settings").hidden && $("ask").hidden && pageBack());
$("source").addEventListener("click", () => showPage(false), true);

const totalTime = (ts) => fmtTime(ts.reduce((s, t) => s + (t.duration || 0), 0));
const countOf = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

function pageSongRow(t, i, number) {
  const playing = current()?.path === t.path;
  return `<div class="page-song${playing ? " playing" : ""}" data-i="${i}"><span class="n">${playing && prefs.equalizer ? EQ_HTML : number}</span>` +
    `<span class="t">${esc(t.title)}${isFav(t) ? '<svg class="heart" style="display:inline-block"><use href="#i-heart" /></svg>' : ""}</span>` +
    `<span class="a">${esc(t.artist)}</span><span class="d">${fmtTime(t.duration)}</span></div>`;
}

function renderPage() {
  const top = pageStack[pageStack.length - 1];
  if (!top) return;
  $("page-close").title = pageStack.length > 1 ? "Back (Esc)" : "Close (Esc)";
  $("page-back-icon").setAttribute("href", pageStack.length > 1 ? "#i-back" : "#i-close");
  if (top.kind === "artist") renderArtistPage(top.key);
  else if (top.kind === "stats") renderStatsPage();
  else if (top.kind === "dupes") renderDupesPage();
  else if (top.kind === "genres") renderGenresPage();
  else if (top.kind === "folders") renderFoldersPage(top.key);
  else renderAlbumPage(top.key);
  $("page").scrollTop = 0;
}

let pageSongs = []; // the songs listed on the page, for clicks
let pageAlbums = []; // the album keys in the page's grid

function renderArtistPage(key) {
  const tracks = state.tracks.filter((t) => artistKey(t) === key).sort(cmpTracks);
  if (!tracks.length) return pageBack();
  const name = tracks[0].albumArtist;
  const groups = new Map();
  for (const t of tracks) {
    const k = albumKey(t);
    if (!groups.has(k)) groups.set(k, { album: t.album, year: t.year, cover: thumbOf(t), count: 0 });
    const g = groups.get(k);
    g.count++;
    g.cover ||= thumbOf(t);
    g.year ||= t.year;
  }
  pageAlbums = [...groups.keys()].sort((a, b) => cmpYear(groups.get(b).year, groups.get(a).year)); // newest first
  const played = tracks.filter(plays);
  const top = (played.length ? [...played].sort((a, b) => plays(b) - plays(a)) : tracks).slice(0, 5);
  pageSongs = top;
  const playsTotal = tracks.reduce((s, t) => s + plays(t), 0);
  const hero = groups.get(pageAlbums[0])?.cover;
  $("page-body").innerHTML =
    `<header class="page-head">${coverHtml(hero, name).replace('class="cover"', 'class="cover page-art round"')}` +
    `<div class="page-title"><div class="page-kind">Artist</div><h1>${esc(name)}</h1>` +
    `<div class="hint">${[countOf(groups.size, "album"), countOf(tracks.length, "song"), totalTime(tracks), playsTotal && countOf(playsTotal, "play")].filter(Boolean).join(" · ")}</div>` +
    `<div class="page-actions"><button class="btn accent" data-act="play">Play</button><button class="btn" data-act="shuffle">Shuffle</button></div>` +
    `<div id="page-tags" class="page-tags"></div></div></header>` +
    `<p id="page-about" class="page-about"></p>` +
    `<h2 class="page-section">${played.length ? "Most played" : "Songs"}</h2><div class="page-songs">${top.map((t, i) => pageSongRow(t, i, i + 1)).join("")}</div>` +
    `<h2 class="page-section">Albums</h2><div class="grid page-albums">${pageAlbums.map((k, i) => {
      const g = groups.get(k);
      return `<div class="album" data-album="${i}" style="--i:${i}">${coverHtml(g.cover, g.album)}<div class="name">${esc(g.album)}</div><div class="sub">${esc(g.year || countOf(g.count, "song"))}</div></div>`;
    }).join("")}</div>` +
    `<div id="page-similar"></div>`;
  $("page-body").dataset.all = "artist";
  pageAll = tracks;
  loadAbout(name, null);
}

function renderAlbumPage(key) {
  const tracks = state.tracks.filter((t) => albumKey(t) === key).sort(cmpTracks);
  if (!tracks.length) return pageBack();
  const t0 = tracks[0];
  const multiDisc = new Set(tracks.map((t) => t.discNo)).size > 1;
  pageSongs = tracks;
  pageAll = tracks;
  pageAlbums = [];
  $("page-body").innerHTML =
    `<header class="page-head">${coverHtml(tracks.find((t) => t.cover)?.cover, t0.album).replace('class="cover"', 'class="cover page-art"')}` +
    `<div class="page-title"><div class="page-kind">Album</div><h1>${esc(t0.album)}</h1>` +
    `<div class="hint"><a href="#" class="page-artist" data-artist="${esc(artistKey(t0))}">${esc(t0.albumArtist)}</a>${t0.year ? " · " + esc(t0.year) : ""} · ${countOf(tracks.length, "song")} · ${totalTime(tracks)}</div>` +
    `<div class="page-actions"><button class="btn accent" data-act="play">Play</button><button class="btn" data-act="shuffle">Shuffle</button><button class="btn" data-act="add">Add to playlist…</button></div>` +
    `<div id="page-tags" class="page-tags"></div></div></header>` +
    `<p id="page-about" class="page-about"></p>` +
    `<div class="page-songs">${tracks.map((t, i) => pageSongRow(t, i, multiDisc ? `${t.discNo}-${t.trackNo}` : t.trackNo || i + 1)).join("")}</div>`;
  loadAbout(t0.albumArtist, t0.album);
}
let pageAll = [];

// ------------------------------------------------------------- listening stats
// Made from the listening history (history.jsonl, see logListen): time listened, top artists,
// songs and albums for a week, month, year or everything.

const stats = { history: null, range: "month" };
const STAT_RANGES = { week: "This week", month: "This month", year: "This year", all: "All time" };
const DAY = 86400;

function openStats() {
  openPage("stats");
}

function rangeStart(range) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  if (range === "week") d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // since Monday
  else if (range === "month") d.setDate(1);
  else if (range === "year") d.setMonth(0, 1);
  else return 0;
  return d.getTime() / 1000;
}

/** "3 h 20 min", "45 min" */
function fmtListened(secs) {
  const m = Math.round(secs / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return h >= 100 ? `${h.toLocaleString()} h` : `${h} h${m % 60 ? ` ${m % 60} min` : ""}`;
}

/** Listened seconds per day / month / year, as bars [{label, title, secs}]. */
function statBars(list, range) {
  const from = rangeStart(range);
  const bars = [];
  const key = (d) => (range === "year" || range === "allMonths" ? `${d.getFullYear()}-${d.getMonth()}` : range === "allYears" ? `${d.getFullYear()}` : d.toDateString());
  if (range === "all") {
    const first = list.length ? new Date(list[0].at * 1000) : new Date();
    const months = (new Date().getFullYear() - first.getFullYear()) * 12 + new Date().getMonth() - first.getMonth();
    return statBars(list, months > 24 ? "allYears" : "allMonths");
  }
  const now = new Date();
  if (range === "week" || range === "month") {
    const end = range === "week" ? 7 : new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    for (let i = 0; i < end; i++) {
      const d = new Date(from * 1000);
      d.setDate(d.getDate() + i);
      bars.push({ key: key(d), label: range === "week" ? d.toLocaleDateString(undefined, { weekday: "short" }) : String(d.getDate()),
        title: d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" }), secs: 0, future: d > now });
    }
  } else if (range === "year" || range === "allMonths") {
    const start = range === "year" ? new Date(now.getFullYear(), 0, 1) : new Date(list[0]?.at * 1000 || now);
    const d = new Date(start.getFullYear(), start.getMonth(), 1);
    const last = range === "year" ? new Date(now.getFullYear(), 11, 1) : new Date(now.getFullYear(), now.getMonth(), 1);
    for (; d <= last; d.setMonth(d.getMonth() + 1)) {
      bars.push({ key: key(d), label: d.toLocaleDateString(undefined, { month: "short" }),
        title: d.toLocaleDateString(undefined, { month: "long", year: "numeric" }), secs: 0, future: d > now });
    }
  } else {
    for (let y = new Date(list[0].at * 1000).getFullYear(); y <= now.getFullYear(); y++) bars.push({ key: String(y), label: String(y), title: String(y), secs: 0 });
  }
  const byKey = new Map(bars.map((b) => [b.key, b]));
  for (const l of list) {
    const b = byKey.get(key(new Date(l.at * 1000)));
    if (b) b.secs += l.secs;
  }
  return bars;
}

/** Top entries of a list of listens grouped by `keyOf`, by time listened. */
function topBy(list, keyOf, n = 10) {
  const groups = new Map();
  for (const l of list) {
    const k = keyOf(l);
    if (!k) continue;
    if (!groups.has(k)) groups.set(k, { first: l, secs: 0, plays: 0 });
    const g = groups.get(k);
    g.secs += l.secs;
    g.plays++;
  }
  return [...groups.values()].sort((a, b) => b.secs - a.secs).slice(0, n);
}

/** Most days in a row with some listening, ending at the last day listened. */
function longestStreak(list) {
  const days = [...new Set(list.map((l) => Math.floor((l.at - new Date(l.at * 1000).getTimezoneOffset() * 60) / DAY)))].sort((a, b) => a - b);
  let best = 0, run = 0;
  days.forEach((d, i) => {
    run = i && d === days[i - 1] + 1 ? run + 1 : 1;
    best = Math.max(best, run);
  });
  return best;
}

async function renderStatsPage() {
  const body = $("page-body");
  body.dataset.all = "stats";
  if (!stats.history) {
    body.innerHTML = `<h1 class="page-h1">Listening stats</h1><p class="hint">Loading…</p>`;
    stats.history = (await invoke("get_history").catch(() => [])) || [];
    if (pageStack[pageStack.length - 1]?.kind !== "stats") return;
  }
  const from = rangeStart(stats.range);
  const list = stats.history.filter((l) => l.at >= from).sort((a, b) => a.at - b.at);
  const total = list.reduce((s, l) => s + l.secs, 0);
  const libraryByPath = new Map(state.tracks.map((t) => [t.path, t]));
  const artistsInLibrary = new Set(state.tracks.map(artistKey));
  const lc = (x) => (x || "").toLowerCase();
  const artists = topBy(list, (l) => lc(l.artist));
  const songs = topBy(list, (l) => l.path);
  const albums = topBy(list.filter((l) => l.album), (l) => lc(l.artist) + "\0" + lc(l.album), 6);
  const bars = statBars(list, stats.range);
  const maxBar = Math.max(1, ...bars.map((b) => b.secs));
  const busiest = topBy(list, (l) => new Date(l.at * 1000).toDateString(), 1)[0];
  const hours = topBy(list, (l) => String(new Date(l.at * 1000).getHours()), 1)[0];
  const tile = (value, label) => `<div class="stat-tile"><div class="stat-value">${esc(value)}</div><div class="stat-label">${esc(label)}</div></div>`;

  pageSongs = songs.map((g) => libraryByPath.get(g.first.path)).filter(Boolean);
  pageAll = pageSongs;
  pageAlbums = albums.map((g) => libraryByPath.get(g.first.path)).map((t) => t && albumKey(t));
  body.innerHTML =
    `<header class="stats-head"><h1 class="page-h1">Listening stats</h1>` +
    `<div class="segmented stat-range">${Object.entries(STAT_RANGES).map(([k, v]) => `<button data-range="${k}" class="${k === stats.range ? "on" : ""}">${v}</button>`).join("")}</div></header>` +
    (list.length
      ? `<div class="stat-tiles">${tile(fmtListened(total), "listened")}${tile(list.length.toLocaleString(), list.length === 1 ? "song played" : "songs played")}` +
        `${tile(new Set(list.map((l) => lc(l.artist))).size.toLocaleString(), "artists")}` +
        (stats.range === "week" ? "" : tile(countOf(longestStreak(list), "day"), "longest streak")) +
        (busiest && stats.range !== "week" ? tile(new Date(busiest.first.at * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short" }), `busiest day · ${fmtListened(busiest.secs)}`) : "") +
        (hours ? tile(new Date(2000, 0, 1, Number(new Date(hours.first.at * 1000).getHours())).toLocaleTimeString(undefined, { hour: "numeric" }), "favourite hour") : "") +
        `</div>` +
        `<div class="stat-chart" role="img" aria-label="Time listened per ${bars.length > 12 ? "day" : "period"}">${bars.map((b) =>
          `<div class="stat-bar${b.future ? " future" : ""}" data-tip="${esc(`${b.title}: ${b.secs ? fmtListened(b.secs) : "nothing"}`)}">` +
          `<i style="height:${b.secs ? Math.max(3, (b.secs / maxBar) * 100) : 0}%"></i><span>${esc(bars.length > 16 && (Number(b.label) - 1) % 5 ? "" : b.label)}</span></div>`).join("")}` +
        `<div id="stat-tip" class="stat-tip" hidden></div></div>` +
        `<div class="stat-cols"><section><h2 class="page-section">Top artists</h2><ol class="stat-list">${artists.map((g) =>
          `<li><span class="stat-name">${artistsInLibrary.has(lc(g.first.artist)) ? `<a href="#" data-artist="${esc(lc(g.first.artist))}">${esc(g.first.artist)}</a>` : esc(g.first.artist || "Unknown")}</span>` +
          `<span class="stat-meter"><i style="width:${(g.secs / artists[0].secs) * 100}%"></i></span><span class="stat-num">${fmtListened(g.secs)}</span></li>`).join("")}</ol></section>` +
        `<section><h2 class="page-section">Top songs</h2><ol class="stat-list">${songs.map((g) => {
          const i = pageSongs.indexOf(libraryByPath.get(g.first.path));
          return `<li${i >= 0 ? ` class="page-song-link" data-song="${i}"` : ""}><span class="stat-name">${esc(g.first.title)}<small>${esc(g.first.artist)}</small></span>` +
            `<span class="stat-num">${countOf(g.plays, "play")}</span></li>`;
        }).join("")}</ol></section></div>` +
        (albums.length ? `<h2 class="page-section">Top albums</h2><div class="grid page-albums">${albums.map((g, i) => {
          const t = libraryByPath.get(g.first.path);
          return `<div class="album"${pageAlbums[i] ? ` data-album="${i}"` : ""} style="--i:${i}">${coverHtml(t && thumbOf(t), g.first.album)}<div class="name">${esc(g.first.album)}</div><div class="sub">${esc(g.first.artist)} · ${fmtListened(g.secs)}</div></div>`;
        }).join("")}</div>` : "")
      : `<p class="stat-empty">${stats.history.length ? `Nothing played ${STAT_RANGES[stats.range].toLowerCase()} yet.` : "Nothing here yet — songs show up once you've listened to them for a bit."}</p>`);
}

$("page-body").addEventListener("click", (e) => {
  const r = e.target.closest("[data-range]");
  if (r) {
    stats.range = r.dataset.range;
    renderStatsPage();
  }
  const song = e.target.closest("[data-song]");
  if (song) playTracks(pageSongs, Number(song.dataset.song));
});
// the bar chart's tooltip
$("page-body").addEventListener("pointermove", (e) => {
  const tip = $("stat-tip");
  if (!tip) return;
  const bar = e.target.closest(".stat-bar");
  for (const b of document.querySelectorAll(".stat-bar.hover")) b !== bar && b.classList.remove("hover");
  if (!bar) return (tip.hidden = true);
  bar.classList.add("hover");
  tip.textContent = bar.dataset.tip;
  tip.hidden = false;
  const box = tip.parentElement.getBoundingClientRect(), r = bar.getBoundingClientRect();
  tip.style.left = `${Math.min(box.width - tip.offsetWidth, Math.max(0, r.left - box.left + r.width / 2 - tip.offsetWidth / 2))}px`;
});
$("page-body").addEventListener("pointerleave", () => $("stat-tip") && ($("stat-tip").hidden = true));

// ---------------------------------------------------------------- duplicates
// The same song more than once in the library: same artist and title (ignoring case, "feat."
// and bracketed bits like "(Remastered)") and nearly the same length.

const dupes = { groups: [] };
function songIdentity(t) {
  const clean = (x) => (x || "").toLowerCase().replace(/[([].*?[)\]]/g, "").replace(/\s(feat|ft)\.?\s.*$/, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return clean(t.artist) + "\0" + clean(t.title);
}
function findDuplicates() {
  const by = new Map();
  for (const t of state.tracks) {
    const k = songIdentity(t);
    if (!k.split("\0")[1]) continue;
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(t);
  }
  const groups = [];
  for (const list of by.values()) {
    if (list.length < 2) continue;
    // split songs of clearly different lengths (a live or extended version is a different song)
    list.sort((a, b) => (a.duration || 0) - (b.duration || 0));
    let cur = [list[0]];
    for (const t of list.slice(1)) {
      if (Math.abs((t.duration || 0) - (cur[cur.length - 1].duration || 0)) <= 3) cur.push(t);
      else (cur.length > 1 && groups.push(cur), (cur = [t]));
    }
    if (cur.length > 1) groups.push(cur);
  }
  return groups.sort((a, b) => cmpName(a[0].artist, b[0].artist) || cmpName(a[0].title, b[0].title));
}
const extOf = (p) => (p.match(/\.([a-z0-9]+)$/i)?.[1] || "").toUpperCase();

const dupeQuality = new Map(); // path -> { label, score, size }
/** The copy of a group that would be kept: the best quality, then the biggest file. */
function bestCopy(g) {
  const q = (t) => dupeQuality.get(t.path) || { score: 0, size: 0 };
  return g.reduce((a, b) => (q(b).score > q(a).score || (q(b).score === q(a).score && q(b).size > q(a).size) ? b : a));
}

function renderDupesPage() {
  const body = $("page-body");
  body.dataset.all = "dupes";
  dupes.groups = findDuplicates();
  pageSongs = dupes.groups.flat();
  pageAll = pageSongs;
  pageAlbums = [];
  const extra = dupes.groups.reduce((s, g) => s + g.length - 1, 0);
  const missing = pageSongs.filter((t) => !dupeQuality.has(t.path));
  if (missing.length) {
    // find out each file's format and quality, then show which copy is the best
    invoke("song_quality", { paths: missing.map((t) => t.path) }).then((q) => {
      for (const [p, v] of Object.entries(q || {})) dupeQuality.set(p, v);
      if (pageStack[pageStack.length - 1]?.kind === "dupes") renderDupesPage();
    }, () => {});
  }
  const ready = !missing.length;
  let i = 0;
  body.innerHTML = `<header class="stats-head"><h1 class="page-h1">Duplicates</h1>` +
    (dupes.groups.length ? `<button class="btn accent" data-dupe-all ${ready ? "" : "disabled"}>Remove all duplicates</button>` : "") + `</header>` +
    (dupes.groups.length
      ? `<p class="hint">${countOf(dupes.groups.length, "song")} ${dupes.groups.length === 1 ? "is" : "are"} in the library more than once (${countOf(extra, "extra copy").replace("copys", "copies")}). ` +
        `<b>Remove all duplicates</b> keeps the best copy of each — lossless before lossy, then the highest quality — and ${phone ? "deletes" : "moves to the bin"} the rest. ` +
        `Favourites, playlists, ratings and play counts go to the copy that's kept.</p>` +
        dupes.groups.map((g) => {
          const keep = ready ? bestCopy(g) : null;
          return `<div class="dupe-group"><div class="dupe-title">${esc(g[0].title)} <span class="hint">${esc(g[0].artist)}</span></div>` +
            g.map((t) => `<div class="dupe-row${t === keep ? " keep" : ""}" data-i="${i++}"><button class="icon-btn" data-dupe="play" title="Play"><svg viewBox="0 0 24 24"><use href="#i-play" /></svg></button>` +
              `<div class="dupe-file"><div>${esc(t.album || "No album")} <span class="tag">${esc(dupeQuality.get(t.path)?.label || extOf(t.path))}</span> <span class="hint">${fmtTime(t.duration)}</span>` +
              (t === keep ? ` <span class="tag best">Best · kept</span>` : "") + `</div>` +
              `<div class="hint path" title="${esc(t.path)}">${esc(t.path)}</div></div>` +
              (phone ? "" : `<button class="btn" data-dupe="reveal">Show</button>`) +
              `<button class="btn danger" data-dupe="delete">Delete</button></div>`).join("") + `</div>`;
        }).join("")
      : `<p class="stat-empty">No duplicates — every song is in the library once.</p>`);
}

/** Keep the best copy of every duplicated song and delete the rest. */
async function removeAllDuplicates() {
  const groups = dupes.groups.filter((g) => g.length > 1);
  const extra = groups.reduce((s, g) => s + g.length - 1, 0);
  if (!extra) return;
  if (!(await ask({
    title: `Remove ${countOf(extra, "duplicate")}?`,
    text: `Keeps the best copy of each of the ${countOf(groups.length, "song")} and ${phone ? "deletes the other files for good" : "moves the other files to the bin"}.`,
    ok: "Remove", danger: true,
  }))) return;
  const resume = releasePlaying(groups.flat().filter((t) => !groups.some((g) => bestCopy(g) === t)).map((t) => t.path));
  let r;
  try {
    r = await invoke("remove_duplicates", { groups: groups.map((g) => g.map((t) => t.path)) });
  } catch (e) {
    resume();
    return setStatus(String(e), 6000);
  }
  // the deleted copies leave the library, and the queue plays the kept copy in their place
  // (replacing the queue's entries, not changing them: they're the same songs as the library's)
  const gaveWay = new Map(r.removed);
  const byPath = new Map(state.tracks.map((t) => [t.path, t]));
  state.queue = state.queue.map((t) => (gaveWay.has(t.path) ? byPath.get(gaveWay.get(t.path)) || t : t));
  if (radio.on) radio.queue = state.queue;
  state.tracks = state.tracks.filter((t) => !gaveWay.has(t.path));
  state.favorites = new Set(r.settings.favorites || []);
  state.playlists = r.settings.playlists || [];
  plSets.clear();
  state.stats = (await invoke("get_stats").catch(() => null)) || state.stats;
  resume();
  applySearch();
  renderDupesPage();
  setStatus(`Removed ${countOf(r.removed.length, "duplicate")}` + (r.failed.length ? ` · ${r.failed.length} couldn't be: ${r.failed[0]}` : ""), 6000);
}
$("page-body").addEventListener("click", (e) => e.target.closest("[data-dupe-all]") && removeAllDuplicates());

$("page-body").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-dupe]");
  if (!b) return;
  const t = pageSongs[Number(b.closest(".dupe-row").dataset.i)];
  if (b.dataset.dupe === "play") return playTracks([t], 0);
  if (b.dataset.dupe === "reveal") return invoke("reveal_file", { path: t.path }).catch((err) => setStatus(String(err), 4000));
  if (!(await ask({ title: `Delete "${t.title}" (${extOf(t.path)}, ${t.album || "no album"})?`, text: t.path, ok: "Delete", danger: true }))) return;
  try {
    await invoke("delete_song", { path: t.path });
    state.tracks = state.tracks.filter((x) => x !== t);
    applySearch();
    renderDupesPage();
    setStatus(`Deleted ${t.title}`, 3000);
  } catch (err) {
    setStatus(String(err), 5000);
  }
});

/** Fill in what Last.fm knows: the text, tags and similar artists. */
async function loadAbout(artist, album) {
  const top = pageStack[pageStack.length - 1];
  let info;
  try {
    info = await invoke("about", { artist, album });
  } catch {
    return;
  }
  if (pageStack[pageStack.length - 1] !== top) return; // moved on meanwhile
  $("page-about").textContent = info.summary;
  $("page-tags").innerHTML = info.tags.slice(0, 5).map((t) => `<span class="tag">${esc(t)}</span>`).join("");
  if (!album && info.similar.length) {
    const inLibrary = new Map(state.tracks.map((t) => [artistKey(t), t.albumArtist]));
    $("page-similar").innerHTML = `<h2 class="page-section">Similar artists</h2><div class="page-tags similar">` +
      info.similar.map((n) => inLibrary.has(n.toLowerCase())
        ? `<a href="#" class="tag link" data-artist="${esc(n.toLowerCase())}">${esc(n)}</a>`
        : `<span class="tag" title="Not in your library">${esc(n)}</span>`).join("") + `</div>`;
  }
}

$("page-body").addEventListener("click", (e) => {
  const artist = e.target.closest("[data-artist]");
  if (artist) {
    e.preventDefault();
    return openPage("artist", artist.dataset.artist);
  }
  const album = e.target.closest("[data-album]");
  if (album) return openPage("album", pageAlbums[album.dataset.album]);
  const song = e.target.closest(".page-song");
  if (song) return playTracks(pageSongs, Number(song.dataset.i));
  const act = e.target.closest("[data-act]")?.dataset.act;
  if (act === "play") playTracks(pageAll, 0);
  if (act === "shuffle") playTracks(shuffled([...pageAll]), 0);
  if (act === "add") {
    const r = e.target.getBoundingClientRect();
    openMenu(r.left, r.bottom + 4, "Add to playlist", playlistMenu(pageAll));
  }
});

// ----------------------------------------------------- now playing & lyrics

const npOpen = () => !$("np").hidden;
function showNowPlaying(open) {
  if (open && !current()) return;
  if (open) closeViewsExcept("np");
  $("np").hidden = !open;
  syncViewClasses();
  $("np-btn").classList.toggle("on", open);
  if (open) renderNowPlaying();
}
$("np-btn").addEventListener("click", () => showNowPlaying(!npOpen()));
$("np-artist").addEventListener("click", () => current() && !current().sc && openPage("artist", artistKey(current())));
$("np-album").addEventListener("click", () => current() && !current().sc && current().album && openPage("album", albumKey(current())));
$("np-close").addEventListener("click", () => showNowPlaying(false));
// the cover in the player opens it too (the cover element is replaced for every song)
document.querySelector(".now").addEventListener("click", (e) => e.target.closest(".cover") && showNowPlaying(!npOpen()));
document.addEventListener("keydown", (e) => e.key === "Escape" && npOpen() && $("settings").hidden && showNowPlaying(false));
$("source").addEventListener("click", () => showNowPlaying(false), true);

const lyricsCache = new Map(); // song path -> { synced: [{ t, text }] | null, plain, instrumental } | "error"
const lyr = { path: null, lines: null, at: -1 };

function renderNowPlaying() {
  if (!npOpen()) return;
  const t = current();
  if (!t) return showNowPlaying(false);
  $("np-cover").innerHTML = coverHtml(t.cover, t.album || t.title);
  $("np-bg").innerHTML = t.cover ? `<img src="${esc(mediaSrc(t.cover))}" alt="" onerror="this.remove()">` : "";
  $("np-title").textContent = t.title;
  $("np-artist").textContent = t.artist;
  $("np-album").textContent = [t.album, t.year].filter(Boolean).join(" · ");
  renderNowStars();
  renderNpTools();
  if (wantGraph() && !graph) startEqualizer().then(drawVisualizer);
  else drawVisualizer();
  // library songs: the artist and album lead to their pages
  $("np-artist").classList.toggle("link", !t.sc);
  $("np-album").classList.toggle("link", !t.sc && !!t.album);
  if (lyr.path !== t.path) loadLyrics(t);
}

/** "[01:23.45] text" lines into [{ t: seconds, text }]. A line can carry several times. */
function parseLrc(lrc) {
  const lines = [];
  for (const raw of lrc.split(/\r?\n/)) {
    const times = [...raw.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    if (!times.length) continue;
    const text = raw.replace(/\[[^\]]*\]/g, "").trim();
    for (const m of times) lines.push({ t: Number(m[1]) * 60 + Number(m[2]), text });
  }
  return lines.sort((a, b) => a.t - b.t);
}

async function loadLyrics(t) {
  if (lyr.editing === t.path) return;
  lyr.editing = null;
  lyr.path = t.path;
  lyr.lines = null;
  lyr.at = -1;
  const box = $("np-lyrics");
  let got = lyricsCache.get(t.path);
  if (!got) {
    box.innerHTML = `<p class="np-note">Looking for lyrics…</p>`;
    try {
      const r = await invoke("lyrics", { title: t.title, artist: t.artist, album: t.album || "", duration: t.duration || audio.duration || 0, path: t.sc ? null : t.path });
      got = { synced: r.synced ? parseLrc(r.synced) : null, plain: r.plain, instrumental: r.instrumental, fromFile: r.fromFile, raw: r.synced || r.plain || "" };
    } catch {
      got = "error";
    }
    lyricsCache.set(t.path, got);
    if (lyr.path !== t.path) return; // the song changed meanwhile
  }
  const credit = got.fromFile ? `<p class="np-credit">Lyrics saved in the song file</p>` : `<p class="np-credit">Lyrics from <a href="#" data-open="https://lrclib.net">LRCLIB</a></p>`;
  if (got === "error") {
    box.innerHTML = `<p class="np-note">Couldn't reach the lyrics service.</p>`;
  } else if (got.synced?.length) {
    lyr.lines = got.synced;
    box.innerHTML = got.synced.map((l, i) => `<p class="np-line${l.text ? "" : " gap"}" data-i="${i}">${esc(l.text || "♪")}</p>`).join("") + credit;
    box.scrollTop = 0;
    syncLyrics();
  } else if (got.plain) {
    box.innerHTML = `<p class="np-note">These lyrics aren't timed to the song.</p>` +
      got.plain.split("\n").map((l) => `<p class="np-line plain">${esc(l) || "&nbsp;"}</p>`).join("") + credit;
  } else {
    box.innerHTML = `<p class="np-note">${got.instrumental ? "Instrumental" : "No lyrics found for this song."}</p>`;
  }
}

// ---- the lyrics editor: write or fix lyrics, and time them while the song plays

const LRC_TIME = /^\s*\[\d+:\d{1,2}(?:\.\d+)?\]\s?/;
const lrcStamp = (secs) => `[${String(Math.floor(secs / 60)).padStart(2, "0")}:${(secs % 60).toFixed(2).padStart(5, "0")}]`;
function editLyrics() {
  const t = current();
  if (!t || t.sc) return;
  const got = lyricsCache.get(t.path);
  lyr.editing = t.path;
  lyr.lines = null;
  $("np-lyrics").innerHTML =
    `<div class="lyr-edit">` +
    `<p class="np-note">One line per line of the song. To time them, play the song, put the cursor on a line and press <b>Stamp</b> (or Ctrl+Enter) as it's sung — it moves on to the next line.</p>` +
    `<textarea id="lyr-text" spellcheck="false" placeholder="Type or paste the lyrics here"></textarea>` +
    `<div class="lyr-actions"><button class="btn" id="lyr-stamp" title="Ctrl+Enter">Stamp ${lrcStamp(audio.currentTime)}</button>` +
    `<button class="btn" id="lyr-untime">Remove times</button><span class="spacer"></span>` +
    `<button class="btn" id="lyr-cancel">Cancel</button><button class="btn accent" id="lyr-save">Save to the song</button></div></div>`;
  $("lyr-text").value = got && got !== "error" ? got.raw || "" : "";
  $("lyr-text").focus();
}
function stampLine() {
  const ta = $("lyr-text");
  if (!ta) return;
  const v = ta.value, start = v.lastIndexOf("\n", ta.selectionStart - 1) + 1;
  let end = v.indexOf("\n", start);
  if (end < 0) end = v.length;
  const line = lrcStamp(Math.max(0, audio.currentTime - 0.15)) + " " + v.slice(start, end).replace(LRC_TIME, "");
  ta.value = v.slice(0, start) + line + v.slice(end);
  // on to the next line that has words
  let next = start + line.length + 1;
  while (next < ta.value.length && ta.value[next] === "\n") next++;
  ta.setSelectionRange(Math.min(next, ta.value.length), Math.min(next, ta.value.length));
  const lineH = parseFloat(getComputedStyle(ta).lineHeight) || 20;
  ta.scrollTop = Math.max(0, ta.value.slice(0, next).split("\n").length * lineH - ta.clientHeight / 2);
}
async function saveLyrics() {
  const t = current();
  if (!t || lyr.editing !== t.path) return;
  const text = $("lyr-text").value.replace(/\s+$/, "");
  const resume = releasePlaying([t.path]);
  try {
    await invoke("save_lyrics", { path: t.path, text });
  } catch (e) {
    resume();
    return setStatus(String(e), 6000);
  }
  resume();
  lyr.editing = null;
  lyricsCache.delete(t.path);
  lyr.path = null;
  loadLyrics(t);
  setStatus(text ? "Saved the lyrics into the song" : "Took the lyrics out of the song", 3000);
}
$("np-lyrics").addEventListener("click", (e) => {
  if (e.target.id === "lyr-stamp") stampLine(), $("lyr-text").focus();
  else if (e.target.id === "lyr-untime") $("lyr-text").value = $("lyr-text").value.split("\n").map((l) => l.replace(LRC_TIME, "")).join("\n");
  else if (e.target.id === "lyr-save") saveLyrics();
  else if (e.target.id === "lyr-cancel") {
    lyr.editing = null;
    lyr.path = null;
    loadLyrics(current());
  }
});
$("np-lyrics").addEventListener("keydown", (e) => {
  if (e.target.id === "lyr-text" && e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    stampLine();
  }
});
onAudio("timeupdate", () => {
  const b = $("lyr-stamp");
  if (b) b.textContent = `Stamp ${lrcStamp(audio.currentTime)}`;
});
$("np-lyr-edit").addEventListener("click", editLyrics);

/** Light up the line being sung and keep it in the middle. */
function syncLyrics() {
  if (!lyr.lines || !npOpen()) return;
  const now = audio.currentTime + 0.2;
  let at = -1;
  for (let i = 0; i < lyr.lines.length && lyr.lines[i].t <= now; i++) at = i;
  if (at === lyr.at) return;
  lyr.at = at;
  const box = $("np-lyrics");
  box.querySelector(".np-line.on")?.classList.remove("on");
  const line = box.querySelector(`.np-line[data-i="${at}"]`);
  if (!line) return;
  line.classList.add("on");
  box.scrollTo({ top: line.offsetTop - box.clientHeight / 2 + line.offsetHeight / 2, behavior: prefs.animations ? "smooth" : "auto" });
}
onAudio("timeupdate", syncLyrics);
onAudio("seeked", () => {
  lyr.at = -2;
  syncLyrics();
});
$("np-lyrics").addEventListener("click", (e) => {
  const link = e.target.closest("a[data-open]");
  if (link) {
    e.preventDefault();
    return window.__TAURI__.opener.openUrl(link.dataset.open);
  }
  const line = e.target.closest(".np-line[data-i]");
  if (line && lyr.lines) audio.currentTime = lyr.lines[line.dataset.i].t; // jump to that line
});

// ------------------------------------------------------- player: heart & queue

/** The heart next to the playing song: a favourite in the library, a like on SoundCloud. */
function renderNowFav() {
  const t = current(), b = $("now-fav");
  b.hidden = !t;
  if (!t) return;
  const on = isFav(t);
  b.classList.toggle("on", on);
  $("now-fav-icon").setAttribute("href", on ? "#i-heart" : "#i-heart-outline");
  b.title = t.sc ? (on ? "Unlike on SoundCloud" : "Like on SoundCloud") : on ? "Remove from favourites" : "Add to favourites";
}
$("now-fav").addEventListener("click", () => {
  const t = current();
  if (t) (t.sc ? scToggleLike(t) : toggleFavorite(t));
});

const queueOpen = () => !$("queue").hidden;
function showQueue(open) {
  $("queue").hidden = !open;
  $("queue-btn").classList.toggle("on", open);
  if (open) renderQueue(true);
}
// iOS has no volume slider, so the queue button sits with the song instead
if (phone) document.querySelector(".now").append($("queue-btn"));
$("queue-btn").addEventListener("click", () => showQueue(!queueOpen()));
$("queue-close").addEventListener("click", () => showQueue(false));
document.addEventListener("keydown", (e) => e.key === "Escape" && queueOpen() && showQueue(false));

/** How many songs the queue shows coming up, and already played. */
const QUEUE_SHOWN = 200, QUEUE_PLAYED_SHOWN = 30;

function queueRowHtml(j, kind) {
  const t = state.queue[state.order[j]];
  const remove = kind === "next"
    ? `<button class="icon-btn" data-remove="${j}" title="Remove from the queue"><svg viewBox="0 0 12 12" class="x"><path d="M2 2l8 8M10 2l-8 8"/></svg></button>` : "";
  return `<div class="queue-row ${kind}" data-j="${j}" title="${esc(`${t.title}\n${t.artist}`)}">${coverHtml(thumbOf(t, 100), t.album || t.title)}` +
    `<div class="queue-text"><div class="name">${kind === "now" && prefs.equalizer ? EQ_HTML : ""}${esc(t.title)}</div><div class="sub">${esc(t.artist)}</div></div>` +
    `<span class="time">${fmtTime(t.duration)}</span>${remove}</div>`;
}

/** Draw the queue panel (if it's open): what's playing, what's coming up, and what played before. */
function renderQueue(scrollToNow = false) {
  nativeQueueChanged();
  if (!queueOpen()) return;
  const list = $("queue-list");
  const pos = state.pos, order = state.order;
  if (!current()) {
    $("queue-summary").textContent = "";
    $("queue-clear").hidden = true;
    list.innerHTML = `<div class="empty-note">Nothing is playing. Play a song and the rest of its list lines up here.</div>`;
    return;
  }
  const upcoming = order.length - pos - 1;
  const random = state.shuffle === SHUFFLE_RANDOM;
  $("queue-summary").textContent = random ? "Random · songs can come up again"
    : `${upcoming} song${upcoming === 1 ? "" : "s"} up next${state.shuffle ? " · shuffled" : ""}${state.repeat === REPEAT_ALL ? " · repeating" : ""}`;
  $("queue-clear").hidden = !upcoming || random;
  let html = "";
  const played = Math.min(pos, QUEUE_PLAYED_SHOWN);
  if (played) {
    html += `<h3 class="queue-section">Played</h3>`;
    for (let j = pos - played; j < pos; j++) html += queueRowHtml(j, "played");
  }
  html += `<h3 class="queue-section">Now playing</h3>` + queueRowHtml(pos, "now");
  if (upcoming) {
    html += `<h3 class="queue-section">${random ? "Coming up" : "Up next"}</h3>`;
    for (let j = pos + 1; j < Math.min(order.length, pos + 1 + QUEUE_SHOWN); j++) html += queueRowHtml(j, "next");
    if (upcoming > QUEUE_SHOWN) html += `<div class="empty-note">and ${upcoming - QUEUE_SHOWN} more</div>`;
  }
  list.innerHTML = html;
  if (scrollToNow) reveal(list, list.querySelector(".queue-row.now"), true);
}

$("queue-list").addEventListener("click", (e) => {
  const remove = e.target.closest("[data-remove]");
  if (remove) {
    const j = Number(remove.dataset.remove);
    if (j <= state.pos) return;
    state.order.splice(j, 1);
    if (state.shuffle === SHUFFLE_RANDOM) fillRandom();
    const keep = $("queue-list").scrollTop;
    renderQueue();
    $("queue-list").scrollTop = keep;
    saveSession();
    return;
  }
  const row = e.target.closest(".queue-row[data-j]");
  if (!row || row.classList.contains("now")) return;
  // jump there: songs between here and there stay where they are in the list
  state.pos = Number(row.dataset.j);
  if (state.shuffle === SHUFFLE_RANDOM) fillRandom();
  playCurrent();
});
$("queue-clear").addEventListener("click", () => {
  state.order.length = state.pos + 1;
  renderQueue();
  saveSession();
});

function copyText(text, done) {
  navigator.clipboard.writeText(text).then(() => setStatus(done, 2000), () => setStatus("Couldn't copy", 3000));
}

/** Update the hearts in the song table and covers without redrawing them. */
function refreshHearts() {
  for (const row of el.songBody.querySelectorAll("tr[data-i]")) {
    const t = state.shown[row.dataset.i];
    if (t) row.classList.toggle("fav", isFav(t));
  }
  for (const card of el.songGrid.children) {
    const t = state.shown[card.dataset.i];
    if (t) card.classList.toggle("fav", isFav(t));
  }
}

async function toggleFavorite(t) {
  const on = !state.favorites.has(t.path);
  const hadAny = state.favorites.size > 0;
  state.favorites = new Set(await invoke("set_favorite", { path: t.path, on }));
  renderNowFav();
  setStatus(on ? `Added “${t.title}” to favourites` : `Removed “${t.title}” from favourites`, 2500);
  if (state.source !== "local") return;
  const favItem = el.artistList.querySelector(`li[data-key="${FAV_KEY}"]`);
  if (state.artist === FAV_KEY || !favItem || !state.favorites.size || hadAny !== state.favorites.size > 0) {
    // the Favourites entry appears, disappears, or is the list being shown
    const scroll = [el.artistList.scrollTop, el.albumGrid.scrollTop, el.songBody.closest(".table-wrap").scrollTop];
    renderArtists();
    [el.artistList.scrollTop, el.albumGrid.scrollTop, el.songBody.closest(".table-wrap").scrollTop] = scroll;
  } else {
    favItem.querySelector(".count").textContent = state.visible.filter((x) => state.favorites.has(x.path)).length;
    refreshHearts();
  }
}

async function scToggleLike(t) {
  const sc = state.sc;
  const on = !sc.liked.has(t.urn);
  try {
    await invoke("sc_like", { urn: t.urn, on });
  } catch (e) {
    setStatus(String(e), 6000);
    return;
  }
  on ? sc.liked.add(t.urn) : sc.liked.delete(t.urn);
  renderNowFav();
  const likes = sc.tracks.get("likes");
  if (likes) {
    if (on) likes.unshift({ ...t, scList: "likes" });
    else sc.tracks.set("likes", likes.filter((x) => x.urn !== t.urn));
  }
  setStatus(on ? `Liked “${t.title}”` : `Unliked “${t.title}”`, 2500);
  if (state.source !== "sc") return;
  if (sc.current === "likes") {
    const wrap = el.songBody.closest(".table-wrap"), scroll = [wrap.scrollTop, el.songGrid.scrollTop];
    renderSc();
    [wrap.scrollTop, el.songGrid.scrollTop] = scroll;
  } else {
    const count = el.artistList.querySelector('li[data-key="likes"] .count');
    if (count) count.textContent = sc.tracks.get("likes")?.length ?? "";
    refreshHearts();
  }
}

// --------------------------------------------------------- SoundCloud downloads

// Each queued song is an item: { id, t, status, via, path, bytes, done, total, speed, error }.
// status: "queued" | "downloading" | "saved" | "existing" | "failed" | "cancelled"
const dl = { queue: [], current: null, finished: [], running: false, paused: false, nextId: 1 };
const ytdlpOn = () => !!state.settings.downloads?.useYtdlp;
const canDownload = (t) => t.sc && (t.downloadable || ytdlpOn());

/** Add songs to the download queue and work through it one at a time. */
function queueDownloads(tracks) {
  const wanted = tracks.filter(canDownload);
  const blocked = tracks.length - wanted.length;
  if (!wanted.length) {
    setStatus(blocked ? "None of these songs can be downloaded — turn on yt-dlp in Settings → Integrations" : "Nothing to download", 6000);
    return;
  }
  const busy = new Set([...dl.queue, dl.current].filter(Boolean).map((it) => it.t.urn));
  const added = wanted.filter((t) => !busy.has(t.urn));
  for (const t of added) dl.queue.push({ id: dl.nextId++, t, status: "queued", done: 0, total: null, speed: 0 });
  const note = added.length === 1 ? `Added “${added[0].title}” to downloads` : `Added ${added.length} songs to downloads`;
  setStatus(note + (blocked ? ` · ${blocked} not allowed by the artist` : ""), 4000);
  renderDownloads();
  if (!dl.running && !dl.paused) runDownloads();
}

/** Pause: stop the song in progress and keep it at the front of the queue. */
function stopDownloads() {
  dl.paused = true;
  if (dl.current) invoke("dl_cancel");
  renderDownloads();
}

function resumeDownloads() {
  dl.paused = false;
  renderDownloads();
  if (!dl.running) runDownloads();
}

async function runDownloads() {
  dl.running = true;
  let saved = 0;
  while (dl.queue.length && !dl.paused) {
    const it = (dl.current = dl.queue.shift());
    Object.assign(it, { status: "downloading", done: 0, total: null, speed: 0, startedAt: performance.now() });
    renderDownloads();
    const { t } = it;
    try {
      const r = await invoke("sc_download", {
        track: { urn: t.urn, title: t.title, artist: t.artist, cover: t.cover, permalinkUrl: t.permalinkUrl, downloadable: !!t.downloadable },
      });
      Object.assign(it, { status: r.via === "existing" ? "existing" : "saved", via: r.via, path: r.path, bytes: r.bytes });
      if (r.via !== "existing") saved++;
    } catch (e) {
      if (String(e) === "Cancelled") {
        if (dl.paused) {
          // paused: start this song again when the queue resumes
          Object.assign(it, { status: "queued", done: 0, total: null, speed: 0 });
          dl.queue.unshift(it);
          dl.current = null;
          break;
        }
        it.status = "cancelled";
      } else {
        Object.assign(it, { status: "failed", error: String(e) });
      }
    }
    dl.finished.unshift(it);
    dl.current = null;
    renderDownloads();
  }
  dl.current = null;
  dl.running = false;
  renderDownloads();
  if (!dl.queue.length) {
    const failed = dl.finished.filter((it) => it.status === "failed").length;
    setStatus(`Downloads finished${failed ? ` · ${failed} failed — see Downloads` : ""}`, 5000);
  }
  // pick the new files up when the download folder is part of the library
  if (saved) refreshAutoFolders().then(() => rescan(false));
}

listen("dl-progress", ({ payload }) => {
  const it = dl.current;
  if (!it || it.t.urn !== payload.urn) return;
  const now = performance.now();
  if (it.lastAt) {
    const rate = ((payload.done - it.done) * 1000) / Math.max(1, now - it.lastAt);
    it.speed = it.speed ? it.speed * 0.7 + rate * 0.3 : rate; // smoothed bytes per second
  }
  Object.assign(it, { done: payload.done, total: payload.total ?? it.total, lastAt: now });
  renderDownloadProgress();
});

// right-click a list (Likes, a playlist, search results) to download all of it
el.artistList.addEventListener("contextmenu", async (e) => {
  if (state.source !== "sc") return;
  const li = e.target.closest("li[data-key]");
  if (!li) return;
  e.preventDefault();
  const key = li.dataset.key;
  const loaded = state.sc.tracks.get(key);
  const items = [
    { label: "Play all", icon: "i-play", action: async () => {
      scSelect(key);
      showPane("songs");
      if (!state.sc.tracks.has(key)) await scFetch(key);
      playShown(0);
    } },
  ];
  if (!phone) items.push(
    "-",
    { label: loaded ? `Download all (${loaded.filter(canDownload).length} of ${loaded.length})` : "Download all", icon: "i-download",
      action: async () => {
        if (!state.sc.tracks.has(key)) {
          setStatus("Loading the list…");
          await scFetch(key);
        }
        queueDownloads(state.sc.tracks.get(key) || []);
      } },
  );
  if (dl.current) items.push({ label: "Pause downloads", icon: "i-stop", action: stopDownloads });
  openMenu(e.clientX, e.clientY, scListName(key), items);
});

// Settings → Integrations → SoundCloud downloads
async function renderDownloadSettings() {
  const d = state.settings.downloads || {};
  $("dl-ytdlp").checked = !!d.useYtdlp;
  $("dl-ytdlp-fields").hidden = !d.useYtdlp;
  if (document.activeElement !== $("dl-ytdlp-path")) $("dl-ytdlp-path").value = d.ytdlpPath || "";
  if (!d.useYtdlp) $("dl-ytdlp-status").textContent = "";
  $("dl-folder").textContent = await invoke("dl_folder");
}

async function saveYtdlp() {
  state.settings = await invoke("dl_set_ytdlp", { enabled: $("dl-ytdlp").checked, path: $("dl-ytdlp-path").value });
  renderDownloadSettings();
}

async function checkYtdlp() {
  const status = $("dl-ytdlp-status");
  status.className = "hint";
  status.textContent = "Looking for yt-dlp…";
  try {
    status.textContent = `Found yt-dlp ${await invoke("dl_ytdlp_version")}`;
    status.className = "hint ok";
  } catch (e) {
    status.textContent = String(e);
    status.className = "hint err";
  }
}

$("dl-ytdlp").addEventListener("change", async () => {
  await saveYtdlp();
  if ($("dl-ytdlp").checked) checkYtdlp();
});
$("dl-ytdlp-path").addEventListener("change", async () => {
  await saveYtdlp();
  checkYtdlp();
});
$("dl-ytdlp-check").addEventListener("click", async () => {
  await saveYtdlp();
  checkYtdlp();
});
$("dl-change").addEventListener("click", async () => {
  const settings = await invoke("dl_pick_folder");
  if (settings) state.settings = settings;
  renderDownloadSettings();
  if (settings) refreshAutoFolders().then(() => rescan(false));
});
$("dl-open").addEventListener("click", () => invoke("dl_open_folder").catch((e) => setStatus(String(e), 5000)));

// ----------------------------------------------------------- Downloads page

function fmtBytes(n) {
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i >= 2 ? 1 : 0)} ${units[i]}`;
}

const viaLabel = (it) => (it.via === "yt-dlp" || (!it.via && !it.t.downloadable) ? "yt-dlp" : "Official");

function showDownloads(open = true) {
  closeSettings();
  if (open) closeViewsExcept("downloads");
  $("downloads").hidden = !open;
  syncViewClasses();
  if (open) {
    renderDownloads();
    pollSlskTransfers();
  }
}

$("downloads-btn").addEventListener("click", () => showDownloads(!document.body.classList.contains("show-downloads")));
$("dl-close").addEventListener("click", () => showDownloads(false));
$("source").addEventListener("click", () => showDownloads(false), true);
$("dl-pause").addEventListener("click", () => (dl.paused ? resumeDownloads() : stopDownloads()));
$("dl-clear").addEventListener("click", async () => {
  dl.finished = [];
  if (state.slsk.status) await invoke("slsk_clear_finished").catch(() => {});
  renderDownloads();
  pollSlskTransfers();
});
$("dl-open-folder").addEventListener("click", () => invoke("dl_open_folder").catch((e) => setStatus(String(e), 5000)));
$("dl-open-slsk").addEventListener("click", () => invoke("slsk_open_folder").catch((e) => setStatus(String(e), 5000)));

function renderDownloads() {
  const scActive = dl.queue.length + (dl.current ? 1 : 0);
  const slskBusy = slskActive();
  const active = scActive + slskBusy;
  const badge = $("dl-badge");
  badge.hidden = !active;
  badge.textContent = active > 99 ? "99+" : active;
  $("downloads-btn").classList.toggle("busy", !!dl.current || state.slsk.transfers.some((x) => x.state.includes("InProgress")));
  if ($("downloads").hidden) return;

  const slskFinished = state.slsk.transfers.filter(slskDone);
  const failed = dl.finished.filter((it) => it.status === "failed").length + slskFinished.filter((x) => !slskOk(x)).length;
  const sending = slskSending();
  $("dl-summary").textContent = !active && !dl.finished.length && !slskFinished.length && !sending
    ? "Nothing downloading. Right-click a SoundCloud song or list, or a Soulseek result, to download it."
    : [active && `${active} to go`, dl.paused && "paused", failed && `${failed} failed`,
      sending && `${sending} being downloaded from your library`].filter(Boolean).join(" · ") || "All done";
  $("dl-pause").textContent = dl.paused ? "Resume" : "Pause";
  $("dl-pause").hidden = !scActive;
  $("dl-clear").hidden = !dl.finished.length && !slskFinished.length && !state.slsk.uploads.some(slskDone);
  renderSlskTransfers();
  renderSlskUploads();

  const it = dl.current;
  $("dl-current").innerHTML = it
    ? `<div class="dl-hero">${coverHtml(it.t.cover, it.t.title)}<div class="dl-hero-info">` +
      `<div class="dl-hero-title">${esc(it.t.title)}</div><div class="dl-hero-artist">${esc(it.t.artist)} <span class="badge">${viaLabel(it)}</span></div>` +
      `<div class="dl-bar"><i id="dl-bar-fill"></i></div><div id="dl-hero-stats" class="dl-hero-stats"></div></div>` +
      `<button id="dl-cancel-current" class="btn">Cancel</button></div>`
    : dl.paused && dl.queue.length ? `<div class="dl-idle">Paused — click Resume to carry on.</div>` : "";
  $("dl-cancel-current")?.addEventListener("click", () => invoke("dl_cancel"));
  renderDownloadProgress();

  $("dl-next-title").hidden = !dl.queue.length;
  $("dl-next-title").textContent = `Up next · ${dl.queue.length}`;
  // long queues: only draw the first few hundred rows
  $("dl-next").innerHTML = dl.queue.slice(0, 300).map((q, i) =>
    `<div class="dl-row" data-id="${q.id}">${coverHtml(thumbOf(q.t, 100), q.t.title)}<div class="dl-row-text">` +
    `<div class="name">${esc(q.t.title)}</div><div class="sub">${esc(q.t.artist)} · ${viaLabel(q)}</div></div>` +
    `<div class="dl-row-actions">${i ? `<button class="icon-btn" data-act="top" title="Download next"><svg viewBox="0 0 24 24"><use href="#i-to-top"/></svg></button>` : ""}` +
    `<button class="icon-btn" data-act="remove" title="Remove from queue"><svg viewBox="0 0 12 12" class="x"><path d="M2 2l8 8M10 2l-8 8"/></svg></button></div></div>`).join("") +
    (dl.queue.length > 300 ? `<div class="empty-note">and ${dl.queue.length - 300} more…</div>` : "");

  $("dl-done-title").hidden = !dl.finished.length;
  $("dl-done").innerHTML = dl.finished.slice(0, 300).map((f) => {
    const what = { saved: `Saved · ${fmtBytes(f.bytes)} · ${viaLabel(f)}`, existing: "Already downloaded", cancelled: "Cancelled", failed: f.error }[f.status];
    const actions = f.path ? `<button class="btn small" data-act="reveal">Show in folder</button>`
      : `<button class="btn small" data-act="retry">Retry</button>`;
    return `<div class="dl-row ${f.status}" data-id="${f.id}">${coverHtml(thumbOf(f.t, 100), f.t.title)}<div class="dl-row-text">` +
      `<div class="name">${esc(f.t.title)}</div><div class="sub" title="${esc(what)}">${esc(f.t.artist)} · ${esc(what)}</div></div>` +
      `<div class="dl-row-actions">${actions}</div></div>`;
  }).join("");
}

/** Just the progress bar and numbers; runs several times a second. */
function renderDownloadProgress() {
  const it = dl.current, fill = $("dl-bar-fill"), stats = $("dl-hero-stats");
  if (!it || !fill) return;
  const total = it.total || 0;
  const frac = total ? Math.min(1, it.done / total) : 0;
  // a sliding bar only once bytes arrive without a known size; before that, an empty bar
  fill.style.width = total ? `${frac * 100}%` : it.done ? "" : "0%";
  fill.classList.toggle("indeterminate", !total && it.done > 0);
  const left = total && it.speed > 1 ? Math.max(0, (total - it.done) / it.speed) : null;
  stats.textContent = !it.done ? "Starting…"
    : [total ? `${Math.round(frac * 100)}%` : null, total ? `${fmtBytes(it.done)} of ${fmtBytes(total)}` : fmtBytes(it.done),
      it.speed ? `${fmtBytes(it.speed)}/s` : null, left != null ? `${fmtTime(left)} left` : null].filter(Boolean).join(" · ");
}

function findItem(id) {
  return dl.queue.find((q) => q.id === id) || dl.finished.find((f) => f.id === id);
}

$("downloads").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-act]");
  if (!b) return;
  const id = Number(b.closest(".dl-row").dataset.id);
  const it = findItem(id);
  if (!it) return;
  if (b.dataset.act === "remove") dl.queue = dl.queue.filter((q) => q.id !== id);
  if (b.dataset.act === "top") dl.queue = [it, ...dl.queue.filter((q) => q.id !== id)];
  if (b.dataset.act === "reveal") invoke("dl_reveal", { path: it.path }).catch((err) => setStatus(String(err), 5000));
  if (b.dataset.act === "retry") {
    dl.finished = dl.finished.filter((f) => f.id !== id);
    queueDownloads([it.t]);
  }
  renderDownloads();
});

renderDownloads();
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && el.settings.hidden && document.body.classList.contains("show-downloads")) showDownloads(false);
});

// ----------------------------------------------------------------- Soulseek
// Searching and downloading go through slskd (see slsk.rs). Results show in the song table;
// double-click or Enter downloads instead of playing, since nothing is on this computer yet.

const SLSK_MAX_SEARCHES = 12;

// Function declarations, not consts: renderDownloads (earlier in the file) runs while the file
// is still loading and already needs some of these.
/** The Soulseek client built into the app, instead of slskd: always on iOS, a test switch elsewhere. */
const slskBuiltin = () => phone || !!state.settings.soulseek?.builtin;

function slskLoggedIn() {
  return !!state.slsk.status?.loggedIn;
}
function slskConfigured() {
  const c = state.settings.soulseek || {};
  return c.external && !slskBuiltin() ? !!c.url : !!(c.username && c.password);
}
function baseName(p) {
  return p.split(/[\\/]/).filter(Boolean).pop() || p;
}
function parentName(p) {
  return p.split(/[\\/]/).filter(Boolean).slice(-2, -1)[0] || "";
}

async function slskConnect() {
  const s = state.slsk;
  if (s.connecting) return;
  s.connecting = true;
  s.error = "";
  renderSlskSettings();
  if (state.source === "slsk") renderSlsk();
  try {
    s.status = await invoke("slsk_connect");
    pollSlskStatus();
    pollSlskTransfers();
  } catch (e) {
    s.status = null;
    s.error = String(e);
  }
  s.connecting = false;
  renderSlskSettings();
  if (state.source === "slsk") renderSlsk();
}

async function slskDisconnect() {
  await invoke("slsk_disconnect").catch(() => {});
  Object.assign(state.slsk, { status: null, transfers: [], uploads: [] });
  slskSeenUploads = slskSeenFinished = null;
  renderSlskSettings();
  renderDownloads();
  if (state.source === "slsk") renderSlsk();
}

// slskd needs a few seconds to log in after it starts, and can drop and regain the connection
let slskStatusTimer;
async function pollSlskStatus() {
  clearTimeout(slskStatusTimer);
  const s = state.slsk;
  try {
    s.status = await invoke("slsk_status");
  } catch (e) {
    s.status = null;
    s.error = String(e);
  }
  const wasIn = slskLoggedIn();
  renderSlskSettings();
  if (state.source === "slsk") renderSlsk();
  if (s.status) slskStatusTimer = setTimeout(pollSlskStatus, wasIn ? 10000 : 1500);
}

function slskStatusText() {
  const s = state.slsk, st = s.status;
  if (s.connecting) return slskBuiltin() ? "Connecting to Soulseek…" : "Starting slskd…";
  if (!st) return s.error || "Not connected";
  if (st.loggedIn) {
    const port = st.listenPort ? ` · listening on port ${st.listenPort}` : "";
    const sending = slskSending();
    const up = sending ? ` · ${sending} ${sending === 1 ? "song" : "songs"} being downloaded from your library` : "";
    return `Connected as ${st.username || state.settings.soulseek?.username}${port}${up}`;
  }
  if (st.busy) return "Logging in to Soulseek…";
  return `${slskBuiltin() ? "Soulseek" : "slskd is running but"} not logged in (${st.state || "disconnected"}). Check the username and password.`;
}

// ------------------------------------------------------------ the view

function renderSlsk() {
  const s = state.slsk;
  const ready = slskLoggedIn();
  el.empty.hidden = true;
  $("slsk-empty").hidden = ready;
  el.library.hidden = !ready;
  if (!ready) {
    $("slsk-empty-text").textContent = s.connecting ? "Starting Soulseek…"
      : s.status ? slskStatusText()
      : slskConfigured() ? (s.error || "Soulseek isn't connected.")
      : "Search and download music from Soulseek. Set up your Soulseek login first.";
    $("slsk-empty-connect").hidden = !slskConfigured() || s.connecting || !!s.status;
    return;
  }
  if (!s.searches.some((x) => x.id === s.current)) s.current = s.searches[0]?.id ?? null;
  let n = 0;
  el.artistList.innerHTML = s.searches.length
    ? s.searches.map((x) =>
        `<li data-key="${esc(x.id)}" class="${x.id === s.current ? "sel" : ""}" title="${esc(x.text)}" style="--i:${n++}">` +
        `<span class="count">${x.complete ? x.files.length : "…"}</span>${esc(x.text)}</li>`).join("")
    : `<li class="none">Type in the search box and press Enter</li>`;
  el.artistsTitle.textContent = `Soulseek · ${s.status.username || ""}`;
  renderSlskSongs();
}

function slskQuality(f) {
  const ext = f.ext.toUpperCase();
  if (f.bitDepth && f.sampleRate) return `${ext} ${f.bitDepth}/${Math.round(f.sampleRate / 100) / 10}`;
  return f.bitRate && !["flac", "wav", "aiff", "aif", "alac", "ape", "wv"].includes(f.ext) ? `${ext} ${f.bitRate}` : ext;
}

const LOSSLESS = ["flac", "wav", "aiff", "aif", "alac", "ape", "wv"];

/** Quality in detail, for the Quality column: "FLAC · 24 bit / 96 kHz", "MP3 · 320 kbps". */
function slskQualityLong(f) {
  const ext = f.ext.toUpperCase();
  if (f.bitDepth && f.sampleRate) return `${ext} · ${f.bitDepth} bit / ${Math.round(f.sampleRate / 100) / 10} kHz`;
  if (f.bitRate && !LOSSLESS.includes(f.ext)) return `${ext} · ${f.bitRate} kbps${f.isVariableBitRate ? " VBR" : ""}`;
  return ext;
}

/** A rough quality score for sorting: lossless first, then by bitrate. */
const slskQualityScore = (f) => (LOSSLESS.includes(f.ext) ? 10000 + (f.bitDepth || 16) * 10 : f.bitRate || 0);

const SLSK_SORTS = {
  best: "Best sources", // free upload slot, then fastest, then shortest queue (like Soulseek's own order)
  quality: "Best quality",
  files: "Most files",
  name: "Folder name",
};

/**
 * Results grouped the way Soulseek shows them: one header row per user and folder, with that
 * folder's files under it. Collapsed folders show only their header.
 */
function slskRows(search) {
  const s = state.slsk, q = s.filter;
  const groups = new Map();
  for (const f of search.files) {
    const dir = f.filename.slice(0, f.filename.length - baseName(f.filename).length);
    const key = `${f.username}\0${dir}`;
    let g = groups.get(key);
    if (!g) {
      const parts = dir.split(/[\\/]/).filter(Boolean);
      groups.set(key, (g = {
        group: true, key, path: `slsk-group:${key}`, username: f.username, dir,
        folder: parts.slice(-2).join(" / ") || "(top level)",
        freeSlot: f.freeSlot, queueLength: f.queueLength, uploadSpeed: f.uploadSpeed, all: [], files: [],
      }));
    }
    const t = {
      slsk: f,
      path: `slsk:${f.username}:${f.filename}`,
      title: baseName(f.filename).replace(/\.[^.]+$/, ""),
      artist: fmtBytes(f.size),
      album: slskQualityLong(f),
      duration: f.length || 0,
      tip: `${f.filename}\n${f.username} · ${fmtBytes(f.size)}`,
    };
    g.all.push(t);
    if (!q || [t.title, g.folder, g.username].some((x) => x.toLowerCase().includes(q))) g.files.push(t);
  }
  const list = [...groups.values()].filter((g) => g.files.length);
  for (const g of list) {
    g.files.sort((x, y) => collator.compare(baseName(x.slsk.filename), baseName(y.slsk.filename)));
    g.size = g.all.reduce((n, t) => n + t.slsk.size, 0);
    g.quality = Math.max(...g.all.map((t) => slskQualityScore(t.slsk)));
    g.formats = [...new Set(g.all.map((t) => t.slsk.ext.toUpperCase()))].join(", ");
  }
  const bySource = (x, y) => (y.freeSlot - x.freeSlot) || (y.uploadSpeed - x.uploadSpeed) || (x.queueLength - y.queueLength);
  const sorts = {
    best: bySource,
    quality: (x, y) => (y.quality - x.quality) || bySource(x, y),
    files: (x, y) => (y.all.length - x.all.length) || bySource(x, y),
    name: (x, y) => collator.compare(x.folder, y.folder) || bySource(x, y),
  };
  list.sort(sorts[prefs.slskSort] || bySource);

  const rows = [];
  for (const g of list) {
    rows.push(g);
    if (!s.collapsed.has(g.key)) g.files.forEach((t, n) => rows.push(Object.assign(t, { num: n + 1, groupKey: g.key })));
  }
  return { rows, folders: list.length, files: list.reduce((n, g) => n + g.files.length, 0), users: new Set(list.map((g) => g.username)).size };
}

/** The header row of one user's folder. */
function slskGroupHtml(g, i) {
  const open = !state.slsk.collapsed.has(g.key);
  const slot = g.freeSlot ? `<span class="slot free">free slot</span>` : `<span class="slot">${g.queueLength} waiting</span>`;
  const stats = [`${g.all.length} file${g.all.length === 1 ? "" : "s"}`, fmtBytes(g.size), g.formats, `${fmtBytes(g.uploadSpeed)}/s`].join(" · ");
  return `<tr data-i="${i}" class="slsk-group${i === state.selected ? " sel" : ""}${open ? "" : " closed"}" title="${esc(g.dir)}">` +
    `<td class="num"><svg class="caret" viewBox="0 0 12 12"><path d="M3 4.5l3 3 3-3"/></svg></td>` +
    `<td colspan="4"><b>${esc(g.username)}</b> ${slot}<span class="folder">${esc(g.folder)}</span><span class="stats">${esc(stats)}</span></td></tr>`;
}

/** `keep` holds the scroll position and selection, for results that grow while searching. */
function renderSlskSongs(keep = false) {
  if (state.source !== "slsk") return;
  const s = state.slsk;
  const search = s.searches.find((x) => x.id === s.current);
  const wrap = tableWrap(), top = wrap.scrollTop, sel = state.shown[state.selected]?.path;
  const { rows, folders, files, users } = search ? slskRows(search) : { rows: [] };
  fillSongs(rows, { title: search ? `“${search.text}”` : "Results" });
  if (search) {
    el.songsTitle.textContent = `“${search.text}” · ${files} file${files === 1 ? "" : "s"} in ${folders} folder${folders === 1 ? "" : "s"} from ${users} user${users === 1 ? "" : "s"}`;
  }
  if (keep) {
    wrap.scrollTop = top;
    const i = sel ? rows.findIndex((t) => t.path === sel) : -1;
    if (i >= 0) {
      state.selected = i;
      renderSongRows();
    }
  }
  const note = !search ? "Search for an artist, album or song."
    : search.error ? search.error
    : !rows.length ? (search.complete ? (s.filter ? "No matches." : "Nobody had that. Try fewer words.") : "Searching…") : "";
  if (note) el.songBody.innerHTML = `<tr><td colspan="5" class="empty-note">${esc(note)}</td></tr>`;
  if (search && !search.complete) el.songsTitle.textContent += " · searching…";
}

function slskToggleGroup(key, open) {
  const c = state.slsk.collapsed;
  if (open ?? c.has(key)) c.delete(key);
  else c.add(key);
  renderSlskSongs(true);
}

function slskSetAllGroups(open) {
  const search = state.slsk.searches.find((x) => x.id === state.slsk.current);
  if (!search) return;
  if (open) state.slsk.collapsed.clear();
  else for (const f of search.files) state.slsk.collapsed.add(`${f.username}\0${f.filename.slice(0, f.filename.length - baseName(f.filename).length)}`);
  renderSlskSongs(true);
}

$("slsk-sort").addEventListener("change", () => {
  setPref("slskSort", $("slsk-sort").value);
  renderSlskSongs();
});

async function slskSearch(text) {
  const s = state.slsk;
  let id;
  try {
    id = await invoke("slsk_search", { text });
  } catch (e) {
    setStatus(String(e), 6000);
    return;
  }
  s.searches.unshift({ id, text, files: [], complete: false });
  s.searches.length = Math.min(s.searches.length, SLSK_MAX_SEARCHES);
  s.current = id;
  s.filter = "";
  el.search.value = "";
  renderSlsk();
  for (let i = 0; i < 120; i++) { // slskd ends a search after 15 s; stop asking after 2 min whatever happens
    await new Promise((r) => setTimeout(r, 1000));
    const search = s.searches.find((x) => x.id === id);
    if (!search) return; // removed
    try {
      const r = await invoke("slsk_search_results", { id });
      Object.assign(search, { files: r.files, complete: r.complete });
    } catch (e) {
      Object.assign(search, { complete: true, error: String(e) });
    }
    if (state.source === "slsk") {
      const li = el.artistList.querySelector(`li[data-key="${id}"] .count`);
      if (li) li.textContent = search.complete ? search.files.length : "…";
      if (s.current === id) renderSlskSongs(true);
    }
    if (search.complete) return;
  }
}

function slskSelect(id) {
  state.slsk.current = id;
  for (const x of el.artistList.children) x.classList.toggle("sel", x.dataset.key === id);
  renderSlskSongs();
}

function slskRemoveSearch(id) {
  const s = state.slsk;
  s.searches = s.searches.filter((x) => x.id !== id);
  invoke("slsk_search_stop", { id }).catch(() => {});
  renderSlsk();
}

/** Queue result rows for download, grouped by the user who has them. */
async function slskDownload(tracks) {
  const byUser = new Map();
  let switched = null;
  for (const t of tracks) {
    let f = t.slsk;
    // a single song from a busy user: take an identical copy from someone with a free slot instead
    if (tracks.length === 1 && !f.freeSlot) {
      const alt = slskBestCopy(f.filename, f.size, new Set([f.username]));
      if (alt?.freeSlot) [f, switched] = [alt, alt.username];
    }
    if (!byUser.has(f.username)) byUser.set(f.username, []);
    byUser.get(f.username).push({ filename: f.filename, size: f.size });
  }
  try {
    for (const [username, files] of byUser) await invoke("slsk_download", { username, files });
    setStatus(switched ? `Downloading “${tracks[0].title}” from ${switched}, who has a free slot — see Downloads`
      : tracks.length === 1 ? `Downloading “${tracks[0].title}” — see Downloads` : `Downloading ${tracks.length} files — see Downloads`, 5000);
  } catch (e) {
    setStatus(String(e), 6000);
  }
  pollSlskTransfers();
}

// ------------------------------------------- picking and switching sources
// Soulseek users send to a few people at a time, and some never get to you. A file is the same
// file when its name and size match, so any user with an identical copy can stand in.

const slskFileKey = (filename, size) => `${baseName(filename).toLowerCase()}\0${size}`;
const slskSourceScore = (f) => (f.freeSlot ? 1e12 : 0) + f.uploadSpeed - f.queueLength * 1e5;

/** Identical copies in the searches done so far (and the ones run to find other sources). */
function slskCopies(filename, size) {
  const key = slskFileKey(filename, size), out = [];
  for (const files of [...state.slsk.searches.map((x) => x.files), state.slsk.extraFiles]) {
    for (const f of files) if (slskFileKey(f.filename, f.size) === key) out.push(f);
  }
  return out;
}

/** The best copy not from one of the users in `skip`. */
function slskBestCopy(filename, size, skip) {
  return slskCopies(filename, size).filter((f) => !skip.has(f.username)).sort((a, b) => slskSourceScore(b) - slskSourceScore(a))[0];
}

/** Words to search for a file by: its name without track number, extension and punctuation. */
const slskSearchWords = (filename) => baseName(filename).replace(/\.[^.]+$/, "").replace(/^[\d\s._-]+/, "").replace(/[_()[\].-]+/g, " ").replace(/\s+/g, " ").trim();

const SLSK_SWITCH_AFTER = 2 * 60 * 1000;
const slskWaitingSince = new Map(); // transfer id -> when we first saw it waiting in a queue
const slskTried = new Map(); // file key -> users already tried
const slskLookedUp = new Set(); // file keys we've searched for other sources
let slskSwitching = false;

/** Move downloads that have waited in someone's queue too long to another user with the same file. */
async function slskSwitchStuck() {
  if (slskSwitching) return;
  slskSwitching = true;
  const now = Date.now();
  for (const x of state.slsk.transfers) {
    if (!x.state.includes("Remotely")) {
      slskWaitingSince.delete(x.id);
      continue;
    }
    if (!slskWaitingSince.has(x.id)) slskWaitingSince.set(x.id, now);
    if (now - slskWaitingSince.get(x.id) < SLSK_SWITCH_AFTER) continue;
    const key = slskFileKey(x.filename, x.size);
    const tried = slskTried.get(key) || new Set();
    tried.add(x.username);
    slskTried.set(key, tried);
    const alt = slskBestCopy(x.filename, x.size, tried);
    if (!alt) {
      // nobody else in our searches has it: look once, and try again on a later round
      if (!slskLookedUp.has(key)) {
        slskLookedUp.add(key);
        slskFindSources(x.filename);
      }
      continue;
    }
    tried.add(alt.username);
    slskWaitingSince.delete(x.id);
    try {
      await invoke("slsk_download", { username: alt.username, files: [{ filename: alt.filename, size: alt.size }] });
      await invoke("slsk_cancel", { username: x.username, id: x.id, remove: true });
      setStatus(`“${baseName(x.filename)}” was stuck in ${x.username}'s queue — getting it from ${alt.username} instead`, 6000);
    } catch {}
  }
  slskSwitching = false;
}

/** A quiet search for other copies of a file; its results only feed slskCopies. */
async function slskFindSources(filename) {
  const words = slskSearchWords(filename);
  if (words.length < 3) return;
  try {
    const id = await invoke("slsk_search", { text: words });
    await new Promise((r) => setTimeout(r, 17000));
    const r = await invoke("slsk_search_results", { id });
    state.slsk.extraFiles.push(...r.files);
    if (state.slsk.extraFiles.length > 5000) state.slsk.extraFiles.splice(0, state.slsk.extraFiles.length - 5000);
  } catch {}
}

/** The folder header a file row sits under. */
const slskGroupOf = (t) => state.shown.find((x) => x.group && x.key === t.groupKey);

function slskSongMenu(t) {
  if (t.group) {
    const open = !state.slsk.collapsed.has(t.key);
    return [
      { label: `Download folder (${t.all.length} file${t.all.length === 1 ? "" : "s"})`, icon: "i-download", action: () => slskDownload(t.all) },
      { label: open ? "Collapse" : "Expand", icon: "i-list", action: () => slskToggleGroup(t.key) },
      "-",
      { label: "Collapse all", icon: "i-list", action: () => slskSetAllGroups(false) },
      { label: "Expand all", icon: "i-list", action: () => slskSetAllGroups(true) },
      "-",
      { label: "Copy folder name", icon: "i-link", action: () => copyText(t.folder.split(" / ").pop(), "Folder name copied") },
    ];
  }
  const g = slskGroupOf(t);
  return [
    { label: "Download", icon: "i-download", action: () => slskDownload([t]) },
    { label: `Download whole folder (${g?.all.length ?? 1})`, icon: "i-download", disabled: !g || g.all.length < 2, action: () => slskDownload(g.all) },
    "-",
    { label: "Copy file name", icon: "i-link", action: () => copyText(baseName(t.slsk.filename), "File name copied") },
  ];
}

// ---------------------------------------------------- downloads in slskd

function slskDone(x) {
  return x.state.includes("Completed");
}
function slskOk(x) {
  return x.state.includes("Succeeded");
}
function slskActive() {
  return state.slsk.transfers.filter((x) => !slskDone(x)).length;
}
/** Files other users are downloading from our library right now, or waiting for in our queue. */
function slskSending() {
  return state.slsk.uploads.filter((x) => !slskDone(x)).length;
}
let slskTransferTimer, slskSeenDone = null, slskRescanTimer;
// What the last poll saw, to tell what's new. null until the first poll after connecting, so
// what was already there doesn't all announce itself at once.
let slskSeenUploads = null, slskSeenFinished = null;

async function pollSlskTransfers() {
  clearTimeout(slskTransferTimer);
  const s = state.slsk;
  if (!s.status) return;
  try {
    s.transfers = await invoke("slsk_transfers");
  } catch {
    return;
  }
  s.uploads = await invoke("slsk_uploads").catch(() => s.uploads);
  slskAnnounce();
  // new files finished: pick them up if the download folder is in the library
  const done = new Set(s.transfers.filter(slskOk).map((x) => x.id));
  if (slskSeenDone && [...done].some((id) => !slskSeenDone.has(id))) {
    clearTimeout(slskRescanTimer);
    slskRescanTimer = setTimeout(() => refreshAutoFolders().then(() => rescan(false)), 2500);
  }
  slskSeenDone = done;
  renderDownloads();
  slskSwitchStuck();
  const busy = slskActive() > 0 || slskSending() > 0 || !$("downloads").hidden;
  slskTransferTimer = setTimeout(pollSlskTransfers, busy ? 1500 : 15000);
}

function slskTransferText(x) {
  const st = x.state;
  if (st.includes("Succeeded")) return `Done · ${fmtBytes(x.size)}`;
  if (st.includes("Cancelled")) return "Cancelled";
  if (st.includes("Completed")) return `Failed${x.error ? `: ${x.error}` : ` (${st.replace("Completed, ", "")})`}`;
  if (st.includes("InProgress")) {
    const pct = x.size ? Math.floor((x.bytes / x.size) * 100) : 0;
    return `${pct}% · ${fmtBytes(x.bytes)} of ${fmtBytes(x.size)}${x.speed ? ` · ${fmtBytes(x.speed)}/s` : ""}`;
  }
  if (st.includes("Remotely")) {
    const place = slskPlaces.get(x.username) ?? x.placeInQueue;
    return place ? `In their queue — ${ordinal(place)} in line` : "In their queue — waiting for them to start sending";
  }
  if (st.includes("Queued")) return "Waiting";
  return "Starting…";
}

const ordinal = (n) => n + ([, "st", "nd", "rd"][(n % 100 >> 3) ^ 1 && n % 10] || "th");

// Where we are in each uploader's queue: asked for one file per user (the place is about the
// same for all of a user's files), one question at a time, at most once a minute per user.
// The other user may never answer, and each question waits a few seconds for them.
const slskPlaces = new Map(), slskPlaceAsked = new Map();
let slskAsking = false;
async function askSlskPlaces() {
  if (slskAsking) return;
  slskAsking = true;
  const now = Date.now(), users = new Set();
  for (const x of state.slsk.transfers) {
    if (!x.state.includes("Remotely") || users.has(x.username) || now - (slskPlaceAsked.get(x.username) || 0) < 60000) continue;
    users.add(x.username);
    slskPlaceAsked.set(x.username, now);
    const place = await invoke("slsk_queue_position", { username: x.username, id: x.id }).catch(() => null);
    if (place != null) {
      slskPlaces.set(x.username, place);
      if (!$("downloads").hidden) renderSlskTransfers();
    }
  }
  slskAsking = false;
}

/** Say in the status line when someone starts downloading from the library, and when our own
 *  Soulseek downloads finish or fail. */
function slskAnnounce() {
  const s = state.slsk, notes = [];
  if (slskSeenUploads) {
    const fresh = s.uploads.filter((x) => !slskSeenUploads.has(x.id) && !slskDone(x));
    const byUser = new Map();
    for (const x of fresh) byUser.set(x.username, [...(byUser.get(x.username) || []), x]);
    for (const [user, files] of byUser) {
      notes.push(files.length === 1
        ? `${user} is downloading "${baseName(files[0].filename)}" from your library`
        : `${user} is downloading ${files.length} songs from your library`);
    }
  }
  slskSeenUploads = new Set(s.uploads.map((x) => x.id));

  if (slskSeenFinished) {
    const fresh = s.transfers.filter((x) => slskDone(x) && !slskSeenFinished.has(x.id) && !x.state.includes("Cancelled"));
    const ok = fresh.filter(slskOk), bad = fresh.filter((x) => !slskOk(x));
    if (ok.length) notes.push(ok.length === 1 ? `Downloaded "${baseName(ok[0].filename)}" from Soulseek` : `Downloaded ${ok.length} songs from Soulseek`);
    if (bad.length) notes.push(bad.length === 1 ? `Couldn't download "${baseName(bad[0].filename)}" (see Downloads)` : `${bad.length} Soulseek downloads failed (see Downloads)`);
  }
  slskSeenFinished = new Set(s.transfers.filter(slskDone).map((x) => x.id));
  if (notes.length) setStatus(notes.join(" · "), 8000);
}

function slskUploadText(x) {
  const st = x.state;
  if (st.includes("Succeeded")) return `Sent · ${fmtBytes(x.size)}`;
  if (st.includes("Cancelled")) return "Cancelled";
  if (st.includes("Completed")) return `Stopped${x.error ? `: ${x.error}` : ` (${st.replace("Completed, ", "")})`}`;
  if (st.includes("InProgress")) {
    const pct = x.size ? Math.floor((x.bytes / x.size) * 100) : 0;
    return `Sending · ${pct}% · ${fmtBytes(x.bytes)} of ${fmtBytes(x.size)}${x.speed ? ` · ${fmtBytes(x.speed)}/s` : ""}`;
  }
  if (st.includes("Queued")) return x.placeInQueue ? `Waiting in your queue — ${ordinal(x.placeInQueue)} in line` : "Waiting in your queue";
  return "Starting…";
}

function renderSlskUploads() {
  const list = state.slsk.uploads;
  $("dl-up-title").hidden = $("dl-up-note").hidden = !list.length;
  $("dl-up-title").textContent = `Shared from your library · ${list.length}`;
  $("dl-up").innerHTML = list.slice(0, 300).map((x) => {
    const cls = slskOk(x) ? "saved" : slskDone(x) && !x.state.includes("Cancelled") ? "failed" : "";
    const bar = x.state.includes("InProgress") && x.size ? `<div class="dl-bar small"><i style="width:${(x.bytes / x.size) * 100}%"></i></div>` : "";
    const actions = !slskDone(x)
      ? `<button class="icon-btn" data-act="slsk-up-cancel" title="Stop sending this"><svg viewBox="0 0 12 12" class="x"><path d="M2 2l8 8M10 2l-8 8"/></svg></button>`
      : `<button class="icon-btn" data-act="slsk-up-remove" title="Remove from list"><svg viewBox="0 0 12 12" class="x"><path d="M2 2l8 8M10 2l-8 8"/></svg></button>`;
    const name = baseName(x.filename);
    return `<div class="dl-row ${cls}" data-slsk-up="${esc(x.id)}">${coverHtml("", parentName(x.filename) || name)}<div class="dl-row-text">` +
      `<div class="name" title="${esc(x.filename)}">${esc(name)}</div><div class="sub" title="${esc(slskUploadText(x))}">${esc(x.username)} · ${esc(slskUploadText(x))}</div>${bar}</div>` +
      `<div class="dl-row-actions">${actions}</div></div>`;
  }).join("");
}

$("downloads").addEventListener("click", async (e) => {
  const b = e.target.closest("button[data-act^='slsk-up-']");
  if (!b) return;
  const x = state.slsk.uploads.find((t) => t.id === b.closest(".dl-row").dataset.slskUp);
  if (!x) return;
  await invoke("slsk_cancel_upload", { username: x.username, id: x.id, remove: b.dataset.act === "slsk-up-remove" })
    .catch((err) => setStatus(String(err), 5000));
  pollSlskTransfers();
});

function renderSlskTransfers() {
  const list = state.slsk.transfers;
  $("dl-slsk-title").hidden = !list.length;
  $("dl-slsk-title").textContent = `Soulseek · ${list.length}`;
  // Soulseek users send to a few people at a time, so "queued" is normal and can last a while
  $("dl-slsk-note").hidden = !list.some((x) => x.state.includes("Remotely"));
  if (!$("downloads").hidden) askSlskPlaces();
  $("dl-slsk").innerHTML = list.slice(0, 300).map((x) => {
    const failed = slskDone(x) && !slskOk(x);
    const cls = slskOk(x) ? "saved" : failed ? "failed" : "";
    const bar = x.state.includes("InProgress") && x.size ? `<div class="dl-bar small"><i style="width:${(x.bytes / x.size) * 100}%"></i></div>` : "";
    const actions = !slskDone(x) ? `<button class="icon-btn" data-act="slsk-cancel" title="Cancel"><svg viewBox="0 0 12 12" class="x"><path d="M2 2l8 8M10 2l-8 8"/></svg></button>`
      : (x.path && !phone ? `<button class="btn small" data-act="slsk-reveal">Show in folder</button>` : "") +
        (failed ? `<button class="btn small" data-act="slsk-retry">Retry</button>` : "") +
        `<button class="icon-btn" data-act="slsk-remove" title="Remove from list"><svg viewBox="0 0 12 12" class="x"><path d="M2 2l8 8M10 2l-8 8"/></svg></button>`;
    const name = baseName(x.filename);
    return `<div class="dl-row ${cls}" data-slsk="${esc(x.id)}">${coverHtml("", parentName(x.filename) || name)}<div class="dl-row-text">` +
      `<div class="name" title="${esc(x.filename)}">${esc(name)}</div><div class="sub" title="${esc(slskTransferText(x))}">${esc(x.username)} · ${esc(slskTransferText(x))}</div>${bar}</div>` +
      `<div class="dl-row-actions">${actions}</div></div>`;
  }).join("");
}

$("downloads").addEventListener("click", async (e) => {
  const b = e.target.closest("button[data-act^='slsk-']:not([data-act^='slsk-up-'])");
  if (!b) return;
  const x = state.slsk.transfers.find((t) => t.id === b.closest(".dl-row").dataset.slsk);
  if (!x) return;
  const act = b.dataset.act;
  try {
    if (act === "slsk-cancel") await invoke("slsk_cancel", { username: x.username, id: x.id, remove: false });
    if (act === "slsk-remove") await invoke("slsk_cancel", { username: x.username, id: x.id, remove: true });
    if (act === "slsk-reveal") await invoke("slsk_reveal", { path: x.path });
    if (act === "slsk-retry") {
      await invoke("slsk_cancel", { username: x.username, id: x.id, remove: true });
      await invoke("slsk_download", { username: x.username, files: [{ filename: x.filename, size: x.size }] });
    }
  } catch (err) {
    setStatus(String(err), 5000);
  }
  pollSlskTransfers();
});

// ---------------------------------------------------------- settings

function renderSlskSettings() {
  const c = state.settings.soulseek || {}, s = state.slsk;
  const status = $("slsk-status");
  status.textContent = slskStatusText();
  status.className = "hint" + (slskLoggedIn() ? " ok" : s.error && !s.status ? " err" : "");
  $("slsk-connect").textContent = s.status ? "Reconnect" : "Connect";
  $("slsk-connect").disabled = s.connecting;
  $("slsk-disconnect").hidden = !s.status;
  // the built-in client needs only the login, like slskd run for you
  const external = !!c.external && !c.builtin;
  $("slsk-builtin").checked = !!c.builtin;
  $("slsk-slskd-row").hidden = !!c.builtin;
  $("slsk-exe-row").hidden = !!c.builtin;
  $("slsk-managed").checked = !c.external;
  $("slsk-managed-fields").hidden = external;
  $("slsk-external-fields").hidden = !external;
  $("slsk-managed-groups").hidden = external;
  $("slsk-share").checked = c.shareLibrary !== false;
  $("slsk-auto").checked = !!c.autoConnect;
  $("slsk-exe").textContent = c.exePath || "Not installed yet";
  for (const [id, value] of [["slsk-user", c.username], ["slsk-pass", c.password], ["slsk-port", c.listenPort || ""], ["slsk-url", c.url], ["slsk-key", c.apiKey]]) {
    if (document.activeElement !== $(id)) $(id).value = value ?? "";
  }
  invoke("slsk_folder").then((f) => ($("slsk-folder").textContent = f));
}

async function saveSlskConfig() {
  const c = state.settings.soulseek || {};
  state.settings = await invoke("slsk_set_config", {
    config: {
      ...c,
      external: !$("slsk-managed").checked,
      url: $("slsk-url").value,
      apiKey: $("slsk-key").value,
      exePath: c.exePath || "",
      username: $("slsk-user").value,
      password: $("slsk-pass").value,
      shareLibrary: $("slsk-share").checked,
      listenPort: Number($("slsk-port").value) || 0,
      autoConnect: $("slsk-auto").checked,
      builtin: $("slsk-builtin").checked,
    },
  });
  renderSlskSettings();
}

for (const id of ["slsk-builtin", "slsk-managed", "slsk-share", "slsk-auto", "slsk-user", "slsk-pass", "slsk-port", "slsk-url", "slsk-key"]) {
  $(id).addEventListener("change", saveSlskConfig);
}
$("slsk-connect").addEventListener("click", async () => {
  await saveSlskConfig();
  slskConnect();
});
$("slsk-disconnect").addEventListener("click", slskDisconnect);
$("slsk-browse").addEventListener("click", async () => {
  const path = await invoke("slsk_pick_exe");
  if (!path) return;
  state.settings.soulseek = { ...state.settings.soulseek, exePath: path };
  await saveSlskConfig();
});
$("slsk-change").addEventListener("click", async () => {
  const settings = await invoke("slsk_pick_folder");
  if (settings) state.settings = settings;
  renderSlskSettings();
  if (settings) refreshAutoFolders().then(() => rescan(false));
});
$("slsk-open").addEventListener("click", () => invoke("slsk_open_folder").catch((e) => setStatus(String(e), 5000)));
$("slsk-empty-setup").addEventListener("click", () => showIntegration("slsk"));
$("slsk-empty-connect").addEventListener("click", slskConnect);

// ------------------------------------------- "Download for me" (yt-dlp, slskd)

const toolButtons = { "yt-dlp": "dl-ytdlp-get", slskd: "slsk-get" };
const toolStatus = { "yt-dlp": "dl-ytdlp-status", slskd: "slsk-tool-status" };

async function installTool(name) {
  const button = $(toolButtons[name]), status = $(toolStatus[name]);
  button.disabled = true;
  status.className = "hint";
  status.textContent = `Downloading ${name} from GitHub…`;
  try {
    state.settings = await invoke("tool_install", { name });
    status.className = "hint ok";
    status.textContent = `Installed ${name}.`;
    renderDownloadSettings();
    renderSlskSettings();
    if (name === "yt-dlp") checkYtdlp();
  } catch (e) {
    status.className = "hint err";
    status.textContent = String(e);
  }
  button.disabled = false;
}

listen("tool-progress", ({ payload }) => {
  const status = $(toolStatus[payload.name]);
  if (!status) return;
  status.textContent = `Downloading ${payload.name}… ${fmtBytes(payload.done)}${payload.total ? ` of ${fmtBytes(payload.total)}` : ""}`;
});
$("dl-ytdlp-get").addEventListener("click", () => installTool("yt-dlp"));
$("slsk-get").addEventListener("click", () => installTool("slskd"));


// ------------------------------------------- Integrations: one service at a time

/** Open Settings → Integrations on one service ("sc", "slsk", "lfm", "discord"). */
function showIntegration(key) {
  openSettings();
  el.settings.querySelector('.settings-tabs [data-tab="integrations"]').click();
  selectIntegration(key);
}

function selectIntegration(key) {
  for (const b of $("int-nav").children) b.classList.toggle("on", b.dataset.int === key);
  for (const panel of el.settings.querySelectorAll(".int-panel")) panel.hidden = panel.dataset.int !== key;
  el.settings.querySelector(".settings-body").scrollTop = 0;
}

$("int-nav").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-int]");
  if (b) selectIntegration(b.dataset.int);
});

/** Each tile repeats its service's status line, with a green dot while it's connected or on. */
function syncIntegrationTiles() {
  for (const b of $("int-nav").children) {
    const status = $(b.dataset.status);
    // just the gist: "Connected as x · port 2234" -> "Connected"
    b.querySelector(".state").textContent = status.textContent.split(/ as |[.—(·]/)[0].trim();
    b.classList.toggle("live", status.classList.contains("ok"));
  }
}
const tileWatcher = new MutationObserver(syncIntegrationTiles);
for (const b of $("int-nav").children) {
  tileWatcher.observe($(b.dataset.status), { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ["class"] });
}
syncIntegrationTiles();

// ---------------------------------------------------------------- setup guide
// A step-by-step walk through the main settings, shown on first start and from Settings → Library.
// The steps borrow the real controls from the Settings pages (and put them back afterwards), so
// everything works exactly as it does there.

const ONBOARD_STEPS = ["welcome", "music", "look", "sc", "slsk", "lfm", "discord", "done"];
const onboard = { active: false, step: 0, borrowed: [] };

/** The Settings controls each step shows. A .group moves as it is; rows are put in a new group. */
function onboardParts(step) {
  const group = (id) => $(id).closest(".group");
  const row = (id) => $(id).closest(".row");
  return {
    look: [row("accent-swatches")],
    sc: [group("sc-status")],
    slsk: [row("slsk-exe"), $("slsk-tool-status"), group("slsk-user"), row("slsk-status")],
    lfm: lastfmBuiltin ? [group("lfm-status")] : [group("lfm-keys"), group("lfm-status")],
    discord: [group("discord-id"), group("discord-status")],
  }[step]?.filter(Boolean) || [];
}

function borrowControls() {
  for (const box of el.settings.querySelectorAll(".ob-borrow")) {
    let holder = null;
    for (const node of onboardParts(box.dataset.borrow)) {
      const marker = document.createComment("borrowed by the setup guide");
      node.before(marker);
      onboard.borrowed.push({ node, marker });
      if (node.classList.contains("group")) {
        box.append(node);
        holder = null;
      } else {
        if (!holder) box.append((holder = Object.assign(document.createElement("div"), { className: "group" })));
        holder.append(node);
      }
    }
  }
}

function returnControls() {
  for (const { node, marker } of onboard.borrowed) marker.replaceWith(node);
  onboard.borrowed = [];
  for (const box of el.settings.querySelectorAll(".ob-borrow")) box.innerHTML = "";
}

function openOnboarding() {
  if (onboard.active) return;
  openSettings();
  onboard.active = true;
  el.settings.querySelector(".settings").classList.add("onboarding");
  $("onboard").hidden = false;
  borrowControls();
  showOnboardStep(0);
}

/** Leave the guide (finished or skipped); it isn't shown on its own again. */
function endOnboarding() {
  if (!onboard.active) return;
  onboard.active = false;
  returnControls();
  $("onboard").hidden = true;
  el.settings.querySelector(".settings").classList.remove("onboarding");
  if (!prefs.onboarded) setPref("onboarded", true);
}

function showOnboardStep(n) {
  onboard.step = Math.max(0, Math.min(ONBOARD_STEPS.length - 1, n));
  const step = ONBOARD_STEPS[onboard.step];
  for (const page of el.settings.querySelectorAll(".ob-page")) page.hidden = page.dataset.step !== step;
  $("onboard-dots").innerHTML = ONBOARD_STEPS.map((s, i) => `<i class="${i === onboard.step ? "on" : i < onboard.step ? "past" : ""}"></i>`).join("");
  const first = step === "welcome", last = step === "done";
  $("onboard-back").hidden = first;
  $("onboard-skip").hidden = first || last;
  $("onboard-quit").hidden = last;
  $("onboard-next").textContent = first ? "Get started" : last ? "Start listening" : "Next";
  if (step === "music") renderFolders();
  if (step === "done") renderOnboardSummary();
  el.settings.querySelector(".onboard-body").scrollTop = 0;
}

function renderOnboardSummary() {
  const folders = state.settings.folders.length;
  const line = (name, text, on) => `<li class="${on ? "on" : ""}"><b>${esc(name)}</b><span>${esc(text)}</span></li>`;
  const status = (id) => [$(id).textContent.trim(), $(id).classList.contains("ok")];
  $("ob-summary").innerHTML =
    line("Music", folders ? `${folders} folder${folders === 1 ? "" : "s"} added` : "No folders yet — downloads still show up", folders > 0) +
    line("SoundCloud", ...status("sc-status")) +
    line("Soulseek", ...status("slsk-status")) +
    line("Last.fm", ...status("lfm-status")) +
    line("Discord", ...status("discord-status"));
}

$("onboard-next").addEventListener("click", () => {
  if (ONBOARD_STEPS[onboard.step] === "done") return closeSettings();
  showOnboardStep(onboard.step + 1);
});
$("onboard-skip").addEventListener("click", () => showOnboardStep(onboard.step + 1));
$("onboard-back").addEventListener("click", () => showOnboardStep(onboard.step - 1));
$("onboard-quit").addEventListener("click", closeSettings);
$("ob-add-folder").addEventListener("click", addFolder);
$("ob-folders").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-i]");
  if (btn) removeFolder(state.settings.folders[Number(btn.dataset.i)]);
});
$("run-setup").addEventListener("click", () => {
  closeSettings();
  setTimeout(openOnboarding, 260 * Number(prefs.speed));
});

// ---------------------------------------------------------------- updates
// Once at start and then twice a day, ask GitHub whether a newer release is out. If so, an Update
// button appears in the title bar that opens the release page; the × skips that version.

const update = { info: null, error: "", checking: false, canInstall: false, installing: null };
invoke("can_self_update").then((can) => {
  update.canInstall = !!can;
  renderUpdate();
}, () => {});

async function checkForUpdate(manual = false) {
  if (update.checking) return;
  update.checking = true;
  update.error = "";
  renderUpdate();
  try {
    update.info = await invoke("check_update", { pretend: window.__pretendVersion || null });
    const { newer, latest } = update.info;
    if (newer && (manual || latest !== prefs.skipVersion)) {
      if (manual && latest === prefs.skipVersion) setPref("skipVersion", ""); // asked by hand: show it again
      setStatus(`yuuricloud ${latest} is out — click ${update.canInstall ? "Install" : "Update"} at the top to get it`, 8000);
    } else if (manual) {
      setStatus(newer ? "" : "You have the newest version", 4000);
    }
  } catch (e) {
    update.error = String(e);
    if (manual) setStatus(`Couldn't check for updates: ${e}`, 6000);
  }
  update.checking = false;
  renderUpdate();
}

function renderUpdate() {
  const info = update.info;
  const show = !!info?.newer && info.latest !== prefs.skipVersion;
  $("update-pill").hidden = !show;
  if (show) {
    const pct = update.installing;
    $("update-open").textContent = pct != null ? (pct >= 0 ? `Downloading… ${pct}%` : "Downloading…") : `${update.canInstall ? "Install" : "Update to"} ${info.latest}`;
    $("update-open").disabled = pct != null;
    $("update-open").title = update.canInstall
      ? `yuuricloud ${info.latest} is out (you have ${info.current}). Downloads it, installs it and restarts.`
      : `yuuricloud ${info.latest} is out (you have ${info.current}). Opens its download page.`;
  }
  const status = $("update-status");
  status.className = "hint" + (show ? " ok" : update.error ? " err" : "");
  status.textContent = update.checking ? "Checking…"
    : update.error ? `Couldn't check: ${update.error}`
    : !info ? "Not checked yet"
    : info.newer ? `Version ${info.latest} is out — you have ${info.current}`
    : `You have the newest version (${info.current})`;
  $("update-check").disabled = update.checking;
}

$("update-open").addEventListener("click", async () => {
  if (!update.info || update.installing != null) return;
  if (!update.canInstall) return window.__TAURI__.opener.openUrl(update.info.url);
  update.installing = -1;
  renderUpdate();
  saveSession();
  const stop = await listen("update-progress", ({ payload: [got, total] }) => {
    update.installing = total ? Math.floor((got / total) * 100) : -1;
    renderUpdate();
  });
  try {
    await invoke("install_update"); // restarts the app when it worked
  } catch (e) {
    setStatus(`${e} — opening the download page instead.`, 8000);
    window.__TAURI__.opener.openUrl(update.info.url);
  }
  stop();
  update.installing = null;
  renderUpdate();
});
$("update-skip").addEventListener("click", () => {
  if (!update.info) return;
  setPref("skipVersion", update.info.latest);
  renderUpdate();
  setStatus(`Skipped ${update.info.latest}. Settings → Library → Check now brings it back.`, 5000);
});
$("update-check").addEventListener("click", () => checkForUpdate(true));
setInterval(() => prefs.checkUpdates && checkForUpdate(), 12 * 60 * 60 * 1000);
renderUpdate();

// ---------------------------------------------------------------- song editor
// Change a song's title, artists, album, numbers, year and cover; written into the file itself.
// Artist and album fields suggest names already in the library, and point out near-misses
// ("lil darkie" → "Lil Darkie") so a typo doesn't split an artist in two.

const editor = { track: null, cover: { kind: "keep" }, albumSongs: [], saving: false };

/** Lower case, letters and digits only: "Lil-Darkie " and "lil darkie" compare equal. */
const nameKey = (s) => s.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, "");

function editDistance(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 3;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = row;
  }
  return prev[b.length];
}

/** The library name `value` was probably meant to be, if it isn't exactly one already. */
function closestName(value, names) {
  const v = value.trim();
  if (!v || names.includes(v)) return null;
  const k = nameKey(v);
  if (!k) return null;
  const same = names.find((n) => nameKey(n) === k);
  if (same) return same; // differs only in capitals, spaces or punctuation
  if (k.length < 5) return null;
  let best = null, bestD = k.length >= 7 ? 2 : 1;
  for (const n of names) {
    const d = editDistance(k, nameKey(n));
    if (d <= bestD) [best, bestD] = [n, d - 0.5];
  }
  return best;
}

function libraryNames() {
  const artists = new Set(), albums = new Set();
  for (const t of state.tracks) {
    for (const a of [t.artist, t.albumArtist]) if (a && a !== "Unknown Artist") artists.add(a);
    if (t.album && t.album !== "Unknown Album") albums.add(t.album);
  }
  return { artists: [...artists].sort(collator.compare), albums: [...albums].sort(collator.compare) };
}

function editorSuggest(inputId, hintId, names) {
  const input = $(inputId), hint = $(hintId);
  const match = closestName(input.value, names);
  hint.hidden = !match;
  if (match) {
    hint.innerHTML = `Did you mean <button type="button" class="link">${esc(match)}</button>?`;
    hint.querySelector("button").onclick = () => {
      input.value = match;
      hint.hidden = true;
    };
  }
}

async function openEditor(t) {
  closeMenu();
  let tags;
  try {
    tags = await invoke("song_tags", { path: t.path });
  } catch (e) {
    return setStatus(String(e), 6000);
  }
  editor.track = t;
  editor.tracks = null;
  editor.trackChanges = null;
  editor.hadCover = !!tags.cover;
  setEditorMode("song");
  editor.cover = { kind: "keep" };
  editor.albumSongs = state.tracks.filter((x) => albumKey(x) === albumKey(t));
  const names = libraryNames();
  editor.names = names;
  $("ed-artists").innerHTML = names.artists.map((n) => `<option value="${esc(n)}"></option>`).join("");
  $("ed-albums").innerHTML = names.albums.map((n) => `<option value="${esc(n)}"></option>`).join("");
  // empty tags fall back to what the library shows (it may come from the folder names)
  $("ed-title").value = tags.title || t.title;
  $("ed-artist").value = tags.artist || t.artist;
  $("ed-album-artist").value = tags.albumArtist || (tags.artist ? "" : t.albumArtist);
  $("ed-album").value = tags.album || (t.album === "Unknown Album" ? "" : t.album);
  $("ed-track").value = tags.trackNo ?? (t.trackNo || "");
  $("ed-disc").value = tags.discNo ?? "";
  $("ed-year").value = tags.year || t.year || "";
  $("ed-genre").value = tags.genre || t.genre || "";
  fillGenreList();
  $("ed-path").textContent = t.path;
  $("ed-path").title = t.path;
  for (const id of ["ed-artist-hint", "ed-album-artist-hint", "ed-album-hint"]) $(id).hidden = true;
  setEditorCover(tags.cover, t);
  $("editor-album-count").textContent = editor.albumSongs.length;
  $("editor-cover-all-row").hidden = editor.albumSongs.length < 2;
  $("editor-cover-all").checked = true;
  $("editor-error").textContent = "";
  $("editor-error").className = "hint err";
  $("editor-save").disabled = false;
  $("editor").hidden = false;
  $("ed-title").focus();
  $("ed-title").select();
}

function setEditorCover(src, t = editor.track) {
  $("editor-cover-img").outerHTML = coverHtml(src || "", t.album || t.title).replace('class="cover"', 'id="editor-cover-img" class="cover"');
  $("editor-cover-remove").disabled = !src;
}

function closeEditor() {
  $("editor").hidden = true;
  editor.track = null;
  editor.tracks = null;
}

function setEditorMode(mode) {
  editor.mode = mode;
  $("editor").querySelector(".editor").classList.toggle("album-mode", mode === "album");
  $("editor-title").textContent = mode === "album" ? "Edit album info" : "Edit song info";
  $("editor-find-panel").hidden = true;
  for (const id of ["ed-artist", "ed-album-artist", "ed-album", "ed-disc", "ed-year", "ed-genre"]) $(id).placeholder = "";
}

function fillGenreList() {
  $("ed-genres").innerHTML = [...new Set(state.tracks.map((t) => t.genre).filter(Boolean))].sort(collator.compare)
    .map((g) => `<option value="${esc(g)}"></option>`).join("");
}

/** Edit a whole album at once: the fields all its songs share (left empty where they differ). */
async function openAlbumEditor(tracks) {
  closeMenu();
  const t = tracks[0];
  let tags = {};
  try {
    tags = await invoke("song_tags", { path: t.path });
  } catch {}
  editor.track = t;
  editor.tracks = tracks;
  editor.trackChanges = null;
  editor.hadCover = !!tags.cover;
  setEditorMode("album");
  editor.cover = { kind: "keep" };
  editor.albumSongs = tracks;
  const names = libraryNames();
  editor.names = names;
  $("ed-artists").innerHTML = names.artists.map((n) => `<option value="${esc(n)}"></option>`).join("");
  $("ed-albums").innerHTML = names.albums.map((n) => `<option value="${esc(n)}"></option>`).join("");
  const common = (f) => (tracks.every((x) => f(x) === f(t)) ? f(t) : null);
  editor.initial = {};
  const fill = (id, value) => {
    $(id).value = value ?? "";
    if (value === null) $(id).placeholder = "Different on each song — leave to keep";
    editor.initial[id] = $(id).value;
  };
  fill("ed-artist", common((x) => x.artist));
  fill("ed-album-artist", common((x) => x.albumArtist));
  fill("ed-album", common((x) => x.album));
  fill("ed-disc", common((x) => String(x.discNo || "")));
  fill("ed-year", common((x) => x.year || ""));
  fill("ed-genre", common((x) => x.genre || ""));
  fillGenreList();
  $("ed-path").textContent = `${countOf(tracks.length, "song")} · ${parentDir(t.path)}`;
  $("ed-path").title = t.path;
  for (const id of ["ed-artist-hint", "ed-album-artist-hint", "ed-album-hint"]) $(id).hidden = true;
  setEditorCover(tags.cover, t);
  $("editor-cover-all-row").hidden = true;
  $("editor-cover-all").checked = true;
  $("editor-error").textContent = "";
  $("editor-error").className = "hint err";
  $("editor-save").disabled = false;
  $("editor").hidden = false;
  $("ed-album").focus();
}
const parentDir = (p) => p.replace(/[\\/][^\\/]*$/, "");

/** Album mode: the fields that were changed, for every song (plus what MusicBrainz matched). */
function albumChanges() {
  const changed = {};
  const map = { "ed-artist": "artist", "ed-album-artist": "albumArtist", "ed-album": "album", "ed-year": "year", "ed-genre": "genre" };
  for (const [id, key] of Object.entries(map)) if ($(id).value !== editor.initial[id]) changed[key] = $(id).value;
  if ($("ed-disc").value !== editor.initial["ed-disc"]) changed.discNo = Math.max(0, Math.floor(Number($("ed-disc").value) || 0));
  return editor.tracks.map((t) => ({ path: t.path, changes: { ...changed, ...(editor.trackChanges?.get(t.path) || {}) } }))
    .filter((x) => Object.keys(x.changes).length || editor.cover.kind !== "keep");
}

/** Close a song's file if it's playing (it can't be rewritten meanwhile); returns how to resume. */
function releasePlaying(paths) {
  const t = current();
  if (!t || !paths.includes(t.path)) return () => {};
  const at = audio.currentTime, playing = !audio.paused;
  audio.pause();
  audio.removeAttribute("src");
  audio.load();
  return () => {
    const now = current() || t;
    setSrc(audio, now.path);
    audio.addEventListener("loadedmetadata", () => (audio.currentTime = at), { once: true });
    if (playing) audio.play().catch(() => {});
  };
}

async function saveAlbumEditor() {
  const songs = albumChanges();
  if (!songs.length) return closeEditor();
  const resume = releasePlaying(songs.map((x) => x.path));
  editor.saving = true;
  $("editor-save").disabled = true;
  $("editor-error").textContent = "";
  try {
    await invoke("save_many_tags", { songs, cover: editor.cover });
    closeEditor();
    setStatus(`Saved ${countOf(songs.length, "song")}`, 3000);
    await rescan(false);
  } catch (e) {
    $("editor-error").textContent = String(e);
    $("editor-save").disabled = false;
    if (String(e).startsWith("Saved")) await rescan(false);
  }
  editor.saving = false;
  resume();
}

// ---- Find online (MusicBrainz)

const find = { results: [], token: 0 };
function openFind() {
  const album = editor.mode === "album";
  $("find-a").placeholder = album ? "Album" : "Title";
  $("find-a").value = album ? $("ed-album").value || editor.track.album : $("ed-title").value;
  $("find-b").value = (album ? $("ed-album-artist").value : $("ed-artist").value) || $("ed-artist").value || editor.track.artist;
  $("find-cover").checked = !editor.hadCover && editor.cover.kind !== "file";
  $("find-results").innerHTML = "";
  $("editor-find-panel").hidden = false;
  if ($("find-a").value.trim()) runFind();
  else $("find-a").focus();
}
async function runFind() {
  const token = ++find.token, album = editor.mode === "album";
  const a = $("find-a").value.trim(), b = $("find-b").value.trim();
  if (!a) return;
  $("find-results").innerHTML = `<div class="hint">Searching…</div>`;
  try {
    find.results = album
      ? await invoke("mb_search_album", { album: a, artist: b })
      : await invoke("mb_search_song", { title: a, artist: b, album: $("ed-album").value });
  } catch (e) {
    if (token === find.token) $("find-results").innerHTML = `<div class="hint err">${esc(String(e))}</div>`;
    return;
  }
  if (token !== find.token) return;
  const art = (id) => `<div class="find-art"><img src="https://coverartarchive.org/release/${encodeURIComponent(id)}/front-250" alt="" loading="lazy" onerror="this.remove()"></div>`;
  const len = editor.track.duration;
  $("find-results").innerHTML = find.results.length
    ? find.results.map((m, i) => album
      ? `<button class="find-row" data-i="${i}">${art(m.releaseId)}<div class="find-text"><div>${esc(m.album)}</div>` +
        `<div class="sub">${esc([m.albumArtist, m.year, m.country, m.format, m.trackCount && countOf(m.trackCount, "song")].filter(Boolean).join(" · "))}</div></div><span class="find-score">${m.score}%</span></button>`
      : `<button class="find-row" data-i="${i}">${art(m.releaseId)}<div class="find-text"><div>${esc(m.title)} — ${esc(m.artist)}</div>` +
        `<div class="sub">${esc([m.album, m.year, m.trackNo && `track ${m.trackNo}`, m.length && fmtTime(m.length)].filter(Boolean).join(" · "))}</div></div>` +
        `<span class="find-score" title="${m.length && len && Math.abs(m.length - len) > 10 ? "A different length from this song" : ""}">${m.length && len && Math.abs(m.length - len) > 10 ? "≠ length" : `${m.score}%`}</span></button>`).join("")
    : `<div class="hint">Nothing found. Try fewer words, or check the spelling.</div>`;
}

async function useFound(m) {
  const album = editor.mode === "album";
  const set = (id, v) => v != null && v !== "" && ($(id).value = v);
  if (album) {
    set("ed-album", m.album);
    set("ed-album-artist", m.albumArtist);
    set("ed-year", m.year);
  } else {
    set("ed-title", m.title);
    set("ed-artist", m.artist);
    set("ed-album", m.album);
    if (!$("ed-album-artist").value || m.albumArtist !== m.artist) set("ed-album-artist", m.albumArtist);
    set("ed-year", m.year);
    set("ed-track", m.trackNo);
    set("ed-disc", m.discNo);
  }
  $("editor-find-panel").hidden = true;
  $("editor-error").textContent = "";
  const wantCover = $("find-cover").checked;
  if (album) {
    // match the album's songs to the release's, by title, to fix titles and numbers
    try {
      const songs = await invoke("mb_album_tracks", { releaseId: m.releaseId });
      const key = (x) => songIdentity({ artist: "", title: x }).slice(1);
      const byTitle = new Map(songs.map((s) => [key(s.title), s]));
      editor.trackChanges = new Map();
      for (const t of editor.tracks) {
        const s = byTitle.get(key(t.title)) || (songs.length === editor.tracks.length && !t.trackNo ? null : songs.find((x) => x.trackNo === t.trackNo && x.discNo === (t.discNo || 1) && Math.abs((x.length || 0) - (t.duration || 0)) < 5));
        if (s) editor.trackChanges.set(t.path, { title: s.title, trackNo: s.trackNo, discNo: songs.some((x) => x.discNo > 1) ? s.discNo : undefined });
      }
      $("editor-error").textContent = `Matched ${editor.trackChanges.size} of ${countOf(editor.tracks.length, "song")} to this album's tracks.`;
      $("editor-error").className = "hint";
    } catch (e) {
      $("editor-error").textContent = String(e);
    }
  }
  if (wantCover) {
    $("editor-cover-change").disabled = true;
    try {
      const cover = await invoke("mb_cover", { releaseId: m.releaseId });
      if (cover) {
        editor.cover = { kind: "file", path: cover.path };
        setEditorCover(cover.preview);
      } else {
        $("editor-error").textContent = "That release has no cover on the Cover Art Archive.";
      }
    } catch (e) {
      $("editor-error").textContent = String(e);
    }
    $("editor-cover-change").disabled = false;
  }
}

$("editor-find").addEventListener("click", openFind);
$("find-back").addEventListener("click", () => ($("editor-find-panel").hidden = true));
$("find-form").addEventListener("submit", (e) => {
  e.preventDefault();
  runFind();
});
$("find-results").addEventListener("click", (e) => {
  const row = e.target.closest(".find-row");
  if (row) useFound(find.results[Number(row.dataset.i)]);
});

async function saveEditor() {
  const t = editor.track;
  if (!t || editor.saving) return;
  if (editor.mode === "album") return saveAlbumEditor();
  const num = (id) => (Number($(id).value) > 0 ? Math.floor(Number($(id).value)) : null);
  const edit = {
    title: $("ed-title").value, artist: $("ed-artist").value, albumArtist: $("ed-album-artist").value, album: $("ed-album").value,
    trackNo: num("ed-track"), discNo: num("ed-disc"), year: $("ed-year").value, genre: $("ed-genre").value,
  };
  if (!edit.title.trim()) {
    $("editor-error").textContent = "A song needs a title.";
    return $("ed-title").focus();
  }
  const others = editor.cover.kind !== "keep" && $("editor-cover-all").checked ? editor.albumSongs.map((x) => x.path) : [];
  // the file can't be rewritten while it's playing from it
  const wasPlaying = current()?.path === t.path, at = audio.currentTime, playing = !audio.paused;
  if (wasPlaying) {
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
  }
  editor.saving = true;
  $("editor-save").disabled = true;
  $("editor-error").textContent = "";
  try {
    await invoke("save_song_tags", { path: t.path, edit, cover: editor.cover, coverAlso: others });
    closeEditor();
    setStatus(`Saved “${edit.title.trim()}”`, 3000);
    await rescan(false);
  } catch (e) {
    $("editor-error").textContent = String(e);
    $("editor-save").disabled = false;
  }
  editor.saving = false;
  if (wasPlaying) {
    setSrc(audio, t.path);
    audio.addEventListener("loadedmetadata", () => (audio.currentTime = at), { once: true });
    if (playing) audio.play().catch(() => {});
  }
}

$("editor-close").addEventListener("click", closeEditor);
$("editor-cancel").addEventListener("click", closeEditor);
$("editor-save").addEventListener("click", saveEditor);
$("editor").addEventListener("mousedown", (e) => e.target === $("editor") && closeEditor());
$("editor").addEventListener("keydown", (e) => e.key === "Enter" && e.target.tagName === "INPUT" && !e.target.closest("#editor-find-panel") && saveEditor());
$("editor-cover-change").addEventListener("click", async () => {
  try {
    const picked = await invoke("pick_cover_image");
    if (!picked) return;
    editor.cover = { kind: "file", path: picked.path };
    setEditorCover(picked.preview);
  } catch (e) {
    $("editor-error").textContent = String(e);
  }
});
$("editor-cover-remove").addEventListener("click", () => {
  editor.cover = { kind: "remove" };
  setEditorCover("");
});
$("ed-artist").addEventListener("input", () => editorSuggest("ed-artist", "ed-artist-hint", editor.names.artists));
$("ed-album-artist").addEventListener("input", () => editorSuggest("ed-album-artist", "ed-album-artist-hint", editor.names.artists));
$("ed-album").addEventListener("input", () => editorSuggest("ed-album", "ed-album-hint", editor.names.albums));
