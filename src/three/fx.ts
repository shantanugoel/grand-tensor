/** Impact effects: voxel debris, shockwave rings, floating pixel text, screen shake. */

import * as THREE from 'three'

const MAX_DEBRIS = 900
const GRAVITY = -22

type Debris = {
  pos: THREE.Vector3
  vel: THREE.Vector3
  spin: THREE.Vector3
  rot: THREE.Euler
  life: number
  maxLife: number
  size: number
}

type Wave = { mesh: THREE.Mesh; life: number; maxLife: number; scale: number }
type Floater = { sprite: THREE.Sprite; life: number; maxLife: number }

export class Fx {
  private debris: Debris[] = []
  private debrisMesh: THREE.InstancedMesh
  private waves: Wave[] = []
  private floaters: Floater[] = []
  private dummy = new THREE.Object3D()
  private shakeAmount = 0

  readonly shakeOffset = new THREE.Vector3()

  constructor(private scene: THREE.Scene) {
    const geo = new THREE.BoxGeometry(1, 1, 1)
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.1 })
    this.debrisMesh = new THREE.InstancedMesh(geo, mat, MAX_DEBRIS)
    this.debrisMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_DEBRIS * 3), 3)
    this.debrisMesh.frustumCulled = false
    this.debrisMesh.count = 0
    this.debrisMesh.castShadow = true
    scene.add(this.debrisMesh)
  }

  /** Blow a piece apart into its own voxels. */
  shatter(origin: THREE.Vector3, voxels: { x: number; y: number; z: number }[], voxelSize: number, color: THREE.Color) {
    const c = 3
    const spread = Math.min(voxels.length, MAX_DEBRIS - this.debris.length)
    const step = Math.max(1, Math.floor(voxels.length / spread))

    for (let i = 0; i < voxels.length; i += step) {
      if (this.debris.length >= MAX_DEBRIS) break
      const v = voxels[i]
      const pos = new THREE.Vector3(
        origin.x + (v.x - c) * voxelSize,
        origin.y + (v.y + 0.5) * voxelSize,
        origin.z + (v.z - c) * voxelSize,
      )
      const out = new THREE.Vector3(pos.x - origin.x, 0.4, pos.z - origin.z).normalize()
      const vel = out.multiplyScalar(3 + Math.random() * 5)
      vel.y += 4 + Math.random() * 6
      this.debris.push({
        pos,
        vel,
        rot: new THREE.Euler(),
        spin: new THREE.Vector3(rand(8), rand(8), rand(8)),
        life: 0,
        maxLife: 1.1 + Math.random() * 0.7,
        size: voxelSize * (0.8 + Math.random() * 0.5),
      })
      const idx = this.debris.length - 1
      const jitter = 0.75 + Math.random() * 0.5
      this.debrisMesh.instanceColor!.setXYZ(idx, color.r * jitter, color.g * jitter, color.b * jitter)
    }
    this.debrisMesh.instanceColor!.needsUpdate = true
  }

  shockwave(origin: THREE.Vector3, color: THREE.Color, scale = 2.4) {
    const geo = new THREE.RingGeometry(0.34, 0.46, 32)
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, side: THREE.DoubleSide, depthWrite: false })
    const mesh = new THREE.Mesh(geo, mat)
    mesh.rotation.x = -Math.PI / 2
    mesh.position.copy(origin).setY(origin.y + 0.12)
    this.scene.add(mesh)
    this.waves.push({ mesh, life: 0, maxLife: 0.6, scale })
  }

  floatText(origin: THREE.Vector3, text: string, color: string, size = 0.9) {
    const sprite = makeTextSprite(text, color)
    sprite.position.copy(origin)
    sprite.scale.set(size * sprite.userData.aspect, size, 1)
    this.scene.add(sprite)
    this.floaters.push({ sprite, life: 0, maxLife: 1.4 })
  }

  shake(amount: number) {
    this.shakeAmount = Math.min(1.2, this.shakeAmount + amount)
  }

  update(dt: number) {
    // Debris
    for (let i = this.debris.length - 1; i >= 0; i--) {
      const d = this.debris[i]
      d.life += dt
      if (d.life > d.maxLife) {
        this.swapRemoveDebris(i)
        continue
      }
      d.vel.y += GRAVITY * dt
      d.pos.addScaledVector(d.vel, dt)
      if (d.pos.y < 0.05) {
        d.pos.y = 0.05
        d.vel.y *= -0.35
        d.vel.x *= 0.7
        d.vel.z *= 0.7
      }
      d.rot.x += d.spin.x * dt
      d.rot.y += d.spin.y * dt
      d.rot.z += d.spin.z * dt

      const fade = 1 - d.life / d.maxLife
      this.dummy.position.copy(d.pos)
      this.dummy.rotation.copy(d.rot)
      this.dummy.scale.setScalar(d.size * Math.max(0.001, fade))
      this.dummy.updateMatrix()
      this.debrisMesh.setMatrixAt(i, this.dummy.matrix)
    }
    this.debrisMesh.count = this.debris.length
    this.debrisMesh.instanceMatrix.needsUpdate = true

    // Rings
    for (let i = this.waves.length - 1; i >= 0; i--) {
      const w = this.waves[i]
      w.life += dt
      const t = w.life / w.maxLife
      if (t >= 1) {
        this.scene.remove(w.mesh)
        w.mesh.geometry.dispose()
        ;(w.mesh.material as THREE.Material).dispose()
        this.waves.splice(i, 1)
        continue
      }
      w.mesh.scale.setScalar(1 + t * w.scale)
      ;(w.mesh.material as THREE.MeshBasicMaterial).opacity = 1 - t
    }

    // Floating text
    for (let i = this.floaters.length - 1; i >= 0; i--) {
      const f = this.floaters[i]
      f.life += dt
      const t = f.life / f.maxLife
      if (t >= 1) {
        this.scene.remove(f.sprite)
        f.sprite.material.map?.dispose()
        f.sprite.material.dispose()
        this.floaters.splice(i, 1)
        continue
      }
      f.sprite.position.y += dt * 1.1
      f.sprite.material.opacity = t < 0.7 ? 1 : 1 - (t - 0.7) / 0.3
    }

    // Shake
    this.shakeAmount = Math.max(0, this.shakeAmount - dt * 2.4)
    const s = this.shakeAmount * this.shakeAmount * 0.35
    this.shakeOffset.set(rand(s), rand(s), rand(s))
  }

  private swapRemoveDebris(i: number) {
    const last = this.debris.length - 1
    if (i !== last) {
      this.debris[i] = this.debris[last]
      const col = this.debrisMesh.instanceColor!
      col.setXYZ(i, col.getX(last), col.getY(last), col.getZ(last))
      col.needsUpdate = true
    }
    this.debris.pop()
  }
}

const rand = (n: number) => (Math.random() - 0.5) * 2 * n

function makeTextSprite(text: string, color: string): THREE.Sprite {
  const pad = 16
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')!
  const font = '700 64px "Press Start 2P", ui-monospace, monospace'
  ctx.font = font
  const width = Math.ceil(ctx.measureText(text).width) + pad * 2
  canvas.width = Math.max(64, width)
  canvas.height = 96

  const c = canvas.getContext('2d')!
  c.font = font
  c.textAlign = 'center'
  c.textBaseline = 'middle'
  c.lineWidth = 10
  c.strokeStyle = 'rgba(0,0,0,0.85)'
  c.strokeText(text, canvas.width / 2, canvas.height / 2)
  c.fillStyle = color
  c.fillText(text, canvas.width / 2, canvas.height / 2)

  const tex = new THREE.CanvasTexture(canvas)
  tex.magFilter = THREE.NearestFilter
  tex.minFilter = THREE.LinearFilter
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }))
  sprite.userData.aspect = canvas.width / canvas.height
  sprite.renderOrder = 999
  return sprite
}
