import { describe, expect, it } from 'vitest';
import {
  ARENA,
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
    // inside the goal mouth
    expect(arenaDistance(v3(0, ARENA.HALF_LENGTH + 400, 300))).toBeGreaterThan(299);
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
    const expected = 1 / curve(CAR.STEER_CURVE, speed);
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
    car.airTimeSinceJump = 3;
    // just under the hitbox bottom (origin + 20.75 offset - 18.08 half height)
    s.ball.pos = v3(CAR.HITBOX_OFFSET.x, 0, 600 + 2.67 - BALL.RADIUS + 5);
    s.ball.vel = v3();
    stepGame(s, () => emptyInput());
    expect(car.hasDoubleJumped).toBe(false);
    expect(car.hasJumped).toBe(false);
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
