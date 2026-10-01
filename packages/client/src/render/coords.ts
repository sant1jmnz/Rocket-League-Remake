import * as THREE from 'three';
import type { Quat, Vec3 } from '@rl/shared';

// Simulation space is right-handed Z-up (Rocket League style); Three.js is Y-up.
// Mapping: three = (sim.x, sim.z, -sim.y). It is a proper rotation, so quaternions map as
// (x, y, z, w) -> (x, z, -y, w).

export const toThree = (v: Vec3, out = new THREE.Vector3()): THREE.Vector3 => out.set(v.x, v.z, -v.y);

export const toThreeXYZ = (x: number, y: number, z: number, out = new THREE.Vector3()): THREE.Vector3 =>
  out.set(x, z, -y);

export const quatToThree = (q: Quat, out = new THREE.Quaternion()): THREE.Quaternion =>
  out.set(q.x, q.z, -q.y, q.w);

export const fromThree = (v: THREE.Vector3): Vec3 => ({ x: v.x, y: -v.z, z: v.y });
