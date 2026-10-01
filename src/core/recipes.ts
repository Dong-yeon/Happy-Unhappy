// 조합표 (스펙 §5.13-5, D-029): 빛나는 영웅 + 정해진 재료 → 전설 추억. Phaser 의존 없음.
// 그리드 드롭 규칙: ① 같은 체인·같은 단계면 기존 머지 ② 아니면 (A, B)가 순서 무관으로 조합표 재료와 일치하면 조합 ③ 아니면 교환.
import type { Recipe } from '../data/types';
import { isWildcard, type Piece } from './grid';

/** 전설 추억의 단계 (영웅 = maxTier 3 위) */
export const LEGEND_TIER = 4;

/** 조각이 재료 조건과 맞는지: 체인·단계 일치, shining 조건이 있으면 빛나는 영웅. 와일드카드·전설은 재료가 될 수 없다 */
function matches(p: Piece, input: Recipe['inputs'][number]): boolean {
  if (isWildcard(p) || p.legend) return false;
  if (p.chain !== input.chain || p.tier !== input.tier) return false;
  return !input.shining || p.shining === true;
}

/** (a, b) 순서 무관으로 일치하는 첫 조합 (조합표 순서). 쉬는 재료도 허용 (§5.13-2) */
export function findRecipe(recipes: readonly Recipe[], a: Piece, b: Piece): Recipe | null {
  for (const r of recipes) {
    const [x, y] = r.inputs;
    if ((matches(a, x) && matches(b, y)) || (matches(a, y) && matches(b, x))) return r;
  }
  return null;
}

/** 영웅(3단계)·전설(4단계): 쓰러지지 않고 부상, 대기열 상한 무시 (§5.13-1·2) */
export function isHeroic(p: { tier: number; legend?: string }, maxTier: number): boolean {
  return p.tier >= maxTier || p.legend !== undefined;
}
