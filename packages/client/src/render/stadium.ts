import * as THREE from 'three';

// Decorative stadium around the arena (not part of the physics): a two-tier seating bowl with a
// crowd, LED ad boards, a ring of lights and a roof canopy, in the style of the classic stadium.
// Built in sim coordinates (Z up) and converted to Three (Y up).

const AX = 4096 + 380;
const AY = 6000 + 380;
const RC = 1900;

const BLUE = new THREE.Color('#1a63ff');
const ORANGE = new THREE.Color('#ff6a10');

interface PathPoint {
  x: number;
  y: number;
  nx: number;
  ny: number;
  d: number;
}

/** Rounded rectangle around the arena, sampled every ~`step` uu, with outward normals. */
function stadiumPath(step: number): PathPoint[] {
  const pts: PathPoint[] = [];
  const corners = [
    [AX - RC, AY - RC, 0],
    [-(AX - RC), AY - RC, Math.PI / 2],
    [-(AX - RC), -(AY - RC), Math.PI],
    [AX - RC, -(AY - RC), (3 * Math.PI) / 2],
  ];
  for (let c = 0; c < 4; c++) {
    const [cx, cy, a0] = corners[c];
    const arcSteps = Math.ceil((RC * Math.PI) / 2 / step);
    for (let i = 0; i < arcSteps; i++) {
      const a = a0 + (i / arcSteps) * (Math.PI / 2);
      pts.push({ x: cx + Math.cos(a) * RC, y: cy + Math.sin(a) * RC, nx: Math.cos(a), ny: Math.sin(a), d: 0 });
    }
    // straight segment to the next corner
    const [nx, ny, na] = corners[(c + 1) % 4];
    const a = na;
    const sx = cx + Math.cos(a) * RC;
    const sy = cy + Math.sin(a) * RC;
    const ex = nx + Math.cos(a) * RC;
    const ey = ny + Math.sin(a) * RC;
    const len = Math.hypot(ex - sx, ey - sy);
    const n = Math.max(1, Math.ceil(len / step));
    for (let i = 0; i < n; i++) {
      const t = i / n;
      pts.push({ x: sx + (ex - sx) * t, y: sy + (ey - sy) * t, nx: Math.cos(a), ny: Math.sin(a), d: 0 });
    }
  }
  let d = 0;
  for (let i = 0; i < pts.length; i++) {
    pts[i].d = d;
    const q = pts[(i + 1) % pts.length];
    d += Math.hypot(q.x - pts[i].x, q.y - pts[i].y);
  }
  return pts;
}

const teamTint = (y: number) => BLUE.clone().lerp(ORANGE, THREE.MathUtils.smoothstep(y, -2500, 2500));

/** Sweeps a 2D profile (outward offset, z) along the path. Returns geometry with vertex colors. */
function sweep(path: PathPoint[], prof: [number, number][], color: (p: PathPoint, z: number) => THREE.Color, uvScale = 1): THREE.BufferGeometry {
  const pos: number[] = [];
  const col: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const total = path[path.length - 1].d + Math.hypot(path[0].x - path[path.length - 1].x, path[0].y - path[path.length - 1].y);
  const rows = path.length + 1;
  for (let i = 0; i < rows; i++) {
    const p = path[i % path.length];
    const d = i === path.length ? total : p.d;
    let acc = 0;
    prof.forEach(([s, z], j) => {
      if (j > 0) acc += Math.hypot(s - prof[j - 1][0], z - prof[j - 1][1]);
      const x = p.x + p.nx * s;
      const y = p.y + p.ny * s;
      pos.push(x, z, -y);
      const c = color(p, z);
      col.push(c.r, c.g, c.b);
      uv.push((d / 1000) * uvScale, acc / 1000);
    });
  }
  const n = prof.length;
  for (let i = 0; i < rows - 1; i++) {
    for (let j = 0; j < n - 1; j++) {
      const a = i * n + j;
      const b = (i + 1) * n + j;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

interface Tier {
  s0: number;
  z0: number;
  rows: number;
  depth: number;
  rise: number;
}

const LOWER: Tier = { s0: 260, z0: 620, rows: 17, depth: 150, rise: 92 };
const UPPER: Tier = { s0: 260 + 17 * 150 + 520, z0: 620 + 17 * 92 + 650, rows: 13, depth: 135, rise: 118 };

function tierProfile(t: Tier): [number, number][] {
  const p: [number, number][] = [];
  for (let r = 0; r < t.rows; r++) {
    const s = t.s0 + r * t.depth;
    const z = t.z0 + r * t.rise;
    p.push([s, z], [s + t.depth, z], [s + t.depth, z + t.rise]);
  }
  return p;
}

function adTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 2048;
  c.height = 128;
  const g = c.getContext('2d')!;
  const words = ['ROCKET REMAKE', '★', 'SUPERSÓNICO', '★', 'FÚTBOL CON AUTOS', '★', 'BOOST', '★'];
  const grad = g.createLinearGradient(0, 0, 2048, 0);
  grad.addColorStop(0, '#0d1a40');
  grad.addColorStop(0.5, '#141a2c');
  grad.addColorStop(1, '#40180a');
  g.fillStyle = grad;
  g.fillRect(0, 0, 2048, 128);
  g.font = 'italic 900 78px system-ui, sans-serif';
  g.textBaseline = 'middle';
  let x = 30;
  let i = 0;
  while (x < 2048) {
    const w = words[i++ % words.length];
    g.fillStyle = i % 4 === 1 ? '#7fc4ff' : i % 4 === 3 ? '#ffb070' : '#ffffff';
    g.fillText(w, x, 68);
    x += g.measureText(w).width + 50;
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  return tex;
}

function crowd(path: PathPoint[], tiers: Tier[]): THREE.Group {
  const grp = new THREE.Group();
  const spots: { x: number; y: number; z: number; rot: number; c: THREE.Color }[] = [];
  let seed = 99;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const palette = ['#ffffff', '#222831', '#e8e8e8', '#3a3f4b', '#ffd23f', '#2ec4b6', '#e63946'];
  const stepAlong = 78;
  const total = path[path.length - 1].d;
  for (const t of tiers) {
    for (let r = 0; r < t.rows; r++) {
      const s = t.s0 + r * t.depth + t.depth * 0.45;
      const z = t.z0 + r * t.rise;
      for (let d = rnd() * stepAlong; d < total; d += stepAlong * (0.85 + rnd() * 0.4)) {
        if (rnd() > 0.8) continue;
        // locate path point
        let lo = 0;
        let hi = path.length - 1;
        while (lo < hi) {
          const mid = (lo + hi + 1) >> 1;
          if (path[mid].d <= d) lo = mid;
          else hi = mid - 1;
        }
        const p = path[lo];
        const x = p.x + p.nx * s;
        const y = p.y + p.ny * s;
        const team = rnd() < 0.72 ? teamTint(y).clone().offsetHSL((rnd() - 0.5) * 0.05, 0, (rnd() - 0.5) * 0.25) : new THREE.Color(palette[Math.floor(rnd() * palette.length)]);
        spots.push({ x, y, z, rot: Math.atan2(-p.ny, -p.nx), c: team });
      }
    }
  }
  const bodyGeo = new THREE.BoxGeometry(48, 66, 34);
  bodyGeo.translate(0, 33, 0);
  const headGeo = new THREE.SphereGeometry(14, 8, 6);
  headGeo.translate(0, 80, 0);
  const bodies = new THREE.InstancedMesh(bodyGeo, new THREE.MeshStandardMaterial({ roughness: 0.9 }), spots.length);
  const heads = new THREE.InstancedMesh(headGeo, new THREE.MeshStandardMaterial({ roughness: 0.8 }), spots.length);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const skin = ['#f1c27d', '#e0ac69', '#c68642', '#8d5524', '#ffdbac'].map((h) => new THREE.Color(h));
  spots.forEach((sp, i) => {
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), sp.rot + Math.PI / 2);
    const scale = 0.9 + ((i * 7919) % 100) / 400;
    m.compose(new THREE.Vector3(sp.x, sp.z, -sp.y), q, new THREE.Vector3(scale, scale, scale));
    bodies.setMatrixAt(i, m);
    heads.setMatrixAt(i, m);
    bodies.setColorAt(i, sp.c);
    heads.setColorAt(i, skin[i % skin.length]);
  });
  grp.add(bodies, heads);
  return grp;
}

export function buildStadium(): THREE.Group {
  const grp = new THREE.Group();
  const path = stadiumPath(260);

  // Seating bowl (concrete + team-colored seats)
  const seatColor = (p: PathPoint) => teamTint(p.y).clone().multiplyScalar(0.55).lerp(new THREE.Color('#2a2f3a'), 0.35);
  const bowlMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0.05, side: THREE.DoubleSide });
  for (const t of [LOWER, UPPER]) {
    const prof = tierProfile(t);
    // front wall of the tier down to the ground / concourse
    prof.unshift([t.s0, t === LOWER ? 0 : t.z0 - 650]);
    const last = prof[prof.length - 1];
    prof.push([last[0], last[1] + 260], [last[0] + 300, last[1] + 260], [last[0] + 300, 0]);
    grp.add(new THREE.Mesh(sweep(path, prof, seatColor), bowlMat));
  }
  // Concourse between tiers
  const lowerTop = LOWER.z0 + LOWER.rows * LOWER.rise;
  const concourse: [number, number][] = [
    [LOWER.s0 + LOWER.rows * LOWER.depth, lowerTop],
    [UPPER.s0, lowerTop],
    [UPPER.s0, UPPER.z0],
  ];
  grp.add(new THREE.Mesh(sweep(path, concourse, () => new THREE.Color('#3b4250')), bowlMat));

  // LED ad boards around the arena base and on the concourse ring
  const ad = adTexture();
  ad.repeat.set(1, 1);
  const adMat = new THREE.MeshStandardMaterial({ map: ad, emissiveMap: ad, emissive: '#ffffff', emissiveIntensity: 1.4, roughness: 0.4, side: THREE.DoubleSide });
  const board = sweep(path, [[40, 0], [40, 560]], () => new THREE.Color('#ffffff'), -0.25);
  grp.add(new THREE.Mesh(board, adMat));
  const ring = sweep(path, [[UPPER.s0 - 2, lowerTop + 80], [UPPER.s0 - 2, UPPER.z0 - 40]], () => new THREE.Color('#ffffff'), -0.25);
  grp.add(new THREE.Mesh(ring, adMat));

  grp.add(crowd(path, [LOWER, UPPER]));

  // Roof canopy with a light ring on its inner edge
  const roofZ = UPPER.z0 + UPPER.rows * UPPER.rise + 900;
  const outer = UPPER.s0 + UPPER.rows * UPPER.depth + 300;
  const roofMat = new THREE.MeshStandardMaterial({ color: '#d9dde4', metalness: 0.6, roughness: 0.45, side: THREE.DoubleSide });
  grp.add(new THREE.Mesh(sweep(path, [[700, roofZ - 80], [700, roofZ], [outer, roofZ + 500], [outer, roofZ + 380]], () => new THREE.Color('#ffffff')), roofMat));
  const lightMat = new THREE.MeshStandardMaterial({ color: '#ffffff', emissive: '#fff6e0', emissiveIntensity: 5 });
  const lampGeo = new THREE.BoxGeometry(260, 40, 120);
  const lamps = new THREE.InstancedMesh(lampGeo, lightMat, Math.ceil(path.length / 4));
  const m = new THREE.Matrix4();
  let n = 0;
  for (let i = 0; i < path.length; i += 4) {
    const p = path[i];
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(p.ny, p.nx) + Math.PI / 2);
    m.compose(new THREE.Vector3(p.x + p.nx * 760, roofZ - 110, -(p.y + p.ny * 760)), q, new THREE.Vector3(1, 1, 1));
    lamps.setMatrixAt(n++, m);
  }
  lamps.count = n;
  grp.add(lamps);
  // Support columns
  const colMat = new THREE.MeshStandardMaterial({ color: '#9aa3b0', metalness: 0.7, roughness: 0.4 });
  for (let i = 0; i < path.length; i += 12) {
    const p = path[i];
    const col = new THREE.Mesh(new THREE.CylinderGeometry(55, 70, roofZ + 400, 10), colMat);
    col.position.set(p.x + p.nx * outer, (roofZ + 400) / 2, -(p.y + p.ny * outer));
    grp.add(col);
  }

  // Ground outside the bowl
  const ground = new THREE.Mesh(new THREE.CircleGeometry(60000, 48), new THREE.MeshStandardMaterial({ color: '#33402f', roughness: 1 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -40;
  ground.receiveShadow = true;
  grp.add(ground);
  return grp;
}
