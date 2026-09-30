// 일기장 병합 (스펙 §5.8-1). Phaser 의존 없음 (표시 목록만 만든다).
import type { DiaryEntry } from '../core/diary';
import type { ForgottenEntry } from '../core/gating';

export interface DiaryRow {
  head: string;
  line: string;
  forgotten: boolean;
}

/**
 * GameState.diary + forgottenLog를 일차 순으로 합친다.
 * forgotten 항목은 atDay번째 날 **앞에** "기억나지 않는 날. (N일)" (diary.json의 forgottenDay 문장).
 */
export function mergeDiary(diary: readonly DiaryEntry[], forgotten: readonly ForgottenEntry[], forgottenLine: string): DiaryRow[] {
  const rows: DiaryRow[] = [];
  const queue = [...forgotten].sort((a, b) => a.atDay - b.atDay);
  const flushBefore = (day: number) => {
    while (queue.length && queue[0].atDay <= day) {
      const f = queue.shift()!;
      rows.push({ head: f.date, line: `${forgottenLine} (${f.count}일)`, forgotten: true });
    }
  };
  for (const d of diary) {
    flushBefore(d.day);
    rows.push({ head: `${d.day}일째 · ${d.eventTitle}`, line: d.line, forgotten: false });
  }
  flushBefore(Infinity);
  return rows;
}
