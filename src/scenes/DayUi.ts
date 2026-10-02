// 스테이지 UI (§5.19, §5.20-12, D-062·D-063): 스테이지 사이 필수 탭 0번.
//   장면 카드 1.5초 → 낮 / 다시 도전 카드 1.5초 → 자동 재시작 / 이야기 한 장 2.5초 → 다음 장면 카드 (탭 = 빨리 넘김, 버튼 없음)
//   고르는 화면은 편성(판 시작 자동·HUD [편성])·챕터 완성뿐. 1-5 갈림길·배정 팝업·추억 조합 삭제.
//   플레이 평가 질문은 ?playtest=1일 때만, 3장마다 + 챕터 완성 때, 안 눌러도 넘어감.
// 도형 + 텍스트만. 상태는 core(GameState)에서 읽고, 버튼은 core 메서드·hooks만 호출한다.
import Phaser from 'phaser';
import type { GameState } from '../core/game';
import type { GameData } from '../data/types';
import { showRatings } from '../debug/gridPreset';
import type { DayRating } from '../metrics/model';
import { REGION, VIEW_H, VIEW_W } from './layout';
import { fillTemplate, hasBatchim } from '../core/roster';
import { FAIL_LINE, stageLabel } from './labels';
import { heroName } from './laneUnits';
import { StoryBookView } from './StoryBookView';
import { sceneCardColor } from './scenery';
import { skinOf } from './skin/Skin';
import { Button, COLOR, text } from './ui';

const OVERLAY_DEPTH = 60;
const PANEL_W = 300;
/** 자동 넘김 시간 (§5.20-12) */
const SCENE_MS = 1500;
const RETRY_MS = 1500;
const PAGE_MS = 2500;
/** 평가 질문 간격 (장) */
const RATE_EVERY = 3;

export interface DayUiHooks {
  /** core 상태가 바뀐 뒤 (그리드·HUD 갱신) */
  onChange(): void;
  /** [처음부터] (두 번 탭 확인 뒤) */
  onRestart(): void;
  /** 판 시작 편성 화면 (취소 없음). 닫히면 done */
  openFormation(done: () => void): void;
  /** 편성 화면 (취소 가능, 챕터 완성 화면에서 다시 읽기 전) */
  editFormation(): void;
  /** 시도 끝 주관 평가 (§5.10-4, ?playtest=1에서만 표시). 키 = 판 통산 시도 번호 */
  rating(attempt: number): DayRating | null;
  rate<K extends keyof DayRating>(attempt: number, key: K, value: DayRating[K]): void;
  endingAgree(): boolean | null;
  setEndingAgree(v: boolean): void;
}

const DAY_RATINGS: { value: NonNullable<DayRating['day']>; label: string }[] = [
  { value: 'good', label: '좋았다' },
  { value: 'meh', label: '그저 그랬다' },
  { value: 'bad', label: '별로였다' },
];
const RETRY_RATINGS: { value: NonNullable<DayRating['retry']>; label: string }[] = [
  { value: 'again', label: '다시 하고 싶다' },
  { value: 'tired', label: '지친다' },
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
    color: number = COLOR.hud,
  ) {
    const overlay = scene.add.rectangle(0, 0, VIEW_W, VIEW_H, 0x000000, 0.55).setOrigin(0).setDepth(OVERLAY_DEPTH).setInteractive();
    const panel = scene.add
      .rectangle((VIEW_W - PANEL_W) / 2, top, PANEL_W, height, color)
      .setOrigin(0)
      .setStrokeStyle(2, COLOR.mirror)
      .setDepth(OVERLAY_DEPTH + 1);
    this.objects.push(overlay, panel);
    // 스킨 패널 그림 (§5.23-1 ui.panel, 팩이 있을 때만): 패널 위에 깔고 색은 tint로
    const skin = skinOf(scene);
    if (skin.has('ui.panel')) {
      const img = skin.panel(scene, 'ui.panel', VIEW_W / 2, top + height / 2, PANEL_W, height).setTint(color).setDepth(OVERLAY_DEPTH + 1);
      this.objects.push(img);
    }
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

  /** 막·패널을 탭하면 */
  onTap(f: () => void): void {
    (this.objects[0] as Phaser.GameObjects.Rectangle).on('pointerup', f);
    (this.objects[1] as Phaser.GameObjects.Rectangle).setInteractive().on('pointerup', f);
  }

  destroy(): void {
    this.scene.tweens.killTweensOf(this.objects);
    for (const o of this.objects) o.destroy();
    for (const b of this.buttons) b.container.destroy();
  }
}

export class DayUi {
  private modal: Modal | null = null;
  private book: StoryBookView | null = null;
  private shownFor = '';
  /** 자동 넘김 타이머 */
  private timer: Phaser.Time.TimerEvent | null = null;
  /** 판 시작 편성 화면이 떠 있음 */
  private formationOpen = false;

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly state: GameState,
    private readonly data: GameData,
    private readonly hooks: DayUiHooks,
  ) {}

  /** 입력 차단 중 (카드·이야기책·판 시작 편성이 떠 있음) */
  get blocking(): boolean {
    return this.modal !== null || this.book !== null || this.formationOpen;
  }

  /** 매 프레임: 단계에 맞는 카드를 띄운다 */
  sync(): void {
    const s = this.state;
    const key = this.phaseKey();
    if (key === this.shownFor) return;
    this.shownFor = key;
    this.closeModal();
    if (s.phase === 'dayStart') {
      if (!s.formationSeen) {
        // 판 시작: 편성 화면 먼저 (§5.20-2)
        this.formationOpen = true;
        this.hooks.openFormation(() => {
          this.formationOpen = false;
          this.shownFor = '';
        });
      } else this.showSceneCard();
    } else if (s.phase === 'diary') this.showPagePanel();
    else if (s.phase === 'chapterComplete') this.showChapterComplete();
  }

  /** 단계별 카드를 다시 띄울지 판단하는 키 */
  private phaseKey(): string {
    const s = this.state;
    return `${s.phase}:${s.stage}:${s.attempt}:${s.retry}:f${s.formationSeen}`;
  }

  private closeModal(): void {
    this.timer?.remove(false);
    this.timer = null;
    this.modal?.destroy();
    this.modal = null;
  }

  /** ms 뒤 자동으로 f, 탭하면 바로 */
  private auto(m: Modal, ms: number, f: () => void): void {
    let done = false;
    const go = () => {
      if (done) return;
      done = true;
      f();
    };
    m.onTap(go);
    this.timer = this.scene.time.delayedCall(ms, go);
  }

  /**
   * 장면 카드 (§5.19-4, §5.20-12): "1-3 · 셋째 고개" + 여는 글 → 1.5초 뒤 낮. 재도전이면 실패 사유 + retryIntro (1.5초 뒤 자동 재시작).
   */
  private showSceneCard(): void {
    const s = this.state;
    const st = s.stageDef;
    const retry = s.retry;
    const replay = s.replay !== null;
    // 장면 카드 배경 tint (§5.23-2): 스테이지 색을 어둡게 섞은 패널
    const h = (retry ? 196 : 168) + (replay ? 34 : 0);
    const m = new Modal(this.scene, h, (VIEW_H - h) / 2, skinOf(this.scene).fx ? sceneCardColor(s.stage) : COLOR.hud);
    const tries = s.attempts[s.stage - 1];
    const head = replay
      ? `다시 읽기 · 적 ×${this.data.balance.replay.difficultyMult}${retry ? ' · 다시 도전' : ''}`
      : retry
        ? `다시 도전 · ${tries + 1}번째`
        : s.stage === s.chapterLength
          ? '마지막 장'
          : '이야기의 다음 장';
    m.text(16, head, {
      fontSize: '11px',
      color: replay ? '#9fd8ff' : retry ? '#ffb46b' : '#9fb4e0',
    });
    m.text(36, stageLabel(this.data, s.stage), { fontSize: '17px', color: '#f2c94c', fontStyle: 'bold' });
    let y = 70;
    if (retry) {
      m.text(y, FAIL_LINE[retry], { fontSize: '11px', color: '#ff9e9e' });
      y += 26;
    }
    m.text(y, retry ? st.retryIntro : st.intro, { fontSize: '12px', lineSpacing: 4 });
    m.text((retry ? 196 : 168) - 20, '탭하면 바로', { fontSize: '8px', color: '#8a8f9e' });
    // 다시 읽기는 그만두고 이야기책(챕터 완성)으로 돌아갈 수 있다 (§5.22-6)
    if (replay) {
      m.button(VIEW_W / 2, (retry ? 196 : 168) + 12, 140, '그만 읽기', () => {
        this.closeModal();
        if (this.state.exitReplay()) this.hooks.onChange();
      }, '11px', 26);
    }
    this.modal = m;
    this.auto(m, retry ? RETRY_MS : SCENE_MS, () => {
      if (this.state.confirmDay().ok) {
        this.closeModal();
        this.shownFor = this.phaseKey();
        this.hooks.onChange();
      }
    });
  }

  /**
   * 아침 이야기 한 장 (§5.19-4, §5.20-12): 제목·핵·이야기·플레이 한 줄 → 2.5초 뒤 다음 장면 카드. 버튼 없음.
   * ?playtest=1이면 3장마다 평가 줄 (안 눌러도 넘어감).
   */
  private showPagePanel(): void {
    const s = this.state;
    const st = s.stageDef;
    const rec = s.lastAttempt;
    const notes = s.pageNotes[s.stage] ?? [];
    const ratings = showRatings() && rec !== null && s.pages.length % RATE_EVERY === 0;
    const m = new Modal(this.scene, 200 + notes.length * 16 + (ratings ? 64 : 0));
    m.text(16, `${stageLabel(this.data, s.stage)} · 이야기 한 장`, { fontSize: '13px', color: '#f2c94c', fontStyle: 'bold' });
    m.text(38, `◆ ${st.coreName}`, { fontSize: '11px', color: '#ffe08a' });
    const body = m.text(62, st.page, { fontSize: '13px', lineSpacing: 5 });
    let y = 62 + body.height + 12;
    if (notes.length) {
      m.text(y, notes.join('\n'), { fontSize: '10px', color: '#9fb4e0', lineSpacing: 4 });
      y += notes.length * 16 + 8;
    }
    if (ratings) {
      const at = rec!.attempt;
      this.ratingRow(m, y, '이번 장은?', DAY_RATINGS, () => this.hooks.rating(at)?.day ?? null, (v) => this.hooks.rate(at, 'day', v));
      this.ratingRow(m, y + 30, '다시 하기는?', RETRY_RATINGS, () => this.hooks.rating(at)?.retry ?? null, (v) => this.hooks.rate(at, 'retry', v));
    }
    this.modal = m;
    this.auto(m, PAGE_MS, () => {
      if (this.state.nextStage()) this.hooks.onChange();
    });
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
    const t = m.text(y + 8, label, { fontSize: '10px', color: '#9fb4e0' }, 0);
    const w = options.length === 3 ? 62 : 78;
    const x0 = (VIEW_W - PANEL_W) / 2 + Math.max(84, 16 + t.width + 8) + w / 2;
    const buttons = options.map((o, i) =>
      m.button(x0 + i * (w + 4), y + 15, w, o.label, () => {
        pick(o.value);
        buttons.forEach((b, j) => b.setActive(options[j].value === current()));
      }, '9px', 22),
    );
    buttons.forEach((b, j) => b.setActive(options[j].value === current()));
  }

  /**
   * 챕터 완성 화면 (§5.15-5, D-043, §5.19-4·9): 제목, 1-length 이야기 한 장, 완성 문구, 해님·달님 각성(합류한 보상 영웅),
   * 조합법 카드 2장(표시만), 기록(시도 수·영웅 Lv·머지·병사·스킬), [이야기책] [처음부터].
   */
  showChapterComplete(): void {
    this.closeModal();
    const s = this.state;
    const cc = this.data.chapterComplete;
    const last = this.data.stages.stages[this.data.stages.stages.length - 1];
    const agree = showRatings();
    const joined = s.rewardHeroes.filter((h) => s.owned.includes(h.id)).map((h) => h.name);
    const fx = skinOf(this.scene).fx;
    const m = new Modal(this.scene, 96 + 70 + 110 + 112 + (agree ? 34 : 0) + 36 + (joined.length ? 68 : 0) + (fx ? 24 : 0));
    m.text(16, cc.title, { fontSize: '12px', color: '#9fb4e0' });
    const page = m.text(36, last.page, { fontSize: '11px', color: '#e8e8e8', lineSpacing: 4 });
    let y = 36 + page.height + 12;
    const head = m.text(y, cc.doneText, { fontSize: '16px', color: '#f2c94c', fontStyle: 'bold' });
    y += head.height + 10;
    // 해님·달님 각성 (D-057)
    if (joined.length) {
      joined.forEach((nm, i) => {
        const sun = i === 0;
        const cx = VIEW_W / 2 + (i === 0 ? -60 : 60);
        const orb = this.scene.add.circle(cx, m.top + y + 26, 11, sun ? 0xffd36b : 0xe6e9f5).setStrokeStyle(2, sun ? 0xfff1c4 : 0x9fb0e0).setDepth(OVERLAY_DEPTH + 3);
        const cap = text(this.scene, cx, m.top + y + 42, `${nm} — ${sun ? '해님' : '달님'}`, { fontSize: '10px', color: sun ? '#ffe08a' : '#dfe6ff' })
          .setOrigin(0.5, 0)
          .setDepth(OVERLAY_DEPTH + 3);
        m.objects.push(orb, cap);
        this.scene.tweens.add({ targets: orb, y: { from: m.top + y + 40, to: m.top + y + 14 }, duration: 900, delay: 300 * i, ease: 'Sine.easeOut' });
        // 각성 (§5.23-2): 해·달이 하늘 띠로 올라가 자리 잡는다
        if (skinOf(this.scene).fx) {
          this.scene.tweens.add({
            targets: orb,
            x: sun ? VIEW_W * 0.3 : VIEW_W * 0.7,
            y: REGION.sky.y + REGION.sky.h / 2,
            scale: 0.75,
            duration: 1200,
            delay: 1300 + 400 * i,
            ease: 'Sine.easeInOut',
          });
        }
      });
      y += 68;
      if (fx) {
        const names = joined.map((nm, i) => (i < joined.length - 1 ? `${nm}${hasBatchim(nm) ? '과' : '와'}` : nm)).join(' ');
        const jl = m.text(y - 4, fillTemplate('{names}{이/가} 이야기 모험대에 합류했다', { names }), { fontSize: '11px', color: '#ffffff' });
        y += jl.height + 6;
      }
    }
    if (fx) {
      // 비법서 2권 카드 (§5.23-2): 이 챕터 이야기 비법서
      const books = this.data.bookSkills.books.filter((b) => b.source === 'chapter' && b.chapter === this.data.chapter.id).slice(0, 2);
      books.forEach((bk, i) => {
        const cx = VIEW_W / 2 + (books.length > 1 ? (i === 0 ? -72 : 72) : 0);
        const box = this.scene.add.rectangle(cx, m.top + y + 40, 132, 80, 0x2f1d2a).setStrokeStyle(2, 0xffb6c8).setDepth(OVERLAY_DEPTH + 2);
        m.objects.push(box);
        const t = (dy: number, str: string, style: Phaser.Types.GameObjects.Text.TextStyle) => {
          const o = text(this.scene, cx, m.top + y + dy, str, { align: 'center', wordWrap: { width: 120 }, ...style }).setOrigin(0.5, 0).setDepth(OVERLAY_DEPTH + 3);
          m.objects.push(o);
        };
        t(6, `📖 비법서 · ${bk.kind === 'start' ? '시작형' : '상시형'}`, { fontSize: '9px', color: '#ffb6c8' });
        t(22, bk.name, { fontSize: '12px', color: '#ffffff', fontStyle: 'bold' });
        t(42, bk.desc, { fontSize: '8px', color: '#cfd6ea' });
      });
      y += 92;
    } else {
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
    const fails = s.attemptLog.filter((x) => x.result !== 'success').length;
    m.text(y, `1-1 ~ 1-${s.chapterLength} · 도전 ${s.attempt}번 (다시 도전 ${fails}번)`, { fontSize: '11px', color: '#cfd6ea' });
    y += 20;
    const lv = s.roster.map((p) => `${heroName(this.data, p.id)} Lv${p.level}`).join(' · ');
    m.text(y, lv, { fontSize: '10px', color: '#ffe08a' });
    y += 18;
    const skills = Object.values(s.stats.skillCasts).reduce((a, b) => a + b, 0);
    m.text(y, `전투 중 머지 ${s.stats.battleMerges} · 병사 ${s.stats.soldiersSpawned} · 스킬 ${skills} · 5단계 ${s.stats.tier5Made}`, { fontSize: '10px', color: '#9fe0a0' });
    y += 40;
    if (agree) {
      const opts = [
        { value: true, label: '응' },
        { value: false, label: '아니' },
      ];
      this.ratingRow(m, y, '이 챕터의 끝, 납득돼?', opts, () => this.hooks.endingAgree(), (v) => this.hooks.setEndingAgree(v));
      y += 34;
    }
    // 성장 (§5.22): 비법서·흠집 없음, 다시 읽기는 이야기책에서 장을 골라
    const books = s.ownedBooks.map((b) => s.bookDef(b).name).join(' · ');
    m.text(y - 18, `비법서 ${books || '없음'} · ✦ 흠집 없음 ${s.perfect.length}/${s.chapterLength}`, { fontSize: '10px', color: '#ffb6c8' });
    m.text(y, '이야기책에서 장을 골라 [다시 읽기] — 오누이도 함께', { fontSize: '9px', color: '#9fb4e0' });
    const by = y + 34;
    m.button(VIEW_W / 2 - 96, by, 90, '이야기책', () => this.showDiaryList());
    m.button(VIEW_W / 2, by, 90, '편성', () => this.hooks.editFormation());
    let armedAt = -Infinity;
    m.button(VIEW_W / 2 + 96, by, 90, '처음부터', (b) => {
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

  /** 이야기책 (§5.20-8): 양면 책. 열려 있는 동안 자동 넘김은 멈춘다 */
  showDiaryList(): void {
    if (this.book) return;
    if (this.timer) this.timer.paused = true;
    this.book = new StoryBookView(
      this.scene,
      this.state,
      this.data,
      () => {
        this.book = null;
        if (this.timer) this.timer.paused = false;
      },
      // 다시 읽기 (§5.22-6): 그 장 하나를 장면 카드부터
      (stage) => {
        if (this.state.startReplay(stage)) this.hooks.onChange();
      },
    );
  }
}
