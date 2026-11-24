const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const $ = (id) => document.getElementById(id);

let state = null;
let stateAt = 0;
const setState = (s) => { state = s; stateAt = Date.now(); render(); };

// "3h 05m"; under an hour "45m"
const hm = (s) => {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
};
// write only on change so the aria-live region is not re-announced by the 1 s tick
const setText = (el, v) => { if (el.textContent !== v) el.textContent = v; };
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const STORES = { steam: 'Steam', xbox: 'Xbox', epic: 'Epic', other: 'Other' };

function render() {
  if (!state) return;
  // most recently started = shortest session so far
  const g = state.playing.reduce((a, b) => (!a || b.session_seconds < a.session_seconds ? b : a), null);
  const elapsed = Math.floor((Date.now() - stateAt) / 1000);
  const now = document.querySelector('.now');
  now.classList.toggle('playing', !!g);
  now.classList.toggle('idle', !g);
  $('now-label').hidden = !g;
  $('btn-ignore').hidden = !g;
  if (g) {
    setText($('now-title'), g.title);
    $('btn-ignore').setAttribute('aria-label', `Ignore this game, ${g.title}`);
    $('btn-ignore').dataset.title = g.title;
    const store = STORES[g.store] || g.store;
    setText($('now-sub'), state.paused ? store : `${store} · ${hm(g.session_seconds + elapsed)} this session`);
  } else {
    setText($('now-title'), 'Not playing');
    setText($('now-sub'), '');
  }
  setText($('today'), hm(state.today_seconds + (g && !state.paused ? elapsed : 0)));

  const c = state.connection;
  $('conn-revoked').hidden = c.kind !== 'revoked';
  const conn = $('conn');
  conn.hidden = c.kind === 'revoked';
  $('conn-dot').className = 'dot ' + (c.kind === 'ok' ? 'ok' : 'off');
  let text = '';
  if (c.kind === 'ok') {
    text = c.last_sent_at == null
      ? 'Connected'
      : `Connected · last sent ${Math.max(0, Math.round(Date.now() / 1000 - c.last_sent_at))} s ago`;
  } else if (c.kind === 'offline') {
    text = c.queued ? `Offline · ${plural(c.queued, 'heartbeat', 'heartbeats')} waiting` : 'Offline';
  } else if (c.kind === 'no_token') {
    text = 'No device token set. Open Settings to paste one.';
  }
  setText($('conn-text'), text);

  const p = state.psn;
  $('psn').hidden = !p;
  if (p) {
    setText($('psn-text'), p.status === 'expired'
      ? 'PSN sign-in expired'
      : `PSN sign-in expires in ${plural(p.days, 'day', 'days')}`);
  }
  setText($('btn-pause'), state.paused ? 'Resume' : 'Pause');
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
$('btn-ignore').onclick = () => invoke('ignore', { title: $('btn-ignore').dataset.title });
$('btn-pause').onclick = () => invoke('set_paused', { paused: !state.paused });
$('psn-renew').onclick = () => invoke('open_dashboard', { path: '/connections' });
$('btn-save').onclick = async () => {
  try {
    await invoke('save_settings', { serverUrl: $('server-url').value, startWithWindows: $('autostart').checked });
    showSettings(false);
  } catch (e) { fail(e); }
};
$('token-paste').onclick = async () => {
  let text;
  try {
    text = await navigator.clipboard.readText();
  } catch {
    $('token-input').focus(); // clipboard denied: user presses Ctrl+V
    return;
  }
  try { await saveToken(text); showSettings(true); } catch (e) { fail(e); }
};
$('token-save').onclick = async () => {
  try { await saveToken($('token-input').value); $('token-input').value = ''; showSettings(true); } catch (e) { fail(e); }
};
$('token-remove').onclick = async () => {
  try { await invoke('remove_token'); showSettings(true); } catch (e) { fail(e); }
};
$('revoked-save').onclick = async () => {
  const el = $('revoked-token');
  try { await saveToken(el.value); el.value = ''; } catch (e) { el.setCustomValidity(String(e)); el.reportValidity(); }
};

listen('state', (e) => setState(e.payload));
invoke('get_state').then(setState);
setInterval(render, 1000);
