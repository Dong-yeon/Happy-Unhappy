// 스테이지 UI (§5.19, §5.15): 장면 카드(탭하면 시작, 재도전이면 실패 사유 + retryIntro)·갈림길, 이야기 한 장(아침),
// 이야기책(펼친 장), 영웅 배정(1-1, [11]-3), 챕터 완성 화면.
// 도형 + 텍스트만. 상태는 core(GameState)에서 읽고, 버튼은 core 메서드·hooks만 호출한다.
import Phaser from 'phaser';
import type { GameState, Role } from '../core/game';
import type { GameData } from '../data/types';
import { showRatings } from '../debug/gridPreset';
import type { DayRating } from '../metrics/model';
import { VIEW_H, VIEW_W } from './layout';
import { FAIL_LINE, chainShort, stageLabel } from './labels';
import { heroName } from './laneUnits';
import { Button, COLOR, text } from './ui';

const OVERLAY_DEPTH = 60;
const PANEL_W = 300;

export interface DayUiHooks {
  /** core 상태가 바뀐 뒤 (그리드·HUD 갱신) */
  onChange(): void;
  /** [처음부터] (두 번 탭 확인 뒤) */
  onRestart(): void;
  /** 시도 끝 주관 평가 (§5.10-4, ?debug=1·?playtest=1에서만 표시). 키 = 판 통산 시도 번호 */
  rating(attempt: number): DayRating | null;
  rate<K extends keyof DayRating>(attempt: number, key: K, value: DayRating[K]): void;
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
  /** 1-1 영웅 배정 화면을 이 세션에서 넘겼는지 (core가 첫 카드를 닫으면 잠근다) */
  private assignSeen = false;
  /** 갈림길에서 고른 선택지 (장면 카드를 닫을 때 confirmDay에 넘긴다) */
  private crossChoice: string | null = null;

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly state: GameState,
    private readonly data: GameData,
    private readonly hooks: DayUiHooks,
  ) {}

  /** 입력 차단 중 (모달·이야기책이 떠 있음) */
  get blocking(): boolean {
    return this.modal !== null || this.diaryList !== null;
  }

  /** 매 프레임: 단계에 맞는 모달을 띄운다 */
  sync(): void {
    const s = this.state;
    const key = this.phaseKey();
    if (key === this.shownFor) return;
    this.shownFor = key;
    this.closeModal();
    if (s.phase === 'dayStart') {
      if (!s.assignmentDone && !this.assignSeen) this.showAssign(); // 1-1 카드보다 먼저 ([11]-3)
      else if (s.crossroad && this.crossChoice === null) this.showCrossroad();
      else this.showSceneCard();
    } else if (s.phase === 'diary') this.showPagePanel();
    else if (s.phase === 'chapterComplete') this.showChapterComplete();
  }

  /** 단계별 모달을 다시 띄울지 판단하는 키 */
  private phaseKey(): string {
    const s = this.state;
    return `${s.phase}:${s.stage}:${s.attempt}:${s.retry}:${s.pendingCrossroad}:a${this.assignSeen}:c${this.crossChoice}`;
  }

  private closeModal(): void {
    this.modal?.destroy();
    this.modal = null;
  }

  /**
   * 장면 카드 (§5.19-4): "1-3 · 셋째 고개" + 여는 글. 재도전이면 실패 사유 + retryIntro. 탭(어디든)하면 낮 시작.
   * 갈림길 선택이 있으면 그 선택과 함께 confirmDay.
   */
  private showSceneCard(): void {
    const s = this.state;
    const st = s.stageDef;
    const retry = s.retry;
    const m = new Modal(this.scene, retry ? 232 : 200);
    const tries = s.attempts[s.stage - 1];
    m.text(16, retry ? `다시 도전 · ${tries + 1}번째` : s.stage === s.chapterLength ? '마지막 장' : '이야기의 다음 장', {
      fontSize: '11px',
      color: retry ? '#ffb46b' : '#9fb4e0',
    });
    m.text(36, stageLabel(this.data, s.stage), { fontSize: '17px', color: '#f2c94c', fontStyle: 'bold' });
    let y = 70;
    if (retry) {
      m.text(y, FAIL_LINE[retry], { fontSize: '11px', color: '#ff9e9e' });
      y += 26;
    }
    m.text(y, retry ? st.retryIntro : st.intro, { fontSize: '12px', lineSpacing: 4 });
    const confirm = () => {
      if (this.state.confirmDay(this.crossChoice ?? undefined).ok) {
        this.crossChoice = null;
        this.closeModal();
        this.shownFor = this.phaseKey();
        this.hooks.onChange();
      }
    };
    // 탭하면 넘김: 막 전체 + [시작]
    (m.objects[0] as Phaser.GameObjects.Rectangle).on('pointerup', confirm);
    (m.objects[1] as Phaser.GameObjects.Rectangle).setInteractive().on('pointerup', confirm);
    m.button(VIEW_W / 2, (retry ? 232 : 200) - 34, 140, '☀ 낮으로', confirm);
    this.modal = m;
  }

  /** 갈림길 (§5.15, 1-turningPoint 성공 다음 장면 카드): 두 선택 버튼 → 고르면 장면 카드 */
  private showCrossroad(): void {
    const s = this.state;
    const c = s.crossroad!;
    const m = new Modal(this.scene, 250);
    m.text(16, `갈림길 · 1-${s.stage - 1}를 지나`, { fontSize: '11px', color: '#9fb4e0' });
    m.text(36, c.title, { fontSize: '17px', color: '#f2c94c', fontStyle: 'bold' });
    m.text(70, c.text, { fontSize: '12px', lineSpacing: 4 });
    s.choices.forEach((ch, i) =>
      m.button(VIEW_W / 2, 164 + i * 40, 286, ch.label, () => {
        this.crossChoice = ch.id;
        this.closeModal();
      }, '11px'),
    );
    this.modal = m;
  }

  /**
   * 영웅 배정 (1-1 dayStart, [11]-3): 삽살·해태(모험대)를 낮덱(오펜스)·밤덱(디펜스)에 하나씩. 기본은 heroes.json(+ start.swapHeroes).
   * 양쪽 최소 1명이라 고르는 것은 "누가 낮에 나가는가" 하나. [이대로 시작] → 장면 카드. 판 중 변경은 M8.11.
   */
  private showAssign(): void {
    const s = this.state;
    const m = new Modal(this.scene, 268);
    m.text(16, '1-1 · 판 시작', { fontSize: '11px', color: '#9fb4e0' });
    m.text(34, '누가 낮에 나갈까?', { fontSize: '17px', color: '#f2c94c', fontStyle: 'bold' });
    m.text(64, '낮덱 = 해가 있는 동안 동화의 핵을 찾아 돌아옴 (오펜스)\n밤덱 = 몰려오는 무리로부터 핵을 지킴 (디펜스)', {
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
    // heroes.json 순서 (모험대 삽살 → 해태, 보상 영웅 제외)
    const order = this.data.heroes.heroes.map((h) => h.id).filter((id) => ids.includes(id));
    const opts = order.map((offId) => ({ offId, btn: null as Button | null }));
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

  /** 아침 이야기 한 장 (§5.19-4): 펼친 장 문구 + 이번 스테이지 기록 + [다음 이야기] [이야기책] [추억 조합] */
  private showPagePanel(): void {
    const s = this.state;
    const st = s.stageDef;
    const rec = s.lastAttempt;
    const ratings = showRatings() && rec !== null;
    const extra = ratings ? 68 : 0;
    const m = new Modal(this.scene, 250 + extra);
    m.text(16, `${stageLabel(this.data, s.stage)} · 이야기 한 장`, { fontSize: '13px', color: '#f2c94c', fontStyle: 'bold' });
    m.text(38, `◆ ${st.coreName}`, { fontSize: '11px', color: '#ffe08a' });
    m.text(62, st.page, { fontSize: '13px', lineSpacing: 5 });
    const tries = s.attempts[s.stage - 1];
    if (rec) {
      m.text(150, `${tries}번째 도전에 펼침 · 핵 ${Math.ceil(rec.coreHpEnd ?? 0)}/${this.data.balance.core.hp} 지킴 · 처치 ${rec.defeated}`, {
        fontSize: '10px',
        color: '#8a8f9e',
      });
    }
    // 주관 평가 (선택 안 해도 넘어갈 수 있음)
    if (ratings) {
      const at = rec!.attempt;
      this.ratingRow(m, 172, '이번 장은?', DAY_RATINGS, () => this.hooks.rating(at)?.day ?? null, (v) => this.hooks.rate(at, 'day', v));
      this.ratingRow(m, 204, '다시 하기는?', RETRY_RATINGS, () => this.hooks.rating(at)?.retry ?? null, (v) => this.hooks.rate(at, 'retry', v));
    }
    const by = 204 + extra;
    m.button(VIEW_W / 2 - 94, by, 86, '다음 이야기', () => {
      if (this.state.nextStage()) this.hooks.onChange();
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
   * 챕터 완성 화면 (§5.15-5, D-043, §5.19-4·9): 제목, 1-length 이야기 한 장("…누이와 오라비가 이야기 모험대에 합류했다"), 완성 문구,
   * 해님·달님 각성(합류한 보상 영웅),
   * 조합법 카드 2장(해·달, 표시만 — 조합표에는 추가하지 않음), 기록(시도 수·영웅 둘의 떡/동아줄 점수·먹이기·병사), [이야기책] [처음부터].
   */
  showChapterComplete(): void {
    this.closeModal();
    const s = this.state;
    const cc = this.data.chapterComplete;
    const last = this.data.stages.stages[this.data.stages.stages.length - 1];
    const agree = showRatings();
    const m = new Modal(this.scene, 96 + 70 + 110 + 112 + (agree ? 34 : 0) + 26 + (s.joinedHeroes.length ? 68 : 0));
    m.text(16, cc.title, { fontSize: '12px', color: '#9fb4e0' });
    const page = m.text(36, last.page, { fontSize: '11px', color: '#e8e8e8', lineSpacing: 4 });
    let y = 36 + page.height + 12;
    const head = m.text(y, cc.doneText, { fontSize: '16px', color: '#f2c94c', fontStyle: 'bold' });
    y += head.height + 10;
    // 해님·달님 각성 (D-057): 합류한 보상 영웅 = 해(낮)·달(밤) 원이 떠오른다
    const joined = s.joinedHeroes.map((id) => heroName(this.data, id));
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
      });
      y += 68;
    }
    {
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

  /** 이야기책: 펼친 장 목록 (스테이지 · 제목 · 이야기 한 장). 드래그·휠로 스크롤만 */
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
    const pages = this.state.pages;
    if (pages.length === 0) {
      list.add(text(scene, x0, 0, '아직 펼친 장이 없다.', { fontSize: '12px', color: '#8a8f9e' }));
    }
    for (const n of pages) {
      const st = this.data.stages.stages[n - 1];
      const head = text(scene, x0, y, `${stageLabel(this.data, n)} · ◆ ${st.coreName}`, { fontSize: '11px', color: '#9fb4e0' });
      const body = text(scene, x0, y + 16, st.page, {
        fontSize: '12px',
        wordWrap: { width: VIEW_W - x0 * 2 },
        lineSpacing: 3,
        color: '#e8e8e8',
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
