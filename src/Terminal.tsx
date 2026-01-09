import { useEffect, useRef, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { WorkerRequest, WorkerResponse } from './types';

export function TerminalComponent() {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const backendWsRef = useRef<WebSocket | null>(null);
  const modeRef = useRef<'local' | 'backend'>('local');
  const fitAddonRef = useRef<FitAddon | null>(null);
  const inputBufferRef = useRef<string>('');
  const cursorPosRef = useRef<number>(0); // Cursor position within input buffer
  const isReadyRef = useRef<boolean>(false);
  const isInReplRef = useRef<boolean>(false);
  const replPromptRef = useRef<string>('>>> ');

  const writePrompt = useCallback(() => {
    const term = xtermRef.current;
    if (!term) return;
    
    if (isInReplRef.current) {
      term.write(`\x1b[33m${replPromptRef.current}\x1b[0m`);
    } else {
      term.write('\x1b[32m$\x1b[0m ');
    }
  }, []);

  const redrawLine = useCallback(() => {
    const term = xtermRef.current;
    if (!term) return;
    
    // Clear line, rewrite prompt and input, position cursor
    term.write('\x1b[2K\r'); // Clear entire line
    writePrompt();
    term.write(inputBufferRef.current);
    
    // Move cursor to correct position
    const distanceFromEnd = inputBufferRef.current.length - cursorPosRef.current;
    if (distanceFromEnd > 0) {
      term.write(`\x1b[${distanceFromEnd}D`); // Move cursor left
    }
  }, [writePrompt]);

  const handleWorkerMessage = useCallback((msg: WorkerResponse) => {
    const term = xtermRef.current;
    if (!term) return;

    switch (msg.type) {
      case 'ready':
        isReadyRef.current = true;
        writePrompt();
        break;
      case 'stdout':
        term.write(msg.data.replace(/\n/g, '\r\n'));
        break;
      case 'stderr':
        term.write(`\x1b[31m${msg.data.replace(/\n/g, '\r\n')}\x1b[0m`);
        break;
      case 'exit':
        writePrompt();
        break;
      case 'error':
        term.writeln(`\r\n\x1b[31mError: ${msg.message}\x1b[0m`);
        writePrompt();
        break;
      case 'history':
        // Clear current line and replace with history entry
        inputBufferRef.current = msg.command;
        cursorPosRef.current = msg.command.length;
        redrawLine();
        break;
      case 'replActive':
        isInReplRef.current = true;
        break;
      case 'replExit':
        isInReplRef.current = false;
        writePrompt();
        break;
      case 'prompt':
        if (msg.isRepl) {
          replPromptRef.current = msg.prompt;
          writePrompt();
        }
        break;
    }
  }, [writePrompt, redrawLine]);

  const handleTerminalInput = useCallback((data: string) => {
    const term = xtermRef.current;
    const worker = workerRef.current;
    if (!term) return;

    if (modeRef.current === 'backend') {
      const ws = backendWsRef.current;
      if (!ws || ws.readyState !== ws.OPEN) return;
      ws.send(JSON.stringify({ type: 'input', data }));
      return;
    }
    if (!worker) return;

    // Wait until worker signals ready
    if (!isReadyRef.current) return;

    if (data === '\r') {
      term.write('\r\n');
      const command = inputBufferRef.current;
      inputBufferRef.current = '';
      cursorPosRef.current = 0;
      if (command.trim() || isInReplRef.current) {
        worker.postMessage({ type: 'exec', command } as WorkerRequest);
      } else {
        writePrompt();
      }
    } else if (data === '\x7F' || data === '\b') {
      // Backspace
      if (cursorPosRef.current > 0) {
        const before = inputBufferRef.current.slice(0, cursorPosRef.current - 1);
        const after = inputBufferRef.current.slice(cursorPosRef.current);
        inputBufferRef.current = before + after;
        cursorPosRef.current--;
        redrawLine();
      }
    } else if (data === '\x1b[3~') {
      // Delete key
      if (cursorPosRef.current < inputBufferRef.current.length) {
        const before = inputBufferRef.current.slice(0, cursorPosRef.current);
        const after = inputBufferRef.current.slice(cursorPosRef.current + 1);
        inputBufferRef.current = before + after;
        redrawLine();
      }
    } else if (data === '\x03') {
      term.write('^C\r\n');
      inputBufferRef.current = '';
      cursorPosRef.current = 0;
      if (isInReplRef.current) {
        // In REPL, Ctrl+C just cancels current input
        writePrompt();
      } else {
        worker.postMessage({ type: 'interrupt' } as WorkerRequest);
      }
    } else if (data === '\x04') {
      // Ctrl+D - exit REPL if in REPL mode
      if (isInReplRef.current && inputBufferRef.current === '') {
        term.write('\r\n');
        worker.postMessage({ type: 'exec', command: 'exit()' } as WorkerRequest);
      }
    } else if (data === '\x0C') {
      term.clear();
      writePrompt();
      term.write(inputBufferRef.current);
    } else if (data === '\x1b[A') {
      // Up arrow - get previous history (only in shell mode)
      if (!isInReplRef.current) {
        worker.postMessage({ type: 'historyPrev' } as WorkerRequest);
      }
    } else if (data === '\x1b[B') {
      // Down arrow - get next history (only in shell mode)
      if (!isInReplRef.current) {
        worker.postMessage({ type: 'historyNext' } as WorkerRequest);
      }
    } else if (data === '\x1b[C') {
      // Right arrow
      if (cursorPosRef.current < inputBufferRef.current.length) {
        cursorPosRef.current++;
        term.write(data);
      }
    } else if (data === '\x1b[D') {
      // Left arrow
      if (cursorPosRef.current > 0) {
        cursorPosRef.current--;
        term.write(data);
      }
    } else if (data === '\x1b[H' || data === '\x01') {
      // Home or Ctrl+A - move to beginning
      if (cursorPosRef.current > 0) {
        term.write(`\x1b[${cursorPosRef.current}D`);
        cursorPosRef.current = 0;
      }
    } else if (data === '\x1b[F' || data === '\x05') {
      // End or Ctrl+E - move to end
      const distance = inputBufferRef.current.length - cursorPosRef.current;
      if (distance > 0) {
        term.write(`\x1b[${distance}C`);
        cursorPosRef.current = inputBufferRef.current.length;
      }
    } else if (data === '\x15') {
      // Ctrl+U - clear line before cursor
      inputBufferRef.current = inputBufferRef.current.slice(cursorPosRef.current);
      cursorPosRef.current = 0;
      redrawLine();
    } else if (data === '\x0b') {
      // Ctrl+K - clear line after cursor
      inputBufferRef.current = inputBufferRef.current.slice(0, cursorPosRef.current);
      redrawLine();
    } else if (data === '\x17') {
      // Ctrl+W - delete word before cursor
      const before = inputBufferRef.current.slice(0, cursorPosRef.current);
      const after = inputBufferRef.current.slice(cursorPosRef.current);
      const newBefore = before.replace(/\S*\s*$/, '');
      inputBufferRef.current = newBefore + after;
      cursorPosRef.current = newBefore.length;
      redrawLine();
    } else if (data >= ' ' || data === '\t') {
      // Insert character at cursor position
      const before = inputBufferRef.current.slice(0, cursorPosRef.current);
      const after = inputBufferRef.current.slice(cursorPosRef.current);
      inputBufferRef.current = before + data + after;
      cursorPosRef.current += data.length;
      
      // If at end, just write character, otherwise redraw
      if (after.length === 0) {
        term.write(data);
      } else {
        redrawLine();
      }
    }
  }, [writePrompt, redrawLine]);

  useEffect(() => {
    if (!terminalRef.current) return;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      theme: {
        background: '#1e1e1e',
        foreground: '#d4d4d4',
        cursor: '#d4d4d4',
      },
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);
    term.open(terminalRef.current);
    term.focus();
    fitAddon.fit();
    fitAddonRef.current = fitAddon;
    xtermRef.current = term;

    const sandboxWsUrl = (import.meta as any).env?.VITE_SANDBOX_WS as string | undefined;

    if (sandboxWsUrl && sandboxWsUrl.trim()) {
      modeRef.current = 'backend';
      term.writeln('\x1b[1;36mShazi Shell\x1b[0m');
      term.writeln('Connecting to self-hosted sandbox...');

      const ws = new WebSocket(sandboxWsUrl);
      backendWsRef.current = ws;

      ws.onopen = () => {
        term.writeln(`Connected: ${sandboxWsUrl}`);
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(String(event.data));
          if (msg?.type === 'ready') return;
          if (msg?.type === 'output' && typeof msg.data === 'string') {
            term.write(msg.data);
            return;
          }
          if (msg?.type === 'error' && typeof msg.message === 'string') {
            term.writeln(`\r\n\x1b[31mSandbox error: ${msg.message}\x1b[0m`);
          }
        } catch {
          // ignore
        }
      };

      ws.onerror = () => {
        term.writeln('\r\n\x1b[31mSandbox connection error\x1b[0m');
      };

      ws.onclose = () => {
        term.writeln('\r\n\x1b[31mSandbox disconnected\x1b[0m');
      };

      const inputDisposable = term.onData(handleTerminalInput);

      const handleResize = () => {
        fitAddon.fit();
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
        }
      };
      window.addEventListener('resize', handleResize);

      const containerEl = terminalRef.current;
      const handleClick = () => term.focus();
      containerEl.addEventListener('click', handleClick);

      return () => {
        window.removeEventListener('resize', handleResize);
        containerEl.removeEventListener('click', handleClick);
        inputDisposable.dispose();
        try {
          ws.close();
        } catch {
          // ignore
        }
        term.dispose();
      };
    }

    const worker = new Worker(new URL('./worker.ts', import.meta.url), {
      type: 'module',
    });
    workerRef.current = worker;
    worker.onmessage = (e: MessageEvent<WorkerResponse>) => handleWorkerMessage(e.data);
    worker.onerror = (err) => term.writeln(`\r\n\x1b[31mWorker error: ${err.message}\x1b[0m`);
    worker.postMessage({ type: 'init' } as WorkerRequest);

    term.writeln('\x1b[1;36mShazi Shell\x1b[0m');
    term.writeln('WebAssembly-based sandboxed terminal');
    term.writeln('Type "help" for available commands');
    term.writeln('Type "python" or "node" to start a REPL\r\n');

    const inputDisposable = term.onData(handleTerminalInput);

    const handleResize = () => {
      fitAddon.fit();
    };
    window.addEventListener('resize', handleResize);

    // Make container focus the terminal on click
    const containerEl = terminalRef.current;
    const handleClick = () => term.focus();
    containerEl.addEventListener('click', handleClick);

    return () => {
      window.removeEventListener('resize', handleResize);
      containerEl.removeEventListener('click', handleClick);
      inputDisposable.dispose();
      term.dispose();
      worker.terminate();
    };
  }, [handleWorkerMessage, handleTerminalInput]);

  return (
    <div
      ref={terminalRef}
      style={{
        width: '100%',
        height: '100%',
        padding: '10px',
      }}
    />
  );
}
