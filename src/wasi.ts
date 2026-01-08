import { VirtualFileSystem } from './vfs';

/**
 * WASI Runtime Adapter
 * Bridges browser_wasi_shim with our VFS and provides stdio handling
 */

export interface WASIOptions {
  args: string[];
  env: Record<string, string>;
  vfs: VirtualFileSystem;
  stdout: (data: string) => void;
  stderr: (data: string) => void;
}

export interface WASIProcess {
  start(instance: WebAssembly.Instance): Promise<number>;
}

// Binary cache to avoid reloading WASM files
const wasmCache = new Map<string, WebAssembly.Module>();

/**
 * Load a WASM module with caching and streaming compilation
 */
export async function loadWasmModule(url: string): Promise<WebAssembly.Module> {
  if (wasmCache.has(url)) {
    return wasmCache.get(url)!;
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to load WASM: ${url} (${response.status})`);
  }

  // Use streaming compilation for better performance
  const module = await WebAssembly.compileStreaming(response);
  wasmCache.set(url, module);

  return module;
}

/**
 * VFS-based File Descriptor implementation for WASI
 */
export class VFSFileDescriptor {
  private vfs: VirtualFileSystem;
  private path: string;
  private position: number = 0;

  constructor(vfs: VirtualFileSystem, path: string, _flags: number = 0) {
    this.vfs = vfs;
    this.path = path;
  }

  read(size: number): Uint8Array {
    const content = this.vfs.readFile(this.path);
    const slice = content.slice(this.position, this.position + size);
    this.position += slice.length;
    return slice;
  }

  write(data: Uint8Array): number {
    // For now, just overwrite the file
    // TODO: Implement append mode properly
    this.vfs.writeFile(this.path, data);
    return data.length;
  }

  seek(offset: number, whence: number): number {
    switch (whence) {
      case 0: // SEEK_SET
        this.position = offset;
        break;
      case 1: // SEEK_CUR
        this.position += offset;
        break;
      case 2: // SEEK_END
        const content = this.vfs.readFile(this.path);
        this.position = content.length + offset;
        break;
    }
    return this.position;
  }

  close(): void {
    // No-op for VFS
  }
}

/**
 * Standard I/O buffer that captures output and sends to callback
 */
export class StdioBuffer {
  private buffer: string = '';
  private callback: (data: string) => void;
  private flush: boolean;

  constructor(callback: (data: string) => void, flush = true) {
    this.callback = callback;
    this.flush = flush;
  }

  write(data: Uint8Array): number {
    const text = new TextDecoder().decode(data);
    
    if (this.flush) {
      // Immediate flush mode
      this.callback(text);
    } else {
      // Line-buffered mode
      this.buffer += text;
      const lines = this.buffer.split('\n');
      
      if (lines.length > 1) {
        // Output all complete lines
        for (let i = 0; i < lines.length - 1; i++) {
          this.callback(lines[i] + '\n');
        }
        this.buffer = lines[lines.length - 1];
      }
    }
    
    return data.length;
  }

  close(): void {
    if (this.buffer) {
      this.callback(this.buffer);
      this.buffer = '';
    }
  }
}

/**
 * Create WASI import object for a WASM module
 * This is a minimal implementation - full WASI support requires browser_wasi_shim
 */
export function createWASIImports(options: WASIOptions): WebAssembly.Imports {
  const stdout = new StdioBuffer(options.stdout);
  const stderr = new StdioBuffer(options.stderr);

  // File descriptor table
  // 0: stdin, 1: stdout, 2: stderr, 3+: files
  const fds: Map<number, VFSFileDescriptor | StdioBuffer> = new Map([
    [1, stdout],
    [2, stderr],
  ]);

  // WASI syscall implementations
  return {
    wasi_snapshot_preview1: {
      // Process
      proc_exit: (code: number) => {
        throw new WASIExitError(code);
      },

      // Arguments
      args_sizes_get: (argc_ptr: number, argv_buf_size_ptr: number, memory: WebAssembly.Memory) => {
        const view = new DataView(memory.buffer);
        view.setUint32(argc_ptr, options.args.length, true);
        
        let bufSize = 0;
        for (const arg of options.args) {
          bufSize += new TextEncoder().encode(arg + '\0').length;
        }
        view.setUint32(argv_buf_size_ptr, bufSize, true);
        
        return 0;
      },

      args_get: (argv_ptr: number, argv_buf_ptr: number, memory: WebAssembly.Memory) => {
        const view = new DataView(memory.buffer);
        const buf = new Uint8Array(memory.buffer);
        
        let bufOffset = argv_buf_ptr;
        for (let i = 0; i < options.args.length; i++) {
          view.setUint32(argv_ptr + i * 4, bufOffset, true);
          
          const encoded = new TextEncoder().encode(options.args[i] + '\0');
          buf.set(encoded, bufOffset);
          bufOffset += encoded.length;
        }
        
        return 0;
      },

      // Environment
      environ_sizes_get: (environ_count_ptr: number, environ_buf_size_ptr: number, memory: WebAssembly.Memory) => {
        const view = new DataView(memory.buffer);
        const entries = Object.entries(options.env);
        
        view.setUint32(environ_count_ptr, entries.length, true);
        
        let bufSize = 0;
        for (const [key, value] of entries) {
          bufSize += new TextEncoder().encode(`${key}=${value}\0`).length;
        }
        view.setUint32(environ_buf_size_ptr, bufSize, true);
        
        return 0;
      },

      environ_get: (environ_ptr: number, environ_buf_ptr: number, memory: WebAssembly.Memory) => {
        const view = new DataView(memory.buffer);
        const buf = new Uint8Array(memory.buffer);
        const entries = Object.entries(options.env);
        
        let bufOffset = environ_buf_ptr;
        for (let i = 0; i < entries.length; i++) {
          view.setUint32(environ_ptr + i * 4, bufOffset, true);
          
          const [key, value] = entries[i];
          const encoded = new TextEncoder().encode(`${key}=${value}\0`);
          buf.set(encoded, bufOffset);
          bufOffset += encoded.length;
        }
        
        return 0;
      },

      // File I/O
      fd_write: (fd: number, iovs_ptr: number, iovs_len: number, nwritten_ptr: number, memory: WebAssembly.Memory) => {
        const view = new DataView(memory.buffer);
        const buf = new Uint8Array(memory.buffer);
        
        let written = 0;
        for (let i = 0; i < iovs_len; i++) {
          const ptr = view.getUint32(iovs_ptr + i * 8, true);
          const len = view.getUint32(iovs_ptr + i * 8 + 4, true);
          
          const data = buf.slice(ptr, ptr + len);
          
          const fdObj = fds.get(fd);
          if (fdObj) {
            written += fdObj.write(data);
          }
        }
        
        view.setUint32(nwritten_ptr, written, true);
        return 0;
      },

      fd_read: (_fd: number, _iovs_ptr: number, _iovs_len: number, nread_ptr: number, memory: WebAssembly.Memory) => {
        // Minimal implementation - stdin returns EOF
        const view = new DataView(memory.buffer);
        view.setUint32(nread_ptr, 0, true);
        return 0;
      },

      fd_close: (fd: number) => {
        fds.delete(fd);
        return 0;
      },

      fd_seek: () => 0,
      fd_fdstat_get: () => 0,
      fd_fdstat_set_flags: () => 0,
      fd_prestat_get: () => 8, // EBADF
      fd_prestat_dir_name: () => 0,

      // Clock
      clock_time_get: (_id: number, _precision: bigint, timestamp_ptr: number, memory: WebAssembly.Memory) => {
        const view = new DataView(memory.buffer);
        const now = BigInt(Date.now()) * BigInt(1000000); // ms to ns
        view.setBigUint64(timestamp_ptr, now, true);
        return 0;
      },

      // Random
      random_get: (buf_ptr: number, buf_len: number, memory: WebAssembly.Memory) => {
        const buf = new Uint8Array(memory.buffer, buf_ptr, buf_len);
        crypto.getRandomValues(buf);
        return 0;
      },

      // Misc
      poll_oneoff: () => 0,
      sched_yield: () => 0,
    },
  };
}

/**
 * Custom error for WASI proc_exit
 */
export class WASIExitError extends Error {
  code: number;

  constructor(code: number) {
    super(`Process exited with code ${code}`);
    this.name = 'WASIExitError';
    this.code = code;
  }
}

/**
 * Execute a WASM module with WASI bindings
 */
export async function executeWASI(
  wasmUrl: string,
  options: WASIOptions
): Promise<number> {
  try {
    const module = await loadWasmModule(wasmUrl);
    const imports = createWASIImports(options);

    // Create instance
    const instance = await WebAssembly.instantiate(module, imports);

    // Call _start (WASI entry point)
    const start = instance.exports._start as CallableFunction;
    if (!start) {
      throw new Error('WASM module has no _start export');
    }

    try {
      start();
      return 0;
    } catch (error) {
      if (error instanceof WASIExitError) {
        return error.code;
      }
      throw error;
    }
  } catch (error) {
    options.stderr(
      `WASI execution failed: ${error instanceof Error ? error.message : 'unknown error'}\n`
    );
    return 1;
  }
}
