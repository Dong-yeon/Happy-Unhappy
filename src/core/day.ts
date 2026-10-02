// 스테이지 구조 (스펙 §5.19-1, D-053·D-054). Phaser 의존 없음.
// 상태 흐름: dayStart(장면 카드) ──(카드 닫기/갈림길 선택)──▶ day(낮: 핵 찾아 돌아오기) ──(이야기책 도착 → 해질녘)──▶ night(밤: 핵 지키기)
//            ──(마지막 웨이브 끝, 핵 HP > 0 → 새벽)──▶ diary(이야기 한 장) ──([다음 이야기])──▶ 다음 스테이지 dayStart
//   낮 실패(시간 초과·가는 길 쓰러짐) → 밤 없이 같은 스테이지 dayStart / 밤 실패(핵 HP 0) → 같은 스테이지 dayStart (낮부터)
//   1-length 낮 성공 → 밤 없이 chapterComplete. 일차·maxDays 없음 (D-054)
//   이벤트(events.json)는 M8.10에서 끔 (데이터·갈림길 카드만 씀)

import type { GameData, Milestone } from '../data/types';

/** 해질녘(dusk)·새벽(dawn)은 단계가 아니라 즉시 처리 (§5.11-1) */
export type DayPhase = 'dayStart' | 'day' | 'night' | 'diary' | 'chapterComplete';

/** 시도 결과: 낮 시간 초과(가는 길) / 가는 길 쓰러짐 / 돌아오는 길 시간 초과 / 밤 핵 HP 0 / 성공 */
export type AttemptResult = 'dayTime' | 'dayFall' | 'returnTime' | 'night' | 'success';
export const ATTEMPT_RESULTS: readonly AttemptResult[] = ['dayTime', 'dayFall', 'returnTime', 'night', 'success'];
/** 실패 사유 (다음 dayStart 카드의 재도전 문구) */
export type FailReason = Exclude<AttemptResult, 'success'>;

/** 갈림길 카드 (1-turningPoint 성공 다음 dayStart, §5.15) */
export interface CrossroadCard {
  id: string;
  title: string;
  text: string;
  event: Milestone;
}

/** 시도 하나(장면 카드 → 낮 → 밤)의 기록 (이야기 한 장·metrics·시뮬). 시도가 끝나면 attemptLog로, 판 stats는 따로 누적 */
export interface AttemptStats {
  stage: number;
  /** 판 통산 시도 번호 (1부터) */
  attempt: number;
  result: AttemptResult | null;
  /** 낮: guardian을 쓰러뜨렸는지 · 핵을 든 시간 · 떨어뜨림 · 적이 되가져감 · 운반 중 쓰러짐 */
  guardianDown: 0 | 1;
  carrySeconds: number;
  drops: number;
  coreReturns: number;
  carryFalls: number;
  /** 밤: 핵 HP (밤이 없으면 null), 가라앉음 수, 밤 영웅 쓰러짐 */
  coreHpEnd: number | null;
  sunk: number;
  defenseFalls: number;
  /** 낮·밤 처치 수 */
  defeated: number;
  joyStart: number;
  joyEnd: number;
  /** ×1 기준 시도 길이(초) = 낮 + 밤 게임 시간 */
  realSeconds: number;
  offenseSeconds: number;
  defenseSeconds: number;
  // ── metrics (관찰만, 규칙은 읽지 않는다) ──
  spawns: number;
  merges: number;
  battleMerges: number;
  feeds: number;
  feedPoints: number;
  soldiers: number;
  soldiersCapped: number;
  releases: number;
  /** 놓아준 조각의 단계별 개수 (길이 maxTier+1, 0 = 와일드카드) */
  releaseTiers: number[];
  /** 지급할 칸이 없어 사라진 조각 */
  lostReturns: number;
  /** 그리드에 빈칸이 없던 게임 시간(초) */
  gridFullSeconds: number;
}

export function emptyAttemptStats(stage: number, attempt: number, joy: number, maxTier: number): AttemptStats {
  return {
    stage,
    attempt,
    result: null,
    guardianDown: 0,
    carrySeconds: 0,
    drops: 0,
    coreReturns: 0,
    carryFalls: 0,
    coreHpEnd: null,
    sunk: 0,
    defenseFalls: 0,
    defeated: 0,
    joyStart: joy,
    joyEnd: joy,
    realSeconds: 0,
    offenseSeconds: 0,
    defenseSeconds: 0,
    spawns: 0,
    merges: 0,
    battleMerges: 0,
    feeds: 0,
    feedPoints: 0,
    soldiers: 0,
    soldiersCapped: 0,
    releases: 0,
    releaseTiers: new Array<number>(maxTier + 1).fill(0),
    lostReturns: 0,
    gridFullSeconds: 0,
  };
}

/** 갈림길 카드 (events.milestones의 id) */
export function crossroadById(data: GameData, id: string): CrossroadCard | null {
  const m = data.events.milestones.find((e) => e.id === id);
  return m ? { id: m.id, title: m.title, text: m.text, event: m } : null;
}
