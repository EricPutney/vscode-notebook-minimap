# Patch 04: `NotebookEditorWidget` — expose `scrollHeight`

## File
`src/vs/workbench/contrib/notebook/browser/notebookEditorWidget.ts`

## Intent
Implement the `scrollHeight` getter declared in patch 03, delegating to the already-existing `NotebookCellList.getScrollHeight()`. This mirrors the existing `scrollTop` / `scrollBottom` delegations.

## Find the existing getters

Around the `scrollTop` / `scrollBottom` accessors you'll see something like:

```ts
get scrollTop() { return this._list.scrollTop; }

get scrollBottom() { return this._list.scrollTop + this._list.getRenderHeight(); }
```

## Add immediately after

```ts
get scrollHeight() { return this._list.getScrollHeight(); }
```

## Nothing else to change here
`onDidScroll` is already plumbed from `this._list.onDidScroll`. Layout-change events (when content size changes without scrollTop changing) fire via `this._onDidChangeLayout` — the main-thread bridge (patch 05) listens to both so content-height changes also produce scroll-state updates.
