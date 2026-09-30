// 한 판 실행: 시드 하나 × 정책 하나 → 결과 (스펙 §8.1).
// 시간은 core의 고정 틱으로만 흐른다. 봇은 decisionInterval마다 판단하고, 반응 지연 뒤에 행동한다.
import { GameState } from '../src/core/game';
import { FIXED_DT } from '../src/core/lane';
import { mulberry32 } from '../src/core/rng';
import type { GameData } from '../src/data/types';
import { defenseGeometry } from '../src/scenes/layout';
import type { Action, Policy, SimConfig } from './types';

export interface RunOptions {
  seed: number;
  grid: { cols: number; rows: number };
  /** 이 웨이브가 끝나면(다음 웨이브까지의 간격에 들어가면) 종료 */
  untilWave: number;
  /** N웨이브마다 spawnedToday = 0 (M5 하루 구조 근사). null이면 리셋 없음 */
  dayReset: number | null;
}

export interface RunResult {
  seed: number;
  /** 마지막으로 진행한 웨이브 */
  reachedWave: number;
  /** 첫 가라앉음이 일어난 웨이브. 없으면 null */
  firstSinkWave: number | null;
  sunk: number;
  /** index 0 = 웨이브 1 */
  sunkByWave: number[];
  /** 각 웨이브가 끝났을 때의 기쁨 */
  joyByWave: number[];
  finalJoy: number;
  kills: number;
  /** 그리드 가득 참 상태였던 틱 비율 */
  gridFullRatio: number;
  summons: number;
  /** 단계별 소환 수 (key = 단계) */
  summonTiers: Record<string, number>;
  meanSummonTier: number | null;
  /** Happy(창문) 소환 비율. M3는 항상 1 */
  upRatio: number | null;
  spawns: number;
  merges: number;
  releases: number;
  /** 실수(엉뚱한 곳 드롭 → 원위치)로 버린 행동 */
  mistakes: number;
  /** 반응 지연 사이에 상태가 바뀌어 core가 거절한 행동 */
  staleActions: number;
  playTime: number;
}

/** 봇 rng는 게임 rng와 다른 수열 (같은 시드에서도 서로 간섭하지 않게) */
function botSeed(seed: number): number {
  return (Math.imul(seed, 0x9e3779b1) ^ 0x5bd1e995) >>> 0;
}

export function runOne(data: GameData, cfg: SimConfig, policy: Policy, opt: RunOptions): RunResult {
  const state = new GameState(data, opt.grid, mulberry32(opt.seed), defenseGeometry(data.balance.lane.laneCap));
  const botRng = mulberry32(botSeed(opt.seed));

  const sunkByWave: number[] = [];
  const joyByWave: number[] = [];
  let firstSinkWave: number | null = null;
  let kills = 0;
  let fullTicks = 0;
  let ticks = 0;
  const counts = { spawns: 0, merges: 0, releases: 0, mistakes: 0, staleActions: 0 };

  let nextDecision = 0;
  let pending: { action: Action; at: number } | null = null;
  let lastWave = 0;
  const maxTicks = Math.ceil(cfg.maxGameSeconds / FIXED_DT);

  const execute = (a: Action) => {
    // 실수: 드래그 행동(드롭·소환·놓아주기)을 엉뚱한 곳에 놓아 원위치 → 아무 일도 없음
    if (a.type !== 'spawn' && botRng() < cfg.mistakeRate) {
      counts.mistakes += 1;
      return;
    }
    switch (a.type) {
      case 'spawn':
        if (state.spawn()) counts.spawns += 1;
        else counts.staleActions += 1;
        break;
      case 'drop': {
        const kind = state.drop(a.from, a.to);
        if (kind === 'merge') counts.merges += 1;
        else if (kind === 'none') counts.staleActions += 1;
        break;
      }
      case 'summon':
        if (!state.summon(a.cell, a.side).ok) counts.staleActions += 1;
        break;
      case 'release':
        if (state.release(a.cell) !== null) counts.releases += 1;
        else counts.staleActions += 1;
        break;
    }
  };

  while (ticks < maxTicks) {
    // 봇 행동 (틱 사이 = 사람 입력과 같은 시점)
    const t = state.playTime;
    if (pending && t >= pending.at - 1e-9) {
      execute(pending.action);
      pending = null;
    }
    if (!pending && t >= nextDecision - 1e-9) {
      const action = policy.decide({ state, rng: botRng, cfg });
      const delay = cfg.reactionDelay + botRng() * cfg.reactionJitter;
      if (action) pending = { action, at: t + delay };
      nextDecision = Math.max(t + cfg.decisionInterval, pending ? pending.at : 0);
    }

    const events = state.tick(FIXED_DT);
    ticks += 1;
    if (state.grid.cells.every((c) => c !== null)) fullTicks += 1;

    const w = state.wave;
    if (w.n !== lastWave) {
      // 웨이브 전환: 끝난 웨이브의 기쁨 기록, 하루 리셋 근사
      for (let k = lastWave; k < w.n; k++) {
        if (k >= 1) joyByWave[k - 1] = state.joy;
        sunkByWave[k] ??= 0;
      }
      lastWave = w.n;
      if (opt.dayReset && w.n > 1 && (w.n - 1) % opt.dayReset === 0) state.spawnedToday = 0;
    }
    for (const e of events) {
      if (e.type === 'worryDie') kills += 1;
      else if (e.type === 'sink') {
        const idx = Math.max(0, w.n - 1);
        sunkByWave[idx] = (sunkByWave[idx] ?? 0) + 1;
        if (firstSinkWave === null) firstSinkWave = w.n;
      }
    }

    if (w.n > opt.untilWave || (w.n === opt.untilWave && w.phase === 'gap')) break;
  }

  const reachedWave = Math.min(state.wave.n, opt.untilWave);
  joyByWave[reachedWave - 1] ??= state.joy;
  for (let k = 0; k < reachedWave; k++) sunkByWave[k] ??= 0;
  sunkByWave.length = reachedWave;
  joyByWave.length = reachedWave;

  const summonTiers: Record<string, number> = {};
  for (const r of state.summonLog) summonTiers[r.tier] = (summonTiers[r.tier] ?? 0) + 1;
  const summons = state.summonLog.length;
  const up = state.summonLog.filter((r) => r.side === 'happy').length;

  return {
    seed: opt.seed,
    reachedWave,
    firstSinkWave,
    sunk: state.stats.sunkCount,
    sunkByWave,
    joyByWave,
    finalJoy: state.joy,
    kills,
    gridFullRatio: ticks === 0 ? 0 : fullTicks / ticks,
    summons,
    summonTiers,
    meanSummonTier: summons === 0 ? null : state.summonLog.reduce((s, r) => s + r.tier, 0) / summons,
    upRatio: summons === 0 ? null : up / summons,
    ...counts,
    playTime: state.playTime,
  };
}
