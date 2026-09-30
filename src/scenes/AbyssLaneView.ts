// 심연 레인 표시: 추억 유닛(위로 전진), 그림자 벽(HP·층), Unhappy 멈춤, 귀환 대기열 + 흐름 연출 (§4.3.2, §4.2.1).
// 상태는 항상 core에서 읽는다. 이벤트는 연출(귀환 빛 조각, 벽 흡수, 소멸)에만 쓴다.
import Phaser from 'phaser';
import type { CoreEvent, GameState } from '../core/game';
import { isWildcard, type Piece } from '../core/grid';
import type { Unit } from '../core/lane';
import type { Chain } from '../data/types';
import { HOME_Y, PORTAL, PORTAL_RADIUS, SHADOW_WALL, cellCenter } from './layout';
import { COLOR, text } from './ui';

const UNIT_SIZE = 16;
const HP_BAR_W = 16;
const SUMMON_MS = 250; // 조각 → 손거울 → 출발선
const RETURN_MS = 450; // 유닛 자리 → 손거울 → 그리드 칸
const PULSE_MS = 120;

interface UnitView {
  container: Phaser.GameObjects.Container;
  bar: Phaser.GameObjects.Rectangle;
  /** 소환 연출 중에는 core 위치로 옮기지 않는다 */
  tweening: boolean;
}

export class AbyssLaneView {
  private readonly units = new Map<number, UnitView>();
  private readonly chainColor = new Map<string, number>();
  private readonly wall: Phaser.GameObjects.Container;
  private readonly wallLabel: Phaser.GameObjects.Text;
  private readonly wallBar: Phaser.GameObjects.Rectangle;
  private readonly unhappy: Phaser.GameObjects.Arc;
  private readonly unhappyLabel: Phaser.GameObjects.Text;
  private readonly queueLabel: Phaser.GameObjects.Text;
  private stalledShown = false;

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly state: GameState,
    chains: Chain[],
  ) {
    for (const c of chains) this.chainColor.set(c.archetypeId, parseInt(c.color.slice(1), 16));

    // 그림자 벽: 배경 + 남은 HP 막대 + "N층 hp/max"
    const w = SHADOW_WALL;
    const bg = scene.add.rectangle(0, 0, w.w, w.h, COLOR.wall);
    this.wallBar = scene.add.rectangle(-w.w / 2, w.h / 2 - 2, w.w, 3, COLOR.unhappy).setOrigin(0, 0.5);
    this.wallLabel = text(scene, 0, -1, '', { fontSize: '9px', color: '#8796c2' }).setOrigin(0.5);
    this.wall = scene.add.container(w.x + w.w / 2, w.y + w.h / 2, [bg, this.wallBar, this.wallLabel]).setDepth(2);

    // Unhappy: 손거울 포탈 바로 위. 멈추면 흐려지고 "멈춤"
    this.unhappy = scene.add.circle(PORTAL.unhappy.x, HOME_Y, 10, COLOR.unhappy).setDepth(2);
    this.unhappyLabel = text(scene, PORTAL.unhappy.x, HOME_Y - 17, 'Unhappy', { fontSize: '8px', color: '#9fb0e0' })
      .setOrigin(0.5)
      .setDepth(2);

    // 귀환 대기열: 손거울 옆 작은 표시
    this.queueLabel = text(scene, PORTAL.unhappy.x + PORTAL_RADIUS + 6, PORTAL.unhappy.y, '', {
      fontSize: '9px',
      color: '#cfd6ea',
      backgroundColor: '#1b1d24',
      padding: { x: 3, y: 1 },
    })
      .setOrigin(0, 0.5)
      .setDepth(6)
      .setVisible(false);
  }

  /** 소환 연출: 드롭 지점 → ◐ 손거울 포탈 → 출발선 슬롯. core에서는 이미 전진 시작 */
  onSummon(unit: Unit, fromX: number, fromY: number): void {
    const v = this.makeUnit(unit);
    v.tweening = true;
    v.container.setPosition(fromX, fromY).setDepth(15);
    this.scene.tweens.chain({
      targets: v.container,
      tweens: [
        { x: PORTAL.unhappy.x, y: PORTAL.unhappy.y, scale: 0.6, duration: SUMMON_MS / 2, ease: 'Sine.easeIn' },
        { x: unit.x, y: unit.y, scale: 1, duration: SUMMON_MS / 2, ease: 'Sine.easeOut' },
      ],
      onComplete: () => {
        v.tweening = false;
        v.container.setDepth(3);
      },
    });
  }

  /** core 이벤트 → 연출. sync() 전에 호출 */
  handle(events: CoreEvent[]): void {
    for (const e of events) {
      if (e.type === 'abyssUnitDie') this.removeUnit(e.unitId, true);
      else if (e.type === 'layerClear') {
        for (const r of e.returns) {
          this.removeUnit(r.unitId, false);
          this.returnFlow(r.piece, r.x, r.y, r.placedAt, r.lost);
        }
      }
    }
  }

  /** 가라앉은 걱정이 거울을 지나 벽에 흡수됨 (DefenseLaneView가 연출 끝에 호출) */
  pulseWall(): void {
    this.scene.tweens.add({ targets: this.wall, scaleY: 1.35, scaleX: 1.02, duration: PULSE_MS, yoyo: true });
  }

  /** 벽 중심 (가라앉음 흐름의 도착점) */
  get wallCenter(): { x: number; y: number } {
    return { x: this.wall.x, y: this.wall.y };
  }

  /** 표시를 core 상태에 맞춘다 (매 프레임) */
  sync(): void {
    const s = this.state;
    const w = s.abyss.wall;
    const label = `▓ 그림자 벽 ${w.layer}층  ${Math.max(0, Math.ceil(w.hp))}/${Math.ceil(w.maxHp)} ▓`;
    if (this.wallLabel.text !== label) this.wallLabel.setText(label);
    this.wallBar.width = SHADOW_WALL.w * Math.max(0, Math.min(1, w.hp / w.maxHp));

    if (s.unhappyStalled !== this.stalledShown) {
      this.stalledShown = s.unhappyStalled;
      this.unhappy.setAlpha(s.unhappyStalled ? 0.45 : 1);
      this.unhappyLabel.setText(s.unhappyStalled ? 'Unhappy · 멈춤' : 'Unhappy').setColor(s.unhappyStalled ? '#ff9e9e' : '#9fb0e0');
    }

    const q = s.returnQueue.length;
    this.queueLabel.setVisible(q > 0);
    if (q > 0) this.queueLabel.setText(`대기 ${q}`);

    const live = new Set<number>();
    for (const u of s.abyss.units) {
      live.add(u.id);
      const v = this.units.get(u.id) ?? this.makeUnit(u);
      if (!v.tweening) v.container.setPosition(u.x, u.y);
      v.bar.width = HP_BAR_W * Math.max(0, Math.min(1, u.hp / u.maxHp));
    }
    for (const id of [...this.units.keys()]) if (!live.has(id)) this.removeUnit(id, true);
  }

  private makeUnit(u: Unit): UnitView {
    const maxTier = this.state.grid.maxTier;
    const fill = this.chainColor.get(u.chain) ?? 0x999999;
    // 거울 속 = 차가운 팔레트: 같은 체인 색에 차가운 테두리
    const body = this.scene.add.rectangle(0, 0, UNIT_SIZE, UNIT_SIZE, fill).setStrokeStyle(2, COLOR.portalUnhappy);
    const label = text(this.scene, 0, 0, u.tier >= maxTier ? '★' : String(u.tier), {
      fontSize: '10px',
      color: '#1b1d24',
      fontStyle: 'bold',
    }).setOrigin(0.5);
    const bg = this.scene.add.rectangle(-HP_BAR_W / 2, UNIT_SIZE / 2 + 3, HP_BAR_W, 3, 0x1b1d24).setOrigin(0, 0.5);
    const bar = this.scene.add.rectangle(-HP_BAR_W / 2, UNIT_SIZE / 2 + 3, HP_BAR_W, 3, 0x9fc3ff).setOrigin(0, 0.5);
    const container = this.scene.add.container(u.x, u.y, [body, label, bg, bar]).setDepth(3);
    const v = { container, bar, tweening: false };
    this.units.set(u.id, v);
    return v;
  }

  private removeUnit(id: number, fade: boolean): void {
    const v = this.units.get(id);
    this.units.delete(id);
    if (!v) return;
    this.scene.tweens.killTweensOf(v.container);
    if (!fade) {
      v.container.destroy();
      return;
    }
    this.scene.tweens.add({ targets: v.container, alpha: 0, duration: 150, onComplete: () => v.container.destroy() });
  }

  /** 층 돌파 귀환: 빛 조각이 ◐ 손거울 포탈을 지나 그리드 칸으로 (대기열이면 손거울 옆, 소실이면 포탈에서 사라짐) */
  private returnFlow(piece: Piece, x: number, y: number, placedAt: number | null, lost: boolean): void {
    const fill = isWildcard(piece) ? COLOR.wildcard : (this.chainColor.get(piece.chain) ?? 0xffffff);
    const light = this.scene.add.rectangle(x, y, 12, 12, fill).setStrokeStyle(1, 0xffffff).setDepth(40);
    const { cols, rows } = this.state.grid;
    const dest =
      placedAt !== null
        ? cellCenter(cols, rows, placedAt)
        : lost
          ? { x: PORTAL.unhappy.x, y: PORTAL.unhappy.y }
          : { x: this.queueLabel.x + 10, y: this.queueLabel.y };
    this.scene.tweens.chain({
      targets: light,
      tweens: [
        { x: PORTAL.unhappy.x, y: PORTAL.unhappy.y, duration: RETURN_MS / 2, ease: 'Sine.easeIn' },
        { x: dest.x, y: dest.y, alpha: lost ? 0 : 1, duration: RETURN_MS / 2, ease: 'Sine.easeOut' },
      ],
      onComplete: () => light.destroy(),
    });
  }
}
