// 한 판(1챕터) 실행: 시드 하나 × 정책 하나 → 결과 (스펙 §8.1, §5.19-6).
// 시간은 core의 고정 틱으로만, 낮(핵 찾아 돌아오기)·밤(핵 지키기)에만 흐른다. 봇은 decisionInterval마다 판단하고 반응 지연 뒤에 행동한다.
// 장면 카드는 봇이 닫고(갈림길이면 정책의 선택), 이야기 한 장 뒤에는 바로 다음 스테이지로 넘어간다.
// 시도 상한(maxAttempts, 기본 sim.json 50): 장면 카드에서 이미 그만큼 시도했으면 그 판은 미완성으로 멈춘다.
// 정책에 boundary가 있으면(lazy) 장면 카드를 닫기 전·다음 스테이지로 넘어가기 전에 시간 없이 행동을 몰아서 한다 (전투 밖 머지).
// --saveRoundTrip (§5.19-7): 경계(장면 카드·이야기 한 장)마다 serializeGame → JSON → fromSave로 상태를 갈아끼운다. 봇 rng는 그대로.
import { ATTEMPT_RESULTS, type AttemptResult, type AttemptStats } from '../src/core/day';
import { GameState, type Role } from '../src/core/game';
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
  /** 시도 상한 (없으면 cfg.maxAttempts) */
  maxAttempts?: number;
}

export interface RunResult {
  seed: number;
  /** 시도 상한 안에 1-length까지 완성 */
  completed: boolean;
  /** 쓴 시도 수 */
  attempts: number;
  /** 끝났을 때 스테이지 */
  stage: number;
  /** 스테이지별 시도 수 (index 0 = 1-1) */
  attemptsByStage: number[];
  /** 스테이지별 첫 시도 성공 여부 (시도 못 했으면 null) */
  firstTry: (boolean | null)[];
  /** 같은 스테이지 연속 실패 최대값 */
  maxFailStreak: number;
  /** 결과별 시도 수 */
  results: Record<AttemptResult, number>;
  /** 스테이지별 결과 수: [stage-1][ATTEMPT_RESULTS 순서] */
  stageResults: number[][];
  /** guardian을 쓰러뜨린 시도의 운반 시간 / 성공한 밤의 핵 남은 HP */
  carryTimes: number[];
  coreHpLeft: number[];
  coreDrops: number;
  coreReturns: number;
  /** 시도 길이(×1 게임 시간, 초) = 낮 + 밤 */
  attemptLengths: number[];
  offenseLengths: number[];
  defenseLengths: number[];
  finalJoy: number;
  kills: number;
  sunk: number;
  /** 그리드 가득 참 상태였던 틱 비율 */
  gridFullRatio: number;
  wildcardsGained: number;
  /** 지급할 칸이 없어 사라진 조각 */
  lostReturns: number;
  offenseSoldierDeaths: number;
  flags: string[];
  spawns: number;
  merges: number;
  releases: number;
  feeds: number;
  /** 실수(엉뚱한 곳 드롭 → 원위치)로 버린 행동 */
  mistakes: number;
  /** 반응 지연 사이에 상태가 바뀌어 core가 거절한 행동 */
  staleActions: number;
  playTime: number;
  // ── 영웅·먹이기·버프 (§5.17-7) ──
  heroPoints: Record<Role, Record<string, number>>;
  heroIds: Record<Role, string>;
  feedTiers: Record<string, number>;
  battleMerges: number;
  affinityMerges: number;
  offenseFalls: number;
  defenseFalls: number;
  buffHeal: number;
  momentumAvg: number;
  // ── 병사 ([11]-4) ──
  soldiers: number;
  soldiersCapped: number;
  soldiersByKind: Record<string, number>;
  damageHero: number;
  damageSoldier: number;
  damageBase: number;
}

/** 봇 rng는 게임 rng와 다른 수열 (같은 시드에서도 서로 간섭하지 않게) */
function botSeed(seed: number): number {
  return (Math.imul(seed, 0x9e3779b1) ^ 0x5bd1e995) >>> 0;
}

/** 레인 슬롯 수 = 영웅 1 + soldierCap */
export function simGeometry(data: GameData) {
  return gameGeometry(data.balance.merge.soldierCap + 1);
}

export function runOne(data: GameData, cfg: SimConfig, policy: Policy, opt: RunOptions): RunResult {
  return runLife(data, cfg, policy, opt).result;
}

/** 경계 상태를 저장 → JSON → 복원한 새 GameState (저장 누락 필드 검출용) */
function roundTrip(data: GameData, state: GameState, grid: RunOptions['grid']): GameState {
  const save = JSON.parse(JSON.stringify(serializeGame(state))) as SaveGame;
  return GameState.fromSave(data, save, mulberry32(save.seed), simGeometry(data), grid);
}

/** 같은 스테이지 연속 실패 최대값 (끝까지 못 넘은 스테이지의 실패도 센다) */
export function maxFailStreak(log: readonly AttemptStats[]): number {
  let best = 0;
  let run = 0;
  let stage = 0;
  for (const a of log) {
    if (a.stage !== stage) {
      stage = a.stage;
      run = 0;
    }
    if (a.result === 'success') run = 0;
    else best = Math.max(best, ++run);
  }
  return best;
}

/** 한 판 + 마지막 상태 */
export function runLife(data: GameData, cfg: SimConfig, policy: Policy, opt: RunOptions): { result: RunResult; state: GameState } {
  let state = new GameState(data, opt.grid, mulberry32(opt.seed), simGeometry(data), opt.seed);
  const botRng = mulberry32(botSeed(opt.seed));
  const maxAttempts = opt.maxAttempts ?? cfg.maxAttempts;
  let kills = 0;
  let fullTicks = 0;
  let ticks = 0;
  const counts = { spawns: 0, merges: 0, releases: 0, feeds: 0, mistakes: 0, staleActions: 0 };

  let nextDecision = 0;
  let pending: { action: Action; at: number } | null = null;
  const maxTicks = Math.ceil(cfg.maxGameSeconds / FIXED_DT);

  const execute = (a: Action, mistakes = true) => {
    // 실수: 드래그 행동(드롭·먹이기·놓아주기)을 엉뚱한 곳에 놓아 원위치 → 아무 일도 없음
    if (mistakes && a.type !== 'spawn' && botRng() < cfg.mistakeRate) {
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
      case 'feed':
        if (state.feed(a.cell, a.role).ok) counts.feeds += 1;
        else counts.staleActions += 1;
        break;
      case 'release':
        if (state.release(a.cell) !== null) counts.releases += 1;
        else counts.staleActions += 1;
        break;
    }
  };

  /** 전투 밖 행동 (lazy): null이 나올 때까지, 실수 없이 */
  const boundary = () => {
    if (!policy.boundary) return;
    for (let k = 0; k < 200; k++) {
      const a = policy.boundary({ state, rng: botRng, cfg });
      if (!a) break;
      execute(a, false);
    }
  };

  while (state.phase !== 'chapterComplete' && ticks < maxTicks) {
    if (state.phase === 'dayStart') {
      if (state.attempt >= maxAttempts) break;
      if (opt.saveRoundTrip) state = roundTrip(data, state, opt.grid);
      boundary();
      // 장면 카드 닫기 (갈림길이면 정책이 고름. 기본은 첫 선택지)
      const choices = state.choices;
      const pick = choices.length ? (policy.milestone?.({ state, rng: botRng, cfg }, choices) ?? choices[0].id) : undefined;
      const r = state.confirmDay(pick);
      if (!r.ok) throw new Error(`confirmDay 실패: ${r.reason}`);
      pending = null;
      nextDecision = state.playTime;
      continue;
    }
    if (state.phase === 'diary') {
      if (opt.saveRoundTrip) state = roundTrip(data, state, opt.grid);
      boundary();
      state.nextStage();
      continue;
    }

    // 낮·밤: 봇 행동 (틱 사이 = 사람 입력과 같은 시점)
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
    for (const e of events) if (e.type === 'worryDie' || e.type === 'enemyDie') kills += 1;
  }

  const st = state.stats;
  const log = state.attemptLog;
  const len = data.balance.chapter.length;
  const feedTiers: Record<string, number> = {};
  for (const f of state.feedLog) feedTiers[f.tier] = (feedTiers[f.tier] ?? 0) + 1;
  const results = Object.fromEntries(ATTEMPT_RESULTS.map((r) => [r, 0])) as Record<AttemptResult, number>;
  const stageResults = Array.from({ length: len }, () => ATTEMPT_RESULTS.map(() => 0));
  const firstTry: (boolean | null)[] = new Array<boolean | null>(len).fill(null);
  for (const a of log) {
    if (!a.result) continue;
    results[a.result] += 1;
    stageResults[a.stage - 1][ATTEMPT_RESULTS.indexOf(a.result)] += 1;
    if (firstTry[a.stage - 1] === null) firstTry[a.stage - 1] = a.result === 'success';
  }

  const result: RunResult = {
    seed: opt.seed,
    completed: state.completed === true,
    attempts: state.attempt,
    stage: state.stage,
    attemptsByStage: [...state.attempts],
    firstTry,
    maxFailStreak: maxFailStreak(log),
    results,
    stageResults,
    carryTimes: log.filter((a) => a.guardianDown).map((a) => a.carrySeconds),
    coreHpLeft: log.filter((a) => a.result === 'success' && a.coreHpEnd !== null).map((a) => a.coreHpEnd!),
    coreDrops: st.coreDrops,
    coreReturns: st.coreReturns,
    attemptLengths: log.map((a) => a.realSeconds),
    offenseLengths: log.map((a) => a.offenseSeconds),
    defenseLengths: log.filter((a) => a.defenseSeconds > 0).map((a) => a.defenseSeconds),
    finalJoy: state.joy,
    kills,
    sunk: st.sunkCount,
    gridFullRatio: ticks === 0 ? 0 : fullTicks / ticks,
    wildcardsGained: st.wildcardsGained,
    lostReturns: state.lostReturns,
    offenseSoldierDeaths: st.offenseSoldierDeaths,
    flags: [...state.flags],
    ...counts,
    playTime: state.playTime,
    heroPoints: { offense: { ...state.heroes.offense.points }, defense: { ...state.heroes.defense.points } },
    heroIds: { offense: state.heroes.offense.id, defense: state.heroes.defense.id },
    feedTiers,
    battleMerges: st.battleMerges,
    affinityMerges: st.affinityMerges,
    offenseFalls: st.offenseFalls,
    defenseFalls: st.defenseFalls,
    buffHeal: st.buffHeal,
    momentumAvg: st.battleSeconds > 0 ? st.momentumStackSeconds / st.battleSeconds : 0,
    soldiers: st.soldiersSpawned,
    soldiersCapped: st.soldiersCapped,
    soldiersByKind: { ...st.soldiersByKind },
    damageHero: st.damageHero,
    damageSoldier: st.damageSoldier,
    damageBase: st.damageBase,
  };
  return { result, state };
}
