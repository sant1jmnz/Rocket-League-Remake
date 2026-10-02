import { ARENA, BALL, BOOST_PAD, CAR, DT, GOAL, GRAVITY, type Team } from '../constants.js';
import { BOOST_PADS } from '../arena/boostpads.js';
import { predictBall } from '../physics/ball.js';
import type { CarState, ControllerInput, GameState } from '../game/state.js';
import { emptyInput } from '../game/state.js';
import {
  clamp,
  curve,
  qforward,
  qinvRotate,
  qup,
  vadd,
  vdist,
  vdot,
  vlen,
  vnorm,
  vscale,
  vsub,
  v3,
  type Vec3,
} from '../math/vec.js';

// Rule-based bots. They read the same state a player sees, plan a target from the ball
// prediction (intercept, shot direction, rotation) and press the same controls a player would:
// throttle/steer/boost/powerslide on the ground, timed single jumps and dodges for shots, and
// a boost-driven aerial controller (All-Star).

export type BotDifficulty = 'rookie' | 'pro' | 'allstar';

type Maneuver = 'none' | 'dodge' | 'jumpShot' | 'aerial';

export interface BotMemory {
  difficulty: BotDifficulty;
  maneuver: Maneuver;
  timer: number;
  /** dodge direction in car space (x forward, y right) */
  dirX: number;
  dirY: number;
  /** jump hold time for jump shots */
  hold: number;
  aerialTarget: Vec3 | null;
  aerialTime: number;
  stuckTimer: number;
  reverseTimer: number;
  reverseSteer: number;
  kickoffWait: number;
  /** reaction delay: inputs are recomputed only every few ticks for lower skills */
  thinkTimer: number;
  last: ControllerInput;
}

export const createBotMemory = (difficulty: BotDifficulty = 'pro'): BotMemory => ({
  difficulty,
  maneuver: 'none',
  timer: 0,
  dirX: 0,
  dirY: 0,
  hold: 0,
  aerialTarget: null,
  aerialTime: 0,
  stuckTimer: 0,
  reverseTimer: 0,
  reverseSteer: 0,
  kickoffWait: 0,
  thinkTimer: 0,
  last: emptyInput(),
});

/** Data shared by all bots during one tick (ball prediction is computed once). */
export interface BotContext {
  tick: number;
  prediction: { pos: Vec3; vel: Vec3; t: number }[];
  /** per-tick cache of each car's time to the ball (for roles) */
  etaTick?: number;
  etas?: Map<number, number>;
}

export function createBotContext(state: GameState): BotContext {
  return { tick: state.tick, prediction: predictBall(state.ball, 4, DT, 3) };
}

/** Drives every bot in a game; the ball prediction is refreshed every few ticks. */
export class BotController {
  private mems = new Map<number, BotMemory>();
  private ctx: BotContext | null = null;

  add(id: number, difficulty: BotDifficulty) {
    this.mems.set(id, createBotMemory(difficulty));
  }

  remove(id: number) {
    this.mems.delete(id);
  }

  has(id: number) {
    return this.mems.has(id);
  }

  get size() {
    return this.mems.size;
  }

  /** Call once per tick before asking for inputs. */
  prepare(state: GameState) {
    if (this.mems.size === 0) return;
    const ctx = this.ctx;
    const stale = !ctx || state.tick - ctx.tick >= 6 || state.tick < ctx.tick;
    let diverged = false;
    if (ctx && !stale) {
      // the ball was touched: the old prediction is useless
      const elapsed = (state.tick - ctx.tick) * DT;
      const i = ctx.prediction.findIndex((s) => s.t >= elapsed);
      const p = ctx.prediction[i];
      // compare against the path between the two surrounding samples
      if (!p) diverged = true;
      else {
        const prev = i > 0 ? ctx.prediction[i - 1] : { pos: p.pos, t: 0 };
        const k = p.t > prev.t ? (elapsed - prev.t) / (p.t - prev.t) : 1;
        const at = vadd(prev.pos, vscale(vsub(p.pos, prev.pos), k));
        diverged = vdist(at, state.ball.pos) > 40;
      }
    }
    if (stale || diverged) this.ctx = createBotContext(state);
  }

  input(state: GameState, car: CarState): ControllerInput {
    const mem = this.mems.get(car.id);
    if (!mem || !this.ctx) return emptyInput();
    return botInput(state, car, mem, this.ctx);
  }
}

// ---------------------------------------------------------------------------
// Skill profiles
// ---------------------------------------------------------------------------

interface Skill {
  level: number;
  maxThrottle: number;
  boost: boolean;
  dodge: boolean;
  jumpShots: boolean;
  aerials: boolean;
  /** ticks between decisions (reaction time) */
  think: number;
  /** extra margin added to the time the bot thinks it needs (hesitation) */
  slack: number;
  powerslide: boolean;
}

const SKILLS: Record<BotDifficulty, Skill> = {
  rookie: { level: 0, maxThrottle: 0.9, boost: true, dodge: false, jumpShots: false, aerials: false, think: 10, slack: 0.35, powerslide: false },
  pro: { level: 1, maxThrottle: 1, boost: true, dodge: true, jumpShots: true, aerials: false, think: 5, slack: 0.2, powerslide: true },
  allstar: { level: 2, maxThrottle: 1, boost: true, dodge: true, jumpShots: true, aerials: true, think: 1, slack: 0.06, powerslide: true },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const goalY = (team: Team) => (team === 0 ? -ARENA.HALF_LENGTH : ARENA.HALF_LENGTH);
const attackSign = (team: Team) => (team === 0 ? 1 : -1);

/** Angle to a target in the car's ground plane (+ = left) and the planar distance. */
function localTarget(car: CarState, target: Vec3): { angle: number; dist: number; local: Vec3 } {
  const local = qinvRotate(car.quat, vsub(target, car.pos));
  return { angle: Math.atan2(local.y, local.x), dist: Math.hypot(local.x, local.y), local };
}

/**
 * Distance a car covers in a straight line over time (1/30 s steps for 4 s), from its current
 * forward speed, with throttle and optionally its boost.
 */
function reachTable(car: CarState, useBoost: boolean, startSpeed?: number): Float64Array {
  const table = new Float64Array(REACH_STEPS + 1);
  let boost = useBoost ? car.boost : 0;
  let v = startSpeed ?? Math.max(0, vdot(car.vel, qforward(car.quat)));
  let d = 0;
  const step = 1 / 30;
  for (let i = 1; i <= REACH_STEPS; i++) {
    let a = v < 1400 ? 1600 - v * (1440 / 1400) : v < 1410 ? 160 - (v - 1400) * 16 : 0;
    if (boost > 0 && v < CAR.MAX_SPEED) {
      a += CAR.BOOST_ACCEL_GROUND;
      boost -= CAR.BOOST_USE_PER_SEC * step;
    }
    v = Math.min(CAR.MAX_SPEED, v + a * step);
    d += v * step;
    table[i] = d;
  }
  return table;
}
const REACH_STEPS = 150;

/** Time to cover `dist` according to a reach table. */
function tableTime(table: Float64Array, dist: number): number {
  if (dist <= 0) return 0;
  // binary search
  let lo = 0;
  let hi = REACH_STEPS;
  if (table[hi] < dist) return REACH_STEPS / 30 + (dist - table[hi]) / CAR.MAX_SPEED;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (table[mid] < dist) lo = mid;
    else hi = mid;
  }
  return hi / 30;
}

interface Planner {
  car: CarState;
  fwd: Float64Array;
  slow: Float64Array;
  v0: number;
}

function planner(car: CarState, useBoost: boolean): Planner {
  const v0 = Math.max(0, vdot(car.vel, qforward(car.quat)));
  return { car, v0, fwd: reachTable(car, useBoost), slow: reachTable(car, useBoost, Math.min(v0, 600)) };
}

/** Rough time for a car to reach a ground point (turning + accelerating). */
function travelTime(p: Planner, target: Vec3): number {
  const { angle, dist } = localTarget(p.car, target);
  // turning costs about the arc length at the current turn radius
  const turnSpeed = Math.max(500, Math.min(p.v0, 1400));
  const radius = 1 / curve(TURN_CURVE, turnSpeed);
  const turnTime = (Math.abs(angle) * radius) / turnSpeed + (Math.abs(angle) > 2 ? 0.35 : 0);
  const remaining = Math.max(0, dist - Math.abs(angle) * radius * 0.5);
  return turnTime + tableTime(Math.abs(angle) > 1.2 ? p.slow : p.fwd, remaining);
}

const TURN_CURVE: readonly (readonly [number, number])[] = [
  [0, 0.0069],
  [500, 0.00398],
  [1000, 0.00235],
  [1500, 0.001375],
  [1750, 0.0011],
  [2500, 0.00088],
];

interface Intercept {
  pos: Vec3;
  vel: Vec3;
  t: number;
}

/** First predicted ball position (below `maxZ`) the car can reach in time. */
function findIntercept(pl: Planner, ctx: BotContext, tick: number, skill: Skill, maxZ: number): Intercept | null {
  const elapsed = (tick - ctx.tick) * DT;
  for (const p of ctx.prediction) {
    const t = p.t - elapsed;
    if (t <= 0) continue;
    if (p.pos.z > maxZ) continue;
    const need = travelTime(pl, p.pos) - BALL.RADIUS / 1500 + skill.slack;
    if (need <= t) return { pos: p.pos, vel: p.vel, t };
  }
  return null;
}

/** Where to put the ball in the opponent goal (inside the posts, away from the far side). */
function shotTarget(team: Team, ballPos: Vec3): Vec3 {
  const gy = goalY(team === 0 ? 1 : 0);
  return v3(clamp(ballPos.x, -GOAL.HALF_WIDTH + 250, GOAL.HALF_WIDTH - 250), gy, 200);
}

/** Keeps a ground target reachable: inside the field, or inside a goal only between the posts. */
function clampTarget(p: Vec3): Vec3 {
  const x = clamp(p.x, -ARENA.HALF_WIDTH + 200, ARENA.HALF_WIDTH - 200);
  let y = clamp(p.y, -ARENA.HALF_LENGTH - 700, ARENA.HALF_LENGTH + 700);
  if (Math.abs(y) > ARENA.HALF_LENGTH - 150) {
    if (Math.abs(x) > GOAL.HALF_WIDTH - 120) y = Math.sign(y) * (ARENA.HALF_LENGTH - 150);
  }
  // keep away from the 45° corners
  const corner = Math.abs(x) + Math.abs(y) - (ARENA.CORNER_PLANE - 250);
  if (corner > 0 && Math.abs(y) < ARENA.HALF_LENGTH) {
    return v3(x - Math.sign(x) * corner * 0.5, y - Math.sign(y) * corner * 0.5, 0);
  }
  return v3(x, y, 0);
}

/** Time after pressing jump (held 0.2 s) for the car origin to rise `h` uu (0 = unreachable). */
function jumpTimeFor(h: number): number {
  if (h <= 0) return 0.05;
  const v0 = CAR.JUMP_IMPULSE;
  const a = CAR.JUMP_ACCEL + GRAVITY;
  const z1 = v0 * 0.2 + 0.5 * a * 0.04;
  if (h <= z1) return (-v0 + Math.sqrt(v0 * v0 + 2 * a * h)) / a;
  const v1 = v0 + a * 0.2;
  const g = -GRAVITY;
  const disc = v1 * v1 - 2 * g * (h - z1);
  if (disc < 0) return 0;
  return 0.2 + (v1 - Math.sqrt(disc)) / g;
}

/** Earliest high ball the car can reach with a jump + boost (RLBot-style aerial check). */
function findAerial(car: CarState, ctx: BotContext, tick: number): Intercept | null {
  if (!car.onGround || qup(car.quat).z < 0.9) return null;
  const elapsed = (tick - ctx.tick) * DT;
  const fuel = car.boost / CAR.BOOST_USE_PER_SEC;
  for (const p of ctx.prediction) {
    const T = p.t - elapsed;
    if (T < 0.5 || T > 2.8) continue;
    if (p.pos.z < 400 || p.pos.z > 1850) continue;
    if (T > fuel + 0.5) break;
    // jump gives about 500 uu/s upwards; the rest has to come from boost
    const start = vadd(car.pos, v3(0, 0, 60));
    const vel = vadd(car.vel, v3(0, 0, 450));
    const delta = vsub(p.pos, vadd(start, vscale(vel, T)));
    const need = vsub(vscale(delta, 2 / (T * T)), v3(0, 0, GRAVITY));
    const needLen = vlen(need);
    // the car must already point roughly at it (time to turn the nose in the air)
    const { angle } = localTarget(car, p.pos);
    if (needLen < 850 && Math.abs(angle) < 0.6) return { pos: p.pos, vel: p.vel, t: T };
  }
  return null;
}

interface DriveOpts {
  boost: boolean;
  /** desired speed when arriving (undefined = full speed) */
  arriveSpeed?: number;
  /** time we have to get there (undefined = asap) */
  arriveIn?: number;
  maxThrottle: number;
  powerslide: boolean;
}

/** Throttle/steer/boost/powerslide towards a point on the current driving surface. */
function driveTo(car: CarState, rawTarget: Vec3, out: ControllerInput, o: DriveOpts): { angle: number; dist: number } {
  const target = car.onGround && qup(car.quat).z > 0.6 ? clampTarget(rawTarget) : rawTarget;
  const { angle, dist } = localTarget(car, target);
  const fwdSpeed = vdot(car.vel, qforward(car.quat));
  const speed = vlen(car.vel);

  // Target behind us and close: reverse towards it (or half-flip when far)
  if (Math.abs(angle) > 2.4 && dist < 900 && fwdSpeed < 600 && car.onGround) {
    out.throttle = -1;
    out.steer = clamp((Math.PI - Math.abs(angle)) * Math.sign(angle) * 3, -1, 1);
    return { angle, dist };
  }

  out.steer = clamp(-angle * 3.2, -1, 1);
  out.throttle = o.maxThrottle;
  // Sharp turns: powerslide at speed
  if (o.powerslide && Math.abs(angle) > 1.6 && speed > 700 && car.onGround && Math.abs(angle) < 2.8) out.handbrake = true;

  // Speed control
  let want: number = CAR.MAX_SPEED;
  if (o.arriveIn !== undefined && o.arriveIn > 0) want = dist / o.arriveIn;
  if (o.arriveSpeed !== undefined) {
    const brakeDist = Math.max(0, (fwdSpeed * fwdSpeed - o.arriveSpeed * o.arriveSpeed) / (2 * 3500));
    if (dist < brakeDist + 150) want = Math.min(want, o.arriveSpeed);
  }
  if (Math.abs(angle) > 0.9) want = Math.min(want, 1200);
  if (fwdSpeed > want + 200) out.throttle = -1;
  else if (fwdSpeed > want) out.throttle = 0;
  else if (fwdSpeed < want - 100 && Math.abs(angle) < 0.3 && o.boost && car.boost > 0 && car.onGround && fwdSpeed < 2250 && dist > 500) {
    out.boost = true;
  }
  return { angle, dist };
}

/** Keeps the wheels down in the air and faces a direction for landing. */
function airRecovery(car: CarState, out: ControllerInput, face?: Vec3): void {
  const up = qinvRotate(car.quat, v3(0, 0, 1));
  const wl = qinvRotate(car.quat, car.angVel);
  // roll: bring local up's y to 0 (roll right = +)
  out.roll = clamp(-up.y * 4 - wl.x * 0.5, -1, 1);
  // pitch: bring local up's x to 0 (nose up = +)
  out.pitch = clamp(-up.x * 4 + wl.y * 0.5, -1, 1);
  if (face && vlen(face) > 0.1) {
    const lf = qinvRotate(car.quat, face);
    const yawErr = Math.atan2(lf.y, lf.x);
    out.yaw = clamp(-yawErr * 3 + wl.z * 0.5, -1, 1);
  }
  out.throttle = 1;
}

/** Points the nose along a world direction in the air; returns the angle error. */
function aimNose(car: CarState, dir: Vec3, out: ControllerInput, upHint: Vec3 = v3(0, 0, 1)): number {
  const l = qinvRotate(car.quat, dir);
  const wl = qinvRotate(car.quat, car.angVel);
  const pitchErr = Math.atan2(l.z, Math.hypot(l.x, l.y)); // + = target above the nose
  const yawErr = Math.atan2(l.y, l.x); // + = target left
  out.pitch = clamp(pitchErr * 5 + wl.y * 0.8, -1, 1);
  out.yaw = clamp(-yawErr * 5 + wl.z * 0.8, -1, 1);
  const u = qinvRotate(car.quat, upHint);
  out.roll = clamp(-u.y * 2 - wl.x * 0.4, -1, 1);
  return Math.acos(clamp(l.x / Math.max(vlen(l), 1e-6), -1, 1));
}

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

type Role = 'attacker' | 'support' | 'defender';

function onSide(car: CarState, ball: Vec3): boolean {
  // between the ball and our own goal
  return (ball.y - car.pos.y) * attackSign(car.team) > -150;
}

function eta(car: CarState, ball: Vec3): number {
  if (car.demolished) return 99;
  const t = travelTime(planner(car, true), ball);
  return t + (onSide(car, ball) ? 0 : 1.2);
}

function pickRole(state: GameState, car: CarState, ctx: BotContext): Role {
  const mates = state.cars.filter((c) => c.team === car.team && !c.demolished);
  if (mates.length <= 1) return 'attacker';
  if (ctx.etaTick !== state.tick || !ctx.etas) {
    ctx.etaTick = state.tick;
    ctx.etas = new Map();
  }
  const etas = ctx.etas;
  const etaOf = (c: CarState) => {
    let e = etas.get(c.id);
    if (e === undefined) {
      e = eta(c, state.ball.pos);
      etas.set(c.id, e);
    }
    return e;
  };
  const ranked = [...mates].sort((a, b) => etaOf(a) - etaOf(b) || a.id - b.id);
  const idx = ranked.findIndex((c) => c.id === car.id);
  if (idx === 0) return 'attacker';
  // the one furthest back defends
  const back = [...mates].sort((a, b) => (a.pos.y - b.pos.y) * attackSign(car.team) || a.id - b.id)[0];
  if (back.id === car.id || idx === ranked.length - 1) return 'defender';
  return 'support';
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export function botInput(state: GameState, car: CarState, mem: BotMemory, ctx: BotContext): ControllerInput {
  const skill = SKILLS[mem.difficulty];
  if (car.demolished || state.phase === 'countdown' || state.phase === 'goal' || state.phase === 'replay') {
    mem.maneuver = 'none';
    mem.last = emptyInput();
    return mem.last;
  }

  // Maneuvers run every tick (they need exact timing)
  if (mem.maneuver !== 'none') {
    const out = runManeuver(state, car, mem, skill, ctx);
    if (out) {
      mem.last = out;
      return out;
    }
  }

  if (mem.reverseTimer > 0) {
    mem.reverseTimer -= DT;
    const out = emptyInput();
    out.throttle = -1;
    out.steer = mem.reverseSteer;
    mem.last = out;
    return out;
  }

  // Lower skills react slower: keep the previous controls for a few ticks
  mem.thinkTimer--;
  if (mem.thinkTimer > 0 && car.onGround && mem.maneuver === 'none') {
    return { ...mem.last, jump: false };
  }
  mem.thinkTimer = skill.think;

  const out = decide(state, car, mem, skill, ctx);

  // Stuck against something: back off
  const speed = vlen(car.vel);
  if (car.onGround && out.throttle > 0.5 && speed < 100 && mem.maneuver === 'none') {
    mem.stuckTimer += DT * skill.think;
    if (mem.stuckTimer > 1) {
      mem.stuckTimer = 0;
      mem.reverseTimer = 0.6;
      mem.reverseSteer = -out.steer || 1;
    }
  } else mem.stuckTimer = 0;

  mem.last = out;
  return out;
}

function startDodge(car: CarState, mem: BotMemory, target: Vec3) {
  const { local } = localTarget(car, target);
  const a = Math.atan2(local.y, local.x);
  mem.maneuver = 'dodge';
  mem.timer = 0;
  mem.dirX = Math.cos(a);
  mem.dirY = -Math.sin(a);
}

function runManeuver(state: GameState, car: CarState, mem: BotMemory, skill: Skill, ctx: BotContext): ControllerInput | null {
  const out = emptyInput();
  mem.timer += DT;
  const t = mem.timer;
  switch (mem.maneuver) {
    case 'dodge': {
      // jump, release, then flip in the stored direction
      out.throttle = 1;
      if (t < 0.07) out.jump = true;
      else if (t < 0.1) out.jump = false;
      else if (t < 0.15) {
        out.jump = true;
        out.pitch = -mem.dirX;
        out.yaw = mem.dirY;
      } else {
        out.pitch = 0;
        if (t > 0.75) airRecovery(car, out, vnorm(v3(car.vel.x, car.vel.y, 0)));
        if (car.onGround && t > 0.2) mem.maneuver = 'none';
        if (t > 2.5) mem.maneuver = 'none';
      }
      return out;
    }
    case 'jumpShot': {
      out.throttle = 1;
      if (t < mem.hold) out.jump = true;
      else if (t < mem.hold + 0.05 || car.onGround) out.jump = false;
      const ball = state.ball.pos;
      const d = vdist(car.pos, ball);
      if (!car.onGround && t > mem.hold + 0.05 && skill.dodge && d < BALL.RADIUS + 140 && !car.hasFlipped && !car.hasDoubleJumped) {
        // dodge into the ball at the top of the jump
        const { local } = localTarget(car, ball);
        const a = Math.atan2(local.y, local.x);
        out.jump = true;
        out.pitch = -Math.cos(a);
        out.yaw = -Math.sin(a);
      }
      if (t > mem.hold + 0.1 && !out.jump) airRecovery(car, out, vnorm(v3(car.vel.x, car.vel.y, 0)));
      if ((car.onGround && t > 0.25) || t > 2.2) mem.maneuver = 'none';
      return out;
    }
    case 'aerial': {
      mem.aerialTime -= DT;
      const target = mem.aerialTarget;
      if (!target || mem.aerialTime < -0.3 || (car.onGround && t > 0.3)) {
        mem.maneuver = 'none';
        return null;
      }
      // first jump, then a second jump for extra height
      if (t < 0.2) out.jump = true;
      else if (t < 0.24) out.jump = false;
      else if (t < 0.28 && target.z > 700) out.jump = true;
      const T = Math.max(mem.aerialTime, 0.05);
      // required acceleration to reach the target in T (gravity compensated)
      const delta = vsub(target, vadd(car.pos, vscale(car.vel, T)));
      const need = vsub(vscale(delta, 2 / (T * T)), v3(0, 0, GRAVITY));
      const dir = vnorm(need);
      const err = aimNose(car, dir, out);
      out.boost = car.boost > 0 && err < 0.35 && vlen(need) > 300;
      out.throttle = 1;
      // close to the ball: dodge into it
      if (vdist(car.pos, state.ball.pos) < BALL.RADIUS + 110 && t > 0.3 && !car.hasFlipped && !car.hasDoubleJumped) {
        const l = localTarget(car, shotTarget(car.team, state.ball.pos)).local;
        const a = Math.atan2(l.y, l.x);
        out.jump = true;
        out.pitch = -Math.cos(a);
        out.yaw = -Math.sin(a);
      }
      void ctx;
      return out;
    }
  }
  return null;
}

function decide(state: GameState, car: CarState, mem: BotMemory, skill: Skill, ctx: BotContext): ControllerInput {
  const out = emptyInput();
  const ball = state.ball;
  const team = car.team;
  const sgn = attackSign(team);
  const ownGoal = v3(0, goalY(team), 0);
  const drive = (o: Partial<DriveOpts>) => ({ boost: skill.boost, maxThrottle: skill.maxThrottle, powerslide: skill.powerslide, ...o });

  // ---------------------------------------------------------------- in the air
  if (!car.onGround) {
    // land wheels-down facing where we're going; wall cars are fine
    airRecovery(car, out, vnorm(v3(car.vel.x, car.vel.y, 0)));
    return out;
  }

  // ---------------------------------------------------------------- on a wall
  if (qup(car.quat).z < 0.6) {
    // drive back down to the floor
    const below = v3(car.pos.x * 0.85, car.pos.y * 0.9, 0);
    driveTo(car, below, out, drive({ boost: false }));
    return out;
  }

  // ---------------------------------------------------------------- kickoff
  const isKickoff = !state.clockRunning && state.phase === 'playing' && vlen(ball.vel) < 1 && Math.abs(ball.pos.x) < 1 && Math.abs(ball.pos.y) < 1;
  const role = pickRole(state, car, ctx);
  mem.kickoffWait = isKickoff ? mem.kickoffWait + DT * skill.think : 0;
  if (isKickoff) {
    if (role === 'attacker' || mem.kickoffWait > 2.5) {
      // straight at the ball (slightly offset so we hit it towards the opponent)
      const target = v3(0, -sgn * 20, 0);
      const { dist } = driveTo(car, target, out, drive({ powerslide: false }));
      out.boost = skill.boost && car.boost > 0;
      out.throttle = 1;
      if (skill.dodge && dist < 520 + vlen(car.vel) * 0.12) startDodge(car, mem, ball.pos);
      if (!skill.dodge && dist < 300) out.boost = false;
    } else if (role === 'defender') {
      driveTo(car, v3(0, ownGoal.y + sgn * 250, 0), out, drive({ boost: false, arriveSpeed: 0 }));
    } else {
      // grab the nearest corner boost
      const bx = car.pos.x < 0 ? -3072 : 3072;
      driveTo(car, v3(bx, ownGoal.y + sgn * 1024, 0), out, drive({}));
    }
    return out;
  }

  // ---------------------------------------------------------------- threat
  const elapsed = (state.tick - ctx.tick) * DT;
  const intoOwnGoal = ctx.prediction.find(
    (p) => p.t > elapsed && p.pos.y * -sgn > ARENA.HALF_LENGTH && Math.abs(p.pos.x) < GOAL.HALF_WIDTH + 100,
  );

  if (role === 'attacker' || (intoOwnGoal && role === 'defender')) {
    return attack(state, car, mem, skill, ctx, out, drive, !!intoOwnGoal);
  }

  // ---------------------------------------------------------------- support / defend
  if (role === 'support') {
    // midfield between ball and own goal, grabbing boost when low
    if (car.boost < 35) {
      const pad = nearestBigPad(car, team);
      if (pad) {
        driveTo(car, pad, out, drive({ boost: false }));
        return out;
      }
    }
    const target = v3(ball.pos.x * 0.6, ball.pos.y - sgn * 2200, 0);
    target.y = clamp(target.y, -ARENA.HALF_LENGTH + 900, ARENA.HALF_LENGTH - 900);
    const { dist } = driveTo(car, target, out, drive({ boost: false, arriveSpeed: 300 }));
    if (dist < 300) faceBall(car, ball.pos, out);
    return out;
  }

  // defender: back post, facing the ball
  const postX = ball.pos.x > 0 ? -600 : 600;
  const target = v3(postX * 0.5, ownGoal.y + sgn * 400, 0);
  if (!onSide(car, ball.pos)) {
    // rotate back along the far post
    driveTo(car, v3(postX, ownGoal.y + sgn * 700, 0), out, drive({}));
    return out;
  }
  const { dist } = driveTo(car, target, out, drive({ boost: false, arriveSpeed: 0 }));
  if (dist < 300) faceBall(car, ball.pos, out);
  return out;
}

function faceBall(car: CarState, ball: Vec3, out: ControllerInput) {
  const { angle } = localTarget(car, ball);
  out.steer = clamp(-angle * 2, -1, 1);
  out.throttle = Math.abs(angle) > 0.5 ? 0.6 : 0;
  out.boost = false;
  out.handbrake = false;
}

function nearestBigPad(car: CarState, team: Team): Vec3 | null {
  let best: Vec3 | null = null;
  let bestD = Infinity;
  BOOST_PADS.forEach((p) => {
    if (!p.big) return;
    if (p.y * attackSign(team) > 100) return; // own half only
    const d = Math.hypot(p.x - car.pos.x, p.y - car.pos.y);
    if (d < bestD) {
      bestD = d;
      best = v3(p.x, p.y, 0);
    }
  });
  void BOOST_PAD;
  return best;
}

function attack(
  state: GameState,
  car: CarState,
  mem: BotMemory,
  skill: Skill,
  ctx: BotContext,
  out: ControllerInput,
  drive: (o: Partial<DriveOpts>) => DriveOpts,
  defending: boolean,
): ControllerInput {
  const ball = state.ball;
  const team = car.team;
  const sgn = attackSign(team);
  const maxZ = skill.aerials ? 1800 : skill.jumpShots ? 300 : 180;
  const pl = planner(car, skill.boost);
  const ground = findIntercept(pl, ctx, state.tick, skill, 160);
  const any = skill.aerials || skill.jumpShots ? findIntercept(pl, ctx, state.tick, skill, maxZ) : null;
  let ip: Intercept = ground ?? any ?? { pos: ball.pos, vel: ball.vel, t: 0.1 };
  if (any && ground && any.t < ground.t - 0.4) ip = any;

  // shot direction: towards the opponent goal; when defending, clear it away from our goal
  let goalTarget = shotTarget(team, ip.pos);
  if (defending || (ip.pos.y - car.pos.y) * sgn < 0) {
    // ball behind us: hit it towards the side wall, never across our own goal
    const side = ip.pos.x >= 0 ? 1 : -1;
    goalTarget = v3(side * ARENA.HALF_WIDTH, ip.pos.y + sgn * 2000, 0);
  }
  const shotDir = vnorm(v3(goalTarget.x - ip.pos.x, goalTarget.y - ip.pos.y, 0));

  // Wrong side of the ball and far from it: rotate back towards our goal first
  const carToBall = vsub(ip.pos, car.pos);
  if ((carToBall.y * sgn < -400 || !onSide(car, ip.pos)) && Math.abs(car.pos.x - ip.pos.x) < 1500 && !defending) {
    const side = car.pos.x > ip.pos.x ? 1 : -1;
    const back = v3(ip.pos.x + side * 900, ip.pos.y - sgn * 1100, 0);
    back.x = clamp(back.x, -ARENA.HALF_WIDTH + 400, ARENA.HALF_WIDTH - 400);
    back.y = clamp(back.y, -ARENA.HALF_LENGTH + 300, ARENA.HALF_LENGTH - 300);
    driveTo(car, back, out, drive({}));
    return out;
  }

  // Approach point behind the ball along the shot line; the offset shrinks as we get close
  const d2 = Math.hypot(carToBall.x, carToBall.y);
  const lineUp = clamp((d2 - 300) * 0.45, 0, 900);
  const contact = BALL.RADIUS + CAR.HITBOX_HALF.x + CAR.HITBOX_OFFSET.x - 20;
  const approach = v3(ip.pos.x - shotDir.x * (contact + lineUp), ip.pos.y - shotDir.y * (contact + lineUp), 0);
  const target = lineUp > 0 ? approach : v3(ip.pos.x, ip.pos.y, 0);
  const arriveIn = ground || any ? Math.max(ip.t, 0.05) : undefined;
  const { angle } = driveTo(car, target, out, drive({ arriveIn: lineUp > 0 ? undefined : arriveIn }));

  const distBall = vdist(car.pos, ball.pos);
  const speed = vlen(car.vel);
  const aligned = Math.abs(angle) < 0.35;
  const timeToBall = Math.max(0, distBall - BALL.RADIUS - 60) / Math.max(speed, 300);

  // Ground shot: dodge into the ball for power
  if (skill.dodge && ball.pos.z < 170 && aligned && timeToBall < 0.28 && speed > 600) {
    startDodge(car, mem, ball.pos);
    return out;
  }
  // Mid-height ball: timed jump shot (jump so the car reaches the ball's height on arrival)
  if (skill.jumpShots && ip.pos.z > 170 && ip.pos.z < 330) {
    const { angle: a, dist: dd } = localTarget(car, ip.pos);
    const jumpT = jumpTimeFor(ip.pos.z - 85);
    if (Math.abs(a) < 0.3 && jumpT > 0 && dd < contact + 120 + speed * jumpT && ip.t <= jumpT + DT * skill.think) {
      mem.maneuver = 'jumpShot';
      mem.timer = 0;
      mem.hold = 0.2;
      return out;
    }
  }
  // High ball: aerial
  if (skill.aerials && car.boost > 20 && onSide(car, ball.pos)) {
    const air = findAerial(car, ctx, state.tick);
    if (air && (!ground || air.t < ground.t - 0.3)) {
      mem.maneuver = 'aerial';
      mem.timer = 0;
      // aim a little behind the ball along the shot direction
      mem.aerialTarget = vsub(air.pos, vscale(shotDir, BALL.RADIUS * 0.5));
      mem.aerialTime = air.t;
      return out;
    }
  }
  return out;
}
