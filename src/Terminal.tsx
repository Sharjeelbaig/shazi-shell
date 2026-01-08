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
  const fitAddonRef = useRef<FitAddon | null>(null);
  const inputBufferRef = useRef<string>('');
  const isReadyRef = useRef<boolean>(false);

  const writePrompt = useCallback(() => {
    const term = xtermRef.current;
    if (term) term.write('\x1b[32m$\x1b[0m ');
  }, []);

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
        term.write('\r\n');
        writePrompt();
        break;
      case 'error':
        term.writeln(`\r\n\x1b[31mError: ${msg.message}\x1b[0m`);
        writePrompt();
        break;
    }
  }, [writePrompt]);

  const handleTerminalInput = useCallback((data: string) => {
    const term = xtermRef.current;
    const worker = workerRef.current;
    if (!term || !worker) return;

    // Wait until worker signals ready
    if (!isReadyRef.current) return;

    if (data === '\r') {
      term.write('\r\n');
      const command = inputBufferRef.current;
      inputBufferRef.current = '';
      if (command.trim()) {
        worker.postMessage({ type: 'exec', command } as WorkerRequest);
      } else {
        writePrompt();
      }
    } else if (data === '\x7F') {
      if (inputBufferRef.current.length > 0) {
        inputBufferRef.current = inputBufferRef.current.slice(0, -1);
        term.write('\b \b');
      }
    } else if (data === '\x03') {
      term.write('^C\r\n');
      inputBufferRef.current = '';
      worker.postMessage({ type: 'interrupt' } as WorkerRequest);
    } else if (data === '\x0C') {
      term.clear();
      writePrompt();
      term.write(inputBufferRef.current);
    } else if (data === '\x1b[A') {
      // Up arrow
    } else if (data === '\x1b[B') {
      // Down arrow
    } else if (data >= ' ' || data === '\t') {
      inputBufferRef.current += data;
      term.write(data);
    }
  }, [writePrompt]);

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

    const worker = new Worker(new URL('./worker.ts', import.meta.url), {
      type: 'module',
    });
    workerRef.current = worker;
    worker.onmessage = (e: MessageEvent<WorkerResponse>) => handleWorkerMessage(e.data);
    worker.onerror = (err) => term.writeln(`\r\n\x1b[31mWorker error: ${err.message}\x1b[0m`);
    worker.postMessage({ type: 'init' } as WorkerRequest);

    const inputDisposable = term.onData(handleTerminalInput);

    const handleResize = () => fitAddon.fit();
    window.addEventListener('resize', handleResize);

    // Make container focus the terminal on click
    const containerEl = terminalRef.current;
    const handleClick = () => term.focus();
    containerEl.addEventListener('click', handleClick);

    term.writeln('\x1b[1;36mShazi Shell v0.1.0\x1b[0m');
    term.writeln('WebAssembly-based sandboxed terminal');
    term.writeln('Type "help" for available commands\r\n');

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
