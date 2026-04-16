# Patch 02: Wire protocol for editor properties

## File
`src/vs/workbench/api/common/extHost.protocol.ts`

## Intent
Add a `scrollState` sub-field to the editor-properties-change wire type so the main thread can ship pixel scroll updates down the same RPC channel that already carries `visibleRanges` / `selections`.

## Add to the protocol

### New type (near other `INotebookEditor*Data` declarations)

```ts
export interface INotebookEditorScrollStateData {
    readonly scrollTop: number;
    readonly scrollHeight: number;
    readonly viewportHeight: number;
}
```

### Extend `INotebookEditorPropertiesChangeData`

Locate the existing declaration (its other fields are `visibleRanges`, `selections`, `viewColumn`, …) and add:

```ts
export interface INotebookEditorPropertiesChangeData {
    visibleRanges?: INotebookEditorVisibleRangesData;
    selections?: INotebookEditorSelectionsData;
    viewColumn?: INotebookEditorViewColumnInfo;

    // ↓↓↓ ADD ↓↓↓
    /**
     * Pixel-level scroll state. Populated when the notebook editor emits
     * onDidScroll / onDidChangeLayout. See proposed API
     * `notebookEditorScroll`.
     */
    scrollState?: INotebookEditorScrollStateData;
    // ↑↑↑ ADD ↑↑↑
}
```

## Why this shape
Reusing the existing batched `$acceptEditorPropertiesChanged` RPC means:
- No new main-thread → ext-host RPC method is required.
- Coalescing already happens on the ext-host side (same apply-then-fire pattern used for visible ranges).
- Back-compat: older renderers that don't emit `scrollState` are unaffected — the field is optional.
