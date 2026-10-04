import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { addCar, createGameState, emptyInput, qfromYaw, startMatch, stepGame, v3, arenaQuery } from '@rl/shared';
import { CameraController } from '../src/camera/camera';

/** Drives a car and returns the camera's worst per-frame view change (deg) and clearance to the arena. */
function drive(
  setup: (car: ReturnType<typeof createGameState>['cars'][number], s: ReturnType<typeof createGameState>) => void,
  input: (t: number) => Partial<ReturnType<typeof emptyInput>>,
  seconds: number,
  ballCam: boolean,
) {
  const s = createGameState({ seed: 1 });
  addCar(s, 1, 0, 'p', false);
  startMatch(s, 300);
  s.phase = 'playing';
  const car = s.cars[0];
  setup(car, s);
  const cam = new CameraController(new THREE.PerspectiveCamera());
  cam.ballCam = ballCam;
  const prev = new THREE.Vector3();
  const look = new THREE.Vector3();
  let worst = 0;
  let clearance = Infinity;
  for (let i = 0; i < seconds * 60; i++) {
    const t = i / 60;
    for (let k = 0; k < 2; k++) stepGame(s, () => ({ ...emptyInput(), ...input(t) }));
    cam.update(
      1 / 60,
      { pos: car.pos, quat: car.quat, vel: car.vel, onGround: car.onGround, boosting: false, supersonic: false },
      ballCam ? s.ball.pos : null,
      { x: 0, y: 0 },
    );
    cam.camera.getWorldDirection(look);
    if (i > 0) worst = Math.max(worst, THREE.MathUtils.radToDeg(look.angleTo(prev)));
    prev.copy(look);
    const p = cam.camera.position;
    clearance = Math.min(clearance, arenaQuery({ x: p.x, y: -p.z, z: p.y }).dist);
  }
  return { worst, clearance };
}

describe('camera', () => {
  it('does not move while air rolling or flipping', () => {
    const air = (car: { pos: unknown; quat: unknown; vel: unknown }) => {
      Object.assign(car, { pos: v3(0, -2000, 600), quat: qfromYaw(Math.PI / 2), vel: v3(300, 700, 200) });
    };
    const roll = drive((c, s) => (air(c), (s.ball.pos = v3(1500, 1000, 300))), () => ({ roll: 1 }), 2.5, false);
    expect(roll.worst).toBeLessThan(1);
    const flip = drive(
      (c, s) => {
        air(c);
        s.ball.pos = v3(1500, 1000, 300);
        c.hasJumped = true;
      },
      (t) => (t > 0.1 && t < 0.15 ? { jump: true, pitch: -1 } : {}),
      2,
      false,
    );
    expect(flip.worst).toBeLessThan(1);
  });

  it('turns smoothly towards a ball behind the car', () => {
    const r = drive(
      (c, s) => {
        c.pos = v3(0, 0, 17);
        c.quat = qfromYaw(Math.PI / 2);
        c.vel = v3(0, 900, 0);
        s.ball.pos = v3(0, -1500, 93);
      },
      () => ({ throttle: 1 }),
      3,
      true,
    );
    expect(r.worst).toBeLessThan(12);
  });

  it('stays inside the stadium next to walls and inside the goal', () => {
    const goal = drive(
      (c, s) => {
        c.pos = v3(0, 4500, 17);
        c.quat = qfromYaw(Math.PI / 2);
        c.vel = v3(0, 1400, 0);
        s.ball.pos = v3(0, 0, 93);
      },
      () => ({ throttle: 1, boost: true }),
      4,
      true,
    );
    expect(goal.clearance).toBeGreaterThan(10);
    expect(goal.worst).toBeLessThan(13);
    const wall = drive(
      (c, s) => {
        c.pos = v3(2500, 0, 17);
        c.vel = v3(1400, 0, 0);
        s.ball.pos = v3(0, 0, 93);
      },
      () => ({ throttle: 1, boost: true }),
      4,
      false,
    );
    expect(wall.clearance).toBeGreaterThan(10);
    expect(wall.worst).toBeLessThan(8);
  });
});
