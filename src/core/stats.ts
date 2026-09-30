// 일생 누적 stats (결말 판정·저장·시뮬). Phaser 의존 없음.

export interface GameStats {
  sentUpTierSum: number;
  sentDownTierSum: number;
  worriesDefeated: number;
  totalJoyEarned: number;
  /** 가라앉은 걱정 수 (역류 보스 제외: 보스 가라앉음은 일반 규칙을 따르지 않는다) */
  sunkCount: number;
  layersCleared: number;
  /** 층 돌파로 실제로 줄어든 그림자 합 (결말 점수, v0.6 D-023) */
  shadowPurified: number;
  /** 역류 보스 처치로 줄어든 그림자 합 (점수 없음, v0.6 D-023) */
  shadowCalmed: number;
  backflows: number;
  bossWins: number;
  bossLosses: number;
  /** Unhappy 멈춤 누적 시간(초) */
  stallSeconds: number;
  /** 심연 유닛 사망 수 */
  abyssDeaths: number;
}

export const GAME_STATS_KEYS: readonly (keyof GameStats)[] = [
  'sentUpTierSum',
  'sentDownTierSum',
  'worriesDefeated',
  'totalJoyEarned',
  'sunkCount',
  'layersCleared',
  'shadowPurified',
  'shadowCalmed',
  'backflows',
  'bossWins',
  'bossLosses',
  'stallSeconds',
  'abyssDeaths',
];

export function emptyGameStats(): GameStats {
  const s = {} as GameStats;
  for (const k of GAME_STATS_KEYS) s[k] = 0;
  return s;
}
