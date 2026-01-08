import { WorkerRequest, WorkerResponse } from './types';
import { VirtualFileSystem } from './vfs';
import { Shell } from './shell';

// Worker global scope
const ctx: Worker = self as any;

let vfs: VirtualFileSystem;
let shell: Shell;
let isReady = false;

function postMessage(msg: WorkerResponse): void {
  ctx.postMessage(msg);
}

function handleOutput(data: string, isError: boolean): void {
  postMessage({
    type: isError ? 'stderr' : 'stdout',
    data,
  });
}

async function handleMessage(event: MessageEvent<WorkerRequest>): Promise<void> {
  const msg = event.data;

  try {
    switch (msg.type) {
      case 'init':
        await handleInit(msg.files);
        break;

      case 'exec':
        await handleExec(msg.command, msg.cwd);
        break;

      case 'interrupt':
        // TODO: Implement process interruption
        handleOutput('\n^C\n', false);
        postMessage({ type: 'exit', code: 130 });
        break;

      case 'resize':
        // TODO: Handle terminal resize if needed
        break;

      case 'historyPrev':
        handleHistoryPrev();
        break;

      case 'historyNext':
        handleHistoryNext();
        break;

      default:
        postMessage({
          type: 'error',
          message: `Unknown message type: ${(msg as any).type}`,
        });
    }
  } catch (error) {
    postMessage({
      type: 'error',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

function handleReplStart(runtime: string, prompt: string): void {
  postMessage({ type: 'replActive', runtime });
  postMessage({ type: 'prompt', prompt, isRepl: true });
}

function handleReplEnd(): void {
  postMessage({ type: 'replExit' });
}

async function handleInit(files?: Record<string, Uint8Array>): Promise<void> {
  if (isReady) {
    postMessage({ type: 'error', message: 'Already initialized' });
    return;
  }

  // Initialize filesystem
  vfs = new VirtualFileSystem();

  // Load initial files if provided
  if (files) {
    for (const [path, content] of Object.entries(files)) {
      try {
        vfs.writeFile(path, content);
      } catch (error) {
        console.error(`Failed to write ${path}:`, error);
      }
    }
  }

  // Initialize shell with REPL callbacks
  shell = new Shell(vfs, handleOutput, handleReplStart, handleReplEnd);

  isReady = true;
  postMessage({ type: 'ready' });
}

async function handleExec(command: string, cwd?: string): Promise<void> {
  if (!isReady) {
    postMessage({ type: 'error', message: 'Worker not initialized' });
    return;
  }

  // If we're in REPL mode, route input to REPL
  if (shell.isInRepl()) {
    await handleReplInput(command);
    return;
  }

  // Change directory if specified
  if (cwd) {
    try {
      vfs.setCwd(cwd);
    } catch (error) {
      handleOutput(
        `cd: ${error instanceof Error ? error.message : 'failed'}\n`,
        true
      );
      postMessage({ type: 'exit', code: 1 });
      return;
    }
  }

  // Execute command
  shell.addToHistory(command);
  const exitCode = await shell.execute(command);

  // If REPL was started, don't send exit code
  if (shell.isInRepl()) {
    return;
  }

  postMessage({ type: 'exit', code: exitCode });
}

async function handleReplInput(input: string): Promise<void> {
  if (!isReady || !shell || !shell.isInRepl()) {
    postMessage({ type: 'error', message: 'Not in REPL mode' });
    return;
  }

  await shell.executeReplInput(input);

  // Send the new prompt if still in REPL
  if (shell.isInRepl()) {
    postMessage({ type: 'prompt', prompt: shell.getReplPrompt(), isRepl: true });
  }
}

function handleHistoryPrev(): void {
  if (!isReady || !shell) return;
  const cmd = shell.getHistoryPrev();
  postMessage({ type: 'history', command: cmd ?? '' });
}

function handleHistoryNext(): void {
  if (!isReady || !shell) return;
  const cmd = shell.getHistoryNext();
  postMessage({ type: 'history', command: cmd ?? '' });
}

// Register message handler
ctx.addEventListener('message', handleMessage);

// Export for access from main thread (for getPrompt, etc.)
export { shell };
