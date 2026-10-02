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

function checkCombat(c: Checker, v: unknown, path: string, extra: string[] = [], optional: string[] = []): Obj | undefined {
  const o = c.obj(v, path, [...extra, ...COMBAT_KEYS], optional);
  if (!o) return undefined;
  c.num(o.hp, `${path}.hp`, { min: 1 });
  c.num(o.atk, `${path}.atk`, { min: 0 });
  c.num(o.atkInterval, `${path}.atkInterval`, { min: 0.01 });
  c.num(o.range, `${path}.range`, { min: 0 });
  return o;
}

function checkBalance(c: Checker, v: unknown): { maxTier?: number; chapterLength?: number } {
  const p = 'balance';
  // v0.15 (D-054·D-055): shadow·diary 블록, chapter.maxDays·days.dailyLimit/storeCap는 삭제 → 남아 있으면 "알 수 없는 키"
  const b = c.obj(v, p, [
    'version', 'start', 'grid', 'spawn', 'lane', 'happy', 'wave', 'enemy', 'swarm', 'guardian', 'carry', 'core', 'hero', 'buff', 'merge', 'skill', 'special',
    'team', 'exp', 'offense', 'chapter',
  ]);
  if (!b) return {};
  // v0.16 (§5.20): feed 블록·hero.dmgReduceMax/atkIntervalMin 삭제 → 남아 있으면 "알 수 없는 키"
  // §5.20-13 (D-064): 기쁨 삭제 — start.joy·grid.spawnCostBase/spawnCostStep/releaseRefund·days(morningJoyFloor)도 "알 수 없는 키"
  if (b.version !== 5) c.fail(`${p}.version`, `5여야 함 (현재 ${String(b.version)})`);
  const st = c.obj(b.start, `${p}.start`, ['swapHeroes']);
  if (st) {
    c.bool(st.swapHeroes, `${p}.start.swapHeroes`);
  }

  let maxTier: number | undefined;
  const g = c.obj(b.grid, `${p}.grid`, [
    'gridCols', 'gridRows', 'gridPresets', 'maxTier',
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
    maxTier = c.num(g.maxTier, `${p}.grid.maxTier`, { int: true, min: 1 });
  }

  // 조각이 생기는 길 (§5.20-13): 저절로 + 처치 드롭
  const sp = c.obj(b.spawn, `${p}.spawn`, ['autoInterval', 'killDropChance', 'bossDropTier', 'bossDropCount']);
  if (sp) {
    c.num(sp.autoInterval, `${p}.spawn.autoInterval`, { min: 0.1 });
    c.num(sp.killDropChance, `${p}.spawn.killDropChance`, { min: 0, max: 1 });
    const bt = c.num(sp.bossDropTier, `${p}.spawn.bossDropTier`, { int: true, min: 1 });
    if (bt !== undefined && maxTier !== undefined && bt > maxTier) c.fail(`${p}.spawn.bossDropTier`, `grid.maxTier(${maxTier}) 이하여야 함`);
    c.num(sp.bossDropCount, `${p}.spawn.bossDropCount`, { int: true, min: 0 });
  }

  // 몬스터 떼 (§5.20-13)
  const sw = c.obj(b.swarm, `${p}.swarm`, ['countMult', 'hpMult', 'laneMaxEnemies']);
  if (sw) {
    c.num(sw.countMult, `${p}.swarm.countMult`, { min: 0.01 });
    c.num(sw.hpMult, `${p}.swarm.hpMult`, { min: 0.01 });
    c.num(sw.laneMaxEnemies, `${p}.swarm.laneMaxEnemies`, { int: true, min: 1 });
  }

  const lane = c.obj(b.lane, `${p}.lane`, ['abyssAdvanceSpeed', 'defenseInterceptRange', 'defenseMoveSpeed', 'defenseContact']);
  if (lane) {
    c.num(lane.abyssAdvanceSpeed, `${p}.lane.abyssAdvanceSpeed`, { min: 0 });
    // 방어 유닛 제한 이동 (§4.3.3): 0이면 기존 규칙
    c.num(lane.defenseInterceptRange, `${p}.lane.defenseInterceptRange`, { min: 0 });
    c.num(lane.defenseMoveSpeed, `${p}.lane.defenseMoveSpeed`, { min: 0 });
    c.num(lane.defenseContact, `${p}.lane.defenseContact`, { min: 0 });
  }

  const h = c.nums(b.happy, `${p}.happy`, ['atk', 'atkInterval', 'range'], { min: 0 });
  if (h) c.num(h.atkInterval, `${p}.happy.atkInterval`, { min: 0.01 });

  c.nums(b.wave, `${p}.wave`, ['spawnInterval', 'waveGap', 'nightStartDelay'], { min: 0 });
  c.nums(b.enemy, `${p}.enemy`, ['hpGrowthPerStage'], { min: 0.01 });
  const gd = c.nums(b.guardian, `${p}.guardian`, ['counterAtk', 'counterAtkInterval', 'counterRange', 'bossCounterMult', 'bossWildcards'], { min: 0 });
  if (gd) {
    c.num(gd.counterAtkInterval, `${p}.guardian.counterAtkInterval`, { min: 0.01 });
    c.num(gd.bossWildcards, `${p}.guardian.bossWildcards`, { int: true });
  }
  const cr = c.nums(b.carry, `${p}.carry`, ['speedMult', 'atkIntervalMult', 'chaseInterval', 'pickupRange', 'chaseSpeedMult'], { min: 0 });
  if (cr) {
    c.num(cr.speedMult, `${p}.carry.speedMult`, { min: 0.01 });
    c.num(cr.atkIntervalMult, `${p}.carry.atkIntervalMult`, { min: 0.01 });
  }
  const co = c.nums(b.core, `${p}.core`, ['hp', 'sinkDamage', 'bossSinkDamage'], { min: 0 });
  if (co) c.num(co.hp, `${p}.core.hp`, { min: 1 });

  // 영웅·먹이기·버프·병사 (§5.17, [11])
  const hr = c.nums(b.hero, `${p}.hero`, ['reviveSeconds', 'reviveHpRatio'], { min: 0 });
  if (hr) c.num(hr.reviveHpRatio, `${p}.hero.reviveHpRatio`, { min: 0.01, max: 1 });
  // 스킬 게이지 (§5.20-5): tierPoints는 1 ~ fullAtTier−1 단계 (maxTier − 1개), fullAtTier ≤ maxTier
  const sk = c.obj(b.skill, `${p}.skill`, ['tierPoints', 'fullAtTier']);
  if (sk) {
    const tp = c.arr(sk.tierPoints, `${p}.skill.tierPoints`) ?? [];
    if (maxTier !== undefined && tp.length !== maxTier - 1) c.fail(`${p}.skill.tierPoints`, `maxTier − 1(${maxTier - 1})개여야 함 (현재 ${tp.length})`);
    tp.forEach((x, i) => c.num(x, `${p}.skill.tierPoints[${i}]`, { min: 0 }));
    c.num(sk.fullAtTier, `${p}.skill.fullAtTier`, { int: true, min: 2, max: maxTier });
  }
  c.nums(b.special, `${p}.special`, ['noonAtkPct', 'noonSeconds', 'fullMoonStunSeconds', 'fullMoonShieldPct'], { min: 0 });
  const tm = c.nums(b.team, `${p}.team`, ['maxTeams', 'teamSize', 'spacing', 'swapSeconds'], { min: 0 });
  if (tm) {
    c.num(tm.maxTeams, `${p}.team.maxTeams`, { int: true, min: 1 });
    c.num(tm.teamSize, `${p}.team.teamSize`, { int: true, min: 1 });
  }
  const ex = c.nums(b.exp, `${p}.exp`, ['kill', 'guardian', 'nightWin', 'failMult', 'levelBase', 'levelStep', 'perLevelPct', 'maxLevel'], { min: 0 });
  if (ex) {
    c.num(ex.failMult, `${p}.exp.failMult`, { max: 1 });
    c.num(ex.levelBase, `${p}.exp.levelBase`, { min: 1 });
    c.num(ex.maxLevel, `${p}.exp.maxLevel`, { int: true, min: 1 });
  }
  const bf = c.nums(b.buff, `${p}.buff`, ['healPct', 'momentumAtkPct', 'momentumSeconds', 'momentumMaxStacks', 'tier3Mult'], { min: 0 });
  if (bf) c.num(bf.momentumMaxStacks, `${p}.buff.momentumMaxStacks`, { int: true, min: 1 });
  const mg = c.obj(b.merge, `${p}.merge`, ['soldiers', 'soldierCap', 'soldierLifetime', 'affinityMult']);
  if (mg) {
    c.bool(mg.soldiers, `${p}.merge.soldiers`);
    c.num(mg.soldierCap, `${p}.merge.soldierCap`, { int: true, min: 0 });
    c.num(mg.soldierLifetime, `${p}.merge.soldierLifetime`, { min: 0.1 });
    c.num(mg.affinityMult, `${p}.merge.affinityMult`, { min: 0 });
  }

  // 낮 = 오펜스 (§5.19-2)
  c.nums(b.offense, `${p}.offense`, ['seconds'], { min: 1 });

  // 챕터 진행 (§5.19-1): 1 ≤ turningPoint < length
  let chapterLength: number | undefined;
  const ch = c.obj(b.chapter, `${p}.chapter`, ['length', 'turningPoint']);
  if (ch) {
    chapterLength = c.num(ch.length, `${p}.chapter.length`, { int: true, min: 2 });
    const tp = c.num(ch.turningPoint, `${p}.chapter.turningPoint`, { int: true, min: 1 });
    if (tp !== undefined && chapterLength !== undefined && tp >= chapterLength) c.fail(`${p}.chapter.turningPoint`, 'length보다 작아야 함');
  }
  return { maxTier, chapterLength };
}

const SKILL_KEYS: Record<string, string[]> = {
  strike: ['mult', 'pierce'],
  ward: ['radius', 'stunSeconds', 'shieldPct'],
  beam: ['mult'],
  mend: ['healPct', 'revive'],
};

/** heroes.json (§5.17-1, §5.19-9, §5.20-1): 능력치·체인·역할·공격 방식·스킬, 기본 편성 offense ≠ defense (보상 영웅 아님) */
function checkHeroes(c: Checker, v: unknown, chainIds: string[]): string[] {
  const o = c.obj(v, 'heroes', ['heroes', 'offense', 'defense']);
  if (!o) return [];
  const list = c.arr(o.heroes, 'heroes.heroes', 2) ?? [];
  const rewards = new Set<string>();
  const ids = list.map((e, i) => {
    const p = `heroes.heroes[${i}]`;
    const h = checkCombat(c, e, p, ['id', 'name', 'chain', 'role', 'attackType', 'skill'], ['reward']);
    if (!h) return undefined;
    c.str(h.name, `${p}.name`);
    const id = c.str(h.id, `${p}.id`);
    const ch = c.str(h.chain, `${p}.chain`);
    if (ch !== undefined && !chainIds.includes(ch)) c.fail(`${p}.chain`, `chains.json에 없는 체인 "${ch}"`);
    if (!['tank', 'attack', 'support'].includes(h.role as string)) c.fail(`${p}.role`, 'tank·attack·support 중 하나여야 함');
    if (h.attackType !== 'melee' && h.attackType !== 'ranged') c.fail(`${p}.attackType`, 'melee 또는 ranged여야 함');
    const sk = h.skill as Obj | undefined;
    const kind = typeof sk === 'object' && sk ? (sk.kind as string) : undefined;
    const extra = kind && SKILL_KEYS[kind];
    if (!extra) c.fail(`${p}.skill.kind`, `${Object.keys(SKILL_KEYS).join('·')} 중 하나여야 함`);
    else {
      const so = c.obj(h.skill, `${p}.skill`, ['kind', 'name', 'gauge', ...extra]);
      if (so) {
        c.str(so.name, `${p}.skill.name`);
        c.num(so.gauge, `${p}.skill.gauge`, { min: 1 });
        for (const k of extra) c.num(so[k], `${p}.skill.${k}`, { min: 0 });
      }
    }
    if ('reward' in h && c.str(h.reward, `${p}.reward`) !== undefined && id !== undefined) rewards.add(id);
    return id;
  });
  c.unique(ids, 'heroes.heroes', '영웅 id');
  const off = c.str(o.offense, 'heroes.offense');
  const def = c.str(o.defense, 'heroes.defense');
  for (const [k, id] of [['offense', off], ['defense', def]] as const) {
    if (id !== undefined && !ids.includes(id)) c.fail(`heroes.${k}`, `heroes에 없는 영웅 "${id}"`);
    // 보상 영웅은 시작 명단에서 뺀다 (D-057)
    if (id !== undefined && rewards.has(id)) c.fail(`heroes.${k}`, `보상 영웅 "${id}"은 시작 배정에 둘 수 없음`);
  }
  if (off !== undefined && off === def) c.fail('heroes.defense', 'offense와 다른 영웅이어야 함 (양쪽 최소 1명)');
  return ids.filter((x): x is string => x !== undefined);
}

/** bonds.json (§5.20-6): 영웅 id·역할 참조, 효과 키 */
function checkBonds(c: Checker, v: unknown, heroIds: string[]): void {
  const o = c.obj(v, 'bonds', ['bonds']);
  if (!o) return;
  const list = c.arr(o.bonds, 'bonds.bonds', 1) ?? [];
  const hero = (x: unknown, path: string) => {
    const id = c.str(x, path);
    if (id !== undefined && !heroIds.includes(id)) c.fail(path, `heroes.json에 없는 영웅 "${id}"`);
  };
  const ids = list.map((e, i) => {
    const p = `bonds.bonds[${i}]`;
    const kind = (e as Obj | null)?.kind;
    const keys = kind === 'sameTeam' ? ['heroes'] : kind === 'split' ? ['offense', 'defense'] : kind === 'roleMix' ? ['roles'] : null;
    if (!keys) {
      c.fail(`${p}.kind`, 'sameTeam·split·roleMix 중 하나여야 함');
      return undefined;
    }
    const b = c.obj(e, p, ['id', 'name', 'kind', 'effect', ...keys]);
    if (!b) return undefined;
    c.str(b.name, `${p}.name`);
    if (kind === 'sameTeam') (c.arr(b.heroes, `${p}.heroes`, 2) ?? []).forEach((h, k) => hero(h, `${p}.heroes[${k}]`));
    if (kind === 'split') {
      hero(b.offense, `${p}.offense`);
      hero(b.defense, `${p}.defense`);
    }
    if (kind === 'roleMix') {
      (c.arr(b.roles, `${p}.roles`, 1) ?? []).forEach((r, k) => {
        if (!['tank', 'attack', 'support'].includes(r as string)) c.fail(`${p}.roles[${k}]`, 'tank·attack·support 중 하나여야 함');
      });
    }
    const ef = c.obj(b.effect, `${p}.effect`, [], ['dmgReduce', 'firstFallReviveHp', 'gaugeMult', 'atkPct']);
    if (ef) {
      for (const k of Object.keys(ef)) c.num(ef[k], `${p}.effect.${k}`, { min: 0 });
      if (Object.keys(ef).length === 0) c.fail(`${p}.effect`, '효과가 하나 이상이어야 함');
    }
    return c.str(b.id, `${p}.id`);
  });
  c.unique(ids, 'bonds.bonds', '인연 id');
}

function checkChains(c: Checker, v: unknown, maxTier: number | undefined, world: string | undefined): string[] {
  const list = c.arr(v, 'chains', 1) ?? [];
  const ids = list.map((e, i) => {
    const p = `chains[${i}]`;
    const o = c.obj(e, p, ['archetypeId', 'world', 'spawnWeight', 'color', 'tierNames', 'side', 'buff', 'soldier']);
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
    if (o.side !== 'sun' && o.side !== 'moon') c.fail(`${p}.side`, 'sun 또는 moon이어야 함');
    if (o.buff !== 'heal' && o.buff !== 'momentum') c.fail(`${p}.buff`, 'heal 또는 momentum이어야 함');
    const so = c.obj(o.soldier, `${p}.soldier`, ['kind', 'name', 'levels']);
    if (so) {
      if (!['shield', 'snare', 'charger', 'bell'].includes(so.kind as string)) c.fail(`${p}.soldier.kind`, 'shield·snare·charger·bell 중 하나여야 함');
      c.str(so.name, `${p}.soldier.name`);
      const lv = c.arr(so.levels, `${p}.soldier.levels`) ?? [];
      // 결과 2~5단계 = 병사 1~4단 → maxTier − 1 단
      if (maxTier !== undefined && lv.length !== maxTier - 1) c.fail(`${p}.soldier.levels`, `maxTier − 1(${maxTier - 1})개여야 함 (현재 ${lv.length})`);
      lv.forEach((l, k) => {
        const q = `${p}.soldier.levels[${k}]`;
        const lo = checkCombat(c, l, q, [], ['slow', 'slowSeconds']);
        if (lo && 'slow' in lo) c.num(lo.slow, `${q}.slow`, { min: 0, max: 1 });
        if (lo && 'slowSeconds' in lo) c.num(lo.slowSeconds, `${q}.slowSeconds`, { min: 0 });
      });
    }
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

/** monsters.json (§5.19-5): 공통 능력치 + 종류별 배수. 돌려주는 값 = 적 id 목록 */
function checkMonsters(c: Checker, v: unknown): string[] {
  const m = c.obj(v, 'monsters', ['base', 'enemies']);
  if (!m) return [];
  const b = c.obj(m.base, 'monsters.base', ['hp', 'speed', 'atk', 'atkInterval']);
  if (b) {
    c.num(b.hp, 'monsters.base.hp', { min: 1 });
    c.num(b.speed, 'monsters.base.speed', { min: 0 });
    c.num(b.atk, 'monsters.base.atk', { min: 0 });
    c.num(b.atkInterval, 'monsters.base.atkInterval', { min: 0.01 });
  }
  const list = c.arr(m.enemies, 'monsters.enemies', 1) ?? [];
  const ids = list.map((e, i) => {
    const p = `monsters.enemies[${i}]`;
    const o = c.obj(e, p, ['id', 'name', 'hpMult', 'speedMult', 'atkMult']);
    if (!o) return undefined;
    c.str(o.name, `${p}.name`);
    c.num(o.hpMult, `${p}.hpMult`, { min: 0.01 });
    c.num(o.speedMult, `${p}.speedMult`, { min: 0 });
    c.num(o.atkMult, `${p}.atkMult`, { min: 0 });
    return c.str(o.id, `${p}.id`);
  });
  c.unique(ids, 'monsters.enemies', '적 id');
  return ids.filter((s): s is string => s !== undefined);
}

/** stages.json (§5.19-4): 챕터 길이만큼, stage 1..n 순서, 필수 문구, 적 id 참조. 1-length는 밤 없음 */
function checkStages(c: Checker, v: unknown, enemyIds: string[], length: number | undefined): void {
  const o = c.obj(v, 'stages', ['stages']);
  if (!o) return;
  const list = c.arr(o.stages, 'stages.stages', 1) ?? [];
  if (length !== undefined && list.length !== length) c.fail('stages.stages', `balance.chapter.length(${length})개여야 함 (현재 ${list.length})`);
  const groups = (g: unknown, path: string, minLen: number) => {
    const a = c.arr(g, path, minLen) ?? [];
    a.forEach((it, k) => {
      const q = `${path}[${k}]`;
      const e = c.obj(it, q, ['type', 'count']);
      if (!e) return;
      const t = c.str(e.type, `${q}.type`);
      if (t !== undefined && !enemyIds.includes(t)) c.fail(`${q}.type`, `monsters.enemies에 없는 적 "${t}"`);
      c.num(e.count, `${q}.count`, { int: true, min: 1 });
    });
  };
  list.forEach((it, i) => {
    const p = `stages.stages[${i}]`;
    const s = c.obj(it, p, ['stage', 'title', 'intro', 'coreName', 'page', 'retryIntro', 'cores', 'day', 'night'], ['coreText', 'retryPageLine']);
    if (!s) return;
    if (s.stage !== i + 1) c.fail(`${p}.stage`, `${i + 1}이어야 함 (순서대로)`);
    c.num(s.cores, `${p}.cores`, { int: true, min: 1 });
    if ('retryPageLine' in s) c.str(s.retryPageLine, `${p}.retryPageLine`);
    for (const k of ['title', 'intro', 'coreName', 'page', 'retryIntro']) c.str(s[k], `${p}.${k}`);
    if ('coreText' in s) c.str(s.coreText, `${p}.coreText`);
    const d = c.obj(s.day, `${p}.day`, ['guardian', 'guardianHp', 'enemies', 'chase'], ['boss']);
    if (d) {
      const gt = c.str(d.guardian, `${p}.day.guardian`);
      if (gt !== undefined && !enemyIds.includes(gt)) c.fail(`${p}.day.guardian`, `monsters.enemies에 없는 적 "${gt}"`);
      c.num(d.guardianHp, `${p}.day.guardianHp`, { min: 1 });
      if ('boss' in d) c.bool(d.boss, `${p}.day.boss`);
      groups(d.enemies, `${p}.day.enemies`, 0);
      groups(d.chase, `${p}.day.chase`, 0);
    }
    const nt = c.obj(s.night, `${p}.night`, ['waves'], ['bossWave']);
    if (nt) {
      const waves = c.arr(nt.waves, `${p}.night.waves`) ?? [];
      waves.forEach((w, k) => groups(w, `${p}.night.waves[${k}]`, 1));
      if ('bossWave' in nt) groups(nt.bossWave, `${p}.night.bossWave`, 1);
      const last = length !== undefined && i + 1 === length;
      // 1-length 낮 성공 = 챕터 완성 (밤 없음). 그 밖의 스테이지는 밤이 있어야 한다
      if (last && (waves.length > 0 || 'bossWave' in nt)) c.fail(`${p}.night`, '마지막 스테이지는 밤이 없어야 함 (waves 비움)');
      if (!last && waves.length === 0) c.fail(`${p}.night.waves`, '밤 웨이브가 하나 이상이어야 함');
    }
  });
}

function checkWorld(c: Checker, v: unknown, path: string, world: string | undefined): void {
  const w = c.str(v, path);
  if (w !== undefined && world !== undefined && w !== world) c.fail(path, `chapter.world("${world}")와 다름 ("${w}")`);
}

function checkEffects(c: Checker, v: unknown, path: string, chainIds: string[], maxTier: number | undefined): void {
  const e = c.obj(v, path, [], ['shadow', 'freePieces', 'worryMultiplier', 'chainWeight']);
  if (!e) return;
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
  /** 갈림길 후보 (chapter.crossroad) */
  milestones: string[];
}

function checkEvents(c: Checker, v: unknown, chainIds: string[], maxTier: number | undefined, world: string | undefined): EventIds {
  const ev = c.obj(v, 'events', ['milestones', 'seasonal', 'daily', 'plainDay']);
  if (!ev) return { fixable: [], all: [], milestones: [] };

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
      const co = c.obj(ch, cp, ['id', 'label', 'flag', 'shadow'], ['faceLayerHpReduce', 'bonusReturnPiece']);
      if (!co) return undefined;
      c.str(co.label, `${cp}.label`);
      if (co.flag !== 'avoid' && co.flag !== 'face') c.fail(`${cp}.flag`, '"avoid" 또는 "face"여야 함');
      c.num(co.shadow, `${cp}.shadow`);
      // 비율: 0.3 = 다음 스테이지 첫 시도 guardian HP 30% 감소
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
  return { fixable: defined([...milestoneIds, ...seasonalIds]), all: defined(all), milestones: defined(milestoneIds) };
}

function checkDays(c: Checker, v: unknown, eventIds: EventIds): void {
  const d = c.obj(v, 'days', ['fixed', 'dailyEventChance', 'dailyEventCooldownDays', 'quietDays']);
  if (!d) return;
  c.num(d.dailyEventChance, 'days.dailyEventChance', { min: 0, max: 1 });
  c.num(d.dailyEventCooldownDays, 'days.dailyEventCooldownDays', { int: true, min: 0 });
  c.num(d.quietDays, 'days.quietDays', { int: true, min: 0 });
  const fixed = c.map(d.fixed, 'days.fixed');
  if (!fixed) return;
  for (const [dayKey, id] of Object.entries(fixed)) {
    const p = `days.fixed.${dayKey}`;
    const day = Number(dayKey);
    if (!Number.isInteger(day) || day < 1) c.fail(p, '일차 키는 1 이상의 정수여야 함');
    const s = c.str(id, p);
    if (s === undefined) continue;
    if (!eventIds.all.includes(s)) c.fail(p, `events.json에 없는 이벤트 "${s}"`);
    else if (!eventIds.fixable.includes(s)) c.fail(p, `"${s}"는 일상 이벤트라 고정 일차에 둘 수 없음 (이정표/계절만)`);
  }
}

/** chapter.json (§5.15-2, §5.20-8): id·world·보스 이름·이야기책 문장 (1-5 갈림길은 D-063으로 삭제) */
function checkChapter(c: Checker, v: unknown): void {
  const o = c.obj(v, 'chapter', ['id', 'world', 'bossName', 'pageLines']);
  if (!o) return;
  const pl = c.obj(o.pageLines, 'chapter.pageLines', ['carrier', 'hpFull', 'hpMid', 'hpLow', 'retry']);
  if (pl) for (const k of ['carrier', 'hpFull', 'hpMid', 'hpLow', 'retry']) c.str(pl[k], `chapter.pageLines.${k}`);
  c.str(o.id, 'chapter.id');
  c.str(o.world, 'chapter.world');
  c.str(o.bossName, 'chapter.bossName');
}

/** chapter_complete.json (§5.15-5) */
function checkChapterComplete(c: Checker, v: unknown): void {
  const o = c.obj(v, 'chapterComplete', ['title', 'doneText', 'learnedRecipes']);
  if (!o) return;
  for (const k of ['title', 'doneText']) c.str(o[k], `chapterComplete.${k}`);
  const list = c.arr(o.learnedRecipes, 'chapterComplete.learnedRecipes') ?? [];
  const ids: (string | undefined)[] = [];
  list.forEach((it, i) => {
    const p = `chapterComplete.learnedRecipes[${i}]`;
    const e = c.obj(it, p, ['id', 'name', 'side']);
    if (!e) return;
    ids.push(c.str(e.id, `${p}.id`));
    c.str(e.name, `${p}.name`);
    if (e.side !== 'day' && e.side !== 'night') c.fail(`${p}.side`, 'day 또는 night여야 함');
  });
  c.unique(ids, 'chapterComplete.learnedRecipes', '조합법 id');
}

/** 조합표 (§5.13-5): 재료 chain이 chains.json에 존재, tier 2~3, 재료 2개, id 중복 금지, 알 수 없는 키 오류 */
function checkRecipes(c: Checker, v: unknown, chainIds: string[], maxTier: number | undefined): void {
  const r = c.obj(v, 'recipes', ['recipes']);
  if (!r) return;
  const list = c.arr(r.recipes, 'recipes.recipes', 1) ?? [];
  const ids: (string | undefined)[] = [];
  list.forEach((it, i) => {
    const p = `recipes.recipes[${i}]`;
    const o = c.obj(it, p, ['id', 'name', 'kind', 'inputs', 'legend']);
    if (!o) return;
    ids.push(c.str(o.id, `${p}.id`));
    c.str(o.name, `${p}.name`);
    if (o.kind !== 'happy' && o.kind !== 'purified') c.fail(`${p}.kind`, 'happy 또는 purified여야 함');
    const inputs = c.arr(o.inputs, `${p}.inputs`);
    if (inputs && inputs.length !== 2) c.fail(`${p}.inputs`, '재료는 2개여야 함');
    inputs?.forEach((inp, j) => {
      const q = `${p}.inputs[${j}]`;
      const io = c.obj(inp, q, ['chain', 'tier'], ['shining']);
      if (!io) return;
      const ch = c.str(io.chain, `${q}.chain`);
      if (ch !== undefined && !chainIds.includes(ch)) c.fail(`${q}.chain`, `chains.json에 없는 체인 "${ch}"`);
      c.num(io.tier, `${q}.tier`, { int: true, min: 2, max: maxTier });
      if ('shining' in io) c.bool(io.shining, `${q}.shining`);
    });
    checkCombat(c, o.legend, `${p}.legend`);
  });
  c.unique(ids, 'recipes.recipes', '조합 id');
}

/** 원본 JSON 묶음을 검증한다. 하나라도 문제가 있으면 전체 목록을 돌려준다. */
export function validateGameData(raw: Record<keyof GameData, unknown>): ValidationResult {
  const c = new Checker();
  const { maxTier, chapterLength } = checkBalance(c, raw.balance);
  const world = typeof (raw.chapter as Obj | null)?.world === 'string' ? ((raw.chapter as Obj).world as string) : undefined;
  const chainIds = checkChains(c, raw.chains, maxTier, world);
  const heroIds = checkHeroes(c, raw.heroes, chainIds);
  checkBonds(c, raw.bonds, heroIds);
  const enemyIds = checkMonsters(c, raw.monsters);
  checkStages(c, raw.stages, enemyIds, chapterLength);
  const eventIds = checkEvents(c, raw.events, chainIds, maxTier, world);
  checkDays(c, raw.days, eventIds);
  checkChapter(c, raw.chapter);
  checkChapterComplete(c, raw.chapterComplete);
  checkRecipes(c, raw.recipes, chainIds, maxTier);

  if (c.issues.length > 0) return { ok: false, issues: c.issues };
  return { ok: true, data: raw as unknown as GameData };
}
