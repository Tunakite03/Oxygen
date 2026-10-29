import * as THREE from 'three';

export interface IridescentMaterialOptions {
  baseColor?: THREE.ColorRepresentation;
  iridescence?: number;
  iridescenceFrequency?: number;
  roughness?: number;
  metalness?: number;
  fresnelPower?: number;
  glitchStrength?: number;
  audioReactivity?: number;
  map?: THREE.Texture | null;
  wireframe?: boolean;
}

const IRIDESCENT_VS = `precision highp float;

uniform float time;
uniform float uGlitch;
uniform float uAudioBass;

out vec3 vWorldPosition;
out vec3 vNormal;
out vec2 vUv;
out vec3 vViewPosition;

void main() {
  vUv = uv;
  
  vec3 pos = position;
  
  // Subtle audio-reactive / glitch vertex ripple
  if (uGlitch > 0.001 || uAudioBass > 0.1) {
    float displacement = sin(pos.y * 8.0 + time * 5.0) * cos(pos.x * 8.0 + time * 4.0);
    pos += normal * displacement * (uGlitch * 0.1 + uAudioBass * 0.04);
  }
  
  vec4 worldPos = modelMatrix * vec4(pos, 1.0);
  vWorldPosition = worldPos.xyz;
  
  vNormal = normalize(mat3(modelMatrix) * normal);
  
  vec4 mvPosition = viewMatrix * worldPos;
  vViewPosition = -mvPosition.xyz;
  
  gl_Position = projectionMatrix * mvPosition;
}
`;

const IRIDESCENT_FS = `precision highp float;

uniform vec3 uBaseColor;
uniform float uIridescence;
uniform float uIridescenceFrequency;
uniform float uRoughness;
uniform float uMetalness;
uniform float uFresnelPower;
uniform float uGlitch;
uniform float uAudioBass;
uniform float uAudioEnergy;
uniform float time;
uniform sampler2D tMap;
uniform bool uHasMap;

in vec3 vWorldPosition;
in vec3 vNormal;
in vec2 vUv;
in vec3 vViewPosition;

out vec4 FragColor;

// Spectral cosine palette (cyan, magenta, gold, electric blue)
vec3 spectralPalette(float t) {
  vec3 a = vec3(0.5, 0.5, 0.5);
  vec3 b = vec3(0.5, 0.5, 0.5);
  vec3 c = vec3(1.0, 1.0, 1.0);
  vec3 d = vec3(0.00, 0.33, 0.67);
  return a + b * cos(6.28318 * (c * t + d));
}

void main() {
  vec3 N = normalize(vNormal);
  vec3 V = normalize(cameraPosition - vWorldPosition);
  
  // Fresnel reflection factor
  float NdotV = max(dot(N, V), 0.0);
  float fresnel = pow(1.0 - NdotV, uFresnelPower);
  
  // Thin-film interference phase calculation
  float phase = fresnel * uIridescenceFrequency + time * 0.15 + (uAudioBass * 0.2);
  vec3 iridColor = spectralPalette(phase);
  
  // Base albedo
  vec3 albedo = uBaseColor;
  if (uHasMap) {
    vec2 uv = vUv;
    if (uGlitch > 0.01) {
      // Chromatic separation on glitch
      float r = texture(tMap, uv + vec2(uGlitch * 0.02, 0.0)).r;
      float g = texture(tMap, uv).g;
      float b = texture(tMap, uv - vec2(uGlitch * 0.02, 0.0)).b;
      albedo *= vec3(r, g, b);
    } else {
      albedo *= texture(tMap, uv).rgb;
    }
  }
  
  // Directional key light & ambient
  vec3 lightDir = normalize(vec3(0.6, 1.0, 0.8));
  float NdotL = max(dot(N, lightDir), 0.0);
  vec3 H = normalize(lightDir + V);
  float NdotH = max(dot(N, H), 0.0);
  float spec = pow(NdotH, (1.0 - uRoughness) * 64.0 + 4.0);
  
  // Rim lighting with iridescent tint
  vec3 rim = iridColor * fresnel * uIridescence * (1.0 + uAudioEnergy * 0.8);
  
  // Specular reflection with thin-film dispersion
  vec3 specular = mix(vec3(spec), iridColor * spec, uMetalness);
  
  vec3 diffuse = albedo * (NdotL * 0.8 + 0.2);
  vec3 finalColor = diffuse + specular + rim;
  
  FragColor = vec4(finalColor, 1.0);
}
`;

/**
 * Creates a thin-film interference material for Three.js: metal or glass surfaces whose colour shifts with
 * the view angle, optionally pulsed by audio bands (`uAudioBass`, `uAudioEnergy`) and glitched (`uGlitch`).
 */
export function createIridescentMaterial(options: IridescentMaterialOptions = {}): THREE.ShaderMaterial {
  const baseColor = new THREE.Color(options.baseColor ?? 0x111625);
  const map = options.map ?? null;

  return new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: {
      uBaseColor: { value: baseColor },
      uIridescence: { value: options.iridescence ?? 1.2 },
      uIridescenceFrequency: { value: options.iridescenceFrequency ?? 2.5 },
      uRoughness: { value: options.roughness ?? 0.2 },
      uMetalness: { value: options.metalness ?? 0.85 },
      uFresnelPower: { value: options.fresnelPower ?? 3.0 },
      uGlitch: { value: options.glitchStrength ?? 0.0 },
      uAudioBass: { value: 0.0 },
      uAudioEnergy: { value: 0.0 },
      time: { value: 0.0 },
      tMap: { value: map },
      uHasMap: { value: map !== null },
    },
    vertexShader: IRIDESCENT_VS,
    fragmentShader: IRIDESCENT_FS,
    wireframe: options.wireframe ?? false,
    transparent: false,
    side: THREE.DoubleSide,
  });
}
