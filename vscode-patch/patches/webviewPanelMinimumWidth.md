# Extension: `WebviewPanelOptions.minimumWidth`

Per-panel override of the 220 px workbench default editor minimum width. Lets extensions that ship thin webview UIs (minimaps, scrollbars, outlines, narrow side panels) opt their panel below the default — without affecting any other editor.

## Public API shape

New optional field on the existing `vscode.WebviewPanelOptions` interface:

```typescript
readonly minimumWidth?: number;  // CSS px; defaults to DEFAULT_EDITOR_MIN_DIMENSIONS.width (220)
```

Threaded through the same serialization path as `enableFindWidget` / `retainContextWhenHidden`. Persists with the webview across reloads (panel options survive via `webviewInput.webview.options`).

Note: this lives in `vscode.d.ts` as a direct field rather than a proposed-API augmentation because the threading through `WebviewOptions` (main-thread struct) is orthogonal to proposals. For upstream it should move to a `vscode.proposed.webviewPanelMinimumWidth.d.ts` and gate the public API on `checkProposedApiEnabled`; the internal plumbing can stay as-is.

## Edits

### 1. `src/vscode-dts/vscode.d.ts`

Add the field to `WebviewPanelOptions` alongside `retainContextWhenHidden`:

```typescript
/**
 * Minimum width of the editor group that hosts this webview panel, in
 * CSS pixels. When omitted, the workbench default applies (220 px).
 *
 * Lower for thin-column UIs (minimaps, outlines). Only affects this
 * specific panel — other editors keep their own minimums.
 */
readonly minimumWidth?: number;
```

### 2. `src/vs/workbench/api/common/extHost.protocol.ts`

Add to `IWebviewPanelOptions`:

```typescript
export interface IWebviewPanelOptions {
    readonly enableFindWidget?: boolean;
    readonly retainContextWhenHidden?: boolean;
    readonly minimumWidth?: number;
}
```

### 3. `src/vs/workbench/api/common/extHostWebviewPanels.ts`

Serialize in `serializeWebviewPanelOptions`:

```typescript
return {
    enableFindWidget: options.enableFindWidget,
    retainContextWhenHidden: options.retainContextWhenHidden,
    minimumWidth: options.minimumWidth,
};
```

### 4. `src/vs/workbench/contrib/webview/browser/webview.ts`

Add to `WebviewOptions` (main-thread struct):

```typescript
export interface WebviewOptions {
    // existing fields...
    readonly minimumWidth?: number;
    transformCssVariables?(styles: WebviewStyles): WebviewStyles;
}
```

### 5. `src/vs/workbench/api/browser/mainThreadWebviewPanels.ts`

Revive in `reviveWebviewOptions`:

```typescript
return {
    enableFindWidget: panelOptions.enableFindWidget,
    retainContextWhenHidden: panelOptions.retainContextWhenHidden,
    minimumWidth: panelOptions.minimumWidth,
};
```

### 6. `src/vs/workbench/contrib/webviewPanel/browser/webviewEditor.ts`

Override the inherited `EditorPane.minimumWidth` getter to prefer the panel's value when set:

```typescript
import { DEFAULT_EDITOR_MIN_DIMENSIONS } from '../../../browser/parts/editor/editor.js';

public override get minimumWidth(): number {
    const requested = (this.input instanceof WebviewInput)
        ? this.input.webview.options.minimumWidth
        : undefined;
    if (typeof requested === 'number' && isFinite(requested) && requested > 0) {
        return requested;
    }
    return DEFAULT_EDITOR_MIN_DIMENSIONS.width;
}
```

Only affects this pane; other editors keep their own minimums. When the webview isn't the active input on the pane (rare; typically `input` is a `WebviewInput` whenever this pane is showing), falls through to the default.

## Persistence

`mainThreadWebviewPanels.ts::$registerWebview` serializes `webviewInput.webview.options` back into the pane's backup state; on restore, `reviveWebviewOptions` reads `minimumWidth` from that blob. So the minimum width survives window reloads without any extra state.
