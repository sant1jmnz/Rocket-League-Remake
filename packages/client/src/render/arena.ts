import * as THREE from 'three';
import { ARENA, GOAL, SHRUNK_OCTAGON } from '@rl/shared';
import { buildStadium } from './stadium';

// Builds the playable arena from the same analytic shape used by the physics (shared/arena/sdf.ts):
// the shrunk octagon swept with a rounded profile, plus the goal boxes.
// Look (DFH-stadium style): turf on the floor and up the curved ramps, a glowing team-colored LED
// band where the ramp meets the wall, then nearly transparent glass walls up to the ceiling.

const R = ARENA.CURVE_RADIUS;
const H = ARENA.HEIGHT;
const HL = ARENA.HALF_LENGTH - R;
const GOAL_BACK = ARENA.HALF_LENGTH + GOAL.DEPTH;
const LED_TOP = R + 34;

export const BLUE = new THREE.Color('#1a63ff');
export const ORANGE = new THREE.Color('#ff6a10');

/** Collects triangles in sim coordinates (Z up) and outputs Three (Y up) buffers. */
class Mesher {
  pos: number[] = [];
  uv: number[] = [];
  col: number[] = [];
  tri(a: number[], b: number[], c: number[], uvs?: number[][]) {
    [a, b, c].forEach((p, i) => {
      this.pos.push(p[0], p[2], -p[1]);
      const u = uvs ? uvs[i] : [p[0], p[1]];
      this.uv.push(u[0], u[1]);
      const t = THREE.MathUtils.smoothstep(p[1], -900, 900);
      const k = BLUE.clone().lerp(ORANGE, t);
      this.col.push(k.r, k.g, k.b);
    });
  }
  quad(a: number[], b: number[], c: number[], d: number[], uvs?: number[][]) {
    this.tri(a, b, c, uvs && [uvs[0], uvs[1], uvs[2]]);
    this.tri(a, c, d, uvs && [uvs[0], uvs[2], uvs[3]]);
  }
  geometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.computeVertexNormals();
    return g;
  }
}

// ---------------------------------------------------------------------------
// Turf
// ---------------------------------------------------------------------------

/** Tileable grass detail texture (used everywhere with world-space UVs). */
function grassTile(): THREE.CanvasTexture {
  const S = 512;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d')!;
  const img = g.createImageData(S, S);
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < S * S; i++) {
    const n = rnd();
    const blade = rnd() < 0.08 ? 0.18 : 0;
    const v = 0.82 + n * 0.22 + blade;
    img.data[i * 4] = 255 * v * 0.92;
    img.data[i * 4 + 1] = 255 * v;
    img.data[i * 4 + 2] = 255 * v * 0.88;
    img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
}

/** Field markings + mowing pattern, mapped over x∈[-4096,4096], y∈[-6000,6000]. */
function fieldTexture(): THREE.CanvasTexture {
  const W = 2048;
  const Hh = 3000;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = Hh;
  const g = c.getContext('2d')!;
  const sx = (x: number) => ((x + 4096) / 8192) * W;
  const sy = (y: number) => ((6000 - y) / 12000) * Hh; // +Y (orange) at the top
  const su = (d: number) => (d / 8192) * W;

  // Base turf with wide mowing bands across the field
  g.fillStyle = '#3b8a2e';
  g.fillRect(0, 0, W, Hh);
  const band = 640;
  for (let y = -6000, i = 0; y < 6000; y += band, i++) {
    g.fillStyle = i % 2 ? '#43982f' : '#367f2a';
    g.fillRect(0, sy(y + band), W, sy(y) - sy(y + band));
  }
  // Team-colored ends (soft) like the colored halves of the real field
  for (const side of [-1, 1]) {
    const grad = g.createLinearGradient(0, sy(side * 5200), 0, sy(side * 1500));
    const rgb = side < 0 ? '40,110,255' : '255,120,20';
    grad.addColorStop(0, `rgba(${rgb},0.30)`);
    grad.addColorStop(1, `rgba(${rgb},0)`);
    g.fillStyle = grad;
    g.fillRect(0, Math.min(sy(side * 5200), sy(side * 1500)), W, Math.abs(sy(side * 1500) - sy(side * 5200)));
  }

  const line = (w: number, color = 'rgba(255,255,255,0.92)') => {
    g.strokeStyle = color;
    g.lineWidth = su(w);
    g.lineCap = 'round';
    g.lineJoin = 'round';
  };
  // Boundary
  line(36);
  g.beginPath();
  SHRUNK_OCTAGON.forEach(([x, y], i) => (i ? g.lineTo(sx(x), sy(y)) : g.moveTo(sx(x), sy(y))));
  g.closePath();
  g.stroke();
  // Center line, circle and spot
  g.beginPath();
  g.moveTo(sx(-3840), sy(0));
  g.lineTo(sx(3840), sy(0));
  g.stroke();
  g.beginPath();
  g.arc(sx(0), sy(0), su(1050), 0, Math.PI * 2);
  g.stroke();
  g.beginPath();
  g.arc(sx(0), sy(0), su(70), 0, Math.PI * 2);
  g.fillStyle = 'rgba(255,255,255,0.92)';
  g.fill();
  // Goal areas
  for (const side of [1, -1]) {
    const gy = side * HL;
    line(36);
    g.beginPath();
    g.moveTo(sx(-1900), sy(gy));
    g.lineTo(sx(-1900), sy(gy - side * 1150));
    g.lineTo(sx(1900), sy(gy - side * 1150));
    g.lineTo(sx(1900), sy(gy));
    g.stroke();
    g.beginPath();
    g.arc(sx(0), sy(gy - side * 1150), su(720), side > 0 ? 0 : Math.PI, side > 0 ? Math.PI : Math.PI * 2);
    g.stroke();
    // Goal line in team color
    line(60, side > 0 ? 'rgba(255,150,60,0.95)' : 'rgba(110,170,255,0.95)');
    g.beginPath();
    g.moveTo(sx(-GOAL.HALF_WIDTH), sy(side * HL));
    g.lineTo(sx(GOAL.HALF_WIDTH), sy(side * HL));
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 16;
  return tex;
}

/** Floor material: marking texture (field UVs) × tiled grass detail (world UVs). */
function turfMaterial(markings: THREE.Texture | null): THREE.MeshStandardMaterial {
  const tile = grassTile();
  const mat = new THREE.MeshStandardMaterial({ color: markings ? '#ffffff' : '#3e8c2f', map: markings, roughness: 0.92, metalness: 0 });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTile = { value: tile };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWorldPos;\nvarying vec3 vWorldN;')
      .replace(
        '#include <worldpos_vertex>',
        '#include <worldpos_vertex>\nvWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvWorldN = normalize(mat3(modelMatrix) * objectNormal);',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D uTile;\nvarying vec3 vWorldPos;\nvarying vec3 vWorldN;')
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        vec3 wp = vWorldPos;
        vec3 an = abs(vWorldN);
        vec2 tuv = an.y > 0.5 ? wp.xz : (an.x > an.z ? wp.zy : wp.xy);
        float detail = texture2D(uTile, tuv / 220.0).g * 0.6 + texture2D(uTile, tuv / 1300.0).g * 0.4;
        diffuseColor.rgb *= 0.55 + detail * 0.55;`,
      );
  };
  return mat;
}

function floorGeometry(): THREE.BufferGeometry {
  const m = new Mesher();
  const poly = SHRUNK_OCTAGON;
  const fuv = (x: number, y: number) => [(x + 4096) / 8192, (y + 6000) / 12000];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    m.tri([0, 0, 0], [a[0], a[1], 0], [b[0], b[1], 0], [fuv(0, 0), fuv(a[0], a[1]), fuv(b[0], b[1])]);
  }
  for (const side of [1, -1]) {
    const y0 = side * HL;
    const y1 = side * GOAL_BACK;
    const x = GOAL.HALF_WIDTH;
    const pts = [
      [-x, y0, 0],
      [x, y0, 0],
      [x, y1, 0],
      [-x, y1, 0],
    ];
    const uvs = pts.map((p) => fuv(p[0], p[1]));
    if (side > 0) m.quad(pts[0], pts[1], pts[2], pts[3], uvs);
    else m.quad(pts[0], pts[3], pts[2], pts[1], [uvs[0], uvs[3], uvs[2], uvs[1]]);
  }
  return m.geometry();
}

// ---------------------------------------------------------------------------
// Walls (perimeter sweep)
// ---------------------------------------------------------------------------

interface PerimeterSample {
  bx: number;
  by: number;
  nx: number;
  ny: number;
  backWall: boolean;
  dist: number;
}

function perimeter(): PerimeterSample[] {
  const out: PerimeterSample[] = [];
  const poly = SHRUNK_OCTAGON;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const c = poly[(i + 2) % poly.length];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    const nx = dy / len;
    const ny = -dx / len;
    const backWall = Math.abs(ny) > 0.99;
    const ts = new Set<number>();
    const steps = Math.max(2, Math.ceil(len / 300));
    for (let s = 0; s < steps; s++) ts.add(s / steps);
    if (backWall) {
      for (const px of [-GOAL.HALF_WIDTH, GOAL.HALF_WIDTH]) {
        const t = (px - a[0]) / dx;
        if (t > 0 && t < 1) ts.add(t);
      }
    }
    for (const t of [...ts].sort((p, q) => p - q)) out.push({ bx: a[0] + dx * t, by: a[1] + dy * t, nx, ny, backWall, dist: 0 });
    const dx2 = c[0] - b[0];
    const dy2 = c[1] - b[1];
    const len2 = Math.hypot(dx2, dy2);
    const a0 = Math.atan2(ny, nx);
    let a1 = Math.atan2(-dx2 / len2, dy2 / len2);
    if (a1 < a0) a1 += Math.PI * 2;
    for (let s = 0; s < 8; s++) {
      const ang = a0 + ((a1 - a0) * s) / 8;
      out.push({ bx: b[0], by: b[1], nx: Math.cos(ang), ny: Math.sin(ang), backWall: false, dist: 0 });
    }
  }
  // Arc length along the outer wall (for UVs)
  let d = 0;
  for (let i = 0; i < out.length; i++) {
    out[i].dist = d;
    const p = out[i];
    const q = out[(i + 1) % out.length];
    d += Math.hypot(q.bx + q.nx * R - p.bx - p.nx * R, q.by + q.ny * R - p.by - p.ny * R);
  }
  return out;
}

type Zone = 'ramp' | 'led' | 'wall' | 'ceiling';

/** Profile: [outward offset, z, zone of the segment starting here]. */
function profile(): [number, number, Zone][] {
  const pts: [number, number, Zone][] = [];
  const steps = 12;
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * (Math.PI / 2);
    pts.push([R * Math.sin(t), R - R * Math.cos(t), i < steps ? 'ramp' : 'led']);
  }
  pts.push([R, LED_TOP, 'wall']);
  pts.push([R, GOAL.HEIGHT, 'wall']);
  pts.push([R, (GOAL.HEIGHT + H - R) / 2, 'wall']);
  pts.push([R, H - R, 'ceiling']);
  for (let i = 1; i <= steps; i++) {
    const t = (i / steps) * (Math.PI / 2);
    pts.push([R * Math.cos(t), H - R + R * Math.sin(t), 'ceiling']);
  }
  return pts;
}

function wallMeshes(): Record<Zone, THREE.BufferGeometry> {
  const per = perimeter();
  const prof = profile();
  const meshers: Record<Zone, Mesher> = { ramp: new Mesher(), led: new Mesher(), wall: new Mesher(), ceiling: new Mesher() };
  const pt = (p: PerimeterSample, q: [number, number, Zone]) => [p.bx + p.nx * q[0], p.by + p.ny * q[0], q[1]];
  // Arc length along the profile (for UVs)
  const profLen: number[] = [0];
  for (let j = 1; j < prof.length; j++) profLen.push(profLen[j - 1] + Math.hypot(prof[j][0] - prof[j - 1][0], prof[j][1] - prof[j - 1][1]));
  const total = per[per.length - 1].dist;
  for (let i = 0; i < per.length; i++) {
    const p0 = per[i];
    const p1 = per[(i + 1) % per.length];
    const u0 = p0.dist;
    const u1 = i + 1 < per.length ? p1.dist : total;
    const inMouth = p0.backWall && p1.backWall && Math.abs(p0.bx) <= GOAL.HALF_WIDTH + 0.01 && Math.abs(p1.bx) <= GOAL.HALF_WIDTH + 0.01;
    for (let j = 0; j < prof.length - 1; j++) {
      const q0 = prof[j];
      const q1 = prof[j + 1];
      if (inMouth && q1[1] <= GOAL.HEIGHT + 0.01) continue;
      const zone = q0[2];
      meshers[zone].quad(pt(p0, q0), pt(p0, q1), pt(p1, q1), pt(p1, q0), [
        [u0, profLen[j]],
        [u0, profLen[j + 1]],
        [u1, profLen[j + 1]],
        [u1, profLen[j]],
      ]);
    }
  }
  // Flat ceiling
  const poly = SHRUNK_OCTAGON;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    meshers.ceiling.tri([0, 0, H], [b[0], b[1], H], [a[0], a[1], H]);
  }
  return {
    ramp: meshers.ramp.geometry(),
    led: meshers.led.geometry(),
    wall: meshers.wall.geometry(),
    ceiling: meshers.ceiling.geometry(),
  };
}

const glassVertex = /* glsl */ `
  attribute vec3 color;
  varying vec3 vWorld;
  varying vec3 vNormal;
  varying vec3 vColor;
  varying vec2 vUv;
  void main() {
    vec4 w = modelMatrix * vec4(position, 1.0);
    vWorld = w.xyz;
    vNormal = normalize(mat3(modelMatrix) * normal);
    vColor = color;
    vUv = uv;
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`;

const glassFragment = /* glsl */ `
  uniform float uOpacity;
  uniform float uHex;
  varying vec3 vWorld;
  varying vec3 vNormal;
  varying vec3 vColor;
  varying vec2 vUv;

  float hexLines(vec2 p) {
    vec2 r = vec2(1.0, 1.7320508);
    vec2 h = r * 0.5;
    vec2 a = mod(p, r) - h;
    vec2 b = mod(p - h, r) - h;
    vec2 g = dot(a, a) < dot(b, b) ? a : b;
    vec2 q = abs(g);
    float d = max(dot(q, normalize(vec2(1.0, 1.7320508))), q.x);
    return smoothstep(0.455, 0.49, d);
  }

  void main() {
    vec3 viewDir = normalize(cameraPosition - vWorld);
    float fres = pow(1.0 - abs(dot(viewDir, normalize(vNormal))), 3.0);
    float hex = hexLines(vUv / 180.0) * uHex;
    float height = vWorld.y;
    // brighter near the LED band, fading upwards
    float low = smoothstep(900.0, 300.0, height);
    vec3 col = mix(vec3(0.85, 0.92, 1.0), vColor, 0.55) * (0.6 + hex * 1.6 + low * 0.6);
    float alpha = uOpacity + hex * 0.22 + fres * 0.18 + low * 0.08;
    gl_FragColor = vec4(col, clamp(alpha, 0.0, 0.6));
  }
`;

const netFragment = /* glsl */ `
  uniform vec3 uColor;
  varying vec3 vWorld;
  varying vec3 vNormal;
  void main() {
    vec3 n = abs(vNormal);
    vec2 uv = n.x > 0.5 ? vWorld.zy : (n.y > 0.5 ? vWorld.xz : vWorld.xy);
    vec2 p = uv / 46.0;
    vec2 r = vec2(1.0, 1.7320508);
    vec2 a = mod(p, r) - r * 0.5;
    vec2 b = mod(p - r * 0.5, r) - r * 0.5;
    vec2 g = dot(a, a) < dot(b, b) ? a : b;
    vec2 q = abs(g);
    float d = max(dot(q, normalize(vec2(1.0, 1.7320508))), q.x);
    float line = smoothstep(0.40, 0.47, d);
    vec3 col = mix(uColor * 0.5, vec3(1.0), 0.65) * (0.7 + line * 0.8);
    gl_FragColor = vec4(col, 0.08 + line * 0.7);
  }
`;

const netVertex = /* glsl */ `
  varying vec3 vWorld;
  varying vec3 vNormal;
  void main() {
    vec4 w = modelMatrix * vec4(position, 1.0);
    vWorld = w.xyz;
    vNormal = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`;

// ---------------------------------------------------------------------------
// Goals
// ---------------------------------------------------------------------------

function goalNetGeometry(side: 1 | -1): THREE.BufferGeometry {
  const m = new Mesher();
  const x = GOAL.HALF_WIDTH;
  const gh = GOAL.HEIGHT;
  const y0 = ARENA.HALF_LENGTH;
  const y1 = GOAL_BACK;
  const s = side;
  m.quad([-x, s * y1, 0], [x, s * y1, 0], [x, s * y1, gh], [-x, s * y1, gh]);
  m.quad([-x, s * y0, gh], [x, s * y0, gh], [x, s * y1, gh], [-x, s * y1, gh]);
  for (const sx of [-1, 1]) m.quad([sx * x, s * y0, 0], [sx * x, s * y1, 0], [sx * x, s * y1, gh], [sx * x, s * y0, gh]);
  return m.geometry();
}

/** Solid side pieces under the floor ramp next to the posts (the ramp gets cut by the goal mouth). */
function goalCheekGeometry(side: 1 | -1): THREE.BufferGeometry {
  const m = new Mesher();
  const x = GOAL.HALF_WIDTH;
  for (const sx of [-1, 1]) {
    const poly: number[][] = [[sx * x, side * HL, 0]];
    for (let i = 1; i <= 10; i++) {
      const t = (i / 10) * (Math.PI / 2);
      poly.push([sx * x, side * (HL + R * Math.sin(t)), R - R * Math.cos(t)]);
    }
    poly.push([sx * x, side * ARENA.HALF_LENGTH, 0]);
    for (let i = 1; i < poly.length - 2; i++) m.tri(poly[poly.length - 1], poly[i], poly[i + 1]);
    m.tri(poly[poly.length - 1], poly[0], poly[1]);
  }
  return m.geometry();
}

function goalFrame(side: 1 | -1, color: THREE.Color): THREE.Group {
  const grp = new THREE.Group();
  const metal = new THREE.MeshStandardMaterial({ color: '#e9edf2', metalness: 0.7, roughness: 0.25 });
  const glow = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 3.2 });
  const t = 34;
  const y = side * ARENA.HALF_LENGTH;
  for (const sx of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(t, GOAL.HEIGHT + t, t), metal);
    post.position.set(sx * (GOAL.HALF_WIDTH + t / 2), (GOAL.HEIGHT + t) / 2, -y);
    post.castShadow = true;
    grp.add(post);
    const strip = new THREE.Mesh(new THREE.BoxGeometry(t * 0.35, GOAL.HEIGHT, t * 1.02), glow);
    strip.position.set(sx * (GOAL.HALF_WIDTH + 2), GOAL.HEIGHT / 2, -y);
    grp.add(strip);
  }
  const bar = new THREE.Mesh(new THREE.BoxGeometry(GOAL.HALF_WIDTH * 2 + t * 2, t, t), metal);
  bar.position.set(0, GOAL.HEIGHT + t / 2, -y);
  bar.castShadow = true;
  grp.add(bar);
  const barStrip = new THREE.Mesh(new THREE.BoxGeometry(GOAL.HALF_WIDTH * 2, t * 0.35, t * 1.02), glow);
  barStrip.position.set(0, GOAL.HEIGHT + 2, -y);
  grp.add(barStrip);
  // Back wall glow panel inside the goal
  const panel = new THREE.Mesh(
    new THREE.PlaneGeometry(GOAL.HALF_WIDTH * 2 - 40, GOAL.HEIGHT - 60),
    new THREE.MeshBasicMaterial({ color: color.clone().multiplyScalar(1.6), transparent: true, opacity: 0.35, depthWrite: false }),
  );
  panel.position.set(0, GOAL.HEIGHT / 2, -side * (GOAL_BACK - 4));
  if (side < 0) panel.rotation.y = Math.PI;
  grp.add(panel);
  return grp;
}

// ---------------------------------------------------------------------------

export interface ArenaMeshes {
  group: THREE.Group;
}

export function buildArena(): ArenaMeshes {
  const group = new THREE.Group();

  const floor = new THREE.Mesh(floorGeometry(), turfMaterial(fieldTexture()));
  floor.receiveShadow = true;
  group.add(floor);

  const walls = wallMeshes();
  const ramp = new THREE.Mesh(walls.ramp, turfMaterial(null));
  ramp.receiveShadow = true;
  group.add(ramp);

  const led = new THREE.Mesh(
    walls.led,
    new THREE.MeshStandardMaterial({ vertexColors: true, emissive: '#ffffff', emissiveIntensity: 0, color: '#ffffff' }),
  );
  // LED band: emissive in team colors (vertex colors drive emissive through onBeforeCompile)
  (led.material as THREE.MeshStandardMaterial).onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      '#include <emissivemap_fragment>\ntotalEmissiveRadiance = vColor.rgb * 2.6;',
    );
  };
  group.add(led);

  const glassMat = (opacity: number, hex: number) =>
    new THREE.ShaderMaterial({
      vertexShader: glassVertex,
      fragmentShader: glassFragment,
      uniforms: { uOpacity: { value: opacity }, uHex: { value: hex } },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
  const wallMesh = new THREE.Mesh(walls.wall, glassMat(0.04, 0.7));
  wallMesh.renderOrder = 2;
  group.add(wallMesh);
  // The ceiling is practically invisible in the real game: only a faint fresnel sheen remains
  const ceilMesh = new THREE.Mesh(walls.ceiling, glassMat(0.0, 0.0));
  ceilMesh.renderOrder = 2;
  group.add(ceilMesh);

  const cheekMat = new THREE.MeshStandardMaterial({ color: '#2b3038', metalness: 0.5, roughness: 0.5, side: THREE.DoubleSide });
  for (const side of [1, -1] as const) {
    const color = side > 0 ? ORANGE : BLUE;
    const net = new THREE.Mesh(
      goalNetGeometry(side),
      new THREE.ShaderMaterial({
        vertexShader: netVertex,
        fragmentShader: netFragment,
        uniforms: { uColor: { value: color } },
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    net.renderOrder = 3;
    group.add(net);
    group.add(new THREE.Mesh(goalCheekGeometry(side), cheekMat));
    group.add(goalFrame(side, color));
    const light = new THREE.PointLight(color, 4, 2600, 1.4);
    light.position.set(0, 350, -side * (ARENA.HALF_LENGTH + 450));
    group.add(light);
  }

  group.add(buildStadium());
  return { group };
}
