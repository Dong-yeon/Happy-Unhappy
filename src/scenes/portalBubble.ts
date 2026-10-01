// 포탈 위 말풍선 판정 (§5.13-2): 쉬는 조각을 포탈(창문·손거울, 맡기기 포함)에 올리면 "쉬는 중이에요".
// v0.9에서 영웅 정화 경고("정화되면 와일드카드로 돌아와요", D-028)는 제거됐다. Phaser 의존 없음 (테스트용으로 분리).
import type { GameState } from '../core/game';
import type { PortalId } from './layout';

export const RESTING_TEXT = '쉬는 중이에요';

/** from 칸의 조각을 portal에 올렸을 때 보여줄 말풍선 (없으면 null) */
export function portalBubble(state: GameState, from: number, portal: PortalId | null): string | null {
  if (!portal) return null;
  return state.canSummon(from, portal) === 'injured' ? RESTING_TEXT : null;
}
