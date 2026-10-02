import * as THREE from 'three';

// Ribbon trails (supersonic wind lines): a strip that follows a moving point and fades with age.

const vertex = /* glsl */ `
  attribute float aAlpha;
  varying float vAlpha;
  void main() {
    vAlpha = aAlpha;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const fragment = /* glsl */ `
  uniform vec3 uColor;
  varying float vAlpha;
  void main() { gl_FragColor = vec4(uColor, vAlpha); }
`;

export class TrailRibbon {
  readonly mesh: THREE.Mesh;
  private pts: { p: THREE.Vector3; up: THREE.Vector3; t: number }[] = [];
  private pos: Float32Array;
  private alpha: Float32Array;
  private geo = new THREE.BufferGeometry();

  constructor(
    color: THREE.Color,
    private width = 6,
    private maxAge = 0.32,
    private maxPoints = 48,
  ) {
    this.pos = new Float32Array(maxPoints * 2 * 3);
    this.alpha = new Float32Array(maxPoints * 2);
    const idx: number[] = [];
    for (let i = 0; i < maxPoints - 1; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    this.geo.setIndex(idx);
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1));
    this.mesh = new THREE.Mesh(
      this.geo,
      new THREE.ShaderMaterial({
        vertexShader: vertex,
        fragmentShader: fragment,
        uniforms: { uColor: { value: color } },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      }),
    );
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;
  }

  clear() {
    this.pts = [];
  }

  /** Adds the current point when `active`, drops old points and rebuilds the strip. */
  update(time: number, active: boolean, point: THREE.Vector3, up: THREE.Vector3) {
    if (active) {
      this.pts.push({ p: point.clone(), up: up.clone(), t: time });
      if (this.pts.length > this.maxPoints) this.pts.shift();
    }
    while (this.pts.length && time - this.pts[0].t > this.maxAge) this.pts.shift();
    const n = this.pts.length;
    for (let i = 0; i < n; i++) {
      const { p, up: u, t } = this.pts[i];
      const k = 1 - (time - t) / this.maxAge;
      const w = this.width * (0.35 + 0.65 * k);
      this.pos.set([p.x + u.x * w, p.y + u.y * w, p.z + u.z * w, p.x - u.x * w, p.y - u.y * w, p.z - u.z * w], i * 6);
      this.alpha[i * 2] = this.alpha[i * 2 + 1] = 0.55 * k * k;
    }
    this.geo.setDrawRange(0, Math.max(0, n - 1) * 6);
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.aAlpha.needsUpdate = true;
    this.mesh.visible = n > 1;
  }
}
