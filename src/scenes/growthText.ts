// 자라기·결과 화면 표시 문구 (§5.14). UI 용어는 "자라기 / 양분"만 쓴다 (D-030).
import type { Branch } from '../core/growth';
import type { GameData } from '../data/types';

export const BRANCH_ICON: Record<Branch, string> = { happy: '☀', unhappy: '☾', together: '☀☾', slow: '·' };
export const BRANCH_LABEL: Record<Branch, string> = {
  happy: '행복한 추억으로 자랐다',
  unhappy: '정화된 추억으로 자랐다',
  together: '두 추억을 함께 키웠다',
  slow: '천천히 자란',
};

/** 특성 이름: `${체인}:${종류}` (표의 강아지·담요 계열). 모르는 체인은 체인 이름 + 낮/밤 */
const TRAIT_NAME: Record<string, string> = {
  'companion_animal:happy': '다정함',
  'companion_animal:purified': '용기',
  'comfort_object:happy': '포근함',
  'comfort_object:purified': '위로',
};

export function traitName(data: GameData, key: string): string {
  if (TRAIT_NAME[key]) return TRAIT_NAME[key];
  const [chain, kind] = key.split(':');
  const c = data.chains.find((x) => x.archetypeId === chain);
  return `${c ? c.tierNames[c.tierNames.length - 1] : chain}(${kind === 'happy' ? '낮' : '밤'})`;
}

/** "다정함 2 · 용기 1" (스택 0은 뺀다). 없으면 '없음' */
export function traitsLine(data: GameData, traits: Record<string, number>, max?: number): string {
  const parts = Object.entries(traits)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${traitName(data, k)} ${n}${max !== undefined ? `/${max}` : ''}`);
  return parts.length ? parts.join(' · ') : '없음';
}

export function recipeName(data: GameData, id: string): string {
  return data.recipes.recipes.find((r) => r.id === id)?.name ?? id;
}
