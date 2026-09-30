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

export function button(
  scene: Phaser.Scene,
  x: number,
  y: number,
  w: number,
  h: number,
  label: string,
  opts: { active?: boolean; enabled?: boolean; onClick?: () => void } = {},
): Phaser.GameObjects.Container {
  const { active = false, enabled = true, onClick } = opts;
  const rect = scene.add.rectangle(0, 0, w, h, active ? COLOR.buttonOn : COLOR.button).setStrokeStyle(1, COLOR.cellLine);
  const t = text(scene, 0, 0, label, { fontSize: '11px', color: enabled ? '#ffffff' : '#8a8f9e' }).setOrigin(0.5);
  const c = scene.add.container(x, y, [rect, t]);
  if (enabled && onClick) {
    rect.setInteractive({ useHandCursor: true }).on('pointerup', onClick);
  }
  return c;
}
