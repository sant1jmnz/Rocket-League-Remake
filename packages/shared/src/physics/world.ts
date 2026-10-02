import { BALL, CAR, DT, GRAVITY, MATERIAL } from '../constants.js';
import type { BallState, CarState, ControllerInput, GameState } from '../game/state.js';
import { qintegrate, vadd, vaddScaled, vclampLen, vlen, vscale, vsub, v3, type Vec3 } from '../math/vec.js';
import { ballApplyForces, ballArenaContact, ballFinish, ballPushOut } from './ball.js';
import { carArenaContacts, carContactMargin, carPreTick, newForces, type CarForces, type CarStepEvents } from './car.js';
import {
  ballHitExtraImpulse,
  carBallContact,
  carCarBump,
  carCarContactList,
  carCarContacts,
  tickBumpCooldowns,
} from './collisions.js';
import { carBody, makeContact, solveContacts, type Contact } from './rigid.js';

// One physics tick in the same order as RocketSim's Arena::Step:
//   car pre-tick (suspension, friction, jump/flip, forces) → ball forces → velocity integration →
//   contacts (car-arena, ball-arena, car-ball, car-car) solved together → position integration →
//   velocity caches (extra ball-hit impulse, bumps) and speed limits.

export interface PhysicsResult {
  carEvents: Map<number, CarStepEvents>;
  ballHits: { carId: number; strength: number; fresh: boolean }[];
  ballImpact: number;
  bumps: { attacker: number; victim: number }[];
  demos: { attacker: number; victim: number }[];
}

export interface PhysicsOptions {
  ballActive: boolean;
  /** countdown: cars settle on their suspension but ignore the controls */
  frozen: boolean;
}

const NEUTRAL: ControllerInput = {
  throttle: 0,
  steer: 0,
  pitch: 0,
  yaw: 0,
  roll: 0,
  jump: false,
  boost: false,
  handbrake: false,
};

export function stepPhysics(
  state: GameState,
  getInput: (car: CarState) => ControllerInput,
  opts: PhysicsOptions,
): PhysicsResult {
  const dt = DT;
  const res: PhysicsResult = { carEvents: new Map(), ballHits: [], ballImpact: 0, bumps: [], demos: [] };
  const ball = state.ball;
  const cars = state.cars.filter((c) => !c.demolished);
  const forces = new Map<CarState, CarForces>();
  const scene = { ball: opts.ballActive ? ball : null, cars };

  for (const car of state.cars) tickBumpCooldowns(car, dt);

  // ------------------------------------------------------------ pre-tick
  for (const car of cars) {
    const f = newForces();
    forces.set(car, f);
    const input = opts.frozen ? { ...NEUTRAL, jump: getInput(car).jump } : getInput(car);
    const ev = carPreTick(car, opts.frozen ? NEUTRAL : input, dt, state.unlimitedBoost, scene, f);
    if (opts.frozen) car.lastInput = { ...car.lastInput, jump: input.jump };
    res.carEvents.set(car.id, ev);
  }
  if (opts.ballActive) ballApplyForces(ball, dt);

  // ------------------------------------------------------ velocities
  for (const car of cars) {
    const f = forces.get(car)!;
    car.vel = vaddScaled(vaddScaled(car.vel, f.accel, dt), v3(0, 0, GRAVITY), dt);
    car.angVel = vaddScaled(car.angVel, f.angAccel, dt);
    if (opts.frozen) {
      car.vel = v3(0, 0, car.vel.z);
      car.angVel = v3();
    }
  }

  // ------------------------------------------------------ contacts
  const contacts: Contact[] = [];
  const pushes: { body: { pos: Vec3 }; dir: Vec3; amount: number }[] = [];
  const ballCache = { v: v3() };

  const worldContacts = new Map<CarState, { contacts: Contact[]; pts: ReturnType<typeof carArenaContacts> }>();
  for (const car of cars) {
    const pts = carArenaContacts(car, carContactMargin(car, dt));
    if (!pts.length) continue;
    const body = carBody(car);
    const list = pts.map((p) =>
      makeContact(
        body,
        null,
        p.point,
        p.normal,
        MATERIAL.CAR_WORLD.friction,
        MATERIAL.CAR_WORLD.restitution,
        Math.max(0, -p.depth),
      ),
    );
    contacts.push(...list);
    worldContacts.set(car, { contacts: list, pts });
  }

  const ballTouches: { car: CarState; contact: Contact; depth: number; strength: number; extra: Vec3 | null; normal: Vec3 }[] = [];
  if (opts.ballActive) {
    const bc = ballArenaContact(ball, dt);
    if (bc) {
      contacts.push(bc.contact);
      res.ballImpact = bc.impact;
    }
    for (const car of cars) {
      const margin = 2 + vlen(vsub(ball.vel, car.vel)) * dt + vlen(car.angVel) * 80 * dt;
      const hit = carBallContact(car, ball, margin);
      if (!hit) continue;
      contacts.push(hit.contact);
      ballTouches.push({
        car,
        contact: hit.contact,
        depth: hit.depth,
        strength: hit.strength,
        extra: ballHitExtraImpulse(car, ball, state.tick),
        normal: hit.normal,
      });
    }
  }

  for (let i = 0; i < cars.length; i++) {
    for (let j = i + 1; j < cars.length; j++) {
      const a = cars[i];
      const b = cars[j];
      const pts = carCarContacts(a, b);
      if (!pts.length) continue;
      const bumps = carCarBump(a, b, pts[0].point);
      let demo = false;
      for (const bump of bumps) {
        const victim = bump.victim === a.id ? a : b;
        if (bump.demo) {
          demo = true;
          res.demos.push({ attacker: bump.attacker, victim: bump.victim });
        } else {
          forces.get(victim)!.velCache = vadd(forces.get(victim)!.velCache, bump.impulse);
          res.bumps.push({ attacker: bump.attacker, victim: bump.victim });
        }
      }
      if (demo) continue; // the attacker blows through the demolished car
      contacts.push(...carCarContactList(a, b, pts));
      pushes.push({ body: a, dir: pts[0].normal, amount: pts[0].depth / 2 });
      pushes.push({ body: b, dir: vscale(pts[0].normal, -1), amount: pts[0].depth / 2 });
    }
  }

  solveContacts(contacts);

  // Callbacks for the contacts that really touched this tick
  for (const [car, wc] of worldContacts) {
    let touched = -1;
    wc.contacts.forEach((c, i) => {
      if (touched < 0 && (wc.pts[i].depth > -1 || c.jn > 0)) touched = i;
    });
    if (touched < 0) continue;
    car.worldContact = true;
    car.worldContactNormal = wc.pts[touched].normal;
    const impact = Math.max(...wc.contacts.map((c) => c.jn)) / CAR.MASS;
    if (impact > 300) {
      const ev = res.carEvents.get(car.id);
      if (ev) ev.wallHit = impact;
    }
  }
  for (const t of ballTouches) {
    if (t.depth <= -1 && t.contact.jn <= 0) continue;
    const car = t.car;
    if (t.extra) {
      car.ballImpulseTick = state.tick;
      ballCache.v = vadd(ballCache.v, t.extra);
    }
    const fresh = car.lastBallTouchTick !== state.tick - 1;
    car.lastBallTouchTick = state.tick;
    res.ballHits.push({ carId: car.id, strength: t.strength, fresh });
    if (t.depth > 0) {
      // separation (split impulse): the light ball takes most of it
      const total = 1 / BALL.MASS + 1 / CAR.MASS;
      pushes.push({ body: ball, dir: t.normal, amount: (t.depth * (1 / BALL.MASS)) / total });
      pushes.push({ body: car, dir: vscale(t.normal, -1), amount: (t.depth * (1 / CAR.MASS)) / total });
    }
  }

  // ------------------------------------------------------ positions
  for (const car of cars) {
    car.pos = vaddScaled(car.pos, car.vel, dt);
    car.quat = qintegrate(car.quat, car.angVel, dt);
  }
  if (opts.ballActive) ball.pos = vaddScaled(ball.pos, ball.vel, dt);
  for (const p of pushes) p.body.pos = vaddScaled(p.body.pos, p.dir, p.amount * 0.8);
  for (const car of cars) {
    const pts = carArenaContacts(car);
    if (pts.length) car.pos = vaddScaled(car.pos, pts[0].normal, pts[0].depth);
  }
  if (opts.ballActive) ballPushOut(ball);

  // ------------------------------------------------------ finish
  for (const car of cars) finishCar(car, forces.get(car)!, dt);
  if (opts.ballActive) {
    ball.vel = vadd(ball.vel, ballCache.v);
    ballFinish(ball);
  }
  return res;
}

function finishCar(car: CarState, f: CarForces, dt: number): void {
  car.vel = vadd(car.vel, f.velCache);
  car.vel = vclampLen(car.vel, CAR.MAX_SPEED);
  car.angVel = vclampLen(car.angVel, CAR.MAX_ANG_SPEED);

  const speed = vlen(car.vel);
  if (car.isSupersonic && car.supersonicTime < CAR.SUPERSONIC_MAINTAIN_TIME) {
    car.isSupersonic = speed >= CAR.SUPERSONIC_MAINTAIN;
  } else {
    car.isSupersonic = speed >= CAR.SUPERSONIC_START;
  }
  car.supersonicTime = car.isSupersonic ? car.supersonicTime + dt : 0;
}

/** Kept for tools/tests: copy of a ball state. */
export const cloneBall = (b: BallState): BallState => ({ pos: { ...b.pos }, vel: { ...b.vel }, angVel: { ...b.angVel } });
