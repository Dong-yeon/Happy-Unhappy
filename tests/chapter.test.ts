// 챕터 진행 (스펙 §5.15-1·7, §5.17-10, D-039·D-046):
// 1-5 정화(낮) → 그날 밤 디펜스 뒤 다음 dayStart 갈림길 / 1-10 정화(낮) → 그날 밤 없이 챕터 완성 / maxDays 미완성. 자라기 없음 (§5.17-5)
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
const SIZE = { cols: 5, rows: 4 };
const GEO = gameGeometry(base.balance.merge.soldierCap + 1);

function fresh(): GameState {
  return new GameState(structuredClone(base), SIZE, mulberry32(1), GEO, 1);
}

const ofType = <T extends CoreEvent['type']>(es: CoreEvent[], t: T) =>
  es.filter((e): e is Extract<CoreEvent, { type: T }> => e.type === t);

/** dayStart → 낮(오펜스) 시작 → 지금 층을 정화 (층 HP 0) → 다음 틱. 1-length가 아니면 낮을 이어간다 */
function clearToday(g: GameState): CoreEvent[] {
  if (g.phase === 'dayStart') g.confirmDay(g.today.kind === 'milestone' ? 'happy' : undefined);
  g.debugBreakLayer();
  const out = g.tick(0);
  out.push(...g.tick(FIXED_DT));
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
    g.debugSetStage(4);
    clearToday(g);
    expect(g.abyss.wall.layer).toBe(5);
    expect(g.abyss.wall.maxHp - g.abyss.wall.extraHp).toBeCloseTo(layerBaseHp(w, 5) * CH.turningPointHpMult, 6);
  });
});

describe('1-5 전환점 → 그날 밤 뒤 다음 dayStart 갈림길 (자라기 없음)', () => {
  it('낮에 정화: 갈림길 대기, 낮은 이어지고 밤도 온다 → 다음 날 카드 = 갈림길', () => {
    const g = fresh();
    g.debugSetStage(CH.turningPoint);
    clearToday(g);
    expect(g.phase).toBe('day'); // 그 낮은 계속
    expect(g.pendingCrossroad).toBe(true);
    expect(g.stats.turningPointClearedDay).toBe(1);
    g.debugToNight();
    expect(g.phase).toBe('night'); // 밤 디펜스도 온다
    g.debugEndNight();
    g.tick(0);
    g.nextDay();
    const es = g.tick(0);
    expect(ofType(es, 'dayStart')).toHaveLength(1);
    expect(g.pendingCrossroad).toBe(false);
    expect(g.today).toMatchObject({ kind: 'milestone', id: base.chapter.crossroad, title: '문틈의 목소리' });
    expect(g.confirmDay()).toEqual({ ok: false, reason: 'needChoice' });
    expect(g.confirmDay('unhappy').ok).toBe(true);
    expect(g.flags).toEqual(['face']);
  });

  it('1-5 도달 일차 기록 (turningPointReachedDay = 4층을 넘은 날)', () => {
    const g = fresh();
    g.debugSetStage(CH.turningPoint - 1);
    clearToday(g);
    expect(g.stats.turningPointReachedDay).toBe(1);
    expect(g.pendingCrossroad).toBe(false);
    g.debugEndDay();
    g.nextDay();
    expect(g.today.kind).not.toBe('milestone');
  });
});

describe('1-10 보스 → 그날 밤 없이 챕터 완성 (§5.17-10)', () => {
  it('정화한 틱에 낮이 끝나고 이야기 한 장(밤 문장 없음)을 쓴 뒤 바로 chapterComplete(true)', () => {
    const g = fresh();
    g.debugSetStage(CH.length);
    const es = clearToday(g);
    expect(ofType(es, 'layerClear').map((e) => e.layer)).toEqual([CH.length]);
    expect(es.map((e) => e.type).filter((t) => t === 'dusk')).toEqual([]); // 밤 없음
    expect(es.map((e) => e.type).filter((t) => t === 'dayEnd' || t === 'chapterComplete')).toEqual(['dayEnd', 'chapterComplete']);
    expect(g.phase).toBe('chapterComplete');
    expect(g.completed).toBe(true);
    expect(g.diary.at(-1)!.resultLine).toBe('');
    expect(g.abyss.units).toHaveLength(0);
    expect(g.nextDay()).toBe(false);
    expect(g.confirmDay().ok).toBe(false);
  });
});

describe('maxDays 미완성', () => {
  it('maxDays일째 이야기 한 장 뒤 1-10을 못 넘었으면 chapterComplete(completed false)', () => {
    const g = fresh();
    g.debugGotoDay(CH.maxDays - 1);
    quietDay(g);
    g.nextDay();
    expect(g.phase).toBe('dayStart');
    quietDay(g);
    expect(g.day).toBe(CH.maxDays);
    g.nextDay();
    expect(g.phase).toBe('chapterComplete');
    expect(g.completed).toBe(false);
  });
});

describe('디버그·저장', () => {
  it('디버그 즉시 챕터 완성 / 미완성: 레인 비움 → chapterComplete', () => {
    for (const done of [true, false]) {
      const g = fresh();
      g.confirmDay();
      g.debugCompleteChapter(done);
      expect(g.phase).toBe('chapterComplete');
      expect(g.completed).toBe(done);
      expect(g.abyss.units).toHaveLength(0);
    }
  });

  it('갈림길 대기 저장 → 복원 뒤 다음 날 갈림길, 챕터 완성 뒤 저장 round-trip', () => {
    const g = fresh();
    g.debugSetStage(CH.turningPoint);
    clearToday(g);
    g.debugEndDay();
    g.tick(0);
    const raw = JSON.stringify(makeSaveData(SIZE, emptyGating(), serializeGame(g), 'x'));
    const r = parseSave(raw, base, SIZE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const back = GameState.fromSave(base, r.save.game!, mulberry32(1), GEO, SIZE);
    expect(back.pendingCrossroad).toBe(true);
    back.nextDay();
    g.nextDay();
    expect(back.today.id).toBe(base.chapter.crossroad);
    expect(JSON.stringify(serializeGame(back))).toBe(JSON.stringify(serializeGame(g)));

    g.debugCompleteChapter(true);
    const done = serializeGame(g);
    expect(done).toMatchObject({ phase: 'chapterComplete', completed: true });
    const r2 = parseSave(JSON.stringify(makeSaveData(SIZE, emptyGating(), done, 'x')), base, SIZE);
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    const back2 = GameState.fromSave(base, r2.save.game!, mulberry32(1), GEO, SIZE);
    expect(JSON.stringify(serializeGame(back2))).toBe(JSON.stringify(done));
  });
});
