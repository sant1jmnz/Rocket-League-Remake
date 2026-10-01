import { ARENA, GOAL } from '../constants.js';
import type { Vec3 } from '../math/vec.js';

// The playable volume is described as a signed distance field: arenaDistance(p) is the distance
// from p to the nearest wall/floor/ceiling (positive = inside the playable space).
//
// Shape: an octagonal prism (rectangle with 45° cut corners) whose inner edges are all rounded with
// radius CURVE_RADIUS (floor→wall ramps, wall→ceiling, wall→corner), unioned with the two goal boxes.

const R = ARENA.CURVE_RADIUS;
const HW = ARENA.HALF_WIDTH - R;
const HL = ARENA.HALF_LENGTH - R;
const CP = ARENA.CORNER_PLANE - R * Math.SQRT2;
const ZC = ARENA.HEIGHT / 2;
const HZ = ARENA.HEIGHT / 2 - R;

/** Vertices of the shrunk octagon (counter-clockwise), shared with the renderer. */
export const SHRUNK_OCTAGON: readonly [number, number][] = (() => {
  // Corner cut intersects x = HW at y = CP - HW, and y = HL at x = CP - HL
  const a = CP - HL; // x where the cut meets the back wall
  const b = CP - HW; // y where the cut meets the side wall
  return [
    [HW, -b],
    [HW, b],
    [a, HL],
    [-a, HL],
    [-HW, b],
    [-HW, -b],
    [-a, -HL],
    [a, -HL],
  ];
})();

const EDGES = SHRUNK_OCTAGON.map((p, i) => {
  const q = SHRUNK_OCTAGON[(i + 1) % SHRUNK_OCTAGON.length];
  const dx = q[0] - p[0];
  const dy = q[1] - p[1];
  const len = Math.hypot(dx, dy);
  // outward normal for a CCW polygon is (dy, -dx)
  return { ax: p[0], ay: p[1], dx, dy, len, nx: dy / len, ny: -dx / len };
});

/** Signed distance to the shrunk octagon in the XY plane (negative inside). */
function octagonSd(x: number, y: number): number {
  let maxPlane = -Infinity;
  for (const e of EDGES) {
    const d = (x - e.ax) * e.nx + (y - e.ay) * e.ny;
    if (d > maxPlane) maxPlane = d;
  }
  if (maxPlane <= 0) return maxPlane;
  // Outside: exact distance to the polygon boundary
  let best = Infinity;
  for (const e of EDGES) {
    const t = Math.max(0, Math.min(1, ((x - e.ax) * e.dx + (y - e.ay) * e.dy) / (e.len * e.len)));
    const px = e.ax + e.dx * t - x;
    const py = e.ay + e.dy * t - y;
    const d = px * px + py * py;
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

function arenaShellDistance(x: number, y: number, z: number): number {
  const qx = octagonSd(x, y);
  const qz = Math.abs(z - ZC) - HZ;
  const ox = Math.max(qx, 0);
  const oz = Math.max(qz, 0);
  const sd = Math.sqrt(ox * ox + oz * oz) + Math.min(Math.max(qx, qz), 0);
  return R - sd;
}

/** Distance inside a goal box (positive inside). The box starts at the beginning of the floor ramp. */
const GOAL_Y0 = ARENA.HALF_LENGTH - R;
const GOAL_Y1 = ARENA.HALF_LENGTH + GOAL.DEPTH;
function goalDistance(x: number, y: number, z: number): number {
  const ay = Math.abs(y);
  const dx = GOAL.HALF_WIDTH - Math.abs(x);
  const dz0 = z;
  const dz1 = GOAL.HEIGHT - z;
  const dy1 = GOAL_Y1 - ay;
  const dy0 = ay - GOAL_Y0;
  const inside = Math.min(dx, dz0, dz1, dy1, dy0);
  if (inside >= 0) return inside;
  // outside: negative euclidean distance to the box
  const ex = Math.max(-dx, 0);
  const ez = Math.max(-dz0, -dz1, 0);
  const ey = Math.max(-dy1, -dy0, 0);
  return -Math.sqrt(ex * ex + ey * ey + ez * ez);
}

export function arenaDistance(p: Vec3): number {
  const a = arenaShellDistance(p.x, p.y, p.z);
  if (Math.abs(p.y) < GOAL_Y0 - 300) return a;
  return Math.max(a, goalDistance(p.x, p.y, p.z));
}

const EPS = 0.5;
/** Outward-from-wall normal (points into the playable space). */
export function arenaNormal(p: Vec3): Vec3 {
  const dx =
    arenaDistance({ x: p.x + EPS, y: p.y, z: p.z }) - arenaDistance({ x: p.x - EPS, y: p.y, z: p.z });
  const dy =
    arenaDistance({ x: p.x, y: p.y + EPS, z: p.z }) - arenaDistance({ x: p.x, y: p.y - EPS, z: p.z });
  const dz =
    arenaDistance({ x: p.x, y: p.y, z: p.z + EPS }) - arenaDistance({ x: p.x, y: p.y, z: p.z - EPS });
  const l = Math.hypot(dx, dy, dz) || 1;
  return { x: dx / l, y: dy / l, z: dz / l };
}

/** Distance + normal in one call. */
export function arenaQuery(p: Vec3): { dist: number; normal: Vec3 } {
  return { dist: arenaDistance(p), normal: arenaNormal(p) };
}

/** True when the whole ball is past the goal line of the given side (+1 = orange goal at +Y). */
export function isInGoal(p: Vec3, side: 1 | -1, radius: number): boolean {
  return side * p.y > ARENA.HALF_LENGTH + radius;
}
