import {
  BALL,
  BALL_HIT_FORWARD_SCALE,
  BALL_HIT_MAX_REL_SPEED,
  BALL_HIT_SCALE,
  BALL_HIT_Z_SCALE,
  BUMP_UPWARD_VEL,
  BUMP_VEL_AIR,
  BUMP_VEL_GROUND,
  CAR,
  MATERIAL,
} from '../constants.js';
import type { BallState, CarState } from '../game/state.js';
import {
  curve,
  qforward,
  qinvRotate,
  qrotate,
  qup,
  vadd,
  vdot,
  vlen,
  vnorm,
  vscale,
  vsub,
  v3,
  type Vec3,
} from '../math/vec.js';
import { hitboxCenter } from './car.js';
import { ballBody, carBody, makeContact, type Contact } from './rigid.js';

const H = CAR.HITBOX_HALF;

// ---------------------------------------------------------------------------
// Car vs ball (RocketSim Ball::_OnHit)
// ---------------------------------------------------------------------------

export interface CarBallContact {
  contact: Contact;
  normal: Vec3;
  depth: number;
  /** relative speed at contact */
  strength: number;
  /** contact point on the car, in car space */
  localPoint: Vec3;
}

/** Closest point on the car hitbox to a world point. */
function closestOnHitbox(car: CarState, p: Vec3): { point: Vec3; normal: Vec3; dist: number } {
  const c = hitboxCenter(car);
  const l = qinvRotate(car.quat, vsub(p, c));
  const cx = Math.max(-H.x, Math.min(H.x, l.x));
  const cy = Math.max(-H.y, Math.min(H.y, l.y));
  const cz = Math.max(-H.z, Math.min(H.z, l.z));
  const inside = cx === l.x && cy === l.y && cz === l.z;
  if (!inside) {
    const local = v3(cx, cy, cz);
    const d = vsub(l, local);
    const dist = vlen(d);
    return { point: vadd(c, qrotate(car.quat, local)), normal: qrotate(car.quat, vscale(d, 1 / dist)), dist };
  }
  // Center inside the box: push out through the nearest face
  const fx = H.x - Math.abs(l.x);
  const fy = H.y - Math.abs(l.y);
  const fz = H.z - Math.abs(l.z);
  let n: Vec3;
  let local: Vec3;
  if (fx <= fy && fx <= fz) {
    n = v3(Math.sign(l.x) || 1, 0, 0);
    local = v3(n.x * H.x, l.y, l.z);
  } else if (fy <= fz) {
    n = v3(0, Math.sign(l.y) || 1, 0);
    local = v3(l.x, n.y * H.y, l.z);
  } else {
    n = v3(0, 0, Math.sign(l.z) || 1);
    local = v3(l.x, l.y, n.z * H.z);
  }
  return { point: vadd(c, qrotate(car.quat, local)), normal: qrotate(car.quat, n), dist: -Math.min(fx, fy, fz) };
}

/** Detects a car-ball contact. `normal` points from the car towards the ball. */
export function carBallContact(car: CarState, ball: BallState, margin = 0): CarBallContact | null {
  if (car.demolished) return null;
  if (vlen(vsub(ball.pos, car.pos)) > BALL.RADIUS + 130 + margin) return null;
  const hit = closestOnHitbox(car, ball.pos);
  if (hit.dist >= BALL.RADIUS + margin) return null;
  const contact = makeContact(
    ballBody(ball),
    carBody(car),
    hit.point,
    hit.normal,
    MATERIAL.CAR_BALL.friction,
    MATERIAL.CAR_BALL.restitution,
    Math.max(0, hit.dist - BALL.RADIUS),
  );
  return {
    contact,
    normal: hit.normal,
    depth: BALL.RADIUS - hit.dist,
    strength: vlen(vsub(ball.vel, car.vel)),
    localPoint: qinvRotate(car.quat, vsub(hit.point, car.pos)),
  };
}

/**
 * Psyonix's extra hit impulse (at most every other tick while touching). Returns the velocity
 * to add to the ball at the end of the tick.
 */
export function ballHitExtraImpulse(car: CarState, ball: BallState, tick: number): Vec3 | null {
  if (!(tick > car.ballImpulseTick + 1 || car.ballImpulseTick > tick)) return null;
  const fwd = qforward(car.quat);
  const relPos = vsub(ball.pos, car.pos);
  const relSpeed = Math.min(vlen(vsub(ball.vel, car.vel)), BALL_HIT_MAX_REL_SPEED);
  if (relSpeed <= 0) return v3();
  let dir = vnorm(v3(relPos.x, relPos.y, relPos.z * BALL_HIT_Z_SCALE));
  dir = vnorm(vsub(dir, vscale(fwd, vdot(dir, fwd) * (1 - BALL_HIT_FORWARD_SCALE))));
  return vscale(dir, relSpeed * curve(BALL_HIT_SCALE, relSpeed));
}

// ---------------------------------------------------------------------------
// Car vs car (box-box contact points + RocketSim bump/demo rules)
// ---------------------------------------------------------------------------

const BOX_POINTS: Vec3[] = (() => {
  const pts: Vec3[] = [];
  for (const sx of [-1, 0, 1])
    for (const sy of [-1, 0, 1])
      for (const sz of [-1, 0, 1]) {
        if (sx === 0 && sy === 0 && sz === 0) continue;
        pts.push(v3(sx * H.x, sy * H.y, sz * H.z));
      }
  return pts;
})();

export interface BoxContact {
  point: Vec3;
  /** normal pointing from `b` towards `a` */
  normal: Vec3;
  depth: number;
}

/** Points of box A inside box B. */
function pointsInside(a: CarState, b: CarState, flip: boolean, out: BoxContact[]): void {
  const ca = hitboxCenter(a);
  const cb = hitboxCenter(b);
  for (const lp of BOX_POINTS) {
    const wp = vadd(ca, qrotate(a.quat, lp));
    const l = qinvRotate(b.quat, vsub(wp, cb));
    const fx = H.x - Math.abs(l.x);
    const fy = H.y - Math.abs(l.y);
    const fz = H.z - Math.abs(l.z);
    if (fx <= 0 || fy <= 0 || fz <= 0) continue;
    const depth = Math.min(fx, fy, fz);
    const nl =
      fx === depth ? v3(Math.sign(l.x), 0, 0) : fy === depth ? v3(0, Math.sign(l.y), 0) : v3(0, 0, Math.sign(l.z));
    let normal = qrotate(b.quat, nl); // out of B, towards A
    if (flip) normal = vscale(normal, -1);
    out.push({ point: wp, normal, depth });
  }
}

/** All contact points between two cars (normals from b towards a), deepest first. */
export function carCarContacts(a: CarState, b: CarState): BoxContact[] {
  if (a.demolished || b.demolished) return [];
  if (vlen(vsub(hitboxCenter(a), hitboxCenter(b))) > 2 * Math.hypot(H.x, H.y, H.z)) return [];
  const out: BoxContact[] = [];
  pointsInside(a, b, false, out);
  pointsInside(b, a, true, out);
  out.sort((p, q) => q.depth - p.depth);
  return out.slice(0, 4);
}

export interface BumpResult {
  attacker: number;
  victim: number;
  demo: boolean;
  /** velocity added to the victim at the end of the tick */
  impulse: Vec3;
}

/** Arena::_BtCallback_OnCarCarCollision, checked both ways. */
export function carCarBump(a: CarState, b: CarState, contactPoint: Vec3): BumpResult[] {
  const res: BumpResult[] = [];
  for (const [car1, car2] of [
    [a, b],
    [b, a],
  ] as const) {
    if (car1.demolished || car2.demolished) break;
    if ((car1.bumpCooldowns[car2.id] ?? 0) > 0) continue;
    const delta = vsub(car2.pos, car1.pos);
    if (vdot(car1.vel, delta) <= 0) continue;
    const velDir = vnorm(car1.vel);
    const dirToOther = vnorm(delta);
    const speedTowards = vdot(car1.vel, dirToOther);
    const otherAway = vdot(car2.vel, velDir);
    if (speedTowards <= otherAway) continue;
    const local = qinvRotate(car1.quat, vsub(contactPoint, car1.pos));
    if (local.x <= CAR.BUMP_MIN_FORWARD_DIST) continue;
    const demo = car1.isSupersonic && car1.team !== car2.team;
    let impulse = v3();
    if (!demo) {
      const base = curve(car2.onGround ? BUMP_VEL_GROUND : BUMP_VEL_AIR, speedTowards);
      const hitUp = car2.onGround ? qup(car2.quat) : v3(0, 0, 1);
      impulse = vadd(vscale(velDir, base), vscale(hitUp, curve(BUMP_UPWARD_VEL, speedTowards)));
    }
    car1.bumpCooldowns[car2.id] = CAR.BUMP_COOLDOWN;
    res.push({ attacker: car1.id, victim: car2.id, demo, impulse });
  }
  return res;
}

export function carCarContactList(a: CarState, b: CarState, pts: BoxContact[]): Contact[] {
  const ba = carBody(a);
  const bb = carBody(b);
  return pts.map((p) =>
    makeContact(ba, bb, p.point, p.normal, MATERIAL.CAR_CAR.friction, MATERIAL.CAR_CAR.restitution),
  );
}

export function tickBumpCooldowns(car: CarState, dt: number): void {
  for (const k of Object.keys(car.bumpCooldowns)) {
    const id = Number(k);
    const t = car.bumpCooldowns[id] - dt;
    if (t <= 0) delete car.bumpCooldowns[id];
    else car.bumpCooldowns[id] = t;
  }
}
