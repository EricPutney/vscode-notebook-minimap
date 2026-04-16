# Patch 03: `INotebookEditor` — add `scrollHeight`

## File
`src/vs/workbench/contrib/notebook/browser/notebookBrowser.ts`

## Intent
The interface already exposes `scrollTop` / `scrollBottom` / `onDidScroll`. We need `scrollHeight` (total scrollable content height) so the main-thread bridge can forward a full `{scrollTop, scrollHeight, viewportHeight}` triple to the extension host. `viewportHeight` is derivable as `scrollBottom - scrollTop`, so no new field is needed for that.

## Add to `INotebookEditor`

Locate the block containing the existing scroll properties:

```ts
readonly onDidChangeVisibleRanges: Event<void>;
readonly onDidScroll: Event<void>;
readonly scrollTop: number;
readonly scrollBottom: number;
```

and add:

```ts
/**
 * Total scrollable content height of the notebook editor, in CSS pixels.
 * This is `this._list.getScrollHeight()` — the sum of all cell heights
 * including gutters, output areas, and insertion toolbars.
 */
readonly scrollHeight: number;
```
