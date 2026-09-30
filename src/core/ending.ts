// 결말 판정 (스펙 §5.6, §5.8-3). 순수 함수, Phaser 의존 없음. 가중치·임계값은 endings.json.
//   happyScore   = sentUpTierSum × wUpTier + worriesDefeated × wDefeat + totalJoyEarned × wJoy
//   unhappyScore = sentDownTierSum × wDownTier + layersCleared × wLayer + shadowPurified × wPurified
// shadowPurified는 층 돌파분만 (보스 승리 감소분 shadowCalmed는 점수 없음, D-023).

import type { EndingId, Endings } from '../data/types';
import { emptyGameStats, type GameStats } from './stats';

export type BreakdownKey = 'upTier' | 'defeat' | 'joy' | 'downTier' | 'layer' | 'purified';

export interface EndingResult {
  id: EndingId;
  happy: number;
  unhappy: number;
  /** 항목별 기여 (가중치 곱한 값) */
  breakdown: Record<BreakdownKey, number>;
}

/** 점수 항목: [breakdown 키, stats 키, 가중치 키, 쪽] */
const TERMS = [
  ['upTier', 'sentUpTierSum', 'wUpTier', 'happy'],
  ['defeat', 'worriesDefeated', 'wDefeat', 'happy'],
  ['joy', 'totalJoyEarned', 'wJoy', 'happy'],
  ['downTier', 'sentDownTierSum', 'wDownTier', 'unhappy'],
  ['layer', 'layersCleared', 'wLayer', 'unhappy'],
  ['purified', 'shadowPurified', 'wPurified', 'unhappy'],
] as const satisfies readonly (readonly [BreakdownKey, keyof GameStats, keyof Endings['weights'], 'happy' | 'unhappy'])[];

export const BREAKDOWN_KEYS: readonly BreakdownKey[] = TERMS.map((t) => t[0]);

/**
 * 위에서부터 첫 번째 일치:
 * hidden: happy ≥ Tʜ, unhappy ≥ Tᴜ, |happy − unhappy| ≤ balanceRatio × max(happy, unhappy), flag face
 * solid: 둘 다 임계값 이상 / mask: happy만 / quiet: unhappy만 / rainy: 둘 다 미달
 */
export function judgeEnding(stats: GameStats, flags: readonly string[], cfg: Endings): EndingResult {
  const breakdown = {} as Record<BreakdownKey, number>;
  let happy = 0;
  let unhappy = 0;
  for (const [key, stat, weight, side] of TERMS) {
    const v = stats[stat] * cfg.weights[weight];
    breakdown[key] = v;
    if (side === 'happy') happy += v;
    else unhappy += v;
  }
  const hOk = happy >= cfg.thresholds.happy;
  const uOk = unhappy >= cfg.thresholds.unhappy;
  let id: EndingId;
  if (hOk && uOk) {
    const balanced = Math.abs(happy - unhappy) <= cfg.balanceRatio * Math.max(happy, unhappy);
    id = balanced && flags.includes('face') ? 'hidden' : 'solid';
  } else if (hOk) id = 'mask';
  else if (uOk) id = 'quiet';
  else id = 'rainy';
  return { id, happy, unhappy, breakdown };
}

/** 한쪽 점수를 target으로 맞추는 stats (그 쪽에서 가중치가 가장 큰 항목 하나만 사용) */
function setScore(s: GameStats, cfg: Endings, side: 'happy' | 'unhappy', target: number): void {
  const terms = TERMS.filter((t) => t[3] === side);
  const best = terms.reduce((a, b) => (cfg.weights[b[2]] > cfg.weights[a[2]] ? b : a));
  const w = cfg.weights[best[2]];
  if (w > 0) s[best[1]] = target / w;
}

/** 결말 5종에 각각 도달하는 stats·flags (테스트·디버그 결말 미리보기용) */
export function endingFixtures(cfg: Endings): Record<EndingId, { stats: GameStats; flags: string[] }> {
  const x = Math.max(cfg.thresholds.happy, cfg.thresholds.unhappy) * 1.2 + 10;
  const make = (h: number, u: number, flags: string[]) => {
    const stats = emptyGameStats();
    setScore(stats, cfg, 'happy', h);
    setScore(stats, cfg, 'unhappy', u);
    return { stats, flags };
  };
  return {
    hidden: make(x, x, ['face']),
    solid: make(x * 1.5, x, ['avoid']),
    mask: make(x, 0, ['avoid']),
    quiet: make(0, x, ['face']),
    rainy: make(0, 0, []),
  };
}
