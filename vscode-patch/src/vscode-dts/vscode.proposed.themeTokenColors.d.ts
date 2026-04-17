/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

declare module 'vscode' {

	// https://github.com/microsoft/vscode/issues/32813
	//
	// Exposes the active color theme's resolved foreground colors for common
	// TextMate token categories (keyword, string, number, comment, function,
	// etc.). Extensions that render tokenized text outside the editor —
	// minimaps, outline previews, side panels, documentation viewers — can
	// match the editor's syntax highlighting without re-parsing or
	// re-implementing TextMate scope matching.

	/**
	 * A resolved set of foreground colors for common syntax categories,
	 * computed from the active color theme's `tokenColors` rules.
	 *
	 * Each value is a CSS color string (hex or rgb) matching the color the
	 * theme would apply to tokens of the category in the editor, or
	 * `undefined` if the theme has no rule for that category.
	 *
	 * Categories are resolved from the following representative TextMate
	 * scopes (most-specific first):
	 *
	 * | category  | scope |
	 * | --------- | ----- |
	 * | keyword   | `keyword.control`, falling back to `keyword` |
	 * | string    | `string` |
	 * | number    | `constant.numeric`, `constant` |
	 * | comment   | `comment` |
	 * | function  | `entity.name.function`, `support.function` |
	 * | type      | `entity.name.type`, `support.type`, `storage.type` |
	 * | variable  | `variable` |
	 * | operator  | `keyword.operator`, falling back to `keyword` |
	 * | constant  | `constant.language`, falling back to `constant` |
	 */
	export interface ThemeTokenColors {
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

	export interface ColorTheme {
		/**
		 * Theme-resolved foreground colors for common syntax categories.
		 * Updated when the active color theme changes — the same event
		 * ({@link window.onDidChangeActiveColorTheme}) that fires for the
		 * existing `kind` field also carries the refreshed values.
		 */
		readonly tokenColors: ThemeTokenColors;
	}
}
