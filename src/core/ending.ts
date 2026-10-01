// 결말 판정 (스펙 §5.6, §5.8-3). 순수 함수, Phaser 의존 없음. 가중치·임계값은 endings.json.
//   happyScore   = max(0, sentUpTierSum × wUpTier + worriesDefeated × wDefeat + totalJoyEarned × wJoy − sunkCount × wSunk)
//   unhappyScore = max(0, sentDownTierSum × wDownTier + layersCleared × wLayer + shadowPurified × wPurified)
// shadowPurified는 층 돌파분만 (보스 승리 감소분 shadowCalmed는 점수 없음, D-023). wSunk 감점·0 하한은 D-024.

import type { EndingId, Endings } from '../data/types';
import { emptyGameStats, type GameStats } from './stats';

export type BreakdownKey = 'upTier' | 'defeat' | 'joy' | 'sunk' | 'downTier' | 'layer' | 'purified';

export interface EndingResult {
  id: EndingId;
  happy: number;
  unhappy: number;
  /** 항목별 기여 (가중치 곱한 값. sunk는 감점이라 음수, 0 하한 적용 전) */
  breakdown: Record<BreakdownKey, number>;
}

/** 점수 항목: [breakdown 키, stats 키, 가중치 키, 쪽, 부호] */
const TERMS = [
  ['upTier', 'sentUpTierSum', 'wUpTier', 'happy', 1],
  ['defeat', 'worriesDefeated', 'wDefeat', 'happy', 1],
  ['joy', 'totalJoyEarned', 'wJoy', 'happy', 1],
  ['sunk', 'sunkCount', 'wSunk', 'happy', -1],
  ['downTier', 'sentDownTierSum', 'wDownTier', 'unhappy', 1],
  ['layer', 'layersCleared', 'wLayer', 'unhappy', 1],
  ['purified', 'shadowPurified', 'wPurified', 'unhappy', 1],
] as const satisfies readonly (readonly [BreakdownKey, keyof GameStats, keyof Endings['weights'], 'happy' | 'unhappy', 1 | -1])[];

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
  for (const [key, stat, weight, side, sign] of TERMS) {
    const v = sign * stats[stat] * cfg.weights[weight];
    breakdown[key] = v;
    if (side === 'happy') happy += v;
    else unhappy += v;
  }
  // 두 점수는 0 미만이면 0 (표시·판정 모두, D-024)
  happy = Math.max(0, happy);
  unhappy = Math.max(0, unhappy);
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

/** 한쪽 점수를 target으로 맞추는 stats (그 쪽의 가산 항목 중 가중치가 가장 큰 것 하나만 사용, 감점 0) */
function setScore(s: GameStats, cfg: Endings, side: 'happy' | 'unhappy', target: number): void {
  const terms = TERMS.filter((t) => t[3] === side && t[4] > 0);
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
