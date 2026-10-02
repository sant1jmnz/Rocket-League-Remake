import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';

/** Final grade on the linear HDR image: a bit more saturation and contrast, soft vignette. */
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uSaturation: { value: 1.12 },
    uContrast: { value: 1.06 },
    uVignette: { value: 0.3 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uSaturation;
    uniform float uContrast;
    uniform float uVignette;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      float lum = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
      vec3 col = max(mix(vec3(lum), c.rgb, uSaturation), 0.0);
      col = 0.18 * pow(col / 0.18, vec3(uContrast)); // contrast around linear mid-grey
      float r = length((vUv - 0.5) * vec2(1.25, 1.0));
      col *= 1.0 - uVignette * smoothstep(0.35, 0.85, r);
      gl_FragColor = vec4(col, c.a);
    }
  `,
};

/** HDR render → bloom (boost, goal frames, pads, explosions) → color grade → tone mapping. */
export class PostFx {
  readonly composer: EffectComposer;
  readonly bloom: UnrealBloomPass;

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera) {
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(renderer, target);
    this.composer.addPass(new RenderPass(scene, camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x / 2, size.y / 2), 0.35, 0.4, 1.1);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new ShaderPass(GradeShader));
    this.composer.addPass(new OutputPass());
  }

  setSize(w: number, h: number, pixelRatio: number) {
    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(w, h);
  }

  render() {
    this.composer.render();
  }
}
