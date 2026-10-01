import * as THREE from 'three';
import type { CarBody } from '@rl/shared';

// Part-based recreations of the two most played bodies, laid out from measured reference
// proportions (orthographic views on a 10 uu grid). Coordinates are car-local Three space:
// +X forward, +Y up, +Z right, origin = car origin (the ground is at y = -17).
// Only our own procedural geometry lives here: lofts, extrusions and primitives.

export type Surface = 'paint' | 'glass' | 'trim' | 'chrome' | 'light' | 'tail' | 'accent' | 'red';

export interface Part {
  geometry: THREE.BufferGeometry;
  /** single surface, or one per geometry group */
  surface: Surface | Surface[];
  /**
   * Optional per-pixel paint mask (GLSL expression body using `vec3 p` = car-local position) that
   * returns vec2(glass, trim) weights. Gives crisp window outlines independent of mesh density.
   */
  mask?: string;
}

/** GLSL piecewise-linear function through control points. */
export function glslPiecewise(name: string, pts: [number, number][]): string {
  const f = (v: number) => v.toFixed(3);
  let body = `float ${name}(float x) {\n  if (x <= ${f(pts[0][0])}) return ${f(pts[0][1])};\n`;
  for (let i = 1; i < pts.length; i++) {
    const [xa, ya] = pts[i - 1];
    const [xb, yb] = pts[i];
    body += `  if (x <= ${f(xb)}) return mix(${f(ya)}, ${f(yb)}, (x - ${f(xa)}) / ${f(xb - xa)});\n`;
  }
  return body + `  return ${f(pts[pts.length - 1][1])};\n}\n`;
}

/** Smooth 0..1 window between a and b (soft edge e). */
const GLSL_BAND = `float band(float v, float a, float b, float e) { return smoothstep(a - e, a + e, v) * (1.0 - smoothstep(b - e, b + e, v)); }\n`;

export interface Design {
  parts: Part[];
  frontR: number;
  rearR: number;
  frontW: number;
  rearW: number;
  /** wheel hub positions (x, y, |z|) */
  wheels: { x: number; y: number; z: number; front: boolean }[];
  nozzle: THREE.Vector3;
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

const smooth = (a: number, b: number, t: number) => {
  const k = Math.max(0, Math.min(1, t));
  return a + (b - a) * k * k * (3 - 2 * k);
};

/** Smooth piecewise profile through control points. */
export function curve(points: [number, number][]) {
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

/** Linear profile (keeps crisp corners). */
export function lin(points: [number, number][]) {
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

interface LoftSpec {
  x0: number;
  x1: number;
  stations: number;
  ring: number;
  top: (x: number) => number;
  bottom: (x: number) => number;
  /** half width at the top and at the bottom of the section */
  wTop: (x: number) => number;
  wBottom: (x: number) => number;
  /** super-ellipse exponent (2 = round, 6+ = boxy) */
  n: (x: number) => number;
  /** surface of each triangle, by its centroid */
  region?: (x: number, y: number, z: number) => Surface;
  surfaces?: Surface[];
  mask?: string;
}

/** Lofts super-ellipse sections along X, with optional per-triangle surface groups. */
function loft(s: LoftSpec): Part {
  const pos: number[] = [];
  const idx: number[] = [];
  for (let j = 0; j <= s.stations; j++) {
    const x = s.x0 + ((s.x1 - s.x0) * j) / s.stations;
    const top = s.top(x);
    const bot = Math.min(s.bottom(x), top - 0.5);
    const e = 2 / s.n(x);
    for (let i = 0; i <= s.ring; i++) {
      const th = -Math.PI / 2 + (i / s.ring) * Math.PI * 2;
      const c = Math.cos(th);
      const sn = Math.sin(th);
      const u = Math.sign(c) * Math.pow(Math.abs(c), e);
      const v = Math.sign(sn) * Math.pow(Math.abs(sn), e);
      const t = (v + 1) / 2;
      const w = s.wBottom(x) + (s.wTop(x) - s.wBottom(x)) * t;
      pos.push(x, bot + (top - bot) * t, u * w);
    }
  }
  const row = s.ring + 1;
  for (let j = 0; j < s.stations; j++) {
    for (let i = 0; i < s.ring; i++) {
      const a = j * row + i;
      const b = a + row;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  // End caps
  for (const [j, flip] of [
    [0, false],
    [s.stations, true],
  ] as const) {
    const base = j * row;
    let cy = 0;
    for (let i = 0; i <= s.ring; i++) cy += pos[(base + i) * 3 + 1];
    const center = pos.length / 3;
    pos.push(pos[base * 3], cy / row, 0);
    for (let i = 0; i < s.ring; i++) {
      if (flip) idx.push(center, base + i, base + i + 1);
      else idx.push(center, base + i + 1, base + i);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  if (!s.region || !s.surfaces) {
    geo.setIndex(idx);
    geo.computeVertexNormals();
    return { geometry: geo, surface: 'paint', mask: s.mask };
  }
  // Group triangles by surface
  const buckets = s.surfaces.map(() => [] as number[]);
  for (let t = 0; t < idx.length; t += 3) {
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (let k = 0; k < 3; k++) {
      cx += pos[idx[t + k] * 3];
      cy += pos[idx[t + k] * 3 + 1];
      cz += pos[idx[t + k] * 3 + 2];
    }
    const surf = s.region(cx / 3, cy / 3, cz / 3);
    const b = Math.max(0, s.surfaces.indexOf(surf));
    buckets[b].push(idx[t], idx[t + 1], idx[t + 2]);
  }
  const ordered: number[] = [];
  buckets.forEach((b, i) => {
    geo.addGroup(ordered.length, b.length, i);
    ordered.push(...b);
  });
  geo.setIndex(ordered);
  geo.computeVertexNormals();
  return { geometry: geo, surface: s.surfaces };
}

/** Side-view outline extruded across Z (from z0 to z1), with rounded edges. */
function slab(outline: [number, number][], z0: number, z1: number, surface: Surface, bevel = 1.5): Part {
  const shape = new THREE.Shape();
  shape.moveTo(outline[0][0], outline[0][1]);
  for (const p of outline.slice(1)) shape.lineTo(p[0], p[1]);
  shape.closePath();
  const depth = Math.abs(z1 - z0) - bevel * 2;
  const geo = new THREE.ExtrudeGeometry(shape, { depth: Math.max(0.5, depth), bevelEnabled: true, bevelSize: bevel, bevelThickness: bevel, bevelSegments: 2, curveSegments: 12 });
  geo.translate(0, 0, Math.min(z0, z1) + bevel);
  return { geometry: geo, surface };
}

/** Arc points around a center (degrees, counter-clockwise in the side view: 0 = forward). */
function arc(cx: number, cy: number, r: number, a0: number, a1: number, steps = 14): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const a = ((a0 + ((a1 - a0) * i) / steps) * Math.PI) / 180;
    out.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  return out;
}

const mirrorZ = (p: Part): Part => {
  const g = p.geometry.clone();
  g.scale(1, 1, -1);
  // flip winding after mirroring
  const index = g.getIndex();
  if (index) {
    const a = index.array as Uint16Array | Uint32Array;
    for (let i = 0; i < a.length; i += 3) [a[i + 1], a[i + 2]] = [a[i + 2], a[i + 1]];
    index.needsUpdate = true;
  } else {
    const pos = g.getAttribute('position');
    for (let i = 0; i < pos.count; i += 3) {
      for (let k = 0; k < pos.itemSize; k++) {
        const t = pos.getComponent(i + 1, k);
        pos.setComponent(i + 1, k, pos.getComponent(i + 2, k));
        pos.setComponent(i + 2, k, t);
      }
    }
  }
  g.computeVertexNormals();
  return { geometry: g, surface: p.surface };
};

const both = (p: Part): Part[] => [p, mirrorZ(p)];

const boxPart = (w: number, h: number, d: number, x: number, y: number, z: number, surface: Surface, rz = 0, ry = 0): Part => {
  const g = new THREE.BoxGeometry(w, h, d);
  if (ry) g.rotateY(ry);
  if (rz) g.rotateZ(rz);
  g.translate(x, y, z);
  return { geometry: g, surface };
};

const cylX = (r: number, len: number, x: number, y: number, z: number, surface: Surface, seg = 16): Part => {
  const g = new THREE.CylinderGeometry(r, r, len, seg);
  g.rotateZ(Math.PI / 2);
  g.translate(x, y, z);
  return { geometry: g, surface };
};

const cylZ = (r: number, len: number, x: number, y: number, z: number, surface: Surface, seg = 12): Part => {
  const g = new THREE.CylinderGeometry(r, r, len, seg);
  g.rotateX(Math.PI / 2);
  g.translate(x, y, z);
  return { geometry: g, surface };
};

/** Tube between two points. */
const tube = (a: THREE.Vector3, b: THREE.Vector3, r: number, surface: Surface): Part => {
  const len = a.distanceTo(b);
  const g = new THREE.CylinderGeometry(r, r, len, 10);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
  g.applyQuaternion(q);
  const m = a.clone().add(b).multiplyScalar(0.5);
  g.translate(m.x, m.y, m.z);
  return { geometry: g, surface };
};

// ---------------------------------------------------------------------------
// Octane
// ---------------------------------------------------------------------------

const OCT_TOP: [number, number][] = [[-46, 25], [-30, 27], [-16, 30], [-6, 33.5], [12, 33.5], [30, 24.5], [47, 15.5], [60, 11], [70, 7], [78, 2]];

function octane(): Design {
  const frontR = 13.5;
  const rearR = 15.5;
  const fwY = -17 + frontR;
  const rwY = -17 + rearR;
  const parts: Part[] = [];

  // Central fuselage: narrow nose, tall bubble canopy, rear deck with the engine bay
  const top = curve(OCT_TOP);
  parts.push(
    loft({
      x0: -46,
      x1: 78,
      stations: 72,
      ring: 56,
      top,
      bottom: curve([[-46, -5], [-36, -9], [64, -9], [78, -5]]),
      wTop: curve([[-46, 15], [-20, 16], [0, 15.5], [14, 14.5], [32, 13.5], [50, 12], [66, 11], [78, 8]]),
      wBottom: curve([[-46, 20], [-30, 23.5], [0, 24], [30, 24], [48, 22], [66, 19], [78, 15]]),
      n: () => 2.7,
      // Windshield on the canopy front, side windows on its flanks, dark sills
      mask:
        GLSL_BAND +
        glslPiecewise('topO', OCT_TOP) +
        `vec2 carMask(vec3 p) {
          float t = topO(p.x);
          float ws = band(p.x, 13.0, 46.0, 0.4) * smoothstep(t - 6.4, t - 5.6, p.y) * (1.0 - smoothstep(12.0, 12.8, abs(p.z)));
          float sw = band(p.x, -3.0, 28.0, 0.4) * band(p.y, 22.0, t - 1.6, 0.35) * smoothstep(8.6, 9.4, abs(p.z));
          float tr = 1.0 - smoothstep(-6.0, -5.2, p.y);
          return vec2(max(ws, sw), tr);
        }`,
    }),
  );

  // Front fenders: curved blades over the front wheels, standing off the nose
  // (low, flat blades: front tip low, highest just behind the wheel center)
  const ff: [number, number][] = [
    [33, 3],
    [38, 8.5],
    [48, 11.5],
    [58, 11.5],
    [67, 9],
    [74, 4],
    [76.5, 0.5],
    [73, 0.5],
    [65, 5.5],
    [57, 8],
    [48, 8],
    [40, 5.5],
    [35, 1],
  ];
  parts.push(...both(slab(ff, 19.5, 35, 'paint', 1.4)));
  parts.push(...both(slab([[35, 1], [40, 5.5], [48, 8], [57, 8], [65, 5.5], [73, 0.5], [72, -0.5], [64, 4.5], [57, 7], [48, 7], [40, 4.5], [36, 0]], 21, 34.5, 'trim', 0.4)));

  // Rear side pods: big swoosh panels over the rear wheels, sweeping down to the sill
  const rp: [number, number][] = [
    [-52, 20],
    [-38, 23.5],
    [-24, 23],
    [-12, 17],
    [-2, 5],
    [6, -8],
    [-4, -9.5],
    ...arc(-33.75, rwY, rearR + 3.5, 10, 180, 14),
    [-52, rwY],
  ];
  parts.push(...both(slab(rp, 23, 36.5, 'paint', 1.8)));
  parts.push(...both(slab([...arc(-33.75, rwY, rearR + 4, 10, 180, 14), ...arc(-33.75, rwY, rearR + 2.5, 180, 10, 14)], 26, 36, 'trim', 0.6)));

  // Exposed engine: dark block, two red tanks, top air scoop and exhausts
  parts.push(boxPart(30, 9, 20, -30, 21, 0, 'trim'));
  for (const z of [-8, 8]) {
    parts.push(cylX(4.6, 26, -30, 26.5, z, 'red'));
    parts.push(cylX(1.6, 10, -48, 12, z * 0.9, 'chrome'));
  }
  parts.push(boxPart(15, 7, 15, -9, 36, 0, 'trim'));
  parts.push(boxPart(3, 5, 12, -1.5, 36, 0, 'chrome'));
  // Roof fins on the rear deck
  for (const z of [-9, -4.5, 0, 4.5, 9]) parts.push(boxPart(5, 3.5, 1.2, -16, 31.5, z, 'trim', 0.4));

  // Front tube bumper with round headlights and grille
  parts.push(cylZ(1.8, 44, 77, -2.5, 0, 'trim'));
  parts.push(cylZ(1.5, 36, 75.5, 6, 0, 'trim'));
  for (const z of [-10, 10]) parts.push(tube(new THREE.Vector3(77, -8, z), new THREE.Vector3(75.5, 6, z), 1.5, 'trim'));
  parts.push(boxPart(4, 9, 22, 74, 1, 0, 'trim'));
  for (const z of [-17.5, 17.5]) {
    parts.push(cylX(4.4, 4, 75.5, 1.5, z, 'trim'));
    parts.push(cylX(3.3, 4.4, 76, 1.5, z, 'light'));
  }

  // Tall rear wing on a swan-neck post
  const wing = new THREE.Shape();
  wing.moveTo(-58, 40);
  wing.lineTo(-44, 42.5);
  wing.lineTo(-43, 44);
  wing.lineTo(-58, 42.2);
  wing.closePath();
  const wg = new THREE.ExtrudeGeometry(wing, { depth: 62, bevelEnabled: true, bevelSize: 0.8, bevelThickness: 0.8, bevelSegments: 1 });
  wg.translate(0, 0, -31);
  parts.push({ geometry: wg, surface: 'paint' });
  for (const z of [-31.5, 31.5]) parts.push(boxPart(15, 9, 1.4, -51, 38, z, 'paint', 0.15));
  parts.push(tube(new THREE.Vector3(-40, 25, 0), new THREE.Vector3(-44, 36, 0), 1.6, 'trim'));
  parts.push(tube(new THREE.Vector3(-44, 36, 0), new THREE.Vector3(-49, 41.5, 0), 1.6, 'trim'));
  // Tail lights on the pods
  for (const z of [-30, 30]) parts.push(boxPart(1.5, 3, 6, -52.5, 18, z, 'tail'));

  return {
    parts,
    frontR,
    rearR,
    frontW: 12,
    rearW: 15,
    wheels: [
      { x: 51.25, y: fwY, z: 28.7, front: true },
      { x: -33.75, y: rwY, z: 31.7, front: false },
    ],
    nozzle: new THREE.Vector3(-47, 14, 0),
  };
}

// ---------------------------------------------------------------------------
// Fennec
// ---------------------------------------------------------------------------

const FEN_ROOF: [number, number][] = [[-59.5, 28], [-56, 33.2], [-2, 33.8], [4, 33.2], [26, 17.6]];

function fennec(): Design {
  const frontR = 14;
  const rearR = 14.5;
  const fwY = -17 + frontR;
  const rwY = -17 + rearR;
  const parts: Part[] = [];

  // Lower body: long flat hood, vertical nose and tail; widens towards the shoulder line
  const hood = lin([[-61, 15], [-58, 17], [22, 18], [30, 17.5], [62, 14], [72, 12.5], [77, 11], [78.5, 8]]);
  parts.push(
    loft({
      x0: -61.5,
      x1: 78.5,
      stations: 70,
      ring: 48,
      top: hood,
      bottom: lin([[-61.5, -6], [-59, -11], [74, -11], [78.5, -6]]),
      wTop: lin([[-61.5, 28], [-58, 30.5], [70, 30.5], [78.5, 27]]),
      wBottom: lin([[-61.5, 22], [-56, 23], [72, 23], [78.5, 21]]),
      n: () => 7,
      mask: `vec2 carMask(vec3 p) { return vec2(0.0, 1.0 - smoothstep(-7.4, -6.6, p.y)); }`,
    }),
  );

  // Greenhouse: flat roof from the tail to the top of a big straight windshield
  const roof = lin(FEN_ROOF);
  parts.push(
    loft({
      x0: -59.5,
      x1: 26,
      stations: 60,
      ring: 48,
      top: roof,
      bottom: () => 15.5,
      wTop: lin([[-59.5, 19], [-54, 20.5], [0, 20.5], [26, 23]]),
      wBottom: lin([[-59.5, 27], [-54, 28], [20, 28.5], [26, 28.5]]),
      n: () => 5,
      // Big windshield, side windows (B-pillar in the middle) ending at a thick C-pillar, rear glass
      mask:
        GLSL_BAND +
        glslPiecewise('roofF', FEN_ROOF) +
        `vec2 carMask(vec3 p) {
          float t = roofF(p.x);
          float ws = band(p.x, 5.0, 25.0, 0.3) * smoothstep(19.0, 19.8, p.y) * (1.0 - smoothstep(21.5, 22.3, abs(p.z))) * smoothstep(t - 6.4, t - 5.6, p.y);
          float side = band(p.x, -37.0, 3.0, 0.35) * band(p.y, 20.0, t - 1.8, 0.35) * smoothstep(14.6, 15.4, abs(p.z));
          float pillar = band(p.x, -18.5, -16.0, 0.3);
          float rear = (1.0 - smoothstep(-57.4, -56.6, p.x)) * band(p.y, 20.0, 31.0, 0.35) * (1.0 - smoothstep(17.0, 17.8, abs(p.z)));
          return vec2(max(max(ws, side * (1.0 - pillar)), rear), side * pillar);
        }`,
    }),
  );

  // Round flared arches + lower side skirts (body color), black liners
  for (const [cx, cy, r, z0, z1] of [
    [48.8, fwY, frontR, 23, 33],
    [-36.5, rwY, rearR, 24, 34],
  ] as const) {
    const outline: [number, number][] = [...arc(cx, cy, r + 4, -8, 188, 20), ...arc(cx, cy, r + 1.6, 188, -8, 20)];
    parts.push(...both(slab(outline, z0, z1, 'paint', 1.2)));
    parts.push(...both(slab([...arc(cx, cy, r + 2, -8, 188, 18), ...arc(cx, cy, r + 1.2, 188, -8, 18)], z0 + 2, z1, 'trim', 0.4)));
  }
  // Sill panel between the wheels with a black lower strip and side vents
  parts.push(...both(slab([[-17, -10], [28, -10], [28, 9], [-17, 9]], 27, 32.5, 'paint', 1.2)));
  parts.push(...both(boxPart(46, 2.5, 1.2, 5, -7.5, 32.6, 'trim')));
  parts.push(...both(slab([[17, 0], [21, 0], [23, 13], [19, 13]], 30.8, 32.8, 'trim', 0.3)));
  parts.push(...both(slab([[-16, -2], [-12, -2], [-10, 12], [-14, 12]], 30.8, 32.8, 'trim', 0.3)));

  // Front: wide dark grille, round headlights, low bumper, hood bulge
  parts.push(boxPart(2.5, 9, 30, 78, 3.5, 0, 'trim'));
  for (let i = 0; i < 4; i++) parts.push(boxPart(2.8, 0.8, 26, 78.2, 0.5 + i * 2.2, 0, 'chrome'));
  for (const z of [-22, 22]) {
    parts.push(cylX(4.6, 2.5, 77.6, 4, z, 'trim'));
    parts.push(cylX(3.6, 3, 78, 4, z, 'light'));
    parts.push(boxPart(2.5, 2.4, 4, 78, 4, z * 0.75, 'accent'));
  }
  parts.push(boxPart(5, 5, 60, 76.5, -8.5, 0, 'trim'));
  parts.push(slab([[34, 17.4], [66, 13.6], [66, 15.6], [40, 19.6]], -9, 9, 'paint', 1.2));
  parts.push(boxPart(8, 1.2, 9, 42, 19.4, 0, 'trim', -0.12));

  // Rear: light bar, bumper, roof spoiler
  parts.push(boxPart(1.5, 3.5, 52, -61.8, 11, 0, 'tail'));
  parts.push(boxPart(4, 6, 58, -60.5, -6, 0, 'trim'));
  parts.push(boxPart(13, 2, 40, -55, 35, 0, 'paint', -0.14));
  for (const z of [-17, 17]) parts.push(boxPart(4, 3, 1.5, -53, 34, z, 'trim'));

  return {
    parts,
    frontR,
    rearR,
    frontW: 13,
    rearW: 15,
    wheels: [
      { x: 48.8, y: fwY, z: 30.7, front: true },
      { x: -36.5, y: rwY, z: 31.8, front: false },
    ],
    nozzle: new THREE.Vector3(-60, 2, 0),
  };
}

const cache: Partial<Record<CarBody, Design>> = {};
export const designFor = (body: CarBody): Design => (cache[body] ??= body === 'fennec' ? fennec() : octane());
