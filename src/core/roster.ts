// 영웅 보유·성장·편성·인연 (스펙 §5.20-1·2·6·7, D-058·D-060). Phaser 의존 없음.
// 편성 = 낮 공격대(offense) · 밤 수비대(defense), 각각 팀 배열, 팀 = 영웅 id 배열(앞 → 뒤, 최대 teamSize).

import type { BondDef, CombatStats, GameData, HeroDef, HeroRole } from '../data/types';

export type Side2 = 'offense' | 'defense';

/** 영웅 한 명의 판 상태 (보유 영웅마다) */
export interface HeroProgress {
  id: string;
  /** 지금 레벨 안에서 쌓인 경험치 */
  exp: number;
  level: number;
  /** 스킬 게이지 0 ~ skill.gauge */
  gauge: number;
}

export interface Formation {
  offense: string[][];
  defense: string[][];
}

export function emptyProgress(id: string): HeroProgress {
  return { id, exp: 0, level: 1, gauge: 0 };
}

type ExpCfg = GameData['balance']['exp'];

/** 레벨 n → n+1 필요 경험치 */
export function levelNeed(cfg: ExpCfg, n: number): number {
  return cfg.levelBase + cfg.levelStep * (n - 1);
}

/** 경험치를 더하고 레벨을 올린다 (상한에서는 경험치를 버림). 오른 레벨 수 */
export function addExp(p: HeroProgress, amount: number, cfg: ExpCfg): number {
  if (p.level >= cfg.maxLevel || amount <= 0) return 0;
  p.exp += amount;
  let up = 0;
  while (p.level < cfg.maxLevel && p.exp >= levelNeed(cfg, p.level) - 1e-9) {
    p.exp -= levelNeed(cfg, p.level);
    p.level += 1;
    up += 1;
  }
  if (p.level >= cfg.maxLevel) p.exp = 0;
  return up;
}

/** 레벨 반영 능력치: maxHp·atk × (1 + perLevelPct × (레벨 − 1)) */
export function statsAtLevel(def: HeroDef, level: number, cfg: ExpCfg): CombatStats {
  const k = 1 + cfg.perLevelPct * (level - 1);
  return { hp: def.hp * k, atk: def.atk * k, atkInterval: def.atkInterval, range: def.range };
}

export function cloneFormation(f: Formation): Formation {
  return { offense: f.offense.map((t) => [...t]), defense: f.defense.map((t) => [...t]) };
}

/** 빈 팀을 뺀 팀 목록 */
export function teamsOf(f: Formation, side: Side2): string[][] {
  return f[side].filter((t) => t.length > 0);
}

export function sameFormation(a: Formation, b: Formation): boolean {
  const norm = (f: Formation) => JSON.stringify({ o: teamsOf(f, 'offense'), d: teamsOf(f, 'defense') });
  return norm(a) === norm(b);
}

/**
 * 편성 검사 (§5.20-2): 팀 수 ≤ maxTeams, 팀 인원 ≤ teamSize, 보유 영웅만, 같은 영웅은 한 곳에만, 공격대·수비대 각각 최소 1명.
 * 문제가 없으면 null, 있으면 사유.
 */
export function formationError(f: Formation, owned: readonly string[], team: GameData['balance']['team']): string | null {
  const seen = new Set<string>();
  for (const side of ['offense', 'defense'] as const) {
    const teams = f[side];
    if (teams.length > team.maxTeams) return `${side === 'offense' ? '공격대' : '수비대'} 팀은 ${team.maxTeams}개까지`;
    for (const t of teams) {
      if (t.length > team.teamSize) return `한 팀은 ${team.teamSize}명까지`;
      for (const id of t) {
        if (!owned.includes(id)) return `없는 영웅: ${id}`;
        if (seen.has(id)) return `같은 영웅은 한 곳에만: ${id}`;
        seen.add(id);
      }
    }
    if (teamsOf(f, side).length === 0) return `${side === 'offense' ? '공격대' : '수비대'}에 최소 1명`;
  }
  return null;
}

/** 켜진 인연 하나: 어느 쪽 몇 팀의 누구에게 */
export interface ActiveBond {
  bond: BondDef;
  /** 효과를 받는 영웅 */
  heroes: string[];
  /** sameTeam·roleMix = 그 팀 (side, team) / split = 양쪽이라 null */
  side: Side2 | null;
  team: number | null;
}

function roleOf(data: GameData, id: string): HeroRole | undefined {
  return data.heroes.heroes.find((h) => h.id === id)?.role;
}

/** 편성에서 켜진 인연 (§5.20-6) */
export function activeBonds(data: GameData, f: Formation): ActiveBond[] {
  const out: ActiveBond[] = [];
  for (const bond of data.bonds.bonds) {
    if (bond.kind === 'split') {
      const inOff = f.offense.some((t) => t.includes(bond.offense));
      const inDef = f.defense.some((t) => t.includes(bond.defense));
      if (inOff && inDef) out.push({ bond, heroes: [bond.offense, bond.defense], side: null, team: null });
      continue;
    }
    for (const side of ['offense', 'defense'] as const) {
      f[side].forEach((t, i) => {
        if (bond.kind === 'sameTeam' && bond.heroes.every((h) => t.includes(h))) out.push({ bond, heroes: [...bond.heroes], side, team: i });
        if (bond.kind === 'roleMix') {
          const roles = t.map((id) => roleOf(data, id));
          if (bond.roles.every((r) => roles.includes(r))) out.push({ bond, heroes: [...t], side, team: i });
        }
      });
    }
  }
  return out;
}

// ── 조사 (§5.20-8): 앞 낱말 받침 ──

/** 마지막 글자가 한글이고 받침이 있으면 true (한글이 아니면 false) */
export function hasBatchim(word: string): boolean {
  const ch = word.trim().slice(-1);
  const code = ch.charCodeAt(0);
  if (code < 0xac00 || code > 0xd7a3) return false;
  return (code - 0xac00) % 28 !== 0;
}

/** "{이/가}" "{을/를}" "{은/는}" "{와/과}"를 바로 앞 낱말 받침에 맞춘다. 앞 낱말 = 표시 직전의 값 */
export function fillTemplate(tpl: string, vars: Record<string, string | number>): string {
  let out = '';
  let last = '';
  const re = /\{([^}]+)\}/g;
  let i = 0;
  for (let m = re.exec(tpl); m; m = re.exec(tpl)) {
    out += tpl.slice(i, m.index);
    const key = m[1];
    if (key.includes('/')) {
      const [withB, without] = key.split('/');
      out += hasBatchim(last) ? withB : without;
    } else {
      const v = String(vars[key] ?? '');
      out += v;
      last = v;
    }
    i = m.index + m[0].length;
    if (!key.includes('/')) continue;
  }
  return out + tpl.slice(i);
}
