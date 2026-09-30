// 시뮬레이터 공용 타입 (스펙 §8.1). Node 전용, 게임 번들에 포함되지 않음.
import type { GameState } from '../src/core/game';
import type { Side } from '../src/core/lane';
import type { Rng } from '../src/core/rng';
import simJson from './sim.json';

export type SimConfig = typeof simJson;

/** 봇이 할 수 있는 행동 = 사람과 같은 core API (spawn / drop / summon / release). 치트 API 없음 */
export type Action =
  | { type: 'spawn' }
  | { type: 'drop'; from: number; to: number }
  | { type: 'summon'; cell: number; side: Side }
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
  /** null = 이번 결정에서는 아무것도 안 함 */
  decide(ctx: PolicyContext): Action | null;
}
