import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';

// Daytime stadium lighting: physical sky + clouds, a sun with soft shadows over the field and an
// HDR environment (Poly Haven "Quarry 01", CC0) for glossy reflections on paint, metal and glass.

export const SUN_DIR = new THREE.Vector3(0.45, 0.78, 0.43).normalize();

function cloudTexture(): THREE.CanvasTexture {
  const W = 2048;
  const H = 512;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  // Value-noise fBm painted as soft puffs
  const rand = mulberry(7);
  for (let layer = 0; layer < 3; layer++) {
    const count = [70, 160, 380][layer];
    const size = [220, 110, 50][layer];
    for (let i = 0; i < count; i++) {
      const x = rand() * W;
      const y = H * (0.25 + rand() * 0.6);
      const r = size * (0.5 + rand());
      const grd = g.createRadialGradient(x, y, 0, x, y, r);
      const a = 0.16 + rand() * 0.18;
      grd.addColorStop(0, `rgba(255,255,255,${a})`);
      grd.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grd;
      // wrap horizontally
      for (const dx of [-W, 0, W]) {
        g.save();
        g.translate(dx, 0);
        g.scale(1.8, 0.55);
        g.beginPath();
        g.arc(x / 1.8, y / 0.55, r, 0, Math.PI * 2);
        g.fill();
        g.restore();
      }
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  return tex;
}

function mulberry(seed: number) {
  let s = seed;
  return () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Environment {
  sun: THREE.DirectionalLight;
  update(dt: number): void;
}

export function setupEnvironment(renderer: THREE.WebGLRenderer, scene: THREE.Scene): Environment {
  // Physical sky
  const sky = new Sky();
  sky.scale.setScalar(55000);
  const u = sky.material.uniforms;
  u.turbidity.value = 4;
  u.rayleigh.value = 1.2;
  u.mieCoefficient.value = 0.004;
  u.mieDirectionalG.value = 0.85;
  u.sunPosition.value.copy(SUN_DIR);
  scene.add(sky);

  // Cloud dome
  const clouds = new THREE.Mesh(
    new THREE.SphereGeometry(48000, 48, 16, 0, Math.PI * 2, 0, Math.PI * 0.48),
    new THREE.MeshBasicMaterial({ map: cloudTexture(), transparent: true, depthWrite: false, side: THREE.BackSide, fog: false }),
  );
  clouds.renderOrder = -1;
  scene.add(clouds);

  scene.fog = new THREE.Fog('#b9d3ec', 16000, 52000);

  // Lights
  scene.add(new THREE.HemisphereLight('#cfe4ff', '#4a5a3a', 0.55));
  const sun = new THREE.DirectionalLight('#fff4e0', 2.6);
  sun.position.copy(SUN_DIR).multiplyScalar(12000);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  const sc = sun.shadow.camera as THREE.OrthographicCamera;
  sc.left = -7000;
  sc.right = 7000;
  sc.top = 7500;
  sc.bottom = -7500;
  sc.near = 1000;
  sc.far = 26000;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 2;
  scene.add(sun);
  scene.add(sun.target);

  // Image-based lighting
  const pmrem = new THREE.PMREMGenerator(renderer);
  new HDRLoader().load(
    `${import.meta.env.BASE_URL}env/quarry_01_1k.hdr`,
    (hdr) => {
      const env = pmrem.fromEquirectangular(hdr).texture;
      scene.environment = env;
      scene.environmentIntensity = 0.9;
      hdr.dispose();
      pmrem.dispose();
    },
    undefined,
    () => {
      // Fallback: neutral room environment if the HDR cannot be loaded
      void import('three/examples/jsm/environments/RoomEnvironment.js').then(({ RoomEnvironment }) => {
        scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
      });
    },
  );

  let t = 0;
  return {
    sun,
    update(dt: number) {
      t += dt;
      clouds.rotation.y = t * 0.002;
    },
  };
}
