const FAV_KEY = 'tuner.favourites';
const RECENT_KEY = 'tuner.recent';
const THEME_KEY = 'tuner.theme';
const MAX_RECENT = 12;

/* Kept in the browser rather than the backend so the app works against a
   deployment with no database. */
function read(key) {
  try {
    const raw = localStorage.getItem(key);
    const value = raw ? JSON.parse(raw) : [];
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode: this session only */
  }
}

function slim(station) {
  return {
    uuid: station.uuid,
    name: station.name,
    country: station.country,
    countryCode: station.countryCode,
    state: station.state,
    codec: station.codec,
    bitrate: station.bitrate,
    favicon: station.favicon,
    homepage: station.homepage,
    tags: (station.tags ?? []).slice(0, 3),
  };
}

export const store = {
  favourites() {
    return read(FAV_KEY);
  },

  isFavourite(uuid) {
    return this.favourites().some((station) => station.uuid === uuid);
  },

  toggleFavourite(station) {
    const current = this.favourites();
    const next = current.filter((item) => item.uuid !== station.uuid);
    const added = next.length === current.length;

    if (added) next.unshift(slim(station));
    write(FAV_KEY, next);
    return added;
  },

  recent() {
    return read(RECENT_KEY);
  },

  remember(station) {
    const next = read(RECENT_KEY).filter((item) => item.uuid !== station.uuid);
    next.unshift(slim(station));
    write(RECENT_KEY, next.slice(0, MAX_RECENT));
  },

  theme() {
    try {
      return localStorage.getItem(THEME_KEY);
    } catch {
      return null;
    }
  },

  setTheme(value) {
    try {
      localStorage.setItem(THEME_KEY, value);
    } catch {
      /* nothing to do */
    }
  },
};
