/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

declare module 'vscode' {

	// Per-panel override of the workbench's default editor minimum width
	// ({@link DEFAULT_EDITOR_MIN_DIMENSIONS.width}, currently 220 px). Lets
	// extensions that ship thin-column webview UIs — minimaps, outlines,
	// scrollbars, narrow review panels — opt their own panel below the
	// default without affecting any other editor in the workbench.
	//
	// See: github.com/microsoft/vscode/issues/<proposal-issue-TBD>

	export interface WebviewPanelOptions {
		/**
		 * Minimum width of the editor group that hosts this webview panel,
		 * in CSS pixels. When omitted, the workbench default applies.
		 *
		 * Lower this for webview panels whose content — minimaps, scrollbars,
		 * outlines, or other thin-column UI — is usable at widths below the
		 * default. Only affects this specific panel; other editors in the
		 * workbench keep their own minimums.
		 */
		readonly minimumWidth?: number;
	}
}
