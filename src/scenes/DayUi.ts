// 하루 구조 UI (§5.7, §5.8, §5.15): 이야기 장면 카드·갈림길 모달, "내일 또 만나요", 역류 준비 경고 띠, 이야기 한 장 패널,
// 이야기책 목록(+ 펼치지 못한 날), 영웅 배정(1-1, [11]-3), 챕터 완성·미완성 화면.
// 도형 + 텍스트만. 상태는 core(GameState)에서 읽고, 버튼은 core 메서드·hooks만 호출한다.
import Phaser from 'phaser';
import type { GameState, Role } from '../core/game';
import type { ForgottenEntry } from '../core/gating';
import type { GameData } from '../data/types';
import { showRatings } from '../debug/gridPreset';
import type { DayRating } from '../metrics/model';
import { minutesUntilMidnight } from '../platform/clock';
import { REGION, VIEW_H, VIEW_W } from './layout';
import { chainShort } from './labels';
import { heroName } from './laneUnits';
import { mergeDiary } from './diaryList';
import { Button, COLOR, text } from './ui';

const OVERLAY_DEPTH = 60;
const PANEL_W = 300;

export interface DayUiHooks {
  /** core 상태가 바뀐 뒤 (그리드·HUD 갱신) */
  onChange(): void;
  /** [처음부터] (두 번 탭 확인 뒤) */
  onRestart(): void;
  /** 날을 시작할 수 있는지 (gating: 열 수 있는 날 ≥ 1 또는 디버그 우회) */
  canOpenDay(): boolean;
  /** "내일 또 만나요"의 [다시 확인]: gating 지급 확인 */
  recheck(): void;
  /** 이번 일생의 기억나지 않는 날 (일기장 병합) */
  forgottenLog(): readonly ForgottenEntry[];
  /** 하루 끝 주관 평가 (§5.10-4, ?debug=1·?playtest=1에서만 표시) */
  rating(day: number): DayRating | null;
  rate<K extends keyof DayRating>(day: number, key: K, value: DayRating[K]): void;
  endingAgree(): boolean | null;
  setEndingAgree(v: boolean): void;
  /** 영웅 배정을 바꾼 뒤 바로 저장 (dayStart 경계) */
  persist(): void;
}

const DAY_RATINGS: { value: NonNullable<DayRating['day']>; label: string }[] = [
  { value: 'good', label: '좋았다' },
  { value: 'meh', label: '그저 그랬다' },
  { value: 'bad', label: '별로였다' },
];
const BACKFLOW_RATINGS: { value: NonNullable<DayRating['backflow']>; label: string }[] = [
  { value: 'tense', label: '긴장됐다' },
  { value: 'annoyed', label: '짜증났다' },
];

/** [처음부터] 두 번 탭: 첫 탭 후 이 시간 안에 다시 눌러야 한다 */
const RESTART_CONFIRM_MS = 3000;

/** 전체 화면을 덮는 반투명 막 + 가운데 패널. 막은 뒤쪽 입력을 막는다 */
class Modal {
  readonly objects: Phaser.GameObjects.GameObject[] = [];
  readonly buttons: Button[] = [];

  constructor(
    readonly scene: Phaser.Scene,
    height: number,
    readonly top = (VIEW_H - height) / 2,
  ) {
    const overlay = scene.add.rectangle(0, 0, VIEW_W, VIEW_H, 0x000000, 0.55).setOrigin(0).setDepth(OVERLAY_DEPTH).setInteractive();
    const panel = scene.add
      .rectangle((VIEW_W - PANEL_W) / 2, top, PANEL_W, height, COLOR.hud)
      .setOrigin(0)
      .setStrokeStyle(2, COLOR.mirror)
      .setDepth(OVERLAY_DEPTH + 1);
    this.objects.push(overlay, panel);
  }

  text(y: number, s: string, style: Phaser.Types.GameObjects.Text.TextStyle = {}, originX = 0.5): Phaser.GameObjects.Text {
    const x = originX === 0.5 ? VIEW_W / 2 : (VIEW_W - PANEL_W) / 2 + 16;
    const t = text(this.scene, x, this.top + y, s, { wordWrap: { width: PANEL_W - 32 }, align: originX === 0.5 ? 'center' : 'left', ...style })
      .setOrigin(originX, 0)
      .setDepth(OVERLAY_DEPTH + 2);
    this.objects.push(t);
    return t;
  }

  button(x: number, y: number, w: number, label: string, onClick: (btn: Button) => void, fontSize = '12px', h = 30): Button {
    const b = new Button(this.scene, x, this.top + y, w, h, label, onClick, fontSize);
    b.container.setDepth(OVERLAY_DEPTH + 2);
    this.buttons.push(b);
    return b;
  }

  destroy(): void {
    this.scene.tweens.killTweensOf(this.objects);
    for (const o of this.objects) o.destroy();
    for (const b of this.buttons) b.container.destroy();
  }
}

export class DayUi {
  private modal: Modal | null = null;
  private diaryList: Phaser.GameObjects.GameObject[] | null = null;
  private shownFor = '';
  private readonly prepBand: Phaser.GameObjects.Container;
  private readonly prepText: Phaser.GameObjects.Text;
  /** "내일 또 만나요"의 남은 시간 텍스트 (떠 있을 때만) */
  private waitText: Phaser.GameObjects.Text | null = null;
  private waitCheckedAt = 0;
  /** 1-1 영웅 배정 화면을 이 세션에서 넘겼는지 (core가 1일차 카드를 닫으면 잠근다) */
  private assignSeen = false;

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly state: GameState,
    private readonly data: GameData,
    private readonly hooks: DayUiHooks,
  ) {
    // 역류 준비 시간 경고 띠: 방어 레인 위쪽
    const r = REGION.ground;
    const band = scene.add.rectangle(0, 0, r.w, 22, 0x7a2e3e, 0.92).setOrigin(0);
    this.prepText = text(scene, r.w / 2, 11, '', { fontSize: '11px', color: '#ffd6de', fontStyle: 'bold' }).setOrigin(0.5);
    this.prepBand = scene.add.container(r.x, r.y + 2, [band, this.prepText]).setDepth(45).setVisible(false);
  }

  /** 입력 차단 중 (모달·일기장이 떠 있음) */
  get blocking(): boolean {
    return this.modal !== null || this.diaryList !== null;
  }

  /** 매 프레임: 단계에 맞는 모달을 띄우고 경고 띠를 갱신 */
  sync(): void {
    const s = this.state;
    const key = this.phaseKey();
    if (key !== this.shownFor) {
      this.shownFor = key;
      this.closeModal();
      if (s.phase === 'dayStart') {
        if (!this.hooks.canOpenDay()) this.showSeeYouTomorrow();
        else if (!s.assignmentDone && !this.assignSeen) this.showAssign(); // 1-1 카드보다 먼저 ([11]-3)
        else this.showEventCard();
      } else if (s.phase === 'diary') this.showDiaryPanel();
      else if (s.phase === 'chapterComplete') this.showChapterComplete(s.completed);
    }
    // 다음 지급까지 남은 시간: 1초마다 확인 (표시는 분 단위라 1분마다 바뀐다)
    if (this.waitText && this.scene.time.now - this.waitCheckedAt >= 1000) {
      this.waitCheckedAt = this.scene.time.now;
      const t = this.waitLabel();
      if (this.waitText.text !== t) this.waitText.setText(t);
    }
    const prep = s.phase === 'night' && s.wave.inBossPrep;
    this.prepBand.setVisible(prep);
    if (prep) this.prepText.setText(`⚠ ${this.data.monsters.backflowBoss.name}가 다가온다 · ${Math.ceil(s.wave.timer)}초`);
  }

  /** 단계별 모달을 다시 띄울지 판단하는 키. dayStart는 날을 시작할 수 있는지도 포함 */
  private phaseKey(): string {
    const s = this.state;
    const open = s.phase === 'dayStart' ? `:${this.hooks.canOpenDay()}` : '';
    return `${s.phase}:${s.day}:${s.today.id}${open}:a${this.assignSeen}`;
  }

  private closeModal(): void {
    this.modal?.destroy();
    this.modal = null;
    this.waitText = null;
  }

  private waitLabel(): string {
    const m = minutesUntilMidnight();
    const h = Math.floor(m / 60);
    return `다음 날이 열리기까지 ${h > 0 ? `${h}시간 ` : ''}${m % 60}분`;
  }

  /** 열 수 있는 날이 0: 마지막 그림일기 한 줄 + "내일 또 만나요" + 남은 시간 + [일기장] [다시 확인] */
  private showSeeYouTomorrow(): void {
    const s = this.state;
    const m = new Modal(this.scene, 230);
    const last = s.diary[s.diary.length - 1];
    let y = 20;
    if (last) {
      m.text(y, `${last.day}일째 · ${last.line}`, { fontSize: '11px', color: '#8a8f9e', lineSpacing: 3 });
      y += 52;
    } else {
      y += 20;
    }
    m.text(y, '내일 또 만나요', { fontSize: '20px', color: '#f2c94c', fontStyle: 'bold' });
    this.waitText = m.text(y + 40, this.waitLabel(), { fontSize: '11px', color: '#9fb4e0' });
    this.waitCheckedAt = this.scene.time.now;
    m.button(VIEW_W / 2 - 64, 190, 110, '이야기책', () => this.showDiaryList());
    m.button(VIEW_W / 2 + 64, 190, 110, '다시 확인', () => {
      this.hooks.recheck();
      this.hooks.onChange();
    });
    this.modal = m;
  }

  /** 이야기 장면 카드: 제목 + 본문 + [확인]. 갈림길(이정표)은 두 선택 버튼 */
  private showEventCard(): void {
    const s = this.state;
    const e = s.today;
    const milestone = e.kind === 'milestone';
    const m = new Modal(this.scene, milestone ? 250 : 200);
    m.text(16, `${milestone ? '갈림길 · ' : ''}${s.day}일째 (${s.maxDays}일 안에) · 1-${s.stage}`, { fontSize: '11px', color: '#9fb4e0' });
    m.text(36, e.title, { fontSize: '17px', color: '#f2c94c', fontStyle: 'bold' });
    const body = e.kind === 'plain' ? '이야기가 조용히 흘러간다.' : e.text;
    m.text(70, body, { fontSize: '12px', lineSpacing: 4 });
    if (s.carryBackflow) m.text(milestone ? 124 : 112, `⚠ 오늘 밤 ${this.data.monsters.backflowBoss.name}가 온다 (준비 시간 있음)`, { fontSize: '10px', color: '#ff9e9e' });
    const confirm = (choice?: string) => {
      if (this.state.confirmDay(choice).ok) {
        this.closeModal();
        this.shownFor = this.phaseKey();
        this.hooks.onChange();
      }
    };
    if (milestone) {
      s.choices.forEach((c, i) => m.button(VIEW_W / 2, 160 + i * 40, 286, c.label, () => confirm(c.id), '11px'));
    } else {
      m.button(VIEW_W / 2, 158, 120, '확인', () => confirm());
    }
    this.modal = m;
  }

  /**
   * 영웅 배정 (1-1 dayStart, [11]-3): 누이·오라비를 낮덱(오펜스)·밤덱(디펜스)에 하나씩. 기본은 heroes.json(+ start.swapHeroes).
   * 양쪽 최소 1명이라 고르는 것은 "누가 낮에 나가는가" 하나. [이대로 시작] → 이야기 장면 카드. 판 중 변경은 M8.10.
   */
  private showAssign(): void {
    const s = this.state;
    const m = new Modal(this.scene, 268);
    m.text(16, '1-1 · 판 시작', { fontSize: '11px', color: '#9fb4e0' });
    m.text(34, '누가 낮에 나갈까?', { fontSize: '17px', color: '#f2c94c', fontStyle: 'bold' });
    m.text(64, '낮덱 = 해가 있는 동안 그림자 층을 정화 (오펜스)\n밤덱 = 몰려오는 무리로부터 집을 지킴 (디펜스)', {
      fontSize: '10px',
      color: '#cfd6ea',
      lineSpacing: 3,
    });
    const ids = [s.heroes.offense.id, s.heroes.defense.id];
    const label = (offId: string) => {
      const defId = ids.find((x) => x !== offId)!;
      return `☀ 낮 ${heroName(this.data, offId)} · ☾ 밤 ${heroName(this.data, defId)}`;
    };
    // 영웅 기본 능력치 (heroes.json)
    const stat = (role: Role) => {
      const h = s.heroDef(role);
      return `${role === 'offense' ? '☀' : '☾'} ${h.name} 체력 ${h.hp} · 공격 ${h.atk}`;
    };
    const info = m.text(192, '', { fontSize: '9px', color: '#8a8f9e', lineSpacing: 3 });
    const opts = [...ids].sort().map((offId) => ({ offId, btn: null as Button | null }));
    const mark = () => {
      opts.forEach((o) => o.btn?.setActive(s.heroes.offense.id === o.offId));
      info.setText(`${stat('offense')}\n${stat('defense')}`);
    };
    opts.forEach((o, k) => {
      o.btn = m.button(VIEW_W / 2, 118 + k * 38, 260, label(o.offId), () => {
        s.assignHeroes(o.offId);
        mark();
        this.hooks.persist();
        this.hooks.onChange();
      }, '11px');
    });
    mark();
    m.button(VIEW_W / 2, 238, 140, '이대로 시작', () => {
      this.assignSeen = true;
      this.closeModal();
      this.shownFor = ''; // 이야기 장면 카드를 띄운다
    });
    this.modal = m;
  }

  /** 하루 끝: 그림일기 + [다음 날] [일기장] */
  private showDiaryPanel(): void {
    const s = this.state;
    const entry = s.diary[s.diary.length - 1];
    const st = s.lastDayStats;
    const ratings = showRatings();
    const backflowRow = ratings && st?.backflow === 1;
    const extra = ratings ? (backflowRow ? 68 : 36) : 0;
    const m = new Modal(this.scene, 250 + extra);
    m.text(16, `${entry.day}일째 · 이야기 한 장`, { fontSize: '14px', color: '#f2c94c', fontStyle: 'bold' });
    m.text(38, entry.eventTitle, { fontSize: '11px', color: '#9fb4e0' });
    m.text(62, entry.line, { fontSize: '13px', lineSpacing: 5 });
    if (st) {
      const bossName = this.data.monsters.backflowBoss.name;
      const boss = st.bossWin === null ? '' : st.bossWin ? ` · ${bossName}를 막아냄` : ` · ${bossName}에 휩쓸림`;
      m.text(
        140,
        `막아낸 ${this.data.monsters.worry.name} ${st.defeated} · 가라앉음 ${st.sunk} · 층 돌파 ${st.layersCleared}${boss}\n하루 ${Math.round(st.realSeconds)}초`,
        { fontSize: '10px', color: '#8a8f9e', lineSpacing: 3 },
      );
    }
    // 주관 평가 (선택 안 해도 다음 날로 갈 수 있음)
    if (ratings) {
      const day = entry.day;
      this.ratingRow(m, 184, '오늘은?', DAY_RATINGS, () => this.hooks.rating(day)?.day ?? null, (v) => this.hooks.rate(day, 'day', v));
      if (backflowRow) {
        this.ratingRow(m, 216, '역류는?', BACKFLOW_RATINGS, () => this.hooks.rating(day)?.backflow ?? null, (v) =>
          this.hooks.rate(day, 'backflow', v),
        );
      }
    }
    const by = 204 + extra;
    const next = s.chapterCleared ? '챕터 완성' : s.day >= s.maxDays ? '이야기 덮기' : '다음 날';
    m.button(VIEW_W / 2 - 94, by, 86, next, () => {
      if (this.state.nextDay()) this.hooks.onChange();
    });
    m.button(VIEW_W / 2, by, 86, '이야기책', () => this.showDiaryList());
    m.button(VIEW_W / 2 + 94, by, 86, '추억 조합', () => this.showRecipes());
    this.modal = m;
  }

  /** "질문 [선택지…]" 한 줄. 고른 버튼은 강조, 다시 고르면 바꿀 수 있다 */
  private ratingRow<T>(
    m: Modal,
    y: number,
    label: string,
    options: { value: T; label: string }[],
    current: () => T | null,
    pick: (v: T) => void,
  ): void {
    const t = m.text(y + 8, label, { fontSize: '11px', color: '#9fb4e0' }, 0);
    const w = options.length === 3 ? 66 : 80;
    // 버튼은 라벨 오른쪽부터 (짧은 라벨은 같은 열에 맞춘다)
    const x0 = (VIEW_W - PANEL_W) / 2 + Math.max(88, 16 + t.width + 8) + w / 2;
    const buttons = options.map((o, i) =>
      m.button(x0 + i * (w + 4), y + 15, w, o.label, () => {
        pick(o.value);
        buttons.forEach((b, j) => b.setActive(options[j].value === current()));
      }, '10px', 24),
    );
    buttons.forEach((b, j) => b.setActive(options[j].value === current()));
  }

  /**
   * 챕터 완성 화면 (§5.15-5, D-043): 제목, 완성 문구, 조합법 카드 2장(해·달, 표시만 — 조합표에는 추가하지 않음),
   * 기록(걸린 일수·스테이지·영웅 둘의 떡/동아줄 점수·먹이기·병사), [이야기책] [처음부터].
   * 미완성(completed false)이면 미완성 문구 + 기록, 조합법 카드 없음.
   */
  showChapterComplete(completed: boolean | null): void {
    this.closeModal();
    const s = this.state;
    const cc = this.data.chapterComplete;
    const done = completed === true;
    const agree = showRatings() && completed !== null;
    const cardsH = done ? 110 : 0;
    const recordH = 112;
    const m = new Modal(this.scene, 96 + cardsH + recordH + (agree ? 34 : 0) + 56);
    m.text(16, cc.title, { fontSize: '12px', color: '#9fb4e0' });
    const head = m.text(36, done ? cc.doneText : cc.notDoneText, { fontSize: '17px', color: done ? '#f2c94c' : '#cfd6ea', fontStyle: 'bold' });
    let y = 36 + head.height + 16;
    if (done) {
      const learned = m.text(y, `${cc.learnedRecipes.map((r) => r.name.replace(/^해와 달이 된 /, '')).join('와 ')}를 만드는 법을 알게 되었다`, { fontSize: '12px', color: '#ffe08a' });
      y += learned.height + 8;
      const cards = cc.learnedRecipes.slice(0, 2);
      cards.forEach((c, i) => {
        const cx = VIEW_W / 2 + (i === 0 ? -72 : 72) * (cards.length > 1 ? 1 : 0);
        const day = c.side === 'day';
        const box = this.scene.add
          .rectangle(cx, m.top + y + 38, 132, 76, day ? 0x3b2f12 : 0x1d2440)
          .setStrokeStyle(2, day ? 0xf2c94c : 0x9fb0e0)
          .setDepth(OVERLAY_DEPTH + 2);
        m.objects.push(box);
        const t = (dy: number, str: string, style: Phaser.Types.GameObjects.Text.TextStyle) => {
          const o = text(this.scene, cx, m.top + y + dy, str, { align: 'center', wordWrap: { width: 120 }, ...style }).setOrigin(0.5, 0).setDepth(OVERLAY_DEPTH + 3);
          m.objects.push(o);
        };
        t(6, day ? '☀ 해의 조합법' : '☾ 달의 조합법', { fontSize: '9px', color: day ? '#ffd36b' : '#b9c6ff' });
        t(26, c.name, { fontSize: '12px', color: '#ffffff', fontStyle: 'bold' });
      });
      y += 88;
    }
    m.text(y, `${s.day}일 동안 · 1-${s.stage}까지`, { fontSize: '11px', color: '#cfd6ea' });
    y += 20;
    for (const role of ['offense', 'defense'] as const) {
      const h = s.heroes[role];
      const pts = this.data.chains.map((c) => `${chainShort(this.data, c.archetypeId)} ${h.points[c.archetypeId] ?? 0}`).join(' · ');
      m.text(y, `${role === 'offense' ? '☀ 낮' : '☾ 밤'} ${heroName(this.data, h.id)}: ${pts}`, { fontSize: '11px', color: role === 'offense' ? '#ffe08a' : '#dfe6ff' });
      y += 18;
    }
    m.text(y, `먹이기 ${s.stats.feeds} · 전투 중 머지 ${s.stats.battleMerges} · 병사 ${s.stats.soldiersSpawned}`, { fontSize: '10px', color: '#9fe0a0' });
    y += 40;
    if (agree) {
      const opts = [
        { value: true, label: '응' },
        { value: false, label: '아니' },
      ];
      this.ratingRow(m, y, '이 챕터의 끝, 납득돼?', opts, () => this.hooks.endingAgree(), (v) => this.hooks.setEndingAgree(v));
      y += 34;
    }
    const by = y + 24;
    m.button(VIEW_W / 2 - 64, by, 110, '이야기책', () => this.showDiaryList());
    let armedAt = -Infinity;
    m.button(VIEW_W / 2 + 64, by, 110, '처음부터', (b) => {
      const now = this.scene.time.now;
      if (now - armedAt <= RESTART_CONFIRM_MS) {
        this.hooks.onRestart();
        return;
      }
      armedAt = now;
      b.setLabel('한 번 더 누르면 처음부터').setActive(true);
      this.scene.time.delayedCall(RESTART_CONFIRM_MS, () => {
        if (b.container.active) b.setLabel('처음부터').setActive(false);
      });
    });
    this.modal = m;
  }

  /**
   * 추억 조합 도감 (§5.13-5, §5.17-6): 조합표를 보여주되 제작은 꺼져 있다 — "아직 쓰는 법을 모른다".
   * 조합법의 역할(스킬 해금·진화·동료)은 보류 (D-045·D-047).
   */
  showRecipes(): void {
    if (this.diaryList) return;
    const scene = this.scene;
    const objs: Phaser.GameObjects.GameObject[] = [];
    const d = OVERLAY_DEPTH + 10;
    objs.push(scene.add.rectangle(0, 0, VIEW_W, VIEW_H, 0x0e1016, 0.96).setOrigin(0).setDepth(d).setInteractive());
    objs.push(text(scene, VIEW_W / 2, 14, '추억 조합', { fontSize: '15px', color: '#f2c94c', fontStyle: 'bold' }).setOrigin(0.5, 0).setDepth(d + 1));
    objs.push(
      text(scene, VIEW_W / 2, 38, '아직 쓰는 법을 모른다 (조합은 지금 되지 않아요)', { fontSize: '11px', color: '#ff9e6b' })
        .setOrigin(0.5, 0)
        .setDepth(d + 1),
    );
    const chains = new Map(this.data.chains.map((c) => [c.archetypeId, c]));
    const maxTier = this.data.balance.grid.maxTier;
    let y = 72;
    for (const r of this.data.recipes.recipes) {
      const icon = (x: number, inp: (typeof r.inputs)[number]) => {
        const c = chains.get(inp.chain);
        const box = scene.add.rectangle(x, y + 18, 34, 28, c ? parseInt(c.color.slice(1), 16) : 0x999999).setDepth(d + 1);
        box.setStrokeStyle(inp.shining ? 2 : 1, inp.shining ? 0xfff1a8 : 0x1b1d24);
        const mark = inp.shining === true ? '✦' : inp.shining === false ? '○' : '';
        const lab = text(scene, x, y + 18, inp.tier >= maxTier ? '★' : String(inp.tier), { fontSize: '13px', color: '#1b1d24', fontStyle: 'bold' })
          .setOrigin(0.5)
          .setDepth(d + 2);
        const name = c ? c.tierNames[inp.tier - 1] : inp.chain;
        const cap = text(scene, x, y + 36, `${mark}${name}`, { fontSize: '8px', color: '#cfd6ea' }).setOrigin(0.5, 0).setDepth(d + 1);
        objs.push(box, lab, cap);
      };
      icon(52, r.inputs[0]);
      objs.push(text(scene, 90, y + 18, '+', { fontSize: '16px', color: '#cfd6ea' }).setOrigin(0.5).setDepth(d + 1));
      icon(128, r.inputs[1]);
      objs.push(text(scene, 166, y + 18, '→', { fontSize: '16px', color: '#f2c94c' }).setOrigin(0.5).setDepth(d + 1));
      const res = scene.add.rectangle(205, y + 18, 34, 28, 0x3b2a00).setStrokeStyle(3, 0xf2c94c).setDepth(d + 1);
      objs.push(res, text(scene, 205, y + 18, '◆', { fontSize: '13px', color: '#f2c94c' }).setOrigin(0.5).setDepth(d + 2));
      objs.push(
        text(scene, 232, y + 10, r.name, { fontSize: '12px', color: '#ffe08a', fontStyle: 'bold' }).setDepth(d + 1),
        text(scene, 232, y + 25, r.kind === 'happy' ? '행복한 추억' : '정화된 추억', { fontSize: '9px', color: r.kind === 'happy' ? '#ffd36b' : '#b9c6ff' }).setDepth(d + 1),
        text(scene, 232, y + 37, '쓰는 법을 모름', { fontSize: '9px', color: '#8a8f9e' }).setDepth(d + 1),
      );
      y += 64;
    }
    const close = new Button(scene, VIEW_W / 2, VIEW_H - 36, 120, 30, '닫기', () => {
      for (const o of objs) o.destroy();
      close.container.destroy();
      this.diaryList = null;
    }, '12px');
    close.container.setDepth(d + 2);
    this.diaryList = objs;
  }

  /** 일기장: 목록(일차 · 이벤트명 · 문장). 드래그·휠로 스크롤만 */
  showDiaryList(): void {
    if (this.diaryList) return;
    const scene = this.scene;
    const objs: Phaser.GameObjects.GameObject[] = [];
    const top = 40;
    const bottom = VIEW_H - 70;
    const x0 = 20;
    const overlay = scene.add.rectangle(0, 0, VIEW_W, VIEW_H, 0x0e1016, 0.96).setOrigin(0).setDepth(OVERLAY_DEPTH + 10).setInteractive();
    const title = text(scene, VIEW_W / 2, 14, '이야기책', { fontSize: '15px', color: '#f2c94c', fontStyle: 'bold' })
      .setOrigin(0.5, 0)
      .setDepth(OVERLAY_DEPTH + 11);
    objs.push(overlay, title);

    const list = scene.add.container(0, top).setDepth(OVERLAY_DEPTH + 11);
    let y = 0;
    const rows = mergeDiary(this.state.diary, this.hooks.forgottenLog(), this.data.diary.forgottenDay);
    if (rows.length === 0) {
      list.add(text(scene, x0, 0, '아직 쓴 일기가 없다.', { fontSize: '12px', color: '#8a8f9e' }));
    }
    for (const r of rows) {
      const head = text(scene, x0, y, r.head, { fontSize: '11px', color: r.forgotten ? '#6d7282' : '#9fb4e0' });
      const body = text(scene, x0, y + 16, r.line, {
        fontSize: '12px',
        wordWrap: { width: VIEW_W - x0 * 2 },
        lineSpacing: 3,
        color: r.forgotten ? '#8a8f9e' : '#e8e8e8',
      });
      list.add([head, body]);
      y += 16 + body.height + 14;
    }
    const maskShape = scene.make.graphics({}, false).fillRect(0, top, VIEW_W, bottom - top);
    list.setMask(maskShape.createGeometryMask());
    objs.push(list, maskShape);

    const minY = Math.min(top, bottom - y);
    const scrollTo = (ny: number) => list.setY(Math.max(minY, Math.min(top, ny)));
    let dragFrom: { py: number; ly: number } | null = null;
    overlay.on('pointerdown', (p: Phaser.Input.Pointer) => (dragFrom = { py: p.worldY, ly: list.y }));
    overlay.on('pointermove', (p: Phaser.Input.Pointer) => {
      if (dragFrom && p.isDown) scrollTo(dragFrom.ly + (p.worldY - dragFrom.py));
    });
    overlay.on('pointerup', () => (dragFrom = null));
    const onWheel = (_p: unknown, _o: unknown, _dx: number, dy: number) => scrollTo(list.y - dy * 0.5);
    scene.input.on('wheel', onWheel);

    const close = new Button(scene, VIEW_W / 2, VIEW_H - 36, 120, 30, '닫기', () => {
      scene.input.off('wheel', onWheel);
      for (const o of objs) o.destroy();
      close.container.destroy();
      this.diaryList = null;
    }, '12px');
    close.container.setDepth(OVERLAY_DEPTH + 12);
    this.diaryList = objs;
  }
}
