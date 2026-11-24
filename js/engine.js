/*
 * Glass Brush rendering engine.
 *
 * Every stroke is stored as a list of points { x, y, r, s } (position, radius,
 * slowness 0..1) plus its style. Strokes are rasterised into per-pixel buffers:
 *
 *   H  height of the surface (in pixels)
 *   C  coverage 0..1 (anti-aliased silhouette)
 *   O  owner: index of the stroke on top, which decides the material
 *
 * A stacking stroke rests on whatever was below it when it started (buffer B),
 * so layers lie on top of each other; a fusing stroke max-merges and melts in.
 *
 * The shader derives a normal from the height gradient, traces a short ray
 * toward the light for cast shadows between layers, and lights each pixel by
 * its material: diffuse/specular, a reflected studio for metal, refraction of
 * the backdrop for glass, or ink dots for stipple.
 *
 * Because strokes are data, the picture can be rebuilt at any time: relight,
 * restyle, hide, reorder, undo — everything re-renders identically.
 */
(function (global) {
  'use strict';

  const MATERIALS = {
    glass:   { label: 'Glass',        shade: 'glass',   profile: 'round', color: '#bfe3ee' },
    metal:   { label: 'Chrome',       shade: 'metal',   profile: 'round', color: '#c9ccd2' },
    gold:    { label: 'Gold',         shade: 'metal',   profile: 'round', color: '#e0b060' },
    ceramic: { label: 'Glaze',        shade: 'phong',   profile: 'round', color: '#2c5f93', kd: 0.8, ks: 1.1, shin: 160, rim: 0.35 },
    clay:    { label: 'Clay',         shade: 'phong',   profile: 'round', color: '#d0704f', kd: 0.95, ks: 0.07, shin: 10, grain: 0.7 },
    stone:   { label: 'Stone',        shade: 'phong',   profile: 'flat',  color: '#a29d93', kd: 1, ks: 0.03, shin: 6, grain: 2.6, speckle: 0.35 },
    foam:    { label: 'Foam',         shade: 'phong',   profile: 'soft',  color: '#f3f1ec', kd: 0.85, ks: 0.7, shin: 60, rim: 0.25, stamp: 'foam' },
    porous:  { label: 'Porous',       shade: 'phong',   profile: 'round', color: '#6f8a55', kd: 0.95, ks: 0.15, shin: 20, grain: 0.5, stamp: 'porous' },
    pearls:  { label: 'Pearls',       shade: 'pearl',   profile: 'round', color: '#efe6dc', stamp: 'beads' },
    thorns:  { label: 'Thorn Vine',   shade: 'phong',   profile: 'round', color: '#3f5f3c', kd: 0.85, ks: 0.45, shin: 45, stamp: 'thorns' },
    leaves:  { label: 'Leafy Vine',   shade: 'phong',   profile: 'round', color: '#8a9a4b', kd: 0.9, ks: 0.35, shin: 30, stamp: 'leaves' },
    sand:    { label: 'Sand',         shade: 'phong',   profile: 'round', color: '#d9bb8c', kd: 0.95, ks: 0.05, shin: 8, grain: 0.3, stamp: 'sand' },
    stipple: { label: 'Stipple',      shade: 'stipple', profile: 'round', color: '#1d1d22', kd: 1, ks: 0.15, shin: 20 },
    emboss:  { label: 'Paper Emboss', shade: 'phong',   profile: 'soft',  color: null, kd: 0.95, ks: 0.05, shin: 8, grain: 0.1, paper: true }
  };

  // [distance in radii, weight] of the sample rings used to drape a stroke over lower layers.
  const LIFT_RINGS = [[0.5, 1], [0.85, 1], [1.3, 0.7], [1.75, 0.38], [2.2, 0.12]];

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

  function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  // Small, fast, seedable PRNG so random brushes rebuild identically.
  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function hash2(x, y) {
    let h = Math.imul(x, 374761393) + Math.imul(y, 668265263);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  function valueNoise(x, y) {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const a = hash2(xi, yi), b = hash2(xi + 1, yi), c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }

  class Engine {
    constructor(canvas, width, height, options = {}) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.unit = options.unit || 1; // pixel density: grain, shadows and refraction scale with it
      this.strokes = [];
      this.light = { angle: 135, elevation: 45 };
      this.backdrop = { color: [238, 234, 226], pixels: null };
      this.resize(width, height);
    }

    resize(width, height) {
      this.W = width; this.H_ = height;
      this.canvas.width = width; this.canvas.height = height;
      const n = width * height;
      this.H = new Float32Array(n);
      this.B = new Float32Array(n);
      this.C = new Float32Array(n);
      this.O = new Int16Array(n).fill(-1);
      this.image = this.ctx.createImageData(width, height);
      // Two noise layers: coarse (lumps) and fine (grain), built once.
      this.N = new Float32Array(n);
      this.F = new Float32Array(n);
      const s = 1 / (7 * this.unit);
      for (let y = 0, i = 0; y < height; y++) {
        for (let x = 0; x < width; x++, i++) {
          this.N[i] = valueNoise(x * s, y * s) * 0.65 + valueNoise(x * s * 2.3, y * s * 2.3) * 0.35 - 0.5;
          this.F[i] = hash2(x, y) - 0.5;
        }
      }
      this.dirty = null;
    }

    setBackdrop(color, pixels) {
      this.backdrop.color = color;
      this.backdrop.pixels = pixels; // Uint8ClampedArray of the backdrop at engine size, or null
    }

    lightVector() {
      const a = (this.light.angle * Math.PI) / 180, e = (this.light.elevation * Math.PI) / 180;
      return [Math.cos(a) * Math.cos(e), -Math.sin(a) * Math.cos(e), Math.sin(e)];
    }

    /* ---------- stroke lifecycle ---------- */

    beginStroke(style) {
      const stroke = {
        material: style.material,
        color: style.color,
        relief: style.relief,
        grain: style.grain,
        mirrorX: !!style.mirrorX,
        mirrorY: !!style.mirrorY,
        erase: !!style.erase,
        stack: style.stack !== false,
        hidden: false,
        scale: 1,
        seed: (Math.random() * 2 ** 31) | 0,
        points: []
      };
      this.strokes.push(stroke);
      this.prepare(stroke, this.strokes.length - 1);
      return stroke;
    }

    addPoint(stroke, point) {
      stroke.points.push(point);
      this.walk(stroke, stroke.points.length - 1);
    }

    prepare(stroke, index) {
      const mat = MATERIALS[stroke.material] || MATERIALS.clay;
      stroke._index = index;
      stroke._mat = mat;
      stroke._rgb = mat.paper ? this.backdrop.color : hexToRgb(stroke.color || mat.color || '#888888');
      stroke._rng = mulberry32(stroke.seed);
      stroke._acc = 0;
      stroke._side = 1;
      stroke._walked = 0;
      stroke._next = {}; // distance at which each periodic feature fires next
      stroke._cavities = [];
      stroke._liftS = []; // smoothed resting height, one per mirrored copy
      stroke._last = null;
      // Snapshot of the surface below, so this stroke can rest on it.
      if (stroke.stack && !stroke.erase && !mat.paper) { this.B.set(this.H); this._lift = this.B; }
      else this._lift = null;
    }

    rebuild() {
      this.H.fill(0); this.C.fill(0); this.O.fill(-1);
      this.strokes.forEach((stroke, index) => {
        this.prepare(stroke, index);
        if (stroke.hidden) return;
        for (let i = 0; i < stroke.points.length; i++) this.walk(stroke, i);
        if (stroke.done) this.finish(stroke);
      });
      this.dirty = null;
      this.shade(0, 0, this.W - 1, this.H_ - 1);
      this.flush(0, 0, this.W - 1, this.H_ - 1);
    }

    /* ---------- path ---------- */

    mark(x0, y0, x1, y1) {
      const d = this.dirty;
      if (!d) this.dirty = [x0, y0, x1, y1];
      else { d[0] = Math.min(d[0], x0); d[1] = Math.min(d[1], y0); d[2] = Math.max(d[2], x1); d[3] = Math.max(d[3], y1); }
    }

    // Calls fn for the point and for each mirrored copy. (dx, dy) is a direction that mirrors too.
    mirrored(stroke, x, y, dx, dy, fn) {
      fn(x, y, dx, dy, 0);
      if (stroke.mirrorX) fn(this.W - x, y, -dx, dy, 1);
      if (stroke.mirrorY) fn(x, this.H_ - y, dx, -dy, 2);
      if (stroke.mirrorX && stroke.mirrorY) fn(this.W - x, this.H_ - y, -dx, -dy, 3);
    }

    /*
     * Pointer samples are joined with quadratic curves through their midpoints
     * (each sample is the control point), so fast strokes don't show creases.
     * Only past samples are needed, so this works live.
     */
    walk(stroke, i) {
      const pts = stroke.points, p = pts[i];
      if (i === 0) {
        stroke._acc = 0;
        this.stampAt(stroke, this.kindOf(stroke), p.x, p.y, p.r * stroke.scale, p.s, 1, 0, 0);
        stroke._last = { x: p.x, y: p.y, r: p.r, s: p.s };
        return;
      }
      const prev = pts[i - 1];
      const mid = { x: (prev.x + p.x) / 2, y: (prev.y + p.y) / 2, r: (prev.r + p.r) / 2, s: (prev.s + p.s) / 2 };
      if (i === 1) this.line(stroke, stroke._last, mid);
      else this.curve(stroke, stroke._last, prev, mid);
      stroke._last = mid;
    }

    // Draws the last half-segment and settles delayed features once the stroke ends.
    finish(stroke) {
      const pts = stroke.points;
      if (pts.length > 1 && stroke._last) this.line(stroke, stroke._last, pts[pts.length - 1]);
      this.carveDue(stroke, Infinity);
    }

    kindOf(stroke) { return stroke.erase ? 'erase' : stroke._mat.stamp || 'tube'; }

    curve(stroke, a, c, b) {
      const approx = Math.hypot(c.x - a.x, c.y - a.y) + Math.hypot(b.x - c.x, b.y - c.y);
      const n = Math.max(1, Math.ceil(approx / 3));
      let prev = a;
      for (let j = 1; j <= n; j++) {
        const t = j / n, u = 1 - t;
        const q = k => u * u * a[k] + 2 * u * t * c[k] + t * t * b[k];
        const pt = { x: q('x'), y: q('y'), r: q('r'), s: q('s') };
        this.line(stroke, prev, pt);
        prev = pt;
      }
    }

    // Stamps at an even spacing along a straight piece, carrying leftover distance over.
    line(stroke, p0, p1) {
      const k = stroke.scale, kind = this.kindOf(stroke);
      const dx = p1.x - p0.x, dy = p1.y - p0.y;
      const len = Math.hypot(dx, dy);
      if (len === 0) return;
      const tx = dx / len, ty = dy / len;
      const rMid = ((p0.r + p1.r) / 2) * k;
      const step = kind === 'sand' ? Math.max(1, rMid * 0.3) : Math.max(0.35, Math.min(1.2, rMid * 0.07));
      let d = step - stroke._acc;
      while (d <= len) {
        const t = d / len;
        stroke._walked += step;
        this.stampAt(stroke, kind, p0.x + dx * t, p0.y + dy * t, (p0.r + (p1.r - p0.r) * t) * k, p0.s + (p1.s - p0.s) * t, tx, ty, step);
        d += step;
      }
      stroke._acc = len - (d - step);
    }

    // True once every `gap` of travelled distance for the named feature (always true at the start).
    due(stroke, key, gap) {
      const next = stroke._next[key];
      if (next !== undefined && stroke._walked < next) return false;
      stroke._next[key] = stroke._walked + gap;
      return true;
    }

    /* ---------- brushes ---------- */

    stampAt(stroke, kind, x, y, r, slow, tx, ty, step) {
      const relief = stroke.relief, owner = stroke._index, profile = stroke._mat.profile, rng = stroke._rng;
      // Resting height on the layers below, smoothed along the path so the stroke
      // climbs over what it crosses without ripples.
      const lifts = stroke._liftS;
      if (this._lift && kind !== 'erase') {
        const k = step ? 1 - Math.exp(-step / (0.45 * r)) : 1;
        this.mirrored(stroke, x, y, 0, 0, (mx, my, _dx, _dy, c) => {
          const target = this.liftAt(mx, my, r);
          lifts[c] = lifts[c] === undefined ? target : lifts[c] + (target - lifts[c]) * k;
        });
      }
      const liftFor = c => (this._lift ? lifts[c] || 0 : 0);
      const disc = (px, py, pr, pRelief, pProfile) =>
        this.mirrored(stroke, px, py, 0, 0, (mx, my, _dx, _dy, c) => this.disc(mx, my, pr, pRelief, owner, pProfile, liftFor(c)));

      switch (kind) {
        case 'erase':
          this.mirrored(stroke, x, y, 0, 0, (mx, my) => this.erase(mx, my, r));
          return;

        case 'tube':
          disc(x, y, r, relief, profile);
          return;

        case 'beads':
          // A bead every diameter along the path; size breathes slightly.
          if (this.due(stroke, 'bead', r * 2.05)) disc(x, y, r * (0.92 + rng() * 0.16), relief, 'round');
          return;

        case 'sand': {
          // Slow strokes clump grains tightly; fast strokes scatter them.
          const count = Math.ceil(2 + r * 0.6 * (0.4 + slow));
          const spread = r * (1.4 - slow * 0.7);
          for (let g = 0; g < count; g++) {
            const a = rng() * Math.PI * 2, d = Math.sqrt(rng()) * spread;
            disc(x + Math.cos(a) * d, y + Math.sin(a) * d, this.unit * (0.8 + rng() * 1.4), relief, 'round');
          }
          if (slow > 0.5) disc(x, y, r * 0.7 * slow, relief * 0.5, 'soft');
          return;
        }

        case 'foam': {
          // Fast: a smooth low stripe. Slow: the line swells and boils up into bubbles.
          disc(x, y, r * (0.55 + 0.25 * slow), relief * 0.6, 'soft');
          if (slow > 0.3 && this.due(stroke, 'bubble', r * (0.7 - slow * 0.35))) {
            const count = 1 + Math.round(slow * 3);
            for (let g = 0; g < count; g++) {
              const a = rng() * Math.PI * 2, d = Math.sqrt(rng()) * r * (0.5 + slow * 0.6);
              disc(x + Math.cos(a) * d, y + Math.sin(a) * d, r * (0.18 + rng() * 0.32) * (0.6 + slow * 0.6), relief, 'round');
            }
          }
          return;
        }

        case 'porous': {
          // A solid body; spherical cavities are carved a little behind the pen
          // so the body stamped later doesn't fill them back in.
          disc(x, y, r, relief, profile);
          if (this.due(stroke, 'pore', r * 0.45)) {
            const a = rng() * Math.PI * 2, d = Math.sqrt(rng()) * r * 0.85;
            stroke._cavities.push({ x: x + Math.cos(a) * d, y: y + Math.sin(a) * d, r: r * (0.18 + rng() * 0.4), at: stroke._walked });
          }
          this.carveDue(stroke, stroke._walked - r * 2.4);
          return;
        }

        case 'thorns':
        case 'leaves': {
          const leaf = kind === 'leaves';
          const stem = r * (leaf ? 0.35 : 0.55);
          disc(x, y, stem, relief, 'round');
          if (!this.due(stroke, 'spike', r * (leaf ? 1.5 : 2.6)) || stroke._walked < r) return;
          const side = (stroke._side = -stroke._side);
          const nx = -ty * side, ny = tx * side; // perpendicular, alternating sides
          // Thorns lean back along the stem, leaves reach forward.
          const back = leaf ? 0.55 : -0.65;
          let ddx = nx * 0.75 + tx * back, ddy = ny * 0.75 + ty * back;
          const dl = Math.hypot(ddx, ddy); ddx /= dl; ddy /= dl;
          const len = r * (leaf ? 2.4 + rng() * 0.8 : 2 + rng() * 0.6);
          const width = leaf ? r * 0.75 : stem * 0.95;
          this.mirrored(stroke, x + nx * stem * 0.4, y + ny * stem * 0.4, ddx, ddy, (mx, my, mdx, mdy, c) =>
            this.spike(mx, my, mdx, mdy, len, width, relief, owner, side, leaf ? 'leaf' : 'thorn', liftFor(c)));
          return;
        }
      }
    }

    carveDue(stroke, upTo) {
      const list = stroke._cavities;
      while (list.length && list[0].at <= upTo) {
        const c = list.shift();
        this.mirrored(stroke, c.x, c.y, 0, 0, (mx, my) => this.cavity(mx, my, c.r, stroke._index));
      }
    }

    heightProfile(profile, r, t) {
      // t = distance from centre / radius, 0..1
      if (profile === 'flat') return r * 0.6 * Math.pow(1 - t * t, 0.3);
      if (profile === 'soft') { const q = 1 - t * t; return r * 0.5 * q * q; }
      return r * Math.sqrt(1 - t * t);
    }

    bounds(cx, cy, rx, ry) {
      const x0 = Math.max(0, Math.floor(cx - rx - 1)), x1 = Math.min(this.W - 1, Math.ceil(cx + rx + 1));
      const y0 = Math.max(0, Math.floor(cy - ry - 1)), y1 = Math.min(this.H_ - 1, Math.ceil(cy + ry + 1));
      return x0 > x1 || y0 > y1 ? null : [x0, y0, x1, y1];
    }

    // Height of the layers below a stamp. Rings of samples around it, weighted
    // down with distance, make the stroke start climbing just before it touches
    // what it crosses, so it drapes over in a smooth ramp instead of a step.
    liftAt(cx, cy, r) {
      const B = this._lift;
      if (!B) return 0;
      let m = 0;
      const W = this.W, Hh = this.H_;
      const sample = (x, y, w) => {
        x = Math.round(x); y = Math.round(y);
        if (x < 0 || y < 0 || x >= W || y >= Hh) return;
        const v = B[y * W + x] * w;
        if (v > m) m = v;
      };
      sample(cx, cy, 1);
      for (const [d, w] of LIFT_RINGS) {
        for (let k = 0; k < 8; k++) {
          const a = (k * Math.PI) / 4 + d; // offset each ring's angles a little
          sample(cx + Math.cos(a) * r * d, cy + Math.sin(a) * r * d, w);
        }
      }
      return m * 0.9; // sinks in slightly, like a soft material resting on another
    }

    disc(cx, cy, r, relief, owner, profile, lift = 0) {
      if (r <= 0.05) return;
      const b = this.bounds(cx, cy, r, r);
      if (!b) return;
      const [x0, y0, x1, y1] = b;
      const W = this.W, H = this.H, C = this.C, O = this.O;
      const rr = r + 0.5;
      for (let y = y0; y <= y1; y++) {
        const dy = y + 0.5 - cy;
        let i = y * W + x0;
        for (let x = x0; x <= x1; x++, i++) {
          const dx = x + 0.5 - cx;
          const d2 = dx * dx + dy * dy;
          if (d2 > rr * rr) continue;
          const d = Math.sqrt(d2);
          const t = d >= r ? 1 : d / r;
          const h = this.heightProfile(profile, r, t) * relief + lift;
          if (O[i] < 0 || h > H[i]) { H[i] = h; O[i] = owner; }
          const cov = rr - d;
          if (cov > C[i]) C[i] = cov > 1 ? 1 : cov;
        }
      }
      this.mark(x0, y0, x1, y1);
    }

    // A tapering hooked thorn, or a lens-shaped leaf with a midrib, from (bx, by) along (dx, dy).
    spike(bx, by, dx, dy, len, baseR, relief, owner, side, shape, baseLift = 0) {
      const leaf = shape === 'leaf';
      const ex = bx + dx * len, ey = by + dy * len;
      const reach = baseR + len * 0.35;
      const b = this.bounds((bx + ex) / 2, (by + ey) / 2, Math.abs(ex - bx) / 2 + reach, Math.abs(ey - by) / 2 + reach);
      if (!b) return;
      const [x0, y0, x1, y1] = b;
      const W = this.W, H = this.H, C = this.C, O = this.O, u1 = this.unit;
      const lift = Math.max(baseLift, this.liftAt(bx + dx * len * 0.5, by + dy * len * 0.5, baseR));
      const curve = (leaf ? 0.12 : 0.35) * side;
      for (let y = y0; y <= y1; y++) {
        let i = y * W + x0;
        for (let x = x0; x <= x1; x++, i++) {
          const px = x + 0.5 - bx, py = y + 0.5 - by;
          const u = px * dx + py * dy;
          if (u < -baseR * 0.3 || u > len) continue;
          const t = clamp(u / len, 0, 1);
          const v = -px * dy + py * dx - curve * len * t * t;
          const hw = leaf ? baseR * Math.pow(Math.sin(Math.PI * t), 0.75) : baseR * Math.pow(1 - t, 1.15);
          const av = Math.abs(v);
          if (av > hw + 0.5) continue;
          const core = hw > 0 ? Math.sqrt(Math.max(0, hw * hw - v * v)) : 0;
          let h = leaf
            ? core * 0.45 + baseR * 0.25 * (1 - t) - (av < 0.8 * u1 ? 0.6 * u1 : 0) // flatter, with a groove
            : core + baseR * 0.55 * (1 - t);
          h = h * relief + lift;
          if (O[i] < 0 || h > H[i]) { H[i] = h; O[i] = owner; }
          const cov = hw + 0.5 - av;
          if (cov > C[i]) C[i] = cov > 1 ? 1 : cov;
        }
      }
      this.mark(x0, y0, x1, y1);
    }

    // Scoops a spherical hollow out of this stroke's own surface; deep ones cut through.
    cavity(cx, cy, r, owner) {
      const b = this.bounds(cx, cy, r, r);
      if (!b) return;
      const [x0, y0, x1, y1] = b;
      const W = this.W, H = this.H, C = this.C, O = this.O, lift = this._lift;
      for (let y = y0; y <= y1; y++) {
        let i = y * W + x0;
        for (let x = x0; x <= x1; x++, i++) {
          if (O[i] !== owner) continue;
          const dx = x + 0.5 - cx, dy = y + 0.5 - cy, d2 = dx * dx + dy * dy;
          if (d2 >= r * r) continue;
          const floor = lift ? lift[i] * 0.9 : 0;
          const h = H[i] - Math.sqrt(r * r - d2) * 1.6;
          if (h <= floor + 0.3) { C[i] = 0; H[i] = floor; O[i] = -1; }
          else H[i] = h;
        }
      }
      this.mark(x0, y0, x1, y1);
    }

    // Cuts through every layer; the cut keeps its full height so the edge reads as a sharp relief.
    erase(cx, cy, r) {
      const b = this.bounds(cx, cy, r, r);
      if (!b) return;
      const [x0, y0, x1, y1] = b;
      const W = this.W, H = this.H, C = this.C, O = this.O;
      for (let y = y0; y <= y1; y++) {
        let i = y * W + x0;
        for (let x = x0; x <= x1; x++, i++) {
          const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
          const e = r + 0.5 - Math.sqrt(dx * dx + dy * dy);
          if (e <= 0) continue;
          if (e >= 1) { C[i] = 0; H[i] = 0; O[i] = -1; }
          else C[i] *= 1 - e;
        }
      }
      this.mark(x0, y0, x1, y1);
    }

    /* ---------- shading ---------- */

    // Shades and uploads whatever changed since the last call.
    present() {
      if (!this.dirty) return;
      const [x0, y0, x1, y1] = this.dirty;
      this.dirty = null;
      // Shadows reach a little beyond the change.
      const m = Math.ceil(20 * this.unit);
      const a = Math.max(0, x0 - m), b = Math.max(0, y0 - m), c = Math.min(this.W - 1, x1 + m), d = Math.min(this.H_ - 1, y1 + m);
      this.shade(a, b, c, d);
      this.flush(a, b, c, d);
    }

    flush(x0, y0, x1, y1) {
      this.ctx.putImageData(this.image, 0, 0, x0, y0, x1 - x0 + 1, y1 - y0 + 1);
    }

    shade(x0, y0, x1, y1) {
      const W = this.W, Hh = this.H_, H = this.H, C = this.C, O = this.O, N = this.N, F = this.F;
      const out = this.image.data;
      const [lx, ly, lz] = this.lightVector();
      // Half vector between light and a viewer looking straight down.
      let hx = lx, hy = ly, hz = lz + 1;
      const hl = Math.hypot(hx, hy, hz); hx /= hl; hy /= hl; hz /= hl;
      const lxy = Math.hypot(lx, ly) || 1;
      // Shadow ray: walk toward the light; anything rising above the ray casts a shadow.
      const sdx = lx / lxy, sdy = ly / lxy, rise = lz / lxy;
      const rayStep = 1.5 * this.unit, raySteps = 12;
      const strokes = this.strokes;
      const bg = this.backdrop.pixels, paper = this.backdrop.color;
      const u = this.unit;

      for (let y = y0; y <= y1; y++) {
        let i = y * W + x0, p = i * 4;
        for (let x = x0; x <= x1; x++, i++, p += 4) {
          const cov = C[i], o = O[i];
          if (cov <= 0.002 || o < 0) { out[p + 3] = 0; continue; }
          const st = strokes[o];
          const m = st._mat;
          const g = (m.grain || 0) * st.grain * u;

          // Height of neighbours, with material grain added on top of the form.
          const iL = x > 0 ? i - 1 : i, iR = x < W - 1 ? i + 1 : i;
          const iU = y > 0 ? i - W : i, iD = y < Hh - 1 ? i + W : i;
          let hL = H[iL], hR = H[iR], hU = H[iU], hD = H[iD];
          if (g) {
            hL += g * (N[iL] * 1.2 + F[iL] * 0.5) * Math.min(1, hL / (3 * u));
            hR += g * (N[iR] * 1.2 + F[iR] * 0.5) * Math.min(1, hR / (3 * u));
            hU += g * (N[iU] * 1.2 + F[iU] * 0.5) * Math.min(1, hU / (3 * u));
            hD += g * (N[iD] * 1.2 + F[iD] * 0.5) * Math.min(1, hD / (3 * u));
          }
          let nx = (hL - hR) * 0.5, ny = (hU - hD) * 0.5, nz = 1;
          const nl = Math.hypot(nx, ny, nz); nx /= nl; ny /= nl; nz /= nl;

          // Cast shadow from taller layers between this pixel and the light.
          let occl = 0;
          const h0 = H[i];
          for (let s = 1; s <= raySteps; s++) {
            const dist = s * rayStep;
            const sx = (x + sdx * dist) | 0, sy = (y + sdy * dist) | 0;
            if (sx < 0 || sy < 0 || sx >= W || sy >= Hh) break;
            if (H[sy * W + sx] - h0 > dist * rise + u) { occl = 1 - (s - 1) / (raySteps * 1.6); break; }
          }

          const ndl = nx * lx + ny * ly + nz * lz;
          const diff = (ndl > 0 ? ndl : 0) * (1 - occl * 0.7);
          const ndh = (nx * hx + ny * hy + nz * hz) * (occl ? 0 : 1);
          const rgb = st._rgb;
          let r, gg, b, alpha = cov;

          if (m.shade === 'metal') {
            // Reflect the view ray into a simple studio: dark floor, bright key light, crisp horizon.
            const rx = 2 * nz * nx, ry = 2 * nz * ny, rz = 2 * nz * nz - 1;
            const e = rx * lx + ry * ly + rz * lz;
            const toward = (rx * lx + ry * ly) / lxy;
            let lo = smooth(-0.6, 0.5, toward);
            lo = lo * (1 - 0.55 * Math.exp(-((toward - 0.08) * (toward - 0.08)) / 0.004)); // horizon line
            const hi = (smooth(0.7, 0.92, e) + 0.35 * Math.pow(Math.max(0, ndh), 40)) * (1 - occl);
            const bounce = smooth(0.3, 0.95, 1 - nz) * smooth(0.1, -0.6, toward); // floor light on the far edge
            const base = (0.2 + 0.66 * lo + 0.5 * bounce) * (1 - occl * 0.5);
            r = rgb[0] * base + (255 - rgb[0] * base) * hi * 0.95;
            gg = rgb[1] * base + (255 - rgb[1] * base) * hi * 0.95;
            b = rgb[2] * base + (255 - rgb[2] * base) * hi * 0.95;
            const amb = 0.85 + 0.15 * diff;
            r *= amb; gg *= amb; b *= amb;
          } else if (m.shade === 'glass') {
            // Refract the backdrop through the bent surface, tint it, add highlight, caustic and rim.
            const k = 34 * u;
            const sx = clamp(Math.round(x - nx * k), 0, W - 1), sy = clamp(Math.round(y - ny * k), 0, Hh - 1);
            let br, bgc, bb;
            if (bg) { const q = (sy * W + sx) * 4; br = bg[q]; bgc = bg[q + 1]; bb = bg[q + 2]; }
            else { br = paper[0]; bgc = paper[1]; bb = paper[2]; }
            const fres = Math.pow(1 - nz, 1.8);
            const tint = 0.4;
            r = br * (1 - tint + (tint * rgb[0]) / 255);
            gg = bgc * (1 - tint + (tint * rgb[1]) / 255);
            b = bb * (1 - tint + (tint * rgb[2]) / 255);
            const edge = fres * 0.8; // thick glass at grazing angles: darker, more saturated
            r += (rgb[0] * 0.3 - r) * edge; gg += (rgb[1] * 0.3 - gg) * edge; b += (rgb[2] * 0.3 - b) * edge;
            const toward = (nx * lx + ny * ly) / lxy;
            const caustic = Math.pow(Math.max(0, -toward), 3) * (1 - nz) * 150 * (1 - occl);
            const rimLine = smooth(0.55, 0.85, 1 - nz) * Math.max(0, toward) * 170 * (1 - occl);
            const spec = Math.pow(Math.max(0, ndh), 220) * 255 + Math.pow(Math.max(0, ndh), 24) * 40;
            const add = spec + caustic + rimLine;
            const dim = 1 - occl * 0.3;
            r = r * dim + add; gg = gg * dim + add; b = b * dim + add;
          } else if (m.shade === 'pearl') {
            const amb = 0.5;
            const sheen = Math.pow(1 - nz, 1.5);
            const spec = Math.pow(Math.max(0, ndh), 70) * 230;
            r = rgb[0] * (amb + 0.55 * diff) + spec + sheen * 40;
            gg = rgb[1] * (amb + 0.5 * diff) + spec + sheen * 25;
            b = rgb[2] * (amb + 0.6 * diff) + spec + sheen * 55;
          } else if (m.shade === 'stipple') {
            // Ink dots on a jittered grid; darker areas get bigger dots.
            const amb = 0.3;
            const lum = clamp(amb + (1 - amb) * diff + 0.6 * Math.pow(Math.max(0, ndh), m.shin), 0, 1);
            const dark = Math.pow(1 - lum, 0.8);
            const cs = 3.4 * u;
            const cx = Math.floor(x / cs), cy = Math.floor(y / cs);
            const jx = (cx + 0.5 + (hash2(cx, cy) - 0.5) * 0.5) * cs, jy = (cy + 0.5 + (hash2(cy, cx + 7) - 0.5) * 0.5) * cs;
            const dist = Math.hypot(x + 0.5 - jx, y + 0.5 - jy);
            const dotR = cs * 0.7 * Math.sqrt(dark) + 0.25 * u;
            const ink = clamp(dotR - dist + 0.5, 0, 1);
            r = rgb[0]; gg = rgb[1]; b = rgb[2];
            alpha = cov * ink;
          } else {
            const amb = 0.38;
            let albedo = 1;
            if (m.speckle) albedo -= m.speckle * smooth(0.25, 0.48, F[i]) * diff;
            if (m.paper) albedo /= amb + (1 - amb) * Math.max(0, lz) * (m.kd || 0.9);
            const lit = (amb + (1 - amb) * diff * (m.kd || 0.9)) * albedo;
            const spec = (m.ks || 0) * Math.pow(Math.max(0, ndh), m.shin || 10) * 255;
            const rim = (m.rim || 0) * Math.pow(1 - nz, 3) * 255;
            r = rgb[0] * lit + spec + rim;
            gg = rgb[1] * lit + spec + rim;
            b = rgb[2] * lit + spec + rim;
          }
          if (m.shade !== 'stipple') {
            // Contact darkening where the form meets the ground.
            const contact = 0.82 + 0.18 * Math.min(1, H[i] / (2.5 * u));
            r *= contact; gg *= contact; b *= contact;
          }
          out[p] = r; out[p + 1] = gg; out[p + 2] = b;
          out[p + 3] = alpha * 255;
        }
      }
    }

    // Bounding box of everything drawn, or null.
    contentBounds() {
      const W = this.W, Hh = this.H_, C = this.C;
      let x0 = W, y0 = Hh, x1 = -1, y1 = -1;
      for (let y = 0, i = 0; y < Hh; y++) {
        for (let x = 0; x < W; x++, i++) {
          if (C[i] > 0.01) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
        }
      }
      return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
    }
  }

  global.GlassBrush = { Engine, MATERIALS, hexToRgb };
})(window);
