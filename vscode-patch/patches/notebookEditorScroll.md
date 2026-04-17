# Proposed API: `notebookEditorScroll`

Exposes the notebook editor's pixel-level vertical scroll state — `scrollTop`, `scrollHeight`, `viewportHeight` — plus an authoritative `cellLayout` array (the real top-pixel offset of every cell) and a `setScrollTop` method for programmatic scroll. Fires on scroll, on layout change (resize, zoom, output render, cell exec), and with an initial snapshot on editor add.

Targets [microsoft/vscode#105625](https://github.com/microsoft/vscode/issues/105625) and [#71038](https://github.com/microsoft/vscode/issues/71038).

## Public API shape

See [`../src/vscode-dts/vscode.proposed.notebookEditorScroll.d.ts`](../src/vscode-dts/vscode.proposed.notebookEditorScroll.d.ts) for the authoritative declaration. Surface:

- `NotebookEditor.scrollTop?: number`
- `NotebookEditor.scrollHeight?: number`
- `NotebookEditor.viewportHeight?: number`
- `NotebookEditor.setScrollTop(scrollTop: number): void`
- `NotebookEditorScrollChangeEvent` with the three numerics plus `cellLayout?: readonly number[]` (length `cellCount + 1`, last entry `== scrollHeight`)
- `window.onDidChangeNotebookEditorScroll: Event<NotebookEditorScrollChangeEvent>`

Consumers: cache `cellLayout` on first delivery and reuse when the field is `undefined` on subsequent events (main-thread omits it when unchanged since the last send).

## Edits

### 1. `src/vs/workbench/contrib/notebook/browser/notebookBrowser.ts`

Add `getScrollHeight()` to `INotebookEditor` alongside the existing `scrollTop` / `scrollBottom`:

```typescript
getScrollHeight(): number;
```

### 2. `src/vs/workbench/contrib/notebook/browser/notebookEditorWidget.ts`

Delegate to the existing `NotebookCellList`:

```typescript
getScrollHeight(): number { return this._list.getScrollHeight(); }
```

`setScrollTop(value: number): void { this._list.scrollTop = value; }` already exists on the widget; confirm it's also declared on `INotebookEditor`.

### 3. `src/vs/workbench/api/common/extHost.protocol.ts`

Add the wire types and extend the shapes:

```typescript
export interface INotebookEditorScrollStateData {
    readonly scrollTop: number;
    readonly scrollHeight: number;
    readonly viewportHeight: number;
    readonly cellLayout?: readonly number[];
}

export interface INotebookEditorPropertiesChangeData {
    // existing fields...
    scrollState?: INotebookEditorScrollStateData;
}

export interface MainThreadNotebookEditorsShape extends IDisposable {
    // existing methods...
    $trySetScrollTop(id: string, scrollTop: number): void;
}
```

### 4. `src/vs/workbench/api/browser/mainThreadNotebookEditors.ts`

Inside `handleEditorsAdded`, wire scroll + layout subscriptions with `cellLayout` diffing so pure-scroll events skip the O(N) recompute:

```typescript
let lastSentCellLayout: number[] | undefined;
let layoutDirty = true;
const cellLayoutChanged = (a: number[] | undefined, b: number[]): boolean => {
    if (!a || a.length !== b.length) return true;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return true;
    return false;
};
const computeCellLayout = (): number[] => {
    const out: number[] = [];
    const n = editor.getLength();
    for (let i = 0; i < n; i++) {
        const cell = editor.cellAt(i);
        out.push(cell ? editor.getAbsoluteTopOfElement(cell) : (out.length > 0 ? out[out.length - 1] : 0));
    }
    out.push(editor.getScrollHeight());
    return out;
};
const fireScrollState = () => {
    let cellLayout: number[] | undefined;
    if (layoutDirty) {
        const fresh = computeCellLayout();
        if (cellLayoutChanged(lastSentCellLayout, fresh)) {
            cellLayout = fresh;
            lastSentCellLayout = fresh;
        }
        layoutDirty = false;
    }
    this._proxy.$acceptEditorPropertiesChanged(editor.getId(), {
        scrollState: {
            scrollTop: editor.scrollTop,
            scrollHeight: editor.getScrollHeight(),
            viewportHeight: editor.scrollBottom - editor.scrollTop,
            cellLayout,
        }
    });
};
editorDisposables.add(editor.onDidScroll(fireScrollState));
editorDisposables.add(editor.onDidChangeLayout(() => {
    layoutDirty = true;
    fireScrollState();
}));
```

Add the `$trySetScrollTop` handler alongside `$tryRevealRange`:

```typescript
$trySetScrollTop(id: string, scrollTop: number): void {
    const editor = this._notebookEditorService.getNotebookEditor(id);
    if (!editor || !editor.hasModel()) { return; }
    editor.setScrollTop(scrollTop);
}
```

### 5. `src/vs/workbench/api/common/extHostNotebookEditor.ts`

Add the private field, the accept method, and expose getters + `setScrollTop` on `apiEditor`:

```typescript
private _scrollState: { scrollTop: number; scrollHeight: number; viewportHeight: number } | undefined;
```

```typescript
_acceptScrollState(value: { scrollTop: number; scrollHeight: number; viewportHeight: number }): void {
    this._scrollState = value;
}
```

Inside the `apiEditor` getter's object literal:

```typescript
get scrollTop() { return that._scrollState?.scrollTop; },
get scrollHeight() { return that._scrollState?.scrollHeight; },
get viewportHeight() { return that._scrollState?.viewportHeight; },
setScrollTop(scrollTop: number) {
    return that._proxy.$trySetScrollTop(that.id, scrollTop);
},
```

Note: assign the object literal to a local `editor` const first (`const editor: vscode.NotebookEditor = { ... }`), then `this._editor = editor` and `return this._editor!`. TypeScript can't prove `this._editor` becomes defined through the object-literal branch otherwise.

### 6. `src/vs/workbench/api/common/extHostNotebookEditors.ts`

Add the emitter, forward `cellLayout` in the public event:

```typescript
private readonly _onDidChangeNotebookEditorScroll = new Emitter<vscode.NotebookEditorScrollChangeEvent>();
readonly onDidChangeNotebookEditorScroll = this._onDidChangeNotebookEditorScroll.event;
```

In `$acceptEditorPropertiesChanged`:

```typescript
if (data.scrollState) {
    editor._acceptScrollState(data.scrollState);
}
// ... other state updates, then events ...
if (data.scrollState) {
    this._onDidChangeNotebookEditorScroll.fire(Object.freeze({
        notebookEditor: editor.apiEditor,
        scrollTop: data.scrollState.scrollTop,
        scrollHeight: data.scrollState.scrollHeight,
        viewportHeight: data.scrollState.viewportHeight,
        cellLayout: data.scrollState.cellLayout,
    }));
}
```

### 7. `src/vs/workbench/api/common/extHostNotebook.ts`

`ExtHostNotebookEditor` now takes one extra constructor argument (`_scrollState`). At the construction site, pass `undefined`:

```typescript
const editor = new ExtHostNotebookEditor(
    editorId,
    this._notebookEditorsProxy,
    document,
    data.visibleRanges.map(typeConverters.NotebookRange.to),
    data.selections.map(typeConverters.NotebookRange.to),
    typeof data.viewColumn === 'number' ? typeConverters.ViewColumn.to(data.viewColumn) : undefined,
    undefined, // scrollState — populated via $acceptEditorPropertiesChanged
    data.viewType
);
```

### 8. `src/vs/workbench/api/common/extHost.api.impl.ts`

Register on `window` next to `onDidChangeNotebookEditorVisibleRanges`:

```typescript
onDidChangeNotebookEditorScroll(listener, thisArgs?, disposables?) {
    checkProposedApiEnabled(extension, 'notebookEditorScroll');
    return _asExtensionEvent(extHostNotebookEditors.onDidChangeNotebookEditorScroll)(listener, thisArgs, disposables);
},
```

## v0.1.2 refactor

The main-thread bridge (patch 4) was restructured: `cellLayout` is only recomputed on `onDidChangeLayout`, not on every `onDidScroll`. Pure scrolling is now constant-time per event (3 property reads + one small RPC) instead of O(N). `cellLayoutChanged` still gates whether the array is sent — layout changes that produce an unchanged array don't re-ship.
