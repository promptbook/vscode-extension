import * as vscode from 'vscode';

export class PromptbookEditorProvider implements vscode.CustomTextEditorProvider {
  public static readonly viewType = 'promptbook.editor';

  public static register(context: vscode.ExtensionContext): vscode.Disposable {
    const provider = new PromptbookEditorProvider(context);
    return vscode.window.registerCustomEditorProvider(
      PromptbookEditorProvider.viewType,
      provider,
      {
        webviewOptions: {
          retainContextWhenHidden: true,
        },
      }
    );
  }

  constructor(private readonly context: vscode.ExtensionContext) {}

  public async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri],
    };

    webviewPanel.webview.html = this.getHtmlForWebview(webviewPanel.webview);

    // Send initial document content to webview
    const updateWebview = () => {
      webviewPanel.webview.postMessage({
        type: 'update',
        content: document.getText(),
      });
    };

    // Listen for document changes
    const changeDocumentSubscription = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() === document.uri.toString()) {
        updateWebview();
      }
    });

    webviewPanel.onDidDispose(() => {
      changeDocumentSubscription.dispose();
    });

    // Handle messages from webview
    webviewPanel.webview.onDidReceiveMessage((message) => {
      switch (message.type) {
        case 'save':
          this.updateDocument(document, message.content);
          break;
        case 'run':
          this.runCell(message.cellId);
          break;
        case 'sync':
          this.syncCell(message.cellId, message.direction);
          break;
      }
    });

    updateWebview();
  }

  private getHtmlForWebview(_webview: vscode.Webview): string {
    // TODO: Load actual React bundle
    return `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Promptbook</title>
        <style>
          body { font-family: var(--vscode-font-family); padding: 20px; }
          .placeholder { color: var(--vscode-descriptionForeground); }
        </style>
      </head>
      <body>
        <div id="root">
          <p class="placeholder">Promptbook editor loading...</p>
        </div>
        <script>
          const vscode = acquireVsCodeApi();

          window.addEventListener('message', (event) => {
            const message = event.data;
            if (message.type === 'update') {
              // TODO: Update React app with new content
              console.log('Received update:', message.content);
            }
          });
        </script>
      </body>
      </html>
    `;
  }

  private updateDocument(document: vscode.TextDocument, content: string): void {
    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      document.uri,
      new vscode.Range(0, 0, document.lineCount, 0),
      content
    );
    vscode.workspace.applyEdit(edit);
  }

  private async runCell(cellId: string): Promise<void> {
    // TODO: Execute cell via kernel manager
    vscode.window.showInformationMessage(`Running cell: ${cellId}`);
  }

  private async syncCell(
    cellId: string,
    direction: 'toCode' | 'toInstructions'
  ): Promise<void> {
    // TODO: Sync cell via AI provider
    vscode.window.showInformationMessage(`Syncing cell: ${cellId} (${direction})`);
  }
}
