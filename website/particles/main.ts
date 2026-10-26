import * as THREE from 'three';
import { GPUParticles, PointerTracker, pointerToPlane, prefersReducedMotion, setMotionPreference } from '@tunn/oxygen';
import type { MotionPreference } from '@tunn/oxygen';
import { createExample, everyFrame } from '../shared/setup';

const { pipeline, camera, gui, quality, bloom } = createExample('GPU particles', { clearColor: '#040406' });
camera.position.set(0, 0, 6);
bloom.threshold = 0.6;

const particles = new GPUParticles(pipeline.renderer, {
  count: quality.level.particles,
  emitter: { type: 'sphere', center: [0, 0, 0], radius: 1.6 },
  lifetime: [3, 7],
  speed: 0.1,
  drag: 0.9,
  curl: { strength: 1.4, scale: 0.55, speed: 0.12 },
  size: 0.018,
  colorStart: 0xffc27a,
  colorEnd: 0x3a5cff,
  opacity: 0.55,
});
pipeline.scene.add(particles.object);

const pointer = new PointerTracker(pipeline.renderer.domElement);
const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
const target = new THREE.Vector3();
particles.attractor.radius = 2.5;

const params = { attract: 6, repel: -14 };
const status = document.querySelector<HTMLElement>('[role="status"]');
if (!status) throw new Error('Particle example needs a motion status element');
let motionPreference: MotionPreference = 'system';
const motion = {
  get preference(): MotionPreference { return motionPreference; },
  set preference(value: MotionPreference) {
    setMotionPreference(value);
    motionPreference = value;
  },
};
const folder = gui.addFolder('Particles');
folder.addMonitor('count', () => particles.count.toLocaleString('en-US'));
folder.addSelect(motion, 'preference', ['system', 'reduce', 'full'], { label: 'motion' });
folder.addNumber(particles, 'timeScale', { label: 'time scale', min: 0, max: 3, step: 0.01 });
folder.addNumber(particles.attractor, 'radius', { label: 'pointer radius', min: 0.1, max: 6, step: 0.01 });
folder.addNumber(params, 'attract', { min: 0, max: 30, step: 0.1 });
folder.addNumber(params, 'repel', { min: -40, max: 0, step: 0.1 });
const curl = particles.simulation.uniforms('velocity').curl?.value as THREE.Vector3;
folder.addNumber(curl, 'x', { label: 'curl strength', min: 0, max: 5, step: 0.01 });
folder.addNumber(curl, 'y', { label: 'curl scale', min: 0.05, max: 3, step: 0.01 });
folder.addUniform(particles.material.uniforms, 'size', { min: 0.002, max: 0.08, step: 0.001 });
folder.addUniform(particles.material.uniforms, 'opacity', { min: 0, max: 1, step: 0.01 });
folder.addColor(particles.material.uniforms.colorStart?.value as THREE.Color, 'birth');
folder.addColor(particles.material.uniforms.colorEnd?.value as THREE.Color, 'death');

everyFrame((delta) => {
  const message = prefersReducedMotion()
    ? 'Paused: reduced motion is enabled. Choose motion → full to run the simulation.'
    : particles.timeScale === 0
      ? 'Paused: time scale is 0. Increase time scale to resume.'
      : 'Simulation running. Move the pointer over the scene to attract; hold to repel.';
  if (status.textContent !== message) status.textContent = message;
  pointer.update(delta);
  if (pointer.inside && pointerToPlane(pointer.ndc, camera, plane, target)) {
    particles.attractor.position.copy(target);
    particles.attractor.strength = pointer.down ? params.repel : params.attract;
  } else particles.attractor.strength = 0;
  particles.update(delta);
});

void pipeline.warmUp(camera);
