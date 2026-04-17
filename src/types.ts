export type CellKind = 'code' | 'markup';

export type OutputItem =
  | { kind: 'text'; lines: string[]; stream?: 'stdout' | 'stderr' }
  | { kind: 'image'; dataUrl: string; naturalWidth: number; naturalHeight: number }
  | { kind: 'html'; lines: string[] }
  | { kind: 'other'; label: string };

export interface CellData {
  index: number;
  kind: CellKind;
  languageId: string;
  text: string;
  lineCount: number;
  outputs: OutputItem[];
}

export interface MinimapConfig {
  maxColumn: number;
  renderCharacters: boolean;
  scale: number;
  showCellBoundaries: boolean;
  followActiveCell: boolean;
  includeOutputs: boolean;
  renderMarkdownHeadings: boolean;
  maxImageHeightRows: number;
  fillPanelWidth: boolean;
}

export type VisibleRangeTuple = readonly [number, number];

export type ExtensionMessage =
  | {
      type: 'setNotebook';
      notebookId: string;
      cells: CellData[];
      config: MinimapConfig;
      visibleRanges: VisibleRangeTuple[];
      activeCell: number;
    }
  | { type: 'updateCell'; notebookId: string; cell: CellData }
  | {
      type: 'replaceCells';
      notebookId: string;
      start: number;
      deleteCount: number;
      cells: CellData[];
    }
  | { type: 'setViewport'; notebookId: string; visibleRanges: VisibleRangeTuple[] }
  | { type: 'setActiveCell'; notebookId: string; index: number }
  | {
      type: 'setScrollState';
      notebookId: string;
      scrollTop: number;
      scrollHeight: number;
      viewportHeight: number;
      cellLayout?: readonly number[];
    }
  | { type: 'setConfig'; config: MinimapConfig }
  | { type: 'clear' };

export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'reveal'; notebookId: string; cellIndex: number; atTop?: boolean }
  | { type: 'scrollTo'; notebookId: string; scrollTop: number };
