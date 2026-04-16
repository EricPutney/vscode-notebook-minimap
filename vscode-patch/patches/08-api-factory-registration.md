# Patch 08: Register the event on `vscode.window`

## File
`src/vs/workbench/api/common/extHost.api.impl.ts`

## Intent
Expose the new ext-host emitter through the public `vscode.window.onDidChangeNotebookEditorScroll` API, gated on the `notebookEditorScroll` proposal.

## Location
Inside the `window` object literal returned from `apiFactory`, next to:

```ts
onDidChangeNotebookEditorVisibleRanges(listener, thisArgs?, disposables?) {
    return _asExtensionEvent(extHostNotebookEditors.onDidChangeNotebookEditorVisibleRanges)(listener, thisArgs, disposables);
},
```

## Add

```ts
onDidChangeNotebookEditorScroll: (listener, thisArgs?, disposables?) => {
    checkProposedApiEnabled(extension, 'notebookEditorScroll');
    return _asExtensionEvent(extHostNotebookEditors.onDidChangeNotebookEditorScroll)(listener, thisArgs, disposables);
},
```

`checkProposedApiEnabled` is already imported in this file; it throws at subscribe-time if the extension's `package.json` doesn't list `notebookEditorScroll` in `enabledApiProposals`. That means stable-API extensions silently ignore the field and don't get access to the event, while opted-in extensions (or anything running in Extension Development Host) pick it up transparently.

## Why a namespace getter rather than a const
The property appears in the `.d.ts` as `export const onDidChangeNotebookEditorScroll: Event<…>`. In the factory object it's a method because the factory generates one object per extension, and we need `extension` in scope for the `checkProposedApiEnabled` call. The shape as seen by the extension (`window.onDidChangeNotebookEditorScroll(listener)`) is identical either way.
