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
  lane: {
    laneCap: number;
    abyssAdvanceSpeed: number;
    /** 방어 유닛 제한 이동 (§4.3.3, D-026): 방어선에서 나갈 수 있는 최대 거리. 0 = 기존 규칙 */
    defenseInterceptRange: number;
    /** 방어 유닛 이동 속도 (px/초) */
    defenseMoveSpeed: number;
    /** 유닛이 걱정 바로 아래 몇 px에 서는지 */
    defenseContact: number;
  };
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
    /** 보스 층 (§5.13-4): 이 값의 배수 층 */
    bossFloorEvery: number;
    bossFloorHpMult: number;
    bossFloorCounterMult: number;
    /** 보스 층 돌파 보상 와일드카드 수 */
    bossFloorWildcards: number;
  };
  /** 영웅 (§5.13-3): 빛나는 영웅의 hp·atk 배수 */
  hero: { shineMult: number };
  /** 자라는 날 (§5.14-4, D-030) */
  growth: {
    /** 양분으로 준 전설 하나당 성장치 */
    growthPerLegend: number;
    /** 기억(행복 1 + 정화 1 짝) 하나당 양쪽 성장치 보너스 */
    memoryBonus: number;
    /** 특성 스택당 hp·atk 배수 증가 */
    traitPerStack: number;
    traitMaxStacks: number;
    /** 자란 횟수만큼 걱정 HP × ageWorryMult^n */
    ageWorryMult: number;
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
  /** 챕터 진행 (§5.15-1, D-039): 1-1 ~ 1-length = 심연 1 ~ length층 */
  chapter: {
    length: number;
    /** 이 층을 정화하면 다음 dayStart에 자라기 + 갈림길 */
    turningPoint: number;
    /** 전환점 층 HP 배수 */
    turningPointHpMult: number;
    /** 이 일차 이야기 한 장 뒤에도 1-length를 못 넘었으면 미완성으로 끝 */
    maxDays: number;
  };
  days: {
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
  /** 자라기 문장 (§5.14-2, §5.15-4): 자라기가 이어지는 날 */
  growth: string[];
  forgottenDay: string;
}

/** 챕터 문구 (§5.15-2, chapter.json): 세계·갈림길·층 장면 이름 */
export interface Chapter {
  /** 이 챕터의 world 값 (체인·이벤트의 world와 같아야 함) */
  world: string;
  /** 1-turningPoint 정화 다음 dayStart에 나오는 갈림길 (events.milestones의 id) */
  crossroad: string;
  /** 1-length 보스 표시 이름 */
  bossName: string;
  /** 밤 층 장면 이름 (1-1 ~ 1-length) */
  sceneNames: string[];
  /** 낮 배경 이름 (현재 층 번호의 것) */
  dayScenes: string[];
}

/** 챕터 완성 화면 (§5.15-5, chapter_complete.json). learnedRecipes는 표시만 (조합표에 추가하지 않음, D-043) */
export interface ChapterComplete {
  title: string;
  doneText: string;
  notDoneText: string;
  learnedRecipes: { id: string; name: string; side: 'day' | 'night' }[];
}

/** 조합표 (§5.13-5) */
export interface RecipeInput {
  chain: string;
  tier: number;
  /** true = 빛나는 영웅만 / false = 빛나지 않아야 함 / 생략 = 무관 (§5.14-1) */
  shining?: boolean;
}

/** 전설의 두 종류 (§5.14-1): 행복한 추억(빛나지 않은 영웅) / 정화된 추억(빛나는 영웅) */
export type LegendKind = 'happy' | 'purified';

export interface Recipe {
  id: string;
  name: string;
  kind: LegendKind;
  inputs: [RecipeInput, RecipeInput];
  legend: CombatStats;
}

export interface Recipes {
  recipes: Recipe[];
}

export interface GameData {
  balance: Balance;
  units: Units;
  chains: Chain[];
  monsters: Monsters;
  events: Events;
  days: Days;
  diary: Diary;
  chapter: Chapter;
  chapterComplete: ChapterComplete;
  recipes: Recipes;
}
