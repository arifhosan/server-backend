# Tuner

A standalone web player for the radio backend. Plain HTML, CSS and ES modules
with no build step and no dependencies, so it deploys to any static host.

## Backend

Already pointed at the live API in `assets/js/config.js`:

```js
window.TUNER_CONFIG = { apiBaseUrl: 'https://api.server.arifhosan.me', apiPrefix: '/radio' };
```

Nothing to configure before deploying. Two overrides exist if you need them:
the Settings sheet in the app (saved per browser) and a `?api=` query string
for testing against another host. An empty `apiBaseUrl` means "same origin".

### CORS

Serving the app from a different origin than the API requires the backend to
send `Access-Control-Allow-Origin`. The deployed API does, on all three kinds
of response: the JSON routes, the SSE metadata stream, and the audio stream
(`*` there).

The stream needs it for a second reason: the spectrum analyser can only read
audio the browser considers same-origin-readable. The app probes this once and
falls back to an animated pattern if reading is not allowed, so playback works
either way.

## Deploy

Copy the folder. That is the whole build.

**nginx**

```nginx
server {
  listen 80;
  root /var/www/tuner;
  index index.html;

  location / {
    try_files $uri $uri/ /index.html;
  }
}
```

**Caddy**

```
radio.example.com {
  root * /var/www/tuner
  file_server
}
```

**Any of these also work as-is:** GitHub Pages, Netlify, Cloudflare Pages,
Vercel, S3 plus CloudFront, or `python -m http.server` for a quick look.

Serve it over HTTP(S), not `file://` — ES modules and the API calls both need a
real origin.

## Local preview

```bash
cd radio-web
python -m http.server 8080
# then open http://localhost:8080
```

It talks to the deployed API, so no local backend is needed. Add
`?api=http://localhost:3000` to test against a local one instead.

## What is in here

| Path | Role |
| --- | --- |
| `index.html` | App shell, inline SVG icon sprite |
| `assets/css/app.css` | Design tokens, components, responsive rules |
| `assets/js/config.js` | Deployment config, loaded before the modules |
| `assets/js/api.js` | API base resolution and endpoint wrappers |
| `assets/js/player.js` | Audio element, reconnect watchdog, SSE titles, media keys |
| `assets/js/visualizer.js` | Canvas spectrum analyser with peak-hold caps |
| `assets/js/store.js` | Favourites, recents and theme in `localStorage` |
| `assets/js/ui.js` | Card, artwork, skeleton and toast builders |
| `assets/js/app.js` | Routing, search, and wiring |

Favourites live in the browser, not the backend, so the app is fully usable
against a deployment with no database.

## Keyboard

| Key | Action |
| --- | --- |
| `Space` | Play or pause |
| `/` | Jump to search |
| `←` `→` | Previous / next station in the current list |
| `Esc` | Close the now-playing view |

## Design notes

The look is a lit analog tuner: warm near-black, a single amber accent for the
dial glow, film grain over flat fills, and monospaced readouts for bitrate,
codec and elapsed time. Light and dark both ship; the theme follows the system
and the toggle overrides it.

The now-playing view is the centrepiece — a log-scaled spectrum with fast
attack, slow release, peak-hold caps and a reflection, over a background that
brightens with the bass. On a phone the player bar collapses to a launcher for
it, which keeps the controls thumb-sized.
