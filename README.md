# Glass Brush

A browser drawing tool where every stroke becomes a material: glass that bends
the backdrop, chrome, gold, glaze, clay, stone, pearls, thorny vines, sand and
paper emboss. It is plain HTML, CSS and JavaScript, with no dependencies and no
build step.

## Run it

```bash
python3 -m http.server 8000
```

Then open <http://localhost:8000>. Opening `index.html` straight from disk also works.

## Using it

- **Draw** with a mouse, a finger or a pen. Slow strokes come out thicker. Pen pressure changes
  the width. When a pen is in use, touches are ignored, so you can rest your palm on the screen.
- **Material, colour, size, relief, grain** apply to new strokes. **Restyle last stroke**
  applies the current settings to the stroke you just drew.
- **Light direction and height** relight the whole picture, shadows included.
- **Mirror ↔ / ↕** draws symmetric copies, which is useful for ornaments.
- **Eraser** cuts through the forms. The cut edge keeps its relief.
- **Backdrop**: paper, dot grid, stripes, dark, or your own photo (**Image**). Glass refracts it.
- **Export PNG** saves only your strokes, on a transparent background and cropped to the drawing.
  **Export with backdrop** saves the whole canvas.
- Keys: `Ctrl/⌘+Z` undo, `Ctrl/⌘+Shift+Z` redo, `E` eraser, `X`/`Y` mirror, `[` `]` size.

## How it works

`js/engine.js` holds the renderer, and `js/app.js` holds the UI, input, history and export.

1. **Strokes are data.** Each stroke stores its points `{x, y, radius, slowness}`
   and its style. Nothing is baked in, so undo, restyle and relight just re-render.
2. **Path smoothing.** Pointer samples are joined by quadratic curves through their
   midpoints, so fast strokes don't show creases.
3. **Height field.** Along the path, the engine stamps discs into a per-pixel height
   buffer using a profile: a round tube (`√(1−t²)`), a flat slab for stone, or a soft
   mound for emboss. Heights are max-merged, so overlapping strokes fuse into one form.
   A coverage buffer keeps edges anti-aliased, and an owner buffer records which
   stroke is on top. Pearls place spheres at even spacing. Thorn Vine adds tapered,
   hooked spikes on alternating sides. Sand scatters seeded random grains, tight when
   you draw slowly and loose when you draw fast.
4. **Shading.** The surface normal comes from the height gradient. Then:
   - Glaze, clay, stone and sand use diffuse light plus a specular highlight, with
     noise grain mixed into the height.
   - Chrome and gold reflect the view ray into a simple studio: dark floor, horizon
     line, key light and bounce light.
   - Glass samples the backdrop at an offset along the normal (refraction), tints it,
     darkens it at grazing angles and adds caustics and a rim highlight.
5. **Shadow.** A CSS `drop-shadow` on the stroke canvas follows the light direction.
   The same filter is applied when exporting.
6. **Speed.** While you draw, only the changed rectangle is re-shaded. A full rebuild
   of a typical canvas takes about 60 ms. Random brushes use a seeded RNG, so a rebuild
   matches the live drawing pixel for pixel.

To add a material, add an entry to `MATERIALS` in `js/engine.js`. Give it a `shade`
model (`phong`, `metal`, `glass` or `pearl`), a `profile`, and optionally a `stamp`
type. It shows up in the picker with a rendered preview automatically.
