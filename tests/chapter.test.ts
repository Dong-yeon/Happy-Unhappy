// 챕터 진행 (스펙 §5.15-1·7, D-039): 1-5 정화 → 다음 dayStart 자라기 + 갈림길 / 1-10 정화 → 새벽 뒤 자라기 + 챕터 완성 / maxDays 미완성
import { describe, expect, it } from 'vitest';
import { rawGameData } from '../src/data';
import type { GameData } from '../src/data/types';
import { GameState, type CoreEvent } from '../src/core/game';
import { FIXED_DT, layerBaseHp, layerHp } from '../src/core/lane';
import { mulberry32 } from '../src/core/rng';
import { makeSaveData, parseSave, serializeGame } from '../src/core/save';
import { emptyGating } from '../src/core/gating';
import { gameGeometry } from '../src/scenes/layout';

const base = structuredClone(rawGameData) as unknown as GameData;
const CH = base.balance.chapter;
const DOG = 'companion_animal';
const SIZE = { cols: 5, rows: 4 };

function fresh(): GameState {
  return new GameState(structuredClone(base), SIZE, mulberry32(1), gameGeometry(base.balance.lane.laneCap), 1);
}

const ofType = <T extends CoreEvent['type']>(es: CoreEvent[], t: T) =>
  es.filter((e): e is Extract<CoreEvent, { type: T }> => e.type === t);

/** dayStart → 낮 즉시 끝 → 밤: 유닛 하나를 내려보내고 지금 층을 정화 (층 HP 0) → 그 밤이 끝날 때까지 */
function clearTonight(g: GameState): CoreEvent[] {
  if (g.phase === 'dayStart') g.confirmDay(g.today.kind === 'milestone' ? 'happy' : undefined);
  g.debugToNight();
  g.summon(g.debugGrant(DOG, 1)!, 'unhappy');
  g.debugBreakLayer();
  const out: CoreEvent[] = [];
  for (let i = 0; i < 60 * 600 && g.phase === 'night'; i++) {
    out.push(...g.tick(FIXED_DT));
    if (ofType(out, 'layerClear').length > 0 && g.phase === 'night') g.debugEndNight();
  }
  out.push(...g.tick(0));
  return out;
}

/** dayStart → 층을 넘지 않고 diary까지 */
function quietDay(g: GameState): void {
  g.confirmDay(g.today.kind === 'milestone' ? 'happy' : undefined);
  g.debugEndDay();
  g.tick(0);
}

describe('데이터 (§5.15-1)', () => {
  it('balance.chapter 그대로: length 10, turningPoint 5, ×1.5, maxDays 20', () => {
    expect(CH).toEqual({ length: 10, turningPoint: 5, turningPointHpMult: 1.5, maxDays: 20 });
  });

  it('5층 HP × turningPointHpMult (보스 층 배수와 별개), 다른 층은 그대로', () => {
    const g = fresh();
    const w = { ...base.balance.abyss, turningPoint: CH.turningPoint, turningPointHpMult: CH.turningPointHpMult };
    expect(layerHp(w, 5)).toBeCloseTo(layerBaseHp(w, 5) * CH.turningPointHpMult, 9);
    expect(layerHp(w, 4)).toBeCloseTo(layerBaseHp(w, 4), 9);
    expect(layerHp(w, 10)).toBeCloseTo(layerBaseHp(w, 10) * base.balance.abyss.bossFloorHpMult, 9);
    // 실제 벽: 4층을 넘으면 5층 HP가 배수만큼
    g.debugSetStage(4);
    clearTonight(g);
    expect(g.abyss.wall.layer).toBe(5);
    expect(g.abyss.wall.maxHp - g.abyss.wall.extraHp).toBeCloseTo(layerBaseHp(w, 5) * CH.turningPointHpMult, 6);
  });
});

describe('1-5 전환점 → 다음 dayStart 자라기 + 갈림길', () => {
  it('정화한 밤: 갈림길 대기, 이야기 한 장에 자라기 문장 → 다음 날 dayStart에서 자라기가 이벤트 카드보다 먼저, 카드 = 갈림길', () => {
    const g = fresh();
    g.debugSetStage(CH.turningPoint);
    clearTonight(g);
    expect(g.phase).toBe('diary');
    expect(g.pendingCrossroad).toBe(true);
    expect(g.stats.turningPointClearedDay).toBe(1);
    const entry = g.diary[g.diary.length - 1];
    expect(base.diary.growth).toContain(entry.growthLine);
    expect(g.growthLog).toHaveLength(0);
    g.nextDay();
    const es = g.tick(0).filter((e) => e.type === 'growth' || e.type === 'dayStart');
    expect(es.map((e) => e.type)).toEqual(['growth', 'dayStart']);
    expect(g.phase).toBe('dayStart');
    expect(g.pendingCrossroad).toBe(false);
    expect(g.today).toMatchObject({ kind: 'milestone', id: base.chapter.crossroad, title: '문틈의 목소리' });
    expect(g.growthLog.map((r) => r.day)).toEqual([2]);
    // 갈림길 선택 효과·flag 그대로
    expect(g.confirmDay()).toEqual({ ok: false, reason: 'needChoice' });
    expect(g.confirmDay('unhappy').ok).toBe(true);
    expect(g.flags).toEqual(['face']);
  });

  it('1-4 도달 일차·1-5 도달 일차 기록 (turningPointReachedDay = 4층을 넘은 날)', () => {
    const g = fresh();
    g.debugSetStage(CH.turningPoint - 1);
    clearTonight(g);
    expect(g.stats.turningPointReachedDay).toBe(1);
    expect(g.pendingCrossroad).toBe(false);
    g.nextDay();
    expect(g.today.kind).not.toBe('milestone');
    expect(g.growthLog).toHaveLength(0);
  });
});

describe('1-10 보스 → 새벽 뒤 자라기 + 챕터 완성', () => {
  it('정화하면 그 밤은 바로 끝(새벽) → 이야기 한 장 → [다음] = 자라기 → chapterComplete(completed true)', () => {
    const g = fresh();
    g.debugSetStage(CH.length);
    g.grid.cells.fill(null);
    g.grid.cells[0] = g.newPiece(DOG, 4, { legend: 'sunny_picnic' });
    const es = clearTonight(g);
    expect(ofType(es, 'layerClear').map((e) => e.layer)).toEqual([CH.length]);
    expect(g.phase).toBe('diary');
    expect(g.chapterCleared).toBe(true);
    expect(g.abyss.units).toHaveLength(0);
    expect(base.diary.growth).toContain(g.diary[g.diary.length - 1].growthLine);
    g.nextDay();
    const ev = g.tick(0);
    expect(ev.map((e) => e.type).filter((t) => t === 'growth' || t === 'chapterComplete')).toEqual(['growth', 'chapterComplete']);
    expect(g.phase).toBe('chapterComplete');
    expect(g.completed).toBe(true);
    expect(g.growthLog.at(-1)).toMatchObject({ day: 1, happyCount: 1 });
    expect(g.nextDay()).toBe(false);
    expect(g.confirmDay().ok).toBe(false);
  });
});

describe('maxDays 미완성', () => {
  it('maxDays일째 이야기 한 장 뒤 1-10을 못 넘었으면 자라기 → chapterComplete(completed false)', () => {
    const g = fresh();
    g.debugGotoDay(CH.maxDays - 1);
    quietDay(g);
    g.nextDay();
    expect(g.phase).toBe('dayStart');
    quietDay(g);
    expect(g.day).toBe(CH.maxDays);
    expect(base.diary.growth).toContain(g.diary[g.diary.length - 1].growthLine);
    g.nextDay();
    expect(g.phase).toBe('chapterComplete');
    expect(g.completed).toBe(false);
    expect(g.growthLog).toHaveLength(1);
  });

  it('갈림길이 없고 자라기도 없는 평범한 날의 이야기 한 장에는 자라기 문장이 없다', () => {
    const g = fresh();
    quietDay(g);
    expect(g.diary[0].growthLine).toBeUndefined();
  });
});

describe('디버그·저장', () => {
  it('디버그 즉시 챕터 완성 / 미완성: 레인 비움 + 자라기 → chapterComplete', () => {
    for (const done of [true, false]) {
      const g = fresh();
      g.confirmDay();
      g.summon(g.debugGrant(DOG, 1)!, 'happy');
      g.debugCompleteChapter(done);
      expect(g.phase).toBe('chapterComplete');
      expect(g.completed).toBe(done);
      expect(g.defense.units).toHaveLength(0);
      expect(g.growthLog).toHaveLength(1);
    }
  });

  it('챕터 완성 뒤 저장 round-trip (결말 코드 없이), 갈림길 대기 저장 → 복원 뒤 다음 날 갈림길', () => {
    const g = fresh();
    g.debugSetStage(CH.turningPoint);
    clearTonight(g);
    const raw = JSON.stringify(makeSaveData(SIZE, emptyGating(), serializeGame(g), 'x'));
    const r = parseSave(raw, base, SIZE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const back = GameState.fromSave(base, r.save.game!, mulberry32(1), gameGeometry(5), SIZE);
    expect(back.pendingCrossroad).toBe(true);
    back.nextDay();
    g.nextDay();
    expect(back.today.id).toBe(base.chapter.crossroad);
    expect(JSON.stringify(serializeGame(back))).toBe(JSON.stringify(serializeGame(g)));

    g.debugCompleteChapter(true);
    const done = serializeGame(g);
    expect(done).toMatchObject({ phase: 'chapterComplete', completed: true });
    expect('ending' in done).toBe(false);
    const r2 = parseSave(JSON.stringify(makeSaveData(SIZE, emptyGating(), done, 'x')), base, SIZE);
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    const back2 = GameState.fromSave(base, r2.save.game!, mulberry32(1), gameGeometry(5), SIZE);
    expect(JSON.stringify(serializeGame(back2))).toBe(JSON.stringify(done));
  });
});
