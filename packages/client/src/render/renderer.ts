import * as THREE from 'three';
import {
  BALL,
  arenaDistance,
  qforward,
  qslerp,
  vlen,
  vlerp,
  type CarBody,
  type CarState,
  type GameEvent,
  type GameState,
} from '@rl/shared';
import { buildArena } from './arena';
import { quatToThree, toThree, toThreeXYZ } from './coords';
import {
  TEAM_COLORS,
  createBallModel,
  createBlobShadow,
  createNameTag,
  type NameTag,
} from './models';
import { createCarModel, type CarModel } from './car';

const CAR_REST = 17.01;
import { ParticleSystem } from './particles';
import { TrailRibbon } from './trails';
import { setupEnvironment, type Environment } from './environment';
import { PostFx } from './post';
import { BoostPadsView } from './pads';
import { CameraController } from '../camera/camera';

interface CarView {
  model: CarModel;
  shadow: THREE.Mesh;
  name: NameTag;
  team: 0 | 1;
  wheelSpin: number;
  steer: number;
  trailTimer: number;
  smokeTimer: number;
  /** supersonic wind lines from the rear wheels */
  trails: TrailRibbon[];
}

export interface RenderOptions {
  localCarId: number | null;
  /** when true, local inputs drive the wheel steering visuals */
  showNames: boolean;
  bodyOf?: (carId: number) => CarBody;
}

export class GameRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(75, 16 / 9, 5, 60000);
  readonly cam: CameraController;
  private cars = new Map<number, CarView>();
  private ball: THREE.Mesh;
  private ballShadow: THREE.Mesh;
  private ballIndicator: THREE.Mesh;
  private padsView = new BoostPadsView();
  private boostFx = new ParticleSystem(4000, true);
  private smokeFx = new ParticleSystem(1500, false);
  private burstFx = new ParticleSystem(3000, true);
  private shockwaves: { mesh: THREE.Mesh; t: number; grow?: number }[] = [];
  private time = 0;
  private env: Environment;
  private showcase: CarModel | null = null;
  private showcaseTeam: 0 | 1 = 0;
  private turntable: THREE.Group | null = null;
  private post: PostFx;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.cam = new CameraController(this.camera);

    this.env = setupEnvironment(this.renderer, this.scene);
    this.post = new PostFx(this.renderer, this.scene, this.camera);

    this.scene.add(buildArena().group);

    // Ball
    this.ball = createBallModel();
    this.scene.add(this.ball);
    this.ballShadow = createBlobShadow(BALL.RADIUS * 1.1, 0.55);
    this.scene.add(this.ballShadow);
    this.ballIndicator = new THREE.Mesh(
      new THREE.RingGeometry(BALL.RADIUS * 1.05, BALL.RADIUS * 1.25, 40),
      new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.35, depthWrite: false }),
    );
    this.ballIndicator.rotation.x = -Math.PI / 2;
    this.scene.add(this.ballIndicator);

    this.scene.add(this.padsView.group);

    this.scene.add(this.boostFx.points, this.smokeFx.points, this.burstFx.points);
    this.resize();
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.post.setSize(w, h, this.renderer.getPixelRatio());
    this.cam.updateFov(w / h);
    for (const fx of [this.boostFx, this.smokeFx, this.burstFx]) fx.setViewportHeight(h * this.renderer.getPixelRatio(), this.camera.fov);
  }

  private syncCars(state: GameState, opts: RenderOptions) {
    const ids = new Set(state.cars.map((c) => c.id));
    const localTeam = state.cars.find((c) => c.id === opts.localCarId)?.team ?? null;
    for (const [id, view] of this.cars) {
      if (!ids.has(id)) {
        this.scene.remove(view.model.root, view.shadow, view.name.sprite, ...view.trails.map((t) => t.mesh));
        this.cars.delete(id);
      }
    }
    for (const c of state.cars) {
      let view = this.cars.get(c.id);
      const body = opts.bodyOf?.(c.id) ?? 'octane';
      if (view && view.model.bodyType !== body) {
        this.scene.remove(view.model.root, view.shadow, view.name.sprite, ...view.trails.map((t) => t.mesh));
        this.cars.delete(c.id);
        view = undefined;
      }
      if (!view) {
        const model = createCarModel(c.team, opts.bodyOf?.(c.id));
        const shadow = createBlobShadow(75, 0.45);
        shadow.scale.set(1.5, 1, 1);
        const name = createNameTag(c.name, c.team);
        const trails = [0, 1].map(() => new TrailRibbon(new THREE.Color(1.6, 1.7, 1.9), 3.5));
        this.scene.add(model.root, shadow, name.sprite, ...trails.map((t) => t.mesh));
        view = { model, shadow, name, team: c.team, wheelSpin: 0, steer: 0, trailTimer: 0, smokeTimer: 0, trails };
        this.cars.set(c.id, view);
      }
      if (view.team !== c.team) {
        view.model.setTeam(c.team);
        view.team = c.team;
      }
      view.name.sprite.visible = opts.showNames && c.id !== opts.localCarId && !c.demolished;
      // teammates show their boost under the name, like the real game
      view.name.setBoost(localTeam !== null && c.team === localTeam && c.id !== opts.localCarId ? c.boost : null);
    }
  }

  /** Renders an interpolated frame between `prev` and `curr`. */
  render(prev: GameState, curr: GameState, alpha: number, dt: number, opts: RenderOptions, swivel: { x: number; y: number }) {
    this.time += dt;
    this.syncCars(curr, opts);
    const prevCars = new Map(prev.cars.map((c) => [c.id, c]));

    let localView: { car: CarState; pos: ReturnType<typeof vlerp>; quat: ReturnType<typeof qslerp> } | null = null;
    for (const car of curr.cars) {
      const view = this.cars.get(car.id)!;
      const p = prevCars.get(car.id) ?? car;
      const teleported = vlen({ x: p.pos.x - car.pos.x, y: p.pos.y - car.pos.y, z: p.pos.z - car.pos.z }) > 400;
      const pos = teleported ? car.pos : vlerp(p.pos, car.pos, alpha);
      const quat = teleported ? car.quat : qslerp(p.quat, car.quat, alpha);
      if (car.id === opts.localCarId) localView = { car, pos, quat };

      const root = view.model.root;
      root.visible = !car.demolished;
      toThree(pos, root.position);
      quatToThree(quat, root.quaternion);

      // Wheels: spin with forward speed, front wheels steer
      const fwd = qforward(car.quat);
      const fwdSpeed = car.vel.x * fwd.x + car.vel.y * fwd.y + car.vel.z * fwd.z;
      view.wheelSpin += (fwdSpeed / 14) * dt;
      view.steer += (-car.lastInput.steer * 0.45 - view.steer) * Math.min(1, dt * 12);
      for (const w of view.model.wheels) {
        const spin = w.mesh.children[0];
        spin.rotation.z = -view.wheelSpin;
        if (w.front) w.mesh.rotation.y = view.steer;
      }

      // Boost flame + trail
      const boosting = car.boostingTime > 0 && !car.demolished;
      view.model.setBoost(boosting, this.time);
      if (boosting) {
        view.trailTimer += dt;
        const nozzle = view.model.nozzle.clone().applyQuaternion(root.quaternion).add(root.position);
        const back = new THREE.Vector3(-1, 0, 0).applyQuaternion(root.quaternion);
        const color = car.team === 0 ? new THREE.Color('#5cc8ff') : new THREE.Color('#ffae3d');
        while (view.trailTimer > 1 / 90) {
          view.trailTimer -= 1 / 90;
          this.boostFx.emit({
            pos: nozzle.clone().add(back.clone().multiplyScalar(20)),
            vel: back.clone().multiplyScalar(300 + Math.random() * 200).add(new THREE.Vector3((Math.random() - 0.5) * 60, (Math.random() - 0.5) * 60, (Math.random() - 0.5) * 60)),
            life: 0.35,
            size0: 38,
            size1: 6,
            color,
            drag: 2,
          });
        }
        // grey smoke trailing the flame, like the default boost
        view.smokeTimer += dt;
        while (view.smokeTimer > 1 / 45) {
          view.smokeTimer -= 1 / 45;
          const jitter = new THREE.Vector3((Math.random() - 0.5) * 50, (Math.random() - 0.5) * 50, (Math.random() - 0.5) * 50);
          this.smokeFx.emit({
            pos: nozzle.clone().add(back.clone().multiplyScalar(70)),
            vel: back.clone().multiplyScalar(120 + Math.random() * 80).add(jitter).add(new THREE.Vector3(0, 40, 0)),
            life: 0.9 + Math.random() * 0.4,
            size0: 26,
            size1: 120,
            color: new THREE.Color('#d5d9df').multiplyScalar(0.85 + Math.random() * 0.15),
            drag: 1.6,
            gravity: 60,
            alpha: 0.32,
          });
        }
      }
      // Supersonic: two white wind lines from the rear wheels
      root.updateMatrixWorld();
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(root.quaternion);
      const rear = view.model.wheels.filter((w) => !w.front);
      view.trails.forEach((trail, i) => {
        if (teleported) trail.clear();
        const wheel = rear[i];
        if (!wheel) return;
        const at = wheel.mesh.getWorldPosition(new THREE.Vector3()).add(up.clone().multiplyScalar(-4));
        trail.update(this.time, car.isSupersonic && !car.demolished, at, up);
      });

      // Blob shadow on the closest surface below the car
      this.placeShadow(view.shadow, pos, car.demolished ? 0 : 1, 70);
      view.shadow.rotation.z = Math.atan2(fwd.y, fwd.x);
      view.name.sprite.position.copy(root.position).add(new THREE.Vector3(0, 120, 0));
    }

    // Ball
    const bp = vlerp(prev.ball.pos, curr.ball.pos, alpha);
    const ballVisible = curr.phase !== 'goal' && curr.phase !== 'ended';
    this.ball.visible = ballVisible;
    toThree(bp, this.ball.position);
    const w = curr.ball.angVel;
    const wl = Math.hypot(w.x, w.y, w.z);
    if (wl > 1e-4) {
      const axis = toThreeXYZ(w.x / wl, w.y / wl, w.z / wl);
      this.ball.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(axis, wl * dt));
    }
    this.placeShadow(this.ballShadow, bp, ballVisible ? 1 : 0, 3000);
    this.ballShadow.scale.setScalar(1 + Math.min(1.5, bp.z / 1500));
    (this.ballShadow.material as THREE.MeshBasicMaterial).opacity = ballVisible ? 0.55 * Math.max(0.3, 1 - bp.z / 2500) : 0;
    this.ballIndicator.visible = false;

    this.padsView.update(curr.pads, this.time, dt);

    // Effects
    this.boostFx.update(dt);
    this.smokeFx.update(dt);
    this.burstFx.update(dt);
    for (const s of this.shockwaves) {
      s.t += dt;
      const k = s.t / 0.9;
      s.mesh.scale.setScalar(1 + k * (s.grow ?? 25));
      (s.mesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 0.6 * (1 - k));
    }
    this.shockwaves = this.shockwaves.filter((s) => {
      if (s.t < 0.9) return true;
      this.scene.remove(s.mesh);
      return false;
    });

    // Camera
    if (localView && !localView.car.demolished) {
      this.cam.update(
        dt,
        { pos: localView.pos, quat: localView.quat, vel: localView.car.vel, onGround: localView.car.onGround },
        ballVisible ? bp : null,
        swivel,
      );
    } else if (!localView) {
      this.cam.updateOverview(dt, bp);
    }
    this.env.update(dt);
    this.post.render();
  }

  /** Main-menu garage: the selected car slowly turning on a glowing platform at midfield. */
  renderShowcase(dt: number, body: CarBody, team: 0 | 1) {
    this.time += dt;
    if (!this.turntable) {
      this.turntable = new THREE.Group();
      const disc = new THREE.Mesh(
        new THREE.CylinderGeometry(118, 128, 12, 64),
        new THREE.MeshStandardMaterial({ color: '#1b2030', metalness: 0.85, roughness: 0.25 }),
      );
      disc.position.y = 7;
      disc.receiveShadow = true;
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(122, 3, 8, 96),
        new THREE.MeshStandardMaterial({ color: '#59c3ff', emissive: '#3aa8ff', emissiveIntensity: 3 }),
      );
      ring.rotation.x = Math.PI / 2;
      ring.position.y = 12;
      this.turntable.add(disc, ring);
      this.scene.add(this.turntable);
    }
    this.turntable.visible = true;
    if (!this.showcase || this.showcase.bodyType !== body) {
      if (this.showcase) this.scene.remove(this.showcase.root);
      this.showcase = createCarModel(team, body);
      this.showcase.root.traverse((o) => (o.castShadow = true));
      this.scene.add(this.showcase.root);
      this.showcaseTeam = team;
    }
    if (this.showcaseTeam !== team) {
      this.showcase.setTeam(team);
      this.showcaseTeam = team;
    }
    const ring = this.turntable.children[1] as THREE.Mesh;
    (ring.material as THREE.MeshStandardMaterial).emissive.set(team === 0 ? '#3aa8ff' : '#ff8a2a');
    this.showcase.root.visible = true;
    this.showcase.root.position.set(0, 12 + CAR_REST, 0);
    this.showcase.root.rotation.set(0, this.time * 0.35, 0);
    this.showcase.setBoost(false, this.time);
    for (const v of this.cars.values()) {
      v.model.root.visible = false;
      v.shadow.visible = false;
      v.name.sprite.visible = false;
    }
    this.ball.visible = false;
    this.ballShadow.visible = false;
    this.padsView.update([], this.time, dt);

    // Camera framing: car on the right third of the screen (menu on the left)
    const cam = this.camera;
    cam.position.set(-120, 85, 175);
    cam.up.set(0, 1, 0);
    cam.lookAt(-62, 38, 24);
    this.env.update(dt);
    this.post.render();
  }

  /** Leaves the garage view (call when a match starts). */
  hideShowcase() {
    if (this.showcase) this.showcase.root.visible = false;
    if (this.turntable) this.turntable.visible = false;
  }

  private placeShadow(mesh: THREE.Mesh, p: { x: number; y: number; z: number }, visible: number, maxDist: number) {
    // Project straight down onto the floor (like the game's ball shadow)
    const d = arenaDistance({ x: p.x, y: p.y, z: 50 });
    mesh.visible = visible > 0 && p.z < maxDist && d > 0;
    toThreeXYZ(p.x, p.y, 1.5, mesh.position);
  }

  handleEvents(events: GameEvent[], state: GameState, localCarId: number | null) {
    for (const e of events) {
      switch (e.type) {
        case 'goal': {
          const color = TEAM_COLORS[e.team];
          const pos = toThree(e.pos);
          // team-colored sparks, a two-layer fireball and smoke that rises and spreads
          this.burstFx.burst(pos, 900, 3500, color, 2.2, 140, -600);
          this.burstFx.burst(pos, 300, 1500, new THREE.Color('#ffffff'), 1.5, 90, -300);
          this.burstFx.burst(pos, 260, 900, new THREE.Color(3, 1.6, 0.5), 0.9, 360, 0, 1.6, 0.9);
          this.burstFx.burst(pos, 160, 500, color.clone().multiplyScalar(2.2), 1.2, 300, 0, 2, 0.8);
          this.smokeFx.burst(pos, 160, 700, new THREE.Color('#4a4f5a'), 3.5, 260, 260, 3.2, 0.55);
          // flat shockwave ring sweeping over the floor
          const ring = new THREE.Mesh(
            new THREE.RingGeometry(36, 44, 96),
            new THREE.MeshBasicMaterial({ color: color.clone().multiplyScalar(2), transparent: true, opacity: 0.6, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }),
          );
          ring.rotation.x = -Math.PI / 2;
          ring.position.set(pos.x, 6, pos.z);
          this.scene.add(ring);
          this.shockwaves.push({ mesh: ring, t: 0, grow: 60 });
          const sw = new THREE.Mesh(
            new THREE.SphereGeometry(40, 24, 16),
            new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.6, depthWrite: false, blending: THREE.AdditiveBlending }),
          );
          sw.position.copy(pos);
          this.scene.add(sw);
          this.shockwaves.push({ mesh: sw, t: 0 });
          this.cam.shake(120, 1.2);
          break;
        }
        case 'demo': {
          const pos = toThree(e.pos);
          const victim = state.cars.find((c) => c.id === e.victim);
          const color = victim ? TEAM_COLORS[victim.team] : new THREE.Color('#ffffff');
          this.burstFx.burst(pos, 300, 1600, new THREE.Color('#ffb347'), 1, 90, -400);
          this.burstFx.burst(pos, 100, 900, color, 0.8, 80);
          this.smokeFx.burst(pos, 60, 300, new THREE.Color('#333'), 2, 250, 120);
          if (e.victim === localCarId || e.attacker === localCarId) this.cam.shake(60, 0.5);
          break;
        }
        case 'ballHit': {
          if (e.strength > 600) {
            this.burstFx.burst(toThree(e.pos), Math.min(80, e.strength / 30), 600, new THREE.Color('#fff4cc'), 0.35, 30);
          }
          break;
        }
        case 'boostPickup': {
          const car = state.cars.find((c) => c.id === e.carId);
          if (car && e.big) this.burstFx.burst(toThree(car.pos), 40, 400, new THREE.Color('#ffc640'), 0.5, 40);
          break;
        }
        case 'kickoffReset':
          this.cam.reset();
          break;
        case 'carWallHit':
          break;
      }
    }
  }

  dispose() {
    this.renderer.dispose();
  }
}
