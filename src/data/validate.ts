// JSON 로드 직후 스키마·참조 무결성 검증. Phaser 의존 없음.
// 알 수 없는 키도 오류로 본다 (키 이름 오타·불일치를 잡기 위함).

import type { GameData } from './types';

export interface Issue {
  path: string;
  reason: string;
}

export type ValidationResult = { ok: true; data: GameData } | { ok: false; issues: Issue[] };

type Obj = Record<string, unknown>;

interface NumOpts {
  min?: number;
  max?: number;
  int?: boolean;
}

export class Checker {
  readonly issues: Issue[] = [];

  fail(path: string, reason: string): void {
    this.issues.push({ path, reason });
  }

  /** 객체인지 확인하고, required/optional 외의 키가 있으면 오류 */
  obj(v: unknown, path: string, required: string[], optional: string[] = []): Obj | undefined {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
      this.fail(path, '객체여야 함');
      return undefined;
    }
    const o = v as Obj;
    for (const k of required) if (!(k in o)) this.fail(`${path}.${k}`, '필수 키 없음');
    for (const k of Object.keys(o)) {
      if (!required.includes(k) && !optional.includes(k)) this.fail(`${path}.${k}`, '알 수 없는 키');
    }
    return o;
  }

  /** 키 집합을 검사하지 않는 맵 (예: days.fixed, chainWeight) */
  map(v: unknown, path: string): Obj | undefined {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
      this.fail(path, '객체여야 함');
      return undefined;
    }
    return v as Obj;
  }

  num(v: unknown, path: string, opts: NumOpts = {}): number | undefined {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      this.fail(path, '숫자여야 함');
      return undefined;
    }
    if (opts.int && !Number.isInteger(v)) this.fail(path, '정수여야 함');
    if (opts.min !== undefined && v < opts.min) this.fail(path, `${opts.min} 이상이어야 함 (현재 ${v})`);
    if (opts.max !== undefined && v > opts.max) this.fail(path, `${opts.max} 이하여야 함 (현재 ${v})`);
    return v;
  }

  str(v: unknown, path: string): string | undefined {
    if (typeof v !== 'string' || v.length === 0) {
      this.fail(path, '비어 있지 않은 문자열이어야 함');
      return undefined;
    }
    return v;
  }

  bool(v: unknown, path: string): boolean | undefined {
    if (typeof v !== 'boolean') {
      this.fail(path, 'true/false여야 함');
      return undefined;
    }
    return v;
  }

  arr(v: unknown, path: string, minLen = 0): unknown[] | undefined {
    if (!Array.isArray(v)) {
      this.fail(path, '배열이어야 함');
      return undefined;
    }
    if (v.length < minLen) this.fail(path, `항목이 ${minLen}개 이상이어야 함`);
    return v;
  }

  strList(v: unknown, path: string, minLen = 1): string[] {
    const a = this.arr(v, path, minLen) ?? [];
    return a.map((s, i) => this.str(s, `${path}[${i}]`)).filter((s): s is string => s !== undefined);
  }

  /** 모든 값이 숫자인 고정 키 객체 */
  nums(v: unknown, path: string, keys: string[], opts: NumOpts = {}): Obj | undefined {
    const o = this.obj(v, path, keys);
    if (o) for (const k of keys) if (k in o) this.num(o[k], `${path}.${k}`, opts);
    return o;
  }

  unique(ids: (string | undefined)[], path: string, label: string): void {
    const seen = new Set<string>();
    for (const id of ids) {
      if (id === undefined) continue;
      if (seen.has(id)) this.fail(path, `${label} 중복: "${id}"`);
      seen.add(id);
    }
  }
}

const COMBAT_KEYS = ['hp', 'atk', 'atkInterval', 'range'];

function checkCombat(c: Checker, v: unknown, path: string, extra: string[] = []): Obj | undefined {
  const o = c.obj(v, path, [...extra, ...COMBAT_KEYS]);
  if (!o) return undefined;
  c.num(o.hp, `${path}.hp`, { min: 1 });
  c.num(o.atk, `${path}.atk`, { min: 0 });
  c.num(o.atkInterval, `${path}.atkInterval`, { min: 0.01 });
  c.num(o.range, `${path}.range`, { min: 0 });
  return o;
}

function checkBalance(c: Checker, v: unknown): { maxTier?: number; lifeLengthDays?: number } {
  const p = 'balance';
  const b = c.obj(v, p, ['version', 'start', 'grid', 'lane', 'happy', 'wave', 'abyss', 'night', 'shadow', 'days', 'diary']);
  if (!b) return {};
  if (b.version !== 2) c.fail(`${p}.version`, `2여야 함 (현재 ${String(b.version)})`);
  c.nums(b.start, `${p}.start`, ['joy', 'shadow'], { min: 0 });

  let maxTier: number | undefined;
  const g = c.obj(b.grid, `${p}.grid`, [
    'gridCols', 'gridRows', 'gridPresets', 'spawnCostBase', 'spawnCostStep', 'maxTier', 'releaseRefund', 'returnQueueCap',
  ]);
  if (g) {
    const cols = c.num(g.gridCols, `${p}.grid.gridCols`, { int: true, min: 1 });
    const rows = c.num(g.gridRows, `${p}.grid.gridRows`, { int: true, min: 1 });
    const presets = c.arr(g.gridPresets, `${p}.grid.gridPresets`, 1) ?? [];
    const parsed: [number, number][] = [];
    presets.forEach((pr, i) => {
      const pp = `${p}.grid.gridPresets[${i}]`;
      const a = c.arr(pr, pp);
      if (!a) return;
      if (a.length !== 2) return c.fail(pp, '[열, 행] 두 값이어야 함');
      const pc = c.num(a[0], `${pp}[0]`, { int: true, min: 1 });
      const prw = c.num(a[1], `${pp}[1]`, { int: true, min: 1 });
      if (pc !== undefined && prw !== undefined) parsed.push([pc, prw]);
    });
    if (cols !== undefined && rows !== undefined && !parsed.some(([pc, prw]) => pc === cols && prw === rows)) {
      c.fail(`${p}.grid`, `기본 그리드 ${cols}×${rows}가 gridPresets에 없음`);
    }
    c.num(g.spawnCostBase, `${p}.grid.spawnCostBase`, { min: 0 });
    c.num(g.spawnCostStep, `${p}.grid.spawnCostStep`, { min: 0 });
    maxTier = c.num(g.maxTier, `${p}.grid.maxTier`, { int: true, min: 1 });
    c.num(g.releaseRefund, `${p}.grid.releaseRefund`, { min: 0 });
    c.num(g.returnQueueCap, `${p}.grid.returnQueueCap`, { int: true, min: 0 });
  }

  const lane = c.obj(b.lane, `${p}.lane`, ['laneCap', 'abyssAdvanceSpeed']);
  if (lane) {
    c.num(lane.laneCap, `${p}.lane.laneCap`, { int: true, min: 1 });
    c.num(lane.abyssAdvanceSpeed, `${p}.lane.abyssAdvanceSpeed`, { min: 0 });
  }

  const h = c.nums(b.happy, `${p}.happy`, ['atk', 'atkInterval', 'range'], { min: 0 });
  if (h) c.num(h.atkInterval, `${p}.happy.atkInterval`, { min: 0.01 });

  const w = c.obj(b.wave, `${p}.wave`, ['wavesPerDay', 'countBase', 'countStep', 'spawnInterval', 'waveGap', 'dayStartDelay', 'bossPrepSeconds', 'hpGrowthPerDay']);
  if (w) {
    c.num(w.wavesPerDay, `${p}.wave.wavesPerDay`, { int: true, min: 1 });
    c.num(w.countBase, `${p}.wave.countBase`, { int: true, min: 0 });
    c.num(w.countStep, `${p}.wave.countStep`, { min: 0 });
    c.num(w.spawnInterval, `${p}.wave.spawnInterval`, { min: 0 });
    c.num(w.waveGap, `${p}.wave.waveGap`, { min: 0 });
    c.num(w.dayStartDelay, `${p}.wave.dayStartDelay`, { min: 0 });
    c.num(w.bossPrepSeconds, `${p}.wave.bossPrepSeconds`, { min: 0 });
    c.num(w.hpGrowthPerDay, `${p}.wave.hpGrowthPerDay`, { min: 0 });
  }

  const a = c.nums(b.abyss, `${p}.abyss`, [
    'layerHpBase', 'layerHpGrowth', 'counterAtk', 'counterAtkInterval', 'counterRange', 'abyssDeathShadow',
    'layerClearShadowReduce',
  ], { min: 0 });
  if (a) {
    c.num(a.layerHpBase, `${p}.abyss.layerHpBase`, { min: 1 });
    c.num(a.counterAtkInterval, `${p}.abyss.counterAtkInterval`, { min: 0.01 });
  }

  // 밤 (v0.8, D-027): abyss.unhappyStallShadowPerSec → night.stallShadowPerSec
  const n = c.nums(b.night, `${p}.night`, ['nightSeconds', 'stallShadowPerSec'], { min: 0 });
  if (n) c.num(n.nightSeconds, `${p}.night.nightSeconds`, { min: 1 });

  const shadowKeys = ['shadowMax', 'sinkShadow', 'sinkLayerHp', 'shadowAfterBossWin', 'shadowAfterBossLose'];
  const s = c.obj(b.shadow, `${p}.shadow`, [...shadowKeys, 'weatherThresholds']);
  if (s) {
    for (const k of shadowKeys) if (k in s) c.num(s[k], `${p}.shadow.${k}`, { min: 0 });
    if (typeof s.shadowMax === 'number') {
      c.num(s.shadowMax, `${p}.shadow.shadowMax`, { min: 1 });
      c.num(s.shadowAfterBossWin, `${p}.shadow.shadowAfterBossWin`, { max: s.shadowMax });
      c.num(s.shadowAfterBossLose, `${p}.shadow.shadowAfterBossLose`, { max: s.shadowMax });
    }
    const wt = c.arr(s.weatherThresholds, `${p}.shadow.weatherThresholds`);
    if (wt) {
      if (wt.length !== 3) c.fail(`${p}.shadow.weatherThresholds`, '[흐림, 비, 폭우] 세 값이어야 함');
      const vals = wt.map((v, i) => c.num(v, `${p}.shadow.weatherThresholds[${i}]`, { min: 0 }));
      for (let i = 1; i < vals.length; i++) {
        const a = vals[i - 1];
        const v = vals[i];
        if (a !== undefined && v !== undefined && v <= a) c.fail(`${p}.shadow.weatherThresholds`, '오름차순이어야 함');
      }
    }
  }

  let lifeLengthDays: number | undefined;
  const d = c.obj(b.days, `${p}.days`, ['lifeLengthDays', 'dailyLimit', 'storeCap', 'morningJoyFloor']);
  if (d) {
    lifeLengthDays = c.num(d.lifeLengthDays, `${p}.days.lifeLengthDays`, { int: true, min: 1 });
    const limit = c.num(d.dailyLimit, `${p}.days.dailyLimit`, { int: true, min: 1 });
    const cap = c.num(d.storeCap, `${p}.days.storeCap`, { int: true, min: 1 });
    c.num(d.morningJoyFloor, `${p}.days.morningJoyFloor`, { int: true, min: 0 });
    if (limit !== undefined && cap !== undefined && cap < limit) c.fail(`${p}.days.storeCap`, 'dailyLimit 이상이어야 함');
  }

  c.nums(b.diary, `${p}.diary`, ['diarySinkThreshold'], { int: true, min: 0 });
  return { maxTier, lifeLengthDays };
}

function checkUnits(c: Checker, v: unknown, maxTier: number | undefined): void {
  const u = c.obj(v, 'units', ['commonSpirit']);
  if (!u) return;
  const list = c.arr(u.commonSpirit, 'units.commonSpirit', 1) ?? [];
  const tiers = list.map((e, i) => {
    const o = checkCombat(c, e, `units.commonSpirit[${i}]`, ['tier']);
    return o ? c.num(o.tier, `units.commonSpirit[${i}].tier`, { int: true, min: 1 }) : undefined;
  });
  c.unique(tiers.map((t) => (t === undefined ? undefined : String(t))), 'units.commonSpirit', 'tier');
  // 1 ~ (maxTier-1) 단계는 공용 정령, maxTier는 영웅
  if (maxTier !== undefined) {
    for (let t = 1; t < maxTier; t++) {
      if (!tiers.includes(t)) c.fail('units.commonSpirit', `${t}단계 능력치 없음`);
    }
    for (const t of tiers) {
      if (t !== undefined && t >= maxTier) c.fail('units.commonSpirit', `${t}단계는 영웅 단계라 chains.hero에서 정의해야 함`);
    }
  }
}

function checkChains(c: Checker, v: unknown, maxTier: number | undefined, world: string | undefined): string[] {
  const list = c.arr(v, 'chains', 1) ?? [];
  const ids = list.map((e, i) => {
    const p = `chains[${i}]`;
    const o = c.obj(e, p, ['archetypeId', 'world', 'spawnWeight', 'color', 'tierNames', 'hero']);
    if (!o) return undefined;
    const id = c.str(o.archetypeId, `${p}.archetypeId`);
    checkWorld(c, o.world, `${p}.world`, world);
    c.num(o.spawnWeight, `${p}.spawnWeight`, { min: 0 });
    const color = c.str(o.color, `${p}.color`);
    if (color !== undefined && !/^#[0-9A-Fa-f]{6}$/.test(color)) c.fail(`${p}.color`, '#RRGGBB 형식이어야 함');
    const names = c.strList(o.tierNames, `${p}.tierNames`);
    if (maxTier !== undefined && names.length !== maxTier) {
      c.fail(`${p}.tierNames`, `maxTier(${maxTier})개여야 함 (현재 ${names.length})`);
    }
    checkCombat(c, o.hero, `${p}.hero`);
    return id;
  });
  c.unique(ids, 'chains', 'archetypeId');
  const totalWeight = list.reduce<number>((s, e) => {
    const w = (e as Obj | null)?.spawnWeight;
    return s + (typeof w === 'number' && w > 0 ? w : 0);
  }, 0);
  if (list.length > 0 && totalWeight <= 0) c.fail('chains', 'spawnWeight 합이 0보다 커야 함 (조각 생성 불가)');
  return ids.filter((s): s is string => s !== undefined);
}

function checkMonsters(c: Checker, v: unknown): void {
  const m = c.obj(v, 'monsters', ['worry', 'backflowBoss']);
  if (!m) return;
  const w = c.obj(m.worry, 'monsters.worry', ['name', 'hpBase', 'speed', 'atk', 'atkInterval', 'joyReward']);
  if (w) {
    c.str(w.name, 'monsters.worry.name');
    c.num(w.hpBase, 'monsters.worry.hpBase', { min: 1 });
    c.num(w.speed, 'monsters.worry.speed', { min: 0 });
    c.num(w.atk, 'monsters.worry.atk', { min: 0 });
    c.num(w.atkInterval, 'monsters.worry.atkInterval', { min: 0.01 });
    c.num(w.joyReward, 'monsters.worry.joyReward', { min: 0 });
  }
  const b = c.obj(m.backflowBoss, 'monsters.backflowBoss', [
    'name', 'hp', 'speed', 'atk', 'atkInterval', 'joyReward', 'joyPenalty', 'sinkLayerHp', 'hpGrowthPerDay',
  ]);
  if (b) {
    c.str(b.name, 'monsters.backflowBoss.name');
    c.num(b.hp, 'monsters.backflowBoss.hp', { min: 1 });
    c.num(b.speed, 'monsters.backflowBoss.speed', { min: 0 });
    c.num(b.atk, 'monsters.backflowBoss.atk', { min: 0 });
    c.num(b.atkInterval, 'monsters.backflowBoss.atkInterval', { min: 0.01 });
    c.num(b.joyReward, 'monsters.backflowBoss.joyReward', { min: 0 });
    c.num(b.joyPenalty, 'monsters.backflowBoss.joyPenalty', { min: 0 });
    c.num(b.sinkLayerHp, 'monsters.backflowBoss.sinkLayerHp', { min: 0 });
    c.num(b.hpGrowthPerDay, 'monsters.backflowBoss.hpGrowthPerDay', { min: 0.01 });
  }
}

function checkWorld(c: Checker, v: unknown, path: string, world: string | undefined): void {
  const w = c.str(v, path);
  if (w !== undefined && world !== undefined && w !== world) c.fail(path, `days.world("${world}")와 다름 ("${w}")`);
}

function checkEffects(c: Checker, v: unknown, path: string, chainIds: string[], maxTier: number | undefined): void {
  const e = c.obj(v, path, [], ['joy', 'shadow', 'freePieces', 'worryMultiplier', 'chainWeight']);
  if (!e) return;
  if ('joy' in e) c.num(e.joy, `${path}.joy`);
  if ('shadow' in e) c.num(e.shadow, `${path}.shadow`);
  if ('worryMultiplier' in e) c.num(e.worryMultiplier, `${path}.worryMultiplier`, { min: 0 });
  if ('freePieces' in e) {
    (c.arr(e.freePieces, `${path}.freePieces`) ?? []).forEach((fp, i) => {
      const pp = `${path}.freePieces[${i}]`;
      const o = c.obj(fp, pp, ['chain', 'tier']);
      if (!o) return;
      const chain = c.str(o.chain, `${pp}.chain`);
      if (chain !== undefined && !chainIds.includes(chain)) c.fail(`${pp}.chain`, `chains.json에 없는 체인 "${chain}"`);
      c.num(o.tier, `${pp}.tier`, { int: true, min: 1, max: maxTier });
    });
  }
  if ('chainWeight' in e) {
    const cw = c.map(e.chainWeight, `${path}.chainWeight`);
    if (cw) {
      for (const [k, val] of Object.entries(cw)) {
        if (!chainIds.includes(k)) c.fail(`${path}.chainWeight.${k}`, `chains.json에 없는 체인 "${k}"`);
        c.num(val, `${path}.chainWeight.${k}`, { min: 0 });
      }
    }
  }
}

interface EventIds {
  fixable: string[]; // days.fixed에 넣을 수 있는 id (이정표 + 계절)
  all: string[];
}

function checkEvents(c: Checker, v: unknown, chainIds: string[], maxTier: number | undefined, world: string | undefined): EventIds {
  const ev = c.obj(v, 'events', ['milestones', 'seasonal', 'daily', 'plainDay']);
  if (!ev) return { fixable: [], all: [] };

  const milestoneIds = (c.arr(ev.milestones, 'events.milestones') ?? []).map((e, i) => {
    const p = `events.milestones[${i}]`;
    const o = c.obj(e, p, ['id', 'world', 'archetypeId', 'title', 'text', 'choices', 'diaryLine']);
    if (!o) return undefined;
    checkWorld(c, o.world, `${p}.world`, world);
    c.str(o.archetypeId, `${p}.archetypeId`);
    c.str(o.title, `${p}.title`);
    c.str(o.text, `${p}.text`);
    c.str(o.diaryLine, `${p}.diaryLine`);
    const choiceIds = (c.arr(o.choices, `${p}.choices`, 2) ?? []).map((ch, j) => {
      const cp = `${p}.choices[${j}]`;
      const co = c.obj(ch, cp, ['id', 'label', 'flag', 'joy', 'shadow'], ['faceLayerHpReduce', 'bonusReturnPiece']);
      if (!co) return undefined;
      c.str(co.label, `${cp}.label`);
      if (co.flag !== 'avoid' && co.flag !== 'face') c.fail(`${cp}.flag`, '"avoid" 또는 "face"여야 함');
      c.num(co.joy, `${cp}.joy`);
      c.num(co.shadow, `${cp}.shadow`);
      // 비율: 0.3 = 그날 심연 층 HP 30% 감소
      if ('faceLayerHpReduce' in co) c.num(co.faceLayerHpReduce, `${cp}.faceLayerHpReduce`, { min: 0, max: 1 });
      if ('bonusReturnPiece' in co) c.bool(co.bonusReturnPiece, `${cp}.bonusReturnPiece`);
      return c.str(co.id, `${cp}.id`);
    });
    c.unique(choiceIds, `${p}.choices`, 'id');
    return c.str(o.id, `${p}.id`);
  });

  const seasonalIds = (c.arr(ev.seasonal, 'events.seasonal') ?? []).map((e, i) => {
    const p = `events.seasonal[${i}]`;
    const o = c.obj(e, p, ['id', 'world', 'archetypeId', 'title', 'text', 'effects', 'diaryLine']);
    if (!o) return undefined;
    checkWorld(c, o.world, `${p}.world`, world);
    c.str(o.archetypeId, `${p}.archetypeId`);
    c.str(o.title, `${p}.title`);
    c.str(o.text, `${p}.text`);
    c.str(o.diaryLine, `${p}.diaryLine`);
    checkEffects(c, o.effects, `${p}.effects`, chainIds, maxTier);
    return c.str(o.id, `${p}.id`);
  });

  const dailyIds = (c.arr(ev.daily, 'events.daily') ?? []).map((e, i) => {
    const p = `events.daily[${i}]`;
    const o = c.obj(e, p, ['id', 'world', 'title', 'effects', 'diaryLine']);
    if (!o) return undefined;
    checkWorld(c, o.world, `${p}.world`, world);
    c.str(o.title, `${p}.title`);
    c.str(o.diaryLine, `${p}.diaryLine`);
    checkEffects(c, o.effects, `${p}.effects`, chainIds, maxTier);
    return c.str(o.id, `${p}.id`);
  });

  const plain = c.obj(ev.plainDay, 'events.plainDay', ['title', 'diaryLines']);
  if (plain) {
    c.str(plain.title, 'events.plainDay.title');
    c.strList(plain.diaryLines, 'events.plainDay.diaryLines');
  }

  const all = [...milestoneIds, ...seasonalIds, ...dailyIds];
  c.unique(all, 'events', '이벤트 id');
  const defined = (ids: (string | undefined)[]) => ids.filter((s): s is string => s !== undefined);
  return { fixable: defined([...milestoneIds, ...seasonalIds]), all: defined(all) };
}

function checkDays(c: Checker, v: unknown, eventIds: EventIds, lifeLengthDays: number | undefined): void {
  const d = c.obj(v, 'days', ['world', 'age', 'fixed', 'dailyEventChance', 'dailyEventCooldownDays', 'quietDays']);
  if (!d) return;
  c.num(d.age, 'days.age', { int: true, min: 0 });
  c.num(d.dailyEventChance, 'days.dailyEventChance', { min: 0, max: 1 });
  c.num(d.dailyEventCooldownDays, 'days.dailyEventCooldownDays', { int: true, min: 0 });
  c.num(d.quietDays, 'days.quietDays', { int: true, min: 0 });
  const fixed = c.map(d.fixed, 'days.fixed');
  if (!fixed) return;
  for (const [dayKey, id] of Object.entries(fixed)) {
    const p = `days.fixed.${dayKey}`;
    const day = Number(dayKey);
    if (!Number.isInteger(day) || day < 1) c.fail(p, '일차 키는 1 이상의 정수여야 함');
    else if (lifeLengthDays !== undefined && day > lifeLengthDays) c.fail(p, `lifeLengthDays(${lifeLengthDays})를 넘는 일차`);
    const s = c.str(id, p);
    if (s === undefined) continue;
    if (!eventIds.all.includes(s)) c.fail(p, `events.json에 없는 이벤트 "${s}"`);
    else if (!eventIds.fixable.includes(s)) c.fail(p, `"${s}"는 일상 이벤트라 고정 일차에 둘 수 없음 (이정표/계절만)`);
  }
}

function checkDiary(c: Checker, v: unknown): void {
  const d = c.obj(v, 'diary', ['result', 'night', 'forgottenDay']);
  if (!d) return;
  const r = c.obj(d.result, 'diary.result', ['backflow', 'manySunk', 'default']);
  if (r) for (const k of ['backflow', 'manySunk', 'default']) if (k in r) c.strList(r[k], `diary.result.${k}`);
  const n = c.obj(d.night, 'diary.night', ['layerCleared', 'tried', 'none']);
  if (n) for (const k of ['layerCleared', 'tried', 'none']) if (k in n) c.strList(n[k], `diary.night.${k}`);
  c.str(d.forgottenDay, 'diary.forgottenDay');
}

function checkEndings(c: Checker, v: unknown): void {
  const e = c.obj(v, 'endings', ['weights', 'thresholds', 'balanceRatio', 'endings']);
  if (!e) return;
  c.nums(e.weights, 'endings.weights', ['wUpTier', 'wDefeat', 'wJoy', 'wSunk', 'wDownTier', 'wLayer', 'wPurified'], { min: 0 });
  c.nums(e.thresholds, 'endings.thresholds', ['happy', 'unhappy'], { min: 0 });
  c.num(e.balanceRatio, 'endings.balanceRatio', { min: 0, max: 1 });
  const ids = ['hidden', 'solid', 'mask', 'quiet', 'rainy'];
  const list = c.obj(e.endings, 'endings.endings', ids);
  if (!list) return;
  for (const id of ids) {
    if (!(id in list)) continue;
    const p = `endings.endings.${id}`;
    const o = c.obj(list[id], p, ['name', 'title', 'desc']);
    if (o) for (const k of ['name', 'title', 'desc']) if (k in o) c.str(o[k], `${p}.${k}`);
  }
}

/** 원본 JSON 묶음을 검증한다. 하나라도 문제가 있으면 전체 목록을 돌려준다. */
export function validateGameData(raw: Record<keyof GameData, unknown>): ValidationResult {
  const c = new Checker();
  const { maxTier, lifeLengthDays } = checkBalance(c, raw.balance);
  const world = typeof (raw.days as Obj | null)?.world === 'string' ? ((raw.days as Obj).world as string) : undefined;
  if (world === undefined) c.fail('days.world', '비어 있지 않은 문자열이어야 함');
  checkUnits(c, raw.units, maxTier);
  const chainIds = checkChains(c, raw.chains, maxTier, world);
  checkMonsters(c, raw.monsters);
  const eventIds = checkEvents(c, raw.events, chainIds, maxTier, world);
  checkDays(c, raw.days, eventIds, lifeLengthDays);
  checkDiary(c, raw.diary);
  checkEndings(c, raw.endings);

  if (c.issues.length > 0) return { ok: false, issues: c.issues };
  return { ok: true, data: raw as unknown as GameData };
}
