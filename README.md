# Shazi Shell

A WebAssembly-based sandboxed shell environment that runs entirely in your browser. Execute Python, Node.js, and other languages safely without server-side execution.

## Features

- **Fully Sandboxed**: Runs in Web Worker with no DOM access
- **In-Memory Filesystem**: POSIX-like file operations
- **WASM Execution**: Safe execution of untrusted code
- **Multiple Languages**: Python, Node.js (coming soon: Rust, C, Lua)
- **POSIX Commands**: ls, cat, mv, rm, mkdir, cd, pwd, and more

## Quick Start

```bash
# Install dependencies
npm install

# Start development server
npm run dev

# Build for production
npm run build
```

Visit `http://localhost:5173` to use the terminal.

## Architecture

See [ARCHITECTURE.md](./ARCHITECTURE.md) for detailed system design, security model, and implementation details.

### Key Components

```
┌─────────────────────────────────┐
│   React Terminal UI (xterm.js)  │
└────────────┬────────────────────┘
             │ postMessage()
┌────────────▼────────────────────┐
│      Web Worker Thread          │
│  ┌─────────────────────────┐   │
│  │  Shell Engine           │   │
│  │  Virtual File System    │   │
│  │  WASI Runtime           │   │
│  │  WASM Binaries          │   │
│  └─────────────────────────┘   │
└─────────────────────────────────┘
```

## Usage

### Basic Commands

```bash
# Navigate filesystem
pwd                 # Print working directory
cd /home/user       # Change directory
ls                  # List files

# File operations
touch file.txt      # Create file
echo "hello" > file.txt  # Write to file
cat file.txt        # Read file
mv old.txt new.txt  # Rename
cp file.txt copy.txt # Copy
rm file.txt         # Delete

# Directories
mkdir mydir         # Create directory
mkdir -p a/b/c      # Create nested directories
rm -r mydir         # Remove directory recursively
```

### Python (Coming Soon)

```bash
# Create Python script
echo 'print("Hello from WASM!")' > hello.py

# Execute
python hello.py
```

## Technology Stack

- **Runtime**: [@bjorn3/browser_wasi_shim](https://github.com/bjorn3/browser_wasi_shim) - WASI implementation
- **Terminal**: [xterm.js](https://xtermjs.org/) - Terminal emulator
- **Build**: [Vite](https://vitejs.dev/) - Fast dev server
- **Framework**: React + TypeScript

## Security

### Isolation Guarantees

✅ Code runs in Web Worker (no DOM access)  
✅ WASM runs in sandbox (no native syscalls)  
✅ VFS is in-memory (no real filesystem access)  
✅ No network access from WASM  
✅ No eval() or dynamic code generation  
✅ Worker can be terminated anytime  

### Threat Model

**Protected Against**:
- Malicious code accessing DOM → **BLOCKED**
- Filesystem escape attempts → **BLOCKED**
- Unauthorized network access → **BLOCKED**
- CPU exhaustion → **MITIGATED** (worker termination)

See [ARCHITECTURE.md](./ARCHITECTURE.md) for complete security analysis.

## Development Roadmap

### Phase 1: Foundation ✅
- [x] Web Worker sandbox
- [x] In-memory VFS
- [x] Basic shell commands
- [x] Terminal UI with xterm.js

### Phase 2: WASI Integration (In Progress)
- [ ] Integrate browser_wasi_shim
- [ ] Load Python WASM binary
- [ ] Map VFS to WASI filesystem
- [ ] Execute Python scripts

### Phase 3: Multi-Language Support
- [ ] Node.js WASM runtime
- [ ] Lua interpreter
- [ ] C compiler (via wasi-sdk)
- [ ] Rust REPL

### Phase 4: Enhanced Features
- [ ] Command history (up/down arrows)
- [ ] Tab completion
- [ ] Piping and redirects
- [ ] Environment variables
- [ ] Background jobs

## Project Structure

```
shazi-shell/
├── src/
│   ├── main.tsx          # React entry point
│   ├── App.tsx           # Main app component
│   ├── Terminal.tsx      # Terminal UI component
│   ├── worker.ts         # Web Worker entry point
│   ├── shell.ts          # Shell command parser/executor
│   ├── vfs.ts            # Virtual filesystem implementation
│   └── types.ts          # TypeScript type definitions
├── public/
│   └── wasm/             # WASM binaries (to be added)
├── ARCHITECTURE.md       # Detailed system design
├── package.json
├── tsconfig.json
└── vite.config.ts
```

## Contributing

This is an educational project. Contributions welcome!

### Adding New Commands

Edit [src/shell.ts](src/shell.ts) and add to the `executeBuiltin()` method:

```typescript
case 'mycommand':
  return this.cmdMyCommand(args);
```

### Adding WASM Languages

1. Obtain WASI-compiled binary
2. Place in `public/wasm/`
3. Integrate with WASI runtime in [src/worker.ts](src/worker.ts)

## Limitations

- **No persistence**: Files lost on refresh (by design)
- **Single process**: No true concurrency
- **No networking**: WASM cannot make HTTP requests
- **Limited stdlib**: Must pre-bundle language modules

## Resources

- [WASI Specification](https://github.com/WebAssembly/WASI)
- [WebAssembly Documentation](https://webassembly.org/)
- [StackBlitz WebContainers](https://webcontainers.io/) (inspiration)
- [Pyodide](https://pyodide.org/) (Python in WASM)

## License

MIT

## Credits

Built by Shazi • Inspired by StackBlitz JSH
