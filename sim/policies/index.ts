// 봇 정책 (스펙 §8.1, §5.17-7, [11]-4). M8.9: 소환·맡기기가 없고 조각은 영웅에게 먹이는 강화 재료.
//   idle / random / balanced(r) / lazy(r) / dayOnly(r=1) / nightOnly(r=0) / hoarder / noFeed
//   r = 낮덱(오펜스) 몫 (cfg.feedRatio, --sweep feedRatio로 바꾼다). dayOnly·nightOnly는 r 고정.
import { isWildcard } from '../../src/core/grid';
import type { Action, Policy, PolicyContext } from '../types';
import { bestFeedCell, bestMerge, canSpawn, emptyCount, feedRole, feedTo, isGridFull, lowestReleaseCell, pick } from './helpers';

/** 아무것도 안 함: 방치 시 최악의 흐름 */
const idle: Policy = {
  name: 'idle',
  decide: () => null,
};

/** 가능한 행동 종류 중 무작위 → 그 안에서 무작위 대상. 하한선 */
const random: Policy = {
  name: 'random',
  milestone: ({ rng }, choices) => pick(rng, choices).id,
  decide({ state, rng }) {
    const cells = state.grid.cells;
    const filled = cells.flatMap((c, i) => (c ? [i] : []));
    const feedable = filled.filter((i) => !isWildcard(cells[i]!));
    const options: (() => Action)[] = [];
    if (canSpawn(state)) options.push(() => ({ type: 'spawn' }));
    if (filled.length > 0 && cells.length > 1) {
      options.push(() => {
        const from = pick(rng, filled);
        const others = cells.map((_, i) => i).filter((i) => i !== from);
        return { type: 'drop', from, to: pick(rng, others) };
      });
    }
    if (feedable.length > 0) options.push(() => ({ type: 'feed', cell: pick(rng, feedable), role: pick(rng, ['offense', 'defense'] as const) }));
    if (feedable.length > 0) options.push(() => ({ type: 'release', cell: pick(rng, feedable) }));
    return options.length === 0 ? null : pick(rng, options)();
  },
};

/**
 * 먹이기 공통: 3단계는 바로 먹인다 (배분 r). 그리드가 막히면(빈 칸 ≤ 1, 머지 없음) 가장 높은 조각을 먹인다.
 */
function feedStep(ctx: PolicyContext, r: number): Action | null {
  const { state } = ctx;
  const t3 = feedTo(state, bestFeedCell(state, state.grid.maxTier), feedRole(state, r));
  if (t3) return t3;
  if (emptyCount(state) <= 1 && !bestMerge(state)) return feedTo(state, bestFeedCell(state), feedRole(state, r));
  return null;
}

/**
 * balanced(r): 조각을 최대한 머지하고(전투 중 머지를 미루지 않음 → 버프·병사), 3단계(또는 그리드 압박 시 아무 단계)를
 * r 비율로 낮덱·(1−r)로 밤덱에 먹인다. 갈림길은 달 쪽(마주함).
 */
function makeBalanced(name: string, fixedR: number | null): Policy {
  const ratio = (ctx: PolicyContext) => fixedR ?? ctx.cfg.feedRatio;
  return {
    name,
    milestone: (_ctx, choices) => choices.find((c) => c.id === 'unhappy')?.id ?? choices[0].id,
    decide(ctx) {
      const { state } = ctx;
      return bestMerge(state) ?? feedStep(ctx, ratio(ctx)) ?? (canSpawn(state) ? { type: 'spawn' } : null);
    },
  };
}

/**
 * lazy(r): balanced와 같은 배분, 머지는 전투 밖에서만 (버프·병사 효과 비교용).
 * 전투 중에는 생성·먹이기만, 막히면 가장 낮은 조각을 놓아준다. 전투 밖(dayStart·이야기 한 장)에서 머지·먹이기를 몰아서.
 */
const lazy: Policy = {
  name: 'lazy',
  milestone: (_ctx, choices) => choices.find((c) => c.id === 'unhappy')?.id ?? choices[0].id,
  decide(ctx) {
    const { state, cfg } = ctx;
    const t3 = feedTo(state, bestFeedCell(state, state.grid.maxTier), feedRole(state, cfg.feedRatio));
    if (t3) return t3;
    if (canSpawn(state)) return { type: 'spawn' };
    return null;
  },
  boundary(ctx) {
    const { state, cfg } = ctx;
    return bestMerge(state) ?? feedStep(ctx, cfg.feedRatio);
  },
};

/** hoarder: 먹이지 않고 3단계까지 쌓기. 막히면 가장 낮은 조각을 놓아준다 (3단계는 지킴) */
const hoarder: Policy = {
  name: 'hoarder',
  decide({ state }) {
    const merge = bestMerge(state);
    if (merge) return merge;
    if (canSpawn(state)) return { type: 'spawn' };
    if (isGridFull(state)) {
      const cell = lowestReleaseCell(state);
      if (cell !== null && state.grid.cells[cell]!.tier < state.grid.maxTier) return { type: 'release', cell };
    }
    return null;
  },
};

/** noFeed: 머지만 (전투 중 버프·병사는 받음), 먹이기 없음. 막히면 가장 낮은 조각을 놓아준다 ([11]-4) */
const noFeed: Policy = {
  name: 'noFeed',
  milestone: (_ctx, choices) => choices.find((c) => c.id === 'unhappy')?.id ?? choices[0].id,
  decide({ state }) {
    const merge = bestMerge(state);
    if (merge) return merge;
    if (canSpawn(state)) return { type: 'spawn' };
    if (isGridFull(state)) {
      const cell = lowestReleaseCell(state);
      if (cell !== null) return { type: 'release', cell };
    }
    return null;
  },
};

export const POLICIES: Record<string, Policy> = {
  idle,
  random,
  balanced: makeBalanced('balanced', null),
  lazy,
  dayOnly: makeBalanced('dayOnly', 1),
  nightOnly: makeBalanced('nightOnly', 0),
  hoarder,
  noFeed,
};
/** 스펙 이름 별칭 */
export const POLICY_ALIASES: Record<string, string> = {};
