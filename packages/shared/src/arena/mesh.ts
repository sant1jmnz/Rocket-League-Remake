import type { Vec3 } from '../math/vec.js';
import { ARENA_MESH_PIECES, type MeshPiece } from './meshdata.js';

// The real standard arena collision mesh (the same triangles the game collides against): the
// corner, goal and ramp pieces mirrored into the four quadrants, plus the flat floor, ceiling and
// side walls. Queries go through a uniform grid whose cells list every triangle within PAD of the
// cell, so distance queries are exact up to PAD and short rays only need one cell.

/** Distance (uu) up to which arenaQuery is exact; farther points report PAD. */
export const ARENA_QUERY_PAD = 160;
const PAD = ARENA_QUERY_PAD;
const CELL = 128;
const MIN_X = -4224;
const MIN_Y = -6144;
const MIN_Z = -128;
const NX = Math.ceil((4224 - MIN_X) / CELL);
const NY = Math.ceil((6144 - MIN_Y) / CELL);
const NZ = Math.ceil((2176 - MIN_Z) / CELL);

// Triangle i: T[i*16 + 0..8] = a, b, c; 9..11 = unit normal (into the field);
// 12..15 = bounding sphere (center, radius)
const STRIDE = 16;
let T: Float64Array;
let triCount = 0;
let cellStart: Int32Array;
let cellTris: Int32Array;

function decode(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function pieceTriangles(piece: MeshPiece, out: number[][]): void {
  const vb = decode(piece.verts);
  const ib = decode(piece.ids);
  const vd = new DataView(vb.buffer);
  const id = new DataView(ib.buffer);
  const vert = (i: number): [number, number, number] => [
    vd.getFloat32(i * 12, true),
    vd.getFloat32(i * 12 + 4, true) + piece.yOffset,
    vd.getFloat32(i * 12 + 8, true),
  ];
  for (const [sx, sy] of [
    [1, 1],
    [-1, 1],
    [1, -1],
    [-1, -1],
  ]) {
    for (let t = 0; t < ib.length; t += 6) {
      const v = [id.getUint16(t, true), id.getUint16(t + 2, true), id.getUint16(t + 4, true)].map((i) => {
        const p = vert(i);
        return [p[0] * sx, p[1] * sy, p[2]];
      });
      // a single mirror flips the winding
      if (sx * sy < 0) out.push([...v[0], ...v[2], ...v[1]]);
      else out.push([...v[0], ...v[1], ...v[2]]);
    }
  }
}

function quad(out: number[][], p: number[], e1: number[], e2: number[]): void {
  const c = (s1: number, s2: number) => [0, 1, 2].map((k) => p[k] + e1[k] * s1 + e2[k] * s2);
  // e1 × e2 is the inward normal
  out.push([...c(-1, -1), ...c(1, -1), ...c(1, 1)], [...c(-1, -1), ...c(1, 1), ...c(-1, 1)]);
}

/** Closest point on triangle i to (px, py, pz), written to CP. Ericson, RTCD 5.1.5. */
const CP = [0, 0, 0];
function closestOnTri(i: number, px: number, py: number, pz: number): void {
  const o = i * STRIDE;
  const ax = T[o], ay = T[o + 1], az = T[o + 2];
  const bx = T[o + 3], by = T[o + 4], bz = T[o + 5];
  const cx = T[o + 6], cy = T[o + 7], cz = T[o + 8];
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return set(ax, ay, az);
  const bpx = px - bx, bpy = py - by, bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return set(bx, by, bz);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return set(ax + abx * v, ay + aby * v, az + abz * v);
  }
  const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return set(cx, cy, cz);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return set(ax + acx * w, ay + acy * w, az + acz * w);
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return set(bx + (cx - bx) * w, by + (cy - by) * w, bz + (cz - bz) * w);
  }
  const denom = 1 / (va + vb + vc);
  const v = vb * denom;
  const w = vc * denom;
  set(ax + abx * v + acx * w, ay + aby * v + acy * w, az + abz * v + acz * w);
}
function set(x: number, y: number, z: number): void {
  CP[0] = x;
  CP[1] = y;
  CP[2] = z;
}

function build(): void {
  const tris: number[][] = [];
  for (const piece of Object.values(ARENA_MESH_PIECES)) pieceTriangles(piece, tris);
  quad(tris, [0, 0, 0], [4096, 0, 0], [0, 5500, 0]); // floor
  quad(tris, [0, 0, 2048], [0, 5120, 0], [4096, 0, 0]); // ceiling
  quad(tris, [4096, 0, 1024], [0, 0, 1024], [0, 5120, 0]); // side walls
  quad(tris, [-4096, 0, 1024], [0, 5120, 0], [0, 0, 1024]);

  T = new Float64Array(tris.length * STRIDE);
  for (let i = 0; i < tris.length; i++) {
    const t = tris[i];
    const e1 = [t[3] - t[0], t[4] - t[1], t[5] - t[2]];
    const e2 = [t[6] - t[0], t[7] - t[1], t[8] - t[2]];
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const l = Math.hypot(n[0], n[1], n[2]);
    if (l < 1e-6) continue; // degenerate
    T.set(t, triCount * STRIDE);
    T.set([n[0] / l, n[1] / l, n[2] / l], triCount * STRIDE + 9);
    const cen = [0, 1, 2].map((k) => (t[k] + t[3 + k] + t[6 + k]) / 3);
    const rad = Math.max(
      ...[0, 3, 6].map((j) => Math.hypot(t[j] - cen[0], t[j + 1] - cen[1], t[j + 2] - cen[2])),
    );
    T.set([...cen, rad], triCount * STRIDE + 12);
    triCount++;
  }

  // Grid: a triangle goes into every cell whose center is within PAD + half the cell diagonal
  const reach = PAD + (CELL * Math.sqrt(3)) / 2;
  // [triangle, distance to the cell center] pairs, sorted so that queries find a close triangle
  // first and can skip the rest with cheap bounds
  const lists: number[][] = Array.from({ length: NX * NY * NZ }, () => []);
  for (let i = 0; i < triCount; i++) {
    const o = i * STRIDE;
    const lo = [0, 1, 2].map((k) => Math.min(T[o + k], T[o + 3 + k], T[o + 6 + k]) - reach);
    const hi = [0, 1, 2].map((k) => Math.max(T[o + k], T[o + 3 + k], T[o + 6 + k]) + reach);
    const ix0 = Math.max(0, Math.floor((lo[0] - MIN_X) / CELL));
    const iy0 = Math.max(0, Math.floor((lo[1] - MIN_Y) / CELL));
    const iz0 = Math.max(0, Math.floor((lo[2] - MIN_Z) / CELL));
    const ix1 = Math.min(NX - 1, Math.floor((hi[0] - MIN_X) / CELL));
    const iy1 = Math.min(NY - 1, Math.floor((hi[1] - MIN_Y) / CELL));
    const iz1 = Math.min(NZ - 1, Math.floor((hi[2] - MIN_Z) / CELL));
    for (let ix = ix0; ix <= ix1; ix++)
      for (let iy = iy0; iy <= iy1; iy++)
        for (let iz = iz0; iz <= iz1; iz++) {
          const px = MIN_X + (ix + 0.5) * CELL;
          const py = MIN_Y + (iy + 0.5) * CELL;
          const pz = MIN_Z + (iz + 0.5) * CELL;
          const pd = (px - T[o]) * T[o + 9] + (py - T[o + 1]) * T[o + 10] + (pz - T[o + 2]) * T[o + 11];
          if (Math.abs(pd) > reach) continue;
          closestOnTri(i, px, py, pz);
          const dx = CP[0] - px, dy = CP[1] - py, dz = CP[2] - pz;
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 <= reach * reach) lists[(ix * NY + iy) * NZ + iz].push(i, d2);
        }
  }
  cellStart = new Int32Array(lists.length + 1);
  let total = 0;
  for (let c = 0; c < lists.length; c++) {
    cellStart[c] = total;
    total += lists[c].length / 2;
  }
  cellStart[lists.length] = total;
  cellTris = new Int32Array(total);
  for (let c = 0; c < lists.length; c++) {
    const l = lists[c];
    const order: number[] = [];
    for (let k = 0; k < l.length; k += 2) order.push(k);
    order.sort((a, b) => l[a + 1] - l[b + 1] || l[a] - l[b]);
    order.forEach((k, j) => (cellTris[cellStart[c] + j] = l[k]));
  }
}
build();

function cellOf(x: number, y: number, z: number): number {
  const ix = Math.floor((x - MIN_X) / CELL);
  const iy = Math.floor((y - MIN_Y) / CELL);
  const iz = Math.floor((z - MIN_Z) / CELL);
  if (ix < 0 || iy < 0 || iz < 0 || ix >= NX || iy >= NY || iz >= NZ) return -1;
  return (ix * NY + iy) * NZ + iz;
}

export interface ArenaQuery {
  /** signed distance to the arena surface (positive = inside the playable space), capped at PAD */
  dist: number;
  /** direction out of the surface towards the point (into the playable space) */
  normal: Vec3;
}

/** Signed distance and contact normal of the nearest arena triangle. */
export function arenaQuery(p: Vec3): ArenaQuery {
  const c = cellOf(p.x, p.y, p.z);
  if (c < 0) return { dist: PAD, normal: { x: 0, y: 0, z: 1 } };
  // nothing beyond PAD matters (the result is capped)
  let best = (PAD + 1) * (PAD + 1);
  let bestTri = -1;
  let bestAlign = 0;
  let bx = 0, by = 0, bz = 0;
  for (let k = cellStart[c], end = cellStart[c + 1]; k < end; k++) {
    const i = cellTris[k];
    const o = i * STRIDE;
    // the bounding sphere and the plane give lower bounds of the triangle distance
    const sx = p.x - T[o + 12], sy = p.y - T[o + 13], sz = p.z - T[o + 14];
    const sd = Math.sqrt(sx * sx + sy * sy + sz * sz) - T[o + 15];
    if (sd > 0 && sd * sd > best + 1e-6) continue;
    const pd = (p.x - T[o]) * T[o + 9] + (p.y - T[o + 1]) * T[o + 10] + (p.z - T[o + 2]) * T[o + 11];
    if (pd * pd > best + 1e-6) continue;
    closestOnTri(i, p.x, p.y, p.z);
    const dx = p.x - CP[0], dy = p.y - CP[1], dz = p.z - CP[2];
    const d2 = dx * dx + dy * dy + dz * dz;
    // On shared edges/vertices several triangles tie: keep the one whose plane best explains the
    // offset, which gives the right inside/outside sign.
    const align = d2 > 1e-12 ? Math.abs(pd) / Math.sqrt(d2) : 1;
    if (d2 < best - 1e-6 || (d2 <= best + 1e-6 && align > bestAlign)) {
      best = Math.min(best, d2);
      bestTri = i;
      bestAlign = align;
      bx = CP[0];
      by = CP[1];
      bz = CP[2];
    }
  }
  if (bestTri < 0) return { dist: PAD, normal: { x: 0, y: 0, z: 1 } };
  const o = bestTri * STRIDE;
  const nx = T[o + 9], ny = T[o + 10], nz = T[o + 11];
  const dx = p.x - bx, dy = p.y - by, dz = p.z - bz;
  const side = dx * nx + dy * ny + dz * nz >= 0 ? 1 : -1;
  const d = Math.sqrt(best);
  const dist = Math.min(PAD, side * d);
  if (d < 1e-3) return { dist, normal: { x: nx, y: ny, z: nz } };
  const s = side / d;
  return { dist, normal: { x: dx * s, y: dy * s, z: dz * s } };
}

export function arenaDistance(p: Vec3): number {
  return arenaQuery(p).dist;
}

export function arenaNormal(p: Vec3): Vec3 {
  return arenaQuery(p).normal;
}

const stamp = new Int32Array(1 << 16);
let stampId = 0;

/**
 * Ray against the arena triangles (front faces only, like a wheel ray from inside the field).
 * `d` must be normalized.
 */
export function raycastArena(o: Vec3, d: Vec3, maxT: number): { t: number; point: Vec3; normal: Vec3 } | null {
  stampId++;
  if (stampId >= 0x7fffffff) {
    stamp.fill(0);
    stampId = 1;
  }
  let bestT = maxT;
  let bestTri = -1;
  // every PAD along the ray, the cell lists cover everything within PAD
  const steps = Math.ceil(maxT / PAD);
  for (let s = 0; s <= steps; s++) {
    const t0 = Math.min(maxT, s * PAD);
    if (t0 > bestT) break;
    const c = cellOf(o.x + d.x * t0, o.y + d.y * t0, o.z + d.z * t0);
    if (c < 0) continue;
    for (let k = cellStart[c], end = cellStart[c + 1]; k < end; k++) {
      const i = cellTris[k];
      if (stamp[i] === stampId) continue;
      stamp[i] = stampId;
      const t = rayTri(i, o, d);
      if (t >= 0 && t < bestT) {
        bestT = t;
        bestTri = i;
      }
    }
  }
  if (bestTri < 0) return null;
  const n = bestTri * STRIDE + 9;
  return {
    t: bestT,
    point: { x: o.x + d.x * bestT, y: o.y + d.y * bestT, z: o.z + d.z * bestT },
    normal: { x: T[n], y: T[n + 1], z: T[n + 2] },
  };
}

/** Möller–Trumbore; front faces only. Returns -1 on a miss. */
function rayTri(i: number, o: Vec3, d: Vec3): number {
  const b = i * STRIDE;
  if (d.x * T[b + 9] + d.y * T[b + 10] + d.z * T[b + 11] >= 0) return -1;
  const ax = T[b], ay = T[b + 1], az = T[b + 2];
  const e1x = T[b + 3] - ax, e1y = T[b + 4] - ay, e1z = T[b + 5] - az;
  const e2x = T[b + 6] - ax, e2y = T[b + 7] - ay, e2z = T[b + 8] - az;
  const px = d.y * e2z - d.z * e2y;
  const py = d.z * e2x - d.x * e2z;
  const pz = d.x * e2y - d.y * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-12) return -1;
  const inv = 1 / det;
  const tx = o.x - ax, ty = o.y - ay, tz = o.z - az;
  const u = (tx * px + ty * py + tz * pz) * inv;
  // a little slack so rays along the seams between mirrored pieces (x = 0, y = 0) still hit
  if (u < -1e-6 || u > 1 + 1e-6) return -1;
  const qx = ty * e1z - tz * e1y;
  const qy = tz * e1x - tx * e1z;
  const qz = tx * e1y - ty * e1x;
  const v = (d.x * qx + d.y * qy + d.z * qz) * inv;
  if (v < -1e-6 || u + v > 1 + 1e-6) return -1;
  const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
  return t >= 0 ? t : -1;
}

/** Triangles of the collision mesh (for debug rendering): flat xyz triples. */
export function arenaTriangles(): Float64Array {
  const out = new Float64Array(triCount * 9);
  for (let i = 0; i < triCount; i++) out.set(T.subarray(i * STRIDE, i * STRIDE + 9), i * 9);
  return out;
}
