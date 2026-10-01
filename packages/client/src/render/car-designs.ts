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
  /** lateral center of the section (default 0: symmetric body); used for off-center pods/fenders */
  zc?: (x: number) => number;
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
    const zc = s.zc ? s.zc(x) : 0;
    for (let i = 0; i <= s.ring; i++) {
      const th = -Math.PI / 2 + (i / s.ring) * Math.PI * 2;
      const c = Math.cos(th);
      const sn = Math.sin(th);
      const u = Math.sign(c) * Math.pow(Math.abs(c), e);
      const v = Math.sign(sn) * Math.pow(Math.abs(sn), e);
      const t = (v + 1) / 2;
      const w = s.wBottom(x) + (s.wTop(x) - s.wBottom(x)) * t;
      pos.push(x, bot + (top - bot) * t, zc + u * w);
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
    pos.push(pos[base * 3], cy / row, s.zc ? s.zc(pos[base * 3]) : 0);
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

/** Rounded side pod / fender (right side) between z = inner and z = outer(x). */
function pod(o: {
  x0: number;
  x1: number;
  inner: number;
  outer: (x: number) => number;
  top: (x: number) => number;
  bottom: (x: number) => number;
  n?: number;
  surface?: Surface;
}): Part {
  const part = loft({
    x0: o.x0,
    x1: o.x1,
    stations: 40,
    ring: 32,
    top: o.top,
    bottom: o.bottom,
    wTop: (x) => (o.outer(x) - o.inner) / 2,
    wBottom: (x) => (o.outer(x) - o.inner) / 2,
    zc: (x) => (o.outer(x) + o.inner) / 2,
    n: () => o.n ?? 2.6,
  });
  part.surface = o.surface ?? 'paint';
  return part;
}

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

const OCT_TOP: [number, number][] = [[-50, 22], [-44, 25], [-30, 25.5], [-22, 30], [-16, 32.5], [-6, 33.5], [8, 33.8], [16, 31.5], [24, 29], [32, 25], [40, 19.5], [48, 15], [56, 13], [64, 10.5], [72, 5.5], [78, 3]];

function octane(): Design {
  // Visual wheel sizes from the reference (wheel model scaled 0.75 front / 0.84 rear)
  const frontR = 11;
  const rearR = 12.7;
  const fwY = -6;
  const rwY = -4.3;
  const parts: Part[] = [];

  // Central fuselage: narrow nose, tall bubble canopy, rear deck with the engine bay
  const top = curve(OCT_TOP);
  parts.push(
    loft({
      x0: -50,
      x1: 78,
      stations: 80,
      ring: 56,
      top,
      bottom: curve([[-50, -2], [-44, -5.5], [44, -5.5], [60, -6.5], [78, -6]]),
      wTop: curve([[-50, 15], [-20, 17], [0, 21], [10, 20], [20, 17], [32, 15], [50, 13], [66, 12], [78, 9]]),
      wBottom: curve([[-50, 22], [-30, 25], [0, 26], [30, 25], [50, 23], [66, 19], [78, 15]]),
      n: () => 2.7,
      // Windshield on the canopy front, side windows on its flanks, dark sills
      mask:
        GLSL_BAND +
        glslPiecewise('topO', OCT_TOP) +
        `vec2 carMask(vec3 p) {
          float t = topO(p.x);
          float ws = band(p.x, 14.0, 44.0, 0.4) * smoothstep(t - 6.4, t - 5.6, p.y) * (1.0 - smoothstep(13.0, 13.8, abs(p.z)));
          float sw = band(p.x, -2.0, 26.0, 0.4) * band(p.y, 21.0, t - 1.6, 0.35) * smoothstep(10.6, 11.4, abs(p.z));
          float tr = 1.0 - smoothstep(-4.6, -3.8, p.y);
          return vec2(max(ws, sw), tr);
        }`,
    }),
  );

  // Front fenders: thin cambered blades over the front wheels, from the cockpit sides to the nose
  parts.push(
    ...both(
      pod({
        x0: 30,
        x1: 67,
        inner: 19.5,
        outer: curve([[30, 21], [34, 27], [40, 30], [48, 31], [56, 31.5], [62, 30.5], [67, 24]]),
        top: curve([[30, 3], [36, 8], [44, 10.5], [52, 11.5], [60, 10.5], [67, 6]]),
        bottom: curve([[30, 0.5], [36, 5], [44, 7], [52, 7.6], [60, 7], [67, 3.5]]),
        n: 2.2,
      }),
    ),
  );

  // Rear side pods: rounded hips over the rear wheels, widest just ahead of the axle
  parts.push(
    ...both(
      pod({
        x0: -48,
        x1: -13,
        inner: 20,
        outer: curve([[-48, 30], [-44, 32.5], [-36, 34.5], [-28, 36], [-22, 36], [-17, 33], [-13, 26]]),
        top: curve([[-48, 18.5], [-44, 21], [-36, 23], [-26, 23.8], [-20, 22.5], [-15, 19], [-13, 15]]),
        bottom: curve([[-48, 8], [-44, 10], [-34, 11.5], [-24, 10.5], [-18, 8.5], [-13, 8]]),
        n: 2.4,
      }),
    ),
  );
  // Dark liners under the pods and blades
  parts.push(...both(pod({ x0: -48, x1: -16, inner: 22, outer: curve([[-48, 30], [-30, 34.5], [-16, 31]]), top: curve([[-48, 7], [-34, 12], [-16, 9]]), bottom: curve([[-48, 5.5], [-34, 10.5], [-16, 7.5]]), surface: 'trim' })));
  parts.push(...both(pod({ x0: 33, x1: 65, inner: 21, outer: curve([[33, 26], [48, 30.5], [65, 25]]), top: curve([[33, 2], [50, 7.8], [65, 4]]), bottom: curve([[33, 1], [50, 6.8], [65, 3]]), surface: 'trim' })));

  // Exposed engine: dark block, two red tanks, top air scoop and exhausts
  parts.push(boxPart(28, 7, 22, -31, 20, 0, 'trim'));
  for (const z of [-8, 8]) {
    parts.push(cylX(4.4, 24, -31, 22.5, z, 'red'));
    parts.push(cylX(1.6, 10, -48, 12, z * 0.9, 'chrome'));
  }
  parts.push(boxPart(15, 6.5, 27, -8.5, 36, 0, 'trim'));
  parts.push(boxPart(2.5, 4.5, 23, -1.2, 36, 0, 'chrome'));
  // Roof fins on the rear deck
  for (const z of [-9, -4.5, 0, 4.5, 9]) parts.push(boxPart(5, 3.5, 1.2, -16, 31.5, z, 'trim', 0.4));

  // Front tube bumper with round headlights and grille
  parts.push(cylZ(1.8, 39, 77, -2.5, 0, 'trim'));
  parts.push(cylZ(1.5, 36, 75.5, 6, 0, 'trim'));
  for (const z of [-10, 10]) parts.push(tube(new THREE.Vector3(77, -8, z), new THREE.Vector3(75.5, 6, z), 1.5, 'trim'));
  parts.push(boxPart(4, 9, 22, 74, 1, 0, 'trim'));
  for (const z of [-17.5, 17.5]) {
    parts.push(cylX(4.4, 4, 75.5, 1.5, z, 'trim'));
    parts.push(cylX(3.3, 4.4, 76, 1.5, z, 'light'));
  }

  // Tall rear wing on a swan-neck post
  const wing = new THREE.Shape();
  wing.moveTo(-61, 40.6);
  wing.lineTo(-46, 41.6);
  wing.lineTo(-45, 42.6);
  wing.lineTo(-61, 41.8);
  wing.closePath();
  const wg = new THREE.ExtrudeGeometry(wing, { depth: 57, bevelEnabled: true, bevelSize: 0.8, bevelThickness: 0.8, bevelSegments: 1 });
  wg.translate(0, 0, -28.5);
  parts.push({ geometry: wg, surface: 'paint' });
  for (const z of [-29.5, 29.5]) parts.push(boxPart(15, 6, 1.4, -53, 40, z, 'paint', 0.08));
  parts.push(tube(new THREE.Vector3(-40, 25, 0), new THREE.Vector3(-44, 36, 0), 1.6, 'trim'));
  parts.push(tube(new THREE.Vector3(-44, 36, 0), new THREE.Vector3(-51, 41.5, 0), 1.6, 'trim'));
  // Tail lights on the pods
  for (const z of [-29, 29]) parts.push(boxPart(1.5, 3, 6, -48.3, 15, z, 'tail'));

  return {
    parts,
    frontR,
    rearR,
    frontW: 12,
    rearW: 15,
    wheels: [
      { x: 51.3, y: fwY, z: 28.7, front: true },
      { x: -34.3, y: rwY, z: 31.7, front: false },
    ],
    nozzle: new THREE.Vector3(-49, 12, 0),
  };
}

// ---------------------------------------------------------------------------
// Fennec
// ---------------------------------------------------------------------------

const FEN_ROOF: [number, number][] = [[-57, 17], [-53, 32.2], [-2, 32.8], [4, 32.3], [26, 18]];

function fennec(): Design {
  // Visual wheel sizes from the reference (same wheel model as the Octane)
  const frontR = 11.2;
  const rearR = 12.7;
  const fwY = -6.1;
  const rwY = -4.6;
  const parts: Part[] = [];

  // Lower body: long flat hood, vertical nose and tail; widens towards the shoulder line
  const hood = lin([[-60, 10], [-57.5, 16], [26, 18], [44, 18], [56, 17], [64, 16], [72, 15], [76, 13.5], [78.5, 10]]);
  parts.push(
    loft({
      x0: -60,
      x1: 78.5,
      stations: 70,
      ring: 48,
      top: hood,
      bottom: lin([[-60, -9], [-57, -12.5], [74, -12.5], [78.5, -9]]),
      wTop: curve([[-60, 27], [-55, 31], [66, 31.5], [72, 30], [76, 25], [78.5, 21]]),
      wBottom: curve([[-60, 23], [-55, 25], [66, 25], [72, 24], [76, 21], [78.5, 18]]),
      n: () => 7,
      mask: `vec2 carMask(vec3 p) { return vec2(0.0, 1.0 - smoothstep(-7.4, -6.6, p.y)); }`,
    }),
  );

  // Greenhouse: flat roof from the tail to the top of a big straight windshield
  const roof = lin(FEN_ROOF);
  parts.push(
    loft({
      x0: -57,
      x1: 26,
      stations: 60,
      ring: 48,
      top: roof,
      bottom: () => 15.5,
      wTop: lin([[-57, 22], [-52, 23.5], [0, 23.5], [26, 25.5]]),
      wBottom: lin([[-57, 30], [-52, 31], [20, 31.5], [26, 31.5]]),
      n: () => 5,
      // Big windshield, side windows (B-pillar in the middle) ending at a thick C-pillar, rear glass
      mask:
        GLSL_BAND +
        glslPiecewise('roofF', FEN_ROOF) +
        `vec2 carMask(vec3 p) {
          float t = roofF(p.x);
          float ws = band(p.x, 5.0, 25.0, 0.3) * smoothstep(19.4, 20.2, p.y) * (1.0 - smoothstep(23.5, 24.3, abs(p.z))) * smoothstep(t - 6.4, t - 5.6, p.y);
          float side = band(p.x, -37.0, 3.0, 0.35) * band(p.y, 20.0, t - 1.8, 0.35) * smoothstep(17.6, 18.4, abs(p.z));
          float pillar = band(p.x, -18.5, -16.0, 0.3);
          float rear = (1.0 - smoothstep(-54.4, -53.6, p.x)) * band(p.y, 20.0, 30.5, 0.35) * (1.0 - smoothstep(19.0, 19.8, abs(p.z)));
          return vec2(max(max(ws, side * (1.0 - pillar)), rear), side * pillar);
        }`,
    }),
  );

  // Round flared arches + lower side skirts (body color), black liners
  for (const [cx, cy, r, z0, z1] of [
    [48.8, fwY, frontR, 24.5, 34.2],
    [-36.5, rwY, rearR, 25.5, 35.6],
  ] as const) {
    const outline: [number, number][] = [...arc(cx, cy, r + 4, -8, 188, 20), ...arc(cx, cy, r + 1.6, 188, -8, 20)];
    parts.push(...both(slab(outline, z0, z1, 'paint', 1.2)));
    parts.push(...both(slab([...arc(cx, cy, r + 2, -8, 188, 18), ...arc(cx, cy, r + 1.2, 188, -8, 18)], z0 + 2, z1, 'trim', 0.4)));
  }
  // Sill panel between the wheels with a black lower strip and side vents
  parts.push(...both(slab([[-21, -12], [33, -12], [33, 8], [-21, 8]], 28.5, 33.5, 'paint', 1.2)));
  parts.push(...both(boxPart(52, 2.5, 1.2, 6, -9.5, 33.6, 'trim')));
  parts.push(...both(slab([[22, -2], [26, -2], [28, 11], [24, 11]], 32.4, 34, 'trim', 0.3)));
  parts.push(...both(slab([[-19, -4], [-15, -4], [-13, 10], [-17, 10]], 32.4, 34, 'trim', 0.3)));

  // Front: wide dark grille, round headlights, low bumper, hood bulge
  parts.push(boxPart(2.5, 9, 30, 78, 3.5, 0, 'trim'));
  for (let i = 0; i < 4; i++) parts.push(boxPart(2.8, 0.8, 26, 78.2, 0.5 + i * 2.2, 0, 'chrome'));
  for (const z of [-21, 21]) {
    parts.push(cylX(4.6, 2.5, 77.4, 5, z, 'trim'));
    parts.push(cylX(3.6, 3, 77.8, 5, z, 'light'));
    parts.push(boxPart(2.5, 2.4, 3.5, 78, 5, z * 0.78, 'accent'));
  }
  // Low bumper that wraps around the rounded front corners
  parts.push(boxPart(5, 5, 42, 76.5, -9, 0, 'trim'));
  for (const z of [-26, 26]) parts.push(boxPart(9, 5, 9, 72.5, -9, z, 'trim', 0, z > 0 ? -0.6 : 0.6));
  // Subtle hood bulge with a vent
  parts.push(slab([[34, 17.9], [66, 15.9], [66, 16.8], [40, 18.8]], -9, 9, 'paint', 0.6));
  parts.push(boxPart(8, 1, 9, 44, 18.6, 0, 'trim', -0.08));

  // Rear: light bar, bumper, roof spoiler
  parts.push(boxPart(1.5, 3.5, 48, -60.3, 7, 0, 'tail'));
  parts.push(boxPart(4, 6, 52, -59.5, -8, 0, 'trim'));
  parts.push(boxPart(9, 1.6, 44, -52.5, 33.3, 0, 'paint', -0.18));
  for (const z of [-19, 19]) parts.push(boxPart(3, 2.4, 1.5, -51, 32.4, z, 'trim'));

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
    nozzle: new THREE.Vector3(-60.5, 0, 0),
  };
}

const cache: Partial<Record<CarBody, Design>> = {};
export const designFor = (body: CarBody): Design => (cache[body] ??= body === 'fennec' ? fennec() : octane());
