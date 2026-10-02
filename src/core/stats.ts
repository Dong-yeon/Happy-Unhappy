// 한 판(챕터) 누적 stats (저장·시뮬·metrics). Phaser 의존 없음.

export interface GameStats {
  worriesDefeated: number;
  totalJoyEarned: number;
  /** 가라앉은 걱정 수 (역류 보스 제외: 보스 가라앉음은 일반 규칙을 따르지 않는다) */
  sunkCount: number;
  layersCleared: number;
  /** 층 돌파로 실제로 줄어든 그림자 합 */
  shadowPurified: number;
  /** 역류 보스 처치로 줄어든 그림자 합 */
  shadowCalmed: number;
  backflows: number;
  bossWins: number;
  bossLosses: number;
  /** 낮 영웅이 쓰러져 건너뛴 시간 누적(초) */
  stallSeconds: number;
  /** 오펜스 병사 쓰러짐 */
  abyssDeaths: number;
  bossFloorsReached: number;
  bossFloorsCleared: number;
  wildcardsGained: number;
  // ── 챕터 진행 (§5.15-6) ──
  /** 1-turningPoint에 도달한 일차 (그 전 층을 돌파한 날, 0 = 아직) */
  turningPointReachedDay: number;
  /** 1-turningPoint를 정화한 일차 (0 = 아직) */
  turningPointClearedDay: number;
  // ── v0.13 영웅·먹이기·버프 (§5.17) ──
  feeds: number;
  battleMerges: number;
  /** 때 맞춤 머지 ([11]-2) */
  affinityMerges: number;
  offenseFalls: number;
  defenseFalls: number;
  /** 떡 버프로 회복한 hp 합 */
  buffHeal: number;
  /** 기세 중첩 × 초 (평균 중첩 = momentumStackSeconds / battleSeconds) */
  momentumStackSeconds: number;
  /** 전투 시간 (낮 오펜스 + 밤 웨이브 진행) */
  battleSeconds: number;
  // ── 병사 ([11]-1·4) ──
  soldiersSpawned: number;
  /** 상한으로 병사 없이 버프만 */
  soldiersCapped: number;
  /** 우리 편이 준 피해: 영웅 / 병사 / 거점(Happy) */
  damageHero: number;
  damageSoldier: number;
  damageBase: number;
  /** 체인별 머지로 3단계가 된 횟수 */
  tier3ByChain: Record<string, number>;
  /** 병사 출전 수: key = "<체인>:<단>" */
  soldiersByKind: Record<string, number>;
}

/** 숫자 필드 (저장 검증) */
export type NumericStatKey = Exclude<keyof GameStats, 'tier3ByChain' | 'soldiersByKind'>;

export const GAME_STATS_KEYS: readonly NumericStatKey[] = [
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
  'bossFloorsReached',
  'bossFloorsCleared',
  'wildcardsGained',
  'turningPointReachedDay',
  'turningPointClearedDay',
  'feeds',
  'battleMerges',
  'affinityMerges',
  'offenseFalls',
  'defenseFalls',
  'buffHeal',
  'momentumStackSeconds',
  'battleSeconds',
  'soldiersSpawned',
  'soldiersCapped',
  'damageHero',
  'damageSoldier',
  'damageBase',
];

export function emptyGameStats(): GameStats {
  const s = { tier3ByChain: {}, soldiersByKind: {} } as unknown as GameStats;
  for (const k of GAME_STATS_KEYS) s[k] = 0;
  return s;
}
