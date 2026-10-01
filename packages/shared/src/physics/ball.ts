import { BALL, GRAVITY } from '../constants.js';
import { arenaDistance, arenaNormal } from '../arena/sdf.js';
import type { BallState } from '../game/state.js';
import { vaddScaled, vclampLen, vscale, v3, type Vec3 } from '../math/vec.js';
import { BALL_INERTIA, resolveContact, type BodyProps } from './rigid.js';

export const BALL_PROPS: BodyProps = {
  invMass: 1 / BALL.MASS,
  invInertia: (v: Vec3) => vscale(v, 1 / BALL_INERTIA),
};

/** Integrates the ball for one tick against the arena (no cars). Returns the wall impact speed. */
export function stepBall(ball: BallState, dt: number): number {
  ball.vel = vaddScaled(ball.vel, v3(0, 0, GRAVITY), dt);
  const damp = Math.pow(1 - BALL.DRAG, dt);
  ball.vel = vscale(ball.vel, damp);

  ball.vel = vclampLen(ball.vel, BALL.MAX_SPEED);
  ball.angVel = vclampLen(ball.angVel, BALL.MAX_ANG_SPEED);
  ball.pos = vaddScaled(ball.pos, ball.vel, dt);

  let impact = 0;
  // Two passes handle corners (e.g. floor + wall at the same time)
  for (let pass = 0; pass < 2; pass++) {
    const d = arenaDistance(ball.pos);
    if (d >= BALL.RADIUS) break;
    const n = arenaNormal(ball.pos);
    ball.pos = vaddScaled(ball.pos, n, BALL.RADIUS - d);
    const contact = vaddScaled(ball.pos, n, -BALL.RADIUS);
    const before = ball.vel.x * n.x + ball.vel.y * n.y + ball.vel.z * n.z;
    resolveContact(ball, BALL_PROPS, null, null, contact, n, BALL.RESTITUTION, BALL.FRICTION);
    impact = Math.max(impact, -before);
  }
  ball.angVel = vclampLen(ball.angVel, BALL.MAX_ANG_SPEED);
  return impact;
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
