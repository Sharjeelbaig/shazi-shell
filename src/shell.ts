/**
 * Shazi Shell - POSIX-compatible WebAssembly Shell
 * Handles control structures, pipes, redirections, variables, package managers
 */

import { VirtualFileSystem } from './vfs';
import { runtimeManager, ReplSession } from './runtimes';
import {
  expandBraces,
  expandVariables,
  expandGlobs,
  isComplete,
  splitByOperators,
  splitByPipes,
  tokenizeCommand,
  extractControlStructure
} from './shell-parser';
import { BUILTINS, CommandContext } from './builtins';

export interface ReplState {
  active: boolean;
  runtime: string;
  session: ReplSession | null;
}

export class Shell {
  private vfs: VirtualFileSystem;
  private env: Map<string, string>;
  private localVars: Map<string, string>;
  private onOutput: (data: string, isError: boolean) => void;
  private history: string[] = [];
  private historyIndex: number = 0;
  private replState: ReplState = { active: false, runtime: '', session: null };
  // Simple line-oriented editor state for `nano` support
  private editorState: {
    active: boolean;
    filename: string | null;
    buffer: string[];
    modified: boolean;
    prompt: string;
  } = { active: false, filename: null, buffer: [], modified: false, prompt: 'nano> ' };
  private onReplStart?: (runtime: string, prompt: string) => void;
  private onReplEnd?: () => void;
  private lastExitCode: number = 0;
  private functions: Map<string, string> = new Map();
  private scriptArgs: string[] = [];
  private aliases: Map<string, string> = new Map();

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
      ['PATH', '/bin:/usr/bin'],
      ['USER', 'user'],
      ['PWD', vfs.getCwd()],
      ['SHELL', '/bin/sh'],
      ['TERM', 'xterm-256color'],
      ['LANG', 'en_US.UTF-8'],
      ['HOSTNAME', 'shazi-shell'],
    ]);
    
    this.localVars = new Map();
    
    // Setup default aliases
    this.aliases.set('ll', 'ls -la');
    this.aliases.set('la', 'ls -a');
    this.aliases.set('..', 'cd ..');
    this.aliases.set('...', 'cd ../..');
  }

  isInRepl(): boolean {
    return this.replState.active || this.editorState.active;
  }

  isInEditor(): boolean {
    return this.editorState.active;
  }

  getReplPrompt(): string {
    return this.replState.session?.getPrompt() ?? '> ';
  }

  async executeReplInput(input: string): Promise<void> {
    if (!this.replState.session) return;

    try {
      const result = await this.replState.session.execute(input);
      if (result.error) this.writeln(result.error, true);
      if (result.result !== null) this.writeln(result.result);

      const exitCmds = ['exit()', 'quit()', '.exit', 'exit'];
      if (!result.continueInput && exitCmds.includes(input.trim())) {
        this.exitRepl();
      }
    } catch (error) {
      this.writeln(error instanceof Error ? error.message : String(error), true);
    }
  }

  /**
   * Start a simple line-oriented editor session (nano-like)
   */
  async startEditor(args: string[]): Promise<number> {
    const filename = args[0] || null;
    this.editorState.active = true;
    this.editorState.filename = filename;
    this.editorState.buffer = [];
    this.editorState.modified = false;

    // Load file if it exists
    if (filename && this.vfs.exists(filename)) {
      try {
        const content = new TextDecoder().decode(this.vfs.readFile(filename));
        this.editorState.buffer = content.split('\n');
      } catch {
        this.writeln(`nano: could not open ${filename}`, true);
        this.editorState.buffer = [];
      }
    }

    // Signal terminal to enter REPL-like input routing and set prompt
    this.onReplStart?.('editor', this.editorState.prompt);

    this.writeln(`\nGNU nano (simulated) - editing ${filename ?? '<untitled>'}`);
    this.writeln("Type .help for commands: .save .exit .show .help\nEnter text lines, press Enter to append.");

    // Show initial buffer with line numbers
    if (this.editorState.buffer.length > 0) {
      for (let i = 0; i < this.editorState.buffer.length; i++) {
        this.writeln(`${i + 1}: ${this.editorState.buffer[i]}`);
      }
    }

    return 0;
  }

  /**
   * Handle a single input line while editor is active
   */
  async executeEditorInput(line: string): Promise<number> {
    if (!this.editorState.active) return 1;

    const trimmed = line.trim();

    // Editor commands
    if (trimmed === '.exit' || trimmed === ':q' || trimmed === 'exit' || trimmed === '^X') {
      // Auto-save if modified
      if (this.editorState.modified && this.editorState.filename) {
        try {
          const encoder = new TextEncoder();
          this.vfs.writeFile(this.editorState.filename, encoder.encode(this.editorState.buffer.join('\n')));
          this.writeln(`Wrote ${this.editorState.filename}`);
        } catch (err: any) {
          this.writeln(`Error saving file: ${err?.message || String(err)}`, true);
        }
      }

      // Exit editor
      this.editorState.active = false;
      this.editorState.filename = null;
      this.editorState.buffer = [];
      this.editorState.modified = false;
      this.onReplEnd?.();
      return 0;
    }

    if (trimmed === '.save' || trimmed === ':w' || trimmed === '^O') {
      if (!this.editorState.filename) {
        this.writeln('No filename specified. Use .exit to quit or provide a filename when starting nano.', true);
        return 1;
      }

      try {
        const encoder = new TextEncoder();
        this.vfs.writeFile(this.editorState.filename, encoder.encode(this.editorState.buffer.join('\n')));
        this.editorState.modified = false;
        this.writeln(`Saved ${this.editorState.filename}`);
        return 0;
      } catch (err: any) {
        this.writeln(`Error saving file: ${err?.message || String(err)}`, true);
        return 1;
      }
    }

    if (trimmed === '.show') {
      for (let i = 0; i < this.editorState.buffer.length; i++) {
        this.writeln(`${i + 1}: ${this.editorState.buffer[i]}`);
      }
      return 0;
    }

    if (trimmed === '.help' || trimmed === '^G') {
      this.writeln('nano (simulated) commands:');
      this.writeln('  .save or :w    Save to filename provided when starting nano');
      this.writeln('  .exit or :q    Exit editor (auto-saves if filename provided)');
      this.writeln('  .show          Display current buffer with line numbers');
      this.writeln('  .help          This help');
      return 0;
    }

    // Append input line to buffer
    this.editorState.buffer.push(line);
    this.editorState.modified = true;
    return 0;
  }

  private exitRepl(): void {
    this.replState.session?.destroy();
    this.replState = { active: false, runtime: '', session: null };
    this.onReplEnd?.();
  }

  private write(text: string, isError = false): void {
    this.onOutput(text, isError);
  }

  private writeln(text: string, isError = false): void {
    this.write(text + '\n', isError);
  }

  needsMoreInput(input: string): boolean {
    return !isComplete(input);
  }

  /**
   * Main entry point for executing commands
   */
  async execute(input: string): Promise<number> {
    input = input.trim();
    if (!input || input.startsWith('#')) return 0;

    try {
      // Expand braces first (before variable expansion)
      input = expandBraces(input);
      
      // Handle alias expansion
      input = this.expandAliases(input);
      
      // Check for simple variable assignment: VAR=value (no spaces)
      const simpleAssign = input.match(/^([a-zA-Z_][a-zA-Z0-9_]*)=([^;]*?)$/);
      if (simpleAssign && !input.includes(' ')) {
        this.localVars.set(simpleAssign[1], this.expandString(simpleAssign[2]));
        return 0;
      }
      
      // Check for function definition
      const funcMatch = input.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*\(\s*\)\s*\{(.+)\}$/s);
      if (funcMatch) {
        this.functions.set(funcMatch[1], funcMatch[2].trim());
        return 0;
      }

      // Split by operators and execute
      const operations = splitByOperators(input);
      let exitCode = 0;

      for (let i = 0; i < operations.length; i++) {
        const op = operations[i];
        
        // Check && and || conditions
        if (i > 0) {
          const prevOp = operations[i - 1].operator;
          if (prevOp === '&&' && exitCode !== 0) continue;
          if (prevOp === '||' && exitCode === 0) continue;
        }

        // Check if this is a control structure
        const ctrl = extractControlStructure(op.command);
        if (ctrl) {
          exitCode = await this.executeControlStructure(ctrl.type, ctrl.content);
        } else {
          exitCode = await this.executePipeline(op.command);
        }
        
        this.lastExitCode = exitCode;
      }

      return exitCode;
    } catch (error: any) {
      if (error?.type === 'exit') throw error;
      this.writeln(`shazi-shell: ${error?.message || 'error'}`, true);
      return 1;
    }
  }

  /**
   * Expand aliases in input
   */
  private expandAliases(input: string): string {
    const parts = input.split(/\s+/);
    if (parts.length > 0 && this.aliases.has(parts[0])) {
      parts[0] = this.aliases.get(parts[0])!;
      return parts.join(' ');
    }
    return input;
  }

  /**
   * Expand all variables in a string
   */
  private expandString(input: string): string {
    // Command substitution $(...)
    input = input.replace(/\$\(([^)]+)\)/g, (_, cmd) => {
      return this.captureOutput(cmd).trim();
    });
    
    // Backtick substitution `...`
    input = input.replace(/`([^`]+)`/g, (_, cmd) => {
      return this.captureOutput(cmd).trim();
    });

    const specialVars: Record<string, string> = {
      '0': this.scriptArgs[0] || 'sh',
      '1': this.scriptArgs[1] || '',
      '2': this.scriptArgs[2] || '',
      '3': this.scriptArgs[3] || '',
      '4': this.scriptArgs[4] || '',
      '5': this.scriptArgs[5] || '',
      '6': this.scriptArgs[6] || '',
      '7': this.scriptArgs[7] || '',
      '8': this.scriptArgs[8] || '',
      '9': this.scriptArgs[9] || '',
      '@': this.scriptArgs.slice(1).join(' '),
      '*': this.scriptArgs.slice(1).join(' '),
      '#': String(Math.max(0, this.scriptArgs.length - 1)),
      '?': String(this.lastExitCode),
      '$': String(Date.now()), // PID simulation
      '!': '0',
      '-': 'himBH',
      '_': '',
    };

    const allVars = new Map([...this.env, ...this.localVars]);
    return expandVariables(input, allVars, specialVars);
  }

  /**
   * Capture command output for substitution
   */
  private captureOutput(command: string): string {
    let captured = '';
    const originalOutput = this.onOutput;
    this.onOutput = (data) => { captured += data; };
    
    try {
      // Execute synchronously for simple commands
      const pipes = splitByPipes(command);
      if (pipes.length === 1) {
        const { cmd, args } = tokenizeCommand(this.expandString(pipes[0]));
        if (BUILTINS[cmd]) {
          const ctx = this.createContext(args, '');
          BUILTINS[cmd](ctx);
        }
      }
    } catch {
      // Ignore errors
    }
    
    this.onOutput = originalOutput;
    return captured;
  }

  /**
   * Execute a pipeline (commands separated by |)
   */
  private async executePipeline(input: string): Promise<number> {
    const expanded = this.expandString(input);
    const commands = splitByPipes(expanded);
    
    if (commands.length === 0) return 0;
    
    // Single command
    if (commands.length === 1) {
      return await this.executeSimpleCommand(commands[0], '');
    }
    
    // Pipeline: pipe output through each command
    let pipeInput = '';
    let exitCode = 0;
    
    for (let i = 0; i < commands.length; i++) {
      const isLast = i === commands.length - 1;
      
      if (!isLast) {
        // Capture output
        let output = '';
        const originalOutput = this.onOutput;
        this.onOutput = (data, isError) => {
          if (!isError) output += data;
          else originalOutput(data, isError);
        };
        
        exitCode = await this.executeSimpleCommand(commands[i], pipeInput);
        
        this.onOutput = originalOutput;
        pipeInput = output;
      } else {
        exitCode = await this.executeSimpleCommand(commands[i], pipeInput);
      }
    }
    
    return exitCode;
  }

  /**
   * Execute a single command
   */
  private async executeSimpleCommand(input: string, stdin: string): Promise<number> {
    const { cmd, args, redirects } = tokenizeCommand(input);
    if (!cmd) return 0;

    // Expand globs in args
    const expandedArgs = expandGlobs(args, (path: string) => this.vfs.readdir(path));

    // Setup redirections
    let redirectedOutput = '';
    let redirectFile = '';
    let appendMode = false;
    const originalOutput = this.onOutput;

    for (const redir of redirects) {
      if (redir.type === '>' || redir.type === '>>') {
        redirectFile = redir.target;
        appendMode = redir.type === '>>';
        this.onOutput = (data, isError) => {
          if (!isError) redirectedOutput += data;
          else originalOutput(data, isError);
        };
      } else if (redir.type === '<') {
        try {
          stdin = new TextDecoder().decode(this.vfs.readFile(redir.target));
        } catch {
          this.onOutput = originalOutput;
          this.writeln(`shazi-shell: ${redir.target}: No such file`, true);
          return 1;
        }
      }
    }

    let exitCode = 0;

    try {
      exitCode = await this.dispatchCommand(cmd, expandedArgs, stdin);
    } catch (error: any) {
      if (error?.type === 'exit') throw error;
      this.writeln(`shazi-shell: ${cmd}: ${error?.message || 'error'}`, true);
      exitCode = 1;
    }

    // Write redirected output
    if (redirectFile) {
      this.onOutput = originalOutput;
      try {
        const encoder = new TextEncoder();
        if (appendMode && this.vfs.exists(redirectFile)) {
          const existing = new TextDecoder().decode(this.vfs.readFile(redirectFile));
          this.vfs.writeFile(redirectFile, encoder.encode(existing + redirectedOutput));
        } else {
          this.vfs.writeFile(redirectFile, encoder.encode(redirectedOutput));
        }
      } catch (error: any) {
        this.writeln(`shazi-shell: ${redirectFile}: ${error?.message || 'write failed'}`, true);
        exitCode = 1;
      }
    }

    return exitCode;
  }

  /**
   * Dispatch command to appropriate handler
   */
  private async dispatchCommand(cmd: string, args: string[], stdin: string): Promise<number> {
    // Check for shell function
    if (this.functions.has(cmd)) {
      const savedArgs = this.scriptArgs;
      this.scriptArgs = [cmd, ...args];
      const result = await this.execute(this.functions.get(cmd)!);
      this.scriptArgs = savedArgs;
      return result;
    }

    // Special shell commands
    switch (cmd) {
      case 'help': return this.cmdHelp();
      case 'history': return this.cmdHistory();
      case 'runtimes': return this.cmdRuntimes();
      case 'alias': return this.cmdAlias(args);
      case 'unalias': return this.cmdUnalias(args);
      case 'source':
      case '.': return await this.cmdSource(args);
      case 'sh':
      case 'bash':
      case 'zsh': return await this.cmdShell(args);
      case 'nano': return await this.startEditor(args);
    }

    // Builtins
    if (BUILTINS[cmd]) {
      const ctx = this.createContext(args, stdin);
      return await BUILTINS[cmd](ctx);
    }

    // Package managers
    if (cmd === 'npm') return await this.cmdNpm(args);
    if (cmd === 'pip' || cmd === 'pip3') return await this.cmdPip(args);
    if (cmd === 'yarn') return await this.cmdYarn(args);
    if (cmd === 'pnpm') return await this.cmdPnpm(args);

    // Git commands
    if (cmd === 'git') return await this.cmdGit(args);

    // Language runtimes
    if (this.isRuntime(cmd)) {
      return await this.executeRuntime(cmd, args);
    }

    // Executable scripts
    if (this.vfs.exists(cmd)) {
      const stat = this.vfs.stat(cmd);
      if (stat.type === 'file') {
        return await this.executeScript(cmd, args);
      }
    }

    // Command not found
    this.writeln(`shazi-shell: ${cmd}: command not found`, true);
    return 127;
  }

  /**
   * Execute control structures (for, while, if, etc.)
   */
  private async executeControlStructure(type: string, content: string): Promise<number> {
    switch (type) {
      case 'for': return await this.executeFor(content);
      case 'while': return await this.executeWhile(content);
      case 'until': return await this.executeUntil(content);
      case 'if': return await this.executeIf(content);
      case 'case': return await this.executeCase(content);
      default: return 1;
    }
  }

  /**
   * Execute for loop: for VAR in ITEMS; do BODY; done
   */
  private async executeFor(content: string): Promise<number> {
    // Parse: for VAR in ITEMS; do BODY; done
    // Or: for VAR in ITEMS\ndo\nBODY\ndone
    const match = content.match(/^for\s+(\w+)\s+in\s+(.+?)\s*[;\n]\s*do\s*[;\n]?\s*(.+?)\s*[;\n]?\s*done$/s);
    
    if (!match) {
      this.writeln('shazi-shell: syntax error in for loop', true);
      return 2;
    }

    const [, varName, itemsStr, body] = match;
    const expandedItems = this.expandString(itemsStr);
    const items = expandedItems.split(/\s+/).filter(Boolean);
    
    let exitCode = 0;
    for (const item of items) {
      this.localVars.set(varName, item);
      exitCode = await this.execute(body);
    }
    
    return exitCode;
  }

  /**
   * Execute while loop: while COND; do BODY; done
   */
  private async executeWhile(content: string): Promise<number> {
    const match = content.match(/^while\s+(.+?)\s*[;\n]\s*do\s*[;\n]?\s*(.+?)\s*[;\n]?\s*done$/s);
    
    if (!match) {
      this.writeln('shazi-shell: syntax error in while loop', true);
      return 2;
    }

    const [, cond, body] = match;
    let exitCode = 0;
    let iterations = 0;
    const maxIterations = 10000;

    while (iterations < maxIterations) {
      const condResult = await this.execute(cond);
      if (condResult !== 0) break;
      exitCode = await this.execute(body);
      iterations++;
    }

    return exitCode;
  }

  /**
   * Execute until loop: until COND; do BODY; done
   */
  private async executeUntil(content: string): Promise<number> {
    const match = content.match(/^until\s+(.+?)\s*[;\n]\s*do\s*[;\n]?\s*(.+?)\s*[;\n]?\s*done$/s);
    
    if (!match) {
      this.writeln('shazi-shell: syntax error in until loop', true);
      return 2;
    }

    const [, cond, body] = match;
    let exitCode = 0;
    let iterations = 0;
    const maxIterations = 10000;

    while (iterations < maxIterations) {
      const condResult = await this.execute(cond);
      if (condResult === 0) break;
      exitCode = await this.execute(body);
      iterations++;
    }

    return exitCode;
  }

  /**
   * Execute if statement: if COND; then BODY; [elif COND; then BODY;]* [else BODY;] fi
   */
  private async executeIf(content: string): Promise<number> {
    // Simple if/then/else/fi
    const match = content.match(/^if\s+(.+?)\s*[;\n]\s*then\s*[;\n]?\s*(.+?)(?:\s*[;\n]\s*else\s*[;\n]?\s*(.+?))?\s*[;\n]?\s*fi$/s);
    
    if (!match) {
      this.writeln('shazi-shell: syntax error in if statement', true);
      return 2;
    }

    const [, cond, thenBody, elseBody] = match;
    const condResult = await this.execute(cond);

    if (condResult === 0) {
      return await this.execute(thenBody);
    } else if (elseBody) {
      return await this.execute(elseBody);
    }

    return 0;
  }

  /**
   * Execute case statement
   */
  private async executeCase(content: string): Promise<number> {
    // Basic case support
    const match = content.match(/^case\s+(\S+)\s+in\s+(.+?)\s+esac$/s);
    
    if (!match) {
      this.writeln('shazi-shell: syntax error in case statement', true);
      return 2;
    }

    const [, word, patterns] = match;
    const expandedWord = this.expandString(word);
    
    // Parse patterns: pattern) commands ;;
    const cases = patterns.split(';;').filter(Boolean);
    
    for (const c of cases) {
      const caseMatch = c.trim().match(/^(.+?)\)\s*(.*)$/s);
      if (caseMatch) {
        const [, pattern, body] = caseMatch;
        const patterns = pattern.split('|').map(p => p.trim());
        
        for (const p of patterns) {
          if (p === '*' || p === expandedWord) {
            return await this.execute(body.trim());
          }
        }
      }
    }

    return 0;
  }

  /**
   * Create command context for builtins
   */
  private createContext(args: string[], stdin: string): CommandContext {
    return {
      vfs: this.vfs,
      env: new Map([...this.env, ...this.localVars]),
      args,
      stdin,
      write: (text) => this.write(text),
      writeln: (text) => this.writeln(text),
      writeError: (text) => this.write(text, true),
    };
  }

  /**
   * Check if command is a runtime
   */
  private isRuntime(cmd: string): boolean {
    const runtimes = [
      'python', 'python3', 'node', 'nodejs', 'js',
      'gcc', 'cc', 'g++', 'cpp', 'java', 'javac',
      'lua', 'ruby', 'go', 'rust', 'rustc'
    ];
    return runtimes.includes(cmd);
  }

  /**
   * Execute language runtime
   */
  private async executeRuntime(cmd: string, args: string[]): Promise<number> {
    const runtimeMap: Record<string, string> = {
      'python3': 'python', 'nodejs': 'node', 'js': 'node',
      'cc': 'gcc', 'cpp': 'g++', 'rustc': 'rust'
    };
    const runtimeName = runtimeMap[cmd] || cmd;

    const runtime = runtimeManager.getRuntime(runtimeName);
    if (!runtime) {
      this.writeln(`${runtimeName}: runtime not available`, true);
      return 127;
    }

    // Inline code: python -c "code"
    if (args.length >= 2 && ['-c', '-e'].includes(args[0])) {
      const code = args.slice(1).join(' ');
      return await this.runRuntimeCode(runtime, runtimeName, code);
    }

    // No args: start REPL
    if (args.length === 0) {
      if (runtime.supportsRepl && runtime.createRepl) {
        return await this.startRepl(runtimeName, runtime);
      }
      this.writeln(`${runtimeName}: no input file specified`, true);
      return 1;
    }

    // File execution
    const file = args[0];
    if (!this.vfs.exists(file)) {
      this.writeln(`${runtimeName}: ${file}: No such file`, true);
      return 1;
    }

    const content = new TextDecoder().decode(this.vfs.readFile(file));
    return await this.runRuntimeCode(runtime, runtimeName, content);
  }

  private async runRuntimeCode(runtime: any, name: string, code: string): Promise<number> {
    try {
      if (!runtime.isLoaded) this.writeln(`Loading ${runtime.name}...`);
      const result = await runtime.execute(code, [], this.vfs);
      if (result.stdout) this.write(result.stdout);
      if (result.stderr) this.write(result.stderr, true);
      return result.exitCode;
    } catch (error: any) {
      this.writeln(`${name}: ${error?.message || 'execution failed'}`, true);
      return 1;
    }
  }

  private async startRepl(name: string, runtime: any): Promise<number> {
    try {
      if (!runtime.isLoaded) this.writeln(`Loading ${runtime.name}...`);
      
      const session = await runtime.createRepl((text: string, isError: boolean) => {
        this.write(text, isError);
      });

      if (name === 'python') {
        this.writeln('Python 3.11.0 (Pyodide)');
        this.writeln('Type "exit()" or "quit()" to exit.');
      } else if (name === 'node') {
        this.writeln('Node.js (QuickJS)');
        this.writeln('Type ".exit" to exit.');
      }

      this.replState = { active: true, runtime: name, session };
      this.onReplStart?.(name, session.getPrompt());
      return 0;
    } catch (error: any) {
      this.writeln(`${name}: Failed to start REPL: ${error?.message}`, true);
      return 1;
    }
  }

  /**
   * Execute a script file
   */
  private async executeScript(path: string, args: string[]): Promise<number> {
    try {
      const content = new TextDecoder().decode(this.vfs.readFile(path));
      const lines = content.split('\n');

      // Check shebang
      if (lines[0]?.startsWith('#!')) {
        const shebang = lines[0].slice(2).trim();
        if (shebang.includes('python')) {
          return await this.executeRuntime('python', [path, ...args]);
        }
        if (shebang.includes('node')) {
          return await this.executeRuntime('node', [path, ...args]);
        }
      }

      // Execute as shell script
      const savedArgs = this.scriptArgs;
      this.scriptArgs = [path, ...args];
      
      let exitCode = 0;
      let fullScript = '';
      
      for (const line of lines) {
        if (line.startsWith('#') || !line.trim()) continue;
        fullScript += line + '\n';
      }
      
      exitCode = await this.execute(fullScript);
      this.scriptArgs = savedArgs;
      return exitCode;
    } catch (error: any) {
      this.writeln(`shazi-shell: ${path}: ${error?.message}`, true);
      return 1;
    }
  }

  // ============================================
  // Package Managers
  // ============================================

  private async cmdNpm(args: string[]): Promise<number> {
    const subcmd = args[0] || 'help';
    
    switch (subcmd) {
      case 'install':
      case 'i':
        return await this.npmInstall(args.slice(1));
      case 'init':
        return this.npmInit(args.slice(1));
      case 'run':
        return await this.npmRun(args.slice(1));
      case 'test':
        return await this.npmRun(['test']);
      case 'start':
        return await this.npmRun(['start']);
      case 'list':
      case 'ls':
        return this.npmList();
      case 'version':
      case '-v':
      case '--version':
        this.writeln('10.2.0');
        return 0;
      case 'help':
      default:
        this.writeln('npm - Node Package Manager (WebAssembly)\n');
        this.writeln('Fetches REAL packages from npm registry via esm.sh CDN!\n');
        this.writeln('Commands:');
        this.writeln('  npm install [pkg]   Install packages');
        this.writeln('  npm init           Create package.json');
        this.writeln('  npm run <script>   Run a script');
        this.writeln('  npm test           Run tests');
        this.writeln('  npm start          Start application');
        this.writeln('  npm list           List installed packages');
        this.writeln('  npm version        Show version');
        return 0;
    }
  }

  private async npmInstall(packages: string[]): Promise<number> {
    const runtime = runtimeManager.getRuntime('node') as any;
    
    if (packages.length === 0) {
      // Install from package.json
      if (this.vfs.exists('package.json')) {
        try {
          const pkg = JSON.parse(new TextDecoder().decode(this.vfs.readFile('package.json')));
          const deps = { ...pkg.dependencies, ...pkg.devDependencies };
          const depList = Object.entries(deps);
          
          if (depList.length === 0) {
            this.writeln('npm: No dependencies to install');
            return 0;
          }
          
          this.writeln(`\nInstalling ${depList.length} packages from package.json...\n`);
          
          // Create node_modules
          if (!this.vfs.exists('node_modules')) {
            this.vfs.mkdir('node_modules');
          }
          
          let installed = 0;
          for (const [name, version] of depList) {
            const ver = String(version).replace(/[\^~>=<]/g, '');
            
            if (runtime) {
              const result = await runtime.installPackage(name, ver, (msg: string) => this.writeln(msg));
              if (result.success) installed++;
            }
            
            // Also create node_modules structure for file-based requires
            this.vfs.mkdirp(`node_modules/${name}`);
            this.vfs.writeFile(
              `node_modules/${name}/package.json`,
              new TextEncoder().encode(JSON.stringify({ name, version: ver, main: 'index.js' }))
            );
            this.vfs.writeFile(
              `node_modules/${name}/index.js`,
              new TextEncoder().encode(`// ${name}@${ver} - imported from esm.sh\nmodule.exports = require('https://esm.sh/${name}@${ver}');`)
            );
          }
          
          this.writeln(`\nadded ${installed} packages`);
          this.writeln('');
          return 0;
        } catch (error: any) {
          this.writeln(`npm ERR! ${error?.message}`, true);
          return 1;
        }
      } else {
        this.writeln('npm WARN No package.json found', true);
        this.writeln('npm WARN Run `npm init` to create one');
        return 1;
      }
    }

    // Install specific packages
    this.writeln('');
    
    if (!this.vfs.exists('node_modules')) {
      this.vfs.mkdir('node_modules');
    }

    let installed = 0;
    const addedPkgs: { name: string; version: string }[] = [];

    for (const pkg of packages) {
      const [name, version] = pkg.split('@');
      const ver = version || 'latest';
      
      if (runtime) {
        const result = await runtime.installPackage(name, ver, (msg: string) => this.writeln(msg));
        if (result.success) {
          installed++;
          addedPkgs.push({ name, version: ver });
        } else {
          this.writeln(`npm WARN ${result.error}`, true);
        }
      }
      
      // Create node_modules structure
      this.vfs.mkdirp(`node_modules/${name}`);
      this.vfs.writeFile(
        `node_modules/${name}/package.json`,
        new TextEncoder().encode(JSON.stringify({ name, version: ver, main: 'index.js' }))
      );
      this.vfs.writeFile(
        `node_modules/${name}/index.js`,
        new TextEncoder().encode(`// ${name}@${ver}\nmodule.exports = {};`)
      );
    }

    // Update package.json dependencies
    if (this.vfs.exists('package.json') && addedPkgs.length > 0) {
      try {
        const pkg = JSON.parse(new TextDecoder().decode(this.vfs.readFile('package.json')));
        pkg.dependencies = pkg.dependencies || {};
        for (const { name, version } of addedPkgs) {
          pkg.dependencies[name] = `^${version}`;
        }
        this.vfs.writeFile('package.json', new TextEncoder().encode(JSON.stringify(pkg, null, 2)));
      } catch {
        // Ignore package.json update errors
      }
    }

    this.writeln(`\nadded ${installed} packages`);
    this.writeln('');
    return 0;
  }

  private npmInit(_args: string[]): number {
    const pkg = {
      name: 'my-project',
      version: '1.0.0',
      description: '',
      main: 'index.js',
      scripts: {
        test: 'echo "Error: no test specified" && exit 1',
        start: 'node index.js'
      },
      keywords: [],
      author: '',
      license: 'ISC',
      dependencies: {}
    };

    this.vfs.writeFile('package.json', new TextEncoder().encode(JSON.stringify(pkg, null, 2)));
    this.writeln('Wrote to package.json:');
    this.writeln('');
    this.writeln(JSON.stringify(pkg, null, 2));
    return 0;
  }

  private async npmRun(args: string[]): Promise<number> {
    const script = args[0];
    if (!script) {
      // List available scripts
      if (this.vfs.exists('package.json')) {
        const pkg = JSON.parse(new TextDecoder().decode(this.vfs.readFile('package.json')));
        this.writeln('Scripts available:');
        for (const [name, cmd] of Object.entries(pkg.scripts || {})) {
          this.writeln(`  ${name}: ${cmd}`);
        }
        return 0;
      }
      this.writeln('npm ERR! No package.json found', true);
      return 1;
    }

    try {
      const pkg = JSON.parse(new TextDecoder().decode(this.vfs.readFile('package.json')));
      const cmd = pkg.scripts?.[script];
      
      if (!cmd) {
        this.writeln(`npm ERR! Missing script: "${script}"`, true);
        this.writeln('');
        this.writeln('Available scripts:');
        for (const name of Object.keys(pkg.scripts || {})) {
          this.writeln(`  - ${name}`);
        }
        return 1;
      }

      this.writeln(`\n> ${pkg.name}@${pkg.version} ${script}`);
      this.writeln(`> ${cmd}\n`);
      
      // Execute the script command in the shell
      return await this.execute(String(cmd));
    } catch {
      this.writeln('npm ERR! No package.json found', true);
      return 1;
    }
  }

  private npmList(): number {
    if (!this.vfs.exists('node_modules')) {
      this.writeln('(empty)');
      return 0;
    }

    const entries = this.vfs.readdir('node_modules');
    const packages: { name: string; version: string }[] = [];

    for (const entry of entries) {
      if (!entry.startsWith('.')) {
        try {
          const pkgJson = JSON.parse(
            new TextDecoder().decode(this.vfs.readFile(`node_modules/${entry}/package.json`))
          );
          packages.push({ name: pkgJson.name, version: pkgJson.version });
        } catch {
          packages.push({ name: entry, version: 'unknown' });
        }
      }
    }

    if (packages.length === 0) {
      this.writeln('(empty)');
      return 0;
    }

    for (const pkg of packages) {
      this.writeln(`├── ${pkg.name}@${pkg.version}`);
    }

    return 0;
  }

  private async cmdPip(args: string[]): Promise<number> {
    const subcmd = args[0] || 'help';

    switch (subcmd) {
      case 'install':
        return await this.pipInstall(args.slice(1));
      case 'list':
        return await this.pipList();
      case 'freeze':
        return await this.pipFreeze();
      case 'uninstall':
        this.writeln('pip uninstall: Not supported in WebAssembly environment');
        return 1;
      case '--version':
      case '-V':
        this.writeln('pip 23.0 (python 3.11) [Pyodide/micropip]');
        return 0;
      case 'help':
      default:
        this.writeln('pip - Python Package Installer (micropip)\n');
        this.writeln('Uses micropip to install REAL PyPI packages!\n');
        this.writeln('Commands:');
        this.writeln('  pip install <pkg>   Install packages from PyPI');
        this.writeln('  pip install -r req  Install from requirements.txt');
        this.writeln('  pip list           List installed packages');
        this.writeln('  pip freeze         Output installed packages');
        this.writeln('  pip --version      Show version');
        this.writeln('\nNote: Only pure-Python packages are supported.');
        return 0;
    }
  }

  private async pipInstall(args: string[]): Promise<number> {
    let packages: string[] = [];
    
    // Parse arguments
    let i = 0;
    while (i < args.length) {
      if (args[i] === '-r' && i + 1 < args.length) {
        // Read from requirements file
        const reqFile = args[i + 1];
        if (this.vfs.exists(reqFile)) {
          const reqs = new TextDecoder().decode(this.vfs.readFile(reqFile));
          const parsed = reqs.split('\n')
            .map(l => l.split('#')[0].trim())
            .filter(l => l && !l.startsWith('-'));
          packages.push(...parsed);
        } else {
          this.writeln(`pip: ERROR: No such file: ${reqFile}`, true);
          return 1;
        }
        i += 2;
      } else if (!args[i].startsWith('-')) {
        packages.push(args[i]);
        i++;
      } else {
        i++; // Skip unknown flags
      }
    }

    if (packages.length === 0) {
      this.writeln('Usage: pip install <package> [package2 ...]', true);
      return 1;
    }

    // Get Python runtime with micropip
    const runtime = runtimeManager.getRuntime('python') as any;
    if (!runtime) {
      this.writeln('pip: ERROR: Python runtime not available', true);
      return 1;
    }

    // Ensure runtime is loaded
    if (!runtime.isLoaded) {
      this.writeln('Loading Python runtime...');
      await runtime.load();
    }

    this.writeln('');
    let failed = 0;
    
    for (const pkg of packages) {
      const result = await runtime.installPackage(pkg, (msg: string) => this.writeln(msg));
      if (!result.success) {
        this.writeln(`  ERROR: ${result.error}`, true);
        failed++;
      }
    }

    this.writeln('');
    if (failed > 0) {
      this.writeln(`Installed ${packages.length - failed} packages, ${failed} failed.`, true);
      return 1;
    }
    
    this.writeln(`Successfully installed ${packages.length} package(s).`);
    return 0;
  }

  private async pipList(): Promise<number> {
    const runtime = runtimeManager.getRuntime('python') as any;
    if (!runtime?.isLoaded) {
      this.writeln('pip: Python runtime not loaded', true);
      return 1;
    }

    const packages = await runtime.listPackages();
    
    this.writeln('Package                  Version');
    this.writeln('------------------------ --------');
    
    for (const pkg of packages) {
      const name = pkg.name.padEnd(24);
      this.writeln(`${name} ${pkg.version}`);
    }
    
    return 0;
  }

  private async pipFreeze(): Promise<number> {
    const runtime = runtimeManager.getRuntime('python') as any;
    if (!runtime?.isLoaded) {
      this.writeln('pip: Python runtime not loaded', true);
      return 1;
    }

    const packages = await runtime.listPackages();
    
    for (const pkg of packages) {
      this.writeln(`${pkg.name}==${pkg.version}`);
    }
    
    return 0;
  }

  private async cmdYarn(args: string[]): Promise<number> {
    // Yarn is similar to npm
    if (args[0] === 'add') {
      return this.npmInstall(args.slice(1));
    }
    return await this.cmdNpm(args);
  }

  private async cmdPnpm(args: string[]): Promise<number> {
    // pnpm is similar to npm
    return await this.cmdNpm(args);
  }

  // ============================================
  // Git Commands
  // ============================================

  private async cmdGit(args: string[]): Promise<number> {
    const subcmd = args[0] || 'help';

    switch (subcmd) {
      case 'clone':
        return await this.gitClone(args.slice(1));
      case 'init':
        return this.gitInit();
      case 'status':
        return this.gitStatus();
      case 'add':
      case 'commit':
      case 'push':
      case 'pull':
        this.writeln(`git ${subcmd}: Remote operations not supported in WebAssembly`, true);
        this.writeln('(This is a sandboxed environment without network git access)');
        return 1;
      case '--version':
        this.writeln('git version 2.40.0 (shazi-shell)');
        return 0;
      case 'help':
      default:
        this.writeln('git - Version Control (WebAssembly)\n');
        this.writeln('Supports cloning public GitHub repositories!\n');
        this.writeln('Commands:');
        this.writeln('  git clone <url>    Clone a GitHub repository');
        this.writeln('  git init          Initialize a git repository');
        this.writeln('  git status        Show working tree status');
        this.writeln('  git --version     Show version');
        this.writeln('\nExamples:');
        this.writeln('  git clone https://github.com/user/repo');
        this.writeln('  git clone github.com/user/repo');
        this.writeln('  git clone user/repo');
        return 0;
    }
  }

  private async gitClone(args: string[]): Promise<number> {
    if (args.length === 0) {
      this.writeln('usage: git clone <repository> [directory]', true);
      return 1;
    }

    let repoUrl = args[0];
    let targetDir = args[1];

    // Parse GitHub URL
    let owner: string, repo: string, branch = 'main';

    // Handle various URL formats
    // https://github.com/owner/repo
    // github.com/owner/repo
    // owner/repo
    // https://github.com/owner/repo/tree/branch
    
    const fullUrlMatch = repoUrl.match(/(?:https?:\/\/)?github\.com\/([^\/]+)\/([^\/]+?)(?:\.git)?(?:\/tree\/([^\/]+))?$/);
    const shortMatch = repoUrl.match(/^([^\/]+)\/([^\/]+?)(?:\.git)?$/);

    if (fullUrlMatch) {
      owner = fullUrlMatch[1];
      repo = fullUrlMatch[2].replace(/\.git$/, '');
      if (fullUrlMatch[3]) branch = fullUrlMatch[3];
    } else if (shortMatch) {
      owner = shortMatch[1];
      repo = shortMatch[2].replace(/\.git$/, '');
    } else {
      this.writeln(`git clone: Invalid repository URL: ${repoUrl}`, true);
      this.writeln('Expected format: owner/repo or https://github.com/owner/repo');
      return 1;
    }

    targetDir = targetDir || repo;

    if (this.vfs.exists(targetDir)) {
      this.writeln(`fatal: destination path '${targetDir}' already exists`, true);
      return 1;
    }

    this.writeln(`Cloning into '${targetDir}'...`);

    try {
      // Use GitHub API to get repository contents
      const apiUrl = `https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`;
      
      const response = await fetch(apiUrl, {
        headers: {
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'shazi-shell'
        }
      });

      if (!response.ok) {
        if (response.status === 404) {
          this.writeln(`fatal: repository '${owner}/${repo}' not found`, true);
        } else if (response.status === 403) {
          this.writeln(`fatal: API rate limit exceeded. Try again later.`, true);
        } else {
          this.writeln(`fatal: Could not read from repository (${response.status})`, true);
        }
        return 1;
      }

      const data = await response.json();
      const tree = data.tree as { path: string; type: string; sha: string; size?: number }[];

      // Create target directory
      this.vfs.mkdir(targetDir);
      this.vfs.mkdir(`${targetDir}/.git`);

      // Create .git/config
      this.vfs.writeFile(
        `${targetDir}/.git/config`,
        new TextEncoder().encode(`[core]
	repositoryformatversion = 0
	filemode = true
	bare = false
[remote "origin"]
	url = https://github.com/${owner}/${repo}.git
	fetch = +refs/heads/*:refs/remotes/origin/*
[branch "${branch}"]
	remote = origin
	merge = refs/heads/${branch}
`)
      );

      // Track files for progress
      const files = tree.filter(item => item.type === 'blob');
      const dirs = tree.filter(item => item.type === 'tree');

      // Create directories first
      for (const dir of dirs) {
        this.vfs.mkdirp(`${targetDir}/${dir.path}`);
      }

      // Fetch and create files
      let fetched = 0;
      const total = files.length;

      for (const file of files) {
        try {
          // Fetch file content from raw.githubusercontent.com
          const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${file.path}`;
          const fileResponse = await fetch(rawUrl);
          
          if (fileResponse.ok) {
            const content = await fileResponse.arrayBuffer();
            
            // Ensure parent directory exists
            const parentDir = file.path.split('/').slice(0, -1).join('/');
            if (parentDir) {
              this.vfs.mkdirp(`${targetDir}/${parentDir}`);
            }
            
            this.vfs.writeFile(`${targetDir}/${file.path}`, new Uint8Array(content));
            fetched++;
            
            // Progress indicator
            if (fetched % 10 === 0 || fetched === total) {
              this.writeln(`Receiving objects: ${Math.round(fetched / total * 100)}% (${fetched}/${total})`);
            }
          }
        } catch {
          // Skip files that fail to fetch
        }
      }

      this.writeln(`Resolving deltas: 100% (${fetched}/${fetched}), done.`);
      return 0;
    } catch (error: any) {
      this.writeln(`fatal: ${error?.message || 'Could not clone repository'}`, true);
      return 1;
    }
  }

  private gitInit(): number {
    if (this.vfs.exists('.git')) {
      const cwd = this.env.get('PWD') || '/';
      this.writeln(`Reinitialized existing Git repository in ${cwd}/.git/`);
      return 0;
    }

    this.vfs.mkdir('.git');
    this.vfs.mkdir('.git/objects');
    this.vfs.mkdir('.git/refs');
    this.vfs.mkdir('.git/refs/heads');
    
    this.vfs.writeFile('.git/HEAD', new TextEncoder().encode('ref: refs/heads/main\n'));
    this.vfs.writeFile('.git/config', new TextEncoder().encode(`[core]
	repositoryformatversion = 0
	filemode = true
	bare = false
`));

    const cwd = this.env.get('PWD') || '/';
    this.writeln(`Initialized empty Git repository in ${cwd}/.git/`);
    return 0;
  }

  private gitStatus(): number {
    if (!this.vfs.exists('.git')) {
      this.writeln('fatal: not a git repository (or any parent up to mount point /)', true);
      return 1;
    }

    this.writeln('On branch main');
    this.writeln('');
    this.writeln('No commits yet');
    this.writeln('');
    
    // List untracked files
    const cwd = this.env.get('PWD') || '/';
    const entries = this.vfs.readdir(cwd);
    const untracked = entries.filter(e => !e.startsWith('.'));
    
    if (untracked.length > 0) {
      this.writeln('Untracked files:');
      this.writeln('  (use "git add <file>..." to include in what will be committed)');
      this.writeln('');
      for (const file of untracked) {
        this.writeln(`\t${file}`);
      }
      this.writeln('');
    }

    return 0;
  }

  // ============================================
  // Shell Commands
  // ============================================

  private async cmdShell(args: string[]): Promise<number> {
    if (args.length === 0) {
      this.writeln('shazi-shell 1.0.0 - WebAssembly POSIX Shell');
      this.writeln('Type "exit" to return to parent shell');
      return 0;
    }

    // sh -c "command"
    if (args[0] === '-c' && args.length > 1) {
      const cmd = args.slice(1).join(' ');
      return await this.execute(cmd);
    }

    // Execute script file
    const scriptPath = args[0];
    if (this.vfs.exists(scriptPath)) {
      const stat = this.vfs.stat(scriptPath);
      if (stat.type === 'file') {
        return await this.executeScript(scriptPath, args.slice(1));
      }
      this.writeln(`sh: ${scriptPath}: Is a directory`, true);
      return 1;
    }

    this.writeln(`sh: ${scriptPath}: No such file or directory`, true);
    return 127;
  }

  private cmdAlias(args: string[]): number {
    if (args.length === 0) {
      for (const [name, value] of this.aliases) {
        this.writeln(`alias ${name}='${value}'`);
      }
      return 0;
    }

    for (const arg of args) {
      const match = arg.match(/^(\w+)=(.+)$/);
      if (match) {
        this.aliases.set(match[1], match[2].replace(/^['"]|['"]$/g, ''));
      } else {
        const value = this.aliases.get(arg);
        if (value) {
          this.writeln(`alias ${arg}='${value}'`);
        }
      }
    }
    return 0;
  }

  private cmdUnalias(args: string[]): number {
    for (const name of args) {
      this.aliases.delete(name);
    }
    return 0;
  }

  private async cmdSource(args: string[]): Promise<number> {
    if (args.length === 0) {
      this.writeln('source: filename argument required', true);
      return 1;
    }

    const file = args[0];
    if (!this.vfs.exists(file)) {
      this.writeln(`source: ${file}: No such file`, true);
      return 1;
    }

    const content = new TextDecoder().decode(this.vfs.readFile(file));
    return await this.execute(content);
  }

  // ============================================
  // History & UI
  // ============================================

  addToHistory(command: string): void {
    if (command.trim() && command !== this.history[this.history.length - 1]) {
      this.history.push(command);
      if (this.history.length > 1000) this.history.shift();
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

  private cmdHistory(): number {
    this.history.forEach((cmd, i) => {
      this.writeln(`  ${(i + 1).toString().padStart(4)}  ${cmd}`);
    });
    return 0;
  }

  getPrompt(): string {
    const cwd = this.vfs.getCwd();
    const home = this.env.get('HOME')!;
    const displayPath = cwd.startsWith(home) ? '~' + cwd.slice(home.length) : cwd;
    return `\x1b[32mshazi\x1b[0m:\x1b[34m${displayPath}\x1b[0m$ `;
  }

  private cmdRuntimes(): number {
    const runtimes = runtimeManager.listRuntimes();
    this.writeln('Available language runtimes:\n');
    for (const rt of runtimes) {
      const status = rt.loaded ? '\x1b[32m✓\x1b[0m' : '\x1b[33m○\x1b[0m';
      this.writeln(`  ${status} ${rt.name.padEnd(10)} - ${rt.description}`);
    }
    this.writeln('\nUsage: <runtime> <file> or <runtime> -c "code"');
    return 0;
  }

  private cmdHelp(): number {
    this.writeln(`
\x1b[1;36m╔══════════════════════════════════════════════════════════════╗
║         Shazi Shell - WebAssembly POSIX Shell v1.0.0         ║
╚══════════════════════════════════════════════════════════════╝\x1b[0m

\x1b[1;33m📁 File Operations:\x1b[0m
  ls [-alh] [path]           List directory contents
  cat/head/tail <file>       View file contents
  touch/mkdir/rm/cp/mv       Create, delete, copy, move files
  grep/wc/sort/uniq/cut/tr   Search and process text

\x1b[1;33m🔄 Control Structures:\x1b[0m
  for i in {1..5}; do echo $i; done
  while [ $i -lt 5 ]; do echo $i; i=$((i+1)); done
  if [ -f file ]; then echo exists; else echo no; fi
  case $var in a) echo A;; *) echo other;; esac

\x1b[1;33m📊 Variables & Expansion:\x1b[0m
  VAR=value                  Set variable
  echo $VAR \${VAR:-default}  Use variable with default
  echo $((1+2*3))            Arithmetic expansion
  echo $(pwd)                Command substitution
  echo {1..5} {a,b,c}        Brace expansion

\x1b[1;33m🔗 Pipes & Redirects:\x1b[0m
  cmd1 | cmd2 | cmd3         Pipe output through commands
  cmd > file                 Redirect stdout to file
  cmd >> file                Append to file
  cmd 2>&1                   Redirect stderr to stdout

\x1b[1;33m📦 Package Managers (REAL packages!):\x1b[0m
  npm init                   Create package.json
  npm install [pkg]          Install from npm registry
  npm run <script>           Run package.json scripts
  pip install <pkg>          Install Python packages (micropip)
  pip list                   List installed packages

\x1b[1;33m🌐 Network Commands:\x1b[0m
  curl <url>                 Fetch URL content
  wget <url>                 Download files
  git clone <repo>           Clone GitHub repositories
  git init                   Initialize git repository

\x1b[1;33m🖥️ Language Runtimes:\x1b[0m
  python [file]              Python 3.11 (Pyodide)
  python -c "code"           Run Python inline
  node [file]                JavaScript (QuickJS)
  node -e "code"             Run JS inline

\x1b[1;33m⚙️ Shell Commands:\x1b[0m
  history                    Command history
  alias name='cmd'           Create alias
  sh script.sh               Execute shell script
  source file                Source a file
  clear                      Clear terminal
  exit                       Exit shell

Type 'runtimes' for all available language runtimes.
`.trim());
    return 0;
  }
}
