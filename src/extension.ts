import * as vscode from 'vscode';
import { PromptbookEditorProvider } from './EditorProvider';

export function activate(context: vscode.ExtensionContext) {
  // Register custom editor provider
  context.subscriptions.push(
    PromptbookEditorProvider.register(context)
  );

  // Register new notebook command
  context.subscriptions.push(
    vscode.commands.registerCommand('promptbook.newNotebook', async () => {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
        vscode.window.showErrorMessage('Please open a folder first');
        return;
      }

      const fileName = await vscode.window.showInputBox({
        prompt: 'Enter notebook name',
        value: 'untitled.promptbook',
      });

      if (fileName) {
        const uri = vscode.Uri.joinPath(workspaceFolder.uri, fileName);
        const initialContent = JSON.stringify({
          version: '1.0',
          metadata: {
            kernel: 'python3',
            aiProvider: 'claude',
            created: new Date().toISOString(),
            modified: new Date().toISOString(),
          },
          cells: [],
        }, null, 2);

        await vscode.workspace.fs.writeFile(uri, Buffer.from(initialContent));
        await vscode.commands.executeCommand('vscode.openWith', uri, 'promptbook.editor');
      }
    })
  );
}

export function deactivate() {}
