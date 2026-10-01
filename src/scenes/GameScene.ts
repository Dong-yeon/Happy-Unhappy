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
import { PartyView, partySlot } from './PartyView';
import { PortalView } from './PortalView';
import { ReleaseZoneView } from './ReleaseZoneView';
import { SaveSession } from './session';
import { SkyView } from './SkyView';
import { stageLabel } from './growthText';
import { PORTAL, PORTAL_RADIUS, REGION, VIEW_W, gridLayout, type PortalId, type Rect } from './layout';
import { Button, COLOR, setupCamera, text } from './ui';

/** HUD 시간대 이름 (표시 텍스트) */
/** HUD 시간대 이름 (표시 텍스트). v0.8에서 "낮"은 낮 전체를 뜻하므로 가운데 칸은 "점심" */

/** 한 프레임에 넘기는 시간 상한 (백그라운드 복귀 직후 몰아서 처리하지 않도록) */
const MAX_FRAME_MS = 100;

/**
 * M8: 하루 = 낮(방어 레인, ☀ 창문 즉시 소환 / ◐ 손거울 맡기기) → 밤(심연 레인, ◐ 손거울 즉시 소환) (§5.11, D-027).
 * 화면은 가로 레인 하나 + 하늘 띠(해/달). + C안 gating·하루 경계 저장/복원·결말 (§5.8), metrics (§5.10).
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
  private weatherText!: Phaser.GameObjects.Text;
  private shadowFill!: Phaser.GameObjects.Rectangle;
  private shadowFrame!: Phaser.GameObjects.Rectangle;
  private shadowBarW = 0;
  private shadowMax = 1;
  private portals!: Record<'happy' | 'unhappy', PortalView>;
  private sky!: SkyView;
  private party!: PartyView;
  private sleepBtn!: Button;
  private queueLabel!: Phaser.GameObjects.Text;
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
    // 저장 복원(하루 경계) 또는 새 일생 (?seed= 가 있으면 그 시드) → gating 지급 확인
    this.session = new SaveSession(data, size);
    this.state = this.session.boot();
    // metrics (§5.10): 관찰만. 판 도중 복원 감지는 생성 시
    this.metrics = new MetricsRecorder(this.state, size);

    this.drawHud(data);
    this.sky = new SkyView(this, this.state);
    this.drawPortalBase();
    this.drawGrid(size);
    this.drawPortals();
    this.drawBottomBar(data);
    this.laneView = new DefenseLaneView(this, this.state, data.chains, { x: this.joyText.x, y: this.joyText.y }, data.monsters.worry.name);
    this.abyssView = new AbyssLaneView(this, this.state, data.chains, partySlot, data.balance.abyss, (n) => stageLabel(data, n, 'night'));
    this.party = new PartyView(this, this.state, data.chains, data.balance.lane.laneCap);
    this.drawSleepButton();
    this.drawRecipeButton();
    this.gridView = new GridView(this, this.state, data.chains, {
      onChange: () => this.syncUi(),
      onHover: (hover) => this.onDragHover(hover),
      onSummon: (r, x, y) => {
        if (r.unit === null) this.party.onReserve(r.reserved, x, y);
        else (r.unit.side === 'happy' ? this.laneView : this.abyssView).onSummon(r.unit, x, y);
      },
      groundPortal: () => this.groundPortal(),
      canInteract: () => this.canAct(),
      onDropResult: (fail, distance) => this.metrics.drop(fail, distance),
    });
    this.showGround(this.state.phase === 'night' ? 'night' : 'day');
    this.dayUi = new DayUi(this, this.state, data, {
      onChange: () => this.onDebugChange(),
      onRestart: () => this.restartLife(),
      canOpenDay: () => this.session.canOpenDay,
      recheck: () => this.session.checkGrant(this.state),
      forgottenLog: () => this.session.gating.forgottenLog,
      rating: (day) => this.metrics.rating(day),
      rate: (day, key, value) => this.metrics.rate(day, key, value),
      endingAgree: () => this.metrics.endingAgree,
      setEndingAgree: (v) => this.metrics.setEndingAgree(v),
    });
    // 지급 확인: 앱이 다시 보일 때 (§5.8-1) / metrics 세션 시간 쓰기: 숨겨질 때 (§5.10-3)
    const onVisible = () => {
      if (document.visibilityState === 'visible') this.session.checkGrant(this.state);
      else this.metrics.onHidden();
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

  /** [처음부터]: 새 일생 (gating 유지) → 다시 부팅하면 새 시드로 만들고 dayStart 저장 */
  private restartLife(): void {
    this.session.newLife();
    this.scene.start('Boot');
  }

  /**
   * 하루 경계 저장 (§5.8-2): dayStart 진입 → game / diary 진입 → gating 소비 + game (한 번의 쓰기) / chapterComplete 진입 → game.
   * 이벤트를 처리하는 시점에 경계 단계가 아니면(같은 프레임에 다음 단계로 넘어간 경우) 건너뛴다.
   */
  private persist(events: CoreEvent[]): void {
    const boundary = this.state.phase === 'dayStart' || this.state.phase === 'diary' || this.state.phase === 'chapterComplete';
    for (const e of events) {
      if (e.type === 'dayEnd') {
        if (boundary) this.session.endDay(this.state);
        this.metrics.endDay();
      } else if (e.type === 'dayStart' || e.type === 'chapterComplete') {
        if (boundary) this.session.saveGame(this.state);
        if (e.type === 'chapterComplete') this.metrics.chapterEnd();
      } else if (e.type === 'dayBegin') {
        this.metrics.beginDay(this.session.bypass);
      }
    }
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
    // 층 돌파 귀환 조각은 core에서 이미 그리드에 들어가 있다
    // 층 돌파·하루 끝 귀환·선물 조각은 core에서 이미 그리드에 들어가 있다
    const gridEvents = ['layerClear', 'dayReturn', 'freePiece', 'injured', 'bossFloorClear', 'combine', 'growth'];
    if (events.some((e) => gridEvents.includes(e.type))) this.gridView.refresh();
    this.laneView.sync();
    this.abyssView.sync();
    this.party.sync();
    this.sky.sync();
    this.dayUi.sync();
    this.syncUi();
  }

  /** 낮/밤 전환: 해질녘 → 1.5초 연출 (절반에서 땅 띠 교체) / 새 하루(dayStart) → 낮 */
  private onPhaseEvents(events: CoreEvent[]): void {
    for (const e of events) {
      if (e.type === 'dusk') {
        this.gridView.cancel();
        this.sky.dusk(
          () => this.showGround('night'),
          () => this.syncUi(),
        );
      } else if (e.type === 'dayStart' || e.type === 'dayBegin') {
        if (this.groundShown !== 'day' || this.sky.mode !== 'day') {
          this.sky.setMode('day');
          this.showGround('day');
        }
      }
    }
  }

  /** 땅 띠 내용 교체 (낮 = 방어 레인 + 맡긴 추억 줄, 밤 = 심연 레인) */
  private showGround(which: 'day' | 'night'): void {
    this.groundShown = which;
    this.laneView.setShown(which === 'day');
    this.abyssView.setShown(which === 'night');
    this.party.setShown(which === 'day');
    if (which === 'night' && !this.sky.transitioning) this.sky.setMode('night');
  }

  /** 지금 땅 띠가 맡는 포탈 (드롭 판정): 낮 = 창문, 밤 = 손거울 */
  private groundPortal(): PortalId | null {
    if (this.state.phase === 'day') return 'happy';
    if (this.state.phase === 'night') return 'unhappy';
    return null;
  }

  /** 그리드·버튼 입력 가능: 낮·밤 + 모달 없음 + 전환 연출 아님 */
  private canAct(): boolean {
    return this.state.timeFlows && !this.dayUi.blocking && !this.sky.transitioning;
  }

  private onDragHover(hover: DragHover): void {
    this.releaseZone.setHover(hover?.kind === 'release' ? hover.hover : null);
    for (const id of ['happy', 'unhappy'] as const) {
      this.portals[id].setHovered(hover?.kind === 'summon' && hover.portal === id && hover.block === null);
    }
  }

  private onDebugChange(): void {
    this.gridView.refresh();
    this.syncUi();
  }

  /** core 상태 → HUD·버튼 */
  private syncUi(): void {
    const s = this.state;
    const joy = `기쁨 ${s.joy}`;
    if (this.joyText.text !== joy) this.joyText.setText(joy);
    const w = s.wave;
    // HUD (§5.15-2): "1-3 고갯마루 들꽃 · 낮" / "1-3 셋째 고개 · 밤" (보스 웨이브면 뒤에 "역류")
    const night = s.phase === 'night';
    const when = night ? '밤' : s.phase === 'diary' ? '새벽' : s.phase === 'chapterComplete' ? '끝' : '낮';
    const tag = s.bossActive ? ' 역류' : w.inBossPrep ? ' 역류 준비' : s.pendingBackflow ? ' · 역류 예약' : w.paused ? ' (정지)' : '';
    const phase = `${stageLabel(this.registry.get('data') as GameData, s.stage, night ? 'night' : 'day')} · ${when}${tag}`;
    if (this.phaseText.text !== phase) this.phaseText.setText(phase).setColor(s.shadowLocked ? '#ff9e9e' : '#e8e8e8');
    const weather = `마음 날씨 ${s.weather}`;
    if (this.weatherText.text !== weather) this.weatherText.setText(weather);
    this.shadowFill.width = this.shadowBarW * (s.shadow / this.shadowMax);
    this.shadowFill.setFillStyle(s.shadowLocked ? 0xd0607a : COLOR.unhappy);
    this.shadowFrame.setStrokeStyle(1, s.shadowLocked ? 0xff9e9e : COLOR.cellLine);
    // 포탈: 낮 = 창문(즉시)·손거울(맡기기, 줄이 차면 닫힘) / 밤 = 창문 닫힘·손거울(즉시) (§5.11-2)
    const cap = this.state.defense.cap;
    this.portals.happy.setClosed(!s.portalOpen('happy') || s.defense.isFull);
    this.portals.unhappy.setClosed(!s.portalOpen('unhappy') || (s.isReserve('unhappy') ? s.nightParty.length >= cap : s.abyss.isFull));
    this.portals.happy.setLabel(s.phase === 'night' ? '닫힘' : '창문');
    this.portals.unhappy.setLabel(s.phase === 'day' ? '맡기기' : '손거울');
    const q = s.returnQueue.length;
    this.queueLabel.setVisible(q > 0);
    if (q > 0) this.queueLabel.setText(`대기 ${q}`);
    this.sleepBtn.setShown(s.canSleep && this.canAct());
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
    // 일차·날씨는 M5/M4에서 core 상태로 연결. 시간대 칸은 M3 임시로 "웨이브 n"
    this.phaseText = text(this, 8, midY, '', { fontSize: '11px' }).setOrigin(0, 0.5);
    this.joyText = text(this, VIEW_W / 2 + 30, midY, `기쁨 ${data.balance.start.joy}`, { fontSize: '12px', color: '#f2c94c' }).setOrigin(0.5);
    this.weatherText = text(this, VIEW_W - 8, midY, '', { fontSize: '12px', color: '#9fb4e0' }).setOrigin(1, 0.5);
  }

  /** 포탈 받침 + 귀환 대기 표시 (창문 왼쪽) */
  private drawPortalBase(): void {
    const base = REGION.portalBase;
    this.fill(base, COLOR.grid);
    const pedestalW = PORTAL.unhappy.x - PORTAL.happy.x + PORTAL_RADIUS * 2 + 16;
    this.add.rectangle(VIEW_W / 2, base.y, pedestalW, 10, COLOR.mirror).setOrigin(0.5, 0);
    this.queueLabel = text(this, PORTAL.happy.x - PORTAL_RADIUS - 6, PORTAL.happy.y, '', {
      fontSize: '9px',
      color: '#cfd6ea',
      backgroundColor: '#1b1d24',
      padding: { x: 3, y: 1 },
    })
      .setOrigin(1, 0.5)
      .setDepth(6)
      .setVisible(false);
  }

  /** [추억 조합] 도감 (§5.13-5): 하늘 띠 오른쪽 위, 언제나 */
  private drawRecipeButton(): void {
    const sky = REGION.sky;
    const b = new Button(this, sky.x + sky.w - 40, sky.y + 14, 72, 20, '추억 조합', () => this.dayUi.showRecipes(), '10px');
    b.container.setDepth(8);
  }

  /** [잠들기]: 밤 + 심연 유닛 0기 + 맡긴 추억 0일 때 (남은 시간 × 멈춤 그림자를 한 번에, §5.11-4) */
  private drawSleepButton(): void {
    const sky = REGION.sky;
    this.sleepBtn = new Button(this, sky.x + sky.w - 52, sky.y + sky.h - 16, 88, 24, '잠들기', () => {
      if (!this.canAct()) return;
      this.state.sleep();
      this.syncUi();
    }, '11px');
    this.sleepBtn.container.setDepth(8);
    this.sleepBtn.setShown(false);
  }

  private drawPortals(): void {
    this.portals = {
      happy: new PortalView(this, PORTAL.happy.x, PORTAL.happy.y, COLOR.portalHappy, '☀', '창문', '#3b3526'),
      unhappy: new PortalView(this, PORTAL.unhappy.x, PORTAL.unhappy.y, COLOR.portalUnhappy, '◐', '손거울', '#10131c'),
    };
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

  private drawBottomBar(data: GameData): void {
    const r = REGION.bottomBar;
    this.fill(r, COLOR.bar);
    const midY = r.y + r.h / 2;
    this.spawnBtn = new Button(this, 62, midY, 108, 34, '', () => this.onSpawn());
    // 놓아주기는 버튼이 아니라 드롭 영역 (D-019)
    this.releaseZone = new ReleaseZoneView(this);
    this.shadowMax = data.balance.shadow.shadowMax;
    text(this, 210, midY, '그림자', { fontSize: '10px', color: '#9fb4e0' }).setOrigin(0, 0.5);
    const barX = 248;
    this.shadowBarW = VIEW_W - barX - 10;
    this.shadowFrame = this.add.rectangle(barX, midY, this.shadowBarW, 10, COLOR.wall).setOrigin(0, 0.5).setStrokeStyle(1, COLOR.cellLine);
    this.shadowFill = this.add.rectangle(barX, midY, 0, 10, COLOR.unhappy).setOrigin(0, 0.5);
  }
}
