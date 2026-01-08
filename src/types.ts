// Message types for Main ↔ Worker communication

export type WorkerRequest =
  | { type: 'init'; files?: Record<string, Uint8Array> }
  | { type: 'exec'; command: string; cwd?: string }
  | { type: 'interrupt' }
  | { type: 'resize'; cols: number; rows: number };

export type WorkerResponse =
  | { type: 'ready' }
  | { type: 'stdout'; data: string }
  | { type: 'stderr'; data: string }
  | { type: 'exit'; code: number }
  | { type: 'error'; message: string };

export interface FileStat {
  type: 'file' | 'directory';
  size: number;
  mtime: Date;
  mode: number;
}

export interface INode {
  type: 'file' | 'directory';
  content?: Uint8Array;
  children?: Map<string, INode>;
  mtime: Date;
  mode: number;
}
