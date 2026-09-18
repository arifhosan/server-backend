const KHZ_LABEL = 'kbps';

export function hue(text) {
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) % 360;
  return hash;
}

export function initials(name) {
  const words = name.replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

export function artTile(station, size = 'sm') {
  const tile = document.createElement('span');
  tile.className = `art art-${size}`;
  tile.style.setProperty('--h', String(hue(station.name ?? '')));
  tile.textContent = initials(station.name ?? '?');

  if (station.favicon) {
    const image = new Image();
    image.decoding = 'async';
    image.loading = 'lazy';
    image.alt = '';
    // Only swapped in once it loads, so a dead favicon never shows a broken tile.
    image.addEventListener('load', () => tile.append(image));
    image.src = station.favicon;
  }

  return tile;
}

export function describe(station) {
  return [station.country, station.state].filter(Boolean).join(' - ');
}

export function quality(station) {
  const parts = [];
  if (station.codec) parts.push(station.codec.toUpperCase());
  if (station.bitrate) parts.push(`${station.bitrate} ${KHZ_LABEL}`);
  return parts.join(' / ');
}

export function stationCard(station, handlers, state) {
  const card = document.createElement('article');
  card.className = 'card';
  card.dataset.uuid = station.uuid;
  card.dataset.playing = String(Boolean(state?.playing));

  const hit = document.createElement('button');
  hit.className = 'card-hit';
  hit.type = 'button';
  hit.setAttribute('aria-label', `Play ${station.name}`);
  hit.addEventListener('click', () => handlers.onPlay(station));

  const body = document.createElement('div');
  body.className = 'card-body';

  const name = document.createElement('span');
  name.className = 'card-name';
  name.textContent = station.name || 'Unnamed station';

  const sub = document.createElement('span');
  sub.className = 'card-sub';
  sub.textContent = describe(station) || 'Unknown location';

  body.append(name, sub);

  const tags = (station.tags ?? []).slice(0, 2);
  const detail = quality(station);

  if (tags.length || detail) {
    const row = document.createElement('div');
    row.className = 'card-tags';

    if (detail) {
      const chip = document.createElement('span');
      chip.className = 'tag';
      chip.textContent = detail;
      row.append(chip);
    }

    for (const tag of tags) {
      const chip = document.createElement('span');
      chip.className = 'tag';
      chip.textContent = tag;
      row.append(chip);
    }

    body.append(row);
  }

  const fav = document.createElement('button');
  fav.className = 'card-fav';
  fav.type = 'button';
  fav.setAttribute('aria-pressed', String(Boolean(state?.favourite)));
  fav.setAttribute('aria-label', `Favourite ${station.name}`);
  fav.innerHTML = icon(state?.favourite ? 'ic-heart' : 'ic-heart-outline');
  fav.addEventListener('click', (event) => {
    event.stopPropagation();
    handlers.onFavourite(station, fav);
  });

  const eq = document.createElement('span');
  eq.className = 'eq';
  eq.dataset.active = String(Boolean(state?.playing));
  eq.innerHTML = '<i></i><i></i><i></i><i></i>';

  card.append(hit, artTile(station, 'md'), body, eq, fav);
  return card;
}

export function icon(id) {
  return `<svg class="icon" aria-hidden="true"><use href="#${id}" /></svg>`;
}

export function skeletons(count) {
  const fragment = document.createDocumentFragment();

  for (let i = 0; i < count; i++) {
    const block = document.createElement('div');
    block.className = 'skeleton';
    block.innerHTML =
      '<span class="sk-art"></span><span class="sk-lines"><span class="sk-line"></span><span class="sk-line"></span></span>';
    fragment.append(block);
  }

  return fragment;
}

export function emptyState(title, message) {
  const box = document.createElement('div');
  box.className = 'empty';
  box.innerHTML = `${icon('ic-radio')}<strong></strong><p></p>`;
  box.querySelector('strong').textContent = title;
  box.querySelector('p').textContent = message;
  return box;
}

export function toast(message, kind = 'info') {
  const host = document.getElementById('toasts');
  const node = document.createElement('div');
  node.className = 'toast';
  node.dataset.kind = kind;
  node.textContent = message;
  host.append(node);

  setTimeout(() => node.remove(), 4200);
}

export function clock(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  const pad = (value) => String(value).padStart(2, '0');

  return hours ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${pad(minutes)}:${pad(secs)}`;
}
