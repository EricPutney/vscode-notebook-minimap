import * as vscode from 'vscode';
import {
  CellData,
  ExtensionMessage,
  MinimapConfig,
  OutputItem,
  ThemeTokenColors,
  VisibleRangeTuple,
  WebviewMessage,
} from './types';

const FLUSH_DEBOUNCE_MS = 120;
const MAX_OUTPUT_TEXT_LINES = 20;
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const PANEL_VIEW_TYPE = 'notebookMinimap.panel';

const TEXT_STDOUT_MIMES = new Set([
  'application/vnd.code.notebook.stdout',
  'application/x.notebook.stdout',
]);
const TEXT_STDERR_MIMES = new Set([
  'application/vnd.code.notebook.stderr',
  'application/x.notebook.stderr',
  'application/vnd.code.notebook.error',
]);
const TEXT_PLAIN_MIMES = new Set(['text/plain', 'text/markdown']);
const IMAGE_BINARY_MIMES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp']);

export class MinimapPanelController {
  private _panel?: vscode.WebviewPanel;
  private _editor?: vscode.NotebookEditor;
  private _webviewReady = false;

  private _dirtyCells = new Set<number>();
  private _needsFullResync = false;
  private _flushTimer?: NodeJS.Timeout;
  private _tokenColors: ThemeTokenColors = {};

  constructor(private readonly _extensionUri: vscode.Uri) {}

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  public isOpen(): boolean {
    return this._panel !== undefined;
  }

  public open(preferredEditor?: vscode.NotebookEditor): void {
    // Snapshot the active notebook *before* creating the panel, since
    // createWebviewPanel can shift focus briefly.
    const remembered =
      this._editor && !this._editor.notebook.isClosed ? this._editor : undefined;
    const initial =
      preferredEditor ??
      vscode.window.activeNotebookEditor ??
      remembered ??
      vscode.window.visibleNotebookEditors?.[0] ??
      this._findEditorForAnyDocument();

    if (this._panel) {
      this._panel.reveal(vscode.ViewColumn.Beside, true);
      if (initial && this._editor?.notebook !== initial.notebook) {
        this._editor = initial;
        if (this._webviewReady) this._sendFullSync(initial);
      }
      return;
    }

    // Allow the editor column to go much narrower than the 220 px workbench
    // default — a minimap needs to be thin. `minimumWidth` is an addition
    // shipped in our VS Code patch; it's not yet in the published
    // @types/vscode, so cast around the stable type.
    const panelOptions = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, 'media')],
      retainContextWhenHidden: true,
      minimumWidth: 50,
    } as vscode.WebviewOptions & vscode.WebviewPanelOptions;
    this._panel = vscode.window.createWebviewPanel(
      PANEL_VIEW_TYPE,
      'Minimap',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      panelOptions
    );

    this._panel.webview.html = this._getHtml(this._panel.webview);
    this._panel.iconPath = vscode.Uri.joinPath(this._extensionUri, 'media', 'minimap-icon.svg');

    this._panel.webview.onDidReceiveMessage((msg: WebviewMessage) => {
      this._handleWebviewMessage(msg);
    });

    this._panel.onDidDispose(() => {
      this._panel = undefined;
      this._webviewReady = false;
      this._editor = undefined;
      this._dirtyCells.clear();
      this._needsFullResync = false;
      if (this._flushTimer) {
        clearTimeout(this._flushTimer);
        this._flushTimer = undefined;
      }
    });

    if (initial) {
      this._editor = initial;
    }

    // Give VS Code a tick to register the new tab group, then squeeze the
    // minimap column narrow if we ended up with a simple two-column split.
    setTimeout(() => this._applyNarrowLayout(), 50);
  }

  private _applyNarrowLayout(): void {
    const groups = vscode.window.tabGroups.all;
    if (groups.length !== 2) return;
    const cfg = vscode.workspace.getConfiguration('notebookMinimap');
    const raw = cfg.get<number>('defaultWidthFraction', 0.05);
    const frac = Math.min(0.5, Math.max(0.02, Number.isFinite(raw) ? raw : 0.05));
    void vscode.commands.executeCommand('vscode.setEditorLayout', {
      orientation: 0,
      groups: [{ size: 1 - frac }, { size: frac }],
    });
  }

  public close(): void {
    this._panel?.dispose();
  }

  public refresh(): void {
    if (!this._panel) return;
    if (!this._webviewReady) return;
    const ed = this._resolveEditor();
    if (ed) {
      this._editor = ed;
      this._sendFullSync(ed);
    } else {
      this._post({ type: 'clear' });
    }
  }

  // ── Event plumbing ─────────────────────────────────────────────────────────

  public setActiveEditor(editor: vscode.NotebookEditor | undefined): void {
    if (!editor) return; // sticky
    if (!this._panel) {
      // Panel not open — just remember for later
      this._editor = editor;
      return;
    }
    const changed = this._editor?.notebook !== editor.notebook;
    this._editor = editor;
    if (!this._webviewReady) return;
    if (changed) {
      this._dirtyCells.clear();
      this._needsFullResync = false;
      this._sendFullSync(editor);
    } else {
      this._sendViewport(editor);
      this._sendActiveCell(editor);
    }
  }

  public onVisibleRanges(e: vscode.NotebookEditorVisibleRangesChangeEvent): void {
    if (!this._panel || !this._webviewReady || !this._editor) return;
    if (e.notebookEditor.notebook !== this._editor.notebook) return;
    this._sendViewport(e.notebookEditor);
  }

  public onSelection(e: vscode.NotebookEditorSelectionChangeEvent): void {
    if (!this._panel || !this._webviewReady || !this._editor) return;
    if (e.notebookEditor.notebook !== this._editor.notebook) return;
    this._sendActiveCell(e.notebookEditor);
  }

  /**
   * Receives pixel-level scroll updates from the proposed
   * `notebookEditorScroll` API. When available this gives the webview a
   * ground-truth scroll ratio and removes the need for velocity
   * extrapolation in tall cells. Silently ignored when the proposed API
   * isn't present at runtime.
   */
  public onThemeChange(tokenColors: ThemeTokenColors): void {
    this._tokenColors = tokenColors;
    if (!this._panel || !this._webviewReady) return;
    this._post({ type: 'setTokenColors', tokenColors });
  }

  public onScrollState(e: {
    notebookEditor: vscode.NotebookEditor;
    scrollTop: number;
    scrollHeight: number;
    viewportHeight: number;
    cellLayout?: readonly number[];
  }): void {
    if (!this._panel || !this._webviewReady || !this._editor) return;
    if (e.notebookEditor.notebook !== this._editor.notebook) return;
    this._post({
      type: 'setScrollState',
      notebookId: this._editor.notebook.uri.toString(),
      scrollTop: e.scrollTop,
      scrollHeight: e.scrollHeight,
      viewportHeight: e.viewportHeight,
      cellLayout: e.cellLayout,
    });
  }

  public onNotebookChange(e: vscode.NotebookDocumentChangeEvent): void {
    if (!this._panel || !this._editor || e.notebook !== this._editor.notebook) return;
    if (e.contentChanges.length > 0) this._needsFullResync = true;
    const cfg = this._getConfig();
    for (const change of e.cellChanges) {
      if (change.document !== undefined) this._dirtyCells.add(change.cell.index);
      if (change.outputs !== undefined && cfg.includeOutputs) this._dirtyCells.add(change.cell.index);
    }
    this._scheduleFlush();
  }

  public onDocumentClose(doc: vscode.NotebookDocument): void {
    if (this._editor?.notebook !== doc) return;
    this._editor = undefined;
    this._dirtyCells.clear();
    this._needsFullResync = false;
    if (this._flushTimer) {
      clearTimeout(this._flushTimer);
      this._flushTimer = undefined;
    }
    const fallback = this._resolveEditor();
    if (fallback) {
      this._editor = fallback;
      if (this._webviewReady) this._sendFullSync(fallback);
    } else if (this._webviewReady) {
      this._post({ type: 'clear' });
    }
  }

  public onConfigChange(): void {
    if (!this._panel || !this._webviewReady) return;
    this._post({ type: 'setConfig', config: this._getConfig() });
    if (this._editor) this._sendFullSync(this._editor);
  }

  // ── Webview messaging ──────────────────────────────────────────────────────

  private _handleWebviewMessage(msg: WebviewMessage): void {
    switch (msg.type) {
      case 'ready': {
        this._webviewReady = true;
        this._post({ type: 'setTokenColors', tokenColors: this._tokenColors });
        const ed = this._resolveEditor();
        if (ed) {
          this._editor = ed;
          this._sendFullSync(ed);
        } else {
          this._post({ type: 'clear' });
        }
        break;
      }
      case 'reveal':
        this._reveal(msg.notebookId, msg.cellIndex, msg.atTop === true);
        break;
      case 'scrollTo':
        this._setScrollTop(msg.notebookId, msg.scrollTop);
        break;
    }
  }

  private _resolveEditor(): vscode.NotebookEditor | undefined {
    if (this._editor && !this._editor.notebook.isClosed) return this._editor;
    if (vscode.window.activeNotebookEditor) return vscode.window.activeNotebookEditor;
    const visible = vscode.window.visibleNotebookEditors ?? [];
    if (visible.length > 0) return visible[0];
    return this._findEditorForAnyDocument();
  }

  private _findEditorForAnyDocument(): vscode.NotebookEditor | undefined {
    // Walk all open notebook documents; match them back to any visible editor.
    const docs = vscode.workspace.notebookDocuments ?? [];
    const visible = vscode.window.visibleNotebookEditors ?? [];
    for (const doc of docs) {
      for (const ed of visible) {
        if (ed.notebook === doc) return ed;
      }
    }
    return undefined;
  }

  private _scheduleFlush(): void {
    if (this._flushTimer) return;
    this._flushTimer = setTimeout(() => {
      this._flushTimer = undefined;
      this._flush();
    }, FLUSH_DEBOUNCE_MS);
  }

  private _flush(): void {
    if (!this._panel || !this._editor || !this._webviewReady) {
      this._dirtyCells.clear();
      this._needsFullResync = false;
      return;
    }
    if (this._needsFullResync) {
      this._sendFullSync(this._editor);
      this._dirtyCells.clear();
      this._needsFullResync = false;
      return;
    }
    const ed = this._editor;
    const notebookId = ed.notebook.uri.toString();
    for (const idx of this._dirtyCells) {
      if (idx < 0 || idx >= ed.notebook.cellCount) continue;
      const cell = ed.notebook.cellAt(idx);
      this._post({ type: 'updateCell', notebookId, cell: this._extractCell(cell) });
      this._fetchTokensForCell(cell);
    }
    this._dirtyCells.clear();
  }

  private _sendFullSync(editor: vscode.NotebookEditor): void {
    const cells: CellData[] = [];
    for (let i = 0; i < editor.notebook.cellCount; i++) {
      cells.push(this._extractCell(editor.notebook.cellAt(i)));
    }
    this._post({
      type: 'setNotebook',
      notebookId: editor.notebook.uri.toString(),
      cells,
      config: this._getConfig(),
      visibleRanges: this._toVisibleRanges(editor),
      activeCell: editor.selection ? editor.selection.start : -1,
    });
    this._fetchTokensForAllCells(editor);
  }

  /**
   * Asynchronously fetches editor-tokenized colors for every cell and ships
   * them to the webview as they land. Uses the `documentTokenColors`
   * proposed API; when it isn't available, silently no-ops and the webview
   * falls back to its heuristic tokenizer.
   */
  private _fetchTokensForAllCells(editor: vscode.NotebookEditor): void {
    const getDocumentTokens = (vscode.languages as unknown as {
      getDocumentTokens?: (doc: vscode.TextDocument) => Thenable<readonly (readonly { startCharacter: number; endCharacter: number; foreground?: string }[])[]>;
    }).getDocumentTokens;
    if (typeof getDocumentTokens !== 'function') return;

    const notebookId = editor.notebook.uri.toString();
    const notebook = editor.notebook;
    for (let i = 0; i < notebook.cellCount; i++) {
      const cell = notebook.cellAt(i);
      const cellIndex = i;
      Promise.resolve(getDocumentTokens(cell.document)).then(tokens => {
        if (!tokens || !this._panel || !this._webviewReady) return;
        if (this._editor?.notebook !== notebook) return;
        if (cellIndex >= notebook.cellCount || notebook.cellAt(cellIndex)?.document.uri.toString() !== cell.document.uri.toString()) return;
        this._post({ type: 'setCellTokens', notebookId, cellIndex, tokens });
      }, () => {/* ignore */});
    }
  }

  private _fetchTokensForCell(cell: vscode.NotebookCell): void {
    const getDocumentTokens = (vscode.languages as unknown as {
      getDocumentTokens?: (doc: vscode.TextDocument) => Thenable<readonly (readonly { startCharacter: number; endCharacter: number; foreground?: string }[])[]>;
    }).getDocumentTokens;
    if (typeof getDocumentTokens !== 'function') return;
    const notebookId = cell.notebook.uri.toString();
    const cellIndex = cell.index;
    Promise.resolve(getDocumentTokens(cell.document)).then(tokens => {
      if (!tokens || !this._panel || !this._webviewReady) return;
      if (this._editor?.notebook !== cell.notebook) return;
      this._post({ type: 'setCellTokens', notebookId, cellIndex, tokens });
    }, () => {/* ignore */});
  }

  private _sendViewport(editor: vscode.NotebookEditor): void {
    this._post({
      type: 'setViewport',
      notebookId: editor.notebook.uri.toString(),
      visibleRanges: this._toVisibleRanges(editor),
    });
  }

  private _sendActiveCell(editor: vscode.NotebookEditor): void {
    this._post({
      type: 'setActiveCell',
      notebookId: editor.notebook.uri.toString(),
      index: editor.selection ? editor.selection.start : -1,
    });
  }

  private _toVisibleRanges(editor: vscode.NotebookEditor): VisibleRangeTuple[] {
    return editor.visibleRanges.map(r => [r.start, r.end] as VisibleRangeTuple);
  }

  // ── Cell / output extraction ───────────────────────────────────────────────

  private _extractCell(cell: vscode.NotebookCell): CellData {
    const config = this._getConfig();
    const doc = cell.document;
    const maxCol = config.maxColumn;
    const lines: string[] = [];
    for (let i = 0; i < doc.lineCount; i++) {
      const line = doc.lineAt(i).text;
      lines.push(line.length > maxCol ? line.substring(0, maxCol) : line);
    }
    const outputs: OutputItem[] = [];
    if (config.includeOutputs && cell.kind === vscode.NotebookCellKind.Code) {
      this._extractOutputs(cell, maxCol, outputs);
    }
    return {
      index: cell.index,
      kind: cell.kind === vscode.NotebookCellKind.Code ? 'code' : 'markup',
      languageId: doc.languageId,
      text: lines.join('\n'),
      lineCount: doc.lineCount,
      outputs,
    };
  }

  private _extractOutputs(cell: vscode.NotebookCell, maxCol: number, out: OutputItem[]): void {
    for (const output of cell.outputs) {
      let consumed = false;
      for (const item of output.items) {
        if (IMAGE_BINARY_MIMES.has(item.mime) || item.mime === 'image/svg+xml') {
          const imgItem = this._buildImageOutput(item);
          if (imgItem) {
            out.push(imgItem);
            consumed = true;
            break;
          }
        }
      }
      if (consumed) continue;
      for (const item of output.items) {
        const textItem = this._buildTextOutput(item, maxCol);
        if (textItem) {
          out.push(textItem);
          consumed = true;
          break;
        }
      }
      if (consumed) continue;
      for (const item of output.items) {
        if (item.mime === 'text/html' || item.mime === 'application/vnd.jupyter.widget-view+json') {
          const htmlItem = this._buildHtmlOutput(item, maxCol);
          if (htmlItem) {
            out.push(htmlItem);
            consumed = true;
            break;
          }
        }
      }
      if (consumed) continue;
      const firstMime = output.items[0]?.mime ?? 'unknown';
      out.push({ kind: 'other', label: firstMime });
    }
  }

  private _buildImageOutput(item: vscode.NotebookCellOutputItem): OutputItem | undefined {
    if (item.data.byteLength > MAX_IMAGE_BYTES) return undefined;
    const dims = readImageDimensions(item.data, item.mime);
    if (!dims) return undefined;
    const base64 = bytesToBase64(item.data);
    const mime = item.mime === 'image/jpg' ? 'image/jpeg' : item.mime;
    return {
      kind: 'image',
      dataUrl: `data:${mime};base64,${base64}`,
      naturalWidth: dims.width,
      naturalHeight: dims.height,
    };
  }

  private _buildTextOutput(
    item: vscode.NotebookCellOutputItem,
    maxCol: number
  ): OutputItem | undefined {
    let stream: 'stdout' | 'stderr' | undefined;
    if (TEXT_STDOUT_MIMES.has(item.mime)) stream = 'stdout';
    else if (TEXT_STDERR_MIMES.has(item.mime)) stream = 'stderr';
    else if (!TEXT_PLAIN_MIMES.has(item.mime)) return undefined;
    const text = new TextDecoder().decode(item.data);
    const lines = clipLines(text, maxCol, MAX_OUTPUT_TEXT_LINES);
    if (lines.length === 0) return undefined;
    return { kind: 'text', lines, stream };
  }

  private _buildHtmlOutput(
    item: vscode.NotebookCellOutputItem,
    maxCol: number
  ): OutputItem | undefined {
    const text = new TextDecoder().decode(item.data);
    const plain = text
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>');
    const lines = clipLines(plain, maxCol, MAX_OUTPUT_TEXT_LINES);
    if (lines.length === 0) return undefined;
    return { kind: 'html', lines };
  }

  private _getConfig(): MinimapConfig {
    const cfg = vscode.workspace.getConfiguration('notebookMinimap');
    return {
      maxColumn: clamp(cfg.get<number>('maxColumn', 80), 30, 300),
      renderCharacters: cfg.get<boolean>('renderCharacters', true),
      scale: clamp(cfg.get<number>('scale', 1), 0.5, 3),
      showCellBoundaries: cfg.get<boolean>('showCellBoundaries', true),
      followActiveCell: cfg.get<boolean>('followActiveCell', true),
      includeOutputs: cfg.get<boolean>('includeOutputs', true),
      renderMarkdownHeadings: cfg.get<boolean>('renderMarkdownHeadings', true),
      maxImageHeightRows: clamp(cfg.get<number>('maxImageHeightRows', 30), 5, 120),
      fillPanelWidth: cfg.get<boolean>('fillPanelWidth', true),
    };
  }

  private _post(msg: ExtensionMessage): void {
    if (!this._panel) return;
    void this._panel.webview.postMessage(msg);
  }

  private _reveal(notebookId: string, cellIndex: number, atTop: boolean): void {
    const editor = this._findEditor(notebookId);
    if (!editor) return;
    if (cellIndex < 0 || cellIndex >= editor.notebook.cellCount) return;
    const range = new vscode.NotebookRange(cellIndex, cellIndex + 1);
    editor.revealRange(
      range,
      atTop ? vscode.NotebookEditorRevealType.AtTop : vscode.NotebookEditorRevealType.Default
    );
  }

  private _setScrollTop(notebookId: string, scrollTop: number): void {
    const editor = this._findEditor(notebookId);
    if (!editor) return;
    // Try the proposed pixel-level scroll API first.
    const setFn = (editor as any).setScrollTop;
    if (typeof setFn === 'function') {
      setFn.call(editor, scrollTop);
      return;
    }
    // Fallback: estimate which cell corresponds to this scrollTop and reveal it.
    // Use a rough heuristic: scrollTop / scrollHeight * cellCount.
    const cellCount = editor.notebook.cellCount;
    if (cellCount === 0) return;
    // We don't have scrollHeight here, so reveal the midpoint cell as a best-effort.
    // The webview should prefer sending 'reveal' when pixel scroll isn't available.
    const idx = Math.min(cellCount - 1, Math.max(0, Math.round(scrollTop)));
    const range = new vscode.NotebookRange(idx, idx + 1);
    editor.revealRange(range, vscode.NotebookEditorRevealType.Default);
  }

  private _findEditor(notebookId: string): vscode.NotebookEditor | undefined {
    const visible = vscode.window.visibleNotebookEditors ?? [];
    for (const ed of visible) {
      if (ed.notebook.uri.toString() === notebookId) return ed;
    }
    if (this._editor && this._editor.notebook.uri.toString() === notebookId) return this._editor;
    return undefined;
  }

  private _getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'media', 'main.js')
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'media', 'main.css')
    );
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${styleUri}" rel="stylesheet">
  <title>Notebook Minimap</title>
</head>
<body>
  <div id="empty" class="empty-state">Open a notebook to see its minimap.</div>
  <div id="container" hidden>
    <div id="scroll">
      <div id="stage">
        <canvas id="canvas"></canvas>
        <div id="viewport-indicator"></div>
        <div id="active-cell-marker"></div>
      </div>
    </div>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

// ── Helpers (unchanged) ──────────────────────────────────────────────────────

function clamp(n: number, lo: number, hi: number): number {
  if (Number.isNaN(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

function clipLines(text: string, maxCol: number, maxLines: number): string[] {
  const out: string[] = [];
  let count = 0;
  for (const raw of text.split(/\r?\n/)) {
    if (count >= maxLines) break;
    out.push(raw.length > maxCol ? raw.substring(0, maxCol) : raw);
    count++;
  }
  while (out.length > 0 && out[out.length - 1].trim() === '') out.pop();
  return out;
}

function readImageDimensions(data: Uint8Array, mime: string): { width: number; height: number } | undefined {
  try {
    if (mime === 'image/png') return readPngDimensions(data);
    if (mime === 'image/jpeg' || mime === 'image/jpg') return readJpegDimensions(data);
    if (mime === 'image/gif') return readGifDimensions(data);
    if (mime === 'image/webp') return readWebpDimensions(data);
    if (mime === 'image/svg+xml') return readSvgDimensions(data);
  } catch {
    return undefined;
  }
  return undefined;
}

function readPngDimensions(data: Uint8Array): { width: number; height: number } | undefined {
  if (data.length < 24) return undefined;
  if (data[0] !== 0x89 || data[1] !== 0x50 || data[2] !== 0x4e || data[3] !== 0x47) return undefined;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return { width: view.getUint32(16, false), height: view.getUint32(20, false) };
}

function readJpegDimensions(data: Uint8Array): { width: number; height: number } | undefined {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return undefined;
  let i = 2;
  while (i < data.length - 8) {
    if (data[i] !== 0xff) return undefined;
    let marker = data[i + 1];
    while (marker === 0xff && i + 1 < data.length) {
      i++;
      marker = data[i + 1];
    }
    if (marker === 0xd8 || marker === 0xd9) return undefined;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = (data[i + 2] << 8) | data[i + 3];
    if (
      marker !== 0xc0 && marker !== 0xc1 && marker !== 0xc2 && marker !== 0xc3 &&
      marker !== 0xc5 && marker !== 0xc6 && marker !== 0xc7 && marker !== 0xc9 &&
      marker !== 0xca && marker !== 0xcb && marker !== 0xcd && marker !== 0xce && marker !== 0xcf
    ) {
      i += 2 + len;
      continue;
    }
    const height = (data[i + 5] << 8) | data[i + 6];
    const width = (data[i + 7] << 8) | data[i + 8];
    return { width, height };
  }
  return undefined;
}

function readGifDimensions(data: Uint8Array): { width: number; height: number } | undefined {
  if (data.length < 10) return undefined;
  if (data[0] !== 0x47 || data[1] !== 0x49 || data[2] !== 0x46) return undefined;
  const width = data[6] | (data[7] << 8);
  const height = data[8] | (data[9] << 8);
  return { width, height };
}

function readWebpDimensions(data: Uint8Array): { width: number; height: number } | undefined {
  if (data.length < 30) return undefined;
  if (data[0] !== 0x52 || data[1] !== 0x49 || data[2] !== 0x46 || data[3] !== 0x46) return undefined;
  if (data[8] !== 0x57 || data[9] !== 0x45 || data[10] !== 0x42 || data[11] !== 0x50) return undefined;
  const chunk = String.fromCharCode(data[12], data[13], data[14], data[15]);
  if (chunk === 'VP8 ') {
    const width = (data[26] | (data[27] << 8)) & 0x3fff;
    const height = (data[28] | (data[29] << 8)) & 0x3fff;
    return { width, height };
  }
  if (chunk === 'VP8L') {
    const b = data.slice(21, 25);
    const width = 1 + (((b[1] & 0x3f) << 8) | b[0]);
    const height = 1 + (((b[3] & 0x0f) << 10) | (b[2] << 2) | ((b[1] & 0xc0) >> 6));
    return { width, height };
  }
  if (chunk === 'VP8X') {
    const width = 1 + (data[24] | (data[25] << 8) | (data[26] << 16));
    const height = 1 + (data[27] | (data[28] << 8) | (data[29] << 16));
    return { width, height };
  }
  return undefined;
}

function readSvgDimensions(data: Uint8Array): { width: number; height: number } | undefined {
  const text = new TextDecoder().decode(data.slice(0, Math.min(2048, data.length)));
  const svgTagMatch = /<svg\b([^>]*)>/i.exec(text);
  if (!svgTagMatch) return undefined;
  const attrs = svgTagMatch[1];
  const wMatch = /\bwidth\s*=\s*["']?([\d.]+)/i.exec(attrs);
  const hMatch = /\bheight\s*=\s*["']?([\d.]+)/i.exec(attrs);
  if (wMatch && hMatch) {
    const w = parseFloat(wMatch[1]);
    const h = parseFloat(hMatch[1]);
    if (w > 0 && h > 0) return { width: w, height: h };
  }
  const viewBoxMatch = /\bviewBox\s*=\s*["']([^"']+)["']/i.exec(attrs);
  if (viewBoxMatch) {
    const parts = viewBoxMatch[1].trim().split(/\s+/).map(parseFloat);
    if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) {
      return { width: parts[2], height: parts[3] };
    }
  }
  return undefined;
}

function bytesToBase64(data: Uint8Array): string {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('base64');
}
