# VS Code core patch — notebook minimap API surface

Source-level changes to VS Code that back the `notebook-minimap` extension. Three proposed APIs and one non-proposed `WebviewPanelOptions` field. All are additive — no existing API or wire format changes behavior.

## What's here

```
vscode-patch/
├── README.md                              (this file)
├── src/vscode-dts/
│   ├── vscode.proposed.notebookEditorScroll.d.ts
│   ├── vscode.proposed.themeTokenColors.d.ts
│   └── vscode.proposed.documentTokenColors.d.ts
└── patches/
    ├── notebookEditorScroll.md
    ├── themeTokenColors.md
    ├── documentTokenColors.md
    └── webviewPanelMinimumWidth.md
```

The three `.d.ts` files are authoritative public-API declarations — drop them into `src/vscode-dts/` in a VS Code checkout and they're live. The four markdown walkthroughs describe the wire-protocol + main-thread + ext-host edits needed to support each surface.

## API summary

### `notebookEditorScroll` (proposed)

Fixes [microsoft/vscode#105625](https://github.com/microsoft/vscode/issues/105625) and [#71038](https://github.com/microsoft/vscode/issues/71038).

Pixel-level scroll state for notebook editors, where the built-in API only exposes cell-level `visibleRanges`:

- `NotebookEditor.scrollTop` / `scrollHeight` / `viewportHeight` (read-only)
- `NotebookEditor.setScrollTop(scrollTop)` (programmatic scroll)
- `window.onDidChangeNotebookEditorScroll`: fires on scroll, resize, zoom, content-height change
- Event carries `cellLayout?: readonly number[]` — authoritative real-pixel top offsets of every cell, length `cellCount + 1`. Ships only when changed; consumers cache the last non-`undefined` value.

→ [`patches/notebookEditorScroll.md`](patches/notebookEditorScroll.md)

### `themeTokenColors` (proposed)

Extends `vscode.ColorTheme` with a `tokenColors` record of theme-resolved foreground colors for common TextMate scope categories (keyword, string, number, comment, function, type, variable, operator, constant). Updates via the existing `window.onDidChangeActiveColorTheme` event.

Useful for UI decorations outside documents (synthetic labels, legends, headers) that want to match the active theme's syntax palette.

→ [`patches/themeTokenColors.md`](patches/themeTokenColors.md)

### `documentTokenColors` (proposed)

`vscode.languages.getDocumentTokens(document)` returns the editor's per-line tokenization of a document, with each token's foreground resolved against the active theme. Sourced from `TextModel.tokenization.getLineTokens()` + `TokenizationRegistry.getColorMap()` — the same pipeline that paints text in the editor, so colors match exactly.

Handles lazily-loaded cell models via `ITextModelService.createModelReference`, so every notebook cell is tokenizable regardless of whether it's currently bound to a cell editor.

→ [`patches/documentTokenColors.md`](patches/documentTokenColors.md)

### `WebviewPanelOptions.minimumWidth` (not proposed)

Per-panel override of the workbench's 220 px default editor minimum width. Lets individual webviews opt below the default for thin-column UIs (minimaps, outlines). Only affects panels that specify the option; all other editors keep their own minimums.

→ [`patches/webviewPanelMinimumWidth.md`](patches/webviewPanelMinimumWidth.md)

## How to apply

```bash
git clone https://github.com/microsoft/vscode.git
cd vscode
nvm use               # project pins Node 22 via .nvmrc
npm install

# drop in the proposed-API declarations
cp <this-repo>/vscode-patch/src/vscode-dts/*.d.ts src/vscode-dts/

# apply the four per-API walkthroughs
#   patches/notebookEditorScroll.md           (8 file edits)
#   patches/themeTokenColors.md               (4 file edits)
#   patches/documentTokenColors.md            (4 file edits)
#   patches/webviewPanelMinimumWidth.md       (6 file edits)

# regenerate the auto-generated proposal registry
npm run compile-api-proposal-names

# build
npm run watch

# once both watch-client and watch-extensions say "Finished", launch from source
./scripts/code.sh
```

F5 the `notebook-minimap` extension folder from the custom-built VS Code; EDH automatically grants proposed-API access for extensions loaded via dev-host.

For a packaged `.vsix` install, enable the proposals in `argv.json`:

```jsonc
{
  "enable-proposed-api": ["community.notebook-minimap"]
}
```

## Upstreaming notes

All three proposed APIs follow the existing `vscode.proposed.*.d.ts` + `$acceptEditorPropertiesChanged` / shape-interface conventions. Touches only notebook-editor, theming, and webview-editor plumbing — all additive. `checkProposedApiEnabled` gates every public surface.

`WebviewPanelOptions.minimumWidth` is currently added to stable `vscode.d.ts` for simplicity of local development. Before upstream submission, move the public-API field to a new `vscode.proposed.webviewPanelMinimumWidth.d.ts` and gate `reviveWebviewOptions` behind `checkProposedApiEnabled` at the ext-host layer; the internal `WebviewOptions` threading stays unchanged.

## Back-compat

All additions are optional:

- `NotebookEditorScrollChangeEvent.cellLayout?` — absence means no change since last send; old consumers ignore.
- `IWebviewPanelOptions.minimumWidth?` — absence falls through to the workbench default.
- `ColorTheme.tokenColors` — defaults to empty record; old consumers ignore.

Old ext hosts running against a new renderer (or vice versa) silently no-op on the new fields. No existing API or wire format changes behavior.
