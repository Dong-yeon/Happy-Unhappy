// 저장 v4 (§5.19-7): 경계(장면 카드·이야기 한 장·실패 직후·챕터 완성)만, 일차·gating 필드 없음, 핵 상태·시도 수·펼친 장
import { describe, expect, it } from 'vitest';
import { rawGameData } from '../src/data';
import type { GameData } from '../src/data/types';
import { GameState } from '../src/core/game';
import { FIXED_DT } from '../src/core/lane';
import { mulberry32 } from '../src/core/rng';
import { SAVE_VERSION, makeSaveData, parseSave, serializeGame, type SaveGame } from '../src/core/save';
import { gameGeometry } from '../src/scenes/layout';
import { POLICIES } from '../sim/policies';
import { runLife } from '../sim/runner';
import simJson from '../sim/sim.json';
import type { SimConfig } from '../sim/types';

const data = structuredClone(rawGameData) as unknown as GameData;
const SIZE = { cols: 5, rows: 4 };
const GEO = gameGeometry(data.balance.merge.soldierCap + 1);

function fresh(seed = 7): GameState {
  return new GameState(data, SIZE, mulberry32(seed), GEO, seed);
}
function restore(save: SaveGame): GameState {
  return GameState.fromSave(data, JSON.parse(JSON.stringify(save)) as SaveGame, mulberry32(save.seed), GEO, SIZE);
}
/** 한 스테이지를 디버그로 성공시킨다 (낮 → 밤 → 이야기 한 장) */
function clearStage(g: GameState): void {
  g.confirmDay(g.choices[0]?.id);
  g.debugToNight();
  g.debugEndNight();
}

describe('serializeGame / fromSave round-trip (경계)', () => {
  it('장면 카드 (스테이지 시작)', () => {
    const g = fresh();
    const s = serializeGame(g);
    expect(s).toMatchObject({ phase: 'dayStart', stage: 1, attempt: 0, retry: null, core: { state: 'none', y: null, hp: 100 } });
    expect(JSON.stringify(serializeGame(restore(s)))).toBe(JSON.stringify(s));
  });

  it('이야기 한 장 (시도 기록·펼친 장 포함)', () => {
    const g = fresh();
    clearStage(g);
    expect(g.phase).toBe('diary');
    const s = serializeGame(g);
    expect(s.pages).toEqual([1]);
    expect(s.attemptLog).toHaveLength(1);
    expect(s.attemptLog[0].result).toBe('success');
    const back = restore(s);
    expect(back.lastAttempt?.result).toBe('success');
    expect(JSON.stringify(serializeGame(back))).toBe(JSON.stringify(s));
  });

  it('실패 직후 장면 카드 (retry·스테이지별 시도 수)', () => {
    const g = fresh();
    g.confirmDay();
    g.debugFail();
    expect(g.phase).toBe('dayStart');
    const s = serializeGame(g);
    expect(s).toMatchObject({ stage: 1, attempt: 1, retry: 'dayTime' });
    expect(s.attempts[0]).toBe(1);
    const back = restore(s);
    expect(back.retry).toBe('dayTime');
    expect(JSON.stringify(serializeGame(back))).toBe(JSON.stringify(s));
  });

  it('챕터 완성 (completed true), 갈림길 대기 플래그', () => {
    const g = fresh();
    for (let k = 0; k < 5; k++) {
      clearStage(g);
      g.nextStage();
    }
    expect(g.pendingCrossroad).toBe(true);
    const s = serializeGame(g);
    expect(s.pendingCrossroad).toBe(true);
    expect(restore(s).choices.length).toBeGreaterThan(0);
    g.debugCompleteChapter();
    const c = serializeGame(g);
    expect(c).toMatchObject({ phase: 'chapterComplete', completed: true });
    expect(JSON.stringify(serializeGame(restore(c)))).toBe(JSON.stringify(c));
  });

  it('낮·밤에는 예외 (경계에서만 저장)', () => {
    const g = fresh();
    g.confirmDay();
    expect(() => serializeGame(g)).toThrow(/경계/);
    g.debugToNight();
    expect(() => serializeGame(g)).toThrow(/경계/);
  });

  it('복원 뒤 진행이 원본과 같다 (rng 상태 포함)', () => {
    const g = fresh(11);
    const s = serializeGame(g);
    const b = restore(s);
    for (const x of [g, b]) {
      x.debugAddJoy(100);
      x.confirmDay();
      for (let k = 0; k < 600; k++) x.tick(FIXED_DT);
      x.spawn();
    }
    expect(b.grid.cells).toEqual(g.grid.cells);
    expect(b.abyss.enemies.map((e) => [e.x, e.y, e.hp])).toEqual(g.abyss.enemies.map((e) => [e.x, e.y, e.hp]));
  });
});

describe('parseSave (초기화 규칙)', () => {
  const raw = (mut?: (o: Record<string, any>) => void) => {
    const o = JSON.parse(JSON.stringify(makeSaveData(SIZE, serializeGame(fresh()), 'x'))) as Record<string, any>;
    mut?.(o);
    return JSON.stringify(o);
  };

  it('정상 저장 / game null 통과', () => {
    expect(parseSave(raw(), data, SIZE).ok).toBe(true);
    expect(parseSave(raw((o) => (o.game = null)), data, SIZE).ok).toBe(true);
  });

  it('키 없음 / JSON 파싱 실패 / version 불일치 (v3 = 옛 저장)', () => {
    expect(parseSave(null, data, SIZE)).toEqual({ ok: false, reason: '저장 없음' });
    expect(parseSave('{', data, SIZE).ok).toBe(false);
    const r = parseSave(raw((o) => (o.version = 3)), data, SIZE);
    expect(r.ok).toBe(false);
    expect(SAVE_VERSION).toBe(4);
  });

  it('일차(day)·gating 필드가 남아 있으면 오류 (D-054)', () => {
    for (const mut of [
      (o: Record<string, any>) => (o.gating = { openableDays: 1 }),
      (o: Record<string, any>) => (o.game.day = 3),
      (o: Record<string, any>) => (o.game.shadow = 0),
      (o: Record<string, any>) => (o.game.todayId = 'plain'),
      (o: Record<string, any>) => (o.game.dailyUsed = []),
    ]) {
      const r = parseSave(raw(mut), data, SIZE);
      expect(r.ok, JSON.stringify(r)).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/알 수 없는 키/);
    }
  });

  it('핵 상태·스테이지·시도 수 검증', () => {
    expect(parseSave(raw((o) => (o.game.core.state = 'lost')), data, SIZE).ok).toBe(false);
    expect(parseSave(raw((o) => (o.game.core.y = 10)), data, SIZE).ok).toBe(false); // none인데 위치
    expect(parseSave(raw((o) => (o.game.core = { state: 'carrying', y: 120, hp: 100 })), data, SIZE).ok).toBe(true);
    expect(parseSave(raw((o) => (o.game.stage = 11)), data, SIZE).ok).toBe(false);
    expect(parseSave(raw((o) => o.game.attempts.pop()), data, SIZE).ok).toBe(false);
    expect(parseSave(raw((o) => (o.game.retry = 'oops')), data, SIZE).ok).toBe(false);
    expect(parseSave(raw((o) => (o.game.pages = [0])), data, SIZE).ok).toBe(false);
  });

  it('grid 길이·조각 검증, 저장된 gridSize ≠ 현재 프리셋 → game만 초기화', () => {
    expect(parseSave(raw((o) => o.game.grid.pop()), data, SIZE).ok).toBe(false);
    expect(parseSave(raw((o) => (o.game.grid[0] = { id: 1, chain: 'nope', tier: 1, bornAt: 0 })), data, SIZE).ok).toBe(false);
    const r = parseSave(raw(), data, { cols: 4, rows: 4 });
    expect(r.ok && 'gameReset' in r && r.save.game === null).toBe(true);
  });
});

describe('결정성: 끊김 없이 한 판 vs 매 경계 round-trip (§5.19-7)', () => {
  const cfg = simJson as SimConfig;
  for (const name of ['balanced', 'nightOnly', 'lazy']) {
    it(name, () => {
      for (const seed of [1, 2]) {
        const opt = { seed, grid: SIZE, maxAttempts: 12 };
        const a = runLife(data, cfg, POLICIES[name], opt);
        const b = runLife(data, cfg, POLICIES[name], { ...opt, saveRoundTrip: true });
        expect(JSON.stringify(b.result)).toBe(JSON.stringify(a.result));
      }
    });
  }
});
