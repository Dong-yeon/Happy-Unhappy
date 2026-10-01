// C안 gating (스펙 §5.5, §5.8-1, §5.8-5)
import { describe, expect, it } from 'vitest';
import type { DiaryEntry } from '../src/core/diary';
import { addDays, consume, daysBetween, emptyGating, gatingForNewLife, grant, isValidDate, type GatingState } from '../src/core/gating';
import { mergeDiary } from '../src/scenes/diaryList';

const CFG = { dailyLimit: 2, storeCap: 4 };

function first(today = '2026-10-01'): GatingState {
  return grant(emptyGating(), today, 1, CFG).next;
}

describe('daysBetween', () => {
  it('월말·윤년 경계: 2028-02-28 → 2028-03-01 = 2일, 평년 2027-02-28 → 2027-03-01 = 1일', () => {
    expect(daysBetween('2028-02-28', '2028-03-01')).toBe(2);
    expect(daysBetween('2027-02-28', '2027-03-01')).toBe(1);
    expect(daysBetween('2026-12-31', '2027-01-01')).toBe(1);
    expect(daysBetween('2026-10-01', '2026-09-30')).toBe(-1);
    expect(daysBetween('2026-10-01', '2027-10-01')).toBe(365);
  });

  it('DST가 있는 날짜 구간도 정수 (UTC 기준)', () => {
    expect(daysBetween('2026-03-07', '2026-03-09')).toBe(2);
    expect(daysBetween('2026-10-31', '2026-11-02')).toBe(2);
  });

  it('잘못된 날짜 문자열은 예외 (형식·존재하지 않는 날짜)', () => {
    for (const bad of ['2026-02-30', '2026-13-01', '2026-1-01', '26-01-01', '2026/01/01', '', '2026-00-10', '2027-02-29']) {
      expect(() => daysBetween(bad, '2026-01-01'), bad).toThrow();
      expect(isValidDate(bad), bad).toBe(false);
    }
    expect(isValidDate('2028-02-29')).toBe(true);
    expect(() => grant(emptyGating(), '2026-02-30', 1, CFG)).toThrow();
  });

  it('addDays: 월·연·윤년 경계', () => {
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2028-02-28', 2)).toBe('2028-03-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(addDays('2026-10-01', 365)).toBe('2027-10-01');
    expect(daysBetween('2026-10-01', addDays('2026-10-01', -400))).toBe(-400);
  });
});

describe('grant (지급 규칙 표)', () => {
  it('첫 실행: openable = min(dailyLimit, storeCap), last = today, forgotten 없음', () => {
    const r = grant(emptyGating(), '2026-10-01', 1, CFG);
    expect(r.next).toEqual({ openableDays: 2, lastGrantDate: '2026-10-01', forgottenDays: 0, forgottenLog: [] });
    expect(r).toMatchObject({ granted: 2, forgotten: 0 });
    expect(grant(emptyGating(), '2026-10-01', 1, { dailyLimit: 5, storeCap: 3 }).next.openableDays).toBe(3);
  });

  it('같은 날 재실행: 변화 없음', () => {
    const g = first();
    const r = grant(g, '2026-10-01', 1, CFG);
    expect(r.next).toEqual(g);
    expect(r).toMatchObject({ granted: 0, forgotten: 0 });
  });

  it('다음 날: +dailyLimit (storeCap까지)', () => {
    const g = consume(consume(first(), false), false); // 0
    const r = grant(g, '2026-10-02', 3, CFG);
    expect(r.next).toEqual({ openableDays: 2, lastGrantDate: '2026-10-02', forgottenDays: 0, forgottenLog: [] });
    expect(r.granted).toBe(2);
  });

  it('3일 뒤: raw = openable + 3 × dailyLimit → storeCap으로 자름, 버려진 수 기록 (항목 1개)', () => {
    const g = consume(first(), false); // 1
    const r = grant(g, '2026-10-04', 2, CFG);
    // raw = 1 + 6 = 7 → 4, forgotten 3
    expect(r.next).toEqual({
      openableDays: 4,
      lastGrantDate: '2026-10-04',
      forgottenDays: 3,
      forgottenLog: [{ date: '2026-10-04', count: 3, atDay: 2 }],
    });
    expect(r).toMatchObject({ granted: 3, forgotten: 3 });
  });

  it('1년 뒤: 항목은 지급 1회당 1개, forgottenDays는 누적', () => {
    const g = grant(first(), '2026-10-04', 1, CFG).next; // 2 + 6 = 8 → 4, forgotten 4
    expect(g.forgottenDays).toBe(4);
    const r = grant(g, '2027-10-04', 5, CFG);
    expect(r.next.openableDays).toBe(4);
    expect(r.forgotten).toBe(365 * 2); // 4 + 730 → 4
    expect(r.next.forgottenDays).toBe(4 + 365 * 2);
    expect(r.next.forgottenLog).toHaveLength(2);
    expect(r.next.forgottenLog[1]).toEqual({ date: '2027-10-04', count: 730, atDay: 5 });
  });

  it('날짜 되돌림 → 지급 없음, last 유지 / 다시 원래 날짜로 와도 이중 지급 없음', () => {
    const g = consume(first('2026-10-05'), false); // 1, last 10-05
    const back = grant(g, '2026-10-02', 1, CFG);
    expect(back.next).toEqual(g);
    expect(back.granted).toBe(0);
    const again = grant(back.next, '2026-10-05', 1, CFG);
    expect(again.next).toEqual(g);
    expect(again.granted).toBe(0);
    // 그다음 날에야 지급
    expect(grant(again.next, '2026-10-06', 1, CFG).next.openableDays).toBe(3);
  });

  it('입력 상태를 바꾸지 않는다 (순수 함수)', () => {
    const g = grant(first(), '2026-10-09', 1, CFG).next;
    const snap = structuredClone(g);
    grant(g, '2026-10-19', 1, CFG);
    consume(g, false);
    gatingForNewLife(g);
    expect(g).toEqual(snap);
  });
});

describe('consume', () => {
  it('openable − 1', () => {
    expect(consume(first(), false).openableDays).toBe(1);
  });

  it('0에서 호출하면 예외, bypass면 0 유지', () => {
    const zero = consume(consume(first(), false), false);
    expect(zero.openableDays).toBe(0);
    expect(() => consume(zero, false)).toThrow();
    expect(consume(zero, true).openableDays).toBe(0);
  });
});

describe('새 일생', () => {
  it('openable·lastGrantDate·forgottenDays 유지, forgottenLog 비움', () => {
    const g = grant(first(), '2026-10-09', 3, CFG).next;
    expect(g.forgottenLog.length).toBe(1);
    expect(gatingForNewLife(g)).toEqual({ ...g, forgottenLog: [] });
  });
});

describe('일기장 병합', () => {
  const entry = (day: number): DiaryEntry => ({
    day,
    eventTitle: `이벤트${day}`,
    line: `문장${day}`,
    eventLine: 'e',
    resultLine: 'r',
    category: 'default',
    nightLine: 'n',
    nightCategory: 'none',
  });

  it('forgotten 항목은 atDay번째 날 앞에 "기억나지 않는 날. (N일)"', () => {
    const rows = mergeDiary(
      [entry(1), entry(2), entry(3)],
      [
        { date: '2026-10-20', count: 1, atDay: 4 },
        { date: '2026-10-09', count: 2, atDay: 3 },
      ],
      '기억나지 않는 날.',
    );
    expect(rows.map((r) => r.line)).toEqual(['문장1', '문장2', '기억나지 않는 날. (2일)', '문장3', '기억나지 않는 날. (1일)']);
    expect(rows[2]).toMatchObject({ forgotten: true, head: '2026-10-09' });
  });
});
