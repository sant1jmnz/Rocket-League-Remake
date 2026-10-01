import * as THREE from 'three';
import { CAR, type CarBody } from '@rl/shared';

// Car bodies modelled in code after the two most played cars, Octane and Fennec (both use the
// Octane hitbox: 118 x 84 x 36 uu). Bodies are lofted super-ellipse sections: a low exponent gives
// the Octane's rounded shapes, a high one the Fennec's boxy panels.
// Local axes (Three): forward = +X, up = +Y, right = +Z. Origin = car origin (17 uu above ground).

const G = -CAR.REST_HEIGHT; // ground level in local space

export const TEAM_PAINT = [new THREE.Color('#1d5bff'), new THREE.Color('#ff6a00')];
const TEAM_ACCENT = ['#7fd0ff', '#ffd27a'];

interface Station {
  x: number;
  yBottom: number;
  yTop: number;
  wBottom: number;
  wTop: number;
  n: number;
}

/** Lofts rounded sections along X. UV: u along length (rear → front), v around the section. */
function loft(stations: Station[], ring = 40, capEnds = true, v0 = 0, v1 = 1): THREE.BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const x0 = stations[0].x;
  const x1 = stations[stations.length - 1].x;
  for (const s of stations) {
    for (let i = 0; i <= ring; i++) {
      const v = v0 + ((v1 - v0) * i) / ring;
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
      // counter-clockwise seen from outside (normals point outwards)
      idx.push(a, b, a + 1, b, b + 1, a + 1);
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
        if (flip) idx.push(center, a, a + 1);
        else idx.push(center, a + 1, a);
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

/** Piecewise linear profile (crisp edges for boxy bodies). */
function linear(points: [number, number][]) {
  return (x: number) => {
    if (x <= points[0][0]) return points[0][1];
    for (let i = 1; i < points.length; i++) {
      const [xa, ya] = points[i - 1];
      const [xb, yb] = points[i];
      if (x <= xb) return ya + ((yb - ya) * (x - xa)) / (xb - xa);
    }
    return points[points.length - 1][1];
  };
}

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
  // Dark lower sills
  g.fillStyle = '#16181d';
  g.fillRect(0, 0, W, vy(0.05));
  g.fillRect(0, vy(0.95), W, vy(0.05));
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



interface Mats {
  paint: THREE.Material;
  glass: THREE.Material;
  plastic: THREE.Material;
  darkMetal: THREE.Material;
  headlight: THREE.Material;
  taillight: THREE.Material;
  accentGlow: THREE.Material;
}

interface Design {
  body(): Station[];
  cabin(): Station[];
  roofRange: [number, number];
  frontR: number;
  rearR: number;
  frontW: number;
  rearW: number;
  wheelOut: number;
  arch: 'round' | 'box';
  nozzle: THREE.Vector3;
  parts(add: (o: THREE.Object3D) => void, m: Mats): void;
}

const box = (w: number, h: number, d: number, mat: THREE.Material, x: number, y: number, z: number, rz = 0) => {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  mesh.position.set(x, G + y, z);
  mesh.rotation.z = rz;
  mesh.castShadow = true;
  return mesh;
};

function stationsFrom(
  x0: number,
  x1: number,
  n: number,
  bottom: (x: number) => number,
  top: (x: number) => number,
  width: (x: number) => number,
  shrinkTop: number,
  exp: number,
): Station[] {
  const out: Station[] = [];
  for (let i = 0; i <= n; i++) {
    const x = x0 + ((x1 - x0) * i) / n;
    const w = width(x);
    out.push({ x, yBottom: G + bottom(x), yTop: G + Math.max(top(x), bottom(x) + 1), wBottom: w - 1, wTop: w - shrinkTop, n: exp });
  }
  return out;
}

const DESIGNS: Record<CarBody, Design> = {
  // Rounded "hot-wheels" body: low pointed nose, tall bubble canopy set back, pinched waist,
  // wide hips over big rear wheels, wing over the tail and a single central exhaust.
  octane: {
    body: () =>
      stationsFrom(
        -47,
        76,
        48,
        profile([[-47, 12], [-40, 8], [64, 8], [76, 13]]),
        profile([[-47, 45], [-38, 47], [-28, 45], [-6, 40], [22, 36], [50, 32], [66, 25], [76, 15]]),
        profile([[-47, 35], [-40, 42.5], [-31, 43.5], [-16, 38], [10, 36.5], [42, 40], [56, 39], [70, 32], [76, 25]]),
        5,
        3.0,
      ),
    cabin: () =>
      stationsFrom(
        -40,
        23,
        32,
        profile([[-40, 41], [23, 33]]),
        profile([[-40, 44], [-34, 51], [-24, 57.5], [-6, 58], [6, 54.5], [23, 34]]),
        profile([[-40, 27], [-26, 31.5], [0, 31.5], [23, 29]]),
        10,
        3.0,
      ),
    roofRange: [-28, 1],
    frontR: 14,
    rearR: 17.5,
    frontW: 13,
    rearW: 17,
    wheelOut: 2,
    arch: 'round',
    nozzle: new THREE.Vector3(-50, G + 24, 0),
    parts(add, m) {
      // Chin splitter and nose
      add(box(14, 3, 54, m.plastic, 71, 8, 0));
      // Round headlights at the nose corners
      for (const sz of [-1, 1]) {
        const hl = new THREE.Mesh(new THREE.CylinderGeometry(4.5, 4.5, 4, 16), m.headlight);
        hl.rotation.z = Math.PI / 2 - 0.5;
        hl.position.set(70, G + 19.5, sz * 21);
        add(hl);
        // Side intakes behind the front wheels
        add(box(14, 7, 2, m.plastic, 28, 22, sz * 37.5));
        add(box(9, 4, 2.2, m.accentGlow, 30, 22, sz * 37.8));
        // Tail lights
        add(box(2, 5, 12, m.taillight, -47.5, 36, sz * 23));
      }
      // Rear wing: blade on two side plates over the tail
      const wing = box(14, 2.4, 80, m.paint, -43, 54, 0, 0.1);
      add(wing);
      for (const sz of [-1, 1]) add(box(16, 10, 1.8, m.plastic, -42, 50, sz * 39));
      // Rear diffuser
      add(box(8, 9, 60, m.plastic, -46, 14, 0));
    },
  },
  // Boxy retro-rally coupe: flat hood, vertical front face, square fender flares, upright straight
  // windshield, flat roof with a roof-edge spoiler and a near-vertical rear hatch.
  fennec: {
    body: () =>
      stationsFrom(
        -47,
        76,
        48,
        linear([[-47, 10], [-44, 9], [72, 9], [76, 11]]),
        linear([[-47, 40], [-44, 41.5], [24, 33.5], [68, 29.5], [74, 27.5], [76, 24]]),
        linear([[-47, 39], [-44, 40.5], [70, 40.5], [76, 37.5]]),
        3,
        7,
      ),
    cabin: () =>
      stationsFrom(
        -44,
        24,
        30,
        linear([[-44, 40], [24, 33]]),
        linear([[-44, 41], [-42.5, 54], [-38, 56], [2, 56.5], [24, 34]]),
        linear([[-44, 33], [24, 34]]),
        6,
        8,
      ),
    roofRange: [-40, 2],
    frontR: 15,
    rearR: 16.5,
    frontW: 14,
    rearW: 16,
    wheelOut: 6,
    arch: 'box',
    nozzle: new THREE.Vector3(-50, G + 21, 0),
    parts(add, m) {
      // Big front bumper, grille slot and wide rectangular headlights
      add(box(10, 9, 82, m.plastic, 72, 12, 0));
      add(box(2, 4, 34, m.darkMetal, 76.5, 20, 0));
      for (const sz of [-1, 1]) {
        add(box(2.2, 4.5, 16, m.headlight, 76.2, 24, sz * 26));
        add(box(2.4, 1.6, 12, m.accentGlow, 77, 16.5, sz * 30));
        // Hood vents
        add(box(16, 1, 5, m.darkMetal, 46, 31.5, sz * 12, 0.06));
      }
      // Side skirts
      for (const sz of [-1, 1]) add(box(70, 5, 2.5, m.plastic, 8, 11, sz * 41));
      // Rear: light bar, bumper, roof spoiler
      add(box(2, 4, 66, m.taillight, -47.6, 34, 0));
      add(box(8, 10, 80, m.plastic, -45, 13, 0));
      add(box(12, 2.2, 66, m.paint, -42, 57.5, 0, -0.18));
      for (const sz of [-1, 1]) add(box(6, 4, 2, m.plastic, -40, 55.5, sz * 30));
    },
  },
};

export interface CarModel {
  root: THREE.Group;
  body: THREE.Group;
  bodyType: CarBody;
  wheels: { mesh: THREE.Object3D; front: boolean; radius: number }[];
  flame: THREE.Group;
  nozzle: THREE.Vector3;
  setTeam(team: 0 | 1): void;
  setBoost(on: boolean, t: number): void;
}

const geoCache: Record<string, THREE.BufferGeometry> = {};
const cached = (k: string, f: () => THREE.BufferGeometry) => (geoCache[k] ??= f());
const texCache: Record<number, THREE.CanvasTexture> = {};
const teamTexture = (t: 0 | 1) => (texCache[t] ??= paintTexture(t));

export function createCarModel(team: 0 | 1, bodyType: CarBody = 'octane'): CarModel {
  const d = DESIGNS[bodyType] ?? DESIGNS.octane;
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const add = (o: THREE.Object3D) => body.add(o);

  const paint = new THREE.MeshPhysicalMaterial({ map: teamTexture(team), metalness: 0.35, roughness: 0.32, clearcoat: 1, clearcoatRoughness: 0.08 });
  const accentGlow = new THREE.MeshStandardMaterial({ color: TEAM_ACCENT[team], emissive: TEAM_ACCENT[team], emissiveIntensity: 2.2 });
  const m: Mats = {
    paint,
    glass: new THREE.MeshPhysicalMaterial({ color: '#070b14', metalness: 0.2, roughness: 0.05, clearcoat: 1, clearcoatRoughness: 0.02 }),
    plastic: new THREE.MeshStandardMaterial({ color: '#15171c', metalness: 0.2, roughness: 0.65 }),
    darkMetal: new THREE.MeshStandardMaterial({ color: '#2a2e36', metalness: 0.8, roughness: 0.35 }),
    headlight: new THREE.MeshStandardMaterial({ color: '#ffffff', emissive: '#fff4d6', emissiveIntensity: 4 }),
    taillight: new THREE.MeshStandardMaterial({ color: '#ff1a1a', emissive: '#ff1010', emissiveIntensity: 3 }),
    accentGlow,
  };
  const chrome = new THREE.MeshStandardMaterial({ color: '#8a919c', metalness: 0.9, roughness: 0.3 });

  const shell = new THREE.Mesh(cached(`${bodyType}-body`, () => loft(d.body())), paint);
  shell.castShadow = true;
  add(shell);
  const cabinStations = d.cabin();
  const cabin = new THREE.Mesh(cached(`${bodyType}-cabin`, () => loft(cabinStations, 32)), m.glass);
  cabin.castShadow = true;
  add(cabin);
  // Painted roof: a shell hugging the top of the canopy, leaving the windows dark
  const roofStations = cabinStations
    .filter((s) => s.x >= d.roofRange[0] && s.x <= d.roofRange[1])
    .map((s) => ({ ...s, yTop: s.yTop + 0.7, wBottom: s.wBottom + 0.7, wTop: s.wTop + 0.7 }));
  const roof = new THREE.Mesh(cached(`${bodyType}-roof`, () => loft(roofStations, 24, false, 0.37, 0.63)), paint);
  roof.castShadow = true;
  add(roof);
  d.parts(add, m);

  // Wheels and arches
  const wheels: CarModel['wheels'] = [];
  const tireMat = new THREE.MeshStandardMaterial({ color: '#141414', roughness: 0.85 });
  CAR.WHEELS.forEach((w, i) => {
    const front = i < 2;
    const r = front ? d.frontR : d.rearR;
    const ww = front ? d.frontW : d.rearW;
    const side = Math.sign(-w.y);
    const z = -w.y + side * d.wheelOut;
    if (d.arch === 'round') {
      // Bulging body-colored fender over the top half of the wheel + dark inner liner
      const fw = ww + 5;
      const fender = new THREE.Mesh(
        cached(`fender${r}-${fw}`, () => new THREE.CylinderGeometry(r + 5, r + 5, fw, 24, 1, true, Math.PI - 1.25, 2.5).rotateX(Math.PI / 2)),
        paint,
      );
      fender.position.set(w.x, G + r + 1, z);
      fender.castShadow = true;
      add(fender);
      const lip = new THREE.Mesh(cached(`lip${r}`, () => new THREE.TorusGeometry(r + 5, 1.6, 6, 24, 2.5).rotateZ(Math.PI / 2 - 1.25)), m.plastic);
      lip.position.set(w.x, G + r + 1, z + side * (fw / 2));
      add(lip);
    } else {
      // Square box flare: flat top over the tire plus angled front/back faces
      const fz = z + side * (ww / 2 - 3);
      add(box(r * 2.2, 5, ww + 4, m.paint, w.x, r * 2 + 4, fz - side * 3));
      for (const dx of [-1, 1]) add(box(4, r * 0.9, ww + 4, m.paint, w.x + dx * r * 1.15, r * 1.6, fz - side * 3, dx * 0.35));
    }
    const pivot = new THREE.Group();
    pivot.position.set(w.x, G + r, z);
    const spin = new THREE.Group();
    spin.add(new THREE.Mesh(cached(`tire${r}-${ww}`, () => tireGeometry(r, ww)), tireMat));
    spin.add(rim(r, ww, chrome, m.darkMetal));
    spin.traverse((o) => (o.castShadow = true));
    pivot.add(spin);
    root.add(pivot);
    wheels.push({ mesh: pivot, front, radius: r });
  });

  // Rocket nozzle
  const nozzle = d.nozzle.clone();
  const noz = new THREE.Mesh(new THREE.CylinderGeometry(8, 10, 10, 20, 1, true), m.darkMetal);
  noz.rotation.z = Math.PI / 2;
  noz.position.copy(nozzle);
  add(noz);
  const nozInnerMat = new THREE.MeshStandardMaterial({ color: '#331100', emissive: team === 0 ? '#3aa0ff' : '#ff8a20', emissiveIntensity: 0.6 });
  const nozInner = new THREE.Mesh(new THREE.CircleGeometry(7.5, 20), nozInnerMat);
  nozInner.rotation.y = -Math.PI / 2;
  nozInner.position.set(nozzle.x - 1, nozzle.y, 0);
  add(nozInner);

  // Boost flame: hot white core + team-colored outer flame (bright enough to bloom)
  const flame = new THREE.Group();
  const coreMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(4, 3.6, 3), transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false });
  const outerColor = (t: 0 | 1) => (t === 0 ? new THREE.Color(0.4, 1.4, 4) : new THREE.Color(4, 1.4, 0.3));
  const outerMat = new THREE.MeshBasicMaterial({ color: outerColor(team), transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false });
  const core = new THREE.Mesh(new THREE.ConeGeometry(5, 34, 16, 1, true), coreMat);
  const outer = new THREE.Mesh(new THREE.ConeGeometry(9, 70, 16, 1, true), outerMat);
  core.rotation.z = Math.PI / 2;
  outer.rotation.z = Math.PI / 2;
  core.position.x = -17;
  outer.position.x = -35;
  flame.add(outer, core);
  flame.position.set(nozzle.x - 4, nozzle.y, 0);
  flame.visible = false;
  add(flame);

  return {
    root,
    body,
    bodyType,
    wheels,
    flame,
    nozzle,
    setTeam(t: 0 | 1) {
      paint.map = teamTexture(t);
      paint.needsUpdate = true;
      accentGlow.color.set(TEAM_ACCENT[t]);
      accentGlow.emissive.set(TEAM_ACCENT[t]);
      outerMat.color.copy(outerColor(t));
      nozInnerMat.emissive.set(t === 0 ? '#3aa0ff' : '#ff8a20');
    },
    setBoost(on: boolean, t: number) {
      flame.visible = on;
      if (!on) return;
      outer.scale.set(1, 0.85 + Math.sin(t * 90) * 0.1 + Math.random() * 0.15, 1);
      core.scale.set(1, 0.9 + Math.random() * 0.2, 1);
    },
  };
}
