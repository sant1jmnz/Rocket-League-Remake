import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { decodeSnapshot, emptyInput, packInput, type ServerMessage } from '@rl/shared';
import { getRoom, startServer, type RunningServer } from '../src/server.js';
import { roomConfig } from '../src/room.js';

let server: RunningServer;

beforeAll(async () => {
  server = await startServer(0);
});
afterAll(async () => {
  await server.close();
});

class TestClient {
  ws: WebSocket;
  messages: ServerMessage[] = [];
  snapshots: ReturnType<typeof decodeSnapshot>[] = [];
  names: Record<number, string> = {};
  constructor(port: number) {
    this.ws = new WebSocket(`ws://localhost:${port}/ws`);
    this.ws.on('message', (data, isBinary) => {
      if (isBinary) {
        this.snapshots.push(decodeSnapshot(new Uint8Array(data as Buffer), this.names));
      } else {
        const m = JSON.parse(data.toString()) as ServerMessage;
        if (m.t === 'start' || m.t === 'names') this.names = m.names;
        this.messages.push(m);
      }
    });
  }
  open() {
    return new Promise<void>((r) => this.ws.once('open', () => r()));
  }
  send(m: object) {
    this.ws.send(JSON.stringify(m));
  }
  async waitFor<T extends ServerMessage['t']>(t: T, pred: (m: Extract<ServerMessage, { t: T }>) => boolean = () => true, ms = 4000) {
    const start = Date.now();
    while (Date.now() - start < ms) {
      const m = this.messages.find((x) => x.t === t && pred(x as Extract<ServerMessage, { t: T }>));
      if (m) return m as Extract<ServerMessage, { t: T }>;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`timeout waiting for ${t}`);
  }
}

describe('server', () => {
  it('creates a room, joins by code, fills bots and streams snapshots', async () => {
    const a = new TestClient(server.port);
    const b = new TestClient(server.port);
    await Promise.all([a.open(), b.open()]);
    const welcomeA = await a.waitFor('welcome');
    a.send({ t: 'create', name: 'Ana', teamSize: 3 });
    const roomMsg = await a.waitFor('room');
    expect(roomMsg.room.code).toHaveLength(5);
    expect(roomMsg.room.hostId).toBe(welcomeA.playerId);

    b.send({ t: 'join', name: 'Beto', code: roomMsg.room.code });
    const joined = await b.waitFor('room', (m) => m.room.players.length === 2);
    expect(joined.room.players.map((p) => p.team).sort()).toEqual([0, 1]);

    // Only the host can start
    b.send({ t: 'start' });
    await new Promise((r) => setTimeout(r, 100));
    expect(b.messages.some((m) => m.t === 'start')).toBe(false);

    a.send({ t: 'start' });
    const start = await a.waitFor('start');
    await b.waitFor('start');
    expect(start.carId).toBe(welcomeA.playerId);

    // Hold throttle for a second of game time
    for (let i = 0; i < 20; i++) {
      const tick = (a.snapshots.at(-1)?.tick ?? 0) + 6;
      a.send({ t: 'input', inputs: [packInput(tick, { ...emptyInput(), throttle: 1 })] });
      await new Promise((r) => setTimeout(r, 50));
    }
    await new Promise((r) => setTimeout(r, 4000));
    const snap = a.snapshots.at(-1)!;
    expect(snap.state.cars).toHaveLength(6);
    expect(snap.state.cars.filter((c) => c.isBot)).toHaveLength(4);
    expect(snap.state.phase).toBe('playing');
    // ~30 snapshots per second
    expect(a.snapshots.length).toBeGreaterThan(100);
    const ticks = a.snapshots.map((s) => s.tick);
    expect(ticks.every((t, i) => i === 0 || t > ticks[i - 1])).toBe(true);

    // A leaving player is replaced by a bot
    b.ws.close();
    await new Promise((r) => setTimeout(r, 300));
    const after = a.snapshots.at(-1)!;
    expect(after.state.cars).toHaveLength(6);
    expect(after.state.cars.filter((c) => c.isBot)).toHaveLength(5);
    a.ws.close();
  });

  it('rejects unknown room codes', async () => {
    const c = new TestClient(server.port);
    await c.open();
    c.send({ t: 'join', name: 'X', code: 'ZZZZZ' });
    const err = await c.waitFor('error');
    expect(err.message).toMatch(/código/);
    c.ws.close();
  });

  it('quick match puts players in the same public room', async () => {
    const a = new TestClient(server.port);
    const b = new TestClient(server.port);
    await Promise.all([a.open(), b.open()]);
    a.send({ t: 'quick', name: 'A', teamSize: 2 });
    const ra = await a.waitFor('room');
    b.send({ t: 'quick', name: 'B', teamSize: 2 });
    const rb = await b.waitFor('room');
    expect(rb.room.code).toBe(ra.room.code);
    a.ws.close();
    b.ws.close();
  });

  it('late joiners replace a bot, and the room returns to the lobby after the match', async () => {
    roomConfig.matchSeconds = 2;
    roomConfig.postMatchSeconds = 1;
    const a = new TestClient(server.port);
    await a.open();
    a.send({ t: 'create', name: 'Host', teamSize: 2 });
    const room = await a.waitFor('room');
    a.send({ t: 'start' });
    await a.waitFor('start');
    // Avoid an open-ended overtime: blue is ahead, so the match ends at 0:00
    getRoom(room.room.code)!.state!.score = [1, 0];
    a.messages = [];
    await new Promise((r) => setTimeout(r, 1000));

    const late = new TestClient(server.port);
    await late.open();
    late.send({ t: 'join', name: 'Tarde', code: room.room.code });
    const start = await late.waitFor('start');
    await new Promise((r) => setTimeout(r, 500));
    const snap = late.snapshots.at(-1)!;
    expect(snap.state.cars).toHaveLength(4);
    expect(snap.state.cars.find((c) => c.id === start.carId)?.isBot).toBe(false);
    expect(snap.state.cars.filter((c) => c.isBot)).toHaveLength(2);

    // Match ends (2 s clock, possibly overtime) and everybody goes back to the lobby
    const lobby = await a.waitFor('room', (m) => m.room.status === 'lobby', 60000).catch((e) => {
      const st = a.snapshots.at(-1)?.state;
      throw new Error(`${e.message}: phase=${st?.phase} clock=${st?.clock} running=${st?.clockRunning} score=${st?.score} ot=${st?.overtime} waitGround=${st?.waitingForBallGround} ballZ=${st?.ball.pos.z}`);
    });
    expect(lobby.room.players).toHaveLength(2);
    const ended = a.snapshots.some((s) => s.state.phase === 'ended');
    expect(ended).toBe(true);
    roomConfig.matchSeconds = 300;
    roomConfig.postMatchSeconds = 10;
    a.ws.close();
    late.ws.close();
  }, 70000);
});
