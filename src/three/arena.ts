/** The 3D battle arena: voxel board, voxel armies, and the move choreography. */

import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import type { Chess, Color, Move, PieceSymbol, Square } from 'chess.js'
import { Fx } from './fx'
import { pieceGeometry, pieceHeight, pieceVoxels, VOXEL, voxelGeometry } from './voxels'

const TILE = 1
const BOARD_TOP = 0.16
/** Bounding radius the camera has to keep in frame (board + frame + tall pieces). */
const BOARD_RADIUS = 5.6
const PIECE_VALUE: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 }

const COLORS = {
  white: new THREE.Color('#ffe0b0'),
  black: new THREE.Color('#7b5cff'),
  lightTile: new THREE.Color('#8ea0c4'),
  darkTile: new THREE.Color('#232c46'),
  frame: new THREE.Color('#161c2e'),
}

type PieceMesh = THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial> & {
  userData: { type: PieceSymbol; color: Color; square: Square }
}

export function squarePos(sq: string): THREE.Vector3 {
  const file = sq.charCodeAt(0) - 97
  const rank = Number(sq[1]) - 1
  return new THREE.Vector3((file - 3.5) * TILE, BOARD_TOP, (3.5 - rank) * TILE)
}

export class Arena {
  scene = new THREE.Scene()
  private renderer: THREE.WebGLRenderer
  private camera: THREE.PerspectiveCamera
  private controls: OrbitControls
  private composer: EffectComposer
  private fx: Fx
  private pieces = new Map<Square, PieceMesh>()
  private materials = new Map<Color, THREE.MeshStandardMaterial>()
  private tiles = new Map<string, THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>>()
  private tileGlow = new Map<string, number>()
  private clock = new THREE.Clock()
  private baseCamPos = new THREE.Vector3(0, 10.6, 12.4)
  private running = true

  /** Multiplier on animation length; the UI shrinks it in turbo mode. */
  speed = 1

  constructor(private container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.05
    container.appendChild(this.renderer.domElement)

    this.scene.background = new THREE.Color('#070912')
    this.scene.fog = new THREE.Fog('#070912', 20, 42)

    this.camera = new THREE.PerspectiveCamera(36, 1, 0.1, 100)
    this.camera.position.copy(this.baseCamPos)

    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.08
    this.controls.minDistance = 7
    this.controls.maxDistance = 28
    this.controls.maxPolarAngle = Math.PI * 0.49
    this.controls.autoRotateSpeed = 0.5
    this.controls.target.set(0, 0.5, 0)

    this.buildLights()
    this.buildBoard()

    this.fx = new Fx(this.scene)

    const renderPass = new RenderPass(this.scene, this.camera)
    const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.55, 0.7, 0.75)
    this.composer = new EffectComposer(this.renderer)
    this.composer.addPass(renderPass)
    this.composer.addPass(bloom)
    this.composer.addPass(new OutputPass())

    this.resize()
    addEventListener('resize', this.resize)
    this.renderer.setAnimationLoop(this.tick)
  }

  set autoRotate(on: boolean) {
    this.controls.autoRotate = on
  }

  private buildLights() {
    this.scene.add(new THREE.HemisphereLight('#8ea8ff', '#0a0a14', 0.55))

    const key = new THREE.DirectionalLight('#fff4e0', 1.5)
    key.position.set(6, 12, 7)
    key.castShadow = true
    key.shadow.mapSize.set(2048, 2048)
    key.shadow.camera.near = 1
    key.shadow.camera.far = 40
    const d = 8
    Object.assign(key.shadow.camera, { left: -d, right: d, top: d, bottom: -d })
    key.shadow.camera.updateProjectionMatrix()
    this.scene.add(key)

    const cyan = new THREE.PointLight('#3ef0ff', 42, 22, 2)
    cyan.position.set(-6, 4, 6)
    this.scene.add(cyan)

    const magenta = new THREE.PointLight('#ff3ea5', 42, 22, 2)
    magenta.position.set(6, 4, -6)
    this.scene.add(magenta)
  }

  private buildBoard() {
    // One shared 5x5-voxel plate; each square clones the material so it can glow.
    const plate: { x: number; y: number; z: number }[] = []
    for (let z = 0; z < 5; z++) for (let x = 0; x < 5; x++) plate.push({ x, y: 0, z })
    const tileGeo = voxelGeometry(plate, TILE / 5, 0.22, 2)
    tileGeo.scale(1, BOARD_TOP / (TILE / 5), 1)

    for (let file = 0; file < 8; file++) {
      for (let rank = 0; rank < 8; rank++) {
        const name = String.fromCharCode(97 + file) + (rank + 1)
        const light = (file + rank) % 2 === 1
        const mat = new THREE.MeshStandardMaterial({
          color: light ? COLORS.lightTile : COLORS.darkTile,
          vertexColors: true,
          roughness: 0.85,
          metalness: 0.05,
        })
        const mesh = new THREE.Mesh(tileGeo, mat)
        mesh.position.set((file - 3.5) * TILE, 0, (3.5 - rank) * TILE)
        mesh.receiveShadow = true
        this.scene.add(mesh)
        this.tiles.set(name, mesh)
      }
    }

    // Chunky frame around the board.
    const frame: { x: number; y: number; z: number }[] = []
    for (let x = -1; x <= 40; x++) {
      for (let z = -1; z <= 40; z++) {
        const inside = x >= 2 && x <= 37 && z >= 2 && z <= 37
        if (!inside) frame.push({ x, y: 0, z })
      }
    }
    const frameGeo = voxelGeometry(frame, TILE / 4.5, 0.3, 19.5)
    frameGeo.scale(1, 0.55, 1)
    const frameMesh = new THREE.Mesh(
      frameGeo,
      new THREE.MeshStandardMaterial({ color: COLORS.frame, vertexColors: true, roughness: 0.6, metalness: 0.35 }),
    )
    frameMesh.position.y = -0.02
    frameMesh.receiveShadow = true
    this.scene.add(frameMesh)

    // Faint grid floor for depth.
    const grid = new THREE.GridHelper(60, 60, '#1b2440', '#121a2e')
    grid.position.y = -0.6
    ;(grid.material as THREE.Material).transparent = true
    ;(grid.material as THREE.Material).opacity = 0.5
    this.scene.add(grid)
  }

  /** One material per side — pieces never differ individually, so sharing them
   *  keeps the per-move rebuild free of allocation churn. */
  private pieceMaterial(color: Color) {
    const cached = this.materials.get(color)
    if (cached) return cached
    const base = color === 'w' ? COLORS.white : COLORS.black
    const mat = new THREE.MeshStandardMaterial({
      color: base,
      vertexColors: true,
      roughness: 0.35,
      metalness: 0.45,
      emissive: base.clone().multiplyScalar(0.18),
    })
    this.materials.set(color, mat)
    return mat
  }

  private makePiece(type: PieceSymbol, color: Color, square: Square): PieceMesh {
    const mesh = new THREE.Mesh(pieceGeometry(type), this.pieceMaterial(color)) as PieceMesh
    mesh.castShadow = true
    mesh.receiveShadow = true
    mesh.position.copy(squarePos(square))
    // Knights face the enemy.
    if (type === 'n') mesh.rotation.y = color === 'w' ? 0 : Math.PI
    mesh.userData = { type, color, square }
    return mesh
  }

  /** Rebuild the whole board from a position. Cheap enough to call every move. */
  setPosition(chess: Chess) {
    for (const mesh of this.pieces.values()) this.scene.remove(mesh)
    this.pieces.clear()

    chess.board().forEach((row, r) => {
      row.forEach((cell, f) => {
        if (!cell) return
        const square = (String.fromCharCode(97 + f) + (8 - r)) as Square
        const mesh = this.makePiece(cell.type, cell.color, square)
        this.scene.add(mesh)
        this.pieces.set(square, mesh)
      })
    })
  }

  /** Animate one move, including the capture spectacle. Resolves when settled. */
  async animateMove(move: Move, chess: Chess, opts: { check: boolean; mate: boolean }) {
    const attacker = this.pieces.get(move.from)
    const from = squarePos(move.from)
    const to = squarePos(move.to)
    const dur = 340 * this.speed
    // Turbo runs the series as fast as the API allows; effects would just pile up.
    const flashy = this.speed > 0

    this.pulseTile(move.from, 0.7)
    this.pulseTile(move.to, 1)

    const capturedSquare = move.isEnPassant()
      ? ((move.to[0] + (move.color === 'w' ? Number(move.to[1]) - 1 : Number(move.to[1]) + 1)) as Square)
      : move.to
    const victim = move.captured ? this.pieces.get(capturedSquare) : undefined

    if (attacker) {
      const lift = move.piece === 'n' ? 1.5 : 0.85
      await tween(dur, (t) => {
        const e = easeInOut(t)
        attacker.position.lerpVectors(from, to, e)
        attacker.position.y = BOARD_TOP + Math.sin(Math.PI * e) * lift
        attacker.rotation.z = Math.sin(Math.PI * e) * 0.25 * (to.x > from.x ? -1 : 1)
        attacker.scale.set(1 + 0.12 * Math.sin(Math.PI * e), 1 - 0.1 * Math.sin(Math.PI * e), 1)
      })
      attacker.position.copy(to)
      attacker.rotation.z = 0
    }

    if (victim) {
      if (flashy) {
        const color = victim.userData.color === 'w' ? COLORS.white : COLORS.black
        this.fx.shatter(squarePos(capturedSquare), pieceVoxels(victim.userData.type), VOXEL, color)
        this.fx.shockwave(squarePos(capturedSquare), new THREE.Color('#ff5f4d'), 3)
        this.fx.floatText(
          squarePos(capturedSquare).setY(BOARD_TOP + 1.2),
          `+${PIECE_VALUE[move.captured!] ?? 1}`,
          '#ffd54a',
        )
        this.fx.shake(0.75)
      }
      this.scene.remove(victim)
      this.pieces.delete(capturedSquare)
      if (flashy) this.flashTile(move.to, '#ff8a5c')
    }

    // Landing squash.
    if (attacker) {
      await tween(140 * this.speed, (t) => {
        const s = 1 + 0.18 * Math.sin(Math.PI * t) * (victim ? 1.6 : 1)
        attacker.scale.set(s, 2 - s, s)
      })
      attacker.scale.set(1, 1, 1)
    }

    if (opts.mate) {
      this.fx.shake(flashy ? 1.2 : 0)
      this.fx.shockwave(to, new THREE.Color('#ffd54a'), 8)
      this.fx.floatText(to.clone().setY(BOARD_TOP + 1.8), 'CHECKMATE', '#ffd54a', 0.75)
    } else if (opts.check && flashy) {
      const king = [...this.pieces.values()].find(
        (p) => p.userData.type === 'k' && p.userData.color !== move.color,
      )
      if (king) {
        this.fx.shockwave(king.position.clone().setY(BOARD_TOP), new THREE.Color('#ff3b3b'), 2)
        this.fx.floatText(king.position.clone().setY(BOARD_TOP + pieceHeight('k') + 0.4), 'CHECK', '#ff5b5b', 0.6)
        this.fx.shake(0.35)
      }
    }

    // Castling and promotion are easier to just re-sync than to choreograph.
    this.setPosition(chess)
  }

  announce(text: string, color = '#7df9ff') {
    this.fx.floatText(new THREE.Vector3(0, 2.6, 0), text, color, 0.8)
    this.fx.shockwave(new THREE.Vector3(0, BOARD_TOP, 0), new THREE.Color(color), 12)
  }

  private pulseTile(square: string, amount: number) {
    this.tileGlow.set(square, Math.max(this.tileGlow.get(square) ?? 0, amount))
  }

  private flashTile(square: string, color: string) {
    const tile = this.tiles.get(square)
    if (tile) tile.material.emissive.set(color)
    this.pulseTile(square, 1.4)
  }

  private tick = () => {
    if (!this.running) return
    const dt = Math.min(this.clock.getDelta(), 0.05)

    for (const [square, value] of this.tileGlow) {
      const next = value - dt * 1.6
      const tile = this.tiles.get(square)!
      if (next <= 0) {
        tile.material.emissive.setScalar(0)
        this.tileGlow.delete(square)
      } else {
        this.tileGlow.set(square, next)
        tile.material.emissiveIntensity = next
        if (tile.material.emissive.getHex() === 0) tile.material.emissive.set('#4de3ff')
      }
    }

    this.fx.update(dt)
    this.controls.update()
    this.camera.position.add(this.fx.shakeOffset)
    this.composer.render()
    this.camera.position.sub(this.fx.shakeOffset)
  }

  private resize = () => {
    const { clientWidth: w, clientHeight: h } = this.container
    if (!w || !h) return
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(w, h)
    this.composer.setSize(w, h)
    this.frameBoard()
  }

  /** Pull the camera back far enough that the whole board fits at any aspect. */
  private frameBoard() {
    const vFov = (this.camera.fov * Math.PI) / 180
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * this.camera.aspect)
    const distance = BOARD_RADIUS / Math.sin(Math.min(vFov, hFov) / 2)
    this.controls.maxDistance = Math.max(28, distance * 1.6)
    const offset = this.camera.position.clone().sub(this.controls.target).setLength(distance)
    this.camera.position.copy(this.controls.target).add(offset)
    this.controls.update()
  }

  dispose() {
    this.running = false
    this.renderer.setAnimationLoop(null)
    removeEventListener('resize', this.resize)
    this.renderer.dispose()
  }
}

const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2)

function tween(ms: number, onUpdate: (t: number) => void): Promise<void> {
  if (ms <= 8) {
    onUpdate(1)
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    const start = performance.now()
    let done = false
    const finish = () => {
      if (done) return
      done = true
      onUpdate(1)
      resolve()
    }
    const step = () => {
      if (done) return
      const t = Math.min(1, (performance.now() - start) / ms)
      onUpdate(t)
      if (t < 1) requestAnimationFrame(step)
      else finish()
    }
    requestAnimationFrame(step)
    // Background tabs throttle rAF to ~1fps — don't let that stall the series.
    setTimeout(finish, ms + 1000)
  })
}
