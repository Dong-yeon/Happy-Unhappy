// 한 판(1챕터)의 core 상태: 스테이지 진행, 기쁨, 누적 게임 시간, 조각 id, 그리드, 두 레인, 밤 웨이브, 핵, 이야기책.
// Phaser 의존 없음. scene은 이 객체의 메서드를 호출하고 결과를 표시만 한다.
// 시간은 고정 틱(FIXED_DT)으로만, 그리고 낮(오펜스)·밤(디펜스)에만 흐른다.
//
// v0.15 (§5.19, D-053·D-054·D-055):
//   스테이지 1-n = 장면 카드 → 낮(핵 찾아 돌아오기) → 해질녘 → 밤(핵 지키기) → 아침 이야기 한 장 → 다음 스테이지
//   낮 실패(시간 초과·가는 길 쓰러짐) → 밤 없이 같은 스테이지 낮부터 / 밤 실패(핵 HP 0) → 같은 스테이지 낮부터. 횟수 제한 없음
//   실패해도 영웅 강화·그리드 조각·기쁨은 남는다. 일차·gating·그림자·역류 없음. 밤 구성은 stages.json 고정 (낮 결과와 무관)
//   영웅은 판 내내 모험대 두 명(삽살·해태, D-057)을 낮덱/밤덱에 하나씩. 머지 조각은 영웅에게 먹이는 강화 재료.
//   전투 중 머지 → 지금 싸우는 쪽 영웅 버프(떡 회복 / 동아줄 기세) + 그 레인에 병사 자동 출전 (때 맞춤이면 × affinityMult).

import type { ChainGrowth, CombatStats, EnemyGroup, GameData, HeroDef, StageDef } from '../data/types';
import { crossroadById, emptyAttemptStats, type AttemptResult, type AttemptStats, type CrossroadCard, type DayPhase, type FailReason } from './day';
import { Expedition, type EnemyStats, type ExpeditionEvent } from './expedition';
import {
  WILDCARD,
  WILDCARD_TIER,
  applyDrop,
  createGrid,
  pickChain,
  pickEmpty,
  releaseAt,
  releaseValue,
  spawnBlock,
  spawnCost,
  type ChainId,
  type DropKind,
  type Grid,
  type GridSize,
  type Piece,
  type SpawnBlock,
  isWildcard,
  toCell,
} from './grid';
import {
  FIXED_DT,
  Lane,
  TICK_RATE,
  type AbyssGeometry,
  type LaneEvent,
  type LaneGeometry,
  type Side,
  type Unit,
  type UnitHost,
  type UnitRole,
  type WorryStats,
} from './lane';
import type { SeededRng } from './rng';
import type { SaveGame } from './save';
import { emptyGameStats, type GameStats } from './stats';
import { NightWaves, interleave } from './wave';

/** 덱: 낮 = 오펜스, 밤 = 디펜스 (§5.17-10) */
export type Role = 'offense' | 'defense';
export const ROLES: readonly Role[] = ['offense', 'defense'];

/** 먹이기 불가 사유: 빈 칸 / 와일드카드 / 지금 단계에서는 못 먹임 */
export type FeedBlock = 'empty' | 'wildcard' | 'closed';

/** 두 레인의 좌표 (scene의 layout.ts에서 만든다) */
export interface GameGeometry {
  defense: LaneGeometry;
  abyss: AbyssGeometry;
}

/** 영웅 한 명의 판 상태 (덱 자리마다) */
export interface HeroState {
  /** heroes.json id */
  id: string;
  /** 체인별 먹인 점수 누계 (§5.17-2) */
  points: Record<string, number>;
  /** 기세 (§5.17-3): 중첩 수·atk 보너스 합·남은 초 */
  momentum: { stacks: number; bonus: number; timer: number };
}

/** 먹이기 기록 (metrics) */
export interface FeedRecord {
  t: number;
  /** 판 통산 시도 번호 */
  attempt: number;
  stage: number;
  role: Role;
  hero: string;
  chain: string;
  tier: number;
  points: number;
  cell: { col: number; row: number };
  /** 조각 보유 시간 = t - bornAt */
  heldFor: number;
}

/** 지급 조각 (갈림길 보너스·보스 와일드카드): 빈 칸에, 없으면 사라짐 (귀환 큐 없음, §5.17-5) */
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

export type CoreEvent =
  | LaneEvent
  | ExpeditionEvent
  /** 장면 카드 (스테이지 시작·실패 뒤 재도전) */
  | { type: 'stageStart'; stage: number; retry: FailReason | null; crossroad: boolean }
  /** 장면 카드를 닫고 낮 시작 */
  | { type: 'dayBegin'; stage: number; attempt: number }
  | { type: 'freePiece'; grant: Grant }
  /** 영웅이 레인에 섬 (단계 시작·쓰러진 뒤 일어남) */
  | { type: 'heroEnter'; role: Role; unitId: number; revive: boolean }
  /** 영웅 쓰러짐 → reviveSeconds 뒤 일어남 (밤 영웅, 낮 운반 중 영웅) */
  | { type: 'heroDown'; role: Role; unitId: number; seconds: number }
  /** guardian을 쓰러뜨려 핵을 찾음 (핵 카드). bonus = 갈림길 face 보너스 조각 */
  | { type: 'coreFound'; stage: number; bonus: Grant[] }
  /** 먹이기 */
  | { type: 'feed'; role: Role; cell: number; chain: string; tier: number; points: number }
  /** 전투 중 머지 버프 */
  | { type: 'buff'; role: Role; kind: 'heal' | 'momentum'; amount: number; stacks: number; affinity: boolean; cell: number }
  /** 전투 중 머지 병사 출전 (capped: 상한이라 병사 없음) */
  | { type: 'soldier'; role: Role; unitId: number | null; chain: string; level: number; affinity: boolean; cell: number; capped: boolean }
  /** 해질녘: 핵을 이야기책에 가져옴 → 밤 시작 */
  | { type: 'dusk'; stage: number }
  /** 밤: 적이 거점에 닿아 핵 HP 감소 */
  | { type: 'coreHit'; hp: number; damage: number; boss: boolean }
  /** 보스 스테이지 핵을 가져옴 → 와일드카드 */
  | { type: 'bossReward'; rewards: Grant[] }
  /** 시도 실패 → 같은 스테이지 장면 카드 */
  | { type: 'attemptFail'; stage: number; reason: FailReason; record: AttemptStats }
  /** 스테이지 성공 → 아침 이야기 한 장 (1-length면 바로 챕터 완성) */
  | { type: 'stageClear'; stage: number; record: AttemptStats }
  | { type: 'chapterComplete'; completed: true }
  /** 보상 영웅 합류 (챕터 완성·디버그, D-057) */
  | { type: 'heroesJoined'; ids: string[] };

export type ConfirmResult = { ok: true } | { ok: false; reason: 'notDayStart' | 'needChoice' | 'badChoice' };
export type FeedResult = { ok: true; points: number } | { ok: false; reason: FeedBlock };

export type { GameStats } from './stats';

/** 레인 쪽: 오펜스 = 낮 레인(unhappy), 디펜스 = 방어(happy). Side는 레인 이벤트·표시용 이름 그대로 */
export function sideOf(role: Role): Side {
  return role === 'offense' ? 'unhappy' : 'happy';
}

/** 적 능력치 (§5.19-5): base × 종류 배수, HP는 × hpGrowthPerStage^(스테이지-1) */
export function enemyStats(data: GameData, type: string, stage: number): EnemyStats {
  const d = data.monsters.enemies.find((e) => e.id === type);
  if (!d) throw new Error(`알 수 없는 적: ${type}`);
  const b = data.monsters.base;
  return {
    type,
    hp: b.hp * d.hpMult * Math.pow(data.balance.enemy.hpGrowthPerStage, stage - 1),
    speed: b.speed * d.speedMult,
    atk: b.atk * d.atkMult,
    atkInterval: b.atkInterval,
    joyReward: b.joyReward,
  };
}

export function enemyName(data: GameData, type: string): string {
  return data.monsters.enemies.find((e) => e.id === type)?.name ?? type;
}

/** 부동소수 누적 오차로 틱이 하나 빠지지 않도록 */
const TICK_EPS = 1e-9;

export class GameState {
  /** 누적 게임 시간(초, 배속 반영). Piece.bornAt 기준 */
  playTime = 0;
  joy: number;
  nextPieceId = 1;
  /** 이번 시도 생성 횟수 (생성 비용). 장면 카드를 닫을 때 0 */
  spawnedAttempt = 0;
  readonly grid: Grid;
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
  readonly feedLog: FeedRecord[] = [];
  /** 낮(오펜스) 남은 시간(초) */
  offenseTimer = 0;
  /** 밤 영웅 쓰러짐: 일어나기까지 남은 초 (0 = 서 있음) */
  defenseDown = 0;
  /** 낮 운반 중 쓰러짐: 일어나기까지 남은 초 · 쓰러진 자리 */
  offenseDown = 0;
  private offenseFallY = 0;
  /** 밤 핵 HP (§5.19-3) */
  coreHp: number;

  // ── 영웅 (§5.17-1, [11]-3) ──
  readonly heroes: Record<Role, HeroState>;
  /** 판 시작(1-1 첫 장면 카드) 배정을 마쳤는지. 첫 카드를 닫으면 true (판 중 변경은 M8.11) */
  assignmentDone = false;
  /** 합류한 보상 영웅 id (챕터 완성, D-057). 덱 화면(M8.11) 전까지는 명단에만 있다 */
  readonly joinedHeroes: string[] = [];
  /** 레인 위 영웅 유닛 id (그 단계에만) */
  private heroUnit: Record<Role, number | null> = { offense: null, defense: null };
  /** 레인 유닛 id → 역할 (피해 비중 집계). 단계가 바뀔 때 비운다 */
  private unitRoles = new Map<number, UnitRole>();

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
  /** 갈림길 선택 flag ("avoid" | "face") */
  readonly flags: string[] = [];
  /** 1-turningPoint 성공 → 다음 장면 카드 = 갈림길 */
  pendingCrossroad = false;
  /** 갈림길 face: 이번 시도 guardian HP 감소 비율 (첫 시도만) · guardian 처치 때 조각 +1 */
  private faceReduce = 0;
  private faceBonus = false;
  /** 판의 끝 (chapterComplete): 완성 true. 그 전에는 null (D-054: 미완성 끝 없음) */
  completed: true | null = null;

  /** 저장(save.ts)이 읽고 쓴다 */
  nextUnitId = 1;
  /** 아직 틱으로 처리하지 않은 시간 */
  private acc = 0;
  /** 틱 밖(먹이기·단계 전환 등)에서 생긴 이벤트. 다음 tick()의 반환값에 앞서 포함된다 */
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
    this.joy = b.start.joy;
    this.coreHp = b.core.hp;
    this.grid = createGrid(size, b.grid.maxTier);
    const need = b.merge.soldierCap + 1;
    for (const [name, g] of [
      ['방어선', geometry.defense],
      ['낮 레인', geometry.abyss],
    ] as const) {
      if (g.slotXs.length < need) throw new Error(`${name} 슬롯 수(${g.slotXs.length}) < 영웅 1 + soldierCap(${need})`);
    }
    const intercept = { range: b.lane.defenseInterceptRange, speed: b.lane.defenseMoveSpeed, contact: b.lane.defenseContact };
    this.defense = new Lane('defense', geometry.defense, b.happy, intercept);
    this.abyss = new Expedition(geometry.abyss, { advanceSpeed: b.lane.abyssAdvanceSpeed, carry: b.carry, escort: intercept });
    this.wave = new NightWaves(b.wave);
    const h = data.heroes;
    const [off, def] = b.start.swapHeroes ? [h.defense, h.offense] : [h.offense, h.defense];
    this.heroes = { offense: emptyHero(off), defense: emptyHero(def) };
    this.attempts = new Array<number>(b.chapter.length).fill(0);
    this.attemptStats = emptyAttemptStats(1, 1, this.joy, b.grid.maxTier);
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

  /** 지금 장면 카드가 갈림길이면 그 카드 */
  get crossroad(): CrossroadCard | null {
    if (this.phase !== 'dayStart' || !this.pendingCrossroad) return null;
    const c = crossroadById(this.data, this.data.chapter.crossroad);
    if (!c) throw new Error(`갈림길 이벤트 없음: ${this.data.chapter.crossroad}`);
    return c;
  }

  /** 갈림길 선택지 (없으면 빈 배열) */
  get choices(): { id: string; label: string }[] {
    return this.crossroad?.event.choices.map((c) => ({ id: c.id, label: c.label })) ?? [];
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

  /** 지금 싸우는 쪽 (낮 = 오펜스, 밤 = 디펜스). 전투 밖이면 null */
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

  heroDef(role: Role): HeroDef {
    const id = this.heroes[role].id;
    const h = this.data.heroes.heroes.find((x) => x.id === id);
    if (!h) throw new Error(`알 수 없는 영웅: ${id}`);
    return h;
  }

  /**
   * 영웅 능력치 (기세 제외, §5.17-2): 점수 1당 체인 성장.
   * maxHp = hp + Σ maxHp·점수 / atk = atk + Σ atk·점수 / atkInterval = max(하한, base × (1 − Σ atkIntervalPct·점수))
   * 받는 피해 = 1 − min(상한, Σ dmgReduce·점수)
   */
  heroStats(role: Role): CombatStats & { dmgMult: number } {
    const base = this.heroDef(role);
    const pts = this.heroes[role].points;
    const sum = (k: keyof ChainGrowth) => this.data.chains.reduce((s, c) => s + (c.growth[k] ?? 0) * (pts[c.archetypeId] ?? 0), 0);
    const h = this.data.balance.hero;
    return {
      hp: base.hp + sum('maxHp'),
      atk: base.atk + sum('atk'),
      atkInterval: Math.max(h.atkIntervalMin, base.atkInterval * (1 - sum('atkIntervalPct'))),
      range: base.range,
      dmgMult: 1 - Math.min(h.dmgReduceMax, sum('dmgReduce')),
    };
  }

  /** 레인 위 영웅 유닛 (없으면 null: 단계 밖·쓰러짐) */
  heroUnitOf(role: Role): Unit | null {
    const id = this.heroUnit[role];
    return id === null ? null : (this.laneOf(role).units.find((u) => u.id === id) ?? null);
  }

  /** 판 시작(1-1 첫 장면 카드) 영웅 배정: 낮덱(오펜스)에 offenseId, 밤덱에 다른 한 명 ([11]-3). 그 밖에는 false */
  assignHeroes(offenseId: string): boolean {
    if (this.assignmentDone || this.phase !== 'dayStart') return false;
    const pair = [this.heroes.offense.id, this.heroes.defense.id];
    if (!pair.includes(offenseId)) return false;
    if (this.heroes.offense.id !== offenseId) {
      const t = this.heroes.offense;
      this.heroes.offense = this.heroes.defense;
      this.heroes.defense = t;
    }
    return true;
  }

  /** 영웅을 레인에 (단계 시작: hp 가득 / 일어남: hp × reviveHpRatio, 낮이면 쓰러진 자리에서) */
  private enterHero(role: Role, out: CoreEvent[], hpRatio = 1, revive = false, y?: number): void {
    const s = this.heroStats(role);
    const lane = this.laneOf(role);
    const u = lane.addUnit(this.nextUnitId++, sideOf(role), this.heroes[role].id, 0, s, {
      role: 'hero',
      dmgMult: s.dmgMult,
      hp: s.hp * hpRatio,
      ...(y !== undefined ? { y } : {}),
    })!;
    this.heroUnit[role] = u.id;
    this.unitRoles.set(u.id, 'hero');
    this.applyMomentum(role);
    out.push({ type: 'heroEnter', role, unitId: u.id, revive });
  }

  /** 기세 반영: 영웅 유닛 atk = 기본 atk × (1 + 보너스) */
  private applyMomentum(role: Role): void {
    const u = this.heroUnitOf(role);
    if (u) u.atk = this.heroStats(role).atk * (1 + this.heroes[role].momentum.bonus);
  }

  private resetMomentum(role: Role): void {
    this.heroes[role].momentum = { stacks: 0, bonus: 0, timer: 0 };
  }

  /** 기세 시간 감소 (전투 중, 지금 싸우는 쪽만). 다 되면 모든 중첩이 함께 사라진다 */
  private tickMomentum(role: Role): void {
    const m = this.heroes[role].momentum;
    this.stats.momentumStackSeconds += m.stacks * FIXED_DT;
    if (m.stacks === 0) return;
    m.timer -= FIXED_DT;
    if (m.timer <= TICK_EPS) {
      this.resetMomentum(role);
      this.applyMomentum(role);
    }
  }

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

  /**
   * 고정 틱 하나. 낮과 밤은 동시에 돌지 않는다.
   * 낮: 1. 낮 레인 step (§5.19-2) → 2. 처치·쓰러짐·핵 이벤트 → 3. 병사 수명 → 4. 기세 → 5. 낮 시간 감소 → 6. 운반 중 쓰러진 영웅 일어남
   *     → 도착이면 낮 성공(해질녘 / 1-length면 챕터 완성), 가는 길 쓰러짐·시간 초과면 실패
   * 밤: 1. 웨이브 → 2. 방어 step → 3. 거점에 닿은 적 → 핵 HP − → 4. 영웅 일어남 → 5. 병사 수명 → 6. 기세
   *     → 핵 HP 0이면 실패, 마지막 웨이브가 끝나면 새벽(스테이지 성공)
   */
  private step(out: CoreEvent[]): void {
    this.tickCount += 1;
    this.playTime = this.tickCount / TICK_RATE;
    this.attemptStats.realSeconds += FIXED_DT;
    if (this.phase === 'day') this.attemptStats.offenseSeconds += FIXED_DT;
    else this.attemptStats.defenseSeconds += FIXED_DT;
    if (this.inBattle) this.stats.battleSeconds += FIXED_DT;
    // metrics: 이 틱에 그리드에 빈칸이 없음 (관찰만)
    if (this.grid.cells.every((c) => c !== null)) this.attemptStats.gridFullSeconds += FIXED_DT;

    if (this.phase === 'day') this.stepOffense(out);
    else this.stepDefense(out);
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

  /** 처치: 기쁨 + */
  private defeated(joy: number): void {
    this.joy += joy;
    this.stats.worriesDefeated += 1;
    this.stats.totalJoyEarned += joy;
    this.attemptStats.defeated += 1;
  }

  /** 낮: 핵 찾아 돌아오기 */
  private stepOffense(out: CoreEvent[]): void {
    const b = this.data.balance;
    const ex = this.abyss;
    const outbound = !ex.guardianDown;
    const from = out.length;
    ex.step(FIXED_DT, out, this.rng);
    this.countDamage(out, from);
    let fell = false;
    let home = false;
    const end = out.length;
    for (let i = from; i < end; i++) {
      const e = out[i];
      switch (e.type) {
        case 'enemyDie':
          this.defeated(e.joy);
          break;
        case 'offenseUnitDie':
          if (e.role !== 'hero') {
            this.stats.offenseSoldierDeaths += 1;
            break;
          }
          this.heroUnit.offense = null;
          this.stats.offenseFalls += 1;
          if (outbound) {
            fell = true; // 가는 길 쓰러짐 = 그 낮 실패 (§5.17-10)
          } else {
            // 운반 중(guardian 처치 뒤) 쓰러짐 → reviveSeconds 뒤 그 자리에서 일어남
            this.offenseDown = b.hero.reviveSeconds;
            this.offenseFallY = e.y;
            this.attemptStats.carryFalls += 1;
            out.push({ type: 'heroDown', role: 'offense', unitId: e.unitId, seconds: b.hero.reviveSeconds });
          }
          break;
        case 'guardianDown': {
          this.stats.guardiansDown += 1;
          this.attemptStats.guardianDown = 1;
          const bonus: Grant[] = [];
          if (this.faceBonus) {
            this.faceBonus = false;
            const chain = pickChain(this.rng, this.data.chains.map((c) => ({ id: c.archetypeId, weight: c.spawnWeight })));
            bonus.push(this.grantPiece(this.newPiece(chain, 1), ex.geo.centerX, ex.geo.wallY));
          }
          out.push({ type: 'coreFound', stage: this.stage, bonus });
          break;
        }
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
    this.tickMomentum('offense');
    this.offenseTimer -= FIXED_DT;
    this.attemptStats.carrySeconds = ex.carryTime;
    if (this.offenseDown > 0 && !home) {
      this.offenseDown -= FIXED_DT;
      if (this.offenseDown <= TICK_EPS) {
        this.offenseDown = 0;
        this.enterHero('offense', out, b.hero.reviveHpRatio, true, this.offenseFallY);
      }
    }

    if (home) this.daySuccess(out);
    else if (fell) this.fail('dayFall', out);
    else if (this.offenseTimer <= TICK_EPS) this.fail(ex.guardianDown ? 'returnTime' : 'dayTime', out);
  }

  /** 핵을 이야기책에 가져옴: 보스 스테이지면 와일드카드 → 1-length면 챕터 완성, 아니면 해질녘 */
  private daySuccess(out: CoreEvent[]): void {
    const b = this.data.balance;
    const ex = this.abyss;
    if (this.stageDef.day.boss) {
      const rewards: Grant[] = [];
      for (let k = 0; k < b.guardian.bossWildcards; k++) {
        rewards.push(this.grantPiece(this.newPiece(WILDCARD, 0), ex.geo.centerX, ex.geo.startY));
        this.stats.wildcardsGained += 1;
      }
      out.push({ type: 'bossReward', rewards });
    }
    if (this.stage >= this.chapterLength) {
      const record = this.finishAttempt('success');
      this.pages.push(this.stage);
      out.push({ type: 'stageClear', stage: this.stage, record });
      this.enterChapterComplete(out);
      return;
    }
    this.dusk(out);
  }

  /** 밤: 웨이브 → 방어 레인 → 핵 HP → 영웅 일어남 */
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
        // 밤 영웅 쓰러짐 → reviveSeconds 뒤 hp × reviveHpRatio로 일어남 (§5.17-10)
        this.heroUnit.defense = null;
        this.defenseDown = b.hero.reviveSeconds;
        this.stats.defenseFalls += 1;
        this.attemptStats.defenseFalls += 1;
        out.push({ type: 'heroDown', role: 'defense', unitId: e.unitId, seconds: b.hero.reviveSeconds });
      } else if (e.type === 'worryDie') {
        this.defeated(e.joy);
      } else if (e.type === 'sink') {
        // 거점에 닿음 → 핵 HP − (보스 웨이브 적은 bossSinkDamage, §5.19-3)
        const damage = e.boss ? b.core.bossSinkDamage : b.core.sinkDamage;
        this.coreHp = Math.max(0, this.coreHp - damage);
        this.stats.sunkCount += 1;
        this.attemptStats.sunk += 1;
        out.push({ type: 'coreHit', hp: this.coreHp, damage, boss: e.boss });
      }
    }

    if (this.defenseDown > 0) {
      this.defenseDown -= FIXED_DT;
      if (this.defenseDown <= TICK_EPS) {
        this.defenseDown = 0;
        this.enterHero('defense', out, b.hero.reviveHpRatio, true);
      }
    }
    this.defense.expireSoldiers(FIXED_DT);
    this.tickMomentum('defense');

    if (this.coreHp <= 0) this.fail('night', out);
    else if (this.wave.phase === 'done') this.nightSuccess(out);
  }

  /** 밤 1단계: 이번 틱에 등장할 적 (stages.json night, 스테이지 고정) */
  private spawnFromWave(out: CoreEvent[]): void {
    const lane = this.defense;
    const geo = lane.geo;
    for (const s of this.wave.step(FIXED_DT, lane.worries.length === 0)) {
      const x = geo.spawnXMin + this.rng() * (geo.spawnXMax - geo.spawnXMin);
      const st: WorryStats = { ...enemyStats(this.data, s.type, this.stage), boss: s.boss };
      lane.spawnWorry(st, x, out);
    }
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

  /** 적 묶음 → 능력치 줄 (종류별로 번갈아) */
  private expand(groups: readonly EnemyGroup[]): EnemyStats[] {
    return interleave(groups).map((t) => enemyStats(this.data, t, this.stage));
  }

  /**
   * 장면 카드를 닫는다(갈림길이면 선택). 시도 시작 처리 (이 순서):
   * 1. 시도 수 + 1, 이번 시도 기록·생성 비용 초기화
   * 2. 기쁨 바닥 joy = max(joy, morningJoyFloor) (D-024)
   * 3. 갈림길 선택 효과 (joy, flag, face: 이번 시도 guardian HP × (1 − reduce) · guardian 처치 때 조각 +1)
   * 4. 낮 시작: guardian·가는 길 무리·추격 무리 배치, 낮덱 영웅이 이야기책에 hp 가득으로, offense.seconds
   */
  confirmDay(choiceId?: string): ConfirmResult {
    if (this.phase !== 'dayStart') return { ok: false, reason: 'notDayStart' };
    const cr = this.crossroad;
    const choice = cr?.event.choices.find((c) => c.id === choiceId);
    if (cr && choiceId === undefined) return { ok: false, reason: 'needChoice' };
    if (cr && !choice) return { ok: false, reason: 'badChoice' };
    const b = this.data.balance;
    const out = this.pending;
    this.assignmentDone = true;

    // 1
    this.attempt += 1;
    this.attempts[this.stage - 1] += 1;
    this.stats.attempts += 1;
    this.spawnedAttempt = 0;
    this.attemptStats = emptyAttemptStats(this.stage, this.attempt, this.joy, b.grid.maxTier);

    // 2
    this.joy = Math.max(this.joy, b.days.morningJoyFloor);

    // 3
    this.faceReduce = 0;
    this.faceBonus = false;
    if (choice) {
      this.pendingCrossroad = false;
      this.joy = Math.max(0, this.joy + choice.joy);
      this.flags.push(choice.flag);
      this.faceReduce = choice.faceLayerHpReduce ?? 0;
      this.faceBonus = choice.bonusReturnPiece ?? false;
    }
    this.attemptStats.joyStart = this.joy;

    // 4
    this.phase = 'day';
    this.offenseTimer = this.offenseSeconds;
    this.clearLaneUnits();
    this.wave.stop();
    const st = this.stageDef;
    const g = b.guardian;
    this.abyss.reset(
      {
        type: st.day.guardian,
        hp: st.day.guardianHp * (1 - this.faceReduce),
        atk: g.counterAtk * (st.day.boss ? g.bossCounterMult : 1),
        atkInterval: g.counterAtkInterval,
        range: g.counterRange,
        boss: st.day.boss ?? false,
      },
      this.expand(st.day.enemies),
      this.expand(st.day.chase),
      this.rng,
    );
    this.enterHero('offense', out);
    out.push({ type: 'dayBegin', stage: this.stage, attempt: this.attempt });
    return { ok: true };
  }

  /** 두 레인 위 우리 편·적을 모두 비운다 (단계가 바뀔 때) */
  private clearLaneUnits(): void {
    this.abyss.clear();
    this.defense.units.length = 0;
    this.defense.worries.length = 0;
    this.heroUnit = { offense: null, defense: null };
    this.unitRoles.clear();
    this.defenseDown = 0;
    this.offenseDown = 0;
  }

  /**
   * 해질녘 (즉시): 낮 병사·영웅은 물러난다(귀환 없음) → 기세 초기화 → 밤 시작:
   * 핵이 이야기책에 놓인다 (핵 HP 가득), 밤덱 영웅이 거점 앞에 hp 가득으로, 스테이지의 웨이브 시작.
   */
  private dusk(out: CoreEvent[]): void {
    this.offenseTimer = 0;
    this.clearLaneUnits();
    for (const r of ROLES) this.resetMomentum(r);
    this.phase = 'night';
    this.coreHp = this.data.balance.core.hp;
    const n = this.stageDef.night;
    this.wave.start(n.waves, n.bossWave);
    this.enterHero('defense', out);
    out.push({ type: 'dusk', stage: this.stage });
  }

  /** 시도를 마치고 기록 (판 stats 누적) */
  private finishAttempt(result: AttemptResult): AttemptStats {
    const a = this.attemptStats;
    a.result = result;
    a.joyEnd = this.joy;
    a.carrySeconds = this.abyss.carryTime;
    if (this.phase === 'night') a.coreHpEnd = this.coreHp;
    this.stats.carrySeconds += a.carrySeconds;
    if (result === 'dayTime') this.stats.dayFailTime += 1;
    else if (result === 'dayFall') this.stats.dayFailFall += 1;
    else if (result === 'returnTime') this.stats.returnFails += 1;
    else if (result === 'night') this.stats.nightFails += 1;
    this.lastAttempt = a;
    this.attemptLog.push(structuredClone(a));
    return a;
  }

  /** 실패 → 레인 비움 → 같은 스테이지 장면 카드 (재도전). 영웅 강화·그리드·기쁨은 그대로 (D-054) */
  private fail(reason: FailReason, out: CoreEvent[]): void {
    const record = this.finishAttempt(reason);
    this.offenseTimer = 0;
    this.clearLaneUnits();
    for (const r of ROLES) this.resetMomentum(r);
    this.wave.stop();
    this.retry = reason;
    this.phase = 'dayStart';
    out.push({ type: 'attemptFail', stage: this.stage, reason, record });
    out.push({ type: 'stageStart', stage: this.stage, retry: reason, crossroad: this.pendingCrossroad });
  }

  /** 새벽 (핵 HP > 0): 스테이지 성공 → 아침 이야기 한 장. 1-turningPoint면 다음 장면 카드 = 갈림길 */
  private nightSuccess(out: CoreEvent[]): void {
    const record = this.finishAttempt('success');
    this.clearLaneUnits();
    for (const r of ROLES) this.resetMomentum(r);
    this.wave.stop();
    this.phase = 'diary';
    this.pages.push(this.stage);
    if (this.stage === this.data.balance.chapter.turningPoint) this.pendingCrossroad = true;
    out.push({ type: 'stageClear', stage: this.stage, record });
  }

  /** [다음 이야기]: 이야기 한 장 → 다음 스테이지 장면 카드 */
  nextStage(): boolean {
    if (this.phase !== 'diary') return false;
    this.stage = Math.min(this.chapterLength, this.stage + 1);
    this.retry = null;
    this.phase = 'dayStart';
    this.pending.push({ type: 'stageStart', stage: this.stage, retry: null, crossroad: this.pendingCrossroad });
    return true;
  }

  private enterChapterComplete(out: CoreEvent[] = this.pending): void {
    this.offenseTimer = 0;
    this.clearLaneUnits();
    this.wave.stop();
    this.completed = true;
    this.phase = 'chapterComplete';
    out.push({ type: 'chapterComplete', completed: true });
    this.joinHeroes(this.data.chapter.id, out);
  }

  /** 이 챕터의 보상 영웅 (heroes.json reward = 챕터 id) */
  get rewardHeroes(): HeroDef[] {
    return this.data.heroes.heroes.filter((h) => h.reward === this.data.chapter.id);
  }

  /** 보상 영웅 합류: reward가 이 챕터인 영웅 중 아직 없는 영웅 (D-057). reward 생략 = 모든 보상 영웅 (디버그) */
  private joinHeroes(reward: string | null, out: CoreEvent[]): void {
    const ids = this.data.heroes.heroes
      .filter((h) => h.reward !== undefined && (reward === null || h.reward === reward) && !this.joinedHeroes.includes(h.id))
      .map((h) => h.id);
    if (!ids.length) return;
    this.joinedHeroes.push(...ids);
    out.push({ type: 'heroesJoined', ids });
  }

  /**
   * 저장된 경계 상태로 복원 (§5.19-7). 생성자가 쓴 rng는 마지막에 rngState로 되돌린다.
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
    g.spawnedAttempt = save.spawnedAttempt;
    g.joy = save.joy;
    g.coreHp = save.core.hp;
    refill(g.grid.cells, save.grid);
    g.lostReturns = save.lostReturns;
    g.defense.happy.cd = save.happyCd;
    g.defense.nextWorryId = save.nextWorryId;
    Object.assign(g.stats, copy(save.stats));
    refill(g.pages, save.pages);
    refill(g.flags, save.flags);
    refill(g.attemptLog, save.attemptLog);
    g.lastAttempt = g.attemptLog.length ? g.attemptLog[g.attemptLog.length - 1] : null;
    refill(g.feedLog, save.feedLog);
    g.completed = save.completed;
    g.pendingCrossroad = save.pendingCrossroad;
    g.assignmentDone = save.assignmentDone;
    refill(g.joinedHeroes, save.joinedHeroes);
    g.heroes.offense = copy(save.heroes.offense);
    g.heroes.defense = copy(save.heroes.defense);
    g.attemptStats = emptyAttemptStats(g.stage, g.attempt + 1, g.joy, data.balance.grid.maxTier);
    g.pending = [];
    rng.setState(save.rngState);
    return g;
  }

  // ── 조각 생성 ──

  get spawnCost(): number {
    return spawnCost(this.data.balance.grid, this.spawnedAttempt);
  }

  get spawnBlock(): SpawnBlock | null {
    return spawnBlock(this.grid, this.joy, this.spawnCost);
  }

  /** 체인 가중치: spawnWeight (이벤트 가중치는 M8.10에서 끔) */
  chainWeight(id: string): number {
    return this.data.chains.find((ch) => ch.archetypeId === id)?.spawnWeight ?? 0;
  }

  /** 기쁨을 쓰고 빈 칸 랜덤 위치에 1단계 조각. 불가하면 null */
  spawn(): { index: number; piece: Piece } | null {
    if (this.spawnBlock) return null;
    const index = pickEmpty(this.rng, this.grid)!;
    const chain = pickChain(
      this.rng,
      this.data.chains.map((c) => ({ id: c.archetypeId, weight: this.chainWeight(c.archetypeId) })),
    );
    this.joy -= this.spawnCost;
    this.spawnedAttempt += 1;
    this.attemptStats.spawns += 1;
    const piece = this.newPiece(chain, 1);
    this.grid.cells[index] = piece;
    return { index, piece };
  }

  // ── 드래그 ──

  /** 드롭: 머지 / 교환·이동 (조합 제작은 끔, §5.17-6). 전투 중 머지면 버프 + 병사 */
  drop(from: number, to: number | null): DropKind {
    const kind = applyDrop(this.grid, from, to);
    if (kind === 'merge') {
      this.attemptStats.merges += 1;
      const p = this.grid.cells[to!]!;
      if (p.tier >= this.data.balance.grid.maxTier) this.stats.tier3ByChain[p.chain] = (this.stats.tier3ByChain[p.chain] ?? 0) + 1;
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
   * 전투 중 머지 (§5.17-3, [11]-1·2). 결과 조각 p(그리드에 남음)의 체인 기준, 와일드카드 머지도 결과 체인.
   * 버프: heal = 즉시 회복 maxHp × healPct / momentum = 기세 중첩 (결과 3단계면 회복 ×tier3Mult·중첩 tier3Mult개)
   * 병사: 결과 2단계 = 1단, 3단계 = 2단. soldierCap이면 병사 없이 버프만. 때 맞춤이면 병사 능력치·버프 × affinityMult
   */
  private battleMerge(p: Piece, cell: number): void {
    const role = this.fightingRole!;
    const b = this.data.balance;
    const c = this.data.chains.find((x) => x.archetypeId === p.chain)!;
    const tier3 = p.tier >= b.grid.maxTier;
    const affinity = this.isAffinity(p.chain);
    const mult = affinity ? b.merge.affinityMult : 1;
    this.stats.battleMerges += 1;
    this.attemptStats.battleMerges += 1;
    if (affinity) this.stats.affinityMerges += 1;

    // 버프 (지금 싸우는 쪽 영웅)
    const hero = this.heroUnitOf(role);
    if (c.buff === 'heal') {
      let healed = 0;
      if (hero) {
        const before = hero.hp;
        hero.hp = Math.min(hero.maxHp, hero.hp + hero.maxHp * b.buff.healPct * (tier3 ? b.buff.tier3Mult : 1) * mult);
        healed = hero.hp - before;
        this.stats.buffHeal += healed;
      }
      this.pending.push({ type: 'buff', role, kind: 'heal', amount: healed, stacks: 0, affinity, cell });
    } else {
      const m = this.heroes[role].momentum;
      const add = tier3 ? b.buff.tier3Mult : 1;
      for (let k = 0; k < add && m.stacks < b.buff.momentumMaxStacks; k++) {
        m.stacks += 1;
        m.bonus += b.buff.momentumAtkPct * mult;
      }
      m.timer = b.buff.momentumSeconds;
      this.applyMomentum(role);
      this.pending.push({ type: 'buff', role, kind: 'momentum', amount: m.bonus, stacks: m.stacks, affinity, cell });
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
      ...(lv.slow !== undefined ? { slow: lv.slow, slowSeconds: lv.slowSeconds ?? 0 } : {}),
    })!;
    this.unitRoles.set(u.id, 'soldier');
    this.stats.soldiersSpawned += 1;
    this.attemptStats.soldiers += 1;
    const key = `${p.chain}:${level}`;
    this.stats.soldiersByKind[key] = (this.stats.soldiersByKind[key] ?? 0) + 1;
    this.pending.push({ type: 'soldier', role, unitId: u.id, chain: p.chain, level, affinity, cell, capped: false });
  }

  // ── 놓아주기 ──

  /** 드래그 중 미리보기: 이 칸의 조각을 놓아주면 받는 기쁨. 와일드카드·빈 칸은 null */
  releasePreview(index: number): number | null {
    const p = this.grid.cells[index];
    return p ? releaseValue(p, this.data.balance.grid.releaseRefund) : null;
  }

  /** 놓아주기 영역에 드롭: 즉시 제거·환급. 빈 칸·와일드카드는 무시하고 null (원위치) */
  release(index: number): number | null {
    const r = releaseAt(this.grid, index, this.data.balance.grid.releaseRefund);
    if (!r) return null;
    this.joy += r.refund;
    this.attemptStats.releases += 1;
    const t = isWildcard(r.piece) ? 0 : r.piece.tier;
    if (t < this.attemptStats.releaseTiers.length) this.attemptStats.releaseTiers[t] += 1;
    return r.refund;
  }

  // ── 먹이기 (§5.17-2) ──

  /** 이 단계에서 먹일 수 있는지: 낮·밤 언제든, 두 영웅 모두 */
  get feedOpen(): boolean {
    return this.phase === 'day' || this.phase === 'night';
  }

  /** 단계 점수 (tierScore[tier-1]) */
  feedScore(tier: number): number {
    return this.data.balance.feed.tierScore[tier - 1] ?? 0;
  }

  /** 드래그 중 미리보기용: 먹일 수 없으면 사유, 가능하면 null */
  canFeed(cell: number, _role: Role): FeedBlock | null {
    if (!this.feedOpen) return 'closed';
    const p = this.grid.cells[cell];
    if (!p) return 'empty';
    if (isWildcard(p)) return 'wildcard';
    return null;
  }

  /** 먹이기: 조각 소모 → 그 영웅의 그 체인 점수 + 단계 점수. 레인 위에 있으면 능력치를 바로 반영 (늘어난 maxHp만큼 hp도) */
  feed(cell: number, role: Role): FeedResult {
    const block = this.canFeed(cell, role);
    if (block) return { ok: false, reason: block };
    const p = this.grid.cells[cell]!;
    const points = this.feedScore(p.tier);
    const before = this.heroStats(role);
    const h = this.heroes[role];
    h.points[p.chain] = (h.points[p.chain] ?? 0) + points;
    this.grid.cells[cell] = null;
    const u = this.heroUnitOf(role);
    if (u) {
      const s = this.heroStats(role);
      u.maxHp = s.hp;
      u.hp = Math.min(s.hp, u.hp + (s.hp - before.hp));
      u.atkInterval = s.atkInterval;
      u.dmgMult = s.dmgMult;
      this.applyMomentum(role);
    }
    this.feedLog.push({
      t: this.playTime,
      attempt: this.attempt,
      stage: this.stage,
      role,
      hero: h.id,
      chain: p.chain,
      tier: p.tier,
      points,
      cell: toCell(this.grid, cell),
      heldFor: this.playTime - p.bornAt,
    });
    this.stats.feeds += 1;
    this.attemptStats.feeds += 1;
    this.attemptStats.feedPoints += points;
    this.pending.push({ type: 'feed', role, cell, chain: p.chain, tier: p.tier, points });
    return { ok: true, points };
  }

  // ── 조각 만들기 ──

  newPiece(chain: ChainId | typeof WILDCARD, tier: number): Piece {
    return { id: this.nextPieceId++, chain, tier: chain === WILDCARD ? WILDCARD_TIER : tier, bornAt: this.playTime };
  }

  // ── 디버그 (?debug=1) ──

  debugAddJoy(amount: number): void {
    this.joy += amount;
  }

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

  /** 낮 레인 우리 편 전멸 → 다음 틱에 사망 처리 (가는 길이면 낮 실패, 운반 중이면 핵 떨어뜨림) */
  debugKillAbyssUnits(): void {
    for (const u of this.abyss.units) u.hp = 0;
  }

  /** 밤 영웅 hp 0 → 다음 틱에 쓰러짐 */
  debugKnockDefenseHero(): void {
    const u = this.heroUnitOf('defense');
    if (u) u.hp = 0;
  }

  /** 낮 즉시 성공 (핵을 이야기책에) → 해질녘 */
  debugToNight(): void {
    if (this.phase !== 'day') return;
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
    this.pendingCrossroad = false;
    this.enterChapterComplete();
  }

  /** 스테이지를 바로 바꾼다 (장면 카드로). 경계(dayStart·diary)에서만 */
  debugSetStage(stage: number): void {
    if (this.phase !== 'dayStart' && this.phase !== 'diary') return;
    this.stage = Math.max(1, Math.min(this.chapterLength, Math.floor(stage)));
    this.retry = null;
    this.phase = 'dayStart';
    this.pending.push({ type: 'stageStart', stage: this.stage, retry: null, crossroad: this.pendingCrossroad });
  }

  /** 보상 영웅 지급 (덱 화면 M8.11 테스트용, D-057) */
  debugGrantRewardHeroes(): void {
    this.joinHeroes(null, this.pending);
  }

  /** 장면 카드에서 갈림길을 바로 연다 */
  debugOpenCrossroad(): void {
    if (this.phase !== 'dayStart') return;
    this.pendingCrossroad = true;
    this.pending.push({ type: 'stageStart', stage: this.stage, retry: this.retry, crossroad: true });
  }
}

function emptyHero(id: string): HeroState {
  return { id, points: {}, momentum: { stacks: 0, bonus: 0, timer: 0 } };
}
