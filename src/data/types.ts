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
    unhappyStallShadowPerSec: number;
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
  days: { lifeLengthDays: number; dailyLimit: number; storeCap: number };
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
}

export interface Diary {
  result: { backflow: string[]; layerCleared: string[]; manySunk: string[]; default: string[] };
  forgottenDay: string;
}

export type EndingId = 'hidden' | 'solid' | 'mask' | 'quiet' | 'rainy';

export interface Endings {
  weights: { wUpTier: number; wDefeat: number; wJoy: number; wDownTier: number; wLayer: number; wPurified: number };
  threshold: number;
  balanceGap: number;
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
