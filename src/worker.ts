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

  // Initialize shell
  shell = new Shell(vfs, handleOutput);

  isReady = true;
  postMessage({ type: 'ready' });
}

async function handleExec(command: string, cwd?: string): Promise<void> {
  if (!isReady) {
    postMessage({ type: 'error', message: 'Worker not initialized' });
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
  const exitCode = await shell.execute(command);

  postMessage({ type: 'exit', code: exitCode });
}

// Register message handler
ctx.addEventListener('message', handleMessage);

// Export for access from main thread (for getPrompt, etc.)
export { shell };
