import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

interface FormatterConfig {
  command: string;
  useStdin: boolean;
  cwd?: string;
}

let output: vscode.OutputChannel;

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('Custom Formatter');
  context.subscriptions.push(output);

  context.subscriptions.push(
    vscode.languages.registerDocumentFormattingEditProvider(
      { scheme: 'file' },
      { provideDocumentFormattingEdits: formatDocument },
    ),
  );
}

export function deactivate(): void {}

function getConfig(document: vscode.TextDocument): FormatterConfig | undefined {
  const cfg = vscode.workspace.getConfiguration('customFormatter', {
    uri: document.uri,
    languageId: document.languageId,
  });
  const command = cfg.get<string>('command');
  if (!command) return undefined;
  return {
    command,
    useStdin: cfg.get<boolean>('useStdin', false),
    cwd: cfg.get<string>('cwd') || undefined,
  };
}

async function formatDocument(document: vscode.TextDocument): Promise<vscode.TextEdit[]> {
  const config = getConfig(document);
  if (!config) return [];

  const content = document.getText();
  const originalPath = document.uri.fsPath;
  const started = Date.now();

  try {
    const { formatted, resolvedCommand, resolvedCwd } = config.useStdin
      ? await runWithStdin(config, content, originalPath)
      : await runOnTempFile(config, content, originalPath);

    const elapsed = Date.now() - started;
    if (formatted === content) {
      output.appendLine(
        `[${new Date().toISOString()}] ok (no changes) ${document.languageId} ${originalPath} in ${elapsed}ms — cwd=${resolvedCwd} cmd=${resolvedCommand}`,
      );
      return [];
    }

    output.appendLine(
      `[${new Date().toISOString()}] ok ${document.languageId} ${originalPath} in ${elapsed}ms — cwd=${resolvedCwd} cmd=${resolvedCommand}`,
    );
    const fullRange = new vscode.Range(document.positionAt(0), document.positionAt(content.length));
    return [vscode.TextEdit.replace(fullRange, formatted)];
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    output.appendLine(
      `[${new Date().toISOString()}] error ${document.languageId} ${originalPath}: ${message}`,
    );
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

interface FormatResult {
  formatted: string;
  resolvedCommand: string;
  resolvedCwd: string;
}

async function runOnTempFile(
  config: FormatterConfig,
  content: string,
  originalPath: string,
): Promise<FormatResult> {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'custom-formatter-'));
  const tmpFile = path.join(tmpDir, path.basename(originalPath) || 'buffer');
  const cwd = config.cwd ? renderTemplate(config.cwd, originalPath, tmpFile) : tmpDir;

  try {
    await fs.promises.writeFile(tmpFile, content);

    const rendered = renderTemplate(config.command, originalPath, tmpFile);
    const command = /\$\{file\}/.test(config.command)
      ? rendered
      : `${rendered} ${shellQuote(tmpFile)}`;

    await runShell(command, cwd);
    const formatted = await fs.promises.readFile(tmpFile, 'utf8');
    return { formatted, resolvedCommand: command, resolvedCwd: cwd };
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  }
}

async function runWithStdin(
  config: FormatterConfig,
  content: string,
  originalPath: string,
): Promise<FormatResult> {
  const cwd = config.cwd
    ? renderTemplate(config.cwd, originalPath, originalPath)
    : path.dirname(originalPath) || process.cwd();
  const command = renderTemplate(config.command, originalPath, originalPath);

  const formatted = await new Promise<string>((resolve, reject) => {
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
    child.stdin?.write(content);
    child.stdin?.end();
  });

  return { formatted, resolvedCommand: command, resolvedCwd: cwd };
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
