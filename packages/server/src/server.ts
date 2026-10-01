import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { isQuickChat, type ClientMessage, type ServerMessage, type Team, type TeamSize } from '@rl/shared';
import { Room, type Client } from './room.js';

const here = dirname(fileURLToPath(import.meta.url));
let STATIC_DIR = resolve(join(here, '../../client/dist'));

// ---------------------------------------------------------------- rooms
const rooms = new Map<string, Room>();
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function newCode(): string {
  for (;;) {
    let c = '';
    for (let i = 0; i < 5; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    if (!rooms.has(c)) return c;
  }
}

function createRoom(teamSize: TeamSize, isPublic: boolean): Room {
  const room = new Room(newCode(), teamSize, isPublic, (r) => rooms.delete(r.code));
  rooms.set(room.code, room);
  return room;
}

const validSize = (n: unknown): TeamSize => (n === 1 || n === 2 || n === 3 ? n : 3);
const cleanName = (n: unknown) => (typeof n === 'string' ? n.replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 16) : '') || 'Jugador';

// --------------------------------------------------------------- static
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

async function serveStatic(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
    return;
  }
  let file = normalize(join(STATIC_DIR, decodeURIComponent(url.pathname)));
  if (file !== STATIC_DIR && !file.startsWith(STATIC_DIR + sep)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const st = await stat(file).catch(() => null);
    if (!st || st.isDirectory()) file = join(STATIC_DIR, 'index.html');
    const data = await readFile(file);
    res.writeHead(200, {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      'cache-control': file.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Cliente no compilado. Ejecuta "npm run build".');
  }
}

// ------------------------------------------------------------ websocket
let nextId = 1;

export interface RunningServer {
  port: number;
  close(): Promise<void>;
}

export function startServer(port: number, staticDir?: string): Promise<RunningServer> {
  if (staticDir) STATIC_DIR = resolve(staticDir);
  const server = createServer((req, res) => void serveStatic(req, res));
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });
  wss.on('connection', onConnection);
  return new Promise((resolveStart) => {
    server.listen(port, () => {
      const addr = server.address();
      const actual = typeof addr === 'object' && addr ? addr.port : port;
      resolveStart({
        port: actual,
        close: () =>
          new Promise<void>((r) => {
            for (const room of rooms.values()) room.stop();
            rooms.clear();
            for (const c of wss.clients) c.terminate();
            wss.close();
            server.close(() => r());
          }),
      });
    });
  });
}

function onConnection(ws: WebSocket) {
  const client: Client = {
    id: nextId,
    name: 'Jugador',
    ping: 0,
    room: null,
    send(msg: ServerMessage) {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
    },
    sendBinary(data: Uint8Array) {
      // Skip snapshots for clients with a congested socket; the next one supersedes it
      if (ws.readyState === ws.OPEN && ws.bufferedAmount < 256 * 1024) ws.send(data);
    },
  };
  nextId = nextId >= 29999 ? 1 : nextId + 1;
  client.send({ t: 'welcome', playerId: client.id });

  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    let msg: ClientMessage;
    try {
      msg = JSON.parse(data.toString()) as ClientMessage;
    } catch {
      return;
    }
    handle(client, msg);
  });
  ws.on('close', () => client.room?.leave(client.id));
}

function handle(client: Client, msg: ClientMessage) {
  switch (msg.t) {
    case 'ping':
      if (typeof msg.rtt === 'number') client.ping = Math.max(0, Math.min(9999, Math.round(msg.rtt)));
      client.send({ t: 'pong', c: msg.c, s: client.room?.state?.tick ?? 0 });
      return;
    case 'input':
      client.room?.receiveInputs(client.id, msg.inputs);
      return;
    case 'create': {
      client.room?.leave(client.id);
      client.name = cleanName(msg.name);
      createRoom(validSize(msg.teamSize), false).join(client);
      return;
    }
    case 'join': {
      client.room?.leave(client.id);
      client.name = cleanName(msg.name);
      const room = rooms.get(String(msg.code).toUpperCase());
      if (!room) client.send({ t: 'error', message: 'No existe una sala con ese código' });
      else if (!room.join(client)) client.send({ t: 'error', message: 'La sala está llena' });
      return;
    }
    case 'quick': {
      client.room?.leave(client.id);
      client.name = cleanName(msg.name);
      const size = validSize(msg.teamSize);
      const room =
        [...rooms.values()].find((r) => r.isPublic && r.teamSize === size && r.freeSlots() > 0) ?? createRoom(size, true);
      room.join(client);
      return;
    }
    case 'team':
      client.room?.setTeam(client.id, (msg.team === 1 ? 1 : 0) as Team);
      return;
    case 'size':
      client.room?.setTeamSize(client.id, validSize(msg.teamSize));
      return;
    case 'start':
      client.room?.start(client.id);
      return;
    case 'leave':
      client.room?.leave(client.id);
      client.send({ t: 'left' });
      return;
    case 'chat': {
      const room = client.room;
      if (!room || typeof msg.text !== 'string' || !isQuickChat(msg.text)) return;
      const team = room.members.get(client.id)?.team ?? 0;
      room.broadcast({ t: 'chat', from: client.name, team, text: msg.text });
      return;
    }
  }
}
