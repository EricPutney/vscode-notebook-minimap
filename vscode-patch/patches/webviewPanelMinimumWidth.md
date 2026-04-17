# Proposed API: `webviewPanelMinimumWidth`

Per-panel override of the workbench's 220 px default editor minimum width. Lets extensions that ship thin webview UIs (minimaps, scrollbars, outlines, narrow side panels) opt their own panel below the default — without affecting any other editor in the workbench.

## Public API shape

See [`../src/vscode-dts/vscode.proposed.webviewPanelMinimumWidth.d.ts`](../src/vscode-dts/vscode.proposed.webviewPanelMinimumWidth.d.ts). The proposal augments the existing stable `WebviewPanelOptions` with:

```typescript
readonly minimumWidth?: number;
```

An opted-out extension that sets the field gets a throw at `createWebviewPanel` time via `checkProposedApiEnabled`; opted-in extensions see the field typed.

## Edits

### 1. `src/vscode-dts/vscode.proposed.webviewPanelMinimumWidth.d.ts`

New proposed-API file. `declare module 'vscode'` augments `WebviewPanelOptions` with the optional field. No changes to stable `vscode.d.ts`.

### 2. `src/vs/workbench/api/common/extHost.protocol.ts`

Add to `IWebviewPanelOptions` (internal wire type; not gated):

```typescript
export interface IWebviewPanelOptions {
    readonly enableFindWidget?: boolean;
    readonly retainContextWhenHidden?: boolean;
    readonly minimumWidth?: number;
}
```

### 3. `src/vs/workbench/api/common/extHostWebviewPanels.ts`

Gate the field's use at serialization time. `serializeWebviewPanelOptions` now takes the extension description and throws on opted-out extensions that set `minimumWidth`:

```typescript
function serializeWebviewPanelOptions(extension: IExtensionDescription, options: vscode.WebviewPanelOptions): extHostProtocol.IWebviewPanelOptions {
    if ((options as { minimumWidth?: number }).minimumWidth !== undefined) {
        checkProposedApiEnabled(extension, 'webviewPanelMinimumWidth');
    }
    return {
        enableFindWidget: options.enableFindWidget,
        retainContextWhenHidden: options.retainContextWhenHidden,
        minimumWidth: (options as { minimumWidth?: number }).minimumWidth,
    };
}
```

Call site in `createWebviewPanel` becomes `serializeWebviewPanelOptions(extension, options)`.

Add the import:

```typescript
import { checkProposedApiEnabled } from '../../services/extensions/common/extensions.js';
```

The cast-via-`{ minimumWidth?: number }` is required because the proposed augmentation only surfaces when the extension opts in — inside main-thread code we operate on the raw options shape.

### 4. `src/vs/workbench/contrib/webview/browser/webview.ts`

Add to `WebviewOptions` (main-thread struct — not API-gated, internal type):

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

## Extension opt-in

Consumers add `webviewPanelMinimumWidth` to their `package.json`:

```jsonc
{
  "enabledApiProposals": [
    "webviewPanelMinimumWidth"
  ]
}
```

Without this, setting `minimumWidth` throws at panel creation.
