// 놓아주기 (D-019): 우물 안쪽 오른쪽 아래 모서리의 🍃 잎사귀 원 (지름 40, 판정 반경 28 — layout.RELEASE).
// 조각을 끌기 시작하면 커지며 빛나고, 위에 오면 밝게(와일드카드는 회색). 드롭 대상 표시만, 판정은 layout.inRelease + core.release.
import Phaser from 'phaser';
import { RELEASE } from './layout';
import { COLOR, text } from './ui';

const DEPTH = 6;
const GLOW = 0x9fe0a0;
/** 끄는 중 커지는 배율 */
const DRAG_SCALE = 1.25;

export type ReleaseHover = 'ok' | 'blocked' | null;

/** 미리보기 문구 (드래그 중 조각 위 태그) */
export function releaseHoverLabel(hover: Exclude<ReleaseHover, null>): string {
  return hover === 'blocked' ? '놓아줄 수 없음' : '놓아주기';
}

export class ReleaseZoneView {
  private readonly root: Phaser.GameObjects.Container;
  private readonly disc: Phaser.GameObjects.Arc;
  private readonly glow: Phaser.GameObjects.Arc;
  private readonly leaf: Phaser.GameObjects.Text;
  private dragging = false;
  private glowTween: Phaser.Tweens.Tween | null = null;

  constructor(private readonly scene: Phaser.Scene) {
    this.glow = scene.add.circle(0, 0, RELEASE.hitR, GLOW, 0);
    this.disc = scene.add.circle(0, 0, RELEASE.r, COLOR.button, 0.85).setStrokeStyle(2, 0x6f8a6a);
    this.leaf = text(scene, 0, 1, '🍃', { fontSize: '18px' }).setOrigin(0.5);
    this.root = scene.add.container(RELEASE.x, RELEASE.y, [this.glow, this.disc, this.leaf]).setDepth(DEPTH);
  }

  /** 조각을 끌기 시작 / 끝: 커지며 빛남 */
  setDragging(on: boolean): void {
    if (on === this.dragging) return;
    this.dragging = on;
    this.scene.tweens.killTweensOf(this.root);
    this.scene.tweens.add({ targets: this.root, scale: on ? DRAG_SCALE : 1, duration: 140, ease: 'Sine.easeOut' });
    this.glowTween?.remove();
    this.glowTween = null;
    if (on) {
      this.glow.setFillStyle(GLOW, 0.3);
      this.glowTween = this.scene.tweens.add({ targets: this.glow, alpha: 0.45, duration: 420, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' });
    } else {
      this.glow.setFillStyle(GLOW, 0).setAlpha(1);
      this.setHover(null);
    }
  }

  /** 드래그 중 원 위: 놓아주기 / 와일드카드는 비활성 표시 / null이면 끄는 중 모습 */
  setHover(hover: ReleaseHover): void {
    if (hover === 'blocked') this.disc.setFillStyle(COLOR.buttonOff, 0.9);
    else if (hover === 'ok') this.disc.setFillStyle(0x4f7d4a, 1);
    else this.disc.setFillStyle(COLOR.button, 0.85);
    this.leaf.setAlpha(hover === 'blocked' ? 0.4 : 1);
  }
}
