/** The 3D battle arena: voxel board, voxel armies, and the move choreography. */

import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import type { Chess, Color, Move, PieceSymbol, Square } from 'chess.js'
import { TAG_COLOR, TAG_SHOUT, TAG_VOLUME, fmtSwing, type MoveEval } from '../tiny-eval'
import { Fx } from './fx'
import { pieceGeometry, pieceHeight, pieceVoxels, VOXEL, voxelGeometry } from './voxels'

const TILE = 1
const BOARD_TOP = 0.16
/** Bounding radius the camera has to keep in frame. The diagonal view puts the
 *  board's corners nearest, so this covers the frame's corner plus a tall piece
 *  standing on it. */
const BOARD_RADIUS = 7.3
const PIECE_VALUE: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 }

const COLORS = {
  white: new THREE.Color('#ffe0b0'),
  black: new THREE.Color('#7b5cff'),
  whiteAccent: new THREE.Color('#ffb154'),
  blackAccent: new THREE.Color('#3ef0ff'),
  lightTile: new THREE.Color('#8ea0c4'),
  darkTile: new THREE.Color('#232c46'),
  frame: new THREE.Color('#161c2e'),
}

type PieceMesh = THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial[]> & {
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
  private materials = new Map<Color, THREE.MeshStandardMaterial[]>()
  private tiles = new Map<string, THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>>()
  private tileGlow = new Map<string, number>()
  private clock = new THREE.Clock()
  // Looking down the a1–h8 diagonal: the armies sit left and right rather than
  // near and far, ranks stagger instead of hiding each other, and the board
  // reads as an isometric diamond. Only the direction matters — frameBoard()
  // sets the distance.
  private baseCamPos = new THREE.Vector3(-9.6, 10.6, 9.6)
  private running = true
  private lowPower: boolean
  /** When the verdict currently on the board fades, and how loud it was. */
  private shoutUntil = 0
  private shoutVolume = 0

  /** Multiplier on animation length; the UI shrinks it in turbo mode. */
  speed = 1

  /** Set while the video export is capturing. Called with the freshly drawn
   *  canvas at the end of every frame — the same task as the draw, which is the
   *  only moment a renderer with no preserved drawing buffer can be read back.
   *  See `snapshot()` for the same constraint in its one-shot form. */
  onFrame: ((canvas: HTMLCanvasElement) => void) | null = null

  constructor(private container: HTMLElement) {
    // Phones get a lighter setup: no shadow pass, a capped pixel ratio and a
    // cheaper bloom. Everything else is identical.
    this.lowPower = matchMedia('(pointer: coarse)').matches || innerWidth < 860

    this.renderer = new THREE.WebGLRenderer({ antialias: !this.lowPower, powerPreference: 'high-performance' })
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, this.lowPower ? 1.5 : 2))
    this.renderer.shadowMap.enabled = !this.lowPower
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
    this.controls.target.set(0, 0.75, 0)

    this.buildLights()
    this.buildBoard()
    this.buildSideStandards()

    this.fx = new Fx(this.scene)

    const renderPass = new RenderPass(this.scene, this.camera)
    const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), this.lowPower ? 0.42 : 0.55, 0.6, 0.8)
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

  get canvas(): HTMLCanvasElement {
    return this.renderer.domElement
  }

  private buildLights() {
    this.scene.add(new THREE.HemisphereLight('#8ea8ff', '#0a0a14', 0.55))

    const key = new THREE.DirectionalLight('#fff4e0', 1.5)
    key.position.set(6, 12, 7)
    key.castShadow = !this.lowPower
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

  /** Castle-like standards fixed to the two home ranks. Unlike the pieces,
   *  these never move or disappear, so the rotating arena always carries an
   *  unmistakable warm-white and violet-black edge with it. */
  private buildSideStandards() {
    const rookGeo = pieceGeometry('r')

    const addSide = (color: Color, z: number) => {
      const isWhite = color === 'w'
      const body = isWhite ? COLORS.white : COLORS.black
      const accent = isWhite ? COLORS.whiteAccent : COLORS.blackAccent
      const group = new THREE.Group()

      // A luminous "castle wall" runs along the home edge and joins the two
      // sentinel towers. It stays low enough not to hide any live pieces.
      const railMat = new THREE.MeshStandardMaterial({
        color: body,
        emissive: accent,
        emissiveIntensity: 0.42,
        roughness: 0.36,
        metalness: 0.72,
      })
      const rail = new THREE.Mesh(new THREE.BoxGeometry(8.85, 0.1, 0.16), railMat)
      rail.position.y = 0.03
      group.add(rail)

      for (const x of [-4.45, 4.45]) {
        const plinth = new THREE.Mesh(new THREE.BoxGeometry(1.08, 0.22, 0.8), railMat)
        plinth.position.set(x, 0.08, 0)
        plinth.castShadow = !this.lowPower
        plinth.receiveShadow = true
        group.add(plinth)

        const tower = new THREE.Mesh(rookGeo, this.pieceMaterials(color))
        tower.position.set(x, 0.19, 0)
        tower.scale.setScalar(1.2)
        tower.castShadow = !this.lowPower
        tower.receiveShadow = true
        group.add(tower)
      }

      group.position.z = z
      this.scene.add(group)
    }

    addSide('w', 4.62)
    addSide('b', -4.62)
  }

  /** Two materials per side — body and accent — matching the geometry's groups.
   *  Pieces never differ individually, so sharing them keeps the per-move
   *  rebuild free of allocation churn. */
  private pieceMaterials(color: Color) {
    const cached = this.materials.get(color)
    if (cached) return cached
    const make = (c: THREE.Color, metal: number, glow: number) =>
      new THREE.MeshStandardMaterial({
        color: c,
        vertexColors: true,
        roughness: 0.35,
        metalness: metal,
        emissive: c.clone().multiplyScalar(glow),
      })
    const pair =
      color === 'w'
        ? [make(COLORS.white, 0.45, 0.18), make(COLORS.whiteAccent, 0.85, 0.3)]
        : [make(COLORS.black, 0.45, 0.18), make(COLORS.blackAccent, 0.85, 0.3)]
    this.materials.set(color, pair)
    return pair
  }

  private makePiece(type: PieceSymbol, color: Color, square: Square): PieceMesh {
    const mesh = new THREE.Mesh(pieceGeometry(type), this.pieceMaterials(color)) as PieceMesh
    mesh.castShadow = true
    mesh.receiveShadow = true
    mesh.position.copy(squarePos(square))
    // Knights face the enemy.
    // Knights turn broadside to the default diagonal camera, which is the only
    // angle the head reads at. Each side faces outward so the two armies still
    // point away from each other.
    if (type === 'n') mesh.rotation.y = color === 'w' ? Math.PI / 4 : Math.PI / 4 + Math.PI
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

  /** Animate one move, including the capture spectacle. Resolves when settled.
   *
   *  `eval` is what the client-side evaluation made of the move, passed in
   *  rather than computed here so the live match and the video replay each
   *  spend exactly one evaluation per ply. Without it the move simply plays
   *  with no verdict over it. */
  async animateMove(move: Move, chess: Chess, opts: { check: boolean; mate: boolean; eval?: MoveEval }) {
    const attacker = this.pieces.get(move.from)
    const from = squarePos(move.from)
    const to = squarePos(move.to)
    const dur = 340 * this.speed
    // Every capture is worth watching, even in turbo where the pieces teleport —
    // Fx caps its own live effect counts, so back-to-back kills can't pile up.

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
      this.fx.kill({
        origin: squarePos(capturedSquare),
        voxels: pieceVoxels(victim.userData.type),
        voxelSize: VOXEL,
        color: victim.userData.color === 'w' ? COLORS.white : COLORS.black,
        value: PIECE_VALUE[move.captured!] ?? 1,
      })
      this.scene.remove(victim)
      this.pieces.delete(capturedSquare)
      this.flashTile(move.to, '#ff8a5c')
    }

    // Landing squash.
    if (attacker) {
      await tween(140 * this.speed, (t) => {
        const s = 1 + 0.18 * Math.sin(Math.PI * t) * (victim ? 1.6 : 1)
        attacker.scale.set(s, 2 - s, s)
      })
      attacker.scale.set(1, 1, 1)
    }

    // Thrown up as the piece lands, ahead of the check and mate fanfare, so a
    // move that is both a blunder and a check reads as one beat.
    if (opts.eval) this.shoutVerdict(opts.eval, to)

    if (opts.mate) {
      this.fx.shake(1.2)
      this.fx.shockwave(to, new THREE.Color('#ffd54a'), 8)
      this.fx.floatText(to.clone().setY(BOARD_TOP + 1.8), 'CHECKMATE', '#ffd54a', 0.75)
    } else if (opts.check) {
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

  /** The arcade half of the evaluation: a verdict thrown up over the square the
   *  move landed on, and gone a second and a half later.
   *
   *  Deliberately silent the rest of the time. A label on every move is a label
   *  on none of them, and a shallow evaluation has not earned the right to be
   *  that loud — so only the swings a spectator would gasp at get anything, and
   *  what they get scales with how bad it was. */
  private shoutVerdict(verdict: MoveEval, at: THREE.Vector3) {
    const shouts = TAG_SHOUT[verdict.tag]
    if (shouts.length === 0) return

    // Short-lived on purpose: at Blitz — which is what the video replay runs at
    // — a ply is half a second, and a verdict that outlived two of them would
    // spend the match stacked on top of the next one.
    const life = 1.1
    // Two models throwing pieces at each other every ply would otherwise cover
    // the board in verdicts. While one is still on screen only a louder one gets
    // through, so a catastrophe is never crowded out by the mistake before it.
    const now = performance.now()
    const volume = TAG_VOLUME[verdict.tag]
    if (now < this.shoutUntil && volume <= this.shoutVolume) return
    this.shoutUntil = now + life * 1000
    this.shoutVolume = volume

    const color = TAG_COLOR[verdict.tag]
    const hue = new THREE.Color(color)
    this.fx.floatText(at.clone().setY(BOARD_TOP + 2.9), shouts[Math.floor(Math.random() * shouts.length)], color, 0.58, {
      rise: 1.5,
      life,
    })
    this.fx.floatText(at.clone().setY(BOARD_TOP + 2.3), fmtSwing(verdict.loss), color, 0.46, { rise: 1.5, life })

    // A wobble for a mistake; a ring and a shove for a blunder; the full
    // treatment for a move that lost the game.
    if (verdict.tag === 'mistake') return this.fx.shake(0.25)

    this.fx.shockwave(at.clone().setY(BOARD_TOP), hue, verdict.tag === 'catastrophe' ? 7 : 4.5, {
      life: 0.55,
      thickness: 0.18,
    })
    this.fx.shake(verdict.tag === 'catastrophe' ? 0.9 : 0.5)

    if (verdict.tag !== 'catastrophe') return
    this.fx.shockwave(at.clone().setY(BOARD_TOP), hue, 4, { delay: 0.14, life: 0.5, upright: true })
    this.fx.sparks(at.clone().setY(BOARD_TOP), hue, 26, 10)
    this.fx.flash(at, hue, 70, 0.4)
  }

  announce(text: string, color = '#7df9ff') {
    this.fx.floatText(new THREE.Vector3(0, 2.6, 0), text, color, 0.8)
    this.fx.shockwave(new THREE.Vector3(0, BOARD_TOP, 0), new THREE.Color(color), 12)
  }

  /** A still of the arena for the shareable result card. The renderer has no
   *  preserveDrawingBuffer, so the read-back only holds if it happens in the
   *  same task as the draw — hence the render right here. */
  snapshot(): string | null {
    try {
      this.composer.render()
      return this.renderer.domElement.toDataURL('image/png')
    } catch {
      return null
    }
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

    if (this.onFrame) {
      // A capture that throws must not take the render loop down with it — the
      // arena outlives any one export.
      try {
        this.onFrame(this.renderer.domElement)
      } catch {
        this.onFrame = null
      }
    }
  }

  private resize = () => {
    const { clientWidth: w, clientHeight: h } = this.container
    if (!w || !h) return
    this.camera.aspect = w / h
    // Tall windows would otherwise force an absurd pull-back to fit the board's
    // width, so they get a wider lens instead.
    this.camera.fov = this.camera.aspect < 1 ? 52 : 36
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
    // Fog is a fraction of the viewing distance, or a far-away camera would sit
    // entirely inside it and grey the board out.
    const fog = this.scene.fog as THREE.Fog
    fog.near = distance * 0.75
    fog.far = distance * 2.1
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
