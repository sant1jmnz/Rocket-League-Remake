import * as THREE from 'three';
import { BALL } from '@rl/shared';

// Procedural ball, blob shadows and name labels (the car lives in car.ts).

export const TEAM_COLORS = [new THREE.Color('#1f6bff'), new THREE.Color('#ff7a12')];

/**
 * Ball panels: truncated icosahedron (12 pentagons + 20 hexagons) computed per pixel of an
 * equirectangular map, with dark seams. Returns color + roughness maps.
 */
function ballTextures(): { map: THREE.CanvasTexture; rough: THREE.CanvasTexture } {
  const W = 1024;
  const H = 512;
  const phi = (1 + Math.sqrt(5)) / 2;
  const pent: number[][] = [];
  for (const a of [-1, 1]) for (const b of [-1, 1]) pent.push([0, a, b * phi], [a, b * phi, 0], [b * phi, 0, a]);
  const hex: number[][] = [];
  for (const a of [-1, 1]) for (const b of [-1, 1]) for (const c of [-1, 1]) hex.push([a, b, c]);
  for (const a of [-1, 1]) for (const b of [-1, 1]) hex.push([0, a / phi, b * phi], [a / phi, b * phi, 0], [b * phi, 0, a / phi]);
  const norm = (v: number[]) => {
    const l = Math.hypot(v[0], v[1], v[2]);
    return [v[0] / l, v[1] / l, v[2] / l];
  };
  const centers = [...pent.map((v) => ({ v: norm(v), pent: true })), ...hex.map((v) => ({ v: norm(v), pent: false }))];
  const PENT_BIAS = 0.012; // pentagons are slightly smaller than the hexagons' Voronoi share
  const mk = () => {
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    return c;
  };
  const cm = mk();
  const cr = mk();
  const gm = cm.getContext('2d')!;
  const gr = cr.getContext('2d')!;
  const im = gm.createImageData(W, H);
  const ir = gr.createImageData(W, H);
  for (let y = 0; y < H; y++) {
    const lat = (0.5 - (y + 0.5) / H) * Math.PI;
    const cl = Math.cos(lat);
    const sl = Math.sin(lat);
    for (let x = 0; x < W; x++) {
      const lon = ((x + 0.5) / W) * Math.PI * 2;
      // Three's SphereGeometry UV convention
      const d = [-Math.cos(lon) * cl, sl, Math.sin(lon) * cl];
      let best = -2;
      let second = -2;
      let bestPent = false;
      for (const c of centers) {
        const s = d[0] * c.v[0] + d[1] * c.v[1] + d[2] * c.v[2] - (c.pent ? PENT_BIAS : 0);
        if (s > best) {
          second = best;
          best = s;
          bestPent = c.pent;
        } else if (s > second) second = s;
      }
      const edge = best - second; // 0 on a seam
      const seam = 1 - Math.min(1, Math.max(0, (edge - 0.004) / 0.01));
      const bevel = Math.min(1, edge / 0.06);
      const base = bestPent ? [150, 158, 170] : [222, 227, 234];
      const shade = 0.82 + bevel * 0.18;
      const i = (y * W + x) * 4;
      for (let k = 0; k < 3; k++) {
        const v = base[k] * shade * (1 - seam) + 70 * seam;
        im.data[i + k] = v;
      }
      im.data[i + 3] = 255;
      const r = bestPent ? 150 : 95;
      const rv = r * (1 - seam) + 230 * seam;
      ir.data[i] = ir.data[i + 1] = ir.data[i + 2] = rv;
      ir.data[i + 3] = 255;
    }
  }
  gm.putImageData(im, 0, 0);
  gr.putImageData(ir, 0, 0);
  const map = new THREE.CanvasTexture(cm);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 8;
  const rough = new THREE.CanvasTexture(cr);
  return { map, rough };
}

export function createBallModel(): THREE.Mesh {
  const { map, rough } = ballTextures();
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(BALL.RADIUS, 64, 40),
    new THREE.MeshPhysicalMaterial({
      map,
      roughnessMap: rough,
      roughness: 1,
      metalness: 0.25,
      clearcoat: 0.6,
      clearcoatRoughness: 0.25,
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
