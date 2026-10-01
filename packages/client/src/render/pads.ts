import * as THREE from 'three';
import { BOOST_PADS } from '@rl/shared';
import { toThreeXYZ } from './coords';

// Boost pads: small = glowing disc on a metal base; big = floating glowing orb over a pedestal
// with a spinning ring. Inactive pads go dark until they respawn.

export class BoostPadsView {
  readonly group = new THREE.Group();
  private items: { glow: THREE.Mesh; mat: THREE.MeshStandardMaterial; orb?: THREE.Mesh; ring?: THREE.Mesh; halo?: THREE.Sprite; big: boolean }[] = [];

  constructor() {
    const baseMat = new THREE.MeshStandardMaterial({ color: '#3b4049', metalness: 0.85, roughness: 0.3 });
    const smallBase = new THREE.CylinderGeometry(62, 70, 6, 32);
    const smallGlow = new THREE.CylinderGeometry(44, 44, 7, 32);
    const bigBase = new THREE.CylinderGeometry(160, 178, 14, 40);
    const bigGlow = new THREE.CylinderGeometry(120, 120, 15, 40);
    const orbGeo = new THREE.SphereGeometry(58, 32, 20);
    const ringGeo = new THREE.TorusGeometry(92, 6, 10, 48);
    const haloTex = haloTexture();

    for (const p of BOOST_PADS) {
      const base = new THREE.Mesh(p.big ? bigBase : smallBase, baseMat);
      toThreeXYZ(p.x, p.y, p.big ? 7 : 3, base.position);
      base.receiveShadow = true;
      this.group.add(base);
      const mat = new THREE.MeshStandardMaterial({ color: '#ffb52e', emissive: '#ff9a10', emissiveIntensity: 2.4, roughness: 0.4 });
      const glow = new THREE.Mesh(p.big ? bigGlow : smallGlow, mat);
      toThreeXYZ(p.x, p.y, p.big ? 8 : 4, glow.position);
      this.group.add(glow);
      const item: (typeof this.items)[number] = { glow, mat, big: p.big };
      if (p.big) {
        const orbMat = new THREE.MeshStandardMaterial({ color: '#ffd27a', emissive: '#ff9000', emissiveIntensity: 3.2, roughness: 0.2 });
        item.orb = new THREE.Mesh(orbGeo, orbMat);
        toThreeXYZ(p.x, p.y, 130, item.orb.position);
        this.group.add(item.orb);
        item.ring = new THREE.Mesh(ringGeo, orbMat);
        toThreeXYZ(p.x, p.y, 130, item.ring.position);
        this.group.add(item.ring);
        item.halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: haloTex, color: '#ffa030', blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
        item.halo.scale.set(380, 380, 1);
        item.halo.position.copy(item.orb.position);
        this.group.add(item.halo);
      }
      this.items.push(item);
    }
  }

  update(pads: number[], time: number, dt: number) {
    pads.forEach((t, i) => {
      const it = this.items[i];
      if (!it) return;
      const active = t <= 0;
      it.mat.emissiveIntensity = active ? 2.2 + Math.sin(time * 4 + i) * 0.3 : 0.05;
      it.mat.color.set(active ? '#ffb52e' : '#3a3020');
      if (it.orb && it.ring && it.halo) {
        it.orb.visible = it.ring.visible = it.halo.visible = active;
        const y = 125 + Math.sin(time * 2 + i) * 10;
        it.orb.position.y = it.ring.position.y = it.halo.position.y = y;
        it.ring.rotation.x += dt * 1.6;
        it.ring.rotation.y += dt * 2.3;
      }
    });
  }
}

function haloTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,0.9)');
  grad.addColorStop(0.3, 'rgba(255,255,255,0.35)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}
