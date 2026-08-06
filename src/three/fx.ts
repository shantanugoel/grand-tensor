/** Impact effects: voxel debris, shockwave rings, floating pixel text, screen shake. */

import * as THREE from 'three'

const MAX_DEBRIS = 900
const MAX_WAVES = 28
const MAX_FLASHES = 4
const MAX_FLOATERS = 12
const GRAVITY = -22

type Debris = {
  pos: THREE.Vector3
  vel: THREE.Vector3
  spin: THREE.Vector3
  rot: THREE.Euler
  life: number
  maxLife: number
  size: number
  /** Multiplier on GRAVITY — floaty embers vs. heavy chunks. */
  grav: number
  /** Per-second velocity retention, for cloudy or swirling debris. */
  drag: number
}

type Wave = {
  mesh: THREE.Mesh
  life: number
  maxLife: number
  scale: number
  /** Seconds to hold before the ring appears, for staggered bursts. */
  delay: number
}
type Floater = { sprite: THREE.Sprite; life: number; maxLife: number; rise: number }
type Flash = { light: THREE.PointLight; life: number; maxLife: number; power: number }

/** How a shattered piece throws its own voxels. Everything is optional; the
 *  defaults are the plain radial pop. */
export type ShatterOpts = {
  /** Outward push. Negative sucks the debris through the centre first. */
  out?: number
  up?: number
  /** Tangential speed around the vertical axis — makes the cloud swirl. */
  swirl?: number
  spin?: number
  /** Gravity multiplier; 0 leaves the debris hanging. */
  gravity?: number
  life?: number
  size?: number
  /** Colour multiplier. Above 1 the debris blows out into the bloom pass. */
  glow?: number
}

export type RingOpts = {
  delay?: number
  life?: number
  /** Stands the ring up vertically instead of lying it flat. */
  upright?: boolean
  thickness?: number
}

export class Fx {
  private debris: Debris[] = []
  private debrisMesh: THREE.InstancedMesh
  private waves: Wave[] = []
  private floaters: Floater[] = []
  private flashes: Flash[] = []
  private dummy = new THREE.Object3D()
  private shakeAmount = 0
  private lastKill = -1

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
  shatter(
    origin: THREE.Vector3,
    voxels: { x: number; y: number; z: number }[],
    voxelSize: number,
    color: THREE.Color,
    opts: ShatterOpts = {},
  ) {
    const {
      out: outSpeed = 4,
      up: upSpeed = 7,
      swirl = 0,
      spin = 8,
      gravity = 1,
      life = 1.45,
      size = 1,
      glow = 1,
    } = opts
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
      const vel = out.clone().multiplyScalar(outSpeed * (0.6 + Math.random()))
      vel.y += upSpeed * (0.55 + Math.random() * 0.7)
      // Perpendicular in the ground plane: the whole cloud turns one way.
      if (swirl) vel.add(new THREE.Vector3(-out.z, 0, out.x).multiplyScalar(swirl * (0.7 + Math.random() * 0.6)))
      this.debris.push({
        pos,
        vel,
        rot: new THREE.Euler(),
        spin: new THREE.Vector3(rand(spin), rand(spin), rand(spin)),
        life: 0,
        maxLife: life * (0.75 + Math.random() * 0.5),
        size: voxelSize * size * (0.8 + Math.random() * 0.5),
        grav: gravity,
        drag: swirl ? 0.55 : 0,
      })
      const idx = this.debris.length - 1
      const jitter = (0.75 + Math.random() * 0.5) * glow
      this.debrisMesh.instanceColor!.setXYZ(idx, color.r * jitter, color.g * jitter, color.b * jitter)
    }
    this.debrisMesh.instanceColor!.needsUpdate = true
  }

  /** Weightless embers thrown from a point — the bright half of a blast. */
  sparks(origin: THREE.Vector3, color: THREE.Color, count: number, speed = 9) {
    for (let i = 0; i < count && this.debris.length < MAX_DEBRIS; i++) {
      const dir = new THREE.Vector3(rand(1), Math.random() * 1.2, rand(1)).normalize()
      this.debris.push({
        pos: origin.clone().setY(origin.y + 0.3),
        vel: dir.multiplyScalar(speed * (0.4 + Math.random())),
        rot: new THREE.Euler(),
        spin: new THREE.Vector3(rand(14), rand(14), rand(14)),
        life: 0,
        maxLife: 0.5 + Math.random() * 0.5,
        size: 0.035 + Math.random() * 0.045,
        grav: 0.35,
        drag: 1.6,
      })
      const idx = this.debris.length - 1
      // Well past 1 so the bloom pass catches them.
      this.debrisMesh.instanceColor!.setXYZ(idx, color.r * 2.4, color.g * 2.4, color.b * 2.4)
    }
    this.debrisMesh.instanceColor!.needsUpdate = true
  }

  shockwave(origin: THREE.Vector3, color: THREE.Color, scale = 2.4, opts: RingOpts = {}) {
    if (this.waves.length >= MAX_WAVES) return
    const { delay = 0, life = 0.6, upright = false, thickness = 0.12 } = opts
    const geo = new THREE.RingGeometry(0.34, 0.34 + thickness, 32)
    const mat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
      opacity: 0,
    })
    const mesh = new THREE.Mesh(geo, mat)
    if (upright) mesh.rotation.y = Math.random() * Math.PI
    else mesh.rotation.x = -Math.PI / 2
    mesh.position.copy(origin).setY(origin.y + (upright ? 0.7 : 0.12))
    mesh.visible = delay === 0
    this.scene.add(mesh)
    this.waves.push({ mesh, life: 0, maxLife: life, scale, delay })
  }

  /** A blown-out point light: the eye reads the kill before the debris lands. */
  flash(origin: THREE.Vector3, color: THREE.Color, power = 60, life = 0.35) {
    // Every live light is another shader permutation, so this cap is a hard one.
    if (this.flashes.length >= MAX_FLASHES) return
    const light = new THREE.PointLight(color, power, 9, 2)
    light.position.copy(origin).setY(origin.y + 0.6)
    this.scene.add(light)
    this.flashes.push({ light, life: 0, maxLife: life, power })
  }

  floatText(origin: THREE.Vector3, text: string, color: string, size = 0.9, opts: { rise?: number; life?: number } = {}) {
    // Turbo can outrun the fade, so the oldest label steps aside for the newest.
    while (this.floaters.length >= MAX_FLOATERS) this.dropFloater(0)
    const sprite = makeTextSprite(text, color)
    sprite.position.copy(origin)
    sprite.scale.set(size * sprite.userData.aspect, size, 1)
    this.scene.add(sprite)
    this.floaters.push({ sprite, life: 0, maxLife: opts.life ?? 1.4, rise: opts.rise ?? 1.1 })
  }

  shake(amount: number) {
    this.shakeAmount = Math.min(1.2, this.shakeAmount + amount)
  }

  /** Every capture gets one of these, never the same one twice running. */
  kill(ctx: KillContext) {
    let pick = Math.floor(Math.random() * KILLS.length)
    if (pick === this.lastKill) pick = (pick + 1 + Math.floor(Math.random() * (KILLS.length - 1))) % KILLS.length
    this.lastKill = pick

    const kill = KILLS[pick]
    kill.run(this, ctx)

    const word = kill.words[Math.floor(Math.random() * kill.words.length)]
    this.floatText(ctx.origin.clone().setY(ctx.origin.y + 1.9), word, kill.color, 0.62, { rise: 1.5 })
    this.floatText(ctx.origin.clone().setY(ctx.origin.y + 1.15), `+${ctx.value}`, '#ffd54a')
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
      d.vel.y += GRAVITY * d.grav * dt
      if (d.drag) d.vel.multiplyScalar(Math.max(0, 1 - d.drag * dt))
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
      if (w.delay > 0) {
        w.delay -= dt
        if (w.delay <= 0) w.mesh.visible = true
        continue
      }
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

    // Flashes
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const f = this.flashes[i]
      f.life += dt
      const t = f.life / f.maxLife
      if (t >= 1) {
        this.scene.remove(f.light)
        f.light.dispose()
        this.flashes.splice(i, 1)
        continue
      }
      // Snap to full then fall away fast, like a real blast.
      f.light.intensity = f.power * (1 - t) * (1 - t)
    }

    // Floating text
    for (let i = this.floaters.length - 1; i >= 0; i--) {
      const f = this.floaters[i]
      f.life += dt
      const t = f.life / f.maxLife
      if (t >= 1) {
        this.dropFloater(i)
        continue
      }
      f.sprite.position.y += dt * f.rise
      f.sprite.material.opacity = t < 0.7 ? 1 : 1 - (t - 0.7) / 0.3
    }

    // Shake
    this.shakeAmount = Math.max(0, this.shakeAmount - dt * 2.4)
    const s = this.shakeAmount * this.shakeAmount * 0.35
    this.shakeOffset.set(rand(s), rand(s), rand(s))
  }

  private dropFloater(i: number) {
    const f = this.floaters[i]
    this.scene.remove(f.sprite)
    f.sprite.material.map?.dispose()
    f.sprite.material.dispose()
    this.floaters.splice(i, 1)
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

/* ---------- kill effects ----------
   One per capture, picked at random. Each is the same three ingredients —
   debris, rings, light — dialled to a different shape, so a queen trade never
   looks like the last one. */

export type KillContext = {
  /** Board-level centre of the square the victim stood on. */
  origin: THREE.Vector3
  voxels: { x: number; y: number; z: number }[]
  voxelSize: number
  /** The victim's own colour, so the debris belongs to the piece. */
  color: THREE.Color
  /** Material value of the piece, popped as the score. */
  value: number
}

type Kill = {
  words: string[]
  color: string
  run: (fx: Fx, ctx: KillContext) => void
}

const col = (hex: string) => new THREE.Color(hex)

const KILLS: Kill[] = [
  {
    // Straight-up detonation: everything leaves at once, in every direction.
    words: ['BOOM!', 'KABOOM!', 'NOVA!'],
    color: '#ffd54a',
    run: (fx, k) => {
      fx.flash(k.origin, col('#ffdca0'), 90)
      fx.shatter(k.origin, k.voxels, k.voxelSize, k.color, { out: 6, up: 9, spin: 11 })
      fx.sparks(k.origin, col('#ffcf6a'), 28, 11)
      fx.shockwave(k.origin, col('#ffd54a'), 3.4)
      fx.shockwave(k.origin, col('#ff8a3d'), 5.2, { delay: 0.09, life: 0.55 })
      fx.shake(0.85)
    },
  },
  {
    // The piece collapses into its own centre before the rebound throws it out.
    words: ['VOID!', 'ERASED!', 'DELETED!'],
    color: '#c78bff',
    run: (fx, k) => {
      fx.shatter(k.origin, k.voxels, k.voxelSize, k.color, {
        out: -7,
        up: 1.5,
        gravity: 0.15,
        life: 1.9,
        spin: 5,
      })
      fx.shockwave(k.origin, col('#b06bff'), -0.72, { life: 0.42, thickness: 0.2 })
      fx.shockwave(k.origin, col('#e0b3ff'), 4, { delay: 0.42, life: 0.5 })
      fx.flash(k.origin, col('#8a4dff'), 70, 0.5)
      fx.shake(0.55)
    },
  },
  {
    // A vertical column: the piece is punched off the board.
    words: ['ERUPT!', 'LAUNCH!', 'UPPERCUT!'],
    color: '#6ff5ff',
    run: (fx, k) => {
      fx.shatter(k.origin, k.voxels, k.voxelSize, k.color, { out: 0.8, up: 17, gravity: 1.35, spin: 6 })
      fx.sparks(k.origin, col('#7df9ff'), 22, 14)
      fx.shockwave(k.origin, col('#4de3ff'), 2.2, { thickness: 0.3 })
      fx.shockwave(k.origin, col('#4de3ff'), 3, { delay: 0.16, upright: true, life: 0.5 })
      fx.flash(k.origin, col('#4de3ff'), 75)
      fx.shake(0.7)
    },
  },
  {
    // Low and flat: the debris skids out across the board instead of up.
    words: ['SLAM!', 'CRUNCH!', 'WHAM!'],
    color: '#ff8a5c',
    run: (fx, k) => {
      fx.shatter(k.origin, k.voxels, k.voxelSize, k.color, { out: 11, up: 1.6, gravity: 1.7, spin: 14 })
      fx.shockwave(k.origin, col('#ff5f4d'), 6.5, { life: 0.5, thickness: 0.26 })
      fx.shockwave(k.origin, col('#ffb46a'), 9, { delay: 0.12, life: 0.6 })
      fx.flash(k.origin, col('#ff6a3d'), 65, 0.28)
      fx.shake(1.05)
    },
  },
  {
    // Fine, fast fragments — more of a burst than a break.
    words: ['SHRED!', 'SPLINTER!', 'SHATTER!'],
    color: '#a8ff5c',
    run: (fx, k) => {
      fx.shatter(k.origin, k.voxels, k.voxelSize, k.color, {
        out: 12,
        up: 6,
        spin: 22,
        gravity: 1.25,
        size: 0.62,
        life: 1.1,
      })
      fx.sparks(k.origin, col('#c6ff7a'), 34, 13)
      fx.shockwave(k.origin, col('#a8ff5c'), 4.2, { life: 0.4, thickness: 0.08 })
      fx.shake(0.8)
    },
  },
  {
    // Slow and floaty: the debris orbits the square on its way out.
    words: ['SPIRAL!', 'TWISTER!', 'WARPED!'],
    color: '#ff5fd2',
    run: (fx, k) => {
      fx.shatter(k.origin, k.voxels, k.voxelSize, k.color, {
        out: 1.8,
        up: 6,
        swirl: 8,
        gravity: 0.3,
        life: 2.1,
        spin: 4,
      })
      fx.sparks(k.origin, col('#ff8ae0'), 18, 6)
      fx.shockwave(k.origin, col('#ff5fd2'), 2.6, { life: 0.7 })
      fx.shockwave(k.origin, col('#ff5fd2'), 3.6, { delay: 0.2, life: 0.7 })
      fx.shockwave(k.origin, col('#ffc2f0'), 4.6, { delay: 0.4, life: 0.7 })
      fx.flash(k.origin, col('#ff5fd2'), 55, 0.6)
      fx.shake(0.55)
    },
  },
]

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
