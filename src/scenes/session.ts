// 앱 층의 메타 상태: gating(C안) + 저장 키 hau_save_v2 (스펙 §5.8-1, §5.8-2).
// core(GameState)는 gating·저장을 모른다. 이 모듈이 core(gating·save)와 platform(clock·storage)을 잇는다.
// 저장 키 하나에 gating과 game이 함께 들어 있으므로, "gating만 저장"은 마지막으로 저장한 game을 그대로 두고 다시 쓴다.

import type { GameData } from '../data/types';
import { GameState } from '../core/game';
import { consume, emptyGating, grant, gatingForNewLife, type GatingState } from '../core/gating';
import type { GridSize } from '../core/grid';
import { mulberry32, parseSeed, randomSeed } from '../core/rng';
import { makeSaveData, parseSave, serializeGame, type SaveGame } from '../core/save';
import { nowIso, today } from '../platform/clock';
import { SAVE_KEY, readKey, removeKey, writeKey } from '../platform/storage';
import { gameGeometry } from './layout';

export class SaveSession {
  gating: GatingState = emptyGating();
  /** 디버그: 열 수 있는 날이 0이어도 날을 시작 (저장하지 않음) */
  bypass = false;
  /** 마지막으로 저장한(또는 불러온) game */
  private game: SaveGame | null = null;

  constructor(
    private readonly data: GameData,
    private readonly size: GridSize,
  ) {}

  /**
   * 부팅: 저장을 읽어 GameState를 복원하거나 새 일생을 만든다 (§5.8-2 초기화 규칙).
   * 새 일생이면 즉시 dayStart 저장. 그 뒤 gating 지급 확인.
   */
  boot(): GameState {
    const r = parseSave(readKey(SAVE_KEY), this.data, this.size);
    let state: GameState | null = null;
    if (!r.ok) {
      if (r.reason !== '저장 없음') {
        console.warn(`[save] 저장 초기화 — ${r.reason}`);
        removeKey(SAVE_KEY);
      }
      this.gating = emptyGating();
    } else {
      if ('gameReset' in r) console.warn(`[save] game만 초기화 — ${r.gameReset}`);
      this.gating = r.save.gating;
      if (r.save.game) {
        try {
          const g = r.save.game;
          state = GameState.fromSave(this.data, g, mulberry32(g.seed), gameGeometry(this.data.balance.lane.laneCap), this.size);
          this.game = g;
        } catch (e) {
          console.warn(`[save] 복원 실패, 새 일생 — ${(e as Error).message}`);
        }
      }
    }
    if (!state) {
      state = this.newState();
      this.saveGame(state);
    }
    this.checkGrant(state);
    return state;
  }

  /** ?seed= 가 있으면 그 시드, 없으면 새 시드로 새 일생 */
  private newState(): GameState {
    const seed = parseSeed(new URLSearchParams(window.location.search).get('seed')) ?? randomSeed(Math.random);
    return new GameState(this.data, this.size, mulberry32(seed), gameGeometry(this.data.balance.lane.laneCap), seed);
  }

  /** 날을 시작할 수 있는지 (dayStart에서 카드 / "내일 또 만나요") */
  get canOpenDay(): boolean {
    return this.bypass || this.gating.openableDays >= 1;
  }

  /**
   * 지급 확인 (앱 부팅·visibilitychange → visible·[다시 확인]·디버그 날짜 오프셋). gating만 즉시 저장.
   * atDay: 다음에 플레이할 게임 일차 (dayStart면 그날, diary·chapterComplete면 다음 날)
   */
  checkGrant(state: GameState): { granted: number; forgotten: number } {
    const atDay = state.phase === 'dayStart' ? state.day : state.day + 1;
    const d = this.data.balance.days;
    const r = grant(this.gating, today(), atDay, { dailyLimit: d.dailyLimit, storeCap: d.storeCap });
    this.gating = r.next;
    this.write();
    return { granted: r.granted, forgotten: r.forgotten };
  }

  /** dayStart·chapterComplete 진입: game 저장 */
  saveGame(state: GameState): void {
    this.game = serializeGame(state);
    this.write();
  }

  /** diary 진입 (하루 끝): gating 1 소비 + game 저장을 한 번의 쓰기로 */
  endDay(state: GameState): void {
    try {
      this.gating = consume(this.gating, this.bypass);
    } catch (e) {
      // 날 시작 조건(openable ≥ 1)을 통과했다면 오지 않는다. 디버그로 우회를 끈 경우 등
      console.warn(`[gating] ${(e as Error).message} — 소비 없이 진행`);
    }
    this.game = serializeGame(state);
    this.write();
  }

  /** [처음부터]: 새 일생. openable·lastGrantDate·forgottenDays 유지, forgottenLog 비움. 다음 부팅에서 새 시드로 만들고 dayStart 저장 */
  newLife(): void {
    this.gating = gatingForNewLife(this.gating);
    this.game = null;
    this.write();
  }

  /** 디버그: 저장 초기화 (게임만) — gating 유지 */
  resetGame(): void {
    this.game = null;
    this.gating = gatingForNewLife(this.gating);
    this.write();
  }

  /** 디버그: 저장 초기화 (전부) */
  resetAll(): void {
    this.game = null;
    this.gating = emptyGating();
    removeKey(SAVE_KEY);
  }

  /** 디버그: 열 수 있는 날 +1 */
  addOpenable(n: number): void {
    this.gating = { ...this.gating, openableDays: this.gating.openableDays + n };
    this.write();
  }

  /** 디버그: 저장 JSON 원문 */
  rawJson(): string {
    return readKey(SAVE_KEY) ?? '(저장 없음)';
  }

  private write(): void {
    writeKey(SAVE_KEY, JSON.stringify(makeSaveData(this.size, this.gating, this.game, nowIso())));
  }
}
