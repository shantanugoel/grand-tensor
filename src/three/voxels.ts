/** Pixel-art chess pieces built out of cubes.
 *
 *  Each piece is authored as a 7-wide side profile (bottom row first). For
 *  "round" pieces the profile width is revolved into a disc; "square" pieces
 *  extrude it into a box cross-section. A few layers (rook crenellations, the
 *  queen's crown, the king's cross) are given explicit 7x7 masks instead. */

import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

export const GRID = 7
export const VOXEL = 0.135

type Model = {
  profile: string[]
  shape: 'round' | 'square' | 'extrude'
  /** layerIndex -> 7 rows of 7 chars, back-to-front. */
  special?: Record<number, string[]>
}

const crenels = [
  'XX.X.XX',
  'X.....X',
  '.......',
  'X.....X',
  '.......',
  'X.....X',
  'XX.X.XX',
]

const crown = [
  'X.X.X.X',
  '.......',
  'X.....X',
  '.......',
  'X.....X',
  '.......',
  'X.X.X.X',
]

const crossBar = [
  '.......',
  '.......',
  '.......',
  '.XXXXX.',
  '.......',
  '.......',
  '.......',
]

const dot = [
  '.......',
  '.......',
  '..XXX..',
  '..XXX..',
  '..XXX..',
  '.......',
  '.......',
]

const MODELS: Record<string, Model> = {
  p: {
    shape: 'round',
    profile: ['XXXXXXX', 'XXXXXXX', '.XXXXX.', '..XXX..', '..XXX..', '.XXXXX.', '.XXXXX.', '..XXX..'],
  },
  r: {
    shape: 'square',
    profile: ['XXXXXXX', 'XXXXXXX', '.XXXXX.', '.XXXXX.', '.XXXXX.', '.XXXXX.', 'XXXXXXX', 'XXXXXXX', 'XXXXXXX'],
    special: { 8: crenels },
  },
  n: {
    // Horse head in side profile, extruded across the board's x axis.
    shape: 'extrude',
    profile: [
      'XXXXXXX',
      'XXXXXXX',
      '.XXXXX.',
      '..XXX..',
      '..XXX..',
      '..XXXX.',
      '..XXXXX',
      '.XXXXXX',
      '.XXXXX.',
      '..XX...',
    ],
  },
  b: {
    shape: 'round',
    profile: ['XXXXXXX', 'XXXXXXX', '.XXXXX.', '..XXX..', '..XXX..', '..XXX..', '.XXXXX.', '.XXXXX.', '..XXX..', '...X...', '...X...'],
  },
  q: {
    shape: 'round',
    profile: ['XXXXXXX', 'XXXXXXX', '.XXXXX.', '..XXX..', '..XXX..', '..XXX..', '.XXXXX.', 'XXXXXXX', 'XXXXXXX', 'XXXXXXX', 'XXXXXXX'],
    special: { 9: crown, 10: dot },
  },
  k: {
    shape: 'round',
    profile: [
      'XXXXXXX',
      'XXXXXXX',
      '.XXXXX.',
      '..XXX..',
      '..XXX..',
      '..XXX..',
      '..XXX..',
      '.XXXXX.',
      'XXXXXXX',
      'XXXXXXX',
      '...X...',
      '.XXXXX.',
      '...X...',
    ],
    special: { 11: crossBar },
  },
}

type Voxel = { x: number; y: number; z: number }

function maskFromProfileRow(row: string, shape: Model['shape']): boolean[][] {
  const filled = [...row].map((c) => c === 'X')
  const first = filled.indexOf(true)
  const last = filled.lastIndexOf(true)
  const mask: boolean[][] = Array.from({ length: GRID }, () => Array(GRID).fill(false))
  if (first < 0) return mask

  const c = (GRID - 1) / 2
  const radius = (last - first + 1) / 2

  for (let z = 0; z < GRID; z++) {
    for (let x = 0; x < GRID; x++) {
      if (shape === 'round') {
        const dx = x - c
        const dz = z - c
        mask[z][x] = Math.hypot(dx, dz) <= radius - 0.35
      } else if (shape === 'square') {
        mask[z][x] = x >= first && x <= last && z >= first && z <= last
      } else {
        // extrude: profile spans z, fixed narrow width in x
        const half = Math.max(1, Math.round((last - first + 1) / 2) - 1)
        mask[z][x] = filled[z] && Math.abs(x - c) <= half
      }
    }
  }
  return mask
}

function voxelsFor(model: Model): Voxel[] {
  const layers: boolean[][][] = model.profile.map((row, i) => {
    const special = model.special?.[i]
    if (special) return special.map((r) => [...r].map((ch) => ch === 'X'))
    return maskFromProfileRow(row, model.shape)
  })

  const at = (y: number, z: number, x: number) =>
    y >= 0 && y < layers.length && z >= 0 && z < GRID && x >= 0 && x < GRID && layers[y][z][x]

  const out: Voxel[] = []
  for (let y = 0; y < layers.length; y++) {
    for (let z = 0; z < GRID; z++) {
      for (let x = 0; x < GRID; x++) {
        if (!layers[y][z][x]) continue
        // Drop fully-enclosed voxels — they are never visible.
        const enclosed =
          at(y + 1, z, x) && at(y - 1, z, x) && at(y, z + 1, x) && at(y, z - 1, x) && at(y, z, x + 1) && at(y, z, x - 1)
        if (!enclosed) out.push({ x, y, z })
      }
    }
  }
  return out
}

/** Merge a voxel list into one geometry centred on x/z with its base at y=0. */
export function voxelGeometry(
  voxels: Voxel[],
  size = VOXEL,
  shade = 0.1,
  center = (GRID - 1) / 2,
): THREE.BufferGeometry {
  const c = center
  const parts: THREE.BufferGeometry[] = []
  const color = new THREE.Color()

  for (const v of voxels) {
    const box = new THREE.BoxGeometry(size, size, size)
    box.translate((v.x - c) * size, (v.y + 0.5) * size, (v.z - c) * size)
    // A fine 3D checker dither: reads as pixel-art shading without turning the
    // silhouette into visual noise.
    const jitter = 1 - shade * ((v.x + v.y + v.z) % 2)
    color.setScalar(jitter)
    const rgb = new Float32Array(box.attributes.position.count * 3)
    for (let i = 0; i < box.attributes.position.count; i++) {
      rgb[i * 3] = color.r
      rgb[i * 3 + 1] = color.g
      rgb[i * 3 + 2] = color.b
    }
    box.setAttribute('color', new THREE.BufferAttribute(rgb, 3))
    parts.push(box)
  }
  const merged = mergeGeometries(parts, false)!
  parts.forEach((p) => p.dispose())
  return merged
}

const cache = new Map<string, THREE.BufferGeometry>()

/** Cached, shared geometry for a piece type ('p','n','b','r','q','k'). */
export function pieceGeometry(type: string): THREE.BufferGeometry {
  const hit = cache.get(type)
  if (hit) return hit
  const geo = voxelGeometry(voxelsFor(MODELS[type] ?? MODELS.p))
  cache.set(type, geo)
  return geo
}

/** Height of a piece in world units — used to place labels and effects. */
export function pieceHeight(type: string): number {
  return (MODELS[type] ?? MODELS.p).profile.length * VOXEL
}

/** The voxel cloud of a piece, for shattering it into debris on capture. */
export function pieceVoxels(type: string): Voxel[] {
  return voxelsFor(MODELS[type] ?? MODELS.p)
}
