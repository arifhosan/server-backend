const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const $ = (id) => document.getElementById(id);

let state = null;

const hm = (s) => `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
const hmShort = (s) => `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
const STORES = { steam: 'Steam', xbox: 'Xbox', epic: 'Epic', other: 'Other' };

function render() {
  if (!state) return;
  const g = state.playing[0];
  const now = document.querySelector('.now');
  now.classList.toggle('playing', !!g);
  now.classList.toggle('idle', !g);
  $('now-label').hidden = !g;
  if (g) {
    $('now-title').textContent = g.title;
    $('now-sub').textContent = `${STORES[g.store] || g.store} · ${hmShort(g.session_seconds)} this session`;
  } else {
    $('now-title').textContent = 'Not playing';
    $('now-sub').textContent = '';
  }
  $('today').textContent = hm(state.today_seconds);

  const c = state.connection;
  $('conn-revoked').hidden = c.kind !== 'revoked';
  const conn = $('conn');
  conn.hidden = c.kind === 'revoked';
  conn.replaceChildren();
  const dot = document.createElement('span');
  dot.className = 'dot ' + (c.kind === 'ok' ? 'ok' : 'off');
  dot.setAttribute('aria-hidden', 'true');
  let text = '';
  if (c.kind === 'ok') {
    text = c.last_sent_at == null
      ? 'Connected'
      : `Connected · last sent ${Math.max(0, Math.round(Date.now() / 1000 - c.last_sent_at))} s ago`;
  } else if (c.kind === 'offline') {
    text = `Offline · ${c.queued} heartbeats waiting`;
  } else if (c.kind === 'no_token') {
    text = 'No device token set. Open Settings to paste one.';
  }
  conn.append(dot, text);

  const p = state.psn;
  $('psn').hidden = !p;
  if (p) {
    $('psn-text').textContent = p.status === 'expired'
      ? 'PSN sign-in expired'
      : `PSN sign-in expires in ${p.days} days`;
  }
  $('btn-pause').textContent = state.paused ? 'Resume' : 'Pause';
}

async function showSettings(on) {
  $('main-view').hidden = on;
  $('settings-view').hidden = !on;
  if (!on) return;
  $('settings-error').hidden = true;
  const s = await invoke('get_settings');
  $('server-url').value = s.server_url;
  $('autostart').checked = s.start_with_windows;
  $('token-masked').textContent = s.token_masked || 'Not set';
  const ul = $('ignored');
  ul.replaceChildren();
  if (!s.ignored.length) {
    const li = document.createElement('li');
    li.className = 'none';
    li.textContent = 'None';
    ul.append(li);
  }
  for (const title of s.ignored) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = '×';
    b.setAttribute('aria-label', `Stop ignoring ${title}`);
    b.onclick = async () => { await invoke('unignore', { title }); li.remove(); };
    li.append(title, b);
    ul.append(li);
  }
}

function fail(e) {
  const el = $('settings-error');
  el.textContent = String(e);
  el.hidden = false;
}

async function saveToken(token) {
  await invoke('set_token', { token });
}

$('btn-settings').onclick = () => showSettings(true);
$('btn-back').onclick = () => showSettings(false);
$('btn-pause').onclick = () => invoke('set_paused', { paused: !state.paused });
$('psn-renew').onclick = () => invoke('open_dashboard', { path: '/connections' });
$('btn-save').onclick = async () => {
  try {
    await invoke('save_settings', { serverUrl: $('server-url').value, startWithWindows: $('autostart').checked });
    showSettings(false);
  } catch (e) { fail(e); }
};
$('token-paste').onclick = async () => {
  try {
    await saveToken(await navigator.clipboard.readText());
    showSettings(true);
  } catch (e) { fail(e); }
};
$('token-remove').onclick = async () => {
  try { await invoke('remove_token'); showSettings(true); } catch (e) { fail(e); }
};
$('revoked-save').onclick = async () => {
  const el = $('revoked-token');
  try { await saveToken(el.value); el.value = ''; } catch (e) { el.setCustomValidity(String(e)); el.reportValidity(); }
};

listen('state', (e) => { state = e.payload; render(); });
invoke('get_state').then((s) => { state = s; render(); });
setInterval(render, 1000);
