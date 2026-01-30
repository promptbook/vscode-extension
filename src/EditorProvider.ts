import * as vscode from 'vscode';
import {
  KernelManager,
  PythonSetup,
  type PythonEnvironment,
  type KernelOutput,
} from '@promptbook/core/kernel';

export class PromptbookEditorProvider implements vscode.CustomTextEditorProvider {
  public static readonly viewType = 'promptbook.editor';

  private static kernelManager: KernelManager | null = null;
  private static pythonSetup: PythonSetup | null = null;
  private static environments: PythonEnvironment[] = [];
  private static selectedEnvironment: PythonEnvironment | null = null;
  private static webviews = new Set<vscode.Webview>();

  public static register(context: vscode.ExtensionContext): vscode.Disposable {
    const provider = new PromptbookEditorProvider(context);

    // Initialize Python setup
    const workspaceDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
    PromptbookEditorProvider.pythonSetup = new PythonSetup(workspaceDir);

    // Scan for environments in background
    PromptbookEditorProvider.scanEnvironments();

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

  private static async scanEnvironments(): Promise<void> {
    if (!PromptbookEditorProvider.pythonSetup) return;
    try {
      PromptbookEditorProvider.environments = await PromptbookEditorProvider.pythonSetup.discoverEnvironments();
    } catch (err) {
      console.error('Failed to scan Python environments:', err);
    }
  }

  private static broadcastToWebviews(message: Record<string, unknown>): void {
    for (const webview of PromptbookEditorProvider.webviews) {
      webview.postMessage(message);
    }
  }

  public static async shutdownKernel(): Promise<void> {
    if (PromptbookEditorProvider.kernelManager) {
      await PromptbookEditorProvider.kernelManager.shutdown();
      PromptbookEditorProvider.kernelManager = null;
    }
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

    // Track this webview
    PromptbookEditorProvider.webviews.add(webviewPanel.webview);

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

    // Set up kernel event listeners
    this.setupKernelEventListeners(webviewPanel.webview);

    webviewPanel.onDidDispose(() => {
      changeDocumentSubscription.dispose();
      PromptbookEditorProvider.webviews.delete(webviewPanel.webview);
    });

    // Handle messages from webview
    webviewPanel.webview.onDidReceiveMessage(async (message) => {
      switch (message.type) {
        case 'save':
          this.updateDocument(document, message.content);
          break;
        case 'kernel:execute':
          await this.handleExecute(webviewPanel.webview, message.code, message.cellId);
          break;
        case 'kernel:interrupt':
          await this.handleInterrupt(webviewPanel.webview);
          break;
        case 'kernel:restart':
          await this.handleRestart(webviewPanel.webview);
          break;
        case 'kernel:getEnvironments':
          webviewPanel.webview.postMessage({
            type: 'kernel:environments',
            environments: PromptbookEditorProvider.environments,
          });
          break;
        case 'kernel:scanEnvironments':
          await PromptbookEditorProvider.scanEnvironments();
          webviewPanel.webview.postMessage({
            type: 'kernel:environments',
            environments: PromptbookEditorProvider.environments,
          });
          break;
        case 'kernel:selectEnvironment':
          await this.handleSelectEnvironment(webviewPanel.webview, message.pythonPath);
          break;
        case 'kernel:installIpykernel':
          await this.handleInstallIpykernel(webviewPanel.webview, message.pythonPath);
          break;
        case 'kernel:getStatus':
          webviewPanel.webview.postMessage({
            type: 'kernel:status',
            state: PromptbookEditorProvider.kernelManager?.getState() || 'disconnected',
            executionCount: PromptbookEditorProvider.kernelManager?.getExecutionCount() || 0,
          });
          break;
        case 'sync':
          await this.syncCell(message.cellId, message.direction);
          break;
      }
    });

    updateWebview();

    // Send initial status
    webviewPanel.webview.postMessage({
      type: 'kernel:status',
      state: PromptbookEditorProvider.kernelManager?.getState() || 'disconnected',
      executionCount: 0,
    });
    webviewPanel.webview.postMessage({
      type: 'kernel:environments',
      environments: PromptbookEditorProvider.environments,
    });
  }

  private setupKernelEventListeners(webview: vscode.Webview): void {
    if (!PromptbookEditorProvider.kernelManager) return;

    PromptbookEditorProvider.kernelManager.on('output', (output: KernelOutput, msgId: string) => {
      webview.postMessage({
        type: 'kernel:output',
        output,
        msgId,
      });
    });

    PromptbookEditorProvider.kernelManager.on('stateChange', (state: string) => {
      PromptbookEditorProvider.broadcastToWebviews({
        type: 'kernel:stateChange',
        state,
      });
    });

    PromptbookEditorProvider.kernelManager.on('error', (error: Error) => {
      webview.postMessage({
        type: 'kernel:error',
        error: error.message,
      });
    });
  }

  private async handleExecute(webview: vscode.Webview, code: string, cellId: string): Promise<void> {
    if (!PromptbookEditorProvider.kernelManager) {
      webview.postMessage({
        type: 'kernel:executeResult',
        cellId,
        success: false,
        error: 'No kernel running',
        needsEnvironment: true,
      });
      return;
    }

    try {
      const result = await PromptbookEditorProvider.kernelManager.execute(code);
      webview.postMessage({
        type: 'kernel:executeResult',
        cellId,
        success: true,
        msgId: result.msgId,
        outputs: result.outputs,
      });
    } catch (err) {
      webview.postMessage({
        type: 'kernel:executeResult',
        cellId,
        success: false,
        error: String(err),
      });
    }
  }

  private async handleInterrupt(webview: vscode.Webview): Promise<void> {
    if (!PromptbookEditorProvider.kernelManager) {
      webview.postMessage({
        type: 'kernel:interruptResult',
        success: false,
        error: 'No kernel running',
      });
      return;
    }

    try {
      await PromptbookEditorProvider.kernelManager.interrupt();
      webview.postMessage({
        type: 'kernel:interruptResult',
        success: true,
      });
    } catch (err) {
      webview.postMessage({
        type: 'kernel:interruptResult',
        success: false,
        error: String(err),
      });
    }
  }

  private async handleRestart(webview: vscode.Webview): Promise<void> {
    if (!PromptbookEditorProvider.kernelManager) {
      webview.postMessage({
        type: 'kernel:restartResult',
        success: false,
        error: 'No kernel running',
      });
      return;
    }

    try {
      await PromptbookEditorProvider.kernelManager.restart();
      webview.postMessage({
        type: 'kernel:restartResult',
        success: true,
      });
    } catch (err) {
      webview.postMessage({
        type: 'kernel:restartResult',
        success: false,
        error: String(err),
      });
    }
  }

  private async handleSelectEnvironment(webview: vscode.Webview, pythonPath: string): Promise<void> {
    try {
      // Shutdown existing kernel
      if (PromptbookEditorProvider.kernelManager) {
        await PromptbookEditorProvider.kernelManager.shutdown();
      }

      // Find the environment
      const env = PromptbookEditorProvider.environments.find((e) => e.path === pythonPath);
      if (!env) {
        webview.postMessage({
          type: 'kernel:selectEnvironmentResult',
          success: false,
          error: 'Environment not found',
        });
        return;
      }

      // Check if ipykernel is installed
      if (!env.hasIpykernel) {
        webview.postMessage({
          type: 'kernel:selectEnvironmentResult',
          success: false,
          error: 'ipykernel not installed',
          needsInstall: true,
        });
        return;
      }

      // Start new kernel
      PromptbookEditorProvider.kernelManager = new KernelManager(pythonPath);
      await PromptbookEditorProvider.kernelManager.start();
      PromptbookEditorProvider.selectedEnvironment = env;

      // Set up event listeners for all webviews
      for (const wv of PromptbookEditorProvider.webviews) {
        this.setupKernelEventListeners(wv);
      }

      // Store selection in workspace settings
      const config = vscode.workspace.getConfiguration('promptbook');
      await config.update('pythonPath', pythonPath, vscode.ConfigurationTarget.Workspace);

      webview.postMessage({
        type: 'kernel:selectEnvironmentResult',
        success: true,
      });

      // Broadcast state change to all webviews
      PromptbookEditorProvider.broadcastToWebviews({
        type: 'kernel:stateChange',
        state: 'idle',
      });
    } catch (err) {
      webview.postMessage({
        type: 'kernel:selectEnvironmentResult',
        success: false,
        error: String(err),
      });
    }
  }

  private async handleInstallIpykernel(webview: vscode.Webview, pythonPath: string): Promise<void> {
    if (!PromptbookEditorProvider.pythonSetup) {
      webview.postMessage({
        type: 'kernel:installIpykernelResult',
        success: false,
        error: 'Python setup not initialized',
      });
      return;
    }

    try {
      const result = await PromptbookEditorProvider.pythonSetup.installIpykernel(pythonPath);

      if (result.success) {
        // Rescan environments
        await PromptbookEditorProvider.scanEnvironments();
        webview.postMessage({
          type: 'kernel:environments',
          environments: PromptbookEditorProvider.environments,
        });
      }

      webview.postMessage({
        type: 'kernel:installIpykernelResult',
        success: result.success,
        error: result.error,
      });
    } catch (err) {
      webview.postMessage({
        type: 'kernel:installIpykernelResult',
        success: false,
        error: String(err),
      });
    }
  }

  private getHtmlForWebview(_webview: vscode.Webview): string {
    // TODO: Load actual React bundle from @promptbook/core
    return `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Promptbook</title>
        <style>
          body {
            font-family: var(--vscode-font-family);
            padding: 20px;
            color: var(--vscode-foreground);
            background: var(--vscode-editor-background);
          }
          .kernel-status {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 8px 12px;
            background: var(--vscode-input-background);
            border-radius: 4px;
            margin-bottom: 16px;
          }
          .kernel-dot {
            width: 8px;
            height: 8px;
            border-radius: 50%;
          }
          .kernel-dot.disconnected { background: #6b7280; }
          .kernel-dot.idle { background: #22c55e; }
          .kernel-dot.busy { background: #eab308; }
          .kernel-dot.dead { background: #ef4444; }
          .placeholder {
            color: var(--vscode-descriptionForeground);
          }
        </style>
      </head>
      <body>
        <div id="root">
          <div class="kernel-status">
            <div class="kernel-dot disconnected" id="kernelDot"></div>
            <span id="kernelLabel">No kernel selected</span>
          </div>
          <p class="placeholder">Promptbook editor loading...</p>
          <p class="placeholder">The full React UI will be bundled in a future update.</p>
        </div>
        <script>
          const vscode = acquireVsCodeApi();

          window.addEventListener('message', (event) => {
            const message = event.data;
            const dot = document.getElementById('kernelDot');
            const label = document.getElementById('kernelLabel');

            switch (message.type) {
              case 'update':
                console.log('Received document update');
                break;
              case 'kernel:stateChange':
                dot.className = 'kernel-dot ' + message.state;
                label.textContent = message.state === 'disconnected' ? 'No kernel selected' : 'Kernel: ' + message.state;
                break;
              case 'kernel:status':
                dot.className = 'kernel-dot ' + message.state;
                label.textContent = message.state === 'disconnected' ? 'No kernel selected' : 'Kernel: ' + message.state;
                break;
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

  private async syncCell(
    cellId: string,
    direction: 'toCode' | 'toInstructions'
  ): Promise<void> {
    // TODO: Sync cell via AI provider
    vscode.window.showInformationMessage(`Syncing cell: ${cellId} (${direction})`);
  }
}
