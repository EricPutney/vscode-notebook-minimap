# Proposed API: `documentTokenColors`

Exposes the editor's tokenized representation of a text document, line by line, with theme-resolved foreground colors per token. Sources directly from `TextModel.tokenization` — the same pipeline the editor uses to paint text — so colors match exactly.

Essential for minimaps, outline previews, documentation renderers, or any extension that paints tokenized text outside the editor and wants fidelity with the real syntax highlighting.

## Public API shape

See [`../src/vscode-dts/vscode.proposed.documentTokenColors.d.ts`](../src/vscode-dts/vscode.proposed.documentTokenColors.d.ts). Surface:

- `DocumentLineToken { startCharacter, endCharacter, foreground? }`
- `languages.getDocumentTokens(document): Thenable<readonly (readonly DocumentLineToken[])[]>`

Output shape: `result[lineNumber]` is an ordered array of tokens on that line. Line numbers are zero-based to match `TextDocument.lineAt` semantics. Foreground is a CSS hex string or `undefined` when the theme falls through to `editor.foreground`.

## Edits

### 1. `src/vs/workbench/api/common/extHost.protocol.ts`

Add the wire type and the RPC on `MainThreadLanguagesShape`:

```typescript
export interface IDocumentLineTokenDto {
    readonly startCharacter: number;
    readonly endCharacter: number;
    readonly foreground?: string;
}

export interface MainThreadLanguagesShape extends IDisposable {
    // existing methods...
    $getDocumentTokens(resource: UriComponents): Promise<readonly (readonly IDocumentLineTokenDto[])[] | undefined>;
}
```

### 2. `src/vs/workbench/api/browser/mainThreadLanguages.ts`

Implement by iterating the model's per-line tokens. Force-load the model via `ITextModelService.createModelReference` if it isn't already in `IModelService` — crucial for notebook cells that load lazily:

```typescript
import { TokenizationRegistry } from '../../../editor/common/languages.js';
import { Color } from '../../../base/common/color.js';
import { Disposable, DisposableMap, IDisposable } from '../../../base/common/lifecycle.js';

async $getDocumentTokens(resource: UriComponents): Promise<readonly (readonly IDocumentLineTokenDto[])[] | undefined> {
    const uri = URI.revive(resource);
    let model = this._modelService.getModel(uri);
    let ref: IDisposable | undefined;
    if (!model) {
        try {
            const modelRef = await this._resolverService.createModelReference(uri);
            ref = modelRef;
            model = modelRef.object.textEditorModel;
        } catch {
            return undefined;
        }
    }
    try {
        const colorMap = TokenizationRegistry.getColorMap();
        const lineCount = model.getLineCount();
        const result: IDocumentLineTokenDto[][] = new Array(lineCount);
        for (let line = 1; line <= lineCount; line++) {
            model.tokenization.forceTokenization(line);
            const lineTokens = model.tokenization.getLineTokens(line);
            const count = lineTokens.getCount();
            const tokens: IDocumentLineTokenDto[] = new Array(count);
            for (let i = 0; i < count; i++) {
                const colorId = lineTokens.getForeground(i);
                const color = colorMap && colorId > 0 ? colorMap[colorId] : undefined;
                tokens[i] = {
                    startCharacter: lineTokens.getStartOffset(i),
                    endCharacter: lineTokens.getEndOffset(i),
                    foreground: color ? Color.Format.CSS.formatHex(color) : undefined,
                };
            }
            result[line - 1] = tokens;
        }
        return result;
    } finally {
        ref?.dispose();
    }
}
```

### 3. `src/vs/workbench/api/common/extHostLanguages.ts`

Wrap the RPC with a public ext-host method:

```typescript
async getDocumentTokens(document: vscode.TextDocument): Promise<readonly (readonly { readonly startCharacter: number; readonly endCharacter: number; readonly foreground?: string }[])[]> {
    const result = await this._proxy.$getDocumentTokens(document.uri);
    return result ?? [];
}
```

### 4. `src/vs/workbench/api/common/extHost.api.impl.ts`

Register on `languages`, gated by proposal check:

```typescript
getDocumentTokens(doc: vscode.TextDocument) {
    checkProposedApiEnabled(extension, 'documentTokenColors');
    return extHostLanguages.getDocumentTokens(doc);
},
```

## Performance notes

- `forceTokenization` blocks the main thread until a line is tokenized. TextMate grammars typically tokenize at ~50k lines/sec; a 1000-line document ≈ 20 ms. Tolerable but callers should avoid hot-loop invocations.
- `createModelReference` keeps the model alive for the duration of the call only — disposed in `finally`. No memory leak.
- Tokens can shift across edits. Callers should re-fetch on `TextDocument.version` change (or subscribe to cell / document change events and refetch just the affected document).
- Result size is O(total tokens). For most notebook cells this is a few hundred tokens; ship it as-is without compression.
