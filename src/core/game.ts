// 한 판의 core 상태: 기쁨, 누적 게임 시간, 조각 id, 그리드, 귀환 대기열, 방어 레인, 웨이브.
// Phaser 의존 없음. scene은 이 객체의 메서드를 호출하고 결과를 표시만 한다.
// 시간은 고정 틱(FIXED_DT)으로만 흐른다: tick(dt)는 누적 시간을 틱 단위로 나눠 처리하고 남은 시간은 다음 호출로 넘긴다.

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
import { FIXED_DT, Lane, TICK_RATE, type LaneEvent, type LaneGeometry, type Side, type Unit } from './lane';
import type { Rng } from './rng';
import { WaveRunner } from './wave';

/** 소환 불가 사유. empty: 빈 칸 / unavailable: 아직 없는 레인(손거울은 M4) */
export type SummonBlock = 'wildcard' | 'laneFull' | 'empty' | 'unavailable';

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

export type CoreEvent =
  | LaneEvent
  | { type: 'summon'; unitId: number; side: Side; slot: number; cell: number; chain: string; tier: number };

export type SummonResult = { ok: true; unit: Unit } | { ok: false; reason: SummonBlock };

export interface GameStats {
  sentUpTierSum: number;
  worriesDefeated: number;
  totalJoyEarned: number;
  /** 가라앉은 걱정 수 (그림자·층 HP 연결은 M4) */
  sunkCount: number;
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
  readonly defense: Lane;
  readonly wave: WaveRunner;
  readonly stats: GameStats = { sentUpTierSum: 0, worriesDefeated: 0, totalJoyEarned: 0, sunkCount: 0 };
  readonly summonLog: SummonRecord[] = [];
  private nextUnitId = 1;
  /** 아직 틱으로 처리하지 않은 시간 */
  private acc = 0;
  /** 틱 밖(소환 등)에서 생긴 이벤트. 다음 tick()의 반환값에 앞서 포함된다 */
  private pending: CoreEvent[] = [];

  constructor(
    private readonly data: GameData,
    size: GridSize,
    private readonly rng: Rng,
    defenseGeometry: LaneGeometry,
  ) {
    this.joy = data.balance.start.joy;
    this.grid = createGrid(size, data.balance.grid.maxTier);
    if (defenseGeometry.slotXs.length !== data.balance.lane.laneCap) {
      throw new Error(`방어선 슬롯 수(${defenseGeometry.slotXs.length}) ≠ laneCap(${data.balance.lane.laneCap})`);
    }
    this.defense = new Lane('defense', defenseGeometry, data.balance.happy);
    const { wave } = data.balance;
    this.wave = new WaveRunner({ ...wave, hpBase: data.monsters.worry.hpBase });
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

  /** 고정 틱 하나 (§4.3.1 처리 순서) */
  private step(out: CoreEvent[]): void {
    this.tickCount += 1;
    this.playTime = this.tickCount / TICK_RATE;
    const lane = this.defense;
    const { geo } = lane;

    // 1. 웨이브 진행 (걱정 등장)
    const spawns = this.wave.step(FIXED_DT, lane.worries.length === 0);
    const worry = this.data.monsters.worry;
    for (let i = 0; i < spawns; i++) {
      const x = geo.spawnXMin + this.rng() * (geo.spawnXMax - geo.spawnXMin);
      lane.spawnWorry(
        { hp: this.wave.hp, speed: worry.speed, atk: worry.atk, atkInterval: worry.atkInterval, joyReward: worry.joyReward },
        x,
        out,
      );
    }

    // 2~6. 이동 → 유닛·Happy 공격 → 걱정 공격 → 사망 → 가라앉음
    const from = out.length;
    lane.step(FIXED_DT, out);
    for (let i = from; i < out.length; i++) {
      const e = out[i];
      if (e.type === 'worryDie') {
        this.joy += e.joy;
        this.stats.worriesDefeated += 1;
        this.stats.totalJoyEarned += e.joy;
      } else if (e.type === 'sink') {
        this.stats.sunkCount += 1; // 그림자·층 HP 증가는 M4
      }
    }
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

  // ── 소환 (§4.3.1) ──

  /** 드래그 중 미리보기용: 소환할 수 없으면 사유, 가능하면 null. 조각 사유(wildcard)를 레인 사유보다 먼저 본다 */
  canSummon(cell: number, side: Side): SummonBlock | null {
    const p = this.grid.cells[cell];
    if (!p) return 'empty';
    if (isWildcard(p)) return 'wildcard';
    if (side === 'unhappy') return 'unavailable'; // ◐ 손거울은 M4
    if (this.defense.isFull) return 'laneFull';
    return null;
  }

  /** 즉시: 조각 제거 → 유닛 생성(빈 슬롯) → 귀환 대기열 flush. 소환 순간부터 전투에 참여 */
  summon(cell: number, side: Side): SummonResult {
    const block = this.canSummon(cell, side);
    if (block) return { ok: false, reason: block };
    const piece = this.grid.cells[cell]!;
    const unit = this.defense.addUnit(this.nextUnitId++, side, piece.chain, piece.tier, this.unitStats(piece.chain, piece.tier))!;
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
    this.stats.sentUpTierSum += piece.tier;
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

  // ── 귀환 대기열 (호출은 M4) ──

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

  // ── 디버그 지급 (?debug=1) ──

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
}
