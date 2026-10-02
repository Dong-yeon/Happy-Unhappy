// 앱 층의 저장 상태: 저장 키 hau_save_v4 (스펙 §5.19-7). gating(하루 열림)은 없다 (D-054).
// core(GameState)는 저장을 모른다. 이 모듈이 core(save)와 platform(storage)을 잇는다.

import type { GameData } from '../data/types';
import { GameState } from '../core/game';
import type { GridSize } from '../core/grid';
import { mulberry32, parseSeed, randomSeed } from '../core/rng';
import { makeSaveData, parseSave, serializeGame, type SaveGame } from '../core/save';
import { nowIso } from '../platform/clock';
import { LEGACY_SAVE_KEYS, SAVE_KEY, readKey, removeKey, writeKey } from '../platform/storage';
import { gameGeometry } from './layout';

export class SaveSession {
  /** 마지막으로 저장한(또는 불러온) game */
  private game: SaveGame | null = null;

  constructor(
    private readonly data: GameData,
    private readonly size: GridSize,
  ) {}

  /** 부팅: 저장을 읽어 GameState를 복원하거나 새 판을 만든다. 새 판이면 즉시 장면 카드(dayStart) 저장 */
  boot(): GameState {
    // v3 이하 저장은 스키마가 달라 읽지 않고 지운다 (§5.19-7, hau_save_v4)
    for (const k of LEGACY_SAVE_KEYS) if (readKey(k) !== null) removeKey(k);
    const r = parseSave(readKey(SAVE_KEY), this.data, this.size);
    let state: GameState | null = null;
    if (!r.ok) {
      if (r.reason !== '저장 없음') {
        console.warn(`[save] 저장 초기화 — ${r.reason}`);
        removeKey(SAVE_KEY);
      }
    } else {
      if ('gameReset' in r) console.warn(`[save] game만 초기화 — ${r.gameReset}`);
      if (r.save.game) {
        try {
          const g = r.save.game;
          state = GameState.fromSave(this.data, g, mulberry32(g.seed), gameGeometry(this.data.balance.merge.soldierCap + 1), this.size);
          this.game = g;
        } catch (e) {
          console.warn(`[save] 복원 실패, 새 판 — ${(e as Error).message}`);
        }
      }
    }
    if (!state) {
      state = this.newState();
      this.saveGame(state);
    }
    return state;
  }

  /** ?seed= 가 있으면 그 시드, 없으면 새 시드로 새 판 */
  private newState(): GameState {
    const seed = parseSeed(new URLSearchParams(window.location.search).get('seed')) ?? randomSeed(Math.random);
    return new GameState(this.data, this.size, mulberry32(seed), gameGeometry(this.data.balance.merge.soldierCap + 1), seed);
  }

  /** 경계(장면 카드·이야기 한 장·실패 직후·챕터 완성) 진입: game 저장 */
  saveGame(state: GameState): void {
    this.game = serializeGame(state);
    this.write();
  }

  /** [처음부터]·디버그 초기화: game을 비운다. 다음 부팅에서 새 시드로 만들고 저장 */
  resetGame(): void {
    this.game = null;
    this.write();
  }

  /** 디버그: 저장 키 삭제 */
  resetAll(): void {
    this.game = null;
    removeKey(SAVE_KEY);
  }

  /** 디버그: 저장 JSON 원문 */
  rawJson(): string {
    return readKey(SAVE_KEY) ?? '(저장 없음)';
  }

  private write(): void {
    writeKey(SAVE_KEY, JSON.stringify(makeSaveData(this.size, this.game, nowIso())));
  }
}
