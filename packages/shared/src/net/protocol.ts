import type { Team } from '../constants.js';
import type { CarState, ControllerInput, GameState, MatchPhase } from '../game/state.js';

// ---------------------------------------------------------------------------
// JSON messages
// ---------------------------------------------------------------------------

export type TeamSize = 1 | 2 | 3;

/** Visual car body (all use the Octane hitbox, like in the real game). */
export type CarBody = 'octane' | 'fennec';
export const CAR_BODIES: CarBody[] = ['octane', 'fennec'];
export const validBody = (b: unknown): CarBody => (b === 'fennec' ? 'fennec' : 'octane');

export interface LobbyPlayer {
  id: number;
  name: string;
  team: Team;
  isBot: boolean;
  ping: number;
}

export interface RoomInfo {
  code: string;
  teamSize: TeamSize;
  hostId: number;
  players: LobbyPlayer[];
  status: 'lobby' | 'playing';
}

export type ClientMessage =
  | { t: 'create'; name: string; teamSize: TeamSize; body?: CarBody }
  | { t: 'join'; name: string; code: string; body?: CarBody }
  | { t: 'quick'; name: string; teamSize: TeamSize; body?: CarBody }
  | { t: 'team'; team: Team }
  | { t: 'size'; teamSize: TeamSize }
  | { t: 'start' }
  | { t: 'leave' }
  | { t: 'ping'; c: number; rtt?: number }
  | { t: 'chat'; text: string }
  /** inputs: [tick, throttle, steer, pitch, yaw, roll, buttons] */
  | { t: 'input'; inputs: number[][] };

export type ServerMessage =
  | { t: 'welcome'; playerId: number }
  | { t: 'room'; room: RoomInfo }
  | { t: 'left' }
  | { t: 'start'; carId: number; serverTick: number; names: Record<number, string>; bodies?: Record<number, CarBody> }
  | { t: 'names'; names: Record<number, string>; bodies?: Record<number, CarBody> }
  | { t: 'pong'; c: number; s: number }
  | { t: 'chat'; from: string; team: Team; text: string }
  | { t: 'error'; message: string };

export const SNAPSHOT_TAG = 1;

export function packInput(tick: number, i: ControllerInput): number[] {
  const r = (v: number) => Math.round(v * 1000) / 1000;
  const buttons = (i.jump ? 1 : 0) | (i.boost ? 2 : 0) | (i.handbrake ? 4 : 0);
  return [tick, r(i.throttle), r(i.steer), r(i.pitch), r(i.yaw), r(i.roll), buttons];
}

export function unpackInput(a: number[]): { tick: number; input: ControllerInput } {
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0);
  const b = typeof a[6] === 'number' ? a[6] : 0;
  return {
    tick: Math.floor(Number(a[0]) || 0),
    input: {
      throttle: n(a[1]),
      steer: n(a[2]),
      pitch: n(a[3]),
      yaw: n(a[4]),
      roll: n(a[5]),
      jump: (b & 1) !== 0,
      boost: (b & 2) !== 0,
      handbrake: (b & 4) !== 0,
    },
  };
}

/** Quantizes an input exactly like it travels over the network (so prediction == server). */
export function quantizeInput(i: ControllerInput): ControllerInput {
  return unpackInput(packInput(0, i)).input;
}

// ---------------------------------------------------------------------------
// Binary snapshot codec (exact float64 so client re-simulation matches the server)
// ---------------------------------------------------------------------------

const PHASES: MatchPhase[] = ['countdown', 'playing', 'goal', 'ended', 'freeplay', 'replay'];

class Writer {
  buf: ArrayBuffer;
  view: DataView;
  o = 0;
  constructor(size = 4096) {
    this.buf = new ArrayBuffer(size);
    this.view = new DataView(this.buf);
  }
  ensure(n: number) {
    if (this.o + n <= this.buf.byteLength) return;
    const nb = new ArrayBuffer(Math.max(this.buf.byteLength * 2, this.o + n));
    new Uint8Array(nb).set(new Uint8Array(this.buf));
    this.buf = nb;
    this.view = new DataView(nb);
  }
  u8(v: number) { this.ensure(1); this.view.setUint8(this.o, v); this.o += 1; }
  i8(v: number) { this.ensure(1); this.view.setInt8(this.o, v); this.o += 1; }
  u16(v: number) { this.ensure(2); this.view.setUint16(this.o, v); this.o += 2; }
  i16(v: number) { this.ensure(2); this.view.setInt16(this.o, v); this.o += 2; }
  i32(v: number) { this.ensure(4); this.view.setInt32(this.o, v); this.o += 4; }
  u32(v: number) { this.ensure(4); this.view.setUint32(this.o, v); this.o += 4; }
  f64(v: number) { this.ensure(8); this.view.setFloat64(this.o, v); this.o += 8; }
  done(): Uint8Array { return new Uint8Array(this.buf, 0, this.o); }
}

class Reader {
  view: DataView;
  o = 0;
  constructor(data: ArrayBuffer | Uint8Array) {
    this.view = data instanceof Uint8Array ? new DataView(data.buffer, data.byteOffset, data.byteLength) : new DataView(data);
  }
  u8() { return this.view.getUint8(this.o++); }
  i8() { return this.view.getInt8(this.o++); }
  u16() { const v = this.view.getUint16(this.o); this.o += 2; return v; }
  i16() { const v = this.view.getInt16(this.o); this.o += 2; return v; }
  i32() { const v = this.view.getInt32(this.o); this.o += 4; return v; }
  u32() { const v = this.view.getUint32(this.o); this.o += 4; return v; }
  f64() { const v = this.view.getFloat64(this.o); this.o += 8; return v; }
}

const CAR_FLAGS: (keyof CarState)[] = [
  'isBot', 'onGround', 'hasJumped', 'isJumping', 'hasDoubleJumped', 'hasFlipped',
  'isFlipping', 'isSupersonic', 'worldContact', 'demolished', 'isBoosting', 'isAutoFlipping',
];
const CAR_NUMS: (keyof CarState)[] = [
  'boost', 'jumpTime', 'flipTime', 'flipTorqueX', 'flipTorqueY', 'airTime', 'airTimeSinceJump',
  'boostingTime', 'supersonicTime', 'handbrakeAmount', 'respawnTimer', 'autoFlipTimer', 'autoFlipTorqueScale',
];

function writeVec(w: Writer, v: { x: number; y: number; z: number }) { w.f64(v.x); w.f64(v.y); w.f64(v.z); }
function readVec(r: Reader) { return { x: r.f64(), y: r.f64(), z: r.f64() }; }

/** Encodes everything in GameState except car names. `extra` is a per-recipient header. */
export function encodeSnapshot(s: GameState, inputLead: number): Uint8Array {
  const w = new Writer();
  w.u8(SNAPSHOT_TAG);
  w.u32(s.tick);
  w.i16(Math.max(-32000, Math.min(32000, inputLead)));
  w.f64(s.time);
  // match
  w.u8(PHASES.indexOf(s.phase));
  w.f64(s.phaseTimer);
  w.f64(s.clock);
  w.u8((s.clockRunning ? 1 : 0) | (s.overtime ? 2 : 0) | (s.waitingForBallGround ? 4 : 0) | (s.freeplay ? 8 : 0) | (s.unlimitedBoost ? 16 : 0));
  w.u8(s.score[0]);
  w.u8(s.score[1]);
  w.i8(s.winner);
  w.i8(s.ballGoalPrediction);
  w.i32(s.rngSeed);
  w.u8(s.lastTouches.length);
  for (const t of s.lastTouches) { w.u16(t.carId); w.u8(t.team); w.f64(t.time); }
  if (s.lastGoal) {
    w.u8(1); w.u8(s.lastGoal.team); w.i16(s.lastGoal.scorerId); w.i16(s.lastGoal.assistId); w.f64(s.lastGoal.speed);
  } else w.u8(0);
  w.u8(s.replaySkips.length);
  for (const id of s.replaySkips) w.u16(id);
  // ball
  writeVec(w, s.ball.pos); writeVec(w, s.ball.vel); writeVec(w, s.ball.angVel);
  // pads
  w.u8(s.pads.length);
  for (const p of s.pads) w.f64(p);
  for (const p of s.padLocks) w.i16(p);
  // cars
  w.u8(s.cars.length);
  for (const c of s.cars) {
    w.u16(c.id);
    w.u8(c.team);
    let flags = 0;
    CAR_FLAGS.forEach((k, i) => { if (c[k]) flags |= 1 << i; });
    w.u16(flags);
    writeVec(w, c.pos);
    w.f64(c.quat.x); w.f64(c.quat.y); w.f64(c.quat.z); w.f64(c.quat.w);
    writeVec(w, c.vel);
    writeVec(w, c.angVel);
    for (const k of CAR_NUMS) w.f64(c[k] as number);
    writeVec(w, c.worldContactNormal);
    w.u8(c.wheelContacts);
    for (let k = 0; k < 4; k++) w.f64(c.wheelSusp[k] ?? 0);
    w.i32(c.lastBallTouchTick);
    w.i32(c.ballImpulseTick);
    const li = c.lastInput;
    w.f64(li.throttle); w.f64(li.steer); w.f64(li.pitch); w.f64(li.yaw); w.f64(li.roll);
    w.u8((li.jump ? 1 : 0) | (li.boost ? 2 : 0) | (li.handbrake ? 4 : 0));
    const cds = Object.entries(c.bumpCooldowns);
    w.u8(cds.length);
    for (const [id, t] of cds) { w.u16(Number(id)); w.f64(t); }
    const st = c.stats;
    for (const v of [st.score, st.goals, st.assists, st.saves, st.shots, st.demos, st.touches]) w.u16(Math.min(65535, v));
  }
  return w.done();
}

export interface DecodedSnapshot {
  tick: number;
  inputLead: number;
  state: GameState;
}

export function decodeSnapshot(data: ArrayBuffer | Uint8Array, names: Record<number, string>): DecodedSnapshot {
  const r = new Reader(data);
  if (r.u8() !== SNAPSHOT_TAG) throw new Error('not a snapshot');
  const tick = r.u32();
  const inputLead = r.i16();
  const time = r.f64();
  const phase = PHASES[r.u8()] ?? 'playing';
  const phaseTimer = r.f64();
  const clock = r.f64();
  const fl = r.u8();
  const score: [number, number] = [r.u8(), r.u8()];
  const winner = r.i8() as Team | -1;
  const ballGoalPrediction = r.i8();
  const rngSeed = r.i32();
  const nt = r.u8();
  const lastTouches = [];
  for (let i = 0; i < nt; i++) lastTouches.push({ carId: r.u16(), team: r.u8() as Team, time: r.f64() });
  let lastGoal: GameState['lastGoal'] = null;
  if (r.u8()) lastGoal = { team: r.u8() as Team, scorerId: r.i16(), assistId: r.i16(), speed: r.f64() };
  const replaySkips: number[] = [];
  for (let i = r.u8(); i > 0; i--) replaySkips.push(r.u16());
  const ball = { pos: readVec(r), vel: readVec(r), angVel: readVec(r) };
  const np = r.u8();
  const pads: number[] = [];
  for (let i = 0; i < np; i++) pads.push(r.f64());
  const padLocks: number[] = [];
  for (let i = 0; i < np; i++) padLocks.push(r.i16());
  const nc = r.u8();
  const cars: CarState[] = [];
  for (let i = 0; i < nc; i++) {
    const id = r.u16();
    const team = r.u8() as Team;
    const flags = r.u16();
    const pos = readVec(r);
    const quat = { x: r.f64(), y: r.f64(), z: r.f64(), w: r.f64() };
    const vel = readVec(r);
    const angVel = readVec(r);
    const nums: Record<string, number> = {};
    for (const k of CAR_NUMS) nums[k as string] = r.f64();
    const worldContactNormal = readVec(r);
    const wheelContacts = r.u8();
    const wheelSusp = [r.f64(), r.f64(), r.f64(), r.f64()];
    const lastBallTouchTick = r.i32();
    const ballImpulseTick = r.i32();
    const lastInput: ControllerInput = {
      throttle: r.f64(), steer: r.f64(), pitch: r.f64(), yaw: r.f64(), roll: r.f64(),
      jump: false, boost: false, handbrake: false,
    };
    const b = r.u8();
    lastInput.jump = (b & 1) !== 0;
    lastInput.boost = (b & 2) !== 0;
    lastInput.handbrake = (b & 4) !== 0;
    const ncd = r.u8();
    const bumpCooldowns: Record<number, number> = {};
    for (let j = 0; j < ncd; j++) bumpCooldowns[r.u16()] = r.f64();
    const stats = { score: r.u16(), goals: r.u16(), assists: r.u16(), saves: r.u16(), shots: r.u16(), demos: r.u16(), touches: r.u16() };
    const car = {
      id, team, name: names[id] ?? `Jugador ${id}`,
      pos, quat, vel, angVel, worldContactNormal, wheelContacts, wheelSusp, lastBallTouchTick, ballImpulseTick, lastInput, bumpCooldowns, stats,
      ...nums,
    } as unknown as CarState;
    CAR_FLAGS.forEach((k, bit) => { (car as unknown as Record<string, boolean>)[k as string] = (flags & (1 << bit)) !== 0; });
    cars.push(car);
  }
  const state: GameState = {
    tick, time, cars, ball, pads, padLocks, score, clock,
    clockRunning: (fl & 1) !== 0,
    overtime: (fl & 2) !== 0,
    waitingForBallGround: (fl & 4) !== 0,
    freeplay: (fl & 8) !== 0,
    unlimitedBoost: (fl & 16) !== 0,
    phase, phaseTimer, lastTouches, ballGoalPrediction, lastGoal, replaySkips, winner, rngSeed,
  };
  return { tick, inputLead, state };
}
