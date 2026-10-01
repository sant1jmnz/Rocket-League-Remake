import { CAR, type Team } from '../constants.js';
import { qfromYaw, rngNext, v3, type Vec3 } from '../math/vec.js';

export interface Spawn {
  pos: Vec3;
  yaw: number;
}

// Blue-side kickoff spots (blue defends -Y). Orange uses the point-mirrored spot.
const Q = Math.PI / 4;
export const KICKOFF_SPOTS_BLUE: readonly Spawn[] = [
  { pos: v3(-2048, -2560, CAR.REST_HEIGHT), yaw: Q }, // right diagonal
  { pos: v3(2048, -2560, CAR.REST_HEIGHT), yaw: 3 * Q }, // left diagonal
  { pos: v3(-256, -3840, CAR.REST_HEIGHT), yaw: 2 * Q }, // right off-center
  { pos: v3(256, -3840, CAR.REST_HEIGHT), yaw: 2 * Q }, // left off-center
  { pos: v3(0, -4608, CAR.REST_HEIGHT), yaw: 2 * Q }, // goalie / back center
];

// Spots used when respawning after a demolition.
export const RESPAWN_SPOTS_BLUE: readonly Spawn[] = [
  { pos: v3(-2304, -4608, CAR.REST_HEIGHT), yaw: 2 * Q },
  { pos: v3(-2688, -4608, CAR.REST_HEIGHT), yaw: 2 * Q },
  { pos: v3(2304, -4608, CAR.REST_HEIGHT), yaw: 2 * Q },
  { pos: v3(2688, -4608, CAR.REST_HEIGHT), yaw: 2 * Q },
];

export function mirrorSpawn(s: Spawn, team: Team): Spawn {
  if (team === 0) return s;
  return { pos: v3(-s.pos.x, -s.pos.y, s.pos.z), yaw: s.yaw + Math.PI };
}

export const spawnQuat = (s: Spawn) => qfromYaw(s.yaw);

/**
 * Picks `count` kickoff spots, in the same way the real game does: diagonals are filled first in
 * 3v3, and the selection is random but identical (mirrored) for both teams.
 * Returns indices into KICKOFF_SPOTS_BLUE in assignment order.
 */
export function pickKickoffSpots(count: number, seed: number): { spots: number[]; seed: number } {
  // Real game layouts: 1v1 any single spot; 2v2 uses pairs (diagonals / off-centers / one+goalie);
  // 3v3 uses diagonals + one of the remaining.
  const layouts: number[][] =
    count <= 1
      ? [[0], [1], [2], [3], [4]]
      : count === 2
        ? [
            [0, 1],
            [2, 3],
            [0, 4],
            [1, 4],
          ]
        : [
            [0, 1, 4],
            [0, 1, 2],
            [0, 1, 3],
          ];
  const r = rngNext(seed);
  const layout = layouts[Math.floor(r.value * layouts.length) % layouts.length];
  const spots = layout.slice(0, count);
  // Shuffle who gets which spot
  let s = r.seed;
  for (let i = spots.length - 1; i > 0; i--) {
    const n = rngNext(s);
    s = n.seed;
    const j = Math.floor(n.value * (i + 1));
    [spots[i], spots[j]] = [spots[j], spots[i]];
  }
  return { spots, seed: s };
}
