// 정책 공용: 상태를 읽기만 하는 판단 도우미. 판정은 core의 순수 함수(resolveDrop)를 그대로 쓴다.
import type { GameState } from '../../src/core/game';
import { isWildcard, resolveDrop, type Piece } from '../../src/core/grid';
import type { Side } from '../../src/core/lane';
import { randInt, type Rng } from '../../src/core/rng';
import type { Action } from '../types';

/** 머지 가능한 (from, to) 중 결과 단계가 가장 높은 것. 같으면 먼저 찾은 것 */
export function bestMerge(state: GameState): Action | null {
  const { grid } = state;
  let best: { from: number; to: number; tier: number } | null = null;
  for (let from = 0; from < grid.cells.length; from++) {
    if (!grid.cells[from]) continue;
    for (let to = 0; to < grid.cells.length; to++) {
      if (resolveDrop(grid, from, to) !== 'merge') continue;
      const a = grid.cells[from]!;
      const b = grid.cells[to]!;
      const tier = (isWildcard(b) ? a.tier : b.tier) + 1;
      if (!best || tier > best.tier) best = { from, to, tier };
    }
  }
  return best ? { type: 'drop', from: best.from, to: best.to } : null;
}

/** 조합 가능한 (from, to) 중 조합표 순서상 앞의 것 (§5.13-5). 같으면 먼저 찾은 것 */
export function bestCombine(state: GameState): Action | null {
  let best: { from: number; to: number; rank: number } | null = null;
  const recipes = state.recipes;
  for (let from = 0; from < state.grid.cells.length; from++) {
    if (!state.grid.cells[from]) continue;
    for (let to = 0; to < state.grid.cells.length; to++) {
      const r = state.combinePreview(from, to);
      if (!r) continue;
      const rank = recipes.indexOf(r);
      if (!best || rank < best.rank) best = { from, to, rank };
    }
  }
  return best ? { type: 'drop', from: best.from, to: best.to } : null;
}

/** 조합 우선, 없으면 머지 */
export function bestMergeOrCombine(state: GameState): Action | null {
  return bestCombine(state) ?? bestMerge(state);
}

/** 조건에 맞는 보낼 수 있는 조각 중 단계가 가장 높은 칸 (와일드카드·쉬는 조각 제외) */
export function bestCell(state: GameState, pred: (p: Piece) => boolean): number | null {
  let best: number | null = null;
  state.grid.cells.forEach((p, i) => {
    if (!p || isWildcard(p) || p.restUntil || !pred(p)) return;
    if (best === null || p.tier > state.grid.cells[best]!.tier) best = i;
  });
  return best;
}

/** 소환 가능한 조각(와일드카드·쉬는 조각 제외) 중 단계가 가장 높은 칸. minTier 미만·maxTier 초과면 제외 */
export function bestSummonCell(state: GameState, minTier = 1, maxTier = Infinity): number | null {
  let best: number | null = null;
  state.grid.cells.forEach((p, i) => {
    if (!p || isWildcard(p) || p.restUntil || p.tier < minTier || p.tier > maxTier) return;
    if (best === null || p.tier > state.grid.cells[best]!.tier) best = i;
  });
  return best;
}

/** 놓아줄 조각: 와일드카드 제외, 가장 낮은 단계 */
export function lowestReleaseCell(state: GameState): number | null {
  let best: number | null = null;
  state.grid.cells.forEach((p, i) => {
    if (!p || isWildcard(p)) return;
    if (best === null || p.tier < state.grid.cells[best]!.tier) best = i;
  });
  return best;
}

export function summonTo(state: GameState, cell: number | null, side: Side): Action | null {
  if (cell === null || state.canSummon(cell, side) !== null) return null;
  return { type: 'summon', cell, side };
}

export function summonHappy(state: GameState, cell: number | null): Action | null {
  return summonTo(state, cell, 'happy');
}

export function summonUnhappy(state: GameState, cell: number | null): Action | null {
  return summonTo(state, cell, 'unhappy');
}

export function canSpawn(state: GameState): boolean {
  return state.spawnBlock === null;
}

export function isGridFull(state: GameState): boolean {
  return state.grid.cells.every((c) => c !== null);
}

export function pick<T>(rng: Rng, items: readonly T[]): T {
  return items[randInt(rng, items.length)];
}
