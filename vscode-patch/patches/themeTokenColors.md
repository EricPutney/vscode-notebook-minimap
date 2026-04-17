# Proposed API: `themeTokenColors`

Exposes the active color theme's resolved foreground colors for common TextMate scope categories (keyword, string, number, comment, function, type, variable, operator, constant). Lets extensions that render tokenized text outside the editor match the editor's syntax highlighting without re-parsing theme files.

Supplementary to `documentTokenColors` (which is the authoritative path for per-document coloring). `themeTokenColors` is useful when an extension wants theme colors for UI decorations that aren't in a document — e.g. styling its own headers, legends, or synthetic labels.

## Public API shape

See [`../src/vscode-dts/vscode.proposed.themeTokenColors.d.ts`](../src/vscode-dts/vscode.proposed.themeTokenColors.d.ts). Surface:

- `ThemeTokenColors` — shape with optional hex strings per category
- `ColorTheme.tokenColors: ThemeTokenColors` — updated via the existing `window.onDidChangeActiveColorTheme` event

Scope-to-category mapping (main-thread resolver, probed most-specific first, falling back to more general):

| category  | TextMate scopes probed |
| --------- | ---------------------- |
| keyword   | `keyword.control`, `keyword` |
| string    | `string` |
| number    | `constant.numeric`, `constant` |
| comment   | `comment` |
| function  | `entity.name.function`, `support.function` |
| type      | `entity.name.type`, `support.type`, `storage.type` |
| variable  | `variable` |
| operator  | `keyword.operator`, `keyword` |
| constant  | `constant.language`, `constant` |

`default` is sourced from `editor.foreground`.

## Edits

### 1. `src/vs/workbench/api/common/extHost.protocol.ts`

Add the wire type and update `ExtHostThemingShape`:

```typescript
export interface IThemeTokenColors {
    readonly default?: string;
    readonly keyword?: string;
    readonly string?: string;
    readonly number?: string;
    readonly comment?: string;
    readonly function?: string;
    readonly type?: string;
    readonly variable?: string;
    readonly operator?: string;
    readonly constant?: string;
}

export interface ExtHostThemingShape {
    $onColorThemeChange(themeType: string, tokenColors: IThemeTokenColors): void;
}
```

### 2. `src/vs/workbench/api/browser/mainThreadTheming.ts`

Rewrite to resolve the scope probes via `ColorThemeData.resolveScopes` (the workbench implementation — `IColorTheme` from the platform only has read-only getters). Cast through `unknown` because `resolveScopes` isn't on the `IColorTheme` interface:

```typescript
import { editorForeground } from '../../../platform/theme/common/colorRegistry.js';
import type { ColorThemeData } from '../../services/themes/common/colorThemeData.js';

const TOKEN_COLOR_PROBES: readonly { readonly key: keyof IThemeTokenColors; readonly scope: readonly string[] }[] = [
    { key: 'keyword', scope: ['keyword.control', 'keyword'] },
    { key: 'string', scope: ['string'] },
    { key: 'number', scope: ['constant.numeric', 'constant'] },
    { key: 'comment', scope: ['comment'] },
    { key: 'function', scope: ['entity.name.function', 'support.function'] },
    { key: 'type', scope: ['entity.name.type', 'support.type', 'storage.type'] },
    { key: 'variable', scope: ['variable'] },
    { key: 'operator', scope: ['keyword.operator', 'keyword'] },
    { key: 'constant', scope: ['constant.language', 'constant'] },
];

function computeTokenColors(theme: IColorTheme): IThemeTokenColors {
    const out: Record<string, string | undefined> = {};
    out.default = theme.getColor(editorForeground)?.toString();
    const impl = theme as unknown as Partial<ColorThemeData>;
    if (typeof impl.resolveScopes === 'function') {
        for (const probe of TOKEN_COLOR_PROBES) {
            try {
                const style = impl.resolveScopes([[...probe.scope]]);
                const fg = style?.foreground?.toString();
                if (fg) out[probe.key] = fg;
            } catch {
                // theme mid-load or rejected probe — skip
            }
        }
    }
    return out as IThemeTokenColors;
}
```

Wire into the constructor / change listener so both the initial send and the change event carry `computeTokenColors(theme)` as the second argument to `$onColorThemeChange`.

### 3. `src/vs/workbench/api/common/extHostTheming.ts`

Accept the second argument and pass to the `ColorTheme` constructor:

```typescript
$onColorThemeChange(type: string, tokenColors: IThemeTokenColors): void {
    // ... existing kind mapping ...
    this._actual = new ColorTheme(kind, tokenColors ?? {});
    this._onDidChangeActiveColorTheme.fire(this._actual);
}
```

Initial construction (in constructor): `new ColorTheme(ColorThemeKind.Dark, {})`.

### 4. `src/vs/workbench/api/common/extHostTypes.ts`

Extend the `ColorTheme` class to hold the resolved colors:

```typescript
@es5ClassCompat
export class ColorTheme implements vscode.ColorTheme {
    constructor(
        public readonly kind: ColorThemeKind,
        public readonly tokenColors: Readonly<{
            default?: string; keyword?: string; string?: string; number?: string;
            comment?: string; function?: string; type?: string; variable?: string;
            operator?: string; constant?: string;
        }> = {},
    ) { }
}
```

## Firing model

The existing `onDidColorThemeChange` hook in `MainThreadTheming` now resolves `tokenColors` on every fire. The same `$onColorThemeChange` RPC carries both the theme kind and the token colors, so extensions listening to `window.onDidChangeActiveColorTheme` get both together.
