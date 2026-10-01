import * as THREE from 'three';
import { ARENA, BOOST_PADS, GOAL, SHRUNK_OCTAGON } from '@rl/shared';

// Builds the stadium meshes from the same analytic shape used by the physics (see shared/arena/sdf.ts):
// the shrunk octagon swept with a rounded profile, plus the goal boxes.

const R = ARENA.CURVE_RADIUS;
const H = ARENA.HEIGHT;
const HL = ARENA.HALF_LENGTH - R;
const GOAL_BACK = ARENA.HALF_LENGTH + GOAL.DEPTH;

const BLUE = new THREE.Color('#1a6dff');
const ORANGE = new THREE.Color('#ff7b1a');

function pushTri(pos: number[], a: number[], b: number[], c: number[]) {
  // sim coords -> three coords
  for (const p of [a, b, c]) pos.push(p[0], p[2], -p[1]);
}

/** Field markings drawn on a canvas, mapped over x∈[-4096,4096], y∈[-6000,6000]. */
function fieldTexture(): THREE.CanvasTexture {
  const W = 1024;
  const Hh = 1500;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = Hh;
  const g = c.getContext('2d')!;
  const sx = (x: number) => ((x + 4096) / 8192) * W;
  const sy = (y: number) => ((6000 - y) / 12000) * Hh; // canvas y grows down; +Y (orange) at the top
  const su = (d: number) => (d / 8192) * W;

  // Grass base with mowing stripes
  g.fillStyle = '#2e6b2a';
  g.fillRect(0, 0, W, Hh);
  const stripe = 512;
  for (let y = -6000, i = 0; y < 6000; y += stripe, i++) {
    g.fillStyle = i % 2 ? '#357a2f' : '#2b6627';
    g.fillRect(0, sy(y + stripe), W, sy(y) - sy(y + stripe));
  }
  // Team tint halves
  g.fillStyle = 'rgba(40,110,255,0.10)';
  g.fillRect(0, sy(0), W, Hh - sy(0));
  g.fillStyle = 'rgba(255,130,30,0.10)';
  g.fillRect(0, 0, W, sy(0));

  g.strokeStyle = 'rgba(255,255,255,0.85)';
  g.lineWidth = su(28);
  // Outline (octagon of the playable floor)
  g.beginPath();
  SHRUNK_OCTAGON.forEach(([x, y], i) => (i ? g.lineTo(sx(x), sy(y)) : g.moveTo(sx(x), sy(y))));
  g.closePath();
  g.stroke();
  // Center line and circle
  g.beginPath();
  g.moveTo(sx(-3840), sy(0));
  g.lineTo(sx(3840), sy(0));
  g.stroke();
  g.beginPath();
  g.arc(sx(0), sy(0), su(1000), 0, Math.PI * 2);
  g.stroke();
  g.beginPath();
  g.arc(sx(0), sy(0), su(60), 0, Math.PI * 2);
  g.fillStyle = 'rgba(255,255,255,0.85)';
  g.fill();
  // Goal boxes (penalty-area style lines like the real field)
  for (const side of [1, -1]) {
    const gy = side * HL;
    g.strokeStyle = side > 0 ? 'rgba(255,170,90,0.9)' : 'rgba(120,180,255,0.9)';
    g.beginPath();
    g.moveTo(sx(-1800), sy(gy));
    g.lineTo(sx(-1800), sy(gy - side * 1100));
    g.lineTo(sx(1800), sy(gy - side * 1100));
    g.lineTo(sx(1800), sy(gy));
    g.stroke();
    g.beginPath();
    g.arc(sx(0), sy(gy - side * 1100), su(700), side > 0 ? 0 : Math.PI, side > 0 ? Math.PI : Math.PI * 2);
    g.stroke();
    // Goal line
    g.lineWidth = su(40);
    g.beginPath();
    g.moveTo(sx(-GOAL.HALF_WIDTH), sy(side * ARENA.HALF_LENGTH));
    g.lineTo(sx(GOAL.HALF_WIDTH), sy(side * ARENA.HALF_LENGTH));
    g.stroke();
    g.lineWidth = su(28);
  }
  // Boost pad rings
  for (const p of BOOST_PADS) {
    g.beginPath();
    g.arc(sx(p.x), sy(p.y), su(p.big ? 210 : 150), 0, Math.PI * 2);
    g.strokeStyle = 'rgba(255,220,120,0.35)';
    g.lineWidth = su(14);
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

function floorGeometry(): THREE.BufferGeometry {
  const pos: number[] = [];
  const poly = SHRUNK_OCTAGON;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    pushTri(pos, [0, 0, 0], [a[0], a[1], 0], [b[0], b[1], 0]);
  }
  // Goal floors
  for (const side of [1, -1]) {
    const y0 = side * HL;
    const y1 = side * GOAL_BACK;
    const x = GOAL.HALF_WIDTH;
    if (side > 0) {
      pushTri(pos, [-x, y0, 0], [x, y0, 0], [x, y1, 0]);
      pushTri(pos, [-x, y0, 0], [x, y1, 0], [-x, y1, 0]);
    } else {
      pushTri(pos, [-x, y0, 0], [x, y1, 0], [x, y0, 0]);
      pushTri(pos, [-x, y0, 0], [-x, y1, 0], [x, y1, 0]);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  const uv: number[] = [];
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i];
    const y = -pos[i + 2];
    uv.push((x + 4096) / 8192, (y + 6000) / 12000);
  }
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.computeVertexNormals();
  return geo;
}

interface PerimeterSample {
  bx: number;
  by: number;
  nx: number;
  ny: number;
  backWall: boolean;
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
    // Edge samples (include goal-post breakpoints on back walls)
    const ts = new Set<number>();
    const steps = Math.max(2, Math.ceil(len / 400));
    for (let s = 0; s < steps; s++) ts.add(s / steps);
    if (backWall) {
      for (const px of [-GOAL.HALF_WIDTH, GOAL.HALF_WIDTH]) {
        const t = (px - a[0]) / dx;
        if (t > 0 && t < 1) ts.add(t);
      }
    }
    for (const t of [...ts].sort((p, q) => p - q)) {
      out.push({ bx: a[0] + dx * t, by: a[1] + dy * t, nx, ny, backWall });
    }
    // Rounded vertical corner at vertex b
    const dx2 = c[0] - b[0];
    const dy2 = c[1] - b[1];
    const len2 = Math.hypot(dx2, dy2);
    const n2x = dy2 / len2;
    const n2y = -dx2 / len2;
    const a0 = Math.atan2(ny, nx);
    let a1 = Math.atan2(n2y, n2x);
    if (a1 < a0) a1 += Math.PI * 2;
    const arcSteps = 6;
    for (let s = 0; s < arcSteps; s++) {
      const ang = a0 + ((a1 - a0) * s) / arcSteps;
      out.push({ bx: b[0], by: b[1], nx: Math.cos(ang), ny: Math.sin(ang), backWall: false });
    }
  }
  return out;
}

/** Profile: [outward offset, z] from the floor ramp up to the ceiling curve. */
function profile(): [number, number][] {
  const pts: [number, number][] = [];
  const steps = 10;
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * (Math.PI / 2);
    pts.push([R * Math.sin(t), R - R * Math.cos(t)]);
  }
  for (const z of [GOAL.HEIGHT, (H - R + GOAL.HEIGHT) / 2]) pts.push([R, z]);
  pts.push([R, H - R]);
  for (let i = 1; i <= steps; i++) {
    const t = (i / steps) * (Math.PI / 2);
    pts.push([R * Math.cos(t), H - R + R * Math.sin(t)]);
  }
  return pts;
}

function wallGeometry(): { walls: THREE.BufferGeometry; ceiling: THREE.BufferGeometry } {
  const per = perimeter();
  const prof = profile();
  const pos: number[] = [];
  const ceilPos: number[] = [];
  const pt = (p: PerimeterSample, q: [number, number]) => [p.bx + p.nx * q[0], p.by + p.ny * q[0], q[1]];
  for (let i = 0; i < per.length; i++) {
    const p0 = per[i];
    const p1 = per[(i + 1) % per.length];
    const inMouth =
      p0.backWall &&
      p1.backWall &&
      Math.abs(p0.bx) <= GOAL.HALF_WIDTH + 0.01 &&
      Math.abs(p1.bx) <= GOAL.HALF_WIDTH + 0.01;
    for (let j = 0; j < prof.length - 1; j++) {
      const q0 = prof[j];
      const q1 = prof[j + 1];
      if (inMouth && q1[1] <= GOAL.HEIGHT + 0.01) continue;
      const a = pt(p0, q0);
      const b = pt(p1, q0);
      const c = pt(p1, q1);
      const d = pt(p0, q1);
      const target = q0[1] >= H - R - 0.01 ? ceilPos : pos;
      // Faces point inwards (towards the playable space)
      pushTri(target, a, c, b);
      pushTri(target, a, d, c);
    }
  }
  // Flat ceiling
  const poly = SHRUNK_OCTAGON;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    pushTri(ceilPos, [0, 0, H], [b[0], b[1], H], [a[0], a[1], H]);
  }
  const walls = new THREE.BufferGeometry();
  walls.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  walls.computeVertexNormals();
  const ceiling = new THREE.BufferGeometry();
  ceiling.setAttribute('position', new THREE.Float32BufferAttribute(ceilPos, 3));
  ceiling.computeVertexNormals();
  return { walls, ceiling };
}

function goalGeometry(side: 1 | -1): THREE.BufferGeometry {
  const pos: number[] = [];
  const x = GOAL.HALF_WIDTH;
  const gh = GOAL.HEIGHT;
  const y0 = ARENA.HALF_LENGTH;
  const y1 = GOAL_BACK;
  const s = side;
  // Back wall
  pushTri(pos, [-x, s * y1, 0], [x, s * y1, 0], [x, s * y1, gh]);
  pushTri(pos, [-x, s * y1, 0], [x, s * y1, gh], [-x, s * y1, gh]);
  // Roof
  pushTri(pos, [-x, s * y0, gh], [x, s * y0, gh], [x, s * y1, gh]);
  pushTri(pos, [-x, s * y0, gh], [x, s * y1, gh], [-x, s * y1, gh]);
  // Side walls, including the part under the floor ramp
  for (const sx of [-1, 1]) {
    const poly: number[][] = [];
    poly.push([sx * x, s * y1, 0]);
    poly.push([sx * x, s * HL, 0]);
    for (let i = 1; i <= 8; i++) {
      const t = (i / 8) * (Math.PI / 2);
      poly.push([sx * x, s * (HL + R * Math.sin(t)), R - R * Math.cos(t)]);
    }
    poly.push([sx * x, s * y0, gh]);
    poly.push([sx * x, s * y1, gh]);
    for (let i = 1; i < poly.length - 1; i++) pushTri(pos, poly[0], poly[i], poly[i + 1]);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  return geo;
}

const wallVertex = /* glsl */ `
  varying vec3 vWorld;
  varying vec3 vNormal;
  void main() {
    vec4 w = modelMatrix * vec4(position, 1.0);
    vWorld = w.xyz;
    vNormal = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`;

const wallFragment = /* glsl */ `
  uniform vec3 uBlue;
  uniform vec3 uOrange;
  uniform float uOpacity;
  varying vec3 vWorld;
  varying vec3 vNormal;

  float hexGrid(vec2 p, float size) {
    p /= size;
    vec2 r = vec2(1.0, 1.7320508);
    vec2 h = r * 0.5;
    vec2 a = mod(p, r) - h;
    vec2 b = mod(p - h, r) - h;
    vec2 g = dot(a, a) < dot(b, b) ? a : b;
    vec2 q = abs(g);
    float d = max(dot(q, normalize(vec2(1.0, 1.7320508))), q.x);
    return smoothstep(0.42, 0.48, d);
  }

  void main() {
    // sim y = -three z
    float simY = -vWorld.z;
    float side = smoothstep(-1200.0, 1200.0, simY);
    vec3 base = mix(uBlue, uOrange, side);
    // Choose a 2D parametrization for the hex pattern based on the normal
    vec3 n = abs(vNormal);
    vec2 uv = n.x > n.z ? vWorld.zy : vWorld.xy;
    if (n.y > 0.7) uv = vWorld.xz;
    float hex = hexGrid(uv, 210.0);
    float height = vWorld.y;
    float floorGlow = smoothstep(260.0, 0.0, height) * 0.6;
    float topFade = smoothstep(2044.0, 1200.0, height);
    vec3 col = base * (0.45 + 0.75 * hex) + vec3(1.0) * hex * 0.12;
    col += base * floorGlow;
    float alpha = uOpacity * (0.18 + 0.82 * hex) * (0.35 + 0.65 * topFade) + floorGlow * 0.5;
    gl_FragColor = vec4(col, clamp(alpha, 0.0, 0.9));
  }
`;

const netFragment = /* glsl */ `
  uniform vec3 uColor;
  varying vec3 vWorld;
  varying vec3 vNormal;
  void main() {
    vec3 n = abs(vNormal);
    vec2 uv = n.x > 0.5 ? vWorld.zy : (n.y > 0.5 ? vWorld.xz : vWorld.xy);
    vec2 g = abs(fract(uv / 60.0) - 0.5);
    float line = 1.0 - smoothstep(0.0, 0.06, min(g.x, g.y));
    vec3 col = mix(uColor * 0.25, vec3(1.0), line * 0.6);
    gl_FragColor = vec4(col, 0.25 + line * 0.55);
  }
`;

function goalFrame(side: 1 | -1, color: THREE.Color): THREE.Group {
  const grp = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: '#e8e8e8', emissive: color, emissiveIntensity: 0.6, metalness: 0.4, roughness: 0.4 });
  const t = 26;
  const y = side * ARENA.HALF_LENGTH;
  for (const sx of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(t, GOAL.HEIGHT, t), mat);
    post.position.set(sx * (GOAL.HALF_WIDTH + t / 2), GOAL.HEIGHT / 2, -y);
    grp.add(post);
  }
  const bar = new THREE.Mesh(new THREE.BoxGeometry(GOAL.HALF_WIDTH * 2 + t * 2, t, t), mat);
  bar.position.set(0, GOAL.HEIGHT + t / 2, -y);
  grp.add(bar);
  // Glowing goal-line strip
  const strip = new THREE.Mesh(
    new THREE.PlaneGeometry(GOAL.HALF_WIDTH * 2, 30),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8 }),
  );
  strip.rotation.x = -Math.PI / 2;
  strip.position.set(0, 1.5, -y);
  grp.add(strip);
  return grp;
}

/** Stands, crowd and surroundings outside the walls (purely decorative). */
function surroundings(): THREE.Group {
  const grp = new THREE.Group();
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(40000, 40000),
    new THREE.MeshStandardMaterial({ color: '#1d2a1f', roughness: 1 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -30;
  grp.add(ground);

  // Crowd texture
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = '#20232c';
  g.fillRect(0, 0, 512, 128);
  for (let i = 0; i < 1600; i++) {
    const hue = Math.random() < 0.5 ? 215 : 25;
    g.fillStyle = `hsl(${hue + Math.random() * 30 - 15}, ${40 + Math.random() * 50}%, ${30 + Math.random() * 40}%)`;
    g.fillRect(Math.random() * 512, Math.random() * 128, 3, 4);
  }
  const crowd = new THREE.CanvasTexture(c);
  crowd.colorSpace = THREE.SRGBColorSpace;
  crowd.wrapS = crowd.wrapT = THREE.RepeatWrapping;

  const standMat = new THREE.MeshStandardMaterial({ map: crowd, roughness: 0.9 });
  const tiers = 3;
  for (let t = 0; t < tiers; t++) {
    const off = 700 + t * 900;
    const h = 700 + t * 700;
    const w = ARENA.HALF_WIDTH + off;
    const l = ARENA.HALF_LENGTH + off + GOAL.DEPTH;
    const mk = (sx: number, sz: number, px: number, pz: number, ry: number) => {
      const geo = new THREE.BoxGeometry(sx, h, sz);
      const tex = crowd.clone();
      tex.repeat.set(sx / 1500, 1);
      tex.needsUpdate = true;
      const m = new THREE.Mesh(geo, standMat.clone());
      (m.material as THREE.MeshStandardMaterial).map = tex;
      m.position.set(px, h / 2 - 30 + t * 250, pz);
      m.rotation.y = ry;
      grp.add(m);
    };
    mk(900, l * 2, w + 450, 0, 0);
    mk(900, l * 2, -w - 450, 0, 0);
    mk(w * 2, 900, 0, l + 450, 0);
    mk(w * 2, 900, 0, -l - 450, 0);
  }
  // Light towers
  const lightMat = new THREE.MeshBasicMaterial({ color: '#fff6d8' });
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(60, 80, 5200, 8), new THREE.MeshStandardMaterial({ color: '#555' }));
      pole.position.set(sx * 7600, 2600, sz * 9200);
      grp.add(pole);
      const lamp = new THREE.Mesh(new THREE.BoxGeometry(900, 400, 120), lightMat);
      lamp.position.set(sx * 7600, 5300, sz * 9200);
      lamp.lookAt(0, 0, 0);
      grp.add(lamp);
    }
  return grp;
}

export interface ArenaMeshes {
  group: THREE.Group;
}

export function buildArena(): ArenaMeshes {
  const group = new THREE.Group();

  const floorMat = new THREE.MeshStandardMaterial({ map: fieldTexture(), roughness: 0.95, metalness: 0 });
  const floor = new THREE.Mesh(floorGeometry(), floorMat);
  floor.receiveShadow = true;
  group.add(floor);

  const { walls, ceiling } = wallGeometry();
  const wallMat = new THREE.ShaderMaterial({
    vertexShader: wallVertex,
    fragmentShader: wallFragment,
    uniforms: {
      uBlue: { value: BLUE },
      uOrange: { value: ORANGE },
      uOpacity: { value: 0.5 },
    },
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const wallMesh = new THREE.Mesh(walls, wallMat);
  wallMesh.renderOrder = 2;
  group.add(wallMesh);
  const ceilMat = wallMat.clone();
  ceilMat.uniforms.uOpacity = { value: 0.18 };
  const ceilMesh = new THREE.Mesh(ceiling, ceilMat);
  ceilMesh.renderOrder = 2;
  group.add(ceilMesh);

  for (const side of [1, -1] as const) {
    const color = side > 0 ? ORANGE : BLUE;
    const net = new THREE.Mesh(
      goalGeometry(side),
      new THREE.ShaderMaterial({
        vertexShader: wallVertex,
        fragmentShader: netFragment,
        uniforms: { uColor: { value: color } },
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    net.renderOrder = 3;
    group.add(net);
    group.add(goalFrame(side, color));
    // Goal glow light
    const light = new THREE.PointLight(color, 2, 2500, 1.2);
    light.position.set(0, 400, -side * (ARENA.HALF_LENGTH + 500));
    group.add(light);
  }

  group.add(surroundings());
  return { group };
}
