// 봇 정책 (스펙 §8.1 최소 세트). M4: 손거울(Unhappy) 사용, alwaysUnhappy 추가, balanced는 위/아래 배분.
// M8 (§5.11-8): summon(cell,'unhappy')는 낮 = 맡기기, 밤 = 즉시 소환. 밤에는 창문이 닫히고 sleep()이 있다.
import { isWildcard } from '../../src/core/grid';
import type { Action, Policy } from '../types';
import {
  bestMerge,
  bestSummonCell,
  canSpawn,
  isGridFull,
  lowestReleaseCell,
  pick,
  summonHappy,
  summonUnhappy,
} from './helpers';

/** 아무것도 안 함: 방치 시 최악의 흐름 */
const idle: Policy = {
  name: 'idle',
  decide: () => null,
};

/** 가능한 행동 종류 중 무작위 → 그 안에서 무작위 대상 (보낼 곳도 무작위). 하한선 */
const random: Policy = {
  name: 'random',
  milestone: ({ rng }, choices) => pick(rng, choices).id,
  decide({ state, rng }) {
    const cells = state.grid.cells;
    const filled = cells.flatMap((c, i) => (c ? [i] : []));
    const sendable = filled.filter((i) => !isWildcard(cells[i]!));
    const sides = (['happy', 'unhappy'] as const).filter((s) => !state.laneOf(s).isFull);
    const options: (() => Action)[] = [];
    if (canSpawn(state)) options.push(() => ({ type: 'spawn' }));
    if (filled.length > 0 && cells.length > 1) {
      options.push(() => {
        const from = pick(rng, filled);
        const others = cells.map((_, i) => i).filter((i) => i !== from);
        return { type: 'drop', from, to: pick(rng, others) };
      });
    }
    if (sendable.length > 0 && sides.length > 0) {
      options.push(() => ({ type: 'summon', cell: pick(rng, sendable), side: pick(rng, sides) }));
    }
    if (sendable.length > 0) options.push(() => ({ type: 'release', cell: pick(rng, sendable) }));
    return options.length === 0 ? null : pick(rng, options)();
  },
};

/** 낮: 합칠 수 있으면 합치고, 나머지는 전부 창문으로 (맡기지 않음) / 밤: 아무것도 안 함 (가능하면 잠들기) */
const alwaysHappy: Policy = {
  name: 'alwaysHappy',
  milestone: (_ctx, choices) => choices.find((c) => c.id === 'happy')?.id ?? choices[0].id,
  decide({ state }) {
    if (state.phase === 'night') return state.canSleep ? { type: 'sleep' } : null;
    return (
      bestMerge(state) ??
      summonHappy(state, bestSummonCell(state)) ??
      (canSpawn(state) ? { type: 'spawn' } : null)
    );
  },
};

/** 낮: 전부 맡김 (가득이면 머지) / 밤: 전부 손거울. 퇴화 전략 검사: 방어가 무너져야 함 */
const alwaysUnhappy: Policy = {
  name: 'alwaysUnhappy',
  milestone: (_ctx, choices) => choices.find((c) => c.id === 'unhappy')?.id ?? choices[0].id,
  decide({ state }) {
    return (
      summonUnhappy(state, bestSummonCell(state)) ??
      bestMerge(state) ??
      (canSpawn(state) ? { type: 'spawn' } : null)
    );
  },
};

/** 낮: 최고 단계까지 합친 뒤에만 창문으로. 막히면 가장 낮은 조각을 놓아준다 (사람 쌓아두기의 대리) / 밤: 아무것도 안 함 */
const hoarder: Policy = {
  name: 'hoarder',
  decide({ state }) {
    if (state.phase === 'night') return null;
    const maxTier = state.grid.maxTier;
    const merge = bestMerge(state);
    if (merge) return merge;
    const hero = summonHappy(state, bestSummonCell(state, maxTier));
    if (hero) return hero;
    if (canSpawn(state)) return { type: 'spawn' };
    if (isGridFull(state)) {
      const cell = lowestReleaseCell(state);
      if (cell !== null && state.grid.cells[cell]!.tier < maxTier) return { type: 'release', cell };
    }
    return null;
  },
};

/**
 * 잘하는 사람의 대리. 방어선 위험도·정원·역류 예약을 보고 위/아래로 배분한다.
 * 0) 역류가 예약돼 있으면 창문 보강 우선 (보스를 막을 방어선)
 * 1) 위험(방어선 근처 걱정)하면 창문으로 가장 좋은 조각
 * 2) 방어 유닛이 minUnits 미만이면 창문으로
 * 3) 합칠 수 있으면 합침 (높은 단계 우선)
 * 4) 방어가 안전하면 abyssMinTier 이상 조각을 손거울로 맡김 (밤에 정화 → 단계 +1 귀환)
 * 5) proactiveSummonTier 이상 조각을 창문으로 미리
 * 6) 생성 → 7) 칸이 막히면 보내거나 가장 낮은 조각을 놓아줌
 * 밤: 머지 우선, 남은 조각 중 abyssMinTier 이상을 손거울로 (§5.11-8)
 */
const balanced: Policy = {
  name: 'balanced',
  // 잘하는 사람은 마주한다 (층 HP 감소 + 귀환 보너스)
  milestone: (_ctx, choices) => choices.find((c) => c.id === 'unhappy')?.id ?? choices[0].id,
  decide({ state, cfg }) {
    const p = cfg.balanced;
    if (state.phase === 'night') return bestMerge(state) ?? summonUnhappy(state, bestSummonCell(state, p.abyssMinTier));
    const lane = state.defense;
    const lineY = lane.geo.lineY;
    const danger = lane.worries.some((w) => w.state === 'stopped' || lineY - w.y < p.dangerDistance);
    const safe = !danger && lane.units.length >= p.minUnits && !state.pendingBackflow;

    if (state.pendingBackflow && !lane.isFull) {
      const a = summonHappy(state, bestSummonCell(state));
      if (a) return a;
    }
    if (!lane.isFull && (danger || lane.units.length < p.minUnits)) {
      const a = summonHappy(state, bestSummonCell(state));
      if (a) return a;
    }
    const merge = bestMerge(state);
    if (merge) return merge;
    if (safe) {
      const down = summonUnhappy(state, bestSummonCell(state, p.abyssMinTier));
      if (down) return down;
    }
    const proactive = summonHappy(state, bestSummonCell(state, p.proactiveSummonTier));
    if (proactive) return proactive;
    if (canSpawn(state)) return { type: 'spawn' };
    if (isGridFull(state)) {
      const send = summonHappy(state, bestSummonCell(state)) ?? summonUnhappy(state, bestSummonCell(state));
      if (send) return send;
      const cell = lowestReleaseCell(state);
      if (cell !== null) return { type: 'release', cell };
    }
    return null;
  },
};

export const POLICIES: Record<string, Policy> = { idle, random, alwaysHappy, alwaysUnhappy, hoarder, balanced };
/** 스펙 이름 별칭 */
export const POLICY_ALIASES: Record<string, string> = { greedy: 'alwaysHappy' };
