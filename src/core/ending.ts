// 결말 판정 (스펙 §5.14-3, D-030 — §5.6 대체). 순수 함수, Phaser 의존 없음. 임계값은 endings.json.
// "얼마나 많은 추억을 양분으로 줬는가": 행복한 추억과 정화된 추억은 같은 무게. 처치 수 등 플레이 결과는 직접 넣지 않는다.
//   total = growth.happy + growth.unhappy,  share = growth.happy / total (total 0이면 0.5)
// 위에서부터 첫 번째:
//   1. 자라기 갈래가 모두 together + memories ≥ hiddenMinMemories → hidden (화해)
//   2. total < totalThreshold → rainy (양분이 적었다)
//   3. shareBand[0] ≤ share ≤ shareBand[1] → solid
//   4. share > shareBand[1] → mask / share < shareBand[0] → quiet

import type { EndingId, Endings } from '../data/types';
import { emptyGrowth, type Branch, type GrowthState } from './growth';

/** 결과 화면·리포트용 숫자 (기존 저장·metrics의 breakdown 자리) */
export type BreakdownKey = 'happyLegends' | 'purifiedLegends' | 'memories';
export const BREAKDOWN_KEYS: readonly BreakdownKey[] = ['happyLegends', 'purifiedLegends', 'memories'];

export interface EndingResult {
  id: EndingId;
  /** growth.happy (행복한 추억 쪽 성장치) */
  happy: number;
  /** growth.unhappy (정화된 추억 쪽 성장치) */
  unhappy: number;
  total: number;
  share: number;
  branches: Branch[];
  /** 준 전설 수(행복/정화)·기억 수 */
  breakdown: Record<BreakdownKey, number>;
}

export function judgeEnding(growth: GrowthState, cfg: Endings): EndingResult {
  const total = growth.happy + growth.unhappy;
  const share = total > 0 ? growth.happy / total : 0.5;
  const [lo, hi] = cfg.shareBand;
  let id: EndingId;
  if (growth.branches.length > 0 && growth.branches.every((b) => b === 'together') && growth.memories >= cfg.hiddenMinMemories) id = 'hidden';
  else if (total < cfg.totalThreshold) id = 'rainy';
  else if (share >= lo && share <= hi) id = 'solid';
  else if (share > hi) id = 'mask';
  else id = 'quiet';
  return {
    id,
    happy: growth.happy,
    unhappy: growth.unhappy,
    total,
    share,
    branches: [...growth.branches],
    breakdown: { happyLegends: growth.given.happy, purifiedLegends: growth.given.purified, memories: growth.memories },
  };
}

/** 결말 5종에 각각 도달하는 growth (테스트·디버그 결말 미리보기용) */
export function endingFixtures(cfg: Endings): Record<EndingId, GrowthState> {
  const t = cfg.totalThreshold;
  const [lo, hi] = cfg.shareBand;
  const make = (happy: number, unhappy: number, branches: Branch[], memories = 0): GrowthState => ({
    ...emptyGrowth(),
    happy,
    unhappy,
    memories,
    branches,
    given: { happy: Math.round(happy / 100), purified: Math.round(unhappy / 100) },
  });
  const big = Math.max(t, 1) * 2;
  const mid = (lo + hi) / 2;
  return {
    hidden: make(big * mid, big * (1 - mid), ['together', 'together', 'together'], cfg.hiddenMinMemories),
    solid: make(big * mid, big * (1 - mid), ['together', 'happy', 'together']),
    mask: make(big * Math.min(1, hi + (1 - hi) / 2), big * (1 - Math.min(1, hi + (1 - hi) / 2)), ['happy', 'happy', 'happy']),
    quiet: make(big * (lo / 2), big * (1 - lo / 2), ['unhappy', 'unhappy', 'unhappy']),
    rainy: make(0, 0, ['slow', 'slow', 'slow']),
  };
}
