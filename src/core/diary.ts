// 그림일기 (스펙 §5.4, §5.7, §5.11-6). Phaser 의존 없음.
// 문장 = 이벤트 문장 + 낮 결과 문장 + 밤 문장.
//   낮 결과 (첫 번째 일치): 1. 역류가 있었던 날 → backflow  2. 가라앉음 ≥ diarySinkThreshold → manySunk  3. default
//   밤 (첫 번째 일치): 1. 층 돌파 → layerCleared  2. 내려갔지만 돌파 못 함 → tried  3. 아무도 내려가지 않음 → none
// 같은 계열 안에서는 rng, 직전 날과 같은 문장은 피한다.

import type { GameData } from '../data/types';
import type { DayEvent, DayStats } from './day';
import { randInt, type Rng } from './rng';

export type DiaryCategory = 'backflow' | 'manySunk' | 'default';
export type NightCategory = 'layerCleared' | 'tried' | 'none';

export interface DiaryEntry {
  day: number;
  eventTitle: string;
  /** 이벤트 문장 + 낮 결과 문장 + 밤 문장 */
  line: string;
  eventLine: string;
  resultLine: string;
  category: DiaryCategory;
  nightLine: string;
  nightCategory: NightCategory;
}

export function diaryCategory(stats: DayStats, sinkThreshold: number): DiaryCategory {
  if (stats.backflow) return 'backflow';
  if (stats.sunk >= sinkThreshold) return 'manySunk';
  return 'default';
}

/** 밤 문장 계열: 층 돌파 / 누군가 내려갔음(맡기기·밤 소환) / 아무도 내려가지 않음 */
export function nightCategory(stats: DayStats): NightCategory {
  if (stats.layersCleared > 0) return 'layerCleared';
  if (stats.sentDown > 0) return 'tried';
  return 'none';
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
  prev: Pick<DiaryEntry, 'resultLine' | 'nightLine'> | null,
): DiaryEntry {
  const category = diaryCategory(stats, data.balance.diary.diarySinkThreshold);
  const eventLine = eventLineOf(data, e, rng);
  const resultLine = pickAvoiding(rng, data.diary.result[category], prev?.resultLine ?? null);
  const nCat = nightCategory(stats);
  const nightLine = pickAvoiding(rng, data.diary.night[nCat], prev?.nightLine ?? null);
  return {
    day,
    eventTitle: e.title,
    line: `${eventLine} ${resultLine} ${nightLine}`,
    eventLine,
    resultLine,
    category,
    nightLine,
    nightCategory: nCat,
  };
}
