// 한 판(챕터) 누적 stats (저장·시뮬·metrics). Phaser 의존 없음.

export interface GameStats {
  /** 처치 수 (낮 + 밤) */
  worriesDefeated: number;
  totalJoyEarned: number;
  /** 밤에 거점에 닿은 적 수 (핵 HP 감소) */
  sunkCount: number;
  /** 낮 병사 쓰러짐 */
  offenseSoldierDeaths: number;
  wildcardsGained: number;
  // ── 스테이지·시도 (§5.19-6) ──
  attempts: number;
  /** 낮 실패: 가는 길 시간 초과 / 가는 길 쓰러짐 / 돌아오는 길 시간 초과 */
  dayFailTime: number;
  dayFailFall: number;
  returnFails: number;
  /** 밤 실패 (핵 HP 0) */
  nightFails: number;
  /** guardian 처치 (핵 획득) */
  guardiansDown: number;
  /** 핵 떨어뜨림 / 적이 되가져감 */
  coreDrops: number;
  coreReturns: number;
  /** 핵을 든 시간 합 */
  carrySeconds: number;
  // ── v0.13 영웅·먹이기·버프 (§5.17) ──
  feeds: number;
  battleMerges: number;
  /** 때 맞춤 머지 ([11]-2) */
  affinityMerges: number;
  /** 낮 영웅 쓰러짐 (가는 길 + 운반 중) */
  offenseFalls: number;
  defenseFalls: number;
  /** 떡 버프로 회복한 hp 합 */
  buffHeal: number;
  /** 기세 중첩 × 초 (평균 중첩 = momentumStackSeconds / battleSeconds) */
  momentumStackSeconds: number;
  /** 전투 시간 (낮 + 밤 웨이브 진행) */
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
  'offenseSoldierDeaths',
  'wildcardsGained',
  'attempts',
  'dayFailTime',
  'dayFailFall',
  'returnFails',
  'nightFails',
  'guardiansDown',
  'coreDrops',
  'coreReturns',
  'carrySeconds',
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
