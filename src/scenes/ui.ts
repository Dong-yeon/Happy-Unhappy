// 표시용 공통 헬퍼 (도형 + 텍스트만).
import Phaser from 'phaser';
import { RENDER_SCALE, VIEW_H, VIEW_W } from './layout';

export const COLOR = {
  bg: 0x1b1d24,
  hud: 0x2a2d38,
  defense: 0x3b3526, // 양: 따뜻한 톤
  sendZone: 0x4a4f63,
  grid: 0x2f3444,
  cell: 0x3d4459,
  cellLine: 0x566081,
  abyss: 0x1c2436, // 음: 차가운 톤
  bar: 0x2a2d38,
  happy: 0xf2c94c,
  unhappy: 0x6c7fb3,
  wall: 0x0e1320,
  line: 0xd8c690,
  button: 0x46506b,
  buttonOn: 0x7b8cc4,
  buttonOff: 0x353a4a,
  wildcard: 0xffffff,
  portalClosed: 0x3a3f4f,
  mirror: 0xb8c4d6,
  portalHappy: 0xf6d98a,
  portalUnhappy: 0x8ea3d6,
} as const;

/** 논리 해상도(360×640) 좌표계를 유지한 채 RENDER_SCALE 배율로 그린다. */
export function setupCamera(scene: Phaser.Scene): void {
  const cam = scene.cameras.main;
  cam.setBackgroundColor(COLOR.bg);
  cam.setZoom(RENDER_SCALE);
  cam.centerOn(VIEW_W / 2, VIEW_H / 2);
}

export function text(
  scene: Phaser.Scene,
  x: number,
  y: number,
  content: string,
  style: Phaser.Types.GameObjects.Text.TextStyle = {},
): Phaser.GameObjects.Text {
  return scene.add
    .text(x, y, content, {
      fontFamily: 'sans-serif',
      fontSize: '12px',
      color: '#e8e8e8',
      resolution: RENDER_SCALE,
      ...style,
    })
    .setResolution(RENDER_SCALE);
}

/** 도형 + 텍스트 버튼. 라벨·활성·강조를 나중에 바꿀 수 있다. 비활성이면 탭을 무시한다. */
export class Button {
  readonly container: Phaser.GameObjects.Container;
  private readonly rect: Phaser.GameObjects.Rectangle;
  private readonly label: Phaser.GameObjects.Text;
  enabled = true;
  private active = false;

  constructor(
    scene: Phaser.Scene,
    x: number,
    y: number,
    w: number,
    h: number,
    label: string,
    onClick?: (btn: Button) => void,
    fontSize = '11px',
  ) {
    this.rect = scene.add.rectangle(0, 0, w, h, COLOR.button).setStrokeStyle(1, COLOR.cellLine);
    this.label = text(scene, 0, 0, label, { fontSize, color: '#ffffff' }).setOrigin(0.5);
    this.container = scene.add.container(x, y, [this.rect, this.label]);
    if (onClick) {
      // 이 버튼 위에서 누른 경우만 (조각 드래그를 버튼 위에서 놓아도 눌리지 않게)
      let pressed = false;
      this.rect
        .setInteractive({ useHandCursor: true })
        .on('pointerdown', () => (pressed = true))
        .on('pointerout', () => (pressed = false))
        .on('pointerup', () => {
          if (pressed && this.enabled) onClick(this);
          pressed = false;
        });
    }
  }

  setLabel(label: string): this {
    if (this.label.text !== label) this.label.setText(label);
    return this;
  }

  setEnabled(enabled: boolean): this {
    this.enabled = enabled;
    this.label.setColor(enabled ? '#ffffff' : '#8a8f9e');
    this.rect.setFillStyle(this.active ? COLOR.buttonOn : enabled ? COLOR.button : COLOR.buttonOff);
    return this;
  }

  /** 접힌 패널 안의 버튼: 보이지 않을 때는 입력도 받지 않는다 */
  setShown(shown: boolean): this {
    this.container.setVisible(shown);
    if (this.rect.input) this.rect.input.enabled = shown;
    return this;
  }

  setActive(active: boolean): this {
    this.active = active;
    return this.setEnabled(this.enabled);
  }
}
