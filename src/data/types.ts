// src/data/*.json 의 타입. 검증(validate.ts)을 통과한 뒤에만 이 타입으로 취급한다.

export interface CombatStats {
  hp: number;
  atk: number;
  atkInterval: number;
  range: number;
}

export interface Balance {
  version: 2;
  start: { joy: number; shadow: number };
  grid: {
    gridCols: number;
    gridRows: number;
    gridPresets: [number, number][];
    spawnCostBase: number;
    spawnCostStep: number;
    maxTier: number;
    releaseRefund: number;
    returnQueueCap: number;
  };
  lane: { laneCap: number; abyssAdvanceSpeed: number };
  happy: { atk: number; atkInterval: number; range: number };
  wave: {
    wavesPerDay: number;
    countBase: number;
    countStep: number;
    spawnInterval: number;
    waveGap: number;
    /** 하루 첫 웨이브 전 대기(초) */
    dayStartDelay: number;
    /** 전날 저녁에 예약된 역류: 다음 날 아침 보스 전 준비 시간(초) (D-021) */
    bossPrepSeconds: number;
    hpGrowthPerDay: number;
  };
  abyss: {
    layerHpBase: number;
    layerHpGrowth: number;
    counterAtk: number;
    counterAtkInterval: number;
    /** 벽 반격 사거리 (벽 아래 변에서의 y 거리, px) */
    counterRange: number;
    abyssDeathShadow: number;
    layerClearShadowReduce: number;
  };
  /** 밤 (§5.11-7, D-027) */
  night: {
    /** 밤 길이(초, 달이 질 때까지) */
    nightSeconds: number;
    /** 밤 동안 심연 유닛 0기이면 그림자 + 이 값 × dt (Unhappy 멈춤, 외면의 대가) */
    stallShadowPerSec: number;
  };
  shadow: {
    shadowMax: number;
    sinkShadow: number;
    sinkLayerHp: number;
    shadowAfterBossWin: number;
    shadowAfterBossLose: number;
    /** 마음 날씨 경계: [흐림, 비, 폭우]가 시작되는 그림자 값 (그 미만은 맑음) */
    weatherThresholds: [number, number, number];
  };
  days: {
    lifeLengthDays: number;
    dailyLimit: number;
    storeCap: number;
    /** 하루 시작(이벤트 효과 직후) 기쁨 바닥. 가산이 아니라 max (D-024) */
    morningJoyFloor: number;
  };
  diary: { diarySinkThreshold: number };
}

export interface Units {
  commonSpirit: (CombatStats & { tier: number })[];
}

export interface Chain {
  archetypeId: string;
  world: string;
  spawnWeight: number;
  color: string;
  tierNames: string[];
  hero: CombatStats;
}

export interface Monsters {
  worry: { name: string; hpBase: number; speed: number; atk: number; atkInterval: number; joyReward: number };
  backflowBoss: {
    name: string;
    hp: number;
    speed: number;
    atk: number;
    atkInterval: number;
    joyReward: number;
    joyPenalty: number;
    sinkLayerHp: number;
    /** 보스 HP = hp × hpGrowthPerDay^(일차-1). M4 무한 웨이브에서는 1일차 취급 */
    hpGrowthPerDay: number;
  };
}

export type Flag = 'avoid' | 'face';

export interface EventEffects {
  joy?: number;
  shadow?: number;
  freePieces?: { chain: string; tier: number }[];
  worryMultiplier?: number;
  chainWeight?: Record<string, number>;
}

export interface MilestoneChoice {
  id: string;
  label: string;
  flag: Flag;
  joy: number;
  shadow: number;
  /** 그날 심연 층 HP 감소 비율 (0~1). 0.3 = 30% 감소 */
  faceLayerHpReduce?: number;
  bonusReturnPiece?: boolean;
}

export interface Milestone {
  id: string;
  world: string;
  archetypeId: string;
  title: string;
  text: string;
  choices: MilestoneChoice[];
  diaryLine: string;
}

export interface SeasonalEvent {
  id: string;
  world: string;
  archetypeId: string;
  title: string;
  text: string;
  effects: EventEffects;
  diaryLine: string;
}

export interface DailyEvent {
  id: string;
  world: string;
  title: string;
  effects: EventEffects;
  diaryLine: string;
}

export interface Events {
  milestones: Milestone[];
  seasonal: SeasonalEvent[];
  daily: DailyEvent[];
  plainDay: { title: string; diaryLines: string[] };
}

export interface Days {
  world: string;
  age: number;
  fixed: Record<string, string>;
  dailyEventChance: number;
  dailyEventCooldownDays: number;
  /** 1 ~ quietDays일차는 고정 이벤트 외에 일상 이벤트 없음 (D-024) */
  quietDays: number;
}

export interface Diary {
  /** 낮 결과 문장 (층 돌파 계열은 v0.8에서 night로 이동) */
  result: { backflow: string[]; manySunk: string[]; default: string[] };
  /** 밤 문장 (§5.11-6) */
  night: { layerCleared: string[]; tried: string[]; none: string[] };
  forgottenDay: string;
}

export type EndingId = 'hidden' | 'solid' | 'mask' | 'quiet' | 'rainy';

export interface Endings {
  /** wSunk: Happy 점수 감점 (가라앉은 걱정 1마리당, D-024) */
  weights: { wUpTier: number; wDefeat: number; wJoy: number; wSunk: number; wDownTier: number; wLayer: number; wPurified: number };
  /** Tʜ·Tᴜ (v0.6, D-023) */
  thresholds: { happy: number; unhappy: number };
  /** 히든 균형: |happy − unhappy| ≤ balanceRatio × max(happy, unhappy) */
  balanceRatio: number;
  endings: Record<EndingId, { name: string; title: string; desc: string }>;
}

export interface GameData {
  balance: Balance;
  units: Units;
  chains: Chain[];
  monsters: Monsters;
  events: Events;
  days: Days;
  diary: Diary;
  endings: Endings;
}
