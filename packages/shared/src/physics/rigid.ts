import { BALL, CAR, DT, MATERIAL } from '../constants.js';
import {
  qinvRotate,
  qrotate,
  vcross,
  vdot,
  vlen,
  vnorm,
  vsub,
  type Quat,
  type Vec3,
} from '../math/vec.js';

// Rigid body helpers and a small sequential-impulse contact solver modelled on Bullet's
// btSequentialImpulseConstraintSolver (the engine Rocket League and RocketSim use).

// Box inertia of the Octane hitbox (mass 180). RocketSim's hitbox sizes reproduce the game's
// inertia tensor exactly.
const HX = CAR.HITBOX_SIZE.x;
const HY = CAR.HITBOX_SIZE.y;
const HZ = CAR.HITBOX_SIZE.z;
export const CAR_INV_INERTIA_LOCAL: Vec3 = {
  x: 1 / ((CAR.MASS / 12) * (HY * HY + HZ * HZ)),
  y: 1 / ((CAR.MASS / 12) * (HX * HX + HZ * HZ)),
  z: 1 / ((CAR.MASS / 12) * (HX * HX + HY * HY)),
};

export const BALL_INERTIA = 0.4 * BALL.MASS * BALL.RADIUS * BALL.RADIUS;

/** Applies the car's world-space inverse inertia tensor to a vector. */
export function carInvInertia(q: Quat, v: Vec3): Vec3 {
  const l = qinvRotate(q, v);
  return qrotate(q, {
    x: l.x * CAR_INV_INERTIA_LOCAL.x,
    y: l.y * CAR_INV_INERTIA_LOCAL.y,
    z: l.z * CAR_INV_INERTIA_LOCAL.z,
  });
}

/** A dynamic body as seen by the solver (velocities are mutated in place). */
export interface Body {
  pos: Vec3;
  vel: Vec3;
  angVel: Vec3;
  invMass: number;
  invInertia: (v: Vec3) => Vec3;
}

export function carBody(car: { pos: Vec3; vel: Vec3; angVel: Vec3; quat: Quat }): Body {
  const q = car.quat;
  return {
    pos: car.pos,
    vel: car.vel,
    angVel: car.angVel,
    invMass: 1 / CAR.MASS,
    invInertia: (v) => carInvInertia(q, v),
  };
}

export function ballBody(ball: { pos: Vec3; vel: Vec3; angVel: Vec3 }): Body {
  return {
    pos: ball.pos,
    vel: ball.vel,
    angVel: ball.angVel,
    invMass: 1 / BALL.MASS,
    invInertia: (v) => ({ x: v.x / BALL_INERTIA, y: v.y / BALL_INERTIA, z: v.z / BALL_INERTIA }),
  };
}

/** Velocity of a world point attached to a body. */
export function pointVel(b: Body, point: Vec3): Vec3 {
  const rx = point.x - b.pos.x;
  const ry = point.y - b.pos.y;
  const rz = point.z - b.pos.z;
  const w = b.angVel;
  return {
    x: b.vel.x + w.y * rz - w.z * ry,
    y: b.vel.y + w.z * rx - w.x * rz,
    z: b.vel.z + w.x * ry - w.y * rx,
  };
}

/** Applies an impulse at a world point (in place). */
export function applyImpulse(b: Body, point: Vec3, impulse: Vec3): void {
  const r = vsub(point, b.pos);
  b.vel.x += impulse.x * b.invMass;
  b.vel.y += impulse.y * b.invMass;
  b.vel.z += impulse.z * b.invMass;
  const dw = b.invInertia(vcross(r, impulse));
  b.angVel.x += dw.x;
  b.angVel.y += dw.y;
  b.angVel.z += dw.z;
}

/** Bullet's computeImpulseDenominator: inverse effective mass along `n` at `point`. */
export function effInvMass(b: Body, point: Vec3, n: Vec3): number {
  const r = vsub(point, b.pos);
  const rn = vcross(r, n);
  return b.invMass + vdot(n, vcross(b.invInertia(rn), r));
}

export interface Contact {
  a: Body;
  /** null = static world */
  b: Body | null;
  point: Vec3;
  /** unit normal pointing from b towards a */
  n: Vec3;
  friction: number;
  restitution: number;
  // solver data
  kN: number;
  target: number;
  jn: number;
  t1: Vec3;
  t2: Vec3;
  kT1: number;
  kT2: number;
  jt1: number;
  jt2: number;
}

function relVel(c: Contact): Vec3 {
  const va = pointVel(c.a, c.point);
  if (!c.b) return va;
  const vb = pointVel(c.b, c.point);
  return { x: va.x - vb.x, y: va.y - vb.y, z: va.z - vb.z };
}

function applyPair(c: Contact, dir: Vec3, j: number): void {
  if (j === 0) return;
  applyImpulse(c.a, c.point, { x: dir.x * j, y: dir.y * j, z: dir.z * j });
  if (c.b) applyImpulse(c.b, c.point, { x: -dir.x * j, y: -dir.y * j, z: -dir.z * j });
}

export function makeContact(
  a: Body,
  b: Body | null,
  point: Vec3,
  n: Vec3,
  friction: number,
  restitution: number,
  /** gap between the surfaces (> 0 = speculative contact that only stops them from crossing) */
  separation = 0,
): Contact {
  const c: Contact = {
    a,
    b,
    point,
    n,
    friction,
    restitution,
    kN: 0,
    target: 0,
    jn: 0,
    t1: n,
    t2: n,
    kT1: 0,
    kT2: 0,
    jt1: 0,
    jt2: 0,
  };
  const k = (dir: Vec3) => effInvMass(a, point, dir) + (b ? effInvMass(b, point, dir) : 0);
  c.kN = k(n);
  const rv = relVel(c);
  const vn = vdot(rv, n);
  if (separation > 0 && -vn * DT <= separation) {
    // Not touching and not reaching the surface this tick: only a limit on the approach speed
    c.target = -separation / DT;
  } else {
    // Restitution only above Bullet's velocity threshold
    c.target = vn < -MATERIAL.RESTITUTION_THRESHOLD ? -restitution * vn : 0;
  }
  // Friction directions: along the sliding velocity (Bullet's lateral friction dir), then a
  // perpendicular one.
  let t = { x: rv.x - n.x * vn, y: rv.y - n.y * vn, z: rv.z - n.z * vn };
  if (vlen(t) < 1e-6) {
    t = Math.abs(n.z) < 0.9 ? vcross(n, { x: 0, y: 0, z: 1 }) : vcross(n, { x: 1, y: 0, z: 0 });
  }
  c.t1 = vnorm(t);
  c.t2 = vcross(n, c.t1);
  c.kT1 = k(c.t1);
  c.kT2 = k(c.t2);
  return c;
}

/** Solves a set of contacts on velocities (10 iterations, like Bullet's default). */
export function solveContacts(contacts: Contact[], iterations = 10): void {
  if (contacts.length === 0) return;
  for (let it = 0; it < iterations; it++) {
    for (const c of contacts) {
      const vn = vdot(relVel(c), c.n);
      const newJ = Math.max(0, c.jn + (c.target - vn) / c.kN);
      applyPair(c, c.n, newJ - c.jn);
      c.jn = newJ;
    }
    for (const c of contacts) {
      if (c.jn <= 0 || c.friction <= 0) continue;
      const lim = c.friction * c.jn;
      const rv = relVel(c);
      const n1 = Math.max(-lim, Math.min(lim, c.jt1 - vdot(rv, c.t1) / c.kT1));
      applyPair(c, c.t1, n1 - c.jt1);
      c.jt1 = n1;
      const rv2 = relVel(c);
      const n2 = Math.max(-lim, Math.min(lim, c.jt2 - vdot(rv2, c.t2) / c.kT2));
      applyPair(c, c.t2, n2 - c.jt2);
      c.jt2 = n2;
    }
  }
}
