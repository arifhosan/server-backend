import { api } from './api.js';
import { Player } from './player.js';
import { store } from './store.js';
import { Visualizer } from './visualizer.js';
import {
  artTile,
  clock,
  describe,
  emptyState,
  icon,
  quality,
  skeletons,
  stationCard,
  toast,
} from './ui.js';

const SEARCH_DEBOUNCE_MS = 340;
const GENRE_COUNT = 18;

const BROWSE_ROWS = [
  { title: 'Most loved', query: { order: 'votes', limit: 12 } },
  { title: 'Played the most today', query: { order: 'clickcount', limit: 12 } },
  { title: 'Trending now', query: { order: 'clicktrend', limit: 12 } },
  { title: 'High fidelity', query: { order: 'bitrate', limit: 12 } },
];

const el = (id) => document.getElementById(id);

const dom = {
  content: el('content'),
  panels: {
    browse: el('panelBrowse'),
    search: el('panelSearch'),
    favourites: el('panelFavourites'),
  },
  browseRows: el('browseRows'),
  searchResults: el('searchResults'),
  searchTitle: el('searchTitle'),
  searchMeta: el('searchMeta'),
  favouriteResults: el('favouriteResults'),
  favMeta: el('favMeta'),
  favCount: el('favCount'),
  searchForm: el('searchForm'),
  searchInput: el('searchInput'),
  searchClear: el('searchClear'),
  countrySelect: el('countrySelect'),
  sortSelect: el('sortSelect'),
  genreChips: el('genreChips'),
  player: el('player'),
  stage: el('stage'),
  stageBg: el('stageBg'),
  settings: el('settingsDialog'),
  apiInput: el('apiInput'),
  apiStatus: el('apiStatus'),
  timerSelect: el('timerSelect'),
  viz: el('viz'),
};

const player = new Player(el('audio'));
const visualizer = new Visualizer(dom.viz);

const state = {
  view: 'browse',
  genre: '',
  queue: [],
  lastQuery: null,
};

/* ------------------------------------------------------------------ theme */

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  store.setTheme(theme);
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', theme === 'light' ? '#f4efe6' : '#0b0a09');
}

applyTheme(
  store.theme() ??
    (window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark'),
);

el('themeToggle').addEventListener('click', () => {
  applyTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
});

/* ----------------------------------------------------------------- routing */

function route() {
  const hash = location.hash.replace('#/', '') || 'browse';
  const view = ['browse', 'search', 'favourites'].includes(hash) ? hash : 'browse';
  state.view = view;

  for (const [name, panel] of Object.entries(dom.panels)) {
    panel.hidden = name !== view;
  }

  for (const link of document.querySelectorAll('[data-view]')) {
    if (link.dataset.view === view) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }

  if (view === 'favourites') renderFavourites();
  if (view === 'search') dom.searchInput.focus({ preventScroll: true });
}

window.addEventListener('hashchange', route);

/* ------------------------------------------------------------------ search */

function currentQuery(extra) {
  const term = dom.searchInput.value.trim();
  const query = {
    order: dom.sortSelect.value,
    limit: 60,
    ...extra,
  };

  if (term) query.q = term;
  if (state.genre) query.tag = state.genre;
  if (dom.countrySelect.value) query.country = dom.countrySelect.value;

  return query;
}

async function runSearch() {
  const query = currentQuery();
  const hasTerm = Boolean(query.q || query.tag || query.country);

  if (!hasTerm) {
    location.hash = '#/browse';
    return;
  }

  if (location.hash !== '#/search') location.hash = '#/search';

  dom.searchTitle.textContent = query.q ? `"${query.q}"` : query.tag || query.country;
  dom.searchMeta.textContent = 'searching';
  dom.searchResults.replaceChildren(skeletons(8));

  const token = Symbol('search');
  state.lastQuery = token;

  try {
    const stations = await api.search(query);
    if (state.lastQuery !== token) return;

    state.queue = stations;
    dom.searchMeta.textContent = `${stations.length} station${stations.length === 1 ? '' : 's'}`;

    if (stations.length === 0) {
      dom.searchResults.replaceChildren(
        emptyState('Nothing matched', 'Try a shorter name, a different country, or another genre.'),
      );
      return;
    }

    paint(dom.searchResults, stations);
  } catch (error) {
    if (state.lastQuery !== token) return;
    dom.searchMeta.textContent = 'failed';
    dom.searchResults.replaceChildren(
      emptyState('Could not reach the API', `${error.message}. Check the API base URL in Settings.`),
    );
  }
}

let searchTimer = 0;

dom.searchInput.addEventListener('input', () => {
  dom.searchClear.hidden = dom.searchInput.value.length === 0;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, SEARCH_DEBOUNCE_MS);
});

dom.searchForm.addEventListener('submit', (event) => {
  event.preventDefault();
  clearTimeout(searchTimer);
  void runSearch();
});

dom.searchClear.addEventListener('click', () => {
  dom.searchInput.value = '';
  dom.searchClear.hidden = true;
  location.hash = '#/browse';
});

dom.countrySelect.addEventListener('change', runSearch);
dom.sortSelect.addEventListener('change', () => {
  if (state.view === 'search') void runSearch();
  else void loadBrowse();
});

/* ------------------------------------------------------------------ render */

function cardState(station) {
  return {
    favourite: store.isFavourite(station.uuid),
    playing: player.station?.uuid === station.uuid,
  };
}

const handlers = {
  onPlay(station) {
    store.remember(station);

    void player.play(station).then(() => {
      // The analyser can only be attached once the CORS answer is known, and
      // the first play is what settles it.
      if (player.corsChecked && !visualizer.source) {
        visualizer.connect(el('audio'), { sample: true });
      }
      visualizer.resume();
    });

    if (window.matchMedia('(max-width: 720px)').matches) openStage();
  },

  onFavourite(station, button) {
    const added = store.toggleFavourite(station);
    button.setAttribute('aria-pressed', String(added));
    button.innerHTML = icon(added ? 'ic-heart' : 'ic-heart-outline');
    toast(added ? `${station.name} added to favourites` : `${station.name} removed`);
    refreshFavCount();
    if (state.view === 'favourites') renderFavourites();
  },
};

function paint(host, stations) {
  const fragment = document.createDocumentFragment();
  for (const station of stations) {
    fragment.append(stationCard(station, handlers, cardState(station)));
  }
  host.replaceChildren(fragment);
}

async function loadBrowse() {
  const rows = [];

  if (store.favourites().length) {
    rows.push({ title: 'Your favourites', stations: store.favourites().slice(0, 12) });
  }

  if (store.recent().length) {
    rows.push({ title: 'Recently played', stations: store.recent() });
  }

  dom.browseRows.replaceChildren();

  for (const row of rows) renderRow(row.title, row.stations);

  for (const row of BROWSE_ROWS) {
    const section = renderRow(row.title, null);

    api
      .search(row.query)
      .then((stations) => {
        if (stations.length === 0) {
          section.remove();
          return;
        }
        paint(section.querySelector('.grid'), stations);
      })
      .catch(() => {
        section.remove();
      });
  }
}

function renderRow(title, stations) {
  const section = document.createElement('section');
  section.className = 'row';

  const head = document.createElement('div');
  head.className = 'row-head';

  const heading = document.createElement('h2');
  heading.className = 'row-title';
  heading.textContent = title;
  head.append(heading);

  const grid = document.createElement('div');
  grid.className = 'grid';

  if (stations) paint(grid, stations);
  else grid.append(skeletons(4));

  section.append(head, grid);
  dom.browseRows.append(section);
  return section;
}

function renderFavourites() {
  const favourites = store.favourites();
  dom.favMeta.textContent = favourites.length
    ? `${favourites.length} saved`
    : 'kept in this browser';

  if (favourites.length === 0) {
    dom.favouriteResults.replaceChildren(
      emptyState('No favourites yet', 'Tap the heart on any station and it shows up here.'),
    );
    return;
  }

  state.queue = favourites;
  paint(dom.favouriteResults, favourites);
}

function refreshFavCount() {
  const count = store.favourites().length;
  dom.favCount.textContent = String(count);
  dom.favCount.hidden = count === 0;
}

function markPlaying(uuid) {
  for (const card of document.querySelectorAll('.card')) {
    const active = card.dataset.uuid === uuid;
    card.dataset.playing = String(active);
    const eq = card.querySelector('.eq');
    if (eq) eq.dataset.active = String(active);
  }
}

/* ----------------------------------------------------------------- filters */

async function loadFilters() {
  try {
    const countries = await api.countries();
    const fragment = document.createDocumentFragment();

    for (const country of countries.slice(0, 140)) {
      const option = document.createElement('option');
      option.value = country.name;
      option.textContent = `${country.name} (${country.stationcount})`;
      fragment.append(option);
    }

    dom.countrySelect.append(fragment);
  } catch {
    /* the country filter stays as "Anywhere" */
  }

  try {
    const tags = await api.tags();
    const fragment = document.createDocumentFragment();

    for (const tag of tags.slice(0, GENRE_COUNT)) {
      const chip = document.createElement('button');
      chip.className = 'chip';
      chip.type = 'button';
      chip.textContent = tag.name;
      chip.setAttribute('aria-pressed', 'false');
      chip.addEventListener('click', () => {
        const active = state.genre === tag.name;
        state.genre = active ? '' : tag.name;

        for (const other of dom.genreChips.children) {
          other.setAttribute('aria-pressed', String(other === chip && !active));
        }

        if (state.genre) void runSearch();
        else location.hash = '#/browse';
      });

      fragment.append(chip);
    }

    dom.genreChips.append(fragment);
  } catch {
    dom.genreChips.append(document.createTextNode(''));
  }
}

/* ------------------------------------------------------------------ player */

function stationIndex() {
  return state.queue.findIndex((station) => station.uuid === player.station?.uuid);
}

function step(direction) {
  if (state.queue.length === 0) return;

  const index = stationIndex();
  const next = state.queue[(index + direction + state.queue.length) % state.queue.length];
  if (next) handlers.onPlay(next);
}

const statusLabels = {
  idle: ['Idle', 'idle'],
  loading: ['Tuning', 'buffering'],
  buffering: ['Buffering', 'buffering'],
  playing: ['Live', 'live'],
  paused: ['Paused', 'idle'],
  error: ['Offline', 'error'],
};

let rendered = null;

player.subscribe((snapshot) => {
  const { station, status, title } = snapshot;
  dom.player.hidden = !station;
  if (!station) return;

  const [label, badgeState] = statusLabels[status] ?? statusLabels.idle;
  const playing = status === 'playing';

  el('barName').textContent = station.name;
  el('barTitle').textContent = title ?? '';
  el('stageName').textContent = station.name;
  el('stageTitle').textContent = title ?? '';
  el('stageSub').textContent = describe(station);

  for (const id of ['barStatus', 'stageStatus']) {
    const badge = el(id);
    badge.dataset.state = badgeState;
    badge.querySelector('span').textContent = label;
  }

  for (const id of ['barPlay', 'stagePlay']) {
    const button = el(id);
    button.dataset.state = status === 'loading' ? 'loading' : playing ? 'playing' : 'paused';
    button.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  }

  el('barEq').dataset.active = String(playing);
  el('barReadout').textContent = quality(station);
  el('stageQuality').textContent = quality(station);
  el('stageClock').textContent = clock(snapshot.elapsed);

  const favourite = store.isFavourite(station.uuid);
  for (const id of ['barFav', 'stageFav']) {
    const button = el(id);
    button.setAttribute('aria-pressed', String(favourite));
    button.innerHTML = icon(favourite ? 'ic-heart' : 'ic-heart-outline');
  }

  const home = el('stageHome');
  home.hidden = !station.homepage;
  if (station.homepage) home.href = station.homepage;

  if (rendered !== station.uuid) {
    rendered = station.uuid;
    swapArt('barArt', station, 'sm');
    swapArt('stageArt', station, 'lg');
    markPlaying(station.uuid);
  }

  for (const input of [el('barVolume'), el('stageVolume')]) {
    input.value = String(snapshot.muted ? 0 : snapshot.volume);
    input.style.setProperty('--fill', `${(snapshot.muted ? 0 : snapshot.volume) * 100}%`);
  }

  el('barMute').innerHTML = icon(snapshot.muted ? 'ic-mute' : 'ic-volume');

  if (playing) visualizer.start();
});

function swapArt(id, station, size) {
  const current = el(id);
  const replacement = artTile(station, size);
  replacement.id = id;
  current.replaceWith(replacement);
}

/* Elapsed clock ticks independently of player events. */
setInterval(() => {
  if (player.status === 'playing') el('stageClock').textContent = clock(player.snapshot().elapsed);
}, 1000);

for (const id of ['barPlay', 'stagePlay']) {
  el(id).addEventListener('click', (event) => {
    event.stopPropagation();
    player.toggle();
    visualizer.resume();
  });
}

for (const id of ['barPrev', 'stagePrev']) {
  el(id).addEventListener('click', (event) => {
    event.stopPropagation();
    step(-1);
  });
}

for (const id of ['barNext', 'stageNext']) {
  el(id).addEventListener('click', (event) => {
    event.stopPropagation();
    step(1);
  });
}

for (const id of ['barFav', 'stageFav']) {
  el(id).addEventListener('click', (event) => {
    event.stopPropagation();
    if (player.station) handlers.onFavourite(player.station, el(id));
  });
}

for (const id of ['barVolume', 'stageVolume']) {
  el(id).addEventListener('input', (event) => {
    event.stopPropagation();
    player.setVolume(Number(event.target.value));
  });
}

el('barMute').addEventListener('click', (event) => {
  event.stopPropagation();
  player.toggleMute();
});

/* ------------------------------------------------------------------- stage */

function openStage() {
  if (!player.station) return;
  dom.stage.hidden = false;
  requestAnimationFrame(() => {
    dom.stage.dataset.open = 'true';
  });
  visualizer.start();
}

function closeStage() {
  dom.stage.dataset.open = 'false';
  setTimeout(() => {
    dom.stage.hidden = true;
  }, 360);
}

el('playerExpand').addEventListener('click', openStage);
el('stageClose').addEventListener('click', closeStage);

visualizer.onEnergy((energy) => {
  dom.stageBg.style.opacity = String(0.7 + energy * 0.3);
});

visualizer.connect(el('audio'), { sample: false });

document.addEventListener('visibilitychange', () => {
  if (document.hidden) visualizer.stop();
  else if (player.status === 'playing') visualizer.start();
});

el('stageTimer').addEventListener('click', () => dom.settings.showModal());

/* ---------------------------------------------------------------- settings */

el('openSettings').addEventListener('click', () => openSettings());
el('tabSettings').addEventListener('click', () => openSettings());

function openSettings() {
  dom.apiInput.value = api.base;
  dom.apiStatus.textContent = '';
  dom.apiStatus.removeAttribute('data-state');
  dom.settings.showModal();
}

dom.settings.addEventListener('close', () => {
  if (dom.settings.returnValue !== 'save') return;

  api.setBase(dom.apiInput.value);
  player.startSleepTimer(Number(dom.timerSelect.value));
  toast('Settings saved');

  dom.countrySelect.length = 1;
  dom.genreChips.replaceChildren();
  void loadFilters();
  void loadBrowse();
});

/* --------------------------------------------------------------- shortcuts */

document.addEventListener('keydown', (event) => {
  const typing = ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName);

  if (event.key === 'Escape' && dom.stage.dataset.open === 'true') {
    closeStage();
    return;
  }

  if (typing) return;

  if (event.key === ' ') {
    event.preventDefault();
    player.toggle();
  }

  if (event.key === '/') {
    event.preventDefault();
    location.hash = '#/search';
    dom.searchInput.focus();
  }

  if (event.key === 'ArrowRight') step(1);
  if (event.key === 'ArrowLeft') step(-1);
});

/* ------------------------------------------------------------------- start */

async function boot() {
  refreshFavCount();
  route();
  await loadFilters();
  await loadBrowse();

  if (!api.base && location.protocol === 'file:') {
    toast('Open this over http, not from a file path', 'error');
  }
}

void boot();
