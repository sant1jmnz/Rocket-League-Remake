import * as THREE from 'three';
import {
  BALL,
  BOOST_PADS,
  arenaDistance,
  qforward,
  qslerp,
  vlen,
  vlerp,
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
  createCarModel,
  createNameSprite,
  type CarModel,
} from './models';
import { ParticleSystem } from './particles';
import { CameraController } from '../camera/camera';

interface CarView {
  model: CarModel;
  shadow: THREE.Mesh;
  name: THREE.Sprite;
  team: 0 | 1;
  wheelSpin: number;
  steer: number;
  trailTimer: number;
}

export interface RenderOptions {
  localCarId: number | null;
  /** when true, local inputs drive the wheel steering visuals */
  showNames: boolean;
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
  private pads: { base: THREE.Mesh; orb: THREE.Mesh | null; big: boolean }[] = [];
  private boostFx = new ParticleSystem(4000, true);
  private smokeFx = new ParticleSystem(1500, false);
  private burstFx = new ParticleSystem(3000, true);
  private shockwaves: { mesh: THREE.Mesh; t: number }[] = [];
  private time = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.cam = new CameraController(this.camera);

    // Sky gradient
    const sky = document.createElement('canvas');
    sky.width = 2;
    sky.height = 256;
    const g = sky.getContext('2d')!;
    const grad = g.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0, '#2c5c9e');
    grad.addColorStop(0.55, '#86b6e3');
    grad.addColorStop(1, '#d8c7a6');
    g.fillStyle = grad;
    g.fillRect(0, 0, 2, 256);
    const skyTex = new THREE.CanvasTexture(sky);
    skyTex.colorSpace = THREE.SRGBColorSpace;
    this.scene.background = skyTex;
    this.scene.fog = new THREE.Fog('#9fb6cf', 14000, 40000);

    // Lights
    this.scene.add(new THREE.HemisphereLight('#dbe8ff', '#3a4a2a', 1.1));
    const sun = new THREE.DirectionalLight('#fff2d6', 2.2);
    sun.position.set(3000, 9000, 2500);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera as THREE.OrthographicCamera;
    sc.left = -6500;
    sc.right = 6500;
    sc.top = 7000;
    sc.bottom = -7000;
    sc.near = 100;
    sc.far = 20000;
    sun.shadow.bias = -0.0005;
    this.scene.add(sun);
    // Fill light from the opposite side so cars facing away from the sun keep their colors
    const fill = new THREE.DirectionalLight('#cfe0ff', 0.9);
    fill.position.set(-3000, 6000, -4000);
    this.scene.add(fill);

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

    // Boost pads
    const smallMat = new THREE.MeshStandardMaterial({ color: '#ffcf4a', emissive: '#ffb000', emissiveIntensity: 1.2 });
    const bigMat = new THREE.MeshStandardMaterial({ color: '#ffd35a', emissive: '#ff9a00', emissiveIntensity: 1.6 });
    const baseMat = new THREE.MeshStandardMaterial({ color: '#3a3f48', metalness: 0.6, roughness: 0.4 });
    for (const p of BOOST_PADS) {
      const base = new THREE.Mesh(
        new THREE.CylinderGeometry(p.big ? 150 : 46, p.big ? 165 : 54, 6, 24),
        p.big ? baseMat : smallMat.clone(),
      );
      toThreeXYZ(p.x, p.y, 4, base.position);
      this.scene.add(base);
      let orb: THREE.Mesh | null = null;
      if (p.big) {
        orb = new THREE.Mesh(new THREE.SphereGeometry(70, 20, 14), bigMat.clone());
        toThreeXYZ(p.x, p.y, 110, orb.position);
        this.scene.add(orb);
        const ring = new THREE.Mesh(new THREE.TorusGeometry(130, 10, 8, 32), bigMat);
        ring.rotation.x = Math.PI / 2;
        toThreeXYZ(p.x, p.y, 10, ring.position);
        this.scene.add(ring);
      }
      this.pads.push({ base, orb, big: p.big });
    }

    this.scene.add(this.boostFx.points, this.smokeFx.points, this.burstFx.points);
    this.resize();
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.cam.updateFov(w / h);
    for (const fx of [this.boostFx, this.smokeFx, this.burstFx]) fx.setViewportHeight(h * this.renderer.getPixelRatio(), this.camera.fov);
  }

  private syncCars(state: GameState, opts: RenderOptions) {
    const ids = new Set(state.cars.map((c) => c.id));
    for (const [id, view] of this.cars) {
      if (!ids.has(id)) {
        this.scene.remove(view.model.root, view.shadow, view.name);
        this.cars.delete(id);
      }
    }
    for (const c of state.cars) {
      let view = this.cars.get(c.id);
      if (!view) {
        const model = createCarModel(c.team);
        const shadow = createBlobShadow(75, 0.45);
        shadow.scale.set(1.5, 1, 1);
        const name = createNameSprite(c.name, c.team === 0 ? '#9fd0ff' : '#ffc890');
        this.scene.add(model.root, shadow, name);
        view = { model, shadow, name, team: c.team, wheelSpin: 0, steer: 0, trailTimer: 0 };
        this.cars.set(c.id, view);
      }
      if (view.team !== c.team) {
        view.model.setTeam(c.team);
        view.team = c.team;
      }
      view.name.visible = opts.showNames && c.id !== opts.localCarId && !c.demolished;
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
      view.model.flame.visible = boosting;
      if (boosting) {
        const s = 0.8 + Math.random() * 0.5;
        view.model.flame.scale.set(1, s, 1);
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
      }
      // Supersonic streaks
      if (car.isSupersonic && !car.demolished && Math.random() < 0.6) {
        const side = new THREE.Vector3(0, (Math.random() - 0.3) * 40, (Math.random() < 0.5 ? -1 : 1) * 40).applyQuaternion(root.quaternion);
        this.boostFx.emit({
          pos: root.position.clone().add(side),
          vel: new THREE.Vector3(),
          life: 0.25,
          size0: 14,
          size1: 2,
          color: new THREE.Color('#ffffff'),
        });
      }

      // Blob shadow on the closest surface below the car
      this.placeShadow(view.shadow, pos, car.demolished ? 0 : 1, 70);
      view.shadow.rotation.z = Math.atan2(fwd.y, fwd.x);
      view.name.position.copy(root.position).add(new THREE.Vector3(0, 130, 0));
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

    // Pads
    curr.pads.forEach((t, i) => {
      const pad = this.pads[i];
      const active = t <= 0;
      if (pad.orb) {
        pad.orb.visible = active;
        pad.orb.position.y = 110 + Math.sin(this.time * 2 + i) * 8;
        pad.orb.rotation.y += dt;
      } else {
        (pad.base.material as THREE.MeshStandardMaterial).emissiveIntensity = active ? 1.4 : 0.05;
      }
    });

    // Effects
    this.boostFx.update(dt);
    this.smokeFx.update(dt);
    this.burstFx.update(dt);
    for (const s of this.shockwaves) {
      s.t += dt;
      const k = s.t / 0.9;
      s.mesh.scale.setScalar(1 + k * 25);
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
    this.renderer.render(this.scene, this.camera);
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
          this.burstFx.burst(pos, 900, 3500, color, 2.2, 140, -600);
          this.burstFx.burst(pos, 300, 1500, new THREE.Color('#ffffff'), 1.5, 90, -300);
          this.smokeFx.burst(pos, 120, 600, new THREE.Color('#555a66'), 3, 400, 80);
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
