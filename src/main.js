"use strict";

const { invoke, convertFileSrc } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const UNKNOWN_ARTIST = "Unknown Artist";
const REPEAT_OFF = 0, REPEAT_ALL = 1, REPEAT_ONE = 2;

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
  favorites: new Set(), // paths of favourite library songs
  query: "",
  artist: null,   // artist key, null = all artists
  album: null,    // album key, null = every album of the artist
  visible: [],    // tracks passing the search
  shown: [],      // tracks in the song table
  albumKeys: [],  // album keys in grid order
  selected: -1,   // selected row in the song table
  queue: [], order: [], pos: -1,
  shuffle: false, repeat: REPEAT_OFF,
  scanning: false, rescanQueued: false,
  source: "local", // "local" library or "sc" (SoundCloud)
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

const audio = new Audio();
audio.preload = "auto";
let baseVolume = 0.7; // the volume slider's value; fades move audio.volume around it

// ------------------------------------------------------------- preferences

const ACCENTS = ["#8b7cff", "#5b8cff", "#2fb7c4", "#3fbf7f", "#e2b33c", "#f0864a", "#ef5a6f", "#e06ad0"];
const DEFAULT_PREFS = {
  accent: ACCENTS[0], blur: true, tint: 0.55, coverSize: "medium", scale: "1", compact: false,
  showCounts: true, onTop: false,
  animations: true, speed: "1", ambient: true, equalizer: true, hoverLift: true, waveform: true,
  waveHeight: 34, waveStyle: "bars", waveBars: 240, coverColors: true, coverTint: true,
  appIcon: "yuuri", scView: "list",
  ignoreThe: true, scanOnStart: true,
  singleClick: false, fade: true, rememberModes: false, shuffle: false, repeat: REPEAT_OFF, resume: true,
};
const COVER_SIZES = { small: "120px", medium: "156px", large: "200px" };
let prefs = { ...DEFAULT_PREFS };

const appWindow = window.__TAURI__.window.getCurrentWindow();
const platform = /Mac/.test(navigator.userAgent) ? "mac" : /Linux/.test(navigator.userAgent) ? "linux" : "windows";
document.body.classList.add(platform);

// ------------------------------------------------------------------ helpers

const artistKey = (t) => t.albumArtist.toLowerCase();
const FAV_KEY = ":fav"; // the "Favourites" entry in the artist list
const inArtist = (t) =>
  state.artist === null || (state.artist === FAV_KEY ? state.favorites.has(t.path) : artistKey(t) === state.artist);
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

/** Something the webview can load: web URLs as they are, local files through the asset protocol. */
const mediaSrc = (p) => (/^https?:\/\//.test(p) ? p : convertFileSrc(p));

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
  const linuxDefaults = platform === "linux" ? { blur: false, tint: 0.96 } : {}; // no compositor blur there
  prefs = { ...DEFAULT_PREFS, ...linuxDefaults, ...(snap.settings.ui || {}) };
  applyPrefs();
  if (prefs.rememberModes) {
    setShuffle(prefs.shuffle);
    setRepeat(prefs.repeat);
  }
  baseVolume = audio.volume = state.settings.volume;
  el.volume.value = baseVolume;
  setRangeFill(el.volume);
  el.preferTags.checked = state.settings.preferTags;
  renderFolders();
  applySearch();
  if (prefs.resume) restoreSession();
  sessionReady = true;
  discordSync();
  // libraries scanned before grid thumbnails existed get them on this scan
  const needThumbs = state.tracks.some((t) => t.cover && !t.thumb);
  if (state.settings.folders.length && (prefs.scanOnStart || !state.tracks.length || needThumbs)) rescan(false);
}

async function rescan(full) {
  if (state.scanning) {
    state.rescanQueued = true;
    return;
  }
  state.scanning = true;
  setStatus("Scanning…");
  try {
    state.tracks = await invoke("scan", { full });
    applySearch();
    setStatus(summary(), 4000);
  } catch (e) {
    setStatus(`Scan failed: ${e}`, 6000);
  } finally {
    state.scanning = false;
  }
  if (state.rescanQueued) {
    state.rescanQueued = false;
    rescan(false);
  }
}

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
}

function renderFolders() {
  const folders = state.settings.folders;
  el.folderList.innerHTML = folders.length
    ? folders.map((f, i) => `<li><span title="${esc(f)}">${esc(f)}</span><button data-i="${i}" title="Remove from library">Remove</button></li>`).join("")
    : `<li class="none">No folders yet</li>`;
}

// -------------------------------------------------------------- rendering

function applySearch() {
  const q = state.query;
  state.visible = q
    ? state.tracks.filter((t) =>
        [t.title, t.artist, t.albumArtist, t.album].some((s) => s.toLowerCase().includes(q)))
    : state.tracks;
  if (state.source !== "local") return; // the SoundCloud view owns the panels
  const hasLibrary = state.tracks.length || state.settings.folders.length;
  el.empty.hidden = !!hasLibrary;
  el.library.hidden = !hasLibrary;
  renderArtists();
}

function renderArtists() {
  const artists = new Map(); // key -> { name, albums }
  for (const t of state.visible) {
    const k = artistKey(t);
    if (!artists.has(k)) artists.set(k, { name: t.albumArtist, albums: new Set() });
    artists.get(k).albums.add(albumKey(t));
  }
  const favCount = state.visible.filter((t) => state.favorites.has(t.path)).length;
  if (state.artist === FAV_KEY ? !favCount : state.artist !== null && !artists.has(state.artist)) state.artist = null;
  const keys = [...artists.keys()].sort((a, b) => cmpName(artists.get(a).name, artists.get(b).name));

  let n = 0;
  const item = (key, name, count) =>
    `<li data-key="${esc(key ?? "")}" class="${key === state.artist ? "sel" : ""}" title="${esc(name)}" style="--i:${n++}">` +
    `<span class="count">${count}</span>${esc(name)}</li>`;
  el.artistList.innerHTML =
    item(null, "All artists", new Set(state.visible.map(albumKey)).size) +
    (favCount ? item(FAV_KEY, "♥ Favourites", favCount) : "") +
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

  const oneArtist = state.artist !== null && state.artist !== FAV_KEY;
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

function renderSongs() {
  const tracks = state.visible.filter((t) =>
    inArtist(t) &&
    (state.album === null || albumKey(t) === state.album));
  tracks.sort((a, b) =>
    cmpName(a.albumArtist, b.albumArtist) || cmpYear(a.year, b.year) ||
    collator.compare(sortName(a.album), sortName(b.album)) ||
    a.discNo - b.discNo || a.trackNo - b.trackNo || collator.compare(a.title, b.title));
  const multiDisc = state.album !== null && new Set(tracks.map((t) => t.discNo)).size > 1;
  fillSongs(tracks, { multiDisc, hideAlbum: state.album !== null, title: "Songs" });
}

/** Put `tracks` in the song table. Shared by the library and SoundCloud views. */
function fillSongs(tracks, { multiDisc = false, hideAlbum = false, title = "Songs" } = {}) {
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
const songTable = { rowH: 0, start: 0, end: 0, multiDisc: false };
const ROW_MARGIN = 24; // rows drawn above and below the visible ones
const ROW_STEP = 16; // redraw only after scrolling this many rows
const tableWrap = () => el.songBody.closest(".table-wrap");

function songRowHtml(t, i, playing) {
  const num = t.sc ? i + 1 : songTable.multiDisc ? `${t.discNo}-${t.trackNo}` : t.trackNo || "";
  const isPlaying = t.path === playing;
  const cls = [isPlaying && "playing", i === state.selected && "sel", t.access === "blocked" && "unplayable", isFav(t) && "fav"].filter(Boolean).join(" ");
  const badge = t.access === "preview" ? '<span class="badge" title="SoundCloud only allows a 30-second preview">PREVIEW</span>' : "";
  return `<tr data-i="${i}" data-num="${num}"${cls ? ` class="${cls}"` : ""} title="${esc(t.sc ? t.permalinkUrl : t.path)}"${i < 40 ? ` style="--i:${i}"` : ""}>` +
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
  state.queue = [...state.shown];
  state.order = state.queue.map((_, i) => i);
  if (state.shuffle) {
    state.order = [index, ...shuffled(state.order.filter((i) => i !== index))];
    state.pos = 0;
  } else {
    state.pos = index;
  }
  playCurrent();
}

function playCurrent(autoplay = true) {
  const t = current();
  if (!t) return;
  if (t.sc) {
    loadScAudio(t, autoplay);
  } else {
    scLoadId++; // drop a SoundCloud download still on its way
    audio.src = convertFileSrc(t.path);
    if (autoplay) startPlayback();
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
  highlightPlaying();
  updateMediaSession(t);
  loadWaveform(t);
  updateAccent();
  $("locate").hidden = false;
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
  if (!document.hidden || audio.paused || audio.volume === baseVolume) return;
  fadeId++;
  if (pausing) {
    pausing = false;
    audio.pause();
  }
  audio.volume = baseVolume;
});

function startPlayback() {
  fadeId++;
  audio.volume = prefs.fade ? 0 : baseVolume;
  audio.play()
    .then(() => prefs.fade && fadeTo(baseVolume, 300))
    .catch(() => (audio.volume = baseVolume));
}

let pausing = false;
async function pausePlayback() {
  pausing = true;
  const faded = !prefs.fade || (await fadeTo(0, 180));
  pausing = false;
  if (!faded) return; // cancelled by a play in the meantime
  audio.pause();
  audio.volume = baseVolume;
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
  if (auto && state.repeat === REPEAT_ONE) {
    audio.currentTime = 0;
    audio.play().catch(() => {});
    return;
  }
  if (state.pos + 1 < state.order.length) {
    state.pos++;
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

function setShuffle(on) {
  state.shuffle = on;
  el.shuffle.classList.toggle("on", on);
  if (prefs.rememberModes && prefs.shuffle !== on) setPref("shuffle", on);
  if (!state.order.length) return;
  const cur = state.order[state.pos];
  if (on) {
    state.order = [cur, ...shuffled(state.queue.map((_, i) => i).filter((i) => i !== cur))];
    state.pos = 0;
  } else {
    state.order = state.queue.map((_, i) => i);
    state.pos = cur;
  }
}

const cycleRepeat = () => setRepeat((state.repeat + 1) % 3);

function setRepeat(mode) {
  state.repeat = mode;
  el.repeat.classList.toggle("on", state.repeat !== REPEAT_OFF);
  el.repeatIcon.setAttribute("href", state.repeat === REPEAT_ONE ? "#i-repeat-one" : "#i-repeat");
  el.repeat.title = `Repeat: ${["off", "all", "one"][state.repeat]}`;
  if (prefs.rememberModes && prefs.repeat !== state.repeat) setPref("repeat", state.repeat);
}

/** OS media keys / lock-screen controls where the webview supports them. */
function updateMediaSession(t) {
  if (!("mediaSession" in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: t.title, artist: t.artist, album: t.album,
    artwork: t.cover ? [{ src: mediaSrc(t.cover) }] : [],
  });
}
if ("mediaSession" in navigator) {
  const ms = navigator.mediaSession;
  ms.setActionHandler("play", startPlayback);
  ms.setActionHandler("pause", pausePlayback);
  ms.setActionHandler("previoustrack", prev);
  ms.setActionHandler("nexttrack", () => next());
}

// ------------------------------------------------------------------ events

audio.addEventListener("play", () => {
  el.playIcon.setAttribute("href", "#i-pause");
  document.body.classList.remove("paused");
  if (scrob.track !== current()) beginScrobble(current());
  discordSync();
});
audio.addEventListener("pause", () => {
  el.playIcon.setAttribute("href", "#i-play");
  document.body.classList.add("paused");
  discordSync();
  saveSession();
});
audio.addEventListener("seeked", () => {
  scrob.lastTime = audio.currentTime;
  discordSync();
});
audio.addEventListener("ended", () => {
  scrob.track = null; // so a repeated song scrobbles again
  next(true);
});
audio.addEventListener("loadedmetadata", () => {
  el.seek.max = audio.duration || 0;
  el.dur.textContent = fmtTime(audio.duration);
});
let seeking = false;
audio.addEventListener("timeupdate", () => {
  trackListening();
  if (seeking) return;
  el.seek.value = audio.currentTime;
  el.pos.textContent = fmtTime(audio.currentTime);
  setRangeFill(el.seek);
});
audio.addEventListener("error", () => {
  if (!audio.getAttribute("src")) return; // cleared while a SoundCloud song downloads
  const t = current();
  setStatus(`Can't play “${t?.title ?? "file"}” — format not supported here`, 6000);
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
  const unplayed = "rgba(255,255,255,0.2)", hovered = "rgba(255,255,255,0.42)";

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
audio.addEventListener("play", kickWave);
audio.addEventListener("seeked", kickWave);
audio.addEventListener("loadedmetadata", kickWave);
window.addEventListener("resize", kickWave);

let volumeSave;
el.volume.addEventListener("input", () => {
  fadeId++; // cancel any running fade
  baseVolume = audio.volume = Number(el.volume.value);
  audio.muted = false;
  setRangeFill(el.volume);
  clearTimeout(volumeSave);
  volumeSave = setTimeout(() => invoke("set_volume", { volume: audio.volume }), 400);
});
audio.addEventListener("volumechange", () =>
  el.volIcon.setAttribute("href", audio.muted || audio.volume === 0 ? "#i-mute" : "#i-volume"));
$("mute").addEventListener("click", () => (audio.muted = !audio.muted));

el.play.addEventListener("click", togglePlay);
$("next").addEventListener("click", () => next());
$("prev").addEventListener("click", prev);
el.shuffle.addEventListener("click", () => setShuffle(!state.shuffle));
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
    state.query = el.search.value.trim().toLowerCase();
    applySearch();
  }, 120);
});
el.search.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || state.source !== "sc" || !el.search.value.trim()) return;
  scSearch(el.search.value.trim());
});

el.artistList.addEventListener("click", (e) => {
  const li = e.target.closest("li");
  if (!li) return;
  if (state.source === "sc") {
    if (li.dataset.key) scSelect(li.dataset.key);
    return;
  }
  state.artist = li.dataset.key || null;
  state.album = null;
  for (const x of el.artistList.children) x.classList.toggle("sel", x === li);
  renderAlbums();
});
el.artistList.addEventListener("dblclick", (e) => e.target.closest("li") && playShown(0));

el.albumGrid.addEventListener("click", (e) => {
  const card = e.target.closest(".album");
  if (!card) return;
  // clicking the selected album again goes back to all of the artist's songs
  const key = state.albumKeys[card.dataset.i];
  state.album = key === state.album ? null : key;
  for (const x of el.albumGrid.children) x.classList.toggle("sel", x === card && state.album !== null);
  renderSongs();
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
  selectRow(Number(row.dataset.i));
  if (prefs.singleClick) playShown(Number(row.dataset.i));
});
el.songBody.addEventListener("dblclick", (e) => {
  const row = e.target.closest("tr");
  if (row && !prefs.singleClick) playShown(Number(row.dataset.i));
});
el.songGrid.addEventListener("click", (e) => {
  const card = e.target.closest(".album");
  if (!card) return;
  selectRow(Number(card.dataset.i));
  if (prefs.singleClick) playShown(Number(card.dataset.i));
});
el.songGrid.addEventListener("dblclick", (e) => {
  const card = e.target.closest(".album");
  if (card && !prefs.singleClick) playShown(Number(card.dataset.i));
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

document.addEventListener("keydown", (e) => {
  const typing = e.target === el.search;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
    e.preventDefault();
    el.search.focus();
    el.search.select();
  } else if (e.key === "F5") {
    e.preventDefault();
    rescan(false);
  } else if ((e.ctrlKey || e.metaKey) && e.key === ",") {
    e.preventDefault();
    el.settings.hidden ? openSettings() : closeSettings();
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "l") {
    e.preventDefault();
    jumpToCurrent();
  } else if (e.key === "Escape") {
    closeSettings();
    if (typing) el.search.blur();
  } else if (typing || !el.settings.hidden) {
    return;
  } else if (e.key === " ") {
    e.preventDefault();
    togglePlay();
  } else if ((e.ctrlKey || e.metaKey) && e.key === "ArrowRight") {
    next();
  } else if ((e.ctrlKey || e.metaKey) && e.key === "ArrowLeft") {
    prev();
  } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const n = state.shown.length;
    if (n) selectRow(Math.min(n - 1, Math.max(0, state.selected + (e.key === "ArrowDown" ? 1 : -1))));
  } else if (e.key === "Enter" && state.selected >= 0) {
    playShown(state.selected);
  }
});

// ------------------------------------------------------------ window chrome

$("win-min").addEventListener("click", () => appWindow.minimize());
$("win-max").addEventListener("click", () => appWindow.toggleMaximize());
$("win-close").addEventListener("click", () => {
  saveSession();
  invoke("discord_update", { track: null, playing: false, position: 0 }).finally(() => appWindow.close());
});

async function syncMaximized() {
  const max = await appWindow.isMaximized();
  document.body.classList.toggle("maximized", max); // square corners when filling the screen
  $("win-max-icon").setAttribute("d", max ? "M3.5 1.5h7v7M1.5 3.5h7v7h-7z" : "M2 2h8v8H2z");
  $("win-max").title = max ? "Restore" : "Maximize";
}
appWindow.onResized(syncMaximized);
syncMaximized();

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
  setShuffle(!!s.shuffle);
  setRepeat(s.repeat || REPEAT_OFF);

  state.sc.current = s.scList || "likes";
  state.sc.searchQuery = s.scSearch || "";
  if (s.source === "sc") setSource("sc");

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
});
const scrob = { track: null, startedAt: 0, listened: 0, lastTime: 0, done: false };

function lastfmEnabled() {
  const lf = state.settings.lastfm;
  return lf && lf.scrobble && lf.sessionKey;
}

function beginScrobble(t) {
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
function renderIntegrations() {
  const lf = state.settings.lastfm || {}, dc = state.settings.discord || {};
  const connected = !!lf.sessionKey;
  const status = $("lfm-status");
  status.className = "hint" + (connected ? " ok" : "");
  status.textContent = connected ? `Connected as ${lf.username}`
    : lastfmPending ? "Approve access in the browser window that opened, then click “I've approved it”."
    : lf.apiKey ? "Not connected" : "Add your API key and shared secret first.";
  $("lfm-connect").hidden = connected;
  $("lfm-connect").disabled = !lf.apiKey || !lf.apiSecret;
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
  const name = APP_ICONS.includes(prefs.appIcon) ? prefs.appIcon : APP_ICONS[0];
  if (name === appliedIcon) return;
  appliedIcon = name;
  $("brand-icon").src = `icons/app-${name}.png`;
  invoke("set_app_icon", { name }).catch(() => {});
}

function applyPrefs() {
  const root = document.documentElement.style;
  const body = document.body.classList;
  updateAccent();
  body.toggle("cover-tint", prefs.coverTint);
  applyAppIcon();
  root.setProperty("--tint-alpha", prefs.tint);
  root.setProperty("--cover-min", COVER_SIZES[prefs.coverSize] || COVER_SIZES.medium);
  root.setProperty("--speed", prefs.speed);
  document.body.style.zoom = prefs.scale;
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
  if (platform !== "linux" && blurApplied !== prefs.blur) {
    blurApplied = prefs.blur;
    const done = prefs.blur
      ? appWindow.setEffects({ effects: ["acrylic", "underWindowBackground"], radius: 16 })
      : appWindow.clearEffects();
    done.catch(() => {});
  }
  appWindow.setAlwaysOnTop(prefs.onTop).catch(() => {});
  highlightPlaying();
  if (!el.settings.hidden) syncSettingsUI();
}

function syncSettingsUI() {
  for (const input of el.settings.querySelectorAll("input[data-pref]")) {
    const value = prefs[input.dataset.pref];
    if (input.type === "checkbox") {
      input.checked = !!value;
    } else {
      input.value = value;
      setRangeFill(input);
    }
  }
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
  if (!prefs.animations) {
    el.settings.hidden = true;
    return;
  }
  el.settings.classList.add("closing");
  setTimeout(() => {
    el.settings.hidden = true;
    el.settings.classList.remove("closing");
  }, 240 * Number(prefs.speed));
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
  document.body.classList.toggle("sc", source === "sc");
  for (const b of $("source").children) b.classList.toggle("on", b.dataset.source === source);
  el.search.placeholder = source === "sc" ? "Filter, or press Enter to search SoundCloud" : "Search artists, albums, songs";
  el.search.value = "";
  state.query = "";
  state.sc.filter = "";
  if (source === "sc") {
    renderSc();
    if (scConnected() && !state.sc.loaded) scLoad();
  } else {
    $("sc-empty").hidden = true;
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
    if (key === "likes") sc.liked = new Set(tracks.map((t) => t.urn));
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
$("sc-open-settings").addEventListener("click", () => {
  openSettings();
  el.settings.querySelector('.settings-tabs [data-tab="integrations"]').click();
});

/** Show the playing SoundCloud song in its list. */
function jumpToScTrack(t) {
  closeSettings();
  if (state.source !== "sc") setSource("sc");
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
    audio.src = convertFileSrc(file);
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
    : scWaiting ? "Approve access in the browser window that opened…"
    : ownKeys ? "Not connected — using your own app" : scBuiltin ? "Not connected" : "Add your Client ID and Client Secret below first.";
  if (!scBuiltin && !ownKeys) $("sc-own").open = true;
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

listen("scan-progress",({ payload: [done, total] }) => setStatus(`Scanning… ${done} / ${total}`));
document.addEventListener("contextmenu", (e) => e.preventDefault());

setNowCover("", "");
document.body.classList.add("paused");
load();

// ------------------------------------------------------- right-click menu

const ctx = $("ctx");
// outside <body>, so the interface-size zoom doesn't throw off its position
document.documentElement.appendChild(ctx);

/** Show a menu at (x, y). `items` are { label, icon, on, disabled, action } or "-" for a divider. */
function openMenu(x, y, title, items) {
  ctx.innerHTML = `<div class="title">${esc(title)}</div>` + items.map((it, i) => it === "-" ? "<hr>"
    : `<button data-i="${i}"${it.disabled ? " disabled" : ""}><svg class="${it.on ? "on" : ""}" viewBox="0 0 24 24"><use href="#${it.icon}"/></svg>${esc(it.label)}</button>`).join("");
  ctx.hidden = false;
  ctx.onclick = (e) => {
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
      "-",
      canDownload(t)
        ? { label: t.downloadable ? "Download" : "Download with yt-dlp", icon: "i-download", action: () => queueDownloads([t]) }
        : { label: "Download (not allowed by the artist)", icon: "i-download", disabled: true },
    );
    if (dl.current) items.push({ label: "Pause downloads", icon: "i-stop", action: stopDownloads });
  } else {
    const fav = state.favorites.has(t.path);
    items.push(
      { label: fav ? "Remove from favourites" : "Add to favourites", icon: fav ? "i-heart" : "i-heart-outline", on: fav, action: () => toggleFavorite(t) },
      { label: "Open file location", icon: "i-folder", action: () => invoke("reveal_file", { path: t.path }).catch((e) => setStatus(String(e), 5000)) },
    );
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
  openMenu(e.clientX, e.clientY, `${t.title} · ${t.artist}`, songMenu(t, i));
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
  saveSession();
}

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
  if (saved && (await downloadsInLibrary())) rescan(false);
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

async function downloadsInLibrary() {
  const folder = (await invoke("dl_folder")).toLowerCase();
  return state.settings.folders.some((f) => folder.startsWith(f.toLowerCase()));
}

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
      if (!state.sc.tracks.has(key)) await scFetch(key);
      playShown(0);
    } },
    "-",
    { label: loaded ? `Download all (${loaded.filter(canDownload).length} of ${loaded.length})` : "Download all", icon: "i-download",
      action: async () => {
        if (!state.sc.tracks.has(key)) {
          setStatus("Loading the list…");
          await scFetch(key);
        }
        queueDownloads(state.sc.tracks.get(key) || []);
      } },
  ];
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
  $("dl-add-library").hidden = await downloadsInLibrary();
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
});
$("dl-open").addEventListener("click", () => invoke("dl_open_folder").catch((e) => setStatus(String(e), 5000)));
$("dl-add-library").addEventListener("click", async () => {
  state.settings = await invoke("dl_add_to_library");
  renderFolders();
  renderDownloadSettings();
  rescan(false);
});

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
  document.body.classList.toggle("show-downloads", open);
  $("downloads").hidden = !open;
  if (open) renderDownloads();
}

$("downloads-btn").addEventListener("click", () => showDownloads(!document.body.classList.contains("show-downloads")));
$("dl-close").addEventListener("click", () => showDownloads(false));
$("source").addEventListener("click", () => showDownloads(false), true);
$("dl-pause").addEventListener("click", () => (dl.paused ? resumeDownloads() : stopDownloads()));
$("dl-clear").addEventListener("click", () => {
  dl.finished = [];
  renderDownloads();
});
$("dl-open-folder").addEventListener("click", () => invoke("dl_open_folder").catch((e) => setStatus(String(e), 5000)));

function renderDownloads() {
  const active = dl.queue.length + (dl.current ? 1 : 0);
  const badge = $("dl-badge");
  badge.hidden = !active;
  badge.textContent = active > 99 ? "99+" : active;
  $("downloads-btn").classList.toggle("busy", !!dl.current);
  if ($("downloads").hidden) return;

  const failed = dl.finished.filter((it) => it.status === "failed").length;
  $("dl-summary").textContent = !active && !dl.finished.length ? "Nothing downloading. Right-click a SoundCloud song or list to download it."
    : [active && `${active} to go`, dl.paused && "paused", failed && `${failed} failed`].filter(Boolean).join(" · ") || "All done";
  $("dl-pause").textContent = dl.paused ? "Resume" : "Pause";
  $("dl-pause").hidden = !active;
  $("dl-clear").hidden = !dl.finished.length;

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
