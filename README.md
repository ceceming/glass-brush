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
- **14 materials:** Glass, Chrome, Gold, Glaze, Clay, Stone, Foam, Porous, Pearls, Thorn Vine,
  Leafy Vine, Sand, Stipple and Paper Emboss. Foam boils into bubbles when you slow down, and
  sand clumps when you go slow and scatters when you go fast.
- **Layers.** Every stroke is a layer. Click one in the Layers list to change its material,
  colour, size, relief or grain after drawing. The picture rebuilds. You can also hide (◉),
  reorder (↑ ↓) and delete (×) layers, and it's all undoable.
- **Stack on layers below.** When this is on, a new stroke rests on earlier ones: it climbs over
  them and casts a shadow onto them. When it's off, the stroke melts into them.
- **Light direction and height** relight the whole picture, shadows included.
- **Mirror ↔ / ↕** draws symmetric copies, which is useful for ornaments.
- **Eraser** cuts through every layer. The cut edge keeps its relief.
- **Backdrop:** paper, dot grid, stripes or dark. Or use **Photo** to load your own image,
  either filling the canvas or framed as a mounted print. Glass refracts it.
- **Zoom.** Pinch with two fingers, or use Ctrl/⌘ + scroll. Scroll pans. **Fit** resets.
- **Export PNG** re-renders your strokes at up to 2× resolution on a transparent background,
  cropped to the drawing. **Export with backdrop** saves the whole composition.
- Keys: `Ctrl/⌘+Z` undo, `Ctrl/⌘+Shift+Z` redo, `E` eraser, `X`/`Y` mirror, `[` `]` size,
  `+`/`-` zoom, `0` fit, `Esc` stop editing a layer.

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
   stroke is on top. A stacking stroke reads the height of the layers below it and
   rests on them. The lift is sampled in rings around each stamp and smoothed along
   the path, so the stroke climbs over what it crosses instead of jumping up.
   Pearls place spheres at even spacing. Thorn Vine and Leafy Vine add tapered spikes
   or leaves on alternating sides. Sand and Foam scatter seeded random grains and
   bubbles. Porous carves spherical hollows a little behind the pen.
4. **Shading.** The surface normal comes from the height gradient. A short ray toward
   the light finds taller layers in the way, which gives cast shadows. Then:
   - Glaze, clay, stone and sand use diffuse light plus a specular highlight, with
     noise grain mixed into the height.
   - Chrome and gold reflect the view ray into a simple studio: dark floor, horizon
     line, key light and bounce light.
   - Glass samples the backdrop at an offset along the normal (refraction), tints it,
     darkens it at grazing angles and adds caustics and a rim highlight.
   - Stipple turns the lighting into ink dots on a jittered grid, with bigger dots where
     the surface is darker.
5. **Shadow.** A CSS `drop-shadow` on the stroke canvas follows the light direction.
   The same filter is applied when exporting.
6. **Speed.** While you draw, only the changed rectangle is re-shaded. A full rebuild
   of a typical canvas takes about 60 ms. Random brushes use a seeded RNG, so a rebuild
   matches the live drawing pixel for pixel.

To add a material, add an entry to `MATERIALS` in `js/engine.js`. Give it a `shade`
model (`phong`, `metal`, `glass` or `pearl`), a `profile`, and optionally a `stamp`
type. It shows up in the picker with a rendered preview automatically.
