# Patch 05: Main-thread → ext-host scroll bridge

## File
`src/vs/workbench/api/browser/mainThreadNotebookEditors.ts`

## Intent
Subscribe to the editor's `onDidScroll` and `onDidChangeLayout` events and forward the pixel scroll state through the existing `$acceptEditorPropertiesChanged` RPC. Throttle to `scheduleAtNextAnimationFrame` so a 120 Hz mouse-wheel burst becomes at most one RPC per frame.

## Context
Inside `handleEditorsAdded(editors)` you'll see existing subscriptions:

```ts
editorDisposables.add(editor.onDidChangeVisibleRanges(() => {
    this._proxy.$acceptEditorPropertiesChanged(editor.getId(), {
        visibleRanges: { ranges: editor.visibleRanges }
    });
}));

editorDisposables.add(editor.onDidChangeSelection(() => {
    this._proxy.$acceptEditorPropertiesChanged(editor.getId(), {
        selections: { selections: editor.getSelections() }
    });
}));
```

## Add alongside these

```ts
// Pixel scroll state (see proposed API `notebookEditorScroll`).
// Coalesce bursts within a single animation frame — onDidScroll fires at
// display refresh rate during active wheel scrolling, which would drown
// the ext-host RPC channel if sent unthrottled.
let scrollFrame: IDisposable | undefined;
const scheduleScrollSend = () => {
    if (scrollFrame) { return; }
    scrollFrame = scheduleAtNextAnimationFrame(getWindow(editor.getDomNode()), () => {
        scrollFrame = undefined;
        this._proxy.$acceptEditorPropertiesChanged(editor.getId(), {
            scrollState: {
                scrollTop: editor.scrollTop,
                scrollHeight: editor.scrollHeight,
                viewportHeight: editor.scrollBottom - editor.scrollTop,
            }
        });
    });
};
editorDisposables.add(toDisposable(() => { scrollFrame?.dispose(); scrollFrame = undefined; }));
editorDisposables.add(editor.onDidScroll(() => scheduleScrollSend()));
editorDisposables.add(editor.onDidChangeLayout(() => scheduleScrollSend()));
```

## Imports to add (top of file)

```ts
import { scheduleAtNextAnimationFrame } from '../../../../base/browser/dom.js';
import { getWindow } from '../../../../base/browser/dom.js';
import { toDisposable, IDisposable } from '../../../../base/common/lifecycle.js';
```

(Use existing identical imports if the file already pulls them in — most of these are standard in this file already; add only what's missing.)

## Fire initial state on editor add

Once the editor is registered, emit a snapshot so the ext host has non-undefined values before the first user scroll:

```ts
// inside handleEditorsAdded, after the subscriptions above
scheduleScrollSend();
```

## Why onDidChangeLayout as well
`onDidScroll` fires only when `scrollTop` changes. When a cell output renders and bumps total content height, `scrollHeight` changes but `scrollTop` does not — `onDidChangeLayout` is what fires in that path. Extensions computing a scroll ratio (`scrollTop / (scrollHeight - viewportHeight)`) must be notified of both for correctness.
