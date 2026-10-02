// 한 판(챕터) 누적 stats (저장·시뮬·metrics). Phaser 의존 없음.

export interface GameStats {
  /** 처치 수 (낮 + 밤) */
  worriesDefeated: number;
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
  // ── 팀 릴레이·스킬·5단계 (§5.20) ──
  /** 팀 교대 수: 낮(전멸 → 다음 팀) / 밤(구간 교대·전멸) */
  teamSwapsDay: number;
  teamSwapsNight: number;
  /** 5단계가 만들어진 머지 수 / 특별 버프 발동 수 */
  tier5Made: number;
  specials: number;
  /** 스킬이 준 피해 */
  damageSkill: number;
  // ── 버프 (§5.17) ──
  battleMerges: number;
  /** 때 맞춤 머지 ([11]-2) */
  affinityMerges: number;
  /** 낮 영웅 쓰러짐 (그 낮 동안 안 일어남) */
  offenseFalls: number;
  defenseFalls: number;
  /** 떡 버프로 회복한 hp 합 */
  buffHeal: number;
  /** 기세 중첩 × 초 (평균 중첩 = momentumStackSeconds / battleSeconds) */
  momentumStackSeconds: number;
  /** 전투 시간 (낮 + 밤 웨이브 진행) */
  battleSeconds: number;
  // ── 조각이 생기는 길 (§5.20-13) ──
  /** 저절로 / 처치 드롭(보스·guardian 확정 포함) 으로 그리드에 들어온 조각 */
  piecesAuto: number;
  piecesDropped: number;
  /** 그리드가 가득이라 버려진 조각 (저절로 + 드롭) */
  piecesDiscarded: number;
  /** 전투 중 그리드에 빈칸이 없던 시간(초). 가득 참 비율 = gridFullSeconds / battleSeconds */
  gridFullSeconds: number;
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
  /** 영웅별 스킬 발동 수 */
  skillCasts: Record<string, number>;
  /** 체인별 생성 조각 수 */
  chainSpawns: Record<string, number>;
}

/** 숫자 필드 (저장 검증) */
export type RecordStatKey = 'tier3ByChain' | 'soldiersByKind' | 'skillCasts' | 'chainSpawns';
export const RECORD_STATS_KEYS: readonly RecordStatKey[] = ['tier3ByChain', 'soldiersByKind', 'skillCasts', 'chainSpawns'];
export type NumericStatKey = Exclude<keyof GameStats, RecordStatKey>;

export const GAME_STATS_KEYS: readonly NumericStatKey[] = [
  'worriesDefeated',
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
  'teamSwapsDay',
  'teamSwapsNight',
  'tier5Made',
  'specials',
  'damageSkill',
  'battleMerges',
  'affinityMerges',
  'offenseFalls',
  'defenseFalls',
  'buffHeal',
  'momentumStackSeconds',
  'battleSeconds',
  'piecesAuto',
  'piecesDropped',
  'piecesDiscarded',
  'gridFullSeconds',
  'soldiersSpawned',
  'soldiersCapped',
  'damageHero',
  'damageSoldier',
  'damageBase',
];

export function emptyGameStats(): GameStats {
  const s = { tier3ByChain: {}, soldiersByKind: {}, skillCasts: {}, chainSpawns: {} } as unknown as GameStats;
  for (const k of GAME_STATS_KEYS) s[k] = 0;
  return s;
}
