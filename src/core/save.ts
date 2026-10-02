// 저장 데이터 (스펙 §5.19-7, §7). Phaser·브라우저 의존 없음 (localStorage는 platform/storage.ts).
// 경계(장면 카드 = 스테이지 시작·실패 직후 / 이야기 한 장 / 챕터 완성)에서만 게임을 저장한다.
// 낮·밤 진행 중 상태(레인 유닛·적·웨이브 타이머)는 저장하지 않는다.
// 파싱은 알 수 없는 키도 오류로 본다 (data/validate.ts의 Checker 재사용) → 일차(day)·gating 필드가 남아 있으면 오류.
// v4 (hau_save_v4): 스테이지·시도 수·핵 상태·펼친 장, 일차·gating·그림자 제거.

import type { GameData } from '../data/types';
import { Checker } from '../data/validate';
import { ATTEMPT_RESULTS, type AttemptStats, type FailReason } from './day';
import { ROLES, type CoreState, type FeedRecord, type GameState, type HeroState, type Role } from './game';
import { WILDCARD, WILDCARD_TIER, type GridSize, type Piece } from './grid';
import { GAME_STATS_KEYS, type GameStats } from './stats';

export const SAVE_VERSION = 4;

export type SavePhase = 'dayStart' | 'diary' | 'chapterComplete';
const SAVE_PHASES: readonly SavePhase[] = ['dayStart', 'diary', 'chapterComplete'];
const FAIL_REASONS = ATTEMPT_RESULTS.filter((r) => r !== 'success');

export interface SaveGame {
  seed: number;
  rngState: number;
  phase: SavePhase;
  /** 지금 스테이지 (1-n의 n) */
  stage: number;
  /** 판 통산 시도 수 */
  attempt: number;
  /** 스테이지별 시도 수 */
  attempts: number[];
  /** 장면 카드가 재도전이면 실패 사유 */
  retry: FailReason | null;
  playTime: number;
  tickCount: number;
  nextPieceId: number;
  nextUnitId: number;
  /** 이번 시도 생성 횟수 (이야기 한 장 단계의 생성 비용 표시. confirmDay에서 0) */
  spawnedAttempt: number;
  joy: number;
  grid: (Piece | null)[];
  lostReturns: number;
  /** 핵: 상태(없음/운반 중 위치/이야기책) + HP (§5.19-7). 경계에서는 항상 none */
  core: { state: CoreState['state']; y: number | null; hp: number };
  /** Happy 거점 공격 쿨다운 (시도를 넘어 이어짐) */
  happyCd: number;
  /** 방어 레인 적 id 카운터 */
  nextWorryId: number;
  stats: GameStats;
  /** 이야기책: 펼친 장 (스테이지 번호) */
  pages: number[];
  flags: string[];
  /** 끝난 시도 전부 */
  attemptLog: AttemptStats[];
  feedLog: FeedRecord[];
  /** 영웅 두 명 (낮덱 = offense / 밤덱 = defense): 점수 누계·기세 (§5.17-8) */
  heroes: Record<Role, HeroState>;
  /** 판 시작 영웅 배정을 마쳤는지 ([11]-3) */
  assignmentDone: boolean;
  /** 합류한 보상 영웅 id (D-057) */
  joinedHeroes: string[];
  /** chapterComplete일 때만 true */
  completed: true | null;
  /** 갈림길 대기: 1-turningPoint 성공 → 다음 장면 카드에 갈림길 */
  pendingCrossroad: boolean;
}

export interface SaveData {
  version: 4;
  /** ISO 시각 (디버그 표시용) */
  savedAt: string;
  gridSize: GridSize;
  game: SaveGame | null;
}

function isSavePhase(p: string): p is SavePhase {
  return (SAVE_PHASES as readonly string[]).includes(p);
}

/** 경계 상태 → SaveGame. 경계가 아니거나 레인이 비어 있지 않으면 예외 */
export function serializeGame(s: GameState): SaveGame {
  if (!isSavePhase(s.phase)) throw new Error(`경계가 아니라 저장할 수 없음: ${s.phase}`);
  if (s.defense.units.length || s.defense.worries.length || s.abyss.units.length || s.abyss.enemies.length) {
    throw new Error('레인이 비어 있지 않아 저장할 수 없음');
  }
  const core = s.coreState;
  return structuredClone({
    seed: s.seed,
    rngState: s.rng.getState(),
    phase: s.phase,
    stage: s.stage,
    attempt: s.attempt,
    attempts: s.attempts,
    retry: s.retry,
    playTime: s.playTime,
    tickCount: s.tickCount,
    nextPieceId: s.nextPieceId,
    nextUnitId: s.nextUnitId,
    spawnedAttempt: s.spawnedAttempt,
    joy: s.joy,
    grid: s.grid.cells,
    lostReturns: s.lostReturns,
    core: { state: core.state, y: core.state === 'carrying' ? core.y : null, hp: s.coreHp },
    happyCd: s.defense.happy.cd,
    nextWorryId: s.defense.nextWorryId,
    stats: s.stats,
    pages: s.pages,
    flags: s.flags,
    attemptLog: s.attemptLog,
    feedLog: s.feedLog,
    heroes: s.heroes,
    assignmentDone: s.assignmentDone,
    joinedHeroes: s.joinedHeroes,
    completed: s.phase === 'chapterComplete' ? s.completed : null,
    pendingCrossroad: s.pendingCrossroad,
  });
}

export function makeSaveData(gridSize: GridSize, game: SaveGame | null, savedAt: string): SaveData {
  return { version: SAVE_VERSION, savedAt, gridSize: { ...gridSize }, game: game && structuredClone(game) };
}

// ── 파싱·검증 ──

export type ParseResult =
  | { ok: true; save: SaveData }
  /** gameReset: 저장된 gridSize ≠ 현재 프리셋 → game만 초기화 (save.game = null) */
  | { ok: true; save: SaveData; gameReset: string }
  | { ok: false; reason: string };

type Obj = Record<string, unknown>;

const PIECE_KEYS = ['id', 'chain', 'tier', 'bornAt'];
export const ATTEMPT_KEYS: (keyof AttemptStats)[] = [
  'stage', 'attempt', 'result', 'guardianDown', 'carrySeconds', 'drops', 'coreReturns', 'carryFalls', 'coreHpEnd', 'sunk',
  'defenseFalls', 'defeated', 'joyStart', 'joyEnd', 'realSeconds', 'offenseSeconds', 'defenseSeconds', 'spawns', 'merges',
  'battleMerges', 'feeds', 'feedPoints', 'soldiers', 'soldiersCapped', 'releases', 'releaseTiers', 'lostReturns', 'gridFullSeconds',
];
const FEED_KEYS: (keyof FeedRecord)[] = ['t', 'attempt', 'stage', 'role', 'hero', 'chain', 'tier', 'points', 'cell', 'heldFor'];
const GAME_KEYS: (keyof SaveGame)[] = [
  'seed', 'rngState', 'phase', 'stage', 'attempt', 'attempts', 'retry', 'playTime', 'tickCount', 'nextPieceId', 'nextUnitId',
  'spawnedAttempt', 'joy', 'grid', 'lostReturns', 'core', 'happyCd', 'nextWorryId', 'stats', 'pages', 'flags', 'attemptLog',
  'feedLog', 'heroes', 'assignmentDone', 'joinedHeroes', 'completed', 'pendingCrossroad',
];

class SaveChecker extends Checker {
  constructor(private readonly data: GameData) {
    super();
  }

  oneOf(v: unknown, path: string, allowed: readonly unknown[]): void {
    if (!allowed.includes(v)) this.fail(path, `다음 중 하나여야 함: ${allowed.join(', ')}`);
  }

  list<T>(v: unknown, path: string, each: (item: unknown, p: string) => T): void {
    (this.arr(v, path) ?? []).forEach((it, i) => each(it, `${path}[${i}]`));
  }

  get chainIds(): string[] {
    return this.data.chains.map((c) => c.archetypeId);
  }

  get length(): number {
    return this.data.balance.chapter.length;
  }

  piece(v: unknown, path: string): void {
    const o = this.obj(v, path, PIECE_KEYS);
    if (!o) return;
    this.num(o.id, `${path}.id`, { int: true, min: 1 });
    this.num(o.bornAt, `${path}.bornAt`, { min: 0 });
    const chain = this.str(o.chain, `${path}.chain`);
    if (chain === undefined) return;
    if (chain === WILDCARD) {
      if (o.tier !== WILDCARD_TIER) this.fail(`${path}.tier`, `와일드카드는 ${WILDCARD_TIER}이어야 함`);
      return;
    }
    if (!this.chainIds.includes(chain)) this.fail(`${path}.chain`, `chains.json에 없는 체인: "${chain}"`);
    this.num(o.tier, `${path}.tier`, { int: true, min: 1, max: this.data.balance.grid.maxTier });
  }

  /** 키 → 0 이상 정수. keyOk가 false면 오류 */
  counts(v: unknown, path: string, keyOk: (k: string) => boolean, what: string): void {
    const m = this.map(v, path);
    if (!m) return;
    for (const [k, x] of Object.entries(m)) {
      if (!keyOk(k)) this.fail(`${path}.${k}`, `알 수 없는 ${what}: "${k}"`);
      this.num(x, `${path}.${k}`, { int: true, min: 0 });
    }
  }

  attemptStats(v: unknown, path: string): void {
    const o = this.obj(v, path, ATTEMPT_KEYS);
    if (!o) return;
    for (const k of ATTEMPT_KEYS) {
      const p = `${path}.${k}`;
      if (k === 'stage') this.num(o[k], p, { int: true, min: 1, max: this.length });
      else if (k === 'attempt') this.num(o[k], p, { int: true, min: 1 });
      else if (k === 'result') this.oneOf(o[k], p, [...ATTEMPT_RESULTS, null]);
      else if (k === 'guardianDown') this.oneOf(o[k], p, [0, 1]);
      else if (k === 'coreHpEnd') {
        if (o[k] !== null) this.num(o[k], p, { min: 0 });
      } else if (k === 'releaseTiers') {
        const a = this.arr(o[k], p);
        if (a && a.length !== this.data.balance.grid.maxTier + 1) this.fail(p, `길이 ${a.length} ≠ maxTier+1`);
        a?.forEach((x, i) => this.num(x, `${p}[${i}]`, { int: true, min: 0 }));
      } else this.num(o[k], p);
    }
  }

  hero(v: unknown, path: string): string | undefined {
    const o = this.obj(v, path, ['id', 'points', 'momentum']);
    if (!o) return undefined;
    const id = this.str(o.id, `${path}.id`);
    if (id !== undefined && !this.data.heroes.heroes.some((h) => h.id === id)) this.fail(`${path}.id`, `heroes.json에 없는 영웅: "${id}"`);
    const pts = this.map(o.points, `${path}.points`);
    if (pts) {
      for (const [k, x] of Object.entries(pts)) {
        if (!this.chainIds.includes(k)) this.fail(`${path}.points.${k}`, `chains.json에 없는 체인: "${k}"`);
        this.num(x, `${path}.points.${k}`, { min: 0 });
      }
    }
    const m = this.nums(o.momentum, `${path}.momentum`, ['stacks', 'bonus', 'timer'], { min: 0 });
    if (m) this.num(m.stacks, `${path}.momentum.stacks`, { int: true, min: 0, max: this.data.balance.buff.momentumMaxStacks });
    return id;
  }

  game(v: unknown, path: string, size: GridSize): void {
    const o = this.obj(v, path, GAME_KEYS);
    if (!o) return;
    const p = (k: string) => `${path}.${k}`;
    for (const k of ['seed', 'rngState', 'tickCount', 'nextPieceId', 'nextUnitId', 'spawnedAttempt', 'lostReturns', 'nextWorryId', 'attempt']) {
      this.num(o[k], p(k), { int: true, min: 0 });
    }
    this.num(o.stage, p('stage'), { int: true, min: 1, max: this.length });
    this.oneOf(o.phase, p('phase'), SAVE_PHASES);
    if (o.retry !== null) this.oneOf(o.retry, p('retry'), FAIL_REASONS);
    for (const k of ['playTime', 'joy']) this.num(o[k], p(k), { min: 0 });
    this.num(o.happyCd, p('happyCd')); // 쿨다운은 틱 오차로 음수일 수 있다
    const att = this.arr(o.attempts, p('attempts'));
    if (att) {
      if (att.length !== this.length) this.fail(p('attempts'), `길이 ${att.length} ≠ chapter.length(${this.length})`);
      att.forEach((x, i) => this.num(x, `${p('attempts')}[${i}]`, { int: true, min: 0 }));
    }

    const grid = this.arr(o.grid, p('grid'));
    if (grid) {
      if (grid.length !== size.cols * size.rows) this.fail(p('grid'), `길이 ${grid.length} ≠ ${size.cols}×${size.rows}`);
      grid.forEach((c, i) => c !== null && this.piece(c, `${p('grid')}[${i}]`));
    }

    const core = this.obj(o.core, p('core'), ['state', 'y', 'hp']);
    if (core) {
      this.oneOf(core.state, `${p('core')}.state`, ['none', 'carrying', 'hut']);
      if (core.state === 'carrying') this.num(core.y, `${p('core')}.y`);
      else if (core.y !== null) this.fail(`${p('core')}.y`, '운반 중이 아니면 null이어야 함');
      this.num(core.hp, `${p('core')}.hp`, { min: 0 });
    }

    const st = this.obj(o.stats, p('stats'), [...GAME_STATS_KEYS, 'tier3ByChain', 'soldiersByKind']);
    if (st) {
      for (const k of GAME_STATS_KEYS) this.num(st[k], `${p('stats')}.${k}`, { min: 0 });
      this.counts(st.tier3ByChain, `${p('stats')}.tier3ByChain`, (k) => this.chainIds.includes(k), '체인');
      this.counts(
        st.soldiersByKind,
        `${p('stats')}.soldiersByKind`,
        (k) => {
          const [chain, lv] = k.split(':');
          const c = this.data.chains.find((x) => x.archetypeId === chain);
          return !!c && Number.isInteger(Number(lv)) && Number(lv) >= 1 && Number(lv) <= c.soldier.levels.length;
        },
        '병사 키',
      );
    }

    this.list(o.pages, p('pages'), (it, pp) => this.num(it, pp, { int: true, min: 1, max: this.length }));
    this.list(o.flags, p('flags'), (it, pp) => this.oneOf(it, pp, ['avoid', 'face']));
    this.list(o.attemptLog, p('attemptLog'), (it, pp) => this.attemptStats(it, pp));
    this.list(o.feedLog, p('feedLog'), (it, pp) => {
      const r = this.obj(it, pp, FEED_KEYS);
      if (!r) return;
      for (const k of ['t', 'points', 'heldFor']) this.num(r[k], `${pp}.${k}`, { min: 0 });
      this.num(r.attempt, `${pp}.attempt`, { int: true, min: 1 });
      this.num(r.stage, `${pp}.stage`, { int: true, min: 1, max: this.length });
      this.num(r.tier, `${pp}.tier`, { int: true, min: 1, max: this.data.balance.grid.maxTier });
      this.oneOf(r.role, `${pp}.role`, ROLES);
      this.str(r.hero, `${pp}.hero`);
      this.oneOf(r.chain, `${pp}.chain`, this.chainIds);
      this.nums(r.cell, `${pp}.cell`, ['col', 'row'], { int: true, min: 0 });
    });

    const heroes = this.obj(o.heroes, p('heroes'), [...ROLES]);
    if (heroes) {
      const off = this.hero(heroes.offense, `${p('heroes')}.offense`);
      const def = this.hero(heroes.defense, `${p('heroes')}.defense`);
      if (off !== undefined && off === def) this.fail(`${p('heroes')}.defense`, '낮덱과 다른 영웅이어야 함 (양쪽 최소 1명)');
    }
    this.bool(o.assignmentDone, p('assignmentDone'));
    this.list(o.joinedHeroes, p('joinedHeroes'), (it, pp) => {
      const h = this.data.heroes.heroes.find((x) => x.id === it);
      if (!h || h.reward === undefined) this.fail(pp, `보상 영웅이 아님: "${String(it)}"`);
    });
    this.bool(o.pendingCrossroad, p('pendingCrossroad'));
    if (o.phase === 'chapterComplete') {
      if (o.completed !== true) this.fail(p('completed'), 'chapterComplete인데 완성 표시가 없음');
    } else if (o.completed !== null) this.fail(p('completed'), 'chapterComplete가 아니면 null이어야 함');
    if (o.phase === 'diary' && Array.isArray(o.attemptLog) && o.attemptLog.length === 0) this.fail(p('attemptLog'), 'diary인데 시도 기록이 없음');
  }
}

/**
 * localStorage 원문 → SaveData.
 * - 키 없음(null) / JSON 파싱 실패 / version ≠ 4 / 스키마 불일치(일차·gating 키가 남은 경우 포함) → { ok: false, reason } (호출부가 키 삭제 + 새 판)
 * - 저장된 gridSize ≠ 현재 프리셋 → game만 null로, gameReset에 사유
 */
export function parseSave(raw: string | null, data: GameData, size: GridSize): ParseResult {
  if (raw === null) return { ok: false, reason: '저장 없음' };
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch (e) {
    return { ok: false, reason: `JSON 파싱 실패: ${(e as Error).message}` };
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return { ok: false, reason: '저장이 객체가 아님' };
  const top = v as Obj;
  if (top.version !== SAVE_VERSION) return { ok: false, reason: `version 불일치: ${String(top.version)} (필요 ${SAVE_VERSION})` };

  const c = new SaveChecker(data);
  const o = c.obj(top, 'save', ['version', 'savedAt', 'gridSize', 'game']);
  if (o) {
    c.str(o.savedAt, 'save.savedAt');
    c.nums(o.gridSize, 'save.gridSize', ['cols', 'rows'], { int: true, min: 1 });
  }
  if (c.issues.length > 0) return { ok: false, reason: issuesText(c) };

  const saved = top.gridSize as GridSize;
  const save = top as unknown as SaveData;
  if (saved.cols !== size.cols || saved.rows !== size.rows) {
    return {
      ok: true,
      save: { ...save, gridSize: { ...size }, game: null },
      gameReset: `그리드 프리셋 불일치: 저장 ${saved.cols}×${saved.rows} ≠ 현재 ${size.cols}×${size.rows}`,
    };
  }
  if (top.game !== null) c.game(top.game, 'save.game', size);
  if (c.issues.length > 0) return { ok: false, reason: issuesText(c) };
  return { ok: true, save };
}

function issuesText(c: Checker): string {
  const head = c.issues.slice(0, 3).map((i) => `${i.path}: ${i.reason}`).join(' / ');
  return c.issues.length > 3 ? `${head} 외 ${c.issues.length - 3}건` : head;
}
