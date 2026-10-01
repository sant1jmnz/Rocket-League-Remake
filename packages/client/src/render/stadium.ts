import * as THREE from 'three';

// Decorative stadium around the arena (not part of the physics), proportioned after the DFH
// Stadium reference: a grass ring and a low marble wall around the arena apron, a lower and a much
// taller upper tier of white concrete with dark fascias, a crowd dressed in team colors, and a black
// roof ring with glass panels that arches over the field.
// Built in sim coordinates (Z up) and converted to Three (Y up).

const AX = 10600;
const AY = 11600;
const RC = 6000;

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
function sweep(path: PathPoint[], prof: [number, number][], color: (p: PathPoint, z: number, j: number) => THREE.Color, uvScale = 1): THREE.BufferGeometry {
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
      const c = color(p, z, j);
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

const LOWER: Tier = { s0: 150, z0: 900, rows: 26, depth: 210, rise: 130 };
const UPPER: Tier = { s0: 6100, z0: 4900, rows: 26, depth: 260, rise: 190 };

/** Stepped seating: per row a tread (seats) then a riser; the riser start is doubled so the two
 * can take different colors (see SEAT_ROLE). */
function tierProfile(t: Tier): [number, number][] {
  const p: [number, number][] = [];
  for (let r = 0; r < t.rows; r++) {
    const s = t.s0 + r * t.depth;
    const z = t.z0 + r * t.rise;
    p.push([s, z], [s + t.depth, z], [s + t.depth, z], [s + t.depth, z + t.rise]);
  }
  return p;
}
/** Role of profile point j of tierProfile (after one leading point): 0,1 tread, 2,3 riser. */
const SEAT_ROLE = (j: number) => ((j - 1) % 4 < 2 ? 'seat' : 'riser');

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
  const stepAlong = 190;
  const total = path[path.length - 1].d;
  for (const t of tiers) {
    for (let r = 0; r < t.rows; r++) {
      const s = t.s0 + r * t.depth + t.depth * 0.45;
      const z = t.z0 + r * t.rise;
      for (let d = rnd() * stepAlong; d < total; d += stepAlong * (0.85 + rnd() * 0.4)) {
        if (rnd() > 0.72) continue;
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
  const headGeo = new THREE.BoxGeometry(26, 26, 26);
  headGeo.translate(0, 79, 0);
  const bodies = new THREE.InstancedMesh(bodyGeo, new THREE.MeshStandardMaterial({ roughness: 0.9 }), spots.length);
  const heads = new THREE.InstancedMesh(headGeo, new THREE.MeshStandardMaterial({ roughness: 0.8 }), spots.length);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const skin = ['#f1c27d', '#e0ac69', '#c68642', '#8d5524', '#ffdbac'].map((h) => new THREE.Color(h));
  spots.forEach((sp, i) => {
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), sp.rot + Math.PI / 2);
    const scale = 1.6 + ((i * 7919) % 100) / 250;
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
  const path = stadiumPath(400);
  const white = () => new THREE.Color('#ffffff');

  // Concrete tiers: white structure, rows slightly darker so the steps read from afar
  const concrete = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75, metalness: 0.05, side: THREE.DoubleSide });
  const SEAT = new THREE.Color('#3b4049');
  const RISER = new THREE.Color('#a4a9b1');
  const rowShade = (_p: PathPoint, _z: number, j: number) => (j > 0 && SEAT_ROLE(j) === 'seat' ? SEAT : RISER);
  for (const t of [LOWER, UPPER]) {
    const prof = tierProfile(t);
    prof.unshift([t.s0, t === LOWER ? 0 : t.z0 - 900]);
    const last = prof[prof.length - 1];
    prof.push([last[0], last[1] + 420], [last[0] + 500, last[1] + 420], [last[0] + 500, 0]);
    grp.add(new THREE.Mesh(sweep(path, prof, rowShade), concrete));
  }
  // Concourse between the tiers
  const lowerTop = LOWER.z0 + LOWER.rows * LOWER.rise;
  const lowerBack = LOWER.s0 + LOWER.rows * LOWER.depth;
  grp.add(
    new THREE.Mesh(
      sweep(path, [[lowerBack, lowerTop], [UPPER.s0, lowerTop], [UPPER.s0, UPPER.z0 - 900]], () => new THREE.Color('#b4b8be')),
      concrete,
    ),
  );

  // Dark fascias with a team-colored light line on the front of each tier
  const fasciaMat = new THREE.MeshStandardMaterial({ color: '#16181c', metalness: 0.7, roughness: 0.35, side: THREE.DoubleSide });
  const lineMat = new THREE.MeshStandardMaterial({ vertexColors: true, emissive: '#ffffff', emissiveIntensity: 0, side: THREE.DoubleSide });
  lineMat.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      '#include <emissivemap_fragment>\ntotalEmissiveRadiance = vColor.rgb * 2.2;',
    );
  };
  for (const [s0, z0, z1] of [
    [LOWER.s0 - 30, LOWER.z0 - 260, LOWER.z0 + 20],
    [UPPER.s0 - 30, UPPER.z0 - 420, UPPER.z0 + 20],
  ]) {
    grp.add(new THREE.Mesh(sweep(path, [[s0, z0], [s0, z1]], white), fasciaMat));
    grp.add(new THREE.Mesh(sweep(path, [[s0 - 4, z0 + 40], [s0 - 4, z0 + 75]], (p) => teamTint(p.y)), lineMat));
  }

  // Low marble wall around the grass ring, carrying the ad boards
  const marble = new THREE.MeshStandardMaterial({ color: '#8d9095', roughness: 0.6, metalness: 0.2, side: THREE.DoubleSide });
  grp.add(new THREE.Mesh(sweep(path, [[-60, -40], [-60, 640], [LOWER.s0, 640]], white), marble));
  const ad = adTexture();
  const adMat = new THREE.MeshStandardMaterial({ map: ad, emissiveMap: ad, emissive: '#ffffff', emissiveIntensity: 1.2, roughness: 0.4, side: THREE.DoubleSide });
  grp.add(new THREE.Mesh(sweep(path, [[-64, 120], [-64, 560]], white, -0.12), adMat));
  grp.add(new THREE.Mesh(sweep(path, [[UPPER.s0 - 36, UPPER.z0 - 380], [UPPER.s0 - 36, UPPER.z0 - 60]], white, -0.12), adMat));

  grp.add(crowd(path, [LOWER, UPPER]));

  // Roof: black ring above the back of the upper tier, glass canopy reaching in over the field
  const upperBack = UPPER.s0 + UPPER.rows * UPPER.depth;
  const upperTop = UPPER.z0 + UPPER.rows * UPPER.rise;
  const steel = new THREE.MeshStandardMaterial({ color: '#121316', metalness: 0.8, roughness: 0.35, side: THREE.DoubleSide });
  const ringIn = 2600;
  const ringZ = 12600;
  grp.add(
    new THREE.Mesh(
      sweep(path, [[ringIn, ringZ - 520], [ringIn, ringZ], [ringIn + 900, ringZ + 120], [ringIn + 900, ringZ - 380], [ringIn, ringZ - 520]], white),
      steel,
    ),
  );
  grp.add(
    new THREE.Mesh(
      sweep(path, [[upperBack + 500, upperTop + 420], [upperBack + 900, upperTop + 1600], [upperBack + 900, ringZ - 400]], white),
      steel,
    ),
  );
  const glass = new THREE.MeshStandardMaterial({
    color: '#9fb4c8',
    metalness: 0.8,
    roughness: 0.08,
    transparent: true,
    opacity: 0.38,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const canopy = new THREE.Mesh(sweep(path, [[ringIn + 900, ringZ - 60], [upperBack + 900, ringZ - 400]], white), glass);
  canopy.renderOrder = 1;
  grp.add(canopy);
  // Ribs across the canopy and leaning masts behind the stands
  for (let i = 0; i < path.length; i += 3) {
    const p = path[i];
    const pt = (s: number, z: number) => new THREE.Vector3(p.x + p.nx * s, z, -(p.y + p.ny * s));
    const rib = new THREE.Mesh(
      new THREE.TubeGeometry(new THREE.LineCurve3(pt(ringIn + 600, ringZ - 100), pt(upperBack + 900, ringZ - 420)), 1, 45, 6),
      steel,
    );
    grp.add(rib);
    if (i % 6 === 0) {
      const mast = new THREE.Mesh(new THREE.TubeGeometry(new THREE.LineCurve3(pt(upperBack + 2200, 0), pt(upperBack + 900, ringZ - 300)), 1, 110, 8), steel);
      grp.add(mast);
    }
  }
  // Floodlights under the inner edge of the ring
  const lightMat = new THREE.MeshStandardMaterial({ color: '#ffffff', emissive: '#fff6e0', emissiveIntensity: 5 });
  const lampGeo = new THREE.BoxGeometry(420, 60, 160);
  const lamps = new THREE.InstancedMesh(lampGeo, lightMat, Math.ceil(path.length / 2));
  const m = new THREE.Matrix4();
  let n = 0;
  for (let i = 0; i < path.length; i += 2) {
    const p = path[i];
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(p.ny, p.nx) + Math.PI / 2);
    m.compose(new THREE.Vector3(p.x + p.nx * (ringIn + 300), ringZ - 560, -(p.y + p.ny * (ringIn + 300))), q, new THREE.Vector3(1, 1, 1));
    lamps.setMatrixAt(n++, m);
  }
  lamps.count = n;
  grp.add(lamps);

  // Grass ring between the arena apron and the stands, and the ground beyond
  const grass = new THREE.Mesh(new THREE.CircleGeometry(16500, 64), new THREE.MeshStandardMaterial({ color: '#46613f', roughness: 0.95 }));
  grass.rotation.x = -Math.PI / 2;
  grass.position.y = -30;
  grass.receiveShadow = true;
  grp.add(grass);
  const ground = new THREE.Mesh(new THREE.CircleGeometry(60000, 48), new THREE.MeshStandardMaterial({ color: '#9a9ea4', roughness: 1 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -60;
  grp.add(ground);
  return grp;
}
