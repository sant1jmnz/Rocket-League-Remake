import { describe, expect, it } from 'vitest';
import {
  ARENA,
  ARENA_QUERY_PAD,
  GOAL,
  raycastArena,
  BALL,
  CAR,
  DT,
  addCar,
  curve,
  arenaDistance,
  cloneState,
  createGameState,
  emptyInput,
  qforward,
  qfromAxisAngle,
  qfromYaw,
  qinvRotate,
  qmul,
  qup,
  stepBall,
  stepGame,
  vlen,
  v3,
  type ControllerInput,
  type GameState,
} from '../src/index.js';

function freeplayWithCar(): GameState {
  const s = createGameState({ freeplay: true });
  addCar(s, 1, 0, 'test');
  const car = s.cars[0];
  car.pos = v3(0, -2000, CAR.REST_HEIGHT);
  // ball out of the way
  s.ball.pos = v3(3000, 3000, BALL.RADIUS);
  return s;
}

function run(s: GameState, seconds: number, input: Partial<ControllerInput> | ((t: number) => Partial<ControllerInput>)) {
  const ticks = Math.round(seconds / DT);
  for (let i = 0; i < ticks; i++) {
    const inp = typeof input === 'function' ? input(i * DT) : input;
    stepGame(s, () => ({ ...emptyInput(), ...inp }));
  }
}

describe('arena', () => {
  it('floor, walls and ceiling are at the real dimensions', () => {
    expect(arenaDistance(v3(0, 0, 100))).toBeCloseTo(100, 3);
    expect(arenaDistance(v3(ARENA.HALF_WIDTH - 50, 0, 1000))).toBeCloseTo(50, 3);
    expect(arenaDistance(v3(0, 0, ARENA.HEIGHT - 30))).toBeCloseTo(30, 3);
    expect(arenaDistance(v3(2000, ARENA.HALF_LENGTH - 40, 1000))).toBeCloseTo(40, 3);
  });

  it('the goal is open and has the real size', () => {
    // inside the goal mouth (queries are exact up to ARENA_QUERY_PAD)
    expect(arenaDistance(v3(0, ARENA.HALF_LENGTH + 400, 300))).toBe(ARENA_QUERY_PAD);
    // the goal is ~880 deep and ~1786 wide
    const back = raycastArena(v3(0, ARENA.HALF_LENGTH, 50), v3(0, 1, 0), 2000);
    expect(back!.t).toBeGreaterThan(700);
    const post = raycastArena(v3(0, ARENA.HALF_LENGTH + 200, 300), v3(1, 0, 0), 2000);
    expect(post!.t).toBeCloseTo(GOAL.HALF_WIDTH, -1);
    // the crossbar blocks above the goal height
    expect(arenaDistance(v3(0, ARENA.HALF_LENGTH + 100, 700))).toBeLessThan(0);
    // the post blocks beside it
    expect(arenaDistance(v3(1000, ARENA.HALF_LENGTH + 100, 300))).toBeLessThan(0);
  });
});

describe('car driving', () => {
  it('throttle only tops out at ~1410 uu/s', () => {
    const s = freeplayWithCar();
    run(s, 4, { throttle: 1 });
    const speed = vlen(s.cars[0].vel);
    expect(speed).toBeGreaterThan(1395);
    expect(speed).toBeLessThan(1415);
  });

  it('boost reaches the 2300 uu/s cap and supersonic', () => {
    const s = freeplayWithCar();
    s.unlimitedBoost = true;
    run(s, 3.5, { throttle: 1, boost: true });
    const car = s.cars[0];
    expect(vlen(car.vel)).toBeGreaterThan(2295);
    expect(car.isSupersonic).toBe(true);
  });

  it('consumes 33.3 boost per second', () => {
    const s = freeplayWithCar();
    s.cars[0].pos.x = -500; // stay away from boost pads
    s.cars[0].boost = 100;
    run(s, 1, { throttle: 1, boost: true });
    expect(s.cars[0].boost).toBeCloseTo(100 - 100 / 3, 0);
  });

  it('turns with the real curvature-vs-speed table', () => {
    const s = freeplayWithCar();
    const car = s.cars[0];
    car.pos = v3(0, 0, CAR.REST_HEIGHT);
    run(s, 0.4, { throttle: 1 });
    run(s, 1, { throttle: 1, steer: 1 });
    const speed = vlen(car.vel);
    const radius = speed / Math.abs(car.angVel.z);
    // Turn curvature measured in the real game (RLBot wiki)
    const STEER_CURVE: [number, number][] = [
      [0, 0.0069],
      [500, 0.00398],
      [1000, 0.00235],
      [1500, 0.001375],
      [1750, 0.0011],
      [2500, 0.00088],
    ];
    const expected = 1 / curve(STEER_CURVE, speed);
    expect(radius / expected).toBeGreaterThan(0.9);
    expect(radius / expected).toBeLessThan(1.1);
  });
});

describe('jumping', () => {
  it('a full single jump reaches ~230 uu', () => {
    const s = freeplayWithCar();
    let maxZ = 0;
    for (let i = 0; i < 120; i++) {
      stepGame(s, () => ({ ...emptyInput(), jump: i < 30 }));
      maxZ = Math.max(maxZ, s.cars[0].pos.z);
    }
    const height = maxZ - CAR.REST_HEIGHT;
    expect(height).toBeGreaterThan(215);
    expect(height).toBeLessThan(250);
  });

  it('a double jump goes much higher', () => {
    const s = freeplayWithCar();
    let maxZ = 0;
    for (let i = 0; i < 200; i++) {
      // hold 0.2s, release, press again at 0.25s
      const jump = i < 24 || (i >= 30 && i < 34);
      stepGame(s, () => ({ ...emptyInput(), jump }));
      maxZ = Math.max(maxZ, s.cars[0].pos.z);
    }
    expect(maxZ - CAR.REST_HEIGHT).toBeGreaterThan(400);
    expect(s.cars[0].hasDoubleJumped).toBe(true);
  });

  it('a front flip adds ~500 uu/s forward and rotates nose down', () => {
    const s = freeplayWithCar();
    const car = s.cars[0];
    for (let i = 0; i < 12; i++) stepGame(s, () => ({ ...emptyInput(), jump: i < 6 }));
    const vy0 = car.vel.y;
    stepGame(s, () => ({ ...emptyInput(), jump: true, pitch: -1 }));
    expect(car.hasFlipped).toBe(true);
    // car faces +y (blue goalie spot faces the ball)
    expect(car.vel.y - vy0).toBeGreaterThan(480);
    for (let i = 0; i < 20; i++) stepGame(s, () => ({ ...emptyInput(), pitch: -1 }));
    expect(qforward(car.quat).z).toBeLessThan(-0.3);
  });

  it('lands back on its wheels', () => {
    const s = freeplayWithCar();
    run(s, 0.1, { jump: true });
    run(s, 2, {});
    const car = s.cars[0];
    expect(car.onGround).toBe(true);
    expect(car.pos.z).toBeCloseTo(CAR.REST_HEIGHT, 0);
    expect(qup(car.quat).z).toBeGreaterThan(0.99);
  });
});

describe('walls', () => {
  it('a car can drive up the side wall', () => {
    const s = freeplayWithCar();
    const car = s.cars[0];
    car.pos = v3(2500, 0, CAR.REST_HEIGHT);
    // face +X towards the side wall
    car.quat = { x: 0, y: 0, z: 0, w: 1 };
    s.unlimitedBoost = true;
    let maxZ = 0;
    for (let i = 0; i < 300; i++) {
      stepGame(s, () => ({ ...emptyInput(), throttle: 1, boost: i < 60 }));
      maxZ = Math.max(maxZ, car.pos.z);
    }
    expect(maxZ).toBeGreaterThan(600);
    expect(qup(car.quat).x).toBeLessThan(-0.95); // wheels on the wall
    expect(car.pos.x).toBeLessThan(ARENA.HALF_WIDTH);
  });
});

describe('ball', () => {
  it('bounces with 0.6 restitution', () => {
    const s = createGameState({ freeplay: true });
    s.ball.pos = v3(0, 0, 1000);
    s.ball.vel = v3();
    let prevVz = 0;
    let impactVz = 0;
    let bounceVz = 0;
    for (let i = 0; i < 400; i++) {
      prevVz = s.ball.vel.z;
      stepBall(s.ball, DT);
      if (prevVz < -100 && s.ball.vel.z > 0) {
        impactVz = prevVz;
        bounceVz = s.ball.vel.z;
        break;
      }
    }
    expect(bounceVz / -impactVz).toBeGreaterThan(0.55);
    expect(bounceVz / -impactVz).toBeLessThan(0.62);
  });

  it('a goal is scored when the ball fully crosses the line', () => {
    const s = createGameState();
    addCar(s, 1, 0, 'a');
    s.phase = 'playing';
    s.ball.pos = v3(0, ARENA.HALF_LENGTH - 200, 200);
    s.ball.vel = v3(0, 2000, 0);
    s.lastTouches.push({ carId: 1, team: 0, time: 0 });
    run(s, 0.5, {});
    expect(s.score[0]).toBe(1);
    expect(s.cars[0].stats.goals).toBe(1);
  });

  it('a car hitting the ball sends it flying', () => {
    const s = freeplayWithCar();
    const car = s.cars[0];
    car.pos = v3(0, -1500, CAR.REST_HEIGHT);
    s.ball.pos = v3(0, -500, BALL.RADIUS);
    s.ball.vel = v3();
    s.unlimitedBoost = true;
    let hit = false;
    for (let i = 0; i < 240 && !hit; i++) {
      const ev = stepGame(s, () => ({ ...emptyInput(), throttle: 1, boost: true }));
      hit = ev.some((e) => e.type === 'ballHit');
    }
    expect(hit).toBe(true);
    run(s, 0.05, {});
    expect(s.ball.vel.y).toBeGreaterThan(vlen(car.vel));
  });
});

describe('flip reset', () => {
  it('touching the ball with the wheels in the air gives the flip back', () => {
    const s = freeplayWithCar();
    const car = s.cars[0];
    car.pos = v3(0, 0, 600);
    car.onGround = false;
    car.hasJumped = true;
    car.hasDoubleJumped = true;
    car.jumpTime = 2;
    car.airTimeSinceJump = 3;
    // under the car, within reach of the suspension rays (but not touching the hitbox)
    s.ball.pos = v3(8, 0, 590 - BALL.RADIUS);
    s.ball.vel = v3();
    stepGame(s, () => emptyInput());
    expect(car.hasDoubleJumped).toBe(false);
    expect(car.hasJumped).toBe(false);
  });
});

describe('RocketSim mechanics', () => {
  it('the car rests on its suspension at the real height', () => {
    const s = freeplayWithCar();
    run(s, 1, {});
    const car = s.cars[0];
    expect(car.wheelContacts).toBe(4);
    expect(car.pos.z).toBeGreaterThan(16.5);
    expect(car.pos.z).toBeLessThan(18);
  });

  it('a flip stops the fall while it rotates (z damping)', () => {
    const s = freeplayWithCar();
    const car = s.cars[0];
    car.pos = v3(0, 0, 800);
    car.onGround = false;
    car.vel = v3(0, 0, -400);
    stepGame(s, () => ({ ...emptyInput(), jump: true, pitch: -1 }));
    expect(car.isFlipping).toBe(true);
    run(s, 0.25, { pitch: -1 });
    expect(Math.abs(car.vel.z)).toBeLessThan(30);
  });

  it('pulling back during a front flip cancels the rotation', () => {
    const flipAngle = (cancel: boolean) => {
      const s = freeplayWithCar();
      const car = s.cars[0];
      car.pos = v3(0, 0, 800);
      car.onGround = false;
      stepGame(s, () => ({ ...emptyInput(), jump: true, pitch: -1 }));
      run(s, 0.4, { pitch: cancel ? 1 : 0 });
      return Math.abs(qinvRotate(car.quat, car.angVel).y);
    };
    expect(flipAngle(true)).toBeLessThan(flipAngle(false) * 0.5);
  });

  it('jumping while upside down on the floor auto-flips the car', () => {
    const s = freeplayWithCar();
    const car = s.cars[0];
    car.quat = qmul(qfromYaw(Math.PI / 2), qfromAxisAngle(v3(1, 0, 0), Math.PI));
    car.pos.z = 45;
    run(s, 1, {});
    expect(qup(car.quat).z).toBeLessThan(-0.9);
    run(s, 1.5, (t) => ({ jump: t < 0.1 }));
    expect(qup(car.quat).z).toBeGreaterThan(0.95);
    expect(car.onGround).toBe(true);
  });

  it('without throttle the car slides down the wall; with throttle it sticks', () => {
    const slide = (throttle: number) => {
      const s = freeplayWithCar();
      const car = s.cars[0];
      // on the side wall at x = +4096, nose pointing along +y
      car.pos = v3(ARENA.HALF_WIDTH - CAR.REST_HEIGHT, 0, 1000);
      car.quat = qmul(qfromYaw(Math.PI / 2), qfromAxisAngle(v3(1, 0, 0), -Math.PI / 2));
      car.vel = v3(0, 300, 0);
      run(s, 1, { throttle });
      return car.pos.z;
    };
    expect(slide(0)).toBeLessThan(900);
    expect(slide(0.05)).toBeGreaterThan(slide(0) + 100);
  });

  it('powerslide turns much tighter than a normal turn', () => {
    const yawAfter = (handbrake: boolean) => {
      const s = freeplayWithCar();
      const car = s.cars[0];
      run(s, 1.5, { throttle: 1 });
      run(s, 0.6, { throttle: 1, steer: 1, handbrake });
      return Math.atan2(qforward(car.quat).y, qforward(car.quat).x);
    };
    // the car starts facing +y (yaw 90°) and turns right (towards 0)
    expect(yawAfter(true)).toBeLessThan(yawAfter(false));
  });

  it('a 1400 uu/s hit sends the ball faster than the car (Psyonix impulse)', () => {
    const s = freeplayWithCar();
    const car = s.cars[0];
    car.pos = v3(0, -3000, CAR.REST_HEIGHT);
    s.ball.pos = v3(3000, 3000, BALL.REST_Z);
    run(s, 2.5, { throttle: 1 });
    s.ball.pos = v3(car.pos.x + 13, car.pos.y + 350, BALL.REST_Z);
    s.ball.vel = v3();
    const carSpeed = vlen(car.vel);
    run(s, 0.4, { throttle: 1 });
    expect(vlen(s.ball.vel)).toBeGreaterThan(carSpeed * 1.2);
  });
});

describe('determinism', () => {
  it('same inputs produce the same state', () => {
    const a = freeplayWithCar();
    const b = cloneState(a);
    const input = (t: number) => ({
      throttle: Math.sin(t * 3),
      steer: Math.cos(t * 2),
      jump: Math.floor(t * 4) % 3 === 0,
      boost: t > 1,
      pitch: Math.sin(t),
    });
    run(a, 3, input);
    run(b, 3, input);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
