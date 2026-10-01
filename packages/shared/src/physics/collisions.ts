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
} from '../constants.js';
import type { BallState, CarState } from '../game/state.js';
import {
  curve,
  qforward,
  qinvRotate,
  qrotate,
  qup,
  vadd,
  vaddScaled,
  vdot,
  vlen,
  vnorm,
  vscale,
  vsub,
  v3,
  type Vec3,
} from '../math/vec.js';
import { BALL_PROPS } from './ball.js';
import { CAR_PROPS, hitboxCenter } from './car.js';
import { resolveContact } from './rigid.js';

const H = CAR.HITBOX_HALF;

export interface BallHit {
  carId: number;
  /** relative speed at contact */
  strength: number;
  /** first tick of this touch (not a continuous dribble contact) */
  fresh: boolean;
}

/** Closest point on the car hitbox to a world point, plus the hitbox-local data. */
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
    return {
      point: vadd(c, qrotate(car.quat, local)),
      normal: qrotate(car.quat, vscale(d, 1 / dist)),
      dist,
    };
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
  return {
    point: vadd(c, qrotate(car.quat, local)),
    normal: qrotate(car.quat, n),
    dist: -Math.min(fx, fy, fz),
  };
}

export function collideCarBall(car: CarState, ball: BallState, tick: number): BallHit | null {
  if (car.demolished) return null;
  // Broad phase
  if (vlen(vsub(ball.pos, car.pos)) > BALL.RADIUS + 120) return null;
  const hit = closestOnHitbox(car, ball.pos);
  if (hit.dist >= BALL.RADIUS) return null;

  const relVelBefore = vsub(ball.vel, car.vel);
  const fresh = car.lastBallTouchTick !== tick - 1;
  car.lastBallTouchTick = tick;

  // Separate (the ball is much lighter, so it takes most of the correction)
  const pen = BALL.RADIUS - hit.dist;
  ball.pos = vaddScaled(ball.pos, hit.normal, pen * 0.9);
  car.pos = vaddScaled(car.pos, hit.normal, -pen * 0.1);

  // Physical impulse (car-ball friction is high in RL)
  resolveContact(ball, BALL_PROPS, car, CAR_PROPS(car), hit.point, hit.normal, 0, 2);

  // Psyonix extra impulse (only on the first tick of a touch)
  if (fresh) {
    const relSpeed = Math.min(vlen(relVelBefore), BALL_HIT_MAX_REL_SPEED);
    if (relSpeed > 0) {
      const fwd = qforward(car.quat);
      let dir = vsub(ball.pos, car.pos);
      dir = vnorm(v3(dir.x, dir.y, dir.z * BALL_HIT_Z_SCALE));
      dir = vnorm(vsub(dir, vscale(fwd, vdot(dir, fwd) * (1 - BALL_HIT_FORWARD_SCALE))));
      ball.vel = vaddScaled(ball.vel, dir, relSpeed * curve(BALL_HIT_SCALE, relSpeed));
    }
  }
  return { carId: car.id, strength: vlen(relVelBefore), fresh };
}

// ---------------------------------------------------------------------------
// Car vs car
// ---------------------------------------------------------------------------

const BOX_POINTS: Vec3[] = (() => {
  const pts: Vec3[] = [];
  for (const sx of [-1, 0, 1])
    for (const sy of [-1, 0, 1])
      for (const sz of [-1, 1]) pts.push(v3(sx * H.x, sy * H.y, sz * H.z));
  return pts;
})();

interface BoxContact {
  point: Vec3;
  /** normal pointing from `other` towards `self` */
  normal: Vec3;
  depth: number;
}

/** Deepest point of box A inside box B. */
function pointsInside(a: CarState, b: CarState): BoxContact | null {
  const ca = hitboxCenter(a);
  const cb = hitboxCenter(b);
  let best: BoxContact | null = null;
  for (const lp of BOX_POINTS) {
    const wp = vadd(ca, qrotate(a.quat, lp));
    const l = qinvRotate(b.quat, vsub(wp, cb));
    const fx = H.x - Math.abs(l.x);
    const fy = H.y - Math.abs(l.y);
    const fz = H.z - Math.abs(l.z);
    if (fx <= 0 || fy <= 0 || fz <= 0) continue;
    const depth = Math.min(fx, fy, fz);
    if (best && depth <= best.depth) continue;
    const nl =
      fx === depth ? v3(Math.sign(l.x), 0, 0) : fy === depth ? v3(0, Math.sign(l.y), 0) : v3(0, 0, Math.sign(l.z));
    best = { point: wp, normal: qrotate(b.quat, nl), depth };
  }
  return best;
}

export interface CarCarResult {
  bump?: { attacker: number; victim: number };
  demo?: { attacker: number; victim: number };
}

export function collideCars(a: CarState, b: CarState): CarCarResult | null {
  if (a.demolished || b.demolished) return null;
  if (vlen(vsub(a.pos, b.pos)) > 200) return null;

  // Contact from either direction
  const ab = pointsInside(a, b);
  const ba = pointsInside(b, a);
  let contact: BoxContact | null = null;
  if (ab && (!ba || ab.depth >= ba.depth)) contact = ab;
  else if (ba) contact = { point: ba.point, normal: vscale(ba.normal, -1), depth: ba.depth };
  if (!contact) return null;

  const n = contact.normal; // from b towards a
  a.pos = vaddScaled(a.pos, n, contact.depth / 2);
  b.pos = vaddScaled(b.pos, n, -contact.depth / 2);

  const res: CarCarResult = {};
  // Bump / demo: the attacker hits the victim with its front.
  const tryBump = (att: CarState, vic: CarState, towardVictim: Vec3) => {
    const local = qinvRotate(att.quat, vsub(contact!.point, hitboxCenter(att)));
    const frontHit = local.x > H.x * 0.6;
    const approach = vdot(att.vel, towardVictim);
    if (!frontHit || approach < 100) return false;
    if ((att.bumpCooldowns[vic.id] ?? 0) > 0) return true;
    att.bumpCooldowns[vic.id] = CAR.BUMP_COOLDOWN;
    if (att.isSupersonic && att.team !== vic.team) {
      res.demo = { attacker: att.id, victim: vic.id };
      return true;
    }
    const speed = vlen(att.vel);
    const dir = vnorm(vsub(vic.pos, att.pos));
    const upDir = vic.onGround ? qup(vic.quat) : v3(0, 0, 1);
    const scale = curve(vic.onGround ? BUMP_VEL_GROUND : BUMP_VEL_AIR, speed);
    const upScale = curve(BUMP_UPWARD_VEL, speed);
    vic.vel = vadd(vic.vel, vadd(vscale(dir, scale), vscale(upDir, upScale)));
    vic.onGround = false;
    res.bump = { attacker: att.id, victim: vic.id };
    return true;
  };

  if (!tryBump(a, b, vscale(n, -1))) tryBump(b, a, n);
  if (!res.demo) resolveContact(a, CAR_PROPS(a), b, CAR_PROPS(b), contact.point, n, 0.1, 0.1);
  return res;
}

export function tickBumpCooldowns(car: CarState, dt: number): void {
  for (const k of Object.keys(car.bumpCooldowns)) {
    const id = Number(k);
    const t = car.bumpCooldowns[id] - dt;
    if (t <= 0) delete car.bumpCooldowns[id];
    else car.bumpCooldowns[id] = t;
  }
}
