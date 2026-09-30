import Phaser from 'phaser';
import type { GameData } from '../data/types';
import type { CoreEvent, GameState } from '../core/game';
import type { GridSize } from '../core/grid';
import type { SlotId } from '../core/wave';
import { createDebugPanel } from '../debug/DebugPanel';
import { isDebug } from '../debug/gridPreset';
import { AbyssLaneView } from './AbyssLaneView';
import { DayUi } from './DayUi';
import { DefenseLaneView } from './DefenseLaneView';
import { GridView, type DragHover } from './GridView';
import { PortalView } from './PortalView';
import { ReleaseZoneView } from './ReleaseZoneView';
import { SaveSession } from './session';
import {
  DEFENSE_LINE_Y,
  HOME_Y,
  PORTAL,
  PORTAL_RADIUS,
  REGION,
  SHADOW_WALL,
  VIEW_W,
  WORRY_SPAWN_Y,
  gridLayout,
  type Rect,
} from './layout';
import { Button, COLOR, setupCamera, text } from './ui';

/** HUD 시간대 이름 (표시 텍스트) */
const SLOT_NAMES: Record<SlotId, string> = { morning: '아침', noon: '낮', evening: '저녁' };

/** 한 프레임에 넘기는 시간 상한 (백그라운드 복귀 직후 몰아서 처리하지 않도록) */
const MAX_FRAME_MS = 100;

/**
 * M6: 하루 = 한 판 (이벤트 카드·3웨이브·그림일기, 14일 일생) + 그리드 + 방어 레인(☀ 창문) + 심연 레인(◐ 손거울) + 그림자·역류
 * + C안 gating·하루 경계 저장/복원·결말 (§5.8). 게임 규칙은 core(GameState)에서, 이 씬은 표시·입력만.
 */
export class GameScene extends Phaser.Scene {
  private state!: GameState;
  private session!: SaveSession;
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
  private age = 0;
  private shadowMax = 1;
  private portals!: Record<'happy' | 'unhappy', PortalView>;
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

    this.drawHud(data);
    this.drawDefenseLane();
    this.drawAbyssLane();
    this.drawMirrorAndBase();
    this.drawGrid(size);
    this.drawPortals();
    this.drawBottomBar(data);
    this.abyssView = new AbyssLaneView(this, this.state, data.chains);
    this.laneView = new DefenseLaneView(
      this,
      this.state,
      data.chains,
      { x: this.joyText.x, y: this.joyText.y },
      { point: () => this.abyssView.wallCenter, onAbsorb: () => this.abyssView.pulseWall() },
    );
    this.gridView = new GridView(this, this.state, data.chains, {
      onChange: () => this.syncUi(),
      onHover: (hover) => this.onDragHover(hover),
      onSummon: (unit, x, y) => (unit.side === 'happy' ? this.laneView : this.abyssView).onSummon(unit, x, y),
      canInteract: () => this.state.phase === 'waves' && !this.dayUi.blocking,
    });
    this.dayUi = new DayUi(this, this.state, data, {
      onChange: () => this.onDebugChange(),
      onRestart: () => this.restartLife(),
      canOpenDay: () => this.session.canOpenDay,
      recheck: () => this.session.checkGrant(this.state),
      forgottenLog: () => this.session.gating.forgottenLog,
    });
    // 지급 확인: 앱이 다시 보일 때 (§5.8-1)
    const onVisible = () => {
      if (document.visibilityState === 'visible') this.session.checkGrant(this.state);
    };
    document.addEventListener('visibilitychange', onVisible);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => document.removeEventListener('visibilitychange', onVisible));
    if (isDebug()) {
      // 디버그 전용: 브라우저 콘솔에서 core 상태를 들여다보기 (?debug=1일 때만)
      (window as unknown as { __hauState?: GameState }).__hauState = this.state;
      createDebugPanel(this, data, this.state, this.session, size, {
        setSpeed: (s) => (this.speed = s),
        onChange: () => this.onDebugChange(),
        openDiary: () => this.dayUi.showDiaryList(),
        previewEnding: (r) => this.dayUi.showResult(r, true),
        reboot: () => this.scene.start('Boot'),
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
   * 하루 경계 저장 (§5.8-2): dayStart 진입 → game / diary 진입 → gating 소비 + game (한 번의 쓰기) / lifeEnd 진입 → game.
   * 이벤트를 처리하는 시점에 경계 단계가 아니면(같은 프레임에 다음 단계로 넘어간 경우) 건너뛴다.
   */
  private persist(events: CoreEvent[]): void {
    const boundary = this.state.phase === 'dayStart' || this.state.phase === 'diary' || this.state.phase === 'lifeEnd';
    for (const e of events) {
      if (e.type === 'dayEnd') {
        if (boundary) this.session.endDay(this.state);
      } else if (e.type === 'dayStart' || e.type === 'lifeEnd') {
        if (boundary) this.session.saveGame(this.state);
      }
    }
  }

  update(_time: number, delta: number): void {
    const events = this.state.tick((Math.min(delta, MAX_FRAME_MS) / 1000) * this.speed);
    this.persist(events);
    this.laneView.handle(events);
    this.abyssView.handle(events);
    // 층 돌파 귀환 조각은 core에서 이미 그리드에 들어가 있다
    // 층 돌파·하루 끝 귀환·선물 조각은 core에서 이미 그리드에 들어가 있다
    if (events.some((e) => e.type === 'layerClear' || e.type === 'dayReturn' || e.type === 'freePiece')) this.gridView.refresh();
    this.laneView.sync();
    this.abyssView.sync();
    this.dayUi.sync();
    this.syncUi();
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
    // HUD: "8살 · n일째 · 아침/낮/저녁" (보스 웨이브면 시간대 옆에 "역류")
    const slot = SLOT_NAMES[w.slotId];
    const tag = s.bossActive ? ' 역류' : w.inBossPrep ? ' 역류 준비' : s.pendingBackflow ? ' · 역류 예약' : w.paused ? ' (정지)' : '';
    const phase = `${this.age}살 · ${s.day}일째 · ${slot}${tag}`;
    if (this.phaseText.text !== phase) this.phaseText.setText(phase).setColor(s.shadowLocked ? '#ff9e9e' : '#e8e8e8');
    const weather = `마음 날씨 ${s.weather}`;
    if (this.weatherText.text !== weather) this.weatherText.setText(weather);
    this.shadowFill.width = this.shadowBarW * (s.shadow / this.shadowMax);
    this.shadowFill.setFillStyle(s.shadowLocked ? 0xd0607a : COLOR.unhappy);
    this.shadowFrame.setStrokeStyle(1, s.shadowLocked ? 0xff9e9e : COLOR.cellLine);
    this.portals.happy.setClosed(s.defense.isFull);
    this.portals.unhappy.setClosed(s.abyss.isFull);
    const block = s.spawnBlock;
    const canAct = s.phase === 'waves' && !this.dayUi.blocking;
    this.spawnBtn
      .setLabel(block === 'full' ? '칸 가득' : block === 'noJoy' ? `기쁨 부족 (${s.spawnCost})` : `조각 생성 (${s.spawnCost})`)
      .setEnabled(block === null && canAct);
  }

  private onSpawn(): void {
    if (this.state.phase !== 'waves' || this.dayUi.blocking) return;
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
    this.age = data.days.age;
    this.phaseText = text(this, 8, midY, '', { fontSize: '11px' }).setOrigin(0, 0.5);
    this.joyText = text(this, VIEW_W / 2 + 30, midY, `기쁨 ${data.balance.start.joy}`, { fontSize: '12px', color: '#f2c94c' }).setOrigin(0.5);
    this.weatherText = text(this, VIEW_W - 8, midY, '', { fontSize: '12px', color: '#9fb4e0' }).setOrigin(1, 0.5);
  }

  /** 왼쪽 = 양. 걱정이 위에서 내려와 아래(거점)로 다가온다 */
  private drawDefenseLane(): void {
    const r = REGION.defenseLane;
    this.fill(r, COLOR.defense);
    const cx = r.x + r.w / 2;
    text(this, cx, WORRY_SPAWN_Y, '걱정 ↓', { fontSize: '10px', color: '#c9b98a' }).setOrigin(0.5, 0);
    text(this, r.x + 6, r.y + r.h / 2, '방어 레인\n(양)', { fontSize: '10px', color: '#8f835f' }).setOrigin(0, 0.5);
    this.add.line(0, 0, r.x, DEFENSE_LINE_Y, r.x + r.w, DEFENSE_LINE_Y, COLOR.line).setOrigin(0).setLineWidth(1);
    this.character(PORTAL.happy.x, HOME_Y, COLOR.happy, 'Happy', '#f2c94c');
  }

  /** 오른쪽 = 음 (거울 속). 추억이 아래(거점)에서 위의 그림자 벽으로 멀어진다 */
  private drawAbyssLane(): void {
    const r = REGION.abyssLane;
    this.fill(r, COLOR.abyss);
    // 그림자 벽·Unhappy는 AbyssLaneView가 core 상태로 그린다
    text(this, r.x + r.w / 2, SHADOW_WALL.y + SHADOW_WALL.h + 6, '추억 ↑', { fontSize: '10px', color: '#8796c2' }).setOrigin(0.5, 0);
    text(this, r.x + r.w - 6, r.y + r.h / 2, '심연 레인\n(음)', { fontSize: '10px', color: '#5d6a91', align: 'right' }).setOrigin(1, 0.5);
  }

  /** 이름은 머리 위에 작게 (옆은 방어선 슬롯이 쓴다) */
  private character(x: number, y: number, color: number, name: string, textColor: string): void {
    this.add.circle(x, y, 10, color).setDepth(2);
    text(this, x, y - 17, name, { fontSize: '8px', color: textColor }).setOrigin(0.5).setDepth(2);
  }

  /** 가운데 세로 거울 → 아래 끝이 포탈 받침으로 이어진다 */
  private drawMirrorAndBase(): void {
    const base = REGION.portalBase;
    this.fill(base, COLOR.grid);
    this.fill(REGION.mirror, COLOR.mirror);
    const pedestalW = (PORTAL.unhappy.x - PORTAL.happy.x) + PORTAL_RADIUS * 2 + 16;
    this.add
      .rectangle(VIEW_W / 2, base.y, pedestalW, 10, COLOR.mirror)
      .setOrigin(0.5, 0);
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
