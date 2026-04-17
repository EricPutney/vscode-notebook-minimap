import * as vscode from 'vscode';
import { MinimapPanelController } from './minimapPanel';

const AUTO_OPEN_MEMO_KEY = 'notebookMinimap.autoOpenDoneThisSession';

export function activate(context: vscode.ExtensionContext): void {
  const controller = new MinimapPanelController(context.extensionUri);

  context.subscriptions.push(
    vscode.commands.registerCommand('notebookMinimap.open', () => controller.open()),
    vscode.commands.registerCommand('notebookMinimap.toggle', () => {
      if (controller.isOpen()) controller.close();
      else controller.open();
    }),
    vscode.commands.registerCommand('notebookMinimap.refresh', () => controller.refresh()),
    vscode.commands.registerCommand('notebookMinimap.toggleRenderCharacters', async () => {
      const cfg = vscode.workspace.getConfiguration('notebookMinimap');
      const current = cfg.get<boolean>('renderCharacters', true);
      await cfg.update('renderCharacters', !current, vscode.ConfigurationTarget.Global);
    }),
    vscode.commands.registerCommand('notebookMinimap.toggleFillPanelWidth', async () => {
      const cfg = vscode.workspace.getConfiguration('notebookMinimap');
      const current = cfg.get<boolean>('fillPanelWidth', true);
      await cfg.update('fillPanelWidth', !current, vscode.ConfigurationTarget.Global);
    })
  );

  context.subscriptions.push(
    vscode.window.onDidChangeActiveNotebookEditor(editor => {
      controller.setActiveEditor(editor);
      maybeAutoOpen(context, controller, editor);
    }),
    vscode.window.onDidChangeNotebookEditorVisibleRanges(e => controller.onVisibleRanges(e)),
    vscode.window.onDidChangeNotebookEditorSelection(e => controller.onSelection(e)),
    vscode.workspace.onDidChangeNotebookDocument(e => controller.onNotebookChange(e)),
    vscode.workspace.onDidCloseNotebookDocument(doc => controller.onDocumentClose(doc)),
    vscode.workspace.onDidOpenNotebookDocument(() => {
      // If the panel is open and currently has no editor, try to refresh once
      // an editor for the new document becomes visible.
      if (controller.isOpen()) {
        setTimeout(() => controller.refresh(), 50);
      }
    }),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('notebookMinimap')) controller.onConfigChange();
    })
  );

  // Pixel-level scroll via proposed API `notebookEditorScroll`. Degrades
  // silently on VS Code builds that don't ship the proposal — the webview's
  // velocity-extrapolation path keeps working.
  const scrollApi = (vscode.window as unknown as {
    onDidChangeNotebookEditorScroll?: vscode.Event<{
      notebookEditor: vscode.NotebookEditor;
      scrollTop: number;
      scrollHeight: number;
      viewportHeight: number;
    }>;
  }).onDidChangeNotebookEditorScroll;
  if (typeof scrollApi === 'function') {
    context.subscriptions.push(scrollApi(e => controller.onScrollState(e)));
  }

  // Theme-resolved token colors via proposed `themeTokenColors`. Forward to
  // the controller now and on every theme change so the webview renderer
  // uses the editor's real syntax colors.
  const readTokenColors = () => {
    const themeAny = vscode.window.activeColorTheme as unknown as {
      tokenColors?: {
        default?: string; keyword?: string; string?: string; number?: string;
        comment?: string; function?: string; type?: string; variable?: string;
        operator?: string; constant?: string;
      };
    };
    return themeAny.tokenColors ?? {};
  };
  controller.onThemeChange(readTokenColors());
  context.subscriptions.push(
    vscode.window.onDidChangeActiveColorTheme(() => controller.onThemeChange(readTokenColors()))
  );

  // Seed the controller with the current editor so open() has something to show.
  const seed =
    vscode.window.activeNotebookEditor ?? vscode.window.visibleNotebookEditors?.[0];
  controller.setActiveEditor(seed);

  // Optional auto-open once per window session
  maybeAutoOpen(context, controller, seed);
}

function maybeAutoOpen(
  context: vscode.ExtensionContext,
  controller: MinimapPanelController,
  editor: vscode.NotebookEditor | undefined
): void {
  if (!editor) return;
  if (controller.isOpen()) return;
  const cfg = vscode.workspace.getConfiguration('notebookMinimap');
  if (!cfg.get<boolean>('autoOpenOnNotebook', false)) return;
  if (context.workspaceState.get<boolean>(AUTO_OPEN_MEMO_KEY, false)) return;
  void context.workspaceState.update(AUTO_OPEN_MEMO_KEY, true);
  controller.open(editor);
}

export function deactivate(): void {
  // no-op
}
