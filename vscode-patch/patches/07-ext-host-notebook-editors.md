# Patch 07: `ExtHostNotebookEditors` — emit the public event

## File
`src/vs/workbench/api/common/extHostNotebookEditors.ts`

## Intent
When the main thread ships a `scrollState` field in `$acceptEditorPropertiesChanged`, apply it to the corresponding `ExtHostNotebookEditor` and fan out a `vscode.NotebookEditorScrollChangeEvent` to the public API.

## 1. Add emitter

Alongside the existing `_onDidChangeNotebookEditorVisibleRanges`:

```ts
private readonly _onDidChangeNotebookEditorScroll =
    new Emitter<vscode.NotebookEditorScrollChangeEvent>();

readonly onDidChangeNotebookEditorScroll =
    this._onDidChangeNotebookEditorScroll.event;
```

Remember to dispose in the class's disposable store.

## 2. Extend `$acceptEditorPropertiesChanged`

Inside the existing method body you'll find the block that handles `data.visibleRanges`:

```ts
if (data.visibleRanges) {
    editor._acceptVisibleRanges(data.visibleRanges.ranges);
    this._onDidChangeNotebookEditorVisibleRanges.fire({
        notebookEditor: editor.apiEditor,
        visibleRanges: editor.apiEditor.visibleRanges,
    });
}
```

Add a symmetrical block:

```ts
if (data.scrollState) {
    editor._acceptScrollState(data.scrollState);
    this._onDidChangeNotebookEditorScroll.fire({
        notebookEditor: editor.apiEditor,
        scrollTop: data.scrollState.scrollTop,
        scrollHeight: data.scrollState.scrollHeight,
        viewportHeight: data.scrollState.viewportHeight,
    });
}
```

## Why apply-then-fire
Same pattern as `visibleRanges`: state mutations land on the editor object before the event fires, so listeners observing `editor.scrollTop` from inside the event handler see the new value.
