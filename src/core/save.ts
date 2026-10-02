// 저장 데이터 (스펙 §5.8-2, §7, §5.17-8). Phaser·브라우저 의존 없음 (localStorage는 platform/storage.ts).
// 하루 경계(dayStart·diary·chapterComplete)에서만 게임을 저장한다. 낮·밤 진행 중 상태(레인 유닛·걱정·웨이브 타이머)는 저장하지 않는다.
// 파싱은 알 수 없는 키도 오류로 본다 (data/validate.ts의 Checker 재사용). v3 (hau_save_v3): 영웅 두 명·먹이기, 귀환 큐·자라기·부상 제거.

import type { GameData } from '../data/types';
import { Checker } from '../data/validate';
import type { DailyUse, DayStats } from './day';
import { eventById } from './day';
import type { DiaryCategory, DiaryEntry, NightCategory } from './diary';
import { ROLES, type BossRecord, type FeedRecord, type GameState, type HeroState, type Role } from './game';
import { isValidDate, type GatingState } from './gating';
import { WILDCARD, WILDCARD_TIER, type GridSize, type Piece } from './grid';
import { GAME_STATS_KEYS, type GameStats } from './stats';

export const SAVE_VERSION = 3;

export type SavePhase = 'dayStart' | 'diary' | 'chapterComplete';
const SAVE_PHASES: readonly SavePhase[] = ['dayStart', 'diary', 'chapterComplete'];

export interface SaveGame {
  seed: number;
  rngState: number;
  day: number;
  phase: SavePhase;
  /** 오늘 이벤트 id (복원 시 재추첨하지 않음) */
  todayId: string;
  playTime: number;
  tickCount: number;
  nextPieceId: number;
  nextUnitId: number;
  /** 오늘 생성 횟수 (diary 단계의 생성 비용 표시. confirmDay에서 0) */
  spawnedToday: number;
  joy: number;
  shadow: number;
  pendingBackflow: boolean;
  carryBackflow: boolean;
  grid: (Piece | null)[];
  lostReturns: number;
  /** 심연 벽 (현재 층). maxHp = 층 기본 HP + extraHp, cd = 반격 쿨다운 */
  abyss: { layer: number; hp: number; maxHp: number; extraHp: number; cd: number };
  /** Happy 거점 공격 쿨다운 (하루를 넘어 이어짐) */
  happyCd: number;
  /** 방어 레인 걱정 id 카운터 */
  nextWorryId: number;
  waveDay: number;
  stats: GameStats;
  diary: DiaryEntry[];
  flags: string[];
  dailyUsed: DailyUse[];
  lastDayStats: DayStats | null;
  bossLog: BossRecord[];
  feedLog: FeedRecord[];
  /** 영웅 두 명 (낮덱 = offense / 밤덱 = defense): 점수 누계·기세 (§5.17-8) */
  heroes: Record<Role, HeroState>;
  /** 판 시작 영웅 배정을 마쳤는지 ([11]-3) */
  assignmentDone: boolean;
  /** chapterComplete일 때만: 완성 true / 미완성 false (§5.15-7) */
  completed: boolean | null;
  /** 갈림길 대기: 1-turningPoint를 정화함 → 다음 dayStart에 갈림길 */
  pendingCrossroad: boolean;
  /** 1-length를 정화함 (챕터 완성) */
  chapterCleared: boolean;
}

export interface SaveData {
  version: 3;
  /** ISO 시각 (디버그 표시용) */
  savedAt: string;
  gridSize: GridSize;
  gating: GatingState;
  game: SaveGame | null;
}

function isSavePhase(p: string): p is SavePhase {
  return (SAVE_PHASES as readonly string[]).includes(p);
}

/** 하루 경계 상태 → SaveGame. 경계가 아니거나 레인이 비어 있지 않으면 예외 */
export function serializeGame(s: GameState): SaveGame {
  if (!isSavePhase(s.phase)) throw new Error(`하루 경계가 아니라 저장할 수 없음: ${s.phase}`);
  if (s.defense.units.length || s.defense.worries.length || s.abyss.units.length) {
    throw new Error('레인이 비어 있지 않아 저장할 수 없음');
  }
  const w = s.abyss.wall;
  return structuredClone({
    seed: s.seed,
    rngState: s.rng.getState(),
    day: s.day,
    phase: s.phase,
    todayId: s.today.id,
    playTime: s.playTime,
    tickCount: s.tickCount,
    nextPieceId: s.nextPieceId,
    nextUnitId: s.nextUnitId,
    spawnedToday: s.spawnedToday,
    joy: s.joy,
    shadow: s.shadow,
    pendingBackflow: s.pendingBackflow,
    carryBackflow: s.carryBackflow,
    grid: s.grid.cells,
    lostReturns: s.lostReturns,
    abyss: { layer: w.layer, hp: w.hp, maxHp: w.maxHp, extraHp: w.extraHp, cd: w.cd },
    happyCd: s.defense.happy.cd,
    nextWorryId: s.defense.nextWorryId,
    waveDay: s.wave.day,
    stats: s.stats,
    diary: s.diary,
    flags: s.flags,
    dailyUsed: s.dailyUsed,
    lastDayStats: s.lastDayStats,
    bossLog: s.bossLog,
    feedLog: s.feedLog,
    heroes: s.heroes,
    assignmentDone: s.assignmentDone,
    completed: s.phase === 'chapterComplete' ? s.completed : null,
    pendingCrossroad: s.pendingCrossroad,
    chapterCleared: s.chapterCleared,
  });
}

export function makeSaveData(gridSize: GridSize, gating: GatingState, game: SaveGame | null, savedAt: string): SaveData {
  return { version: SAVE_VERSION, savedAt, gridSize: { ...gridSize }, gating: structuredClone(gating), game: game && structuredClone(game) };
}

// ── 파싱·검증 ──

export type ParseResult =
  | { ok: true; save: SaveData }
  /** gameReset: 저장된 gridSize ≠ 현재 프리셋 → game만 초기화하고 gating은 유지 (save.game = null) */
  | { ok: true; save: SaveData; gameReset: string }
  | { ok: false; reason: string };

type Obj = Record<string, unknown>;

const PIECE_KEYS = ['id', 'chain', 'tier', 'bornAt'];
const DAY_STATS_KEYS: (keyof DayStats)[] = [
  'sunk', 'defeated', 'backflow', 'bossWin', 'layersCleared', 'offenseFell', 'defenseFalls', 'joyStart', 'joyEnd', 'realSeconds',
  'offenseSeconds', 'defenseSeconds', 'spawns', 'merges', 'battleMerges', 'feeds', 'feedPoints', 'soldiers', 'soldiersCapped',
  'releases', 'releaseTiers', 'lostReturns', 'stallSeconds', 'gridFullSeconds', 'layerClearTimes',
];
const DIARY_KEYS: (keyof DiaryEntry)[] = ['day', 'eventTitle', 'line', 'eventLine', 'resultLine', 'category', 'nightLine', 'nightCategory'];
const DIARY_CATEGORIES: DiaryCategory[] = ['backflow', 'manySunk', 'default'];
const NIGHT_CATEGORIES: NightCategory[] = ['layerCleared', 'tried', 'none'];
const BOSS_KEYS: (keyof BossRecord)[] = ['day', 'slot', 'prep', 'defenseUnits', 'heroUp', 'gridPieces', 'joy', 'shadowBefore', 'win'];
const FEED_KEYS: (keyof FeedRecord)[] = ['t', 'day', 'role', 'hero', 'chain', 'tier', 'points', 'cell', 'heldFor'];
const GAME_KEYS: (keyof SaveGame)[] = [
  'seed', 'rngState', 'day', 'phase', 'todayId', 'playTime', 'tickCount', 'nextPieceId', 'nextUnitId', 'spawnedToday',
  'joy', 'shadow', 'pendingBackflow', 'carryBackflow', 'grid', 'lostReturns', 'abyss', 'happyCd', 'nextWorryId', 'waveDay',
  'stats', 'diary', 'flags', 'dailyUsed', 'lastDayStats', 'bossLog', 'feedLog', 'heroes', 'assignmentDone',
  'completed', 'pendingCrossroad', 'chapterCleared',
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

  gating(v: unknown, path: string): void {
    const o = this.obj(v, path, ['openableDays', 'lastGrantDate', 'forgottenDays', 'forgottenLog']);
    if (!o) return;
    this.num(o.openableDays, `${path}.openableDays`, { int: true, min: 0 });
    if (o.lastGrantDate !== null) this.date(o.lastGrantDate, `${path}.lastGrantDate`);
    this.num(o.forgottenDays, `${path}.forgottenDays`, { int: true, min: 0 });
    this.list(o.forgottenLog, `${path}.forgottenLog`, (it, p) => {
      const e = this.obj(it, p, ['date', 'count', 'atDay']);
      if (!e) return;
      this.date(e.date, `${p}.date`);
      this.num(e.count, `${p}.count`, { int: true, min: 1 });
      this.num(e.atDay, `${p}.atDay`, { int: true, min: 1 });
    });
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

  date(v: unknown, path: string): void {
    if (typeof v !== 'string' || !isValidDate(v)) this.fail(path, '날짜 형식 오류 (YYYY-MM-DD)');
  }

  dayStats(v: unknown, path: string): void {
    const o = this.obj(v, path, DAY_STATS_KEYS);
    if (!o) return;
    for (const k of DAY_STATS_KEYS) {
      if (k === 'backflow' || k === 'offenseFell') this.oneOf(o[k], `${path}.${k}`, [0, 1]);
      else if (k === 'bossWin') this.oneOf(o[k], `${path}.${k}`, [0, 1, null]);
      else if (k === 'releaseTiers') {
        const a = this.arr(o[k], `${path}.${k}`);
        if (a && a.length !== this.data.balance.grid.maxTier + 1) this.fail(`${path}.${k}`, `길이 ${a.length} ≠ maxTier+1`);
        a?.forEach((x, i) => this.num(x, `${path}.${k}[${i}]`, { int: true, min: 0 }));
      } else if (k === 'layerClearTimes') this.list(o[k], `${path}.${k}`, (x, pp) => this.num(x, pp, { min: 0 }));
      else this.num(o[k], `${path}.${k}`);
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
    const lifeDays = this.data.balance.chapter.maxDays;
    const p = (k: string) => `${path}.${k}`;
    for (const k of ['seed', 'rngState', 'tickCount', 'nextPieceId', 'nextUnitId', 'spawnedToday', 'lostReturns', 'nextWorryId']) {
      this.num(o[k], p(k), { int: true, min: 0 });
    }
    this.num(o.day, p('day'), { int: true, min: 1, max: lifeDays });
    this.num(o.waveDay, p('waveDay'), { int: true, min: 1, max: lifeDays });
    this.oneOf(o.phase, p('phase'), SAVE_PHASES);
    const todayId = this.str(o.todayId, p('todayId'));
    if (todayId !== undefined && !eventById(this.data, todayId)) this.fail(p('todayId'), `events에 없는 이벤트: "${todayId}"`);
    for (const k of ['playTime', 'joy', 'shadow']) this.num(o[k], p(k), { min: 0 });
    this.num(o.happyCd, p('happyCd')); // 쿨다운은 틱 오차로 음수일 수 있다
    this.bool(o.pendingBackflow, p('pendingBackflow'));
    this.bool(o.carryBackflow, p('carryBackflow'));

    const grid = this.arr(o.grid, p('grid'));
    if (grid) {
      if (grid.length !== size.cols * size.rows) this.fail(p('grid'), `길이 ${grid.length} ≠ ${size.cols}×${size.rows}`);
      grid.forEach((c, i) => c !== null && this.piece(c, `${p('grid')}[${i}]`));
    }

    const abyss = this.nums(o.abyss, p('abyss'), ['layer', 'hp', 'maxHp', 'extraHp', 'cd']);
    if (abyss) this.num(abyss.layer, `${p('abyss')}.layer`, { int: true, min: 1 });
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

    this.list(o.flags, p('flags'), (it, pp) => this.oneOf(it, pp, ['avoid', 'face']));
    this.list(o.dailyUsed, p('dailyUsed'), (it, pp) => {
      const d = this.obj(it, pp, ['id', 'day']);
      if (!d) return;
      this.str(d.id, `${pp}.id`);
      this.num(d.day, `${pp}.day`, { int: true, min: 1 });
    });
    this.list(o.diary, p('diary'), (it, pp) => {
      const d = this.obj(it, pp, DIARY_KEYS);
      if (!d) return;
      this.num(d.day, `${pp}.day`, { int: true, min: 1 });
      for (const k of ['eventTitle', 'line', 'eventLine', 'resultLine', 'nightLine']) {
        if (typeof d[k] !== 'string') this.fail(`${pp}.${k}`, '문자열이어야 함');
      }
      this.oneOf(d.category, `${pp}.category`, DIARY_CATEGORIES);
      this.oneOf(d.nightCategory, `${pp}.nightCategory`, NIGHT_CATEGORIES);
    });
    if (o.lastDayStats !== null) this.dayStats(o.lastDayStats, p('lastDayStats'));
    this.list(o.bossLog, p('bossLog'), (it, pp) => {
      const b = this.obj(it, pp, BOSS_KEYS);
      if (!b) return;
      for (const k of ['day', 'defenseUnits', 'gridPieces', 'joy', 'shadowBefore']) this.num(b[k], `${pp}.${k}`);
      this.oneOf(b.slot, `${pp}.slot`, ['morning', 'noon', 'evening']);
      this.bool(b.prep, `${pp}.prep`);
      this.bool(b.heroUp, `${pp}.heroUp`);
      this.oneOf(b.win, `${pp}.win`, [true, false, null]);
    });
    this.list(o.feedLog, p('feedLog'), (it, pp) => {
      const r = this.obj(it, pp, FEED_KEYS);
      if (!r) return;
      for (const k of ['t', 'points', 'heldFor']) this.num(r[k], `${pp}.${k}`, { min: 0 });
      this.num(r.day, `${pp}.day`, { int: true, min: 1 });
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
    this.bool(o.pendingCrossroad, p('pendingCrossroad'));
    this.bool(o.chapterCleared, p('chapterCleared'));
    if (o.phase === 'chapterComplete') {
      if (typeof o.completed !== 'boolean') this.fail(p('completed'), 'chapterComplete인데 완성 여부가 없음');
    } else if (o.completed !== null) this.fail(p('completed'), 'chapterComplete가 아니면 null이어야 함');
    if (o.phase === 'diary' && o.lastDayStats === null) this.fail(p('lastDayStats'), 'diary인데 그날 기록이 없음');
  }
}

/**
 * localStorage 원문 → SaveData (§5.8-2 초기화 규칙).
 * - 키 없음(null) / JSON 파싱 실패 / version ≠ 3 / 스키마 불일치 → { ok: false, reason } (호출부가 키 삭제 + 새 판 + 첫 실행 gating)
 * - 저장된 gridSize ≠ 현재 프리셋 → game만 null로 (gating 유지), gameReset에 사유
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
  const o = c.obj(top, 'save', ['version', 'savedAt', 'gridSize', 'gating', 'game']);
  if (o) {
    c.str(o.savedAt, 'save.savedAt');
    c.nums(o.gridSize, 'save.gridSize', ['cols', 'rows'], { int: true, min: 1 });
    c.gating(o.gating, 'save.gating');
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
