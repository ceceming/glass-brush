/* Glass Brush UI: input, controls, layers, history, zoom, backdrop and export. */
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
    mirrorX: false, mirrorY: false, erase: false, stack: true,
    backdrop: 'dots', image: null
  };
  const undoStack = [], redoStack = [];
  let selected = null;     // layer being edited, or null when the controls set up the next stroke
  let pendingEdit = null;  // { stroke, before } while a slider drag is in progress

  /* ---------- backdrop ---------- */

  const BACKDROP_COLORS = { paper: '#eeeae2', dots: '#eeeae2', stripes: '#ece8df', dark: '#18191c', image: '#eeeae2', framed: '#eeeae2' };

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
    } else if (kind === 'framed' && image) {
      // The photo as a mounted print: white mat, soft shadow, centred.
      const s = Math.min((w * 0.72) / image.width, (h * 0.72) / image.height);
      const iw = image.width * s, ih = image.height * s;
      const mat = Math.min(w, h) * 0.035;
      const x = (w - iw) / 2, y = (h - ih) / 2;
      ctx.save();
      ctx.shadowColor = 'rgba(30,24,16,.28)'; ctx.shadowBlur = 24 * unit; ctx.shadowOffsetY = 8 * unit;
      ctx.fillStyle = '#fbfaf7';
      ctx.fillRect(x - mat, y - mat, iw + mat * 2, ih + mat * 2);
      ctx.restore();
      ctx.drawImage(image, x, y, iw, ih);
    }
  }

  const backdropPixels = (ctx, w, h) => ctx.getImageData(0, 0, w, h).data;

  function applyBackdrop() {
    const ctx = backdropCanvas.getContext('2d', { willReadFrequently: true });
    paintBackdrop(ctx, W, H, state.backdrop, scale, state.image);
    engine.setBackdrop(hexToRgb(BACKDROP_COLORS[state.backdrop]), backdropPixels(ctx, W, H));
    engine.rebuild(); // glass and emboss depend on the backdrop
  }

  /* ---------- shadow (follows the light) ---------- */

  function shadowParams(pxPerUnit) {
    const [lx, ly, lz] = engine.lightVector();
    const len = (1 - lz) * 14 + 3;
    return { dx: -lx * len * pxPerUnit, dy: -ly * len * pxPerUnit, blur: (6 + (1 - lz) * 8) * pxPerUnit };
  }
  function updateShadow() {
    const cssPerUnit = board.offsetWidth / cssW; // layout size, so zoom doesn't count twice
    const s = shadowParams(cssPerUnit);
    strokeCanvas.style.filter =
      `drop-shadow(${s.dx.toFixed(1)}px ${s.dy.toFixed(1)}px ${s.blur.toFixed(1)}px rgba(20,16,10,.32))`;
  }

  /* ---------- material picker with rendered previews ---------- */

  function renderPreview(key) {
    const c = document.createElement('canvas');
    const pw = 128, ph = 60;
    const mini = new Engine(c, pw, ph, { unit: 1 });
    const bctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    bctx.canvas.width = pw; bctx.canvas.height = ph;
    paintBackdrop(bctx, pw, ph, 'dots', 1, null);
    mini.setBackdrop(hexToRgb(BACKDROP_COLORS.dots), backdropPixels(bctx, pw, ph));
    const stroke = mini.beginStroke({ material: key, color: state.colors[key], relief: 1, grain: 1 });
    for (let i = 0; i <= 40; i++) {
      const t = i / 40;
      mini.addPoint(stroke, { x: 14 + t * 100, y: 30 + Math.sin(t * Math.PI * 2) * 12, r: 7, s: 0.5 });
    }
    stroke.done = true;
    mini.finish(stroke);
    mini.present();
    bctx.drawImage(c, 0, 0); // flatten onto the backdrop so glass shows refraction
    return bctx.canvas.toDataURL();
  }

  const materialButtons = {};
  Object.entries(MATERIALS).forEach(([key, m]) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'material';
    b.setAttribute('role', 'radio');
    b.innerHTML = `<img alt="" src="${renderPreview(key)}"><span>${m.label}</span>`;
    b.addEventListener('click', () => pickMaterial(key));
    $('material-list').append(b);
    materialButtons[key] = b;
  });

  function showMaterial(key) {
    Object.entries(materialButtons).forEach(([k, b]) => b.setAttribute('aria-checked', String(k === key)));
  }

  function pickMaterial(key) {
    if (selected && !selected.erase) {
      editSelected(s => { s.material = key; s.color = state.colors[key]; });
      commitEdit();
      syncControls();
      return;
    }
    if (selected) select(null);
    state.material = key;
    setErase(false);
    syncControls();
  }

  /* ---------- controls ---------- */

  const controls = {
    size: $('size'), relief: $('relief'), grain: $('grain'), color: $('color'),
    angle: $('angle'), elev: $('elev')
  };
  const fmt = {
    size: v => `${Math.round(v)}px`, relief: v => `${v}%`, grain: v => `${v}%`,
    angle: v => `${v}°`, elev: v => `${v}°`
  };
  const showValue = id => { $(id + '-out').textContent = fmt[id](Number(controls[id].value)); };

  // Puts either the selected layer's style or the next-stroke settings into the controls.
  function syncControls() {
    const s = selected;
    const editing = !!(s && !s.erase);
    $('edit-banner').hidden = !s;
    $('brush-heading').textContent = s ? 'Layer' : 'Brush';
    if (s) $('edit-label').textContent = `Editing ${layerName(s, engine.strokes.indexOf(s))}`;
    const material = editing ? s.material : state.material;
    showMaterial(s && s.erase ? null : material);
    controls.color.value = editing ? s.color || state.colors[material] : state.colors[material];
    controls.color.disabled = !!MATERIALS[material].paper || !!(s && s.erase);
    controls.size.value = s ? Math.round((s.baseSize * s.scale) / scale) : state.size;
    controls.relief.value = Math.round((editing ? s.relief : state.relief) * 100);
    controls.grain.value = Math.round((editing ? s.grain : state.grain) * 100);
    controls.relief.disabled = controls.grain.disabled = !!(s && s.erase);
    ['size', 'relief', 'grain'].forEach(showValue);
  }

  let rebuildFrame = 0;
  function scheduleRebuild() {
    if (rebuildFrame) return;
    rebuildFrame = requestAnimationFrame(() => { rebuildFrame = 0; engine.rebuild(); });
  }

  const pick = s => ({ material: s.material, color: s.color, relief: s.relief, grain: s.grain, scale: s.scale, hidden: s.hidden });

  function editSelected(mutate) {
    if (!selected) return;
    if (!pendingEdit || pendingEdit.stroke !== selected) { commitEdit(); pendingEdit = { stroke: selected, before: pick(selected) }; }
    mutate(selected);
    scheduleRebuild();
  }
  function commitEdit() {
    if (!pendingEdit) return;
    const { stroke, before } = pendingEdit;
    pendingEdit = null;
    const after = pick(stroke);
    if (JSON.stringify(before) !== JSON.stringify(after)) commit({ type: 'restyle', stroke, before, after });
  }

  controls.size.addEventListener('input', () => {
    const v = Number(controls.size.value);
    if (selected) editSelected(s => { s.scale = (v * scale) / s.baseSize; });
    else state.size = v;
    showValue('size');
  });
  controls.relief.addEventListener('input', () => {
    const v = Number(controls.relief.value) / 100;
    if (selected) editSelected(s => { s.relief = v; }); else state.relief = v;
    showValue('relief');
  });
  controls.grain.addEventListener('input', () => {
    const v = Number(controls.grain.value) / 100;
    if (selected) editSelected(s => { s.grain = v; }); else state.grain = v;
    showValue('grain');
  });
  controls.color.addEventListener('input', () => {
    const v = controls.color.value;
    if (selected) editSelected(s => { s.color = v; });
    else state.colors[state.material] = v;
  });
  ['size', 'relief', 'grain', 'color'].forEach(id => controls[id].addEventListener('change', commitEdit));

  let lightFrame = 0;
  function relight() {
    if (lightFrame) return;
    lightFrame = requestAnimationFrame(() => {
      lightFrame = 0;
      engine.shade(0, 0, W - 1, H - 1); engine.flush(0, 0, W - 1, H - 1);
      updateShadow();
    });
  }
  controls.angle.addEventListener('input', () => { engine.light.angle = Number(controls.angle.value); showValue('angle'); relight(); });
  controls.elev.addEventListener('input', () => { engine.light.elevation = Number(controls.elev.value); showValue('elev'); relight(); });

  function toggle(id, key) {
    const b = $(id);
    b.addEventListener('click', () => { state[key] = !state[key]; b.setAttribute('aria-pressed', String(state[key])); });
  }
  toggle('mirror-x', 'mirrorX');
  toggle('mirror-y', 'mirrorY');
  toggle('stack', 'stack');
  function setErase(on) { state.erase = on; $('eraser').setAttribute('aria-pressed', String(on)); }
  $('eraser').addEventListener('click', () => { const on = !state.erase; select(null); setErase(on); });
  $('edit-done').addEventListener('click', () => select(null));

  $('backdrop-kind').addEventListener('change', e => { state.backdrop = e.target.value; applyBackdrop(); });
  $('image-input').addEventListener('change', e => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const img = new Image();
    img.onload = () => {
      state.image = img;
      const sel = $('backdrop-kind');
      sel.querySelectorAll('[value=image],[value=framed]').forEach(o => { o.disabled = false; });
      if (state.backdrop !== 'image' && state.backdrop !== 'framed') state.backdrop = 'framed';
      sel.value = state.backdrop;
      applyBackdrop();
      URL.revokeObjectURL(img.src);
    };
    img.src = URL.createObjectURL(file);
    e.target.value = '';
  });

  /* ---------- layers ---------- */

  const layerName = (stroke, index) => `${index + 1}. ${stroke.erase ? 'Eraser' : MATERIALS[stroke.material].label}`;

  function select(stroke) {
    commitEdit();
    selected = stroke;
    if (stroke) setErase(false);
    syncControls();
    renderLayers();
  }

  function renderLayers() {
    const list = $('layers');
    list.textContent = '';
    const strokes = engine.strokes;
    $('layers-empty').hidden = strokes.length > 0;
    for (let i = strokes.length - 1; i >= 0; i--) {
      const s = strokes[i];
      const li = document.createElement('li');
      li.className = 'layer' + (s === selected ? ' selected' : '') + (s.hidden ? ' is-hidden' : '');
      const dot = s.erase ? 'transparent' : MATERIALS[s.material].paper ? '#eeeae2' : s.color;
      li.innerHTML =
        `<span class="layer-dot" style="background:${dot}"></span><span class="layer-name"></span>` +
        `<button type="button" data-act="hide" title="${s.hidden ? 'Show' : 'Hide'}">${s.hidden ? '○' : '◉'}</button>` +
        `<button type="button" data-act="up" title="Move up" ${i === strokes.length - 1 ? 'disabled' : ''}>↑</button>` +
        `<button type="button" data-act="down" title="Move down" ${i === 0 ? 'disabled' : ''}>↓</button>` +
        `<button type="button" data-act="delete" title="Delete">×</button>`;
      li.querySelector('.layer-name').textContent = layerName(s, i);
      li.addEventListener('click', e => layerAction(s, e.target.closest('button')?.dataset.act));
      list.append(li);
    }
  }

  function layerAction(s, act) {
    if (!act) { select(selected === s ? null : s); return; }
    commitEdit();
    const index = engine.strokes.indexOf(s);
    if (act === 'hide') {
      const before = pick(s); s.hidden = !s.hidden;
      commit({ type: 'restyle', stroke: s, before, after: pick(s) });
    } else if (act === 'up' || act === 'down') {
      const to = index + (act === 'up' ? 1 : -1);
      if (to < 0 || to >= engine.strokes.length) return;
      moveStroke(index, to);
      commit({ type: 'move', from: index, to });
    } else if (act === 'delete') {
      engine.strokes.splice(index, 1);
      if (selected === s) selected = null;
      commit({ type: 'delete', stroke: s, index });
    }
    engine.rebuild();
    syncControls();
    renderLayers();
  }

  function moveStroke(from, to) {
    const [s] = engine.strokes.splice(from, 1);
    engine.strokes.splice(to, 0, s);
  }

  /* ---------- history ---------- */

  function syncHistoryButtons() {
    $('undo').disabled = !undoStack.length;
    $('redo').disabled = !redoStack.length;
  }
  function commit(action) { undoStack.push(action); redoStack.length = 0; syncHistoryButtons(); renderLayers(); }

  function apply(action, forward) {
    const strokes = engine.strokes;
    switch (action.type) {
      case 'add':
        if (forward) strokes.push(action.stroke); else strokes.splice(strokes.indexOf(action.stroke), 1);
        break;
      case 'clear':
        engine.strokes = forward ? [] : action.strokes.slice();
        break;
      case 'restyle':
        Object.assign(action.stroke, forward ? action.after : action.before);
        break;
      case 'delete':
        if (forward) strokes.splice(action.index, 1); else strokes.splice(action.index, 0, action.stroke);
        break;
      case 'move':
        if (forward) moveStroke(action.from, action.to); else moveStroke(action.to, action.from);
        break;
    }
    if (selected && !engine.strokes.includes(selected)) selected = null;
    engine.rebuild();
    syncControls();
    renderLayers();
  }
  function undo() { commitEdit(); const a = undoStack.pop(); if (a) { apply(a, false); redoStack.push(a); syncHistoryButtons(); } }
  function redo() { commitEdit(); const a = redoStack.pop(); if (a) { apply(a, true); undoStack.push(a); syncHistoryButtons(); } }

  $('undo').addEventListener('click', undo);
  $('redo').addEventListener('click', redo);
  $('clear').addEventListener('click', () => {
    commitEdit();
    if (!engine.strokes.length) return;
    const strokes = engine.strokes.slice();
    engine.strokes = []; selected = null;
    engine.rebuild();
    commit({ type: 'clear', strokes });
    syncControls();
  });

  /* ---------- zoom and pan ---------- */

  const view = { s: 1, tx: 0, ty: 0 };
  const applyView = () => { board.style.transform = `translate(${view.tx}px, ${view.ty}px) scale(${view.s})`; };
  function boardOrigin() {
    const r = stage.getBoundingClientRect();
    return { x: r.left + board.offsetLeft, y: r.top + board.offsetTop };
  }
  // Zoom so the content under (cx, cy) stays under it.
  function zoomTo(s, cx, cy, from = view) {
    s = Math.max(0.5, Math.min(8, s));
    const o = boardOrigin();
    const qx = (cx - o.x - from.tx) / from.s, qy = (cy - o.y - from.ty) / from.s;
    view.s = s; view.tx = cx - o.x - qx * s; view.ty = cy - o.y - qy * s;
    applyView();
  }
  function fitView() { view.s = 1; view.tx = 0; view.ty = 0; applyView(); }
  $('fit').addEventListener('click', fitView);

  stage.addEventListener('wheel', e => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      // Trackpad pinches send small deltas, mouse wheels large ones.
      const k = Math.abs(e.deltaY) > 40 ? 0.0025 : 0.01;
      zoomTo(view.s * Math.exp(-e.deltaY * k), e.clientX, e.clientY);
    }
    else { view.tx -= e.deltaX; view.ty -= e.deltaY; applyView(); }
  }, { passive: false });

  // Two fingers zoom and pan; one finger or the pen draws. No mode to switch.
  const touches = new Map();
  let pinch = null;
  const midpoint = () => {
    const [a, b] = [...touches.values()];
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) || 1 };
  };
  stage.addEventListener('pointerdown', e => {
    if (e.pointerType !== 'touch') return;
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touches.size === 2) {
      if (active && active.type === 'touch') cancelActive();
      pinch = { start: midpoint(), view: { ...view } };
    }
  }, true);
  stage.addEventListener('pointermove', e => {
    if (!touches.has(e.pointerId)) return;
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (!pinch || touches.size < 2) return;
    const m = midpoint(), st = pinch.start;
    // Zoom around the starting midpoint, then follow the fingers' movement.
    zoomTo(pinch.view.s * (m.d / st.d), st.x, st.y, pinch.view);
    view.tx += m.x - st.x; view.ty += m.y - st.y;
    applyView();
  }, true);
  const liftTouch = e => { touches.delete(e.pointerId); if (touches.size < 2) pinch = null; };
  stage.addEventListener('pointerup', liftTouch, true);
  stage.addEventListener('pointercancel', liftTouch, true);

  /* ---------- drawing ---------- */

  let active = null; // { id, stroke, x, y, t, speed, r, type }
  let penSeen = false;
  let frame = 0;

  const toCanvas = e => {
    const r = strokeCanvas.getBoundingClientRect(); // includes zoom and pan
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
    if (pinch) return;
    if (e.pointerType === 'pen') {
      penSeen = true;
      // The palm landed first: throw its line away when the nib arrives.
      if (active && active.type === 'touch') cancelActive();
    } else if (e.pointerType === 'touch' && (penSeen || active)) return;
    if (active) return;
    e.preventDefault();
    if (selected) select(null); // drawing goes back to the brush settings
    strokeCanvas.setPointerCapture(e.pointerId);
    const p = toCanvas(e);
    const stroke = engine.beginStroke({
      material: state.material, color: state.colors[state.material],
      relief: state.relief, grain: state.grain, stack: state.stack,
      mirrorX: state.mirrorX, mirrorY: state.mirrorY, erase: state.erase
    });
    stroke.baseSize = state.size * scale;
    // Start at a moderate speed so the stroke doesn't begin with a knob.
    const { r, slow } = radiusFor(e, 0.6 * scale);
    active = { id: e.pointerId, stroke, x: p.x, y: p.y, t: e.timeStamp, speed: 0.6 * scale, r, type: e.pointerType };
    engine.addPoint(stroke, { x: p.x, y: p.y, r, s: slow });
    schedule();
    $('hint').classList.add('gone');
  });

  strokeCanvas.addEventListener('pointermove', e => {
    if (!active || e.pointerId !== active.id) return;
    const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
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
    const stroke = active.stroke;
    active = null;
    commit({ type: 'add', stroke });
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
    return new Promise(resolve => canvas.toBlob(blob => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = name;
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      resolve();
    }, 'image/png'));
  }

  // Re-renders every layer from scratch at k× resolution for a crisp export.
  function renderHiRes(k) {
    const hw = Math.round(W * k), hh = Math.round(H * k);
    const c = document.createElement('canvas');
    const hi = new Engine(c, hw, hh, { unit: scale * k });
    hi.light = { ...engine.light };
    const bc = document.createElement('canvas');
    bc.width = hw; bc.height = hh;
    const bctx = bc.getContext('2d', { willReadFrequently: true });
    paintBackdrop(bctx, hw, hh, state.backdrop, scale * k, state.image);
    hi.setBackdrop(hexToRgb(BACKDROP_COLORS[state.backdrop]), backdropPixels(bctx, hw, hh));
    hi.strokes = engine.strokes.map(s => ({ ...s, points: s.points.map(p => ({ x: p.x * k, y: p.y * k, r: p.r * k, s: p.s })) }));
    hi.rebuild();
    return { hi, strokes: c, backdrop: bc };
  }

  async function exportPNG(withBackdrop, button) {
    commitEdit();
    if (!withBackdrop && !engine.contentBounds()) return;
    const label = button.textContent;
    button.disabled = true; button.textContent = 'Rendering…';
    await new Promise(r => setTimeout(r, 30)); // let the label paint
    try {
      const k = Math.max(1, Math.min(2, Math.sqrt(5e6 / (W * H))));
      const { hi, strokes, backdrop } = renderHiRes(k);
      const s = shadowParams(scale * k);
      let sx = 0, sy = 0, w = hi.W, h = hi.H_;
      if (!withBackdrop) {
        const b = hi.contentBounds();
        // Crop to the drawing, leaving room for the shadow.
        const pad = Math.ceil(s.blur * 2 + Math.max(Math.abs(s.dx), Math.abs(s.dy)));
        sx = Math.max(0, b.x - pad); sy = Math.max(0, b.y - pad);
        w = Math.min(hi.W, b.x + b.w + pad) - sx; h = Math.min(hi.H_, b.y + b.h + pad) - sy;
      }
      const out = document.createElement('canvas');
      out.width = w; out.height = h;
      const ctx = out.getContext('2d');
      if (withBackdrop) ctx.drawImage(backdrop, 0, 0);
      ctx.filter = `drop-shadow(${s.dx}px ${s.dy}px ${s.blur}px rgba(20,16,10,.32))`;
      ctx.drawImage(strokes, sx, sy, w, h, 0, 0, w, h);
      await download(out, withBackdrop ? 'glass-brush-composition.png' : 'glass-brush.png');
    } finally {
      button.disabled = false; button.textContent = label;
    }
  }
  $('export').addEventListener('click', e => exportPNG(false, e.currentTarget));
  $('export-all').addEventListener('click', e => exportPNG(true, e.currentTarget));

  /* ---------- keyboard ---------- */

  document.addEventListener('keydown', e => {
    if (e.target.closest('input, select')) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
    else if (mod) return;
    else if (e.key === 'e') $('eraser').click();
    else if (e.key === 'x') $('mirror-x').click();
    else if (e.key === 'y') $('mirror-y').click();
    else if (e.key === 'Escape') select(null);
    else if (e.key === '0') fitView();
    else if (e.key === '+' || e.key === '=' || e.key === '-') {
      const r = stage.getBoundingClientRect();
      zoomTo(view.s * (e.key === '-' ? 0.8 : 1.25), r.left + r.width / 2, r.top + r.height / 2);
    } else if (e.key === '[' || e.key === ']') {
      controls.size.value = Number(controls.size.value) + (e.key === ']' ? 2 : -2);
      controls.size.dispatchEvent(new Event('input'));
      commitEdit();
    }
  });

  /* ---------- start ---------- */

  $('backdrop-kind').value = state.backdrop;
  ['angle', 'elev'].forEach(showValue);
  syncControls();
  applyBackdrop();
  fitBoard();
  syncHistoryButtons();
  renderLayers();
  addEventListener('resize', fitBoard);
  window.glassBrush = { engine, state, view }; // handy for debugging in the console
})();
