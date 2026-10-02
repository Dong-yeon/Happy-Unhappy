// 봇 정책 (스펙 §8.1, §5.20-10, §5.22-8): balanced / dayHeavy / nightHeavy / noInk / noStar / idle / random
//   (+ noMerge·lazy, roster all 인연 비교용 bondOn·bondOff). dayHeavy·nightHeavy = 성장 자원(잉크·별가루)을 한쪽에 몰기 (M8.12).
// 먹이기 정책(feedRatio·noFeed·dayOnly·nightOnly·hoarder)은 먹이기 삭제로 없어졌다.
// §5.20-13: 조각 생성 버튼이 없어져(저절로 + 처치 드롭) 정책의 손은 머지·놓아주기뿐. noMerge는 idle과 사실상 같다 (가득이면 놓아주기만).
import type { GameState } from '../../src/core/game';
import type { Formation } from '../../src/core/roster';
import type { Action, Policy, PolicyContext } from '../types';
import { bestChainMerge, bestMerge, emptyCount, isGridFull, lowestReleaseCell, pick, topTierCell } from './helpers';

const TEAM = 3;

/** 3명씩 팀으로 */
function chunk(ids: string[]): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += TEAM) out.push(ids.slice(i, i + TEAM));
  return out.length ? out : [[]];
}

/** balanced 편성: 보유 영웅을 공격대·수비대에 번갈아, 1팀부터 채움 */
export function alternateFormation(state: GameState): Formation {
  const owned = state.owned;
  const off = owned.filter((_, i) => i % 2 === 0);
  const def = owned.filter((_, i) => i % 2 === 1);
  return { offense: chunk(off), defense: chunk(def) };
}

/** 한쪽 몰기: 반대쪽 최소 1명, 나머지 전부 이쪽 */
function heavyFormation(state: GameState, side: 'offense' | 'defense'): Formation {
  const owned = state.owned;
  const other = side === 'offense' ? 'defense' : 'offense';
  // 기본 편성의 반대쪽 영웅(시작 명단 기준) 1명을 남긴다
  const keep = state.formation[other][0]?.[0] ?? owned[owned.length - 1];
  const rest = owned.filter((id) => id !== keep);
  return { [side]: chunk(rest), [other]: [[keep]] } as unknown as Formation;
}

/** roster all 인연 켬: 공격대 [해태·삽살·누이] (모험대) / 수비대 [테스트 B·오라비·테스트 A] (해와 달 + 고른 팀) */
function bondOnFormation(state: GameState): Formation {
  const want = { offense: [['haetae', 'sapsal', 'nui']], defense: [['test_b', 'orabi', 'test_a']] };
  return state.formationError(want) ? alternateFormation(state) : want;
}

/** roster all 인연 끔: 공격대 [삽살·오라비·테스트 A] / 수비대 [해태·누이·테스트 B] */
function bondOffFormation(state: GameState): Formation {
  const want = { offense: [['sapsal', 'orabi', 'test_a']], defense: [['haetae', 'nui', 'test_b']] };
  return state.formationError(want) ? alternateFormation(state) : want;
}

/** 머지 다음: 5단계 조각은 더 쓸 데가 없어 놓아줌, 막히면 가장 낮은 조각 놓아줌 */
function tidy(state: GameState): Action | null {
  const top = topTierCell(state);
  if (top !== null && isGridFull(state)) return { type: 'release', cell: top };
  if (isGridFull(state) && !bestMerge(state)) {
    const cell = lowestReleaseCell(state);
    if (cell !== null) return { type: 'release', cell };
  }
  return null;
}

/** 아무것도 안 함: 방치 시 최악의 흐름 (머지·잉크·진급 모두 안 함) */
const idle: Policy = { name: 'idle', grow: 'none', promote: false, decide: () => null };

/** 가능한 행동 종류 중 무작위 → 그 안에서 무작위 대상. 하한선 */
const random: Policy = {
  name: 'random',
  grow: 'random',
  decide({ state, rng }) {
    const cells = state.grid.cells;
    const filled = cells.flatMap((c, i) => (c ? [i] : []));
    const options: (() => Action)[] = [];
    if (filled.length > 0 && cells.length > 1) {
      options.push(() => {
        const from = pick(rng, filled);
        const others = cells.map((_, i) => i).filter((i) => i !== from);
        return { type: 'drop', from, to: pick(rng, others) };
      });
      options.push(() => ({ type: 'release', cell: pick(rng, filled) }));
    }
    return options.length === 0 ? null : pick(rng, options)();
  },
};

/** 머지를 미루지 않는다 (전투 중 머지 → 버프·병사·스킬 게이지) */
function makeMerger(name: string, formation?: (s: GameState) => Formation, grow: Policy['grow'] = 'alternate', promote = true): Policy {
  return {
    name,
    formation,
    grow,
    promote,
    decide(ctx: PolicyContext) {
      const { state } = ctx;
      return bestMerge(state) ?? tidy(state);
    },
  };
}

/**
 * chainer (D-073): 같은 체인을 단계별로 모아 두었다가 연쇄로 터뜨린다 — 2연쇄 이상 되는 머지가 있으면 가장 긴 것,
 * 없으면 기다림 (빈 칸이 CHAINER_ROOM 이하로 줄면 보통 머지로 칸을 비움)
 */
const CHAINER_ROOM = 2;
const chainer: Policy = {
  name: 'chainer',
  formation: alternateFormation,
  decide({ state }) {
    const c = bestChainMerge(state);
    if (c) return c.action;
    if (emptyCount(state) <= CHAINER_ROOM) return bestMerge(state) ?? tidy(state);
    return null;
  },
};

/** noMerge: 머지 안 함 (가득 차면 가장 낮은 조각을 놓아줌) */
const noMerge: Policy = {
  name: 'noMerge',
  decide({ state }) {
    if (isGridFull(state)) {
      const cell = lowestReleaseCell(state);
      if (cell !== null) return { type: 'release', cell };
    }
    return null;
  },
};

/** lazy: 전투 중에는 손대지 않고(가득이면 조각이 버려짐), 머지는 전투 밖(장면 카드·이야기 한 장)에서 몰아서 */
const lazy: Policy = {
  name: 'lazy',
  decide: () => null,
  boundary({ state }) {
    return bestMerge(state) ?? tidy(state);
  },
};

export const POLICIES: Record<string, Policy> = {
  balanced: makeMerger('balanced', alternateFormation),
  dayHeavy: makeMerger('dayHeavy', alternateFormation, 'offense'),
  nightHeavy: makeMerger('nightHeavy', alternateFormation, 'defense'),
  noInk: makeMerger('noInk', alternateFormation, 'none'),
  noStar: makeMerger('noStar', alternateFormation, 'alternate', false),
  idle,
  random,
};

/** roster all 인연 비교용 (전 정책 목록에는 넣지 않음, --policy bondOn,bondOff) */
export const EXTRA_POLICIES: Record<string, Policy> = {
  noMerge,
  chainer,
  lazy,
  /** M8.11 편성 몰기 (보유 영웅을 한쪽 팀에) */
  dayHeavyTeam: makeMerger('dayHeavyTeam', (s) => heavyFormation(s, 'offense')),
  nightHeavyTeam: makeMerger('nightHeavyTeam', (s) => heavyFormation(s, 'defense')),
  bondOn: makeMerger('bondOn', bondOnFormation),
  bondOff: makeMerger('bondOff', bondOffFormation),
};

/** 스펙 이름 별칭 */
export const POLICY_ALIASES: Record<string, string> = {};
