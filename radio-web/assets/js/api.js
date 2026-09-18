const STORAGE_KEY = 'tuner.apiBase';

const defaults = window.TUNER_CONFIG ?? { apiBaseUrl: '', apiPrefix: '/radio' };

function fromQuery() {
  const value = new URLSearchParams(location.search).get('api');
  if (value === null) return null;
  save(value);
  return value;
}

function stored() {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function save(value) {
  try {
    if (value) localStorage.setItem(STORAGE_KEY, value);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* private mode: the value lasts for this page load only */
  }
}

let base = (fromQuery() ?? stored() ?? defaults.apiBaseUrl ?? '').replace(/\/+$/, '');

export const api = {
  get base() {
    return base;
  },

  setBase(value) {
    base = (value ?? '').trim().replace(/\/+$/, '');
    save(base);
  },

  url(path, params) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value !== undefined && value !== null && value !== '') {
        query.set(key, String(value));
      }
    }

    const search = query.toString();
    return `${base}${defaults.apiPrefix}${path}${search ? `?${search}` : ''}`;
  },

  async json(path, params, init) {
    const response = await fetch(this.url(path, params), {
      ...init,
      headers: { Accept: 'application/json', ...(init?.headers ?? {}) },
    });

    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }

    return response.json();
  },

  search(query) {
    return this.json('/stations/search', query);
  },

  countries() {
    return this.json('/countries');
  },

  tags() {
    return this.json('/tags');
  },

  streamUrl(uuid) {
    return `${this.url(`/stream/${encodeURIComponent(uuid)}`)}`;
  },

  eventsUrl(uuid) {
    return `${this.url(`/stream/${encodeURIComponent(uuid)}/events`)}`;
  },

  nowPlaying(uuid) {
    return this.json(`/stream/${encodeURIComponent(uuid)}/now-playing`);
  },

  /** True when the stream endpoint allows cross-origin reads, which the
      visualiser needs to sample audio. */
  async allowsCors(uuid) {
    const controller = new AbortController();

    try {
      const response = await fetch(this.streamUrl(uuid), {
        signal: controller.signal,
        cache: 'no-store',
      });
      return response.ok;
    } catch {
      return false;
    } finally {
      controller.abort();
    }
  },
};
