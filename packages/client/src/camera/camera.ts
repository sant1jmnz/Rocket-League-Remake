import * as THREE from 'three';
import { arenaQuery, qforward, qup, raycastArena, type Quat, type Vec3 } from '@rl/shared';
import { toThreeXYZ } from '../render/coords';

// Car cam / ball cam modelled after the real game's camera settings.
export interface CameraSettings {
  /** horizontal field of view, degrees */
  fov: number;
  distance: number;
  height: number;
  /** degrees, negative looks down */
  angle: number;
  stiffness: number;
  swivelSpeed: number;
  transitionSpeed: number;
  shake: boolean;
  invertSwivel: boolean;
}

/** The game's defaults (Settings → Camera). */
export const DEFAULT_CAMERA: CameraSettings = {
  fov: 90,
  distance: 270,
  height: 100,
  angle: -3,
  stiffness: 0.5,
  swivelSpeed: 2.5,
  transitionSpeed: 1.2,
  shake: true,
  invertSwivel: false,
};

type V = THREE.Vector3;

export interface CameraTarget {
  pos: Vec3;
  quat: Quat;
  vel: Vec3;
  onGround: boolean;
  boosting: boolean;
  supersonic: boolean;
}

export class CameraController {
  ballCam = true;
  settings: CameraSettings = { ...DEFAULT_CAMERA };
  private blend = 1;
  private dir = new THREE.Vector3(1, 0, 0); // sim space, horizontal-ish
  private up = new THREE.Vector3(0, 0, 1);
  private lagPos = new THREE.Vector3();
  private lastCarPos = new THREE.Vector3();
  private lastLook = new THREE.Vector3();
  /** nose direction on the floor plane, continuous through flips */
  private heading = new THREE.Vector3(1, 0, 0);
  /** fraction of the boom that is free of geometry (smoothed) */
  private boomFree = 1;
  private initialized = false;
  private swivel = new THREE.Vector2();
  private shakeTime = 0;
  private shakeAmp = 0;
  private shakeClock = 0;

  constructor(public camera: THREE.PerspectiveCamera) {}

  reset() {
    this.initialized = false;
  }

  shake(amount: number, seconds: number) {
    if (!this.settings.shake) return;
    this.shakeAmp = Math.max(this.shakeAmp, amount);
    this.shakeTime = Math.max(this.shakeTime, seconds);
  }

  updateFov(aspect: number) {
    const h = (this.settings.fov * Math.PI) / 180;
    const v = 2 * Math.atan(Math.tan(h / 2) / aspect);
    this.camera.fov = Math.min(110, (v * 180) / Math.PI);
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /** Spectator view over the whole field (no local car). */
  updateOverview(dt: number, ball: Vec3) {
    const target = new THREE.Vector3(ball.x * 0.5, ball.y * 0.5 - 5200, 2600);
    if (!this.initialized) {
      this.lagPos.copy(target);
      this.initialized = true;
    }
    this.lagPos.lerp(target, 1 - Math.exp(-2 * dt));
    toThreeXYZ(this.lagPos.x, this.lagPos.y, this.lagPos.z, this.camera.position);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(toThreeXYZ(ball.x * 0.7, ball.y * 0.7, 0));
  }

  /** Rotates `dir` towards `target` about `up` by a fraction of the signed angle between them. */
  private rotateToward(dir: V, target: V, up: V, k: number) {
    const angle = Math.atan2(up.dot(new THREE.Vector3().crossVectors(dir, target)), dir.dot(target));
    dir.applyAxisAngle(up, angle * k).normalize();
  }

  update(dt: number, car: CameraTarget, ball: Vec3 | null, swivelInput: { x: number; y: number }) {
    const s = this.settings;
    const carPos = new THREE.Vector3(car.pos.x, car.pos.y, car.pos.z);
    const fwd = qforward(car.quat);
    const cup = qup(car.quat);
    const worldUp = new THREE.Vector3(0, 0, 1);

    // Respawns and kickoffs teleport the car: start over from its nose direction
    if (this.initialized && carPos.distanceTo(this.lastCarPos) > 400) this.initialized = false;
    this.lastCarPos.copy(carPos);

    if (!this.initialized) {
      this.lagPos.copy(carPos);
      this.dir.set(fwd.x, fwd.y, 0).normalize();
      this.heading.copy(this.dir);
      this.up.copy(worldUp);
      this.blend = this.ballCam ? 1 : 0;
      this.lastLook.set(0, 0, 0);
      this.initialized = true;
    }

    // Camera up follows the surface while driving on walls, world up in the air
    const targetUp = car.onGround ? new THREE.Vector3(cup.x, cup.y, cup.z) : worldUp;
    this.up.lerp(targetUp, 1 - Math.exp(-(car.onGround ? 5 : 2.5) * dt)).normalize();

    // Blend car cam <-> ball cam
    const bt = this.ballCam && ball ? 1 : 0;
    const rate = 4 * s.transitionSpeed;
    this.blend += Math.sign(bt - this.blend) * Math.min(Math.abs(bt - this.blend), rate * dt);

    const flat = (v: V) => v.sub(this.up.clone().multiplyScalar(v.dot(this.up)));
    // Car heading = the nose direction projected on the camera's floor plane. It ignores roll
    // (air roll never moves the camera) and is kept continuous through flips: when the nose
    // swings past vertical the projection reverses, so it is flipped back instead of spinning the
    // camera 180°.
    const noseFlat = flat(new THREE.Vector3(fwd.x, fwd.y, fwd.z));
    const noseLen = noseFlat.length();
    if (noseLen > 0.25) {
      noseFlat.divideScalar(noseLen);
      if (noseFlat.dot(this.heading) < 0) noseFlat.negate();
      this.heading.copy(noseFlat);
    }
    const carDir = this.heading.clone();
    let targetDir = carDir.clone();
    let ballDir: V | null = null;
    if (ball) {
      ballDir = flat(new THREE.Vector3(ball.x - carPos.x, ball.y - carPos.y, ball.z - carPos.z));
      if (ballDir.lengthSq() < 100) ballDir = carDir.clone();
      ballDir.normalize();
      // Ball cam always faces the ball, also when it is behind the car (short way round)
      const ang = Math.atan2(this.up.dot(new THREE.Vector3().crossVectors(carDir, ballDir)), carDir.dot(ballDir));
      targetDir = carDir.clone().applyAxisAngle(this.up, ang * this.blend).normalize();
    }
    // Smoothly rotate towards the target direction (car cam lags a bit in the air)
    const turnRate = this.blend > 0.5 ? 9 : car.onGround ? 10 : 6;
    flat(this.dir).normalize();
    this.rotateToward(this.dir, targetDir, this.up, 1 - Math.exp(-turnRate * dt));

    // Swivel (right stick)
    const swRate = s.swivelSpeed * 2;
    const swX = s.invertSwivel ? -swivelInput.x : swivelInput.x;
    this.swivel.x += (swX - this.swivel.x) * Math.min(1, swRate * dt);
    this.swivel.y += (swivelInput.y - this.swivel.y) * Math.min(1, swRate * dt);
    const viewDir = this.dir.clone().applyAxisAngle(this.up, -this.swivel.x * Math.PI);

    // The camera is attached to the car; only the vertical bounce of the suspension is smoothed.
    // Lower stiffness pulls the camera further back at high speed, as in the game.
    const along = carPos.clone().sub(this.lagPos).dot(this.up);
    this.lagPos.copy(carPos).sub(this.up.clone().multiplyScalar(along * Math.exp(-25 * dt)));
    if (this.lagPos.distanceTo(carPos) > 200) this.lagPos.copy(carPos);
    const speed = Math.hypot(car.vel.x, car.vel.y, car.vel.z);
    const stretch = 1 + (1 - s.stiffness) * 0.35 * Math.min(1, speed / 2300);

    // Camera collision: shorten the boom when the stadium (walls, goal backs, ceiling) is in the way
    const anchor = this.lagPos.clone().add(this.up.clone().multiplyScalar(Math.min(s.height, 60)));
    const wanted = this.lagPos
      .clone()
      .add(this.up.clone().multiplyScalar(s.height))
      .sub(viewDir.clone().multiplyScalar(s.distance * stretch));
    const boom = wanted.clone().sub(anchor);
    const boomLen = boom.length();
    let free = 1;
    if (boomLen > 1e-3) {
      const d = boom.clone().divideScalar(boomLen);
      const hit = raycastArena(
        { x: anchor.x, y: anchor.y, z: anchor.z },
        { x: d.x, y: d.y, z: d.z },
        boomLen + 40,
      );
      if (hit) free = THREE.MathUtils.clamp((hit.t - 40) / boomLen, 0.2, 1);
    }
    // zoom in at once, zoom back out smoothly
    this.boomFree = free < this.boomFree ? free : this.boomFree + (free - this.boomFree) * (1 - Math.exp(-6 * dt));
    const camPos = anchor.clone().add(boom.multiplyScalar(this.boomFree));
    // last resort: never end up inside geometry
    for (let i = 0; i < 2; i++) {
      const q = arenaQuery({ x: camPos.x, y: camPos.y, z: camPos.z });
      if (q.dist < 25) camPos.add(new THREE.Vector3(q.normal.x, q.normal.y, q.normal.z).multiplyScalar(25 - q.dist));
    }

    // Look direction
    const ang = (s.angle * Math.PI) / 180 + this.swivel.y * 0.6;
    const side = new THREE.Vector3().crossVectors(this.up, viewDir).normalize();
    const carLook = viewDir.clone().applyAxisAngle(side, -ang);
    let look = carLook;
    if (ball && this.blend > 0 && Math.abs(this.swivel.x) < 0.2) {
      const toBall = new THREE.Vector3(ball.x, ball.y, ball.z).sub(camPos).normalize();
      // Limit how far up/down the camera may tilt so the car stays on screen
      const elev = Math.asin(THREE.MathUtils.clamp(toBall.dot(this.up), -1, 1));
      const base = Math.asin(THREE.MathUtils.clamp(carLook.dot(this.up), -1, 1));
      const clamped = THREE.MathUtils.clamp(elev, base - 0.35, base + 0.6);
      const horiz = flat(toBall.clone()).normalize();
      const ballLook = horiz.multiplyScalar(Math.cos(clamped)).add(this.up.clone().multiplyScalar(Math.sin(clamped)));
      look = carLook.clone().lerp(ballLook, this.blend).normalize();
    }

    // Shake: events (goals, demos, big hits) plus the light rumble of boosting / supersonic
    this.shakeClock += dt;
    let a = 0;
    if (this.shakeTime > 0) {
      this.shakeTime -= dt;
      a = this.shakeAmp * Math.max(0, this.shakeTime);
      if (this.shakeTime <= 0) this.shakeAmp = 0;
    }
    if (s.shake) a += (car.boosting ? 1.6 : 0) + (car.supersonic ? 1.6 : 0);
    if (a > 0) {
      const t = this.shakeClock;
      const n = (f: number, ph: number) => Math.sin(t * f + ph) * 0.6 + Math.sin(t * f * 2.3 + ph * 1.7) * 0.4;
      camPos.add(new THREE.Vector3(n(37, 0) * a, n(41, 2.1) * a, n(33, 4.2) * a));
    }

    // The view never snaps: cap how fast it can turn (720°/s) so geometry or surface changes
    // cannot flip it in a single frame
    look.normalize();
    if (this.lastLook.lengthSq() > 0.5) {
      const ang = Math.acos(THREE.MathUtils.clamp(look.dot(this.lastLook), -1, 1));
      const maxAng = (Math.PI * 4) * dt;
      if (ang > maxAng) look.lerp(this.lastLook, 1 - maxAng / ang).normalize();
    }
    this.lastLook.copy(look);

    toThreeXYZ(camPos.x, camPos.y, camPos.z, this.camera.position);
    const lookAt = camPos.clone().add(look.multiplyScalar(1000));
    toThreeXYZ(this.up.x, this.up.y, this.up.z, this.camera.up);
    this.camera.lookAt(toThreeXYZ(lookAt.x, lookAt.y, lookAt.z));
  }
}
