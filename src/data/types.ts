// src/data/*.json 의 타입. 검증(validate.ts)을 통과한 뒤에만 이 타입으로 취급한다.

export interface CombatStats {
  hp: number;
  atk: number;
  atkInterval: number;
  range: number;
}

export interface Balance {
  version: 3;
  /** swapHeroes: true면 기본 배정(heroes.json offense/defense)을 맞바꾼다 (영웅 배정 기본값, [11]-3) */
  start: { joy: number; shadow: number; swapHeroes: boolean };
  grid: {
    gridCols: number;
    gridRows: number;
    gridPresets: [number, number][];
    spawnCostBase: number;
    spawnCostStep: number;
    maxTier: number;
    releaseRefund: number;
  };
  lane: {
    /** 오펜스: 영웅·병사가 층으로 전진하는 속도 */
    abyssAdvanceSpeed: number;
    /** 디펜스 영웅·병사 제한 이동 (§4.3.3, D-026): 방어선에서 나갈 수 있는 최대 거리. 0 = 이동 없음 */
    defenseInterceptRange: number;
    /** 방어 유닛 이동 속도 (px/초) */
    defenseMoveSpeed: number;
    /** 유닛이 걱정 바로 아래 몇 px에 서는지 */
    defenseContact: number;
  };
  happy: { atk: number; atkInterval: number; range: number };
  /** 밤(디펜스) 웨이브 (§5.17-10: 구 낮 웨이브) */
  wave: {
    wavesPerNight: number;
    countBase: number;
    countStep: number;
    spawnInterval: number;
    waveGap: number;
    /** 밤 첫 웨이브 전 대기(초) */
    dayStartDelay: number;
    /** 낮에 예약된 역류: 그날 밤 첫 웨이브(보스) 전 준비 시간(초) (D-021, §5.17-10) */
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
    /** 오펜스 병사가 쓰러질 때 그림자 */
    abyssDeathShadow: number;
    layerClearShadowReduce: number;
    /** 보스 층 (§5.13-4): 이 값의 배수 층 */
    bossFloorEvery: number;
    bossFloorHpMult: number;
    bossFloorCounterMult: number;
    /** 보스 층 돌파 보상 와일드카드 수 */
    bossFloorWildcards: number;
  };
  /** 영웅 공통 (§5.17-2·4·10) */
  hero: {
    /** 떡 성장 받는 피해 감소의 상한 */
    dmgReduceMax: number;
    /** 동아줄 성장 atkInterval 하한(초) */
    atkIntervalMin: number;
    /** 디펜스(밤) 영웅 쓰러짐 → 이 초 뒤 일어남 */
    reviveSeconds: number;
    /** 일어날 때 hp = maxHp × 이 값 */
    reviveHpRatio: number;
  };
  /** 먹이기 (§5.17-2): 단계별 점수 (index 0 = 1단계) */
  feed: { tierScore: number[] };
  /** 전투 중 머지 버프 (§5.17-3) */
  buff: {
    /** 떡: 즉시 회복 maxHp × healPct */
    healPct: number;
    /** 동아줄: 기세 1중첩당 atk +momentumAtkPct */
    momentumAtkPct: number;
    momentumSeconds: number;
    momentumMaxStacks: number;
    /** 결과 3단계 머지면 회복 × / 중첩 수 × */
    tier3Mult: number;
  };
  /** 전투 중 머지 병사 ([11]-1·2, D-049·D-050) */
  merge: {
    soldiers: boolean;
    /** 두 레인 합이 아니라 지금 싸우는 레인의 병사 수 상한 */
    soldierCap: number;
    /** 병사 수명(초) */
    soldierLifetime: number;
    /** 때 맞춤 (낮 sun 체인 / 밤 moon 체인) 병사 능력치·버프 배수 */
    affinityMult: number;
  };
  /** 낮 = 오펜스 (§5.17-10, 구 night 블록) */
  offense: {
    /** 낮 길이(초) */
    seconds: number;
    /** 오펜스 영웅이 쓰러져 낮이 끝나면 남은 초 × 이 값만큼 그림자 */
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
    /** 이 층을 정화하면 다음 dayStart에 갈림길 */
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

/** 시작 영웅 (§5.17-1, heroes.json) */
export interface HeroDef extends CombatStats {
  id: string;
  name: string;
}

export interface Heroes {
  heroes: HeroDef[];
  /** 기본 배정: 낮(오펜스) / 밤(디펜스) 영웅 id */
  offense: string;
  defense: string;
}

/** 먹이기 성장 (점수 1당, §5.17-2) */
export interface ChainGrowth {
  maxHp?: number;
  /** 받는 피해 감소 (비율) */
  dmgReduce?: number;
  atk?: number;
  /** atkInterval 감소 (비율) */
  atkIntervalPct?: number;
}

export interface SoldierLevel extends CombatStats {
  /** 올가미병: 맞힌 적 감속 비율·시간 */
  slow?: number;
  slowSeconds?: number;
}

export interface Chain {
  archetypeId: string;
  world: string;
  spawnWeight: number;
  color: string;
  tierNames: string[];
  /** 때 맞춤 ([11]-2): sun = 낮에 머지하면 강함 / moon = 밤 */
  side: 'sun' | 'moon';
  growth: ChainGrowth;
  /** 전투 중 머지 버프 (§5.17-3) */
  buff: 'heal' | 'momentum';
  /** 전투 중 머지 병사 ([11]-1): shield = 접촉한 적 정지·반격을 먼저 받음 / snare = 맞힌 적 감속 */
  soldier: { kind: 'shield' | 'snare'; name: string; levels: SoldierLevel[] };
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
  heroes: Heroes;
  chains: Chain[];
  monsters: Monsters;
  events: Events;
  days: Days;
  diary: Diary;
  chapter: Chapter;
  chapterComplete: ChapterComplete;
  recipes: Recipes;
}
