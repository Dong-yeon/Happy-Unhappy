// 포탈 표시 (D-018, §4.2): 평소 / 드래그 중 강조(+10%, 밝게) / 닫힘(정원 초과: 어둡게 + ✕)
import Phaser from 'phaser';
import { PORTAL_RADIUS } from './layout';
import { COLOR, text } from './ui';

export type PortalLook = 'normal' | 'hover' | 'closed';

export class PortalView {
  private readonly container: Phaser.GameObjects.Container;
  private readonly circle: Phaser.GameObjects.Arc;
  private readonly cross: Phaser.GameObjects.Text;
  private readonly label: Phaser.GameObjects.Text;
  private look: PortalLook = 'normal';
  private hovered = false;
  private closed = false;

  constructor(
    scene: Phaser.Scene,
    readonly x: number,
    readonly y: number,
    private readonly color: number,
    icon: string,
    label: string,
    textColor: string,
  ) {
    this.circle = scene.add.circle(0, 0, PORTAL_RADIUS, color).setStrokeStyle(2, COLOR.mirror);
    const i = text(scene, 0, -5, icon, { fontSize: '16px', color: textColor }).setOrigin(0.5);
    this.label = text(scene, 0, 12, label, { fontSize: '8px', color: textColor }).setOrigin(0.5);
    const l = this.label;
    this.cross = text(scene, 0, 0, '✕', { fontSize: '26px', color: '#ff8a8a', fontStyle: 'bold' }).setOrigin(0.5).setVisible(false);
    this.container = scene.add.container(x, y, [this.circle, i, l, this.cross]).setDepth(5);
  }

  /** 레인 정원이 차면 닫힌 모습 (core 상태에서 매 프레임) */
  setClosed(closed: boolean): void {
    this.closed = closed;
    this.apply();
  }

  /** 단계별 역할 이름 (낮: 창문·맡기기 / 밤: 손거울) */
  setLabel(label: string): void {
    if (this.label.text !== label) this.label.setText(label);
  }

  /** 드래그 중 이 포탈(또는 땅 띠) 위 */
  setHovered(hovered: boolean): void {
    this.hovered = hovered;
    this.apply();
  }

  private apply(): void {
    const look: PortalLook = this.closed ? 'closed' : this.hovered ? 'hover' : 'normal';
    if (look === this.look) return;
    this.look = look;
    this.container.setScale(look === 'hover' ? 1.1 : 1);
    this.circle.setFillStyle(look === 'closed' ? COLOR.portalClosed : look === 'hover' ? brighten(this.color) : this.color);
    this.cross.setVisible(look === 'closed');
  }
}

function brighten(c: number): number {
  const ch = (shift: number) => Math.min(255, (((c >> shift) & 0xff) * 1.2 + 20) | 0);
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}
