# WASM Binaries Directory

Place WebAssembly binaries here for language runtime support.

## Supported Binaries

- `python.wasm` - Python 3.11 WASI build
- `node.wasm` - Node.js WASI build (experimental)
- `lua.wasm` - Lua interpreter
- `quickjs.wasm` - QuickJS JavaScript engine

## Where to Get WASM Binaries

### Python

1. **PyPI WASM packages**:
   ```bash
   pip install pywasm
   ```

2. **Build from source** with wasi-sdk:
   ```bash
   # Use cpython-wasi project
   git clone https://github.com/niccokunzmann/pywasm
   ```

3. **Pyodide** (Emscripten-based, not pure WASI):
   - https://pyodide.org/
   - Note: Pyodide uses Emscripten, not WASI

### Node.js

Node.js doesn't have an official WASI build. Alternatives:

1. **QuickJS** (recommended for WASI):
   ```bash
   # Pre-built WASI binaries available
   wget https://niccokunzmann.github.io/pywasm/wasm/quickjs.wasm
   ```

2. **Txiki.js**:
   - https://github.com/niccokunzmann/pywasm/txiki.js

### Lua

```bash
# Lua WASI builds
wget https://niccokunzmann.github.io/pywasm/wasm/lua.wasm
```

## File Sizes

Approximate sizes (affects load time):

- Python: ~15-20 MB
- QuickJS: ~500 KB
- Lua: ~300 KB

## Usage

Once you place a `.wasm` file here, update `src/shell.ts` to enable the runtime:

```typescript
const WASM_BINARIES: Record<string, string> = {
  python: '/wasm/python.wasm',
  node: '/wasm/quickjs.wasm', // Use QuickJS as Node alternative
  lua: '/wasm/lua.wasm',
};
```

## Testing

```bash
# After placing python.wasm
echo 'print("Hello WASM!")' > test.py
python test.py
```
