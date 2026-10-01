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
const LED_TOP = R + 120; // dark strip of screens above the ramps

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

const FLOOR_BLUE = '#2a4cff';
const FLOOR_ORANGE = '#ffa024';

/**
 * Field floor in the style of the current DFH Stadium, mapped over x∈[-4096,4096], y∈[-6000,6000]:
 * olive turf with cross bands, a team-colored hex "circuit" and thick lane stripes on each half,
 * dark hex-mesh pads in front of the goals and along the side walls, a grey metal cross through
 * the middle and a hexagonal center pad. Returns the color map and an emissive map for the glowing
 * team lines. Layout measured from a top-down reference; everything is drawn here.
 */
function fieldTexture(): { map: THREE.CanvasTexture; glow: THREE.CanvasTexture } {
  const W = 2048;
  const Hh = 3000;
  const mk = () => {
    const c = document.createElement('canvas');
    c.width = W;
    c.height = Hh;
    return { c, g: c.getContext('2d')! };
  };
  const base = mk();
  const emit = mk();
  const g = base.g;
  const e = emit.g;
  const sx = (x: number) => ((x + 4096) / 8192) * W;
  const sy = (y: number) => ((6000 - y) / 12000) * Hh; // +Y (orange) at the top
  const su = (d: number) => (d / 8192) * W;
  const both = (fn: (ctx: CanvasRenderingContext2D) => void) => {
    fn(g);
    fn(e);
  };
  /** Path through points given as (x, d) in one quarter, mirrored to the requested quadrant. */
  const quarterPath = (ctx: CanvasRenderingContext2D, pts: number[][], mx: number, side: number) => {
    ctx.beginPath();
    pts.forEach(([x, d], i) => (i ? ctx.lineTo(sx(mx * x), sy(side * d)) : ctx.moveTo(sx(mx * x), sy(side * d))));
    ctx.closePath();
  };
  /** A zone mirrored across x = 0 (pts go from x = 0 out and back). */
  const halfPath = (ctx: CanvasRenderingContext2D, pts: number[][], side: number) => {
    const full = [...pts, ...pts.slice().reverse().map(([x, d]) => [-x, d])];
    quarterPath(ctx, full, 1, side);
  };
  const octagon = (ctx: CanvasRenderingContext2D, inset = 0) => {
    ctx.beginPath();
    SHRUNK_OCTAGON.forEach(([x, y], i) => {
      const k = 1 - inset / Math.hypot(x, y);
      if (i) ctx.lineTo(sx(x * k), sy(y * k));
      else ctx.moveTo(sx(x * k), sy(y * k));
    });
    ctx.closePath();
  };
  const hexGrid = (ctx: CanvasRenderingContext2D, r: number, stretch: number, color: string, width: number) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = su(width);
    ctx.beginPath();
    // pointy-ended hexes (vertices at ±y): their straight sides run along y, the field's length
    const w = r * Math.sqrt(3);
    const h = r * 1.5 * stretch;
    for (let j = -Math.ceil(6200 / h) - 1; j <= Math.ceil(6200 / h) + 1; j++) {
      for (let i = -Math.ceil(4200 / w) - 1; i <= Math.ceil(4200 / w) + 1; i++) {
        const cx = i * w + (Math.abs(j) % 2 ? w / 2 : 0);
        const cy = j * h;
        // right half of each cell; the neighbours draw the rest
        for (let k = 0; k < 3; k++) {
          const a0 = (k * Math.PI) / 3;
          const a1 = ((k + 1) * Math.PI) / 3;
          ctx.moveTo(sx(cx + Math.sin(a0) * r), sy(cy + Math.cos(a0) * r * stretch));
          ctx.lineTo(sx(cx + Math.sin(a1) * r), sy(cy + Math.cos(a1) * r * stretch));
        }
      }
    }
    ctx.stroke();
  };
  const halves = [
    { side: -1, color: FLOOR_BLUE },
    { side: 1, color: FLOOR_ORANGE },
  ];
  const clipHalf = (ctx: CanvasRenderingContext2D, side: number) => {
    ctx.beginPath();
    ctx.rect(0, side > 0 ? 0 : sy(0), W, Hh / 2);
    ctx.clip();
  };

  // Everything outside the turf (goal floors) is dark metal
  g.fillStyle = '#16191e';
  g.fillRect(0, 0, W, Hh);
  e.fillStyle = '#000';
  e.fillRect(0, 0, W, Hh);

  // Turf: olive base, strong bands across the field and faint ones along it
  g.save();
  octagon(g);
  g.clip();
  g.fillStyle = '#4f6a48';
  g.fillRect(0, 0, W, Hh);
  for (let y = -6000, i = 0; y < 6000; y += 260, i++) {
    if (i % 2) continue;
    g.fillStyle = 'rgba(20,35,15,0.16)';
    g.fillRect(0, sy(y + 260), W, sy(y) - sy(y + 260));
  }
  for (let x = -4096, i = 0; x < 4096; x += 256, i++) {
    if (i % 2) continue;
    g.fillStyle = 'rgba(20,35,15,0.07)';
    g.fillRect(sx(x), 0, su(256), Hh);
  }
  // Lighter worn lanes from the corners toward the center
  g.strokeStyle = 'rgba(160,190,140,0.10)';
  g.lineWidth = su(160);
  for (const mx of [-1, 1])
    for (const side of [-1, 1]) {
      g.beginPath();
      g.moveTo(sx(mx * 3100), sy(side * 4100));
      g.lineTo(sx(mx * 2400), sy(side * 3500));
      g.lineTo(sx(mx * 900), sy(side * 1000));
      g.stroke();
    }
  g.restore();

  // Team circuit + lane stripes, clipped to the turf of each half
  for (const { side, color } of halves) {
    for (const ctx of [g, e]) {
      ctx.save();
      octagon(ctx, 40);
      ctx.clip();
      clipHalf(ctx, side);
      ctx.globalAlpha = ctx === g ? 0.4 : 0.22;
      hexGrid(ctx, 280, 2.6, color, 18);
      ctx.globalAlpha = ctx === g ? 0.62 : 0.3;
      ctx.fillStyle = color;
      for (const mx of [-1, 1]) {
        for (const [x, d0, d1] of [
          [830, 1120, 3080],
          [1850, 460, 3960],
          [2910, 1120, 2960],
        ]) {
          // parallelogram with a 45° cut on the end that points to the center
          quarterPath(ctx, [[x - 90, d0 + 180], [x + 90, d0], [x + 90, d1], [x - 90, d1]], mx, side);
          ctx.fill();
        }
        // broken dashes continuing the outer stripe toward the corner
        for (let t = 0; t < 5; t++) {
          const d = 3060 + t * 190;
          const x = 2960 + t * 140;
          quarterPath(ctx, [[x - 90, d], [x + 90, d], [x + 140, d + 70], [x - 40, d + 70]], mx, side);
          ctx.fill();
        }
      }
      ctx.globalAlpha = ctx === g ? 0.5 : 0.25;
      ctx.strokeStyle = color;
      ctx.lineWidth = su(14);
      for (const mx of [-1, 1])
        for (const off of [-130, 130]) {
          ctx.beginPath();
          ctx.moveTo(sx(mx * (1850 + off)), sy(side * 700));
          ctx.lineTo(sx(mx * (1850 + off)), sy(side * 3800));
          ctx.stroke();
        }
      ctx.restore();
    }
  }

  // Center circle (dashed, white)
  g.save();
  g.setLineDash([su(60), su(50)]);
  g.strokeStyle = 'rgba(235,240,245,0.45)';
  g.lineWidth = su(12);
  g.beginPath();
  g.arc(sx(0), sy(0), su(1700), 0, Math.PI * 2);
  g.stroke();
  g.restore();

  // Dark hex-mesh zones: in front of each goal (into the goal mouth) and along the side walls
  const goalZone = [
    [0, 5200],
    [GOAL.HALF_WIDTH + 40, 5200],
    [GOAL.HALF_WIDTH + 40, 4840],
    [2060, 4840],
    [2060, 3900],
    [1180, 3080],
    [0, 3080],
  ];
  const sideZone = [
    [3320, 260],
    [3420, 160],
    [3900, 160],
    [3900, 3080],
    [3760, 3080],
    [3320, 2640],
  ];
  for (const { side, color } of halves) {
    const zones = (ctx: CanvasRenderingContext2D) => {
      ctx.beginPath();
      const add = (pts: number[][], mx: number) =>
        pts.forEach(([x, d], i) => (i ? ctx.lineTo(sx(mx * x), sy(side * d)) : ctx.moveTo(sx(mx * x), sy(side * d))));
      add([...goalZone, ...goalZone.slice().reverse().map(([x, d]) => [-x, d])], 1);
      ctx.closePath();
      for (const mx of [-1, 1]) {
        add(sideZone, mx);
        ctx.closePath();
      }
    };
    // soft glowing outline
    both((ctx) => {
      ctx.save();
      octagon(ctx);
      ctx.clip();
      zones(ctx);
      ctx.strokeStyle = color;
      ctx.lineWidth = su(22);
      ctx.shadowColor = color;
      ctx.shadowBlur = su(90);
      ctx.stroke();
      ctx.restore();
    });
    g.save();
    zones(g);
    g.fillStyle = '#15181d';
    g.fill();
    g.clip();
    hexGrid(g, 175, 1, color, 9);
    g.restore();
    e.save();
    zones(e);
    e.fillStyle = '#000';
    e.fill();
    e.clip();
    e.globalAlpha = 0.2;
    hexGrid(e, 175, 1, color, 9);
    e.restore();
    // white inner outline of the goal zone + post lines
    g.save();
    g.strokeStyle = 'rgba(215,220,226,0.85)';
    g.lineWidth = su(14);
    halfPath(g, [[0, 4760], [1980, 4760], [1980, 3930], [1150, 3160], [0, 3160]], side);
    g.stroke();
    g.setLineDash([su(40), su(30)]);
    for (const mx of [-1, 1]) {
      g.beginPath();
      g.moveTo(sx(mx * 940), sy(side * 4320));
      g.lineTo(sx(mx * 940), sy(side * 3240));
      g.stroke();
    }
    g.restore();
  }

  // Grey metal cross: along the length (center pad → goal zones) and across the midline
  const metalStrip = (x0: number, y0: number, x1: number, y1: number) => {
    g.fillStyle = '#2a2d32';
    g.fillRect(sx(x0) - su(24), sy(y1) - su(24), su(x1 - x0) + su(48), sy(y0) - sy(y1) + su(48));
    e.fillStyle = '#000';
    e.fillRect(sx(x0) - su(24), sy(y1) - su(24), su(x1 - x0) + su(48), sy(y0) - sy(y1) + su(48));
    g.fillStyle = '#7a7e85';
    g.fillRect(sx(x0), sy(y1), su(x1 - x0), sy(y0) - sy(y1));
    g.fillStyle = 'rgba(255,255,255,0.18)';
    const vertical = y1 - y0 > x1 - x0;
    if (vertical) g.fillRect(sx((x0 + x1) / 2) - su(8), sy(y1), su(16), sy(y0) - sy(y1));
    else g.fillRect(sx(x0), sy((y0 + y1) / 2) - su(8), su(x1 - x0), su(16));
  };
  metalStrip(-100, -3080, 100, 3080);
  metalStrip(-3840, -120, 3840, 120);

  // Center pad: dark hex disc with a team-colored rim on each half and a metal vent in the middle
  for (const { side, color } of halves) {
    g.save();
    g.beginPath();
    g.arc(sx(0), sy(0), su(707), side < 0 ? 0 : Math.PI, side < 0 ? Math.PI : Math.PI * 2);
    g.closePath();
    g.fillStyle = '#15181d';
    g.fill();
    g.clip();
    hexGrid(g, 150, 1, color, 12);
    g.restore();
    e.save();
    e.beginPath();
    e.arc(sx(0), sy(0), su(707), 0, Math.PI * 2);
    e.fillStyle = '#000';
    e.fill();
    e.restore();
    both((ctx) => {
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = su(22);
      ctx.shadowColor = color;
      ctx.shadowBlur = su(60);
      ctx.beginPath();
      ctx.arc(sx(0), sy(0), su(660), side < 0 ? 0 : Math.PI, side < 0 ? Math.PI : Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    });
  }
  g.strokeStyle = '#7a7e85';
  g.lineWidth = su(40);
  g.beginPath();
  g.arc(sx(0), sy(0), su(725), 0, Math.PI * 2);
  g.stroke();
  g.fillStyle = '#5d6066';
  g.beginPath();
  g.arc(sx(0), sy(0), su(214), 0, Math.PI * 2);
  g.fill();
  g.fillStyle = 'rgba(20,22,26,0.7)';
  for (let x = -200; x <= 200; x += 36)
    for (let y = -200; y <= 200; y += 36) {
      if (Math.hypot(x, y) > 190) continue;
      g.beginPath();
      g.arc(sx(x), sy(y), su(9), 0, Math.PI * 2);
      g.fill();
    }

  // Team line where the turf meets the ramps
  for (const { side, color } of halves)
    both((ctx) => {
      ctx.save();
      clipHalf(ctx, side);
      octagon(ctx, 12);
      ctx.strokeStyle = color;
      ctx.lineWidth = su(20);
      ctx.shadowColor = color;
      ctx.shadowBlur = su(70);
      ctx.stroke();
      ctx.restore();
    });

  const tex = (c: HTMLCanvasElement) => {
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 16;
    return t;
  };
  return { map: tex(base.c), glow: tex(emit.c) };
}

/** Floor material: marking texture (field UVs) × tiled grass detail (world UVs). */
function turfMaterial(markings: { map: THREE.Texture; glow: THREE.Texture }): THREE.MeshStandardMaterial {
  const tile = grassTile();
  const mat = new THREE.MeshStandardMaterial({
    map: markings.map,
    emissive: '#ffffff',
    emissiveMap: markings.glow,
    emissiveIntensity: 1.4,
    roughness: 0.9,
    metalness: 0,
  });
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

/**
 * Curved ramps: grey metal gutter split into panels, with a darker groove along the middle and a
 * glowing team-colored line at the bottom (turf side) and the top (wall side).
 * UVs: x = distance along the perimeter, y = distance along the ramp profile (0 → ~402).
 */
/** Length of the ramp's quarter-circle profile as tessellated by profile() (UV y at the ramp top). */
function rampProfileLength(): number {
  const prof = profile();
  let len = 0;
  for (let j = 1; j < prof.length && prof[j - 1][2] === 'ramp'; j++) len += Math.hypot(prof[j][0] - prof[j - 1][0], prof[j][1] - prof[j - 1][1]);
  return len;
}

function rampMaterial(): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, color: '#ffffff', metalness: 0.75, roughness: 0.42 });
  const rampLen = rampProfileLength();
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vRamp;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvRamp = uv;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vRamp;')
      .replace(
        '#include <color_fragment>',
        `vec3 teamCol = vColor.rgb;
        float v = vRamp.y;
        float pm = mod(vRamp.x, 560.0);
        float seam = 1.0 - smoothstep(4.0, 9.0, min(pm, 560.0 - pm));
        float groove = smoothstep(150.0, 160.0, v) * (1.0 - smoothstep(240.0, 250.0, v));
        float rib = step(0.5, fract(vRamp.x / 70.0)) * groove;
        vec3 metal = vec3(0.36, 0.375, 0.40);
        metal = mix(metal, vec3(0.16, 0.17, 0.19), groove * 0.85);
        metal *= 1.0 - rib * 0.25;
        metal *= 1.0 - seam * 0.5;
        float edgeLo = 1.0 - smoothstep(14.0, 26.0, v);
        float edgeHi = smoothstep(${(rampLen - 26).toFixed(1)}, ${(rampLen - 12).toFixed(1)}, v);
        float teamLine = max(edgeLo, edgeHi);
        diffuseColor.rgb = mix(metal, teamCol, teamLine);`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\ntotalEmissiveRadiance += teamCol * teamLine * 2.2;',
      );
  };
  return mat;
}

/**
 * Strip above the ramps: dark metal housing a row of screens that glow in the team color, with
 * a bright team line along the top edge. UVs: x = perimeter distance, y = profile distance.
 */
function screenStripMaterial(): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, color: '#ffffff', metalness: 0.6, roughness: 0.4 });
  const y0 = rampProfileLength();
  const h = LED_TOP - R;
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vStrip;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvStrip = uv;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vStrip;')
      .replace(
        '#include <color_fragment>',
        `vec3 teamCol = vColor.rgb;
        float t = clamp((vStrip.y - ${y0.toFixed(1)}) / ${h.toFixed(1)}, 0.0, 1.0);
        float px = mod(vStrip.x, 620.0);
        float screen = step(30.0, px) * step(px, 590.0) * step(0.18, t) * step(t, 0.78);
        // screen content: a soft horizontal gradient with scan bands
        float scan = 0.75 + 0.25 * step(0.5, fract(vStrip.y / 9.0));
        float content = (0.35 + 0.65 * smoothstep(590.0, 30.0, px)) * scan;
        float topLine = smoothstep(0.86, 0.92, t);
        float bottomLine = 1.0 - smoothstep(0.04, 0.1, t);
        diffuseColor.rgb = mix(vec3(0.07, 0.075, 0.085), vec3(0.02), screen);`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        totalEmissiveRadiance += teamCol * (screen * content * 1.1 + topLine * 2.6 + bottomLine * 0.8);`,
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

  // distance-to-edge of a hex cell (0.5 on the edges)
  float hexDist(vec2 p) {
    vec2 r = vec2(1.0, 1.7320508);
    vec2 h = r * 0.5;
    vec2 a = mod(p, r) - h;
    vec2 b = mod(p - h, r) - h;
    vec2 g = dot(a, a) < dot(b, b) ? a : b;
    vec2 q = abs(g);
    return max(dot(q, normalize(r)), q.x);
  }

  void main() {
    vec3 viewDir = normalize(cameraPosition - vWorld);
    float fres = pow(1.0 - abs(dot(viewDir, normalize(vNormal))), 3.0);
    // big honeycomb (~650 uu cells) with thin team-colored lines, like the arena shell
    float d = hexDist(vUv / 650.0);
    float aa = fwidth(d) * 1.5;
    float hex = smoothstep(0.491 - aa, 0.491, d) * uHex;
    float height = vWorld.y;
    // team glow rising from the base of the walls
    float low = smoothstep(900.0, 380.0, height);
    vec3 tint = mix(vec3(0.75, 0.85, 1.0), vColor, 0.45);
    vec3 col = mix(tint, vColor * 0.9, hex) * (0.7 + low * 0.9);
    float alpha = uOpacity + hex * 0.5 + fres * 0.14 + low * 0.16;
    gl_FragColor = vec4(col, clamp(alpha, 0.0, 0.75));
  }
`;

const netFragment = /* glsl */ `
  uniform vec3 uColor;
  varying vec3 vWorld;
  varying vec3 vNormal;
  void main() {
    vec3 n = abs(vNormal);
    vec2 uv = n.x > 0.5 ? vWorld.zy : (n.y > 0.5 ? vWorld.xz : vWorld.xy);
    // fine square grid on tinted glass
    vec2 g = abs(fract(uv / 70.0) - 0.5);
    float aa = fwidth(uv.x / 70.0) * 1.5;
    float line = smoothstep(0.47 - aa, 0.47, max(g.x, g.y));
    vec3 col = mix(uColor * 0.6, vec3(0.9, 0.95, 1.0), 0.35 + line * 0.4);
    gl_FragColor = vec4(col, 0.10 + line * 0.32);
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

/** U-shaped rounded frame around a goal opening (three coords), offset by `grow` uu outwards. */
function goalArch(z: number, grow: number, corner: number): THREE.CurvePath<THREE.Vector3> {
  const w = GOAL.HALF_WIDTH + grow;
  const h = GOAL.HEIGHT + grow;
  const c = corner;
  const path = new THREE.CurvePath<THREE.Vector3>();
  const V = (x: number, y: number) => new THREE.Vector3(x, y, z);
  const arc = (cx: number, cy: number, a0: number, a1: number) => {
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= 8; i++) {
      const a = a0 + ((a1 - a0) * i) / 8;
      pts.push(V(cx + Math.cos(a) * c, cy + Math.sin(a) * c));
    }
    return new THREE.CatmullRomCurve3(pts);
  };
  path.add(new THREE.LineCurve3(V(-w, -10), V(-w, h - c)));
  path.add(arc(-w + c, h - c, Math.PI, Math.PI / 2));
  path.add(new THREE.LineCurve3(V(-w + c, h), V(w - c, h)));
  path.add(arc(w - c, h - c, Math.PI / 2, 0));
  path.add(new THREE.LineCurve3(V(w, h - c), V(w, -10)));
  return path;
}

/**
 * Goal frames as in the current DFH Stadium: a rounded dark metal frame around the mouth with a
 * glowing team-colored tube on its face, a smaller frame at the back and glowing rails joining
 * them along the top corners.
 */
function goalFrame(side: 1 | -1, color: THREE.Color): THREE.Group {
  const grp = new THREE.Group();
  const metal = new THREE.MeshStandardMaterial({ color: '#1d2026', metalness: 0.8, roughness: 0.35 });
  const glow = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 1.5, roughness: 0.4 });
  const zMouth = -side * ARENA.HALF_LENGTH;
  const zBack = -side * (GOAL_BACK - 30);
  const front = new THREE.Mesh(new THREE.TubeGeometry(goalArch(zMouth - side * 20, 46, 170), 120, 46, 12), metal);
  front.castShadow = true;
  grp.add(front);
  const frontGlow = new THREE.Mesh(new THREE.TubeGeometry(goalArch(zMouth + side * 26, 46, 170), 120, 18, 10), glow);
  grp.add(frontGlow);
  const inner = new THREE.Mesh(new THREE.TubeGeometry(goalArch(zMouth - side * 30, 6, 140), 120, 8, 8), glow);
  grp.add(inner);
  const back = new THREE.Mesh(new THREE.TubeGeometry(goalArch(zBack, 20, 150), 120, 30, 10), metal);
  grp.add(back);
  const backGlow = new THREE.Mesh(new THREE.TubeGeometry(goalArch(zBack + side * 30, 20, 150), 120, 10, 8), glow);
  grp.add(backGlow);
  for (const sx of [-1, 1]) {
    const rail = new THREE.Mesh(
      new THREE.TubeGeometry(
        new THREE.LineCurve3(
          new THREE.Vector3(sx * (GOAL.HALF_WIDTH - 60), GOAL.HEIGHT + 4, zMouth),
          new THREE.Vector3(sx * (GOAL.HALF_WIDTH - 60), GOAL.HEIGHT + 4, zBack),
        ),
        8,
        9,
        8,
      ),
      glow,
    );
    grp.add(rail);
  }
  return grp;
}

/** Dark hex-tiled apron outside the walls, lit by team-colored hex lines (blue half / orange half). */
function apron(): THREE.Mesh {
  const shape = new THREE.Shape();
  const ax = 6144;
  const ay = 7166;
  const c = 900;
  shape.moveTo(-ax + c, -ay);
  shape.lineTo(ax - c, -ay);
  shape.lineTo(ax, -ay + c);
  shape.lineTo(ax, ay - c);
  shape.lineTo(ax - c, ay);
  shape.lineTo(-ax + c, ay);
  shape.lineTo(-ax, ay - c);
  shape.lineTo(-ax, -ay + c);
  const geo = new THREE.ShapeGeometry(shape);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshStandardMaterial({ color: '#121418', metalness: 0.6, roughness: 0.45 });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uBlue = { value: BLUE };
    shader.uniforms.uOrange = { value: ORANGE };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vApron;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvApron = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vApron;\nuniform vec3 uBlue;\nuniform vec3 uOrange;')
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        vec2 p = vApron.xz / 300.0;
        vec2 r = vec2(1.0, 1.7320508);
        vec2 ha = mod(p, r) - r * 0.5;
        vec2 hb = mod(p - r * 0.5, r) - r * 0.5;
        vec2 hg = dot(ha, ha) < dot(hb, hb) ? ha : hb;
        vec2 hq = abs(hg);
        float hd = max(dot(hq, normalize(r)), hq.x);
        float hexLine = smoothstep(0.455, 0.485, hd);
        vec3 team = vApron.z > 0.0 ? uBlue : uOrange;
        float fade = 1.0 - smoothstep(5500.0, 7400.0, length(vApron.xz * vec2(1.15, 1.0)));
        diffuseColor.rgb *= 1.0 - hexLine * 0.3;
        totalEmissiveRadiance += team * hexLine * (0.25 + 0.55 * fade);`,
      );
  };
  const m = new THREE.Mesh(geo, mat);
  m.position.y = -3;
  m.receiveShadow = true;
  return m;
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
  const ramp = new THREE.Mesh(walls.ramp, rampMaterial());
  ramp.receiveShadow = true;
  group.add(ramp);

  const led = new THREE.Mesh(walls.led, screenStripMaterial());
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
  const wallMesh = new THREE.Mesh(walls.wall, glassMat(0.03, 1.0));
  wallMesh.renderOrder = 2;
  group.add(wallMesh);
  // The ceiling is clear glass: only the honeycomb lines and a faint fresnel sheen show
  const ceilMesh = new THREE.Mesh(walls.ceiling, glassMat(0.0, 0.75));
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

  group.add(apron());
  group.add(buildStadium());
  return { group };
}
