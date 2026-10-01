import { ARENA, BALL, CAR, DT, type Team } from '../constants.js';
import { predictBall } from '../physics/ball.js';
import type { CarState, ControllerInput, GameState } from '../game/state.js';
import { emptyInput } from '../game/state.js';
import {
  clamp,
  qinvRotate,
  vdist,
  vlen,
  vnorm,
  vsub,
  v3,
  type Vec3,
} from '../math/vec.js';

export type BotDifficulty = 'rookie' | 'pro' | 'allstar';

export interface BotMemory {
  difficulty: BotDifficulty;
  /** dodge state machine: 0 idle, 1 first jump held, 2 waiting, 3 flip pressed */
  dodgeStage: number;
  dodgeTimer: number;
  dodgeDirX: number;
  dodgeDirY: number;
  /** aerial state */
  aerial: boolean;
  aerialTimer: number;
  jumpHoldTimer: number;
  lastJump: boolean;
  stuckTimer: number;
  kickoffWait: number;
  reverseTimer: number;
  reverseSteer: number;
}

export const createBotMemory = (difficulty: BotDifficulty = 'pro'): BotMemory => ({
  difficulty,
  dodgeStage: 0,
  dodgeTimer: 0,
  dodgeDirX: 0,
  dodgeDirY: 0,
  aerial: false,
  aerialTimer: 0,
  jumpHoldTimer: 0,
  lastJump: false,
  stuckTimer: 0,
  kickoffWait: 0,
  reverseTimer: 0,
  reverseSteer: 0,
});

/** Data shared by all bots during one tick (ball prediction is computed once). */
export interface BotContext {
  tick: number;
  prediction: { pos: Vec3; vel: Vec3; t: number }[];
}

export function createBotContext(state: GameState): BotContext {
  return { tick: state.tick, prediction: predictBall(state.ball, 4, DT, 4) };
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
    const stale = !this.ctx || state.tick - this.ctx.tick >= 6 || state.tick < this.ctx.tick;
    const ballJumped = this.ctx && this.ctx.prediction.length > 0 && vdist(this.ctx.prediction[0].pos, state.ball.pos) > 400;
    if (stale || ballJumped) this.ctx = createBotContext(state);
  }

  input(state: GameState, car: CarState): ControllerInput {
    const mem = this.mems.get(car.id);
    if (!mem || !this.ctx) return emptyInput();
    return botInput(state, car, mem, this.ctx);
  }
}

const goalY = (team: Team) => (team === 0 ? -ARENA.HALF_LENGTH : ARENA.HALF_LENGTH);

type Role = 'attacker' | 'support' | 'goalie';

function etaToBall(car: CarState, ball: Vec3, team: Team): number {
  const d = vdist(car.pos, ball);
  const speed = vlen(car.vel);
  // Penalize cars that are on the wrong side of the ball (between ball and opponent goal)
  const attackDir = team === 0 ? 1 : -1;
  const wrongSide = (car.pos.y - ball.y) * attackDir > 0 ? 1.2 : 0;
  const local = qinvRotate(car.quat, vsub(ball, car.pos));
  const angle = Math.abs(Math.atan2(local.y, local.x));
  return d / Math.max(800, speed + 400) + wrongSide + angle * 0.35 + (car.demolished ? 99 : 0);
}

function pickRole(state: GameState, car: CarState): Role {
  const mates = state.cars.filter((c) => c.team === car.team && !c.demolished);
  if (mates.length <= 1) return 'attacker';
  const ranked = [...mates].sort(
    (a, b) => etaToBall(a, state.ball.pos, a.team) - etaToBall(b, state.ball.pos, b.team) || a.id - b.id,
  );
  const idx = ranked.findIndex((c) => c.id === car.id);
  if (idx === 0) return 'attacker';
  if (idx === ranked.length - 1) return 'goalie';
  return 'support';
}

/** Steering/throttle towards a point on the ground. */
function driveTo(
  car: CarState,
  target: Vec3,
  out: ControllerInput,
  opts: { boost: boolean; arriveSpeed?: number; maxThrottle: number },
): { angle: number; dist: number } {
  const local = qinvRotate(car.quat, vsub(target, car.pos));
  const angle = Math.atan2(local.y, local.x); // + = target on the left
  const dist = Math.hypot(local.x, local.y);
  const speed = vlen(car.vel);
  out.steer = clamp(-angle * 3, -1, 1);
  out.throttle = opts.maxThrottle;
  if (Math.abs(angle) > 2.3 && dist < 1100 && speed < 900 && car.onGround) {
    // Target behind and close: back up towards it
    out.throttle = -1;
    out.steer = clamp(-(Math.PI - Math.abs(angle)) * Math.sign(angle) * 3, -1, 1);
    return { angle, dist };
  }
  if (Math.abs(angle) > 1.9 && speed > 500 && dist > 300) out.handbrake = true;
  if (opts.arriveSpeed !== undefined && dist < 900) {
    const want = opts.arriveSpeed + (dist / 900) * (1400 - opts.arriveSpeed);
    out.throttle = speed > want + 150 ? -0.3 : speed > want ? 0 : opts.maxThrottle;
  }
  if (opts.boost && car.onGround && Math.abs(angle) < 0.25 && speed < 2250 && car.boost > 0 && dist > 900) {
    out.boost = true;
  }
  return { angle, dist };
}

/** Keeps the wheels down while in the air (and optionally faces a direction). */
function airRecovery(car: CarState, out: ControllerInput, face?: Vec3): void {
  const up = qinvRotate(car.quat, v3(0, 0, 1));
  const wl = qinvRotate(car.quat, car.angVel);
  out.roll = clamp(-up.y * 4 + wl.x * 0.35 * -1, -1, 1);
  out.pitch = clamp(-up.x * 4 + wl.y * 0.3, -1, 1);
  if (face) {
    const lf = qinvRotate(car.quat, face);
    const yawErr = Math.atan2(lf.y, lf.x);
    out.yaw = clamp(-yawErr * 3 + wl.z * 0.3, -1, 1);
  }
  out.throttle = 1;
}

/** Points the nose towards a world direction in the air (used for aerials). */
function aimNose(car: CarState, dir: Vec3, out: ControllerInput): number {
  const l = qinvRotate(car.quat, dir);
  const wl = qinvRotate(car.quat, car.angVel);
  const pitchErr = Math.atan2(l.z, l.x); // + = target above nose
  const yawErr = Math.atan2(l.y, l.x); // + = target left
  out.pitch = clamp(pitchErr * 4 + wl.y * 0.5, -1, 1);
  out.yaw = clamp(-yawErr * 4 + wl.z * 0.5, -1, 1);
  const up = qinvRotate(car.quat, v3(0, 0, 1));
  out.roll = clamp(-up.y * 2 + -wl.x * 0.3, -1, 1);
  return Math.acos(clamp(l.x / Math.max(vlen(l), 1e-6), -1, 1));
}

export function botInput(state: GameState, car: CarState, mem: BotMemory, ctx: BotContext): ControllerInput {
  if (mem.reverseTimer > 0) {
    mem.reverseTimer -= DT;
    const out = emptyInput();
    out.throttle = -1;
    out.steer = mem.reverseSteer;
    return out;
  }
  const out = botInputInner(state, car, mem, ctx);
  const speed = vlen(car.vel);
  if (car.onGround && state.phase !== 'countdown' && Math.abs(out.throttle) > 0.5 && speed < 120 && !car.demolished) {
    mem.stuckTimer += DT;
    if (mem.stuckTimer > 0.8) {
      mem.stuckTimer = 0;
      mem.reverseTimer = 0.7;
      mem.reverseSteer = out.throttle > 0 ? -out.steer || 1 : out.steer;
      if (out.throttle < 0) {
        // was already reversing: go forward instead
        mem.reverseTimer = 0;
        out.throttle = 1;
      }
    }
  } else {
    mem.stuckTimer = 0;
  }
  return out;
}

function botInputInner(state: GameState, car: CarState, mem: BotMemory, ctx: BotContext): ControllerInput {
  const out = emptyInput();
  if (car.demolished || state.phase === 'countdown') return out;

  const skill = mem.difficulty === 'rookie' ? 0 : mem.difficulty === 'pro' ? 1 : 2;
  const maxThrottle = skill === 0 ? 0.85 : 1;
  const ball = state.ball;
  const ownGoal = v3(0, goalY(car.team), 0);
  const oppGoal = v3(0, goalY(car.team === 0 ? 1 : 0), 0);
  const attackDir = car.team === 0 ? 1 : -1;

  // --------------------------------------------------- dodge in progress
  if (mem.dodgeStage > 0) {
    mem.dodgeTimer += DT;
    if (mem.dodgeStage === 1) {
      out.jump = true;
      if (mem.dodgeTimer > 0.08) {
        mem.dodgeStage = 2;
        mem.dodgeTimer = 0;
      }
    } else if (mem.dodgeStage === 2) {
      out.jump = false;
      if (mem.dodgeTimer > 0.03) {
        mem.dodgeStage = 3;
        mem.dodgeTimer = 0;
      }
    } else if (mem.dodgeStage === 3) {
      out.jump = mem.dodgeTimer < 0.05;
      out.pitch = -mem.dodgeDirX;
      out.yaw = mem.dodgeDirY;
      if (mem.dodgeTimer > 0.6 || car.onGround) mem.dodgeStage = 0;
    }
    out.throttle = 1;
    if (mem.dodgeStage === 3 && mem.dodgeTimer > 0.35 && !car.onGround) airRecovery(car, out);
    mem.lastJump = out.jump;
    return out;
  }

  const startDodge = (target: Vec3) => {
    const local = qinvRotate(car.quat, vsub(target, car.pos));
    const a = Math.atan2(local.y, local.x);
    mem.dodgeStage = 1;
    mem.dodgeTimer = 0;
    mem.dodgeDirX = Math.cos(a);
    mem.dodgeDirY = clamp(-Math.sin(a), -1, 1);
  };

  // ---------------------------------------------------------- kickoff
  const isKickoff = !state.clockRunning && state.phase === 'playing' && vlen(ball.vel) < 1 && Math.abs(ball.pos.x) < 1 && Math.abs(ball.pos.y) < 1;
  const role = pickRole(state, car);
  mem.kickoffWait = isKickoff ? mem.kickoffWait + DT : 0;
  if (isKickoff) {
    // If the teammate who should take the kickoff never goes (AFK player), take it anyway
    if (role === 'attacker' || mem.kickoffWait > 2.5) {
      const target = v3(0, -attackDir * 40, 0);
      const { dist } = driveTo(car, target, out, { boost: true, maxThrottle: 1 });
      out.boost = car.boost > 0 && car.onGround;
      if (dist < 600 + vlen(car.vel) * 0.08 && skill > 0 && car.onGround) startDodge(ball.pos);
    } else if (role === 'goalie') {
      driveTo(car, v3(0, ownGoal.y + attackDir * 300, 0), out, { boost: false, arriveSpeed: 0, maxThrottle: 1 });
    } else {
      // grab the closest corner boost
      const bx = car.pos.x < 0 ? -3072 : 3072;
      driveTo(car, v3(bx, ownGoal.y + attackDir * 1024, 0), out, { boost: false, maxThrottle: 1 });
    }
    mem.lastJump = out.jump;
    return out;
  }

  // ------------------------------------------------------------ in air
  if (!car.onGround) {
    if (mem.aerial) {
      mem.aerialTimer += DT;
      const target = interceptPoint(car, ctx, true, state.tick) ?? ball.pos;
      const dir = vnorm(vsub(target, car.pos));
      const err = aimNose(car, dir, out);
      out.boost = err < 0.5 && car.boost > 0;
      out.jump = mem.aerialTimer < 0.2;
      if (mem.aerialTimer > 3 || vdist(car.pos, ball.pos) < BALL.RADIUS + 80) mem.aerial = false;
    } else {
      airRecovery(car, out, vnorm(v3(car.vel.x, car.vel.y, 0)));
    }
    mem.lastJump = out.jump;
    return out;
  }
  mem.aerial = false;

  // ---------------------------------------------------- ground roles
  const ballToOwnGoal = vlen(vsub(ball.pos, ownGoal));
  const threatened = ctx.prediction.some((p) => p.pos.y * -attackDir > ARENA.HALF_LENGTH + BALL.RADIUS && p.t < 2.5);
  const effectiveRole: Role = threatened && role !== 'attacker' && ballToOwnGoal < 2500 ? 'attacker' : role;

  if (effectiveRole === 'attacker') {
    const intercept = interceptPoint(car, ctx, false, state.tick) ?? ball.pos;
    const shotDir = vnorm(vsub(oppGoal, intercept));
    // If the car is on the wrong side, go around towards our own post side
    const carToBall = vsub(intercept, car.pos);
    const wrongSide = carToBall.y * attackDir < -200;
    let target: Vec3;
    if (wrongSide) {
      const sideX = car.pos.x > intercept.x ? 1 : -1;
      target = v3(intercept.x + sideX * 600, intercept.y - attackDir * 900, 0);
    } else {
      // Approach from behind the ball along the shot line; the offset shrinks when close so the
      // car drives straight through the ball instead of orbiting it.
      const d = Math.hypot(carToBall.x, carToBall.y);
      const offset = (threatened ? 40 : BALL.RADIUS + 160) * clamp((d - 250) / 1100, 0, 1);
      target = v3(intercept.x - shotDir.x * offset, intercept.y - shotDir.y * offset, 0);
    }
    const { angle, dist } = driveTo(car, target, out, { boost: skill > 0, maxThrottle });

    // Jump / dodge into the ball
    const dBall = vdist(car.pos, ball.pos);
    const speed = vlen(car.vel);
    const ballH = ball.pos.z;
    if (!wrongSide && Math.abs(angle) < 0.35) {
      if (ballH < 160 && dBall < 260 + speed * 0.12 && speed > 700 && skill > 0) {
        startDodge(ball.pos);
      } else if (ballH > 230 && ballH < 520 && dBall < ballH + 250) {
        out.jump = true;
      } else if (skill === 2 && ballH > 650 && car.boost > 40 && dist < 1600 && intercept.z > 600) {
        mem.aerial = true;
        mem.aerialTimer = 0;
        out.jump = true;
      }
    }
  } else if (effectiveRole === 'support') {
    const target = v3(
      ball.pos.x * 0.5,
      ball.pos.y + (ownGoal.y - ball.pos.y) * 0.45,
      0,
    );
    // keep it inside the field
    target.y = clamp(target.y, -ARENA.HALF_LENGTH + 800, ARENA.HALF_LENGTH - 800);
    const d = driveTo(car, target, out, { boost: false, arriveSpeed: 0, maxThrottle });
    if (d.dist < 250) {
      out.throttle = 0;
      out.steer = 0;
    }
  } else {
    const target = v3(clamp(ball.pos.x * 0.25, -700, 700), ownGoal.y + attackDir * 350, 0);
    const d = driveTo(car, target, out, { boost: false, arriveSpeed: 0, maxThrottle });
    if (d.dist < 250) {
      // face the ball while waiting
      const local = qinvRotate(car.quat, vsub(ball.pos, car.pos));
      const a = Math.atan2(local.y, local.x);
      out.steer = clamp(-a * 2, -1, 1);
      out.throttle = Math.abs(a) > 0.4 ? 0.4 : 0;
    }
  }

  // Rookies hesitate
  if (skill === 0) out.boost = false;
  mem.lastJump = out.jump;
  return out;
}

/** First predicted ball position the car can reach in time. */
function interceptPoint(car: CarState, ctx: BotContext, aerial: boolean, tick: number): Vec3 | null {
  const elapsed = (tick - ctx.tick) * DT;
  const speed = vlen(car.vel);
  const reach = Math.max(1200, Math.min(CAR.MAX_SPEED, speed + (car.boost > 20 ? 900 : 300)));
  for (const p of ctx.prediction) {
    if (!aerial && p.pos.z > 300) continue;
    const d = vdist(car.pos, p.pos) - BALL.RADIUS;
    if (p.t < elapsed) continue;
    if (d / reach <= p.t - elapsed) return p.pos;
  }
  return null;
}
