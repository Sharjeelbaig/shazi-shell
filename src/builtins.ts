/**
 * POSIX Shell Builtin Commands
 * All the standard Unix commands implemented in TypeScript
 */

import { VirtualFileSystem } from './vfs';

export interface CommandContext {
  vfs: VirtualFileSystem;
  env: Map<string, string>;
  args: string[];
  stdin: string;
  write: (text: string) => void;
  writeln: (text: string) => void;
  writeError: (text: string) => void;
}

type BuiltinFn = (ctx: CommandContext) => number | Promise<number>;

// =============================================================================
// Core Navigation
// =============================================================================

export const pwd: BuiltinFn = (ctx) => {
  ctx.writeln(ctx.vfs.getCwd());
  return 0;
};

export const cd: BuiltinFn = (ctx) => {
  const path = ctx.args[0] || ctx.env.get('HOME') || '/';
  try {
    ctx.vfs.setCwd(path);
    ctx.env.set('PWD', ctx.vfs.getCwd());
    return 0;
  } catch (error) {
    ctx.writeError(`cd: ${error instanceof Error ? error.message : 'failed'}\n`);
    return 1;
  }
};

export const ls: BuiltinFn = (ctx) => {
  const args = ctx.args;
  let showAll = false;
  let longFormat = false;
  const paths: string[] = [];

  for (const arg of args) {
    if (arg.startsWith('-')) {
      if (arg.includes('a')) showAll = true;
      if (arg.includes('l')) longFormat = true;
    } else {
      paths.push(arg);
    }
  }

  if (paths.length === 0) paths.push('.');

  for (const path of paths) {
    try {
      const entries = ctx.vfs.readdir(path);
      const filtered = showAll ? entries : entries.filter(e => !e.startsWith('.'));

      if (longFormat) {
        for (const entry of filtered) {
          try {
            const fullPath = path === '.' ? entry : `${path}/${entry}`;
            const stat = ctx.vfs.stat(fullPath);
            const type = stat.type === 'directory' ? 'd' : '-';
            const mode = stat.mode.toString(8).padStart(4, '0');
            const size = stat.size.toString().padStart(8, ' ');
            const date = stat.mtime.toISOString().slice(0, 10);
            const name = stat.type === 'directory' ? `\x1b[34m${entry}\x1b[0m` : entry;
            ctx.writeln(`${type}${mode} ${size} ${date} ${name}`);
          } catch {
            ctx.writeln(entry);
          }
        }
      } else {
        const formatted = filtered.map(entry => {
          try {
            const fullPath = path === '.' ? entry : `${path}/${entry}`;
            const stat = ctx.vfs.stat(fullPath);
            return stat.type === 'directory' ? `\x1b[34m${entry}\x1b[0m` : entry;
          } catch {
            return entry;
          }
        });
        ctx.writeln(formatted.join('  '));
      }
    } catch (error) {
      ctx.writeError(`ls: ${error instanceof Error ? error.message : 'failed'}\n`);
      return 1;
    }
  }
  return 0;
};

// =============================================================================
// File Creation & Manipulation
// =============================================================================

export const touch: BuiltinFn = (ctx) => {
  if (ctx.args.length === 0) {
    ctx.writeError('touch: missing operand\n');
    return 1;
  }

  for (const path of ctx.args) {
    try {
      if (!ctx.vfs.exists(path)) {
        ctx.vfs.writeFile(path, new Uint8Array());
      }
    } catch (error) {
      ctx.writeError(`touch: ${error instanceof Error ? error.message : 'failed'}\n`);
      return 1;
    }
  }
  return 0;
};

export const cp: BuiltinFn = (ctx) => {
  let recursive = false;
  const paths: string[] = [];

  for (const arg of ctx.args) {
    if (arg === '-r' || arg === '-R' || arg === '-a') {
      recursive = true;
    } else {
      paths.push(arg);
    }
  }

  if (paths.length < 2) {
    ctx.writeError('cp: missing operand\n');
    return 1;
  }

  const dst = paths.pop()!;
  
  const copyRecursive = (src: string, dest: string) => {
    const stat = ctx.vfs.stat(src);
    if (stat.type === 'directory') {
      if (!recursive) {
        throw new Error(`cp: -r not specified; omitting directory '${src}'`);
      }
      ctx.vfs.mkdirp(dest);
      for (const child of ctx.vfs.readdir(src)) {
        copyRecursive(`${src}/${child}`, `${dest}/${child}`);
      }
    } else {
      ctx.vfs.writeFile(dest, ctx.vfs.readFile(src));
    }
  };

  try {
    for (const src of paths) {
      const destPath = paths.length > 1 || (ctx.vfs.exists(dst) && ctx.vfs.stat(dst).type === 'directory')
        ? `${dst}/${src.split('/').pop()}`
        : dst;
      copyRecursive(src, destPath);
    }
    return 0;
  } catch (error) {
    ctx.writeError(`cp: ${error instanceof Error ? error.message : 'failed'}\n`);
    return 1;
  }
};

export const mv: BuiltinFn = (ctx) => {
  if (ctx.args.length < 2) {
    ctx.writeError('mv: missing operand\n');
    return 1;
  }

  const dst = ctx.args.pop()!;
  
  try {
    for (const src of ctx.args) {
      const destPath = ctx.args.length > 1 || (ctx.vfs.exists(dst) && ctx.vfs.stat(dst).type === 'directory')
        ? `${dst}/${src.split('/').pop()}`
        : dst;
      ctx.vfs.rename(src, destPath);
    }
    return 0;
  } catch (error) {
    ctx.writeError(`mv: ${error instanceof Error ? error.message : 'failed'}\n`);
    return 1;
  }
};

export const rm: BuiltinFn = (ctx) => {
  let recursive = false;
  let force = false;
  const paths: string[] = [];

  for (const arg of ctx.args) {
    if (arg.startsWith('-')) {
      if (arg.includes('r') || arg.includes('R')) recursive = true;
      if (arg.includes('f')) force = true;
    } else {
      paths.push(arg);
    }
  }

  if (paths.length === 0) {
    if (!force) ctx.writeError('rm: missing operand\n');
    return force ? 0 : 1;
  }

  const removeRecursive = (path: string) => {
    const stat = ctx.vfs.stat(path);
    if (stat.type === 'directory') {
      if (!recursive) {
        throw new Error(`rm: cannot remove '${path}': Is a directory`);
      }
      for (const child of ctx.vfs.readdir(path)) {
        removeRecursive(`${path}/${child}`);
      }
      ctx.vfs.rmdir(path);
    } else {
      ctx.vfs.unlink(path);
    }
  };

  for (const path of paths) {
    try {
      if (!ctx.vfs.exists(path)) {
        if (!force) {
          ctx.writeError(`rm: cannot remove '${path}': No such file or directory\n`);
          return 1;
        }
        continue;
      }
      removeRecursive(path);
    } catch (error) {
      if (!force) {
        ctx.writeError(`rm: ${error instanceof Error ? error.message : 'failed'}\n`);
        return 1;
      }
    }
  }
  return 0;
};

export const mkdir: BuiltinFn = (ctx) => {
  let parents = false;
  const dirs: string[] = [];

  for (const arg of ctx.args) {
    if (arg === '-p') {
      parents = true;
    } else {
      dirs.push(arg);
    }
  }

  if (dirs.length === 0) {
    ctx.writeError('mkdir: missing operand\n');
    return 1;
  }

  for (const dir of dirs) {
    try {
      if (parents) {
        ctx.vfs.mkdirp(dir);
      } else {
        ctx.vfs.mkdir(dir);
      }
    } catch (error) {
      ctx.writeError(`mkdir: ${error instanceof Error ? error.message : 'failed'}\n`);
      return 1;
    }
  }
  return 0;
};

export const rmdir: BuiltinFn = (ctx) => {
  if (ctx.args.length === 0) {
    ctx.writeError('rmdir: missing operand\n');
    return 1;
  }

  for (const dir of ctx.args) {
    try {
      ctx.vfs.rmdir(dir);
    } catch (error) {
      ctx.writeError(`rmdir: ${error instanceof Error ? error.message : 'failed'}\n`);
      return 1;
    }
  }
  return 0;
};

// =============================================================================
// Viewing Files
// =============================================================================

export const cat: BuiltinFn = (ctx) => {
  // If stdin provided, output it
  if (ctx.stdin) {
    ctx.write(ctx.stdin);
    return 0;
  }

  if (ctx.args.length === 0) {
    // cat with no args reads stdin (already handled above)
    return 0;
  }

  for (const file of ctx.args) {
    try {
      const content = new TextDecoder().decode(ctx.vfs.readFile(file));
      ctx.write(content);
    } catch (error) {
      ctx.writeError(`cat: ${error instanceof Error ? error.message : 'failed'}\n`);
      return 1;
    }
  }
  return 0;
};

export const head: BuiltinFn = (ctx) => {
  let lines = 10;
  const files: string[] = [];

  for (let i = 0; i < ctx.args.length; i++) {
    if (ctx.args[i] === '-n' && i + 1 < ctx.args.length) {
      lines = parseInt(ctx.args[i + 1], 10);
      i++;
    } else if (ctx.args[i].startsWith('-') && /^\d+$/.test(ctx.args[i].slice(1))) {
      lines = parseInt(ctx.args[i].slice(1), 10);
    } else {
      files.push(ctx.args[i]);
    }
  }

  const processContent = (content: string) => {
    const allLines = content.split('\n');
    return allLines.slice(0, lines).join('\n');
  };

  if (ctx.stdin) {
    ctx.writeln(processContent(ctx.stdin));
    return 0;
  }

  for (const file of files) {
    try {
      const content = new TextDecoder().decode(ctx.vfs.readFile(file));
      if (files.length > 1) ctx.writeln(`==> ${file} <==`);
      ctx.writeln(processContent(content));
    } catch (error) {
      ctx.writeError(`head: ${error instanceof Error ? error.message : 'failed'}\n`);
      return 1;
    }
  }
  return 0;
};

export const tail: BuiltinFn = (ctx) => {
  let lines = 10;
  const files: string[] = [];

  for (let i = 0; i < ctx.args.length; i++) {
    if (ctx.args[i] === '-n' && i + 1 < ctx.args.length) {
      lines = parseInt(ctx.args[i + 1], 10);
      i++;
    } else if (ctx.args[i].startsWith('-') && /^\d+$/.test(ctx.args[i].slice(1))) {
      lines = parseInt(ctx.args[i].slice(1), 10);
    } else {
      files.push(ctx.args[i]);
    }
  }

  const processContent = (content: string) => {
    const allLines = content.split('\n');
    return allLines.slice(-lines).join('\n');
  };

  if (ctx.stdin) {
    ctx.writeln(processContent(ctx.stdin));
    return 0;
  }

  for (const file of files) {
    try {
      const content = new TextDecoder().decode(ctx.vfs.readFile(file));
      if (files.length > 1) ctx.writeln(`==> ${file} <==`);
      ctx.writeln(processContent(content));
    } catch (error) {
      ctx.writeError(`tail: ${error instanceof Error ? error.message : 'failed'}\n`);
      return 1;
    }
  }
  return 0;
};

// =============================================================================
// Text Processing
// =============================================================================

export const echo: BuiltinFn = (ctx) => {
  let noNewline = false;
  let enableEscapes = false;
  const parts: string[] = [];

  for (const arg of ctx.args) {
    if (arg === '-n') {
      noNewline = true;
    } else if (arg === '-e') {
      enableEscapes = true;
    } else {
      parts.push(arg);
    }
  }

  let output = parts.join(' ');

  if (enableEscapes) {
    output = output
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\r/g, '\r')
      .replace(/\\\\/g, '\\');
  }

  if (noNewline) {
    ctx.write(output);
  } else {
    ctx.writeln(output);
  }
  return 0;
};

export const printf: BuiltinFn = (ctx) => {
  if (ctx.args.length === 0) return 0;

  const format = ctx.args[0];
  const values = ctx.args.slice(1);
  let valueIdx = 0;
  let output = '';
  let i = 0;

  while (i < format.length) {
    if (format[i] === '\\') {
      i++;
      switch (format[i]) {
        case 'n': output += '\n'; break;
        case 't': output += '\t'; break;
        case 'r': output += '\r'; break;
        case '\\': output += '\\'; break;
        default: output += format[i];
      }
      i++;
    } else if (format[i] === '%') {
      i++;
      if (format[i] === '%') {
        output += '%';
        i++;
      } else {
        // Parse format specifier
        let spec = '';
        while (i < format.length && !'sdifxXoec'.includes(format[i])) {
          spec += format[i];
          i++;
        }
        const type = format[i] || 's';
        i++;
        const val = values[valueIdx++] ?? '';

        switch (type) {
          case 's':
            output += val;
            break;
          case 'd':
          case 'i':
            output += parseInt(val, 10) || 0;
            break;
          case 'f':
            output += parseFloat(val) || 0;
            break;
          case 'x':
            output += (parseInt(val, 10) || 0).toString(16);
            break;
          case 'X':
            output += (parseInt(val, 10) || 0).toString(16).toUpperCase();
            break;
          case 'o':
            output += (parseInt(val, 10) || 0).toString(8);
            break;
          default:
            output += val;
        }
      }
    } else {
      output += format[i];
      i++;
    }
  }

  ctx.write(output);
  return 0;
};

export const grep: BuiltinFn = (ctx) => {
  let showLineNumbers = false;
  let recursive = false;
  let ignoreCase = false;
  let invert = false;
  let pattern = '';
  const files: string[] = [];

  for (let i = 0; i < ctx.args.length; i++) {
    const arg = ctx.args[i];
    if (arg.startsWith('-')) {
      if (arg.includes('n')) showLineNumbers = true;
      if (arg.includes('r') || arg.includes('R')) recursive = true;
      if (arg.includes('i')) ignoreCase = true;
      if (arg.includes('v')) invert = true;
    } else if (!pattern) {
      pattern = arg;
    } else {
      files.push(arg);
    }
  }

  if (!pattern) {
    ctx.writeError('grep: missing pattern\n');
    return 1;
  }

  const regex = new RegExp(pattern, ignoreCase ? 'i' : '');

  const grepFile = (path: string, prefix: string) => {
    try {
      const stat = ctx.vfs.stat(path);
      if (stat.type === 'directory') {
        if (recursive) {
          for (const child of ctx.vfs.readdir(path)) {
            grepFile(`${path}/${child}`, `${path}/${child}:`);
          }
        }
        return;
      }

      const content = new TextDecoder().decode(ctx.vfs.readFile(path));
      const lines = content.split('\n');
      
      lines.forEach((line, idx) => {
        const matches = regex.test(line);
        if (matches !== invert) {
          const lineNum = showLineNumbers ? `${idx + 1}:` : '';
          ctx.writeln(`${prefix}${lineNum}${line}`);
        }
      });
    } catch {
      // Skip unreadable files
    }
  };

  if (ctx.stdin) {
    const lines = ctx.stdin.split('\n');
    lines.forEach((line, idx) => {
      const matches = regex.test(line);
      if (matches !== invert) {
        const lineNum = showLineNumbers ? `${idx + 1}:` : '';
        ctx.writeln(`${lineNum}${line}`);
      }
    });
    return 0;
  }

  if (files.length === 0) files.push('.');

  for (const file of files) {
    grepFile(file, files.length > 1 ? `${file}:` : '');
  }

  return 0;
};

export const wc: BuiltinFn = (ctx) => {
  let showLines = false;
  let showWords = false;
  let showBytes = false;
  const files: string[] = [];

  for (const arg of ctx.args) {
    if (arg.startsWith('-')) {
      if (arg.includes('l')) showLines = true;
      if (arg.includes('w')) showWords = true;
      if (arg.includes('c')) showBytes = true;
    } else {
      files.push(arg);
    }
  }

  // Default: show all
  if (!showLines && !showWords && !showBytes) {
    showLines = showWords = showBytes = true;
  }

  const countContent = (content: string): { lines: number; words: number; bytes: number } => {
    const lines = content.split('\n').length - (content.endsWith('\n') ? 1 : 0);
    const words = content.trim().split(/\s+/).filter(Boolean).length;
    const bytes = new TextEncoder().encode(content).length;
    return { lines, words, bytes };
  };

  const formatOutput = (lines: number, words: number, bytes: number, name: string): string => {
    const parts: string[] = [];
    if (showLines) parts.push(lines.toString().padStart(8));
    if (showWords) parts.push(words.toString().padStart(8));
    if (showBytes) parts.push(bytes.toString().padStart(8));
    parts.push(name);
    return parts.join(' ');
  };

  if (ctx.stdin) {
    const { lines, words, bytes } = countContent(ctx.stdin);
    ctx.writeln(formatOutput(lines, words, bytes, ''));
    return 0;
  }

  let totalLines = 0, totalWords = 0, totalBytes = 0;

  for (const file of files) {
    try {
      const content = new TextDecoder().decode(ctx.vfs.readFile(file));
      const { lines, words, bytes } = countContent(content);
      totalLines += lines;
      totalWords += words;
      totalBytes += bytes;
      ctx.writeln(formatOutput(lines, words, bytes, file));
    } catch (error) {
      ctx.writeError(`wc: ${error instanceof Error ? error.message : 'failed'}\n`);
      return 1;
    }
  }

  if (files.length > 1) {
    ctx.writeln(formatOutput(totalLines, totalWords, totalBytes, 'total'));
  }

  return 0;
};

export const sort: BuiltinFn = (ctx) => {
  let reverse = false;
  let numeric = false;
  let unique = false;
  const files: string[] = [];

  for (const arg of ctx.args) {
    if (arg.startsWith('-')) {
      if (arg.includes('r')) reverse = true;
      if (arg.includes('n')) numeric = true;
      if (arg.includes('u')) unique = true;
    } else {
      files.push(arg);
    }
  }

  let content = ctx.stdin || '';

  for (const file of files) {
    try {
      content += new TextDecoder().decode(ctx.vfs.readFile(file));
    } catch (error) {
      ctx.writeError(`sort: ${error instanceof Error ? error.message : 'failed'}\n`);
      return 1;
    }
  }

  let lines = content.split('\n').filter(Boolean);

  if (numeric) {
    lines.sort((a, b) => parseFloat(a) - parseFloat(b));
  } else {
    lines.sort();
  }

  if (reverse) lines.reverse();
  if (unique) lines = [...new Set(lines)];

  ctx.writeln(lines.join('\n'));
  return 0;
};

export const uniq: BuiltinFn = (ctx) => {
  let count = false;
  let repeated = false;
  let unique = false;
  const files: string[] = [];

  for (const arg of ctx.args) {
    if (arg.startsWith('-')) {
      if (arg.includes('c')) count = true;
      if (arg.includes('d')) repeated = true;
      if (arg.includes('u')) unique = true;
    } else {
      files.push(arg);
    }
  }

  let content = ctx.stdin || '';

  for (const file of files) {
    try {
      content += new TextDecoder().decode(ctx.vfs.readFile(file));
    } catch (error) {
      ctx.writeError(`uniq: ${error instanceof Error ? error.message : 'failed'}\n`);
      return 1;
    }
  }

  const lines = content.split('\n');
  const counts: Map<string, number> = new Map();
  const order: string[] = [];

  let prev = '';
  for (const line of lines) {
    if (line !== prev) {
      order.push(line);
      counts.set(line, 1);
      prev = line;
    } else {
      counts.set(line, (counts.get(line) || 0) + 1);
    }
  }

  for (const line of order) {
    const c = counts.get(line) || 0;
    if (repeated && c === 1) continue;
    if (unique && c > 1) continue;

    if (count) {
      ctx.writeln(`${c.toString().padStart(7)} ${line}`);
    } else {
      ctx.writeln(line);
    }
  }

  return 0;
};

export const cut: BuiltinFn = (ctx) => {
  let delimiter = '\t';
  let fields: number[] = [];
  const files: string[] = [];

  for (let i = 0; i < ctx.args.length; i++) {
    const arg = ctx.args[i];
    if (arg === '-d' && i + 1 < ctx.args.length) {
      delimiter = ctx.args[++i];
    } else if (arg.startsWith('-d')) {
      delimiter = arg.slice(2);
    } else if (arg === '-f' && i + 1 < ctx.args.length) {
      fields = ctx.args[++i].split(',').map(n => parseInt(n, 10));
    } else if (arg.startsWith('-f')) {
      fields = arg.slice(2).split(',').map(n => parseInt(n, 10));
    } else {
      files.push(arg);
    }
  }

  const processLine = (line: string): string => {
    if (fields.length === 0) return line;
    const parts = line.split(delimiter);
    return fields.map(f => parts[f - 1] || '').join(delimiter);
  };

  if (ctx.stdin) {
    const lines = ctx.stdin.split('\n');
    for (const line of lines) {
      ctx.writeln(processLine(line));
    }
    return 0;
  }

  for (const file of files) {
    try {
      const content = new TextDecoder().decode(ctx.vfs.readFile(file));
      const lines = content.split('\n');
      for (const line of lines) {
        ctx.writeln(processLine(line));
      }
    } catch (error) {
      ctx.writeError(`cut: ${error instanceof Error ? error.message : 'failed'}\n`);
      return 1;
    }
  }

  return 0;
};

export const tr: BuiltinFn = (ctx) => {
  if (ctx.args.length < 2) {
    ctx.writeError('tr: missing operand\n');
    return 1;
  }

  const set1 = ctx.args[0];
  const set2 = ctx.args[1];
  const input = ctx.stdin || '';

  // Expand character ranges like a-z
  const expandSet = (s: string): string => {
    let result = '';
    let i = 0;
    while (i < s.length) {
      if (i + 2 < s.length && s[i + 1] === '-') {
        const start = s.charCodeAt(i);
        const end = s.charCodeAt(i + 2);
        for (let c = start; c <= end; c++) {
          result += String.fromCharCode(c);
        }
        i += 3;
      } else {
        result += s[i];
        i++;
      }
    }
    return result;
  };

  const from = expandSet(set1);
  const to = expandSet(set2);

  let output = '';
  for (const char of input) {
    const idx = from.indexOf(char);
    if (idx !== -1 && idx < to.length) {
      output += to[idx];
    } else if (idx !== -1) {
      output += to[to.length - 1];
    } else {
      output += char;
    }
  }

  ctx.write(output);
  return 0;
};

// =============================================================================
// File Metadata
// =============================================================================

export const stat: BuiltinFn = (ctx) => {
  for (const path of ctx.args) {
    try {
      const s = ctx.vfs.stat(path);
      ctx.writeln(`  File: ${path}`);
      ctx.writeln(`  Size: ${s.size}\t\tType: ${s.type}`);
      ctx.writeln(`Access: (${s.mode.toString(8)})\tModify: ${s.mtime.toISOString()}`);
    } catch (error) {
      ctx.writeError(`stat: ${error instanceof Error ? error.message : 'failed'}\n`);
      return 1;
    }
  }
  return 0;
};

export const file: BuiltinFn = (ctx) => {
  for (const path of ctx.args) {
    try {
      const s = ctx.vfs.stat(path);
      if (s.type === 'directory') {
        ctx.writeln(`${path}: directory`);
      } else {
        const content = ctx.vfs.readFile(path);
        // Detect file type based on content
        if (content.length === 0) {
          ctx.writeln(`${path}: empty`);
        } else if (content[0] === 0x7f && content[1] === 0x45) {
          ctx.writeln(`${path}: ELF executable`);
        } else if (content[0] === 0x00 && content[1] === 0x61 && content[2] === 0x73 && content[3] === 0x6d) {
          ctx.writeln(`${path}: WebAssembly binary`);
        } else {
          // Check if it's text
          const text = new TextDecoder().decode(content.slice(0, 512));
          if (/^[\x00-\x7F]*$/.test(text)) {
            if (text.startsWith('#!')) {
              ctx.writeln(`${path}: script, ${text.split('\n')[0]}`);
            } else {
              ctx.writeln(`${path}: ASCII text`);
            }
          } else {
            ctx.writeln(`${path}: data`);
          }
        }
      }
    } catch (error) {
      ctx.writeError(`file: ${error instanceof Error ? error.message : 'failed'}\n`);
      return 1;
    }
  }
  return 0;
};

// =============================================================================
// Time & Date
// =============================================================================

export const date: BuiltinFn = (ctx) => {
  const now = new Date();
  
  if (ctx.args.length > 0 && ctx.args[0].startsWith('+')) {
    // Custom format
    let format = ctx.args[0].slice(1);
    format = format
      .replace(/%Y/g, now.getFullYear().toString())
      .replace(/%m/g, (now.getMonth() + 1).toString().padStart(2, '0'))
      .replace(/%d/g, now.getDate().toString().padStart(2, '0'))
      .replace(/%H/g, now.getHours().toString().padStart(2, '0'))
      .replace(/%M/g, now.getMinutes().toString().padStart(2, '0'))
      .replace(/%S/g, now.getSeconds().toString().padStart(2, '0'))
      .replace(/%s/g, Math.floor(now.getTime() / 1000).toString());
    ctx.writeln(format);
  } else {
    ctx.writeln(now.toString());
  }
  return 0;
};

export const sleep: BuiltinFn = async (ctx) => {
  const seconds = parseFloat(ctx.args[0] || '0');
  await new Promise(resolve => setTimeout(resolve, seconds * 1000));
  return 0;
};

// =============================================================================
// Environment
// =============================================================================

export const env: BuiltinFn = (ctx) => {
  for (const [key, value] of ctx.env) {
    ctx.writeln(`${key}=${value}`);
  }
  return 0;
};

export const printenv: BuiltinFn = (ctx) => {
  if (ctx.args.length === 0) {
    return env(ctx);
  }
  for (const name of ctx.args) {
    const value = ctx.env.get(name);
    if (value !== undefined) {
      ctx.writeln(value);
    }
  }
  return 0;
};

export const exportCmd: BuiltinFn = (ctx) => {
  for (const arg of ctx.args) {
    const match = arg.match(/^(\w+)=(.*)$/);
    if (match) {
      ctx.env.set(match[1], match[2]);
    } else if (arg.match(/^\w+$/)) {
      // Just export name without value
      if (!ctx.env.has(arg)) {
        ctx.env.set(arg, '');
      }
    } else {
      ctx.writeError(`export: invalid format: ${arg}\n`);
      return 1;
    }
  }
  return 0;
};

export const unset: BuiltinFn = (ctx) => {
  for (const name of ctx.args) {
    ctx.env.delete(name);
  }
  return 0;
};

// =============================================================================
// Shell Builtins
// =============================================================================

export const trueCmd: BuiltinFn = () => 0;
export const falseCmd: BuiltinFn = () => 1;
export const colon: BuiltinFn = () => 0; // : is a no-op

export const exitCmd: BuiltinFn = (ctx) => {
  const code = parseInt(ctx.args[0] || '0', 10);
  throw { type: 'exit', code };
};

export const test: BuiltinFn = (ctx) => {
  const args = ctx.args;

  // Remove trailing ] if present
  if (args[args.length - 1] === ']') args.pop();

  if (args.length === 0) return 1;

  const evaluate = (): boolean => {
    // Unary operators
    if (args[0] === '-f') {
      try {
        return ctx.vfs.stat(args[1]).type === 'file';
      } catch { return false; }
    }
    if (args[0] === '-d') {
      try {
        return ctx.vfs.stat(args[1]).type === 'directory';
      } catch { return false; }
    }
    if (args[0] === '-e') {
      return ctx.vfs.exists(args[1]);
    }
    if (args[0] === '-r' || args[0] === '-w' || args[0] === '-x') {
      return ctx.vfs.exists(args[1]);
    }
    if (args[0] === '-s') {
      try {
        return ctx.vfs.stat(args[1]).size > 0;
      } catch { return false; }
    }
    if (args[0] === '-z') {
      return args[1] === '' || args[1] === undefined;
    }
    if (args[0] === '-n') {
      return args[1] !== '' && args[1] !== undefined;
    }
    if (args[0] === '!') {
      args.shift();
      return !evaluate();
    }

    // Binary operators
    if (args.length >= 3) {
      const [left, op, right] = args;
      switch (op) {
        case '=':
        case '==':
          return left === right;
        case '!=':
          return left !== right;
        case '-eq':
          return parseInt(left) === parseInt(right);
        case '-ne':
          return parseInt(left) !== parseInt(right);
        case '-lt':
          return parseInt(left) < parseInt(right);
        case '-le':
          return parseInt(left) <= parseInt(right);
        case '-gt':
          return parseInt(left) > parseInt(right);
        case '-ge':
          return parseInt(left) >= parseInt(right);
      }
    }

    // Single string test
    return args[0] !== '';
  };

  return evaluate() ? 0 : 1;
};

export const read: BuiltinFn = (ctx) => {
  // In a non-interactive context, read from stdin
  const line = ctx.stdin.split('\n')[0] || '';
  const varName = ctx.args[0] || 'REPLY';
  ctx.env.set(varName, line);
  return 0;
};

// =============================================================================
// Archives (Basic Implementation)
// =============================================================================

export const tar: BuiltinFn = (ctx) => {
  let create = false;
  let extract = false;
  let list = false;
  let file = '';
  const paths: string[] = [];

  for (let i = 0; i < ctx.args.length; i++) {
    const arg = ctx.args[i];
    if (arg.startsWith('-')) {
      if (arg.includes('c')) create = true;
      if (arg.includes('x')) extract = true;
      if (arg.includes('t')) list = true;
      if (arg.includes('f') && i + 1 < ctx.args.length) {
        file = ctx.args[++i];
      }
    } else if (arg === '-f') {
      file = ctx.args[++i];
    } else {
      paths.push(arg);
    }
  }

  if (!file) {
    ctx.writeError('tar: missing -f option\n');
    return 1;
  }

  if (create) {
    // Create a simple tar-like format (JSON for simplicity)
    const archive: Record<string, string> = {};
    
    const addPath = (path: string) => {
      try {
        const stat = ctx.vfs.stat(path);
        if (stat.type === 'directory') {
          for (const child of ctx.vfs.readdir(path)) {
            addPath(`${path}/${child}`);
          }
        } else {
          const content = ctx.vfs.readFile(path);
          archive[path] = btoa(String.fromCharCode(...content));
        }
      } catch {
        // Skip
      }
    };

    for (const p of paths) {
      addPath(p);
    }

    ctx.vfs.writeFile(file, new TextEncoder().encode(JSON.stringify(archive)));
    return 0;
  }

  if (extract || list) {
    try {
      const content = new TextDecoder().decode(ctx.vfs.readFile(file));
      const archive: Record<string, string> = JSON.parse(content);

      for (const [path, data] of Object.entries(archive)) {
        if (list) {
          ctx.writeln(path);
        } else {
          // Ensure parent directory exists
          const dir = path.substring(0, path.lastIndexOf('/'));
          if (dir) ctx.vfs.mkdirp(dir);
          
          const decoded = Uint8Array.from(atob(data), c => c.charCodeAt(0));
          ctx.vfs.writeFile(path, decoded);
        }
      }
      return 0;
    } catch (error) {
      ctx.writeError(`tar: ${error instanceof Error ? error.message : 'failed'}\n`);
      return 1;
    }
  }

  ctx.writeError('tar: missing operation (-c, -x, or -t)\n');
  return 1;
};

// =============================================================================
// Misc
// =============================================================================

export const clear: BuiltinFn = (ctx) => {
  ctx.write('\x1bc');
  return 0;
};

export const history: BuiltinFn = () => {
  // This is handled specially by the shell
  return 0;
};

export const alias: BuiltinFn = (ctx) => {
  // Aliases are handled at parse time
  ctx.writeln('alias: not implemented in this shell');
  return 0;
};

export const which: BuiltinFn = (ctx) => {
  const builtins = ['pwd', 'cd', 'ls', 'cat', 'echo', 'mkdir', 'rm', 'mv', 'cp', 'touch',
    'head', 'tail', 'grep', 'wc', 'sort', 'uniq', 'cut', 'tr', 'printf',
    'stat', 'file', 'date', 'sleep', 'env', 'printenv', 'export', 'unset',
    'true', 'false', 'exit', 'test', 'read', 'tar', 'clear', 'history',
    'python', 'node', 'lua', 'ruby', 'go', 'rust', 'gcc', 'java'];

  for (const cmd of ctx.args) {
    if (builtins.includes(cmd)) {
      ctx.writeln(`${cmd}: shell built-in command`);
    } else {
      ctx.writeError(`${cmd}: not found\n`);
    }
  }
  return 0;
};

export const type: BuiltinFn = (ctx) => {
  return which(ctx);
};

export const basename: BuiltinFn = (ctx) => {
  if (ctx.args.length === 0) {
    ctx.writeError('basename: missing operand\n');
    return 1;
  }
  const path = ctx.args[0];
  const suffix = ctx.args[1] || '';
  let name = path.split('/').pop() || '';
  if (suffix && name.endsWith(suffix)) {
    name = name.slice(0, -suffix.length);
  }
  ctx.writeln(name);
  return 0;
};

export const dirname: BuiltinFn = (ctx) => {
  if (ctx.args.length === 0) {
    ctx.writeError('dirname: missing operand\n');
    return 1;
  }
  const path = ctx.args[0];
  const dir = path.substring(0, path.lastIndexOf('/')) || '.';
  ctx.writeln(dir);
  return 0;
};

export const seq: BuiltinFn = (ctx) => {
  let start = 1;
  let step = 1;
  let end = 1;

  if (ctx.args.length === 1) {
    end = parseInt(ctx.args[0], 10);
  } else if (ctx.args.length === 2) {
    start = parseInt(ctx.args[0], 10);
    end = parseInt(ctx.args[1], 10);
  } else if (ctx.args.length >= 3) {
    start = parseInt(ctx.args[0], 10);
    step = parseInt(ctx.args[1], 10);
    end = parseInt(ctx.args[2], 10);
  }

  if (step > 0) {
    for (let i = start; i <= end; i += step) {
      ctx.writeln(i.toString());
    }
  } else if (step < 0) {
    for (let i = start; i >= end; i += step) {
      ctx.writeln(i.toString());
    }
  }

  return 0;
};

export const tee: BuiltinFn = (ctx) => {
  let append = false;
  const files: string[] = [];

  for (const arg of ctx.args) {
    if (arg === '-a') {
      append = true;
    } else {
      files.push(arg);
    }
  }

  const input = ctx.stdin || '';
  ctx.write(input);

  for (const file of files) {
    try {
      if (append && ctx.vfs.exists(file)) {
        const existing = new TextDecoder().decode(ctx.vfs.readFile(file));
        ctx.vfs.writeFile(file, new TextEncoder().encode(existing + input));
      } else {
        ctx.vfs.writeFile(file, new TextEncoder().encode(input));
      }
    } catch (error) {
      ctx.writeError(`tee: ${error instanceof Error ? error.message : 'failed'}\n`);
    }
  }

  return 0;
};

export const xargs: BuiltinFn = async (ctx) => {
  const cmd = ctx.args[0] || 'echo';
  const cmdArgs = ctx.args.slice(1);
  const inputArgs = (ctx.stdin || '').trim().split(/\s+/).filter(Boolean);
  
  // Just concatenate for now - xargs is complex
  ctx.writeln(`xargs: would run ${cmd} ${[...cmdArgs, ...inputArgs].join(' ')}`);
  return 0;
};

// =============================================================================
// Network Commands (curl, wget)
// =============================================================================

export const curl: BuiltinFn = async (ctx) => {
  const args = ctx.args;
  let url = '';
  let outputFile = '';
  let silent = false;
  let showHeaders = false;
  let method = 'GET';
  let data = '';
  const headers: Record<string, string> = {};

  // Parse arguments
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-o' && i + 1 < args.length) {
      outputFile = args[++i];
    } else if (arg === '-O') {
      // Use remote filename
      outputFile = '__use_remote__';
    } else if (arg === '-s' || arg === '--silent') {
      silent = true;
    } else if (arg === '-i' || arg === '--include') {
      showHeaders = true;
    } else if (arg === '-X' && i + 1 < args.length) {
      method = args[++i];
    } else if (arg === '-d' || arg === '--data') {
      data = args[++i] || '';
      if (method === 'GET') method = 'POST';
    } else if (arg === '-H' && i + 1 < args.length) {
      const header = args[++i];
      const colonIdx = header.indexOf(':');
      if (colonIdx > 0) {
        headers[header.substring(0, colonIdx).trim()] = header.substring(colonIdx + 1).trim();
      }
    } else if (!arg.startsWith('-')) {
      url = arg;
    }
  }

  if (!url) {
    ctx.writeError('curl: no URL specified\n');
    ctx.writeln('Usage: curl [options] <url>');
    ctx.writeln('Options:');
    ctx.writeln('  -o <file>   Write output to file');
    ctx.writeln('  -O          Use remote filename');
    ctx.writeln('  -s          Silent mode');
    ctx.writeln('  -i          Include headers in output');
    ctx.writeln('  -X <method> HTTP method (GET, POST, etc.)');
    ctx.writeln('  -d <data>   POST data');
    ctx.writeln('  -H <header> Add header');
    return 1;
  }

  // Ensure URL has protocol
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = 'https://' + url;
  }

  try {
    const fetchOptions: RequestInit = { method, headers };
    if (data && method !== 'GET') {
      fetchOptions.body = data;
    }

    if (!silent) {
      ctx.writeln(`  % Total    % Received % Xferd  Average Speed   Time    Time     Time  Current`);
      ctx.writeln(`                                 Dload  Upload   Total   Spent    Left  Speed`);
    }

    const response = await fetch(url, fetchOptions);

    if (showHeaders) {
      ctx.writeln(`HTTP/1.1 ${response.status} ${response.statusText}`);
      response.headers.forEach((value, key) => {
        ctx.writeln(`${key}: ${value}`);
      });
      ctx.writeln('');
    }

    const content = await response.text();

    if (outputFile) {
      let filename = outputFile;
      if (outputFile === '__use_remote__') {
        // Extract filename from URL
        const urlObj = new URL(url);
        filename = urlObj.pathname.split('/').pop() || 'index.html';
      }
      ctx.vfs.writeFile(filename, new TextEncoder().encode(content));
      if (!silent) {
        ctx.writeln(`100 ${content.length}    100 ${content.length}    0     0   ${content.length}      0 --:--:-- --:--:-- --:--:-- ${content.length}`);
      }
    } else {
      ctx.write(content);
    }

    return response.ok ? 0 : 1;
  } catch (error) {
    ctx.writeError(`curl: (6) Could not resolve host: ${error instanceof Error ? error.message : 'unknown error'}\n`);
    return 6;
  }
};

export const wget: BuiltinFn = async (ctx) => {
  const args = ctx.args;
  let url = '';
  let outputFile = '';
  let quiet = false;

  // Parse arguments
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if ((arg === '-O' || arg === '-o' || arg === '--output-document') && i + 1 < args.length) {
      outputFile = args[++i];
    } else if (arg === '-q' || arg === '--quiet') {
      quiet = true;
    } else if (!arg.startsWith('-')) {
      url = arg;
    }
  }

  if (!url) {
    ctx.writeError('wget: missing URL\n');
    ctx.writeln('Usage: wget [options] <url>');
    ctx.writeln('Options:');
    ctx.writeln('  -O <file>  Write to file');
    ctx.writeln('  -q         Quiet mode');
    return 1;
  }

  // Ensure URL has protocol
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = 'https://' + url;
  }

  try {
    // Extract filename
    if (!outputFile) {
      const urlObj = new URL(url);
      outputFile = urlObj.pathname.split('/').pop() || 'index.html';
    }

    if (!quiet) {
      ctx.writeln(`--${new Date().toISOString().replace('T', ' ').slice(0, 19)}--  ${url}`);
      ctx.writeln(`Resolving ${new URL(url).hostname}...`);
      ctx.writeln('Connecting... connected.');
      ctx.writeln('HTTP request sent, awaiting response...');
    }

    const response = await fetch(url);

    if (!quiet) {
      ctx.writeln(`${response.status} ${response.statusText}`);
      ctx.writeln(`Length: unspecified [${response.headers.get('content-type') || 'text/html'}]`);
      ctx.writeln(`Saving to: '${outputFile}'`);
      ctx.writeln('');
    }

    const content = await response.arrayBuffer();
    ctx.vfs.writeFile(outputFile, new Uint8Array(content));

    if (!quiet) {
      ctx.writeln(`${outputFile}              100%[===================>] ${content.byteLength} bytes`);
      ctx.writeln('');
      ctx.writeln(`'${outputFile}' saved [${content.byteLength}]`);
    }

    return response.ok ? 0 : 1;
  } catch (error) {
    ctx.writeError(`wget: ${error instanceof Error ? error.message : 'failed'}\n`);
    return 1;
  }
};

// =============================================================================
// Export all builtins
// =============================================================================

export const BUILTINS: Record<string, BuiltinFn> = {
  pwd, cd, ls,
  touch, cp, mv, rm, mkdir, rmdir,
  cat, head, tail,
  echo, printf, grep, wc, sort, uniq, cut, tr,
  stat, file,
  date, sleep,
  env, printenv, export: exportCmd, unset,
  true: trueCmd, false: falseCmd, ':': colon, exit: exitCmd,
  test, '[': test, read,
  tar,
  clear, history, alias, which, type,
  basename, dirname, seq, tee, xargs,
  curl, wget,
};
