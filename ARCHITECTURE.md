# WebAssembly Shell Architecture

## System Overview

A fully sandboxed, browser-based execution environment that provides a POSIX-like shell interface with support for Python, Node.js, and other languages via WebAssembly/WASI.

## Core Components

```
┌─────────────────────────────────────────┐
│         Browser Main Thread             │
│  ┌───────────────────────────────────┐  │
│  │   React Terminal UI (xterm.js)    │  │
│  └─────────────┬─────────────────────┘  │
│                │ postMessage()           │
└────────────────┼─────────────────────────┘
                 │
┌────────────────▼─────────────────────────┐
│           Web Worker Thread              │
│  ┌───────────────────────────────────┐  │
│  │      Shell Engine (builtin)       │  │
│  │   - parse commands                │  │
│  │   - dispatch to builtins/WASI     │  │
│  └────────────┬──────────────────────┘  │
│               │                          │
│  ┌────────────▼──────────────────────┐  │
│  │   Virtual File System (VFS)       │  │
│  │   - in-memory POSIX-like FS       │  │
│  │   - /home, /tmp, /bin, etc.       │  │
│  └────────────┬──────────────────────┘  │
│               │                          │
│  ┌────────────▼──────────────────────┐  │
│  │  WASI Runtime (browser_wasi_shim) │  │
│  │  - stdio redirection              │  │
│  │  - filesystem mapping             │  │
│  │  - environment variables          │  │
│  └────────────┬──────────────────────┘  │
│               │                          │
│  ┌────────────▼──────────────────────┐  │
│  │    WASM Binaries (lazy-loaded)    │  │
│  │    - Python 3.11                  │  │
│  │    - Node.js 20                   │  │
│  │    - (future: Lua, C compiler)    │  │
│  └───────────────────────────────────┘  │
└──────────────────────────────────────────┘
```

## Technology Stack

### 1. WASI Runtime
- **[@bjorn3/browser_wasi_shim](https://github.com/bjorn3/browser_wasi_shim)** (8KB)
  - Implements WASI syscalls in browser
  - Handles stdio, filesystem, environment
  - Battle-tested, minimal dependencies

### 2. WASM Language Binaries
- **Python**: Use [python-wasm](https://github.com/wasmerio/python-wasm) or build with wasi-sdk
- **Node.js**: Use unofficial WASI build or [node-wasi](https://github.com/nodejs/node/tree/main/deps/uvwasi)
- **Alternative**: Use [wasi-sdk](https://github.com/WebAssembly/wasi-sdk) to compile interpreters

### 3. Terminal UI
- **[xterm.js](https://xtermjs.org/)** - Industry standard terminal emulator
- **[xterm-addon-fit](https://www.npmjs.com/package/xterm-addon-fit)** - Auto-sizing
- **[xterm-addon-web-links](https://www.npmjs.com/package/xterm-addon-web-links)** - Clickable links

### 4. In-Memory Filesystem
- **Custom implementation** using JavaScript Map/objects
- POSIX-like structure: inodes, directories, symlinks
- ~300 LOC for MVP

### 5. Build System
- **Vite** - Fast dev server, optimized builds
- **TypeScript** - Type safety
- **React** - UI framework (already familiar)

## Implementation Plan (1 Week)

### Day 1-2: Foundation
**Goal**: Working Web Worker with basic I/O

```typescript
// Deliverables:
- [ ] Project scaffolding (Vite + React + TS)
- [ ] Web Worker with message passing
- [ ] In-memory VFS with basic operations
- [ ] Terminal UI with xterm.js
- [ ] Simple echo command working end-to-end
```

**Success Criteria**: Type "echo hello" → see "hello" in terminal

### Day 3-4: Shell Engine
**Goal**: POSIX-like builtin commands

```bash
# Deliverables:
- [ ] Shell parser (split args, handle quotes)
- [ ] Builtin commands: cd, pwd, ls, cat, mkdir, rm, mv, cp
- [ ] Working directory state
- [ ] Environment variables ($PATH, $HOME)
- [ ] Simple piping (cmd1 | cmd2)
```

**Success Criteria**: Navigate filesystem, create/move/delete files

### Day 5-6: WASI Integration
**Goal**: Run Python/Node scripts

```typescript
// Deliverables:
- [ ] Integrate browser_wasi_shim
- [ ] Load Python WASM binary (lazy)
- [ ] Map VFS to WASI filesystem
- [ ] Redirect stdio to terminal
- [ ] Execute: python script.py
```

**Success Criteria**: `echo 'print("hello")' > test.py && python test.py`

### Day 7: Polish
**Goal**: Usable developer experience

```
- [ ] Command history (up/down arrows)
- [ ] Tab completion (files/commands)
- [ ] Ctrl+C interrupt handling
- [ ] Error messages
- [ ] README with examples
```

## What NOT to Build (V1)

❌ **Multi-process support** - Single process execution only  
❌ **Real permissions** - No user/group/chmod (everything is rwx)  
❌ **Networking** - No fetch/websockets from WASM (yet)  
❌ **Background jobs** - No `&` or job control  
❌ **Package managers** - No pip/npm install (pre-bundle packages)  
❌ **Signal handling** - Only basic Ctrl+C  
❌ **Persistent storage** - No IndexedDB/localStorage (ephemeral only)  
❌ **Symlinks** - Hard to implement correctly, skip for MVP  
❌ **Glob expansion** - No `*.txt` wildcards initially  
❌ **Complex piping** - No `|&`, `>`, `>>`, `2>&1` redirects  

## Security Model

### Threat Model

**In-Scope Threats**:
1. Malicious user code attempting DOM access → **BLOCKED** (Web Worker)
2. Infinite loops / CPU exhaustion → **MITIGATED** (Worker can be terminated)
3. Memory exhaustion → **MITIGATED** (WASM heap limits)
4. Filesystem escape attempts → **BLOCKED** (VFS is isolated Map object)
5. Network access attempts → **BLOCKED** (No fetch API exposed to WASM)

**Out-of-Scope**:
- Side-channel attacks (Spectre/Meltdown) - browser responsibility
- Physical attacks - not applicable
- Social engineering - application layer concern

### Isolation Guarantees

```
✓ Code runs in Web Worker (no DOM access)
✓ WASM runs in sandbox (no native syscalls)
✓ VFS is in-memory JavaScript object (no real FS)
✓ No network access from WASM context
✓ No eval() or dynamic code generation
✓ Worker can be terminated anytime
✓ No shared memory with main thread
```

### Attack Surface

**Minimal**:
- Only communication: `postMessage()` from main thread to worker
- WASM binary size limits (max ~100MB realistic)
- No cross-origin resource access

**Developer Responsibilities**:
1. Validate WASM binaries (use official sources)
2. Implement resource limits (timeout, memory)
3. Sanitize user input in terminal UI (XSS prevention)

## Data Flow

### Command Execution

```
User types: "python hello.py"
     ↓
[Terminal UI] captures input
     ↓
postMessage({type: 'exec', cmd: 'python hello.py'})
     ↓
[Worker: Shell] parses command
     ↓
Shell resolves 'python' → /bin/python.wasm
     ↓
[WASI Runtime] loads python.wasm (if not cached)
     ↓
WASI maps VFS to WASM memory
     ↓
Execute WASM with args: ['hello.py']
     ↓
Python reads hello.py via WASI fd_read()
     ↓
Python writes to stdout via WASI fd_write()
     ↓
[Worker] captures stdout, sends to main thread
     ↓
postMessage({type: 'stdout', data: '...'})
     ↓
[Terminal UI] renders output
```

### File Operations

```
User: "echo 'test' > file.txt"
     ↓
[Shell] parses redirect
     ↓
Execute echo, capture stdout
     ↓
[VFS] creates inode, stores content
     ↓
Returns success
```

## File System Structure

```
/
├── home/
│   └── user/          # Default working directory
│       └── (user files here)
├── tmp/               # Temporary files
├── bin/               # WASM binaries (virtual)
│   ├── python.wasm
│   ├── node.wasm
│   └── (others)
└── lib/               # Stdlib for languages
    └── python/
        └── (bundled modules)
```

## API Design

### Worker Message Protocol

```typescript
// Main → Worker
type CommandMessage = {
  type: 'exec';
  command: string;
  cwd?: string;
};

type InitMessage = {
  type: 'init';
  files?: Record<string, Uint8Array>;
};

type InterruptMessage = {
  type: 'interrupt';
};

// Worker → Main
type OutputMessage = {
  type: 'stdout' | 'stderr';
  data: string;
};

type ExitMessage = {
  type: 'exit';
  code: number;
};

type ReadyMessage = {
  type: 'ready';
};
```

### VFS API

```typescript
interface VFS {
  readFile(path: string): Uint8Array;
  writeFile(path: string, data: Uint8Array): void;
  mkdir(path: string): void;
  rmdir(path: string): void;
  unlink(path: string): void;
  rename(oldPath: string, newPath: string): void;
  readdir(path: string): string[];
  stat(path: string): FileStat;
  exists(path: string): boolean;
}
```

## Performance Considerations

- **Lazy-load WASM binaries**: Python is ~15MB, only fetch when needed
- **Cache compiled modules**: Store WebAssembly.Module after compilation
- **Shared Array Buffer**: NOT needed (single process model)
- **Streaming compilation**: Use `WebAssembly.compileStreaming()` for faster startup
- **Virtual scrollback**: xterm.js handles 10k+ lines efficiently

## Limitations (Acknowledged)

1. **No real concurrency** - Single-threaded execution
2. **No native addons** - Pure WASM only
3. **Slow first run** - WASM download + compilation (cache helps)
4. **Limited stdlib** - Must pre-bundle Python/Node modules
5. **Memory-only** - Files lost on refresh (by design)

## Extension Points (Future)

- **Persistence**: Add IndexedDB backing to VFS
- **Networking**: Proxy fetch through worker postMessage
- **Package install**: Download and cache .wasm modules
- **Multi-language**: Add Lua, Rust REPL, C compiler
- **Collaboration**: Sync VFS state via CRDT

## Success Metrics

**MVP is successful if**:
- User can run Python scripts end-to-end
- Basic file operations work (create, edit, delete)
- Terminal feels responsive (<100ms for builtins)
- Can reset environment instantly (reload worker)
- No crashes or security escapes

## References

- [WASI specification](https://github.com/WebAssembly/WASI)
- [browser_wasi_shim](https://github.com/bjorn3/browser_wasi_shim)
- [StackBlitz WebContainers](https://webcontainers.io/) (inspiration, proprietary)
- [Pyodide](https://pyodide.org/) (Python in WASM, but uses Emscripten not pure WASI)
- [Node.js WASI support](https://nodejs.org/api/wasi.html)
