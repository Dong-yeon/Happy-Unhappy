// 하루 구조 (스펙 §5.1~5.3, §5.7, §5.11). Phaser 의존 없음.
// 상태 흐름 (v0.8, D-027): dayStart ──(카드 닫기/이정표 선택)──▶ day(낮: 방어) ──(저녁 종료 → 해질녘)──▶ night(밤: 심연)
//                          ──(달이 짐·잠들기 → 새벽)──▶ diary ──([다음 날])──▶ 다음 dayStart   14일째 diary 후 → lifeEnd

import type { DailyEvent, EventEffects, GameData, Milestone, SeasonalEvent } from '../data/types';
import { weightedPick, type Rng } from './rng';

/** 해질녘(dusk)·새벽(dawn)은 단계가 아니라 즉시 처리 (§5.11-1) */
export type DayPhase = 'dayStart' | 'day' | 'night' | 'diary' | 'lifeEnd';

/** 그날 무슨 날인지 (카드 표시·효과·그림일기 문장) */
export type DayEvent =
  | { kind: 'milestone'; id: string; title: string; text: string; event: Milestone }
  | { kind: 'seasonal'; id: string; title: string; text: string; effects: EventEffects; diaryLine: string }
  | { kind: 'daily'; id: string; title: string; text: string; effects: EventEffects; diaryLine: string }
  | { kind: 'plain'; id: 'plain'; title: string; text: string; effects: EventEffects };

/** 그날 기록 (그림일기·metrics). 하루 끝에 초기화, 일생 stats는 따로 누적 */
export interface DayStats {
  sunk: number;
  defeated: number;
  layersCleared: number;
  /** 역류 보스가 등장한 날 1 */
  backflow: 0 | 1;
  /** 보스 결과: 처치 1 / 가라앉음 0 / 보스 없음 null */
  bossWin: 0 | 1 | null;
  sentUp: number;
  sentDown: number;
  joyStart: number;
  joyEnd: number;
  /** ×1 기준 하루 길이(초) = 낮 + 밤에 흐른 게임 시간 */
  realSeconds: number;
  /** 낮(day 단계) 게임 시간(초) */
  daySeconds: number;
  /** 밤(night 단계) 게임 시간(초). 잠들기로 건너뛴 시간은 들어가지 않는다 */
  nightSeconds: number;
  /** 낮에 손거울로 맡긴 수 (§5.11-3) */
  reserved: number;
  // ── M7 metrics (§5.10-1). 관찰만 한다: 게임 규칙은 이 값을 읽지 않는다 ──
  /** 조각 생성 수 */
  spawns: number;
  merges: number;
  releases: number;
  /** 놓아준 조각의 단계별 개수 (길이 maxTier+1, 0 = 와일드카드) */
  releaseTiers: number[];
  /** 귀환 대기열 상한 초과로 소실된 조각 */
  lostReturns: number;
  abyssDeaths: number;
  /** Unhappy 멈춤 시간(초) */
  stallSeconds: number;
  /** 낮·밤에 그리드에 빈칸이 없던 게임 시간(초) */
  gridFullSeconds: number;
  /** 그날 층 돌파 시각 (playTime) */
  layerClearTimes: number[];
  /** 영웅·전설 부상 (낮·밤 합, §5.13-2) */
  injuries: number;
  /** 조합 (§5.13-5, metrics): 시각·조합 id·재료 ("chain:tier", 빛나면 "*") */
  combines: { t: number; recipe: string; inputs: string[] }[];
}

export function emptyDayStats(joy: number, maxTier: number): DayStats {
  return {
    sunk: 0,
    defeated: 0,
    layersCleared: 0,
    backflow: 0,
    bossWin: null,
    sentUp: 0,
    sentDown: 0,
    joyStart: joy,
    joyEnd: joy,
    realSeconds: 0,
    daySeconds: 0,
    nightSeconds: 0,
    reserved: 0,
    spawns: 0,
    merges: 0,
    releases: 0,
    releaseTiers: new Array<number>(maxTier + 1).fill(0),
    lostReturns: 0,
    abyssDeaths: 0,
    stallSeconds: 0,
    gridFullSeconds: 0,
    layerClearTimes: [],
    injuries: 0,
    combines: [],
  };
}

/** 일상 이벤트 사용 기록 (쿨다운) */
export interface DailyUse {
  id: string;
  day: number;
}

function toCard(e: Milestone | SeasonalEvent, kind: 'milestone' | 'seasonal'): DayEvent {
  if (kind === 'milestone') {
    const m = e as Milestone;
    return { kind, id: m.id, title: m.title, text: m.text, event: m };
  }
  const s = e as SeasonalEvent;
  return { kind, id: s.id, title: s.title, text: s.text, effects: s.effects, diaryLine: s.diaryLine };
}

function dailyCard(e: DailyEvent): DayEvent {
  return { kind: 'daily', id: e.id, title: e.title, text: e.diaryLine, effects: e.effects, diaryLine: e.diaryLine };
}

export function plainCard(data: GameData): DayEvent {
  return { kind: 'plain', id: 'plain', title: data.events.plainDay.title, text: '', effects: {} };
}

/** id로 이벤트 찾기 (디버그 강제용). 'plain'은 평범한 하루 */
export function eventById(data: GameData, id: string): DayEvent | null {
  if (id === 'plain') return plainCard(data);
  const m = data.events.milestones.find((e) => e.id === id);
  if (m) return toCard(m, 'milestone');
  const s = data.events.seasonal.find((e) => e.id === id);
  if (s) return toCard(s, 'seasonal');
  const d = data.events.daily.find((e) => e.id === id);
  return d ? dailyCard(d) : null;
}

/** 강제 가능한 모든 이벤트 id (디버그) */
export function allEventIds(data: GameData): string[] {
  const e = data.events;
  return [...e.milestones.map((x) => x.id), ...e.seasonal.map((x) => x.id), ...e.daily.map((x) => x.id), 'plain'];
}

/**
 * 일차 d의 이벤트 (§5.2): days.fixed(이정표·계절) → 조용한 날(d ≤ quietDays, 난수 소비 없음, D-024)이면 평범한 하루
 * → 아니면 dailyEventChance로 일상 이벤트(쿨다운 제외) → 아니면 평범한 하루.
 * 같은 일상 이벤트는 dailyEventCooldownDays일 안에 반복하지 않는다 (d - 마지막 사용일 ≤ 쿨다운이면 제외).
 */
export function resolveDayEvent(data: GameData, day: number, rng: Rng, used: readonly DailyUse[]): DayEvent {
  const fixedId = data.days.fixed[String(day)];
  if (fixedId) {
    const found = eventById(data, fixedId);
    if (found) return found;
  }
  // 조용한 날: 1~2일차는 규칙을 익히는 날 (rng 호출 전에 판정해 난수를 소비하지 않는다)
  if (day <= data.days.quietDays) return plainCard(data);
  if (rng() < data.days.dailyEventChance) {
    const cd = data.days.dailyEventCooldownDays;
    const pool = data.events.daily.filter((e) => !used.some((u) => u.id === e.id && day - u.day <= cd));
    if (pool.length > 0) return dailyCard(weightedPick(rng, pool, () => 1));
  }
  return plainCard(data);
}

/** 그날 이벤트 효과 (이정표는 선택 전이라 없음) */
export function effectsOf(e: DayEvent): EventEffects {
  return e.kind === 'milestone' ? {} : e.effects;
}
