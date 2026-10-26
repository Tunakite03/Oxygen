import * as THREE from 'three';
import { createExample, everyFrame } from '../shared/setup';

const { pipeline, camera, gui } = createExample('Post-processing');
camera.position.set(0, 0.6, 7);
camera.lookAt(0, 0, 0);

const scene = pipeline.scene;
scene.add(new THREE.HemisphereLight(0x8899ff, 0x111018, 0.6));
const key = new THREE.DirectionalLight(0xffffff, 2);
key.position.set(3, 4, 5);
scene.add(key);

// Emissive intensities above 1 only survive because the pipeline renders into a half-float buffer.
const glow = { intensity: 6 };
const emissive = [0xff5a36, 0x3d7bff, 0x37d6a0];
const group = new THREE.Group();
scene.add(group);
const knots = emissive.map((color, i) => {
  const material = new THREE.MeshStandardMaterial({ color: 0x15171c, roughness: 0.35, metalness: 0.6, emissive: color, emissiveIntensity: glow.intensity });
  const mesh = new THREE.Mesh(new THREE.TorusKnotGeometry(0.55, 0.12, 220, 24, 2 + i, 3), material);
  mesh.position.x = (i - 1) * 2.2;
  group.add(mesh);
  return mesh;
});

const floor = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.MeshStandardMaterial({ color: 0x0c0d10, roughness: 0.25, metalness: 0.8 }));
floor.rotation.x = -Math.PI / 2;
floor.position.y = -1.3;
scene.add(floor);

const sceneFolder = gui.addFolder('Scene');
sceneFolder.addNumber(glow, 'intensity', { label: 'emissive', min: 0, max: 20, step: 0.1 }).onChange((v) => {
  for (const k of knots) (k.material as THREE.MeshStandardMaterial).emissiveIntensity = v;
});
const motion = { speed: 1 };
sceneFolder.addNumber(motion, 'speed', { min: 0, max: 4, step: 0.01 });

everyFrame((delta, time) => {
  knots.forEach((k, i) => {
    k.rotation.x += delta * 0.0004 * motion.speed * (i + 1);
    k.rotation.y += delta * 0.0006 * motion.speed;
  });
  group.position.y = Math.sin(time * 0.0008) * 0.1;
});

void pipeline.warmUp(camera);
