import { VirtualFileSystem } from './vfs';
import { runtimeManager, ReplSession } from './runtimes';

/**
 * Shell command parser and executor
 * Handles builtin commands and external WASM processes
 */

export interface ReplState {
  active: boolean;
  runtime: string;
  session: ReplSession | null;
}

export class Shell {
  private vfs: VirtualFileSystem;
  private env: Map<string, string>;
  private onOutput: (data: string, isError: boolean) => void;
  private history: string[] = [];
  private historyIndex: number = 0;
  private replState: ReplState = { active: false, runtime: '', session: null };
  private onReplStart?: (runtime: string, prompt: string) => void;
  private onReplEnd?: () => void;

  constructor(
    vfs: VirtualFileSystem,
    onOutput: (data: string, isError: boolean) => void,
    onReplStart?: (runtime: string, prompt: string) => void,
    onReplEnd?: () => void
  ) {
    this.vfs = vfs;
    this.onOutput = onOutput;
    this.onReplStart = onReplStart;
    this.onReplEnd = onReplEnd;
    this.env = new Map([
      ['HOME', '/home/user'],
      ['PATH', '/bin'],
      ['USER', 'user'],
      ['PWD', vfs.getCwd()],
    ]);
  }

  isInRepl(): boolean {
    return this.replState.active;
  }

  getReplPrompt(): string {
    if (this.replState.session) {
      return this.replState.session.getPrompt();
    }
    return '> ';
  }

  async executeReplInput(input: string): Promise<void> {
    if (!this.replState.session) return;

    try {
      const result = await this.replState.session.execute(input);

      if (result.error) {
        this.writeln(result.error, true);
      }

      if (result.result !== null) {
        this.writeln(result.result);
      }

      // Check if REPL should continue
      if (!result.continueInput && (input.trim() === 'exit()' || input.trim() === 'quit()' || input.trim() === '.exit' || input.trim() === 'exit')) {
        this.exitRepl();
      }
    } catch (error) {
      this.writeln(error instanceof Error ? error.message : String(error), true);
    }
  }

  private exitRepl(): void {
    if (this.replState.session) {
      this.replState.session.destroy();
    }
    this.replState = { active: false, runtime: '', session: null };
    this.onReplEnd?.();
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
      case 'runtimes':
        return this.cmdRuntimes();

      // Language runtimes
      case 'python':
      case 'python3':
        return this.executeRuntime('python', args);
      case 'node':
      case 'nodejs':
      case 'js':
        return this.executeRuntime('node', args);
      case 'gcc':
      case 'cc':
        return this.executeRuntime('gcc', args);
      case 'g++':
      case 'cpp':
        return this.executeRuntime('g++', args);
      case 'java':
      case 'javac':
        return this.executeRuntime('java', args);
      case 'lua':
        return this.executeRuntime('lua', args);
      case 'ruby':
        return this.executeRuntime('ruby', args);
      case 'go':
        return this.executeRuntime('go', args);
      case 'rust':
      case 'rustc':
        return this.executeRuntime('rust', args);

      default:
        throw new Error(`command not found: ${cmd}`);
    }
  }

  // Runtime execution

  private async executeRuntime(runtimeName: string, args: string[]): Promise<number> {
    const runtime = runtimeManager.getRuntime(runtimeName);
    if (!runtime) {
      this.writeln(`${runtimeName}: runtime not available`, true);
      return 127;
    }

    // Check for -c or -e flag (inline code)
    if (args.length >= 2 && (args[0] === '-c' || args[0] === '-e')) {
      const code = args.slice(1).join(' ');
      return this.runCode(runtime, runtimeName, code);
    }

    // No arguments - start REPL if supported
    if (args.length === 0) {
      if (runtime.supportsRepl && runtime.createRepl) {
        return this.startRepl(runtimeName, runtime);
      } else {
        this.writeln(`${runtimeName}: no input file specified`, true);
        this.writeln(`Usage: ${runtimeName} <file> or ${runtimeName} -c "code"`, true);
        return 1;
      }
    }

    const file = args[0];
    if (!this.vfs.exists(file)) {
      this.writeln(`${runtimeName}: ${file}: No such file`, true);
      return 1;
    }

    try {
      const content = new TextDecoder().decode(this.vfs.readFile(file));
      return this.runCode(runtime, runtimeName, content);
    } catch (error) {
      this.writeln(
        `${runtimeName}: ${error instanceof Error ? error.message : 'execution failed'}`,
        true
      );
      return 1;
    }
  }

  private async startRepl(runtimeName: string, runtime: ReturnType<typeof runtimeManager.getRuntime>): Promise<number> {
    if (!runtime || !runtime.createRepl) return 127;

    try {
      // Show loading message
      if (!runtime.isLoaded) {
        this.writeln(`Loading ${runtime.name}...`);
      }

      // Create REPL session
      const session = await runtime.createRepl((text: string, isError: boolean) => {
        this.write(text, isError);
      });

      // Show REPL header
      if (runtimeName === 'python' || runtimeName === 'python3') {
        this.writeln(`Python 3.11.0 (Pyodide)`);
        this.writeln(`Type "exit()" or "quit()" to exit.`);
      } else if (runtimeName === 'node' || runtimeName === 'javascript' || runtimeName === 'js') {
        this.writeln(`Node.js (QuickJS)`);
        this.writeln(`Type ".exit" to exit.`);
      }

      // Set REPL state
      this.replState = {
        active: true,
        runtime: runtimeName,
        session,
      };

      // Notify that REPL started
      this.onReplStart?.(runtimeName, session.getPrompt());

      return 0;
    } catch (error) {
      this.writeln(
        `${runtimeName}: Failed to start REPL: ${error instanceof Error ? error.message : 'unknown error'}`,
        true
      );
      return 1;
    }
  }

  private async runCode(
    runtime: ReturnType<typeof runtimeManager.getRuntime>,
    name: string,
    code: string
  ): Promise<number> {
    if (!runtime) return 127;

    try {
      // Show loading message for runtimes that need to load
      if (!runtime.isLoaded) {
        this.writeln(`Loading ${runtime.name}...`);
      }

      const result = await runtime.execute(code, [], this.vfs);

      if (result.stdout) {
        this.write(result.stdout);
      }
      if (result.stderr) {
        this.write(result.stderr, true);
      }

      return result.exitCode;
    } catch (error) {
      this.writeln(
        `${name}: ${error instanceof Error ? error.message : 'execution failed'}`,
        true
      );
      return 1;
    }
  }

  private cmdRuntimes(): number {
    const runtimes = runtimeManager.listRuntimes();
    this.writeln('Available language runtimes:\n');

    for (const rt of runtimes) {
      const status = rt.loaded ? '\x1b[32m✓\x1b[0m' : '\x1b[33m○\x1b[0m';
      this.writeln(`  ${status} ${rt.name.padEnd(10)} - ${rt.description}`);
    }

    this.writeln('\nUsage: <runtime> <file> or <runtime> -c "code"');
    this.writeln('       <runtime>            (start REPL for python/node)');
    this.writeln('Example: python hello.py');
    this.writeln('Example: node -c "console.log(\'Hello\')"');
    this.writeln('Example: python              (starts Python REPL)');

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
Shazi Shell - WebAssembly Terminal

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
  runtimes            - List available language runtimes

Language Runtimes:
  python              - Start Python REPL (interactive mode)
  node                - Start Node.js REPL (interactive mode)
  python <file>       - Run Python 3 code (Pyodide)
  node <file>         - Run JavaScript (QuickJS)
  gcc <file>          - Compile/run C code
  g++ <file>          - Compile/run C++ code
  java <file>         - Run Java code
  lua <file>          - Run Lua code
  ruby <file>         - Run Ruby code
  go <file>           - Run Go code
  rust <file>         - Run Rust code

Inline Execution:
  python -c "print('Hello')"
  node -c "console.log('Hello')"

REPL Mode:
  python              - Start Python REPL
  >>> print("Hello")  - Execute in Python REPL
  >>> exit()          - Exit Python REPL
  
  node                - Start Node.js REPL
  > console.log("Hi") - Execute in Node REPL
  > .exit             - Exit Node REPL

Redirects:
  cmd > file          - Redirect output to file

Keyboard Shortcuts:
  ↑/↓                 - Navigate command history (shell mode)
  Ctrl+C              - Cancel current input
  Ctrl+D              - Exit REPL (when input is empty)
  Ctrl+L              - Clear screen
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
