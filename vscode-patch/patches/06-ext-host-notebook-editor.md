# Patch 06: `ExtHostNotebookEditor` — accept + expose scroll state

## File
`src/vs/workbench/api/common/extHostNotebookEditor.ts`

## Intent
Store incoming scroll state from the main thread and surface it via the public `NotebookEditor` API object.

## 1. Add private state

Alongside `_visibleRanges`, `_selections`, `_viewColumn`:

```ts
private _scrollState: { scrollTop: number; scrollHeight: number; viewportHeight: number } | undefined;
```

## 2. Add accept method

Alongside `_acceptVisibleRanges` / `_acceptSelections`:

```ts
_acceptScrollState(state: { scrollTop: number; scrollHeight: number; viewportHeight: number }): void {
    this._scrollState = state;
}
```

## 3. Extend `apiEditor`

In the `apiEditor` getter (the object returned to extensions), add the three read-only getters alongside `visibleRanges`:

```ts
get scrollTop() { return that._scrollState?.scrollTop; },
get scrollHeight() { return that._scrollState?.scrollHeight; },
get viewportHeight() { return that._scrollState?.viewportHeight; },
```

(The `that` / capture name depends on this file's existing convention — match it to the surrounding code.)

## Notes
- Deliberately `undefined` before first layout so extensions can distinguish "not yet reported" from "genuinely 0".
- No setter: the public property is read-only. Scroll changes go through `revealRange` (already stable API) and come back via the new event.
