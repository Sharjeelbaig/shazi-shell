/**
 * Language Runtime Manager
 * Handles loading and executing code in various languages via WASM
 */

import { VirtualFileSystem } from './vfs';

export interface RuntimeResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface LanguageRuntime {
  name: string;
  extensions: string[];
  isLoaded: boolean;
  supportsRepl: boolean;
  load(): Promise<void>;
  execute(code: string, args: string[], vfs: VirtualFileSystem): Promise<RuntimeResult>;
  executeFile(path: string, args: string[], vfs: VirtualFileSystem): Promise<RuntimeResult>;
  // REPL methods
  createRepl?(onOutput: (text: string, isError: boolean) => void): Promise<ReplSession>;
}

export interface ReplSession {
  execute(input: string): Promise<{ result: string | null; error: string | null; continueInput: boolean }>;
  destroy(): void;
  getPrompt(): string;
}

// Pyodide for Python
class PythonRuntime implements LanguageRuntime {
  name = 'Python';
  extensions = ['.py'];
  isLoaded = false;
  supportsRepl = true;
  private pyodide: any = null;

  async load(): Promise<void> {
    if (this.isLoaded) return;

    try {
      // Load Pyodide from CDN
      // @ts-ignore - Pyodide is loaded dynamically
      const { loadPyodide } = await import('https://cdn.jsdelivr.net/pyodide/v0.24.1/full/pyodide.mjs');
      this.pyodide = await loadPyodide({
        indexURL: 'https://cdn.jsdelivr.net/pyodide/v0.24.1/full/',
      });
      this.isLoaded = true;
    } catch (error) {
      throw new Error(`Failed to load Python runtime: ${error}`);
    }
  }

  async execute(code: string, _args: string[], _vfs: VirtualFileSystem): Promise<RuntimeResult> {
    if (!this.isLoaded) {
      await this.load();
    }

    let stdout = '';
    let stderr = '';

    try {
      // Redirect stdout/stderr
      this.pyodide.setStdout({ batched: (text: string) => { stdout += text + '\n'; } });
      this.pyodide.setStderr({ batched: (text: string) => { stderr += text + '\n'; } });

      await this.pyodide.runPythonAsync(code);
      return { exitCode: 0, stdout, stderr };
    } catch (error) {
      stderr += error instanceof Error ? error.message : String(error);
      return { exitCode: 1, stdout, stderr };
    }
  }

  async executeFile(path: string, args: string[], vfs: VirtualFileSystem): Promise<RuntimeResult> {
    const content = new TextDecoder().decode(vfs.readFile(path));
    return this.execute(content, args, vfs);
  }

  async createRepl(onOutput: (text: string, isError: boolean) => void): Promise<ReplSession> {
    if (!this.isLoaded) {
      await this.load();
    }

    const pyodide = this.pyodide;
    let inputBuffer = '';
    let indentLevel = 0;

    // Set up stdout/stderr for REPL
    pyodide.setStdout({ batched: (text: string) => onOutput(text + '\n', false) });
    pyodide.setStderr({ batched: (text: string) => onOutput(text + '\n', true) });

    // Initialize Python REPL helper
    await pyodide.runPythonAsync(`
import sys
import code
import io
from contextlib import redirect_stdout, redirect_stderr

class ReplHelper:
    def __init__(self):
        self.locals = {}
        self.buffer = []
    
    def push(self, line):
        """Push a line to the buffer. Returns True if more input is needed."""
        self.buffer.append(line)
        source = '\\n'.join(self.buffer)
        
        try:
            compiled = code.compile_command(source, '<stdin>', 'single')
            if compiled is None:
                # Incomplete input
                return True
            
            # Complete, execute it
            self.buffer = []
            exec(compiled, self.locals)
            return False
        except SyntaxError as e:
            if 'unexpected EOF' in str(e) or 'EOF while scanning' in str(e):
                return True
            self.buffer = []
            raise
        except:
            self.buffer = []
            raise
    
    def reset(self):
        self.buffer = []

_repl_helper = ReplHelper()
`);

    return {
      async execute(input: string): Promise<{ result: string | null; error: string | null; continueInput: boolean }> {
        try {
          // Check for exit commands
          const trimmed = input.trim();
          if (trimmed === 'exit()' || trimmed === 'quit()') {
            return { result: null, error: null, continueInput: false };
          }

          // Handle multi-line input
          inputBuffer += input;
          
          const needsMore = await pyodide.runPythonAsync(`
try:
    _needs_more = _repl_helper.push(${JSON.stringify(input)})
    _needs_more
except Exception as e:
    print(str(e), file=sys.stderr)
    _repl_helper.reset()
    False
`);
          
          if (needsMore) {
            indentLevel = (inputBuffer.match(/:\s*$/m) ? 1 : 0) + 
                          (inputBuffer.split('\n').length - 1);
            return { result: null, error: null, continueInput: true };
          }

          inputBuffer = '';
          indentLevel = 0;
          return { result: null, error: null, continueInput: false };
        } catch (error) {
          inputBuffer = '';
          indentLevel = 0;
          const errMsg = error instanceof Error ? error.message : String(error);
          return { result: null, error: errMsg, continueInput: false };
        }
      },

      destroy(): void {
        // Cleanup if needed
      },

      getPrompt(): string {
        return indentLevel > 0 || inputBuffer.length > 0 ? '... ' : '>>> ';
      }
    };
  }
}

// QuickJS for JavaScript/Node.js
class JavaScriptRuntime implements LanguageRuntime {
  name = 'JavaScript (QuickJS)';
  extensions = ['.js', '.mjs'];
  isLoaded = false;
  supportsRepl = true;
  private quickjs: any = null;

  async load(): Promise<void> {
    if (this.isLoaded) return;

    try {
      // Load QuickJS WASM from CDN
      // @ts-ignore - QuickJS is loaded dynamically
      const { getQuickJS } = await import('https://esm.sh/quickjs-emscripten@0.29.2');
      this.quickjs = await getQuickJS();
      this.isLoaded = true;
    } catch (error) {
      throw new Error(`Failed to load JavaScript runtime: ${error}`);
    }
  }

  async execute(code: string, _args: string[], _vfs: VirtualFileSystem): Promise<RuntimeResult> {
    if (!this.isLoaded) {
      await this.load();
    }

    let stdout = '';
    let stderr = '';

    try {
      const vm = this.quickjs.newContext();

      // Add console.log
      const logHandle = vm.newFunction('log', (...args: any[]) => {
        const strings = args.map((arg: any) => {
          const str = vm.getString(arg);
          return str;
        });
        stdout += strings.join(' ') + '\n';
      });

      const consoleHandle = vm.newObject();
      vm.setProp(consoleHandle, 'log', logHandle);
      vm.setProp(vm.global, 'console', consoleHandle);
      consoleHandle.dispose();
      logHandle.dispose();

      const result = vm.evalCode(code);
      if (result.error) {
        stderr = vm.getString(result.error);
        result.error.dispose();
        vm.dispose();
        return { exitCode: 1, stdout, stderr };
      }

      result.value.dispose();
      vm.dispose();
      return { exitCode: 0, stdout, stderr };
    } catch (error) {
      stderr += error instanceof Error ? error.message : String(error);
      return { exitCode: 1, stdout, stderr };
    }
  }

  async executeFile(path: string, args: string[], vfs: VirtualFileSystem): Promise<RuntimeResult> {
    const content = new TextDecoder().decode(vfs.readFile(path));
    return this.execute(content, args, vfs);
  }

  async createRepl(onOutput: (text: string, isError: boolean) => void): Promise<ReplSession> {
    if (!this.isLoaded) {
      await this.load();
    }

    const quickjs = this.quickjs;
    const vm = quickjs.newContext();
    let inputBuffer = '';

    // Set up console.log
    const logHandle = vm.newFunction('log', (...args: any[]) => {
      const strings = args.map((arg: any) => vm.getString(arg));
      onOutput(strings.join(' ') + '\n', false);
    });

    const warnHandle = vm.newFunction('warn', (...args: any[]) => {
      const strings = args.map((arg: any) => vm.getString(arg));
      onOutput(strings.join(' ') + '\n', false);
    });

    const errorHandle = vm.newFunction('error', (...args: any[]) => {
      const strings = args.map((arg: any) => vm.getString(arg));
      onOutput(strings.join(' ') + '\n', true);
    });

    const consoleHandle = vm.newObject();
    vm.setProp(consoleHandle, 'log', logHandle);
    vm.setProp(consoleHandle, 'warn', warnHandle);
    vm.setProp(consoleHandle, 'error', errorHandle);
    vm.setProp(vm.global, 'console', consoleHandle);
    consoleHandle.dispose();
    logHandle.dispose();
    warnHandle.dispose();
    errorHandle.dispose();

    return {
      async execute(input: string): Promise<{ result: string | null; error: string | null; continueInput: boolean }> {
        const trimmed = input.trim();

        // Check for exit
        if (trimmed === '.exit' || trimmed === 'exit' || trimmed === 'exit()') {
          return { result: null, error: null, continueInput: false };
        }

        // Handle multi-line input (check for unclosed braces/brackets/parens)
        inputBuffer += input;
        
        // Simple bracket matching for multi-line detection
        let openBraces = 0;
        let openBrackets = 0;
        let openParens = 0;
        let inString = false;
        let stringChar = '';
        
        for (let i = 0; i < inputBuffer.length; i++) {
          const char = inputBuffer[i];
          const prevChar = i > 0 ? inputBuffer[i - 1] : '';
          
          if (inString) {
            if (char === stringChar && prevChar !== '\\') {
              inString = false;
            }
          } else {
            if (char === '"' || char === "'" || char === '`') {
              inString = true;
              stringChar = char;
            } else if (char === '{') openBraces++;
            else if (char === '}') openBraces--;
            else if (char === '[') openBrackets++;
            else if (char === ']') openBrackets--;
            else if (char === '(') openParens++;
            else if (char === ')') openParens--;
          }
        }

        if (openBraces > 0 || openBrackets > 0 || openParens > 0 || inString) {
          inputBuffer += '\n';
          return { result: null, error: null, continueInput: true };
        }

        const code = inputBuffer;
        inputBuffer = '';

        try {
          const result = vm.evalCode(code);
          
          if (result.error) {
            const errStr = vm.getString(result.error);
            result.error.dispose();
            return { result: null, error: errStr, continueInput: false };
          }

          // Get result value for display
          const value = result.value;
          let resultStr: string | null = null;
          
          const type = vm.typeof(value);
          if (type !== 'undefined') {
            try {
              // Try to stringify the result
              if (type === 'string') {
                resultStr = "'" + vm.getString(value) + "'";
              } else if (type === 'number' || type === 'boolean') {
                resultStr = vm.getString(vm.evalCode(`String(${vm.getString(value)})`).value);
              } else if (type === 'object' || type === 'function') {
                const jsonResult = vm.evalCode(`JSON.stringify(${vm.getString(value)}, null, 2)`);
                if (!jsonResult.error) {
                  resultStr = vm.getString(jsonResult.value);
                  jsonResult.value.dispose();
                }
              }
            } catch {
              resultStr = vm.getString(value);
            }
          }
          
          value.dispose();
          return { result: resultStr, error: null, continueInput: false };
        } catch (error) {
          inputBuffer = '';
          return { 
            result: null, 
            error: error instanceof Error ? error.message : String(error), 
            continueInput: false 
          };
        }
      },

      destroy(): void {
        vm.dispose();
      },

      getPrompt(): string {
        return inputBuffer.length > 0 ? '... ' : '> ';
      }
    };
  }
}

// Simple C interpreter (limited subset)
class CRuntime implements LanguageRuntime {
  name = 'C (Interpreter)';
  extensions = ['.c'];
  isLoaded = true; // No external loading needed
  supportsRepl = false;

  async load(): Promise<void> {
    // Built-in interpreter, no loading needed
  }

  async execute(code: string, _args: string[], _vfs: VirtualFileSystem): Promise<RuntimeResult> {
    let stdout = '';
    const stderr = '';

    // Very simple C interpreter for basic programs
    // Handles printf with string literals
    const printfMatches = code.matchAll(/printf\s*\(\s*"([^"]*)"(?:\s*,\s*([^)]+))?\s*\)/g);

    for (const match of printfMatches) {
      let output = match[1];
      // Handle escape sequences
      output = output
        .replace(/\\n/g, '\n')
        .replace(/\\t/g, '\t')
        .replace(/\\r/g, '\r')
        .replace(/\\\\/g, '\\');

      // Handle format specifiers if there are arguments
      if (match[2]) {
        const args = match[2].split(',').map(a => a.trim());
        let argIndex = 0;
        output = output.replace(/%[difs]/g, () => {
          return args[argIndex++] || '';
        });
      }

      stdout += output;
    }

    // Check for main function
    if (!code.includes('main')) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: 'Error: No main function found\n',
      };
    }

    return { exitCode: 0, stdout, stderr };
  }

  async executeFile(path: string, args: string[], vfs: VirtualFileSystem): Promise<RuntimeResult> {
    const content = new TextDecoder().decode(vfs.readFile(path));
    return this.execute(content, args, vfs);
  }
}

// C++ uses the same simple interpreter as C for now
class CppRuntime extends CRuntime {
  name = 'C++ (Interpreter)';
  extensions = ['.cpp', '.cc', '.cxx'];
  supportsRepl = false;

  async execute(code: string, args: string[], vfs: VirtualFileSystem): Promise<RuntimeResult> {
    // Handle cout
    let stdout = '';
    const coutMatches = code.matchAll(/(?:std::)?cout\s*<<\s*(?:"([^"]*)"|([\w]+))/g);

    for (const match of coutMatches) {
      if (match[1]) {
        stdout += match[1].replace(/\\n/g, '\n').replace(/\\t/g, '\t');
      } else if (match[2] === 'endl') {
        stdout += '\n';
      }
    }

    if (stdout) {
      return { exitCode: 0, stdout, stderr: '' };
    }

    // Fall back to C-style printf
    return super.execute(code, args, vfs);
  }
}

// Java simulation (no real JVM in browser)
class JavaRuntime implements LanguageRuntime {
  name = 'Java (Simulator)';
  extensions = ['.java'];
  isLoaded = true;
  supportsRepl = false;

  async load(): Promise<void> {}

  async execute(code: string, _args: string[], _vfs: VirtualFileSystem): Promise<RuntimeResult> {
    let stdout = '';

    // Extract System.out.println statements
    const printlnMatches = code.matchAll(/System\.out\.println\s*\(\s*(?:"([^"]*)"|([\w\s+]+))\s*\)/g);

    for (const match of printlnMatches) {
      if (match[1]) {
        stdout += match[1] + '\n';
      } else if (match[2]) {
        // Try to evaluate simple expressions
        stdout += match[2].trim() + '\n';
      }
    }

    // Extract System.out.print statements
    const printMatches = code.matchAll(/System\.out\.print\s*\(\s*"([^"]*)"\s*\)/g);
    for (const match of printMatches) {
      stdout += match[1];
    }

    // Check for main method
    if (!code.includes('public static void main')) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: 'Error: No main method found. Java requires:\n  public static void main(String[] args)\n',
      };
    }

    return { exitCode: 0, stdout, stderr: '' };
  }

  async executeFile(path: string, args: string[], vfs: VirtualFileSystem): Promise<RuntimeResult> {
    const content = new TextDecoder().decode(vfs.readFile(path));
    return this.execute(content, args, vfs);
  }
}

// Lua interpreter (uses Fengari or similar)
class LuaRuntime implements LanguageRuntime {
  name = 'Lua';
  extensions = ['.lua'];
  isLoaded = false;
  supportsRepl = false;
  private fengari: any = null;

  async load(): Promise<void> {
    if (this.isLoaded) return;

    try {
      // @ts-ignore - Fengari loaded dynamically
      this.fengari = await import('https://esm.sh/fengari-web@0.1.4');
      this.isLoaded = true;
    } catch (error) {
      throw new Error(`Failed to load Lua runtime: ${error}`);
    }
  }

  async execute(code: string, _args: string[], _vfs: VirtualFileSystem): Promise<RuntimeResult> {
    if (!this.isLoaded) {
      await this.load();
    }

    let stdout = '';
    const stderr = '';

    try {
      // Simple Lua execution using fengari
      const { lua, lauxlib, lualib } = this.fengari;
      const L = lauxlib.luaL_newstate();
      lualib.luaL_openlibs(L);

      // Execute the code
      if (lauxlib.luaL_dostring(L, code) !== 0) {
        const error = lua.lua_tojsstring(L, -1);
        return { exitCode: 1, stdout: '', stderr: error };
      }

      return { exitCode: 0, stdout, stderr };
    } catch (error) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async executeFile(path: string, args: string[], vfs: VirtualFileSystem): Promise<RuntimeResult> {
    const content = new TextDecoder().decode(vfs.readFile(path));
    return this.execute(content, args, vfs);
  }
}

// Ruby simulation
class RubyRuntime implements LanguageRuntime {
  name = 'Ruby (Simulator)';
  extensions = ['.rb'];
  isLoaded = true;
  supportsRepl = false;

  async load(): Promise<void> {}

  async execute(code: string, _args: string[], _vfs: VirtualFileSystem): Promise<RuntimeResult> {
    let stdout = '';

    // Extract puts statements
    const putsMatches = code.matchAll(/puts\s+(?:"([^"]*)"|([\w]+))/g);
    for (const match of putsMatches) {
      stdout += (match[1] || match[2] || '') + '\n';
    }

    // Extract print statements
    const printMatches = code.matchAll(/print\s+"([^"]*)"/g);
    for (const match of printMatches) {
      stdout += match[1];
    }

    return { exitCode: 0, stdout, stderr: '' };
  }

  async executeFile(path: string, args: string[], vfs: VirtualFileSystem): Promise<RuntimeResult> {
    const content = new TextDecoder().decode(vfs.readFile(path));
    return this.execute(content, args, vfs);
  }
}

// Go simulation
class GoRuntime implements LanguageRuntime {
  name = 'Go (Simulator)';
  extensions = ['.go'];
  isLoaded = true;
  supportsRepl = false;

  async load(): Promise<void> {}

  async execute(code: string, _args: string[], _vfs: VirtualFileSystem): Promise<RuntimeResult> {
    let stdout = '';

    // Extract fmt.Println statements
    const printlnMatches = code.matchAll(/fmt\.Println\s*\(\s*"([^"]*)"\s*\)/g);
    for (const match of printlnMatches) {
      stdout += match[1] + '\n';
    }

    // Extract fmt.Print statements
    const printMatches = code.matchAll(/fmt\.Print\s*\(\s*"([^"]*)"\s*\)/g);
    for (const match of printMatches) {
      stdout += match[1];
    }

    // Check for main function
    if (!code.includes('func main()')) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: 'Error: No main function found\n',
      };
    }

    return { exitCode: 0, stdout, stderr: '' };
  }

  async executeFile(path: string, args: string[], vfs: VirtualFileSystem): Promise<RuntimeResult> {
    const content = new TextDecoder().decode(vfs.readFile(path));
    return this.execute(content, args, vfs);
  }
}

// Rust simulation
class RustRuntime implements LanguageRuntime {
  name = 'Rust (Simulator)';
  extensions = ['.rs'];
  isLoaded = true;
  supportsRepl = false;

  async load(): Promise<void> {}

  async execute(code: string, _args: string[], _vfs: VirtualFileSystem): Promise<RuntimeResult> {
    let stdout = '';

    // Extract println! macro
    const printlnMatches = code.matchAll(/println!\s*\(\s*"([^"]*)"/g);
    for (const match of printlnMatches) {
      stdout += match[1].replace(/\{\}/g, '?') + '\n';
    }

    // Extract print! macro
    const printMatches = code.matchAll(/print!\s*\(\s*"([^"]*)"/g);
    for (const match of printMatches) {
      stdout += match[1].replace(/\{\}/g, '?');
    }

    // Check for main function
    if (!code.includes('fn main()')) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: 'Error: No main function found\n',
      };
    }

    return { exitCode: 0, stdout, stderr: '' };
  }

  async executeFile(path: string, args: string[], vfs: VirtualFileSystem): Promise<RuntimeResult> {
    const content = new TextDecoder().decode(vfs.readFile(path));
    return this.execute(content, args, vfs);
  }
}

// Runtime Manager
export class RuntimeManager {
  private runtimes: Map<string, LanguageRuntime> = new Map();
  private loadingPromises: Map<string, Promise<void>> = new Map();

  constructor() {
    // Register all runtimes
    this.register('python', new PythonRuntime());
    this.register('python3', new PythonRuntime());
    this.register('node', new JavaScriptRuntime());
    this.register('javascript', new JavaScriptRuntime());
    this.register('js', new JavaScriptRuntime());
    this.register('gcc', new CRuntime());
    this.register('cc', new CRuntime());
    this.register('c', new CRuntime());
    this.register('g++', new CppRuntime());
    this.register('cpp', new CppRuntime());
    this.register('java', new JavaRuntime());
    this.register('javac', new JavaRuntime());
    this.register('lua', new LuaRuntime());
    this.register('ruby', new RubyRuntime());
    this.register('go', new GoRuntime());
    this.register('rust', new RustRuntime());
    this.register('rustc', new RustRuntime());
  }

  private register(name: string, runtime: LanguageRuntime): void {
    this.runtimes.set(name, runtime);
  }

  getRuntime(name: string): LanguageRuntime | undefined {
    return this.runtimes.get(name.toLowerCase());
  }

  hasRuntime(name: string): boolean {
    return this.runtimes.has(name.toLowerCase());
  }

  async loadRuntime(name: string): Promise<void> {
    const runtime = this.getRuntime(name);
    if (!runtime) {
      throw new Error(`Unknown runtime: ${name}`);
    }

    if (runtime.isLoaded) return;

    // Prevent duplicate loading
    if (this.loadingPromises.has(name)) {
      return this.loadingPromises.get(name);
    }

    const loadPromise = runtime.load();
    this.loadingPromises.set(name, loadPromise);

    try {
      await loadPromise;
    } finally {
      this.loadingPromises.delete(name);
    }
  }

  listRuntimes(): { name: string; loaded: boolean; description: string }[] {
    const seen = new Set<LanguageRuntime>();
    const result: { name: string; loaded: boolean; description: string }[] = [];

    for (const [key, runtime] of this.runtimes) {
      if (!seen.has(runtime)) {
        seen.add(runtime);
        result.push({
          name: key,
          loaded: runtime.isLoaded,
          description: runtime.name,
        });
      }
    }

    return result;
  }
}

// Singleton instance
export const runtimeManager = new RuntimeManager();
