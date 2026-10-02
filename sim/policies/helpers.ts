// 정책 공용: 상태를 읽기만 하는 판단 도우미. 판정은 core의 순수 함수(resolveDrop)를 그대로 쓴다.
import type { GameState } from '../../src/core/game';
import { isWildcard, resolveDrop } from '../../src/core/grid';
import { randInt, type Rng } from '../../src/core/rng';
import type { Action } from '../types';

/**
 * 머지 가능한 (from, to) 중 결과 단계가 가장 높은 것. 같으면 먼저 찾은 것.
 * 자동 뭉침 (D-070): 와일드카드 없이 autoMergeMaxTier 이하끼리는 core가 저절로 합치므로 손으로 하지 않는다
 */
export function bestMerge(state: GameState): Action | null {
  const { grid } = state;
  const autoMax = state.autoMergeMaxTier;
  let best: { from: number; to: number; tier: number } | null = null;
  for (let from = 0; from < grid.cells.length; from++) {
    if (!grid.cells[from]) continue;
    for (let to = 0; to < grid.cells.length; to++) {
      if (resolveDrop(grid, from, to) !== 'merge') continue;
      const a = grid.cells[from]!;
      const b = grid.cells[to]!;
      if (!isWildcard(a) && !isWildcard(b) && a.tier <= autoMax) continue;
      const tier = (isWildcard(b) ? a.tier : b.tier) + 1;
      if (!best || tier > best.tier) best = { from, to, tier };
    }
  }
  return best ? { type: 'drop', from: best.from, to: best.to } : null;
}

/**
 * 연쇄 사다리 (D-073): (from → to) 손 머지 결과 단계 t부터 같은 체인 t, t+1, … 조각이 그리드에 있으면 그 id들 (단계 순).
 * 와일드카드가 끼면 연쇄 없음 (빈 배열). 봇은 chainSkill 확률로 "이 조각들이 맞닿게 놓았다"고 가정해 drop(from, to, 이 목록)
 */
export function chainLadder(state: GameState, from: number, to: number): number[] {
  const { grid } = state;
  const a = grid.cells[from];
  const b = grid.cells[to];
  if (!a || !b || isWildcard(a) || isWildcard(b) || resolveDrop(grid, from, to) !== 'merge') return [];
  const ids: number[] = [];
  for (let t = b.tier + 1; t < grid.maxTier; t++) {
    const i = grid.cells.findIndex((q, k) => k !== from && k !== to && q !== null && !isWildcard(q) && q.chain === b.chain && q.tier === t);
    if (i < 0) break;
    ids.push(grid.cells[i]!.id);
  }
  return ids;
}

/** 연쇄가 가장 긴 손 머지 (사다리 1칸 이상 = 2연쇄 이상). 자동 뭉침 단계 이하는 손대지 않음. 없으면 null */
export function bestChainMerge(state: GameState): { action: Action; ladder: number } | null {
  const { grid } = state;
  const autoMax = state.autoMergeMaxTier;
  let best: { from: number; to: number; ladder: number } | null = null;
  for (let from = 0; from < grid.cells.length; from++) {
    const a = grid.cells[from];
    if (!a || isWildcard(a) || a.tier <= autoMax) continue;
    for (let to = 0; to < grid.cells.length; to++) {
      if (to === from) continue;
      const ladder = chainLadder(state, from, to).length;
      if (ladder > 0 && (!best || ladder > best.ladder)) best = { from, to, ladder };
    }
  }
  return best && { action: { type: 'drop', from: best.from, to: best.to }, ladder: best.ladder };
}

/** 최고 단계(더 합칠 수 없는) 조각 칸 (와일드카드 제외). 없으면 null */
export function topTierCell(state: GameState): number | null {
  const i = state.grid.cells.findIndex((p) => p !== null && !isWildcard(p) && p.tier >= state.grid.maxTier);
  return i >= 0 ? i : null;
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

export function isGridFull(state: GameState): boolean {
  return state.grid.cells.every((c) => c !== null);
}

export function emptyCount(state: GameState): number {
  return state.grid.cells.reduce((n, c) => n + (c ? 0 : 1), 0);
}

export function pick<T>(rng: Rng, items: readonly T[]): T {
  return items[randInt(rng, items.length)];
}
