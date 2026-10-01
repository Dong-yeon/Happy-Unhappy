// 한 판(일생)의 core 상태: 하루 흐름, 기쁨, 누적 게임 시간, 조각 id, 그리드, 귀환 대기열, 방어·심연 레인, 웨이브, 그림자·역류, 그림일기.
// Phaser 의존 없음. scene은 이 객체의 메서드를 호출하고 결과를 표시만 한다.
// 시간은 고정 틱(FIXED_DT)으로만, 그리고 하루 단계가 'waves'일 때만 흐른다 (§5.7).
// 한 틱의 처리 순서는 §4.3.2 (step() 참고). 하루 시작·끝 처리 순서는 §5.7 (confirmDay() / endDay()).

import type { CombatStats, GameData, Recipe } from '../data/types';
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
  resolveDrop,
  createGrid,
  enqueueReturn,
  flushReturnQueue,
  pickChain,
  pickEmpty,
  releaseAt,
  releaseValue,
  spawnBlock,
  spawnCost,
  type ChainId,
  type DropKind,
  type EnqueueResult,
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
} from './lane';
import { applyGrowth, emptyGrowth, kindOf, traitMult, type GrowthResult, type GrowthState, type Traits } from './growth';
import { LEGEND_TIER, findRecipe, isHeroic } from './recipes';
import type { SeededRng } from './rng';
import type { SaveGame } from './save';
import { emptyGameStats, type GameStats } from './stats';
import { clampShadow, weatherOf, type Weather } from './shadow';
import { DayWaves, type SlotId } from './wave';

/** 소환 불가 사유. empty: 빈 칸 */
/** partyFull: 낮의 맡긴 추억이 laneCap / closed: 지금 단계에서 닫힌 포탈 (밤의 창문, 낮·밤이 아닌 단계) / injured: 부상으로 쉬는 영웅·전설 (§5.13-2) */
export type SummonBlock = 'wildcard' | 'laneFull' | 'empty' | 'partyFull' | 'closed' | 'injured';

/** 두 레인의 좌표 (scene의 layout.ts에서 만든다) */
export interface GameGeometry {
  defense: LaneGeometry;
  abyss: AbyssGeometry;
}

/** 소환 기록 (metrics M7 대비, 스펙 §4.3.1) */
export interface SummonRecord {
  t: number;
  /** 소환한 일차 (M7 metrics) */
  day: number;
  side: Side;
  chain: string;
  tier: number;
  cell: { col: number; row: number };
  /** 조각 보유 시간 = t - bornAt */
  heldFor: number;
  /** 낮의 손거울 = 밤까지 맡김 (§5.11-3). 기록은 맡긴 순간 */
  reserved: boolean;
}

/** 층 돌파·하루 끝 귀환 하나 */
export interface LayerReturn {
  /** 이정표 face 보너스 조각은 -1 */
  unitId: number;
  /** 귀환 연출 시작점 (유닛이 있던 곳) */
  x: number;
  y: number;
  piece: Piece;
  /** 즉시 배치된 칸. 대기·소실이면 null */
  placedAt: number | null;
  queued: boolean;
  lost: boolean;
}

/** 보스 등장 진단 기록 (§5.7): 등장 틱의 상태 + 결과 */
export interface BossRecord {
  day: number;
  slot: SlotId;
  /** 전날 넘어온 역류라 준비 시간이 있었는지 */
  prep: boolean;
  defenseUnits: number;
  defenseAvgTier: number | null;
  abyssUnits: number;
  gridPieces: number;
  joy: number;
  shadowBefore: number;
  /** 처치 true / 가라앉음 false / 아직 null */
  win: boolean | null;
}

export type CoreEvent =
  | LaneEvent
  | { type: 'summon'; unitId: number; side: Side; slot: number; cell: number; chain: string; tier: number }
  // §4.3.2
  | { type: 'layerClear'; layer: number; returns: LayerReturn[] }
  | { type: 'shadowChange'; value: number; weather: Weather }
  | { type: 'stallStart' }
  | { type: 'stallEnd' }
  | { type: 'backflowPending'; slot: SlotId | 'nextMorning' }
  | { type: 'backflowStart'; record: BossRecord }
  | { type: 'backflowEnd'; win: boolean }
  // §5.7
  | { type: 'dayBegin'; day: number; event: DayEvent; bossMorning: boolean }
  | { type: 'freePiece'; ret: LayerReturn }
  /** 하루 끝 귀환 (D-022): 방어(side happy) → 심연(side unhappy) 순으로 한 번씩, 레인 안에서는 소환 순서 */
  | { type: 'dayReturn'; side: Side; returns: LayerReturn[] }
  // §5.11
  /** 낮의 손거울: 그리드 칸의 조각을 밤까지 맡김 */
  | { type: 'reserve'; cell: number; piece: Piece }
  /** 해질녘: 방어 유닛 귀환(dayReturn happy) 뒤, 맡긴 추억이 심연 출발선에 소환됨 (맡긴 순서) */
  | { type: 'dusk'; day: number; units: Unit[] }
  /** 잠들기: 밤을 건너뜀 (남은 시간 × 멈춤 그림자를 한 번에) */
  | { type: 'sleep'; skipped: number }
  // §5.13
  /** 영웅·전설 부상: 레인에서 빠져 즉시 그리드로 (side: happy = 낮 / unhappy = 밤) */
  | { type: 'injured'; side: Side; ret: LayerReturn }
  /** 조합: from 칸이 비고 to 칸에 전설 */
  | { type: 'combine'; recipe: string; from: number; to: number; piece: Piece }
  /** 보스 층 돌파 보상 (와일드카드) */
  | { type: 'bossFloorClear'; layer: number; returns: LayerReturn[] }
  | { type: 'dayEnd'; day: number; entry: DiaryEntry; stats: DayStats }
  | { type: 'dayStart'; day: number; event: DayEvent }
  /** 자라기 (§5.15-1): 1-turningPoint 정화 다음 dayStart 앞 / 챕터 완성·미완성 chapterComplete 앞 */
  | { type: 'growth'; result: GrowthResult }
  | { type: 'chapterComplete'; completed: boolean };

/** 즉시 소환이면 unit, 낮의 손거울(맡기기)이면 unit = null·reserved = 맡긴 조각 */
export type SummonResult =
  | { ok: true; unit: Unit; reserved?: undefined }
  | { ok: true; unit: null; reserved: Piece }
  | { ok: false; reason: SummonBlock };

export type ConfirmResult = { ok: true } | { ok: false; reason: 'notDayStart' | 'needChoice' | 'badChoice' };

export type { GameStats } from './stats';

/** 역류 보스 HP = hp × hpGrowthPerDay^(일차-1) */
export function bossHp(boss: { hp: number; hpGrowthPerDay: number }, day: number): number {
  return boss.hp * Math.pow(boss.hpGrowthPerDay, Math.max(1, day) - 1);
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
  readonly returnQueue: Piece[] = [];
  /** 귀환 대기열 상한 초과로 소실된 수 (metrics는 M7) */
  lostReturns = 0;
  /** 처리한 고정 틱 수. playTime = tickCount / TICK_RATE */
  tickCount = 0;
  readonly defense: Lane<'defense'>;
  readonly abyss: Lane<'abyss'>;
  readonly wave: DayWaves;
  readonly stats: GameStats = emptyGameStats();
  readonly summonLog: SummonRecord[] = [];
  /** 0 ~ shadowMax */
  shadow: number;
  /** 그림자가 shadowMax에 닿아 역류 보스가 예약됨 (보스가 등장하면 해제) */
  pendingBackflow = false;
  /** 저녁 도중·이후 예약 → 다음 날 아침이 보스 (+ 준비 시간, D-021) */
  carryBackflow = false;
  /** 역류 보스 웨이브 진행 중 */
  bossActive = false;
  /** Unhappy 멈춤 (밤 + 심연 유닛 0기) */
  unhappyStalled = false;
  /** 낮에 손거울로 맡긴 추억 (최대 laneCap). 해질녘에 심연 출발선에 소환되고 비워진다 (§5.11-3) */
  readonly nightParty: Piece[] = [];
  /** 밤 남은 시간(초) */
  nightTimer = 0;
  /** 영웅 정화로 도감에 기록된 체인 (처음일 때만 추가) */
  readonly heroFirstPurify: string[] = [];
  /** 전설 정화로 도감에 기록된 조합 id (§5.13-3) */
  readonly legendPurified: string[] = [];

  // ── 하루 (§5.7) ──
  day = 1;
  phase: DayPhase = 'dayStart';
  /** 오늘의 이벤트 (dayStart 카드) */
  today: DayEvent;
  dayStats: DayStats;
  /** 방금 끝난 날의 기록 (diary 단계 표시·시뮬) */
  lastDayStats: DayStats | null = null;
  readonly diary: DiaryEntry[] = [];
  /** 이정표 선택 flag ("avoid" | "face") */
  readonly flags: string[] = [];
  readonly dailyUsed: DailyUse[] = [];
  readonly bossLog: BossRecord[] = [];
  /** 이정표 face: 그날 첫 층 돌파 때 귀환 조각 +1 (그날 한 번) */
  private faceBonusToday = false;
  /** 그날 조각 생성 체인 가중치 배율 (이벤트 chainWeight) */
  private chainWeightToday: Record<string, number> = {};
  /** 디버그: 다음 dayStart에 강제할 이벤트 */
  private forcedNext: string | null = null;
  /** 이정표 face의 층 HP 감소: 그날 해질녘에 적용 (§5.11-4) */
  private faceReduceTonight: number | null = null;
  // ── 챕터 진행 (§5.15-1) ──
  /** 1-turningPoint를 정화함 → 다음 dayStart에 자라기 + 갈림길 (저장: 갈림길 대기) */
  pendingCrossroad = false;
  /** 1-length(보스)를 정화함 → 그날 이야기 한 장 뒤 [다음] = 자라기 + 챕터 완성 */
  chapterCleared = false;
  /** 판의 끝 (chapterComplete): 완성 true / maxDays 미완성 false. 그 전에는 null */
  completed: boolean | null = null;

  // ── 자라기 (§5.14) ──
  readonly growth: GrowthState = emptyGrowth();
  /** `${체인}:${종류}` → 스택 */
  readonly traits: Traits = {};
  /** 자라기마다의 결과 (리포트·metrics·연출) */
  readonly growthLog: GrowthResult[] = [];

  /** 저장(save.ts)이 읽고 쓴다 */
  nextUnitId = 1;
  /** 아직 틱으로 처리하지 않은 시간 */
  private acc = 0;
  /** 틱 밖(소환·하루 전환 등)에서 생긴 이벤트. 다음 tick()의 반환값에 앞서 포함된다 */
  private pending: CoreEvent[] = [];

  constructor(
    private readonly data: GameData,
    size: GridSize,
    readonly rng: SeededRng,
    geometry: GameGeometry,
    /** 이 일생의 시드 (저장·디버그 표시·재현용) */
    readonly seed = 0,
  ) {
    const b = data.balance;
    this.joy = b.start.joy;
    this.shadow = clampShadow(b.start.shadow, b.shadow.shadowMax);
    this.grid = createGrid(size, b.grid.maxTier);
    for (const [name, g] of [
      ['방어선', geometry.defense],
      ['심연', geometry.abyss],
    ] as const) {
      if (g.slotXs.length !== b.lane.laneCap) throw new Error(`${name} 슬롯 수(${g.slotXs.length}) ≠ laneCap(${b.lane.laneCap})`);
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
    this.today = this.resolveToday();
    this.dayStats = emptyDayStats(this.joy, b.grid.maxTier);
  }

  /** 시간은 낮·밤에만 흐른다 */
  get timeFlows(): boolean {
    return this.phase === 'day' || this.phase === 'night';
  }

  get nightSeconds(): number {
    return this.data.balance.night.nightSeconds;
  }

  /** 잠들기 가능: 밤 + 심연 유닛 0기 + 맡긴 추억 0 */
  get canSleep(): boolean {
    return this.phase === 'night' && this.abyss.units.length === 0 && this.nightParty.length === 0;
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

  /** 다음 [다음 날]에 자라기가 이어지는가 (갈림길·챕터 완성·미완성) — 이야기 한 장의 자라기 문장 */
  get growsNext(): boolean {
    return this.pendingCrossroad || this.chapterCleared || this.day >= this.maxDays;
  }

  /** 오늘 이벤트가 이정표면 선택지 */
  get choices(): { id: string; label: string }[] {
    return this.today.kind === 'milestone' ? this.today.event.choices.map((c) => ({ id: c.id, label: c.label })) : [];
  }

  /**
   * dt: 배속이 반영된 경과 시간(초). 고정 틱 단위로 나눠 처리하고 그동안 생긴 이벤트를 돌려준다.
   * tick(1)과 tick(1/60) × 60은 같은 결과. 'waves' 단계가 아니면 시간이 흐르지 않는다.
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
   * 고정 틱 하나. 낮과 밤은 동시에 돌지 않는다 (§5.11-1, D-027).
   * 낮 (방어 레인만): 1. 웨이브 진행 → 2. 방어 레인 step (§4.3.1의 2~6) → 3. 가라앉음 반영 (그림자 +, 현재 층 추가 HP +)
   * 밤 (심연 레인만): 1. 심연 레인 step (전진 → 벽 공격 → 반격 → 사망 → 층 돌파) → 2. Unhappy 멈춤 그림자 → 3. 밤 시간 감소
   * 공통: 역류 판정 (그림자 ≥ shadowMax면 역류 예약)
   * 저녁 웨이브가 끝난 틱이면 해질녘(dusk), 밤 시간이 다 된 틱이면 새벽(dawn → 그림일기)
   */
  private step(out: CoreEvent[]): void {
    this.tickCount += 1;
    this.playTime = this.tickCount / TICK_RATE;
    this.dayStats.realSeconds += FIXED_DT;
    if (this.phase === 'day') this.dayStats.daySeconds += FIXED_DT;
    else this.dayStats.nightSeconds += FIXED_DT;
    const shadowBefore = this.shadow;

    if (this.phase === 'day') this.stepDay(out);
    else this.stepNight(out);

    this.checkBackflow(out);

    if (this.shadow !== shadowBefore) out.push({ type: 'shadowChange', value: this.shadow, weather: this.weather });

    // metrics: 이 틱 끝에 그리드에 빈칸이 없음 (관찰만)
    if (this.grid.cells.every((c) => c !== null)) this.dayStats.gridFullSeconds += FIXED_DT;

    if (this.phase === 'day' && this.wave.phase === 'done') this.dusk(out);
    // 1-length를 정화하면 그 밤은 바로 끝난다 (11층 이상은 가지 않음, §5.15-1)
    else if (this.phase === 'night' && (this.nightTimer <= TICK_EPS || this.chapterCleared)) this.endDay(out);
  }

  /** 낮: 웨이브 → 방어 레인 → 가라앉음 */
  private stepDay(out: CoreEvent[]): void {
    const b = this.data.balance;
    this.spawnFromWave(out);

    const sinks: { boss: boolean }[] = [];
    const from = out.length;
    this.defense.step(FIXED_DT, out);
    for (let i = from; i < out.length; i++) {
      const e = out[i];
      if (e.type === 'unitDie' && isHeroic(e, this.data.balance.grid.maxTier)) {
        // 영웅·전설은 쓰러지지 않고 부상: 즉시 그리드로, 새벽까지 쉼 (§5.13-2)
        this.injure('happy', e, 'dawn', out);
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
        this.abyss.addExtraHp(b.shadow.sinkLayerHp); // 낮에 가라앉은 걱정이 그날 밤 벽을 단단하게 (D-027)
      }
    }
  }

  /** 밤: 심연 레인 → 멈춤 그림자 → 밤 시간 */
  private stepNight(out: CoreEvent[]): void {
    const b = this.data.balance;
    const from = out.length;
    const r = this.abyss.stepAbyss(FIXED_DT, out);
    for (let i = from; i < out.length; i++) {
      const e = out[i];
      if (e.type !== 'abyssUnitDie') continue;
      this.addShadow(b.abyss.abyssDeathShadow); // 그림자 대가는 부상에도 유지
      if (isHeroic(e, this.data.balance.grid.maxTier)) {
        // 영웅·전설 밤 부상: 즉시 그리드로, 다음 날 해질녘까지 쉼 (§5.13-2)
        this.injure('unhappy', e, 'dusk', out);
      } else {
        this.stats.abyssDeaths += 1; // 1~2단계: 조각 소실
        this.dayStats.abyssDeaths += 1;
      }
    }
    if (r.cleared) this.clearLayer(r.cleared.layer, r.cleared.units, out);

    // Unhappy 멈춤 (외면의 대가): 밤 동안 심연 유닛 0기
    this.updateStall(out);
    if (this.unhappyStalled) {
      this.stats.stallSeconds += FIXED_DT;
      this.dayStats.stallSeconds += FIXED_DT;
      this.addShadow(b.night.stallShadowPerSec * FIXED_DT);
    }
    this.nightTimer -= FIXED_DT;
  }

  private updateStall(out: CoreEvent[]): void {
    const stalled = this.phase === 'night' && this.abyss.units.length === 0;
    if (stalled !== this.unhappyStalled) {
      this.unhappyStalled = stalled;
      out.push({ type: stalled ? 'stallStart' : 'stallEnd' });
    }
  }

  private checkBackflow(out: CoreEvent[]): void {
    if (this.shadow >= this.data.balance.shadow.shadowMax && !this.shadowLocked) this.scheduleBackflow(out);
  }

  /** 1단계: 이번 틱에 등장할 걱정(또는 역류 보스) */
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
          {
            hp: bossHp(boss, this.day),
            speed: boss.speed,
            atk: boss.atk,
            atkInterval: boss.atkInterval,
            joyReward: boss.joyReward,
            boss: true,
          },
          x,
          out,
        );
        out.push({ type: 'backflowStart', record });
      } else {
        const worry = this.data.monsters.worry;
        lane.spawnWorry(
          { hp: this.worryHp, speed: worry.speed, atk: worry.atk, atkInterval: worry.atkInterval, joyReward: worry.joyReward },
          x,
          out,
        );
      }
    }
  }

  /** 보스 등장 순간의 방어 상태 (§5.7 진단 기록) */
  private bossRecord(): BossRecord {
    const units = this.defense.units;
    return {
      day: this.day,
      slot: this.wave.slotId,
      prep: this.wave.slot === 0 && this.wave.prepMorning,
      defenseUnits: units.length,
      defenseAvgTier: units.length ? units.reduce((s, u) => s + u.tier, 0) / units.length : null,
      abyssUnits: this.abyss.units.length,
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
   * 역류 예약 (D-021): 그날 남은 웨이브가 있으면 다음 웨이브 칸을 보스로 교체,
   * 저녁 도중·이후면 다음 날 아침이 보스 (+ 준비 시간).
   */
  private scheduleBackflow(out: CoreEvent[]): void {
    this.shadow = this.data.balance.shadow.shadowMax;
    this.pendingBackflow = true;
    // 낮이면 남은 웨이브 칸, 밤·저녁 이후면 다음 날 아침 (D-021, §5.11-5)
    const next = this.phase === 'day' || this.phase === 'dayStart' ? this.wave.nextSlot() : null;
    if (next !== null) {
      this.wave.markBoss(next);
      out.push({ type: 'backflowPending', slot: ['morning', 'noon', 'evening'][next] as SlotId });
    } else {
      this.carryBackflow = true;
      out.push({ type: 'backflowPending', slot: 'nextMorning' });
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
      // 보스 승리 감소분은 결말 점수에 넣지 않는다 (D-023)
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
   * 층 돌파: 그 틱에 살아 있던 유닛 전원 귀환. 1~2단계 → 같은 체인 +1, 3단계 → 와일드카드 + heroFirstPurify.
   * 배치는 enqueueReturn (rng 빈 칸 → 대기열 → 상한 초과 소실). 그림자 −layerClearShadowReduce.
   * 이정표 face를 고른 날의 첫 층 돌파면 조각 +1 (첫 비영웅 유닛의 체인 1단계, 영웅뿐이면 와일드카드).
   */
  private clearLayer(layer: number, units: Unit[], out: CoreEvent[]): void {
    const b = this.data.balance;
    const maxTier = b.grid.maxTier;
    // 정화 (§5.13-3): 1~2단계 → 같은 체인 +1 / 영웅 → 빛나는 영웅 / 전설 → 그대로 + 도감. 와일드카드는 나오지 않는다
    const returns: LayerReturn[] = units.map((u) => {
      let piece: Piece;
      if (u.legend !== undefined) {
        piece = this.newPiece(u.chain, u.tier, { legend: u.legend, shining: u.shining });
        if (!this.legendPurified.includes(u.legend)) this.legendPurified.push(u.legend);
      } else if (u.tier >= maxTier) {
        if (!u.shining) this.stats.shiningMade += 1;
        piece = this.newPiece(u.chain, u.tier, { shining: true });
        if (!this.heroFirstPurify.includes(u.chain)) this.heroFirstPurify.push(u.chain);
      } else {
        piece = this.newPiece(u.chain, u.tier + 1);
      }
      return this.returnPiece(u.id, u.x, u.y, piece);
    });
    if (this.faceBonusToday) {
      this.faceBonusToday = false;
      const first = units.find((u) => u.tier < maxTier);
      const piece = first ? this.newPiece(first.chain, 1) : this.newPiece(WILDCARD, 0);
      if (!first) this.stats.wildcardsGained += 1;
      const src = units[0] ?? { x: this.abyss.geo.centerX, y: this.abyss.geo.wallY };
      returns.push(this.returnPiece(-1, src.x, src.y, piece));
    }
    // 보스 층 (§5.13-4): 돌파하면 와일드카드 + 그림자 감소 × 2
    const boss = isBossFloor(b.abyss, layer);
    if (!this.shadowLocked) {
      const next = Math.max(0, this.shadow - b.abyss.layerClearShadowReduce * (boss ? 2 : 1));
      this.stats.shadowPurified += this.shadow - next;
      this.shadow = next;
    }
    this.stats.layersCleared += 1;
    this.dayStats.layersCleared += 1;
    const ch = b.chapter;
    if (layer === ch.turningPoint) {
      this.pendingCrossroad = true;
      if (!this.stats.turningPointClearedDay) this.stats.turningPointClearedDay = this.day;
    }
    if (layer + 1 === ch.turningPoint && !this.stats.turningPointReachedDay) this.stats.turningPointReachedDay = this.day;
    if (layer === ch.length) this.chapterCleared = true;
    this.dayStats.layerClearTimes.push(this.playTime);
    out.push({ type: 'layerClear', layer, returns });
    if (boss) {
      this.stats.bossFloorsCleared += 1;
      const src = units[0] ?? { x: this.abyss.geo.centerX, y: this.abyss.geo.wallY };
      const rewards: LayerReturn[] = [];
      for (let k = 0; k < b.abyss.bossFloorWildcards; k++) {
        rewards.push(this.returnPiece(-1, src.x, src.y, this.newPiece(WILDCARD, 0)));
        this.stats.wildcardsGained += 1;
      }
      out.push({ type: 'bossFloorClear', layer, returns: rewards });
    }
    if (isBossFloor(b.abyss, this.abyss.wall.layer)) this.stats.bossFloorsReached += 1;
  }

  /** 영웅·전설 부상: 레인에서 빠진 유닛을 같은 조각(빛남·전설 유지)으로 그리드에 돌려보내고 쉬게 한다 */
  private injure(
    side: Side,
    u: { unitId: number; chain: string; tier: number; x: number; y: number; shining?: boolean; legend?: string },
    restUntil: 'dawn' | 'dusk',
    out: CoreEvent[],
  ): void {
    const piece = this.newPiece(u.chain, u.tier, { shining: u.shining, legend: u.legend, restUntil });
    if (side === 'happy') this.stats.injuriesDay += 1;
    else this.stats.injuriesNight += 1;
    this.dayStats.injuries += 1;
    out.push({ type: 'injured', side, ret: this.returnPiece(u.unitId, u.x, u.y, piece) });
  }

  /** 새벽·해질녘: 그때 풀리는 부상 해제 (그리드·귀환 대기열) */
  private releaseRest(when: 'dawn' | 'dusk'): void {
    for (const p of [...this.grid.cells, ...this.returnQueue]) {
      if (p && p.restUntil === when) p.restUntil = null;
    }
  }

  private returnPiece(unitId: number, x: number, y: number, piece: Piece): LayerReturn {
    const r = this.enqueueReturn(piece);
    return { unitId, x, y, piece, placedAt: r.placedAt, queued: r.queued, lost: r.lost > 0 };
  }

  // ── 하루 흐름 (§5.7) ──

  private resolveToday(): DayEvent {
    const forced = this.forcedNext ? eventById(this.data, this.forcedNext) : null;
    this.forcedNext = null;
    const e = forced ?? resolveDayEvent(this.data, this.day, this.rng, this.dailyUsed);
    if (e.kind === 'daily') this.dailyUsed.push({ id: e.id, day: this.day });
    return e;
  }

  /**
   * 이벤트 카드를 닫는다(이정표면 선택). 하루 시작 처리 (이 순서):
   * 1. spawnedToday = 0
   * 2. 이벤트 효과: joy 가감(0 미만 불가) → freePieces 지급 → chainWeight → worryMultiplier
   *    → 아침 기쁨 바닥 joy = max(joy, morningJoyFloor) (D-024, 가산이 아니라 바닥)
   * 3. 이정표 선택 효과
   * 4. 역류가 넘어와 있으면 아침 웨이브를 보스로 (+ 준비 시간)
   * 그다음 'waves' 단계로 (첫 웨이브 전 dayStartDelay 또는 bossPrepSeconds)
   */
  confirmDay(choiceId?: string): ConfirmResult {
    if (this.phase !== 'dayStart') return { ok: false, reason: 'notDayStart' };
    const e = this.today;
    const choice = e.kind === 'milestone' ? e.event.choices.find((c) => c.id === choiceId) : undefined;
    if (e.kind === 'milestone' && choiceId === undefined) return { ok: false, reason: 'needChoice' };
    if (e.kind === 'milestone' && !choice) return { ok: false, reason: 'badChoice' };
    const out = this.pending;
    const shadowBefore = this.shadow;

    // 1
    this.spawnedToday = 0;
    this.dayStats = emptyDayStats(this.joy, this.data.balance.grid.maxTier);
    this.faceBonusToday = false;
    this.faceReduceTonight = null;

    // 2
    const fx = effectsOf(e);
    if (fx.joy !== undefined) this.joy = Math.max(0, this.joy + fx.joy);
    if (fx.shadow !== undefined) this.addShadow(fx.shadow);
    for (const fp of fx.freePieces ?? []) {
      const src = { x: this.defense.geo.centerX, y: this.defense.geo.lineY };
      out.push({ type: 'freePiece', ret: this.returnPiece(-1, src.x, src.y, this.newPiece(fp.chain, fp.tier)) });
    }
    this.chainWeightToday = { ...(fx.chainWeight ?? {}) };
    const mult = fx.worryMultiplier ?? 1;
    this.joy = Math.max(this.joy, this.data.balance.days.morningJoyFloor);

    // 3
    if (choice) {
      this.joy = Math.max(0, this.joy + choice.joy);
      if (choice.shadow) this.addShadow(choice.shadow);
      this.flags.push(choice.flag);
      // 현재 층의 남은 HP × (1 − faceLayerHpReduce): 그날 밤(해질녘)에 1회 (§5.11-4)
      if (choice.faceLayerHpReduce !== undefined) this.faceReduceTonight = choice.faceLayerHpReduce;
      if (choice.bonusReturnPiece) this.faceBonusToday = true;
    }
    this.dayStats.joyStart = this.joy;

    // 4
    const carried = this.carryBackflow;
    this.carryBackflow = false;
    this.wave.startDay(this.day, mult, carried);
    this.phase = 'day';
    // 하루 시작 효과(이정표 Happy 등)로 그림자가 가득 차면 남은 칸(아침)을 보스로
    this.checkBackflow(out);
    if (this.shadow !== shadowBefore) out.push({ type: 'shadowChange', value: this.shadow, weather: this.weather });
    out.push({ type: 'dayBegin', day: this.day, event: e, bossMorning: carried });
    return { ok: true };
  }

  /**
   * 해질녘 (§5.11-1, 즉시 처리. 저녁 웨이브의 마지막 걱정이 처치·가라앉음된 틱 이후):
   * 1. 방어선에 남은 걱정은 사라짐 (가라앉음 아님), 살아남은 방어 유닛 단계 그대로 귀환 (D-022)
   * 2. 이정표 face의 층 HP 감소 (그날 밤)
   * 3. 맡긴 추억이 맡긴 순서대로 심연 출발선 슬롯에 소환됨 → 밤 (nightSeconds)
   */
  private dusk(out: CoreEvent[]): void {
    this.releaseRest('dusk'); // 전날 밤 부상이 풀린다 (§5.13-2)
    this.defense.worries.length = 0;
    const back = this.defense.units.splice(0);
    out.push({ type: 'dayReturn', side: 'happy', returns: back.map((u) => this.returnPiece(u.id, u.x, u.y, this.unitPiece(u))) });
    if (this.faceReduceTonight !== null) {
      const w = this.abyss.wall;
      w.hp = w.hp * (1 - this.faceReduceTonight);
      this.faceReduceTonight = null;
    }
    const units: Unit[] = [];
    for (const p of this.nightParty.splice(0)) {
      const u = this.abyss.addUnit(this.nextUnitId++, 'unhappy', p.chain, p.tier, this.pieceStats(p, 'abyss'));
      if (u) units.push(this.markHeroic(u, p));
    }
    this.wave.phase = 'idle';
    this.phase = 'night';
    this.nightTimer = this.nightSeconds;
    out.push({ type: 'dusk', day: this.day, units: units.map((u) => ({ ...u })) }); // 소환 순간의 사본 (이후 전진은 core에서)
    this.updateStall(out);
  }

  /** [잠들기]: 심연 유닛 0기 + 맡긴 추억 0일 때만. 남은 밤 시간 × 멈춤 그림자를 한 번에 더하고 새벽으로 */
  sleep(): boolean {
    if (!this.canSleep) return false;
    const out = this.pending;
    const skipped = Math.max(0, this.nightTimer);
    const shadowBefore = this.shadow;
    this.stats.stallSeconds += skipped;
    this.dayStats.stallSeconds += skipped;
    this.addShadow(this.data.balance.night.stallShadowPerSec * skipped);
    this.checkBackflow(out);
    if (this.shadow !== shadowBefore) out.push({ type: 'shadowChange', value: this.shadow, weather: this.weather });
    out.push({ type: 'sleep', skipped });
    this.nightTimer = 0;
    this.endDay(out);
    return true;
  }

  /**
   * 새벽 (즉시 처리, 이 순서):
   * 1. 심연 유닛 단계 그대로 귀환 (소환 순서). 칸이 모자라면 대기열 → 상한 초과 소실
   * 2. 그림일기 생성 (그날의 dayStats 기준: 이벤트 + 낮 결과 + 밤 문장)
   * 3. dayStats 초기화
   * 그리드·그림자·심연 층·역류 예약은 다음 날로 이어진다.
   */
  private endDay(out: CoreEvent[]): void {
    this.releaseRest('dawn'); // 그날 낮 부상이 풀린다 (§5.13-2)
    this.phase = 'diary';
    this.updateStall(out); // 멈춤 해제
    this.nightTimer = 0;
    const back = this.abyss.units.splice(0);
    out.push({ type: 'dayReturn', side: 'unhappy', returns: back.map((u) => this.returnPiece(u.id, u.x, u.y, this.unitPiece(u))) });
    this.dayStats.joyEnd = this.joy;
    const prev = this.diary.length ? this.diary[this.diary.length - 1] : null;
    const entry = writeDiary(this.data, this.day, this.today, this.dayStats, this.rng, prev, this.growsNext);
    this.diary.push(entry);
    this.lastDayStats = this.dayStats;
    this.dayStats = emptyDayStats(this.joy, this.data.balance.grid.maxTier);
    this.wave.phase = 'idle';
    out.push({ type: 'dayEnd', day: this.day, entry, stats: this.lastDayStats });
  }

  /**
   * [다음 날] (§5.15-1):
   * - 1-length를 정화한 날 → 자라기 → 챕터 완성 (completed true)
   * - maxDays일째 → 자라기 → 미완성 (completed false)
   * - 1-turningPoint를 정화했으면 → 다음 날 dayStart에 자라기 → 갈림길 카드 (이벤트 추첨 없음)
   */
  nextDay(): boolean {
    if (this.phase !== 'diary') return false;
    if (this.chapterCleared || this.day >= this.maxDays) {
      this.grow();
      this.enterChapterComplete(this.chapterCleared);
      return true;
    }
    this.day += 1;
    if (this.pendingCrossroad) {
      this.pendingCrossroad = false;
      this.grow();
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

  /** 걱정 HP = 일차 HP × ageWorryMult^(자란 횟수) (§5.14-2). 역류 보스는 bossHp 그대로 */
  get worryHp(): number {
    return this.wave.hp * Math.pow(this.data.balance.growth.ageWorryMult, this.growth.branches.length);
  }

  /**
   * 자라기 (즉시, 레인·맡긴 추억이 빈 경계에서만 호출):
   * 그리드(칸 순) + 귀환 대기열(순서대로)의 전설 전부를 소진 (쉬는 전설 포함). 영웅·1~2단계·와일드카드는 남는다.
   * 성장치·기억·특성·갈래 반영. 빈 칸에 대기열을 채운다.
   */
  grow(): GrowthResult {
    const recipes = this.data.recipes.recipes;
    const consumed: GrowthResult['consumed'] = [];
    this.grid.cells.forEach((p, i) => {
      if (!p || p.legend === undefined) return;
      consumed.push({ recipe: p.legend, kind: kindOf(recipes, p.legend), chain: p.chain, cell: i });
      this.grid.cells[i] = null;
    });
    const keep = this.returnQueue.filter((p) => {
      if (p.legend === undefined) return true;
      consumed.push({ recipe: p.legend, kind: kindOf(recipes, p.legend), chain: p.chain, cell: null });
      return false;
    });
    this.returnQueue.splice(0, this.returnQueue.length, ...keep);
    const result = applyGrowth(this.growth, this.traits, consumed, this.data.balance.growth, this.day);
    this.growthLog.push(result);
    this.flushReturnQueue();
    this.pending.push({ type: 'growth', result });
    return result;
  }

  private enterChapterComplete(completed: boolean): void {
    this.completed = completed;
    this.phase = 'chapterComplete';
    this.pending.push({ type: 'chapterComplete', completed });
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
    refill(g.returnQueue, save.returnQueue);
    g.lostReturns = save.lostReturns;
    Object.assign(g.abyss.wall, save.abyss);
    g.abyss.syncWallForLayer(); // 보스 층이면 반격 배수 (§5.13-4)
    g.defense.happy.cd = save.happyCd;
    g.defense.nextWorryId = save.nextWorryId;
    g.wave.day = save.waveDay;
    Object.assign(g.stats, copy(save.stats));
    refill(g.heroFirstPurify, save.heroFirstPurify);
    refill(g.legendPurified, save.legendPurified);
    refill(g.diary, save.diary);
    refill(g.flags, save.flags);
    refill(g.dailyUsed, save.dailyUsed);
    g.lastDayStats = copy(save.lastDayStats);
    refill(g.bossLog, save.bossLog);
    refill(g.summonLog, save.summonLog);
    g.completed = save.completed;
    g.pendingCrossroad = save.pendingCrossroad;
    g.chapterCleared = save.chapterCleared;
    Object.assign(g.growth, copy(save.growth));
    Object.assign(g.traits, copy(save.traits));
    refill(g.growthLog, save.growthLog);
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

  /** 머지로 칸이 비면 귀환 대기열을 바로 배치한다 */
  /** 조합표 (§5.13-5, 표시·봇용) */
  get recipes(): readonly Recipe[] {
    return this.data.recipes.recipes;
  }

  /** from을 to에 놓으면 조합되는 조합 (머지가 아니고 두 칸 모두 조각일 때만, §5.13-5) */
  combinePreview(from: number, to: number | null): Recipe | null {
    if (to === null || resolveDrop(this.grid, from, to) !== 'swap') return null;
    const a = this.grid.cells[from];
    const b = this.grid.cells[to];
    return a && b ? findRecipe(this.data.recipes.recipes, a, b) : null;
  }

  /** 드롭: ① 머지 ② 조합 (순서 무관, B 칸에 전설) ③ 교환·이동 (§5.13-5) */
  drop(from: number, to: number | null): DropKind | 'combine' {
    const recipe = this.combinePreview(from, to);
    if (recipe && to !== null) {
      const a = this.grid.cells[from]!;
      const b = this.grid.cells[to]!;
      const legend = this.newPiece(recipe.inputs[0].chain, LEGEND_TIER, { legend: recipe.id });
      this.grid.cells[from] = null;
      this.grid.cells[to] = legend;
      this.stats.legendsMade += 1;
      this.stats.legendsByRecipe[recipe.id] = (this.stats.legendsByRecipe[recipe.id] ?? 0) + 1;
      const tag = (p: Piece) => `${p.chain}:${p.tier}${p.shining ? '*' : ''}`;
      this.dayStats.combines.push({ t: this.playTime, recipe: recipe.id, inputs: [tag(a), tag(b)] });
      this.pending.push({ type: 'combine', recipe: recipe.id, from, to, piece: legend });
      this.flushReturnQueue();
      return 'combine';
    }
    const kind = applyDrop(this.grid, from, to);
    if (kind === 'merge') {
      // metrics: 머지 수, 3단계(영웅)가 된 체인
      this.dayStats.merges += 1;
      const p = this.grid.cells[to!]!;
      if (p.tier >= this.data.balance.grid.maxTier && !isWildcard(p)) {
        this.stats.tier3ByChain[p.chain] = (this.stats.tier3ByChain[p.chain] ?? 0) + 1;
      }
      this.flushReturnQueue();
    }
    return kind;
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
    this.flushReturnQueue();
    return r.refund;
  }

  // ── 소환 (§4.3.1, §4.3.2) ──

  laneOf(side: Side): Lane {
    return side === 'happy' ? this.defense : this.abyss;
  }

  /** 이 단계에서 포탈이 열려 있는지: 낮 = 창문(즉시)·손거울(맡기기), 밤 = 손거울(즉시)만 (§5.11-2) */
  portalOpen(side: Side): boolean {
    if (this.phase === 'day') return true;
    if (this.phase === 'night') return side === 'unhappy';
    return false;
  }

  /** 낮의 손거울 = 맡기기 */
  isReserve(side: Side): boolean {
    return this.phase === 'day' && side === 'unhappy';
  }

  /**
   * 드래그 중 미리보기용: 소환할 수 없으면 사유, 가능하면 null.
   * 닫힌 포탈 → 빈 칸 → 조각 사유(wildcard) → 정원(맡긴 추억 partyFull / 레인 laneFull) 순.
   */
  canSummon(cell: number, side: Side): SummonBlock | null {
    if (!this.portalOpen(side)) return 'closed';
    const p = this.grid.cells[cell];
    if (!p) return 'empty';
    if (p.restUntil) return 'injured';
    if (isWildcard(p)) return 'wildcard';
    if (this.isReserve(side)) return this.nightParty.length >= this.data.balance.lane.laneCap ? 'partyFull' : null;
    if (this.laneOf(side).isFull) return 'laneFull';
    return null;
  }

  /**
   * 즉시: 조각 제거 → 유닛 생성(빈 슬롯) → 귀환 대기열 flush. 소환 순간부터 전투에 참여.
   * ☀ 창문(happy) = 방어 레인, ◐ 손거울(unhappy) = 심연 레인 출발선.
   */
  summon(cell: number, side: Side): SummonResult {
    const block = this.canSummon(cell, side);
    if (block) return { ok: false, reason: block };
    const piece = this.grid.cells[cell]!;
    // 낮의 손거울: 맡기기 (되돌릴 수 없음). 기록은 맡긴 순간 (§5.11-3)
    if (this.isReserve(side)) {
      this.grid.cells[cell] = null;
      this.flushReturnQueue();
      this.nightParty.push(piece);
      this.recordSummon(piece, cell, side, true);
      this.dayStats.reserved += 1;
      this.pending.push({ type: 'reserve', cell, piece });
      return { ok: true, unit: null, reserved: piece };
    }
    const unit = this.markHeroic(this.laneOf(side).addUnit(this.nextUnitId++, side, piece.chain, piece.tier, this.pieceStats(piece, side === 'happy' ? 'defense' : 'abyss'))!, piece);
    this.grid.cells[cell] = null;
    this.flushReturnQueue();
    this.recordSummon(piece, cell, side, false);
    this.pending.push({ type: 'summon', unitId: unit.id, side, slot: unit.slot, cell, chain: piece.chain, tier: piece.tier });
    return { ok: true, unit };
  }

  /** 소환 기록·통계 (즉시 소환과 맡기기 공통) */
  private recordSummon(piece: Piece, cell: number, side: Side, reserved: boolean): void {
    this.summonLog.push({
      t: this.playTime,
      day: this.day,
      side,
      chain: piece.chain,
      tier: piece.tier,
      cell: toCell(this.grid, cell),
      heldFor: this.playTime - piece.bornAt,
      reserved,
    });
    if (piece.tier === this.data.balance.grid.maxTier && piece.legend === undefined && this.stats.heroFirstSummonDay[piece.chain] === undefined) {
      this.stats.heroFirstSummonDay[piece.chain] = this.day;
    }
    if (side === 'happy') {
      this.stats.sentUpTierSum += piece.tier;
      this.dayStats.sentUp += 1;
    } else {
      this.stats.sentDownTierSum += piece.tier;
      this.dayStats.sentDown += 1;
    }
  }

  /** 1~(maxTier-1)단계 = 공용 추억 정령, maxTier = 체인 영웅 */
  /** 조각의 유닛 능력치: 전설 = 조합표 능력치 / 빛나는 영웅 = 영웅 × shineMult (hp·atk) / 그 외 unitStats (§5.13) */
  /** lane이 있으면 그 레인의 특성 배수 (happy 특성 = 낮 방어, purified 특성 = 밤 심연, 해당 체인만, §5.14-2) */
  pieceStats(p: Pick<Piece, 'chain' | 'tier' | 'shining' | 'legend'>, lane?: 'defense' | 'abyss'): CombatStats {
    const t = lane ? traitMult(this.traits, p.chain, lane, this.data.balance.growth) : 1;
    const withTrait = (s: CombatStats): CombatStats => (t === 1 ? s : { ...s, hp: s.hp * t, atk: s.atk * t });
    if (p.legend !== undefined) {
      const r = this.data.recipes.recipes.find((x) => x.id === p.legend);
      if (!r) throw new Error(`알 수 없는 전설: ${p.legend}`);
      return withTrait(r.legend);
    }
    const s = this.unitStats(p.chain, p.tier);
    if (!p.shining) return withTrait(s);
    const m = this.data.balance.hero.shineMult;
    return withTrait({ ...s, hp: s.hp * m, atk: s.atk * m });
  }

  /** 유닛에 조각의 빛남·전설 표시를 옮긴다 (값이 있을 때만) */
  private markHeroic(u: Unit, p: Piece): Unit {
    if (p.shining) u.shining = true;
    if (p.legend !== undefined) u.legend = p.legend;
    return u;
  }

  /** 하루 끝 귀환: 유닛 → 같은 조각 (빛남·전설 유지, 부상 아님) */
  private unitPiece(u: Unit): Piece {
    return this.newPiece(u.chain, u.tier, { shining: u.shining, legend: u.legend });
  }

  unitStats(chain: ChainId, tier: number): CombatStats {
    if (tier >= this.data.balance.grid.maxTier) {
      const c = this.data.chains.find((ch) => ch.archetypeId === chain);
      if (!c) throw new Error(`알 수 없는 체인: ${chain}`);
      return c.hero;
    }
    const s = this.data.units.commonSpirit.find((u) => u.tier === tier);
    if (!s) throw new Error(`공용 정령 ${tier}단계 능력치 없음`);
    return s;
  }

  // ── 귀환 대기열 (층 돌파·하루 끝·선물 조각) ──

  enqueueReturn(piece: Piece): EnqueueResult {
    // 영웅·전설은 사라지지 않는다: 대기열 상한 무시 (§5.13-2)
    const heroic = !isWildcard(piece) && isHeroic(piece, this.data.balance.grid.maxTier);
    const r = enqueueReturn(this.grid, this.returnQueue, piece, this.data.balance.grid.returnQueueCap, this.rng, heroic);
    this.lostReturns += r.lost;
    this.dayStats.lostReturns += r.lost;
    return r;
  }

  flushReturnQueue(): number[] {
    return flushReturnQueue(this.grid, this.returnQueue, this.rng);
  }

  // ── 조각 만들기 ──

  /** extra는 값이 있을 때만 키로 넣는다 (1~2단계 조각 모양은 그대로) */
  newPiece(
    chain: ChainId | typeof WILDCARD,
    tier: number,
    extra: { shining?: boolean; legend?: string; restUntil?: 'dawn' | 'dusk' | null } = {},
  ): Piece {
    const p: Piece = {
      id: this.nextPieceId++,
      chain,
      tier: chain === WILDCARD ? WILDCARD_TIER : tier,
      bornAt: this.playTime,
    };
    if (extra.shining) p.shining = true;
    if (extra.legend !== undefined) p.legend = extra.legend;
    if (extra.restUntil) p.restUntil = extra.restUntil;
    return p;
  }

  // ── 디버그 (?debug=1) ──

  debugAddJoy(amount: number): void {
    this.joy += amount;
  }

  /** 빈 칸 랜덤 위치에 지급. 칸이 없으면 null */
  debugGrant(
    chain: ChainId | typeof WILDCARD,
    tier: number,
    extra: { shining?: boolean; legend?: string; restUntil?: 'dawn' | 'dusk' | null } = {},
  ): number | null {
    const index = pickEmpty(this.rng, this.grid);
    if (index === null) return null;
    this.grid.cells[index] = this.newPiece(chain, tier, extra);
    return index;
  }

  /** 그림자 값 설정. shadowMax 이상이면 다음 틱에 역류 예약. 역류 예약·보스 중에는 무시 */
  debugSetShadow(value: number): void {
    if (this.shadowLocked) return;
    this.shadow = clampShadow(value, this.data.balance.shadow.shadowMax);
    this.pending.push({ type: 'shadowChange', value: this.shadow, weather: this.weather });
  }

  /** 역류 즉시 예약 (남은 칸이 있으면 다음 칸, 없으면 다음 날 아침) */
  debugScheduleBackflow(): void {
    if (this.shadowLocked) return;
    this.scheduleBackflow(this.pending);
    this.pending.push({ type: 'shadowChange', value: this.shadow, weather: this.weather });
  }

  /** 현재 층 HP 0 → 다음 틱에 층 돌파 */
  debugBreakLayer(): void {
    this.abyss.wall.hp = 0;
  }

  /** 심연 유닛 전멸 → 다음 틱에 사망 처리 (조각 소실 + 그림자) */
  debugKillAbyssUnits(): void {
    for (const u of this.abyss.units) u.hp = 0;
  }

  /** 낮 즉시 종료 → 해질녘 (밤 시작): 남은 걱정은 사라짐 */
  debugToNight(): void {
    if (this.phase !== 'day') return;
    if (this.bossActive) this.bossActive = false;
    // 아직 오지 않은 보스 칸을 건너뛰면 예약을 다음 날 아침으로 넘긴다 (예약이 떠돌지 않게)
    if (this.pendingBackflow) this.carryBackflow = true;
    this.defense.worries.length = 0;
    this.wave.phase = 'done';
    this.dusk(this.pending);
  }

  /** 밤 즉시 종료 → 새벽 (그림일기). 건너뛴 시간의 멈춤 그림자는 없음 (디버그) */
  debugEndNight(): void {
    if (this.phase !== 'night') return;
    this.endDay(this.pending);
  }

  /** 하루 즉시 종료 (그림일기까지): 낮이면 해질녘 → 새벽, 밤이면 새벽 */
  debugEndDay(): void {
    this.debugToNight();
    this.debugEndNight();
  }

  /** 즉시 챕터 완성(true)·미완성(false): 레인을 비우고 자라기 → chapterComplete */
  debugCompleteChapter(completed: boolean): void {
    if (this.phase === 'chapterComplete') return;
    this.clearLanes();
    this.pendingCrossroad = false;
    this.chapterCleared = completed;
    this.grow();
    this.enterChapterComplete(completed);
  }

  /** 심연 층(스테이지)을 바로 바꾼다. 경계(dayStart·diary)에서만 */
  debugSetStage(layer: number): void {
    if (this.phase !== 'dayStart' && this.phase !== 'diary') return;
    this.abyss.debugSetLayer(Math.max(1, Math.min(this.data.balance.chapter.length, Math.floor(layer))));
  }

  private clearLanes(): void {
    this.defense.worries.length = 0;
    this.defense.units.length = 0;
    this.abyss.units.length = 0;
    this.nightParty.length = 0;
    this.nightTimer = 0;
    this.bossActive = false;
    this.unhappyStalled = false;
    this.wave.phase = 'idle';
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
    this.clearLanes();
    this.completed = null;
    this.day = d;
    this.today = this.resolveToday();
    this.dayStats = emptyDayStats(this.joy, this.data.balance.grid.maxTier);
    this.phase = 'dayStart';
    this.pending.push({ type: 'dayStart', day: this.day, event: this.today });
  }
}
