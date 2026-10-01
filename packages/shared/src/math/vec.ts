// Minimal immutable-style vector / quaternion helpers for the simulation.
// Coordinates: right-handed, Z up. Units are Unreal units (1 uu = 1 cm), like Rocket League.

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

export const v3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });
export const vcopy = (a: Vec3): Vec3 => ({ x: a.x, y: a.y, z: a.z });
export const vadd = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const vsub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const vscale = (a: Vec3, s: number): Vec3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });
export const vaddScaled = (a: Vec3, b: Vec3, s: number): Vec3 => ({
  x: a.x + b.x * s,
  y: a.y + b.y * s,
  z: a.z + b.z * s,
});
export const vdot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
export const vcross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
export const vlen = (a: Vec3): number => Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
export const vlenSq = (a: Vec3): number => a.x * a.x + a.y * a.y + a.z * a.z;
export const vdist = (a: Vec3, b: Vec3): number => vlen(vsub(a, b));
export const vnorm = (a: Vec3): Vec3 => {
  const l = vlen(a);
  return l > 1e-9 ? vscale(a, 1 / l) : { x: 0, y: 0, z: 0 };
};
export const vclampLen = (a: Vec3, max: number): Vec3 => {
  const l = vlen(a);
  return l > max ? vscale(a, max / l) : a;
};
export const vlerp = (a: Vec3, b: Vec3, t: number): Vec3 => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
  z: a.z + (b.z - a.z) * t,
});
/** Removes the component of `a` along unit vector `n`. */
export const vreject = (a: Vec3, n: Vec3): Vec3 => vaddScaled(a, n, -vdot(a, n));

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const sign = (v: number): number => (v > 0 ? 1 : v < 0 ? -1 : 0);

/** Piecewise-linear interpolation over sorted [x, y] points (clamped at the ends). */
export function curve(points: readonly (readonly [number, number])[], x: number): number {
  if (x <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i];
    if (x <= x1) {
      const [x0, y0] = points[i - 1];
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return points[points.length - 1][1];
}

// ---------------------------------------------------------------------------
// Quaternions
// ---------------------------------------------------------------------------

export const qidentity = (): Quat => ({ x: 0, y: 0, z: 0, w: 1 });

export const qmul = (a: Quat, b: Quat): Quat => ({
  x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
  y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
  z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
});

export const qnorm = (q: Quat): Quat => {
  const l = Math.sqrt(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w) || 1;
  return { x: q.x / l, y: q.y / l, z: q.z / l, w: q.w / l };
};

export const qconj = (q: Quat): Quat => ({ x: -q.x, y: -q.y, z: -q.z, w: q.w });

export const qfromAxisAngle = (axis: Vec3, angle: number): Quat => {
  const h = angle / 2;
  const s = Math.sin(h);
  return { x: axis.x * s, y: axis.y * s, z: axis.z * s, w: Math.cos(h) };
};

/** Rotation about world Z (yaw), used for spawns. */
export const qfromYaw = (yaw: number): Quat => qfromAxisAngle({ x: 0, y: 0, z: 1 }, yaw);

export const qrotate = (q: Quat, v: Vec3): Vec3 => {
  // v' = q * v * q^-1 (optimized)
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  return {
    x: v.x + q.w * tx + (q.y * tz - q.z * ty),
    y: v.y + q.w * ty + (q.z * tx - q.x * tz),
    z: v.z + q.w * tz + (q.x * ty - q.y * tx),
  };
};

export const qinvRotate = (q: Quat, v: Vec3): Vec3 => qrotate(qconj(q), v);

/** Integrates angular velocity (world space, rad/s) over dt. */
export const qintegrate = (q: Quat, w: Vec3, dt: number): Quat => {
  const angle = vlen(w) * dt;
  if (angle < 1e-12) return q;
  const axis = vscale(w, 1 / vlen(w));
  return qnorm(qmul(qfromAxisAngle(axis, angle), q));
};

/** Shortest rotation that takes unit vector a onto unit vector b. */
export const qfromTo = (a: Vec3, b: Vec3): Quat => {
  const d = vdot(a, b);
  if (d > 0.999999) return qidentity();
  if (d < -0.999999) {
    let axis = vcross({ x: 1, y: 0, z: 0 }, a);
    if (vlenSq(axis) < 1e-6) axis = vcross({ x: 0, y: 1, z: 0 }, a);
    return qfromAxisAngle(vnorm(axis), Math.PI);
  }
  const c = vcross(a, b);
  return qnorm({ x: c.x, y: c.y, z: c.z, w: 1 + d });
};

export const qslerp = (a: Quat, b: Quat, t: number): Quat => {
  let cos = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
  let bx = b.x, by = b.y, bz = b.z, bw = b.w;
  if (cos < 0) {
    cos = -cos;
    bx = -bx; by = -by; bz = -bz; bw = -bw;
  }
  if (cos > 0.9995) {
    return qnorm({
      x: a.x + (bx - a.x) * t,
      y: a.y + (by - a.y) * t,
      z: a.z + (bz - a.z) * t,
      w: a.w + (bw - a.w) * t,
    });
  }
  const theta = Math.acos(cos);
  const s = Math.sin(theta);
  const wa = Math.sin((1 - t) * theta) / s;
  const wb = Math.sin(t * theta) / s;
  return { x: a.x * wa + bx * wb, y: a.y * wa + by * wb, z: a.z * wa + bz * wb, w: a.w * wa + bw * wb };
};

/** Local axes of an orientation: forward (+X), left (+Y), up (+Z). */
export const qforward = (q: Quat): Vec3 => qrotate(q, { x: 1, y: 0, z: 0 });
export const qleft = (q: Quat): Vec3 => qrotate(q, { x: 0, y: 1, z: 0 });
export const qup = (q: Quat): Vec3 => qrotate(q, { x: 0, y: 0, z: 1 });

/** Builds an orientation from a forward and an up vector (re-orthogonalized). */
export const qfromBasis = (forward: Vec3, up: Vec3): Quat => {
  const f = vnorm(forward);
  const l = vnorm(vcross(up, f));
  const u = vcross(f, l);
  // Rotation matrix columns: f, l, u
  const m00 = f.x, m01 = l.x, m02 = u.x;
  const m10 = f.y, m11 = l.y, m12 = u.y;
  const m20 = f.z, m21 = l.z, m22 = u.z;
  const tr = m00 + m11 + m22;
  let q: Quat;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    q = { w: 0.25 * s, x: (m21 - m12) / s, y: (m02 - m20) / s, z: (m10 - m01) / s };
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    q = { w: (m21 - m12) / s, x: 0.25 * s, y: (m01 + m10) / s, z: (m02 + m20) / s };
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    q = { w: (m02 - m20) / s, x: (m01 + m10) / s, y: 0.25 * s, z: (m12 + m21) / s };
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    q = { w: (m10 - m01) / s, x: (m02 + m20) / s, y: (m12 + m21) / s, z: 0.25 * s };
  }
  return qnorm(q);
};

// ---------------------------------------------------------------------------
// Deterministic RNG (mulberry32) so server and clients pick the same kickoffs.
// ---------------------------------------------------------------------------

export function rngNext(seed: number): { value: number; seed: number } {
  let t = (seed + 0x6d2b79f5) | 0;
  const next = t;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return { value: ((t ^ (t >>> 14)) >>> 0) / 4294967296, seed: next };
}
