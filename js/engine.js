/*
 * Glass Brush rendering engine.
 *
 * Every stroke is stored as a list of points { x, y, r, s } (position, radius,
 * slowness 0..1). Strokes are rasterised into three per-pixel buffers:
 *
 *   H  height of the surface (in pixels)       — max-merged, so strokes fuse
 *   C  coverage 0..1                            — anti-aliased silhouette
 *   O  owner: index of the stroke on top        — decides the material
 *
 * The shader then derives a surface normal from the height gradient and lights
 * each pixel according to its owner's material (diffuse/specular, a reflected
 * studio environment for metal, or refraction of the backdrop for glass).
 *
 * Because strokes are kept as data, the whole picture can be rebuilt at any
 * time: change the light, restyle a stroke, undo — everything re-renders.
 */
(function (global) {
  'use strict';

  const MATERIALS = {
    glass:   { label: 'Glass',          shade: 'glass', profile: 'round', color: '#bfe3ee' },
    metal:   { label: 'Chrome',         shade: 'metal', profile: 'round', color: '#c9ccd2' },
    gold:    { label: 'Gold',           shade: 'metal', profile: 'round', color: '#e0b060' },
    ceramic: { label: 'Glaze',          shade: 'phong', profile: 'round', color: '#2c5f93', kd: 0.8, ks: 1.1, shin: 160, rim: 0.35 },
    clay:    { label: 'Clay',           shade: 'phong', profile: 'round', color: '#d0704f', kd: 0.95, ks: 0.07, shin: 10, grain: 0.7 },
    stone:   { label: 'Stone',          shade: 'phong', profile: 'flat',  color: '#a29d93', kd: 1, ks: 0.03, shin: 6, grain: 2.6, speckle: 0.35 },
    pearls:  { label: 'Pearls',         shade: 'pearl', profile: 'round', color: '#efe6dc', stamp: 'beads' },
    thorns:  { label: 'Thorn Vine',     shade: 'phong', profile: 'round', color: '#3f5f3c', kd: 0.85, ks: 0.45, shin: 45, stamp: 'thorns' },
    sand:    { label: 'Sand',           shade: 'phong', profile: 'round', color: '#d9bb8c', kd: 0.95, ks: 0.05, shin: 8, grain: 0.3, stamp: 'sand' },
    emboss:  { label: 'Paper Emboss',   shade: 'phong', profile: 'soft',  color: null, kd: 0.95, ks: 0.05, shin: 8, grain: 0.1, paper: true }
  };

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

  function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  // Small, fast, seedable PRNG so random brushes (sand, beads) rebuild identically.
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
      this.unit = options.unit || 1; // pixel density: grain and refraction scale with it
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
      this.C = new Float32Array(n);
      this.O = new Int16Array(n).fill(-1);
      this.image = this.ctx.createImageData(width, height);
      // Two noise layers: coarse (rock lumps) and fine (grain), built once.
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
        mirrorX: style.mirrorX,
        mirrorY: style.mirrorY,
        erase: !!style.erase,
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
      stroke._beadDist = Infinity; // first bead lands on the first point
      stroke._thornDist = 0;
    }

    rebuild() {
      this.H.fill(0); this.C.fill(0); this.O.fill(-1);
      this.strokes.forEach((stroke, index) => {
        this.prepare(stroke, index);
        for (let i = 0; i < stroke.points.length; i++) this.walk(stroke, i);
        if (stroke.done) this.finish(stroke);
      });
      this.dirty = null;
      this.shade(0, 0, this.W - 1, this.H_ - 1);
      this.flush(0, 0, this.W - 1, this.H_ - 1);
    }

    /* ---------- rasterisation ---------- */

    mark(x0, y0, x1, y1) {
      const d = this.dirty;
      if (!d) this.dirty = [x0, y0, x1, y1];
      else { d[0] = Math.min(d[0], x0); d[1] = Math.min(d[1], y0); d[2] = Math.max(d[2], x1); d[3] = Math.max(d[3], y1); }
    }

    // Calls fn for the point and for each mirrored copy. (dx, dy) is a direction that mirrors too.
    mirrored(stroke, x, y, dx, dy, fn) {
      fn(x, y, dx, dy);
      if (stroke.mirrorX) fn(this.W - x, y, -dx, dy);
      if (stroke.mirrorY) fn(x, this.H_ - y, dx, -dy);
      if (stroke.mirrorX && stroke.mirrorY) fn(this.W - x, this.H_ - y, -dx, -dy);
    }

    /*
     * Path smoothing: pointer samples are joined with quadratic curves through
     * their midpoints (each sample is the control point), so fast strokes
     * don't show creases. Only past samples are needed, so it works live.
     */
    walk(stroke, i) {
      const pts = stroke.points, p = pts[i];
      if (i === 0) {
        stroke._acc = 0;
        this.stampAt(stroke, this.kindOf(stroke), p.x, p.y, p.r * stroke.scale, p.s, 1, 0);
        stroke._last = { x: p.x, y: p.y, r: p.r, s: p.s };
        return;
      }
      const prev = pts[i - 1];
      const mid = { x: (prev.x + p.x) / 2, y: (prev.y + p.y) / 2, r: (prev.r + p.r) / 2, s: (prev.s + p.s) / 2 };
      if (i === 1) this.line(stroke, stroke._last, mid);
      else this.curve(stroke, stroke._last, prev, mid);
      stroke._last = mid;
    }

    // Draws the last half-segment once the stroke is finished.
    finish(stroke) {
      const pts = stroke.points;
      if (pts.length > 1 && stroke._last) this.line(stroke, stroke._last, pts[pts.length - 1]);
    }

    kindOf(stroke) { return stroke.erase ? 'erase' : stroke._mat.stamp || 'tube'; }

    curve(stroke, a, c, b) {
      const approx = Math.hypot(c.x - a.x, c.y - a.y) + Math.hypot(b.x - c.x, b.y - c.y);
      const n = Math.max(1, Math.ceil(approx / 3));
      let prev = a;
      for (let j = 1; j <= n; j++) {
        const t = j / n, u = 1 - t;
        const q = (k) => u * u * a[k] + 2 * u * t * c[k] + t * t * b[k];
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
        this.stampAt(stroke, kind, p0.x + dx * t, p0.y + dy * t, (p0.r + (p1.r - p0.r) * t) * k, p0.s + (p1.s - p0.s) * t, tx, ty);
        d += step;
      }
      stroke._acc = len - (d - step);
    }

    stampAt(stroke, kind, x, y, r, slow, tx, ty) {
      const relief = stroke.relief, owner = stroke._index, profile = stroke._mat.profile;
      if (kind === 'erase') {
        this.mirrored(stroke, x, y, 0, 0, (mx, my) => this.erase(mx, my, r));
        return;
      }
      if (kind === 'tube') {
        this.mirrored(stroke, x, y, 0, 0, (mx, my) => this.disc(mx, my, r, relief, owner, profile));
        return;
      }
      if (kind === 'beads') {
        // A bead every diameter along the path; size breathes slightly.
        stroke._beadDist = (stroke._beadDist || 0) + Math.max(0.35, Math.min(1.2, r * 0.07));
        if (stroke._beadDist < r * 2.05) return;
        stroke._beadDist = 0;
        const br = r * (0.92 + stroke._rng() * 0.16);
        this.mirrored(stroke, x, y, 0, 0, (mx, my) => this.disc(mx, my, br, relief, owner, 'round'));
        return;
      }
      if (kind === 'sand') {
        // Slow strokes clump grains tightly; fast strokes scatter them.
        const count = Math.ceil(2 + r * 0.6 * (0.4 + slow));
        const spread = r * (1.4 - slow * 0.7);
        for (let g = 0; g < count; g++) {
          const a = stroke._rng() * Math.PI * 2;
          const d = Math.sqrt(stroke._rng()) * spread;
          const gr = this.unit * (0.8 + stroke._rng() * 1.4);
          const gx = x + Math.cos(a) * d, gy = y + Math.sin(a) * d;
          this.mirrored(stroke, gx, gy, 0, 0, (mx, my) => this.disc(mx, my, gr, relief, owner, 'round'));
        }
        // A low body under the grains so a slow stroke reads as a heap.
        if (slow > 0.5) this.mirrored(stroke, x, y, 0, 0, (mx, my) => this.disc(mx, my, r * 0.7 * slow, relief * 0.5, owner, 'soft'));
        return;
      }
      if (kind === 'thorns') {
        const stem = r * 0.55;
        this.mirrored(stroke, x, y, 0, 0, (mx, my) => this.disc(mx, my, stem, relief, owner, 'round'));
        stroke._thornDist = (stroke._thornDist || 0) + Math.max(0.35, Math.min(1.2, r * 0.07));
        if (stroke._thornDist < r * 2.6) return;
        stroke._thornDist = 0;
        const side = (stroke._side = -stroke._side);
        const nx = -ty * side, ny = tx * side; // perpendicular, alternating sides
        // Thorns lean backwards along the stem.
        let ddx = nx * 0.75 - tx * 0.65, ddy = ny * 0.75 - ty * 0.65;
        const dl = Math.hypot(ddx, ddy); ddx /= dl; ddy /= dl;
        const len = r * (2 + stroke._rng() * 0.6);
        this.mirrored(stroke, x + nx * stem * 0.4, y + ny * stem * 0.4, ddx, ddy, (mx, my, mdx, mdy) =>
          this.thorn(mx, my, mdx, mdy, len, stem * 0.95, relief, owner, side));
      }
    }

    heightProfile(profile, r, t) {
      // t = distance from centre / radius, 0..1
      if (profile === 'flat') return r * 0.6 * Math.pow(1 - t * t, 0.3);
      if (profile === 'soft') { const q = 1 - t * t; return r * 0.5 * q * q; }
      return r * Math.sqrt(1 - t * t);
    }

    disc(cx, cy, r, relief, owner, profile) {
      if (r <= 0.05) return;
      const W = this.W, Hh = this.H_, H = this.H, C = this.C, O = this.O;
      const x0 = Math.max(0, Math.floor(cx - r - 1)), x1 = Math.min(W - 1, Math.ceil(cx + r + 1));
      const y0 = Math.max(0, Math.floor(cy - r - 1)), y1 = Math.min(Hh - 1, Math.ceil(cy + r + 1));
      if (x0 > x1 || y0 > y1) return;
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
          const h = this.heightProfile(profile, r, t) * relief;
          if (O[i] < 0 || h > H[i]) { H[i] = h; O[i] = owner; }
          const cov = rr - d;
          if (cov > C[i]) C[i] = cov > 1 ? 1 : cov;
        }
      }
      this.mark(x0, y0, x1, y1);
    }

    // A tapering, slightly curved spike from (bx, by) along (dx, dy).
    thorn(bx, by, dx, dy, len, baseR, relief, owner, side) {
      const W = this.W, Hh = this.H_, H = this.H, C = this.C, O = this.O;
      const pad = baseR + 2;
      const ex = bx + dx * len, ey = by + dy * len;
      const x0 = Math.max(0, Math.floor(Math.min(bx, ex) - pad - len * 0.3)), x1 = Math.min(W - 1, Math.ceil(Math.max(bx, ex) + pad + len * 0.3));
      const y0 = Math.max(0, Math.floor(Math.min(by, ey) - pad - len * 0.3)), y1 = Math.min(Hh - 1, Math.ceil(Math.max(by, ey) + pad + len * 0.3));
      if (x0 > x1 || y0 > y1) return;
      const curve = 0.35 * side;
      for (let y = y0; y <= y1; y++) {
        let i = y * W + x0;
        for (let x = x0; x <= x1; x++, i++) {
          const px = x + 0.5 - bx, py = y + 0.5 - by;
          const u = px * dx + py * dy;
          if (u < -baseR * 0.3 || u > len) continue;
          const t = clamp(u / len, 0, 1);
          const v = -px * dy + py * dx - curve * len * t * t; // hook toward the tip
          const hw = baseR * Math.pow(1 - t, 1.15);
          const av = Math.abs(v);
          if (av > hw + 0.5) continue;
          const core = hw > 0 ? Math.sqrt(Math.max(0, hw * hw - v * v)) : 0;
          const h = (core + baseR * 0.55 * (1 - t)) * relief;
          if (O[i] < 0 || h > H[i]) { H[i] = h; O[i] = owner; }
          const cov = hw + 0.5 - av;
          if (cov > C[i]) C[i] = cov > 1 ? 1 : cov;
        }
      }
      this.mark(x0, y0, x1, y1);
    }

    // Cuts through the form; the cut keeps its full height so the edge reads as a sharp relief.
    erase(cx, cy, r) {
      const W = this.W, Hh = this.H_, H = this.H, C = this.C, O = this.O;
      const x0 = Math.max(0, Math.floor(cx - r - 1)), x1 = Math.min(W - 1, Math.ceil(cx + r + 1));
      const y0 = Math.max(0, Math.floor(cy - r - 1)), y1 = Math.min(Hh - 1, Math.ceil(cy + r + 1));
      if (x0 > x1 || y0 > y1) return;
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
      const a = Math.max(0, x0 - 2), b = Math.max(0, y0 - 2), c = Math.min(this.W - 1, x1 + 2), d = Math.min(this.H_ - 1, y1 + 2);
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

          const ndl = nx * lx + ny * ly + nz * lz;
          const diff = ndl > 0 ? ndl : 0;
          const ndh = nx * hx + ny * hy + nz * hz;
          const rgb = st._rgb;
          let r, gg, b, alpha = cov;

          if (m.shade === 'metal') {
            // Reflect the view ray and look it up in a simple studio: dark floor, bright key light, crisp horizon.
            const rx = 2 * nz * nx, ry = 2 * nz * ny, rz = 2 * nz * nz - 1;
            const e = rx * lx + ry * ly + rz * lz;
            const toward = (rx * lx + ry * ly) / lxy; // reflection leaning toward the light side
            let lo = smooth(-0.6, 0.5, toward);
            lo = lo * (1 - 0.55 * Math.exp(-((toward - 0.08) * (toward - 0.08)) / 0.004)); // horizon line
            const hi = smooth(0.7, 0.92, e) + 0.35 * Math.pow(Math.max(0, ndh), 40);
            const bounce = smooth(0.3, 0.95, 1 - nz) * smooth(0.1, -0.6, toward); // floor light on the far edge
            const base = 0.2 + 0.66 * lo + 0.5 * bounce;
            r = rgb[0] * base + (255 - rgb[0] * base) * hi * 0.95;
            gg = rgb[1] * base + (255 - rgb[1] * base) * hi * 0.95;
            b = rgb[2] * base + (255 - rgb[2] * base) * hi * 0.95;
            const amb = 0.85 + 0.15 * diff;
            r *= amb; gg *= amb; b *= amb;
          } else if (m.shade === 'glass') {
            // Refract the backdrop through the bent surface; tint it, add a sharp highlight and dark rim.
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
            // Thick glass at grazing angles: darker and more saturated with the glass colour.
            const edge = fres * 0.8;
            r += (rgb[0] * 0.3 - r) * edge; gg += (rgb[1] * 0.3 - gg) * edge; b += (rgb[2] * 0.3 - b) * edge;
            const toward = (nx * lx + ny * ly) / lxy;
            // Light passing through gathers on the side away from the light; a thin bright line rims the lit edge.
            const caustic = Math.pow(Math.max(0, -toward), 3) * (1 - nz) * 150;
            const rimLine = smooth(0.55, 0.85, 1 - nz) * Math.max(0, toward) * 170;
            const spec = Math.pow(Math.max(0, ndh), 220) * 255 + Math.pow(Math.max(0, ndh), 24) * 40;
            const add = spec + caustic + rimLine;
            r += add; gg += add; b += add;
            alpha = cov;
          } else if (m.shade === 'pearl') {
            const amb = 0.5;
            const sheen = Math.pow(1 - nz, 1.5);
            const spec = Math.pow(Math.max(0, ndh), 70) * 230;
            r = rgb[0] * (amb + 0.55 * diff) + spec + sheen * 40;
            gg = rgb[1] * (amb + 0.5 * diff) + spec + sheen * 25;
            b = rgb[2] * (amb + 0.6 * diff) + spec + sheen * 55;
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
          // Contact darkening where the form meets the ground.
          const contact = 0.82 + 0.18 * Math.min(1, H[i] / (2.5 * u));
          out[p] = r * contact; out[p + 1] = gg * contact; out[p + 2] = b * contact;
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
