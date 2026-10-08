# Bookmarks Graph (Firefox)

Your Firefox bookmarks as an Obsidian-style graph.

## Install (temporary, for personal use)
1. Open `about:debugging#/runtime/this-firefox`
2. "Load Temporary Add-on…" → pick `manifest.json` from this folder
3. Click the graph icon on the toolbar — the graph opens in a tab

A temporary add-on disappears when Firefox restarts. For a permanent install, sign it
on AMO (unlisted): `npx web-ext sign --channel=unlisted --api-key=… --api-secret=…`

## Controls
- wheel — zoom, drag the background — pan, drag a node — move it
- click a link — open it (Ctrl/Shift — in the background); click a folder — highlight its connections
- `/` — search, `Esc` — reset; the dropdown shows a single section only
- the graph updates itself when bookmarks change
- ⚙ — settings: link labels, common root node, color scheme, sparseness and layout sliders (all logarithmic, ×1/16 … ×16)

`dev/` — a test page with data from `bookmarks.html` (to try it outside Firefox).
