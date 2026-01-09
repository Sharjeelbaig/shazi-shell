/**
 * POSIX-compatible shell parser
 * Handles control structures, pipes, redirections, variables, etc.
 */

export interface Redirect {
  type: '>' | '>>' | '<' | '2>' | '2>>' | '&>' | '2>&1';
  target: string;
}

export interface SimpleCommand {
  cmd: string;
  args: string[];
  redirects: Redirect[];
  background: boolean;
}

export interface Pipeline {
  commands: SimpleCommand[];
  operator?: '&&' | '||' | ';';
}

/**
 * Expand brace expressions like {1..5} or {a,b,c}
 */
export function expandBraces(input: string): string {
  let result = input;
  
  // Handle {start..end} numeric ranges
  const rangeRegex = /\{(-?\d+)\.\.(-?\d+)\}/g;
  let match;
  
  while ((match = rangeRegex.exec(result)) !== null) {
    const start = parseInt(match[1], 10);
    const end = parseInt(match[2], 10);
    const expansion: string[] = [];
    
    if (start <= end) {
      for (let i = start; i <= end; i++) {
        expansion.push(i.toString());
      }
    } else {
      for (let i = start; i >= end; i--) {
        expansion.push(i.toString());
      }
    }
    
    result = result.replace(match[0], expansion.join(' '));
    rangeRegex.lastIndex = 0; // Reset for next iteration
  }
  
  // Handle {a,b,c} comma-separated lists
  const listRegex = /\{([^{}]+,[^{}]+)\}/g;
  while ((match = listRegex.exec(result)) !== null) {
    const items = match[1].split(',').map(s => s.trim());
    result = result.replace(match[0], items.join(' '));
    listRegex.lastIndex = 0;
  }
  
  return result;
}

/**
 * Expand arithmetic expressions $((expr))
 */
export function expandArithmetic(input: string, getVar: (name: string) => string): string {
  const arithRegex = /\$\(\((.+?)\)\)/g;
  
  return input.replace(arithRegex, (_, expr: string) => {
    // Replace variables in expression  
    let evalExpr = expr.replace(/\b([a-zA-Z_][a-zA-Z0-9_]*)\b/g, (varMatch: string) => {
      // Skip operators and known math functions
      if (['true', 'false', 'Math', 'pow', 'floor', 'ceil', 'abs'].includes(varMatch)) {
        return varMatch;
      }
      const val = getVar(varMatch);
      return val || '0';
    });
    
    try {
      // Safe arithmetic evaluation
      evalExpr = evalExpr.replace(/(\d+)\s*\*\*\s*(\d+)/g, 'Math.pow($1,$2)');
      
      // Only allow safe characters
      if (!/^[\d\s+\-*/%().<>=!&|^~,Math.powflorceiabs]+$/.test(evalExpr)) {
        return '0';
      }
      
      const result = Function('"use strict"; return (' + evalExpr + ')')();
      return String(Math.floor(result));
    } catch {
      return '0';
    }
  });
}

/**
 * Expand variables in a string
 */
export function expandVariables(
  input: string,
  env: Map<string, string>,
  specialVars: Record<string, string>
): string {
  const getVar = (name: string): string => {
    if (specialVars[name] !== undefined) return specialVars[name];
    return env.get(name) ?? '';
  };

  // First expand arithmetic
  let result = expandArithmetic(input, getVar);
  
  let output = '';
  let i = 0;

  while (i < result.length) {
    if (result[i] === '$') {
      i++;
      
      // Special variables $0-$9, $@, $#, $?, etc.
      if (i < result.length && '0123456789@#?$!-_*'.includes(result[i])) {
        output += specialVars[result[i]] ?? '';
        i++;
        continue;
      }

      // ${VAR} or ${VAR:-default} form
      if (result[i] === '{') {
        i++;
        let varName = '';
        let defaultValue = '';
        let hasDefault = false;
        
        while (i < result.length && result[i] !== '}') {
          if (result[i] === ':' && result[i + 1] === '-') {
            hasDefault = true;
            i += 2;
            while (i < result.length && result[i] !== '}') {
              defaultValue += result[i];
              i++;
            }
            break;
          }
          varName += result[i];
          i++;
        }
        i++; // skip }
        
        const value = env.get(varName) ?? specialVars[varName];
        output += value !== undefined && value !== '' ? value : (hasDefault ? defaultValue : '');
        continue;
      }

      // $VAR form
      let varName = '';
      while (i < result.length && /[a-zA-Z0-9_]/.test(result[i])) {
        varName += result[i];
        i++;
      }
      if (varName) {
        output += env.get(varName) ?? specialVars[varName] ?? '';
      } else {
        output += '$';
      }
      continue;
    }

    output += result[i];
    i++;
  }

  return output;
}

/**
 * Find matching closing keyword, handling nesting and quotes
 */
function findMatchingKeyword(input: string, open: string, close: string): number {
  let depth = 0;
  let i = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  
  while (i < input.length) {
    // Handle quotes
    if (!inDoubleQuote && input[i] === "'" && input[i - 1] !== '\\') {
      inSingleQuote = !inSingleQuote;
      i++;
      continue;
    }
    if (!inSingleQuote && input[i] === '"' && input[i - 1] !== '\\') {
      inDoubleQuote = !inDoubleQuote;
      i++;
      continue;
    }
    
    if (inSingleQuote || inDoubleQuote) {
      i++;
      continue;
    }
    
    // Check for keywords at word boundaries
    const isWordBoundary = (pos: number) => {
      if (pos < 0) return true;
      if (pos >= input.length) return true;
      return /[\s;|&()<>]/.test(input[pos]);
    };
    
    // Check for opening keyword
    if (isWordBoundary(i - 1) && input.substring(i, i + open.length) === open && isWordBoundary(i + open.length)) {
      depth++;
      i += open.length;
      continue;
    }
    
    // Check for closing keyword
    if (isWordBoundary(i - 1) && input.substring(i, i + close.length) === close && isWordBoundary(i + close.length)) {
      depth--;
      if (depth === 0) {
        return i;
      }
      i += close.length;
      continue;
    }
    
    i++;
  }
  
  return -1;
}

/**
 * Extract a complete control structure from input
 */
export function extractControlStructure(input: string): { type: string; content: string; remaining: string } | null {
  const trimmed = input.trim();
  
  // For loop
  if (/^for\s/.test(trimmed)) {
    const doneIdx = findMatchingKeyword(trimmed, 'for', 'done');
    if (doneIdx !== -1) {
      return {
        type: 'for',
        content: trimmed.substring(0, doneIdx + 4),
        remaining: trimmed.substring(doneIdx + 4).trim()
      };
    }
  }
  
  // While loop
  if (/^while\s/.test(trimmed)) {
    const doneIdx = findMatchingKeyword(trimmed, 'while', 'done');
    if (doneIdx !== -1) {
      return {
        type: 'while',
        content: trimmed.substring(0, doneIdx + 4),
        remaining: trimmed.substring(doneIdx + 4).trim()
      };
    }
  }
  
  // Until loop
  if (/^until\s/.test(trimmed)) {
    const doneIdx = findMatchingKeyword(trimmed, 'until', 'done');
    if (doneIdx !== -1) {
      return {
        type: 'until',
        content: trimmed.substring(0, doneIdx + 4),
        remaining: trimmed.substring(doneIdx + 4).trim()
      };
    }
  }
  
  // If statement
  if (/^if\s/.test(trimmed)) {
    const fiIdx = findMatchingKeyword(trimmed, 'if', 'fi');
    if (fiIdx !== -1) {
      return {
        type: 'if',
        content: trimmed.substring(0, fiIdx + 2),
        remaining: trimmed.substring(fiIdx + 2).trim()
      };
    }
  }
  
  // Case statement
  if (/^case\s/.test(trimmed)) {
    const esacIdx = findMatchingKeyword(trimmed, 'case', 'esac');
    if (esacIdx !== -1) {
      return {
        type: 'case',
        content: trimmed.substring(0, esacIdx + 4),
        remaining: trimmed.substring(esacIdx + 4).trim()
      };
    }
  }
  
  return null;
}

/**
 * Tokenize a simple command into parts
 */
export function tokenizeCommand(input: string): { cmd: string; args: string[]; redirects: Redirect[] } {
  const tokens: string[] = [];
  const redirects: Redirect[] = [];
  let i = 0;
  
  while (i < input.length) {
    // Skip whitespace
    while (i < input.length && (input[i] === ' ' || input[i] === '\t')) i++;
    if (i >= input.length) break;
    
    // Check for redirections
    let redirType: Redirect['type'] | null = null;
    
    if (input.substring(i, i + 4) === '2>&1') {
      redirType = '2>&1';
      i += 4;
    } else if (input.substring(i, i + 3) === '2>>') {
      redirType = '2>>';
      i += 3;
    } else if (input.substring(i, i + 2) === '2>') {
      redirType = '2>';
      i += 2;
    } else if (input.substring(i, i + 2) === '&>') {
      redirType = '&>';
      i += 2;
    } else if (input.substring(i, i + 2) === '>>') {
      redirType = '>>';
      i += 2;
    } else if (input[i] === '>') {
      redirType = '>';
      i++;
    } else if (input[i] === '<') {
      redirType = '<';
      i++;
    }
    
    if (redirType) {
      // Skip whitespace after redirect
      while (i < input.length && input[i] === ' ') i++;
      
      // Get target filename
      let target = '';
      while (i < input.length && !/[\s<>|&;]/.test(input[i])) {
        if (input[i] === '"') {
          i++;
          while (i < input.length && input[i] !== '"') {
            if (input[i] === '\\' && i + 1 < input.length) {
              i++;
            }
            target += input[i];
            i++;
          }
          i++;
        } else if (input[i] === "'") {
          i++;
          while (i < input.length && input[i] !== "'") {
            target += input[i];
            i++;
          }
          i++;
        } else {
          target += input[i];
          i++;
        }
      }
      
      if (target) {
        redirects.push({ type: redirType, target });
      }
      continue;
    }
    
    // Read a word
    let word = '';
    while (i < input.length) {
      const char = input[i];
      
      if (/[\s<>|&;]/.test(char)) break;
      if (char === '2' && input[i + 1] === '>') break;
      
      if (char === '"') {
        i++;
        while (i < input.length && input[i] !== '"') {
          if (input[i] === '\\' && i + 1 < input.length && '"\\$`'.includes(input[i + 1])) {
            i++;
          }
          word += input[i];
          i++;
        }
        i++;
      } else if (char === "'") {
        i++;
        while (i < input.length && input[i] !== "'") {
          word += input[i];
          i++;
        }
        i++;
      } else if (char === '\\' && i + 1 < input.length) {
        i++;
        word += input[i];
        i++;
      } else {
        word += char;
        i++;
      }
    }
    
    if (word) {
      tokens.push(word);
    }
  }
  
  return {
    cmd: tokens[0] || '',
    args: tokens.slice(1),
    redirects
  };
}

/**
 * Split input by pipes, respecting quotes and parentheses
 */
export function splitByPipes(input: string): string[] {
  const parts: string[] = [];
  let current = '';
  let i = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let parenDepth = 0;
  
  while (i < input.length) {
    const char = input[i];
    
    if (!inDoubleQuote && char === "'" && input[i - 1] !== '\\') {
      inSingleQuote = !inSingleQuote;
      current += char;
      i++;
      continue;
    }
    
    if (!inSingleQuote && char === '"' && input[i - 1] !== '\\') {
      inDoubleQuote = !inDoubleQuote;
      current += char;
      i++;
      continue;
    }
    
    if (!inSingleQuote && !inDoubleQuote) {
      if (char === '(') parenDepth++;
      if (char === ')') parenDepth--;
      
      // Check for pipe (not ||)
      if (char === '|' && input[i + 1] !== '|' && parenDepth === 0) {
        parts.push(current.trim());
        current = '';
        i++;
        continue;
      }
    }
    
    current += char;
    i++;
  }
  
  if (current.trim()) {
    parts.push(current.trim());
  }
  
  return parts;
}

/**
 * Split by operators (&&, ||, ;) while respecting control structures
 */
export function splitByOperators(input: string): { command: string; operator: '&&' | '||' | ';' | null }[] {
  const result: { command: string; operator: '&&' | '||' | ';' | null }[] = [];
  let remaining = input.trim();
  
  while (remaining.length > 0) {
    // Check for control structure first
    const ctrl = extractControlStructure(remaining);
    if (ctrl) {
      let operator: '&&' | '||' | ';' | null = null;
      let afterCtrl = ctrl.remaining;
      
      if (afterCtrl.startsWith('&&')) {
        operator = '&&';
        afterCtrl = afterCtrl.substring(2).trim();
      } else if (afterCtrl.startsWith('||')) {
        operator = '||';
        afterCtrl = afterCtrl.substring(2).trim();
      } else if (afterCtrl.startsWith(';')) {
        operator = ';';
        afterCtrl = afterCtrl.substring(1).trim();
      }
      
      result.push({ command: ctrl.content, operator });
      remaining = afterCtrl;
      continue;
    }
    
    // Find next operator
    let foundIdx = -1;
    let foundOp: '&&' | '||' | ';' | null = null;
    let foundLen = 0;
    let i = 0;
    let inSingleQuote = false;
    let inDoubleQuote = false;
    let parenDepth = 0;
    
    while (i < remaining.length) {
      const char = remaining[i];
      
      if (!inDoubleQuote && char === "'" && remaining[i - 1] !== '\\') {
        inSingleQuote = !inSingleQuote;
        i++;
        continue;
      }
      
      if (!inSingleQuote && char === '"' && remaining[i - 1] !== '\\') {
        inDoubleQuote = !inDoubleQuote;
        i++;
        continue;
      }
      
      if (!inSingleQuote && !inDoubleQuote) {
        if (char === '(') parenDepth++;
        if (char === ')') parenDepth--;
        
        if (parenDepth === 0) {
          if (remaining.substring(i, i + 2) === '&&') {
            foundIdx = i;
            foundOp = '&&';
            foundLen = 2;
            break;
          }
          if (remaining.substring(i, i + 2) === '||') {
            foundIdx = i;
            foundOp = '||';
            foundLen = 2;
            break;
          }
          if (char === ';') {
            foundIdx = i;
            foundOp = ';';
            foundLen = 1;
            break;
          }
        }
      }
      
      i++;
    }
    
    if (foundIdx !== -1) {
      const cmd = remaining.substring(0, foundIdx).trim();
      if (cmd) {
        result.push({ command: cmd, operator: foundOp });
      }
      remaining = remaining.substring(foundIdx + foundLen).trim();
    } else {
      if (remaining) {
        result.push({ command: remaining, operator: null });
      }
      break;
    }
  }
  
  return result;
}

/**
 * Check if input is complete (all quotes/structures closed)
 */
export function isComplete(input: string): boolean {
  let inSingleQuote = false;
  let inDoubleQuote = false;
  
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    const prevChar = i > 0 ? input[i - 1] : '';
    
    if (inSingleQuote) {
      if (char === "'") inSingleQuote = false;
      continue;
    }
    
    if (inDoubleQuote) {
      if (char === '"' && prevChar !== '\\') inDoubleQuote = false;
      continue;
    }
    
    if (char === "'") inSingleQuote = true;
    else if (char === '"') inDoubleQuote = true;
  }
  
  if (inSingleQuote || inDoubleQuote) return false;
  
  // Check for unclosed control structures
  const pairs: [string, string][] = [
    ['\\bif\\b', '\\bfi\\b'],
    ['\\bfor\\b', '\\bdone\\b'],
    ['\\bwhile\\b', '\\bdone\\b'],
    ['\\buntil\\b', '\\bdone\\b'],
    ['\\bcase\\b', '\\besac\\b']
  ];
  
  for (const [openPat, closePat] of pairs) {
    const opens = (input.match(new RegExp(openPat, 'g')) || []).length;
    const closes = (input.match(new RegExp(closePat, 'g')) || []).length;
    if (opens > closes) return false;
  }
  
  if (input.trimEnd().endsWith('\\')) return false;
  
  return true;
}

/**
 * Glob pattern matching
 */
export function matchGlob(pattern: string, text: string): boolean {
  let pi = 0;
  let ti = 0;
  let starIdx = -1;
  let match = 0;

  while (ti < text.length) {
    if (pi < pattern.length && (pattern[pi] === '?' || pattern[pi] === text[ti])) {
      pi++;
      ti++;
    } else if (pi < pattern.length && pattern[pi] === '*') {
      starIdx = pi;
      match = ti;
      pi++;
    } else if (starIdx !== -1) {
      pi = starIdx + 1;
      match++;
      ti = match;
    } else {
      return false;
    }
  }

  while (pi < pattern.length && pattern[pi] === '*') {
    pi++;
  }

  return pi === pattern.length;
}

/**
 * Expand glob patterns in args
 */
export function expandGlobs(args: string[], readdir: (path: string) => string[]): string[] {
  const result: string[] = [];

  for (const arg of args) {
    if (arg.includes('*') || arg.includes('?')) {
      const dir = arg.includes('/') ? arg.substring(0, arg.lastIndexOf('/')) || '.' : '.';
      const pattern = arg.includes('/') ? arg.substring(arg.lastIndexOf('/') + 1) : arg;
      
      try {
        const files = readdir(dir);
        const matches = files.filter(f => matchGlob(pattern, f) && !f.startsWith('.'));
        
        if (matches.length > 0) {
          result.push(...matches.map(f => dir === '.' ? f : `${dir}/${f}`).sort());
        } else {
          result.push(arg);
        }
      } catch {
        result.push(arg);
      }
    } else {
      result.push(arg);
    }
  }

  return result;
}
