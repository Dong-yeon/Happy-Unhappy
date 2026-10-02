// 한 판(1챕터)의 core 상태: 하루 흐름, 기쁨, 누적 게임 시간, 조각 id, 그리드, 두 레인, 웨이브, 그림자·역류, 이야기 한 장.
// Phaser 의존 없음. scene은 이 객체의 메서드를 호출하고 결과를 표시만 한다.
// 시간은 고정 틱(FIXED_DT)으로만, 그리고 낮(오펜스)·밤(디펜스)에만 흐른다.
//
// v0.13 (§5.17, D-045·D-046 + [11] D-049·D-050):
//   하루 = dayStart → 낮(오펜스: 오펜스 영웅이 심연 층을 친다, offense.seconds) → 해질녘 → 밤(디펜스: 디펜스 영웅이 웨이브를 막는다) → 이야기 한 장
//   영웅은 판 내내 두 명(누이·오라비)을 낮덱/밤덱에 하나씩. 머지 조각은 소환하지 않고 영웅에게 먹이는 강화 재료.
//   전투 중 머지 → 지금 싸우는 쪽 영웅 버프(떡 회복 / 동아줄 기세) + 그 레인에 병사 자동 출전 (때 맞춤이면 × affinityMult).

import type { ChainGrowth, CombatStats, GameData, HeroDef } from '../data/types';
import {
  effectsOf,
  emptyDayStats,
  eventById,
  resolveDayEvent,
  type DailyUse,
  type DayEvent,
  type DayPhase,
  type DayStats,
} from './day';
import { writeDiary, type DiaryEntry } from './diary';
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
  isBossFloor,
  type AbyssGeometry,
  type LaneEvent,
  type LaneGeometry,
  type Side,
  type Unit,
  type UnitRole,
} from './lane';
import type { SeededRng } from './rng';
import type { SaveGame } from './save';
import { emptyGameStats, type GameStats } from './stats';
import { clampShadow, weatherOf, type Weather } from './shadow';
import { DayWaves, type SlotId } from './wave';

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
  day: number;
  role: Role;
  hero: string;
  chain: string;
  tier: number;
  points: number;
  cell: { col: number; row: number };
  /** 조각 보유 시간 = t - bornAt */
  heldFor: number;
}

/** 지급 조각 (이벤트 선물·갈림길 보너스·보스 층 와일드카드): 빈 칸에, 없으면 사라짐 (귀환 큐 없음, §5.17-5) */
export interface Grant {
  /** 연출 시작점 */
  x: number;
  y: number;
  piece: Piece;
  placedAt: number | null;
  lost: boolean;
}

/** 보스 등장 진단 기록 (§5.7): 등장 틱의 상태 + 결과 */
export interface BossRecord {
  day: number;
  slot: SlotId;
  /** 낮에 예약되어 준비 시간이 있었는지 */
  prep: boolean;
  /** 디펜스 레인의 우리 편 수 (영웅 + 병사) */
  defenseUnits: number;
  /** 디펜스 영웅이 서 있었는지 (쓰러져 있지 않음) */
  heroUp: boolean;
  gridPieces: number;
  joy: number;
  shadowBefore: number;
  /** 처치 true / 가라앉음 false / 아직 null */
  win: boolean | null;
}

export type CoreEvent =
  | LaneEvent
  | { type: 'layerClear'; layer: number; bonus: Grant[] }
  | { type: 'shadowChange'; value: number; weather: Weather }
  /** 역류 예약: 오늘 밤 남은 웨이브 칸 / 오늘 밤 첫 웨이브 / 다음 밤 첫 웨이브 */
  | { type: 'backflowPending'; slot: SlotId | 'tonight' | 'nextNight' }
  | { type: 'backflowStart'; record: BossRecord }
  | { type: 'backflowEnd'; win: boolean }
  | { type: 'dayBegin'; day: number; event: DayEvent; bossTonight: boolean }
  | { type: 'freePiece'; grant: Grant }
  /** 영웅이 레인에 섬 (단계 시작·밤 영웅 일어남) */
  | { type: 'heroEnter'; role: Role; unitId: number; revive: boolean }
  /** 밤 영웅 쓰러짐 → reviveSeconds 뒤 일어남 */
  | { type: 'heroDown'; role: Role; unitId: number; seconds: number }
  /** 낮 영웅 쓰러짐 → 그 낮 끝 (남은 초 × stallShadowPerSec 그림자) */
  | { type: 'offenseFall'; skipped: number }
  /** 먹이기 */
  | { type: 'feed'; role: Role; cell: number; chain: string; tier: number; points: number }
  /** 전투 중 머지 버프 */
  | { type: 'buff'; role: Role; kind: 'heal' | 'momentum'; amount: number; stacks: number; affinity: boolean; cell: number }
  /** 전투 중 머지 병사 출전 (capped: 상한이라 병사 없음) */
  | { type: 'soldier'; role: Role; unitId: number | null; chain: string; level: number; affinity: boolean; cell: number; capped: boolean }
  /** 해질녘: 낮(오펜스) 끝 → 밤(디펜스) 시작 */
  | { type: 'dusk'; day: number }
  /** 보스 층 돌파 보상 (와일드카드) */
  | { type: 'bossFloorClear'; layer: number; rewards: Grant[] }
  | { type: 'dayEnd'; day: number; entry: DiaryEntry; stats: DayStats }
  | { type: 'dayStart'; day: number; event: DayEvent }
  | { type: 'chapterComplete'; completed: boolean };

export type ConfirmResult = { ok: true } | { ok: false; reason: 'notDayStart' | 'needChoice' | 'badChoice' };
export type FeedResult = { ok: true; points: number } | { ok: false; reason: FeedBlock };

export type { GameStats } from './stats';

/** 역류 보스 HP = hp × hpGrowthPerDay^(일차-1) */
export function bossHp(boss: { hp: number; hpGrowthPerDay: number }, day: number): number {
  return boss.hp * Math.pow(boss.hpGrowthPerDay, Math.max(1, day) - 1);
}

/** 레인 쪽: 오펜스 = 심연(unhappy), 디펜스 = 방어(happy). Side는 레인 이벤트·표시용 이름 그대로 */
export function sideOf(role: Role): Side {
  return role === 'offense' ? 'unhappy' : 'happy';
}

/** 부동소수 누적 오차로 틱이 하나 빠지지 않도록 */
const TICK_EPS = 1e-9;

export class GameState {
  /** 누적 게임 시간(초, 배속 반영). Piece.bornAt 기준 */
  playTime = 0;
  joy: number;
  nextPieceId = 1;
  /** 오늘 생성 횟수. 하루 시작 때 0 */
  spawnedToday = 0;
  readonly grid: Grid;
  /** 지급할 칸이 없어 사라진 조각 수 */
  lostReturns = 0;
  /** 처리한 고정 틱 수. playTime = tickCount / TICK_RATE */
  tickCount = 0;
  /** 밤(디펜스) 레인 */
  readonly defense: Lane<'defense'>;
  /** 낮(오펜스) 레인 */
  readonly abyss: Lane<'abyss'>;
  readonly wave: DayWaves;
  readonly stats: GameStats = emptyGameStats();
  readonly feedLog: FeedRecord[] = [];
  /** 0 ~ shadowMax */
  shadow: number;
  /** 그림자가 shadowMax에 닿아 역류 보스가 예약됨 (보스가 등장하면 해제) */
  pendingBackflow = false;
  /** 오늘 밤(또는 다음 밤) 첫 웨이브가 보스 (+ 준비 시간, D-021, §5.17-10) */
  carryBackflow = false;
  /** 역류 보스 웨이브 진행 중 */
  bossActive = false;
  /** 낮(오펜스) 남은 시간(초) */
  offenseTimer = 0;
  /** 밤 영웅 쓰러짐: 일어나기까지 남은 초 (0 = 서 있음) */
  defenseDown = 0;

  // ── 영웅 (§5.17-1, [11]-3) ──
  readonly heroes: Record<Role, HeroState>;
  /** 판 시작(1-1 dayStart) 배정을 마쳤는지. 1일차 카드를 닫으면 true (판 중 변경은 M8.10) */
  assignmentDone = false;
  /** 레인 위 영웅 유닛 id (그 단계에만) */
  private heroUnit: Record<Role, number | null> = { offense: null, defense: null };
  /** 레인 유닛 id → 역할 (피해 비중 집계). 단계가 바뀔 때 비운다 */
  private unitRoles = new Map<number, UnitRole>();

  // ── 하루 (§5.7) ──
  day = 1;
  phase: DayPhase = 'dayStart';
  /** 오늘의 이벤트 (dayStart 카드) */
  today: DayEvent;
  dayStats: DayStats;
  /** 방금 끝난 날의 기록 (diary 단계 표시·시뮬) */
  lastDayStats: DayStats | null = null;
  readonly diary: DiaryEntry[] = [];
  /** 갈림길 선택 flag ("avoid" | "face") */
  readonly flags: string[] = [];
  readonly dailyUsed: DailyUse[] = [];
  readonly bossLog: BossRecord[] = [];
  /** 갈림길 face: 그날 첫 층 돌파 때 조각 +1 (그날 한 번) */
  private faceBonusToday = false;
  /** 그날 조각 생성 체인 가중치 배율 (이벤트 chainWeight) */
  private chainWeightToday: Record<string, number> = {};
  /** 그날 밤 걱정 배율 (이벤트 worryMultiplier) */
  private worryMultToday = 1;
  /** 디버그: 다음 dayStart에 강제할 이벤트 */
  private forcedNext: string | null = null;

  // ── 챕터 진행 (§5.15-1) ──
  /** 1-turningPoint를 정화함 → 다음 dayStart에 갈림길 (저장: 갈림길 대기) */
  pendingCrossroad = false;
  /** 1-length(보스)를 정화함 → 그날 밤 없이 챕터 완성 */
  chapterCleared = false;
  /** 판의 끝 (chapterComplete): 완성 true / maxDays 미완성 false. 그 전에는 null */
  completed: boolean | null = null;

  /** 저장(save.ts)이 읽고 쓴다 */
  nextUnitId = 1;
  /** 아직 틱으로 처리하지 않은 시간 */
  private acc = 0;
  /** 틱 밖(먹이기·하루 전환 등)에서 생긴 이벤트. 다음 tick()의 반환값에 앞서 포함된다 */
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
    this.shadow = clampShadow(b.start.shadow, b.shadow.shadowMax);
    this.grid = createGrid(size, b.grid.maxTier);
    const need = b.merge.soldierCap + 1;
    for (const [name, g] of [
      ['방어선', geometry.defense],
      ['심연', geometry.abyss],
    ] as const) {
      if (g.slotXs.length < need) throw new Error(`${name} 슬롯 수(${g.slotXs.length}) < 영웅 1 + soldierCap(${need})`);
    }
    this.defense = new Lane('defense', geometry.defense, b.happy, {
      range: b.lane.defenseInterceptRange,
      speed: b.lane.defenseMoveSpeed,
      contact: b.lane.defenseContact,
    });
    // 전환점 층 HP 배수 (§5.15-1, 보스 층 배수와 별개)
    const wall = { ...b.abyss, turningPoint: b.chapter.turningPoint, turningPointHpMult: b.chapter.turningPointHpMult };
    this.abyss = new Lane('abyss', geometry.abyss, { wall, advanceSpeed: b.lane.abyssAdvanceSpeed });
    this.wave = new DayWaves({ ...b.wave, hpBase: data.monsters.worry.hpBase });
    const h = data.heroes;
    const [off, def] = b.start.swapHeroes ? [h.defense, h.offense] : [h.offense, h.defense];
    this.heroes = { offense: emptyHero(off), defense: emptyHero(def) };
    this.today = this.resolveToday();
    this.dayStats = emptyDayStats(this.joy, b.grid.maxTier);
  }

  /** 시간은 낮·밤에만 흐른다 */
  get timeFlows(): boolean {
    return this.phase === 'day' || this.phase === 'night';
  }

  get offenseSeconds(): number {
    return this.data.balance.offense.seconds;
  }

  get weather(): Weather {
    return weatherOf(this.shadow, this.data.balance.shadow.weatherThresholds);
  }

  /** 역류 예약·보스 진행 중에는 그림자가 shadowMax에 머문다 (보스 결과가 값을 설정한다) */
  get shadowLocked(): boolean {
    return this.pendingBackflow || this.bossActive;
  }

  /** 이 일차 이야기 한 장 뒤에도 1-length를 못 넘었으면 미완성으로 끝 (§5.15-1) */
  get maxDays(): number {
    return this.data.balance.chapter.maxDays;
  }

  /** 지금 스테이지 번호 (1-n의 n) = 심연 층 (챕터 길이에서 멈춤) */
  get stage(): number {
    return Math.min(this.abyss.wall.layer, this.data.balance.chapter.length);
  }

  /** 오늘 이벤트가 갈림길(이정표)이면 선택지 */
  get choices(): { id: string; label: string }[] {
    return this.today.kind === 'milestone' ? this.today.event.choices.map((c) => ({ id: c.id, label: c.label })) : [];
  }

  /** 지금 싸우는 쪽 (낮 = 오펜스, 밤 = 디펜스). 전투 밖이면 null */
  get fightingRole(): Role | null {
    if (this.phase === 'day' && this.offenseTimer > TICK_EPS) return 'offense';
    if (this.phase === 'night') return 'defense';
    return null;
  }

  /** 전투 중 (§5.17-3): 낮 남은 시간 > 0 / 밤 웨이브 진행 중 */
  get inBattle(): boolean {
    return this.fightingRole !== null;
  }

  laneOf(role: Role): Lane {
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

  /** 판 시작(1-1 dayStart) 영웅 배정: 낮덱(오펜스)에 offenseId, 밤덱에 다른 한 명 ([11]-3). 그 밖에는 false */
  assignHeroes(offenseId: string): boolean {
    if (this.assignmentDone || this.day !== 1 || this.phase !== 'dayStart') return false;
    const ids = this.data.heroes.heroes.map((h) => h.id);
    if (!ids.includes(offenseId)) return false;
    const pair = [this.heroes.offense.id, this.heroes.defense.id];
    if (!pair.includes(offenseId)) return false;
    if (this.heroes.offense.id !== offenseId) {
      const t = this.heroes.offense;
      this.heroes.offense = this.heroes.defense;
      this.heroes.defense = t;
    }
    return true;
  }

  /** 그 단계 시작: 영웅을 레인에 hp 가득으로 (§5.17-1) */
  private enterHero(role: Role, out: CoreEvent[], hpRatio = 1, revive = false): void {
    const s = this.heroStats(role);
    const lane = this.laneOf(role);
    const u = lane.addUnit(this.nextUnitId++, sideOf(role), this.heroes[role].id, 0, s, {
      role: 'hero',
      dmgMult: s.dmgMult,
      hp: s.hp * hpRatio,
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
    if (!this.timeFlows) this.acc = 0; // 하루가 끝난 뒤 남은 시간은 버린다
    return out;
  }

  /**
   * 고정 틱 하나. 낮과 밤은 동시에 돌지 않는다 (§5.17-10).
   * 낮 (심연 레인만): 1. 심연 step (전진 → 벽 공격 → 반격 → 사망 → 층 돌파) → 2. 병사 수명 → 3. 기세 → 4. 낮 시간 감소
   * 밤 (방어 레인만): 1. 웨이브 → 2. 방어 step → 3. 가라앉음 (그림자 +, 현재 층 추가 HP +) → 4. 영웅 일어남 → 5. 병사 수명 → 6. 기세
   * 공통: 역류 판정. 1-10 정화한 틱이면 챕터 완성(밤 없음), 낮 시간이 다 된 틱이면 해질녘, 마지막 웨이브가 끝난 틱이면 새벽
   */
  private step(out: CoreEvent[]): void {
    this.tickCount += 1;
    this.playTime = this.tickCount / TICK_RATE;
    this.dayStats.realSeconds += FIXED_DT;
    if (this.phase === 'day') this.dayStats.offenseSeconds += FIXED_DT;
    else this.dayStats.defenseSeconds += FIXED_DT;
    if (this.inBattle) this.stats.battleSeconds += FIXED_DT;
    const shadowBefore = this.shadow;

    if (this.phase === 'day') this.stepOffense(out);
    else this.stepDefense(out);

    this.checkBackflow(out);
    if (this.shadow !== shadowBefore) out.push({ type: 'shadowChange', value: this.shadow, weather: this.weather });

    // metrics: 이 틱 끝에 그리드에 빈칸이 없음 (관찰만)
    if (this.grid.cells.every((c) => c !== null)) this.dayStats.gridFullSeconds += FIXED_DT;

    if (this.phase === 'day') {
      if (this.chapterCleared) this.finishChapterDay(out);
      else if (this.offenseTimer <= TICK_EPS) this.dusk(out);
    } else if (this.phase === 'night' && this.wave.phase === 'done') {
      this.endDay(out, true);
    }
  }

  /** 우리 편이 준 피해 집계 (영웅 / 병사 / 거점) */
  private countDamage(out: CoreEvent[], from: number): void {
    for (let i = from; i < out.length; i++) {
      const e = out[i];
      if (e.type === 'attack') {
        if (e.attacker.kind === 'happy') this.stats.damageBase += e.damage;
        else if (e.attacker.kind === 'unit') this.addDamage(e.attacker.id, e.damage);
      } else if (e.type === 'wallHit') {
        this.addDamage(e.unitId, e.damage);
      }
    }
  }

  private addDamage(unitId: number, dmg: number): void {
    if (this.unitRoles.get(unitId) === 'soldier') this.stats.damageSoldier += dmg;
    else this.stats.damageHero += dmg;
  }

  /** 낮: 오펜스 영웅·병사가 층을 친다 */
  private stepOffense(out: CoreEvent[]): void {
    const b = this.data.balance;
    const from = out.length;
    const r = this.abyss.stepAbyss(FIXED_DT, out);
    this.countDamage(out, from);
    let fell = false;
    for (let i = from; i < out.length; i++) {
      const e = out[i];
      if (e.type !== 'abyssUnitDie') continue;
      if (e.role === 'hero') {
        fell = true;
        this.heroUnit.offense = null;
      } else {
        this.addShadow(b.abyss.abyssDeathShadow); // 병사 쓰러짐
        this.stats.abyssDeaths += 1;
      }
    }
    if (r.cleared) this.clearLayer(r.cleared.layer, out);
    this.abyss.expireSoldiers(FIXED_DT);
    this.tickMomentum('offense');
    this.offenseTimer -= FIXED_DT;
    // 낮 영웅 쓰러짐 → 그 낮 끝 + 남은 초 × stallShadowPerSec (§5.17-10)
    if (fell && !this.chapterCleared) {
      const skipped = Math.max(0, this.offenseTimer);
      this.stats.offenseFalls += 1;
      this.stats.stallSeconds += skipped;
      this.dayStats.offenseFell = 1;
      this.dayStats.stallSeconds += skipped;
      this.addShadow(b.offense.stallShadowPerSec * skipped);
      this.offenseTimer = 0;
      out.push({ type: 'offenseFall', skipped });
    }
  }

  /** 밤: 웨이브 → 방어 레인 → 가라앉음 → 영웅 일어남 */
  private stepDefense(out: CoreEvent[]): void {
    const b = this.data.balance;
    this.spawnFromWave(out);

    const sinks: { boss: boolean }[] = [];
    const from = out.length;
    this.defense.step(FIXED_DT, out);
    this.countDamage(out, from);
    for (let i = from; i < out.length; i++) {
      const e = out[i];
      if (e.type === 'unitDie' && e.role === 'hero') {
        // 밤 영웅 쓰러짐 → reviveSeconds 뒤 hp × reviveHpRatio로 일어남 (§5.17-10)
        this.heroUnit.defense = null;
        this.defenseDown = b.hero.reviveSeconds;
        this.stats.defenseFalls += 1;
        this.dayStats.defenseFalls += 1;
        out.push({ type: 'heroDown', role: 'defense', unitId: e.unitId, seconds: b.hero.reviveSeconds });
      } else if (e.type === 'worryDie') {
        this.joy += e.joy;
        this.stats.worriesDefeated += 1;
        this.stats.totalJoyEarned += e.joy;
        this.dayStats.defeated += 1;
        if (e.boss) this.bossResult(true, out);
      } else if (e.type === 'sink') {
        sinks.push({ boss: e.boss });
      }
    }

    for (const sk of sinks) {
      if (sk.boss) {
        this.bossResult(false, out); // 보스 가라앉음은 일반 규칙(sinkShadow·sinkLayerHp) 미적용
      } else {
        this.stats.sunkCount += 1;
        this.dayStats.sunk += 1;
        this.addShadow(b.shadow.sinkShadow);
        this.abyss.addExtraHp(b.shadow.sinkLayerHp); // 밤에 가라앉은 걱정이 다음 낮의 층을 단단하게
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
  }

  private checkBackflow(out: CoreEvent[]): void {
    if (this.shadow >= this.data.balance.shadow.shadowMax && !this.shadowLocked) this.scheduleBackflow(out);
  }

  /** 걱정 HP = 일차 HP (자라기 배수 없음, §5.17-5) */
  get worryHp(): number {
    return this.wave.hp;
  }

  /** 밤 1단계: 이번 틱에 등장할 걱정(또는 역류 보스) */
  private spawnFromWave(out: CoreEvent[]): void {
    const lane = this.defense;
    const geo = lane.geo;
    const spawns = this.wave.step(FIXED_DT, lane.worries.length === 0);
    for (let i = 0; i < spawns; i++) {
      const x = geo.spawnXMin + this.rng() * (geo.spawnXMax - geo.spawnXMin);
      if (this.wave.isBoss) {
        const boss = this.data.monsters.backflowBoss;
        const record = this.bossRecord();
        this.bossLog.push(record);
        this.bossActive = true;
        this.pendingBackflow = false;
        this.stats.backflows += 1;
        this.dayStats.backflow = 1;
        lane.spawnWorry(
          { hp: bossHp(boss, this.day), speed: boss.speed, atk: boss.atk, atkInterval: boss.atkInterval, joyReward: boss.joyReward, boss: true },
          x,
          out,
        );
        out.push({ type: 'backflowStart', record });
      } else {
        const worry = this.data.monsters.worry;
        lane.spawnWorry({ hp: this.worryHp, speed: worry.speed, atk: worry.atk, atkInterval: worry.atkInterval, joyReward: worry.joyReward }, x, out);
      }
    }
  }

  /** 보스 등장 순간의 디펜스 상태 (§5.7 진단 기록) */
  private bossRecord(): BossRecord {
    return {
      day: this.day,
      slot: this.wave.slotId,
      prep: this.wave.slot === 0 && this.wave.prepMorning,
      defenseUnits: this.defense.units.length,
      heroUp: this.heroUnit.defense !== null,
      gridPieces: this.grid.cells.filter((c) => c !== null).length,
      joy: this.joy,
      shadowBefore: this.shadow,
      win: null,
    };
  }

  /** 그림자 증감. 역류 예약·보스 중에는 shadowMax에 고정 */
  private addShadow(delta: number): void {
    if (this.shadowLocked) return;
    this.shadow = clampShadow(this.shadow + delta, this.data.balance.shadow.shadowMax);
  }

  /**
   * 역류 예약 (D-021, §5.17-10): 밤 도중이고 남은 웨이브 칸이 있으면 다음 칸을 보스로,
   * 낮(·하루 시작)이면 그날 밤 첫 웨이브가 보스 (+ 준비 시간), 밤 마지막 웨이브 도중·이후면 다음 밤 첫 웨이브.
   */
  private scheduleBackflow(out: CoreEvent[]): void {
    this.shadow = this.data.balance.shadow.shadowMax;
    this.pendingBackflow = true;
    const next = this.phase === 'night' ? this.wave.nextSlot() : null;
    if (next !== null) {
      this.wave.markBoss(next);
      out.push({ type: 'backflowPending', slot: ['morning', 'noon', 'evening'][next] as SlotId });
    } else {
      this.carryBackflow = true;
      out.push({ type: 'backflowPending', slot: this.phase === 'night' || this.phase === 'diary' ? 'nextNight' : 'tonight' });
    }
  }

  /** 역류 보스 결과: 처치 → 그림자 = shadowAfterBossWin / 가라앉음 → shadowAfterBossLose, 기쁨 −, 층 추가 HP + */
  private bossResult(win: boolean, out: CoreEvent[]): void {
    const s = this.data.balance.shadow;
    const boss = this.data.monsters.backflowBoss;
    this.bossActive = false;
    const rec = this.bossLog[this.bossLog.length - 1];
    if (rec) rec.win = win;
    this.dayStats.bossWin = win ? 1 : 0;
    if (win) {
      const next = clampShadow(s.shadowAfterBossWin, s.shadowMax);
      this.stats.shadowCalmed += Math.max(0, this.shadow - next);
      this.shadow = next;
      this.stats.bossWins += 1; // 기쁨 +joyReward는 일반 처치 처리로 이미 반영
    } else {
      this.shadow = clampShadow(s.shadowAfterBossLose, s.shadowMax);
      this.joy = Math.max(0, this.joy - boss.joyPenalty);
      this.abyss.addExtraHp(boss.sinkLayerHp);
      this.stats.bossLosses += 1;
    }
    out.push({ type: 'backflowEnd', win });
  }

  /**
   * 층 돌파 (§5.17-5: 귀환 없음, 유닛은 그대로 다음 층으로). 그림자 −layerClearShadowReduce.
   * 갈림길 face를 고른 날의 첫 층 돌파면 조각 +1 (1단계 랜덤 체인). 보스 층이면 와일드카드 + 그림자 감소 × 2.
   * 1-turningPoint → 갈림길 대기, 1-length → 챕터 완성 (그 틱 끝에).
   */
  private clearLayer(layer: number, out: CoreEvent[]): void {
    const b = this.data.balance;
    const src = this.heroUnitOf('offense') ?? { x: this.abyss.geo.centerX, y: this.abyss.geo.wallY };
    const bonus: Grant[] = [];
    if (this.faceBonusToday) {
      this.faceBonusToday = false;
      const chain = pickChain(this.rng, this.data.chains.map((c) => ({ id: c.archetypeId, weight: this.chainWeight(c.archetypeId) })));
      bonus.push(this.grantPiece(this.newPiece(chain, 1), src.x, src.y));
    }
    const boss = isBossFloor(b.abyss, layer);
    if (!this.shadowLocked) {
      const next = Math.max(0, this.shadow - b.abyss.layerClearShadowReduce * (boss ? 2 : 1));
      this.stats.shadowPurified += this.shadow - next;
      this.shadow = next;
    }
    this.stats.layersCleared += 1;
    this.dayStats.layersCleared += 1;
    this.dayStats.layerClearTimes.push(this.playTime);
    const ch = b.chapter;
    if (layer === ch.turningPoint) {
      this.pendingCrossroad = true;
      if (!this.stats.turningPointClearedDay) this.stats.turningPointClearedDay = this.day;
    }
    if (layer + 1 === ch.turningPoint && !this.stats.turningPointReachedDay) this.stats.turningPointReachedDay = this.day;
    if (layer === ch.length) this.chapterCleared = true;
    out.push({ type: 'layerClear', layer, bonus });
    if (boss) {
      this.stats.bossFloorsCleared += 1;
      const rewards: Grant[] = [];
      for (let k = 0; k < b.abyss.bossFloorWildcards; k++) {
        rewards.push(this.grantPiece(this.newPiece(WILDCARD, 0), src.x, src.y));
        this.stats.wildcardsGained += 1;
      }
      out.push({ type: 'bossFloorClear', layer, rewards });
    }
    if (isBossFloor(b.abyss, this.abyss.wall.layer)) this.stats.bossFloorsReached += 1;
  }

  /** 조각 지급: 빈 칸(rng)에, 없으면 사라짐 */
  private grantPiece(piece: Piece, x: number, y: number): Grant {
    const index = pickEmpty(this.rng, this.grid);
    if (index !== null) this.grid.cells[index] = piece;
    else {
      this.lostReturns += 1;
      this.dayStats.lostReturns += 1;
    }
    return { x, y, piece, placedAt: index, lost: index === null };
  }

  // ── 하루 흐름 (§5.7, §5.17-10) ──

  private resolveToday(): DayEvent {
    const forced = this.forcedNext ? eventById(this.data, this.forcedNext) : null;
    this.forcedNext = null;
    const e = forced ?? resolveDayEvent(this.data, this.day, this.rng, this.dailyUsed);
    if (e.kind === 'daily') this.dailyUsed.push({ id: e.id, day: this.day });
    return e;
  }

  /**
   * 이야기 장면 카드를 닫는다(갈림길이면 선택). 하루 시작 처리 (이 순서):
   * 1. spawnedToday = 0
   * 2. 이벤트 효과: joy 가감(0 미만 불가) → freePieces 지급 → chainWeight → worryMultiplier(그날 밤)
   *    → 아침 기쁨 바닥 joy = max(joy, morningJoyFloor) (D-024)
   * 3. 갈림길 선택 효과 (face: 현재 층 남은 HP × (1 − reduce)는 오늘 낮에 바로)
   * 4. 낮(오펜스) 시작: 오펜스 영웅이 심연 출발선에 hp 가득으로, offense.seconds
   */
  confirmDay(choiceId?: string): ConfirmResult {
    if (this.phase !== 'dayStart') return { ok: false, reason: 'notDayStart' };
    const e = this.today;
    const choice = e.kind === 'milestone' ? e.event.choices.find((c) => c.id === choiceId) : undefined;
    if (e.kind === 'milestone' && choiceId === undefined) return { ok: false, reason: 'needChoice' };
    if (e.kind === 'milestone' && !choice) return { ok: false, reason: 'badChoice' };
    const out = this.pending;
    const shadowBefore = this.shadow;
    this.assignmentDone = true;

    // 1
    this.spawnedToday = 0;
    this.dayStats = emptyDayStats(this.joy, this.data.balance.grid.maxTier);
    this.faceBonusToday = false;

    // 2
    const fx = effectsOf(e);
    if (fx.joy !== undefined) this.joy = Math.max(0, this.joy + fx.joy);
    if (fx.shadow !== undefined) this.addShadow(fx.shadow);
    for (const fp of fx.freePieces ?? []) {
      out.push({ type: 'freePiece', grant: this.grantPiece(this.newPiece(fp.chain, fp.tier), this.abyss.geo.centerX, this.abyss.geo.startY) });
    }
    this.chainWeightToday = { ...(fx.chainWeight ?? {}) };
    this.worryMultToday = fx.worryMultiplier ?? 1;
    this.joy = Math.max(this.joy, this.data.balance.days.morningJoyFloor);

    // 3
    if (choice) {
      this.joy = Math.max(0, this.joy + choice.joy);
      if (choice.shadow) this.addShadow(choice.shadow);
      this.flags.push(choice.flag);
      if (choice.faceLayerHpReduce !== undefined) {
        const w = this.abyss.wall;
        w.hp = w.hp * (1 - choice.faceLayerHpReduce);
      }
      if (choice.bonusReturnPiece) this.faceBonusToday = true;
    }
    this.dayStats.joyStart = this.joy;

    // 4
    this.phase = 'day';
    this.offenseTimer = this.offenseSeconds;
    this.clearLaneUnits();
    this.wave.phase = 'idle';
    this.enterHero('offense', out);
    // 하루 시작 효과(갈림길 해 쪽 그림자 등)로 그림자가 가득 차면 오늘 밤 첫 웨이브가 보스
    this.checkBackflow(out);
    if (this.shadow !== shadowBefore) out.push({ type: 'shadowChange', value: this.shadow, weather: this.weather });
    out.push({ type: 'dayBegin', day: this.day, event: e, bossTonight: this.carryBackflow });
    return { ok: true };
  }

  /** 두 레인 위 우리 편·걱정을 모두 비운다 (단계가 바뀔 때) */
  private clearLaneUnits(): void {
    this.abyss.units.length = 0;
    this.defense.units.length = 0;
    this.defense.worries.length = 0;
    this.heroUnit = { offense: null, defense: null };
    this.unitRoles.clear();
    this.defenseDown = 0;
  }

  /**
   * 해질녘 (즉시): 낮 병사·영웅은 물러난다(귀환 없음) → 기세 초기화 → 밤(디펜스) 시작:
   * 디펜스 영웅이 거점 앞에 hp 가득으로, 웨이브 시작 (낮에 예약된 역류면 첫 웨이브가 보스 + 준비 시간).
   */
  private dusk(out: CoreEvent[]): void {
    this.offenseTimer = 0;
    this.clearLaneUnits();
    for (const r of ROLES) this.resetMomentum(r);
    this.phase = 'night';
    const carried = this.carryBackflow;
    this.carryBackflow = false;
    this.wave.startDay(this.day, this.worryMultToday, carried);
    this.enterHero('defense', out);
    out.push({ type: 'dusk', day: this.day });
  }

  /** 1-length 정화: 그날 밤 없이 이야기 한 장(밤 문장 없음)을 쓰고 바로 챕터 완성 (§5.17-10) */
  private finishChapterDay(out: CoreEvent[]): void {
    this.endDay(out, false);
    this.enterChapterComplete(true, out);
  }

  /**
   * 새벽 (즉시 처리): 레인 비움 → 이야기 한 장 생성 (그날 dayStats 기준) → dayStats 초기화.
   * 그리드·그림자·심연 층·역류 예약은 다음 날로 이어진다.
   */
  private endDay(out: CoreEvent[], hadNight: boolean): void {
    this.phase = 'diary';
    this.offenseTimer = 0;
    this.clearLaneUnits();
    for (const r of ROLES) this.resetMomentum(r);
    this.wave.phase = 'idle';
    this.dayStats.joyEnd = this.joy;
    const prev = this.diary.length ? this.diary[this.diary.length - 1] : null;
    const entry = writeDiary(this.data, this.day, this.today, this.dayStats, this.rng, prev, hadNight);
    this.diary.push(entry);
    this.lastDayStats = this.dayStats;
    this.dayStats = emptyDayStats(this.joy, this.data.balance.grid.maxTier);
    out.push({ type: 'dayEnd', day: this.day, entry, stats: this.lastDayStats });
  }

  /**
   * [다음 날] (§5.15-1): maxDays일째 → 미완성 (completed false).
   * 1-turningPoint를 정화했으면 다음 날 dayStart 카드 = 갈림길 (이벤트 추첨 없음).
   */
  nextDay(): boolean {
    if (this.phase !== 'diary') return false;
    if (this.day >= this.maxDays) {
      this.enterChapterComplete(false);
      return true;
    }
    this.day += 1;
    if (this.pendingCrossroad) {
      this.pendingCrossroad = false;
      this.today = this.crossroadCard();
    } else {
      this.today = this.resolveToday();
    }
    this.phase = 'dayStart';
    this.pending.push({ type: 'dayStart', day: this.day, event: this.today });
    return true;
  }

  private crossroadCard(): DayEvent {
    const e = eventById(this.data, this.data.chapter.crossroad);
    if (!e) throw new Error(`갈림길 이벤트 없음: ${this.data.chapter.crossroad}`);
    return e;
  }

  private enterChapterComplete(completed: boolean, out: CoreEvent[] = this.pending): void {
    this.completed = completed;
    this.phase = 'chapterComplete';
    out.push({ type: 'chapterComplete', completed });
  }

  /**
   * 저장된 하루 경계 상태로 복원 (§5.8-2). 생성자가 쓴 rng는 마지막에 rngState로 되돌린다.
   * 레인 유닛·걱정·웨이브 진행 상태는 경계에서 항상 비어 있으므로 기본값 그대로.
   */
  static fromSave(data: GameData, save: SaveGame, rng: SeededRng, geometry: GameGeometry, size: GridSize): GameState {
    const g = new GameState(data, size, rng, geometry, save.seed);
    if (g.grid.cells.length !== save.grid.length) throw new Error(`grid 길이 불일치: ${save.grid.length} ≠ ${g.grid.cells.length}`);
    const today = eventById(data, save.todayId);
    if (!today) throw new Error(`알 수 없는 이벤트: ${save.todayId}`);
    const copy = <T>(v: T): T => structuredClone(v);
    const refill = <T>(dst: T[], src: readonly T[]) => dst.splice(0, dst.length, ...copy(src));

    g.day = save.day;
    g.phase = save.phase;
    g.today = today;
    g.playTime = save.playTime;
    g.tickCount = save.tickCount;
    g.nextPieceId = save.nextPieceId;
    g.nextUnitId = save.nextUnitId;
    g.spawnedToday = save.spawnedToday;
    g.joy = save.joy;
    g.shadow = save.shadow;
    g.pendingBackflow = save.pendingBackflow;
    g.carryBackflow = save.carryBackflow;
    refill(g.grid.cells, save.grid);
    g.lostReturns = save.lostReturns;
    Object.assign(g.abyss.wall, save.abyss);
    g.abyss.syncWallForLayer(); // 보스 층이면 반격 배수 (§5.13-4)
    g.defense.happy.cd = save.happyCd;
    g.defense.nextWorryId = save.nextWorryId;
    g.wave.day = save.waveDay;
    Object.assign(g.stats, copy(save.stats));
    refill(g.diary, save.diary);
    refill(g.flags, save.flags);
    refill(g.dailyUsed, save.dailyUsed);
    g.lastDayStats = copy(save.lastDayStats);
    refill(g.bossLog, save.bossLog);
    refill(g.feedLog, save.feedLog);
    g.completed = save.completed;
    g.pendingCrossroad = save.pendingCrossroad;
    g.chapterCleared = save.chapterCleared;
    g.assignmentDone = save.assignmentDone;
    g.heroes.offense = copy(save.heroes.offense);
    g.heroes.defense = copy(save.heroes.defense);
    g.dayStats = emptyDayStats(g.joy, data.balance.grid.maxTier);
    g.pending = [];
    rng.setState(save.rngState);
    return g;
  }

  // ── 조각 생성 ──

  get spawnCost(): number {
    return spawnCost(this.data.balance.grid, this.spawnedToday);
  }

  get spawnBlock(): SpawnBlock | null {
    return spawnBlock(this.grid, this.joy, this.spawnCost);
  }

  /** 오늘 체인 가중치: spawnWeight × 이벤트 chainWeight */
  chainWeight(id: string): number {
    const c = this.data.chains.find((ch) => ch.archetypeId === id);
    return (c?.spawnWeight ?? 0) * (this.chainWeightToday[id] ?? 1);
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
    this.spawnedToday += 1;
    this.dayStats.spawns += 1;
    const piece = this.newPiece(chain, 1);
    this.grid.cells[index] = piece;
    return { index, piece };
  }

  // ── 드래그 ──

  /** 드롭: 머지 / 교환·이동 (조합 제작은 끔, §5.17-6). 전투 중 머지면 버프 + 병사 */
  drop(from: number, to: number | null): DropKind {
    const kind = applyDrop(this.grid, from, to);
    if (kind === 'merge') {
      this.dayStats.merges += 1;
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
    this.dayStats.battleMerges += 1;
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
      this.dayStats.soldiersCapped += 1;
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
    this.dayStats.soldiers += 1;
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
    this.dayStats.releases += 1;
    const t = isWildcard(r.piece) ? 0 : r.piece.tier;
    if (t < this.dayStats.releaseTiers.length) this.dayStats.releaseTiers[t] += 1;
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
      day: this.day,
      role,
      hero: h.id,
      chain: p.chain,
      tier: p.tier,
      points,
      cell: toCell(this.grid, cell),
      heldFor: this.playTime - p.bornAt,
    });
    this.stats.feeds += 1;
    this.dayStats.feeds += 1;
    this.dayStats.feedPoints += points;
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

  /** 그림자 값 설정. shadowMax 이상이면 다음 틱에 역류 예약. 역류 예약·보스 중에는 무시 */
  debugSetShadow(value: number): void {
    if (this.shadowLocked) return;
    this.shadow = clampShadow(value, this.data.balance.shadow.shadowMax);
    this.pending.push({ type: 'shadowChange', value: this.shadow, weather: this.weather });
  }

  /** 역류 즉시 예약 (밤이면 남은 다음 칸, 아니면 오늘·다음 밤 첫 웨이브) */
  debugScheduleBackflow(): void {
    if (this.shadowLocked) return;
    this.scheduleBackflow(this.pending);
    this.pending.push({ type: 'shadowChange', value: this.shadow, weather: this.weather });
  }

  /** 현재 층 HP 0 → 다음 틱(낮)에 돌파 */
  debugBreakLayer(): void {
    this.abyss.wall.hp = 0;
  }

  /** 낮 레인 우리 편 전멸 → 다음 틱에 사망 처리 (영웅이면 그 낮 끝) */
  debugKillAbyssUnits(): void {
    for (const u of this.abyss.units) u.hp = 0;
  }

  /** 밤 영웅 hp 0 → 다음 틱에 쓰러짐 */
  debugKnockDefenseHero(): void {
    const u = this.heroUnitOf('defense');
    if (u) u.hp = 0;
  }

  /** 낮 즉시 종료 → 해질녘 (밤 시작) */
  debugToNight(): void {
    if (this.phase !== 'day') return;
    this.dusk(this.pending);
  }

  /** 밤 즉시 종료 → 새벽 (이야기 한 장). 아직 오지 않은 보스 칸은 다음 밤 첫 웨이브로 넘긴다 */
  debugEndNight(): void {
    if (this.phase !== 'night') return;
    if (this.pendingBackflow) this.carryBackflow = true;
    this.bossActive = false;
    this.endDay(this.pending, true);
  }

  /** 하루 즉시 종료 (이야기 한 장까지): 낮이면 해질녘 → 새벽, 밤이면 새벽 */
  debugEndDay(): void {
    this.debugToNight();
    this.debugEndNight();
  }

  /** 즉시 챕터 완성(true)·미완성(false): 레인을 비우고 chapterComplete */
  debugCompleteChapter(completed: boolean): void {
    if (this.phase === 'chapterComplete') return;
    this.clearLaneUnits();
    this.wave.phase = 'idle';
    this.pendingCrossroad = false;
    this.chapterCleared = completed;
    this.enterChapterComplete(completed);
  }

  /** 심연 층(스테이지)을 바로 바꾼다. 경계(dayStart·diary)에서만 */
  debugSetStage(layer: number): void {
    if (this.phase !== 'dayStart' && this.phase !== 'diary') return;
    this.abyss.debugSetLayer(Math.max(1, Math.min(this.data.balance.chapter.length, Math.floor(layer))));
  }

  /** 다음 dayStart에 이 이벤트를 강제. 지금 dayStart면 오늘 이벤트를 바로 바꾼다 */
  debugForceEvent(id: string): boolean {
    const e = eventById(this.data, id);
    if (!e) return false;
    if (this.phase === 'dayStart') {
      this.today = e;
      this.pending.push({ type: 'dayStart', day: this.day, event: e });
    } else {
      this.forcedNext = id;
    }
    return true;
  }

  /** 특정 일차의 dayStart로 이동 (그리드·그림자·층은 유지, 레인은 비움) */
  debugGotoDay(day: number): void {
    const d = Math.max(1, Math.min(this.maxDays, Math.floor(day)));
    this.clearLaneUnits();
    this.wave.phase = 'idle';
    this.bossActive = false;
    this.completed = null;
    this.day = d;
    this.today = this.resolveToday();
    this.dayStats = emptyDayStats(this.joy, this.data.balance.grid.maxTier);
    this.phase = 'dayStart';
    this.pending.push({ type: 'dayStart', day: this.day, event: this.today });
  }
}

function emptyHero(id: string): HeroState {
  return { id, points: {}, momentum: { stacks: 0, bonus: 0, timer: 0 } };
}
