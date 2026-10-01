// 하루 구조 UI (§5.7, §5.8): 이벤트 카드·이정표 모달, "내일 또 만나요", 역류 준비 경고 띠, 그림일기 패널,
// 일기장 목록(+ 기억나지 않는 날), 결과 화면.
// 도형 + 텍스트만. 상태는 core(GameState)에서 읽고, 버튼은 core 메서드·hooks만 호출한다.
import Phaser from 'phaser';
import type { EndingResult } from '../core/ending';
import type { GrowthResult } from '../core/growth';
import type { GameState } from '../core/game';
import type { ForgottenEntry } from '../core/gating';
import type { GameData } from '../data/types';
import { showDebugUi, showRatings } from '../debug/gridPreset';
import type { DayRating } from '../metrics/model';
import { minutesUntilMidnight } from '../platform/clock';
import { REGION, VIEW_H, VIEW_W, cellCenter, skyArc } from './layout';
import { BRANCH_ICON, BRANCH_LABEL, recipeName, traitName, traitsLine } from './growthText';
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

/** 자라기 연출: 전설이 빛이 되어 해(행복한 추억)·달(정화된 추억)로 올라간다 */
const GROWTH_LIGHT_MS = 700;
const GROWTH_LIGHT_STAGGER = 120;

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
  /** 연출을 본 자라기 수 (복원 시점까지는 본 것으로 친다) */
  private growthSeen: number;

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
    this.growthSeen = state.growthLog.length;
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
      const growth = s.growthLog[this.growthSeen];
      if (growth && (s.phase === 'dayStart' || s.phase === 'lifeEnd')) this.showGrowth(growth); // 이벤트 카드·결과보다 먼저
      else if (s.phase === 'dayStart') {
        if (this.hooks.canOpenDay()) this.showEventCard();
        else this.showSeeYouTomorrow();
      } else if (s.phase === 'diary') this.showDiaryPanel();
      else if (s.phase === 'lifeEnd') this.showResult(s.ending, false);
    }
    // 다음 지급까지 남은 시간: 1초마다 확인 (표시는 분 단위라 1분마다 바뀐다)
    if (this.waitText && this.scene.time.now - this.waitCheckedAt >= 1000) {
      this.waitCheckedAt = this.scene.time.now;
      const t = this.waitLabel();
      if (this.waitText.text !== t) this.waitText.setText(t);
    }
    const prep = s.phase === 'day' && s.wave.inBossPrep;
    this.prepBand.setVisible(prep);
    if (prep) this.prepText.setText(`⚠ 역류가 다가온다 · ${Math.ceil(s.wave.timer)}초`);
  }

  /** 단계별 모달을 다시 띄울지 판단하는 키. dayStart는 날을 시작할 수 있는지도 포함 */
  private phaseKey(): string {
    const s = this.state;
    const open = s.phase === 'dayStart' ? `:${this.hooks.canOpenDay()}` : '';
    return `${s.phase}:${s.day}:${s.today.id}${open}:g${this.growthSeen}`;
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
    m.button(VIEW_W / 2 - 64, 190, 110, '일기장', () => this.showDiaryList());
    m.button(VIEW_W / 2 + 64, 190, 110, '다시 확인', () => {
      this.hooks.recheck();
      this.hooks.onChange();
    });
    this.modal = m;
  }

  /** 이벤트 카드: 제목 + 본문 + [확인]. 이정표는 두 선택 버튼 */
  private showEventCard(): void {
    const s = this.state;
    const e = s.today;
    const milestone = e.kind === 'milestone';
    const m = new Modal(this.scene, milestone ? 250 : 200);
    m.text(16, `${s.day}일째`, { fontSize: '11px', color: '#9fb4e0' });
    m.text(36, e.title, { fontSize: '17px', color: '#f2c94c', fontStyle: 'bold' });
    const body = e.kind === 'plain' ? '오늘은 별일 없는 하루.' : e.text;
    m.text(70, body, { fontSize: '12px', lineSpacing: 4 });
    if (s.carryBackflow) m.text(milestone ? 124 : 112, '⚠ 어젯밤의 역류가 아침에 온다 (준비 시간 있음)', { fontSize: '10px', color: '#ff9e9e' });
    const confirm = (choice?: string) => {
      if (this.state.confirmDay(choice).ok) {
        this.closeModal();
        this.shownFor = this.phaseKey();
        this.hooks.onChange();
      }
    };
    if (milestone) {
      s.choices.forEach((c, i) => m.button(VIEW_W / 2, 160 + i * 40, 250, c.label, () => confirm(c.id)));
    } else {
      m.button(VIEW_W / 2, 158, 120, '확인', () => confirm());
    }
    this.modal = m;
  }

  /**
   * 자라기 연출 모달 (§5.14-2): 소진된 전설이 빛이 되어 해/달로 올라가고, 갈래·양분·기억·특성을 보여준다.
   * [자라기] 한 번이면 끝 (core는 이미 처리됨). 다음은 이벤트 카드(5·10일) 또는 결과 화면(일생 끝).
   */
  private showGrowth(g: GrowthResult): void {
    const s = this.state;
    const scene = this.scene;
    const cfg = this.data.balance.growth;
    const last = s.phase === 'lifeEnd';
    const m = new Modal(scene, 262);
    // 하늘의 해·달 (막 위에 다시 그린다)
    const sunAt = skyArc(0.25);
    const moonAt = skyArc(0.75);
    const d = OVERLAY_DEPTH + 3;
    const sun = scene.add.circle(sunAt.x, sunAt.y, 11, 0xffd36b).setStrokeStyle(2, 0xfff1c4).setDepth(d);
    const moon = scene.add.circle(moonAt.x, moonAt.y, 9, 0xe8ecff).setStrokeStyle(2, 0x9fb0e0).setDepth(d);
    m.objects.push(sun, moon);
    const { cols, rows } = s.grid;
    const mid = cellCenter(cols, rows, Math.floor((cols * rows) / 2));
    g.consumed.forEach((c, i) => {
      const from = c.cell !== null ? cellCenter(cols, rows, c.cell) : mid;
      const to = c.kind === 'happy' ? sunAt : moonAt;
      const light = scene.add.star(from.x, from.y, 4, 4, 9, c.kind === 'happy' ? 0xffe08a : 0xc9d4ff).setDepth(d + 1);
      m.objects.push(light);
      scene.tweens.add({
        targets: light,
        x: to.x,
        y: to.y,
        scale: 0.4,
        delay: i * GROWTH_LIGHT_STAGGER,
        duration: GROWTH_LIGHT_MS,
        ease: 'Sine.easeIn',
        onComplete: () => {
          light.setVisible(false);
          scene.tweens.add({ targets: c.kind === 'happy' ? sun : moon, scale: 1.25, yoyo: true, duration: 140 });
        },
      });
    });
    m.text(14, `${last ? '마지막 자라기' : `${g.index}번째 자라기`} · ${g.age}살`, { fontSize: '11px', color: '#9fb4e0' });
    m.text(32, '한 뼘 자랐다', { fontSize: '18px', color: '#f2c94c', fontStyle: 'bold' });
    m.text(62, `${BRANCH_ICON[g.branch]}  ${BRANCH_LABEL[g.branch]}`, { fontSize: '13px', color: g.branch === 'slow' ? '#cfd6ea' : '#ffe08a' });
    const given = g.consumed.length
      ? `양분: 행복한 추억 ${g.happyCount} · 정화된 추억 ${g.purifiedCount}`
      : '양분으로 줄 전설이 없었다. 그래도 아이는 자란다.';
    m.text(90, given, { fontSize: '11px', lineSpacing: 3 });
    m.text(112, `성장 ☀ +${g.gained.happy} · ☾ +${g.gained.unhappy}   기억 +${g.pairs} (모두 ${s.growth.memories})`, {
      fontSize: '11px',
      color: '#cfd6ea',
    });
    const up = Object.keys(g.traitsUp);
    const upLine = up.length ? up.map((k) => `${traitName(this.data, k)} ${s.traits[k]}/${cfg.traitMaxStacks}`).join(' · ') : '새로 생긴 특성 없음';
    m.text(136, `특성: ${upLine}`, { fontSize: '11px', color: '#9fe0a0', lineSpacing: 3 });
    m.text(172, '다정함·포근함 = 낮에 / 용기·위로 = 밤에 그 계열이 강해진다', { fontSize: '9px', color: '#8a8f9e' });
    if (!last) m.text(188, '자란 만큼 걱정도 조금 더 단단해진다', { fontSize: '9px', color: '#8a8f9e' });
    m.button(VIEW_W / 2, 226, 120, '자라기', () => {
      this.growthSeen += 1;
      this.closeModal();
      this.shownFor = ''; // 다음 모달(이벤트 카드·결과)을 띄운다
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
    m.text(16, `${entry.day}일째 그림일기`, { fontSize: '14px', color: '#f2c94c', fontStyle: 'bold' });
    m.text(38, entry.eventTitle, { fontSize: '11px', color: '#9fb4e0' });
    m.text(62, entry.line, { fontSize: '13px', lineSpacing: 5 });
    if (st) {
      const boss = st.bossWin === null ? '' : st.bossWin ? ' · 역류를 이겨냄' : ' · 역류에 휩쓸림';
      m.text(
        140,
        `막아낸 걱정 ${st.defeated} · 가라앉음 ${st.sunk} · 층 돌파 ${st.layersCleared}${boss}\n하루 ${Math.round(st.realSeconds)}초`,
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
    const last = s.day >= s.lifeLengthDays;
    m.button(VIEW_W / 2 - 94, by, 86, last ? '일생 끝' : '다음 날', () => {
      if (this.state.nextDay()) this.hooks.onChange();
    });
    m.button(VIEW_W / 2, by, 86, '일기장', () => this.showDiaryList());
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
   * 결과 화면 (§5.8-3, §5.14-3): 결말 이름, 엔딩 제목(+ 상하 반전 alpha 0.35 반사), 설명,
   * 자라기 갈래(아이콘), 준 전설 수(행복/정화)·기억, 기억 앨범, 특성, [일기장], [처음부터].
   * ?debug=1이면 판정 숫자(total·share). preview(디버그 결말 미리보기)면 [처음부터] 대신 [닫기]이고 게임 상태는 바꾸지 않는다.
   */
  showResult(result: EndingResult | null, preview: boolean): void {
    this.closeModal();
    const debug = showDebugUi();
    const agree = showRatings() && !preview && result !== null;
    const album = preview ? [] : this.state.growth.album;
    const ALBUM_ROWS = 4;
    const albumLines = Math.min(album.length, ALBUM_ROWS) + (album.length > ALBUM_ROWS ? 1 : 0);
    const extra = (debug ? 18 : 0) + (agree ? 34 : 0) + albumLines * 14;
    const m = new Modal(this.scene, 372 + extra);
    if (!result) {
      m.text(40, '결말 없음', { fontSize: '16px', color: '#ff9e9e' });
    } else {
      const e = this.data.endings.endings[result.id];
      if (preview) m.text(6, `(미리보기 · ${result.id})`, { fontSize: '9px', color: '#ff9e6b' });
      m.text(22, e.name, { fontSize: '13px', color: '#9fb4e0' });
      const title = m.text(46, e.title, { fontSize: '22px', color: '#f2c94c', fontStyle: 'bold' });
      // 수면 반사: 같은 글자를 상하 반전·alpha 0.35로 한 번 더 (연출은 본 개발)
      m.text(46 + title.height, e.title, { fontSize: '22px', color: '#f2c94c', fontStyle: 'bold' }).setFlipY(true).setAlpha(0.35);
      m.text(46 + title.height * 2 + 12, e.desc, { fontSize: '12px', lineSpacing: 4 });
      let y = 176;
      const branches = result.branches.length ? result.branches.map((b) => BRANCH_ICON[b]).join('   ') : '-';
      m.text(y, `자라기  ${branches}`, { fontSize: '15px', color: '#ffe08a' });
      y += 26;
      const bd = result.breakdown;
      m.text(y, `양분으로 준 추억: 행복한 추억 ${bd.happyLegends} · 정화된 추억 ${bd.purifiedLegends}`, { fontSize: '11px' });
      y += 18;
      m.text(y, `기억 ${bd.memories}개`, { fontSize: '11px', color: '#f2c94c' });
      y += 18;
      album.slice(0, ALBUM_ROWS).forEach((a) => {
        m.text(y, `${a.day}일 · ${recipeName(this.data, a.happy)} + ${recipeName(this.data, a.purified)}`, { fontSize: '10px', color: '#cfd6ea' });
        y += 14;
      });
      if (album.length > ALBUM_ROWS) {
        m.text(y, `외 ${album.length - ALBUM_ROWS}개`, { fontSize: '10px', color: '#8a8f9e' });
        y += 14;
      }
      m.text(y + 4, `특성: ${preview ? '-' : traitsLine(this.data, this.state.traits)}`, { fontSize: '11px', color: '#9fe0a0', lineSpacing: 3 });
      y += 26;
      if (debug) {
        m.text(y, `[판정] 총 ${Math.round(result.total)} (☀ ${Math.round(result.happy)} · ☾ ${Math.round(result.unhappy)}) · 행복 비율 ${result.share.toFixed(2)}`, {
          fontSize: '9px',
          color: '#ff9e6b',
        });
      }
    }
    const base = 278 + albumLines * 14 + (debug ? 18 : 0);
    if (agree) {
      const opts = [
        { value: true, label: '응' },
        { value: false, label: '아니' },
      ];
      this.ratingRow(m, base, '이 결말, 납득돼?', opts, () => this.hooks.endingAgree(), (v) => this.hooks.setEndingAgree(v));
    }
    const by = base + 54 + (agree ? 34 : 0);
    m.button(VIEW_W / 2 - 64, by, 110, '일기장', () => this.showDiaryList());
    if (preview) {
      m.button(VIEW_W / 2 + 64, by, 110, '닫기', () => {
        this.closeModal();
        this.shownFor = ''; // 단계 모달을 다시 띄운다
      });
    } else {
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
    }
    this.modal = m;
  }

  /**
   * 추억 조합 도감 (§5.13-5): 조합표 전부를 처음부터 보여준다 (재료 아이콘 + 결과 이름, 만든 적 있으면 ✓).
   * 원랜디·나랜디처럼 목표를 미리 보이게 한다.
   */
  showRecipes(): void {
    if (this.diaryList) return;
    const scene = this.scene;
    const objs: Phaser.GameObjects.GameObject[] = [];
    const d = OVERLAY_DEPTH + 10;
    objs.push(scene.add.rectangle(0, 0, VIEW_W, VIEW_H, 0x0e1016, 0.96).setOrigin(0).setDepth(d).setInteractive());
    objs.push(text(scene, VIEW_W / 2, 14, '추억 조합', { fontSize: '15px', color: '#f2c94c', fontStyle: 'bold' }).setOrigin(0.5, 0).setDepth(d + 1));
    objs.push(
      text(scene, VIEW_W / 2, 38, '✦ 빛나는 영웅(밤에 정화하면 생겨요) · ○ 빛나지 않은 영웅 · 쉬는 영웅도 재료', { fontSize: '10px', color: '#8a8f9e' })
        .setOrigin(0.5, 0)
        .setDepth(d + 1),
    );
    const chains = new Map(this.data.chains.map((c) => [c.archetypeId, c]));
    const made = this.state.stats.legendsByRecipe;
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
      const done = (made[r.id] ?? 0) > 0;
      objs.push(
        text(scene, 232, y + 10, r.name, { fontSize: '12px', color: '#ffe08a', fontStyle: 'bold' }).setDepth(d + 1),
        text(scene, 232, y + 25, r.kind === 'happy' ? '행복한 추억' : '정화된 추억', { fontSize: '9px', color: r.kind === 'happy' ? '#ffd36b' : '#b9c6ff' }).setDepth(d + 1),
        text(scene, 232, y + 37, `공격 ${r.legend.atk} · 체력 ${r.legend.hp}${done ? '  ✓ 만듦' : ''}`, {
          fontSize: '9px',
          color: done ? '#9fe0a0' : '#8a8f9e',
        }).setDepth(d + 1),
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
    const title = text(scene, VIEW_W / 2, 14, '일기장', { fontSize: '15px', color: '#f2c94c', fontStyle: 'bold' })
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
