// @ts-check
/* global acquireVsCodeApi */
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();

  const container = /** @type {HTMLDivElement} */ (document.getElementById('container'));
  const scroll = /** @type {HTMLDivElement} */ (document.getElementById('scroll'));
  const stage = /** @type {HTMLDivElement} */ (document.getElementById('stage'));
  const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('canvas'));
  const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
  const viewportIndicator = /** @type {HTMLDivElement} */ (document.getElementById('viewport-indicator'));
  const activeCellMarker = /** @type {HTMLDivElement} */ (document.getElementById('active-cell-marker'));
  const emptyState = /** @type {HTMLDivElement} */ (document.getElementById('empty'));

  // ── State ──────────────────────────────────────────────────────────────────

  /** @type {{maxColumn:number, renderCharacters:boolean, scale:number, showCellBoundaries:boolean, followActiveCell:boolean, includeOutputs:boolean, renderMarkdownHeadings:boolean, maxImageHeightRows:number, fillPanelWidth:boolean}} */
  let config = {
    maxColumn: 120,
    renderCharacters: true,
    scale: 1,
    showCellBoundaries: true,
    followActiveCell: true,
    includeOutputs: true,
    renderMarkdownHeadings: true,
    maxImageHeightRows: 30,
    fillPanelWidth: true,
  };

  /** @type {string|null} */
  let notebookId = null;
  /** @type {Array<{index:number, kind:'code'|'markup', languageId:string, text:string, lineCount:number, outputs:Array<any>}>} */
  let cells = [];
  /** @type {Array<any>} */
  let cellLayouts = [];
  let totalHeight = 0;
  let activeCellIndex = -1;
  /** @type {Array<[number, number]>} */
  let visibleRanges = [];
  /** @type {ReturnType<typeof readPalette>|null} */
  let palette = null;
  /** @type {{panelW:number, padX:number, charW:number, lineH:number, minimapW:number}} */
  let metrics = { panelW: 126, padX: 3, charW: 1, lineH: 2, minimapW: 126 };

  // Rolling estimate of the notebook viewport height in minimap pixels.
  // Updated from frames where several cells are simultaneously visible
  // (i.e. none of them is dominating the viewport). Used to clamp the
  // viewport overlay when one tall cell fills the view, so the overlay
  // stops pretending to cover the whole cell.
  let viewportHEst = 0;
  let prevSpanTop = 0;
  let prevSpanBottom = 0;

  // Pixel-level scroll state from the proposed `notebookEditorScroll` API.
  // When present, it supersedes both the cell-span clamping and the velocity
  // extrapolation below — we can draw the overlay at the exact fractional
  // position of the real viewport. `null` means that API isn't active and we
  // should fall back to the legacy cell-boundary + extrapolation path.
  /** @type {{scrollTop:number, scrollHeight:number, viewportHeight:number}|null} */
  let pixelScroll = null;

  // Real-notebook pixel top offsets of every cell, delivered by the proposed
  // `notebookEditorScroll` API. Length is cellCount + 1: cellLayoutReal[i] is
  // the top of cell i, cellLayoutReal[cellCount] is the scroll bottom. This
  // is an exact map (sourced from NotebookCellList internals) — when we have
  // it, real→minimap mapping is deterministic at every cell boundary, and we
  // only interpolate *within* a single cell (two-segment for code / output).
  // Updated in-place whenever the API reports a change; sparse scroll events
  // leave it untouched so we don't re-cache on pure-scroll frames.
  /** @type {readonly number[]|null} */
  let cellLayoutReal = null;

  // Scroll messages from the extension host can burst at the display refresh
  // rate (60 Hz+). Processing each synchronously performs several style
  // writes and a binary search per message — 10 messages per frame means
  // 9 wasted updates (only the last is ever painted). Coalesce bursts to
  // one flush per animation frame, always carrying the latest state.
  /** @type {any|null} */
  let pendingScrollMsg = null;
  let pendingScrollRAF = null;
  function queueScrollState(msg) {
    pendingScrollMsg = msg;
    if (pendingScrollRAF !== null) return;
    pendingScrollRAF = requestAnimationFrame(flushScrollState);
  }
  function flushScrollState() {
    pendingScrollRAF = null;
    const msg = pendingScrollMsg;
    pendingScrollMsg = null;
    if (!msg || msg.notebookId !== notebookId) return;
    pixelScroll = {
      scrollTop: msg.scrollTop,
      scrollHeight: msg.scrollHeight,
      viewportHeight: msg.viewportHeight,
    };
    if (Array.isArray(msg.cellLayout) && msg.cellLayout.length > 1) {
      cellLayoutReal = msg.cellLayout;
    }
    if (scrollAnchors.length < 2) resetScrollAnchors();
    if (anchorRecordPending) {
      anchorRecordPending = false;
      recordAnchorsFromTransition();
    }
    updateViewportIndicator();
  }

  // Progressive anchor table that maps real-notebook pixel offsets to minimap
  // pixel offsets. Seeded with {0→0, scrollHeight→totalHeight} (the global
  // ratio endpoints) and refined every time a cell boundary crosses the
  // viewport — at that instant we know the cell's real pixel offset via
  // scrollTop.  Between anchors we interpolate linearly, so the mapping is
  // exact at every cell boundary the user has scrolled past and approximately
  // correct elsewhere.
  /** @type {Array<{realY:number, minimapY:number, cellIdx:number}>} */
  let scrollAnchors = [];
  let prevVisStart = -1;
  let prevVisEnd = -1;
  let anchorRecordPending = false;

  // Velocity extrapolation between cell-boundary transitions. The notebook API
  // only reports cell-level visibility, so inside a single tall cell we know
  // direction and an approximate speed from the previous transition, but no
  // ground-truth scroll position. We extrapolate with monotonic ease-out so
  // the overlay drifts in the scroll direction for a bounded window, then
  // decelerates if no new transition arrives. Capped at span edges and
  // snapped back to truth on the next transition.
  let scrollSpeed = 0;                 // minimap px / ms
  let scrollDir = 0;                   // -1 up, 0 idle, +1 down
  let lastTransitionTime = 0;
  let animBaseTop = 0;
  let animSpanTop = 0;
  let animSpanBottom = 0;
  let animH = 0;
  let animMs = 0;                      // adaptive per-transition window
  let animFrame = null;
  // Adaptive extrapolation: instead of a fixed time window, fix the maximum
  // post-stop drift and let the duration expand for slow scrolls so motion
  // stays visible. Total drift after a stop is always ≤ MAX_DRIFT_PX (the
  // integral of our decaying-velocity ease-out is speed × T / 2, so setting
  // T = 2·drift/speed pins the drift regardless of speed). Duration clamped
  // so very fast/slow scrolls don't go to extremes.
  const MAX_DRIFT_PX = 60;
  const MIN_ANIM_MS = 120;
  const MAX_ANIM_MS_CAP = 900;
  const MAX_SPEED = 3; // minimap px/ms; sanity cap

  const MAX_OUTPUT_LINES = 20;
  const EST_PX_PER_CODE_LINE = 20;

  // Theme-resolved foreground colors for common syntax categories. Supplied
  // by the extension via the `themeTokenColors` proposed API — the active
  // color theme's actual tokenColors rules resolved on the main thread.
  // Empty when the proposal isn't enabled; palette falls back to the
  // symbolIcon.* CSS variables (close but not exact).
  /** @type {{default?:string, keyword?:string, string?:string, number?:string, comment?:string, function?:string, type?:string, variable?:string, operator?:string, constant?:string}} */
  let themeTokenColors = {};

  // ── Image cache ────────────────────────────────────────────────────────────

  /** @type {Map<string, {img:HTMLImageElement, loaded:boolean, error:boolean}>} */
  const imageCache = new Map();

  function getOrLoadImage(dataUrl) {
    let entry = imageCache.get(dataUrl);
    if (entry) return entry;
    const img = new Image();
    entry = { img, loaded: false, error: false };
    imageCache.set(dataUrl, entry);
    img.onload = () => {
      entry.loaded = true;
      scheduleDraw();
    };
    img.onerror = () => {
      entry.error = true;
      scheduleDraw();
    };
    img.src = dataUrl;
    return entry;
  }

  function pruneImageCache() {
    // Remove cached images not referenced by current cells
    const active = new Set();
    for (const cell of cells) {
      for (const out of cell.outputs || []) {
        if (out && out.kind === 'image') active.add(out.dataUrl);
      }
    }
    for (const key of imageCache.keys()) {
      if (!active.has(key)) imageCache.delete(key);
    }
  }

  // ── Theme palette ──────────────────────────────────────────────────────────

  function cssVar(name, fallback) {
    const v = getComputedStyle(document.body).getPropertyValue(name).trim();
    return v || fallback;
  }

  function readPalette() {
    const editorBg = cssVar('--vscode-editor-background', '#1e1e1e');
    const editorFg = cssVar('--vscode-editor-foreground', '#cccccc');
    return {
      bg: editorBg,
      fg: editorFg,
      codeBg: cssVar('--vscode-notebook-cellEditorBackground', editorBg),
      codeHeader: cssVar('--vscode-notebook-focusedCellBorder', cssVar('--vscode-focusBorder', '#007fd4')),
      markupBg: cssVar('--vscode-textCodeBlock-background', 'rgba(128,128,128,0.06)'),
      markupHeader: cssVar('--vscode-textLink-foreground', '#3794ff'),
      border: cssVar('--vscode-notebook-cellBorderColor', cssVar('--vscode-panel-border', 'rgba(128,128,128,0.2)')),
      activeCell: cssVar('--vscode-focusBorder', '#007fd4'),
      outputBg: cssVar('--vscode-textBlockQuote-background', 'rgba(128,128,128,0.05)'),
      outputFg: cssVar('--vscode-descriptionForeground', 'rgba(200,200,200,0.6)'),
      errorFg: cssVar('--vscode-errorForeground', '#f48771'),
      // Prefer theme-resolved tokenColors when present (exact match with
      // the editor's syntax highlighting), fall back to the symbolIcon.*
      // CSS vars otherwise. These are themeTokenColors-first, CSS-fallback.
      keyword: themeTokenColors.keyword || cssVar('--vscode-symbolIcon-keywordForeground', '#c586c0'),
      stringFg: themeTokenColors.string || cssVar('--vscode-symbolIcon-stringForeground', '#ce9178'),
      numberFg: themeTokenColors.number || cssVar('--vscode-symbolIcon-numberForeground', '#b5cea8'),
      commentFg: themeTokenColors.comment || cssVar('--vscode-editorLineNumber-foreground', 'rgba(128,128,128,0.7)'),
      functionFg: themeTokenColors.function || cssVar('--vscode-symbolIcon-functionForeground', '#dcdcaa'),
      h1: cssVar('--vscode-textLink-activeForeground', cssVar('--vscode-textLink-foreground', '#3794ff')),
      h2: cssVar('--vscode-textLink-foreground', '#3794ff'),
      h3: cssVar('--vscode-symbolIcon-keywordForeground', '#c586c0'),
      h4: cssVar('--vscode-symbolIcon-functionForeground', '#dcdcaa'),
      h5: cssVar('--vscode-symbolIcon-classForeground', '#4ec9b0'),
      h6: cssVar('--vscode-descriptionForeground', '#9cdcfe'),
      fontFamily: cssVar('--vscode-font-family', 'system-ui, sans-serif'),
    };
  }

  function headingColor(level) {
    if (!palette) return '#888';
    switch (level) {
      case 1: return palette.h1;
      case 2: return palette.h2;
      case 3: return palette.h3;
      case 4: return palette.h4;
      case 5: return palette.h5;
      case 6: return palette.h6;
      default: return palette.fg;
    }
  }

  // ── Metrics ────────────────────────────────────────────────────────────────

  function computeMetrics() {
    const scl = Math.max(0.5, Math.min(3, config.scale || 1));
    // scroll.clientWidth excludes the vertical scrollbar (pinned via
    // scrollbar-gutter: stable). Fall back to container width on the very
    // first paint before layout has settled.
    const rawW = scroll.clientWidth || container.clientWidth || 126;
    const panelW = Math.max(40, Math.floor(rawW));
    let charW;
    let padX;
    let minimapW;
    if (config.fillPanelWidth !== false) {
      padX = Math.max(2, Math.round(panelW * 0.02));
      const available = Math.max(20, panelW - padX * 2);
      charW = Math.max(0.8, (available / config.maxColumn) * scl);
      minimapW = panelW;
    } else {
      charW = Math.max(1, 1 * scl);
      padX = Math.max(2, Math.round(3 * scl));
      minimapW = Math.round(config.maxColumn * charW + padX * 2);
    }
    const lineH = Math.max(2, Math.round(charW * 2));
    return { panelW, padX, charW, minimapW, lineH };
  }

  // ── Line classification ────────────────────────────────────────────────────

  function getHeadingLevel(line) {
    const trimmed = trimStart(line);
    if (trimmed.length === 0 || trimmed.charCodeAt(0) !== 35 /* # */) return 0;
    let i = 0;
    while (i < trimmed.length && i < 6 && trimmed.charCodeAt(i) === 35) i++;
    if (i < trimmed.length && trimmed.charCodeAt(i) !== 32 /* space */) return 0;
    return i;
  }

  function lineVerticalUnits(cell, line) {
    if (cell.kind !== 'markup') return 1;
    if (!config.renderMarkdownHeadings) return 1;
    const level = getHeadingLevel(line);
    switch (level) {
      case 1: return 4;
      case 2: return 3;
      case 3: return 2.25;
      case 4: return 1.75;
      case 5: return 1.5;
      case 6: return 1.5;
      default: return 1;
    }
  }

  // ── Layout computation ─────────────────────────────────────────────────────

  function computeLayout() {
    cellLayouts = [];
    const lh = metrics.lineH;
    const hh = Math.max(2, Math.round(metrics.lineH * 1.5));
    const gap = Math.max(2, Math.round(metrics.lineH * 1.5));

    let y = 0;
    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i];
      const lines = cell.text.length > 0 ? cell.text.split('\n') : [''];
      const lineLayouts = [];
      let bodyY = y + hh;
      let curY = bodyY;
      for (let li = 0; li < lines.length; li++) {
        const units = lineVerticalUnits(cell, lines[li]);
        const h = Math.max(lh, Math.round(lh * units));
        lineLayouts.push({ y: curY, h, text: lines[li], headingLevel: cell.kind === 'markup' ? getHeadingLevel(lines[li]) : 0 });
        curY += h;
      }
      const contentH = curY - bodyY;

      const outputLayouts = [];
      let outStart = curY;
      let outCursor = outStart;
      if (config.includeOutputs && cell.outputs && cell.outputs.length > 0) {
        for (const output of cell.outputs) {
          const ol = layoutOutput(output, outCursor, metrics, lh);
          outputLayouts.push(ol);
          outCursor += ol.h;
        }
      }
      const outputsH = outCursor - outStart;

      const height = hh + contentH + outputsH + gap;
      cellLayouts.push({
        top: y,
        height,
        headerY: y,
        headerH: Math.max(1, hh - 1),
        bodyY,
        bodyH: contentH,
        outputsY: outStart,
        outputsH,
        lines: lineLayouts,
        outputs: outputLayouts,
      });
      y += height;
    }
    totalHeight = y;
  }

  function layoutOutput(output, y, m, lh) {
    if (output.kind === 'image') {
      const usableW = m.minimapW - m.padX * 2;
      const w = Math.max(8, usableW);
      const aspect = output.naturalWidth > 0 ? output.naturalHeight / output.naturalWidth : 0.75;
      const naturalH = Math.round(w * aspect);
      const maxH = Math.round(config.maxImageHeightRows * lh);
      const h = Math.max(Math.round(lh * 2), Math.min(maxH, naturalH));
      return {
        kind: 'image',
        y,
        h,
        dataUrl: output.dataUrl,
        drawX: m.padX,
        drawW: w,
      };
    }
    if (output.kind === 'text' || output.kind === 'html') {
      const nLines = Math.min(MAX_OUTPUT_LINES, output.lines ? output.lines.length : 0);
      const h = Math.max(lh, nLines * lh);
      return {
        kind: output.kind,
        y,
        h,
        lines: output.lines ? output.lines.slice(0, nLines) : [],
        stream: output.stream,
      };
    }
    // 'other' fallback
    return {
      kind: 'other',
      y,
      h: Math.max(lh, Math.round(lh * 1.5)),
      label: output.label,
    };
  }

  // ── Canvas sizing ──────────────────────────────────────────────────────────

  function sizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const w = metrics.minimapW;
    const h = totalHeight;
    canvas.width = Math.max(1, Math.ceil(w * dpr));
    canvas.height = Math.max(1, Math.ceil(h * dpr));
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    stage.style.width = w + 'px';
    stage.style.height = h + 'px';
    viewportIndicator.style.width = w + 'px';
    activeCellMarker.style.width = Math.max(2, Math.round(metrics.charW * 2)) + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // ── Rendering ──────────────────────────────────────────────────────────────

  let pendingDraw = false;
  function scheduleDraw() {
    if (pendingDraw) return;
    pendingDraw = true;
    requestAnimationFrame(() => {
      pendingDraw = false;
      render();
    });
  }

  function render() {
    palette = readPalette();
    metrics = computeMetrics();
    computeLayout();
    sizeCanvas();
    drawAll();
    updateViewportIndicator();
    updateActiveCellMarker();
    if (config.followActiveCell) autoScroll();
  }

  function drawAll() {
    if (!palette) return;
    ctx.clearRect(0, 0, metrics.minimapW, totalHeight);
    for (let i = 0; i < cells.length; i++) drawCell(i);
  }

  function drawCell(i) {
    if (!palette) return;
    const cell = cells[i];
    const layout = cellLayouts[i];
    const w = metrics.minimapW;
    const isMarkup = cell.kind === 'markup';

    // Body background
    ctx.fillStyle = isMarkup ? palette.markupBg : palette.codeBg;
    ctx.fillRect(0, layout.bodyY, w, layout.bodyH);

    // Outputs background
    if (layout.outputsH > 0) {
      ctx.fillStyle = palette.outputBg;
      ctx.fillRect(0, layout.outputsY, w, layout.outputsH);
    }

    // Cell header strip
    const headerColor = isMarkup ? palette.markupHeader : palette.codeHeader;
    ctx.fillStyle = headerColor;
    ctx.globalAlpha = 0.4;
    ctx.fillRect(0, layout.headerY, w, layout.headerH);
    ctx.globalAlpha = 1;

    // Cell boundary
    if (config.showCellBoundaries) {
      ctx.fillStyle = palette.border;
      ctx.fillRect(0, layout.top + layout.height - 1, w, 1);
    }

    // Body lines
    for (let li = 0; li < layout.lines.length; li++) {
      const lineInfo = layout.lines[li];
      if (isMarkup && lineInfo.headingLevel > 0 && config.renderMarkdownHeadings) {
        drawHeadingLine(lineInfo.text, lineInfo.y, lineInfo.h, lineInfo.headingLevel);
      } else {
        drawTextLine(lineInfo.text, lineInfo.y, lineInfo.h, cell, isMarkup, li);
      }
    }

    // Outputs
    for (const out of layout.outputs) drawOutput(out);
  }

  function drawTextLine(rawLine, y, lineH, cell, isMarkup, lineIndex) {
    if (!palette) return;
    const cw = metrics.charW;
    const px = metrics.padX;
    const maxCol = config.maxColumn;
    const line = rawLine.length > maxCol ? rawLine.substring(0, maxCol) : rawLine;
    const len = line.length;
    if (len === 0) return;

    // Line-level classification
    const trimmed = trimStart(line);
    let lineColor = palette.fg;
    let lineAlpha = 0.85;
    let isComment = false;

    if (isMarkup) {
      lineAlpha = 0.72;
      if (trimmed.startsWith('>')) lineColor = palette.commentFg;
      else if (trimmed.startsWith('```')) lineColor = palette.commentFg;
      else if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
        // list marker slightly accented
      }
    } else {
      const lid = cell.languageId;
      if (lid === 'python' || lid === 'r' || lid === 'shellscript' || lid === 'yaml' || lid === 'toml' || lid === 'ruby') {
        if (trimmed.startsWith('#')) {
          isComment = true; lineColor = palette.commentFg; lineAlpha = 0.55;
        }
      } else if (
        lid === 'javascript' || lid === 'typescript' || lid === 'javascriptreact' || lid === 'typescriptreact' ||
        lid === 'c' || lid === 'cpp' || lid === 'java' || lid === 'go' || lid === 'rust' || lid === 'csharp' || lid === 'swift'
      ) {
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
          isComment = true; lineColor = palette.commentFg; lineAlpha = 0.55;
        }
      } else if (lid === 'sql') {
        if (trimmed.startsWith('--')) { isComment = true; lineColor = palette.commentFg; lineAlpha = 0.55; }
      }
    }

    const blockPad = lineH >= 4 ? 1 : 0.5;
    const blockY = Math.round(y + blockPad);
    const blockH = Math.max(1, Math.round(y + lineH - blockPad) - blockY);

    if (!config.renderCharacters) {
      const leading = countLeadingWhitespace(line);
      const trailing = countTrailingWhitespace(line);
      const vis = len - leading - trailing;
      if (vis <= 0) return;
      const nonWs = countNonWhitespace(line, leading, len - trailing);
      const density = Math.min(1, nonWs / Math.max(1, vis));
      ctx.fillStyle = lineColor;
      ctx.globalAlpha = Math.min(1, lineAlpha * (0.45 + density * 0.6));
      const xStart = Math.round(px + leading * cw);
      const xEnd = Math.round(px + (leading + vis) * cw);
      ctx.fillRect(xStart, blockY, Math.max(1, xEnd - xStart), blockH);
      ctx.globalAlpha = 1;
      return;
    }

    // Color source: editor tokens (documentTokenColors proposed API). When
    // tokens haven't arrived yet (notebook just opened, cell edited but
    // re-tokenization pending, or stock VS Code without the proposal), the
    // line renders in the default foreground — we do NOT attempt a
    // heuristic classification, which diverges visibly from the real
    // editor syntax highlighting.
    const editorTokens = (cell.tokens && lineIndex >= 0 && lineIndex < cell.tokens.length)
      ? cell.tokens[lineIndex]
      : null;
    let lastColor = null;
    let lastAlpha = -1;
    let tIdx = 0;

    for (let i = 0; i < len; i++) {
      const code = line.charCodeAt(i);
      if (code <= 32) continue;

      let c = lineColor;
      let a = lineAlpha;

      if (editorTokens) {
        while (tIdx < editorTokens.length && editorTokens[tIdx].endCharacter <= i) tIdx++;
        if (tIdx < editorTokens.length && editorTokens[tIdx].startCharacter <= i) {
          const fg = editorTokens[tIdx].foreground;
          if (fg) c = fg;
          a = 0.95;
        }
      }

      if (c !== lastColor) { ctx.fillStyle = c; lastColor = c; }
      if (a !== lastAlpha) { ctx.globalAlpha = a; lastAlpha = a; }

      const xStart = Math.round(px + i * cw);
      const xEnd = Math.round(px + (i + 1) * cw);
      ctx.fillRect(xStart, blockY, Math.max(1, xEnd - xStart), blockH);
    }
    ctx.globalAlpha = 1;
  }

  function drawHeadingLine(rawLine, y, lineH, level) {
    if (!palette) return;
    const w = metrics.minimapW;
    const px = metrics.padX;
    const color = headingColor(level);
    const label = rawLine.replace(/^\s*#+\s*/, '').trim();

    // Background tint proportional to level (H1 strongest)
    const bgAlpha = 0.22 - (level - 1) * 0.025;
    ctx.fillStyle = color;
    ctx.globalAlpha = bgAlpha;
    ctx.fillRect(0, y, w, lineH);

    // Top + bottom accent strips
    const strip = Math.max(1, Math.round(lineH * 0.12));
    ctx.globalAlpha = 0.9;
    ctx.fillRect(0, y, w, strip);
    ctx.globalAlpha = 0.55 - (level - 1) * 0.06;
    ctx.fillRect(0, y + lineH - strip, w, strip);

    // Left accent bar
    const barW = Math.max(2, Math.round(metrics.charW * 2.5));
    ctx.globalAlpha = 0.95;
    ctx.fillRect(0, y, barW, lineH);

    // Heading text if there's room
    const fontSize = Math.max(4, Math.min(lineH - 2, Math.round(lineH * 0.72)));
    if (fontSize >= 6 && label.length > 0) {
      ctx.globalAlpha = 1;
      ctx.fillStyle = color;
      ctx.textBaseline = 'middle';
      ctx.font = `bold ${fontSize}px ${palette.fontFamily}`;
      const textX = barW + Math.max(2, Math.round(px));
      const textY = y + lineH / 2 + 0.5;
      const maxTextW = Math.max(8, w - textX - px);
      const truncated = truncateCanvasText(ctx, label, maxTextW);
      ctx.fillText(truncated, textX, textY);
    }

    ctx.globalAlpha = 1;
  }

  function truncateCanvasText(context, text, maxWidth) {
    if (context.measureText(text).width <= maxWidth) return text;
    const ell = '…';
    let lo = 0;
    let hi = text.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      const t = text.substring(0, mid) + ell;
      if (context.measureText(t).width <= maxWidth) lo = mid;
      else hi = mid - 1;
    }
    return lo === 0 ? ell : text.substring(0, lo) + ell;
  }

  function drawOutput(out) {
    if (!palette) return;
    if (out.kind === 'image') {
      drawImageOutput(out);
      return;
    }
    if (out.kind === 'text' || out.kind === 'html') {
      drawTextOutput(out);
      return;
    }
    // Fallback placeholder
    ctx.fillStyle = palette.outputFg;
    ctx.globalAlpha = 0.25;
    ctx.fillRect(metrics.padX, out.y + 1, metrics.minimapW - metrics.padX * 2, Math.max(1, out.h - 2));
    ctx.globalAlpha = 1;
  }

  function drawImageOutput(out) {
    if (!palette) return;
    const entry = getOrLoadImage(out.dataUrl);
    // Border + placeholder
    ctx.fillStyle = palette.outputBg;
    ctx.fillRect(out.drawX, out.y, out.drawW, out.h);
    if (entry.loaded) {
      try {
        ctx.drawImage(entry.img, out.drawX, out.y, out.drawW, out.h);
      } catch (_) { /* ignore */ }
    } else if (entry.error) {
      ctx.strokeStyle = palette.outputFg;
      ctx.globalAlpha = 0.35;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(out.drawX, out.y);
      ctx.lineTo(out.drawX + out.drawW, out.y + out.h);
      ctx.moveTo(out.drawX + out.drawW, out.y);
      ctx.lineTo(out.drawX, out.y + out.h);
      ctx.stroke();
      ctx.globalAlpha = 1;
    } else {
      // loading: a dim diagonal hatch effect
      ctx.fillStyle = palette.outputFg;
      ctx.globalAlpha = 0.08;
      ctx.fillRect(out.drawX + 2, out.y + 2, out.drawW - 4, out.h - 4);
      ctx.globalAlpha = 1;
    }
  }

  function drawTextOutput(out) {
    if (!palette) return;
    const px = metrics.padX;
    const cw = metrics.charW;
    const lh = metrics.lineH;
    const maxCol = config.maxColumn;
    const color = out.stream === 'stderr' ? palette.errorFg : palette.outputFg;

    ctx.fillStyle = color;

    for (let oi = 0; oi < out.lines.length; oi++) {
      const rawLine = out.lines[oi];
      const line = rawLine.length > maxCol ? rawLine.substring(0, maxCol) : rawLine;
      const len = line.length;
      if (len === 0) continue;
      const y = out.y + oi * lh;
      const blockPad = lh >= 4 ? 1 : 0.5;
      const blockY = Math.round(y + blockPad);
      const blockH = Math.max(1, Math.round(y + lh - blockPad) - blockY);

      if (!config.renderCharacters) {
        const leading = countLeadingWhitespace(line);
        const trailing = countTrailingWhitespace(line);
        const vis = len - leading - trailing;
        if (vis <= 0) continue;
        ctx.globalAlpha = 0.6;
        const xStart = Math.round(px + leading * cw);
        const xEnd = Math.round(px + (leading + vis) * cw);
        ctx.fillRect(xStart, blockY, Math.max(1, xEnd - xStart), blockH);
        continue;
      }

      ctx.globalAlpha = 0.7;
      for (let i = 0; i < len; i++) {
        const code = line.charCodeAt(i);
        if (code <= 32) continue;
        const xStart = Math.round(px + i * cw);
        const xEnd = Math.round(px + (i + 1) * cw);
        ctx.fillRect(xStart, blockY, Math.max(1, xEnd - xStart), blockH);
      }
    }
    ctx.globalAlpha = 1;
  }

  // ── Whitespace helpers ─────────────────────────────────────────────────────

  function trimStart(s) {
    let i = 0;
    while (i < s.length) {
      const c = s.charCodeAt(i);
      if (c !== 32 && c !== 9) break;
      i++;
    }
    return s.substring(i);
  }

  function countLeadingWhitespace(line) {
    let i = 0;
    while (i < line.length) {
      const c = line.charCodeAt(i);
      if (c !== 32 && c !== 9) break;
      i++;
    }
    return i;
  }

  function countTrailingWhitespace(line) {
    let i = line.length;
    while (i > 0) {
      const c = line.charCodeAt(i - 1);
      if (c !== 32 && c !== 9) break;
      i--;
    }
    return line.length - i;
  }

  function countNonWhitespace(line, start, end) {
    let n = 0;
    for (let i = start; i < end; i++) {
      const c = line.charCodeAt(i);
      if (c > 32) n++;
    }
    return n;
  }

  // ── Overlays ───────────────────────────────────────────────────────────────

  // ── Scroll anchor mapping ────────────────────────────────────────────────

  function resetScrollAnchors() {
    scrollAnchors = [];
    if (pixelScroll && pixelScroll.scrollHeight > 0 && totalHeight > 0) {
      scrollAnchors.push({ realY: 0, minimapY: 0, cellIdx: 0 });
      scrollAnchors.push({ realY: pixelScroll.scrollHeight, minimapY: totalHeight, cellIdx: cells.length });
    }
  }

  function recordAnchorsFromTransition() {
    if (!pixelScroll || !visibleRanges.length || !cellLayouts.length) return;
    const { scrollTop, viewportHeight } = pixelScroll;

    const curStart = visibleRanges[0][0];
    const curEnd = visibleRanges[visibleRanges.length - 1][1]; // exclusive

    if (prevVisStart < 0 || prevVisEnd < 0) {
      // First observation — just store, don't record (we have no delta yet)
      prevVisStart = curStart;
      prevVisEnd = curEnd;
      return;
    }

    // Discontinuous jump (click-to-scroll, programmatic reveal): the prev →
    // cur relationship no longer encodes a single boundary crossing. Any
    // anchor derived from it pairs a new real offset with a stale cell's
    // minimap offset and poisons the whole mapping (non-monotonic entries
    // produce tiny / inverted viewport indicators). Skip.
    const JUMP_STEP = 3;
    const disjoint = curEnd <= prevVisStart || curStart >= prevVisEnd;
    const bigStep =
      Math.abs(curStart - prevVisStart) > JUMP_STEP ||
      Math.abs(curEnd - prevVisEnd) > JUMP_STEP;
    if (disjoint || bigStep) {
      prevVisStart = curStart;
      prevVisEnd = curEnd;
      return;
    }

    // Only record when a cell boundary actually transitioned. At that
    // instant the boundary's real pixel offset equals scrollTop (top edge)
    // or scrollTop + viewportHeight (bottom edge).

    // Scrolled down: cell(s) left top → curStart's top ≈ scrollTop
    if (curStart > prevVisStart && curStart < cellLayouts.length) {
      upsertAnchor(scrollTop, cellLayouts[curStart].top, curStart);
    }

    // Scrolled down: cell(s) entered bottom → the newly-appeared cell's
    // top ≈ scrollTop + viewportHeight.  Skip when prevVisEnd collapses
    // onto the cell we just anchored at the top (the viewport shifted
    // fully past the prior cell into a single new one — the bottom edge
    // is somewhere inside that same cell, not at its top).
    if (curEnd > prevVisEnd && prevVisEnd < cellLayouts.length && prevVisEnd !== curStart) {
      upsertAnchor(scrollTop + viewportHeight, cellLayouts[prevVisEnd].top, prevVisEnd);
    }

    // Scrolled up: cell(s) entered top → prev first cell's top ≈ scrollTop
    if (curStart < prevVisStart && prevVisStart < cellLayouts.length) {
      upsertAnchor(scrollTop, cellLayouts[prevVisStart].top, prevVisStart);
    }

    // Scrolled up: cell(s) left bottom → curEnd boundary ≈ bottom of viewport.
    // Same collapsed-edge guard as the scrolled-down case.
    if (curEnd < prevVisEnd && curEnd >= 0 && curEnd < cellLayouts.length && curEnd !== prevVisStart) {
      upsertAnchor(scrollTop + viewportHeight, cellLayouts[curEnd].top, curEnd);
    }

    prevVisStart = curStart;
    prevVisEnd = curEnd;
  }

  function upsertAnchor(realY, minimapY, cellIdx) {
    const MERGE_DIST = 3;
    // Merge with a near-duplicate real offset (keep one anchor per scroll
    // position; the newer observation is more accurate).
    for (let i = 0; i < scrollAnchors.length; i++) {
      if (Math.abs(scrollAnchors[i].realY - realY) < MERGE_DIST) {
        // Refuse the update if it would break monotonicity with neighbors.
        const prev = i > 0 ? scrollAnchors[i - 1] : null;
        const next = i < scrollAnchors.length - 1 ? scrollAnchors[i + 1] : null;
        if (prev && minimapY < prev.minimapY) return;
        if (next && minimapY > next.minimapY) return;
        scrollAnchors[i].realY = realY;
        scrollAnchors[i].minimapY = minimapY;
        scrollAnchors[i].cellIdx = cellIdx;
        return;
      }
    }
    // Find insertion position by realY.
    let insertIdx = scrollAnchors.length;
    for (let i = 0; i < scrollAnchors.length; i++) {
      if (scrollAnchors[i].realY > realY) {
        insertIdx = i;
        break;
      }
    }
    // Reject any anchor that would make the table non-monotonic. A
    // monotonic table is an invariant that `mapRealToMinimap` relies on;
    // one bad entry produces nonsense viewport indicators everywhere the
    // interpolation crosses it.
    const prev = insertIdx > 0 ? scrollAnchors[insertIdx - 1] : null;
    const next = insertIdx < scrollAnchors.length ? scrollAnchors[insertIdx] : null;
    if (prev && minimapY < prev.minimapY) return;
    if (next && minimapY > next.minimapY) return;
    scrollAnchors.splice(insertIdx, 0, { realY, minimapY, cellIdx });
  }

  /**
   * Two-segment piecewise-linear mapping from real notebook Y to minimap Y.
   *
   * When two consecutive anchors span exactly one cell (cellIdx difference = 1),
   * the real span is split into a code portion (~lineCount * EST_PX_PER_CODE_LINE)
   * and an output portion (remainder). The minimap span is split proportionally
   * by headerH+bodyH (code) vs outputsH. This prevents the indicator from racing
   * through large outputs that occupy many real pixels but few minimap pixels.
   *
   * Falls back to simple linear interpolation when the span doesn't cover exactly
   * one cell.
   */
  /**
   * Locate a realY in cellLayoutReal and return intra-cell two-segment
   * interpolation. This is the *exact* path — real cell boundaries come
   * straight from NotebookCellList via the proposed API — so the mapping
   * stays accurate under zoom, resize, and output rendering without any
   * calibration scrolling by the user. Returns null when cellLayoutReal
   * isn't available or the math doesn't line up; caller should fall back.
   */
  function mapRealToMinimapExact(realY) {
    if (!cellLayoutReal || cellLayoutReal.length < 2 || !cellLayouts.length) return null;
    if (cellLayoutReal.length !== cellLayouts.length + 1) return null;
    if (totalHeight <= 0) return null;

    // Clamp to the real scroll range.
    const first = cellLayoutReal[0];
    const last = cellLayoutReal[cellLayoutReal.length - 1];
    if (realY <= first) return 0;
    if (realY >= last) return totalHeight;

    // Binary search for the cell containing realY.
    let lo = 0;
    let hi = cellLayoutReal.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (cellLayoutReal[mid] <= realY) lo = mid;
      else hi = mid;
    }
    const ci = lo;
    if (ci < 0 || ci >= cellLayouts.length) return null;

    const cellRealTop = cellLayoutReal[ci];
    const cellRealBot = cellLayoutReal[ci + 1];
    const realCellH = cellRealBot - cellRealTop;
    if (realCellH <= 0) return cellLayouts[ci].top;

    const lay = cellLayouts[ci];
    const cell = cells[ci];
    const minimapCellTop = lay.top;
    const minimapCodePx = lay.headerH + lay.bodyH;
    const minimapOutputPx = lay.outputsH;

    const offset = realY - cellRealTop;

    // Two-segment intra-cell mapping: split real cell height into a code
    // portion (estimated from lineCount × per-line px) and an output
    // portion (remainder). Maps each to the minimap's own code / output
    // sub-regions so a tall output that's compressed on the minimap
    // doesn't make the overlay race through it.
    const realCodePx = cell ? Math.min(cell.lineCount * EST_PX_PER_CODE_LINE, realCellH * 0.95) : realCellH;
    const realOutputPx = realCellH - realCodePx;

    if (cell && realOutputPx > 0 && minimapOutputPx > 0 && minimapCodePx > 0) {
      if (offset <= realCodePx) {
        const frac = realCodePx > 0 ? offset / realCodePx : 0;
        return minimapCellTop + frac * minimapCodePx;
      }
      const outputOffset = offset - realCodePx;
      const frac = realOutputPx > 0 ? outputOffset / realOutputPx : 0;
      return minimapCellTop + minimapCodePx + frac * minimapOutputPx;
    }

    // Single-segment cell: just scale across the full cell layout.
    const frac = offset / realCellH;
    return minimapCellTop + frac * lay.height;
  }

  /** Inverse of mapRealToMinimapExact. */
  function mapMinimapToRealExact(minimapY) {
    if (!cellLayoutReal || cellLayoutReal.length < 2 || !cellLayouts.length) return null;
    if (cellLayoutReal.length !== cellLayouts.length + 1) return null;
    if (totalHeight <= 0) return null;

    if (minimapY <= 0) return cellLayoutReal[0];
    if (minimapY >= totalHeight) return cellLayoutReal[cellLayoutReal.length - 1];

    // Binary search for the minimap cell containing minimapY.
    let lo = 0;
    let hi = cellLayouts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (cellLayouts[mid].top <= minimapY) lo = mid;
      else hi = mid - 1;
    }
    const ci = lo;
    const lay = cellLayouts[ci];
    const cell = cells[ci];
    const minimapCellTop = lay.top;
    const minimapCodePx = lay.headerH + lay.bodyH;
    const minimapOutputPx = lay.outputsH;

    const cellRealTop = cellLayoutReal[ci];
    const cellRealBot = cellLayoutReal[ci + 1];
    const realCellH = cellRealBot - cellRealTop;
    if (realCellH <= 0) return cellRealTop;

    const realCodePx = cell ? Math.min(cell.lineCount * EST_PX_PER_CODE_LINE, realCellH * 0.95) : realCellH;
    const realOutputPx = realCellH - realCodePx;
    const offset = minimapY - minimapCellTop;

    if (cell && realOutputPx > 0 && minimapOutputPx > 0 && minimapCodePx > 0) {
      if (offset <= minimapCodePx) {
        const frac = minimapCodePx > 0 ? offset / minimapCodePx : 0;
        return cellRealTop + frac * realCodePx;
      }
      const outputOffset = offset - minimapCodePx;
      const frac = minimapOutputPx > 0 ? outputOffset / minimapOutputPx : 0;
      return cellRealTop + realCodePx + frac * realOutputPx;
    }

    const frac = lay.height > 0 ? offset / lay.height : 0;
    return cellRealTop + frac * realCellH;
  }

  function mapRealToMinimap(realY) {
    const exact = mapRealToMinimapExact(realY);
    if (exact !== null) return exact;

    const n = scrollAnchors.length;
    if (n < 2) return totalHeight > 0 ? (realY / (pixelScroll?.scrollHeight || 1)) * totalHeight : 0;
    if (realY <= scrollAnchors[0].realY) return scrollAnchors[0].minimapY;
    if (realY >= scrollAnchors[n - 1].realY) return scrollAnchors[n - 1].minimapY;
    let lo = 0;
    let hi = n - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (scrollAnchors[mid].realY <= realY) lo = mid;
      else hi = mid;
    }
    const a = scrollAnchors[lo];
    const b = scrollAnchors[hi];
    const realSpan = b.realY - a.realY;
    if (realSpan === 0) return a.minimapY;
    const minimapSpan = b.minimapY - a.minimapY;

    // Two-segment calibration when the anchor pair spans exactly one cell.
    if (b.cellIdx - a.cellIdx === 1) {
      const ci = a.cellIdx;
      if (ci >= 0 && ci < cells.length && ci < cellLayouts.length) {
        const cell = cells[ci];
        const lay = cellLayouts[ci];
        const realCodePx = cell.lineCount * EST_PX_PER_CODE_LINE;
        const realOutputPx = realSpan - realCodePx;
        const minimapCodePx = lay.headerH + lay.bodyH;
        const minimapOutputPx = lay.outputsH;
        if (realCodePx > 0 && realOutputPx > 0 && minimapCodePx > 0) {
          const offset = realY - a.realY;
          if (offset <= realCodePx) {
            // In the code portion
            const frac = offset / realCodePx;
            return a.minimapY + frac * minimapCodePx;
          } else {
            // In the output portion
            const outputOffset = offset - realCodePx;
            const frac = minimapOutputPx > 0 ? outputOffset / realOutputPx : 0;
            return a.minimapY + minimapCodePx + frac * minimapOutputPx;
          }
        }
      }
    }

    // Fallback: simple linear interpolation
    const frac = (realY - a.realY) / realSpan;
    return a.minimapY + frac * minimapSpan;
  }

  /**
   * Inverse of mapRealToMinimap: given a minimap Y coordinate, compute the
   * corresponding real notebook scrollTop using the same two-segment logic.
   */
  function mapMinimapToReal(minimapY) {
    const exact = mapMinimapToRealExact(minimapY);
    if (exact !== null) return exact;

    const n = scrollAnchors.length;
    if (n < 2) return totalHeight > 0 ? (minimapY / totalHeight) * (pixelScroll?.scrollHeight || 0) : 0;
    if (minimapY <= scrollAnchors[0].minimapY) return scrollAnchors[0].realY;
    if (minimapY >= scrollAnchors[n - 1].minimapY) return scrollAnchors[n - 1].realY;
    let lo = 0;
    let hi = n - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (scrollAnchors[mid].minimapY <= minimapY) lo = mid;
      else hi = mid;
    }
    const a = scrollAnchors[lo];
    const b = scrollAnchors[hi];
    const minimapSpan = b.minimapY - a.minimapY;
    if (minimapSpan === 0) return a.realY;
    const realSpan = b.realY - a.realY;

    // Two-segment inverse when the anchor pair spans exactly one cell.
    if (b.cellIdx - a.cellIdx === 1) {
      const ci = a.cellIdx;
      if (ci >= 0 && ci < cells.length && ci < cellLayouts.length) {
        const cell = cells[ci];
        const lay = cellLayouts[ci];
        const realCodePx = cell.lineCount * EST_PX_PER_CODE_LINE;
        const realOutputPx = realSpan - realCodePx;
        const minimapCodePx = lay.headerH + lay.bodyH;
        const minimapOutputPx = lay.outputsH;
        if (realCodePx > 0 && realOutputPx > 0 && minimapCodePx > 0) {
          const offset = minimapY - a.minimapY;
          if (offset <= minimapCodePx) {
            // In the code portion
            const frac = offset / minimapCodePx;
            return a.realY + frac * realCodePx;
          } else {
            // In the output portion
            const outputOffset = offset - minimapCodePx;
            const frac = minimapOutputPx > 0 ? outputOffset / minimapOutputPx : 0;
            return a.realY + realCodePx + frac * realOutputPx;
          }
        }
      }
    }

    // Fallback: simple linear interpolation
    const frac = (minimapY - a.minimapY) / minimapSpan;
    return a.realY + frac * realSpan;
  }

  // ── Viewport indicator ─────────────────────────────────────────────────────

  function updateViewportIndicator() {
    cancelViewportAnim();
    if (cellLayouts.length === 0) {
      viewportIndicator.style.display = 'none';
      return;
    }

    // Pixel-accurate path: use the anchor table to map real scroll coords
    // to minimap coords. The table self-corrects as the user scrolls past
    // cell boundaries, so the mapping is exact at every cell boundary
    // they've visited and approximately correct everywhere else.
    if (pixelScroll && pixelScroll.scrollHeight > 0 && totalHeight > 0) {
      const topM = mapRealToMinimap(pixelScroll.scrollTop);
      const botM = mapRealToMinimap(pixelScroll.scrollTop + pixelScroll.viewportHeight);
      const h = Math.max(metrics.lineH * 2, Math.round(botM - topM));
      const top = Math.max(0, Math.min(totalHeight - h, Math.round(topM)));
      viewportIndicator.style.display = 'block';
      viewportIndicator.style.top = top + 'px';
      viewportIndicator.style.height = h + 'px';
      if (config.followActiveCell) autoScroll();
      return;
    }

    if (!visibleRanges || visibleRanges.length === 0) {
      viewportIndicator.style.display = 'none';
      return;
    }
    let spanTop = Infinity;
    let spanBottom = 0;
    let visibleCellCount = 0;
    for (const range of visibleRanges) {
      const s = clampIdx(range[0], 0, cellLayouts.length - 1);
      const eExclusive = clampIdx(range[1], 0, cellLayouts.length);
      if (eExclusive <= s) continue;
      const e = eExclusive - 1;
      spanTop = Math.min(spanTop, cellLayouts[s].top);
      spanBottom = Math.max(spanBottom, cellLayouts[e].top + cellLayouts[e].height);
      visibleCellCount += e - s + 1;
    }
    if (!isFinite(spanTop) || spanBottom <= spanTop) {
      viewportIndicator.style.display = 'none';
      return;
    }
    const spanH = spanBottom - spanTop;

    // Update viewport-height estimate from frames where the span is unlikely
    // to be dominated by a single huge cell.
    if (visibleCellCount >= 2 && visibleCellCount <= 8) {
      viewportHEst = viewportHEst === 0 ? spanH : viewportHEst * 0.82 + spanH * 0.18;
    }
    // Fallback so the "tooTall" branch can fire even when we've never had a
    // multi-cell frame to sample from — e.g. the user opens a notebook whose
    // first visible cell is a huge one. Roughly 40 minimap rows ≈ a typical
    // notebook viewport.
    const effectiveViewportH =
      viewportHEst > 0 ? viewportHEst : Math.max(60, metrics.lineH * 40);

    // Update velocity model from this transition. We infer a scroll direction
    // and speed (minimap px/ms) from whichever span edge advanced, capped at
    // MAX_SPEED so a huge jump doesn't poison the estimate.
    const now = performance.now();
    const spanChanged =
      Math.abs(spanTop - prevSpanTop) > 0.5 || Math.abs(spanBottom - prevSpanBottom) > 0.5;
    if (spanChanged) {
      if (lastTransitionTime > 0) {
        const dt = now - lastTransitionTime;
        if (dt > 8 && dt < 2500) {
          const delta = Math.max(
            Math.abs(spanTop - prevSpanTop),
            Math.abs(spanBottom - prevSpanBottom)
          );
          if (delta > 0.5) {
            const inst = Math.min(MAX_SPEED, delta / dt);
            scrollSpeed = scrollSpeed === 0 ? inst : scrollSpeed * 0.55 + inst * 0.45;
          }
        }
      }
      if (spanBottom > prevSpanBottom + 0.5) scrollDir = 1;
      else if (spanTop < prevSpanTop - 0.5) scrollDir = -1;
      else if (spanTop > prevSpanTop + 0.5) scrollDir = 1;
      else if (spanBottom < prevSpanBottom - 0.5) scrollDir = -1;
      // Seed a modest default velocity on the first transition so a cold
      // scroll straight into a tall cell still animates a little instead of
      // freezing. Real samples take over from the next transition onward.
      if (scrollDir !== 0 && scrollSpeed === 0) scrollSpeed = 0.15;
      lastTransitionTime = now;
    }

    let indicatorTop = spanTop;
    let indicatorH = spanH;

    const tooTall = spanH > effectiveViewportH * 1.4;
    if (tooTall) {
      const minH = Math.max(metrics.lineH * 4, 8);
      const clampedH = Math.max(minH, Math.min(spanH, Math.round(effectiveViewportH)));
      // Anchor the clamped overlay using whichever span edge just transitioned.
      // A visibleRanges change only fires when a cell enters or leaves view, so
      // the transition tells us where the real viewport edge currently sits.
      //   * new cell entered at bottom → viewport bottom was at prevSpanBottom
      //   * new cell entered at top    → viewport top was at prevSpanTop
      //   * cell left from top         → viewport top is now at spanTop
      //   * cell left from bottom      → viewport bottom is now at spanBottom
      const enteredBottom = spanBottom > prevSpanBottom + 0.5;
      const enteredTop = spanTop < prevSpanTop - 0.5;
      const leftTop = spanTop > prevSpanTop + 0.5;
      const leftBottom = spanBottom < prevSpanBottom - 0.5;
      let anchored;
      if (enteredBottom) {
        anchored = prevSpanBottom - clampedH;
      } else if (enteredTop) {
        anchored = prevSpanTop;
      } else if (leftTop) {
        anchored = spanTop;
      } else if (leftBottom) {
        anchored = spanBottom - clampedH;
      } else {
        anchored = spanTop;
      }
      indicatorTop = Math.max(spanTop, Math.min(spanBottom - clampedH, anchored));
      indicatorH = clampedH;
    }

    prevSpanTop = spanTop;
    prevSpanBottom = spanBottom;

    viewportIndicator.style.display = 'block';
    viewportIndicator.style.top = indicatorTop + 'px';
    viewportIndicator.style.height = indicatorH + 'px';

    // Kick off the extrapolation animation when we're inside a tall cell and
    // we have a recent velocity sample.
    animBaseTop = indicatorTop;
    animSpanTop = spanTop;
    animSpanBottom = spanBottom;
    animH = indicatorH;
    animMs = computeAnimMs(scrollSpeed);
    if (tooTall && scrollSpeed > 0 && scrollDir !== 0 && lastTransitionTime > 0 && animMs > 0) {
      scheduleViewportAnim();
    }
  }

  function computeAnimMs(speed) {
    if (speed <= 0) return 0;
    const target = (2 * MAX_DRIFT_PX) / speed;
    return Math.max(MIN_ANIM_MS, Math.min(MAX_ANIM_MS_CAP, target));
  }

  function scheduleViewportAnim() {
    if (animFrame !== null) return;
    viewportIndicator.classList.add('animating');
    animFrame = requestAnimationFrame(stepViewportAnim);
  }

  function cancelViewportAnim() {
    if (animFrame !== null) {
      cancelAnimationFrame(animFrame);
      animFrame = null;
    }
    viewportIndicator.classList.remove('animating');
  }

  function stepViewportAnim() {
    animFrame = null;
    const elapsed = performance.now() - lastTransitionTime;
    if (elapsed >= animMs || animMs <= 0 || scrollSpeed === 0 || scrollDir === 0) {
      viewportIndicator.classList.remove('animating');
      return;
    }

    // Monotonic ease-out displacement: integral of a decaying velocity so the
    // overlay moves quickly at first and coasts to a stop. Integrating
    //     v(τ) = speed * max(0, 1 - τ/T)
    // gives
    //     d(t)  = speed * (t - t²/(2T))  for t ≤ T,
    //     d(T)  = speed * T/2  =  MAX_DRIFT_PX (by construction of T).
    const t = Math.min(elapsed, animMs);
    const displacement = scrollSpeed * (t - (t * t) / (2 * animMs)) * scrollDir;
    const newTop = Math.max(
      animSpanTop,
      Math.min(animSpanBottom - animH, animBaseTop + displacement)
    );
    viewportIndicator.style.top = newTop + 'px';

    // Keep the overlay in view as it advances through a tall cell that
    // extends past the minimap's own scroll viewport.
    if (config.followActiveCell) autoScroll();

    if (elapsed < animMs) {
      animFrame = requestAnimationFrame(stepViewportAnim);
    }
  }

  function resetViewportModel() {
    cancelViewportAnim();
    viewportHEst = 0;
    prevSpanTop = 0;
    prevSpanBottom = 0;
    scrollSpeed = 0;
    scrollDir = 0;
    lastTransitionTime = 0;
    animMs = 0;
    pixelScroll = null;
    cellLayoutReal = null;
    scrollAnchors = [];
    prevVisStart = -1;
    prevVisEnd = -1;
    anchorRecordPending = false;
    if (pendingScrollRAF !== null) {
      cancelAnimationFrame(pendingScrollRAF);
      pendingScrollRAF = null;
    }
    pendingScrollMsg = null;
  }

  function updateActiveCellMarker() {
    if (activeCellIndex < 0 || activeCellIndex >= cellLayouts.length) {
      activeCellMarker.style.display = 'none';
      return;
    }
    const layout = cellLayouts[activeCellIndex];
    activeCellMarker.style.display = 'block';
    activeCellMarker.style.top = layout.top + 'px';
    activeCellMarker.style.height = layout.height + 'px';
  }

  // Suppresses autoScroll while the user is navigating via the minimap.
  // Clicking / dragging on the minimap produces scroll events that would
  // otherwise pull the minimap's own scroll to keep the overlay in view —
  // which means the spot the user just clicked jumps out from under them.
  // Set by sendRevealAt; decays on its own.
  let autoScrollSuppressUntil = 0;

  function autoScroll() {
    if (performance.now() < autoScrollSuppressUntil) return;
    autoScrollImpl();
  }
  function autoScrollImpl() {
    if (visibleRanges.length === 0 || cellLayouts.length === 0) return;
    const viewportH = container.getBoundingClientRect().height;
    if (totalHeight <= viewportH) {
      scroll.scrollTop = 0;
      return;
    }
    const top = parseFloat(viewportIndicator.style.top) || 0;
    const height = parseFloat(viewportIndicator.style.height) || 0;
    const bottom = top + height;
    const margin = 24;
    if (top < scroll.scrollTop + margin) {
      scroll.scrollTop = Math.max(0, top - margin);
    } else if (bottom > scroll.scrollTop + viewportH - margin) {
      scroll.scrollTop = Math.min(totalHeight - viewportH, bottom - viewportH + margin);
    }
  }

  function clampIdx(n, lo, hi) {
    if (n < lo) return lo;
    if (n > hi) return hi;
    return n;
  }

  // ── Interaction ────────────────────────────────────────────────────────────

  function findCellAt(y) {
    if (cellLayouts.length === 0) return -1;
    let lo = 0;
    let hi = cellLayouts.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const layout = cellLayouts[mid];
      if (y < layout.top) hi = mid - 1;
      else if (y >= layout.top + layout.height) lo = mid + 1;
      else return mid;
    }
    return clampIdx(lo, 0, cellLayouts.length - 1);
  }

  function pointerStageY(e) {
    const rect = stage.getBoundingClientRect();
    return e.clientY - rect.top;
  }

  let isDragging = false;
  let lastSentCell = -1;

  function onPointerDown(e) {
    if (e.button !== 0) return;
    if (cells.length === 0 || notebookId == null) return;
    isDragging = true;
    viewportIndicator.classList.add('dragging');
    try { stage.setPointerCapture(e.pointerId); } catch (_) { /* noop */ }
    sendRevealAt(e, true);
    e.preventDefault();
  }

  function onPointerMove(e) {
    if (!isDragging) return;
    sendRevealAt(e, false);
  }

  function onPointerEnd(e) {
    if (!isDragging) return;
    isDragging = false;
    viewportIndicator.classList.remove('dragging');
    try { stage.releasePointerCapture(e.pointerId); } catch (_) { /* noop */ }
    lastSentCell = -1;
  }

  function sendRevealAt(e, isClick) {
    // Clicks/drags drive the editor scroll, which bounces back as a
    // setScrollState event that would otherwise trigger autoScroll on the
    // minimap itself. Suppress it briefly — the user's cursor position on
    // the minimap is what they're watching, not the overlay position.
    autoScrollSuppressUntil = performance.now() + 350;
    const y = pointerStageY(e);
    const idx = findCellAt(y);
    if (idx < 0) return;

    // When pixel scroll state is available and we have anchors, use the
    // inverse mapping to compute an exact scrollTop target.
    if (pixelScroll && scrollAnchors.length >= 2) {
      const targetScrollTop = mapMinimapToReal(y);
      // Center the click point in the viewport
      const centered = Math.max(0, targetScrollTop - pixelScroll.viewportHeight / 2);
      vscode.postMessage({ type: 'scrollTo', notebookId, scrollTop: centered });
      lastSentCell = idx;
      return;
    }

    // Fallback: cell-level reveal
    if (!isClick && idx === lastSentCell) return;
    lastSentCell = idx;
    const layout = cellLayouts[idx];
    const atTop = (y - layout.top) < layout.height * 0.3;
    vscode.postMessage({ type: 'reveal', notebookId, cellIndex: idx, atTop });
  }

  stage.addEventListener('pointerdown', onPointerDown);
  stage.addEventListener('pointermove', onPointerMove);
  stage.addEventListener('pointerup', onPointerEnd);
  stage.addEventListener('pointercancel', onPointerEnd);

  // Resize observer. Defer all DOM work to a subsequent animation frame so
  // no writes land inside the observer callback itself — Chromium emits
  // "ResizeObserver loop completed with undelivered notifications" whenever
  // it detects writes during the observation cycle that could plausibly
  // produce further resize events, even when they don't.
  let resizeRAF = null;
  const ro = new ResizeObserver(() => {
    if (resizeRAF !== null) return;
    resizeRAF = requestAnimationFrame(() => {
      resizeRAF = null;
      scheduleDraw();
    });
  });
  ro.observe(container);

  // Chromium logs the above "ResizeObserver loop" message at INFO level
  // whenever layout writes land adjacent to observer fires — even when no
  // real loop exists. It floods the console during active scrolling /
  // tokenization rollouts. Silence just that one string; preserve every
  // other error.
  window.addEventListener('error', (e) => {
    if (e && typeof e.message === 'string' &&
      e.message.indexOf('ResizeObserver loop') !== -1) {
      e.stopImmediatePropagation();
      e.preventDefault();
    }
  });

  // Theme change observer
  const themeObserver = new MutationObserver(() => {
    palette = readPalette();
    scheduleDraw();
  });
  themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });

  // ── Message dispatch ───────────────────────────────────────────────────────

  function showEmpty() {
    emptyState.hidden = false;
    container.hidden = true;
  }

  function showContent() {
    emptyState.hidden = true;
    container.hidden = false;
  }

  function applySetNotebook(msg) {
    notebookId = msg.notebookId;
    cells = msg.cells || [];
    config = msg.config || config;
    visibleRanges = Array.isArray(msg.visibleRanges) ? msg.visibleRanges : [];
    activeCellIndex = typeof msg.activeCell === 'number' ? msg.activeCell : -1;
    resetViewportModel();
    pruneImageCache();
    if (cells.length === 0) {
      emptyState.textContent = 'This notebook has no cells yet.';
      showEmpty();
    } else {
      showContent();
      scheduleDraw();
    }
  }

  window.addEventListener('message', (ev) => {
    const msg = ev.data;
    if (!msg || typeof msg.type !== 'string') return;
    switch (msg.type) {
      case 'setNotebook':
        applySetNotebook(msg);
        break;
      case 'updateCell':
        if (msg.notebookId !== notebookId) return;
        if (msg.cell.index >= 0 && msg.cell.index < cells.length) {
          cells[msg.cell.index] = msg.cell;
          pruneImageCache();
          scheduleDraw();
        }
        break;
      case 'replaceCells':
        if (msg.notebookId !== notebookId) return;
        cells.splice(msg.start, msg.deleteCount, ...msg.cells);
        for (let i = 0; i < cells.length; i++) cells[i].index = i;
        pruneImageCache();
        if (cells.length === 0) showEmpty();
        else scheduleDraw();
        break;
      case 'setViewport':
        if (msg.notebookId !== notebookId) return;
        visibleRanges = Array.isArray(msg.visibleRanges) ? msg.visibleRanges : [];
        // Don't record anchors here — pixelScroll may still hold a stale
        // scrollTop from before this visibleRanges change.  Set a flag so
        // the next setScrollState (which carries the fresh scrollTop) does
        // the recording.
        anchorRecordPending = true;
        updateViewportIndicator();
        if (config.followActiveCell) autoScroll();
        break;
      case 'setActiveCell':
        if (msg.notebookId !== notebookId) return;
        activeCellIndex = typeof msg.index === 'number' ? msg.index : -1;
        updateActiveCellMarker();
        break;
      case 'setScrollState':
        if (msg.notebookId !== notebookId) return;
        queueScrollState(msg);
        break;
      case 'setTokenColors':
        themeTokenColors = msg.tokenColors || {};
        palette = readPalette();
        scheduleDraw();
        break;
      case 'setCellTokens':
        if (msg.notebookId !== notebookId) return;
        if (msg.cellIndex >= 0 && msg.cellIndex < cells.length) {
          cells[msg.cellIndex].tokens = msg.tokens;
          scheduleDraw();
        }
        break;
      case 'setConfig':
        config = msg.config;
        scheduleDraw();
        break;
      case 'clear':
        notebookId = null;
        cells = [];
        cellLayouts = [];
        visibleRanges = [];
        activeCellIndex = -1;
        totalHeight = 0;
        resetViewportModel();
        imageCache.clear();
        emptyState.textContent = 'Open a notebook to see its minimap.';
        showEmpty();
        break;
    }
  });

  showEmpty();
  vscode.postMessage({ type: 'ready' });
})();
