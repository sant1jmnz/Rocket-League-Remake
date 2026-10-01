import * as THREE from 'three';
import { CAR } from '@rl/shared';

// "Battle car" model: original design sized to the Octane hitbox (118 x 84 x 36 uu body, big wheels,
// tall cabin). Built from lofted super-ellipse sections so the body is smooth and glossy.
// Local axes (Three): forward = +X, up = +Y, right = +Z. Origin = car origin (17 uu above ground).

const G = -CAR.REST_HEIGHT; // ground level in local space

export const TEAM_PAINT = [new THREE.Color('#1d5bff'), new THREE.Color('#ff6a00')];
const TEAM_ACCENT = ['#7fd0ff', '#ffd27a'];
const TEAM_DARK = ['#0b2a7a', '#8a2a00'];

interface Station {
  x: number;
  yBottom: number;
  yTop: number;
  wBottom: number;
  wTop: number;
  n: number;
}

/** Lofts rounded sections along X. UV: u along length (rear → front), v around the section. */
function loft(stations: Station[], ring = 40, capEnds = true): THREE.BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const x0 = stations[0].x;
  const x1 = stations[stations.length - 1].x;
  for (const s of stations) {
    for (let i = 0; i <= ring; i++) {
      const v = i / ring;
      // start at the bottom, go up the right side, over the top, down the left side
      const th = -Math.PI / 2 + v * Math.PI * 2;
      const c = Math.cos(th);
      const sn = Math.sin(th);
      const e = 2 / s.n;
      const uu = Math.sign(c) * Math.pow(Math.abs(c), e);
      const vv = Math.sign(sn) * Math.pow(Math.abs(sn), e);
      const t = (vv + 1) / 2; // 0 bottom .. 1 top
      const w = s.wBottom + (s.wTop - s.wBottom) * t;
      const y = s.yBottom + (s.yTop - s.yBottom) * t;
      pos.push(s.x, y, uu * w);
      uv.push((s.x - x0) / (x1 - x0), v);
    }
  }
  const row = ring + 1;
  for (let j = 0; j < stations.length - 1; j++) {
    for (let i = 0; i < ring; i++) {
      const a = j * row + i;
      const b = a + row;
      idx.push(a, a + 1, b, b, a + 1, b + 1);
    }
  }
  if (capEnds) {
    for (const [j, flip] of [
      [0, true],
      [stations.length - 1, false],
    ] as const) {
      const s = stations[j];
      const center = pos.length / 3;
      pos.push(s.x, (s.yBottom + s.yTop) / 2, 0);
      uv.push(j === 0 ? 0 : 1, 0.5);
      for (let i = 0; i < ring; i++) {
        const a = j * row + i;
        if (flip) idx.push(center, a + 1, a);
        else idx.push(center, a, a + 1);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

const smooth = (a: number, b: number, t: number) => {
  const k = Math.max(0, Math.min(1, t));
  return a + (b - a) * k * k * (3 - 2 * k);
};

/** Piecewise smooth profile through control points. */
function profile(points: [number, number][]) {
  return (x: number) => {
    if (x <= points[0][0]) return points[0][1];
    for (let i = 1; i < points.length; i++) {
      const [xa, ya] = points[i - 1];
      const [xb, yb] = points[i];
      if (x <= xb) return smooth(ya, yb, (x - xa) / (xb - xa));
    }
    return points[points.length - 1][1];
  };
}

function bodyStations(): Station[] {
  // Heights above ground
  const bottom = profile([[-48, 10], [-40, 7], [62, 7], [76, 12]]);
  const top = profile([[-48, 38], [-36, 40], [-5, 35], [30, 31], [58, 26], [72, 19], [76, 14]]);
  const width = profile([[-48, 33], [-40, 39], [-34, 41.5], [-20, 40], [20, 39], [48, 41], [62, 39], [76, 30]]);
  const out: Station[] = [];
  const N = 46;
  for (let i = 0; i <= N; i++) {
    const x = -48 + (124 * i) / N;
    const w = width(x);
    out.push({ x, yBottom: G + bottom(x), yTop: G + top(x), wBottom: w - 2, wTop: w - 6, n: 3.2 });
  }
  return out;
}

function cabinStations(): Station[] {
  const top = profile([[-44, 40], [-36, 50], [-24, 56.5], [-2, 56.5], [8, 53], [26, 33]]);
  const base = profile([[-44, 36], [26, 31]]);
  const width = profile([[-44, 28], [-30, 31], [10, 31], [26, 30]]);
  const out: Station[] = [];
  const N = 30;
  for (let i = 0; i <= N; i++) {
    const x = -44 + (70 * i) / N;
    const w = width(x);
    out.push({ x, yBottom: G + base(x) - 2, yTop: G + Math.max(top(x), base(x) + 1), wBottom: w + 2, wTop: w - 8, n: 3.6 });
  }
  return out;
}

function paintTexture(team: 0 | 1): THREE.CanvasTexture {
  const W = 1024;
  const H = 512;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  const base = '#' + TEAM_PAINT[team].getHexString();
  g.fillStyle = base;
  g.fillRect(0, 0, W, H);
  // v (canvas y) = around the section: 0 bottom, 0.25 right side, 0.5 top, 0.75 left side
  const vy = (v: number) => v * H;
  // Twin racing stripes over the top, from the nose to the tail
  g.fillStyle = TEAM_ACCENT[team];
  g.fillRect(0, vy(0.462), W, vy(0.022));
  g.fillRect(0, vy(0.516), W, vy(0.022));
  // Side swoosh
  g.fillStyle = TEAM_DARK[team];
  for (const side of [0.25, 0.75]) {
    g.beginPath();
    const dir = side < 0.5 ? 1 : -1;
    g.moveTo(W * 0.15, vy(side - dir * 0.02));
    g.lineTo(W * 0.92, vy(side - dir * 0.09));
    g.lineTo(W * 0.92, vy(side - dir * 0.05));
    g.lineTo(W * 0.15, vy(side + dir * 0.03));
    g.closePath();
    g.fill();
  }
  // Dark lower sills
  g.fillStyle = '#16181d';
  g.fillRect(0, 0, W, vy(0.09));
  g.fillRect(0, vy(0.91), W, vy(0.09));
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

function tireGeometry(r: number, width: number): THREE.BufferGeometry {
  // Lathe profile (radius, axial) of a chunky tire with rounded shoulders
  const pts: THREE.Vector2[] = [];
  const hw = width / 2;
  const inner = r * 0.62;
  pts.push(new THREE.Vector2(inner, -hw));
  pts.push(new THREE.Vector2(r - 3, -hw));
  for (let i = 0; i <= 6; i++) {
    const a = -Math.PI / 2 + (i / 6) * (Math.PI / 2);
    pts.push(new THREE.Vector2(r - 3 + Math.cos(a) * 3, -hw + 3 + Math.sin(a) * 3));
  }
  for (let i = 0; i <= 6; i++) {
    const a = (i / 6) * (Math.PI / 2);
    pts.push(new THREE.Vector2(r - 3 + Math.cos(a) * 3, hw - 3 + Math.sin(a) * 3));
  }
  pts.push(new THREE.Vector2(inner, hw));
  const geo = new THREE.LatheGeometry(pts, 32);
  geo.rotateX(Math.PI / 2); // lathe axis Y -> Z (wheel axle along car right)
  return geo;
}

function rim(r: number, width: number, mat: THREE.Material, dark: THREE.Material): THREE.Group {
  const g = new THREE.Group();
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.64, r * 0.64, width * 0.8, 24, 1, true), dark);
  barrel.rotation.x = Math.PI / 2;
  g.add(barrel);
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.2, r * 0.24, width * 0.9, 12), mat);
  hub.rotation.x = Math.PI / 2;
  g.add(hub);
  for (let i = 0; i < 5; i++) {
    const spoke = new THREE.Mesh(new THREE.BoxGeometry(r * 0.16, r * 0.62, 2.2), mat);
    spoke.position.y = r * 0.31;
    const pivot = new THREE.Group();
    pivot.rotation.z = (i / 5) * Math.PI * 2;
    pivot.add(spoke);
    for (const side of [-1, 1]) {
      const p = pivot.clone();
      p.position.z = side * (width * 0.38);
      g.add(p);
    }
  }
  return g;
}

export interface CarModel {
  root: THREE.Group;
  body: THREE.Group;
  wheels: { mesh: THREE.Object3D; front: boolean; radius: number }[];
  flame: THREE.Group;
  nozzle: THREE.Vector3;
  setTeam(team: 0 | 1): void;
  setBoost(on: boolean, t: number): void;
}

const geoCache: Record<string, THREE.BufferGeometry> = {};
const cached = (k: string, f: () => THREE.BufferGeometry) => (geoCache[k] ??= f());

export function createCarModel(team: 0 | 1): CarModel {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);

  const textures = [paintTexture(0), paintTexture(1)];
  const paint = new THREE.MeshPhysicalMaterial({
    map: textures[team],
    metalness: 0.35,
    roughness: 0.32,
    clearcoat: 1,
    clearcoatRoughness: 0.08,
  });
  const glass = new THREE.MeshPhysicalMaterial({ color: '#070b14', metalness: 0.2, roughness: 0.05, clearcoat: 1, clearcoatRoughness: 0.02 });
  const plastic = new THREE.MeshStandardMaterial({ color: '#15171c', metalness: 0.2, roughness: 0.65 });
  const chrome = new THREE.MeshStandardMaterial({ color: '#d7dde6', metalness: 1, roughness: 0.18 });
  const darkMetal = new THREE.MeshStandardMaterial({ color: '#2a2e36', metalness: 0.8, roughness: 0.35 });
  const headlight = new THREE.MeshStandardMaterial({ color: '#ffffff', emissive: '#fff4d6', emissiveIntensity: 4 });
  const taillight = new THREE.MeshStandardMaterial({ color: '#ff1a1a', emissive: '#ff1010', emissiveIntensity: 3 });
  const accentGlow = new THREE.MeshStandardMaterial({ color: TEAM_ACCENT[team], emissive: TEAM_ACCENT[team], emissiveIntensity: 2.2 });

  const shell = new THREE.Mesh(cached('body', () => loft(bodyStations())), paint);
  shell.castShadow = true;
  body.add(shell);
  const cabin = new THREE.Mesh(cached('cabin', () => loft(cabinStations(), 32)), glass);
  cabin.castShadow = true;
  body.add(cabin);
  // Roof panel (paint) over the glass, like a real car roof
  const roofStations = cabinStations()
    .filter((s) => s.x > -30 && s.x < 4)
    .map((s) => ({ ...s, yBottom: s.yTop - 3, yTop: s.yTop + 0.6, wBottom: s.wTop + 1.5, wTop: s.wTop - 0.5, n: 4 }));
  const roof = new THREE.Mesh(cached('roof', () => loft(roofStations, 24)), paint);
  body.add(roof);

  // Wheel arches (fender flares)
  const archGeo = (r: number) => cached(`arch${r}`, () => new THREE.TorusGeometry(r + 4, 3.2, 8, 20, Math.PI));
  CAR.WHEELS.forEach((w, i) => {
    const r = i < 2 ? CAR.FRONT_WHEEL_RADIUS : CAR.BACK_WHEEL_RADIUS;
    const arch = new THREE.Mesh(archGeo(r), plastic);
    arch.position.set(w.x, G + r + 1, -w.y + Math.sign(-w.y) * 9);
    body.add(arch);
  });

  // Front: splitter, grille, headlights
  const splitter = new THREE.Mesh(new THREE.BoxGeometry(12, 3, 70), plastic);
  splitter.position.set(72, G + 8, 0);
  body.add(splitter);
  const grille = new THREE.Mesh(new THREE.BoxGeometry(3, 7, 40), darkMetal);
  grille.position.set(74.5, G + 14, 0);
  body.add(grille);
  for (const sz of [-1, 1]) {
    const hl = new THREE.Mesh(new THREE.BoxGeometry(6, 3, 13), headlight);
    hl.position.set(70, G + 21, sz * 22);
    hl.rotation.z = -0.35;
    body.add(hl);
    const drl = new THREE.Mesh(new THREE.BoxGeometry(2, 1.5, 9), accentGlow);
    drl.position.set(73.5, G + 17, sz * 27);
    body.add(drl);
  }
  // Rear: diffuser, taillights, spoiler
  const diffuser = new THREE.Mesh(new THREE.BoxGeometry(10, 8, 64), plastic);
  diffuser.position.set(-46, G + 13, 0);
  body.add(diffuser);
  for (const sz of [-1, 1]) {
    const tl = new THREE.Mesh(new THREE.BoxGeometry(2, 4, 18), taillight);
    tl.position.set(-48.5, G + 32, sz * 22);
    body.add(tl);
  }
  const wing = new THREE.Mesh(new THREE.BoxGeometry(13, 2.4, 74), paint);
  wing.position.set(-44, G + 55, 0);
  wing.rotation.z = 0.12;
  body.add(wing);
  for (const sz of [-1, 1]) {
    const strut = new THREE.Mesh(new THREE.BoxGeometry(6, 13, 2.4), plastic);
    strut.position.set(-41, G + 48, sz * 22);
    body.add(strut);
    const plate = new THREE.Mesh(new THREE.BoxGeometry(15, 8, 1.6), plastic);
    plate.position.set(-44, G + 54, sz * 37.5);
    body.add(plate);
  }

  // Rocket nozzle
  const nozzle = new THREE.Vector3(-51, G + 22, 0);
  const noz = new THREE.Mesh(new THREE.CylinderGeometry(8, 10, 10, 20, 1, true), darkMetal);
  noz.rotation.z = Math.PI / 2;
  noz.position.copy(nozzle);
  body.add(noz);
  const nozInner = new THREE.Mesh(
    new THREE.CircleGeometry(7.5, 20),
    new THREE.MeshStandardMaterial({ color: '#331100', emissive: team === 0 ? '#3aa0ff' : '#ff8a20', emissiveIntensity: 0.6 }),
  );
  nozInner.rotation.y = -Math.PI / 2;
  nozInner.position.set(nozzle.x - 1, nozzle.y, 0);
  body.add(nozInner);

  // Boost flame: hot white core + team-colored outer flame (bright enough to bloom)
  const flame = new THREE.Group();
  const coreMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(4, 3.6, 3), transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false });
  const outerMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.4, 1.4, 4), transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false });
  const core = new THREE.Mesh(new THREE.ConeGeometry(5, 34, 16, 1, true), coreMat);
  const outer = new THREE.Mesh(new THREE.ConeGeometry(9, 70, 16, 1, true), outerMat);
  core.rotation.z = Math.PI / 2;
  outer.rotation.z = Math.PI / 2;
  core.position.x = -17;
  outer.position.x = -35;
  flame.add(outer, core);
  flame.position.set(nozzle.x - 4, nozzle.y, 0);
  flame.visible = false;
  body.add(flame);

  // Wheels
  const wheels: CarModel['wheels'] = [];
  const tireMat = new THREE.MeshStandardMaterial({ color: '#141414', roughness: 0.85 });
  CAR.WHEELS.forEach((w, i) => {
    const front = i < 2;
    const r = front ? CAR.FRONT_WHEEL_RADIUS + 1.5 : CAR.BACK_WHEEL_RADIUS + 1.5;
    const ww = front ? 13 : 16;
    const pivot = new THREE.Group();
    pivot.position.set(w.x, G + r, -w.y + Math.sign(-w.y) * 9);
    const spin = new THREE.Group();
    spin.add(new THREE.Mesh(cached(`tire${r}`, () => tireGeometry(r, ww)), tireMat));
    spin.add(rim(r, ww, chrome, darkMetal));
    spin.traverse((o) => (o.castShadow = true));
    pivot.add(spin);
    root.add(pivot);
    wheels.push({ mesh: pivot, front, radius: r });
  });

  return {
    root,
    body,
    wheels,
    flame,
    nozzle,
    setTeam(t: 0 | 1) {
      paint.map = textures[t];
      paint.needsUpdate = true;
      accentGlow.color.set(TEAM_ACCENT[t]);
      accentGlow.emissive.set(TEAM_ACCENT[t]);
      outerMat.color.copy(t === 0 ? new THREE.Color(0.4, 1.4, 4) : new THREE.Color(4, 1.4, 0.3));
      (nozInner.material as THREE.MeshStandardMaterial).emissive.set(t === 0 ? '#3aa0ff' : '#ff8a20');
    },
    setBoost(on: boolean, t: number) {
      flame.visible = on;
      if (!on) return;
      const f = 0.85 + Math.sin(t * 90) * 0.1 + Math.random() * 0.15;
      outer.scale.set(1, f, 1);
      core.scale.set(1, 0.9 + Math.random() * 0.2, 1);
    },
  };
}
