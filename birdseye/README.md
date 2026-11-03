# Bird’s-Eye PDF Workspace

A local-first canvas for reading and annotating PDFs on iPad and Mac. The whole document sits on one
canvas: pinch and drag to move between a bird’s-eye view of every page and a close reading of a single
line, while a floating Notes panel stays put on screen.

## What works now (steps 0–2)

- Open a PDF from Files (iPad) or drag one in (Mac). Pages are laid out in a grid sized to the screen.
- Pinch, drag, flick, trackpad pinch/scroll, keyboard (`+` `-` `0`, arrows). Tap a page to read it,
  double-tap to return. **Fit all** frames the whole document beside the Notes panel.
- Level-of-detail rendering: cached thumbnails for the overview, sharp tiles only for what is on screen,
  capped in memory for iPad Safari.
- Notes panel: drag, resize from the corner, minimize to a pill. Size and position are stored as
  fractions of the screen. Linked passages are hidden by default (filled in step 3).
- Everything is saved on the device (IndexedDB): the PDF, thumbnails, notes, panel and view. Export
  notes as Markdown; back up and restore the workspace as JSON.
- Debug overlay (⋯ menu) shows scale, tiles, megapixels and render time — useful when testing on iPad.

## Develop

```sh
npm install
npm run dev      # http://localhost:5173
npm test         # geometry unit tests
npm run build    # static site in dist/
```

## Deploy

`.github/workflows/birdseye-pages.yml` builds and publishes `dist/` to GitHub Pages.
Enable it once in the repository: **Settings → Pages → Source: GitHub Actions**.

## Next

3. Text index, Select text mode, highlights, linked notes and pins on the canvas.
4. Search across the document and notes.
5. Markdown brief with page references, note tags.
