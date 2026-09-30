// 하루 구조 UI (§5.7, §5.8): 이벤트 카드·이정표 모달, "내일 또 만나요", 역류 준비 경고 띠, 그림일기 패널,
// 일기장 목록(+ 기억나지 않는 날), 결과 화면.
// 도형 + 텍스트만. 상태는 core(GameState)에서 읽고, 버튼은 core 메서드·hooks만 호출한다.
import Phaser from 'phaser';
import type { EndingResult } from '../core/ending';
import type { GameState } from '../core/game';
import type { ForgottenEntry } from '../core/gating';
import type { GameData } from '../data/types';
import { isDebug } from '../debug/gridPreset';
import { minutesUntilMidnight } from '../platform/clock';
import { REGION, VIEW_H, VIEW_W } from './layout';
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
}

const BREAKDOWN_LABELS: Record<keyof EndingResult['breakdown'], string> = {
  upTier: '위로 보낸 단계',
  defeat: '막아낸 걱정',
  joy: '얻은 기쁨',
  downTier: '아래로 보낸 단계',
  layer: '층 돌파',
  purified: '정화한 그림자',
};

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

  button(x: number, y: number, w: number, label: string, onClick: (btn: Button) => void): Button {
    const b = new Button(this.scene, x, this.top + y, w, 30, label, onClick, '12px');
    b.container.setDepth(OVERLAY_DEPTH + 2);
    this.buttons.push(b);
    return b;
  }

  destroy(): void {
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

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly state: GameState,
    private readonly data: GameData,
    private readonly hooks: DayUiHooks,
  ) {
    // 역류 준비 시간 경고 띠: 방어 레인 위쪽
    const r = REGION.defenseLane;
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
    const prep = s.phase === 'waves' && s.wave.inBossPrep;
    this.prepBand.setVisible(prep);
    if (prep) this.prepText.setText(`⚠ 역류가 다가온다 · ${Math.ceil(s.wave.timer)}초`);
  }

  /** 단계별 모달을 다시 띄울지 판단하는 키. dayStart는 날을 시작할 수 있는지도 포함 */
  private phaseKey(): string {
    const s = this.state;
    const open = s.phase === 'dayStart' ? `:${this.hooks.canOpenDay()}` : '';
    return `${s.phase}:${s.day}:${s.today.id}${open}`;
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

  /** 하루 끝: 그림일기 + [다음 날] [일기장] */
  private showDiaryPanel(): void {
    const s = this.state;
    const entry = s.diary[s.diary.length - 1];
    const st = s.lastDayStats;
    const m = new Modal(this.scene, 250);
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
    const last = s.day >= s.lifeLengthDays;
    m.button(VIEW_W / 2 - 64, 204, 110, last ? '일생 끝' : '다음 날', () => {
      if (this.state.nextDay()) this.hooks.onChange();
    });
    m.button(VIEW_W / 2 + 64, 204, 110, '일기장', () => this.showDiaryList());
    this.modal = m;
  }

  /**
   * 결과 화면 (§5.8-3): 결말 이름, 한 줄 설명, 엔딩 제목(+ 상하 반전 alpha 0.35 반사), 두 점수, [일기장], [처음부터].
   * ?debug=1이면 항목별 기여. preview(디버그 결말 미리보기)면 [처음부터] 대신 [닫기]이고 게임 상태는 바꾸지 않는다.
   */
  showResult(result: EndingResult | null, preview: boolean): void {
    this.closeModal();
    const debug = isDebug();
    const m = new Modal(this.scene, debug ? 330 : 300);
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
      m.text(176, `Happy ${Math.round(result.happy)} · Unhappy ${Math.round(result.unhappy)}`, { fontSize: '13px' });
      if (debug) {
        const lines = (Object.keys(BREAKDOWN_LABELS) as (keyof typeof BREAKDOWN_LABELS)[]).map(
          (k) => `${BREAKDOWN_LABELS[k]} ${result.breakdown[k].toFixed(1)}`,
        );
        m.text(202, `[기여] ${lines.slice(0, 3).join(' · ')}\n${lines.slice(3).join(' · ')}`, {
          fontSize: '9px',
          color: '#ff9e6b',
          lineSpacing: 3,
        });
      }
    }
    const by = debug ? 290 : 260;
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
