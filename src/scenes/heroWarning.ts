// 영웅 정화 경고 (§5.12-2, D-028): 영웅(maxTier) 조각을 손거울 위에 올리면 "정화되면 와일드카드로 돌아와요".
// 드롭은 막지 않는다. Phaser 의존 없음 (판정만 — 테스트용으로 분리).
import type { GameState } from '../core/game';
import { isWildcard } from '../core/grid';
import type { PortalId } from './layout';

export const HERO_WARNING_TEXT = '정화되면 와일드카드로 돌아와요';

/** from 칸의 조각을 portal에 올렸을 때 경고를 보여야 하는지: 손거울 + 영웅 + 실제로 보낼 수 있음(맡기기·즉시 소환) */
export function showHeroWarning(state: GameState, from: number, portal: PortalId | null): boolean {
  if (portal !== 'unhappy') return false;
  const p = state.grid.cells[from];
  if (!p || isWildcard(p) || p.tier < state.grid.maxTier) return false;
  return state.canSummon(from, 'unhappy') === null;
}
