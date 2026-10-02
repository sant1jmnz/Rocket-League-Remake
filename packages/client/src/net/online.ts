import {
  DT,
  SNAPSHOT_TAG,
  cloneState,
  decodeSnapshot,
  packInput,
  quantizeInput,
  stepGame,
  vadd,
  vscale,
  vsub,
  type CarBody,
  type ClientMessage,
  type ControllerInput,
  type GameEvent,
  type GameState,
  type RoomInfo,
  type ServerMessage,
  type Vec3,
} from '@rl/shared';
import type { Session } from '../game/session';

/** WebSocket connection to the game server (lobby + match traffic). */
export class NetClient {
  private ws: WebSocket | null = null;
  playerId = -1;
  room: RoomInfo | null = null;
  names: Record<number, string> = {};
  bodies: Record<number, CarBody> = {};
  rtt = 100;
  private pingTimer: number | undefined;
  onMessage: ((m: ServerMessage) => void) | null = null;
  onSnapshot: ((data: ArrayBuffer) => void) | null = null;
  onClose: ((reason: string) => void) | null = null;
  /** Debug: artificial round-trip latency in ms (?lag=150) */
  private lag = Number(new URLSearchParams(location.search).get('lag') ?? 0) || 0;

  connect(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      let opened = false;
      const timeout = window.setTimeout(() => {
        if (!opened) {
          ws.close();
          reject(new Error('No se pudo conectar con el servidor'));
        }
      }, 12000);
      ws.onopen = () => {
        opened = true;
        window.clearTimeout(timeout);
        this.pingTimer = window.setInterval(() => this.send({ t: 'ping', c: performance.now(), rtt: Math.round(this.rtt) }), 1000);
        this.send({ t: 'ping', c: performance.now() });
        resolve();
      };
      ws.onerror = () => {
        if (!opened) {
          window.clearTimeout(timeout);
          reject(new Error('No se pudo conectar con el servidor'));
        }
      };
      ws.onclose = () => {
        window.clearInterval(this.pingTimer);
        if (opened) this.onClose?.('Conexión perdida con el servidor');
        this.ws = null;
      };
      ws.onmessage = (ev) => {
        if (this.lag > 0) window.setTimeout(() => this.receive(ev), this.lag / 2);
        else this.receive(ev);
      };
    });
  }

  private receive(ev: MessageEvent) {
    if (ev.data instanceof ArrayBuffer) {
      const tag = new Uint8Array(ev.data, 0, 1)[0];
      if (tag === SNAPSHOT_TAG) this.onSnapshot?.(ev.data);
      return;
    }
    let msg: ServerMessage;
    try {
      msg = JSON.parse(ev.data as string) as ServerMessage;
    } catch {
      return;
    }
    if (msg.t === 'welcome') this.playerId = msg.playerId;
    if (msg.t === 'room') this.room = msg.room;
    if (msg.t === 'names' || msg.t === 'start') {
      this.names = msg.names;
      this.bodies = msg.bodies ?? {};
    }
    if (msg.t === 'pong') this.rtt = this.rtt * 0.8 + (performance.now() - msg.c) * 0.2;
    this.onMessage?.(msg);
  }

  get connected() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  send(m: ClientMessage) {
    const data = JSON.stringify(m);
    const go = () => {
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(data);
    };
    if (this.lag > 0) window.setTimeout(go, this.lag / 2);
    else go();
  }

  close() {
    window.clearInterval(this.pingTimer);
    this.onClose = null;
    this.ws?.close();
    this.ws = null;
  }
}

const MAX_ROLLBACK = 48;
const TARGET_LEAD_MIN = 2;
const TARGET_LEAD_MAX = 6;

/**
 * Client-side prediction of the whole world with rollback: the local car uses its own inputs,
 * the other cars repeat their last known input, and every server snapshot rewinds + replays.
 */
export class OnlineSession implements Session {
  readonly kind = 'online' as const;
  state: GameState;
  prev: GameState;
  alpha = 0;
  private hasAuth = false;
  private tick = 0;
  private authTick = -1;
  private acc = 0;
  private rate = 1;
  private lead = 0;
  private history = new Map<number, ControllerInput>();
  private unsent: number[][] = [];
  private recentSent: number[][] = [];
  private lastInput: ControllerInput | null = null;
  private maxEventTick = 0;
  private carError = new Map<number, Vec3>();
  private ballError: Vec3 = { x: 0, y: 0, z: 0 };
  private pendingSnapshot: ArrayBuffer | null = null;
  /** Debug stats: how far the local car was corrected by the last snapshots (uu) */
  readonly corrections: number[] = [];

  constructor(
    private net: NetClient,
    public localCarId: number,
    serverTick: number,
  ) {
    this.tick = serverTick + Math.round((net.rtt / 2000) * 120) + 4;
    this.state = cloneState(emptyState());
    this.prev = this.state;
    net.onSnapshot = (data) => (this.pendingSnapshot = data);
  }

  get ready() {
    return this.hasAuth;
  }

  private applySnapshot(data: ArrayBuffer) {
    const snap = decodeSnapshot(data, this.net.names);
    if (snap.tick <= this.authTick) return;
    this.authTick = snap.tick;
    this.lead = snap.inputLead;

    if (!this.hasAuth) {
      this.hasAuth = true;
      this.tick = Math.max(this.tick, snap.tick + 2);
      this.maxEventTick = this.tick;
    }
    // Inputs arriving late at the server: jump ahead
    if (this.lead < -4) this.tick += Math.min(30, -this.lead + 3);
    if (this.tick - snap.tick > MAX_ROLLBACK) this.tick = snap.tick + MAX_ROLLBACK;
    if (this.tick < snap.tick) this.tick = snap.tick;

    const old = this.state;
    const st = snap.state;
    let prev = st;
    for (let t = snap.tick + 1; t <= this.tick; t++) {
      if (t === this.tick) prev = cloneState(st);
      const mine = this.history.get(t) ?? this.lastInput;
      stepGame(st, (car) => (car.id === this.localCarId && mine ? mine : car.lastInput));
    }
    if (this.tick === snap.tick) prev = cloneState(st);

    // Visual error smoothing (render offset decays instead of snapping)
    if (old.cars.length) {
      const o = old.cars.find((x) => x.id === this.localCarId);
      const n = st.cars.find((x) => x.id === this.localCarId);
      if (o && n) {
        this.corrections.push(Math.hypot(o.pos.x - n.pos.x, o.pos.y - n.pos.y, o.pos.z - n.pos.z));
        if (this.corrections.length > 300) this.corrections.shift();
      }
      for (const c of st.cars) {
        const o = old.cars.find((x) => x.id === c.id);
        if (!o || o.demolished !== c.demolished) continue;
        const delta = vsub(o.pos, c.pos);
        if (Math.hypot(delta.x, delta.y, delta.z) > 300) continue;
        this.carError.set(c.id, vadd(this.carError.get(c.id) ?? { x: 0, y: 0, z: 0 }, delta));
      }
      const bd = vsub(old.ball.pos, st.ball.pos);
      if (Math.hypot(bd.x, bd.y, bd.z) < 400) this.ballError = vadd(this.ballError, bd);
    }
    this.state = st;
    this.prev = prev;
    for (const t of this.history.keys()) if (t <= snap.tick - 5) this.history.delete(t);

    // Clock sync: keep inputs arriving a few ticks before the server needs them
    if (this.lead < TARGET_LEAD_MIN) this.rate = 1.04;
    else if (this.lead > TARGET_LEAD_MAX + 6) this.rate = 0.94;
    else if (this.lead > TARGET_LEAD_MAX) this.rate = 0.98;
    else this.rate = 1;
  }

  frame(realDt: number, input: ControllerInput): GameEvent[] {
    if (this.pendingSnapshot) {
      const d = this.pendingSnapshot;
      this.pendingSnapshot = null;
      this.applySnapshot(d);
    }
    const events: GameEvent[] = [];
    if (!this.hasAuth) return events;

    const q = quantizeInput(input);
    this.acc += Math.min(realDt, 0.1) * this.rate;
    const steps = Math.min(12, Math.floor(this.acc / DT));
    this.acc -= steps * DT;
    for (let i = 0; i < steps; i++) {
      this.tick++;
      this.history.set(this.tick, q);
      this.lastInput = q;
      const packed = packInput(this.tick, q);
      this.unsent.push(packed);
      if (i === steps - 1) this.prev = cloneState(this.state);
      const ev = stepGame(this.state, (car) => (car.id === this.localCarId ? q : car.lastInput));
      if (this.tick > this.maxEventTick) {
        events.push(...ev);
        this.maxEventTick = this.tick;
      }
    }
    if (this.unsent.length) {
      // Redundancy: resend the last few inputs in case a packet is late
      const batch = [...this.recentSent.slice(-4), ...this.unsent];
      this.net.send({ t: 'input', inputs: batch });
      this.recentSent = [...this.recentSent, ...this.unsent].slice(-8);
      this.unsent = [];
    }
    this.alpha = this.acc / DT;

    // Decay error offsets
    const k = Math.exp(-12 * realDt);
    for (const [id, e] of this.carError) this.carError.set(id, vscale(e, k));
    this.ballError = vscale(this.ballError, k);
    return events;
  }

  /** States for rendering, with the smoothing offsets applied. */
  view(): { prev: GameState; curr: GameState } {
    const fix = (s: GameState) => {
      const c = { ...s, cars: s.cars.map((car) => ({ ...car })), ball: { ...s.ball } };
      for (const car of c.cars) {
        const e = this.carError.get(car.id);
        if (e) car.pos = vadd(car.pos, e);
      }
      c.ball.pos = vadd(c.ball.pos, this.ballError);
      return c;
    };
    return { prev: fix(this.prev), curr: fix(this.state) };
  }

  bodyOf(id: number): CarBody {
    return this.net.bodies[id] ?? 'octane';
  }

  status(): string {
    return `Sala ${this.net.room?.code ?? ''} · ${Math.round(this.net.rtt)} ms`;
  }

  dispose() {
    this.net.onSnapshot = null;
  }
}

function emptyState(): GameState {
  return {
    tick: 0, time: 0, cars: [], ball: { pos: { x: 0, y: 0, z: 93 }, vel: { x: 0, y: 0, z: 0 }, angVel: { x: 0, y: 0, z: 0 } },
    pads: [], padLocks: [], score: [0, 0], clock: 300, clockRunning: false, overtime: false, phase: 'countdown', phaseTimer: 3,
    waitingForBallGround: false, lastTouches: [], ballGoalPrediction: 0, lastGoal: null, replaySkips: [], winner: -1,
    freeplay: false, unlimitedBoost: false, rngSeed: 0,
  };
}
