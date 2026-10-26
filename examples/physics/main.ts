import * as THREE from 'three';
import { ClothGeometry, PointerTracker, VectorSpring, VerletWorld, createCloth, pointerToPlane } from '@tunn/oxygen';
import { PhysicsWorld } from '@tunn/oxygen/physics';
import { createExample, everyFrame } from '../shared/setup';

const { pipeline, camera, gui, bloom } = createExample('Physics', { clearColor: '#0a0b0e' });
camera.position.set(0, 3.2, 9);
camera.lookAt(0, 1, 0);
bloom.intensity = 0.5;

const scene = pipeline.scene;
scene.add(new THREE.HemisphereLight(0xdde6ff, 0x1a1712, 1.1));
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.position.set(4, 8, 6);
scene.add(sun);

// Rigid bodies -------------------------------------------------------------------------------------------------
const physics = await PhysicsWorld.create({ gravity: [0, -9.81, 0] });
const floor = new THREE.Mesh(new THREE.BoxGeometry(14, 0.4, 8), new THREE.MeshStandardMaterial({ color: 0x1b1d22, roughness: 0.9 }));
floor.position.y = -0.2;
scene.add(floor);
physics.add(floor, { type: 'fixed', friction: 0.8 });

const palette = [0xe9e4da, 0xff6b3d, 0x4f7cff];
const dynamic: THREE.Mesh[] = [];
const maxBodies = 140;

function spawn(mesh: THREE.Mesh, options: Parameters<PhysicsWorld['add']>[1]): void {
  scene.add(mesh);
  physics.add(mesh, options);
  dynamic.push(mesh);
  if (dynamic.length > maxBodies) {
    const old = dynamic.shift() as THREE.Mesh;
    physics.remove(old);
    old.removeFromParent();
  }
}

const boxGeometry = new THREE.BoxGeometry(0.5, 0.5, 0.5);
for (let i = 0; i < 40; i++) {
  const box = new THREE.Mesh(boxGeometry, new THREE.MeshStandardMaterial({ color: palette[i % palette.length], roughness: 0.5 }));
  box.position.set(-5 + (i % 5) * 0.55, 0.3 + Math.floor(i / 5) * 0.55, -1.5 + (i % 2) * 0.1);
  spawn(box, { restitution: 0.1, friction: 0.7 });
}

const ballGeometry = new THREE.SphereGeometry(0.22, 24, 16);
const ballMaterial = new THREE.MeshStandardMaterial({ color: 0xffd27a, emissive: 0xff9a3d, emissiveIntensity: 2.5 });
const throwParams = { speed: 16 };
const pointer = new PointerTracker(window);
const raycaster = new THREE.Raycaster();
pointer.on('tap', () => {
  raycaster.setFromCamera(pointer.ndc, camera);
  const ball = new THREE.Mesh(ballGeometry, ballMaterial);
  ball.position.copy(camera.position).addScaledVector(raycaster.ray.direction, 1);
  const v = raycaster.ray.direction.clone().multiplyScalar(throwParams.speed);
  spawn(ball, { shape: { type: 'sphere', radius: 0.22 }, density: 4, restitution: 0.4, linearVelocity: [v.x, v.y, v.z], ccd: true });
});

// Cloth --------------------------------------------------------------------------------------------------------
const verlet = new VerletWorld({ gravity: [0, -9.81, 0], iterations: 12, drag: 0.6, particleRadius: 0.03 });
const cloth = createCloth(verlet, { origin: [0.9, 3.1, 0], width: 2.6, height: 2.4, segmentsX: 30, segmentsY: 26, pin: 'top' });
const clothMesh = new THREE.Mesh(new ClothGeometry(verlet, cloth), new THREE.MeshStandardMaterial({ color: 0x4f7cff, roughness: 0.6, side: THREE.DoubleSide }));
scene.add(clothMesh);
const brush = { type: 'sphere' as const, center: new THREE.Vector3(0, -10, 0), radius: 0.45 };
verlet.colliders.push(brush, { type: 'plane', normal: new THREE.Vector3(0, 1, 0), constant: 0 });
const brushPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -0.2);
const wind = { strength: 1.2 };

// Springs ------------------------------------------------------------------------------------------------------
const springCubes = [-1.2, 0, 1.2].map((x) => {
  const cube = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.6, 0.6), new THREE.MeshStandardMaterial({ color: 0xe9e4da, roughness: 0.3, metalness: 0.2 }));
  cube.position.set(x - 1.4, 3.3, 1.2);
  scene.add(cube);
  const spring = new VectorSpring(cube.scale, new THREE.Vector3(1, 1, 1), { frequency: 3.5, damping: 0.35 });
  return { cube, spring };
});

const folder = gui.addFolder('Physics');
folder.addMonitor('bodies', () => String(physics.bodies.length));
folder.addNumber(throwParams, 'speed', { label: 'throw speed', min: 2, max: 40, step: 0.5 });
folder.addNumber(physics.world.gravity, 'y', { label: 'gravity', min: -30, max: 0, step: 0.1 });
folder.addNumber(wind, 'strength', { label: 'wind', min: 0, max: 6, step: 0.01 });
folder.addNumber(brush, 'radius', { label: 'brush radius', min: 0.1, max: 1.5, step: 0.01 });
folder.addNumber(verlet, 'iterations', { label: 'cloth iterations', min: 1, max: 40, step: 1 });
folder.addButton('Reset boxes', () => {
  dynamic.forEach((mesh, i) => physics.setTransform(mesh, new THREE.Vector3(-5 + (i % 5) * 0.55, 0.3 + Math.floor(i / 5) * 0.55, -1.5), new THREE.Quaternion()));
});

const windForce = new THREE.Vector3();
everyFrame((delta, time) => {
  pointer.update(delta);
  physics.update(delta);

  if (pointer.inside && pointerToPlane(pointer.ndc, camera, brushPlane, brush.center)) brush.center.z = 0.2;
  else brush.center.set(0, -10, 0);
  windForce.set(Math.sin(time * 0.0013) * 0.4, 0, Math.sin(time * 0.0007) + 0.5).multiplyScalar(wind.strength * delta * 0.001);
  for (const i of cloth.indices) if (!verlet.isPinned(i)) verlet.addVelocity(i, windForce);
  verlet.update(delta);
  (clothMesh.geometry as ClothGeometry).update();

  raycaster.setFromCamera(pointer.ndc, camera);
  const hovered = pointer.inside ? raycaster.intersectObjects(springCubes.map((s) => s.cube))[0]?.object : undefined;
  for (const { cube, spring } of springCubes) {
    spring.target.setScalar(cube === hovered ? 1.45 : 1);
    spring.update(delta);
    cube.rotation.y += delta * 0.0005;
  }
});

void pipeline.warmUp(camera);
