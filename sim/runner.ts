// 한 판 실행: 시드 하나 × 정책 하나 → 결과 (스펙 §8.1).
// 시간은 core의 고정 틱으로만 흐른다. 봇은 decisionInterval마다 판단하고, 반응 지연 뒤에 행동한다.
import { GameState } from '../src/core/game';
import { FIXED_DT } from '../src/core/lane';
import { mulberry32 } from '../src/core/rng';
import type { GameData } from '../src/data/types';
import { gameGeometry } from '../src/scenes/layout';
import type { Action, Policy, SimConfig } from './types';

export interface RunOptions {
  seed: number;
  grid: { cols: number; rows: number };
  /** 이 웨이브가 끝나면(다음 웨이브까지의 간격에 들어가면) 종료 */
  untilWave: number;
  /** N웨이브마다 spawnedToday = 0 (참고용, 생성 횟수 리셋만). null이면 리셋 없음 */
  dayReset: number | null;
  /**
   * 'm5': M5 하루 구조 근사 (§8.1 v0.4.1). wavesPerDay웨이브 = 하루.
   * ① 하루 시작 spawnedToday = 0 ② 하루 끝(저녁 웨이브 정리 후) 방어 유닛 해산 ③ 걱정 HP는 일차 기준 ④ lifeLengthDays일에서 종료.
   * untilWave는 무시하고 lifeLengthDays × wavesPerDay로 정한다. dayReset과 함께 쓰지 않는다.
   */
  dayMode?: 'm5' | null;
}

/** dayMode m5의 종료 웨이브 */
export function m5LastWave(data: GameData): number {
  return data.balance.days.lifeLengthDays * data.balance.wave.wavesPerDay;
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
  /** 각 웨이브가 끝났을 때의 그림자 */
  shadowByWave: number[];
  finalJoy: number;
  kills: number;
  /** 그리드 가득 참 상태였던 틱 비율 */
  gridFullRatio: number;
  summons: number;
  /** 단계별 소환 수 (key = 단계) */
  summonTiers: Record<string, number>;
  meanSummonTier: number | null;
  /** Happy(창문) 소환 비율 */
  upRatio: number | null;
  /** Unhappy(손거울) 소환 비율 */
  downRatio: number | null;
  /** 층 돌파 수 */
  layersCleared: number;
  /** 역류(보스 웨이브) 수 */
  backflows: number;
  bossWins: number;
  bossLosses: number;
  /** 귀환 대기열 상한 초과로 소실된 조각 */
  lostReturns: number;
  /** 심연 유닛 사망 */
  abyssDeaths: number;
  /** Unhappy 멈춤 누적(초) */
  stallSeconds: number;
  maxShadow: number;
  spawns: number;
  merges: number;
  releases: number;
  /** 실수(엉뚱한 곳 드롭 → 원위치)로 버린 행동 */
  mistakes: number;
  /** 반응 지연 사이에 상태가 바뀌어 core가 거절한 행동 */
  staleActions: number;
  playTime: number;
  /** dayMode m5: 일차별 하루 시작·끝 기쁨 (index 0 = 1일차). 그 외 모드는 빈 배열 */
  dayStartJoy: number[];
  dayEndJoy: number[];
  /** 1일차(첫 wavesPerDay웨이브)의 걱정 수·가라앉은 수 */
  day1Worries: number;
  day1Sunk: number;
  /** 방어 유닛 해산 수 (dayMode m5) */
  disbanded: number;
}

/** 봇 rng는 게임 rng와 다른 수열 (같은 시드에서도 서로 간섭하지 않게) */
function botSeed(seed: number): number {
  return (Math.imul(seed, 0x9e3779b1) ^ 0x5bd1e995) >>> 0;
}

export function runOne(data: GameData, cfg: SimConfig, policy: Policy, opt: RunOptions): RunResult {
  const state = new GameState(data, opt.grid, mulberry32(opt.seed), gameGeometry(data.balance.lane.laneCap));
  const botRng = mulberry32(botSeed(opt.seed));
  const m5 = opt.dayMode === 'm5';
  const wpd = data.balance.wave.wavesPerDay;
  const untilWave = m5 ? m5LastWave(data) : opt.untilWave;
  const dayOf = (n: number) => Math.ceil(n / wpd);
  if (m5) state.wave.hpLevel = dayOf; // ③ HP는 일차 기준 (마리 수는 웨이브 기준 그대로)
  const dayStartJoy: number[] = [];
  const dayEndJoy: number[] = [];
  let disbanded = 0;
  let endedDay = 0;
  let day1Worries = 0;

  const sunkByWave: number[] = [];
  const joyByWave: number[] = [];
  const shadowByWave: number[] = [];
  let maxShadow = state.shadow;
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
        if (k >= 1) {
          joyByWave[k - 1] = state.joy;
          shadowByWave[k - 1] = state.shadow;
        }
        sunkByWave[k] ??= 0;
      }
      lastWave = w.n;
      if (opt.dayReset && w.n > 1 && (w.n - 1) % opt.dayReset === 0) state.spawnedToday = 0;
      if (m5 && (w.n - 1) % wpd === 0) {
        // ① 하루 시작 (첫 걱정은 이미 이번 틱에 나왔지만 생성 횟수 리셋은 봇의 다음 행동 전)
        state.spawnedToday = 0;
        dayStartJoy[dayOf(w.n) - 1] = state.joy;
      }
    }
    if (m5 && w.n % wpd === 0 && w.phase === 'gap' && endedDay < dayOf(w.n)) {
      // ② 하루 끝: 저녁 웨이브 정리 후 방어 유닛 해산 (M5에서 core의 하루 끝 처리로 대체)
      endedDay = dayOf(w.n);
      dayEndJoy[endedDay - 1] = state.joy;
      disbanded += state.defense.units.length;
      state.defense.units.length = 0;
    }
    for (const e of events) {
      // 1일차 일반 걱정만 센다 (역류 보스는 가라앉음 집계에서도 빠지므로)
      if (e.type === 'spawnWorry' && !e.boss && w.n <= wpd) day1Worries += 1;
      if (e.type === 'worryDie') kills += 1;
      // 역류 보스 가라앉음은 일반 가라앉음에 넣지 않는다 (core stats.sunkCount와 같은 기준)
      else if (e.type === 'sink' && !e.boss) {
        const idx = Math.max(0, w.n - 1);
        sunkByWave[idx] = (sunkByWave[idx] ?? 0) + 1;
        if (firstSinkWave === null) firstSinkWave = w.n;
      }
    }

    if (state.shadow > maxShadow) maxShadow = state.shadow;
    // 역류 보스가 끼어 있으면 끝날 때까지 (보스 웨이브는 번호를 올리지 않음)
    if (w.n > untilWave || (w.n === untilWave && w.phase === 'gap' && !w.bossPending)) break;
  }

  const reachedWave = Math.min(state.wave.n, untilWave);
  joyByWave[reachedWave - 1] ??= state.joy;
  shadowByWave[reachedWave - 1] ??= state.shadow;
  for (let k = 0; k < reachedWave; k++) sunkByWave[k] ??= 0;
  sunkByWave.length = reachedWave;
  joyByWave.length = reachedWave;
  shadowByWave.length = reachedWave;

  const summonTiers: Record<string, number> = {};
  for (const r of state.summonLog) summonTiers[r.tier] = (summonTiers[r.tier] ?? 0) + 1;
  const summons = state.summonLog.length;
  const up = state.summonLog.filter((r) => r.side === 'happy').length;
  const st = state.stats;

  return {
    seed: opt.seed,
    reachedWave,
    firstSinkWave,
    sunk: state.stats.sunkCount,
    sunkByWave,
    joyByWave,
    shadowByWave,
    finalJoy: state.joy,
    kills,
    gridFullRatio: ticks === 0 ? 0 : fullTicks / ticks,
    summons,
    summonTiers,
    meanSummonTier: summons === 0 ? null : state.summonLog.reduce((s, r) => s + r.tier, 0) / summons,
    upRatio: summons === 0 ? null : up / summons,
    downRatio: summons === 0 ? null : (summons - up) / summons,
    layersCleared: st.layersCleared,
    backflows: st.backflows,
    bossWins: st.bossWins,
    bossLosses: st.bossLosses,
    lostReturns: state.lostReturns,
    abyssDeaths: st.abyssDeaths,
    stallSeconds: st.stallSeconds,
    maxShadow,
    ...counts,
    playTime: state.playTime,
    dayStartJoy,
    dayEndJoy,
    day1Worries,
    day1Sunk: sunkByWave.slice(0, wpd).reduce((s, v) => s + v, 0),
    disbanded,
  };
}
