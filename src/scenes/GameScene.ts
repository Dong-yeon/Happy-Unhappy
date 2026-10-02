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
import { GridView, type DragHover } from './GridView';
import { HeroSlotView } from './HeroSlotView';
import { ReleaseZoneView } from './ReleaseZoneView';
import { SaveSession } from './session';
import { SkyView } from './SkyView';
import { stageLabel } from './labels';
import { REGION, VIEW_W, gridLayout, skyArc, type Rect } from './layout';
import { Button, COLOR, setupCamera, text } from './ui';
import type { Role } from '../core/game';

/** 한 프레임에 넘기는 시간 상한 (백그라운드 복귀 직후 몰아서 처리하지 않도록) */
const MAX_FRAME_MS = 100;

/**
 * M8.10: 스테이지 = 장면 카드 → 낮(핵 찾아 돌아오기) → 밤(핵 지키기) → 이야기 한 장 (§5.19, D-053).
 * 화면은 가로 레인 하나 + 하늘 띠(해/달) + 영웅 슬롯 두 칸(먹이기). + 경계 저장/복원 (§5.19-7), metrics (§5.10).
 * 게임 규칙은 core(GameState)에서, 이 씬은 표시·입력만.
 */
export class GameScene extends Phaser.Scene {
  private state!: GameState;
  private session!: SaveSession;
  private metrics!: MetricsRecorder;
  private gridView!: GridView;
  private joyText!: Phaser.GameObjects.Text;
  private spawnBtn!: Button;
  private releaseZone!: ReleaseZoneView;
  private laneView!: DefenseLaneView;
  private abyssView!: AbyssLaneView;
  private dayUi!: DayUi;
  private retryText!: Phaser.GameObjects.Text;
  private slots!: Record<Role, HeroSlotView>;
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

    this.drawHud(data);
    this.sky = new SkyView(this, this.state);
    this.fill(REGION.portalBase, COLOR.grid);
    this.drawGrid(size);
    this.slots = {
      offense: new HeroSlotView(this, this.state, data, 'offense'),
      defense: new HeroSlotView(this, this.state, data, 'defense'),
    };
    this.drawBottomBar();
    this.laneView = new DefenseLaneView(this, this.state, data, { x: this.joyText.x, y: this.joyText.y });
    this.abyssView = new AbyssLaneView(this, this.state, data);
    this.drawRecipeButton();
    this.gridView = new GridView(this, this.state, data, {
      onChange: () => this.syncUi(),
      onHover: (hover) => this.onDragHover(hover),
      onFeed: (role, piece, points, x, y) => this.slots[role].onFeed(x, y, this.gridView.colorOf(piece), points),
      canInteract: () => this.canAct(),
      onDropResult: (fail, distance) => this.metrics.drop(fail, distance),
    });
    this.showGround(this.state.phase === 'night' ? 'night' : 'day');
    this.dayUi = new DayUi(this, this.state, data, {
      onChange: () => this.onDebugChange(),
      onRestart: () => this.restartLife(),
      rating: (attempt) => this.metrics.rating(attempt),
      rate: (attempt, key, value) => this.metrics.rate(attempt, key, value),
      endingAgree: () => this.metrics.endingAgree,
      setEndingAgree: (v) => this.metrics.setEndingAgree(v),
      persist: () => this.session.saveGame(this.state),
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
    this.gridView.refresh();
    this.syncUi();
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
    // 낮 → 밤 전환 연출(1.5초) 동안은 게임 시간을 멈춘다 (밤이 줄어들지 않게, 입력도 막힘)
    const paused = this.sky.transitioning;
    // metrics 실제 시간: 배속을 곱하지 않은 프레임 시간 (백그라운드 동안은 프레임이 멈춘다)
    this.metrics.frame(paused ? 0 : dt, this.speed);
    const events = this.state.tick(paused ? 0 : dt * this.speed);
    this.persist(events);
    this.onPhaseEvents(events);
    this.laneView.handle(events);
    this.abyssView.handle(events);
    this.onMergeEvents(events);
    // 지급 조각(갈림길 보너스·와일드카드)은 core에서 이미 그리드에 들어가 있다
    const gridEvents = ['coreFound', 'freePiece', 'bossReward'];
    if (events.some((e) => gridEvents.includes(e.type))) this.gridView.refresh();
    this.laneView.sync();
    this.abyssView.sync();
    this.slots.offense.sync();
    this.slots.defense.sync();
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
    const at = { x: p.x, y: REGION.sky.y + 26 };
    const ring = this.add.circle(at.x, at.y, 14, role === 'offense' ? COLOR.happy : 0xe6e9f5, 0.5).setDepth(30);
    this.tweens.add({ targets: ring, scale: 2, alpha: 0, duration: 600, onComplete: () => ring.destroy() });
    const t = text(this, at.x, at.y + 18, `+${pct}%`, { fontSize: '12px', color: role === 'offense' ? '#ffe08a' : '#dfe6ff', fontStyle: 'bold' })
      .setOrigin(0.5)
      .setDepth(31);
    this.tweens.add({ targets: t, y: at.y + 8, alpha: 0, delay: 600, duration: 400, onComplete: () => t.destroy() });
  }

  /** 낮/밤 전환: 해질녘 → 1.5초 연출 (절반에서 땅 띠 교체) / 장면 카드(스테이지 시작·실패 뒤) → 낮 */
  private onPhaseEvents(events: CoreEvent[]): void {
    for (const e of events) {
      if (e.type === 'dusk') {
        this.gridView.cancel();
        this.sky.dusk(
          () => this.showGround('night'),
          () => this.syncUi(),
        );
      } else if (e.type === 'stageStart' || e.type === 'dayBegin') {
        this.gridView.cancel();
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

  /** 그리드·버튼 입력 가능: 낮·밤 + 모달 없음 + 전환 연출 아님 */
  private canAct(): boolean {
    return this.state.timeFlows && !this.dayUi.blocking && !this.sky.transitioning;
  }

  private onDragHover(hover: DragHover): void {
    this.releaseZone.setHover(hover?.kind === 'release' ? hover.hover : null);
    for (const role of ['offense', 'defense'] as const) {
      this.slots[role].setHovered(hover?.kind === 'feed' && hover.role === role && hover.block === null);
    }
  }

  private onDebugChange(): void {
    this.gridView.refresh();
    this.syncUi();
  }

  /** core 상태 → HUD·버튼 */
  private syncUi(): void {
    const s = this.state;
    const data = this.registry.get('data') as GameData;
    const joy = `기쁨 ${s.joy}`;
    if (this.joyText.text !== joy) this.joyText.setText(joy);
    // HUD (§5.19-1): "1-3 · 셋째 고개", 재도전일 때만 "다시 도전". 일차는 쓰지 않는다
    const phase = s.phase === 'chapterComplete' ? '이야기 끝' : stageLabel(data, s.stage);
    if (this.phaseText.text !== phase) this.phaseText.setText(phase);
    const retry = (s.phase === 'dayStart' && s.retry !== null) || ((s.phase === 'day' || s.phase === 'night') && s.attempts[s.stage - 1] > 1);
    const tag = retry ? '다시 도전' : s.wave.paused ? '(웨이브 정지)' : '';
    if (this.retryText.text !== tag) this.retryText.setText(tag);
    // 영웅 슬롯: 낮·밤 언제든 양쪽 먹이기 (§5.17-2)
    this.slots.offense.setClosed(!s.feedOpen);
    this.slots.defense.setClosed(!s.feedOpen);
    const block = s.spawnBlock;
    const canAct = this.canAct();
    this.spawnBtn
      .setLabel(block === 'full' ? '칸 가득' : block === 'noJoy' ? `기쁨 부족 (${s.spawnCost})` : `조각 생성 (${s.spawnCost})`)
      .setEnabled(block === null && canAct);
  }

  private onSpawn(): void {
    if (!this.canAct()) return;
    if (this.state.spawn()) this.gridView.refresh();
    this.syncUi();
  }

  private fill(r: Rect, color: number): Phaser.GameObjects.Rectangle {
    return this.add.rectangle(r.x, r.y, r.w, r.h, color).setOrigin(0);
  }

  private drawHud(data: GameData): void {
    const r = REGION.hud;
    this.fill(r, COLOR.hud);
    const midY = r.y + r.h / 2;
    this.phaseText = text(this, 8, midY, '', { fontSize: '11px' }).setOrigin(0, 0.5);
    this.joyText = text(this, VIEW_W / 2 + 30, midY, `기쁨 ${data.balance.start.joy}`, { fontSize: '12px', color: '#f2c94c' }).setOrigin(0.5);
    this.retryText = text(this, VIEW_W - 8, midY, '', { fontSize: '11px', color: '#ffb46b' }).setOrigin(1, 0.5);
  }

  /** [추억 조합] 도감 (§5.13-5): 하늘 띠 오른쪽 위, 언제나 */
  private drawRecipeButton(): void {
    const sky = REGION.sky;
    const b = new Button(this, sky.x + sky.w - 40, sky.y + 14, 72, 20, '추억 조합', () => this.dayUi.showRecipes(), '10px');
    b.container.setDepth(8);
  }

  /** 그리드는 중립 색 (좌우를 양/음 색으로 칠하지 않음, D-018) */
  private drawGrid(size: GridSize): void {
    this.fill(REGION.grid, COLOR.grid);
    const l = gridLayout(size.cols, size.rows);
    for (let i = 0; i < size.cols * size.rows; i++) {
      const col = i % size.cols;
      const row = Math.floor(i / size.cols);
      this.add
        .rectangle(l.x + col * l.cellW + 1, l.y + row * l.cellH + 1, l.cellW - 2, l.cellH - 2, COLOR.cell)
        .setOrigin(0)
        .setStrokeStyle(1, COLOR.cellLine);
    }
  }

  private drawBottomBar(): void {
    const r = REGION.bottomBar;
    this.fill(r, COLOR.bar);
    const midY = r.y + r.h / 2;
    this.spawnBtn = new Button(this, 62, midY, 108, 34, '', () => this.onSpawn());
    // 놓아주기는 버튼이 아니라 드롭 영역 (D-019)
    this.releaseZone = new ReleaseZoneView(this);
    // 이야기책 (펼친 장, §5.19-4)
    new Button(this, VIEW_W - 64, midY, 108, 34, '이야기책', () => {
      if (!this.dayUi.blocking) this.dayUi.showDiaryList();
    }, '12px');
  }
}
