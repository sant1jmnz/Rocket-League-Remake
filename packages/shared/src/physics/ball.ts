import { BALL, GRAVITY } from '../constants.js';
import { arenaDistance, arenaNormal } from '../arena/sdf.js';
import type { BallState } from '../game/state.js';
import { vaddScaled, vclampLen, vdot, vlen, v3, type Vec3 } from '../math/vec.js';
import { ballBody, makeContact, solveContacts, type Contact } from './rigid.js';

// Ball physics as in RocketSim: a Bullet sphere with linear damping, and the arena contact
// resolved as one averaged "special" contact (restitution 0.6, friction 0.35).

/** Gravity and drag (Bullet predictUnconstrainedMotion). */
export function ballApplyForces(ball: BallState, dt: number): void {
  ball.vel = vaddScaled(ball.vel, v3(0, 0, GRAVITY), dt);
  const damp = Math.pow(1 - BALL.DRAG, dt);
  ball.vel = { x: ball.vel.x * damp, y: ball.vel.y * damp, z: ball.vel.z * damp };
}

export interface BallArenaContact {
  contact: Contact;
  normal: Vec3;
  depth: number;
  /** approach speed into the surface */
  impact: number;
}

/** Contact between the ball and the arena (the ball rests at BALL.REST_Z, like the real game). */
export function ballArenaContact(ball: BallState, dt: number): BallArenaContact | null {
  const d = arenaDistance(ball.pos);
  const margin = 2 + vlen(ball.vel) * dt;
  if (d >= BALL.REST_Z + margin) return null;
  const n = arenaNormal(ball.pos);
  const point = vaddScaled(ball.pos, n, -BALL.RADIUS);
  const vn = vdot(ball.vel, n);
  const sep = d - BALL.REST_Z;
  // only a real impact if the ball reaches the surface this tick
  const impact = sep <= 0 || -vn * dt > sep ? -vn : 0;
  const contact = makeContact(ballBody(ball), null, point, n, BALL.FRICTION, BALL.RESTITUTION, Math.max(0, sep));
  return { contact, normal: n, depth: -sep, impact };
}

/** Position correction out of the arena (Bullet's split impulse). */
export function ballPushOut(ball: BallState): void {
  for (let pass = 0; pass < 2; pass++) {
    const d = arenaDistance(ball.pos);
    if (d >= BALL.REST_Z - 0.01) return;
    ball.pos = vaddScaled(ball.pos, arenaNormal(ball.pos), BALL.REST_Z - d);
  }
}

export function ballFinish(ball: BallState): void {
  ball.vel = vclampLen(ball.vel, BALL.MAX_SPEED);
  ball.angVel = vclampLen(ball.angVel, BALL.MAX_ANG_SPEED);
}

/** Steps the ball alone for one tick (no cars). Returns the arena impact speed (0 = none). */
export function stepBall(ball: BallState, dt: number): number {
  ballApplyForces(ball, dt);
  const c = ballArenaContact(ball, dt);
  if (c) solveContacts([c.contact]);
  ball.pos = vaddScaled(ball.pos, ball.vel, dt);
  ballPushOut(ball);
  ballFinish(ball);
  return c ? c.impact : 0;
}

/** Predicts the ball path ignoring cars. Returns positions every `stride` ticks. */
export function predictBall(
  ball: BallState,
  seconds: number,
  dt: number,
  stride = 1,
): { pos: Vec3; vel: Vec3; t: number }[] {
  const b: BallState = {
    pos: { ...ball.pos },
    vel: { ...ball.vel },
    angVel: { ...ball.angVel },
  };
  const out: { pos: Vec3; vel: Vec3; t: number }[] = [];
  const steps = Math.round(seconds / dt);
  for (let i = 1; i <= steps; i++) {
    stepBall(b, dt);
    if (i % stride === 0) out.push({ pos: { ...b.pos }, vel: { ...b.vel }, t: i * dt });
  }
  return out;
}

