// 한 판(1챕터) 실행: 시드 하나 × 정책 하나 → 결과 (스펙 §8.1, §5.17-7).
// 시간은 core의 고정 틱으로만, 낮(오펜스)·밤(디펜스)에만 흐른다. 봇은 decisionInterval마다 판단하고 반응 지연 뒤에 행동한다.
// 하루 시작 카드는 봇이 닫고(갈림길이면 정책의 선택), 이야기 한 장 뒤에는 바로 다음 날로 넘어간다.
// 정책에 boundary가 있으면(lazy) 카드를 닫기 전·다음 날로 넘어가기 전에 시간 없이 행동을 몰아서 한다 (전투 밖 머지).
// --saveRoundTrip (§5.8-4): 경계(dayStart·diary)마다 serializeGame → JSON → fromSave로 상태를 갈아끼운다. 봇 rng는 그대로.
import { GameState, type BossRecord, type Role } from '../src/core/game';
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
  /** 이야기 한 장까지 끝낸 날 수 (완성한 날 또는 maxDays) */
  days: number;
  /** 첫 가라앉음이 일어난 웨이브 (판 통산 번호: (일차-1) × wavesPerNight + 칸 + 1). 없으면 null */
  firstSinkWave: number | null;
  firstSinkDay: number | null;
  sunk: number;
  /** index 0 = 1일차 (역류 보스 제외) */
  sunkByDay: number[];
  /** 각 날이 끝났을 때의 기쁨·그림자 */
  joyByDay: number[];
  shadowByDay: number[];
  /** 각 날의 길이(×1 게임 시간, 초) = 오펜스(낮) + 디펜스(밤) */
  dayLengths: number[];
  dayLengthsOffense: number[];
  dayLengthsDefense: number[];
  dayStartJoy: number[];
  dayEndJoy: number[];
  /** 1일차 일반 걱정 수·가라앉은 수 */
  day1Worries: number;
  day1Sunk: number;
  finalJoy: number;
  kills: number;
  /** 그리드 가득 참 상태였던 틱 비율 */
  gridFullRatio: number;
  layersCleared: number;
  backflows: number;
  bossWins: number;
  bossLosses: number;
  bossLog: BossRecord[];
  bossFloorsReached: number;
  bossFloorsCleared: number;
  wildcardsGained: number;
  /** 지급할 칸이 없어 사라진 조각 */
  lostReturns: number;
  /** 오펜스 병사 쓰러짐 */
  abyssDeaths: number;
  /** 낮 영웅이 쓰러져 건너뛴 시간(초) */
  stallSeconds: number;
  maxShadow: number;
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
  // ── v0.13 영웅·먹이기·버프 (§5.17-7) ──
  /** 영웅별 최종 체인 점수 (덱 자리 기준) */
  heroPoints: Record<Role, Record<string, number>>;
  heroIds: Record<Role, string>;
  /** 먹인 단계별 수 (key = 단계) */
  feedTiers: Record<string, number>;
  battleMerges: number;
  affinityMerges: number;
  offenseFalls: number;
  defenseFalls: number;
  buffHeal: number;
  /** 기세 평균 중첩 (전투 시간 기준) */
  momentumAvg: number;
  // ── 병사 ([11]-4) ──
  soldiers: number;
  soldiersCapped: number;
  soldiersByKind: Record<string, number>;
  damageHero: number;
  damageSoldier: number;
  damageBase: number;
  // ── 챕터 진행 (§5.15-6) ──
  /** 판의 끝: 완성 true / maxDays 미완성 false / 시간 상한으로 중단 null */
  completed: boolean | null;
  /** 끝난 일차 (완성이면 완성 일차) */
  endDay: number;
  /** 끝났을 때 스테이지 (1-n의 n) */
  stage: number;
  /** 1-turningPoint 도달·정화 일차 (없으면 null) */
  turningPointReachedDay: number | null;
  turningPointClearedDay: number | null;
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

/** 한 판 + 마지막 상태 (chapterComplete면 serializeGame으로 비교 가능) */
export function runLife(data: GameData, cfg: SimConfig, policy: Policy, opt: RunOptions): { result: RunResult; state: GameState } {
  let state = new GameState(data, opt.grid, mulberry32(opt.seed), simGeometry(data), opt.seed);
  const botRng = mulberry32(botSeed(opt.seed));
  const wpn = data.balance.wave.wavesPerNight;
  const days = data.balance.chapter.maxDays;

  const sunkByDay = new Array<number>(days).fill(0);
  const joyByDay: number[] = [];
  const shadowByDay: number[] = [];
  const dayLengths: number[] = [];
  const dayLengthsOffense: number[] = [];
  const dayLengthsDefense: number[] = [];
  const dayStartJoy: number[] = [];
  const dayEndJoy: number[] = [];
  let firstSinkWave: number | null = null;
  let firstSinkDay: number | null = null;
  let day1Worries = 0;
  let kills = 0;
  let fullTicks = 0;
  let ticks = 0;
  let maxShadow = state.shadow;
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
      if (opt.saveRoundTrip) state = roundTrip(data, state, opt.grid);
      boundary();
      // 카드 닫기 (갈림길이면 정책이 고름. 기본은 첫 선택지)
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
      dayLengthsOffense[i] = st.offenseSeconds;
      dayLengthsDefense[i] = st.defenseSeconds;
      boundary();
      state.nextDay();
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

    const day = state.day;
    const waveNo = (day - 1) * wpn + state.wave.slot + 1;
    const night = state.phase === 'night';
    const events = state.tick(FIXED_DT);
    ticks += 1;
    if (state.grid.cells.every((c) => c !== null)) fullTicks += 1;
    if (state.shadow > maxShadow) maxShadow = state.shadow;
    for (const e of events) {
      if (e.type === 'spawnWorry' && !e.boss && day === 1) day1Worries += 1;
      else if (e.type === 'worryDie') kills += 1;
      // 역류 보스 가라앉음은 일반 가라앉음에 넣지 않는다 (core stats.sunkCount와 같은 기준)
      else if (e.type === 'sink' && !e.boss && night) {
        sunkByDay[day - 1] += 1;
        if (firstSinkWave === null) {
          firstSinkWave = waveNo;
          firstSinkDay = day;
        }
      }
    }
  }

  // 1-10 정화한 날은 이야기 한 장 뒤 바로 chapterComplete라 diary 단계를 거치지 않는다 → 그날 기록을 여기서
  if (state.phase === 'chapterComplete' && state.lastDayStats && dayLengths.length < state.day) {
    const st = state.lastDayStats;
    const i = state.day - 1;
    dayEndJoy[i] = st.joyEnd;
    joyByDay[i] = state.joy;
    shadowByDay[i] = state.shadow;
    dayLengths[i] = st.realSeconds;
    dayLengthsOffense[i] = st.offenseSeconds;
    dayLengthsDefense[i] = st.defenseSeconds;
  }
  const st = state.stats;
  const lived = dayLengths.length;
  const feedTiers: Record<string, number> = {};
  for (const f of state.feedLog) feedTiers[f.tier] = (feedTiers[f.tier] ?? 0) + 1;

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
    dayLengthsOffense,
    dayLengthsDefense,
    dayStartJoy,
    dayEndJoy,
    day1Worries,
    day1Sunk: sunkByDay[0],
    finalJoy: state.joy,
    kills,
    gridFullRatio: ticks === 0 ? 0 : fullTicks / ticks,
    layersCleared: st.layersCleared,
    backflows: st.backflows,
    bossWins: st.bossWins,
    bossLosses: st.bossLosses,
    bossLog: state.bossLog.map((b) => ({ ...b })),
    bossFloorsReached: st.bossFloorsReached,
    bossFloorsCleared: st.bossFloorsCleared,
    wildcardsGained: st.wildcardsGained,
    lostReturns: state.lostReturns,
    abyssDeaths: st.abyssDeaths,
    stallSeconds: st.stallSeconds,
    maxShadow,
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
    completed: state.completed,
    endDay: state.day,
    stage: state.stage,
    turningPointReachedDay: st.turningPointReachedDay || null,
    turningPointClearedDay: st.turningPointClearedDay || null,
  };
  return { result, state };
}
