import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

interface FormatterConfig {
  command: string;
  useStdin?: boolean;
  cwd?: string;
}

const EXTENSION_ID = 'bwees.custom-formatter';
const providerRegistrations = new Map<string, vscode.Disposable>();

export function activate(context: vscode.ExtensionContext): void {
  refreshProviders(context);
  void syncDefaultFormatters();

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration('customFormatter.commands') ||
        e.affectsConfiguration('customFormatter.autoRegister') ||
        e.affectsConfiguration('customFormatter.autoRegisterTarget')
      ) {
        refreshProviders(context);
        void syncDefaultFormatters();
      }
    }),
    vscode.commands.registerCommand('customFormatter.syncDefaultFormatters', () =>
      syncDefaultFormatters(true),
    ),
  );
}

export function deactivate(): void {
  for (const disp of providerRegistrations.values()) disp.dispose();
  providerRegistrations.clear();
}

function getCommands(): Record<string, FormatterConfig> {
  return (
    vscode.workspace
      .getConfiguration('customFormatter')
      .get<Record<string, FormatterConfig>>('commands') ?? {}
  );
}

function refreshProviders(context: vscode.ExtensionContext): void {
  const commands = getCommands();
  const wanted = new Set(Object.keys(commands));

  for (const [language, disp] of providerRegistrations) {
    if (!wanted.has(language) || !commands[language]?.command) {
      disp.dispose();
      providerRegistrations.delete(language);
    }
  }

  for (const [language, cfg] of Object.entries(commands)) {
    if (!cfg?.command || providerRegistrations.has(language)) continue;
    const disp = vscode.languages.registerDocumentFormattingEditProvider(
      { language },
      {
        provideDocumentFormattingEdits: (doc) => formatDocument(doc, getCommands()[language]),
      },
    );
    providerRegistrations.set(language, disp);
    context.subscriptions.push(disp);
  }
}

async function syncDefaultFormatters(notify = false): Promise<void> {
  const root = vscode.workspace.getConfiguration('customFormatter');
  if (!root.get<boolean>('autoRegister', true)) return;

  const target =
    root.get<string>('autoRegisterTarget', 'global') === 'workspace'
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;

  const commands = getCommands();
  const updated: string[] = [];

  for (const language of Object.keys(commands)) {
    const scoped = vscode.workspace.getConfiguration('editor', { languageId: language });
    const inspect = scoped.inspect<string>('defaultFormatter');
    const currentAtTarget =
      target === vscode.ConfigurationTarget.Workspace
        ? inspect?.workspaceLanguageValue
        : inspect?.globalLanguageValue;
    if (currentAtTarget === EXTENSION_ID) continue;
    try {
      await scoped.update('defaultFormatter', EXTENSION_ID, target, true);
      updated.push(language);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showWarningMessage(
        `Custom Formatter: failed to set defaultFormatter for ${language}: ${message}`,
      );
    }
  }

  if (notify) {
    if (updated.length) {
      vscode.window.showInformationMessage(
        `Custom Formatter: linked as default formatter for ${updated.join(', ')}.`,
      );
    } else {
      vscode.window.showInformationMessage(
        'Custom Formatter: all configured languages already point at this extension.',
      );
    }
  }
}

async function formatDocument(
  document: vscode.TextDocument,
  config: FormatterConfig | undefined,
): Promise<vscode.TextEdit[]> {
  if (!config?.command) return [];

  const content = document.getText();
  const originalPath = document.uri.fsPath;
  const cwd = config.cwd
    ? renderTemplate(config.cwd, originalPath, originalPath)
    : path.dirname(originalPath) || process.cwd();

  try {
    const formatted = config.useStdin
      ? await runWithStdin(renderTemplate(config.command, originalPath, originalPath), content, cwd)
      : await runOnTempFile(config.command, content, originalPath, cwd);

    if (formatted === content) return [];
    const fullRange = new vscode.Range(document.positionAt(0), document.positionAt(content.length));
    return [vscode.TextEdit.replace(fullRange, formatted)];
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`Custom Formatter: ${message}`);
    return [];
  }
}

function renderTemplate(template: string, originalPath: string, fileSubstitution: string): string {
  const parsed = path.parse(originalPath);
  const workspaceFolder =
    vscode.workspace.getWorkspaceFolder(vscode.Uri.file(originalPath))?.uri.fsPath ??
    parsed.dir ??
    '';

  return template
    .replace(/\$\{file\}/g, shellQuote(fileSubstitution))
    .replace(/\$\{fileName\}/g, parsed.base)
    .replace(/\$\{fileDirname\}/g, parsed.dir)
    .replace(/\$\{fileExtname\}/g, parsed.ext)
    .replace(/\$\{fileBasenameNoExtension\}/g, parsed.name)
    .replace(/\$\{workspaceFolder\}/g, workspaceFolder);
}

function shellQuote(value: string): string {
  if (process.platform === 'win32') {
    return `"${value.replace(/"/g, '\\"')}"`;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function runOnTempFile(
  commandTemplate: string,
  content: string,
  originalPath: string,
  cwd: string,
): Promise<string> {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'custom-formatter-'));
  const tmpFile = path.join(tmpDir, path.basename(originalPath) || 'buffer');
  try {
    await fs.promises.writeFile(tmpFile, content);
    const command = renderTemplate(commandTemplate, originalPath, tmpFile);
    await runShell(command, cwd);
    return await fs.promises.readFile(tmpFile, 'utf8');
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  }
}

function runWithStdin(command: string, input: string, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = cp.spawn(command, { shell: true, cwd });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || `Formatter exited with code ${code}`));
    });
    child.stdin?.write(input);
    child.stdin?.end();
  });
}

function runShell(command: string, cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = cp.spawn(command, { shell: true, cwd });
    let stderr = '';
    child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `Formatter exited with code ${code}`));
    });
  });
}
