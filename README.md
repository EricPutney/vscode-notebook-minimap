# Notebook Minimap

A community VS Code extension that adds a minimap for Jupyter / native notebooks, implementing the long-standing feature request [microsoft/vscode#115266](https://github.com/microsoft/vscode/issues/115266).

Extensions can't render inside the notebook scrollbar, and the sidebar-placement options all felt wrong (wrong thematic container, forced coexistence with unrelated views, couldn't control width). So the minimap opens as **an editor tab beside the notebook** (`createWebviewPanel` with `ViewColumn.Beside`). You get:

- Placement right next to the notebook, in the editor area — no sidebar gymnastics
- Full control over width by dragging the column divider
- No coexistence with Claude Code / Chat / other secondary-sidebar views
- Closes and reopens like any editor tab

## What's rendered

- **Code cells** — character-level glyphs with cheap token approximation (strings, comments, digits)
- **Markdown cells** — same character rendering, with **headings (H1–H6) promoted** to tall colored bars with tiny inline labels
- **Text outputs** — `stdout`/`stderr`/`text/plain` as density bands (stderr tinted red)
- **HTML outputs** — tags stripped, rendered as density bands
- **Image outputs** — PNG / JPEG / GIF / WebP / SVG drawn at correct aspect ratio (dimensions parsed from file headers host-side so layout doesn't jump when images load)
- **Viewport indicator** — tracks the notebook's visible range
- **Active-cell marker** — thin bar on the left

## Interaction

- **Click** anywhere in the minimap → notebook scrolls to that cell
- **Click + drag** → continuous scrolling
- Scrolling the notebook auto-scrolls the minimap to keep the viewport indicator in view
- Drag the column divider to resize; set `notebookMinimap.fillPanelWidth` if you want it to re-flow

## Installation

```bash
cd vscode-notebook-minimap
npm install
npm run compile
```

Press `F5` from this folder in VS Code to launch an Extension Development Host, or package with `npm run package` and `code --install-extension notebook-minimap-0.4.0.vsix`.

## Commands & keybinding

| Command | ID | Default key |
| --- | --- | --- |
| Open Notebook Minimap Beside | `notebookMinimap.open` | — |
| Toggle Notebook Minimap | `notebookMinimap.toggle` | `Ctrl`/`Cmd` + `K`, `M` |
| Refresh Notebook Minimap | `notebookMinimap.refresh` | — |
| Toggle Minimap Render Mode (Blocks / Characters) | `notebookMinimap.toggleRenderCharacters` | — |
| Toggle Minimap Fill-Panel-Width | `notebookMinimap.toggleFillPanelWidth` | — |

The keybinding is active when a notebook editor is focused or when the minimap panel itself is focused.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `notebookMinimap.autoOpenOnNotebook` | `false` | Auto-open the minimap beside a notebook the first time one becomes active this window session. |
| `notebookMinimap.defaultWidthFraction` | `0.12` | Fraction of editor-area width the minimap column takes when first opened (12% ≈ a traditional minimap; applied only when the resulting layout is a simple two-column split). |
| `notebookMinimap.maxColumn` | `80` | Maximum column width reflected in the minimap. Lower = thinner. |
| `notebookMinimap.renderCharacters` | `true` | Render one block per character (true) vs. a density bar per line (false). |
| `notebookMinimap.scale` | `1` | Scale multiplier for the base pixel size (0.5–3). |
| `notebookMinimap.fillPanelWidth` | `true` | If true, the minimap stretches to the column width; if false, fixed compact width. |
| `notebookMinimap.showCellBoundaries` | `true` | Draw separator lines between cells. |
| `notebookMinimap.followActiveCell` | `true` | Auto-scroll the minimap to keep the viewport indicator in view. |
| `notebookMinimap.includeOutputs` | `true` | Render executed cell outputs (text + images). |
| `notebookMinimap.renderMarkdownHeadings` | `true` | Emphasize Markdown headings with colored bars + inline labels. |
| `notebookMinimap.maxImageHeightRows` | `30` | Max vertical size (in minimap rows) for image outputs. |

## How the tracking works

The panel is a singleton — one per window. It tracks whichever notebook is currently active:

- Notebook switch → full resync of cells + viewport
- Cell content change → debounced (120 ms) delta flush
- Scroll → viewport-indicator move only (no canvas redraw)
- Cursor move → active-cell marker move only
- Close the tracked notebook → roll forward to another open notebook if any; otherwise show the "Open a notebook" placeholder
- Close the minimap tab → disposed; re-open via `notebookMinimap.toggle`

## Architecture

```
src/
  extension.ts         — activation, commands, event wiring, optional auto-open
  minimapPanel.ts      — MinimapPanelController: createWebviewPanel lifecycle,
                          cell + output extraction with image-header dimension
                          parsing (PNG / JPEG / GIF / WebP / SVG)
  types.ts             — typed message protocol (host ↔ webview)
media/
  main.js              — canvas renderer: per-line heights for Markdown headings,
                          async image cache, syntax-approximate character rendering
  main.css             — theme-aware styling via VS Code CSS variables
  minimap-icon.svg     — editor-tab icon
```

**Host → webview:**
- `onDidChangeActiveNotebookEditor` → full resync on notebook switch
- `onDidChangeNotebookDocument` → debounced delta flush
- `onDidChangeNotebookEditorVisibleRanges` → viewport indicator
- `onDidChangeNotebookEditorSelection` → active-cell marker
- `onDidChangeConfiguration` → push new config + re-render

**Webview → host:**
- Pointer click/drag → `revealRange` on the matching `NotebookEditor` (`AtTop` when clicking in the top third of a cell, otherwise `Default`).

## Pixel-accurate viewport (proposed VS Code API)

The stable VS Code notebook API exposes only cell-level `visibleRanges`, with no pixel-level `scrollTop` or `onDidScroll` event. Output-renderer iframes are sandboxed so no DOM side-channel is available either. See [microsoft/vscode#105625](https://github.com/microsoft/vscode/issues/105625) and [#71038](https://github.com/microsoft/vscode/issues/71038).

This repo ships a **VS Code source patch** under `vscode-patch/` that adds a proposed API (`notebookEditorScroll`) exposing `scrollTop` / `scrollHeight` / `viewportHeight` plus `window.onDidChangeNotebookEditorScroll`. See `vscode-patch/README.md` for the full file-by-file walkthrough and an upstreaming checklist.

When the extension detects that API at runtime (via `"enabledApiProposals": ["notebookEditorScroll"]` in this extension's manifest and a VS Code build with the patch applied), it routes pixel scroll state straight to the webview and draws the overlay at the exact fractional position of the real viewport — no extrapolation, no drift, no freezing inside tall cells.

## Fallback: velocity extrapolation

When the proposed API isn't present (stock VS Code), the overlay falls back to a cell-boundary-driven best effort:

- **Size clamp** — a rolling estimate of viewport height (sampled from frames where 2–8 cells are simultaneously visible) caps the overlay so it doesn't pretend to cover a whole tall cell.
- **Edge anchoring** — at each cell-boundary transition the overlay snaps to the real viewport edge: new cell at bottom → overlay bottom at `prevSpanBottom`; new cell at top → overlay top at `prevSpanTop`; etc.
- **Adaptive-duration extrapolation** — between transitions the overlay tweens in the scroll direction with monotonic ease-out, sized so the **total drift** after a stop is capped at `MAX_DRIFT_PX = 60`. Duration auto-scales to `2·drift/speed` (clamped `[120, 900] ms`) so slow scrolls still produce visible motion. During active scrolling, transitions fire more often than the window so the extrapolation is continuously re-anchored to truth.
- **Seed velocity** — a modest default velocity seeds the very first transition so a cold scroll straight into a giant cell still animates a little.
- **Auto-scroll** — the minimap scrolls itself to keep the overlay in view as it advances past the visible minimap area.

What it can't do without the patch: track pixel-accurate position inside a single tall cell during a *long* scroll with no cell-boundary transitions. That's the hard API-floor problem the patch fixes.
- Images are drawn at minimap resolution (usually ≤ 200 px wide); fine plot details pixelate.
- No real syntax tokenization; the character renderer uses cheap heuristics.
- Images larger than 6 MB are skipped (tunable via `MAX_IMAGE_BYTES` in `minimapPanel.ts`).
- The panel is a regular editor tab, so it participates in normal editor-group layout: opening lots of files may push it offscreen.

## License

MIT
