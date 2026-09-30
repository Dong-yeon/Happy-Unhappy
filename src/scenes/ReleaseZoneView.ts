// 하단 바의 놓아주기 영역 (v0.3.2, D-019). 드롭 대상 표시만. 판정은 layout.dropTarget.
import Phaser from 'phaser';
import { RELEASE_ZONE } from './layout';
import { COLOR, text } from './ui';

const IDLE_LABEL = '🍃 놓아주기';

export type ReleaseHover = { refund: number } | 'blocked' | null;

/** 미리보기 문구 (영역 라벨과 드래그 중 조각 위 태그가 같이 쓴다) */
export function releaseHoverLabel(hover: Exclude<ReleaseHover, null>): string {
  return hover === 'blocked' ? '놓아줄 수 없음' : `놓아주기 +${hover.refund}`;
}

export class ReleaseZoneView {
  private readonly rect: Phaser.GameObjects.Rectangle;
  private readonly label: Phaser.GameObjects.Text;

  constructor(scene: Phaser.Scene) {
    const cx = RELEASE_ZONE.x + RELEASE_ZONE.w / 2;
    const cy = RELEASE_ZONE.y + RELEASE_ZONE.h / 2;
    this.rect = scene.add.rectangle(cx, cy, RELEASE_ZONE.w, RELEASE_ZONE.h, COLOR.button).setStrokeStyle(1, COLOR.cellLine);
    this.label = text(scene, cx, cy, IDLE_LABEL, { fontSize: '11px' }).setOrigin(0.5);
  }

  /** 드래그 중 영역 위: 환급액 미리보기 / 와일드카드는 비활성 표시 / null이면 평소 모습 */
  setHover(hover: ReleaseHover): void {
    if (hover === null) {
      this.rect.setFillStyle(COLOR.button);
      this.label.setText(IDLE_LABEL).setColor('#ffffff');
    } else if (hover === 'blocked') {
      this.rect.setFillStyle(COLOR.buttonOff);
      this.label.setText(releaseHoverLabel(hover)).setColor('#8a8f9e');
    } else {
      this.rect.setFillStyle(COLOR.buttonOn);
      this.label.setText(releaseHoverLabel(hover)).setColor('#ffffff');
    }
  }
}
