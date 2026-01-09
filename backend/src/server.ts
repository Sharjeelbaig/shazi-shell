import http from 'node:http';
import express from 'express';
import Docker from 'dockerode';
import { WebSocketServer } from 'ws';

type ClientMessage =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'ping' };

type ServerMessage =
  | { type: 'ready' }
  | { type: 'output'; data: string }
  | { type: 'error'; message: string };

const PORT = Number(process.env.PORT ?? 5174);
const IMAGE = process.env.SHAZI_SANDBOX_IMAGE ?? 'shazi-shell-sandbox:latest';
const MEMORY_MB = Number(process.env.SHAZI_SANDBOX_MEMORY_MB ?? 768);
const PIDS_LIMIT = Number(process.env.SHAZI_SANDBOX_PIDS_LIMIT ?? 256);

const docker = new Docker({ socketPath: process.env.DOCKER_SOCKET ?? '/var/run/docker.sock' });

const app = express();
app.get('/health', (_req, res) => res.json({ ok: true }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/pty' });

function send(ws: import('ws').WebSocket, msg: ServerMessage) {
  ws.send(JSON.stringify(msg));
}

wss.on('connection', async (ws) => {
  let container: Docker.Container | null = null;
  let io: NodeJS.ReadWriteStream | null = null;
  let closed = false;

  const cleanup = async () => {
    if (closed) return;
    closed = true;

    try {
      if (io) {
        try {
          io.end();
        } catch {
          // ignore
        }
      }

      if (container) {
        try {
          await container.stop({ t: 0 });
        } catch {
          // ignore
        }

        try {
          await container.remove({ force: true });
        } catch {
          // ignore
        }
      }
    } finally {
      container = null;
      io = null;
    }
  };

  ws.on('close', () => {
    void cleanup();
  });

  ws.on('error', () => {
    void cleanup();
  });

  try {
    // Create an ephemeral container with a TTY so the stream is raw.
    container = await docker.createContainer({
      Image: IMAGE,
      Cmd: ['bash', '-l'],
      WorkingDir: '/workspace',
      Tty: true,
      OpenStdin: true,
      StdinOnce: false,
      Env: [
        'TERM=xterm-256color',
        'HOME=/home/sandbox',
        'USER=sandbox',
        'SHELL=/bin/bash',
      ],
      HostConfig: {
        AutoRemove: true,
        NetworkMode: 'bridge',
        Memory: MEMORY_MB * 1024 * 1024,
        PidsLimit: PIDS_LIMIT,
        ReadonlyRootfs: false,
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges'],
      },
      User: 'sandbox',
    });

    await container.start();

    io = (await container.attach({
      stream: true,
      stdin: true,
      stdout: true,
      stderr: true,
      hijack: true,
    })) as unknown as NodeJS.ReadWriteStream;

    io.on('data', (chunk: Buffer) => {
      if (ws.readyState !== ws.OPEN) return;
      // Container TTY output is a byte stream; assume UTF-8.
      send(ws, { type: 'output', data: chunk.toString('utf8') });
    });

    io.on('error', () => {
      // ignore; cleanup handled by ws close
    });

    send(ws, { type: 'ready' });

    ws.on('message', async (raw) => {
      if (!container || !io) return;

      let msg: ClientMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (msg.type === 'ping') return;

      if (msg.type === 'input') {
        try {
          io.write(msg.data);
        } catch {
          // ignore
        }
        return;
      }

      if (msg.type === 'resize') {
        try {
          await container.resize({ h: msg.rows, w: msg.cols });
        } catch {
          // ignore
        }
      }
    });
  } catch (err: any) {
    send(ws, { type: 'error', message: err?.message || String(err) });
    await cleanup();
    try {
      ws.close();
    } catch {
      // ignore
    }
  }
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`shazi-shell backend listening on http://localhost:${PORT}`);
  // eslint-disable-next-line no-console
  console.log(`WS PTY endpoint: ws://localhost:${PORT}/pty`);
  // eslint-disable-next-line no-console
  console.log(`Using Docker image: ${IMAGE}`);
});
