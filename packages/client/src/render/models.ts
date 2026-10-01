import * as THREE from 'three';
import { BALL } from '@rl/shared';

// Procedural ball, blob shadows and name labels (the car lives in car.ts).

export const TEAM_COLORS = [new THREE.Color('#1f6bff'), new THREE.Color('#ff7a12')];

interface BallMaps {
  map: THREE.CanvasTexture;
  rough: THREE.CanvasTexture;
  bump: THREE.CanvasTexture;
  glow: THREE.CanvasTexture;
}

const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
/** c = mix(c, col, t) in place. */
const mixInto = (c: number[], col: readonly number[], t: number) => {
  if (t <= 0) return;
  c[0] += (col[0] - c[0]) * t;
  c[1] += (col[1] - c[1]) * t;
  c[2] += (col[2] - c[2]) * t;
};
/** Signed distance to a rounded rectangle with half extents (bx, by) and corner radius r. */
const sdRoundRect = (x: number, y: number, bx: number, by: number, r: number) => {
  const qx = Math.abs(x) - bx + r;
  const qy = Math.abs(y) - by + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
};
let armT = 0;
/** Distance to a segment from the origin along (ca, sa), length len; armT = 0..1 along it. */
const sdArm = (x: number, y: number, ca: number, sa: number, len: number) => {
  const t = Math.min(len, Math.max(0, x * ca + y * sa));
  armT = t / len;
  return Math.hypot(x - ca * t, y - sa * t);
};
const HUB_ARMS = [0, 1, 2].map((i) => [Math.cos(Math.PI / 2 + (i * 2 * Math.PI) / 3), Math.sin(Math.PI / 2 + (i * 2 * Math.PI) / 3)]);
/** 0 on the walls of a hexagonal mesh with cells of size s, 1 in the middle of a cell. */
const hexCell = (x: number, y: number, s: number) => {
  const q = (2 / 3) * x / s;
  const r = (-1 / 3) * x / s + (Math.sqrt(3) / 3) * y / s;
  // cube rounding
  const cz = -q - r;
  let rx = Math.round(q);
  let ry = Math.round(r);
  const rz = Math.round(cz);
  const dx = Math.abs(rx - q);
  const dy = Math.abs(ry - r);
  const dz = Math.abs(rz - cz);
  if (dx > dy && dx > dz) rx = -ry - rz;
  else if (dy > dz) ry = -rx - rz;
  const fx = x / s - 1.5 * rx;
  const fy = y / s - Math.sqrt(3) * (ry + rx / 2);
  const ax = Math.abs(fx);
  const ay = Math.abs(fy);
  const h = Math.max(ax * 0.5 + ay * (Math.sqrt(3) / 2), ax); // hex "radius", 1 at the edge
  return 1 - h;
};

/**
 * Ball maps modelled on the default ball: a cube layout of six faces. The equatorial belt
 * alternates two ribbed cushions framed in dark metal with two hex-mesh faces carrying an
 * X-bracketed teal light; each pole has a three-armed hub around another light. Everything is
 * evaluated per pixel of an equirectangular map (color, roughness, bump and emissive), in
 * time slices; the maps start as flat grey and fill in once the work is done.
 */
function ballTextures(): BallMaps {
  const W = 2048;
  const H = 1024;
  const mk = () => {
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const g = c.getContext('2d')!;
    return { c, g, im: g.createImageData(W, H) };
  };
  const col = mk();
  const rgh = mk();
  const bmp = mk();
  const glw = mk();
  const CUSHION = [206, 201, 182];
  const RIB = [168, 163, 146];
  const MESH = [130, 127, 112];
  const MESH_WALL = [78, 77, 70];
  const FRAME = [96, 94, 88];
  const ARM = [118, 116, 108];
  const RING = [44, 45, 46];
  const LIGHT = [104, 214, 158];
  const SEAM = [40, 40, 38];
  const PETAL = CUSHION.map((v) => v * 0.86);
  const c = [0, 0, 0];
  const cu = [0, 0, 0];
  const aa = 0.012; // edge softness in gnomonic face units

  const row = (y: number) => {
    const lat = (0.5 - (y + 0.5) / H) * Math.PI;
    const cl = Math.cos(lat);
    const sl = Math.sin(lat);
    for (let x = 0; x < W; x++) {
      const lon = ((x + 0.5) / W) * Math.PI * 2;
      // Three's SphereGeometry UV convention
      const dx = -Math.cos(lon) * cl;
      const dy = sl;
      const dz = Math.sin(lon) * cl;
      const ax = Math.abs(dx);
      const ay = Math.abs(dy);
      const az = Math.abs(dz);
      let face: 'pole' | 'cushion' | 'light';
      let u: number;
      let v: number;
      if (ay >= ax && ay >= az) {
        face = 'pole';
        u = dx / ay;
        v = (dz / ay) * Math.sign(dy);
      } else if (az >= ax) {
        // +z cushion, -z light: every cushion faces a light on the opposite side
        face = dz > 0 ? 'cushion' : 'light';
        u = dx / az;
        v = dy / az;
      } else {
        face = dx < 0 ? 'cushion' : 'light';
        u = dz / ax;
        v = dy / ax;
      }

      // Base: hex mesh everywhere, cube edges as deep seams
      const cell = hexCell(u, v, 0.045);
      const wall = 1 - smooth(0.08, 0.2, cell);
      c[0] = MESH[0];
      c[1] = MESH[1];
      c[2] = MESH[2];
      mixInto(c, MESH_WALL, wall);
      let rough = 0.62 + wall * 0.1;
      let height = 0.42 - wall * 0.12;
      let glow = 0;

      if (face === 'cushion') {
        // Ribbed cushion inside a thick dark frame
        const d = sdRoundRect(u, v, 0.68, 0.9, 0.34);
        const frame = smooth(-aa, aa, d + 0.12) * (1 - smooth(-aa, aa, d));
        const inside = 1 - smooth(-aa, aa, d + 0.12);
        const ribPhase = (v + 1) / 0.105;
        const rib = smooth(0.0, 0.12, Math.abs(ribPhase - Math.round(ribPhase)));
        // staggered fish scales between the ribs
        const fy = ribPhase - Math.floor(ribPhase);
        const fx = ((((u + 1) / 0.21 + (Math.floor(ribPhase) % 2) * 0.5) % 1) + 1) % 1 - 0.5;
        const scaleLine = 1 - smooth(0.03, 0.09, Math.abs(fy - (0.9 - 2.4 * fx * fx)));
        const dome = Math.max(0, 1 - (d + 0.12) / -0.5);
        const shade = 1 - scaleLine * 0.1;
        for (let k = 0; k < 3; k++) cu[k] = (CUSHION[k] + (RIB[k] - CUSHION[k]) * (1 - rib) * 0.7) * shade;
        // c·(1 - inside - frame) + FRAME·frame + cushion·inside
        mixInto(c, FRAME, inside < 1 ? frame / (1 - inside) : 0);
        mixInto(c, cu, inside);
        rough = rough * (1 - inside - frame) + 0.38 * inside + 0.3 * frame;
        height = height * (1 - inside - frame) + (0.62 + 0.18 * Math.min(1, dome) - (1 - rib) * 0.06) * inside + 0.88 * frame;
      } else if (face === 'light') {
        // X bracket around a teal light
        const r = Math.hypot(u, v);
        const bd = sdArm(Math.abs(u), Math.abs(v), Math.SQRT1_2, Math.SQRT1_2, 0.36);
        const bar = 1 - smooth(-aa, aa, bd - (0.075 - 0.04 * armT));
        // dark frames bordering the cushions on either side
        const side = 1 - smooth(-aa, aa, Math.abs(Math.abs(u) - 0.93) - 0.07);
        const ring = 1 - smooth(-aa, aa, r - 0.17);
        const lamp = 1 - smooth(-aa, aa, r - 0.115);
        mixInto(c, ARM, bar);
        mixInto(c, FRAME, side);
        mixInto(c, RING, ring);
        mixInto(c, LIGHT, lamp);
        rough = rough * (1 - Math.max(bar, side)) + 0.3 * Math.max(bar, side);
        rough = rough * (1 - ring) + (0.25 - 0.25 * lamp) * ring;
        height = Math.max(height, 0.9 * bar, 0.88 * side, 0.8 * ring - 0.15 * lamp);
        glow = lamp * (0.55 + 0.45 * (1 - r / 0.115));
      } else {
        // Pole hub: three tapered arms, light petals between them, central light
        const r = Math.hypot(u, v);
        let arm = 0;
        for (const [ca, sa] of HUB_ARMS) {
          const d = sdArm(u, v, ca, sa, 0.62);
          arm = Math.max(arm, 1 - smooth(-aa, aa, d - (0.14 - 0.07 * armT)));
        }
        const ang = Math.atan2(v, u) - Math.PI / 2 + Math.PI / 3;
        const petalAng = Math.abs(((ang % ((2 * Math.PI) / 3)) + (2 * Math.PI) / 3) % ((2 * Math.PI) / 3) - Math.PI / 3);
        const petal = (1 - smooth(-aa, aa, r - 0.78 + petalAng * 0.25)) * smooth(-aa, aa, r - 0.3) * smooth(0.12, 0.2, petalAng);
        const hub = 1 - smooth(-aa, aa, r - 0.2);
        const lamp = 1 - smooth(-aa, aa, r - 0.1);
        mixInto(c, PETAL, petal);
        mixInto(c, ARM, arm);
        mixInto(c, RING, hub);
        mixInto(c, LIGHT, lamp);
        rough = rough * (1 - petal) + 0.38 * petal;
        rough = rough * (1 - Math.max(arm, hub)) + 0.28 * Math.max(arm, hub) * (1 - lamp);
        height = Math.max(height * (1 - petal) + 0.62 * petal, 0.92 * arm, 0.9 * hub - 0.2 * lamp);
        glow = lamp * (0.55 + 0.45 * (1 - r / 0.1));
      }

      // Seams along the cube edges
      const edge = 1 - Math.max(Math.abs(u), Math.abs(v));
      const seam = 1 - smooth(0.004, 0.02, edge);
      mixInto(c, SEAM, seam);
      height *= 1 - seam * 0.9;
      rough = rough * (1 - seam) + 0.8 * seam;

      const i = (y * W + x) * 4;
      for (let k = 0; k < 3; k++) {
        col.im.data[i + k] = c[k];
        glw.im.data[i + k] = glow * 255;
      }
      rgh.im.data[i] = rgh.im.data[i + 1] = rgh.im.data[i + 2] = rough * 255;
      bmp.im.data[i] = bmp.im.data[i + 1] = bmp.im.data[i + 2] = height * 255;
      col.im.data[i + 3] = rgh.im.data[i + 3] = bmp.im.data[i + 3] = glw.im.data[i + 3] = 255;
    }
  };
  const tex = (t: ReturnType<typeof mk>, srgb: boolean, fill: string) => {
    t.g.fillStyle = fill;
    t.g.fillRect(0, 0, W, H);
    const out = new THREE.CanvasTexture(t.c);
    if (srgb) out.colorSpace = THREE.SRGBColorSpace;
    out.anisotropy = 8;
    return out;
  };
  const maps = {
    map: tex(col, true, `rgb(${MESH.join(',')})`),
    rough: tex(rgh, false, '#999'),
    bump: tex(bmp, false, '#000'),
    glow: tex(glw, true, '#000'),
  };
  // ~1 s of per-pixel work: spread it over short slices so loading never stalls, then upload
  let y = 0;
  const step = () => {
    const t0 = performance.now();
    while (y < H && performance.now() - t0 < 8) row(y++);
    if (y < H) {
      setTimeout(step, 0);
      return;
    }
    const done: [ReturnType<typeof mk>, THREE.CanvasTexture][] = [
      [col, maps.map],
      [rgh, maps.rough],
      [bmp, maps.bump],
      [glw, maps.glow],
    ];
    for (const [t, out] of done) {
      t.g.putImageData(t.im, 0, 0);
      out.needsUpdate = true;
    }
  };
  setTimeout(step, 0);
  return maps;
}

export function createBallModel(): THREE.Mesh {
  const { map, rough, bump, glow } = ballTextures();
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(BALL.RADIUS, 96, 64),
    new THREE.MeshPhysicalMaterial({
      map,
      roughnessMap: rough,
      roughness: 1,
      metalness: 0.45,
      bumpMap: bump,
      bumpScale: 2.2,
      emissive: new THREE.Color(0.09, 0.63, 1.0),
      emissiveMap: glow,
      emissiveIntensity: 1.6,
      clearcoat: 0.1,
      clearcoatRoughness: 0.5,
    }),
  );
  mesh.castShadow = true;
  return mesh;
}

/** Soft dark disc used as a blob shadow (the real game draws a shadow straight under the ball). */
export function createBlobShadow(radius: number, opacity = 0.5): THREE.Mesh {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(0,0,0,1)');
  grad.addColorStop(0.6, 'rgba(0,0,0,0.6)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(radius * 2, radius * 2),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity, depthWrite: false }),
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.renderOrder = 1;
  return mesh;
}

/** Text sprite used for player names. */
export function createNameSprite(text: string, color: string): THREE.Sprite {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 96;
  const g = c.getContext('2d')!;
  g.font = 'bold 56px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineWidth = 10;
  g.strokeStyle = 'rgba(0,0,0,0.75)';
  g.strokeText(text, 256, 48);
  g.fillStyle = color;
  g.fillText(text, 256, 48);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  sprite.scale.set(240, 45, 1);
  sprite.renderOrder = 10;
  return sprite;
}
