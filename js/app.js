/* Glass Brush UI: pointer input, controls, history, backdrop and export. */
(() => {
  'use strict';
  const { Engine, MATERIALS, hexToRgb } = window.GlassBrush;
  const $ = id => document.getElementById(id);

  const stage = $('stage'), board = $('board');
  const strokeCanvas = $('strokes'), backdropCanvas = $('backdrop');

  /* ---------- canvas size ---------- */

  // Internal resolution follows the screen, capped so shading stays fast.
  const stageRect = stage.getBoundingClientRect();
  const cssW = Math.max(320, Math.floor(stageRect.width - 32));
  const cssH = Math.max(240, Math.floor(stageRect.height - 32));
  let scale = Math.min(window.devicePixelRatio || 1, 2);
  const MAX_PIXELS = 3.2e6;
  if (cssW * cssH * scale * scale > MAX_PIXELS) scale = Math.sqrt(MAX_PIXELS / (cssW * cssH));
  const W = Math.round(cssW * scale), H = Math.round(cssH * scale);
  const aspect = W / H;

  const engine = new Engine(strokeCanvas, W, H, { unit: scale });
  backdropCanvas.width = W; backdropCanvas.height = H;

  function fitBoard() {
    const r = stage.getBoundingClientRect();
    let w = r.width - 32, h = w / aspect;
    if (h > r.height - 32) { h = r.height - 32; w = h * aspect; }
    board.style.width = `${Math.max(50, w)}px`;
    board.style.height = `${Math.max(50, h)}px`;
    updateShadow();
  }

  /* ---------- state ---------- */

  const state = {
    material: 'glass',
    colors: Object.fromEntries(Object.entries(MATERIALS).map(([k, m]) => [k, m.color || '#ffffff'])),
    size: 20, relief: 1, grain: 1,
    mirrorX: false, mirrorY: false, erase: false,
    backdrop: 'dots', image: null
  };
  const undoStack = [], redoStack = [];

  /* ---------- backdrop ---------- */

  const BACKDROP_COLORS = { paper: '#eeeae2', dots: '#eeeae2', stripes: '#ece8df', dark: '#18191c', image: '#eeeae2' };

  function paintBackdrop(ctx, w, h, kind, unit, image) {
    ctx.fillStyle = BACKDROP_COLORS[kind];
    ctx.fillRect(0, 0, w, h);
    if (kind === 'dots') {
      ctx.fillStyle = '#c9c3b6';
      const gap = 18 * unit;
      for (let y = gap / 2; y < h; y += gap) for (let x = gap / 2; x < w; x += gap) {
        ctx.beginPath(); ctx.arc(x, y, 1.6 * unit, 0, Math.PI * 2); ctx.fill();
      }
    } else if (kind === 'stripes') {
      ctx.fillStyle = '#d8d1c3';
      const gap = 22 * unit;
      for (let x = 0; x < w; x += gap) ctx.fillRect(x, 0, gap * 0.45, h);
    } else if (kind === 'image' && image) {
      // Cover-fit the photo.
      const s = Math.max(w / image.width, h / image.height);
      const iw = image.width * s, ih = image.height * s;
      ctx.drawImage(image, (w - iw) / 2, (h - ih) / 2, iw, ih);
    }
  }

  function applyBackdrop() {
    const ctx = backdropCanvas.getContext('2d', { willReadFrequently: true });
    paintBackdrop(ctx, W, H, state.backdrop, scale, state.image);
    const pixels = ctx.getImageData(0, 0, W, H).data;
    engine.setBackdrop(hexToRgb(BACKDROP_COLORS[state.backdrop]), pixels);
    engine.rebuild(); // glass and emboss depend on the backdrop
  }

  /* ---------- shadow (follows the light) ---------- */

  function shadowParams(pxPerUnit) {
    const [lx, ly, lz] = engine.lightVector();
    const len = (1 - lz) * 14 + 3;
    return { dx: -lx * len * pxPerUnit, dy: -ly * len * pxPerUnit, blur: (6 + (1 - lz) * 8) * pxPerUnit };
  }
  function updateShadow() {
    const cssPerUnit = board.getBoundingClientRect().width / cssW;
    const s = shadowParams(cssPerUnit);
    strokeCanvas.style.filter =
      `drop-shadow(${s.dx.toFixed(1)}px ${s.dy.toFixed(1)}px ${s.blur.toFixed(1)}px rgba(20,16,10,.32))`;
  }

  /* ---------- material picker with rendered previews ---------- */

  function renderPreview(key) {
    const c = document.createElement('canvas');
    const pw = 128, ph = 60;
    const mini = new Engine(c, pw, ph, { unit: 1 });
    const bctx = document.createElement('canvas').getContext('2d');
    bctx.canvas.width = pw; bctx.canvas.height = ph;
    paintBackdrop(bctx, pw, ph, 'dots', 1, null);
    mini.setBackdrop(hexToRgb(BACKDROP_COLORS.dots), bctx.getImageData(0, 0, pw, ph).data);
    const stroke = mini.beginStroke({ material: key, color: state.colors[key], relief: 1, grain: 1 });
    for (let i = 0; i <= 40; i++) {
      const t = i / 40;
      mini.addPoint(stroke, { x: 14 + t * 100, y: 30 + Math.sin(t * Math.PI * 2) * 12, r: 7, s: 0.5 });
    }
    stroke.done = true;
    mini.finish(stroke);
    mini.present();
    // Flatten onto the backdrop so the preview shows glass refraction too.
    bctx.drawImage(c, 0, 0);
    return bctx.canvas.toDataURL();
  }

  const list = $('material-list');
  const materialButtons = {};
  Object.entries(MATERIALS).forEach(([key, m]) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'material';
    b.setAttribute('role', 'radio');
    b.innerHTML = `<img alt="" src="${renderPreview(key)}"><span>${m.label}</span>`;
    b.addEventListener('click', () => selectMaterial(key));
    list.append(b);
    materialButtons[key] = b;
  });

  function selectMaterial(key) {
    state.material = key;
    setErase(false);
    Object.entries(materialButtons).forEach(([k, b]) => b.setAttribute('aria-checked', String(k === key)));
    const color = $('color');
    color.value = state.colors[key];
    color.disabled = !!MATERIALS[key].paper;
  }

  /* ---------- controls ---------- */

  const bind = (id, fn, fmt) => {
    const input = $(id), out = $(id + '-out');
    const sync = () => { fn(Number(input.value)); if (out) out.textContent = fmt(Number(input.value)); };
    input.addEventListener('input', sync);
    sync();
  };
  let lightFrame = 0;
  const relight = () => {
    if (lightFrame) return;
    lightFrame = requestAnimationFrame(() => {
      lightFrame = 0;
      engine.shade(0, 0, W - 1, H - 1); engine.flush(0, 0, W - 1, H - 1);
      updateShadow();
    });
  };
  bind('size', v => (state.size = v), v => `${v}px`);
  bind('relief', v => (state.relief = v / 100), v => `${v}%`);
  bind('grain', v => (state.grain = v / 100), v => `${v}%`);
  bind('angle', v => { engine.light.angle = v; relight(); }, v => `${v}°`);
  bind('elev', v => { engine.light.elevation = v; relight(); }, v => `${v}°`);
  $('elev-out').textContent = `${$('elev').value}°`;

  $('color').addEventListener('input', e => { state.colors[state.material] = e.target.value; });

  function toggle(id, key) {
    const b = $(id);
    b.addEventListener('click', () => { state[key] = !state[key]; b.setAttribute('aria-pressed', String(state[key])); });
  }
  toggle('mirror-x', 'mirrorX');
  toggle('mirror-y', 'mirrorY');
  function setErase(on) { state.erase = on; $('eraser').setAttribute('aria-pressed', String(on)); }
  $('eraser').addEventListener('click', () => setErase(!state.erase));

  $('backdrop-kind').addEventListener('change', e => { state.backdrop = e.target.value; applyBackdrop(); });
  $('image-input').addEventListener('change', e => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const img = new Image();
    img.onload = () => {
      state.image = img; state.backdrop = 'image';
      const sel = $('backdrop-kind'); sel.querySelector('[value=image]').disabled = false; sel.value = 'image';
      applyBackdrop();
      URL.revokeObjectURL(img.src);
    };
    img.src = URL.createObjectURL(file);
    e.target.value = '';
  });

  /* ---------- history ---------- */

  function syncHistoryButtons() {
    $('undo').disabled = !undoStack.length;
    $('redo').disabled = !redoStack.length;
    $('restyle').disabled = !engine.strokes.some(s => !s.erase);
  }
  function commit(action) { undoStack.push(action); redoStack.length = 0; syncHistoryButtons(); }

  function apply(action, forward) {
    if (action.type === 'add') {
      if (forward) engine.strokes.push(action.stroke);
      else engine.strokes.splice(engine.strokes.indexOf(action.stroke), 1);
    } else if (action.type === 'clear') {
      engine.strokes = forward ? [] : action.strokes.slice();
    } else if (action.type === 'restyle') {
      Object.assign(action.stroke, forward ? action.after : action.before);
    }
    engine.rebuild();
    syncHistoryButtons();
  }
  function undo() { const a = undoStack.pop(); if (a) { apply(a, false); redoStack.push(a); syncHistoryButtons(); } }
  function redo() { const a = redoStack.pop(); if (a) { apply(a, true); undoStack.push(a); syncHistoryButtons(); } }

  $('undo').addEventListener('click', undo);
  $('redo').addEventListener('click', redo);
  $('clear').addEventListener('click', () => {
    if (!engine.strokes.length) return;
    const strokes = engine.strokes.slice();
    engine.strokes = []; engine.rebuild();
    commit({ type: 'clear', strokes });
  });
  $('restyle').addEventListener('click', () => {
    const stroke = [...engine.strokes].reverse().find(s => !s.erase);
    if (!stroke) return;
    const pick = s => ({ material: s.material, color: s.color, relief: s.relief, grain: s.grain, scale: s.scale });
    const before = pick(stroke);
    const after = {
      material: state.material, color: state.colors[state.material], relief: state.relief, grain: state.grain,
      scale: (state.size * scale) / stroke.baseSize
    };
    Object.assign(stroke, after);
    engine.rebuild();
    commit({ type: 'restyle', stroke, before, after });
  });

  /* ---------- drawing ---------- */

  let active = null;      // { id, stroke, x, y, t, speed, r, type }
  let penSeen = false;
  let frame = 0;

  const toCanvas = e => {
    const r = strokeCanvas.getBoundingClientRect();
    return { x: ((e.clientX - r.left) * W) / r.width, y: ((e.clientY - r.top) * H) / r.height };
  };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; engine.present(); }); };

  function radiusFor(e, speed) {
    const base = (state.size * scale) / 2;
    const pressure = e.pointerType === 'pen' && e.pressure > 0 ? 0.35 + e.pressure * 0.9 : 1;
    const slow = 1 - Math.min(1, speed / (1.3 * scale)); // px per ms
    return { r: base * pressure * (0.8 + 0.5 * slow), slow };
  }

  strokeCanvas.addEventListener('pointerdown', e => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    if (e.pointerType === 'pen') {
      penSeen = true;
      // Palm landed first: throw its line away when the nib arrives.
      if (active && active.type === 'touch') cancelActive();
    } else if (e.pointerType === 'touch' && (penSeen || active)) return;
    if (active) return;
    e.preventDefault();
    strokeCanvas.setPointerCapture(e.pointerId);
    const p = toCanvas(e);
    const stroke = engine.beginStroke({
      material: state.material, color: state.colors[state.material],
      relief: state.relief, grain: state.grain,
      mirrorX: state.mirrorX, mirrorY: state.mirrorY, erase: state.erase
    });
    stroke.baseSize = state.size * scale;
    // Start at a moderate speed so the stroke doesn't begin with a knob.
    const { r, slow } = radiusFor(e, 0.6 * scale);
    active = { id: e.pointerId, stroke, x: p.x, y: p.y, t: e.timeStamp, speed: 0, r, type: e.pointerType };
    engine.addPoint(stroke, { x: p.x, y: p.y, r, s: slow });
    schedule();
    $('hint').classList.add('gone');
  });

  strokeCanvas.addEventListener('pointermove', e => {
    if (!active || e.pointerId !== active.id) return;
    const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of events.length ? events : [e]) {
      const p = toCanvas(ev);
      // Light smoothing removes jitter without lagging behind the hand.
      const x = active.x + (p.x - active.x) * 0.55, y = active.y + (p.y - active.y) * 0.55;
      const dist = Math.hypot(x - active.x, y - active.y);
      if (dist < 0.4 * scale) continue;
      const dt = Math.max(1, ev.timeStamp - active.t);
      active.speed += (dist / dt - active.speed) * 0.25;
      const { r, slow } = radiusFor(ev, active.speed);
      active.r += (r - active.r) * 0.3;
      engine.addPoint(active.stroke, { x, y, r: active.r, s: slow });
      active.x = x; active.y = y; active.t = ev.timeStamp;
    }
    schedule();
  });

  function finish(e) {
    if (!active || e.pointerId !== active.id) return;
    active.stroke.done = true;
    engine.finish(active.stroke);
    schedule();
    commit({ type: 'add', stroke: active.stroke });
    active = null;
  }
  function cancelActive() {
    if (!active) return;
    engine.strokes.splice(engine.strokes.indexOf(active.stroke), 1);
    active = null;
    engine.rebuild();
  }
  strokeCanvas.addEventListener('pointerup', finish);
  strokeCanvas.addEventListener('pointercancel', e => { if (active && e.pointerId === active.id) cancelActive(); });

  /* ---------- export ---------- */

  function download(canvas, name) {
    canvas.toBlob(blob => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = name;
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    }, 'image/png');
  }

  function exportPNG(withBackdrop) {
    const s = shadowParams(scale);
    const out = document.createElement('canvas');
    let sx = 0, sy = 0, w = W, h = H;
    if (!withBackdrop) {
      const b = engine.contentBounds();
      if (!b) return;
      // Crop to the drawing, leaving room for the shadow.
      const pad = Math.ceil(s.blur * 2 + Math.max(Math.abs(s.dx), Math.abs(s.dy)));
      sx = Math.max(0, b.x - pad); sy = Math.max(0, b.y - pad);
      w = Math.min(W, b.x + b.w + pad) - sx; h = Math.min(H, b.y + b.h + pad) - sy;
    }
    out.width = w; out.height = h;
    const ctx = out.getContext('2d');
    if (withBackdrop) ctx.drawImage(backdropCanvas, 0, 0);
    ctx.filter = `drop-shadow(${s.dx}px ${s.dy}px ${s.blur}px rgba(20,16,10,.32))`;
    ctx.drawImage(strokeCanvas, sx, sy, w, h, 0, 0, w, h);
    download(out, withBackdrop ? 'glass-brush-composition.png' : 'glass-brush.png');
  }
  $('export').addEventListener('click', () => exportPNG(false));
  $('export-all').addEventListener('click', () => exportPNG(true));

  /* ---------- keyboard ---------- */

  document.addEventListener('keydown', e => {
    if (e.target.closest('input, select')) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
    else if (mod) return;
    else if (e.key === 'e') setErase(!state.erase);
    else if (e.key === 'x') $('mirror-x').click();
    else if (e.key === 'y') $('mirror-y').click();
    else if (e.key === '[' || e.key === ']') {
      const size = $('size');
      size.value = Number(size.value) + (e.key === ']' ? 2 : -2);
      size.dispatchEvent(new Event('input'));
    }
  });

  /* ---------- start ---------- */

  $('backdrop-kind').value = state.backdrop;
  selectMaterial(state.material);
  applyBackdrop();
  fitBoard();
  syncHistoryButtons();
  addEventListener('resize', fitBoard);
  window.glassBrush = { engine, state }; // handy for debugging in the console
})();
