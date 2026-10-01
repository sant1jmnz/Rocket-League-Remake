import * as THREE from 'three';
import { BALL, CAR } from '@rl/shared';

// Procedural models (original low-poly designs; the car body matches the Octane hitbox size).
// Local axes in Three space: forward = +X, up = +Y, right = +Z.

export const TEAM_COLORS = [new THREE.Color('#1f6bff'), new THREE.Color('#ff7a12')];
export const TEAM_ACCENTS = [new THREE.Color('#9fd0ff'), new THREE.Color('#ffd08a')];

export interface CarModel {
  root: THREE.Group;
  body: THREE.Group;
  wheels: { mesh: THREE.Object3D; front: boolean; radius: number }[];
  flame: THREE.Mesh;
  nozzle: THREE.Vector3;
  setTeam(team: 0 | 1): void;
}

function sideProfile(): THREE.Shape {
  const s = new THREE.Shape();
  const pts: [number, number][] = [
    [-46, 5],
    [73, 5],
    [74, 13],
    [66, 20],
    [40, 27],
    [22, 30],
    [8, 47],
    [-24, 50],
    [-40, 42],
    [-47, 33],
    [-47, 14],
  ];
  s.moveTo(pts[0][0], pts[0][1]);
  for (const p of pts.slice(1)) s.lineTo(p[0], p[1]);
  s.closePath();
  return s;
}

function cabinProfile(): THREE.Shape {
  const s = new THREE.Shape();
  const pts: [number, number][] = [
    [21, 30.5],
    [8.5, 46],
    [-23, 49],
    [-37, 41],
    [-35, 31],
  ];
  s.moveTo(pts[0][0], pts[0][1]);
  for (const p of pts.slice(1)) s.lineTo(p[0], p[1]);
  s.closePath();
  return s;
}

export function createCarModel(team: 0 | 1): CarModel {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const yOff = -CAR.REST_HEIGHT; // model built from the ground up; origin is 17 uu above ground

  const paint = new THREE.MeshStandardMaterial({ color: TEAM_COLORS[team], metalness: 0.55, roughness: 0.35 });
  const accent = new THREE.MeshStandardMaterial({ color: TEAM_ACCENTS[team], metalness: 0.4, roughness: 0.4 });
  const dark = new THREE.MeshStandardMaterial({ color: '#15171c', metalness: 0.3, roughness: 0.6 });
  const glass = new THREE.MeshStandardMaterial({ color: '#0b1220', metalness: 0.9, roughness: 0.1 });

  const width = 76;
  const shell = new THREE.Mesh(
    new THREE.ExtrudeGeometry(sideProfile(), { depth: width, bevelEnabled: true, bevelSize: 3, bevelThickness: 3, bevelSegments: 2 }),
    paint,
  );
  shell.position.set(0, yOff, -width / 2);
  shell.castShadow = true;
  body.add(shell);

  const cabin = new THREE.Mesh(new THREE.ExtrudeGeometry(cabinProfile(), { depth: width - 6, bevelEnabled: true, bevelSize: 2.5, bevelThickness: 4, bevelSegments: 1 }), glass);
  cabin.position.set(0, yOff + 0.6, -(width - 6) / 2);
  body.add(cabin);

  // Side skirts / accent stripe
  const stripe = new THREE.Mesh(new THREE.BoxGeometry(100, 4, width + 7), accent);
  stripe.position.set(12, yOff + 18, 0);
  body.add(stripe);

  // Spoiler
  const spoiler = new THREE.Mesh(new THREE.BoxGeometry(14, 3, width + 4), dark);
  spoiler.position.set(-44, yOff + 52, 0);
  body.add(spoiler);
  for (const sz of [-1, 1]) {
    const strut = new THREE.Mesh(new THREE.BoxGeometry(5, 9, 3), dark);
    strut.position.set(-42, yOff + 46.5, sz * 26);
    body.add(strut);
  }
  // Front splitter
  const splitter = new THREE.Mesh(new THREE.BoxGeometry(14, 3, width + 2), dark);
  splitter.position.set(68, yOff + 5, 0);
  body.add(splitter);

  // Lights
  const head = new THREE.MeshBasicMaterial({ color: '#fff8e0' });
  const tail = new THREE.MeshBasicMaterial({ color: '#ff2a2a' });
  for (const sz of [-1, 1]) {
    const hl = new THREE.Mesh(new THREE.BoxGeometry(2, 4, 14), head);
    hl.position.set(75.5, yOff + 14, sz * 26);
    body.add(hl);
    const tl = new THREE.Mesh(new THREE.BoxGeometry(2, 5, 16), tail);
    tl.position.set(-49.5, yOff + 30, sz * 25);
    body.add(tl);
  }

  // Boost nozzle
  const nozzle = new THREE.Vector3(-50, yOff + 22, 0);
  const noz = new THREE.Mesh(new THREE.CylinderGeometry(7, 9, 8, 12), dark);
  noz.rotation.z = Math.PI / 2;
  noz.position.copy(nozzle);
  body.add(noz);

  const flameMat = new THREE.MeshBasicMaterial({
    color: team === 0 ? '#8fd8ff' : '#ffc070',
    transparent: true,
    opacity: 0.85,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const flame = new THREE.Mesh(new THREE.ConeGeometry(8, 60, 12, 1, true), flameMat);
  flame.rotation.z = Math.PI / 2; // cone tip points -X (backwards)
  flame.position.set(nozzle.x - 30, nozzle.y, 0);
  flame.visible = false;
  body.add(flame);

  // Wheels
  const wheels: CarModel['wheels'] = [];
  const tire = new THREE.MeshStandardMaterial({ color: '#111', roughness: 0.9 });
  const rim = new THREE.MeshStandardMaterial({ color: '#c9ced6', metalness: 0.8, roughness: 0.3 });
  CAR.WHEELS.forEach((w, i) => {
    const front = i < 2;
    const r = front ? CAR.FRONT_WHEEL_RADIUS : CAR.BACK_WHEEL_RADIUS;
    const wwidth = front ? 11 : 14;
    const pivot = new THREE.Group();
    // sim local (x fwd, y left, z up) -> three local (x fwd, y up, z right)
    pivot.position.set(w.x, -CAR.REST_HEIGHT + r + 0.5, -w.y);
    const spin = new THREE.Group();
    const t = new THREE.Mesh(new THREE.CylinderGeometry(r, r, wwidth, 18), tire);
    t.rotation.x = Math.PI / 2;
    spin.add(t);
    const rm = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.6, r * 0.6, wwidth + 0.6, 6), rim);
    rm.rotation.x = Math.PI / 2;
    spin.add(rm);
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
      paint.color.copy(TEAM_COLORS[t]);
      accent.color.copy(TEAM_ACCENTS[t]);
      flameMat.color.set(t === 0 ? '#8fd8ff' : '#ffc070');
    },
  };
}

function ballTexture(): THREE.CanvasTexture {
  const W = 1024;
  const H = 512;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  const grad = g.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, '#d9dde3');
  grad.addColorStop(0.5, '#f1f3f6');
  grad.addColorStop(1, '#d9dde3');
  g.fillStyle = grad;
  g.fillRect(0, 0, W, H);
  // Hexagon panels (equirectangular approximation)
  g.strokeStyle = '#40454f';
  g.lineWidth = 5;
  const size = 46;
  const hw = Math.sqrt(3) * size;
  for (let row = -1; row < H / (size * 1.5) + 1; row++) {
    for (let col = -1; col < W / hw + 1; col++) {
      const cx = col * hw + (row % 2 ? hw / 2 : 0);
      const cy = row * size * 1.5;
      g.beginPath();
      for (let k = 0; k < 6; k++) {
        const a = (Math.PI / 3) * k + Math.PI / 6;
        const x = cx + Math.cos(a) * size;
        const y = cy + Math.sin(a) * size;
        if (k) g.lineTo(x, y);
        else g.moveTo(x, y);
      }
      g.closePath();
      g.stroke();
    }
  }
  // Seam band
  g.fillStyle = '#5b6170';
  g.fillRect(0, H / 2 - 6, W, 12);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

export function createBallModel(): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(BALL.RADIUS, 48, 32),
    new THREE.MeshStandardMaterial({
      map: ballTexture(),
      metalness: 0.15,
      roughness: 0.45,
      emissive: new THREE.Color('#2a2f3a'),
      emissiveIntensity: 0.25,
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
