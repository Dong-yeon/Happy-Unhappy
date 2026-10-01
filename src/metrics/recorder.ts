// metrics 수집·저장 (스펙 §5.10-2·3). 씬 층에서 쓴다: core 상태는 읽기만 하고, 입력·실제 시간은 씬이 넘겨준다.
// 저장 키 hau_metrics_v2는 게임 저장(hau_save_v2)과 분리. 새 일생·저장 초기화에도 지워지지 않는다.
// localStorage 예외는 무시하고 게임을 계속한다 (platform/storage가 console.warn).

import type { GameState } from '../core/game';
import type { GridSize } from '../core/grid';
import { nowIso, realToday, today } from '../platform/clock';
import { METRICS_KEY, readKey, removeKey, writeKey } from '../platform/storage';
import {
  detectMidDayRestore,
  emptyDropFails,
  emptyMetrics,
  enforceLimits,
  newLife,
  parseMetrics,
  type DayMetrics,
  type DayRating,
  type DropFails,
  type LifeMetrics,
  type MetricsData,
  type SessionRecord,
} from './model';

/** 앱 실행 하나 = 세션 하나. 씬 재시작([처음부터]·디버그)에도 같은 세션을 이어 쓴다 */
let sessionStartedAt: string | null = null;

export type DropFailKind = keyof DropFails;

export class MetricsRecorder {
  data: MetricsData;
  life!: LifeMetrics;
  private session!: SessionRecord;
  // 그날 입력 카운터 (메모리에만. 판 도중 종료하면 버려진다)
  private active = false;
  private dropFails = emptyDropFails();
  private dragDistance = 0;
  private realSeconds = 0;
  private speedUsed = 0;
  private bypass = false;

  constructor(
    private readonly state: GameState,
    private readonly gridSize: GridSize,
  ) {
    const r = parseMetrics(readKey(METRICS_KEY));
    if (!r.ok && r.reason !== '없음') {
      console.warn(`[metrics] 초기화 — ${r.reason}`);
      removeKey(METRICS_KEY);
    }
    this.data = r.ok ? r.data : emptyMetrics(nowIso());
    this.attach();
    if (detectMidDayRestore(this.data, this.life, state.day, state.phase)) {
      console.info(`[metrics] 판 도중 복원 감지 (${state.day}일째) → midDayRestores ${this.life.midDayRestores}`);
    }
    this.write();
  }

  /** 현재 일생·세션을 찾거나 만든다 */
  private attach(): void {
    const s = this.state;
    const same = (l: LifeMetrics) => l.seed === s.seed && l.gridSize.cols === this.gridSize.cols && l.gridSize.rows === this.gridSize.rows;
    const found = [...this.data.lives].reverse().find((l) => same(l) && (l.endedAt === null || s.phase === 'lifeEnd'));
    if (found) this.life = found;
    else {
      this.life = newLife(s.seed, this.gridSize, nowIso());
      this.data.lives.push(this.life);
    }
    sessionStartedAt ??= nowIso();
    const sess = this.data.sessions.find((x) => x.startedAt === sessionStartedAt);
    if (sess) this.session = sess;
    else {
      this.session = { date: today(), realDate: realToday(), startedAt: sessionStartedAt, foregroundSeconds: 0, daysCompleted: 0 };
      this.data.sessions.push(this.session);
    }
  }

  /** 매 프레임: dt = 실제 경과(초, 백그라운드 동안은 프레임이 멈춘다), speed = 디버그 배속 */
  frame(dt: number, speed: number): void {
    this.session.foregroundSeconds += dt;
    if (!this.active || this.state.phase !== 'waves') return;
    this.realSeconds += dt;
    if (speed !== 1) this.speedUsed += dt;
  }

  /** 드래그를 놓았을 때 (실패 사유는 없으면 null) */
  drop(fail: DropFailKind | null, distance: number): void {
    if (!this.active) return;
    this.dragDistance += distance;
    if (fail) this.dropFails[fail] += 1;
  }

  /** confirmDay (dayBegin 이벤트): 카운터 초기화 + inProgress 기록 */
  beginDay(bypass: boolean): void {
    const s = this.state;
    this.active = true;
    this.dropFails = emptyDropFails();
    this.dragDistance = 0;
    this.realSeconds = 0;
    this.speedUsed = 0;
    this.bypass = bypass;
    if (bypass) this.life.gatingBypassUsed = true;
    if (s.today.kind === 'milestone') {
      // 선택지의 flag는 서로 다르므로 마지막 flag로 고른 선택지를 찾는다
      const flag = s.flags[s.flags.length - 1];
      const choice = s.today.event.choices.find((c) => c.flag === flag);
      if (choice) this.life.milestoneChoices.push({ day: s.day, eventId: s.today.id, choiceId: choice.id });
    }
    this.data.inProgress = { lifeId: this.life.lifeId, day: s.day };
    this.write();
  }

  /** 하루 끝 (diary 진입): 그날 DayMetrics 확정 */
  endDay(): void {
    const s = this.state;
    const st = s.lastDayStats;
    if (!st) return;
    const m: DayMetrics = {
      day: s.day,
      date: today(),
      realDate: realToday(),
      eventId: s.today.id,
      dayStats: structuredClone(st),
      summons: s.summonLog.filter((r) => r.day === s.day).map((r) => ({ ...r, cell: { ...r.cell } })),
      dropFails: { ...this.dropFails },
      dragDistance: this.dragDistance,
      realSeconds: this.realSeconds,
      speedUsed: this.speedUsed,
      bypass: this.bypass,
      rating: null,
    };
    // 디버그 일차 이동으로 같은 날을 다시 끝내면 덮어쓴다
    const i = this.life.days.findIndex((d) => d.day === m.day);
    if (i >= 0) this.life.days[i] = m;
    else this.life.days.push(m);
    this.data.inProgress = null;
    this.session.daysCompleted += 1;
    this.active = false;
    this.write();
  }

  /** lifeEnd 진입: 결말·일생 stats */
  lifeEnd(): void {
    const s = this.state;
    this.life.ending = s.ending ? structuredClone(s.ending) : null;
    this.life.stats = structuredClone(s.stats);
    this.life.endedAt = nowIso();
    this.data.inProgress = null;
    this.write();
  }

  rating(day: number): DayRating | null {
    return this.life.days.find((d) => d.day === day)?.rating ?? null;
  }

  rate<K extends keyof DayRating>(day: number, key: K, value: DayRating[K]): void {
    const d = this.life.days.find((x) => x.day === day);
    if (!d) return;
    d.rating = { ...(d.rating ?? { day: null, backflow: null }), [key]: value };
    this.write();
  }

  get endingAgree(): boolean | null {
    return this.life.endingAgree;
  }

  setEndingAgree(v: boolean): void {
    this.life.endingAgree = v;
    this.write();
  }

  /** visibilitychange hidden: 세션 시간 */
  onHidden(): void {
    this.write();
  }

  /** 디버그 "metrics 초기화" */
  reset(): void {
    this.data = emptyMetrics(nowIso());
    this.attach();
    this.write();
  }

  json(): string {
    return JSON.stringify(this.data, null, 2);
  }

  private write(): void {
    for (const w of enforceLimits(this.data)) console.warn(`[metrics] ${w}`);
    writeKey(METRICS_KEY, JSON.stringify(this.data));
  }
}
