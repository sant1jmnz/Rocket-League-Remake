import * as THREE from 'three';
import type { CarBody } from '@rl/shared';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { designFor, type Surface } from './car-designs';

// Car models: Octane and Fennec rebuilt from parts (see car-designs.ts). Both use the Octane hitbox,
// like in the real game. Local axes (Three): forward = +X, up = +Y, right = +Z; origin = car origin.

export const TEAM_PAINT = [new THREE.Color('#1d5bff'), new THREE.Color('#ff6a00')];
const TEAM_ACCENT = ['#7fd0ff', '#ffd27a'];

/** Rim radius as a fraction of the tire radius (measured on the reference wheel). */
const RIM_RATIO = 0.77;

/**
 * Chunky off-road style tire: square shoulders, flat tread and V-shaped (chevron) tread blocks,
 * merged into one geometry. Axle along Z.
 */
function tireGeometry(r: number, width: number): THREE.BufferGeometry {
  const hw = width / 2;
  const inner = r * RIM_RATIO;
  const sh = Math.min(2.4, width * 0.2); // shoulder radius
  const base = r - 1.1; // carcass radius below the tread blocks
  const pts: THREE.Vector2[] = [new THREE.Vector2(inner, -hw * 0.92)];
  for (let i = 0; i <= 6; i++) {
    const a = -Math.PI / 2 + (i / 6) * (Math.PI / 2);
    pts.push(new THREE.Vector2(base - sh + Math.cos(a) * sh, -hw + sh + Math.sin(a) * sh));
  }
  for (let i = 0; i <= 6; i++) {
    const a = (i / 6) * (Math.PI / 2);
    pts.push(new THREE.Vector2(base - sh + Math.cos(a) * sh, hw - sh + Math.sin(a) * sh));
  }
  pts.push(new THREE.Vector2(inner, hw * 0.92));
  const carcass = new THREE.LatheGeometry(pts, 40);
  carcass.rotateX(Math.PI / 2);

  // Chevron blocks: two angled lugs per pitch, meeting at the center line
  const lugs: THREE.BufferGeometry[] = [carcass];
  const count = 22;
  const lugLen = hw * 0.95;
  for (let i = 0; i < count; i++) {
    const ang = (i / count) * Math.PI * 2;
    for (const side of [-1, 1]) {
      const lug = new THREE.BoxGeometry(2.6, 1.3, lugLen);
      // angle the lug along the circumference so the pair forms a V
      lug.rotateY(side * 0.55);
      lug.translate(side * 0.9, base + 0.5, side * lugLen * 0.48);
      lug.rotateZ(ang);
      lugs.push(lug.toNonIndexed());
    }
  }
  const merged = mergeGeometries(lugs.map((g) => (g.index ? g.toNonIndexed() : g)));
  merged.computeVertexNormals();
  return merged;
}

/** Deep-dish rim with five split (double) spokes and a center cap. Axle along Z. */
function rimGeometry(r: number, width: number): { metal: THREE.BufferGeometry; dark: THREE.BufferGeometry } {
  const R = r * RIM_RATIO;
  const face = width * 0.32; // spokes sit recessed behind the outer lip
  const dark: THREE.BufferGeometry[] = [];
  const metal: THREE.BufferGeometry[] = [];
  const barrel = new THREE.CylinderGeometry(R * 0.98, R * 0.98, width * 0.9, 32, 1, true);
  barrel.rotateX(Math.PI / 2);
  dark.push(barrel);
  const back = new THREE.CircleGeometry(R * 0.96, 32);
  back.translate(0, 0, -width * 0.2);
  dark.push(back);
  for (const zs of [-1, 1]) {
    const lip = new THREE.TorusGeometry(R * 0.99, 0.55, 6, 40);
    lip.translate(0, 0, zs * width * 0.44);
    metal.push(lip);
  }
  const hub = new THREE.CylinderGeometry(R * 0.2, R * 0.26, 3.2, 14);
  hub.rotateX(Math.PI / 2);
  hub.translate(0, 0, face);
  metal.push(hub);
  const cap = new THREE.CylinderGeometry(R * 0.09, R * 0.09, 3.6, 10);
  cap.rotateX(Math.PI / 2);
  cap.translate(0, 0, face + 0.3);
  dark.push(cap);
  for (let i = 0; i < 5; i++) {
    const ang = (i / 5) * Math.PI * 2;
    for (const split of [-1, 1]) {
      const spoke = new THREE.BoxGeometry(R * 0.11, R * 0.78, 1.4);
      spoke.translate(0, R * 0.58, 0);
      spoke.rotateZ(split * 0.13); // the two halves of a spoke fan out towards the rim
      spoke.rotateX(-0.16); // dish: spokes lean towards the outer face at the hub
      spoke.translate(0, 0, face - 0.6);
      spoke.rotateZ(ang);
      metal.push(spoke);
    }
  }
  const merge = (list: THREE.BufferGeometry[]) => {
    const m = mergeGeometries(list.map((g) => (g.index ? g.toNonIndexed() : g)));
    m.computeVertexNormals();
    return m;
  };
  return { metal: merge(metal), dark: merge(dark) };
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
const rimCache: Record<string, { metal: THREE.BufferGeometry; dark: THREE.BufferGeometry }> = {};

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
  const tireMat = new THREE.MeshStandardMaterial({ color: '#161616', roughness: 0.92 });
  const rimMat = new THREE.MeshStandardMaterial({ color: '#9aa1ab', metalness: 0.9, roughness: 0.28, side: THREE.DoubleSide });
  for (const w of d.wheels) {
    const r = w.front ? d.frontR : d.rearR;
    const ww = w.front ? d.frontW : d.rearW;
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(w.x, w.y, side * w.z);
      const spin = new THREE.Group();
      spin.add(new THREE.Mesh(cached(`tire${r}-${ww}`, () => tireGeometry(r, ww)), tireMat));
      const rg = rimCache[`${r}-${ww}`] ??= rimGeometry(r, ww);
      const metal = new THREE.Mesh(rg.metal, rimMat);
      const dark = new THREE.Mesh(rg.dark, mats.trim);
      // spokes face outwards on both sides of the car
      if (side < 0) {
        metal.scale.z = -1;
        dark.scale.z = -1;
      }
      spin.add(metal, dark);
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
  // long faint tail of the flame (the default boost reaches about a car length)
  const tailMat = new THREE.MeshBasicMaterial({ color: outerColor(team).multiplyScalar(0.5), transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false });
  const tail = new THREE.Mesh(new THREE.ConeGeometry(10, 120, 16, 1, true), tailMat);
  tail.rotation.z = Math.PI / 2;
  tail.position.x = -60;
  flame.add(tail, outer, core);
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
      tailMat.color.copy(outerColor(t).multiplyScalar(0.5));
      nozInnerMat.emissive.set(t === 0 ? '#3aa0ff' : '#ff8a20');
    },
    setBoost(on: boolean, t: number) {
      flame.visible = on;
      if (!on) return;
      outer.scale.set(1, 0.85 + Math.sin(t * 90) * 0.1 + Math.random() * 0.15, 1);
      core.scale.set(1, 0.9 + Math.random() * 0.2, 1);
      const w = 0.9 + Math.random() * 0.2;
      tail.scale.set(w, 0.75 + Math.sin(t * 53) * 0.12 + Math.random() * 0.25, w);
    },
  };
}
