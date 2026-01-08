import { VirtualFileSystem } from './vfs';
import { executeWASI } from './wasi';

/**
 * Shell command parser and executor
 * Handles builtin commands and external WASM processes
 */

// Available WASM runtimes and their URLs
const WASM_BINARIES: Record<string, string> = {
  // These will be loaded from public/wasm/ when available
  // python: '/wasm/python.wasm',
  // node: '/wasm/node.wasm',
  // lua: '/wasm/lua.wasm',
};

export class Shell {
  private vfs: VirtualFileSystem;
  private env: Map<string, string>;
  private onOutput: (data: string, isError: boolean) => void;
  private history: string[] = [];
  private historyIndex: number = 0;

  constructor(
    vfs: VirtualFileSystem,
    onOutput: (data: string, isError: boolean) => void
  ) {
    this.vfs = vfs;
    this.onOutput = onOutput;
    this.env = new Map([
      ['HOME', '/home/user'],
      ['PATH', '/bin'],
      ['USER', 'user'],
      ['PWD', vfs.getCwd()],
    ]);
  }

  private write(text: string, isError = false): void {
    this.onOutput(text, isError);
  }

  private writeln(text: string, isError = false): void {
    this.write(text + '\n', isError);
  }

  private parseCommand(input: string): { cmd: string; args: string[] } {
    // Simple parsing: split on spaces, respect quotes
    const tokens: string[] = [];
    let current = '';
    let inQuote = false;
    let quoteChar = '';

    for (let i = 0; i < input.length; i++) {
      const char = input[i];

      if ((char === '"' || char === "'") && !inQuote) {
        inQuote = true;
        quoteChar = char;
      } else if (char === quoteChar && inQuote) {
        inQuote = false;
        quoteChar = '';
      } else if (char === ' ' && !inQuote) {
        if (current) {
          tokens.push(current);
          current = '';
        }
      } else {
        current += char;
      }
    }

    if (current) tokens.push(current);

    const cmd = tokens[0] || '';
    const args = tokens.slice(1);

    return { cmd, args };
  }

  async execute(input: string): Promise<number> {
    input = input.trim();
    if (!input) return 0;

    // Check for simple redirects: echo text > file
    const redirectMatch = input.match(/^(.+?)\s*>\s*(.+)$/);
    if (redirectMatch) {
      const [, command, file] = redirectMatch;
      return this.executeWithRedirect(command.trim(), file.trim());
    }

    const { cmd, args } = this.parseCommand(input);

    try {
      // Execute builtin or external command
      const exitCode = await this.executeBuiltin(cmd, args);
      return exitCode;
    } catch (error) {
      this.writeln(
        `shazi-shell: ${cmd}: ${error instanceof Error ? error.message : 'command failed'}`,
        true
      );
      return 1;
    }
  }

  private async executeWithRedirect(command: string, file: string): Promise<number> {
    // Capture output
    let captured = '';
    const originalOutput = this.onOutput;

    this.onOutput = (data: string) => {
      captured += data;
    };

    await this.execute(command);

    this.onOutput = originalOutput;

    // Write to file
    try {
      this.vfs.writeFile(file, new TextEncoder().encode(captured));
      return 0;
    } catch (error) {
      this.writeln(
        `shazi-shell: ${file}: ${error instanceof Error ? error.message : 'write failed'}`,
        true
      );
      return 1;
    }
  }

  private async executeBuiltin(cmd: string, args: string[]): Promise<number> {
    switch (cmd) {
      case 'pwd':
        return this.cmdPwd();
      case 'cd':
        return this.cmdCd(args[0] || this.env.get('HOME')!);
      case 'ls':
        return this.cmdLs(args[0] || '.');
      case 'cat':
        return this.cmdCat(args);
      case 'echo':
        return this.cmdEcho(args);
      case 'mkdir':
        return this.cmdMkdir(args);
      case 'rm':
        return this.cmdRm(args);
      case 'mv':
        return this.cmdMv(args);
      case 'cp':
        return this.cmdCp(args);
      case 'touch':
        return this.cmdTouch(args);
      case 'clear':
        return this.cmdClear();
      case 'help':
        return this.cmdHelp();
      case 'env':
        return this.cmdEnv();
      case 'export':
        return this.cmdExport(args);
      case 'history':
        return this.cmdHistory();
      case 'python':
      case 'python3':
        return this.cmdPython(args);
      case 'node':
        return this.cmdNode(args);
      default:
        // Check if it's a WASM binary
        if (WASM_BINARIES[cmd]) {
          return this.executeWasm(cmd, args);
        }
        throw new Error(`command not found: ${cmd}`);
    }
  }

  // WASM execution

  private async executeWasm(cmd: string, args: string[]): Promise<number> {
    const wasmUrl = WASM_BINARIES[cmd];
    if (!wasmUrl) {
      this.writeln(`${cmd}: WASM binary not found`, true);
      return 127;
    }

    return executeWASI(wasmUrl, {
      args: [cmd, ...args],
      env: Object.fromEntries(this.env),
      vfs: this.vfs,
      stdout: (data) => this.write(data, false),
      stderr: (data) => this.write(data, true),
    });
  }

  private cmdPython(args: string[]): number {
    // TODO: Replace with actual Python WASM when available
    if (args.length === 0) {
      this.writeln(
        'Python WASM runtime not yet loaded.\n' +
          'To enable Python support:\n' +
          '1. Download python.wasm from https://github.com/niccokunzmann/pywasm\n' +
          '2. Place in public/wasm/python.wasm\n' +
          '3. Uncomment python entry in WASM_BINARIES',
        true
      );
      return 1;
    }

    // Simple Python simulation for demo purposes
    const file = args[0];
    if (file === '-c' && args.length > 1) {
      // python -c "code"
      this.writeln('[Python simulation mode]');
      this.writeln(`Would execute: ${args[1]}`);
      return 0;
    }

    if (!this.vfs.exists(file)) {
      this.writeln(`python: can't open file '${file}': No such file`, true);
      return 1;
    }

    this.writeln('[Python WASM not loaded - showing file contents instead]');
    const content = new TextDecoder().decode(this.vfs.readFile(file));
    this.writeln(content);
    return 0;
  }

  private cmdNode(args: string[]): number {
    // TODO: Replace with actual Node.js WASM when available
    if (args.length === 0) {
      this.writeln(
        'Node.js WASM runtime not yet loaded.\n' +
          'Node.js WASI support is experimental.\n' +
          'Consider using Deno WASM or QuickJS instead.',
        true
      );
      return 1;
    }

    const file = args[0];
    if (file === '-e' && args.length > 1) {
      // node -e "code"
      this.writeln('[Node.js simulation mode]');
      this.writeln(`Would execute: ${args[1]}`);
      return 0;
    }

    if (!this.vfs.exists(file)) {
      this.writeln(`node: can't open file '${file}': No such file`, true);
      return 1;
    }

    this.writeln('[Node.js WASM not loaded - showing file contents instead]');
    const content = new TextDecoder().decode(this.vfs.readFile(file));
    this.writeln(content);
    return 0;
  }

  // Builtin commands

  private cmdPwd(): number {
    this.writeln(this.vfs.getCwd());
    return 0;
  }

  private cmdCd(path: string): number {
    try {
      this.vfs.setCwd(path);
      this.env.set('PWD', this.vfs.getCwd());
      return 0;
    } catch (error) {
      this.writeln(
        `cd: ${error instanceof Error ? error.message : 'failed'}`,
        true
      );
      return 1;
    }
  }

  private cmdLs(path: string): number {
    try {
      const entries = this.vfs.readdir(path);
      if (entries.length === 0) {
        return 0;
      }

      // Simple column layout
      const maxLen = Math.max(...entries.map((e) => e.length));
      const cols = Math.floor(80 / (maxLen + 2)) || 1;
      const rows = Math.ceil(entries.length / cols);

      for (let row = 0; row < rows; row++) {
        let line = '';
        for (let col = 0; col < cols; col++) {
          const idx = row + col * rows;
          if (idx < entries.length) {
            line += entries[idx].padEnd(maxLen + 2);
          }
        }
        this.writeln(line.trimEnd());
      }

      return 0;
    } catch (error) {
      this.writeln(
        `ls: ${error instanceof Error ? error.message : 'failed'}`,
        true
      );
      return 1;
    }
  }

  private cmdCat(args: string[]): number {
    if (args.length === 0) {
      this.writeln('cat: missing file operand', true);
      return 1;
    }

    for (const path of args) {
      try {
        const content = this.vfs.readFile(path);
        this.write(new TextDecoder().decode(content));
      } catch (error) {
        this.writeln(
          `cat: ${path}: ${error instanceof Error ? error.message : 'failed'}`,
          true
        );
        return 1;
      }
    }

    return 0;
  }

  private cmdEcho(args: string[]): number {
    this.writeln(args.join(' '));
    return 0;
  }

  private cmdMkdir(args: string[]): number {
    if (args.length === 0) {
      this.writeln('mkdir: missing operand', true);
      return 1;
    }

    for (const path of args) {
      try {
        // Support -p flag for recursive
        if (path === '-p') continue;
        const hasP = args.includes('-p');

        if (hasP) {
          this.vfs.mkdirp(path);
        } else {
          this.vfs.mkdir(path);
        }
      } catch (error) {
        this.writeln(
          `mkdir: ${error instanceof Error ? error.message : 'failed'}`,
          true
        );
        return 1;
      }
    }

    return 0;
  }

  private cmdRm(args: string[]): number {
    if (args.length === 0) {
      this.writeln('rm: missing operand', true);
      return 1;
    }

    const isRecursive = args.includes('-r') || args.includes('-rf');
    const paths = args.filter((a) => !a.startsWith('-'));

    for (const path of paths) {
      try {
        const stat = this.vfs.stat(path);
        if (stat.type === 'directory') {
          if (!isRecursive) {
            this.writeln(`rm: ${path}: is a directory`, true);
            return 1;
          }
          this.rmRecursive(path);
        } else {
          this.vfs.unlink(path);
        }
      } catch (error) {
        this.writeln(
          `rm: ${error instanceof Error ? error.message : 'failed'}`,
          true
        );
        return 1;
      }
    }

    return 0;
  }

  private rmRecursive(path: string): void {
    const entries = this.vfs.readdir(path);
    for (const entry of entries) {
      const fullPath = `${path}/${entry}`;
      const stat = this.vfs.stat(fullPath);
      if (stat.type === 'directory') {
        this.rmRecursive(fullPath);
      } else {
        this.vfs.unlink(fullPath);
      }
    }
    this.vfs.rmdir(path);
  }

  private cmdMv(args: string[]): number {
    if (args.length < 2) {
      this.writeln('mv: missing operand', true);
      return 1;
    }

    try {
      this.vfs.rename(args[0], args[1]);
      return 0;
    } catch (error) {
      this.writeln(
        `mv: ${error instanceof Error ? error.message : 'failed'}`,
        true
      );
      return 1;
    }
  }

  private cmdCp(args: string[]): number {
    if (args.length < 2) {
      this.writeln('cp: missing operand', true);
      return 1;
    }

    try {
      const content = this.vfs.readFile(args[0]);
      this.vfs.writeFile(args[1], content);
      return 0;
    } catch (error) {
      this.writeln(
        `cp: ${error instanceof Error ? error.message : 'failed'}`,
        true
      );
      return 1;
    }
  }

  private cmdTouch(args: string[]): number {
    if (args.length === 0) {
      this.writeln('touch: missing operand', true);
      return 1;
    }

    for (const path of args) {
      try {
        if (!this.vfs.exists(path)) {
          this.vfs.writeFile(path, new Uint8Array());
        }
      } catch (error) {
        this.writeln(
          `touch: ${error instanceof Error ? error.message : 'failed'}`,
          true
        );
        return 1;
      }
    }

    return 0;
  }

  private cmdClear(): number {
    this.write('\x1bc'); // Clear terminal
    return 0;
  }

  private cmdEnv(): number {
    for (const [key, value] of this.env) {
      this.writeln(`${key}=${value}`);
    }
    return 0;
  }

  private cmdExport(args: string[]): number {
    for (const arg of args) {
      const match = arg.match(/^(\w+)=(.*)$/);
      if (match) {
        this.env.set(match[1], match[2]);
      } else {
        this.writeln(`export: invalid format: ${arg}`, true);
        return 1;
      }
    }
    return 0;
  }

  private cmdHistory(): number {
    for (let i = 0; i < this.history.length; i++) {
      this.writeln(`  ${i + 1}  ${this.history[i]}`);
    }
    return 0;
  }

  addToHistory(command: string): void {
    if (command.trim() && command !== this.history[this.history.length - 1]) {
      this.history.push(command);
      if (this.history.length > 100) {
        this.history.shift();
      }
    }
    this.historyIndex = this.history.length;
  }

  getHistoryPrev(): string | null {
    if (this.historyIndex > 0) {
      this.historyIndex--;
      return this.history[this.historyIndex];
    }
    return null;
  }

  getHistoryNext(): string | null {
    if (this.historyIndex < this.history.length - 1) {
      this.historyIndex++;
      return this.history[this.historyIndex];
    }
    this.historyIndex = this.history.length;
    return '';
  }

  private cmdHelp(): number {
    const help = `
Shazi Shell - Available Commands:

File Operations:
  ls [path]           - List directory contents
  cat <file>...       - Display file contents
  touch <file>...     - Create empty files
  mkdir [-p] <dir>... - Create directories
  rm [-r] <path>...   - Remove files/directories
  mv <src> <dst>      - Move/rename files
  cp <src> <dst>      - Copy files

Navigation:
  pwd                 - Print working directory
  cd <path>           - Change directory

Utilities:
  echo <text>         - Print text
  clear               - Clear terminal
  help                - Show this help
  env                 - Show environment variables
  export VAR=val      - Set environment variable
  history             - Show command history

Language Runtimes (WASM):
  python <file>       - Run Python script
  node <file>         - Run JavaScript (Node.js)

Redirects:
  cmd > file          - Redirect output to file

Note: Language runtimes require WASM binaries in /public/wasm/
`.trim();

    this.writeln(help);
    return 0;
  }

  getPrompt(): string {
    const cwd = this.vfs.getCwd();
    const home = this.env.get('HOME')!;
    const displayPath = cwd.startsWith(home) ? '~' + cwd.slice(home.length) : cwd;
    return `$ ${displayPath} `;
  }
}
