// 한 판(1챕터)의 core 상태: 스테이지 진행, 누적 게임 시간, 조각 id, 그리드, 두 레인, 밤 웨이브, 핵, 영웅·편성, 이야기책.
// Phaser 의존 없음. scene은 이 객체의 메서드를 호출하고 결과를 표시만 한다.
// 시간은 고정 틱(FIXED_DT)으로만, 그리고 낮(오펜스)·밤(디펜스)에만 흐른다.
//
// v0.15 (§5.19, D-053~D-057): 스테이지 = 장면 카드 → 낮(핵 찾아 돌아오기) → 해질녘 → 밤(핵 지키기) → 이야기 한 장 → 다음 스테이지.
//   실패하면 같은 스테이지를 낮부터 (횟수 제한 없음), 실패해도 영웅 성장·그리드는 남는다.
// v0.16 (§5.20, D-058~D-063):
//   편성 = 낮 공격대·밤 수비대 각 1~5팀 × 최대 3인. 레인에는 한 번에 한 팀 (팀 릴레이: 낮 = 전멸하면 다음 팀이 같은 핵 이어받기,
//   밤 = 웨이브 구간 교대·전멸하면 다음 팀). 편성이 전투 중에 바뀌면 단계 시작 스냅샷으로 되돌려 다시.
//   그리드에는 지금 레인 팀 영웅들의 체인만 나온다. 머지 5단계, 자기 체인 머지 = 스킬 게이지, 5단계 = 즉시 발동 + 특별 버프.
//   인연 4종(bonds.json), 경험치 → 레벨(임시). 먹이기·영웅 슬롯·배정 팝업·1-5 갈림길 삭제.
//   전투 중 머지 → 지금 싸우는 팀 버프(회복 / 기세) + 병사 자동 출전 (때 맞춤이면 × affinityMult).
// §5.20-13 (D-064): 기쁨·[조각 생성] 삭제 → 조각은 전투 중 spawn.autoInterval마다 저절로 + 처치 시 killDropChance로 드롭
//   (밤 보스·guardian은 bossDropTier단계 bossDropCount개 확정). 그리드가 가득이면 버림. 적은 × swarm.countMult 떼(한 마리 hp × hpMult),
//   레인 동시 적 최대 laneMaxEnemies (넘으면 대기열). 스킬은 autoSkill(기본)이면 게이지가 차는 즉시, 끄면 castReady(영웅)로 발동.
// v0.18 (§5.22, D-060·D-066·D-067): 영웅 성장 — 레벨(경험치 + 잉크 붓기), 성급(별가루 진급, ★은 고유 스킬만 강화), 낮·밤 적성 배율,
//   배우는 칸(Lv·★ 해금)에 비법서 장착(시작형 = 팀이 레인에 나갈 때, 상시형 = 단계마다 1회 버팀), 잉크(실제 시간 누적 + 첫 클리어 보상),
//   챕터 완성 뒤 다시 읽기(그 장 하나, 난이도 × replay.difficultyMult, 성공 시 잉크), 장별 흠집 없음 → 숨은 비법서.
//   실제 시각은 core가 읽지 않는다: scene·시뮬이 accrueInk(지금 ms)를 부른다.

import type { BookSkill, CombatStats, EnemyGroup, GameData, HeroDef, SkillDef, StageDef } from '../data/types';
import { emptyAttemptStats, type AttemptResult, type AttemptStats, type DayPhase, type FailReason } from './day';
import { Expedition, type EnemyStats, type ExpeditionEvent } from './expedition';
import {
  WILDCARD,
  WILDCARD_TIER,
  applyDrop,
  createGrid,
  isFull,
  isWildcard,
  pickChain,
  pickEmpty,
  releaseAt,
  type ChainId,
  type DropKind,
  type Grid,
  type GridSize,
  type Piece,
} from './grid';
import {
  FIXED_DT,
  Lane,
  TICK_RATE,
  stun,
  type AbyssGeometry,
  type LaneEvent,
  type LaneGeometry,
  type Side,
  type Unit,
  type UnitHost,
  type UnitRole,
  type WorryStats,
} from './lane';
import {
  activeBonds,
  addExp,
  cloneFormation,
  emptyProgress,
  fillTemplate,
  formationError,
  levelNeed,
  sameFormation,
  skillAtStar,
  slotCount,
  statsAtLevel,
  teamsOf,
  type ActiveBond,
  type Formation,
  type HeroProgress,
} from './roster';
import type { SeededRng } from './rng';
import type { SaveGame } from './save';
import { emptyGameStats, type GameStats } from './stats';
import { NightWaves, interleave } from './wave';

/** 덱: 낮 = 공격대(오펜스), 밤 = 수비대(디펜스) */
export type Role = 'offense' | 'defense';
export const ROLES: readonly Role[] = ['offense', 'defense'];

/** 두 레인의 좌표 (scene의 layout.ts에서 만든다) */
export interface GameGeometry {
  defense: LaneGeometry;
  abyss: AbyssGeometry;
}

/** 지급 조각 (보스 와일드카드): 빈 칸에, 없으면 사라짐 */
export interface Grant {
  /** 연출 시작점 (낮 레인 core 좌표) */
  x: number;
  y: number;
  piece: Piece;
  placedAt: number | null;
  lost: boolean;
}

/** 핵 상태 (저장·표시, §5.19-7): 없음 / 낮에 운반 중(진행 축 위치) / 이야기책에 놓임(밤) */
export type CoreState = { state: 'none' } | { state: 'carrying'; y: number } | { state: 'hut' };

/** 단계 시작 스냅샷 (§5.20-2): 편성이 전투 중에 바뀌면 이것으로 되돌려 그 단계를 다시 */
interface PhaseSnapshot {
  grid: (Piece | null)[];
  roster: HeroProgress[];
  rngState: number;
  stats: GameStats;
  attemptStats: AttemptStats;
  nextPieceId: number;
}

export type CoreEvent =
  | LaneEvent
  | ExpeditionEvent
  /** 장면 카드 (스테이지 시작·실패 뒤 재도전) */
  | { type: 'stageStart'; stage: number; retry: FailReason | null }
  /** 자동 뭉침 (D-070): from 조각이 to 칸으로 합쳐짐 (보상은 손 머지와 같음). 화면은 이 쌍을 끌어다 붙이는 연출만 */
  | { type: 'autoMerge'; from: number; to: number }
  /** 팀 교대 이어받기 (D-072): cells 칸의 조각이 회수되어 새 팀 게이지로 (gauges = 더한 뒤 값) */
  | { type: 'handover'; role: Role; cells: number[]; amount: number; gauges: { heroId: string; gauge: number; max: number }[] }
  /** 장면 카드를 닫고 낮 시작 */
  | { type: 'dayBegin'; stage: number; attempt: number }
  /** 영웅이 레인에 섬 (팀 출발·일어남) */
  | { type: 'heroEnter'; role: Role; unitId: number; heroId: string; revive: boolean }
  /** 영웅 쓰러짐: 밤이면 reviveSeconds 뒤 일어남, 낮이면 그 낮 동안 안 일어남 (seconds 0) */
  | { type: 'heroDown'; role: Role; unitId: number; heroId: string; seconds: number }
  /** 팀 교대 (§5.20-3): 다음 팀이 이야기책에서 출발. reason = 전멸 / 밤 구간 교대 / 다음 핵 */
  | { type: 'teamSwap'; role: Role; team: number; reason: 'wipe' | 'segment' | 'core' }
  /** guardian을 쓰러뜨려 핵을 찾음 (핵 카드) */
  | { type: 'coreFound'; stage: number }
  /** 전투 중 머지 버프 */
  | { type: 'buff'; role: Role; kind: 'heal' | 'momentum'; amount: number; stacks: number; affinity: boolean; cell: number }
  /** 전투 중 머지 병사 출전 (capped: 상한이라 병사 없음) */
  | { type: 'soldier'; role: Role; unitId: number | null; chain: string; level: number; affinity: boolean; cell: number; capped: boolean }
  /** 스킬 게이지 변화 (자기 체인 머지) */
  | { type: 'gauge'; heroId: string; gauge: number; max: number }
  /** 스킬 발동 */
  | { type: 'skill'; role: Role; heroId: string; unitId: number; kind: SkillDef['kind']; name: string }
  /** 5단계 특별 버프 (§5.18-9): 한낮 / 보름달 */
  | { type: 'special'; role: Role; kind: 'noon' | 'fullMoon'; affinity: boolean; cell: number }
  /** 레벨 업 */
  | { type: 'levelUp'; heroId: string; level: number }
  /** 편성이 전투 중에 바뀌어 지금 단계를 처음부터 */
  | { type: 'formationRestart'; phase: 'day' | 'night' }
  /** 해질녘: 핵을 이야기책에 가져옴 → 밤 시작 */
  | { type: 'dusk'; stage: number }
  /** 밤: 적이 거점에 닿아 핵 HP 감소 */
  | { type: 'coreHit'; hp: number; damage: number; boss: boolean }
  /** 조각이 생김 (§5.20-13): 저절로 / 처치 드롭 / 보스·guardian 확정. index null = 그리드 가득이라 버림. from = 처치 지점 (레인 core 좌표) */
  | { type: 'piece'; source: 'auto' | 'drop' | 'boss'; index: number | null; piece: Piece; from: { role: Role; x: number; y: number } | null }
  /** 스킬 자동/수동 전환 */
  | { type: 'autoSkill'; on: boolean }
  /** 보스 스테이지 핵을 가져옴 → 와일드카드 */
  | { type: 'bossReward'; rewards: Grant[] }
  /** 시도 실패 → 같은 스테이지 장면 카드 */
  | { type: 'attemptFail'; stage: number; reason: FailReason; record: AttemptStats }
  /** 스테이지 성공 → 아침 이야기 한 장 (1-length면 바로 챕터 완성) */
  | { type: 'stageClear'; stage: number; record: AttemptStats; notes: string[] }
  | { type: 'chapterComplete'; completed: true }
  /** 영웅 합류 (챕터 완성 보상·디버그, D-057) */
  | { type: 'heroesJoined'; ids: string[] }
  /** 첫 클리어 보상 (§5.22-2·3): 잉크·별가루 */
  | { type: 'stageReward'; stage: number; ink: number; dust: number }
  /** 비법서 얻음 (챕터 완성 / 10장 흠집 없음) */
  | { type: 'booksGained'; ids: string[]; source: BookSkill['source'] }
  /** 비법서 발동 (시작형: 팀 출발 / 상시형: 버팀) */
  | { type: 'bookSkill'; role: Role; heroId: string; bookId: string }
  /** 장이 흠집 없음이 됨 (밤 핵 HP 가득) */
  | { type: 'perfectPage'; stage: number }
  /** 다시 읽기 끝: 성공(잉크) / 그만 읽기 */
  | { type: 'replayEnd'; stage: number; success: boolean; perfect: boolean; ink: number };

export type ConfirmResult = { ok: true } | { ok: false; reason: 'notDayStart' };
export type FormationResult = { ok: true; restarted: boolean } | { ok: false; reason: string };

export type { GameStats } from './stats';

/** 레인 쪽: 오펜스 = 낮 레인(unhappy), 디펜스 = 방어(happy). Side는 레인 이벤트·표시용 이름 그대로 */
export function sideOf(role: Role): Side {
  return role === 'offense' ? 'unhappy' : 'happy';
}

/** 적 능력치 (§5.19-5): base × 종류 배수, HP는 × hpGrowthPerStage^(스테이지-1). 떼(보스가 아님)면 × swarm.hpMult (§5.20-13) */
export function enemyStats(data: GameData, type: string, stage: number, swarm = true): EnemyStats {
  const d = data.monsters.enemies.find((e) => e.id === type);
  if (!d) throw new Error(`알 수 없는 적: ${type}`);
  const b = data.monsters.base;
  return {
    type,
    hp: b.hp * d.hpMult * Math.pow(data.balance.enemy.hpGrowthPerStage, stage - 1) * (swarm ? data.balance.swarm.hpMult : 1),
    speed: b.speed * d.speedMult,
    atk: b.atk * d.atkMult,
    atkInterval: b.atkInterval,
  };
}

/** 적 묶음 × swarm.countMult (반올림, 묶음마다 최소 1) */
export function swarmGroups(data: GameData, groups: readonly EnemyGroup[]): EnemyGroup[] {
  const m = data.balance.swarm.countMult;
  return groups.map((g) => ({ ...g, count: Math.max(1, Math.round(g.count * m)) }));
}

export function enemyName(data: GameData, type: string): string {
  return data.monsters.enemies.find((e) => e.id === type)?.name ?? type;
}

/** 부동소수 누적 오차로 틱이 하나 빠지지 않도록 */
const TICK_EPS = 1e-9;

/** 스킬·특별 버프 대상이 되는 적 (두 레인 공용 모양) */
interface Foe {
  hp: number;
  y: number;
  slowTimer: number;
  slowMult: number;
}

export class GameState {
  /** 누적 게임 시간(초, 배속 반영). Piece.bornAt 기준 */
  playTime = 0;
  nextPieceId = 1;
  readonly grid: Grid;
  /** 스킬 자동 발동 (§5.20-13, 기본 true). false면 게이지가 찬 영웅을 castReady로 발동 */
  autoSkill = true;
  /** 저절로 조각까지 남은 초 (단계 시작마다 autoInterval) */
  autoTimer = 0;
  /** 자동 뭉침 (D-070): 다음 자동 머지까지 남은 초 (머지 뒤 autoMergeInterval, 짝이 없으면 0에 멈춤. 단계 시작마다 0) */
  autoMergeTimer = 0;
  /** 화면이 잡고 있는 칸 (자동 뭉침 대상에서 제외). 저장하지 않는 화면 상태 */
  readonly heldCells = new Set<number>();
  /** 이 판에서 자동 뭉침 횟수 (저장하지 않음, 시뮬 집계용) */
  autoMerges = 0;
  /** 팀 교대 이어받기 횟수·회수한 조각 수 (저장하지 않음, 시뮬 집계용) */
  handovers = 0;
  handoverPieces = 0;
  /** 밤: 동시 적 상한을 넘어 아직 레인에 못 나온 적 */
  private readonly nightQueue: WorryStats[] = [];
  /** 지급할 칸이 없어 사라진 조각 수 */
  lostReturns = 0;
  /** 처리한 고정 틱 수. playTime = tickCount / TICK_RATE */
  tickCount = 0;
  /** 밤(디펜스) 레인 */
  readonly defense: Lane;
  /** 낮(오펜스) 레인: 핵 찾아 돌아오기 */
  readonly abyss: Expedition;
  readonly wave: NightWaves;
  readonly stats: GameStats = emptyGameStats();
  /** 낮(오펜스) 남은 시간(초) */
  offenseTimer = 0;
  /** 밤 핵 HP (§5.19-3) */
  coreHp: number;

  // ── 영웅·편성 (§5.20-1·2) ──
  /** 보유 영웅 (얻은 순서) */
  readonly roster: HeroProgress[] = [];
  formation: Formation;
  /** 판 시작 편성 화면을 지났는지 (첫 장면 카드를 닫으면 true) */
  formationSeen = false;
  /** 지금 레인에 있는 팀 번호 (팀 목록 = 빈 팀을 뺀 teamsOf) */
  readonly activeTeam: Record<Role, number> = { offense: 0, defense: 0 };
  /** 낮에 쓰러져 그 낮 동안 안 일어나는 영웅 */
  private readonly fallen = new Set<string>();
  /** 밤에 쓰러진 영웅: 일어나기까지 남은 초 */
  readonly reviveTimers = new Map<string, number>();
  /** 레인 위 영웅 유닛: 영웅 id → 유닛 id */
  private readonly heroUnits = new Map<string, number>();
  /** 레인 유닛 id → 역할 (피해 비중 집계). 단계가 바뀔 때 비운다 */
  private unitRoles = new Map<number, UnitRole>();
  /** 오누이 인연: 이번 단계에 이미 쓴 팀 ("offense:0") */
  private readonly siblingsUsed = new Set<string>();
  /** 기세 (팀 단위, §5.17-3) */
  readonly momentum: Record<Role, { stacks: number; bonus: number; timer: number }> = {
    offense: { stacks: 0, bonus: 0, timer: 0 },
    defense: { stacks: 0, bonus: 0, timer: 0 },
  };
  /** 한낮 특별 버프: 남은 초·atk 배수 */
  readonly noon: Record<Role, { timer: number; pct: number }> = { offense: { timer: 0, pct: 0 }, defense: { timer: 0, pct: 0 } };
  /** 이번 단계 경험치 (단계가 끝날 때 성공 ×1, 실패 ×failMult로 들어간다) */
  private phaseExp = new Map<string, number>();
  /** 이번 밤 싸운 영웅 (밤 성공 경험치) */
  private readonly foughtNight = new Set<string>();
  /** 이번 낮 끝낸 핵 수 */
  coresDone = 0;
  private snapshot: PhaseSnapshot | null = null;

  // ── 스테이지 (§5.19-1) ──
  /** 지금 스테이지 (1-n의 n). 성공해야만 +1 */
  stage = 1;
  phase: DayPhase = 'dayStart';
  /** 판 통산 시도 수 (장면 카드를 닫을 때 +1) */
  attempt = 0;
  /** 스테이지별 시도 수 (index 0 = 1-1) */
  readonly attempts: number[];
  /** 지금 장면 카드가 실패 뒤 재도전이면 그 사유 */
  retry: FailReason | null = null;
  /** 이번 시도 기록 */
  attemptStats: AttemptStats;
  /** 방금 끝난 시도 (이야기 한 장·재도전 카드 표시) */
  lastAttempt: AttemptStats | null = null;
  /** 끝난 시도 전부 (시뮬·metrics) */
  readonly attemptLog: AttemptStats[] = [];
  /** 이야기책: 펼친 장 (스테이지 번호, 성공 순서) */
  readonly pages: number[] = [];
  /** 이야기책: 장마다 덧붙인 플레이 문장 (§5.20-8). key = 스테이지 번호 */
  readonly pageNotes: Record<number, string[]> = {};
  /** 판의 끝 (chapterComplete): 완성 true. 그 전에는 null */
  completed: true | null = null;

  // ── 성장 (§5.22) ──
  /** 잉크 (소수 포함, 표시는 내림) */
  ink = 0;
  /** 마지막으로 잉크를 계산한 실제 시각 (ms, null = 아직 없음) */
  inkAt: number | null = null;
  /** 별가루 */
  stardust = 0;
  /** 가진 비법서 (얻은 순서) */
  readonly ownedBooks: string[] = [];
  /** 장착: 영웅 id → 칸별 비법서 id (빈 칸 null). 편성처럼 단계 스냅샷 밖 */
  readonly equipped: Record<string, (string | null)[]> = {};
  /** 흠집 없음 장 (스테이지 번호, 그 장 밤을 핵 HP 가득으로 지킴) */
  readonly perfect: number[] = [];
  /** 다시 읽기 중인 장 (null = 아님) */
  replay: number | null = null;
  /** 이번 단계에 버팀(상시형)을 쓴 영웅 */
  private readonly endureUsed = new Set<string>();
  /** 시간이 정해진 보호막 (떡 나눠 주기): 끝나면 남은 만큼 걷음 */
  private timedShields: { unitId: number; amount: number; left: number }[] = [];

  /** 저장(save.ts)이 읽고 쓴다 */
  nextUnitId = 1;
  /** 아직 틱으로 처리하지 않은 시간 */
  private acc = 0;
  /** 틱 밖(머지·단계 전환 등)에서 생긴 이벤트. 다음 tick()의 반환값에 앞서 포함된다 */
  private pending: CoreEvent[] = [];

  constructor(
    private readonly data: GameData,
    size: GridSize,
    readonly rng: SeededRng,
    geometry: GameGeometry,
    /** 이 판의 시드 (저장·디버그 표시·재현용) */
    readonly seed = 0,
  ) {
    const b = data.balance;
    this.coreHp = b.core.hp;
    this.grid = createGrid(size, b.grid.maxTier);
    const need = b.merge.soldierCap + b.team.teamSize;
    for (const [name, g] of [
      ['방어선', geometry.defense],
      ['낮 레인', geometry.abyss],
    ] as const) {
      if (g.slotXs.length < need) throw new Error(`${name} 슬롯 수(${g.slotXs.length}) < 팀 ${b.team.teamSize} + soldierCap(${b.merge.soldierCap})`);
    }
    const intercept = { range: b.lane.defenseInterceptRange, speed: b.lane.defenseMoveSpeed, contact: b.lane.defenseContact };
    this.defense = new Lane('defense', geometry.defense, b.happy, intercept);
    this.abyss = new Expedition(geometry.abyss, { advanceSpeed: b.lane.abyssAdvanceSpeed, carry: b.carry, escort: intercept, maxEnemies: b.swarm.laneMaxEnemies });
    this.wave = new NightWaves(b.wave);
    const h = data.heroes;
    const [off, def] = b.start.swapHeroes ? [h.defense, h.offense] : [h.offense, h.defense];
    for (const hero of h.heroes) if (hero.reward === undefined) this.roster.push(emptyProgress(hero.id));
    this.formation = { offense: [[off]], defense: [[def]] };
    this.attempts = new Array<number>(b.chapter.length).fill(0);
    this.attemptStats = emptyAttemptStats(1, 1, b.grid.maxTier);
  }

  /** 시간은 낮·밤에만 흐른다 */
  get timeFlows(): boolean {
    return this.phase === 'day' || this.phase === 'night';
  }

  get offenseSeconds(): number {
    return this.data.balance.offense.seconds;
  }

  get chapterLength(): number {
    return this.data.balance.chapter.length;
  }

  /** 지금 스테이지 데이터 (stages.json) */
  get stageDef(): StageDef {
    return this.data.stages.stages[this.stage - 1];
  }

  /** 핵 상태 (§5.19-7) */
  get coreState(): CoreState {
    if (this.phase === 'night') return { state: 'hut' };
    if (this.phase !== 'day') return { state: 'none' };
    const c = this.abyss.core;
    if (c.at === 'carried') return { state: 'carrying', y: this.abyss.carrier?.y ?? this.abyss.geo.wallY };
    if (c.at === 'dropped') return { state: 'carrying', y: c.y };
    if (c.at === 'hut') return { state: 'hut' };
    return { state: 'none' };
  }

  /** 지금 싸우는 쪽 (낮 = 공격대, 밤 = 수비대). 전투 밖이면 null */
  get fightingRole(): Role | null {
    if (this.phase === 'day' && this.offenseTimer > TICK_EPS) return 'offense';
    if (this.phase === 'night') return 'defense';
    return null;
  }

  /** 전투 중 (§5.17-3): 낮 남은 시간 > 0 / 밤 */
  get inBattle(): boolean {
    return this.fightingRole !== null;
  }

  laneOf(role: Role): UnitHost {
    return role === 'offense' ? this.abyss : this.defense;
  }

  // ── 영웅 ──

  heroDef(id: string): HeroDef {
    const h = this.data.heroes.heroes.find((x) => x.id === id);
    if (!h) throw new Error(`알 수 없는 영웅: ${id}`);
    return h;
  }

  progressOf(id: string): HeroProgress {
    const p = this.roster.find((x) => x.id === id);
    if (!p) throw new Error(`보유하지 않은 영웅: ${id}`);
    return p;
  }

  get owned(): string[] {
    return this.roster.map((p) => p.id);
  }

  /** 팀 목록 (빈 팀 제외) */
  teams(role: Role): string[][] {
    return teamsOf(this.formation, role);
  }

  /** 지금 그 덱에서 레인에 나가 있는(나갈) 팀 */
  activeTeamIds(role: Role): string[] {
    return this.teams(role)[this.activeTeam[role]] ?? [];
  }

  /** 레인 팀 기준 역할: 낮 → 공격대, 밤 → 수비대, 전투 밖 → 다음에 나갈 공격대 (§5.20-4) */
  get laneRole(): Role {
    return this.phase === 'night' ? 'defense' : 'offense';
  }

  /** 켜진 인연 (§5.20-6) */
  get bonds(): ActiveBond[] {
    return activeBonds(this.data, this.formation);
  }

  /** 이 영웅에게 걸린 인연 효과 (지금 편성 기준) */
  private bondEffect(id: string): { dmgReduce: number; gaugeMult: number; atkPct: number } {
    const out = { dmgReduce: 0, gaugeMult: 1, atkPct: 0 };
    for (const b of this.bonds) {
      if (!b.heroes.includes(id)) continue;
      const e = b.bond.effect;
      out.dmgReduce += e.dmgReduce ?? 0;
      out.gaugeMult *= e.gaugeMult ?? 1;
      out.atkPct += e.atkPct ?? 0;
    }
    return out;
  }

  /** 영웅 능력치 (레벨 + 적성 + 인연, 기세·한낮 제외). role = 그 단계(낮 공격대 / 밤 수비대), 없으면 편성 쪽 */
  heroStats(id: string, role: Role = this.sideOfHero(id)): CombatStats & { dmgMult: number } {
    const p = this.progressOf(id);
    const s = statsAtLevel(this.heroDef(id), p.level, this.data.balance.exp);
    const apt = this.aptitudeMult(id, role);
    const bond = this.bondEffect(id);
    return { ...s, hp: s.hp * apt, atk: s.atk * apt * (1 + bond.atkPct), dmgMult: 1 - Math.min(0.95, bond.dmgReduce) };
  }

  /** 편성에서 이 영웅이 있는 쪽 (없으면 공격대) */
  sideOfHero(id: string): Role {
    return this.formation.defense.some((t) => t.includes(id)) ? 'defense' : 'offense';
  }

  /** 낮·밤 적성 배율 (§5.22-4): 공격대 = 낮 적성, 수비대 = 밤 적성 */
  aptitudeMult(id: string, role: Role): number {
    const a = this.heroDef(id).aptitude;
    return this.data.balance.aptitude[role === 'offense' ? a.day : a.night];
  }

  /** ★ 반영 고유 스킬 (§5.22-3) */
  skillOf(id: string): SkillDef {
    return skillAtStar(this.heroDef(id), this.progressOf(id).star);
  }

  /** 레인 위 영웅 유닛 (없으면 null) */
  heroUnit(id: string): Unit | null {
    const uid = this.heroUnits.get(id);
    if (uid === undefined) return null;
    for (const lane of [this.abyss, this.defense] as UnitHost[]) {
      const u = lane.units.find((x) => x.id === uid);
      if (u) return u;
    }
    return null;
  }

  /** 레인 위 그 덱 팀 영웅 유닛들 (팀 순서, 살아 있는 것만) */
  teamUnits(role: Role): Unit[] {
    return this.activeTeamIds(role)
      .map((id) => this.heroUnit(id))
      .filter((u): u is Unit => u !== null && u.hp > 0);
  }

  /** 레인 위 그 덱 맨 앞 영웅 (표시·테스트용) */
  heroUnitOf(role: Role): Unit | null {
    return this.teamUnits(role)[0] ?? null;
  }

  /** 영웅을 레인에 (팀 출발: hp 가득 / 일어남: hp × 비율) */
  private enterHero(role: Role, id: string, out: CoreEvent[], opts: { hpRatio?: number; revive?: boolean; y?: number } = {}): void {
    const s = this.heroStats(id, role);
    const def = this.heroDef(id);
    const lane = this.laneOf(role);
    const u = lane.addUnit(this.nextUnitId++, sideOf(role), id, 0, s, {
      role: 'hero',
      dmgMult: s.dmgMult,
      hp: s.hp * (opts.hpRatio ?? 1),
      attackType: def.attackType,
      ...(opts.y !== undefined ? { y: opts.y } : {}),
    });
    if (!u) return;
    // 상시형 비법서: 이번 단계에 아직 안 썼으면 버팀 1회
    if (this.bookEffects(id).some((b) => b.kind === 'passive' && b.effect.endure) && !this.endureUsed.has(id)) u.endure = true;
    this.heroUnits.set(id, u.id);
    this.unitRoles.set(u.id, 'hero');
    if (role === 'defense') this.foughtNight.add(id);
    this.applyMomentum(role);
    out.push({ type: 'heroEnter', role, unitId: u.id, heroId: id, revive: opts.revive ?? false });
  }

  /** 팀 출발: 낮은 이야기책에서 앞·가운데·뒤 순서로(쓰러진 영웅 제외), 밤은 거점 앞 */
  private enterTeam(role: Role, out: CoreEvent[]): void {
    const ids = this.activeTeamIds(role).filter((id) => !(role === 'offense' && this.fallen.has(id)));
    this.handover(role, ids, out);
    const sp = this.data.balance.team.spacing;
    ids.forEach((id, i) => {
      this.enterHero(role, id, out, role === 'offense' ? { y: this.abyss.teamStartY(i, ids.length, sp) } : {});
    });
    this.startBooks(role, ids, out);
  }

  /**
   * 팀 교대 이어받기 (D-072, §5.24-2): 레인에 새 팀이 나갈 때(릴레이·낮→밤·밤→낮) 새 팀 체인이 아닌 조각을 전부 회수.
   * 회수량 = Σ handoverTierValue[단계-1] × handoverRatio → 새 팀(나가는 영웅)의 스킬 게이지에 똑같이 나눠 더함 (상한 넘치면 버림).
   * 와일드카드·새 팀 체인 조각은 남는다
   */
  private handover(role: Role, ids: string[], out: CoreEvent[]): void {
    const g = this.data.balance.grid;
    const keep = new Set(this.activeTeamIds(role).map((id) => this.heroDef(id).chain));
    const cells: number[] = [];
    let amount = 0;
    this.grid.cells.forEach((p, i) => {
      if (!p || isWildcard(p) || keep.has(p.chain)) return;
      cells.push(i);
      amount += g.handoverTierValue[p.tier - 1] ?? 0;
    });
    if (!cells.length) return;
    for (const i of cells) this.grid.cells[i] = null;
    amount *= g.handoverRatio;
    const gauges: { heroId: string; gauge: number; max: number }[] = [];
    if (ids.length && amount > 0) {
      const each = amount / ids.length;
      for (const id of ids) {
        const prog = this.progressOf(id);
        const max = this.skillOf(id).gauge;
        prog.gauge = Math.min(max, prog.gauge + each);
        gauges.push({ heroId: id, gauge: prog.gauge, max });
      }
    }
    this.handovers += 1;
    this.handoverPieces += cells.length;
    out.push({ type: 'handover', role, cells, amount, gauges });
  }

  /** 시작형 비법서 (§5.22-5): 팀이 레인에 나갈 때(낮 출발·밤 구간 시작·교대) 그 팀에 1회 */
  private startBooks(role: Role, ids: string[], out: CoreEvent[]): void {
    for (const id of ids) {
      for (const b of this.bookEffects(id)) {
        if (b.kind !== 'start') continue;
        const e = b.effect;
        for (const tid of ids) {
          const u = this.heroUnit(tid);
          if (u && e.healPct) u.hp = Math.min(u.maxHp, u.hp + u.maxHp * e.healPct);
          if (u && e.shieldPct) {
            const amount = u.maxHp * e.shieldPct;
            u.shield += amount;
            this.timedShields.push({ unitId: u.id, amount, left: e.shieldSeconds ?? 0 });
          }
          if (e.gaugePct) {
            const p = this.progressOf(tid);
            p.gauge = Math.max(p.gauge, this.skillOf(tid).gauge * e.gaugePct);
          }
        }
        out.push({ type: 'bookSkill', role, heroId: id, bookId: b.id });
      }
    }
  }

  /** 시간이 정해진 보호막이 끝나면 남은 만큼 걷는다 */
  private tickTimedShields(): void {
    if (!this.timedShields.length) return;
    for (const t of this.timedShields) t.left -= FIXED_DT;
    for (const t of this.timedShields.filter((x) => x.left <= TICK_EPS)) {
      for (const lane of [this.abyss, this.defense] as UnitHost[]) {
        const u = lane.units.find((x) => x.id === t.unitId);
        if (u) u.shield = Math.max(0, u.shield - t.amount);
      }
    }
    this.timedShields = this.timedShields.filter((x) => x.left > TICK_EPS);
  }

  /** 상시형 버팀을 쓴 영웅 기록 (유닛의 endure가 꺼졌으면) */
  private checkEndure(role: Role, out: CoreEvent[]): void {
    for (const id of this.activeTeamIds(role)) {
      const u = this.heroUnit(id);
      if (!u || u.endure !== false || this.endureUsed.has(id)) continue;
      this.endureUsed.add(id);
      const b = this.bookEffects(id).find((x) => x.kind === 'passive' && x.effect.endure);
      if (b) out.push({ type: 'bookSkill', role, heroId: id, bookId: b.id });
    }
  }

  /** 레인 위 영웅 유닛을 모두 내린다 (교대) */
  private removeTeamUnits(role: Role): void {
    const lane = this.laneOf(role);
    const ids = new Set(this.heroUnits.values());
    for (let i = lane.units.length - 1; i >= 0; i--) if (lane.units[i].role === 'hero' && ids.has(lane.units[i].id)) lane.units.splice(i, 1);
    this.heroUnits.clear();
  }

  /** 기세 반영: 팀 영웅 atk = 기본 atk × (1 + 보너스) */
  private applyMomentum(role: Role): void {
    for (const id of this.activeTeamIds(role)) {
      const u = this.heroUnit(id);
      if (u) u.atk = this.heroStats(id).atk * (1 + this.momentum[role].bonus);
    }
  }

  private resetMomentum(role: Role): void {
    this.momentum[role] = { stacks: 0, bonus: 0, timer: 0 };
    this.noon[role] = { timer: 0, pct: 0 };
  }

  /** 기세·한낮 시간 감소 (전투 중, 지금 싸우는 쪽만) */
  private tickBuffs(role: Role): void {
    const m = this.momentum[role];
    this.stats.momentumStackSeconds += m.stacks * FIXED_DT;
    if (m.stacks > 0) {
      m.timer -= FIXED_DT;
      if (m.timer <= TICK_EPS) {
        this.momentum[role] = { stacks: 0, bonus: 0, timer: 0 };
        this.applyMomentum(role);
      }
    }
    const n = this.noon[role];
    if (n.timer > 0) {
      n.timer = Math.max(0, n.timer - FIXED_DT);
      if (n.timer <= TICK_EPS) n.pct = 0;
    }
    this.laneOf(role).atkMult = 1 + (n.timer > 0 ? n.pct : 0);
  }

  // ── 편성 (§5.20-2) ──

  /** 편성 검사 (문제가 없으면 null) */
  formationError(f: Formation): string | null {
    return formationError(f, this.owned, this.data.balance.team);
  }

  /**
   * 편성 확정. 바뀌었고 전투 중이면 지금 단계를 단계 시작 스냅샷으로 되돌려 다시 (D-049).
   * 전투 밖(장면 카드·이야기 한 장)에서 바꾸면 재시작 없음.
   */
  setFormation(f: Formation): FormationResult {
    const err = this.formationError(f);
    if (err) return { ok: false, reason: err };
    this.formationSeen = true;
    if (sameFormation(f, this.formation)) return { ok: true, restarted: false };
    // 빈 팀은 정리 (팀 순서는 유지)
    this.formation = { offense: teamsOf(f, 'offense').map((t) => [...t]), defense: teamsOf(f, 'defense').map((t) => [...t]) };
    if (this.phase === 'day' || this.phase === 'night') {
      this.restartPhase(this.pending);
      return { ok: true, restarted: true };
    }
    return { ok: true, restarted: false };
  }

  private takeSnapshot(): void {
    this.snapshot = {
      grid: structuredClone(this.grid.cells),
      roster: structuredClone(this.roster),
      rngState: this.rng.getState(),
      stats: structuredClone(this.stats),
      attemptStats: structuredClone(this.attemptStats),
      nextPieceId: this.nextPieceId,
    };
  }

  /** 단계 시작 스냅샷으로 되돌리고 그 단계를 처음부터 */
  private restartPhase(out: CoreEvent[]): void {
    const s = this.snapshot;
    if (!s) return;
    const phase = this.phase as 'day' | 'night';
    this.grid.cells.splice(0, this.grid.cells.length, ...structuredClone(s.grid));
    this.roster.splice(0, this.roster.length, ...structuredClone(s.roster));
    this.rng.setState(s.rngState);
    Object.assign(this.stats, structuredClone(s.stats));
    this.attemptStats = structuredClone(s.attemptStats);
    this.nextPieceId = s.nextPieceId;
    out.push({ type: 'formationRestart', phase });
    if (phase === 'day') this.startDay(out);
    else this.startNight(out);
  }

  // ── 시간 ──

  /**
   * dt: 배속이 반영된 경과 시간(초). 고정 틱 단위로 나눠 처리하고 그동안 생긴 이벤트를 돌려준다.
   * tick(1)과 tick(1/60) × 60은 같은 결과. 낮·밤이 아니면 시간이 흐르지 않는다.
   */
  tick(dt: number): CoreEvent[] {
    const out = this.pending;
    this.pending = [];
    if (!this.timeFlows) {
      this.acc = 0;
      return out;
    }
    if (dt > 0) this.acc += dt;
    const n = Math.floor((this.acc + TICK_EPS) / FIXED_DT);
    this.acc = Math.max(0, this.acc - n * FIXED_DT);
    for (let i = 0; i < n && this.timeFlows; i++) this.step(out);
    if (!this.timeFlows) this.acc = 0; // 단계가 끝난 뒤 남은 시간은 버린다
    return out;
  }

  /** 고정 틱 하나. 낮과 밤은 동시에 돌지 않는다 */
  private step(out: CoreEvent[]): void {
    this.tickCount += 1;
    this.playTime = this.tickCount / TICK_RATE;
    this.attemptStats.realSeconds += FIXED_DT;
    if (this.phase === 'day') this.attemptStats.offenseSeconds += FIXED_DT;
    else this.attemptStats.defenseSeconds += FIXED_DT;
    if (this.inBattle) this.stats.battleSeconds += FIXED_DT;
    if (isFull(this.grid)) {
      this.attemptStats.gridFullSeconds += FIXED_DT;
      if (this.inBattle) this.stats.gridFullSeconds += FIXED_DT;
    }

    const role: Role = this.phase === 'day' ? 'offense' : 'defense';
    if (this.phase === 'day') this.stepOffense(out);
    else this.stepDefense(out);
    if (!this.timeFlows) return; // 단계가 끝남
    this.checkEndure(role, out);
    this.tickTimedShields();

    // 저절로 조각 (§5.20-13): 전투 중 autoInterval마다 1단계 1개
    if (this.inBattle) {
      this.autoTimer -= FIXED_DT;
      if (this.autoTimer <= TICK_EPS) {
        this.autoTimer += this.data.balance.spawn.autoInterval;
        this.makePiece('auto', 1, null, out);
      }
    }
    // 자동 뭉침 (D-070): autoMergeMaxTier 이하 같은 조각 한 쌍을 autoMergeInterval마다
    this.stepAutoMerge(out);
    // 자동 모드: 게이지가 찬 레인 영웅은 바로 발동 (수동 → 자동 전환·찬 채로 다시 나온 영웅)
    if (this.autoSkill) {
      const role = this.fightingRole;
      if (role) for (const id of this.activeTeamIds(role)) if (this.skillReady(id)) this.fireSkill(role, id, out);
    }
  }

  /**
   * 조각 하나를 그리드 빈 칸(rng)에. 체인 = 레인 팀 체인 중 균등 (§5.20-4). 가득이면 버림.
   * source: auto = 저절로 / drop = 처치 드롭 / boss = 보스·guardian 확정
   */
  private makePiece(source: 'auto' | 'drop' | 'boss', tier: number, from: { role: Role; x: number; y: number } | null, out: CoreEvent[]): void {
    const chain = pickChain(
      this.rng,
      this.spawnChains.map((id) => ({ id, weight: 1 })),
    );
    const piece = this.newPiece(chain, tier);
    const index = pickEmpty(this.rng, this.grid);
    if (index === null) {
      this.stats.piecesDiscarded += 1;
      this.attemptStats.discarded += 1;
    } else {
      this.grid.cells[index] = piece;
      this.attemptStats.spawns += 1;
      this.stats.chainSpawns[chain] = (this.stats.chainSpawns[chain] ?? 0) + 1;
      if (source === 'auto') this.stats.piecesAuto += 1;
      else this.stats.piecesDropped += 1;
    }
    out.push({ type: 'piece', source, index, piece, from });
  }

  /** 우리 편이 준 피해 집계 (영웅 / 병사 / 거점) */
  private countDamage(out: CoreEvent[], from: number): void {
    for (let i = from; i < out.length; i++) {
      const e = out[i];
      if (e.type === 'attack') {
        if (e.attacker.kind === 'happy') this.stats.damageBase += e.damage;
        else if (e.attacker.kind === 'unit') this.addDamage(e.attacker.id, e.damage);
      } else if (e.type === 'unitHit' || e.type === 'guardianHit') {
        this.addDamage(e.unitId, e.damage);
      }
    }
  }

  private addDamage(unitId: number, dmg: number): void {
    if (this.unitRoles.get(unitId) === 'soldier') this.stats.damageSoldier += dmg;
    else this.stats.damageHero += dmg;
  }

  /** 이번 단계 경험치: 지금 레인 팀원에게 균등 */
  private giveExp(role: Role, amount: number): void {
    const ids = this.activeTeamIds(role);
    if (!ids.length || amount <= 0) return;
    for (const id of ids) this.phaseExp.set(id, (this.phaseExp.get(id) ?? 0) + amount / ids.length);
  }

  /** 단계가 끝남: 이번 단계 경험치를 넣는다 (실패면 × failMult) */
  private commitExp(success: boolean, out: CoreEvent[]): void {
    const cfg = this.data.balance.exp;
    for (const [id, x] of this.phaseExp) {
      const p = this.roster.find((r) => r.id === id);
      if (!p) continue;
      if (addExp(p, x * (success ? 1 : cfg.failMult), cfg) > 0) out.push({ type: 'levelUp', heroId: id, level: p.level });
    }
    this.phaseExp = new Map();
  }

  /** 이번 단계에 쌓인 (아직 넣지 않은) 경험치 */
  pendingExp(id: string): number {
    return this.phaseExp.get(id) ?? 0;
  }

  /** 처치: 경험치 + 조각 드롭 (보스는 bossDropTier × bossDropCount 확정, 일반은 killDropChance로 1단계 1개) */
  private defeated(role: Role, x: number, y: number, boss: boolean, out: CoreEvent[]): void {
    const sp = this.data.balance.spawn;
    this.stats.worriesDefeated += 1;
    this.attemptStats.defeated += 1;
    this.giveExp(role, this.data.balance.exp.kill);
    if (boss) for (let k = 0; k < sp.bossDropCount; k++) this.makePiece('boss', sp.bossDropTier, { role, x, y }, out);
    else if (this.rng() < sp.killDropChance) this.makePiece('drop', 1, { role, x, y }, out);
  }

  /** 오누이 인연: 이 영웅의 팀에 켜져 있고 이번 단계에 아직 안 썼으면 쓴다 → 일어날 hp 비율 */
  private siblingsRevive(role: Role, id: string): number | null {
    const team = this.activeTeam[role];
    const key = `${role}:${team}`;
    if (this.siblingsUsed.has(key)) return null;
    const b = this.bonds.find((x) => x.side === role && x.team === team && x.bond.effect.firstFallReviveHp !== undefined && x.heroes.includes(id));
    if (!b) return null;
    this.siblingsUsed.add(key);
    return b.bond.effect.firstFallReviveHp!;
  }

  /** 낮: 핵 찾아 돌아오기 (팀 릴레이) */
  private stepOffense(out: CoreEvent[]): void {
    const ex = this.abyss;
    const from = out.length;
    ex.step(FIXED_DT, out, this.rng);
    this.countDamage(out, from);
    let home = false;
    const end = out.length;
    for (let i = from; i < end; i++) {
      const e = out[i];
      switch (e.type) {
        case 'enemyDie':
          this.defeated('offense', e.x, e.y, false, out);
          break;
        case 'offenseUnitDie': {
          if (e.role !== 'hero') {
            this.stats.offenseSoldierDeaths += 1;
            break;
          }
          const id = e.chain;
          this.heroUnits.delete(id);
          this.stats.offenseFalls += 1;
          if (e.carrying) this.attemptStats.carryFalls += 1;
          const again = this.siblingsRevive('offense', id);
          if (again !== null) {
            this.enterHero('offense', id, out, { hpRatio: again, revive: true, y: e.y });
          } else {
            this.fallen.add(id); // 그 낮 동안 안 일어남 (§5.20-3)
            out.push({ type: 'heroDown', role: 'offense', unitId: e.unitId, heroId: id, seconds: 0 });
          }
          break;
        }
        case 'guardianDown':
          this.stats.guardiansDown += 1;
          this.attemptStats.guardianDown = 1;
          this.giveExp('offense', this.data.balance.exp.guardian);
          out.push({ type: 'coreFound', stage: this.stage });
          for (let k = 0; k < this.data.balance.spawn.bossDropCount; k++) {
            this.makePiece('boss', this.data.balance.spawn.bossDropTier, { role: 'offense', x: ex.geo.centerX, y: ex.geo.wallY }, out);
          }
          break;
        case 'coreDrop':
          this.stats.coreDrops += 1;
          this.attemptStats.drops += 1;
          break;
        case 'coreReturned':
          this.stats.coreReturns += 1;
          this.attemptStats.coreReturns += 1;
          break;
        case 'coreHome':
          home = true;
          break;
        default:
          break;
      }
    }
    ex.expireSoldiers(FIXED_DT);
    this.tickBuffs('offense');
    this.offenseTimer -= FIXED_DT;
    this.attemptStats.carrySeconds = ex.carryTime;

    if (home) {
      this.coresDone += 1;
      if (this.coresDone >= this.stageDef.cores) return this.daySuccess(out);
      this.nextCore(out);
      return;
    }
    // 팀 전멸 → 다음 팀이 이야기책에서 출발, 같은 핵 이어받기 (떨어진 핵은 그 자리)
    if (this.teamUnits('offense').length === 0) {
      if (this.activeTeam.offense + 1 < this.teams('offense').length) {
        this.activeTeam.offense += 1;
        this.stats.teamSwapsDay += 1;
        this.attemptStats.teamSwaps += 1;
        this.resetMomentum('offense');
        this.enterTeam('offense', out);
        out.push({ type: 'teamSwap', role: 'offense', team: this.activeTeam.offense, reason: 'wipe' });
      } else {
        return this.fail('dayFall', out);
      }
    }
    if (this.offenseTimer <= TICK_EPS) this.fail(ex.guardianDown ? 'returnTime' : 'dayTime', out);
  }

  /** 핵을 하나 들였고 남은 핵이 있다: 다음 핵은 다음 팀 (없으면 같은 팀) */
  private nextCore(out: CoreEvent[]): void {
    this.removeTeamUnits('offense');
    this.resetExpedition();
    if (this.activeTeam.offense + 1 < this.teams('offense').length) this.activeTeam.offense += 1;
    this.stats.teamSwapsDay += 1;
    this.attemptStats.teamSwaps += 1;
    this.enterTeam('offense', out);
    out.push({ type: 'teamSwap', role: 'offense', team: this.activeTeam.offense, reason: 'core' });
  }

  /** 핵을 모두 이야기책에 가져옴: 보스 스테이지면 와일드카드 → 1-length면 챕터 완성, 아니면 해질녘 */
  private daySuccess(out: CoreEvent[]): void {
    const b = this.data.balance;
    const ex = this.abyss;
    this.commitExp(true, out);
    if (this.stageDef.day.boss) {
      const rewards: Grant[] = [];
      for (let k = 0; k < b.guardian.bossWildcards; k++) {
        rewards.push(this.grantPiece(this.newPiece(WILDCARD, 0), ex.geo.centerX, ex.geo.startY));
        this.stats.wildcardsGained += 1;
      }
      out.push({ type: 'bossReward', rewards });
    }
    if (this.replay !== null && this.stage >= this.chapterLength) return this.replaySuccess(out);
    if (this.stage >= this.chapterLength) {
      const record = this.finishAttempt('success');
      this.openPage(record);
      out.push({ type: 'stageClear', stage: this.stage, record, notes: this.pageNotes[this.stage] });
      this.enterChapterComplete(out);
      return;
    }
    this.dusk(out);
  }

  /** 밤: 웨이브 → 방어 레인 → 핵 HP → 영웅 일어남 → 구간·전멸 교대 */
  private stepDefense(out: CoreEvent[]): void {
    const b = this.data.balance;
    this.spawnFromWave(out);
    const from = out.length;
    this.defense.step(FIXED_DT, out);
    this.countDamage(out, from);
    const end = out.length;
    for (let i = from; i < end; i++) {
      const e = out[i];
      if (e.type === 'unitDie' && e.role === 'hero') {
        const id = e.chain;
        this.heroUnits.delete(id);
        this.stats.defenseFalls += 1;
        this.attemptStats.defenseFalls += 1;
        const again = this.siblingsRevive('defense', id);
        if (again !== null) {
          this.enterHero('defense', id, out, { hpRatio: again, revive: true });
        } else {
          // 밤 쓰러짐 → reviveSeconds 뒤 hp × reviveHpRatio로 일어남
          this.reviveTimers.set(id, b.hero.reviveSeconds);
          out.push({ type: 'heroDown', role: 'defense', unitId: e.unitId, heroId: id, seconds: b.hero.reviveSeconds });
        }
      } else if (e.type === 'worryDie') {
        this.defeated('defense', e.x, e.y, e.boss, out);
      } else if (e.type === 'sink') {
        const damage = e.boss ? b.core.bossSinkDamage : b.core.sinkDamage;
        this.coreHp = Math.max(0, this.coreHp - damage);
        this.stats.sunkCount += 1;
        this.attemptStats.sunk += 1;
        out.push({ type: 'coreHit', hp: this.coreHp, damage, boss: e.boss });
      }
    }

    for (const [id, t] of [...this.reviveTimers]) {
      const left = t - FIXED_DT;
      if (left <= TICK_EPS) {
        this.reviveTimers.delete(id);
        if (this.activeTeamIds('defense').includes(id)) this.enterHero('defense', id, out, { hpRatio: b.hero.reviveHpRatio, revive: true });
      } else this.reviveTimers.set(id, left);
    }
    this.defense.expireSoldiers(FIXED_DT);
    this.tickBuffs('defense');

    // 교대: 웨이브 구간 담당이 넘어감 / 팀 전멸 → 다음 팀 즉시 (마지막 팀은 그대로 일어남을 기다린다)
    const teams = this.teams('defense');
    const n = Math.max(1, this.wave.waveCount);
    const owner = Math.min(teams.length - 1, Math.floor((this.wave.slot * teams.length) / n));
    if (owner > this.activeTeam.defense) this.swapDefense(owner, 'segment', out);
    else if (this.teamUnits('defense').length === 0 && this.activeTeam.defense + 1 < teams.length) this.swapDefense(this.activeTeam.defense + 1, 'wipe', out);

    if (this.coreHp <= 0) this.fail('night', out);
    else if (this.wave.phase === 'done') this.nightSuccess(out);
  }

  private swapDefense(team: number, reason: 'wipe' | 'segment', out: CoreEvent[]): void {
    this.removeTeamUnits('defense');
    this.reviveTimers.clear();
    this.activeTeam.defense = team;
    this.resetMomentum('defense');
    this.stats.teamSwapsNight += 1;
    this.attemptStats.teamSwaps += 1;
    this.enterTeam('defense', out);
    out.push({ type: 'teamSwap', role: 'defense', team, reason });
  }

  /** 밤 1단계: 이번 틱에 등장할 적 (stages.json night × 떼, 스테이지 고정). 동시 적 상한이면 대기열 → 자리가 나면 등장 */
  private spawnFromWave(out: CoreEvent[]): void {
    const lane = this.defense;
    const geo = lane.geo;
    for (const s of this.wave.step(FIXED_DT, lane.worries.length === 0 && this.nightQueue.length === 0)) {
      this.nightQueue.push({ ...this.harder(enemyStats(this.data, s.type, this.stage, !s.boss)), boss: s.boss });
    }
    const max = this.data.balance.swarm.laneMaxEnemies;
    while (this.nightQueue.length && lane.worries.length < max) {
      const x = geo.spawnXMin + this.rng() * (geo.spawnXMax - geo.spawnXMin);
      lane.spawnWorry(this.nightQueue.shift()!, x, out);
    }
  }

  /** 밤 대기열에 남은 적 수 (표시용) */
  get nightQueued(): number {
    return this.nightQueue.length;
  }

  /** 조각 지급: 빈 칸(rng)에, 없으면 사라짐 */
  private grantPiece(piece: Piece, x: number, y: number): Grant {
    const index = pickEmpty(this.rng, this.grid);
    if (index !== null) this.grid.cells[index] = piece;
    else {
      this.lostReturns += 1;
      this.attemptStats.lostReturns += 1;
    }
    return { x, y, piece, placedAt: index, lost: index === null };
  }

  // ── 스테이지 흐름 (§5.19-1) ──

  /** 적 묶음 × 떼 → 능력치 줄 (종류별로 번갈아) */
  private expand(groups: readonly EnemyGroup[]): EnemyStats[] {
    return interleave(swarmGroups(this.data, groups)).map((t) => this.harder(enemyStats(this.data, t, this.stage)));
  }

  /** 다시 읽기 난이도 배수 (§5.22-6, 아니면 1) */
  get difficulty(): number {
    return this.replay !== null ? this.data.balance.replay.difficultyMult : 1;
  }

  /** 적 hp·atk × 난이도 */
  private harder<T extends { hp: number; atk: number }>(s: T): T {
    const k = this.difficulty;
    return k === 1 ? s : { ...s, hp: s.hp * k, atk: s.atk * k };
  }

  /** 장면 카드를 닫는다 → 시도 수 + 1, 낮 시작 */
  confirmDay(): ConfirmResult {
    if (this.phase !== 'dayStart') return { ok: false, reason: 'notDayStart' };
    const b = this.data.balance;
    const out = this.pending;
    this.formationSeen = true;
    this.attempt += 1;
    if (this.replay !== null) this.stats.replayAttempts += 1;
    else {
      this.attempts[this.stage - 1] += 1;
      this.stats.attempts += 1;
    }
    this.attemptStats = emptyAttemptStats(this.stage, this.attempt, b.grid.maxTier);
    this.attemptStats.replay = this.replay !== null ? 1 : 0;
    this.phase = 'day';
    this.startDay(out);
    out.push({ type: 'dayBegin', stage: this.stage, attempt: this.attempt });
    return { ok: true };
  }

  /** guardian·가는 길 무리·추격 무리 배치 */
  private resetExpedition(): void {
    const st = this.stageDef;
    const g = this.data.balance.guardian;
    this.abyss.reset(
      {
        type: st.day.guardian,
        hp: st.day.guardianHp * this.difficulty,
        atk: g.counterAtk * (st.day.boss ? g.bossCounterMult : 1) * this.difficulty,
        atkInterval: g.counterAtkInterval,
        range: g.counterRange,
        boss: st.day.boss ?? false,
      },
      this.expand(st.day.enemies),
      this.expand(st.day.chase),
      this.rng,
    );
  }

  /** 낮 시작 (또는 편성 재시작): 스냅샷 → 레인 비움 → 공격대 1팀 출발 */
  private startDay(out: CoreEvent[]): void {
    this.takeSnapshot();
    this.offenseTimer = this.offenseSeconds;
    this.clearLaneUnits();
    this.wave.stop();
    this.fallen.clear();
    this.siblingsUsed.clear();
    this.endureUsed.clear();
    this.phaseExp = new Map();
    this.coresDone = 0;
    this.autoTimer = this.data.balance.spawn.autoInterval;
    this.autoMergeTimer = 0;
    this.activeTeam.offense = 0;
    for (const r of ROLES) this.resetMomentum(r);
    this.resetExpedition();
    this.enterTeam('offense', out);
  }

  /** 두 레인 위 우리 편·적을 모두 비운다 (단계가 바뀔 때) */
  private clearLaneUnits(): void {
    this.abyss.clear();
    this.defense.units.length = 0;
    this.defense.worries.length = 0;
    this.nightQueue.length = 0;
    this.timedShields = [];
    this.heroUnits.clear();
    this.unitRoles.clear();
    this.reviveTimers.clear();
    this.abyss.atkMult = 1;
    this.defense.atkMult = 1;
  }

  /** 해질녘 (즉시): 낮 레인 비움 → 밤 시작 */
  private dusk(out: CoreEvent[]): void {
    this.offenseTimer = 0;
    this.phase = 'night';
    this.startNight(out);
    out.push({ type: 'dusk', stage: this.stage });
  }

  /** 밤 시작 (또는 편성 재시작): 스냅샷 → 핵이 이야기책에 (HP 가득) → 수비대 1팀 → 스테이지 웨이브 */
  private startNight(out: CoreEvent[]): void {
    this.takeSnapshot();
    this.clearLaneUnits();
    for (const r of ROLES) this.resetMomentum(r);
    this.siblingsUsed.clear();
    this.endureUsed.clear();
    this.phaseExp = new Map();
    this.foughtNight.clear();
    this.coreHp = this.data.balance.core.hp;
    this.autoTimer = this.data.balance.spawn.autoInterval;
    this.autoMergeTimer = 0;
    this.activeTeam.defense = 0;
    const n = this.stageDef.night;
    this.wave.start(
      n.waves.map((w) => swarmGroups(this.data, w)),
      n.bossWave,
    );
    this.enterTeam('defense', out);
  }

  /** 시도를 마치고 기록 (판 stats 누적) */
  private finishAttempt(result: AttemptResult): AttemptStats {
    const a = this.attemptStats;
    a.result = result;
    a.carrySeconds = this.abyss.carryTime;
    if (this.phase === 'night') a.coreHpEnd = this.coreHp;
    this.stats.carrySeconds += a.carrySeconds;
    if (this.replay === null) {
      if (result === 'dayTime') this.stats.dayFailTime += 1;
      else if (result === 'dayFall') this.stats.dayFailFall += 1;
      else if (result === 'returnTime') this.stats.returnFails += 1;
      else if (result === 'night') this.stats.nightFails += 1;
    }
    this.lastAttempt = a;
    this.attemptLog.push(structuredClone(a));
    return a;
  }

  /** 실패 → 레인 비움 → 같은 스테이지 장면 카드 (재도전). 경험치는 × failMult, 그리드는 그대로 */
  private fail(reason: FailReason, out: CoreEvent[]): void {
    this.commitExp(false, out);
    const record = this.finishAttempt(reason);
    this.offenseTimer = 0;
    this.clearLaneUnits();
    for (const r of ROLES) this.resetMomentum(r);
    this.wave.stop();
    this.snapshot = null;
    this.retry = reason;
    this.phase = 'dayStart';
    out.push({ type: 'attemptFail', stage: this.stage, reason, record });
    out.push({ type: 'stageStart', stage: this.stage, retry: reason });
  }

  /** 새벽 (핵 HP > 0): 밤 성공 경험치(싸운 영웅 균등) → 스테이지 성공 → 아침 이야기 한 장 */
  private nightSuccess(out: CoreEvent[]): void {
    const fought = [...this.foughtNight];
    for (const id of fought) this.phaseExp.set(id, (this.phaseExp.get(id) ?? 0) + this.data.balance.exp.nightWin / fought.length);
    this.commitExp(true, out);
    if (this.replay !== null) return this.replaySuccess(out);
    const record = this.finishAttempt('success');
    this.clearLaneUnits();
    for (const r of ROLES) this.resetMomentum(r);
    this.wave.stop();
    this.snapshot = null;
    this.phase = 'diary';
    this.openPage(record);
    out.push({ type: 'stageClear', stage: this.stage, record, notes: this.pageNotes[this.stage] });
  }

  /** 이야기책에 장을 펼치고 플레이 문장을 덧붙인다 (§5.20-8) */
  private openPage(record: AttemptStats): void {
    const first = !this.pages.includes(this.stage);
    this.pages.push(this.stage);
    if (first) this.stageReward(this.pending);
    this.markPerfect(record, this.pending);
    const pl = this.data.chapter.pageLines;
    const st = this.stageDef;
    const notes: string[] = [];
    const carrier = this.abyss.lastCarrier;
    if (carrier) notes.push(fillTemplate(pl.carrier, { hero: this.heroDef(carrier).name, core: st.coreName }));
    if (record.coreHpEnd !== null) {
      const hp = record.coreHpEnd;
      const max = this.data.balance.core.hp;
      notes.push(hp >= max ? pl.hpFull : hp >= max / 2 ? pl.hpMid : pl.hpLow);
    }
    const tries = this.attempts[this.stage - 1];
    if (tries >= 2) notes.push(fillTemplate(st.retryPageLine ?? pl.retry, { n: tries }));
    this.pageNotes[this.stage] = notes;
  }

  /** 이야기 한 장 → 다음 스테이지 장면 카드 */
  nextStage(): boolean {
    if (this.phase !== 'diary') return false;
    this.stage = Math.min(this.chapterLength, this.stage + 1);
    this.retry = null;
    this.phase = 'dayStart';
    this.pending.push({ type: 'stageStart', stage: this.stage, retry: null });
    return true;
  }

  private enterChapterComplete(out: CoreEvent[] = this.pending): void {
    this.offenseTimer = 0;
    this.clearLaneUnits();
    this.wave.stop();
    this.snapshot = null;
    this.completed = true;
    this.phase = 'chapterComplete';
    out.push({ type: 'chapterComplete', completed: true });
    this.joinHeroes((h) => h.reward === this.data.chapter.id, out);
    this.gainBooks('chapter', out);
  }

  /** 이 챕터의 보상 영웅 (heroes.json reward = 챕터 id) */
  get rewardHeroes(): HeroDef[] {
    return this.data.heroes.heroes.filter((h) => h.reward === this.data.chapter.id);
  }

  /** 영웅 합류 (아직 없는 영웅만) */
  private joinHeroes(pred: (h: HeroDef) => boolean, out: CoreEvent[]): void {
    const ids = this.data.heroes.heroes.filter((h) => pred(h) && !this.owned.includes(h.id)).map((h) => h.id);
    if (!ids.length) return;
    for (const id of ids) this.roster.push(emptyProgress(id));
    out.push({ type: 'heroesJoined', ids });
  }

  /**
   * 저장된 경계 상태로 복원 (§5.20-11). 생성자가 쓴 rng는 마지막에 rngState로 되돌린다.
   * 레인 유닛·적·웨이브 진행 상태는 경계에서 항상 비어 있으므로 기본값 그대로.
   */
  static fromSave(data: GameData, save: SaveGame, rng: SeededRng, geometry: GameGeometry, size: GridSize): GameState {
    const g = new GameState(data, size, rng, geometry, save.seed);
    if (g.grid.cells.length !== save.grid.length) throw new Error(`grid 길이 불일치: ${save.grid.length} ≠ ${g.grid.cells.length}`);
    const copy = <T>(v: T): T => structuredClone(v);
    const refill = <T>(dst: T[], src: readonly T[]) => dst.splice(0, dst.length, ...copy(src));

    g.stage = save.stage;
    g.phase = save.phase;
    g.attempt = save.attempt;
    refill(g.attempts, save.attempts);
    g.retry = save.retry;
    g.playTime = save.playTime;
    g.tickCount = save.tickCount;
    g.nextPieceId = save.nextPieceId;
    g.nextUnitId = save.nextUnitId;
    g.autoSkill = save.autoSkill;
    g.coreHp = save.core.hp;
    refill(g.grid.cells, save.grid);
    g.lostReturns = save.lostReturns;
    g.defense.happy.cd = save.happyCd;
    g.defense.nextWorryId = save.nextWorryId;
    Object.assign(g.stats, copy(save.stats));
    refill(g.pages, save.pages);
    for (const [k, v] of Object.entries(save.pageNotes)) g.pageNotes[Number(k)] = copy(v);
    refill(g.attemptLog, save.attemptLog);
    g.lastAttempt = g.attemptLog.length ? g.attemptLog[g.attemptLog.length - 1] : null;
    g.completed = save.completed;
    g.formationSeen = save.formationSeen;
    refill(g.roster, save.roster);
    g.formation = cloneFormation(save.formation);
    g.ink = save.ink;
    g.inkAt = save.inkAt;
    g.stardust = save.stardust;
    refill(g.ownedBooks, save.ownedBooks);
    for (const [k, v] of Object.entries(save.equipped)) g.equipped[k] = [...v];
    refill(g.perfect, save.perfect);
    g.replay = save.replay;
    g.attemptStats = emptyAttemptStats(g.stage, g.attempt + 1, data.balance.grid.maxTier);
    g.pending = [];
    rng.setState(save.rngState);
    return g;
  }

  // ── 성장 (§5.22) ──

  /** 전투 밖 (장면 카드·이야기 한 장·챕터 완성): 잉크 붓기·진급은 여기서만 (단계 스냅샷이 되돌리지 않게) */
  get atBoundary(): boolean {
    return !this.timeFlows;
  }

  /** 잉크 시간 누적 상한 (perHour × capHours) */
  get inkCap(): number {
    const c = this.data.balance.ink;
    return c.perHour * c.capHours;
  }

  /**
   * 잉크 시간 누적 (§5.22-2): 마지막 계산 시각 → now(ms) 사이 시간 × perHour. 시간 누적으로는 inkCap까지만 (보상 잉크는 넘을 수 있음).
   * 시계가 되돌아갔으면 0 (기준 시각만 now로). 처음 부르면 기준 시각만 잡는다. 얻은 잉크를 돌려준다.
   */
  accrueInk(nowMs: number): number {
    if (this.inkAt === null || nowMs < this.inkAt) {
      this.inkAt = nowMs;
      return 0;
    }
    const hours = (nowMs - this.inkAt) / 3_600_000;
    this.inkAt = nowMs;
    const gain = Math.max(0, Math.min(hours * this.data.balance.ink.perHour, this.inkCap - this.ink));
    this.ink += gain;
    this.stats.inkTime += gain;
    return gain;
  }

  /** 다음 레벨까지 필요한 잉크 (상한이면 0) */
  inkToNext(id: string): number {
    const p = this.progressOf(id);
    const cfg = this.data.balance.exp;
    if (p.level >= cfg.maxLevel) return 0;
    return Math.max(0, Math.ceil((levelNeed(cfg, p.level) - p.exp) / this.data.balance.ink.expPerInk - 1e-9));
  }

  /** 잉크 붓기 (§5.22-1): 잉크 amount(내림, 가진 만큼) → 경험치 × expPerInk. 전투 밖에서만. 쓴 잉크·오른 레벨 */
  pourInk(id: string, amount: number): { spent: number; levels: number } {
    const p = this.progressOf(id);
    const cfg = this.data.balance.exp;
    if (!this.atBoundary || p.level >= cfg.maxLevel) return { spent: 0, levels: 0 };
    const spent = Math.max(0, Math.min(Math.floor(amount), Math.floor(this.ink + 1e-9)));
    if (!spent) return { spent: 0, levels: 0 };
    this.ink = Math.max(0, this.ink - spent);
    this.stats.inkSpent += spent;
    const levels = addExp(p, spent * this.data.balance.ink.expPerInk, cfg);
    if (levels) this.pending.push({ type: 'levelUp', heroId: id, level: p.level });
    return { spent, levels };
  }

  /** 진급 비용 (별가루). 최고 ★이면 null */
  promoteCost(id: string): number | null {
    const st = this.data.balance.star;
    const star = this.progressOf(id).star;
    return star >= st.maxStar ? null : (st.cost[star - 1] ?? null);
  }

  /** 진급 (§5.22-3): 별가루를 써서 ★ + 1. 전투 밖에서만 */
  promote(id: string): boolean {
    const cost = this.promoteCost(id);
    if (cost === null || !this.atBoundary || this.stardust < cost) return false;
    this.stardust -= cost;
    this.progressOf(id).star += 1;
    this.stats.dustSpent += cost;
    this.stats.promotions += 1;
    return true;
  }

  /** 배우는 칸 수 (Lv·★ 해금) */
  slotsOf(id: string): number {
    return slotCount(this.progressOf(id), this.data.balance.learn);
  }

  bookDef(bookId: string): BookSkill {
    const b = this.data.bookSkills.books.find((x) => x.id === bookId);
    if (!b) throw new Error(`알 수 없는 비법서: ${bookId}`);
    return b;
  }

  /** 이 영웅이 지금 끼고 있는 비법서 (열린 칸만) */
  booksOf(id: string): string[] {
    const n = this.slotsOf(id);
    return (this.equipped[id] ?? []).slice(0, n).filter((b): b is string => b !== null);
  }

  private bookEffects(id: string): BookSkill[] {
    return this.booksOf(id).map((b) => this.bookDef(b));
  }

  /** 그 비법서를 끼고 있는 영웅 (없으면 null) */
  bookHolder(bookId: string): string | null {
    for (const [id, list] of Object.entries(this.equipped)) if (list.includes(bookId)) return id;
    return null;
  }

  /**
   * 비법서 장착 (§5.22-5, D-067): 영웅 id의 slot 칸에 bookId (null = 빼기). 한 권 = 한 영웅 (다른 영웅이 끼고 있으면 옮겨 옴).
   * 바뀌었고 전투 중이면 편성 변경처럼 단계 재시작.
   */
  equip(id: string, slot: number, bookId: string | null): FormationResult {
    this.progressOf(id);
    if (slot < 0 || slot >= this.slotsOf(id)) return { ok: false, reason: '잠긴 칸' };
    if (bookId !== null && !this.ownedBooks.includes(bookId)) return { ok: false, reason: '없는 비법서' };
    const list = (this.equipped[id] ??= []);
    if ((list[slot] ?? null) === bookId) return { ok: true, restarted: false };
    if (bookId !== null) {
      for (const l of Object.values(this.equipped)) {
        const i = l.indexOf(bookId);
        if (i >= 0) l[i] = null;
      }
    }
    while (list.length <= slot) list.push(null);
    list[slot] = bookId;
    if (this.phase === 'day' || this.phase === 'night') {
      this.restartPhase(this.pending);
      return { ok: true, restarted: true };
    }
    return { ok: true, restarted: false };
  }

  /** 처음 깬 스테이지 보상 (§5.22-2·3): 마지막 장 / 보스 장 / 그 밖 */
  private stageReward(out: CoreEvent[]): void {
    const ink = this.data.balance.ink;
    const st = this.data.balance.star;
    const last = this.stage >= this.chapterLength;
    const boss = this.stageDef.day.boss ?? false;
    const gi = last ? ink.finalClear : boss ? ink.bossClear : ink.firstClear;
    const gd = last ? st.dustFinal : boss ? st.dustBoss : st.dustFirstClear;
    this.ink += gi;
    this.stats.inkReward += gi;
    this.stardust += gd;
    this.stats.dustEarned += gd;
    out.push({ type: 'stageReward', stage: this.stage, ink: gi, dust: gd });
  }

  /**
   * 흠집 없음 (§5.22-6): 그 장 밤을 핵 HP 가득으로 지킴. 밤이 없는 마지막 장은 깨면 흠집 없음.
   * 챕터 모든 장이 흠집 없음이면 숨은 비법서. 이번에 흠집 없음이었는지 돌려준다
   */
  private markPerfect(record: AttemptStats, out: CoreEvent[]): boolean {
    const ok = record.coreHpEnd === null ? this.stage >= this.chapterLength : record.coreHpEnd >= this.data.balance.core.hp - 1e-9;
    if (!ok) return false;
    if (!this.perfect.includes(this.stage)) {
      this.perfect.push(this.stage);
      out.push({ type: 'perfectPage', stage: this.stage });
      if (this.perfect.length >= this.chapterLength) this.gainBooks('perfect', out);
    }
    return true;
  }

  /** 비법서 얻기 (그 챕터·얻는 법, 이미 있으면 건너뜀) */
  private gainBooks(source: BookSkill['source'], out: CoreEvent[]): void {
    const ids = this.data.bookSkills.books
      .filter((b) => b.source === source && b.chapter === this.data.chapter.id && !this.ownedBooks.includes(b.id))
      .map((b) => b.id);
    if (!ids.length) return;
    this.ownedBooks.push(...ids);
    out.push({ type: 'booksGained', ids, source });
  }

  /** 다시 읽기 시작 (§5.22-6): 챕터 완성 뒤, 장 하나를 장면 카드부터 */
  startReplay(stage: number): boolean {
    if (this.phase !== 'chapterComplete' || this.completed !== true) return false;
    if (stage < 1 || stage > this.chapterLength) return false;
    this.replay = stage;
    this.stage = stage;
    this.retry = null;
    this.phase = 'dayStart';
    this.pending.push({ type: 'stageStart', stage, retry: null });
    return true;
  }

  /** 다시 읽기 그만 (장면 카드에서): 이야기책(챕터 완성)으로 */
  exitReplay(): boolean {
    if (this.replay === null || this.phase !== 'dayStart') return false;
    const stage = this.replay;
    this.endReplay();
    this.pending.push({ type: 'replayEnd', stage, success: false, perfect: false, ink: 0 });
    return true;
  }

  private endReplay(): void {
    this.replay = null;
    this.retry = null;
    this.stage = this.chapterLength;
    this.phase = 'chapterComplete';
  }

  /** 다시 읽기 성공: 잉크 + 흠집 없음 판정 → 챕터 완성 화면으로 */
  private replaySuccess(out: CoreEvent[]): void {
    const record = this.finishAttempt('success');
    this.clearLaneUnits();
    for (const r of ROLES) this.resetMomentum(r);
    this.wave.stop();
    this.snapshot = null;
    this.offenseTimer = 0;
    const stage = this.stage;
    const ink = this.data.balance.ink.replayWin;
    this.ink += ink;
    this.stats.inkReward += ink;
    this.stats.replayWins += 1;
    const perfect = this.markPerfect(record, out);
    this.endReplay();
    out.push({ type: 'replayEnd', stage, success: true, perfect, ink });
  }

  // ── 조각 생성 (§5.20-4·13): 저절로·처치 드롭만 (makePiece) ──

  /** 지금 생성될 수 있는 체인 = 레인 팀(전투 밖이면 다음에 나갈 공격대 팀) 영웅들의 체인 (중복 제거) */
  get spawnChains(): string[] {
    const ids = this.activeTeamIds(this.laneRole);
    const chains = [...new Set(ids.map((id) => this.heroDef(id).chain))];
    return chains.length ? chains : this.data.chains.map((c) => c.archetypeId);
  }

  // ── 드래그 ──

  /**
   * 자동 뭉침 쌍 (D-070): autoMergeMaxTier 이하, 와일드카드·잡고 있는 칸 제외, 같은 체인·같은 단계 두 조각.
   * 고르는 순서: 낮은 단계 먼저 → 합쳐질 칸(to, 작은 번호) → 옮겨 올 칸(from, to 다음으로 작은 번호). 없으면 null
   */
  /** 자동 뭉침 단계 상한 (0 = 끔). 이 단계 이하 같은 조각은 손으로 합칠 필요가 없다 */
  get autoMergeMaxTier(): number {
    return this.data.balance.grid.autoMergeMaxTier;
  }

  autoMergePair(): { from: number; to: number } | null {
    const max = this.autoMergeMaxTier;
    const cells = this.grid.cells;
    let best: { from: number; to: number; tier: number } | null = null;
    for (let to = 0; to < cells.length; to++) {
      const a = cells[to];
      if (!a || isWildcard(a) || a.tier > max || a.tier >= this.grid.maxTier || this.heldCells.has(to)) continue;
      if (best && a.tier >= best.tier) continue;
      for (let from = to + 1; from < cells.length; from++) {
        const b = cells[from];
        if (!b || isWildcard(b) || this.heldCells.has(from) || b.chain !== a.chain || b.tier !== a.tier) continue;
        best = { from, to, tier: a.tier };
        break;
      }
    }
    return best && { from: best.from, to: best.to };
  }

  private stepAutoMerge(out: CoreEvent[]): void {
    this.autoMergeTimer = Math.max(0, this.autoMergeTimer - FIXED_DT);
    if (this.autoMergeTimer > TICK_EPS) return;
    const pair = this.autoMergePair();
    if (!pair) return;
    this.autoMergeTimer = this.data.balance.grid.autoMergeInterval;
    this.autoMerges += 1;
    out.push({ type: 'autoMerge', from: pair.from, to: pair.to });
    this.drop(pair.from, pair.to);
  }

  /** 드롭: 머지 / 교환·이동. 전투 중 머지면 버프 + 병사 + 스킬 게이지 */
  drop(from: number, to: number | null): DropKind {
    const kind = applyDrop(this.grid, from, to);
    if (kind === 'merge') {
      this.attemptStats.merges += 1;
      const p = this.grid.cells[to!]!;
      if (p.tier >= 3) this.stats.tier3ByChain[p.chain] = (this.stats.tier3ByChain[p.chain] ?? 0) + 1;
      if (p.tier >= this.data.balance.grid.maxTier) this.stats.tier5Made += 1;
      if (this.inBattle) this.battleMerge(p, to!);
    }
    return kind;
  }

  /** 지금 이 체인을 머지하면 때 맞춤인지 ([11]-2): 낮 sun / 밤 moon */
  isAffinity(chain: string): boolean {
    const role = this.fightingRole;
    const c = this.data.chains.find((x) => x.archetypeId === chain);
    if (!role || !c) return false;
    return (role === 'offense' && c.side === 'sun') || (role === 'defense' && c.side === 'moon');
  }

  /**
   * 전투 중 머지 (§5.17-3, [11]-1·2, §5.20-5). 결과 조각 p(그리드에 남음)의 체인 기준.
   * 버프: heal = 팀 영웅 즉시 회복 / momentum = 기세 중첩 (결과 3단계 이상이면 × tier3Mult)
   * 병사: 결과 2~5단계 = 1~4단. 상한이면 버프만. 때 맞춤이면 병사 능력치·버프·특별 버프 × affinityMult
   * 스킬 게이지: 레인에 있는 그 체인 주인 영웅 + tierPoints (5단계 = 즉시 가득). 5단계 = 특별 버프
   */
  private battleMerge(p: Piece, cell: number): void {
    const role = this.fightingRole!;
    const b = this.data.balance;
    const c = this.data.chains.find((x) => x.archetypeId === p.chain)!;
    const big = p.tier >= 3;
    const affinity = this.isAffinity(p.chain);
    const mult = affinity ? b.merge.affinityMult : 1;
    this.stats.battleMerges += 1;
    this.attemptStats.battleMerges += 1;
    if (affinity) this.stats.affinityMerges += 1;

    // 버프 (지금 싸우는 팀)
    if (c.buff === 'heal') {
      let healed = 0;
      for (const u of this.teamUnits(role)) {
        const before = u.hp;
        u.hp = Math.min(u.maxHp, u.hp + u.maxHp * b.buff.healPct * (big ? b.buff.tier3Mult : 1) * mult);
        healed += u.hp - before;
      }
      this.stats.buffHeal += healed;
      this.pending.push({ type: 'buff', role, kind: 'heal', amount: healed, stacks: 0, affinity, cell });
    } else {
      const m = this.momentum[role];
      const add = big ? b.buff.tier3Mult : 1;
      for (let k = 0; k < add && m.stacks < b.buff.momentumMaxStacks; k++) {
        m.stacks += 1;
        m.bonus += b.buff.momentumAtkPct * mult;
      }
      m.timer = b.buff.momentumSeconds;
      this.applyMomentum(role);
      this.pending.push({ type: 'buff', role, kind: 'momentum', amount: m.bonus, stacks: m.stacks, affinity, cell });
    }

    // 5단계 특별 버프 (§5.18-9)
    const top = p.tier >= b.skill.fullAtTier;
    if (top) this.special(role, c.side, mult, affinity, cell);

    // 스킬 게이지: 레인에 있는 체인 주인
    for (const id of this.activeTeamIds(role)) {
      if (this.heroDef(id).chain !== p.chain || !this.heroUnit(id)) continue;
      const prog = this.progressOf(id);
      const max = this.skillOf(id).gauge;
      if (top) prog.gauge = max;
      else prog.gauge = Math.min(max, prog.gauge + (b.skill.tierPoints[p.tier - 1] ?? 0) * this.bondEffect(id).gaugeMult);
      this.pending.push({ type: 'gauge', heroId: id, gauge: prog.gauge, max });
      // 자동이면 차는 즉시, 수동이면 탭(castReady)을 기다린다. 5단계는 수동이어도 즉시 (§5.20-13)
      if ((this.autoSkill || top) && this.skillReady(id)) this.fireSkill(role, id, this.pending);
    }

    // 병사
    if (!b.merge.soldiers) return;
    const level = Math.min(c.soldier.levels.length, Math.max(1, p.tier - 1));
    const lane = this.laneOf(role);
    if (lane.soldierCount >= b.merge.soldierCap || lane.pickSlot() === null) {
      this.stats.soldiersCapped += 1;
      this.attemptStats.soldiersCapped += 1;
      this.pending.push({ type: 'soldier', role, unitId: null, chain: p.chain, level, affinity, cell, capped: true });
      return;
    }
    const lv = c.soldier.levels[level - 1];
    const stats: CombatStats = { hp: lv.hp * mult, atk: lv.atk * mult, atkInterval: lv.atkInterval, range: lv.range };
    const u = lane.addUnit(this.nextUnitId++, sideOf(role), p.chain, level, stats, {
      role: 'soldier',
      soldier: c.soldier.kind,
      life: b.merge.soldierLifetime,
      attackType: 'melee',
      ...(lv.slow !== undefined ? { slow: lv.slow, slowSeconds: lv.slowSeconds ?? 0 } : {}),
    })!;
    this.unitRoles.set(u.id, 'soldier');
    this.stats.soldiersSpawned += 1;
    this.attemptStats.soldiers += 1;
    const key = `${p.chain}:${level}`;
    this.stats.soldiersByKind[key] = (this.stats.soldiersByKind[key] ?? 0) + 1;
    this.pending.push({ type: 'soldier', role, unitId: u.id, chain: p.chain, level, affinity, cell, capped: false });
  }

  /** 지금 레인의 적 (스킬 대상). 낮이면 guardian도 */
  private foes(role: Role): Foe[] {
    if (role === 'defense') return this.defense.worries.filter((w) => w.hp > 0);
    const list: Foe[] = this.abyss.enemies.filter((e) => e.hp > 0);
    const g = this.abyss.guardian;
    const wallY = this.abyss.geo.wallY;
    if (g.hp > 0) {
      list.push({
        get hp() {
          return g.hp;
        },
        set hp(v: number) {
          g.hp = v;
        },
        y: wallY,
        get slowTimer() {
          return g.slowTimer;
        },
        set slowTimer(v: number) {
          g.slowTimer = v;
        },
        get slowMult() {
          return g.slowMult;
        },
        set slowMult(v: number) {
          g.slowMult = v;
        },
      });
    }
    return list;
  }

  /** 레인의 우리 편 (영웅·병사) */
  private allies(role: Role): Unit[] {
    return this.laneOf(role).units.filter((u) => u.hp > 0);
  }

  private skillHit(f: Foe, dmg: number): void {
    f.hp -= dmg;
    this.stats.damageSkill += dmg;
  }

  /** 게이지가 가득이고 레인에 서 있는 영웅 (수동 모드에서 원형 버튼이 빛남) */
  skillReady(id: string): boolean {
    const role = this.fightingRole;
    if (!role || !this.activeTeamIds(role).includes(id) || !this.heroUnit(id)) return false;
    return this.progressOf(id).gauge >= this.skillOf(id).gauge - 1e-9;
  }

  /** 게이지를 비우고 발동 */
  private fireSkill(role: Role, id: string, out: CoreEvent[]): void {
    this.progressOf(id).gauge = 0;
    this.castSkill(role, id, out);
  }

  /** 수동 발동 (원형 버튼 탭): 게이지가 찬 레인 영웅이면 발동하고 true */
  castReady(id: string): boolean {
    const role = this.fightingRole;
    if (!role || !this.skillReady(id)) return false;
    this.fireSkill(role, id, this.pending);
    return true;
  }

  /** HUD [자동] 토글 */
  setAutoSkill(on: boolean): void {
    if (this.autoSkill === on) return;
    this.autoSkill = on;
    this.pending.push({ type: 'autoSkill', on });
  }

  /** 스킬 발동 (§5.20-5, 1★) */
  private castSkill(role: Role, id: string, out: CoreEvent[]): void {
    const u = this.heroUnit(id);
    if (!u) return;
    const sk = this.skillOf(id);
    const mult = this.laneOf(role).atkMult;
    this.stats.skillCasts[id] = (this.stats.skillCasts[id] ?? 0) + 1;
    this.attemptStats.skills += 1;
    const foes = this.foes(role);
    switch (sk.kind) {
      case 'strike': {
        const near = [...foes].sort((a, b) => Math.abs(a.y - u.y) - Math.abs(b.y - u.y)).slice(0, sk.pierce);
        for (const f of near) this.skillHit(f, u.atk * sk.mult * mult);
        break;
      }
      case 'ward': {
        for (const f of foes) if (Math.abs(f.y - u.y) <= sk.radius) stun(f, sk.stunSeconds);
        for (const a of this.teamUnits(role)) a.shield += a.maxHp * sk.shieldPct;
        break;
      }
      case 'beam': {
        for (const f of foes) this.skillHit(f, u.atk * sk.mult * mult);
        break;
      }
      case 'mend': {
        for (const a of this.teamUnits(role)) a.hp = Math.min(a.maxHp, a.hp + a.maxHp * sk.healPct);
        let left = sk.revive;
        const ratio = this.data.balance.hero.reviveHpRatio;
        for (const other of this.activeTeamIds(role)) {
          if (left <= 0) break;
          if (role === 'offense' && this.fallen.has(other)) {
            this.fallen.delete(other);
            this.enterHero(role, other, out, { hpRatio: ratio, revive: true, y: u.y });
            left -= 1;
          } else if (role === 'defense' && this.reviveTimers.has(other)) {
            this.reviveTimers.delete(other);
            this.enterHero(role, other, out, { hpRatio: ratio, revive: true });
            left -= 1;
          }
        }
        break;
      }
    }
    out.push({ type: 'skill', role, heroId: id, unitId: u.id, kind: sk.kind, name: sk.name });
  }

  /** 5단계 특별 버프: 해 = 한낮 (우리 편 atk +, 초) / 달 = 보름달 (적 정지 + 보호막) */
  private special(role: Role, side: 'sun' | 'moon', mult: number, affinity: boolean, cell: number): void {
    const s = this.data.balance.special;
    this.stats.specials += 1;
    if (side === 'sun') {
      this.noon[role] = { timer: s.noonSeconds, pct: s.noonAtkPct * mult };
      this.laneOf(role).atkMult = 1 + this.noon[role].pct;
    } else {
      for (const f of this.foes(role)) stun(f, s.fullMoonStunSeconds);
      for (const a of this.allies(role)) a.shield += a.maxHp * s.fullMoonShieldPct * mult;
    }
    this.pending.push({ type: 'special', role, kind: side === 'sun' ? 'noon' : 'fullMoon', affinity, cell });
  }

  // ── 놓아주기 ──

  /** 놓아주기 영역에 드롭: 즉시 제거 (환급 없음, §5.20-13). 빈 칸·와일드카드는 무시하고 false (원위치) */
  release(index: number): boolean {
    const p = releaseAt(this.grid, index);
    if (!p) return false;
    this.attemptStats.releases += 1;
    if (p.tier < this.attemptStats.releaseTiers.length) this.attemptStats.releaseTiers[p.tier] += 1;
    return true;
  }

  // ── 조각 만들기 ──

  newPiece(chain: ChainId | typeof WILDCARD, tier: number): Piece {
    return { id: this.nextPieceId++, chain, tier: chain === WILDCARD ? WILDCARD_TIER : tier, bornAt: this.playTime };
  }

  // ── 디버그 (?debug=1) ──

  /** 빈 칸 랜덤 위치에 지급. 칸이 없으면 null */
  debugGrant(chain: ChainId | typeof WILDCARD, tier: number): number | null {
    const index = pickEmpty(this.rng, this.grid);
    if (index === null) return null;
    this.grid.cells[index] = this.newPiece(chain, tier);
    return index;
  }

  /** guardian HP 0 → 다음 틱에 핵 획득 (운반 시작) */
  debugKillGuardian(): void {
    if (this.phase === 'day') this.abyss.guardian.hp = 0;
  }

  /** 낮 레인 우리 편 전멸 → 다음 틱에 사망 처리 (다음 팀 / 낮 실패) */
  debugKillAbyssUnits(): void {
    for (const u of this.abyss.units) u.hp = 0;
  }

  /** 밤 팀 영웅 hp 0 → 다음 틱에 쓰러짐 */
  debugKnockDefenseHero(): void {
    for (const u of this.teamUnits('defense')) u.hp = 0;
  }

  /** 레인 팀 영웅 스킬을 바로 발동 */
  debugCastSkills(): void {
    const role = this.fightingRole;
    if (!role) return;
    for (const id of this.activeTeamIds(role)) {
      if (!this.heroUnit(id)) continue;
      this.fireSkill(role, id, this.pending);
    }
  }

  /** 낮 즉시 성공 (핵을 이야기책에) → 해질녘 */
  debugToNight(): void {
    if (this.phase !== 'day') return;
    this.abyss.lastCarrier ??= this.activeTeamIds('offense')[0] ?? null;
    this.daySuccess(this.pending);
  }

  /** 밤 즉시 성공 → 이야기 한 장 */
  debugEndNight(): void {
    if (this.phase !== 'night') return;
    this.nightSuccess(this.pending);
  }

  /** 지금 시도를 즉시 실패시킨다 (낮: 시간 초과 / 밤: 핵 HP 0) */
  debugFail(): void {
    if (this.phase === 'day') this.fail(this.abyss.guardianDown ? 'returnTime' : 'dayTime', this.pending);
    else if (this.phase === 'night') {
      this.coreHp = 0;
      this.fail('night', this.pending);
    }
  }

  /** 즉시 챕터 완성: 레인을 비우고 chapterComplete */
  debugCompleteChapter(): void {
    if (this.phase === 'chapterComplete') return;
    this.enterChapterComplete();
  }

  /** 스테이지를 바로 바꾼다 (장면 카드로). 경계(dayStart·diary)에서만 */
  debugSetStage(stage: number): void {
    if (this.phase !== 'dayStart' && this.phase !== 'diary') return;
    this.stage = Math.max(1, Math.min(this.chapterLength, Math.floor(stage)));
    this.retry = null;
    this.phase = 'dayStart';
    this.pending.push({ type: 'stageStart', stage: this.stage, retry: null });
  }

  /** 영웅 전부 지급: 시작 + 챕터 보상 (테스트 영웅 제외, §5.20-1) */
  debugGrantAllHeroes(): void {
    this.joinHeroes((h) => h.reward !== 'debug', this.pending);
  }

  /** 별가루 지급 */
  debugAddDust(n: number): void {
    this.stardust += n;
  }

  /** 이 챕터 비법서 전부 지급 */
  debugGrantBooks(): void {
    this.gainBooks('chapter', this.pending);
    this.gainBooks('perfect', this.pending);
  }

  /** 테스트 영웅 2명 추가 (reward "debug") */
  debugGrantTestHeroes(): void {
    this.joinHeroes((h) => h.reward === 'debug', this.pending);
  }
}
