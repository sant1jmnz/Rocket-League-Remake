import { BALL, CAR, GRAVITY } from '../constants.js';
import { arenaDistance, arenaNormal } from '../arena/sdf.js';
import type { BallState, CarState, ControllerInput } from '../game/state.js';
import {
  clamp,
  curve,
  qforward,
  qinvRotate,
  qleft,
  qrotate,
  qup,
  vadd,
  vaddScaled,
  vcross,
  vdot,
  vlen,
  vnorm,
  vscale,
  vsub,
  v3,
  type Vec3,
} from '../math/vec.js';
import { applyImpulse, ballBody, carBody, effInvMass, pointVel, type Body } from './rigid.js';

// Car simulation ported from RocketSim (Car.cpp + btVehicleRL.cpp), which reproduces Rocket
// League's Bullet raycast vehicle: four suspension rays with springs, per-wheel lateral friction
// impulses, engine/brake rolling friction, sticky forces, and the game's jump/flip/air-control
// logic. Everything is in uu (Bullet's mass-scaled units cancel out).

export interface CarStepEvents {
  jumped?: boolean;
  doubleJumped?: boolean;
  flipped?: boolean;
  landed?: boolean;
  wallHit?: number;
}

/** Per-tick forces accumulated before the world step (as accelerations). */
export interface CarForces {
  /** linear acceleration (uu/s²), gravity not included */
  accel: Vec3;
  /** angular acceleration (rad/s²) */
  angAccel: Vec3;
  /** velocity added at the end of the tick (bumps) */
  velCache: Vec3;
}

export const newForces = (): CarForces => ({ accel: v3(), angAccel: v3(), velCache: v3() });

interface WheelDef {
  cs: Vec3;
  front: boolean;
  radius: number;
  rest: number;
  rayLen: number;
  pushbackThresh: number;
  forceScale: number;
}

const WHEEL_DEFS: WheelDef[] = CAR.WHEELS.map((w) => {
  const radius = w.front ? CAR.FRONT_WHEEL_RADIUS : CAR.BACK_WHEEL_RADIUS;
  const rest = (w.front ? CAR.FRONT_SUSPENSION_REST : CAR.BACK_SUSPENSION_REST) - CAR.SUSPENSION_MAX_TRAVEL;
  return {
    cs: v3(w.x, w.y, w.z),
    front: w.front,
    radius,
    rest,
    rayLen: rest + CAR.SUSPENSION_MAX_TRAVEL + radius - CAR.SUSPENSION_SUBTRACTION,
    pushbackThresh: rest + radius - CAR.SUSPENSION_SUBTRACTION,
    forceScale: w.front ? CAR.SUSPENSION_FORCE_SCALE_FRONT : CAR.SUSPENSION_FORCE_SCALE_BACK,
  };
});

/** Wheel radius / rest suspension (for the renderer). */
export const WHEEL_INFO = WHEEL_DEFS.map((w) => ({ radius: w.radius, rest: w.rest, front: w.front, cs: w.cs }));

export function hitboxCenter(car: CarState): Vec3 {
  return vadd(car.pos, qrotate(car.quat, CAR.HITBOX_OFFSET));
}

export function carSpeed(car: CarState): number {
  return vlen(car.vel);
}

/** Car-local axes (forward, left, up) in world space. */
export function carAxes(car: CarState): { forward: Vec3; left: Vec3; up: Vec3 } {
  return { forward: qforward(car.quat), left: qleft(car.quat), up: qup(car.quat) };
}

// ---------------------------------------------------------------------------
// Raycasts (suspension rays hit the arena, the ball and other cars)
// ---------------------------------------------------------------------------

interface RayHit {
  t: number;
  point: Vec3;
  normal: Vec3;
  /** null = static arena */
  body: Body | null;
}

export interface RayScene {
  ball: BallState | null;
  cars: CarState[];
}

/** Sphere-traces the arena distance field. */
export function raycastArena(o: Vec3, d: Vec3, maxT: number): { t: number; point: Vec3; normal: Vec3 } | null {
  let t = 0;
  for (let i = 0; i < 32; i++) {
    const p = vaddScaled(o, d, t);
    const dist = arenaDistance(p);
    if (dist < 0.02) {
      if (i === 0 && dist < -1) return null; // ray starts inside a wall
      return { t, point: p, normal: arenaNormal(p) };
    }
    t += dist;
    if (t > maxT) return null;
  }
  return null;
}

function raySphere(o: Vec3, d: Vec3, c: Vec3, r: number, maxT: number): number | null {
  const m = vsub(o, c);
  const b = vdot(m, d);
  const cc = vdot(m, m) - r * r;
  if (cc > 0 && b > 0) return null;
  const disc = b * b - cc;
  if (disc < 0) return null;
  const t = Math.max(0, -b - Math.sqrt(disc));
  return t <= maxT ? t : null;
}

function rayCarBox(o: Vec3, d: Vec3, car: CarState, maxT: number): { t: number; normal: Vec3 } | null {
  const c = hitboxCenter(car);
  const lo = qinvRotate(car.quat, vsub(o, c));
  const ld = qinvRotate(car.quat, d);
  const h = CAR.HITBOX_HALF;
  let tmin = 0;
  let tmax = maxT;
  let axis = -1;
  let sgn = 1;
  const comps: [number, number, number][] = [
    [lo.x, ld.x, h.x],
    [lo.y, ld.y, h.y],
    [lo.z, ld.z, h.z],
  ];
  for (let i = 0; i < 3; i++) {
    const [p, v, e] = comps[i];
    if (Math.abs(v) < 1e-9) {
      if (p < -e || p > e) return null;
      continue;
    }
    let t1 = (-e - p) / v;
    let t2 = (e - p) / v;
    let s = -1;
    if (t1 > t2) {
      [t1, t2] = [t2, t1];
      s = 1;
    }
    if (t1 > tmin) {
      tmin = t1;
      axis = i;
      sgn = s;
    }
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }
  if (axis < 0) return null; // origin inside the box
  const ln = v3(axis === 0 ? sgn : 0, axis === 1 ? sgn : 0, axis === 2 ? sgn : 0);
  return { t: tmin, normal: qrotate(car.quat, ln) };
}

function castRay(o: Vec3, d: Vec3, maxT: number, self: CarState, scene: RayScene): RayHit | null {
  let best: RayHit | null = null;
  const w = raycastArena(o, d, maxT);
  if (w) best = { t: w.t, point: w.point, normal: w.normal, body: null };
  const ball = scene.ball;
  if (ball) {
    const t = raySphere(o, d, ball.pos, BALL.RADIUS, best ? best.t : maxT);
    if (t !== null) {
      const point = vaddScaled(o, d, t);
      best = { t, point, normal: vnorm(vsub(point, ball.pos)), body: ballBody(ball) };
    }
  }
  for (const other of scene.cars) {
    if (other === self || other.demolished) continue;
    if (vlen(vsub(other.pos, o)) > maxT + 120) continue;
    const r = rayCarBox(o, d, other, best ? best.t : maxT);
    if (r) best = { t: r.t, point: vaddScaled(o, d, r.t), normal: r.normal, body: carBody(other) };
  }
  return best;
}

// ---------------------------------------------------------------------------
// Pre-tick update (RocketSim Car::_PreTickUpdate)
// ---------------------------------------------------------------------------

interface WheelState {
  hit: RayHit | null;
  hardPoint: Vec3;
  suspLen: number;
  suspRelVel: number;
  invContactDot: number;
  extraPushback: number;
}

/**
 * Runs the vehicle logic for one tick. Impulses are applied to the car velocities immediately;
 * forces go into `f` and are integrated by the world step together with gravity.
 */
export function carPreTick(
  car: CarState,
  rawInput: ControllerInput,
  dt: number,
  unlimitedBoost: boolean,
  scene: RayScene,
  f: CarForces,
): CarStepEvents {
  const ev: CarStepEvents = {};
  const controls: ControllerInput = {
    throttle: clamp(rawInput.throttle, -1, 1),
    steer: clamp(rawInput.steer, -1, 1),
    pitch: clamp(rawInput.pitch, -1, 1),
    yaw: clamp(rawInput.yaw, -1, 1),
    roll: clamp(rawInput.roll, -1, 1),
    jump: !!rawInput.jump,
    boost: !!rawInput.boost,
    handbrake: !!rawInput.handbrake,
  };
  const jumpPressed = controls.jump && !car.lastInput.jump;
  const body = carBody(car);
  const fwd = qforward(car.quat);
  const left = qleft(car.quat);
  const up = qup(car.quat);
  const down = vscale(up, -1);

  // ------------------------------------------------- suspension raycasts
  const wheels: WheelState[] = WHEEL_DEFS.map((w) => {
    const hardPoint = vadd(car.pos, qrotate(car.quat, w.cs));
    const st: WheelState = {
      hit: null,
      hardPoint,
      suspLen: w.rest + CAR.SUSPENSION_MAX_TRAVEL,
      suspRelVel: 0,
      invContactDot: 1,
      extraPushback: 0,
    };
    const hit = castRay(hardPoint, down, w.rayLen, car, scene);
    if (!hit) return st;
    st.hit = hit;
    const traceLen = vdot(vsub(hardPoint, hit.point), up);
    st.suspLen = clamp(traceLen - w.radius, w.rest - CAR.SUSPENSION_MAX_TRAVEL, w.rest + CAR.SUSPENSION_MAX_TRAVEL);
    const denom = vdot(hit.normal, up);
    const projVel = vdot(hit.normal, pointVel(body, hit.point));
    if (denom > 0.1) {
      st.suspRelVel = projVel / denom;
      st.invContactDot = 1 / denom;
    } else {
      st.suspRelVel = 0;
      st.invContactDot = 10;
    }
    if (!hit.body && traceLen < w.pushbackThresh) {
      // Bullet resolveSingleCollision (not applied, just measured): pushes a heavily compressed
      // wheel back out of the surface.
      const dist = traceLen - w.pushbackThresh;
      const relN = vdot(hit.normal, pointVel(body, hit.point));
      const k = effInvMass(body, hit.point, hit.normal);
      const j = Math.max(0, (0.2 * -dist) / dt / k - relN / k);
      st.extraPushback = j / WHEEL_DEFS.length;
    }
    return st;
  });
  let numContacts = 0;
  let worldContactWheels = false;
  for (const w of wheels) {
    if (w.hit) {
      numContacts++;
      if (!w.hit.body) worldContactWheels = true;
    }
  }
  car.wheelContacts = numContacts;
  car.wheelSusp = wheels.map((w) => w.suspLen);
  const wasOnGround = car.onGround;
  car.onGround = numContacts >= 3;
  if (car.onGround && !wasOnGround) ev.landed = true;

  const forwardSpeed = vdot(car.vel, fwd);
  const absForwardSpeed = Math.abs(forwardSpeed);
  const hasBoost = unlimitedBoost || car.boost > 0;

  // ------------------------------------------------------ wheels
  car.handbrakeAmount = clamp(
    car.handbrakeAmount + (controls.handbrake ? CAR.POWERSLIDE_RISE_RATE : -CAR.POWERSLIDE_FALL_RATE) * dt,
    0,
    1,
  );
  let realThrottle = controls.throttle;
  let realBrake = 0;
  if (controls.boost && hasBoost) realThrottle = 1;

  let driveSpeedScale = curve(CAR.DRIVE_SPEED_TORQUE_FACTOR, absForwardSpeed);
  let engineThrottle = realThrottle;
  if (!controls.handbrake) {
    if (Math.abs(realThrottle) >= CAR.THROTTLE_DEADZONE) {
      if (absForwardSpeed > CAR.STOPPING_FORWARD_VEL && Math.sign(realThrottle) !== Math.sign(forwardSpeed)) {
        // Driving against the motion: full brake, no engine
        realBrake = 1;
        if (absForwardSpeed > CAR.BRAKING_NO_THROTTLE_SPEED_THRESH) engineThrottle = 0;
      }
    } else {
      // Coasting: light brake, full stop when nearly still
      engineThrottle = 0;
      realBrake = absForwardSpeed < CAR.STOPPING_FORWARD_VEL ? 1 : CAR.COASTING_BRAKE_FACTOR;
    }
  }
  if (numContacts < 3) driveSpeedScale /= 4;
  const engineForce = engineThrottle * CAR.MASS * CAR.THROTTLE_TORQUE * driveSpeedScale;
  const brakeForce = realBrake * CAR.MASS * CAR.BRAKE_TORQUE;

  let steerAngle = curve(CAR.STEER_ANGLE, absForwardSpeed);
  if (car.handbrakeAmount > 0) {
    steerAngle += (curve(CAR.POWERSLIDE_STEER_ANGLE, absForwardSpeed) - steerAngle) * car.handbrakeAmount;
  }
  steerAngle *= controls.steer;

  // Wheel frames: front wheels are rotated by the steer angle (positive steer = turn right)
  const cs = Math.cos(steerAngle);
  const sn = Math.sin(steerAngle);
  const steeredLeft = vadd(vscale(left, cs), vscale(fwd, sn));

  const frictionScale = CAR.MASS / 3;
  const sticky = realThrottle !== 0;
  const impulses: { point: Vec3; impulse: Vec3 }[] = [];
  WHEEL_DEFS.forEach((def, i) => {
    const w = wheels[i];
    const hit = w.hit;
    if (!hit) return;
    const n = hit.normal;
    const wheelLeft = def.front ? steeredLeft : left;

    // Friction factors (Car::_UpdateWheels)
    const crossVec = pointVel(body, w.hardPoint);
    const baseFriction = Math.abs(vdot(crossVec, wheelLeft));
    const longDir0 = vcross(wheelLeft, n);
    let frictionCurveInput = 0;
    if (baseFriction > 5) frictionCurveInput = baseFriction / (Math.abs(vdot(crossVec, longDir0)) + baseFriction);
    let latFriction = curve(CAR.LAT_FRICTION, frictionCurveInput);
    let longFriction = 1;
    if (car.handbrakeAmount > 0) {
      const hb = car.handbrakeAmount;
      latFriction *= (curve(CAR.HANDBRAKE_LAT_FRICTION, frictionCurveInput) - 1) * hb + 1;
      longFriction *= (curve(CAR.HANDBRAKE_LONG_FRICTION, frictionCurveInput) - 1) * hb + 1;
    }
    if (!sticky) {
      const nonSticky = curve(CAR.NON_STICKY_FRICTION, n.z);
      latFriction *= nonSticky;
      longFriction *= nonSticky;
    }

    // Friction impulses (btVehicleRL::calcFrictionImpulses)
    let axle = vsub(wheelLeft, vscale(n, vdot(wheelLeft, n)));
    axle = vnorm(axle);
    const wheelFwd = vnorm(vcross(axle, n));
    const groundVel = hit.body ? pointVel(hit.body, hit.point) : v3();
    const contactVel = vsub(pointVel(body, hit.point), groundVel);
    const kSide = effInvMass(body, hit.point, axle) + (hit.body ? effInvMass(hit.body, hit.point, axle) : 0);
    const sideImpulse = (-0.2 * vdot(contactVel, axle)) / kSide;
    let rolling = 0;
    if (engineForce === 0) {
      if (brakeForce > 0) {
        const relV = vdot(contactVel, wheelFwd);
        rolling = clamp(-relV * CAR.ROLLING_FRICTION_SCALE, -brakeForce, brakeForce);
      }
    } else {
      rolling = engineForce / frictionScale;
    }
    const total = vadd(vscale(wheelFwd, rolling * longFriction), vscale(axle, sideImpulse * latFriction));
    // Applied at the contact point moved to the height of the center of mass
    const off = vsub(hit.point, car.pos);
    const relPos = vsub(off, vscale(up, vdot(up, off)));
    impulses.push({ point: vadd(car.pos, relPos), impulse: vscale(total, frictionScale * dt) });
  });

  // Sticky force towards the surface
  if (worldContactWheels) {
    let sum = v3();
    for (const w of wheels) if (w.hit) sum = vadd(sum, w.hit.normal);
    const upDir = vnorm(sum);
    const fullStick = realThrottle !== 0 || absForwardSpeed > CAR.STOPPING_FORWARD_VEL;
    let scale = 0.5;
    if (fullStick) scale += 1 - Math.abs(upDir.z);
    f.accel = vaddScaled(f.accel, upDir, scale * GRAVITY);
  }

  // ------------------------------------------------------ air control
  if (numContacts < 3) airTorque(car, controls, numContacts === 0, f);
  else car.isFlipping = false;

  // ------------------------------------------------------ jump
  if (car.onGround && !car.isJumping) {
    if (!(car.hasJumped && car.jumpTime < CAR.JUMP_MIN_TIME + CAR.JUMP_RESET_TIME_PAD)) {
      car.hasJumped = false;
      car.jumpTime = 0;
    }
  }
  if (car.isJumping) {
    car.isJumping = car.jumpTime < CAR.JUMP_MIN_TIME || (controls.jump && car.jumpTime < CAR.JUMP_MAX_TIME);
  } else if (car.onGround && jumpPressed) {
    car.isJumping = true;
    car.jumpTime = 0;
    car.vel = vaddScaled(car.vel, up, CAR.JUMP_IMPULSE);
    ev.jumped = true;
  }
  if (car.isJumping) {
    car.hasJumped = true;
    const k = car.jumpTime < CAR.JUMP_MIN_TIME ? CAR.JUMP_PRE_MIN_ACCEL_SCALE : 1;
    f.accel = vaddScaled(f.accel, up, CAR.JUMP_ACCEL * k);
  }
  if (car.isJumping || car.hasJumped) car.jumpTime += dt;

  // ------------------------------------------------------ auto-flip
  if (jumpPressed && car.worldContact && car.worldContactNormal.z > CAR.AUTOFLIP_NORMZ_THRESH) {
    const absRoll = Math.atan2(Math.abs(left.z), up.z);
    if (absRoll > CAR.AUTOFLIP_ROLL_THRESH) {
      car.autoFlipTimer = CAR.AUTOFLIP_TIME * (absRoll / Math.PI);
      // rotate about the forward axis in the direction that brings the roof up
      car.autoFlipTorqueScale = left.z > 0 ? -1 : 1;
      car.isAutoFlipping = true;
      car.vel = vaddScaled(car.vel, up, -CAR.AUTOFLIP_IMPULSE);
    }
  }
  if (car.isAutoFlipping) {
    if (car.autoFlipTimer <= 0) {
      car.isAutoFlipping = false;
      car.autoFlipTimer = 0;
    } else {
      car.angVel = vaddScaled(car.angVel, fwd, CAR.AUTOFLIP_TORQUE * car.autoFlipTorqueScale * dt);
      car.autoFlipTimer -= dt;
    }
  }

  // ------------------------------------------------------ double jump / flip
  doubleJumpOrFlip(car, controls, dt, jumpPressed, forwardSpeed, ev);

  // ------------------------------------------------------ auto-roll
  if (controls.throttle !== 0 && ((numContacts > 0 && numContacts < 4) || car.worldContact)) {
    let groundUp: Vec3;
    if (numContacts > 0) {
      let sum = v3();
      for (const w of wheels) if (w.hit) sum = vadd(sum, w.hit.normal);
      groundUp = vnorm(sum);
    } else groundUp = car.worldContactNormal;
    const idealLeft = vnorm(vcross(groundUp, fwd));
    const idealFwd = vcross(idealLeft, groundUp);
    const rollFactor = 1 - clamp(vdot(left, idealLeft), 0, 1);
    const pitchFactor = 1 - clamp(vdot(fwd, idealFwd), 0, 1);
    const rollTorque = vscale(fwd, (vdot(left, groundUp) >= 0 ? -1 : 1) * rollFactor);
    const pitchTorque = vscale(left, (vdot(fwd, groundUp) >= 0 ? 1 : -1) * pitchFactor);
    f.accel = vaddScaled(f.accel, groundUp, -CAR.AUTOROLL_FORCE);
    f.angAccel = vaddScaled(f.angAccel, vadd(rollTorque, pitchTorque), CAR.AUTOROLL_TORQUE);
  }
  car.worldContact = false;

  // ------------------------------------------------------ suspension
  // (the jump/flip code above may have replaced the velocity objects: rebuild the body view)
  const sb = carBody(car);
  WHEEL_DEFS.forEach((def, i) => {
    const w = wheels[i];
    if (!w.hit) return;
    let force = (def.rest - w.suspLen) * CAR.SUSPENSION_STIFFNESS * w.invContactDot;
    const damp = w.suspRelVel < 0 ? CAR.SUSPENSION_DAMP_COMPRESSION : CAR.SUSPENSION_DAMP_RELAXATION;
    force = (force - damp * w.suspRelVel) * def.forceScale;
    if (force < 0) force = 0; // RL never pulls the car down with the suspension
    const j = force * dt + w.extraPushback;
    if (j !== 0) applyImpulse(sb, w.hit.point, vscale(w.hit.normal, j));
  });
  for (const im of impulses) applyImpulse(sb, im.point, im.impulse);

  // ------------------------------------------------------ boost
  if (hasBoost) {
    if (car.isBoosting) car.isBoosting = controls.boost || car.boostingTime < CAR.BOOST_MIN_TIME;
    else car.isBoosting = controls.boost;
  } else car.isBoosting = false;
  if (car.isBoosting) car.boostingTime += dt;
  else car.boostingTime = 0;
  if (car.isBoosting) {
    if (!unlimitedBoost) car.boost = Math.max(0, car.boost - CAR.BOOST_USE_PER_SEC * dt);
    f.accel = vaddScaled(f.accel, fwd, car.onGround ? CAR.BOOST_ACCEL_GROUND : CAR.BOOST_ACCEL_AIR);
  }
  car.boost = Math.min(car.boost, CAR.BOOST_MAX);

  car.lastInput = controls;
  return ev;
}

/** Car::_UpdateAirTorque */
function airTorque(car: CarState, controls: ControllerInput, updateAirControl: boolean, f: CarForces): void {
  const fwd = qforward(car.quat);
  const left = qleft(car.quat);
  const up = qup(car.quat);
  // Rotation axes in this right-handed frame: nose up = about -left, yaw right = about -up,
  // roll right = about +forward.
  const pitchAxis = vscale(left, -1);
  const yawAxis = vscale(up, -1);
  const rollAxis = fwd;

  let doAirControl = false;
  if (car.isFlipping) car.isFlipping = car.hasFlipped && car.flipTime < CAR.FLIP_TORQUE_TIME;
  if (car.isFlipping) {
    if (car.flipTorqueX !== 0 || car.flipTorqueY !== 0) {
      // Flip cancel: pulling the stick against a front/back flip stops its rotation
      let pitchScale = 1;
      if (car.flipTorqueY !== 0 && controls.pitch !== 0 && Math.sign(car.flipTorqueY) === Math.sign(controls.pitch)) {
        pitchScale = 1 - Math.min(Math.abs(controls.pitch), 1);
        doAirControl = true;
      }
      const local = v3(car.flipTorqueX * CAR.FLIP_TORQUE_X, car.flipTorqueY * pitchScale * CAR.FLIP_TORQUE_Y, 0);
      f.angAccel = vadd(f.angAccel, qrotate(car.quat, local));
    } else {
      doAirControl = true; // stall
    }
  } else {
    doAirControl = true;
  }
  doAirControl = doAirControl && !car.isAutoFlipping && updateAirControl;

  if (doAirControl) {
    let pitchTorqueScale = 1;
    let torque = v3();
    if (controls.pitch || controls.yaw || controls.roll) {
      if (car.isFlipping) pitchTorqueScale = 0;
      else if (car.hasFlipped && car.flipTime < CAR.FLIP_TORQUE_TIME + CAR.FLIP_PITCHLOCK_EXTRA_TIME) pitchTorqueScale = 0;
      torque = vadd(
        vadd(
          vscale(pitchAxis, controls.pitch * pitchTorqueScale * CAR.AIR_TORQUE.pitch),
          vscale(yawAxis, controls.yaw * CAR.AIR_TORQUE.yaw),
        ),
        vscale(rollAxis, controls.roll * CAR.AIR_TORQUE.roll),
      );
    }
    const w = car.angVel;
    const dampPitch = vdot(pitchAxis, w) * CAR.AIR_DAMP.pitch * (1 - Math.abs(controls.pitch * pitchTorqueScale));
    const dampYaw = vdot(yawAxis, w) * CAR.AIR_DAMP.yaw * (1 - Math.abs(controls.yaw));
    const dampRoll = vdot(rollAxis, w) * CAR.AIR_DAMP.roll;
    const damping = vadd(vadd(vscale(yawAxis, dampYaw), vscale(pitchAxis, dampPitch)), vscale(rollAxis, dampRoll));
    f.angAccel = vaddScaled(f.angAccel, vsub(torque, damping), CAR.TORQUE_SCALE);
  }

  if (controls.throttle !== 0) f.accel = vaddScaled(f.accel, fwd, controls.throttle * CAR.AIR_THROTTLE_ACCEL);
}

/** Car::_UpdateDoubleJumpOrFlip */
function doubleJumpOrFlip(
  car: CarState,
  controls: ControllerInput,
  dt: number,
  jumpPressed: boolean,
  forwardSpeed: number,
  ev: CarStepEvents,
): void {
  if (car.onGround) {
    car.hasDoubleJumped = false;
    car.hasFlipped = false;
    car.airTime = 0;
    car.airTimeSinceJump = 0;
    car.flipTime = 0;
  } else {
    car.airTime += dt;
    if (car.hasJumped && !car.isJumping) car.airTimeSinceJump += dt;
    else car.airTimeSinceJump = 0;

    if (jumpPressed && car.airTimeSinceJump < CAR.DOUBLE_JUMP_WINDOW) {
      const inputMagnitude = Math.abs(controls.yaw) + Math.abs(controls.pitch) + Math.abs(controls.roll);
      const isFlipInput = inputMagnitude >= CAR.DODGE_DEADZONE;
      const canUse = !car.hasDoubleJumped && !car.hasFlipped && !car.isAutoFlipping;
      if (canUse) {
        if (isFlipInput) {
          car.flipTime = 0;
          car.hasFlipped = true;
          car.isFlipping = true;
          ev.flipped = true;
          // dodge direction: x = forward, y = right
          let dx = -controls.pitch;
          let dy = controls.yaw + controls.roll;
          if (Math.abs(dy) < 0.1 && Math.abs(dx) < 0.1) {
            dx = 0;
            dy = 0;
          } else {
            const l = Math.hypot(dx, dy);
            dx /= l;
            dy /= l;
          }
          // Car-space rotation: side flips roll about forward, front flips pitch nose down
          car.flipTorqueX = dy;
          car.flipTorqueY = dx;
          if (Math.abs(dx) < 0.1) dx = 0;
          if (Math.abs(dy) < 0.1) dy = 0;
          if (dx !== 0 || dy !== 0) {
            const ratio = Math.abs(forwardSpeed) / CAR.MAX_SPEED;
            const backwards = Math.abs(forwardSpeed) < 100 ? dx < 0 : dx >= 0 !== forwardSpeed >= 0;
            let ix = dx * CAR.FLIP_INITIAL_VEL;
            let iy = dy * CAR.FLIP_INITIAL_VEL;
            const maxScaleX = backwards ? CAR.FLIP_BACKWARD_SPEED_SCALE : CAR.FLIP_FORWARD_SPEED_SCALE;
            ix *= (maxScaleX - 1) * ratio + 1;
            iy *= (CAR.FLIP_SIDE_SPEED_SCALE - 1) * ratio + 1;
            if (backwards) ix *= CAR.FLIP_BACKWARD_X_SCALE;
            const fw = qforward(car.quat);
            let f2 = v3(fw.x, fw.y, 0);
            f2 = vlen(f2) < 1e-6 ? v3(1, 0, 0) : vnorm(f2);
            const r2 = v3(f2.y, -f2.x, 0);
            car.vel = vadd(car.vel, vadd(vscale(f2, ix), vscale(r2, iy)));
          }
        } else {
          car.vel = vaddScaled(car.vel, qup(car.quat), CAR.JUMP_IMPULSE);
          car.hasDoubleJumped = true;
          ev.doubleJumped = true;
        }
      }
    }
  }

  if (car.isFlipping) {
    car.flipTime += dt;
    if (car.flipTime <= CAR.FLIP_TORQUE_TIME) {
      if (car.flipTime >= CAR.FLIP_Z_DAMP_START && (car.vel.z < 0 || car.flipTime < CAR.FLIP_Z_DAMP_END)) {
        car.vel = { ...car.vel, z: car.vel.z * (1 - CAR.FLIP_Z_DAMP_120) };
      }
    }
  } else if (car.hasFlipped) {
    car.flipTime += dt;
  }
}

// ---------------------------------------------------------------------------
// Hitbox vs arena
// ---------------------------------------------------------------------------

/** Hitbox sample points in car space (corners, edge midpoints, face centers). */
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

export interface ArenaContactPoint {
  point: Vec3;
  normal: Vec3;
  /** penetration (negative = gap of a speculative contact) */
  depth: number;
}

/**
 * Points of the car hitbox inside (or within `margin` of) the arena walls, deepest first
 * (Bullet keeps up to 4 per manifold).
 */
export function carArenaContacts(car: CarState, margin = 0): ArenaContactPoint[] {
  const out: ArenaContactPoint[] = [];
  if (arenaDistance(hitboxCenter(car)) >= HITBOX_BOUND + margin) return out;
  for (const lp of HITBOX_POINTS) {
    const wp = vadd(car.pos, qrotate(car.quat, lp));
    const d = arenaDistance(wp);
    if (d < margin) out.push({ point: wp, normal: arenaNormal(wp), depth: -d });
  }
  out.sort((a, b) => b.depth - a.depth);
  return out.slice(0, 4);
}

/** How far a hitbox point can travel in one tick (speculative contact margin). */
export function carContactMargin(car: CarState, dt: number): number {
  return 2 + (vlen(car.vel) + vlen(car.angVel) * 80) * dt;
}
