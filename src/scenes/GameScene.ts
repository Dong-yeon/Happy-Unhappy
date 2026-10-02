import Phaser from 'phaser';
import type { GameData } from '../data/types';
import type { CoreEvent, GameState } from '../core/game';
import type { GridSize } from '../core/grid';
import { createDebugPanel } from '../debug/DebugPanel';
import { showDebugUi } from '../debug/gridPreset';
import { MetricsRecorder } from '../metrics/recorder';
import { AbyssLaneView } from './AbyssLaneView';
import { DayUi } from './DayUi';
import { DefenseLaneView } from './DefenseLaneView';
import { WellView, type DragHover } from './WellView';
import { FormationView } from './FormationView';
import { SkillButtonsView } from './SkillButtonsView';
import { ReleaseZoneView } from './ReleaseZoneView';
import { SaveSession } from './session';
import { SkyView } from './SkyView';
import { stageLabel } from './labels';
import { NAME_BAND_Y, REGION, VIEW_W, skyArc, toScreen, type Rect } from './layout';
import { Button, COLOR, setupCamera, text } from './ui';
import { nowMs } from '../platform/clock';
import { skinOf } from './skin/Skin';
import { enemyName } from '../core/game';
import type { Role } from '../core/game';

/** 한 프레임에 넘기는 시간 상한 (백그라운드 복귀 직후 몰아서 처리하지 않도록) */
const MAX_FRAME_MS = 100;

/**
 * M8.10: 스테이지 = 장면 카드 → 낮(핵 찾아 돌아오기) → 밤(핵 지키기) → 이야기 한 장 (§5.19, D-053).
 * §5.20-13 화면: HUD(스테이지·시도 / [자동] [편성] [책]) + 해·달 띠 + 전장(가로 레인 하나) + 머지 판(원형 조각, 경계의 원형 스킬 버튼)
 * + 놓아주기 칸. 조각 생성 버튼·기쁨은 없다 (저절로 + 처치 드롭). + 경계 저장/복원 (§5.19-7), metrics (§5.10).
 * 게임 규칙은 core(GameState)에서, 이 씬은 표시·입력만.
 */
export class GameScene extends Phaser.Scene {
  private state!: GameState;
  private session!: SaveSession;
  private metrics!: MetricsRecorder;
  private wellView!: WellView;
  private autoBtn!: Button;
  private inkText!: Phaser.GameObjects.Text;
  /** 잉크 시간 누적을 다시 계산할 때까지 (ms) */
  private inkTick = 0;
  private releaseZone!: ReleaseZoneView;
  private laneView!: DefenseLaneView;
  private abyssView!: AbyssLaneView;
  private dayUi!: DayUi;
  private retryText!: Phaser.GameObjects.Text;
  private skills!: SkillButtonsView;
  private formationView: FormationView | null = null;
  private sky!: SkyView;
  /** 땅 띠가 지금 보여주는 단계 (전환 연출 중에는 core 단계와 다를 수 있다) */
  private groundShown: 'day' | 'night' = 'day';
  private phaseText!: Phaser.GameObjects.Text;
  /** 디버그 배속 (dt 배율) */
  private speed = 1;

  constructor() {
    super('Game');
  }

  create(): void {
    setupCamera(this);
    const data = this.registry.get('data') as GameData;
    const size = this.registry.get('gridSize') as GridSize;
    // 저장 복원(경계) 또는 새 판 (?seed= 가 있으면 그 시드)
    this.session = new SaveSession(data, size);
    this.state = this.session.boot();
    // metrics (§5.10): 관찰만. 판 도중 복원 감지는 생성 시
    this.metrics = new MetricsRecorder(this.state, size);

    // 잉크 (§5.22-2): 자리를 비운 동안 쌓인 만큼 (저장된 마지막 시각 → 지금)
    const away = this.state.accrueInk(nowMs());
    this.drawHud(data);
    this.sky = new SkyView(this, this.state);
    this.drawGrid(size);
    this.skills = new SkillButtonsView(this, this.state, data, data.balance.team.teamSize);
    this.drawBottomBar();
    this.laneView = new DefenseLaneView(this, this.state, data);
    this.abyssView = new AbyssLaneView(this, this.state, data);
    this.wellView = new WellView(this, this.state, data, {
      onChange: () => this.syncUi(),
      onHover: (hover) => this.onDragHover(hover),
      onDrag: (active) => this.releaseZone.setDragging(active),
      canInteract: () => this.canAct(),
      onDropResult: (fail, distance) => this.metrics.drop(fail, distance),
    });
    this.showGround(this.state.phase === 'night' ? 'night' : 'day');
    this.dayUi = new DayUi(this, this.state, data, {
      onChange: () => this.onDebugChange(),
      onRestart: () => this.restartLife(),
      openFormation: (done) => this.openFormation(false, done),
      editFormation: () => this.openFormation(true),
      rating: (attempt) => this.metrics.rating(attempt),
      rate: (attempt, key, value) => this.metrics.rate(attempt, key, value),
      endingAgree: () => this.metrics.endingAgree,
      setEndingAgree: (v) => this.metrics.setEndingAgree(v),
    });
    // metrics 세션 시간 쓰기: 숨겨질 때 (§5.10-3)
    const onVisible = () => {
      if (document.visibilityState !== 'visible') this.metrics.onHidden();
    };
    document.addEventListener('visibilitychange', onVisible);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => document.removeEventListener('visibilitychange', onVisible));
    if (showDebugUi()) {
      // 디버그 전용 (?playtest=1이면 숨김): 브라우저 콘솔에서 core 상태를 들여다보기 (?debug=1일 때만)
      (window as unknown as { __hauState?: GameState }).__hauState = this.state;
      (window as unknown as { __hauGame?: Phaser.Game }).__hauGame = this.game;
      createDebugPanel(this, data, this.state, this.session, size, {
        setSpeed: (s) => (this.speed = s),
        onChange: () => this.onDebugChange(),
        openDiary: () => this.dayUi.showDiaryList(),
        reboot: () => this.scene.start('Boot'),
        metrics: this.metrics,
      });
    }
    this.wellView.refresh();
    this.syncUi();
    if (away >= 1) this.time.delayedCall(400, () => this.banner(`✒ 자리를 비운 동안 잉크 +${Math.floor(away)}`, '#9fd8ff'));
  }

  /**
   * 편성 화면 (§5.20-2): 판 시작(취소 없음) / HUD [편성]. 전투 밖에서 확정하면 경계라 바로 저장,
   * 전투 중 확정하면 core가 그 단계를 스냅샷으로 되돌려 다시 (formationRestart 이벤트).
   */
  private openFormation(cancellable: boolean, done?: () => void): void {
    if (this.formationView?.isOpen) return;
    this.wellView.cancel();
    const data = this.registry.get('data') as GameData;
    this.formationView = new FormationView(this, this.state, data, () => {
      this.formationView = null;
      const p = this.state.phase;
      if (p === 'dayStart' || p === 'diary' || p === 'chapterComplete') this.session.saveGame(this.state);
      this.wellView.refresh();
      done?.();
      this.syncUi();
    }, cancellable);
  }

  /** [처음부터]: 새 판 → 다시 부팅하면 새 시드로 만들고 장면 카드 저장 */
  private restartLife(): void {
    this.session.resetGame();
    this.scene.start('Boot');
  }

  /**
   * 경계 저장 (§5.19-7): 장면 카드(스테이지 시작·실패 직후) / 이야기 한 장 / 챕터 완성 진입 → game.
   * 이벤트를 처리하는 시점에 경계 단계가 아니면(같은 프레임에 다음 단계로 넘어간 경우) 건너뛴다.
   */
  private persist(events: CoreEvent[]): void {
    const boundary = this.state.phase === 'dayStart' || this.state.phase === 'diary' || this.state.phase === 'chapterComplete';
    let save = false;
    for (const e of events) {
      if (e.type === 'attemptFail' || e.type === 'stageClear') this.metrics.endAttempt(e.record);
      if (e.type === 'stageStart' || e.type === 'stageClear' || e.type === 'chapterComplete') save = true;
      if (e.type === 'chapterComplete') this.metrics.chapterEnd();
      else if (e.type === 'dayBegin') this.metrics.beginAttempt();
    }
    if (save && boundary) this.session.saveGame(this.state);
  }

  update(_time: number, delta: number): void {
    const dt = Math.min(delta, MAX_FRAME_MS) / 1000;
    // 낮 → 밤 전환 연출(1.5초)·편성 화면 동안은 게임 시간을 멈춘다
    const paused = this.sky.transitioning || this.formationView !== null;
    // metrics 실제 시간: 배속을 곱하지 않은 프레임 시간 (백그라운드 동안은 프레임이 멈춘다)
    this.metrics.frame(paused ? 0 : dt, this.speed);
    // 켜져 있는 동안도 잉크가 쌓인다 (1초마다 실제 시각으로)
    this.inkTick -= delta;
    if (this.inkTick <= 0) {
      this.inkTick = 1000;
      this.state.accrueInk(nowMs());
    }
    const events = this.state.tick(paused ? 0 : dt * this.speed);
    this.persist(events);
    this.onPhaseEvents(events);
    this.laneView.handle(events);
    this.abyssView.handle(events);
    this.onMergeEvents(events);
    this.onFxEvents(events);
    this.wellView.handle(events);
    this.wellView.update(delta);
    this.skills.handle(events);
    // 지급 조각(와일드카드)·편성 재시작(그리드 되돌림)은 core에서 이미 그리드에 반영됐다
    const gridEvents = ['bossReward', 'formationRestart'];
    if (events.some((e) => gridEvents.includes(e.type))) this.wellView.refresh();
    this.laneView.sync();
    this.abyssView.sync();
    this.skills.sync();
    this.sky.sync();
    this.dayUi.sync();
    this.syncUi();
  }

  /**
   * 전투 중 머지 (§5.17-3, [11]-5): 때 맞춤이면 해(낮)/달(밤) 반짝임 + "+50%" 1초.
   * 버프·병사 이벤트가 같은 머지에서 둘 다 오므로 머지 칸 기준으로 한 번만.
   */
  private onMergeEvents(events: CoreEvent[]): void {
    const cells = new Set<number>();
    for (const e of events) {
      if ((e.type === 'buff' || e.type === 'soldier') && e.affinity && !cells.has(e.cell)) {
        cells.add(e.cell);
        this.affinityFlash(e.role);
      }
    }
  }

  private affinityFlash(role: Role): void {
    const data = this.registry.get('data') as GameData;
    const pct = Math.round((data.balance.merge.affinityMult - 1) * 100);
    const p = skyArc(0.5);
    const at = { x: p.x, y: REGION.sky.y + REGION.sky.h / 2 };
    const ring = this.add.circle(at.x, at.y, 14, role === 'offense' ? COLOR.happy : 0xe6e9f5, 0.5).setDepth(30);
    this.tweens.add({ targets: ring, scale: 2, alpha: 0, duration: 600, onComplete: () => ring.destroy() });
    const t = text(this, at.x, at.y + 18, `+${pct}%`, { fontSize: '12px', color: role === 'offense' ? '#ffe08a' : '#dfe6ff', fontStyle: 'bold' })
      .setOrigin(0.5)
      .setDepth(31);
    this.tweens.add({ targets: t, y: at.y + 8, alpha: 0, delay: 600, duration: 400, onComplete: () => t.destroy() });
  }

  /**
   * 레인 연출 (§5.20): 스킬 이름 (영웅 위로 떠오름) / 5단계 특별 버프 (하늘 띠 번쩍 + "한낮!"·"보름달!") /
   * 팀 교대 ("2팀 출발") / 편성 재시작 ("편성이 바뀌어 처음부터").
   */
  private onFxEvents(events: CoreEvent[]): void {
    const data = this.registry.get('data') as GameData;
    for (const e of events) {
      if (e.type === 'skill') {
        const lane = e.role === 'offense' ? this.state.abyss : this.state.defense;
        const u = lane.units.find((x) => x.id === e.unitId);
        const p = u ? toScreen(e.role === 'offense' ? 'abyss' : 'defense', u.x, u.y) : { x: VIEW_W / 2, y: REGION.ground.y + 40 };
        const t = text(this, p.x, p.y - 16, `${e.name}!`, { fontSize: '11px', color: '#9fe0ff', fontStyle: 'bold', backgroundColor: '#1b1d24', padding: { x: 3, y: 1 } })
          .setOrigin(0.5)
          .setDepth(40);
        this.tweens.add({ targets: t, y: p.y - 40, alpha: 0, delay: 500, duration: 500, onComplete: () => t.destroy() });
      } else if (e.type === 'special') {
        const noon = e.kind === 'noon';
        const sky = REGION.sky;
        const flash = this.add.rectangle(sky.x, sky.y, sky.w, sky.h + REGION.ground.h, noon ? 0xffe08a : 0xdfe6ff, 0.35).setOrigin(0).setDepth(35);
        this.tweens.add({ targets: flash, alpha: 0, duration: 700, onComplete: () => flash.destroy() });
        this.banner(noon ? '☀ 한낮! 우리 편 공격 +' : '☾ 보름달! 적이 멈춘다', noon ? '#ffe08a' : '#dfe6ff');
      } else if (e.type === 'teamSwap') {
        this.banner(`${e.role === 'offense' ? '☀' : '☾'} ${e.team + 1}팀 출발`, '#ffffff');
      } else if (e.type === 'formationRestart') {
        this.banner('편성이 바뀌어 처음부터', '#ffb46b');
      } else if (e.type === 'dayBegin' && this.state.stageDef.day.boss && skinOf(this).fx) {
        // 1-5 털장갑 손 / 1-10 성난 호랑이 그림자: 등장 이름 띠 1초 (§5.23-2)
        this.nameBand(enemyName(data, this.state.stageDef.day.guardian));
      } else if (e.type === 'spawnWorry' && e.boss && skinOf(this).fx && this.bossBandAt !== this.state.attempt) {
        this.bossBandAt = this.state.attempt;
        this.nameBand(enemyName(data, e.enemy));
      } else if (e.type === 'stageReward') {
        this.banner(`첫 클리어 · 잉크 +${e.ink} · 별가루 +${e.dust}`, '#ffe08a');
      } else if (e.type === 'booksGained') {
        this.banner(`비법서: ${e.ids.map((b) => this.state.bookDef(b).name).join(' · ')}`, '#ffb6c8');
      } else if (e.type === 'bookSkill') {
        const u = this.state.heroUnit(e.heroId);
        const lane = e.role === 'offense' ? 'abyss' : 'defense';
        const p = u ? toScreen(lane, u.x, u.y) : { x: VIEW_W / 2, y: REGION.ground.y + 60 };
        const t = text(this, p.x, p.y - 28, `📖 ${this.state.bookDef(e.bookId).name}`, { fontSize: '10px', color: '#ffb6c8', backgroundColor: '#1b1d24', padding: { x: 3, y: 1 } })
          .setOrigin(0.5)
          .setDepth(40);
        this.tweens.add({ targets: t, y: p.y - 50, alpha: 0, delay: 700, duration: 500, onComplete: () => t.destroy() });
      } else if (e.type === 'replayEnd' && e.success) {
        this.banner(`다시 읽기 성공 · 잉크 +${e.ink}${e.perfect ? ' · 흠집 없음 ✦' : ''}`, '#9fd8ff');
      } else if (e.type === 'levelUp') {
        void data;
      }
    }
  }

  /** 땅 띠 위쪽 한 줄 알림 (1.2초) */
  private banners = 0;
  /** 밤 보스 이름 띠를 보여 준 시도 (한 번만) */
  private bossBandAt = -1;

  /** 보스 등장 이름 띠 1초: 전장 가운데 어두운 띠 + 이름 */
  private nameBand(name: string): void {
    // 레인 위쪽 (보스 몸·HP 막대와 겹치지 않게)
    const y = NAME_BAND_Y;
    const band = this.add.rectangle(VIEW_W / 2, y, VIEW_W, 34, 0x0e0a14, 0.82).setDepth(45).setScale(1, 0);
    const t = text(this, VIEW_W / 2, y, name, { fontSize: '16px', color: '#ff9e9e', fontStyle: 'bold' }).setOrigin(0.5).setDepth(46).setAlpha(0);
    this.tweens.add({ targets: band, scaleY: 1, duration: 140 });
    this.tweens.add({ targets: t, alpha: 1, duration: 140 });
    this.time.delayedCall(1000, () => {
      this.tweens.add({ targets: [band, t], alpha: 0, duration: 200, onComplete: () => (band.destroy(), t.destroy()) });
    });
  }

  /** 같은 때 여러 줄이면 아래로 쌓는다 (보상·비법서·흠집 없음이 한꺼번에 오므로 조금 더 오래) */
  private banner(msg: string, color: string): void {
    const g = REGION.ground;
    const k = this.banners++;
    const t = text(this, g.x + g.w / 2, g.y + 34 + k * 24, msg, { fontSize: '13px', color, fontStyle: 'bold', backgroundColor: '#1b1d24cc', padding: { x: 6, y: 3 } })
      .setOrigin(0.5)
      .setDepth(70); // 장면 카드·결과 막(60) 위, 편성 화면(80) 아래 — 부팅 때 잉크 알림이 장면 카드에 가리지 않게
    this.tweens.add({
      targets: t,
      alpha: 0,
      delay: 1400,
      duration: 300,
      onComplete: () => {
        t.destroy();
        this.banners = Math.max(0, this.banners - 1);
      },
    });
  }

  /** 낮/밤 전환: 해질녘 → 1.5초 연출 (절반에서 땅 띠 교체) / 장면 카드(스테이지 시작·실패 뒤) → 낮 */
  private onPhaseEvents(events: CoreEvent[]): void {
    for (const e of events) {
      if (e.type === 'dusk') {
        this.wellView.cancel();
        this.sky.dusk(
          () => this.showGround('night'),
          () => this.syncUi(),
        );
      } else if (e.type === 'stageStart' || e.type === 'dayBegin') {
        this.wellView.cancel();
        if (this.groundShown !== 'day' || this.sky.mode !== 'day') {
          this.sky.setMode('day');
          this.showGround('day');
        }
      }
    }
  }

  /** 땅 띠 내용 교체 (낮 = 핵 찾아 돌아오기, 밤 = 핵 지키기) */
  private showGround(which: 'day' | 'night'): void {
    this.groundShown = which;
    this.abyssView.setShown(which === 'day');
    this.laneView.setShown(which === 'night');
    if (which === 'night' && !this.sky.transitioning) this.sky.setMode('night');
  }

  /** 그리드·버튼 입력 가능: 낮·밤 + 모달·편성 화면 없음 + 전환 연출 아님 */
  private canAct(): boolean {
    return this.state.timeFlows && !this.dayUi.blocking && !this.sky.transitioning && this.formationView === null;
  }

  private onDragHover(hover: DragHover): void {
    this.releaseZone.setHover(hover?.kind === 'release' ? hover.hover : null);
  }

  private onDebugChange(): void {
    this.wellView.refresh();
    this.syncUi();
  }

  /** core 상태 → HUD·버튼 */
  private syncUi(): void {
    const s = this.state;
    const data = this.registry.get('data') as GameData;
    // HUD (§5.19-1, §5.20-13): "1-3 · 셋째 고개", 아래 줄에 시도 수 (재도전이면 "다시 도전 · n번째")
    const phase = s.phase === 'chapterComplete' ? '이야기 끝' : stageLabel(data, s.stage);
    if (this.phaseText.text !== phase) this.phaseText.setText(phase);
    const tries = s.attempts[s.stage - 1] + (s.phase === 'dayStart' ? 1 : 0);
    const retry = (s.phase === 'dayStart' && s.retry !== null) || ((s.phase === 'day' || s.phase === 'night') && s.attempts[s.stage - 1] > 1);
    const tag =
      s.phase === 'chapterComplete' || s.phase === 'diary'
        ? ''
        : s.replay !== null
          ? `다시 읽기${s.retry ? ' · 다시 도전' : ''}`
          : `${retry ? '다시 도전 · ' : ''}${tries}번째 시도${s.wave.paused ? ' (웨이브 정지)' : ''}`;
    if (this.retryText.text !== tag) this.retryText.setText(tag).setColor(retry ? '#ffb46b' : '#9aa1b5');
    this.autoBtn.setLabel(s.autoSkill ? '자동' : '수동').setActive(s.autoSkill);
    // 잉크 (§5.22-2): [자동][편성][책] 왼쪽 아래 줄, 상한 근처면 반짝
    const ink = `✒ 잉크 ${Math.floor(s.ink)}`;
    if (this.inkText.text !== ink) this.inkText.setText(ink);
    const near = s.ink >= s.inkCap * 0.9;
    this.inkText.setAlpha(near ? 0.6 + 0.4 * Math.abs(Math.sin(this.time.now / 250)) : 1).setColor(near ? '#ffffff' : '#9fd8ff');
  }

  private fill(r: Rect, color: number): Phaser.GameObjects.Rectangle {
    return this.add.rectangle(r.x, r.y, r.w, r.h, color).setOrigin(0);
  }

  /** HUD (§5.20-13): 왼쪽 스테이지명·시도 / 오른쪽 [자동] [편성] [책] 작은 버튼 */
  private drawHud(_data: GameData): void {
    const r = REGION.hud;
    this.fill(r, COLOR.hud);
    const midY = r.y + r.h / 2;
    this.phaseText = text(this, 8, midY - 7, '', { fontSize: '11px' }).setOrigin(0, 0.5);
    this.retryText = text(this, 8, midY + 8, '', { fontSize: '9px', color: '#9aa1b5' }).setOrigin(0, 0.5);
    const bw = 44;
    const gap = 4;
    const x3 = VIEW_W - 6 - bw / 2;
    // [자동] 스킬 자동/수동 (§5.20-13). 끄면 원형 스킬 버튼 탭 = 발동
    this.autoBtn = new Button(this, x3 - (bw + gap) * 2, midY, bw, 24, '자동', () => this.state.setAutoSkill(!this.state.autoSkill), '11px');
    // [편성] 언제든 (§5.20-2). 추억 조합 버튼은 삭제 (§5.20-12)
    const f = new Button(this, x3 - (bw + gap), midY, bw, 24, '편성', () => {
      if (!this.dayUi.blocking) this.openFormation(true);
    }, '11px');
    // [책] 이야기책 (§5.20-8)
    const b = new Button(this, x3, midY, bw, 24, '책', () => {
      if (!this.dayUi.blocking) this.dayUi.showDiaryList();
    }, '11px');
    for (const x of [this.autoBtn, f, b]) x.container.setDepth(8);
    // 잉크 수 (§5.22-2): [자동] 왼쪽, 아래 줄
    this.inkText = text(this, x3 - (bw + gap) * 2 - bw / 2 - 6, midY + 8, '', { fontSize: '10px', color: '#9fd8ff' }).setOrigin(1, 0.5).setDepth(8);
  }

  /** 머지 판 = 이야기 우물 (§5.21): 둥근 테 우물, 칸·자리 표시 없음 */
  private drawGrid(_size: GridSize): void {
    WellView.drawWell(this);
  }

  /** 놓아주기: 우물 오른쪽 아래 안쪽 모서리의 🍃 잎사귀 원 (하단 칸은 삭제) */
  private drawBottomBar(): void {
    this.releaseZone = new ReleaseZoneView(this);
  }
}
