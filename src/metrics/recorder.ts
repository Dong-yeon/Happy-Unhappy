// metrics 수집·저장 (스펙 §5.10-2·3). 씬 층에서 쓴다: core 상태는 읽기만 하고, 입력·실제 시간은 씬이 넘겨준다.
// 저장 키 hau_metrics_v4는 게임 저장(hau_save_v4)과 분리. 새 판·저장 초기화에도 지워지지 않는다.
// localStorage 예외는 무시하고 게임을 계속한다 (platform/storage가 console.warn).

import type { AttemptStats } from '../core/day';
import type { GameState } from '../core/game';
import type { GridSize } from '../core/grid';
import { nowIso, realToday } from '../platform/clock';
import { METRICS_KEY, readKey, removeKey, writeKey } from '../platform/storage';
import {
  detectMidAttemptRestore,
  emptyDropFails,
  emptyPlay,
  emptyUi,
  PLAY_KEYS,
  emptyMetrics,
  enforceLimits,
  newLife,
  parseMetrics,
  type AttemptMetrics,
  type AttemptPlay,
  type SessionUi,
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
  // 이번 시도 입력 카운터 (메모리에만. 시도 도중 종료하면 버려진다)
  private active = false;
  private dropFails = emptyDropFails();
  private dragDistance = 0;
  private dayRealSeconds = 0;
  private nightRealSeconds = 0;
  private speedUsed = 0;
  /** 시도 시작 때 core 런타임 카운터 (끝에서 차이 = 이 시도 몫) */
  private playStart: AttemptPlay = emptyPlay();

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
    if (detectMidAttemptRestore(this.data, this.life, state.attempt, state.phase)) {
      console.info(`[metrics] 시도 도중 복원 감지 (1-${state.stage}) → midAttemptRestores ${this.life.midAttemptRestores}`);
    }
    this.write();
  }

  /** 현재 판·세션을 찾거나 만든다 */
  private attach(): void {
    const s = this.state;
    const same = (l: LifeMetrics) => l.seed === s.seed && l.gridSize.cols === this.gridSize.cols && l.gridSize.rows === this.gridSize.rows;
    const found = [...this.data.lives].reverse().find((l) => same(l) && (l.endedAt === null || s.phase === 'chapterComplete'));
    if (found) this.life = found;
    else {
      this.life = newLife(s.seed, this.gridSize, nowIso());
      this.data.lives.push(this.life);
    }
    sessionStartedAt ??= nowIso();
    const sess = this.data.sessions.find((x) => x.startedAt === sessionStartedAt);
    if (sess) this.session = sess;
    else {
      this.session = { realDate: realToday(), startedAt: sessionStartedAt, foregroundSeconds: 0, attemptsCompleted: 0, ui: emptyUi() };
      this.data.sessions.push(this.session);
    }
  }

  /** 매 프레임: dt = 실제 경과(초, 백그라운드 동안은 프레임이 멈춘다), speed = 디버그 배속 */
  frame(dt: number, speed: number): void {
    this.session.foregroundSeconds += dt;
    if (!this.active || !this.state.timeFlows) return;
    if (this.state.phase === 'day') this.dayRealSeconds += dt;
    else this.nightRealSeconds += dt;
    if (speed !== 1) this.speedUsed += dt;
  }

  /** 드래그를 놓았을 때 (실패 사유는 없으면 null) */
  drop(fail: DropFailKind | null, distance: number): void {
    if (!this.active) return;
    this.dragDistance += distance;
    if (fail) this.dropFails[fail] += 1;
  }

  /** 장면 카드를 닫음 (dayBegin 이벤트): 카운터 초기화 + inProgress 기록 */
  beginAttempt(): void {
    const s = this.state;
    this.active = true;
    this.dropFails = emptyDropFails();
    this.dragDistance = 0;
    this.dayRealSeconds = 0;
    this.nightRealSeconds = 0;
    this.speedUsed = 0;
    this.playStart = this.playNow();
    this.data.inProgress = { lifeId: this.life.lifeId, attempt: s.attempt };
    this.write();
  }

  /** 시도 끝 (실패·성공): AttemptMetrics 확정 */
  endAttempt(record: AttemptStats): void {
    const s = this.state;
    const m: AttemptMetrics = {
      attempt: record.attempt,
      stage: record.stage,
      result: record.result,
      realDate: realToday(),
      record: structuredClone(record),
      formation: structuredClone(s.formation),
      dropFails: { ...this.dropFails },
      dragDistance: this.dragDistance,
      realSeconds: this.dayRealSeconds + this.nightRealSeconds,
      dayRealSeconds: this.dayRealSeconds,
      nightRealSeconds: this.nightRealSeconds,
      speedUsed: this.speedUsed,
      rating: null,
      play: this.playDelta(),
    };
    const i = this.life.attempts.findIndex((d) => d.attempt === m.attempt);
    if (i >= 0) this.life.attempts[i] = m;
    else this.life.attempts.push(m);
    this.data.inProgress = null;
    this.session.attemptsCompleted += 1;
    this.active = false;
    this.write();
  }

  /** chapterComplete 진입: 판 기록 */
  chapterEnd(): void {
    const s = this.state;
    this.life.chapter = { completed: true, attempts: s.attempt, stage: s.stage };
    this.life.stats = structuredClone(s.stats);
    this.life.endedAt = nowIso();
    this.data.inProgress = null;
    this.write();
  }

  /** core 런타임 카운터 지금 값 */
  private playNow(): AttemptPlay {
    const s = this.state;
    return {
      chains: s.chains,
      chainSteps: s.chainSteps,
      autoMerges: s.autoMerges,
      handovers: s.handovers,
      handoverPieces: s.handoverPieces,
      skillsAuto: s.skillsAuto,
      skillsManual: s.skillsManual,
    };
  }

  private playDelta(): AttemptPlay {
    const now = this.playNow();
    const out = emptyPlay();
    // 카운터는 저장되지 않아 앱을 다시 열면 0부터 — 음수가 되지 않게
    for (const k of PLAY_KEYS) out[k] = Math.max(0, now[k] - this.playStart[k]);
    return out;
  }

  /** 화면 카운터 (편성·이야기책·영웅 상세 연 횟수, 편성 바꿈, 잉크 부은 양) — 세션 단위 */
  ui(key: keyof SessionUi, amount = 1): void {
    this.session.ui[key] += amount;
    this.write();
  }

  rating(attempt: number): DayRating | null {
    return this.life.attempts.find((d) => d.attempt === attempt)?.rating ?? null;
  }

  rate<K extends keyof DayRating>(attempt: number, key: K, value: DayRating[K]): void {
    const d = this.life.attempts.find((x) => x.attempt === attempt);
    if (!d) return;
    d.rating = { ...(d.rating ?? { day: null, retry: null }), [key]: value };
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
