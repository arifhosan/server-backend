import { api } from './api.js';

const PROGRESS_TIMEOUT_MS = 12000;
const WATCHDOG_MS = 2000;
const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 20000;
const VOLUME_KEY = 'tuner.volume';
const CORS_KEY = 'tuner.cors';

export class Player {
  constructor(audio) {
    this.audio = audio;
    this.station = null;
    this.status = 'idle';
    this.title = null;
    this.startedAt = 0;
    this.retries = 0;
    this.lastProgress = 0;
    this.wanted = false;
    this.events = null;
    this.sleepTimer = null;
    this.listeners = new Set();
    this.corsChecked = readCors();

    audio.volume = readVolume();

    audio.addEventListener('playing', () => {
      this.retries = 0;
      this.lastProgress = Date.now();
      this.set('playing');
    });

    audio.addEventListener('waiting', () => {
      if (this.wanted) this.set('buffering');
    });

    audio.addEventListener('timeupdate', () => {
      this.lastProgress = Date.now();
    });

    audio.addEventListener('progress', () => {
      this.lastProgress = Date.now();
    });

    audio.addEventListener('error', () => this.recover('stream error'));
    audio.addEventListener('ended', () => this.recover('stream ended'));

    audio.addEventListener('pause', () => {
      if (!this.wanted) this.set('paused');
    });

    setInterval(() => this.checkProgress(), WATCHDOG_MS);
    window.addEventListener('online', () => {
      if (this.wanted) this.load();
    });

    this.bindMediaKeys();
  }

  subscribe(listener) {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  snapshot() {
    return {
      station: this.station,
      status: this.status,
      title: this.title,
      elapsed: this.startedAt ? Math.floor((Date.now() - this.startedAt) / 1000) : 0,
      volume: this.audio.volume,
      muted: this.audio.muted,
    };
  }

  emit() {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }

  set(status) {
    this.status = status;
    this.emit();
  }

  async play(station) {
    const sameStation = this.station?.uuid === station.uuid;
    this.station = station;
    this.title = null;
    this.retries = 0;
    this.wanted = true;

    if (!sameStation) this.startedAt = Date.now();

    this.set('loading');
    this.watchMetadata(station.uuid);
    this.describeForOs(station);

    // crossOrigin decides whether the visualiser can sample the audio, and it
    // has to be settled before the first src assignment.
    if (this.corsChecked === null) {
      this.corsChecked = await api.allowsCors(station.uuid);
      writeCors(this.corsChecked);
    }

    if (this.corsChecked) this.audio.crossOrigin = 'anonymous';
    else this.audio.removeAttribute('crossorigin');

    this.load();
  }

  load() {
    if (!this.station) return;

    this.lastProgress = Date.now();
    // A fresh query string forces a new connection instead of a cached body.
    this.audio.src = `${api.streamUrl(this.station.uuid)}?t=${Date.now()}`;

    this.audio.play().catch(() => {
      if (this.wanted) this.set('error');
    });
  }

  toggle() {
    if (!this.station) return;

    if (this.wanted) {
      this.pause();
      return;
    }

    this.wanted = true;
    this.set('loading');
    this.load();
  }

  pause() {
    this.wanted = false;
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
    this.set('paused');
  }

  /* The backend reconnects upstream behind an open response, so this only
     covers losing the connection to the backend itself. */
  recover(reason) {
    if (!this.station || !this.wanted) return;

    this.retries += 1;
    const wait = Math.min(RETRY_BASE_MS * 2 ** (this.retries - 1), RETRY_MAX_MS);

    this.set('buffering');
    console.warn(`${reason}; retrying in ${wait}ms`);
    setTimeout(() => {
      if (this.wanted) this.load();
    }, wait);
  }

  checkProgress() {
    if (!this.wanted || this.audio.paused) return;
    if (Date.now() - this.lastProgress < PROGRESS_TIMEOUT_MS) return;

    this.recover('stalled');
  }

  watchMetadata(uuid) {
    this.events?.close();
    this.events = new EventSource(api.eventsUrl(uuid));

    this.events.addEventListener('message', (event) => {
      try {
        const state = JSON.parse(event.data);
        this.title = state.title ?? null;
        this.emit();
        this.describeForOs(this.station, this.title);
      } catch {
        /* a malformed frame is not worth interrupting playback for */
      }
    });

    this.events.addEventListener('error', () => {
      /* SSE reconnects itself; titles simply pause until it does */
    });
  }

  setVolume(value) {
    this.audio.volume = value;
    this.audio.muted = value === 0;
    writeVolume(value);
    this.emit();
  }

  toggleMute() {
    this.audio.muted = !this.audio.muted;
    this.emit();
  }

  startSleepTimer(minutes) {
    clearTimeout(this.sleepTimer);
    if (!minutes) return;

    this.sleepTimer = setTimeout(() => this.pause(), minutes * 60000);
  }

  describeForOs(station, title) {
    if (!('mediaSession' in navigator) || !station) return;

    navigator.mediaSession.metadata = new MediaMetadata({
      title: title ?? station.name,
      artist: title ? station.name : [station.country, station.codec].filter(Boolean).join(' - '),
      album: 'Tuner',
      artwork: station.favicon ? [{ src: station.favicon, sizes: '256x256' }] : [],
    });
  }

  bindMediaKeys() {
    if (!('mediaSession' in navigator)) return;

    navigator.mediaSession.setActionHandler('play', () => this.toggle());
    navigator.mediaSession.setActionHandler('pause', () => this.pause());
    navigator.mediaSession.setActionHandler('stop', () => this.pause());
  }
}

function readVolume() {
  try {
    const value = Number(localStorage.getItem(VOLUME_KEY));
    return Number.isFinite(value) && value > 0 ? Math.min(value, 1) : 0.9;
  } catch {
    return 0.9;
  }
}

function writeVolume(value) {
  try {
    localStorage.setItem(VOLUME_KEY, String(value));
  } catch {
    /* nothing to do */
  }
}

function readCors() {
  try {
    const value = localStorage.getItem(CORS_KEY);
    return value === null ? null : value === '1';
  } catch {
    return null;
  }
}

function writeCors(value) {
  try {
    localStorage.setItem(CORS_KEY, value ? '1' : '0');
  } catch {
    /* nothing to do */
  }
}
