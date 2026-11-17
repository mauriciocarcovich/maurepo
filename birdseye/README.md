# Bird’s-Eye PDF Workspace

A local-first canvas for reading and annotating PDFs on iPad and Mac. The whole document sits on one
canvas: pinch and drag to move between a bird’s-eye view of every page and a close reading of a single
line, while a floating Notes panel stays put on screen.

## What it does

- **Library:** every PDF you open is kept on the device. Tap the document title to switch between
  documents or delete one; each keeps its own notes, highlights and last view.
- **Canvas:** pinch, drag and flick between a bird’s-eye view of every page and a single line.
  Tap a page to read it, double-tap to return; **Fit all** frames the pages beside the Notes panel.
- **Highlights:** Pan / Select text switch (an Apple Pencil always selects). Four tags — Important,
  Question, Disagree, Idea — underline, delete (with Undo) and linked notes with pins on the canvas.
- **Notes panel:** drag, resize, minimize; general notes per document; linked notes hidden until opened.
- **Search:** ⌘F / Ctrl+F or 🔍 — the document or your notes, with per-page match counts.
- **Export:** a Markdown brief grouped by page or by tag, with quotes and page references, to copy or
  download. Workspace backup and restore as JSON.
- **Works offline** once opened; password-protected PDFs are supported.

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

## Later

- OCR for scanned PDFs, several documents on one canvas, sync between devices.
