// 그림일기 (스펙 §5.4, §5.7). Phaser 의존 없음.
// 문장 = 이벤트 문장 + 결과 문장. 결과 문장 계열 (우선순위 순, 첫 번째 일치):
//   1. 역류가 있었던 날 → backflow  2. 층을 돌파한 날 → layerCleared  3. 가라앉음 ≥ diarySinkThreshold → manySunk  4. default
// 같은 계열 안에서는 rng, 직전 날과 같은 결과 문장은 피한다.

import type { GameData } from '../data/types';
import type { DayEvent, DayStats } from './day';
import { randInt, type Rng } from './rng';

export type DiaryCategory = 'backflow' | 'layerCleared' | 'manySunk' | 'default';

export interface DiaryEntry {
  day: number;
  eventTitle: string;
  /** 이벤트 문장 + 결과 문장 */
  line: string;
  eventLine: string;
  resultLine: string;
  category: DiaryCategory;
}

export function diaryCategory(stats: DayStats, sinkThreshold: number): DiaryCategory {
  if (stats.backflow) return 'backflow';
  if (stats.layersCleared > 0) return 'layerCleared';
  if (stats.sunk >= sinkThreshold) return 'manySunk';
  return 'default';
}

/** 후보 중 rng로 하나. avoid와 같은 문장은 다른 후보가 있으면 피한다 */
export function pickAvoiding(rng: Rng, lines: readonly string[], avoid: string | null): string {
  const pool = lines.length > 1 && avoid !== null ? lines.filter((l) => l !== avoid) : lines;
  const list = pool.length > 0 ? pool : lines;
  return list[randInt(rng, list.length)];
}

export function eventLineOf(data: GameData, e: DayEvent, rng: Rng): string {
  if (e.kind === 'plain') return data.events.plainDay.diaryLines[randInt(rng, data.events.plainDay.diaryLines.length)];
  if (e.kind === 'milestone') return e.event.diaryLine;
  return e.diaryLine;
}

export function writeDiary(
  data: GameData,
  day: number,
  e: DayEvent,
  stats: DayStats,
  rng: Rng,
  prevResultLine: string | null,
): DiaryEntry {
  const category = diaryCategory(stats, data.balance.diary.diarySinkThreshold);
  const eventLine = eventLineOf(data, e, rng);
  const resultLine = pickAvoiding(rng, data.diary.result[category], prevResultLine);
  return { day, eventTitle: e.title, line: `${eventLine} ${resultLine}`, eventLine, resultLine, category };
}
