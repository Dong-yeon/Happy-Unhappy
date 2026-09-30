// 한 판(일생) 실행: 시드 하나 × 정책 하나 → 결과 (스펙 §8.1). M5부터 실제 하루 구조(--until life)만.
// 시간은 core의 고정 틱으로만, 하루 단계가 'waves'일 때만 흐른다. 봇은 decisionInterval마다 판단하고 반응 지연 뒤에 행동한다.
// 하루 시작 카드는 봇이 닫고(이정표면 정책의 선택), 그림일기 뒤에는 바로 다음 날로 넘어간다.
// --saveRoundTrip (§5.8-4): 경계(dayStart·diary)마다 serializeGame → JSON → fromSave로 상태를 갈아끼운다. 봇 rng는 그대로.
import type { EndingResult } from '../src/core/ending';
import { GameState, type BossRecord } from '../src/core/game';
import { FIXED_DT } from '../src/core/lane';
import { mulberry32 } from '../src/core/rng';
import { serializeGame, type SaveGame } from '../src/core/save';
import type { GameData } from '../src/data/types';
import { gameGeometry } from '../src/scenes/layout';
import type { Action, Policy, SimConfig } from './types';

export interface RunOptions {
  seed: number;
  grid: { cols: number; rows: number };
  /** 경계마다 저장 round-trip (결과가 끈 실행과 같아야 한다) */
  saveRoundTrip?: boolean;
}

export interface RunResult {
  seed: number;
  /** 끝까지 산 날 수 (정상이면 lifeLengthDays) */
  days: number;
  /** 첫 가라앉음이 일어난 웨이브 (일생 통산 번호: (일차-1) × wavesPerDay + 칸 + 1). 없으면 null */
  firstSinkWave: number | null;
  firstSinkDay: number | null;
  sunk: number;
  /** index 0 = 1일차 (역류 보스 제외) */
  sunkByDay: number[];
  /** 각 날이 끝났을 때의 기쁨·그림자 */
  joyByDay: number[];
  shadowByDay: number[];
  /** 각 날의 길이(×1 게임 시간, 초) = dayStats.realSeconds */
  dayLengths: number[];
  dayStartJoy: number[];
  dayEndJoy: number[];
  /** 1일차 일반 걱정 수·가라앉은 수 */
  day1Worries: number;
  day1Sunk: number;
  finalJoy: number;
  kills: number;
  /** 그리드 가득 참 상태였던 틱 비율 */
  gridFullRatio: number;
  summons: number;
  /** 단계별 소환 수 (key = 단계) */
  summonTiers: Record<string, number>;
  meanSummonTier: number | null;
  /** Happy(창문) / Unhappy(손거울) 소환 비율 */
  upRatio: number | null;
  downRatio: number | null;
  layersCleared: number;
  /** 역류(보스 웨이브) 수 */
  backflows: number;
  bossWins: number;
  bossLosses: number;
  /** 보스 등장 진단 기록 (§5.7) */
  bossLog: BossRecord[];
  /** 귀환 대기열 상한 초과로 소실된 조각 */
  lostReturns: number;
  abyssDeaths: number;
  /** Unhappy 멈춤 누적(초) */
  stallSeconds: number;
  maxShadow: number;
  /** 이정표 flag 기록 */
  flags: string[];
  spawns: number;
  merges: number;
  releases: number;
  /** 실수(엉뚱한 곳 드롭 → 원위치)로 버린 행동 */
  mistakes: number;
  /** 반응 지연 사이에 상태가 바뀌어 core가 거절한 행동 */
  staleActions: number;
  playTime: number;
  /** 결말 (14일을 다 살았을 때). 없으면 null */
  ending: EndingResult | null;
}

/** 봇 rng는 게임 rng와 다른 수열 (같은 시드에서도 서로 간섭하지 않게) */
function botSeed(seed: number): number {
  return (Math.imul(seed, 0x9e3779b1) ^ 0x5bd1e995) >>> 0;
}

export function runOne(data: GameData, cfg: SimConfig, policy: Policy, opt: RunOptions): RunResult {
  return runLife(data, cfg, policy, opt).result;
}

/** 경계 상태를 저장 → JSON → 복원한 새 GameState (저장 누락 필드 검출용) */
function roundTrip(data: GameData, state: GameState, grid: RunOptions['grid']): GameState {
  const save = JSON.parse(JSON.stringify(serializeGame(state))) as SaveGame;
  return GameState.fromSave(data, save, mulberry32(save.seed), gameGeometry(data.balance.lane.laneCap), grid);
}

/** 한 판 + 마지막 상태 (lifeEnd면 serializeGame으로 비교 가능) */
export function runLife(data: GameData, cfg: SimConfig, policy: Policy, opt: RunOptions): { result: RunResult; state: GameState } {
  let state = new GameState(data, opt.grid, mulberry32(opt.seed), gameGeometry(data.balance.lane.laneCap), opt.seed);
  const botRng = mulberry32(botSeed(opt.seed));
  const wpd = data.balance.wave.wavesPerDay;
  const days = data.balance.days.lifeLengthDays;

  const sunkByDay = new Array<number>(days).fill(0);
  const joyByDay: number[] = [];
  const shadowByDay: number[] = [];
  const dayLengths: number[] = [];
  const dayStartJoy: number[] = [];
  const dayEndJoy: number[] = [];
  let firstSinkWave: number | null = null;
  let firstSinkDay: number | null = null;
  let day1Worries = 0;
  let kills = 0;
  let fullTicks = 0;
  let ticks = 0;
  let maxShadow = state.shadow;
  const counts = { spawns: 0, merges: 0, releases: 0, mistakes: 0, staleActions: 0 };

  let nextDecision = 0;
  let pending: { action: Action; at: number } | null = null;
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

  while (state.phase !== 'lifeEnd' && ticks < maxTicks) {
    if (state.phase === 'dayStart') {
      if (opt.saveRoundTrip) state = roundTrip(data, state, opt.grid);
      // 카드 닫기 (이정표면 정책이 고름. 기본은 첫 선택지)
      const choices = state.choices;
      const pick = choices.length ? (policy.milestone?.({ state, rng: botRng, cfg }, choices) ?? choices[0].id) : undefined;
      const r = state.confirmDay(pick);
      if (!r.ok) throw new Error(`confirmDay 실패: ${r.reason}`);
      dayStartJoy[state.day - 1] = state.dayStats.joyStart;
      pending = null;
      nextDecision = state.playTime;
      continue;
    }
    if (state.phase === 'diary') {
      if (opt.saveRoundTrip) state = roundTrip(data, state, opt.grid);
      const st = state.lastDayStats!;
      const i = state.day - 1;
      dayEndJoy[i] = st.joyEnd;
      joyByDay[i] = state.joy;
      shadowByDay[i] = state.shadow;
      dayLengths[i] = st.realSeconds;
      state.nextDay();
      continue;
    }

    // waves: 봇 행동 (틱 사이 = 사람 입력과 같은 시점)
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

    const day = state.day;
    const waveNo = (day - 1) * wpd + state.wave.slot + 1;
    const events = state.tick(FIXED_DT);
    ticks += 1;
    if (state.grid.cells.every((c) => c !== null)) fullTicks += 1;
    if (state.shadow > maxShadow) maxShadow = state.shadow;
    for (const e of events) {
      if (e.type === 'spawnWorry' && !e.boss && day === 1) day1Worries += 1;
      else if (e.type === 'worryDie') kills += 1;
      // 역류 보스 가라앉음은 일반 가라앉음에 넣지 않는다 (core stats.sunkCount와 같은 기준)
      else if (e.type === 'sink' && !e.boss) {
        sunkByDay[day - 1] += 1;
        if (firstSinkWave === null) {
          firstSinkWave = waveNo;
          firstSinkDay = day;
        }
      }
    }
  }

  const summonTiers: Record<string, number> = {};
  for (const r of state.summonLog) summonTiers[r.tier] = (summonTiers[r.tier] ?? 0) + 1;
  const summons = state.summonLog.length;
  const up = state.summonLog.filter((r) => r.side === 'happy').length;
  const st = state.stats;
  const lived = dayLengths.length;

  const result: RunResult = {
    seed: opt.seed,
    days: lived,
    firstSinkWave,
    firstSinkDay,
    sunk: st.sunkCount,
    sunkByDay: sunkByDay.slice(0, lived),
    joyByDay,
    shadowByDay,
    dayLengths,
    dayStartJoy,
    dayEndJoy,
    day1Worries,
    day1Sunk: sunkByDay[0],
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
    bossLog: state.bossLog.map((b) => ({ ...b })),
    lostReturns: state.lostReturns,
    abyssDeaths: st.abyssDeaths,
    stallSeconds: st.stallSeconds,
    maxShadow,
    flags: [...state.flags],
    ...counts,
    playTime: state.playTime,
    ending: state.ending && structuredClone(state.ending),
  };
  return { result, state };
}
