import { WORLD_ARCS } from './world.js';

const DEG = Math.PI / 180;

const AUTO_SPIN_DEG_PER_SEC = 4.5;
const SPIN_RESUME_MS = 2600;
const DRAG_SENSITIVITY = 0.32;
const MAX_TILT = 78;
const MIN_ZOOM = 0.8;
const MAX_ZOOM = 7;
const CLICK_SLOP_PX = 6;
const HOVER_RADIUS_PX = 16;

/* Alpha is a state change, so points are bucketed by depth and each bucket is
   drawn in one pass instead of setting alpha per point. */
const DEPTH_TIERS = 4;

const SPRITE_PX = 14;

export class Globe {
  constructor(canvas, { onPick, onHint, onHover } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onPick = onPick;
    this.onHint = onHint;
    this.onHover = onHover;

    this.lats = new Float32Array(0);
    this.lons = new Float32Array(0);
    this.codes = [];
    this.hover = null;

    this.rotation = -20;
    this.tilt = 18;
    this.zoom = 1;
    this.energy = 0;

    this.dragging = false;
    this.moved = 0;
    this.lastPointer = null;
    this.lastInteraction = 0;
    this.momentum = 0;

    this.selection = null;
    this.pulse = 0;

    this.running = false;
    this.frame = 0;
    this.lastTime = 0;

    this.tierX = [];
    this.tierY = [];
    this.tierCount = new Int32Array(DEPTH_TIERS);

    this.resize = this.resize.bind(this);
    this.tick = this.tick.bind(this);

    this.observer = new ResizeObserver(this.resize);
    this.observer.observe(canvas);

    this.bindPointer();
    this.refreshTheme();
    this.resize();
  }

  setPoints(points, codes) {
    const count = codes?.length ?? Math.floor(points.length / 2);
    this.lats = new Float32Array(count);
    this.lons = new Float32Array(count);
    this.codes = codes ?? [];
    this.hitX = new Float32Array(count);
    this.hitY = new Float32Array(count);
    this.hitIndex = new Int32Array(count);
    this.hitCount = 0;

    for (let i = 0; i < count; i++) {
      this.lats[i] = points[i * 2];
      this.lons[i] = points[i * 2 + 1];
    }

    for (let tier = 0; tier < DEPTH_TIERS; tier++) {
      this.tierX[tier] = new Float32Array(count);
      this.tierY[tier] = new Float32Array(count);
    }
  }

  setEnergy(value) {
    this.energy = value;
  }

  /** Colours come from CSS custom properties, so themes carry over. */
  refreshTheme() {
    const styles = getComputedStyle(document.documentElement);
    this.colors = {
      hot: styles.getPropertyValue('--accent-hot').trim() || '#ffb063',
      accent: styles.getPropertyValue('--accent').trim() || '#ff9233',
      deep: styles.getPropertyValue('--accent-deep').trim() || '#d8491f',
      line: styles.getPropertyValue('--line').trim() || '#282320',
      sunken: styles.getPropertyValue('--bg-sunken').trim() || '#070606',
    };

    this.sprite = buildSprite(this.colors.hot);
  }

  resize() {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const { width, height } = this.canvas.getBoundingClientRect();
    if (!width || !height) return;

    this.canvas.width = Math.round(width * ratio);
    this.canvas.height = Math.round(height * ratio);
    this.ctx.setTransform(ratio, 0, 0, ratio, 0, 0);

    this.cssWidth = width;
    this.cssHeight = height;
    this.cx = width / 2;
    this.cy = height / 2;
    this.baseRadius = Math.min(width, height) * 0.42;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.lastTime = 0;
    this.frame = requestAnimationFrame(this.tick);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.frame);
  }

  destroy() {
    this.stop();
    this.observer.disconnect();
  }

  get radius() {
    return this.baseRadius * this.zoom;
  }

  project(lat, lon) {
    const phi = lat * DEG;
    const lambda = (lon + this.rotation) * DEG;
    const cosPhi = Math.cos(phi);

    const x = cosPhi * Math.sin(lambda);
    const y = Math.sin(phi);
    const z = cosPhi * Math.cos(lambda);

    const t = this.tilt * DEG;
    const cosT = Math.cos(t);
    const sinT = Math.sin(t);

    return { x, y: y * cosT - z * sinT, z: y * sinT + z * cosT };
  }

  /** Screen point to lat/lon, or null when the click missed the sphere. */
  unproject(px, py) {
    const r = this.radius;
    const dx = (px - this.cx) / r;
    const dy = -(py - this.cy) / r;
    const squared = dx * dx + dy * dy;
    if (squared > 1) return null;

    const dz = Math.sqrt(1 - squared);
    const t = this.tilt * DEG;
    const cosT = Math.cos(t);
    const sinT = Math.sin(t);

    const y = dy * cosT + dz * sinT;
    const z = -dy * sinT + dz * cosT;

    const lat = Math.asin(Math.max(-1, Math.min(1, y))) / DEG;
    let lon = Math.atan2(dx, z) / DEG - this.rotation;

    lon = ((((lon + 180) % 360) + 360) % 360) - 180;
    return { lat, lon };
  }

  bindPointer() {
    const canvas = this.canvas;

    canvas.addEventListener('pointerdown', (event) => {
      canvas.setPointerCapture(event.pointerId);
      this.dragging = true;
      this.moved = 0;
      this.lastPointer = { x: event.clientX, y: event.clientY };
      this.momentum = 0;
    });

    canvas.addEventListener('pointermove', (event) => {
      if (!this.dragging) {
        const rect = canvas.getBoundingClientRect();
        this.trackHover(event.clientX - rect.left, event.clientY - rect.top);
        return;
      }

      if (!this.lastPointer) return;

      const dx = event.clientX - this.lastPointer.x;
      const dy = event.clientY - this.lastPointer.y;
      this.moved += Math.abs(dx) + Math.abs(dy);

      this.rotation += dx * DRAG_SENSITIVITY;
      this.tilt = Math.max(-MAX_TILT, Math.min(MAX_TILT, this.tilt + dy * DRAG_SENSITIVITY));
      this.momentum = dx * DRAG_SENSITIVITY;

      this.lastPointer = { x: event.clientX, y: event.clientY };
      this.lastInteraction = performance.now();
    });

    const release = (event) => {
      if (!this.dragging) return;
      this.dragging = false;
      this.lastInteraction = performance.now();

      if (this.moved > CLICK_SLOP_PX) return;

      const rect = canvas.getBoundingClientRect();
      const hit = this.unproject(event.clientX - rect.left, event.clientY - rect.top);

      if (!hit) {
        this.onHint?.('Tap the globe itself to hear that part of the world');
        return;
      }

      this.selection = hit;
      this.pulse = 0;
      this.onPick?.(hit);
    };

    canvas.addEventListener('pointerup', release);
    canvas.addEventListener('pointercancel', () => {
      this.dragging = false;
    });

    canvas.addEventListener('pointerleave', () => {
      this.hover = null;
      this.onHover?.(null);
    });

    canvas.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault();
        const step = event.deltaY > 0 ? 0.93 : 1.075;
        this.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, this.zoom * step));
        this.lastInteraction = performance.now();
      },
      { passive: false },
    );
  }

  tick(time) {
    if (!this.running) return;

    const dt = Math.min(0.05, this.lastTime ? (time - this.lastTime) / 1000 : 0.016);
    this.lastTime = time;

    const idle = time - this.lastInteraction > SPIN_RESUME_MS;

    if (!this.dragging) {
      if (Math.abs(this.momentum) > 0.01) {
        this.rotation += this.momentum;
        this.momentum *= 0.94;
      } else if (idle) {
        this.rotation += AUTO_SPIN_DEG_PER_SEC * dt;
      }
    }

    this.pulse += dt;
    this.draw();
    this.frame = requestAnimationFrame(this.tick);
  }

  draw() {
    const { ctx } = this;
    const width = this.cssWidth;
    const height = this.cssHeight;
    if (!width || !height) return;

    ctx.clearRect(0, 0, width, height);

    const r = this.radius;
    this.drawSphere(r);
    this.drawGraticule(r);
    this.drawLand(r);
    this.drawPoints(r);
    this.drawSelection(r);
    this.drawHover(r);
  }

  drawSphere(r) {
    const { ctx, cx, cy, colors } = this;

    const halo = ctx.createRadialGradient(cx, cy, r * 0.82, cx, cy, r * 1.22);
    halo.addColorStop(0, withAlpha(colors.accent, 0.22));
    halo.addColorStop(1, withAlpha(colors.accent, 0));
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(cx, cy, r * 1.22, 0, Math.PI * 2);
    ctx.fill();

    const body = ctx.createRadialGradient(
      cx - r * 0.35,
      cy - r * 0.42,
      r * 0.1,
      cx,
      cy,
      r,
    );
    body.addColorStop(0, withAlpha(colors.accent, 0.12));
    body.addColorStop(0.55, withAlpha(colors.sunken, 0.92));
    body.addColorStop(1, withAlpha(colors.sunken, 1));

    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = withAlpha(colors.accent, 0.4);
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  drawGraticule(r) {
    const { ctx, cx, cy, colors } = this;

    ctx.strokeStyle = withAlpha(colors.line, 0.55);
    ctx.lineWidth = 1;

    for (let lat = -60; lat <= 60; lat += 30) {
      this.strokePath(r, (step) => ({ lat, lon: step }), 72);
    }

    for (let lon = 0; lon < 360; lon += 30) {
      this.strokePath(r, (step) => ({ lat: (step / 360) * 180 - 90, lon }), 48);
    }

    ctx.strokeStyle = withAlpha(colors.accent, 0.3);
    this.strokePath(r, (step) => ({ lat: 0, lon: step }), 72);

    void cx;
    void cy;
  }

  /** Draws a lat/lon path, breaking it wherever it crosses to the far side. */
  strokePath(r, at, segments) {
    const { ctx, cx, cy } = this;
    ctx.beginPath();

    let drawing = false;

    for (let i = 0; i <= segments; i++) {
      const { lat, lon } = at((i / segments) * 360);
      const point = this.project(lat, lon);

      if (point.z <= 0) {
        drawing = false;
        continue;
      }

      const x = cx + point.x * r;
      const y = cy - point.y * r;

      if (drawing) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);

      drawing = true;
    }

    ctx.stroke();
  }

  /** Coastlines and country borders, drawn from the vendored arcs. */
  drawLand(r) {
    const { ctx, cx, cy, colors } = this;

    ctx.strokeStyle = withAlpha(colors.line, 0.95);
    ctx.lineWidth = 1;
    ctx.lineJoin = 'round';

    for (const arc of WORLD_ARCS) {
      ctx.beginPath();
      let drawing = false;

      for (let i = 0; i < arc.length; i += 2) {
        const point = this.project(arc[i + 1], arc[i]);

        if (point.z <= 0) {
          drawing = false;
          continue;
        }

        const x = cx + point.x * r;
        const y = cy - point.y * r;

        if (drawing) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);

        drawing = true;
      }

      ctx.stroke();
    }
  }

  /** Nearest station dot under the cursor, using last frame's screen positions. */
  trackHover(px, py) {
    let best = -1;
    let bestDistance = HOVER_RADIUS_PX * HOVER_RADIUS_PX;

    for (let i = 0; i < this.hitCount; i++) {
      const dx = this.hitX[i] - px;
      const dy = this.hitY[i] - py;
      const distance = dx * dx + dy * dy;

      if (distance < bestDistance) {
        bestDistance = distance;
        best = i;
      }
    }

    const index = best === -1 ? null : this.hitIndex[best];
    const changed = index !== (this.hover?.index ?? null);

    this.hover = index === null ? null : { index, x: this.hitX[best], y: this.hitY[best] };

    if (changed) {
      this.onHover?.(
        index === null
          ? null
          : { code: this.codes[index], lat: this.lats[index], lon: this.lons[index] },
      );
    }
  }

  drawHover(r) {
    if (!this.hover) return;

    const { ctx, colors } = this;
    ctx.strokeStyle = colors.hot;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(this.hover.x, this.hover.y, 9, 0, Math.PI * 2);
    ctx.stroke();

    void r;
  }

  drawPoints(r) {
    const { ctx, cx, cy } = this;
    const count = this.lats.length;
    if (!count || !this.sprite) return;

    this.tierCount.fill(0);
    this.hitCount = 0;

    for (let i = 0; i < count; i++) {
      const point = this.project(this.lats[i], this.lons[i]);
      if (point.z <= 0.02) continue;

      const x = cx + point.x * r;
      const y = cy - point.y * r;

      const tier = Math.min(DEPTH_TIERS - 1, Math.floor(point.z * DEPTH_TIERS));
      const slot = this.tierCount[tier]++;

      this.tierX[tier][slot] = x;
      this.tierY[tier][slot] = y;

      this.hitX[this.hitCount] = x;
      this.hitY[this.hitCount] = y;
      this.hitIndex[this.hitCount] = i;
      this.hitCount += 1;
    }

    ctx.globalCompositeOperation = 'lighter';

    // Dense regions overlap and bloom on their own, which is the glow.
    const boost = 1 + this.energy * 0.6;

    for (let tier = 0; tier < DEPTH_TIERS; tier++) {
      const depth = (tier + 0.5) / DEPTH_TIERS;
      const size = SPRITE_PX * (0.5 + depth * 0.55) * Math.min(1.4, this.zoom);
      const half = size / 2;

      ctx.globalAlpha = Math.min(1, (0.2 + depth * 0.7) * boost);

      const xs = this.tierX[tier];
      const ys = this.tierY[tier];

      for (let i = 0, n = this.tierCount[tier]; i < n; i++) {
        ctx.drawImage(this.sprite, xs[i] - half, ys[i] - half, size, size);
      }
    }

    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  drawSelection(r) {
    if (!this.selection) return;

    const { ctx, cx, cy, colors } = this;
    const point = this.project(this.selection.lat, this.selection.lon);
    if (point.z <= 0) return;

    const x = cx + point.x * r;
    const y = cy - point.y * r;
    const phase = (this.pulse % 1.6) / 1.6;

    ctx.strokeStyle = withAlpha(colors.hot, 1 - phase);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, 6 + phase * 22, 0, Math.PI * 2);
    ctx.stroke();

    ctx.fillStyle = colors.hot;
    ctx.beginPath();
    ctx.arc(x, y, 3.5, 0, Math.PI * 2);
    ctx.fill();
  }
}

function buildSprite(color) {
  const sprite = document.createElement('canvas');
  sprite.width = SPRITE_PX;
  sprite.height = SPRITE_PX;

  const ctx = sprite.getContext('2d');
  const mid = SPRITE_PX / 2;
  const gradient = ctx.createRadialGradient(mid, mid, 0, mid, mid, mid);

  gradient.addColorStop(0, withAlpha(color, 1));
  gradient.addColorStop(0.28, withAlpha(color, 0.55));
  gradient.addColorStop(1, withAlpha(color, 0));

  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, SPRITE_PX, SPRITE_PX);
  return sprite;
}

/** Accepts the hex values the stylesheets use and returns rgba. */
function withAlpha(color, alpha) {
  const hex = color.replace('#', '');
  const full = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex;

  if (full.length < 6) return color;

  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);

  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
