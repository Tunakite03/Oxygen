import * as THREE from 'three';
import { lerp, lerpVec, range } from '../core/math';
import { pointer, stage } from '../core/stage';

/**
 * Gaze camera: a perspective camera that drifts toward the pointer (moveXY), eases with
 * lerpSpeed, looks at a local target and can wobble. `group` is moved by the Story scroll.
 */
export class GazeCamera {
  readonly camera: THREE.PerspectiveCamera;
  readonly group = new THREE.Group();
  readonly inner = new THREE.Group();
  readonly position = new THREE.Vector3();
  readonly moveXY = new THREE.Vector2(4, 4);
  readonly lookAt = new THREE.Vector3();
  readonly cameraRotation = new THREE.Euler();
  strength = 1;
  lerpSpeed = 0.05;
  lerpSpeed2 = 1;
  deltaRotate = 0;
  deltaLerp = 1;
  zoomOffset = 0;
  wobbleStrength = 0;
  wobbleSpeed = 1;
  wobbleZ = 1;

  private readonly move = new THREE.Vector3();
  private readonly smoothed = new THREE.Vector3();
  private readonly wobble = new THREE.Vector3();
  private readonly wobbleAngle = THREE.MathUtils.degToRad(Math.random() * 360);
  private readonly quat = new THREE.Quaternion();
  private rotation = 0;
  private prevMoveX = 0;
  private strengthTween = 1;
  private readonly _target = new THREE.Vector3();
  private readonly _zero = new THREE.Vector3();

  constructor(fov = 35, near = 0.1, far = 1000) {
    this.camera = new THREE.PerspectiveCamera(fov, 1, near, far);
    this.inner.add(this.camera);
    this.group.add(this.inner);
  }

  setPosition(x: number, y: number, z: number): void {
    this.position.set(x, y, z);
    this.move.set(x, y, z);
    this.smoothed.copy(this.move);
    this.camera.position.copy(this.move);
  }

  resize(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  update(timeMs: number): void {
    const moveX = stage.width ? range(pointer.x, 0, stage.width, -1, 1, true) : 0;
    const moveY = stage.height ? range(pointer.y, 0, stage.height, -1, 1, true) : 0;
    const s = this.strengthTween * this.strength;
    this.move.x = this.position.x + moveX * s * this.moveXY.x;
    this.move.y = this.position.y + moveY * s * this.moveXY.y;
    const deltaX = moveX - this.prevMoveX;
    this.prevMoveX = moveX;
    const rotateStrength = stage.width ? range(Math.abs(deltaX) / stage.width, 0, 0.02, 0, 1, true) : 0;
    this.rotation = lerp(THREE.MathUtils.degToRad(this.deltaRotate) * rotateStrength * Math.sign(deltaX), this.rotation, 0.02 * this.deltaLerp * this.strengthTween);
    this.inner.rotation.z = lerp(this.rotation, this.inner.rotation.z, 0.07 * this.deltaLerp);
    this.move.z = this.position.z;
    lerpVec(this.smoothed, this.move, this.lerpSpeed2);
    this.smoothed.z += this.zoomOffset;
    lerpVec(this.camera.position, this.smoothed, this.lerpSpeed);
    this.group.updateMatrixWorld(true);
    this.camera.lookAt(this.inner.localToWorld(this._target.copy(this.lookAt)));
    if (Math.abs(this.cameraRotation.x) > 1e-6 || Math.abs(this.cameraRotation.y) > 1e-6 || Math.abs(this.cameraRotation.z) > 1e-6) {
      this.quat.setFromEuler(this.cameraRotation);
      this.camera.quaternion.multiply(this.quat);
    }
    this.camera.updateMatrixWorld();
    if (this.wobbleStrength > 0) {
      const t = timeMs;
      const a = this.wobbleAngle;
      const sp = this.wobbleSpeed;
      this.wobble.x = Math.cos(a + t * (75e-5 * sp)) * (a + 200 * Math.sin(t * (95e-5 * sp)));
      this.wobble.y = Math.sin(Math.asin(Math.cos(a + t * (85e-5 * sp)))) * (150 * Math.sin(a + t * (75e-5 * sp)));
      this.wobble.x *= 2 * Math.sin(a + t * (75e-5 * sp));
      this.wobble.y *= 1.75 * Math.cos(a + t * (65e-5 * sp));
      this.wobble.x *= 1.1 * Math.cos(a + t * (75e-5 * sp));
      this.wobble.y *= 1.15 * Math.sin(a + t * (25e-5 * sp));
      this.wobble.z = Math.sin(a + 0.0025 * this.wobble.x) * (100 * this.wobbleZ);
      this.wobble.multiplyScalar(0.001 * this.wobbleStrength * this.strengthTween);
      lerpVec(this.inner.position, this.wobble, 0.07);
    } else if (this.inner.position.lengthSq() > 0) {
      lerpVec(this.inner.position, this._zero, 0.07);
      if (this.inner.position.length() < 0.001) this.inner.position.set(0, 0, 0);
    }
  }
}
