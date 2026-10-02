import * as THREE from 'three';

// Simple CPU particle system rendered as soft points (one draw call per system).

const vertex = /* glsl */ `
  attribute float aSize;
  attribute float aAlpha;
  attribute vec3 aColor;
  varying float vAlpha;
  varying vec3 vColor;
  uniform float uScale;
  void main() {
    vAlpha = aAlpha;
    vColor = aColor;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * uScale / max(-mv.z, 1.0);
    gl_Position = projectionMatrix * mv;
  }
`;

const fragment = /* glsl */ `
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    vec2 d = gl_PointCoord - 0.5;
    float r = length(d);
    if (r > 0.5) discard;
    float a = smoothstep(0.5, 0.0, r) * vAlpha;
    gl_FragColor = vec4(vColor, a);
  }
`;

interface Particle {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  life: number; maxLife: number;
  size0: number; size1: number;
  r: number; g: number; b: number;
  drag: number;
  gravity: number;
  /** peak opacity (1 = opaque at birth) */
  alpha: number;
}

export class ParticleSystem {
  readonly points: THREE.Points;
  private particles: Particle[] = [];
  private geo: THREE.BufferGeometry;
  private pos: Float32Array;
  private size: Float32Array;
  private alpha: Float32Array;
  private color: Float32Array;
  private material: THREE.ShaderMaterial;

  constructor(private max: number, additive: boolean) {
    this.geo = new THREE.BufferGeometry();
    this.pos = new Float32Array(max * 3);
    this.size = new Float32Array(max);
    this.alpha = new Float32Array(max);
    this.color = new Float32Array(max * 3);
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1));
    this.geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1));
    this.geo.setAttribute('aColor', new THREE.BufferAttribute(this.color, 3));
    this.material = new THREE.ShaderMaterial({
      vertexShader: vertex,
      fragmentShader: fragment,
      uniforms: { uScale: { value: 600 } },
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(this.geo, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
  }

  setViewportHeight(h: number, fovY: number) {
    this.material.uniforms.uScale.value = h / (2 * Math.tan((fovY * Math.PI) / 360));
  }

  emit(p: {
    pos: THREE.Vector3;
    vel: THREE.Vector3;
    life: number;
    size0: number;
    size1: number;
    color: THREE.Color;
    drag?: number;
    gravity?: number;
    alpha?: number;
  }) {
    if (this.particles.length >= this.max) this.particles.shift();
    this.particles.push({
      x: p.pos.x, y: p.pos.y, z: p.pos.z,
      vx: p.vel.x, vy: p.vel.y, vz: p.vel.z,
      life: p.life, maxLife: p.life,
      size0: p.size0, size1: p.size1,
      r: p.color.r, g: p.color.g, b: p.color.b,
      drag: p.drag ?? 0,
      gravity: p.gravity ?? 0,
      alpha: p.alpha ?? 1,
    });
  }

  burst(center: THREE.Vector3, count: number, speed: number, color: THREE.Color, life: number, size: number, gravity = 0, grow = 0.2, alpha = 1) {
    const v = new THREE.Vector3();
    for (let i = 0; i < count; i++) {
      v.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1).normalize().multiplyScalar(speed * (0.3 + Math.random() * 0.7));
      const c = color.clone().offsetHSL(0, 0, (Math.random() - 0.5) * 0.2);
      this.emit({ pos: center, vel: v.clone(), life: life * (0.5 + Math.random() * 0.5), size0: size, size1: size * grow, color: c, drag: 1.5, gravity, alpha });
    }
  }

  update(dt: number) {
    let n = 0;
    const alive: Particle[] = [];
    for (const p of this.particles) {
      p.life -= dt;
      if (p.life <= 0) continue;
      const d = Math.exp(-p.drag * dt);
      p.vx *= d; p.vy *= d; p.vz *= d;
      p.vy += p.gravity * dt;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      alive.push(p);
      const t = 1 - p.life / p.maxLife;
      this.pos[n * 3] = p.x;
      this.pos[n * 3 + 1] = p.y;
      this.pos[n * 3 + 2] = p.z;
      this.size[n] = p.size0 + (p.size1 - p.size0) * t;
      this.alpha[n] = Math.min(1, (1 - t) * 1.5, t * 12) * p.alpha;
      this.color[n * 3] = p.r;
      this.color[n * 3 + 1] = p.g;
      this.color[n * 3 + 2] = p.b;
      n++;
    }
    this.particles = alive;
    this.geo.setDrawRange(0, n);
    for (const k of ['position', 'aSize', 'aAlpha', 'aColor']) {
      (this.geo.getAttribute(k) as THREE.BufferAttribute).needsUpdate = true;
    }
  }

  clear() {
    this.particles = [];
  }
}
