// 한 판의 core 상태: 기쁨, 누적 게임 시간, 조각 id, 그리드, 귀환 대기열, 방어·심연 레인, 웨이브, 그림자·역류.
// Phaser 의존 없음. scene은 이 객체의 메서드를 호출하고 결과를 표시만 한다.
// 시간은 고정 틱(FIXED_DT)으로만 흐른다: tick(dt)는 누적 시간을 틱 단위로 나눠 처리하고 남은 시간은 다음 호출로 넘긴다.
// 한 틱의 처리 순서는 §4.3.2 (step() 참고).

import type { CombatStats, GameData } from '../data/types';
import {
  WILDCARD,
  WILDCARD_TIER,
  applyDrop,
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
  type AbyssGeometry,
  type LaneEvent,
  type LaneGeometry,
  type Side,
  type Unit,
} from './lane';
import type { Rng } from './rng';
import { clampShadow, weatherOf, type Weather } from './shadow';
import { WaveRunner } from './wave';

/** 소환 불가 사유. empty: 빈 칸 */
export type SummonBlock = 'wildcard' | 'laneFull' | 'empty';

/** 두 레인의 좌표 (scene의 layout.ts에서 만든다) */
export interface GameGeometry {
  defense: LaneGeometry;
  abyss: AbyssGeometry;
}

/** 소환 기록 (metrics M7 대비, 스펙 §4.3.1) */
export interface SummonRecord {
  t: number;
  side: Side;
  chain: string;
  tier: number;
  cell: { col: number; row: number };
  /** 조각 보유 시간 = t - bornAt */
  heldFor: number;
}

/** 층 돌파 귀환 하나 */
export interface LayerReturn {
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

export type CoreEvent =
  | LaneEvent
  | { type: 'summon'; unitId: number; side: Side; slot: number; cell: number; chain: string; tier: number }
  // §4.3.2
  | { type: 'layerClear'; layer: number; returns: LayerReturn[] }
  | { type: 'shadowChange'; value: number; weather: Weather }
  | { type: 'stallStart' }
  | { type: 'stallEnd' }
  | { type: 'backflowPending' }
  | { type: 'backflowStart' }
  | { type: 'backflowEnd'; win: boolean };

export type SummonResult = { ok: true; unit: Unit } | { ok: false; reason: SummonBlock };

export interface GameStats {
  sentUpTierSum: number;
  sentDownTierSum: number;
  worriesDefeated: number;
  totalJoyEarned: number;
  /** 가라앉은 걱정 수 (역류 보스 제외: 보스 가라앉음은 일반 규칙을 따르지 않는다) */
  sunkCount: number;
  layersCleared: number;
  /** 층 돌파·보스 처치로 실제로 줄어든 그림자 합 */
  shadowPurified: number;
  backflows: number;
  bossWins: number;
  bossLosses: number;
  /** Unhappy 멈춤 누적 시간(초) */
  stallSeconds: number;
  /** 심연 유닛 사망 수 */
  abyssDeaths: number;
}

/** 부동소수 누적 오차로 틱이 하나 빠지지 않도록 */
const TICK_EPS = 1e-9;

export class GameState {
  /** 누적 게임 시간(초, 배속 반영). Piece.bornAt 기준 */
  playTime = 0;
  joy: number;
  nextPieceId = 1;
  /** 오늘 생성 횟수. M5 전까지 게임 시작 시 0, 하루 리셋은 M5에서 */
  spawnedToday = 0;
  readonly grid: Grid;
  readonly returnQueue: Piece[] = [];
  /** 귀환 대기열 상한 초과로 소실된 수 (metrics는 M7) */
  lostReturns = 0;
  /** 처리한 고정 틱 수. playTime = tickCount / TICK_RATE */
  tickCount = 0;
  readonly defense: Lane<'defense'>;
  readonly abyss: Lane<'abyss'>;
  readonly wave: WaveRunner;
  readonly stats: GameStats = {
    sentUpTierSum: 0,
    sentDownTierSum: 0,
    worriesDefeated: 0,
    totalJoyEarned: 0,
    sunkCount: 0,
    layersCleared: 0,
    shadowPurified: 0,
    backflows: 0,
    bossWins: 0,
    bossLosses: 0,
    stallSeconds: 0,
    abyssDeaths: 0,
  };
  readonly summonLog: SummonRecord[] = [];
  /** 0 ~ shadowMax */
  shadow: number;
  /** 그림자가 shadowMax에 닿아 역류 보스가 예약됨 (다음 웨이브 시작 때 등장) */
  pendingBackflow = false;
  /** 역류 보스 웨이브 진행 중 */
  bossActive = false;
  /** Unhappy 멈춤 (심연 유닛 0기 + 웨이브 진행 중) */
  unhappyStalled = false;
  /** 영웅 정화로 도감에 기록된 체인 (처음일 때만 추가) */
  readonly heroFirstPurify: string[] = [];
  private nextUnitId = 1;
  /** 아직 틱으로 처리하지 않은 시간 */
  private acc = 0;
  /** 틱 밖(소환 등)에서 생긴 이벤트. 다음 tick()의 반환값에 앞서 포함된다 */
  private pending: CoreEvent[] = [];

  constructor(
    private readonly data: GameData,
    size: GridSize,
    private readonly rng: Rng,
    geometry: GameGeometry,
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
    this.defense = new Lane('defense', geometry.defense, b.happy);
    this.abyss = new Lane('abyss', geometry.abyss, { wall: b.abyss, advanceSpeed: b.lane.abyssAdvanceSpeed });
    this.wave = new WaveRunner({ ...b.wave, hpBase: data.monsters.worry.hpBase });
  }

  get weather(): Weather {
    return weatherOf(this.shadow, this.data.balance.shadow.weatherThresholds);
  }

  /** 역류 예약·보스 진행 중에는 그림자가 shadowMax에 머문다 (보스 결과가 값을 설정한다) */
  get shadowLocked(): boolean {
    return this.pendingBackflow || this.bossActive;
  }

  /**
   * dt: 배속이 반영된 경과 시간(초). 고정 틱 단위로 나눠 처리하고 그동안 생긴 이벤트를 돌려준다.
   * tick(1)과 tick(1/60) × 60은 같은 결과.
   */
  tick(dt: number): CoreEvent[] {
    if (dt > 0) this.acc += dt;
    const n = Math.floor((this.acc + TICK_EPS) / FIXED_DT);
    this.acc = Math.max(0, this.acc - n * FIXED_DT);
    const out = this.pending;
    this.pending = [];
    for (let i = 0; i < n; i++) this.step(out);
    return out;
  }

  /**
   * 고정 틱 하나 (§4.3.2 처리 순서, 고정)
   * 1. 웨이브 진행 (걱정·역류 보스 등장)
   * 2. 방어 레인 step (§4.3.1의 2~6)
   * 3. 심연 레인 step: 전진 → 벽 공격 → 반격 → 사망 → 층 돌파
   * 4. Unhappy 멈춤에 의한 그림자 증가
   * 5. 이번 틱의 가라앉음 반영 (그림자 +, 현재 층 추가 HP +)
   * 6. 역류 판정 (그림자 ≥ shadowMax면 역류 예약)
   */
  private step(out: CoreEvent[]): void {
    this.tickCount += 1;
    this.playTime = this.tickCount / TICK_RATE;
    const b = this.data.balance;
    const shadowBefore = this.shadow;

    // 1. 웨이브 진행
    this.spawnFromWave(out);

    // 2. 방어 레인 (가라앉음은 5단계에서 반영)
    const sinks: { boss: boolean }[] = [];
    let from = out.length;
    this.defense.step(FIXED_DT, out);
    for (let i = from; i < out.length; i++) {
      const e = out[i];
      if (e.type === 'worryDie') {
        this.joy += e.joy;
        this.stats.worriesDefeated += 1;
        this.stats.totalJoyEarned += e.joy;
        if (e.boss) this.bossResult(true, out);
      } else if (e.type === 'sink') {
        sinks.push({ boss: e.boss });
      }
    }

    // 3. 심연 레인
    from = out.length;
    const r = this.abyss.stepAbyss(FIXED_DT, out);
    for (let i = from; i < out.length; i++) {
      if (out[i].type === 'abyssUnitDie') {
        this.stats.abyssDeaths += 1;
        this.addShadow(b.abyss.abyssDeathShadow); // 조각 소실 + 그림자
      }
    }
    if (r.cleared) this.clearLayer(r.cleared.layer, r.cleared.units, out);

    // 4. Unhappy 멈춤: 심연 유닛 0기 + 웨이브 진행 중(보스 웨이브 포함). waiting·gap에는 없음
    const stalled = this.abyss.units.length === 0 && this.wave.active;
    if (stalled !== this.unhappyStalled) {
      this.unhappyStalled = stalled;
      out.push({ type: stalled ? 'stallStart' : 'stallEnd' });
    }
    if (stalled) {
      this.stats.stallSeconds += FIXED_DT;
      this.addShadow(b.abyss.unhappyStallShadowPerSec * FIXED_DT);
    }

    // 5. 가라앉음 반영
    for (const sk of sinks) {
      if (sk.boss) {
        this.bossResult(false, out); // 보스 가라앉음은 일반 규칙(sinkShadow·sinkLayerHp) 미적용
      } else {
        this.stats.sunkCount += 1;
        this.addShadow(b.shadow.sinkShadow);
        this.abyss.addExtraHp(b.shadow.sinkLayerHp);
      }
    }

    // 6. 역류 판정
    if (this.shadow >= b.shadow.shadowMax && !this.shadowLocked) this.scheduleBackflow(out);

    if (this.shadow !== shadowBefore) out.push({ type: 'shadowChange', value: this.shadow, weather: this.weather });
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
        this.bossActive = true;
        this.pendingBackflow = false;
        this.stats.backflows += 1;
        lane.spawnWorry(
          { hp: boss.hp, speed: boss.speed, atk: boss.atk, atkInterval: boss.atkInterval, joyReward: boss.joyReward, boss: true },
          x,
          out,
        );
        out.push({ type: 'backflowStart' });
      } else {
        const worry = this.data.monsters.worry;
        lane.spawnWorry(
          { hp: this.wave.hp, speed: worry.speed, atk: worry.atk, atkInterval: worry.atkInterval, joyReward: worry.joyReward },
          x,
          out,
        );
      }
    }
  }

  /** 그림자 증감. 역류 예약·보스 중에는 shadowMax에 고정 */
  private addShadow(delta: number): void {
    if (this.shadowLocked) return;
    this.shadow = clampShadow(this.shadow + delta, this.data.balance.shadow.shadowMax);
  }

  private scheduleBackflow(out: CoreEvent[]): void {
    this.shadow = this.data.balance.shadow.shadowMax;
    this.pendingBackflow = true;
    this.wave.bossPending = true;
    out.push({ type: 'backflowPending' });
  }

  /** 역류 보스 결과: 처치 → 그림자 = shadowAfterBossWin / 가라앉음 → shadowAfterBossLose, 기쁨 −, 층 추가 HP + */
  private bossResult(win: boolean, out: CoreEvent[]): void {
    const s = this.data.balance.shadow;
    const boss = this.data.monsters.backflowBoss;
    this.bossActive = false;
    if (win) {
      const next = clampShadow(s.shadowAfterBossWin, s.shadowMax);
      this.stats.shadowPurified += Math.max(0, this.shadow - next);
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
   */
  private clearLayer(layer: number, units: Unit[], out: CoreEvent[]): void {
    const maxTier = this.data.balance.grid.maxTier;
    const returns: LayerReturn[] = units.map((u) => {
      let piece: Piece;
      if (u.tier >= maxTier) {
        piece = this.newPiece(WILDCARD, 0);
        if (!this.heroFirstPurify.includes(u.chain)) this.heroFirstPurify.push(u.chain);
      } else {
        piece = this.newPiece(u.chain, u.tier + 1);
      }
      const r = this.enqueueReturn(piece);
      return { unitId: u.id, x: u.x, y: u.y, piece, placedAt: r.placedAt, queued: r.queued, lost: r.lost > 0 };
    });
    if (!this.shadowLocked) {
      const next = Math.max(0, this.shadow - this.data.balance.abyss.layerClearShadowReduce);
      this.stats.shadowPurified += this.shadow - next;
      this.shadow = next;
    }
    this.stats.layersCleared += 1;
    out.push({ type: 'layerClear', layer, returns });
  }

  // ── 조각 생성 ──

  get spawnCost(): number {
    return spawnCost(this.data.balance.grid, this.spawnedToday);
  }

  get spawnBlock(): SpawnBlock | null {
    return spawnBlock(this.grid, this.joy, this.spawnCost);
  }

  /** 기쁨을 쓰고 빈 칸 랜덤 위치에 1단계 조각. 불가하면 null */
  spawn(): { index: number; piece: Piece } | null {
    if (this.spawnBlock) return null;
    const index = pickEmpty(this.rng, this.grid)!;
    // 체인 가중치: M5 전까지 spawnWeight만 (이벤트 보정은 M5)
    const chain = pickChain(
      this.rng,
      this.data.chains.map((c) => ({ id: c.archetypeId, weight: c.spawnWeight })),
    );
    this.joy -= this.spawnCost;
    this.spawnedToday += 1;
    const piece = this.newPiece(chain, 1);
    this.grid.cells[index] = piece;
    return { index, piece };
  }

  // ── 드래그 ──

  /** 머지로 칸이 비면 귀환 대기열을 바로 배치한다 */
  drop(from: number, to: number | null): DropKind {
    const kind = applyDrop(this.grid, from, to);
    if (kind === 'merge') this.flushReturnQueue();
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
    this.flushReturnQueue();
    return r.refund;
  }

  // ── 소환 (§4.3.1, §4.3.2) ──

  laneOf(side: Side): Lane {
    return side === 'happy' ? this.defense : this.abyss;
  }

  /** 드래그 중 미리보기용: 소환할 수 없으면 사유, 가능하면 null. 조각 사유(wildcard)를 레인 사유보다 먼저 본다 */
  canSummon(cell: number, side: Side): SummonBlock | null {
    const p = this.grid.cells[cell];
    if (!p) return 'empty';
    if (isWildcard(p)) return 'wildcard';
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
    const unit = this.laneOf(side).addUnit(this.nextUnitId++, side, piece.chain, piece.tier, this.unitStats(piece.chain, piece.tier))!;
    this.grid.cells[cell] = null;
    this.flushReturnQueue();

    this.summonLog.push({
      t: this.playTime,
      side,
      chain: piece.chain,
      tier: piece.tier,
      cell: toCell(this.grid, cell),
      heldFor: this.playTime - piece.bornAt,
    });
    if (side === 'happy') this.stats.sentUpTierSum += piece.tier;
    else this.stats.sentDownTierSum += piece.tier;
    this.pending.push({ type: 'summon', unitId: unit.id, side, slot: unit.slot, cell, chain: piece.chain, tier: piece.tier });
    return { ok: true, unit };
  }

  /** 1~(maxTier-1)단계 = 공용 추억 정령, maxTier = 체인 영웅 */
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

  // ── 귀환 대기열 (층 돌파 귀환이 사용) ──

  enqueueReturn(piece: Piece): EnqueueResult {
    const r = enqueueReturn(this.grid, this.returnQueue, piece, this.data.balance.grid.returnQueueCap, this.rng);
    this.lostReturns += r.lost;
    return r;
  }

  flushReturnQueue(): number[] {
    return flushReturnQueue(this.grid, this.returnQueue, this.rng);
  }

  // ── 조각 만들기 ──

  newPiece(chain: ChainId | typeof WILDCARD, tier: number): Piece {
    return {
      id: this.nextPieceId++,
      chain,
      tier: chain === WILDCARD ? WILDCARD_TIER : tier,
      bornAt: this.playTime,
    };
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

  /** 역류 즉시 예약 (다음 웨이브 시작 때 보스) */
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
}
