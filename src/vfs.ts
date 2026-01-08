import { INode, FileStat } from './types';

/**
 * In-memory POSIX-like filesystem
 * Implements basic file operations without real OS calls
 */
export class VirtualFileSystem {
  private root: INode;
  private cwd: string = '/home/user';

  constructor() {
    this.root = this.createDirectory();
    this.initializeFilesystem();
  }

  private createDirectory(): INode {
    return {
      type: 'directory',
      children: new Map(),
      mtime: new Date(),
      mode: 0o755,
    };
  }

  private createFile(content: Uint8Array = new Uint8Array()): INode {
    return {
      type: 'file',
      content,
      mtime: new Date(),
      mode: 0o644,
    };
  }

  private initializeFilesystem(): void {
    // Create basic directory structure
    this.mkdirp('/home/user');
    this.mkdirp('/tmp');
    this.mkdirp('/bin');
    this.mkdirp('/lib');

    // Create a welcome file
    const welcomeText = new TextEncoder().encode(
      'Welcome to Shazi Shell!\nA WebAssembly-based sandboxed terminal.\n\nTry: ls, cat, echo, pwd, cd\n'
    );
    this.writeFile('/home/user/README.txt', welcomeText);
  }

  private resolvePath(path: string): string {
    if (path.startsWith('/')) {
      return this.normalizePath(path);
    }
    return this.normalizePath(`${this.cwd}/${path}`);
  }

  private normalizePath(path: string): string {
    const parts = path.split('/').filter((p) => p && p !== '.');
    const normalized: string[] = [];

    for (const part of parts) {
      if (part === '..') {
        normalized.pop();
      } else {
        normalized.push(part);
      }
    }

    return '/' + normalized.join('/');
  }

  private getNode(path: string): INode | null {
    const resolved = this.resolvePath(path);
    if (resolved === '/') return this.root;

    const parts = resolved.split('/').filter(Boolean);
    let current = this.root;

    for (const part of parts) {
      if (current.type !== 'directory' || !current.children) {
        return null;
      }
      const next = current.children.get(part);
      if (!next) return null;
      current = next;
    }

    return current;
  }

  private getParentAndName(path: string): { parent: INode; name: string } | null {
    const resolved = this.resolvePath(path);
    const parts = resolved.split('/').filter(Boolean);
    const name = parts.pop();

    if (!name) throw new Error('Cannot operate on root');

    const parentPath = '/' + parts.join('/');
    const parent = this.getNode(parentPath);

    if (!parent || parent.type !== 'directory') {
      return null;
    }

    return { parent, name };
  }

  // Public API

  exists(path: string): boolean {
    return this.getNode(path) !== null;
  }

  stat(path: string): FileStat {
    const node = this.getNode(path);
    if (!node) throw new Error(`ENOENT: ${path}`);

    return {
      type: node.type,
      size: node.type === 'file' ? (node.content?.length || 0) : 0,
      mtime: node.mtime,
      mode: node.mode,
    };
  }

  readFile(path: string): Uint8Array {
    const node = this.getNode(path);
    if (!node) throw new Error(`ENOENT: ${path}`);
    if (node.type !== 'file') throw new Error(`EISDIR: ${path}`);
    return node.content || new Uint8Array();
  }

  writeFile(path: string, content: Uint8Array): void {
    const info = this.getParentAndName(path);
    if (!info) throw new Error(`ENOENT: parent directory not found`);

    const existing = info.parent.children!.get(info.name);
    if (existing && existing.type === 'directory') {
      throw new Error(`EISDIR: ${path}`);
    }

    info.parent.children!.set(info.name, this.createFile(content));
  }

  mkdir(path: string): void {
    const info = this.getParentAndName(path);
    if (!info) throw new Error(`ENOENT: parent directory not found`);

    if (info.parent.children!.has(info.name)) {
      throw new Error(`EEXIST: ${path}`);
    }

    info.parent.children!.set(info.name, this.createDirectory());
  }

  mkdirp(path: string): void {
    const resolved = this.resolvePath(path);
    const parts = resolved.split('/').filter(Boolean);
    let current = this.root;

    for (const part of parts) {
      if (!current.children!.has(part)) {
        current.children!.set(part, this.createDirectory());
      }
      current = current.children!.get(part)!;
      if (current.type !== 'directory') {
        throw new Error(`ENOTDIR: ${path}`);
      }
    }
  }

  rmdir(path: string): void {
    const node = this.getNode(path);
    if (!node) throw new Error(`ENOENT: ${path}`);
    if (node.type !== 'directory') throw new Error(`ENOTDIR: ${path}`);
    if (node.children!.size > 0) throw new Error(`ENOTEMPTY: ${path}`);

    const info = this.getParentAndName(path);
    if (info) {
      info.parent.children!.delete(info.name);
    }
  }

  unlink(path: string): void {
    const node = this.getNode(path);
    if (!node) throw new Error(`ENOENT: ${path}`);
    if (node.type === 'directory') throw new Error(`EISDIR: ${path}`);

    const info = this.getParentAndName(path);
    if (info) {
      info.parent.children!.delete(info.name);
    }
  }

  readdir(path: string): string[] {
    const node = this.getNode(path);
    if (!node) throw new Error(`ENOENT: ${path}`);
    if (node.type !== 'directory') throw new Error(`ENOTDIR: ${path}`);
    return Array.from(node.children!.keys()).sort();
  }

  rename(oldPath: string, newPath: string): void {
    const node = this.getNode(oldPath);
    if (!node) throw new Error(`ENOENT: ${oldPath}`);

    const newInfo = this.getParentAndName(newPath);
    if (!newInfo) throw new Error(`ENOENT: destination parent not found`);

    // Remove from old location
    const oldInfo = this.getParentAndName(oldPath);
    if (oldInfo) {
      oldInfo.parent.children!.delete(oldInfo.name);
    }

    // Add to new location
    newInfo.parent.children!.set(newInfo.name, node);
  }

  getCwd(): string {
    return this.cwd;
  }

  setCwd(path: string): void {
    const node = this.getNode(path);
    if (!node) throw new Error(`ENOENT: ${path}`);
    if (node.type !== 'directory') throw new Error(`ENOTDIR: ${path}`);
    this.cwd = this.resolvePath(path);
  }
}
