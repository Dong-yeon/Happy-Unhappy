// 저장/복원 (스펙 §5.8-2, §7, §5.8-5)
import { describe, expect, it } from 'vitest';
import { rawGameData } from '../src/data';
import type { GameData } from '../src/data/types';
import { GameState } from '../src/core/game';
import { emptyGating, grant, type GatingState } from '../src/core/gating';
import type { GridSize } from '../src/core/grid';
import { FIXED_DT } from '../src/core/lane';
import { mulberry32 } from '../src/core/rng';
import { makeSaveData, parseSave, serializeGame, type SaveData, type SaveGame } from '../src/core/save';
import { gameGeometry } from '../src/scenes/layout';
import { POLICIES } from '../sim/policies';
import { runLife } from '../sim/runner';
import simJson from '../sim/sim.json';
import type { SimConfig } from '../sim/types';

const data = structuredClone(rawGameData) as unknown as GameData;
const SIZE: GridSize = { cols: 5, rows: 4 };
const geo = () => gameGeometry(data.balance.lane.laneCap);
const GATING: GatingState = grant(emptyGating(), '2026-10-01', 1, { dailyLimit: 2, storeCap: 4 }).next;

function fresh(seed = 5): GameState {
  return new GameState(data, SIZE, mulberry32(seed), geo(), seed);
}

/** 간단한 입력으로 phase에 도달할 때까지 (생성·위/아래 소환). 하루 경계를 넘을 때마다 1일 */
function playUntil(g: GameState, day: number, phase: 'dayStart' | 'diary'): GameState {
  let k = 0;
  while (!(g.day === day && g.phase === phase)) {
    if (g.phase === 'dayStart') g.confirmDay(g.today.kind === 'milestone' ? 'unhappy' : undefined);
    else if (g.phase === 'diary') g.nextDay();
    else {
      if (k % 90 === 0) {
        const s = g.spawn();
        if (s) g.summon(s.index, k % 180 === 0 ? 'happy' : 'unhappy');
      }
      g.tick(FIXED_DT);
      k++;
    }
  }
  return g;
}

function restore(save: SaveGame, size = SIZE): GameState {
  return GameState.fromSave(data, save, mulberry32(save.seed), geo(), size);
}

/** serialize → stringify → parseSave → fromSave → serialize */
function roundTripJson(g: GameState): { before: string; after: string } {
  const before = JSON.stringify(serializeGame(g));
  const raw = JSON.stringify(makeSaveData(SIZE, GATING, serializeGame(g), '2026-10-01T00:00:00.000Z'));
  const r = parseSave(raw, data, SIZE);
  if (!r.ok) throw new Error(r.reason);
  const after = JSON.stringify(serializeGame(restore(r.save.game!)));
  return { before, after };
}

describe('serializeGame / fromSave round-trip (경계 3종)', () => {
  it('dayStart', () => {
    const g = playUntil(fresh(), 4, 'dayStart');
    expect(g.grid.cells.some((c) => c !== null)).toBe(true);
    const { before, after } = roundTripJson(g);
    expect(after).toBe(before);
  });

  it('diary (lastDayStats 포함)', () => {
    const g = playUntil(fresh(), 7, 'diary');
    const { before, after } = roundTripJson(g);
    expect(after).toBe(before);
    expect(restore(serializeGame(g)).lastDayStats).toEqual(g.lastDayStats);
  });

  it('chapterComplete (완성 여부 포함, §5.15-7)', () => {
    for (const seed of [1, 2]) {
      const { state } = runLife(data, simJson as SimConfig, POLICIES.balanced, { seed, grid: SIZE });
      expect(state.phase).toBe('chapterComplete');
      expect(typeof state.completed).toBe('boolean');
      const { before, after } = roundTripJson(state);
      expect(after).toBe(before);
      expect(restore(serializeGame(state)).completed).toBe(state.completed);
    }
  });

  it('갈림길 대기·1-10 정화 플래그도 저장된다, 옛 저장(ending 키)은 초기화', () => {
    const g = playUntil(fresh(), 4, 'diary');
    g.pendingCrossroad = true;
    g.chapterCleared = true;
    const back = restore(serializeGame(g));
    expect(back.pendingCrossroad).toBe(true);
    expect(back.chapterCleared).toBe(true);
    const raw = JSON.parse(JSON.stringify(makeSaveData(SIZE, emptyGating(), serializeGame(g), 'x')));
    raw.game.ending = null;
    delete raw.game.completed;
    expect(parseSave(JSON.stringify(raw), data, SIZE).ok).toBe(false);
    const bad = JSON.parse(JSON.stringify(makeSaveData(SIZE, emptyGating(), serializeGame(g), 'x')));
    bad.game.phase = 'lifeEnd';
    expect(parseSave(JSON.stringify(bad), data, SIZE).ok).toBe(false);
  });

  it('복원한 dayStart는 오늘 이벤트를 다시 뽑지 않고, 이후 진행이 원본과 같다', () => {
    const a = playUntil(fresh(9), 3, 'dayStart');
    const b = restore(JSON.parse(JSON.stringify(serializeGame(a))) as SaveGame);
    expect(b.today).toEqual(a.today);
    for (const g of [a, b]) playUntil(g, 6, 'diary');
    expect(JSON.stringify(serializeGame(b))).toBe(JSON.stringify(serializeGame(a)));
  });

  it('웨이브 중(waves)에는 예외 / 레인이 비어 있지 않으면 예외', () => {
    const g = fresh();
    g.debugForceEvent('plain');
    g.confirmDay();
    expect(() => serializeGame(g)).toThrow(/경계/);
    g.summon(g.debugGrant('companion_animal', 1)!, 'happy');
    g.phase = 'diary'; // 인위적으로 경계로 바꿔도 레인에 유닛이 있으면 거부
    expect(() => serializeGame(g)).toThrow(/레인/);
  });
});

describe('parseSave (초기화 규칙)', () => {
  const valid = (): SaveData => makeSaveData(SIZE, GATING, serializeGame(playUntil(fresh(), 2, 'diary')), '2026-10-01T00:00:00.000Z');
  const parseAfter = (mutate: (s: SaveData & Record<string, unknown>) => void) => {
    const s = structuredClone(valid()) as SaveData & Record<string, unknown>;
    mutate(s);
    return parseSave(JSON.stringify(s), data, SIZE);
  };
  const expectReset = (r: ReturnType<typeof parseSave>, reason: RegExp) => {
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(reason);
  };

  it('정상 저장은 통과', () => {
    const r = parseSave(JSON.stringify(valid()), data, SIZE);
    expect(r.ok && !('gameReset' in r)).toBe(true);
  });

  it('game이 null(새 일생 대기)이어도 통과', () => {
    const r = parseSave(JSON.stringify(makeSaveData(SIZE, GATING, null, 'x')), data, SIZE);
    expect(r.ok).toBe(true);
  });

  it('키 없음 / JSON 파싱 실패 / version 불일치', () => {
    expectReset(parseSave(null, data, SIZE), /저장 없음/);
    expectReset(parseSave('{broken', data, SIZE), /JSON/);
    expectReset(parseAfter((s) => ((s as Record<string, unknown>).version = 1)), /version/);
  });

  it('알 수 없는 키 (최상위·game·gating)', () => {
    expectReset(parseAfter((s) => (s.extra = 1)), /save\.extra.*알 수 없는 키/);
    expectReset(parseAfter((s) => ((s.game as unknown as Record<string, unknown>).dayStartSnapshot = {})), /알 수 없는 키/);
    expectReset(parseAfter((s) => ((s.gating as unknown as Record<string, unknown>).bonus = 1)), /알 수 없는 키/);
  });

  it('필드 누락·타입 불일치', () => {
    expectReset(parseAfter((s) => delete (s.game as unknown as Record<string, unknown>).rngState), /rngState.*필수 키/);
    expectReset(parseAfter((s) => ((s.game as unknown as Record<string, unknown>).joy = '60')), /joy/);
  });

  it('grid 길이 ≠ cols×rows', () => {
    expectReset(parseAfter((s) => s.game!.grid.pop()), /grid.*길이/);
  });

  it('조각의 chain이 chains.json에 없음 / tier 범위 밖', () => {
    expectReset(
      parseAfter((s) => (s.game!.grid[0] = { id: 999, chain: 'no_such_chain', tier: 1, bornAt: 0 })),
      /chains\.json에 없는 체인/,
    );
    expectReset(parseAfter((s) => (s.game!.grid[0] = { id: 999, chain: 'companion_animal', tier: 9, bornAt: 0 })), /tier/);
  });

  it('todayId가 events에 없음 / 날짜 형식 오류', () => {
    expectReset(parseAfter((s) => (s.game!.todayId = 'nope')), /todayId/);
    expectReset(parseAfter((s) => (s.gating.lastGrantDate = '2026-02-30')), /lastGrantDate.*날짜/);
  });

  it('저장된 gridSize ≠ 현재 프리셋 → game만 초기화, gating 유지', () => {
    const s = valid();
    const r = parseSave(JSON.stringify(s), data, { cols: 6, rows: 4 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect('gameReset' in r && r.gameReset).toMatch(/프리셋/);
    expect(r.save.game).toBeNull();
    expect(r.save.gating).toEqual(s.gating);
    expect(r.save.gridSize).toEqual({ cols: 6, rows: 4 });
  });
});

describe('결정성: 끊김 없이 한 판 vs 매 경계 round-trip (§5.8-5)', () => {
  const cfg = simJson as SimConfig;
  it.each(['balanced', 'alwaysHappy'].flatMap((p) => [11, 22, 33].map((seed) => [p, seed] as const)))(
    '%s 시드 %i: 최종 stats·diary·completed 동일',
    (policy, seed) => {
      const a = runLife(data, cfg, POLICIES[policy], { seed, grid: SIZE });
      const b = runLife(data, cfg, POLICIES[policy], { seed, grid: SIZE, saveRoundTrip: true });
      expect(a.state.phase).toBe('chapterComplete');
      expect(b.state.stats).toEqual(a.state.stats);
      expect(b.state.diary).toEqual(a.state.diary);
      expect(b.state.completed).toBe(a.state.completed);
      expect(b.result).toEqual(a.result);
      expect(JSON.stringify(serializeGame(b.state))).toBe(JSON.stringify(serializeGame(a.state)));
    },
  );
});
