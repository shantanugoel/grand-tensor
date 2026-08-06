/** Pixel-art chess pieces built out of cubes.
 *
 *  Each piece is authored as a side profile, one string per layer from the base
 *  up, on a 9-wide grid. The width of each row is revolved into a disc ("round"),
 *  extruded into a box ("square"), or — for the knight — swept along the board's
 *  depth axis so the row art reads as an actual head in profile.
 *
 *  The details that give a piece its character (crenellations, the queen's crown,
 *  the king's cross, the rook's arrow slits) are generated masks rather than
 *  hand-drawn grids, so they stay legible and easy to retune.
 *
 *  Layers at or above `accentFrom` are emitted into a second geometry group and
 *  get their own material, which is what makes crowns and manes pop. */

import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

export const GRID = 9
export const VOXEL = 0.097

const C = (GRID - 1) / 2

type Mask = boolean[][]

const blank = (): Mask => Array.from({ length: GRID }, () => Array(GRID).fill(false))

/** Rounded cross-section. `r` is the profile half-width in voxels. */
function disc(r: number): Mask {
  const m = blank()
  for (let z = 0; z < GRID; z++)
    for (let x = 0; x < GRID; x++) m[z][x] = Math.hypot(x - C, z - C) <= r - 0.35
  return m
}

function box(first: number, last: number): Mask {
  const m = blank()
  for (let z = first; z <= last; z++) for (let x = first; x <= last; x++) m[z][x] = true
  return m
}

/** One-voxel-thick square border. */
function ring(first: number, last: number): Mask {
  const m = box(first, last)
  for (let z = first + 1; z < last; z++) for (let x = first + 1; x < last; x++) m[z][x] = false
  return m
}

/** Battlements: the border, with two-voxel merlons and gaps between them. */
function crenels(first: number, last: number): Mask {
  const m = ring(first, last)
  for (let z = 0; z < GRID; z++)
    for (let x = 0; x < GRID; x++) if ((Math.floor(x / 2) + Math.floor(z / 2)) % 2 !== 0) m[z][x] = false
  return m
}

/** Arrow slits: the border with the middle of each wall knocked out. */
function slits(first: number, last: number): Mask {
  const m = ring(first, last)
  for (let i = 0; i < GRID; i++) {
    m[C][i] = m[C][i] && i !== first && i !== last
    m[i][C] = m[i][C] && i !== first && i !== last
  }
  return m
}

/** `n` points evenly spaced on a circle — the queen's crown. */
function crown(radius: number, n: number): Mask {
  const m = blank()
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2
    m[Math.round(C + Math.sin(a) * radius)][Math.round(C + Math.cos(a) * radius)] = true
  }
  return m
}

/** Horizontal arm of the king's cross, thickened at the centre to meet the stem. */
function crossBar(half: number): Mask {
  const m = disc(1.5)
  for (let x = C - half; x <= C + half; x++) m[C][x] = true
  return m
}

function union(a: Mask, b: Mask): Mask {
  return a.map((row, z) => row.map((on, x) => on || b[z][x]))
}

export type Voxel = { x: number; y: number; z: number }

/** Picks out the voxels that get the accent material — crowns, manes, eyes. */
type AccentFn = (v: Voxel) => boolean

const above = (y: number): AccentFn => (v) => v.y >= y

type Model = {
  profile: string[]
  shape: 'round' | 'square' | 'knight'
  accent: AccentFn
  /** knight only: first layer of the head sweep; below it the base is revolved. */
  sweepFrom?: number
  /** knight only: half-width of the sweep across the board's x axis. */
  sweepHalf?: number
  special?: Record<number, Mask>
}

const MODELS: Record<string, Model> = {
  // Squat foot soldier: narrow base so it reads as the smallest piece, pinched
  // waist, round helmet capped in accent.
  p: {
    shape: 'round',
    accent: above(8),
    profile: [
      '.XXXXXXX.',
      '.XXXXXXX.',
      '..XXXXX..',
      '..XXXXX..',
      '...XXX...',
      '...XXX...',
      '..XXXXX..',
      '.XXXXXXX.',
      '.XXXXXXX.',
      '..XXXXX..',
    ],
  },

  // Castle tower: straight walls, arrow slits, corbelled top, battlements.
  r: {
    shape: 'square',
    accent: above(9),
    profile: [
      'XXXXXXXXX',
      'XXXXXXXXX',
      '.XXXXXXX.',
      '.XXXXXXX.',
      '.XXXXXXX.',
      '.XXXXXXX.',
      '.XXXXXXX.',
      '.XXXXXXX.',
      '.XXXXXXX.',
      'XXXXXXXXX',
      'XXXXXXXXX',
      'XXXXXXXXX',
    ],
    special: { 5: slits(1, 7), 11: crenels(0, 8) },
  },

  // Horse in profile: chest, arched neck, muzzle out front, ears on top. The
  // accent is the mane down the back of the neck plus a pair of eyes, which is
  // what actually sells it as a head rather than a wedge.
  n: {
    shape: 'knight',
    accent: (v) => (v.z <= 2 && v.y >= 7) || (v.y === 10 && v.z === 6 && Math.abs(v.x - C) === 2),
    sweepFrom: 4,
    sweepHalf: 2,
    profile: [
      'XXXXXXXXX',
      'XXXXXXXXX',
      '.XXXXXXX.',
      '..XXXXX..',
      '..XXXX...',
      '..XXXX...',
      '..XXXXX..',
      '.XXXXXX..',
      '.XXXXXXXX',
      '.XXXXXXXX',
      '.XXXXXXX.',
      '.XXXXX...',
      '.XXXX....',
      '.X.X.....',
    ],
  },

  // Slender stem under a slit mitre, topped with a single-voxel finial.
  b: {
    shape: 'round',
    accent: above(11),
    profile: [
      'XXXXXXXXX',
      'XXXXXXXXX',
      '.XXXXXXX.',
      '..XXXXX..',
      '...XXX...',
      '...XXX...',
      '...XXX...',
      '..XXXXX..',
      '.XXXXXXX.',
      '.XXXXXXX.',
      '.XXXXXXX.',
      '..XXXXX..',
      '..XXXXX..',
      '...XXX...',
      '....X....',
    ],
    special: { 10: slits(1, 7) },
  },

  // Gown flaring into a wide band, eight-point crown, orb on top.
  q: {
    shape: 'round',
    accent: above(13),
    profile: [
      'XXXXXXXXX',
      'XXXXXXXXX',
      'XXXXXXXXX',
      '.XXXXXXX.',
      '..XXXXX..',
      '..XXXXX..',
      '...XXX...',
      '...XXX...',
      '...XXX...',
      '..XXXXX..',
      '.XXXXXXX.',
      'XXXXXXXXX',
      'XXXXXXXXX',
      'XXXXXXXXX',
      '...XXX...',
      '..XXXXX..',
    ],
    special: { 13: union(crown(3.2, 8), disc(1.5)) },
  },

  // Broad shoulders, heavy crown band, cross on top — the tallest piece.
  k: {
    shape: 'round',
    accent: above(14),
    profile: [
      'XXXXXXXXX',
      'XXXXXXXXX',
      'XXXXXXXXX',
      '.XXXXXXX.',
      '..XXXXX..',
      '...XXX...',
      '...XXX...',
      '...XXX...',
      '..XXXXX..',
      '.XXXXXXX.',
      'XXXXXXXXX',
      'XXXXXXXXX',
      '.XXXXXXX.',
      '..XXXXX..',
      '...XXX...',
      '...XXX...',
      '...XXX...',
      '...XXX...',
    ],
    special: { 16: crossBar(3) },
  },
}

function layerMask(model: Model, y: number): Mask {
  const special = model.special?.[y]
  if (special) return special

  const row = model.profile[y]
  const filled = [...row].map((ch) => ch === 'X')
  const first = filled.indexOf(true)
  const last = filled.lastIndexOf(true)
  if (first < 0) return blank()

  if (model.shape === 'square') return box(first, last)
  if (model.shape === 'knight' && y >= (model.sweepFrom ?? 0)) {
    // The row art is the silhouette along z; sweep it across a fixed x width.
    const m = blank()
    const half = model.sweepHalf ?? 2
    for (let z = first; z <= last; z++) for (let x = C - half; x <= C + half; x++) m[z][x] = filled[z]
    return m
  }
  return disc((last - first + 1) / 2)
}

function voxelsFor(model: Model): { base: Voxel[]; accent: Voxel[] } {
  const layers = model.profile.map((_, y) => layerMask(model, y))
  const at = (y: number, z: number, x: number) =>
    y >= 0 && y < layers.length && z >= 0 && z < GRID && x >= 0 && x < GRID && layers[y][z][x]

  const base: Voxel[] = []
  const accent: Voxel[] = []
  for (let y = 0; y < layers.length; y++) {
    for (let z = 0; z < GRID; z++) {
      for (let x = 0; x < GRID; x++) {
        if (!layers[y][z][x]) continue
        // Drop fully-enclosed voxels — they are never visible.
        const enclosed =
          at(y + 1, z, x) && at(y - 1, z, x) && at(y, z + 1, x) && at(y, z - 1, x) && at(y, z, x + 1) && at(y, z, x - 1)
        if (enclosed) continue
        const v = { x, y, z }
        ;(model.accent(v) ? accent : base).push(v)
      }
    }
  }
  return { base, accent }
}

/** Merge a voxel list into one geometry centred on x/z with its base at y=0. */
export function voxelGeometry(voxels: Voxel[], size = VOXEL, shade = 0.1, center = C): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = []
  const color = new THREE.Color()

  for (const v of voxels) {
    const cube = new THREE.BoxGeometry(size, size, size)
    cube.translate((v.x - center) * size, (v.y + 0.5) * size, (v.z - center) * size)
    // A fine 3D checker dither: reads as pixel-art shading without turning the
    // silhouette into visual noise.
    color.setScalar(1 - shade * ((v.x + v.y + v.z) % 2))
    const rgb = new Float32Array(cube.attributes.position.count * 3)
    for (let i = 0; i < cube.attributes.position.count; i++) {
      rgb[i * 3] = color.r
      rgb[i * 3 + 1] = color.g
      rgb[i * 3 + 2] = color.b
    }
    cube.setAttribute('color', new THREE.BufferAttribute(rgb, 3))
    parts.push(cube)
  }
  const merged = mergeGeometries(parts, false)!
  parts.forEach((p) => p.dispose())
  return merged
}

const cache = new Map<string, THREE.BufferGeometry>()

/** Cached geometry for a piece type, with group 0 = body and group 1 = accent. */
export function pieceGeometry(type: string): THREE.BufferGeometry {
  const hit = cache.get(type)
  if (hit) return hit
  const { base, accent } = voxelsFor(MODELS[type] ?? MODELS.p)
  const geo = mergeGeometries([voxelGeometry(base), voxelGeometry(accent)], true)!
  cache.set(type, geo)
  return geo
}

/** Height of a piece in world units — used to place labels and effects. */
export function pieceHeight(type: string): number {
  return (MODELS[type] ?? MODELS.p).profile.length * VOXEL
}

/** The voxel cloud of a piece, for shattering it into debris on capture. */
export function pieceVoxels(type: string): Voxel[] {
  const { base, accent } = voxelsFor(MODELS[type] ?? MODELS.p)
  return [...base, ...accent]
}
