# VS Code patch: `notebookEditorScroll` proposed API

Adds a proposed extension API surface that exposes the notebook editor's pixel-level vertical scroll state and a corresponding change event. Targets the feature requests in [microsoft/vscode#105625](https://github.com/microsoft/vscode/issues/105625) and [#71038](https://github.com/microsoft/vscode/issues/71038).

## What it exposes

```ts
interface NotebookEditor {
  readonly scrollTop?: number;        // CSS px, from top of first cell
  readonly scrollHeight?: number;     // CSS px, total scrollable content
  readonly viewportHeight?: number;   // CSS px, visible area
}

interface NotebookEditorScrollChangeEvent {
  readonly notebookEditor: NotebookEditor;
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly viewportHeight: number;
}

namespace window {
  export const onDidChangeNotebookEditorScroll: Event<NotebookEditorScrollChangeEvent>;
}
```

## Why

`NotebookEditor.visibleRanges` is cell-indexed. It fires only when a cell crosses the viewport boundary, so any extension that wants to track scrolling *inside* a single tall cell (notebook minimaps, read-progress indicators, scroll-linked output annotations, review-comment overlays, outline peek, etc.) is blind between those transitions.

The data already exists internally — `NotebookCellList` tracks `getViewScrollTop` / `getScrollHeight` / `getRenderHeight`, and `NotebookEditorWidget` already surfaces `scrollTop` / `scrollBottom` / `onDidScroll` to main-thread callers. This patch is purely additive plumbing to get those values across the ext-host RPC boundary.

## File map

```
src/vscode-dts/
  vscode.proposed.notebookEditorScroll.d.ts        ← NEW: public proposal file

patches/
  01-api-proposal-registration.md                  ← auto-regen of extensionsApiProposals.ts
  02-ext-host-protocol.md                          ← wire type: scrollState in IProps change
  03-notebook-editor-interface.md                  ← INotebookEditor.scrollHeight
  04-notebook-editor-widget.md                     ← widget getter, delegates to _list
  05-main-thread-bridge.md                         ← subscribe onDidScroll/onDidChangeLayout
  06-ext-host-notebook-editor.md                   ← accept + expose on apiEditor
  07-ext-host-notebook-editors.md                  ← emit public Event
  08-api-factory-registration.md                   ← window.onDidChangeNotebookEditorScroll
```

## How to apply

### 1. Clone VS Code

```bash
git clone https://github.com/microsoft/vscode.git
cd vscode
npm install
```

### 2. Drop in the proposed-API file

```bash
cp <path-to-this-patch>/src/vscode-dts/vscode.proposed.notebookEditorScroll.d.ts \
   ./src/vscode-dts/
```

### 3. Apply the source edits

Each file under `patches/` is a focused markdown note describing a single file's edits. They're small and localized — mirror existing neighboring code. Walk through them in numeric order.

### 4. Regenerate the proposal registry

```bash
npm run compile-api-proposal-names   # or: npm run watch — it's part of prepublish
```

This updates `src/vs/platform/extensions/common/extensionsApiProposals.ts` automatically.

### 5. Type-check the ext-host surface

```bash
npm run compile
```

If the `.d.ts` side of things is wired correctly the compiler will fail only on the files you actively edited.

### 6. Run VS Code from source

```bash
./scripts/code.sh
```

Press `F5` on the `notebook-minimap` extension folder to launch its Extension Development Host — the proposal is auto-enabled in dev-host mode.

## Runtime considerations

- `onDidChangeNotebookEditorScroll` is coalesced on the main thread to one RPC per animation frame (see patch 05). During a 5-second continuous wheel scroll that's ~300 events — reasonable for the ext-host channel. Consumers in the ext host should still throttle if they do expensive work (rAF-debouncing on their own webview is the usual pattern).
- `scrollHeight` updates independently of `scrollTop` when content height changes (cell executed, output rendered). Subscribing to `onDidChangeLayout` in the bridge captures this; the event fires with the new `scrollHeight` and unchanged `scrollTop`, which is what consumers want for ratio maths.
- Initial snapshot: the bridge fires once on editor-added so extensions don't have to wait for a scroll before they have values.

## Back-compat

All surface additions are optional (`scrollTop?`, `scrollHeight?`, `viewportHeight?`). The added `scrollState` field on the wire protocol is optional. Older ext hosts running against a new renderer simply ignore the field; older renderers running against a new ext host never populate it (the event just doesn't fire). No existing API or wire format changes behavior.

## Testing checklist before upstream PR

- [ ] `npm run compile` clean
- [ ] `npm run smoketest` clean
- [ ] A sample extension using the proposed API gets:
  - [ ] A scroll event on first render (initial snapshot from patch 05)
  - [ ] Continuous events during wheel scroll
  - [ ] Event with changed `scrollHeight` when a cell output renders
  - [ ] Values consistent with `editor.scrollTop + editor.viewportHeight ≤ editor.scrollHeight`
- [ ] Extension that does NOT enable `notebookEditorScroll` throws at subscribe-time (exercise the `checkProposedApiEnabled` path)
- [ ] Open the sample `notebookEditorScroll`-enabled extension in two notebook tabs — events route to the right editor
- [ ] No regression in `onDidChangeNotebookEditorVisibleRanges` timing (it still fires on cell-boundary transitions)

## Upstreaming

This patch sticks to the existing conventions in `extHost.protocol.ts` / `extHostNotebook*.ts` and touches nothing outside notebook-editor API plumbing, so it should be a reasonable PR candidate. Open against `microsoft/vscode` citing #105625 and #71038; proposal starts unflagged (opt-in via `enabledApiProposals`) per standard process and stabilizes after a few iterations of extension-author feedback.
