// 한 판(1챕터) 실행: 시드 하나 × 정책 하나 → 결과 (스펙 §8.1, §5.19-6, §5.20-10).
// --roster start = 시작 모험대(삽살·해태) / all = 디버그 6명 지급. 판 시작에 정책의 편성(없으면 balanced 편성)을 확정한다.
// 시간은 core의 고정 틱으로만, 낮(핵 찾아 돌아오기)·밤(핵 지키기)에만 흐른다. 봇은 decisionInterval마다 판단하고 반응 지연 뒤에 행동한다.
// 장면 카드는 봇이 닫고(갈림길이면 정책의 선택), 이야기 한 장 뒤에는 바로 다음 스테이지로 넘어간다.
// 시도 상한(maxAttempts, 기본 sim.json 50): 장면 카드에서 이미 그만큼 시도했으면 그 판은 미완성으로 멈춘다.
// 정책에 boundary가 있으면(lazy) 장면 카드를 닫기 전·다음 스테이지로 넘어가기 전에 시간 없이 행동을 몰아서 한다 (전투 밖 머지).
// --saveRoundTrip (§5.19-7): 경계(장면 카드·이야기 한 장)마다 serializeGame → JSON → fromSave로 상태를 갈아끼운다. 봇 rng는 그대로.
import { ATTEMPT_RESULTS, type AttemptResult, type AttemptStats } from '../src/core/day';
import { GameState } from '../src/core/game';
import { FIXED_DT } from '../src/core/lane';
import { mulberry32 } from '../src/core/rng';
import { serializeGame, type SaveGame } from '../src/core/save';
import type { GameData } from '../src/data/types';
import { gameGeometry } from '../src/scenes/layout';
import { alternateFormation } from './policies';
import { chainLadder } from './policies/helpers';
import type { Action, Policy, SimConfig } from './types';

export type Roster = 'start' | 'all';

export interface RunOptions {
  seed: number;
  grid: { cols: number; rows: number };
  /** 경계마다 저장 round-trip (결과가 끈 실행과 같아야 한다) */
  saveRoundTrip?: boolean;
  /** 시도 상한 (없으면 cfg.maxAttempts) */
  maxAttempts?: number;
  /** 보유 영웅 (기본 start) */
  roster?: Roster;
  /** 세션 모델 (§5.22-8): 시도 attempts번마다 offlineHours 쉬고(잉크 누적) 이어서. 없으면 쉬지 않음 */
  session?: { attempts: number; offlineHours: number } | null;
  /** 챕터 완성 뒤 10장 다시 읽기 (흠집 없음·숨은 비법서 확인) */
  replayPerfect?: boolean;
}

/** 다시 읽기 한 장에서 그만두는 시도 수 */
const REPLAY_MAX_TRIES = 10;

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
  kills: number;
  sunk: number;
  /** 그리드 가득 참 비율 = 전투 중 가득이던 시간 / 전투 시간 (§5.20-13) */
  gridFullRatio: number;
  /** 조각: 저절로 / 처치 드롭(보스 확정 포함) / 그리드 가득이라 버려짐 */
  piecesAuto: number;
  piecesDropped: number;
  piecesDiscarded: number;
  wildcardsGained: number;
  /** 지급할 칸이 없어 사라진 조각 */
  lostReturns: number;
  offenseSoldierDeaths: number;
  /** 봇 손 머지 수 */
  merges: number;
  /** 자동 뭉침 수 (D-070, core가 저절로) */
  autoMerges: number;
  /** 연쇄 (D-073): 2연쇄 이상 횟수 · 이어 합친 단계 수 합 */
  chains: number;
  chainSteps: number;
  /** 팀 교대 이어받기 (D-072): 회수 횟수·회수한 조각 수 */
  handovers: number;
  handoverPieces: number;
  releases: number;
  /** 실수(엉뚱한 곳 드롭 → 원위치)로 버린 행동 */
  mistakes: number;
  /** 반응 지연 사이에 상태가 바뀌어 core가 거절한 행동 */
  staleActions: number;
  playTime: number;
  // ── 영웅·편성·스킬 (§5.20-10) ──
  /** 판 시작 편성 */
  formation: { offense: string[][]; defense: string[][] };
  /** 켜진 인연 id */
  bonds: string[];
  /** 영웅별 최종 레벨 */
  levels: Record<string, number>;
  /** 영웅별 스킬 발동 수 */
  skillCasts: Record<string, number>;
  /** 팀 교대 수 (낮 / 밤) */
  teamSwapsDay: number;
  teamSwapsNight: number;
  /** 5단계가 만들어진 머지 수 · 특별 버프 발동 수 */
  tier5Made: number;
  specials: number;
  /** 체인별 생성 조각 수 */
  chainSpawns: Record<string, number>;
  damageSkill: number;
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
  // ── 성장 (§5.22-8): 챕터 완성(또는 멈춘) 시점 ──
  /** 세션 수 (첫 세션 1, 쉴 때마다 + 1) */
  sessions: number;
  stars: Record<string, number>;
  inkTime: number;
  inkReward: number;
  inkSpent: number;
  dustEarned: number;
  dustSpent: number;
  promotions: number;
  // ── 다시 읽기 (--replayPerfect, 판 끝) ──
  books: string[];
  perfectPages: number;
  replayAttempts: number;
  replayWins: number;
}

/** 봇 rng는 게임 rng와 다른 수열 (같은 시드에서도 서로 간섭하지 않게) */
function botSeed(seed: number): number {
  return (Math.imul(seed, 0x9e3779b1) ^ 0x5bd1e995) >>> 0;
}

/** 레인 슬롯 수 = 영웅 1 + soldierCap */
export function simGeometry(data: GameData) {
  return gameGeometry(data.balance.merge.soldierCap + data.balance.team.teamSize);
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
  let ticks = 0;
  const counts = { merges: 0, autoMerges: 0, handovers: 0, handoverPieces: 0, chains: 0, chainSteps: 0, releases: 0, mistakes: 0, staleActions: 0 };
  // 보유 영웅·편성 (판 시작, 장면 카드 앞 = 편성 화면 자리)
  if (opt.roster === 'all') {
    state.debugGrantAllHeroes();
    state.debugGrantTestHeroes();
    state.tick(0);
  }
  const f = (policy.formation ?? alternateFormation)(state);
  const fr = state.setFormation(f);
  if (!fr.ok) throw new Error(`편성 실패 (${policy.name}): ${fr.reason}`);
  const startFormation = structuredClone(state.formation);
  const startBonds = state.bonds.map((b) => b.bond.id);

  let nextDecision = 0;
  let pending: { action: Action; at: number } | null = null;
  const maxTicks = Math.ceil(cfg.maxGameSeconds / FIXED_DT);

  const execute = (a: Action, mistakes = true) => {
    // 실수: 드래그 행동(드롭·놓아주기)을 엉뚱한 곳에 놓아 원위치 → 아무 일도 없음
    if (mistakes && botRng() < cfg.mistakeRate) {
      counts.mistakes += 1;
      return;
    }
    switch (a.type) {
      case 'drop': {
        // 연쇄 (D-073): 그리드에 같은 체인 t, t+1 … 이 있으면 chainSkill 확률로 "맞닿게 놓았다"고 가정
        const ladder = chainLadder(state, a.from, a.to);
        const touching = ladder.length && botRng() < cfg.chainSkill ? ladder : [];
        // 연쇄 집계는 drop 직후 state 카운터 차이로 (경계에서 저장·불러오기를 해도 이벤트를 잃지 않게)
        const c0 = state.chains;
        const s0 = state.chainSteps;
        const kind = state.drop(a.from, a.to, touching);
        counts.chains += state.chains - c0;
        counts.chainSteps += state.chainSteps - s0;
        if (kind === 'merge') counts.merges += 1;
        else if (kind === 'none') counts.staleActions += 1;
        break;
      }
      case 'release':
        if (state.release(a.cell)) counts.releases += 1;
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

  // ── 성장 (§5.22-8): 잉크 붓기·진급. 실제 시각 = 게임 시간 + 쉰 시간 ──
  let sessions = 1;
  let sinceSession = 0;
  let offlineMs = 0;
  let growTurn = 0;
  const clock = () => state.playTime * 1000 + offlineMs;
  const sideIds = (role: 'offense' | 'defense') => state.teams(role).flat();
  /** 성장 대상 순서: 번갈아 = 공격대·수비대 번갈아 / 한쪽 몰기 / 무작위 */
  const growTarget = (mode: Policy['grow']): string | null => {
    const off = sideIds('offense');
    const def = sideIds('defense');
    if (mode === 'offense') return off[growTurn++ % off.length] ?? null;
    if (mode === 'defense') return def[growTurn++ % def.length] ?? null;
    if (mode === 'random') {
      const all = [...off, ...def];
      return all.length ? all[Math.floor(botRng() * all.length)] : null;
    }
    const k = growTurn++;
    const side = k % 2 === 0 ? off : def;
    return side.length ? side[Math.floor(k / 2) % side.length] : null;
  };
  const pourAll = () => {
    const mode = policy.grow ?? 'alternate';
    if (mode === 'none') return;
    const step = data.balance.ink.pourStep;
    for (let k = 0; k < 10_000 && state.ink >= 1; k++) {
      const id = growTarget(mode);
      if (!id) break;
      if (state.pourInk(id, Math.min(step, state.ink)).spent === 0) {
        // 상한 레벨 등으로 못 부으면 다른 대상 (모두 못 부으면 멈춤)
        if ([...sideIds('offense'), ...sideIds('defense')].every((h) => state.progressOf(h).level >= data.balance.exp.maxLevel)) break;
      }
    }
  };
  let promoteTurn = 0;
  const promoteAll = () => {
    if (policy.promote === false) return;
    const mode = policy.grow === 'offense' || policy.grow === 'defense' || policy.grow === 'random' ? policy.grow : 'alternate';
    for (let k = 0; k < 20; k++) {
      const off = sideIds('offense');
      const def = sideIds('defense');
      let id: string | null;
      if (mode === 'offense') id = off.find((h) => state.promoteCost(h) !== null) ?? null;
      else if (mode === 'defense') id = def.find((h) => state.promoteCost(h) !== null) ?? null;
      else if (mode === 'random') {
        const all = [...off, ...def].filter((h) => state.promoteCost(h) !== null);
        id = all.length ? all[Math.floor(botRng() * all.length)] : null;
      } else {
        const side = promoteTurn % 2 === 0 ? off : def;
        id = side.find((h) => state.promoteCost(h) !== null) ?? [...off, ...def].find((h) => state.promoteCost(h) !== null) ?? null;
      }
      if (!id || !state.promote(id)) break;
      promoteTurn += 1;
    }
  };
  state.accrueInk(clock());

  const replayQueue: number[] = [];
  let replayTries = 0;
  let base: RunResult | null = null;

  while (ticks < maxTicks) {
    if (state.phase === 'chapterComplete') {
      if (!base) {
        base = collect();
        if (opt.replayPerfect && state.completed) {
          // 다시 읽기는 오누이 포함 전원 (§5.22-6)
          const fr2 = state.setFormation(alternateFormation(state));
          if (!fr2.ok) throw new Error(`다시 읽기 편성 실패: ${fr2.reason}`);
          for (let k = 1; k <= data.balance.chapter.length; k++) replayQueue.push(k);
        }
      }
      const next = replayQueue.shift();
      if (next === undefined) break;
      state.startReplay(next);
      replayTries = 0;
      continue;
    }
    if (state.phase === 'dayStart') {
      if (state.replay === null && state.attempt >= maxAttempts) break;
      if (opt.saveRoundTrip) state = roundTrip(data, state, opt.grid);
      if (state.replay !== null && replayTries >= REPLAY_MAX_TRIES) {
        state.exitReplay();
        continue;
      }
      // 세션: 시도 session.attempts번마다 쉬고 잉크가 쌓인 뒤, 세션 시작에 잉크를 전부 붓는다
      state.accrueInk(clock());
      if (opt.session) {
        if (sinceSession >= opt.session.attempts) {
          offlineMs += opt.session.offlineHours * 3_600_000;
          sessions += 1;
          sinceSession = 0;
          state.accrueInk(clock());
          pourAll();
        } else if (state.attempt === 0) pourAll();
      } else pourAll();
      promoteAll();
      boundary();
      const r = state.confirmDay();
      if (!r.ok) throw new Error(`confirmDay 실패: ${r.reason}`);
      sinceSession += 1;
      if (state.replay !== null) replayTries += 1;
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
    for (const e of events) {
      if (e.type === 'worryDie' || e.type === 'enemyDie') kills += 1;
      else if (e.type === 'autoMerge') counts.autoMerges += 1;
      else if (e.type === 'handover') {
        counts.handovers += 1;
        counts.handoverPieces += e.cells.length;
      }
    }
  }

  const result: RunResult = {
    ...(base ?? collect()),
    books: [...state.ownedBooks],
    perfectPages: state.perfect.length,
    replayAttempts: state.stats.replayAttempts,
    replayWins: state.stats.replayWins,
  };
  return { result, state };

  /** 판 진행 지표 (다시 읽기 시도는 뺀다) */
  function collect(): RunResult {
  const st = state.stats;
  const log = state.attemptLog.filter((a) => !a.replay);
  const len = data.balance.chapter.length;
  const results = Object.fromEntries(ATTEMPT_RESULTS.map((r) => [r, 0])) as Record<AttemptResult, number>;
  const stageResults = Array.from({ length: len }, () => ATTEMPT_RESULTS.map(() => 0));
  const firstTry: (boolean | null)[] = new Array<boolean | null>(len).fill(null);
  for (const a of log) {
    if (!a.result) continue;
    results[a.result] += 1;
    stageResults[a.stage - 1][ATTEMPT_RESULTS.indexOf(a.result)] += 1;
    if (firstTry[a.stage - 1] === null) firstTry[a.stage - 1] = a.result === 'success';
  }

  return {
    seed: opt.seed,
    completed: state.completed === true,
    attempts: log.length,
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
    kills,
    sunk: st.sunkCount,
    gridFullRatio: st.battleSeconds > 0 ? st.gridFullSeconds / st.battleSeconds : 0,
    piecesAuto: st.piecesAuto,
    piecesDropped: st.piecesDropped,
    piecesDiscarded: st.piecesDiscarded,
    wildcardsGained: st.wildcardsGained,
    lostReturns: state.lostReturns,
    offenseSoldierDeaths: st.offenseSoldierDeaths,
    ...counts,
    playTime: state.playTime,
    formation: startFormation,
    bonds: startBonds,
    levels: Object.fromEntries(state.roster.map((p) => [p.id, p.level])),
    skillCasts: { ...st.skillCasts },
    teamSwapsDay: st.teamSwapsDay,
    teamSwapsNight: st.teamSwapsNight,
    tier5Made: st.tier5Made,
    specials: st.specials,
    chainSpawns: { ...st.chainSpawns },
    damageSkill: st.damageSkill,
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
    sessions,
    stars: Object.fromEntries(state.roster.map((p) => [p.id, p.star])),
    inkTime: st.inkTime,
    inkReward: st.inkReward,
    inkSpent: st.inkSpent,
    dustEarned: st.dustEarned,
    dustSpent: st.dustSpent,
    promotions: st.promotions,
    books: [],
    perfectPages: 0,
    replayAttempts: 0,
    replayWins: 0,
  };
  }
}
