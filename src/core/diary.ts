// 이야기 한 장 (스펙 §5.4, §5.7, §5.11-6, §5.17-10). Phaser 의존 없음.
// 문장 = 이벤트 문장 + 낮(오펜스) 문장 + 밤(디펜스) 결과 문장 (하루 순서대로, §5.17-10).
//   밤 결과 (첫 번째 일치): 1. 역류가 있었던 날 → backflow  2. 가라앉음 ≥ diarySinkThreshold → manySunk  3. default
//   낮 (첫 번째 일치): 1. 층 돌파 → layerCleared  2. 영웅이 쓰러짐 → none  3. 내려갔지만 돌파 못 함 → tried
//   1-10 정화한 날은 밤이 없으므로 밤 결과 문장도 없다.
// 같은 계열 안에서는 rng, 직전 날과 같은 문장은 피한다. 데이터 키 이름(result/night)은 v0.8 그대로.

import type { GameData } from '../data/types';
import type { DayEvent, DayStats } from './day';
import { randInt, type Rng } from './rng';

export type DiaryCategory = 'backflow' | 'manySunk' | 'default';
export type NightCategory = 'layerCleared' | 'tried' | 'none';

export interface DiaryEntry {
  day: number;
  eventTitle: string;
  /** 이벤트 문장 + 낮(오펜스) 문장 + 밤(디펜스) 결과 문장 */
  line: string;
  eventLine: string;
  /** 밤(디펜스) 결과 문장. 밤이 없던 날(1-10 정화)은 '' */
  resultLine: string;
  category: DiaryCategory;
  /** 낮(오펜스) 문장 */
  nightLine: string;
  nightCategory: NightCategory;
}

export function diaryCategory(stats: DayStats, sinkThreshold: number): DiaryCategory {
  if (stats.backflow) return 'backflow';
  if (stats.sunk >= sinkThreshold) return 'manySunk';
  return 'default';
}

/** 낮(오펜스) 문장 계열: 층 돌파 / 영웅이 쓰러짐 / 그 밖 */
export function nightCategory(stats: DayStats): NightCategory {
  if (stats.layersCleared > 0) return 'layerCleared';
  if (stats.offenseFell) return 'none';
  return 'tried';
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
  hadNight = true,
): DiaryEntry {
  const category = diaryCategory(stats, data.balance.diary.diarySinkThreshold);
  const eventLine = eventLineOf(data, e, rng);
  const nCat = nightCategory(stats);
  const nightLine = pickAvoiding(rng, data.diary.night[nCat], prev?.nightLine ?? null);
  const resultLine = hadNight ? pickAvoiding(rng, data.diary.result[category], prev?.resultLine ?? null) : '';
  return {
    day,
    eventTitle: e.title,
    line: [eventLine, nightLine, resultLine].filter((l) => l !== '').join(' '),
    eventLine,
    resultLine,
    category,
    nightLine,
    nightCategory: nCat,
  };
}
