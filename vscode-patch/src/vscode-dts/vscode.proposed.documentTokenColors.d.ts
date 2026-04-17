/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

declare module 'vscode' {

	// API proposal: github.com/microsoft/vscode/issues/<proposal-issue-TBD>
	//
	// Exposes the editor's tokenized representation of a text document with
	// theme-resolved foreground colors for each token. Lets extensions that
	// render text outside the editor — minimaps, previews, documentation
	// viewers, outline renderers — paint exactly what the editor paints,
	// without reinventing TextMate scope matching or hard-coding per-language
	// keyword lists.

	/**
	 * A single lexical token within one line of a document, paired with the
	 * foreground color the active color theme would apply to it. Offsets
	 * are zero-based character indexes within the line (matching
	 * {@link TextDocument.lineAt} column semantics).
	 */
	export interface DocumentLineToken {
		readonly startCharacter: number;
		readonly endCharacter: number;
		/** CSS color string (hex or rgb). `undefined` when the theme falls
		 *  through to `editor.foreground`. */
		readonly foreground: string | undefined;
		/**
		 * Font-style string as supplied by the theme's tokenColors rule —
		 * space-separated combination of `italic`, `bold`, `underline`,
		 * `strikethrough`. `undefined` when the theme applies no style.
		 * Reserved for future population; renderers may ignore it today.
		 */
		readonly fontStyle?: string;
	}

	export namespace languages {
		/**
		 * Return the editor's tokenization of the given document, line by
		 * line, with each token's theme-resolved foreground color attached.
		 *
		 * The result is sourced from the same tokenization pipeline the
		 * editor uses to paint text (TextMate grammar + active color
		 * theme), so foreground colors match the editor's syntax
		 * highlighting exactly.
		 *
		 * Output shape: `result[lineNumber]` is the ordered list of tokens
		 * for that line. Line numbers are zero-based.
		 *
		 * The call forces tokenization of every line; for very large
		 * documents it may take hundreds of milliseconds. Prefer invoking
		 * it after large edits settle, cache the result per document
		 * version, and pass a {@link CancellationToken} so callers can
		 * abort stale requests.
		 */
		export function getDocumentTokens(document: TextDocument, token?: CancellationToken): Thenable<readonly (readonly DocumentLineToken[])[]>;
	}
}
