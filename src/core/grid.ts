// 머지 그리드 규칙. Phaser 의존 없음 (스펙 §4.1, §4.1.1).
// 판정(resolveDrop)은 순수 함수, 적용(applyDrop 등)은 grid를 제자리에서 바꾼다.

import { randInt, weightedPick, type Rng } from './rng';

export type ChainId = string;
export const WILDCARD = 'wildcard' as const;
/** 와일드카드는 단계가 없다. 저장 형식을 맞추기 위해 0으로 둔다 */
export const WILDCARD_TIER = 0;

export interface Piece {
  /** 증가 정수 */
  id: number;
  chain: ChainId | typeof WILDCARD;
  tier: number;
  /** 생성 시점의 누적 게임 시간(초, 배속 반영) */
  bornAt: number;
  /** 빛나는 영웅: 밤에 정화된 영웅 (§5.13-3). 능력치 × hero.shineMult */
  shining?: boolean;
  /** 부상으로 쉬는 중 (§5.13-2): 'dawn' = 새벽에 / 'dusk' = 다음 해질녘에 풀림 */
  restUntil?: 'dawn' | 'dusk' | null;
  /** 전설 추억 (tier 4): 조합표 id (§5.13-5) */
  legend?: string;
}

export interface GridSize {
  cols: number;
  rows: number;
}

export interface Grid extends GridSize {
  maxTier: number;
  /** 행 우선(row-major). 길이 = cols × rows */
  cells: (Piece | null)[];
}

export function createGrid({ cols, rows }: GridSize, maxTier: number): Grid {
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) {
    throw new Error(`잘못된 그리드 크기: ${cols}×${rows}`);
  }
  return { cols, rows, maxTier, cells: new Array<Piece | null>(cols * rows).fill(null) };
}

export function isWildcard(p: Piece): boolean {
  return p.chain === WILDCARD;
}

// ── 좌표 ──

export function toIndex(size: GridSize, col: number, row: number): number {
  if (col < 0 || col >= size.cols || row < 0 || row >= size.rows) {
    throw new RangeError(`칸 범위 밖: (${col}, ${row}) / ${size.cols}×${size.rows}`);
  }
  return row * size.cols + col;
}

export function toCell(size: GridSize, index: number): { col: number; row: number } {
  if (!isValidIndex(size, index)) {
    throw new RangeError(`인덱스 범위 밖: ${index} / ${size.cols}×${size.rows}`);
  }
  return { col: index % size.cols, row: Math.floor(index / size.cols) };
}

function isValidIndex(size: GridSize, index: number): boolean {
  return Number.isInteger(index) && index >= 0 && index < size.cols * size.rows;
}

export function isPreset(presets: [number, number][], size: GridSize): boolean {
  return presets.some(([c, r]) => c === size.cols && r === size.rows);
}

/** 요청한 크기가 프리셋에 있으면 그것을, 아니면 기본 크기를 쓴다. */
export function resolveGridSize(presets: [number, number][], fallback: GridSize, requested?: GridSize | null): GridSize {
  if (requested && isPreset(presets, requested)) return { cols: requested.cols, rows: requested.rows };
  return { cols: fallback.cols, rows: fallback.rows };
}

// ── 빈 칸 ──

/** 빈 칸 인덱스 (행 우선 순서) */
export function emptyIndices(grid: Grid): number[] {
  const out: number[] = [];
  grid.cells.forEach((c, i) => {
    if (c === null) out.push(i);
  });
  return out;
}

export function isFull(grid: Grid): boolean {
  return grid.cells.every((c) => c !== null);
}

// ── 드래그 결과 (§4.1.1 결과표) ──

export type DropKind = 'move' | 'merge' | 'swap' | 'none';

/**
 * A(from 칸의 조각)를 B(to 칸)에 놓았을 때의 결과 종류. grid를 바꾸지 않는다.
 * to가 null이면 그리드 밖(무효 영역·포탈·레인) → 'none' (M3에서 소환 연결).
 */
export function resolveDrop(grid: Grid, from: number, to: number | null): DropKind {
  if (to === null || from === to || !isValidIndex(grid, from) || !isValidIndex(grid, to)) return 'none';
  const a = grid.cells[from];
  const b = grid.cells[to];
  if (!a) return 'none';
  if (!b) return 'move';
  const aWild = isWildcard(a);
  const bWild = isWildcard(b);
  if (aWild && bWild) return 'swap';
  if (aWild) return b.tier < grid.maxTier ? 'merge' : 'swap';
  if (bWild) return a.tier < grid.maxTier ? 'merge' : 'swap';
  if (a.chain === b.chain && a.tier === b.tier && a.tier < grid.maxTier) return 'merge';
  return 'swap';
}

/**
 * resolveDrop 결과를 grid에 적용한다. 결과는 항상 B(to) 칸에 생긴다.
 * 머지 결과 조각은 체인을 가진 쪽의 id를 이어받고 (둘 다 체인이면 B), bornAt은 재료 중 더 이른 값.
 */
export function applyDrop(grid: Grid, from: number, to: number | null): DropKind {
  const kind = resolveDrop(grid, from, to);
  if (kind === 'none' || to === null) return kind;
  const a = grid.cells[from]!;
  const b = grid.cells[to];
  switch (kind) {
    case 'move':
      grid.cells[to] = a;
      grid.cells[from] = null;
      break;
    case 'swap':
      grid.cells[to] = a;
      grid.cells[from] = b;
      break;
    case 'merge': {
      const base = isWildcard(b!) ? a : b!;
      grid.cells[to] = { ...base, tier: base.tier + 1, bornAt: Math.min(a.bornAt, b!.bornAt) };
      grid.cells[from] = null;
      break;
    }
  }
  return kind;
}

// ── 조각 생성 ──

export interface SpawnConfig {
  spawnCostBase: number;
  spawnCostStep: number;
}

export function spawnCost(cfg: SpawnConfig, spawnedToday: number): number {
  return cfg.spawnCostBase + cfg.spawnCostStep * spawnedToday;
}

/** 생성 불가 사유. 둘 다 해당하면 'full' (기쁨을 모아도 해결되지 않으므로) */
export type SpawnBlock = 'full' | 'noJoy';

export function spawnBlock(grid: Grid, joy: number, cost: number): SpawnBlock | null {
  if (isFull(grid)) return 'full';
  if (joy < cost) return 'noJoy';
  return null;
}

export interface ChainWeight {
  id: ChainId;
  weight: number;
}

export function pickChain(rng: Rng, chains: readonly ChainWeight[]): ChainId {
  return weightedPick(rng, chains, (c) => c.weight).id;
}

/** 빈 칸 중 랜덤 1칸. 빈 칸이 없으면 null */
export function pickEmpty(rng: Rng, grid: Grid): number | null {
  const empty = emptyIndices(grid);
  return empty.length === 0 ? null : empty[randInt(rng, empty.length)];
}

// ── 놓아주기 ──

/** 놓아주기 환급액. 와일드카드는 놓아줄 수 없으므로 null (드래그 중 미리보기에도 사용) */
export function releaseValue(piece: Piece, releaseRefund: number): number | null {
  return isWildcard(piece) ? null : releaseRefund * piece.tier;
}

/** 조각 제거 후 환급액을 돌려준다. 빈 칸·와일드카드는 무시하고 null */
export function releaseAt(grid: Grid, index: number, releaseRefund: number): { piece: Piece; refund: number } | null {
  if (!isValidIndex(grid, index)) return null;
  const p = grid.cells[index];
  const refund = p ? releaseValue(p, releaseRefund) : null;
  if (!p || refund === null) return null;
  grid.cells[index] = null;
  return { piece: p, refund };
}

// ── 귀환 대기열 (§4.1.1, 호출은 M4) ──

export interface EnqueueResult {
  /** 즉시 배치된 칸. 대기·소실이면 null */
  placedAt: number | null;
  queued: boolean;
  /** 소실된 조각 수 (0 또는 1) */
  lost: number;
}

/**
 * 빈 칸이 있으면 rng로 고른 빈 칸에 즉시 배치, 없으면 대기열 끝에 추가. 대기열이 cap이면 소실.
 * 행 우선 첫 빈 칸(왼쪽 위 = ☀ 창문 포탈 근처)에 두면 Happy 쪽 소환 편향이 생기므로 쓰지 않는다 (D-019).
 */
export function enqueueReturn(grid: Grid, queue: Piece[], piece: Piece, cap: number, rng: Rng, ignoreCap = false): EnqueueResult {
  // 먼저 온 대기 조각이 앞서도록 대기열부터 비운다
  flushReturnQueue(grid, queue, rng);
  const index = pickEmpty(rng, grid);
  if (index !== null) {
    grid.cells[index] = piece;
    return { placedAt: index, queued: false, lost: 0 };
  }
  // 영웅·전설은 사라지지 않는다: 대기열 상한을 무시한다 (§5.13-2)
  if (queue.length >= cap && !ignoreCap) return { placedAt: null, queued: false, lost: 1 };
  queue.push(piece);
  return { placedAt: null, queued: true, lost: 0 };
}

/** 대기열 앞에서부터 rng로 고른 빈 칸에 배치. 배치된 칸 목록을 배치 순서대로 돌려준다 */
export function flushReturnQueue(grid: Grid, queue: Piece[], rng: Rng): number[] {
  const placed: number[] = [];
  while (queue.length > 0) {
    const index = pickEmpty(rng, grid);
    if (index === null) break;
    grid.cells[index] = queue.shift()!;
    placed.push(index);
  }
  return placed;
}
