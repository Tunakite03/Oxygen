import * as THREE from 'three';
import type { BoneDef, SkinAnimationData } from '../assets/geometry';
import { loadSkinAnimation } from '../assets/geometry';
import { attachWorldNormalMatrix } from './shaderLibrary';

/**
 * Texture-skinned mesh: bones live in a detached hierarchy; their (matrixWorld * bindInverse) matrices are packed into
 * a float RGBA texture that the vertex shader reads through `boneTexture` / `boneTextureSize`. Several weighted
 * animations blend per bone; bones for which `isBoneAnimated` returns false keep their procedural transform.
 */
export class SkinAnimation {
  elapsed = 0;
  weight = 1;
  readonly duration: number;
  private readonly extraSkins: Skin[] = [];
  private static readonly tPos = new THREE.Vector3();
  private static readonly tPos2 = new THREE.Vector3();
  private static readonly tRot = new THREE.Quaternion();
  private static readonly tRot2 = new THREE.Quaternion();
  private static readonly tScl = new THREE.Vector3();
  private static readonly tScl2 = new THREE.Vector3();

  constructor(
    private readonly skin: Skin,
    private readonly data: SkinAnimationData,
  ) {
    this.duration = data.duration;
  }

  addSkin(skin: Skin): void {
    this.extraSkins.push(skin);
  }

  update(totalWeight: number, isSet: boolean): void {
    const w = isSet ? 1 : this.weight / totalWeight;
    const numberKeys = this.duration + 1;
    const elapsed = this.elapsed % numberKeys;
    const prev = Math.floor(elapsed);
    const next = Math.floor(elapsed + 1) % numberKeys;
    const t = elapsed - prev;
    const { tPos, tPos2, tRot, tRot2, tScl, tScl2 } = SkinAnimation;
    this.data.skeleton.forEach((d, i) => {
      const bone = this.skin.bones[i];
      if (!bone) return;
      if (!this.skin.isBoneAnimated(bone.name)) return;
      const a = d.keys[prev];
      const b = d.keys[next] ?? a;
      if (!a || !b) return;
      tPos.fromArray(a.pos).lerp(tPos2.fromArray(b.pos), t);
      tRot.fromArray(a.rot).slerp(tRot2.fromArray(b.rot), t);
      tScl.fromArray(a.scl).lerp(tScl2.fromArray(b.scl), t);
      for (const s of [this.skin, ...this.extraSkins]) {
        const target = s.bones[i];
        if (!target) continue;
        target.position.lerp(tPos, w);
        target.quaternion.slerp(tRot, w);
        target.scale.lerp(tScl, w);
      }
    });
  }
}

export interface BoneObject extends THREE.Object3D {
  bindInverse: THREE.Matrix4;
}

export class Skin extends THREE.Mesh<THREE.BufferGeometry, THREE.RawShaderMaterial> {
  readonly isSkin = true;
  autoUpdateBoneTexture = true;
  readonly root = new THREE.Object3D();
  readonly bones: BoneObject[] = [];
  readonly boneMatrices: Float32Array;
  readonly boneTexture: THREE.DataTexture;
  readonly boneTextureSize: number;
  readonly skinAnimations: SkinAnimation[] = [];
  private static readonly tmp = new THREE.Matrix4();

  constructor(geometry: THREE.BufferGeometry, material: THREE.RawShaderMaterial, bones: BoneDef[] = geometry.userData.bones as BoneDef[]) {
    super(geometry, material);
    if (!bones) throw new Error(`Skin created for geometry "${geometry.name}" without bone data`);
    for (const data of bones) {
      const bone = new THREE.Object3D() as BoneObject;
      bone.name = data.name;
      bone.position.fromArray(data.pos);
      bone.quaternion.fromArray(data.rot).normalize();
      bone.scale.fromArray(data.scl);
      this.bones.push(bone);
    }
    bones.forEach((data, i) => {
      const bone = this.bones[i] as BoneObject;
      if (data.parent === -1) this.root.add(bone);
      else (this.bones[data.parent] as BoneObject).add(bone);
    });
    this.root.updateMatrixWorld(true);
    for (const bone of this.bones) bone.bindInverse = bone.matrixWorld.clone().invert();

    const size = Math.max(4, Math.pow(2, Math.ceil(Math.log(Math.sqrt(4 * this.bones.length)) / Math.LN2)));
    this.boneTextureSize = size;
    this.boneMatrices = new Float32Array(size * size * 4);
    this.boneTexture = new THREE.DataTexture(this.boneMatrices, size, size, THREE.RGBAFormat, THREE.FloatType);
    this.boneTexture.magFilter = THREE.NearestFilter;
    this.boneTexture.minFilter = THREE.NearestFilter;
    this.boneTexture.generateMipmaps = false;
    this.boneTexture.needsUpdate = true;
    this.bindMaterial(material);
    this.frustumCulled = false;
    attachWorldNormalMatrix(this);
    this.updateBoneTexture();
  }

  /** Bones excluded from keyframe animation (driven by code instead). Override in a subclass. */
  isBoneAnimated(_name: string): boolean {
    return true;
  }

  /** Points a material's skinning uniforms at this skin's bone texture. */
  bindMaterial(material: THREE.RawShaderMaterial): void {
    material.uniforms.boneTexture = { value: this.boneTexture };
    material.uniforms.boneTextureSize = { value: this.boneTextureSize };
  }

  addAnimation(data: SkinAnimationData): SkinAnimation {
    const animation = new SkinAnimation(this, data);
    this.skinAnimations.push(animation);
    return animation;
  }

  async loadAnimation(path: string): Promise<SkinAnimation> {
    return this.addAnimation(await loadSkinAnimation(path));
  }

  update(): void {
    let total = 0;
    for (const a of this.skinAnimations) total += a.weight;
    this.skinAnimations.forEach((a, i) => a.update(total || 1, i === 0));
    if (!this.autoUpdateBoneTexture) this.updateBoneTexture();
  }

  updateBoneTexture(): void {
    this.root.updateMatrixWorld(true);
    this.bones.forEach((bone, i) => {
      Skin.tmp.multiplyMatrices(bone.matrixWorld, bone.bindInverse);
      this.boneMatrices.set(Skin.tmp.elements, 16 * i);
    });
    this.boneTexture.needsUpdate = true;
  }

  override updateMatrixWorld(force?: boolean): void {
    super.updateMatrixWorld(force);
    this.root.updateMatrixWorld(true);
    if (this.autoUpdateBoneTexture) this.updateBoneTexture();
  }
}
