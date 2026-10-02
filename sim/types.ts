// 시뮬레이터 공용 타입 (스펙 §8.1, §5.20-10). Node 전용, 게임 번들에 포함되지 않음.
import type { GameState } from '../src/core/game';
import type { Formation } from '../src/core/roster';
import type { Rng } from '../src/core/rng';
import simJson from './sim.json';

export type SimConfig = typeof simJson;

/** 봇이 할 수 있는 행동 = 사람과 같은 core API (drop / release). 조각은 저절로·처치 드롭으로만 생긴다 (§5.20-13). 치트 API 없음 */
export type Action =
  | { type: 'drop'; from: number; to: number }
  | { type: 'release'; cell: number };

export interface PolicyContext {
  /** 읽기 전용으로만 본다. 상태 변경은 Action으로만 */
  readonly state: GameState;
  /** 봇 전용 rng (게임 rng와 분리) */
  readonly rng: Rng;
  readonly cfg: SimConfig;
}

export interface Policy {
  readonly name: string;
  /** 전투 중(낮·밤) 판단. null = 이번 결정에서는 아무것도 안 함 */
  decide(ctx: PolicyContext): Action | null;
  /** 전투 밖(장면 카드를 닫기 전·이야기 한 장 뒤)의 판단 (lazy용). 시간이 흐르지 않으므로 null이 나올 때까지 반복 */
  boundary?(ctx: PolicyContext): Action | null;
  /** 판 시작 편성 (보유 영웅으로). 없으면 balanced 편성 */
  formation?(state: GameState): Formation;
  /** 성장 (§5.22-8): 잉크 붓기 대상 — alternate(공격대·수비대 번갈아, 기본) / offense / defense (한쪽 몰기) / none (안 씀) / random.
   *  진급도 같은 쪽으로 (none이면 번갈아) */
  readonly grow?: 'alternate' | 'offense' | 'defense' | 'none' | 'random';
  /** 진급 (false = 안 함, 기본 true) */
  readonly promote?: boolean;
}
