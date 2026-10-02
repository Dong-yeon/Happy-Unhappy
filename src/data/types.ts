// src/data/*.json 의 타입. 검증(validate.ts)을 통과한 뒤에만 이 타입으로 취급한다.

export interface CombatStats {
  hp: number;
  atk: number;
  atkInterval: number;
  range: number;
}

export interface Balance {
  version: 4;
  /** swapHeroes: true면 기본 배정(heroes.json offense/defense)을 맞바꾼다 (영웅 배정 기본값, [11]-3) */
  start: { joy: number; swapHeroes: boolean };
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
    /** 낮(오펜스): 영웅·병사 이동 속도 (가는 길·돌아오는 길, px/초) */
    abyssAdvanceSpeed: number;
    /** 디펜스 영웅·병사 제한 이동 (§4.3.3, D-026): 방어선에서 나갈 수 있는 최대 거리. 0 = 이동 없음. 낮 호위(운반자 뒤)도 같은 값 */
    defenseInterceptRange: number;
    /** 방어·호위 유닛 이동 속도 (px/초) */
    defenseMoveSpeed: number;
    /** 유닛이 적 바로 앞 몇 px에 서는지 */
    defenseContact: number;
  };
  happy: { atk: number; atkInterval: number; range: number };
  /** 밤(디펜스) 웨이브 진행 (구성은 stages.json night, §5.19-3-5) */
  wave: {
    spawnInterval: number;
    waveGap: number;
    /** 밤 첫 웨이브 전 대기(초) */
    nightStartDelay: number;
  };
  /** 적 공통: HP = base.hp × hpMult × hpGrowthPerStage^(스테이지-1) (낮·밤 모두) */
  enemy: { hpGrowthPerStage: number };
  /** 낮: 핵을 쥔 그림자 (§5.19-2, 구 심연 층 1개). HP는 stages.json */
  guardian: {
    counterAtk: number;
    counterAtkInterval: number;
    /** 반격 사거리 (guardian 자리에서의 진행 축 거리, px) */
    counterRange: number;
    /** 보스 스테이지(1-5·1-10) guardian 반격 배수 */
    bossCounterMult: number;
    /** 보스 스테이지 핵을 가져왔을 때 와일드카드 수 */
    bossWildcards: number;
  };
  /** 핵 운반 (§5.19-2) */
  carry: {
    /** 운반자 이동 속도 배수 */
    speedMult: number;
    /** 운반자 공격 간격 배수 */
    atkIntervalMult: number;
    /** 추격 무리 등장 간격(초) */
    chaseInterval: number;
    /** 영웅이 떨어진 핵을 줍는 거리 (적이 닿는 거리도 같음, px) */
    pickupRange: number;
  };
  /** 밤: 핵 HP (§5.19-3) */
  core: { hp: number; sinkDamage: number; bossSinkDamage: number };
  /** 영웅 공통 (§5.17-2·4·10) */
  hero: {
    /** 떡 성장 받는 피해 감소의 상한 */
    dmgReduceMax: number;
    /** 동아줄 성장 atkInterval 하한(초) */
    atkIntervalMin: number;
    /** 쓰러짐 → 이 초 뒤 일어남 (밤 영웅, 낮 운반 중 영웅) */
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
  /** 낮 = 오펜스: 해가 지기까지(초). 왕복이라 v0.15에서 늘림 */
  offense: { seconds: number };
  /** 챕터 진행 (§5.19-1): 1-1 ~ 1-length 스테이지 */
  chapter: {
    length: number;
    /** 이 스테이지를 성공하면 다음 dayStart에 갈림길 */
    turningPoint: number;
  };
  days: {
    /** 스테이지 시작(장면 카드를 닫을 때) 기쁨 바닥. 가산이 아니라 max (D-024) */
    morningJoyFloor: number;
  };
}

/** 영웅 (§5.17-1, §5.19-9, heroes.json): 시작 모험대(삽살·해태) + 챕터 완성 보상 영웅(reward) */
export interface HeroDef extends CombatStats {
  id: string;
  name: string;
  /** 챕터 완성 보상 영웅 (예: "ch01" = 1챕터 완성 시 합류, D-057). 없으면 시작 모험대 */
  reward?: string;
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

/** 적 공통 능력치 (§5.19-5): 종류별 배수를 곱한다 */
export interface EnemyBase {
  hp: number;
  speed: number;
  atk: number;
  atkInterval: number;
  joyReward: number;
}

export interface EnemyDef {
  id: string;
  name: string;
  hpMult: number;
  speedMult: number;
  atkMult: number;
}

export interface Monsters {
  base: EnemyBase;
  enemies: EnemyDef[];
}

/** stages.json 적 묶음 */
export interface EnemyGroup {
  type: string;
  count: number;
}

/** 1챕터 스테이지 하나 (§5.19-4): 이야기 문구 + 낮(핵 찾아 돌아오기) + 밤(핵 지키기) */
export interface StageDef {
  stage: number;
  title: string;
  /** dayStart 장면 카드 여는 글 */
  intro: string;
  coreName: string;
  /** 핵 카드 한 줄 (없으면 이름만) */
  coreText?: string;
  /** 아침 이야기 한 장 */
  page: string;
  /** 실패 뒤 다시 도전할 때 장면 카드 */
  retryIntro: string;
  day: {
    /** 핵을 쥔 그림자 종류 (monsters.enemies id, 표시 이름) */
    guardian: string;
    guardianHp: number;
    /** 보스 스테이지: guardian 반격 × bossCounterMult, 핵을 가져오면 와일드카드 */
    boss?: boolean;
    /** 가는 길 무리 */
    enemies: EnemyGroup[];
    /** 돌아오는 길 추격 무리 */
    chase: EnemyGroup[];
  };
  night: {
    /** 웨이브마다 적 묶음. 비면 밤 없음 (1-10) */
    waves: EnemyGroup[][];
    /** 마지막에 오는 보스 웨이브 (핵 피해 bossSinkDamage) */
    bossWave?: EnemyGroup[];
  };
}

export interface Stages {
  stages: StageDef[];
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
  /** 다음 스테이지 첫 시도의 guardian HP 감소 비율 (0~1). 0.3 = 30% 감소 */
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

/** 챕터 문구 (§5.15-2, chapter.json): 세계·갈림길. 스테이지 이름은 stages.json title */
export interface Chapter {
  /** 챕터 id (heroes.json reward와 짝: 완성하면 그 보상 영웅이 합류, D-057) */
  id: string;
  /** 이 챕터의 world 값 (체인·이벤트의 world와 같아야 함) */
  world: string;
  /** 1-turningPoint 성공 다음 dayStart에 나오는 갈림길 (events.milestones의 id) */
  crossroad: string;
  /** 1-length 보스 표시 이름 */
  bossName: string;
}

/** 챕터 완성 화면 (§5.15-5, chapter_complete.json). learnedRecipes는 표시만 (조합표에 추가하지 않음, D-043) */
export interface ChapterComplete {
  title: string;
  doneText: string;
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
  stages: Stages;
  chapter: Chapter;
  chapterComplete: ChapterComplete;
  recipes: Recipes;
}
