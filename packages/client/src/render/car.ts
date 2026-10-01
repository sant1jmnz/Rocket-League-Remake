import * as THREE from 'three';
import type { CarBody } from '@rl/shared';
import { designFor, type Surface } from './car-designs';

// Car models: Octane and Fennec rebuilt from parts (see car-designs.ts). Both use the Octane hitbox,
// like in the real game. Local axes (Three): forward = +X, up = +Y, right = +Z; origin = car origin.

export const TEAM_PAINT = [new THREE.Color('#1d5bff'), new THREE.Color('#ff6a00')];
const TEAM_ACCENT = ['#7fd0ff', '#ffd27a'];

function tireGeometry(r: number, width: number): THREE.BufferGeometry {
  // Lathe profile (radius, axial) of a chunky tire with rounded shoulders
  const pts: THREE.Vector2[] = [];
  const hw = width / 2;
  const inner = r * 0.62;
  pts.push(new THREE.Vector2(inner, -hw));
  pts.push(new THREE.Vector2(r - 3, -hw));
  for (let i = 0; i <= 6; i++) {
    const a = -Math.PI / 2 + (i / 6) * (Math.PI / 2);
    pts.push(new THREE.Vector2(r - 3 + Math.cos(a) * 3, -hw + 3 + Math.sin(a) * 3));
  }
  for (let i = 0; i <= 6; i++) {
    const a = (i / 6) * (Math.PI / 2);
    pts.push(new THREE.Vector2(r - 3 + Math.cos(a) * 3, hw - 3 + Math.sin(a) * 3));
  }
  pts.push(new THREE.Vector2(inner, hw));
  const geo = new THREE.LatheGeometry(pts, 32);
  geo.rotateX(Math.PI / 2); // lathe axis Y -> Z (wheel axle along car right)
  return geo;
}

function rim(r: number, width: number, mat: THREE.Material, dark: THREE.Material): THREE.Group {
  const g = new THREE.Group();
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.64, r * 0.64, width * 0.8, 24, 1, true), dark);
  barrel.rotation.x = Math.PI / 2;
  g.add(barrel);
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.2, r * 0.24, width * 0.9, 12), mat);
  hub.rotation.x = Math.PI / 2;
  g.add(hub);
  for (let i = 0; i < 5; i++) {
    const spoke = new THREE.Mesh(new THREE.BoxGeometry(r * 0.16, r * 0.62, 2.2), mat);
    spoke.position.y = r * 0.31;
    const pivot = new THREE.Group();
    pivot.rotation.z = (i / 5) * Math.PI * 2;
    pivot.add(spoke);
    for (const side of [-1, 1]) {
      const p = pivot.clone();
      p.position.z = side * (width * 0.38);
      g.add(p);
    }
  }
  return g;
}



export interface CarModel {
  root: THREE.Group;
  body: THREE.Group;
  bodyType: CarBody;
  wheels: { mesh: THREE.Object3D; front: boolean; radius: number }[];
  flame: THREE.Group;
  nozzle: THREE.Vector3;
  setTeam(team: 0 | 1): void;
  setBoost(on: boolean, t: number): void;
}

const geoCache: Record<string, THREE.BufferGeometry> = {};
const cached = (k: string, f: () => THREE.BufferGeometry) => (geoCache[k] ??= f());

export function createCarModel(team: 0 | 1, bodyType: CarBody = 'octane'): CarModel {
  const d = designFor(bodyType);
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);

  const paint = new THREE.MeshPhysicalMaterial({ color: TEAM_PAINT[team], metalness: 0.3, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.06 });
  const accent = new THREE.MeshStandardMaterial({ color: TEAM_ACCENT[team], emissive: TEAM_ACCENT[team], emissiveIntensity: 2.2 });
  const mats: Record<Surface, THREE.Material> = {
    paint,
    glass: new THREE.MeshPhysicalMaterial({ color: '#05080f', metalness: 0.1, roughness: 0.04, clearcoat: 1, clearcoatRoughness: 0.02 }),
    trim: new THREE.MeshStandardMaterial({ color: '#17191e', metalness: 0.35, roughness: 0.55 }),
    chrome: new THREE.MeshStandardMaterial({ color: '#b9c0ca', metalness: 1, roughness: 0.22 }),
    light: new THREE.MeshStandardMaterial({ color: '#ffffff', emissive: '#fff4d6', emissiveIntensity: 4 }),
    tail: new THREE.MeshStandardMaterial({ color: '#ff1a1a', emissive: '#ff1010', emissiveIntensity: 3 }),
    accent,
    red: new THREE.MeshStandardMaterial({ color: '#a8141c', metalness: 0.5, roughness: 0.35 }),
  };

  // Painted parts with a window/trim mask get their own material instance
  const masked: THREE.MeshPhysicalMaterial[] = [];
  const maskedPaint = (glsl: string) => {
    const m = paint.clone();
    m.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vCarPos;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvCarPos = position;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\nvarying vec3 vCarPos;\nvec2 gMask;\n${glsl}`)
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
          gMask = carMask(vCarPos);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.012, 0.016, 0.03), gMask.x);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.06, 0.065, 0.075), gMask.y);`,
        )
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(mix(roughnessFactor, 0.05, gMask.x), 0.6, gMask.y);')
        .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = mix(metalnessFactor, 0.15, max(gMask.x, gMask.y));')
        .replace('#include <lights_physical_fragment>', '#include <lights_physical_fragment>\nmaterial.clearcoat *= 1.0 - gMask.y;');
    };
    // Each mask is different GLSL: give it its own program cache entry
    m.customProgramCacheKey = () => `carMask:${glsl}`;
    masked.push(m);
    return m;
  };

  for (const part of d.parts) {
    const material = part.mask
      ? maskedPaint(part.mask)
      : Array.isArray(part.surface)
        ? part.surface.map((s) => mats[s])
        : mats[part.surface];
    const mesh = new THREE.Mesh(part.geometry, material);
    mesh.castShadow = true;
    body.add(mesh);
  }

  // Wheels
  const wheels: CarModel['wheels'] = [];
  const tireMat = new THREE.MeshStandardMaterial({ color: '#141414', roughness: 0.85 });
  const rimMat = new THREE.MeshStandardMaterial({ color: '#8a919c', metalness: 0.9, roughness: 0.3 });
  for (const w of d.wheels) {
    const r = w.front ? d.frontR : d.rearR;
    const ww = w.front ? d.frontW : d.rearW;
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(w.x, w.y, side * w.z);
      const spin = new THREE.Group();
      spin.add(new THREE.Mesh(cached(`tire${r}-${ww}`, () => tireGeometry(r, ww)), tireMat));
      spin.add(rim(r, ww, rimMat, mats.trim));
      spin.traverse((o) => (o.castShadow = true));
      pivot.add(spin);
      root.add(pivot);
      wheels.push({ mesh: pivot, front: w.front, radius: r });
    }
  }

  // Rocket nozzle
  const nozzle = d.nozzle.clone();
  const noz = new THREE.Mesh(new THREE.CylinderGeometry(6.5, 8, 8, 20, 1, true), mats.trim);
  noz.rotation.z = Math.PI / 2;
  noz.position.copy(nozzle);
  body.add(noz);
  const nozInnerMat = new THREE.MeshStandardMaterial({ color: '#331100', emissive: team === 0 ? '#3aa0ff' : '#ff8a20', emissiveIntensity: 0.6 });
  const nozInner = new THREE.Mesh(new THREE.CircleGeometry(6, 20), nozInnerMat);
  nozInner.rotation.y = -Math.PI / 2;
  nozInner.position.set(nozzle.x - 1, nozzle.y, 0);
  body.add(nozInner);

  // Boost flame: hot white core + team-colored outer flame (bright enough to bloom)
  const flame = new THREE.Group();
  const coreMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(4, 3.6, 3), transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false });
  const outerColor = (t: 0 | 1) => (t === 0 ? new THREE.Color(0.4, 1.4, 4) : new THREE.Color(4, 1.4, 0.3));
  const outerMat = new THREE.MeshBasicMaterial({ color: outerColor(team), transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false });
  const core = new THREE.Mesh(new THREE.ConeGeometry(4.5, 34, 16, 1, true), coreMat);
  const outer = new THREE.Mesh(new THREE.ConeGeometry(8, 70, 16, 1, true), outerMat);
  core.rotation.z = Math.PI / 2;
  outer.rotation.z = Math.PI / 2;
  core.position.x = -17;
  outer.position.x = -35;
  flame.add(outer, core);
  flame.position.set(nozzle.x - 4, nozzle.y, 0);
  flame.visible = false;
  body.add(flame);

  return {
    root,
    body,
    bodyType,
    wheels,
    flame,
    nozzle,
    setTeam(t: 0 | 1) {
      paint.color.copy(TEAM_PAINT[t]);
      for (const m of masked) m.color.copy(TEAM_PAINT[t]);
      accent.color.set(TEAM_ACCENT[t]);
      accent.emissive.set(TEAM_ACCENT[t]);
      outerMat.color.copy(outerColor(t));
      nozInnerMat.emissive.set(t === 0 ? '#3aa0ff' : '#ff8a20');
    },
    setBoost(on: boolean, t: number) {
      flame.visible = on;
      if (!on) return;
      outer.scale.set(1, 0.85 + Math.sin(t * 90) * 0.1 + Math.random() * 0.15, 1);
      core.scale.set(1, 0.9 + Math.random() * 0.2, 1);
    },
  };
}
