// --set / --sweep: JSON 수치를 파일 수정 없이 메모리 사본에서 덮어쓴다 (시뮬레이터 전용).
// 키 경로: 첫 마디가 데이터 파일 이름(balance, units, chains, monsters, events, days, diary, endings)이면 그 파일,
// 아니면 balance.json으로 본다.  예) shadow.shadowAfterBossWin=50 → balance.shadow.shadowAfterBossWin
//                               monsters.backflowBoss.hp=300 / chains.0.hero.atk=16
// 이미 있는 키만 바꿀 수 있고(오타 방지), 값의 타입이 원래와 같아야 한다. 적용 후 데이터 검증을 다시 돌린다.
import type { GameData } from '../src/data/types';
import { validateGameData } from '../src/data/validate';

export type OverrideValue = number | boolean | string | unknown[];

export interface Override {
  /** 사용자가 쓴 키 (리포트 표시용) */
  key: string;
  /** 파일 이름을 포함한 전체 경로 */
  path: string[];
  value: OverrideValue;
}

const FILES: (keyof GameData)[] = ['balance', 'heroes', 'chains', 'monsters', 'events', 'days', 'diary', 'chapter', 'chapterComplete', 'recipes'];

export function resolvePath(key: string): string[] {
  const parts = key.split('.').filter((p) => p.length > 0);
  if (parts.length === 0) throw new Error(`빈 키: "${key}"`);
  return (FILES as string[]).includes(parts[0]) ? parts : ['balance', ...parts];
}

/** 값 문자열 → 숫자·불리언·배열(JSON) 또는 문자열 */
export function parseValue(raw: string): OverrideValue {
  const t = raw.trim();
  if (t === '') throw new Error('값이 비어 있음');
  try {
    return JSON.parse(t) as OverrideValue;
  } catch {
    return t;
  }
}

/** "key=value" 하나 */
export function parseSet(arg: string): Override {
  const i = arg.indexOf('=');
  if (i <= 0) throw new Error(`--set은 key=value 형식: "${arg}"`);
  const key = arg.slice(0, i).trim();
  return { key, path: resolvePath(key), value: parseValue(arg.slice(i + 1)) };
}

/** "key=a,b,c" → 같은 키의 값 목록 (배열 값은 sweep 대상이 아님) */
export function parseSweep(arg: string): { key: string; values: Override[] } {
  const i = arg.indexOf('=');
  if (i <= 0) throw new Error(`--sweep은 key=a,b,c 형식: "${arg}"`);
  const key = arg.slice(0, i).trim();
  const raws = arg
    .slice(i + 1)
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (raws.length === 0) throw new Error(`--sweep 값이 없음: "${arg}"`);
  const path = resolvePath(key);
  return { key, values: raws.map((r) => ({ key, path, value: parseValue(r) })) };
}

function typeName(v: unknown): string {
  return Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v;
}

/**
 * 원본을 복제해 덮어쓴 GameData를 돌려준다. 원본은 바꾸지 않는다.
 * 없는 키·타입 불일치·검증 실패는 예외 (메시지에 경로와 원인).
 */
export function applyOverrides(data: GameData, overrides: Override[]): GameData {
  const out = structuredClone(data);
  for (const o of overrides) {
    let node: unknown = out;
    for (let k = 0; k < o.path.length - 1; k++) {
      const seg = o.path[k];
      if (typeof node !== 'object' || node === null || !(seg in node)) {
        throw new Error(`--set ${o.key}: "${o.path.slice(0, k + 1).join('.')}"가 없음`);
      }
      node = (node as Record<string, unknown>)[seg];
    }
    const last = o.path[o.path.length - 1];
    if (typeof node !== 'object' || node === null || !(last in node)) {
      throw new Error(`--set ${o.key}: "${o.path.join('.')}"가 없음 (없는 키는 만들지 않음)`);
    }
    const parent = node as Record<string, unknown>;
    const before = parent[last];
    if (typeName(before) !== typeName(o.value)) {
      throw new Error(`--set ${o.key}: 타입이 다름 (원래 ${typeName(before)}, 입력 ${typeName(o.value)})`);
    }
    parent[last] = o.value;
  }
  const r = validateGameData(out as unknown as Record<keyof GameData, unknown>);
  if (!r.ok) {
    throw new Error(`--set 적용 후 데이터 검증 실패:\n${r.issues.map((i) => `  ${i.path}: ${i.reason}`).join('\n')}`);
  }
  return r.data;
}

/** 리포트 기록용 {키: 값} */
export function overridesRecord(overrides: Override[]): Record<string, OverrideValue> {
  const rec: Record<string, OverrideValue> = {};
  for (const o of overrides) rec[o.path.join('.')] = o.value;
  return rec;
}
