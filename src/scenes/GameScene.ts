import Phaser from 'phaser';
import type { GameData } from '../data/types';
import { GameState } from '../core/game';
import type { GridSize } from '../core/grid';
import { mulberry32, parseSeed } from '../core/rng';
import { createDebugPanel } from '../debug/DebugPanel';
import { isDebug } from '../debug/gridPreset';
import { DefenseLaneView } from './DefenseLaneView';
import { GridView, type DragHover } from './GridView';
import { PortalView } from './PortalView';
import { ReleaseZoneView } from './ReleaseZoneView';
import {
  DEFENSE_LINE_Y,
  HOME_Y,
  PORTAL,
  PORTAL_RADIUS,
  REGION,
  SHADOW_WALL,
  VIEW_W,
  WORRY_SPAWN_Y,
  defenseGeometry,
  gridLayout,
  type Rect,
} from './layout';
import { Button, COLOR, setupCamera, text } from './ui';

/** 한 프레임에 넘기는 시간 상한 (백그라운드 복귀 직후 몰아서 처리하지 않도록) */
const MAX_FRAME_MS = 100;

/**
 * M3: 그리드 + 방어 레인(☀ 창문 소환, 걱정, Happy). ◐ 손거울·심연 레인은 M4.
 * 게임 규칙은 core(GameState)에서, 이 씬은 표시·입력만.
 */
export class GameScene extends Phaser.Scene {
  private state!: GameState;
  private gridView!: GridView;
  private joyText!: Phaser.GameObjects.Text;
  private spawnBtn!: Button;
  private releaseZone!: ReleaseZoneView;
  private laneView!: DefenseLaneView;
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
    // ?seed= 가 있으면 시드 고정, 없으면 Math.random
    const seed = parseSeed(new URLSearchParams(window.location.search).get('seed'));
    this.state = new GameState(
      data,
      size,
      seed === null ? Math.random : mulberry32(seed),
      defenseGeometry(data.balance.lane.laneCap),
    );

    this.drawHud(data);
    this.drawDefenseLane();
    this.drawAbyssLane();
    this.drawMirrorAndBase();
    this.drawGrid(size);
    this.drawPortals();
    this.drawBottomBar(data);
    this.laneView = new DefenseLaneView(this, this.state, data.chains, { x: this.joyText.x, y: this.joyText.y });
    this.gridView = new GridView(this, this.state, data.chains, {
      onChange: () => this.syncUi(),
      onHover: (hover) => this.onDragHover(hover),
      onSummon: (unit, x, y) => this.laneView.onSummon(unit, x, y),
    });
    if (isDebug()) {
      createDebugPanel(this, data, this.state, size, seed, {
        setSpeed: (s) => (this.speed = s),
        onChange: () => this.onDebugChange(),
      });
    }
    this.syncUi();
  }

  update(_time: number, delta: number): void {
    const events = this.state.tick((Math.min(delta, MAX_FRAME_MS) / 1000) * this.speed);
    this.laneView.handle(events);
    this.laneView.sync();
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
    const phase = w.n === 0 ? '웨이브 준비' : `웨이브 ${w.n}${w.paused ? ' (정지)' : ''}`;
    if (this.phaseText.text !== phase) this.phaseText.setText(phase);
    this.portals.happy.setClosed(s.defense.isFull);
    const block = s.spawnBlock;
    this.spawnBtn
      .setLabel(block === 'full' ? '칸 가득' : block === 'noJoy' ? `기쁨 부족 (${s.spawnCost})` : `조각 생성 (${s.spawnCost})`)
      .setEnabled(block === null);
  }

  private onSpawn(): void {
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
    text(this, 8, midY, `${data.days.age}살 · 1일째 ·`, { fontSize: '12px' }).setOrigin(0, 0.5);
    this.phaseText = text(this, 86, midY, '', { fontSize: '12px' }).setOrigin(0, 0.5);
    this.joyText = text(this, VIEW_W / 2 + 30, midY, `기쁨 ${data.balance.start.joy}`, { fontSize: '12px', color: '#f2c94c' }).setOrigin(0.5);
    text(this, VIEW_W - 8, midY, '마음 날씨 —', { fontSize: '12px', color: '#9fb4e0' }).setOrigin(1, 0.5);
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
    this.fill(SHADOW_WALL, COLOR.wall);
    text(this, SHADOW_WALL.x + SHADOW_WALL.w / 2, SHADOW_WALL.y + SHADOW_WALL.h / 2, '▓ 그림자 벽 (1층) ▓', {
      fontSize: '9px',
      color: '#8796c2',
    }).setOrigin(0.5);
    text(this, r.x + r.w / 2, SHADOW_WALL.y + SHADOW_WALL.h + 6, '추억 ↑', { fontSize: '10px', color: '#8796c2' }).setOrigin(0.5, 0);
    text(this, r.x + r.w - 6, r.y + r.h / 2, '심연 레인\n(음)', { fontSize: '10px', color: '#5d6a91', align: 'right' }).setOrigin(1, 0.5);
    this.character(PORTAL.unhappy.x, HOME_Y, COLOR.unhappy, 'Unhappy', '#9fb0e0');
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
    const { shadowMax } = data.balance.shadow;
    const shadow = data.balance.start.shadow;
    text(this, 210, midY, '그림자', { fontSize: '10px', color: '#9fb4e0' }).setOrigin(0, 0.5);
    const barX = 248;
    const barW = VIEW_W - barX - 10;
    this.add.rectangle(barX, midY, barW, 10, COLOR.wall).setOrigin(0, 0.5).setStrokeStyle(1, COLOR.cellLine);
    if (shadow > 0) {
      this.add.rectangle(barX, midY, (barW * Math.min(shadow, shadowMax)) / shadowMax, 10, COLOR.unhappy).setOrigin(0, 0.5);
    }
  }
}
