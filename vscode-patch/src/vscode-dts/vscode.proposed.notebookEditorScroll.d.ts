/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

declare module 'vscode' {

	// API proposal: github.com/microsoft/vscode/issues/<proposal-issue-TBD>
	// Motivating feature requests:
	//   - https://github.com/microsoft/vscode/issues/105625
	//   - https://github.com/microsoft/vscode/issues/71038
	//
	// Exposes the pixel-level vertical scroll state of a notebook editor so
	// that extensions can build sub-cell aware UIs (minimaps, progress
	// indicators, outline peek, review annotations, etc.).
	//
	// The existing stable API surface for notebook viewport only exposes
	// cell-granular `visibleRanges`, which is insufficient for a notebook
	// with tall cells (e.g. a code cell followed by dozens of matplotlib
	// figures): between cell-boundary transitions no signal is emitted,
	// even though the editor is actively scrolling pixel-by-pixel.

	export interface NotebookEditor {
		/**
		 * The vertical scroll offset of the notebook editor in CSS pixels,
		 * measured from the top of the first cell.
		 *
		 * `0` when the editor is scrolled all the way to the top. The value
		 * is live: it updates as the user scrolls and is the same coordinate
		 * system used by `scrollHeight` and `viewportHeight` below.
		 *
		 * Undefined if the editor has never been laid out (e.g. has only
		 * just been opened and its webview hasn't reported a first paint).
		 */
		readonly scrollTop?: number;

		/**
		 * The total scrollable content height of the notebook editor in
		 * CSS pixels. This is the height of all cells stacked end-to-end,
		 * including cell editors, outputs, insertion toolbars, and gutters.
		 *
		 * `scrollTop + viewportHeight <= scrollHeight` at all times.
		 *
		 * Undefined if the editor has never been laid out.
		 */
		readonly scrollHeight?: number;

		/**
		 * The height of the editor's visible viewport in CSS pixels. This
		 * is what fits on screen at the current window size and matches
		 * `editor.scrollBottom - editor.scrollTop` at the widget layer.
		 *
		 * Undefined if the editor has never been laid out.
		 */
		readonly viewportHeight?: number;

		/**
		 * Scroll the notebook editor to the given vertical offset in CSS
		 * pixels, measured from the top of the first cell. The value is
		 * clamped to `[0, scrollHeight - viewportHeight]`.
		 */
		setScrollTop(scrollTop: number): void;
	}

	/**
	 * An event describing a change to the pixel scroll state of a
	 * {@link NotebookEditor}. This fires for:
	 *  - user-initiated scroll (wheel, touch, keyboard, drag, programmatic `revealRange`),
	 *  - viewport resize (editor split resized, window resized),
	 *  - content-height changes (output rendered, cell executed, cells added/removed).
	 *
	 * The event is noisy — it can fire at the display refresh rate during
	 * active scrolling. Consumers that perform layout or DOM work should
	 * throttle (rAF-debounce) before reacting.
	 */
	export interface NotebookEditorScrollChangeEvent {
		/**
		 * The {@link NotebookEditor} whose scroll state changed.
		 */
		readonly notebookEditor: NotebookEditor;

		/**
		 * The new vertical scroll offset, in CSS pixels.
		 */
		readonly scrollTop: number;

		/**
		 * The new total scrollable content height, in CSS pixels.
		 */
		readonly scrollHeight: number;

		/**
		 * The new visible viewport height, in CSS pixels.
		 */
		readonly viewportHeight: number;

		/**
		 * The absolute pixel offset of each cell's top edge, in cell-index
		 * order. Length is `cellCount + 1` — the final entry is the bottom
		 * edge of the last cell (equal to `scrollHeight`).
		 *
		 * Present only when cell layout has changed since the last event
		 * (typically on zoom, resize, output render, or cell exec). When
		 * `undefined`, the previous value remains authoritative — consumers
		 * should cache and reuse it. This lets extensions build an exact
		 * real→display pixel mapping that accounts for the varying real
		 * pixel rates of code vs. output regions.
		 */
		readonly cellLayout: readonly number[] | undefined;
	}

	export namespace window {
		/**
		 * An {@link Event} which fires when the pixel scroll state of a
		 * {@link NotebookEditor} changes — i.e. on scroll, viewport resize,
		 * or content-height change. This is the fine-grained counterpart
		 * to {@link onDidChangeNotebookEditorVisibleRanges}, which only
		 * fires when a cell crosses the viewport boundary.
		 */
		export const onDidChangeNotebookEditorScroll: Event<NotebookEditorScrollChangeEvent>;
	}
}
