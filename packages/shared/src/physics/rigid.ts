import { CAR, BALL } from '../constants.js';
import {
  qinvRotate,
  qrotate,
  vadd,
  vcross,
  vdot,
  vlen,
  vscale,
  vsub,
  type Quat,
  type Vec3,
} from '../math/vec.js';

// Box inertia of the Octane hitbox (mass 180).
const HX = CAR.HITBOX_HALF.x * 2;
const HY = CAR.HITBOX_HALF.y * 2;
const HZ = CAR.HITBOX_HALF.z * 2;
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

export interface Body {
  pos: Vec3;
  vel: Vec3;
  angVel: Vec3;
}

export interface BodyProps {
  invMass: number;
  invInertia: (v: Vec3) => Vec3;
}

/** Velocity of a point attached to a body. */
export const pointVel = (b: Body, point: Vec3): Vec3 =>
  vadd(b.vel, vcross(b.angVel, vsub(point, b.pos)));

/** Applies an impulse at a world point. */
export function applyImpulse(b: Body, p: BodyProps, point: Vec3, impulse: Vec3): void {
  const r = vsub(point, b.pos);
  b.vel = vadd(b.vel, vscale(impulse, p.invMass));
  b.angVel = vadd(b.angVel, p.invInertia(vcross(r, impulse)));
}

/** Inverse effective mass of a body for an impulse along `n` at `point`. */
export function effInvMass(b: Body, p: BodyProps, point: Vec3, n: Vec3): number {
  const r = vsub(point, b.pos);
  const rn = vcross(r, n);
  return p.invMass + vdot(n, vcross(p.invInertia(rn), r));
}

/**
 * Resolves a contact between body `a` and a static world (b = null) or a second body.
 * `n` points from b towards a. Returns the normal impulse magnitude applied.
 */
export function resolveContact(
  a: Body,
  pa: BodyProps,
  b: Body | null,
  pb: BodyProps | null,
  point: Vec3,
  n: Vec3,
  restitution: number,
  friction: number,
): number {
  const va = pointVel(a, point);
  const vb = b ? pointVel(b, point) : { x: 0, y: 0, z: 0 };
  const rel = vsub(va, vb);
  const vn = vdot(rel, n);
  if (vn >= 0) return 0;
  const k = effInvMass(a, pa, point, n) + (b && pb ? effInvMass(b, pb, point, n) : 0);
  const e = vn > -40 ? 0 : restitution;
  const jn = (-(1 + e) * vn) / k;
  applyImpulse(a, pa, point, vscale(n, jn));
  if (b && pb) applyImpulse(b, pb, point, vscale(n, -jn));

  // Coulomb friction
  const vt = vsub(rel, vscale(n, vn));
  const vtLen = vlen(vt);
  if (vtLen > 1e-6 && friction > 0) {
    const t = vscale(vt, 1 / vtLen);
    const kt = effInvMass(a, pa, point, t) + (b && pb ? effInvMass(b, pb, point, t) : 0);
    const jt = Math.min(vtLen / kt, friction * jn);
    applyImpulse(a, pa, point, vscale(t, -jt));
    if (b && pb) applyImpulse(b, pb, point, vscale(t, jt));
  }
  return jn;
}
