import { CAR, GRAVITY } from '../constants.js';
import { arenaDistance, arenaNormal } from '../arena/sdf.js';
import type { CarState, ControllerInput } from '../game/state.js';
import {
  clamp,
  curve,
  qfromTo,
  qforward,
  qidentity,
  qintegrate,
  qinvRotate,
  qmul,
  qrotate,
  qslerp,
  qup,
  qleft,
  vadd,
  vaddScaled,
  vclampLen,
  vcross,
  vdot,
  vlen,
  vnorm,
  vreject,
  vscale,
  v3,
  type Vec3,
} from '../math/vec.js';
import { carInvInertia, resolveContact, type BodyProps } from './rigid.js';

export interface CarStepEvents {
  jumped?: boolean;
  doubleJumped?: boolean;
  flipped?: boolean;
  landed?: boolean;
  wallHit?: number;
}

const WHEEL_CONTACT_TOL = 8;
const MOVING_AWAY_SPEED = 60;
const ALIGN_RATE = 28;
const FLIP_SPIN_RATE = 40;

export const CAR_PROPS = (car: CarState): BodyProps => ({
  invMass: 1 / CAR.MASS,
  invInertia: (v: Vec3) => carInvInertia(car.quat, v),
});

/** Hitbox sample points in car-local space (corners, edge midpoints, face centers). */
const HITBOX_POINTS: Vec3[] = (() => {
  const pts: Vec3[] = [];
  const h = CAR.HITBOX_HALF;
  const o = CAR.HITBOX_OFFSET;
  for (const sx of [-1, 0, 1])
    for (const sy of [-1, 0, 1])
      for (const sz of [-1, 0, 1]) {
        if (sx === 0 && sy === 0 && sz === 0) continue;
        pts.push(v3(o.x + sx * h.x, o.y + sy * h.y, o.z + sz * h.z));
      }
  return pts;
})();
const HITBOX_BOUND = Math.hypot(CAR.HITBOX_HALF.x, CAR.HITBOX_HALF.y, CAR.HITBOX_HALF.z) + 5;

export function hitboxCenter(car: CarState): Vec3 {
  return vadd(car.pos, qrotate(car.quat, CAR.HITBOX_OFFSET));
}

export function carSpeed(car: CarState): number {
  return vlen(car.vel);
}

export function stepCar(
  car: CarState,
  rawInput: ControllerInput,
  dt: number,
  unlimitedBoost: boolean,
  frozen = false,
): CarStepEvents {
  const ev: CarStepEvents = {};
  if (car.demolished) return ev;

  const input: ControllerInput = {
    throttle: clamp(rawInput.throttle, -1, 1),
    steer: clamp(rawInput.steer, -1, 1),
    pitch: clamp(rawInput.pitch, -1, 1),
    yaw: clamp(rawInput.yaw, -1, 1),
    roll: clamp(rawInput.roll, -1, 1),
    jump: !!rawInput.jump,
    boost: !!rawInput.boost,
    handbrake: !!rawInput.handbrake,
  };
  const jumpPressed = input.jump && !car.lastInput.jump;
  car.lastInput = input;

  if (frozen) {
    // Kickoff countdown: cars cannot move, but stay glued to the floor.
    car.vel = v3();
    car.angVel = v3();
    return ev;
  }

  // ---------------------------------------------------------------- boost
  const hasBoost = unlimitedBoost || car.boost > 0;
  let boosting = false;
  if (hasBoost && (input.boost || (car.boostingTime > 0 && car.boostingTime < CAR.BOOST_MIN_TIME))) {
    boosting = true;
    car.boostingTime += dt;
    if (!unlimitedBoost) car.boost = Math.max(0, car.boost - CAR.BOOST_USE_PER_SEC * dt);
  } else {
    car.boostingTime = 0;
  }

  car.handbrakeAmount = input.handbrake
    ? Math.min(1, car.handbrakeAmount + 5 * dt)
    : Math.max(0, car.handbrakeAmount - 2 * dt);

  // ------------------------------------------------------- ground contact
  const up = qup(car.quat);
  const d0 = arenaDistance(car.pos);
  const n0 = arenaNormal(car.pos);
  let contacts = 0;
  if (d0 < CAR.REST_HEIGHT + 60 && vdot(up, n0) > 0.5) {
    for (const w of CAR.WHEELS) {
      const wp = vadd(car.pos, qrotate(car.quat, w));
      if (arenaDistance(wp) <= CAR.REST_HEIGHT + WHEEL_CONTACT_TOL) contacts++;
    }
  }
  car.wheelContacts = contacts;
  const wasOnGround = car.onGround;
  const movingAway = vdot(car.vel, n0) > MOVING_AWAY_SPEED;
  const grounded = contacts >= 3 && !car.isJumping && !movingAway;

  if (grounded && !wasOnGround) ev.landed = true;
  if (grounded) {
    car.onGround = true;
    car.airTicks = 0;
    car.hasJumped = false;
    car.hasDoubleJumped = false;
    car.hasFlipped = false;
    car.isFlipping = false;
    car.airTimeSinceJump = 0;
  } else {
    car.onGround = false;
    car.airTicks++;
  }

  // ----------------------------------------------------------------- jump
  if (car.onGround && jumpPressed) {
    car.vel = vaddScaled(car.vel, up, CAR.JUMP_IMPULSE);
    car.isJumping = true;
    car.jumpTime = 0;
    car.hasJumped = true;
    car.onGround = false;
    ev.jumped = true;
  }

  if (car.onGround) {
    groundPhysics(car, input, dt, boosting, n0, d0, wasOnGround);
  } else {
    airPhysics(car, input, dt, boosting, jumpPressed && !ev.jumped, ev);
  }

  // ---------------------------------------------------- body vs arena
  car.bodyContact = false;
  const hc = hitboxCenter(car);
  if (arenaDistance(hc) < HITBOX_BOUND) {
    let deepest = 0;
    let deepestPoint: Vec3 | null = null;
    let deepestN: Vec3 | null = null;
    for (const lp of HITBOX_POINTS) {
      const wp = vadd(car.pos, qrotate(car.quat, lp));
      const d = arenaDistance(wp);
      if (d < 0 && -d > deepest) {
        deepest = -d;
        deepestPoint = wp;
        deepestN = arenaNormal(wp);
      }
    }
    if (deepestPoint && deepestN) {
      car.bodyContact = true;
      car.pos = vaddScaled(car.pos, deepestN, deepest);
      const jn = resolveContact(
        car,
        CAR_PROPS(car),
        null,
        null,
        deepestPoint,
        deepestN,
        CAR.RESTITUTION_WORLD,
        CAR.FRICTION_WORLD,
      );
      if (jn > CAR.MASS * 300) ev.wallHit = jn / CAR.MASS;

      // Auto-flip: on the roof/side touching a surface and pressing jump
      if (jumpPressed && !car.onGround && vdot(qup(car.quat), deepestN) < 0.7071 && !ev.jumped) {
        car.vel = vaddScaled(car.vel, deepestN, 200);
        let axis = vcross(qup(car.quat), deepestN);
        if (vlen(axis) < 0.1) axis = qforward(car.quat);
        car.angVel = vscale(vnorm(axis), 7);
      }
    }
  }

  // ------------------------------------------------------ integrate
  car.vel = vclampLen(car.vel, CAR.MAX_SPEED);
  car.angVel = vclampLen(car.angVel, CAR.MAX_ANG_SPEED);
  car.pos = vaddScaled(car.pos, car.vel, dt);
  car.quat = qintegrate(car.quat, car.angVel, dt);

  // ------------------------------------------------------ supersonic
  const speed = vlen(car.vel);
  if (speed >= CAR.SUPERSONIC_START) {
    car.isSupersonic = true;
    car.supersonicTime = 0;
  } else if (car.isSupersonic && speed >= CAR.SUPERSONIC_MAINTAIN && car.supersonicTime < CAR.SUPERSONIC_MAINTAIN_TIME) {
    car.supersonicTime += dt;
  } else {
    car.isSupersonic = false;
    car.supersonicTime = 0;
  }
  return ev;
}

function groundPhysics(
  car: CarState,
  input: ControllerInput,
  dt: number,
  boosting: boolean,
  n: Vec3,
  dist: number,
  wasOnGround: boolean,
): void {
  // Follow the surface: velocity into the surface is redirected (driving through curves keeps
  // speed) or absorbed (landing).
  const vn = vdot(car.vel, n);
  if (vn < 0) {
    const vt = vreject(car.vel, n);
    const speed = vlen(car.vel);
    const tl = vlen(vt);
    if (wasOnGround && tl > 1 && -vn < 0.35 * speed) car.vel = vscale(vt, speed / tl);
    else car.vel = vt;
  }

  // Suspension: keep the car at its rest height and aligned with the surface.
  car.pos = vaddScaled(car.pos, n, (CAR.REST_HEIGHT - dist) * 0.5);
  const align = qfromTo(qup(car.quat), n);
  car.quat = qmul(qslerp(qidentity(), align, 1 - Math.exp(-ALIGN_RATE * dt)), car.quat);

  const fwd = vnorm(vreject(qforward(car.quat), n));
  const left = vcross(n, fwd);
  const vf = vdot(car.vel, fwd);
  const absVf = Math.abs(vf);

  // Throttle / brake / coast
  const throttle = boosting ? 1 : input.throttle;
  let accel = 0;
  if (Math.abs(throttle) > 0.01) {
    if (vf * throttle < 0 && absVf > 1) {
      accel = -Math.sign(vf) * Math.min(CAR.BRAKE_ACCEL, absVf / dt);
    } else {
      accel = throttle * curve(CAR.THROTTLE_CURVE, absVf);
    }
  } else if (absVf > 0) {
    accel = -Math.sign(vf) * Math.min(CAR.COAST_DECEL, absVf / dt);
  }
  if (boosting) accel += CAR.BOOST_ACCEL_GROUND;
  car.vel = vaddScaled(car.vel, fwd, accel * dt);

  // Lateral grip (powerslide lowers it)
  const grip = CAR.LATERAL_GRIP + (CAR.POWERSLIDE_GRIP - CAR.LATERAL_GRIP) * car.handbrakeAmount;
  const vl = vdot(car.vel, left);
  car.vel = vaddScaled(car.vel, left, -vl * (1 - Math.exp(-grip * dt)));

  // Steering: yaw rate follows the real curvature-vs-speed table
  const curvature = curve(CAR.STEER_CURVE, absVf);
  const slideMult = 1 + (CAR.POWERSLIDE_STEER_MULT - 1) * car.handbrakeAmount;
  const target = -input.steer * curvature * vf * slideMult;
  const wn = vdot(car.angVel, n);
  car.angVel = vscale(n, wn + (target - wn) * (1 - Math.exp(-CAR.STEER_RESPONSE * dt)));

  // Gravity along the surface; the normal part is absorbed by the wheels unless it pulls the car
  // off (ceiling / steep overhang), countered by the sticky force.
  const g = v3(0, 0, GRAVITY);
  const gn = vdot(g, n);
  car.vel = vaddScaled(car.vel, vreject(g, n), dt);
  const away = gn - CAR.STICKY_ACCEL;
  if (away > 0) car.vel = vaddScaled(car.vel, n, away * dt);

  // Full stop at very low speed without input
  if (!boosting && Math.abs(input.throttle) < 0.01) {
    const nvf = vdot(car.vel, fwd);
    if (Math.abs(nvf) < CAR.STOP_SPEED && vlen(vreject(car.vel, n)) < CAR.STOP_SPEED * 2) {
      car.vel = vscale(n, Math.max(0, vdot(car.vel, n)));
    }
  }
}

function airPhysics(
  car: CarState,
  input: ControllerInput,
  dt: number,
  boosting: boolean,
  jumpPressed: boolean,
  ev: CarStepEvents,
): void {
  const up = qup(car.quat);
  const fwd = qforward(car.quat);

  // Jump hold force
  if (car.isJumping) {
    car.jumpTime += dt;
    const holding = input.jump && car.jumpTime < CAR.JUMP_MAX_HOLD;
    if (holding || car.jumpTime < CAR.JUMP_MIN_HOLD) {
      car.vel = vaddScaled(car.vel, up, CAR.JUMP_HOLD_ACCEL * dt);
    } else {
      car.isJumping = false;
    }
  } else if (car.hasJumped) {
    car.airTimeSinceJump += dt;
  }

  // Second jump / dodge
  const canDodge =
    !car.hasDoubleJumped &&
    !car.hasFlipped &&
    (!car.hasJumped || car.airTimeSinceJump < CAR.DOUBLE_JUMP_WINDOW);
  if (jumpPressed && canDodge) {
    let dx = -input.pitch;
    let dy = input.yaw + input.roll;
    if (Math.abs(dx) < 0.1) dx = 0;
    if (Math.abs(dy) < 0.1) dy = 0;
    if (Math.abs(dx) + Math.abs(dy) >= CAR.DODGE_DEADZONE) {
      const l = Math.hypot(dx, dy);
      dx /= l;
      dy /= l;
      car.hasFlipped = true;
      car.isFlipping = true;
      car.flipTime = 0;
      car.flipDirX = dx;
      car.flipDirY = dy;
      ev.flipped = true;

      let f2 = v3(fwd.x, fwd.y, 0);
      if (vlen(f2) < 0.1) f2 = v3(car.vel.x, car.vel.y, 0);
      f2 = vlen(f2) < 0.1 ? v3(1, 0, 0) : vnorm(f2);
      const r2 = v3(f2.y, -f2.x, 0);
      const forwardSpeed = vdot(car.vel, f2);
      const ratio = Math.abs(forwardSpeed) / CAR.MAX_SPEED;
      const backwards = Math.abs(forwardSpeed) < 100 ? dx < 0 : dx >= 0 !== forwardSpeed > 0;
      let ix = dx * CAR.FLIP_INITIAL_VEL;
      let iy = dy * CAR.FLIP_INITIAL_VEL;
      ix *= (backwards ? CAR.FLIP_BACKWARD_SPEED_SCALE : CAR.FLIP_FORWARD_SPEED_SCALE) * ratio + 1;
      iy *= CAR.FLIP_SIDE_SPEED_SCALE * ratio + 1;
      if (backwards) ix *= CAR.FLIP_BACKWARD_X_SCALE;
      car.vel = vadd(car.vel, vadd(vscale(f2, ix), vscale(r2, iy)));
    } else {
      car.hasDoubleJumped = true;
      car.vel = vaddScaled(car.vel, up, CAR.JUMP_IMPULSE);
      ev.doubleJumped = true;
    }
  }

  // Gravity
  car.vel = vaddScaled(car.vel, v3(0, 0, GRAVITY), dt);

  // Flip: vertical damping + spin
  let wl = qinvRotate(car.quat, car.angVel);
  let lockPitch = false;
  let lockRoll = false;
  if (car.isFlipping) {
    car.flipTime += dt;
    if (
      car.flipTime < CAR.FLIP_Z_DAMP_END &&
      (car.vel.z < 0 || car.flipTime < CAR.FLIP_Z_DAMP_START)
    ) {
      car.vel.z *= Math.pow(1 - CAR.FLIP_Z_DAMP_120, dt * 120);
    }
    if (car.flipTime >= CAR.FLIP_TORQUE_TIME) {
      car.isFlipping = false;
    } else {
      const k = 1 - Math.exp(-FLIP_SPIN_RATE * dt);
      if (car.flipDirX !== 0) {
        // Flip cancel: pulling the stick against the flip stops the rotation
        const cancel = input.pitch * car.flipDirX > 0 ? Math.abs(input.pitch) : 0;
        const target = car.flipDirX * CAR.FLIP_PITCH_RATE * (1 - cancel);
        wl.y += (target - wl.y) * k;
        lockPitch = cancel === 0;
      }
      if (car.flipDirY !== 0) {
        const target = car.flipDirY * CAR.FLIP_ROLL_RATE;
        wl.x += (target - wl.x) * k;
        lockRoll = true;
      }
    }
  }

  // Air control (torque + damping), RL coefficients
  const T = CAR.AIR_TORQUE;
  const D = CAR.AIR_DAMP;
  const ax = lockRoll ? 0 : T.roll * input.roll - D.roll * wl.x;
  const ay = lockPitch ? 0 : -T.pitch * input.pitch - D.pitch * (1 - Math.abs(input.pitch)) * wl.y;
  const az = -T.yaw * input.yaw - D.yaw * (1 - Math.abs(input.yaw)) * wl.z;
  wl = v3(wl.x + ax * dt, wl.y + ay * dt, wl.z + az * dt);
  car.angVel = qrotate(car.quat, wl);

  // Air throttle + boost
  const throttle = boosting ? 1 : input.throttle;
  car.vel = vaddScaled(car.vel, fwd, throttle * CAR.AIR_THROTTLE_ACCEL * dt);
  if (boosting) car.vel = vaddScaled(car.vel, fwd, CAR.BOOST_ACCEL_GROUND * dt);
}

/** Car-local axes (forward, left, up) in world space. */
export function carAxes(car: CarState): { forward: Vec3; left: Vec3; up: Vec3 } {
  return { forward: qforward(car.quat), left: qleft(car.quat), up: qup(car.quat) };
}
