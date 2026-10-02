// 시뮬레이터 공용 타입 (스펙 §8.1, §5.17-7). Node 전용, 게임 번들에 포함되지 않음.
import type { GameState, Role } from '../src/core/game';
import type { Rng } from '../src/core/rng';
import simJson from './sim.json';

export type SimConfig = typeof simJson;

/** 봇이 할 수 있는 행동 = 사람과 같은 core API (spawn / drop / feed / release). 치트 API 없음 */
export type Action =
  | { type: 'spawn' }
  | { type: 'drop'; from: number; to: number }
  /** 영웅 슬롯에 먹이기 (§5.17-2) */
  | { type: 'feed'; cell: number; role: Role }
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
  /** 전투 밖(dayStart 카드를 닫기 전·이야기 한 장 뒤)의 판단 (lazy용). 시간이 흐르지 않으므로 null이 나올 때까지 반복 */
  boundary?(ctx: PolicyContext): Action | null;
  /** 갈림길 선택 (하루 시작 카드). 없으면 첫 선택지 */
  milestone?(ctx: PolicyContext, choices: { id: string; label: string }[]): string;
}
