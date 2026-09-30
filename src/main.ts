import Phaser from 'phaser';
import { BootScene } from './scenes/BootScene';
import { ErrorScene } from './scenes/ErrorScene';
import { GameScene } from './scenes/GameScene';
import { RENDER_SCALE, VIEW_H, VIEW_W } from './scenes/layout';

new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'game',
  width: VIEW_W * RENDER_SCALE,
  height: VIEW_H * RENDER_SCALE,
  backgroundColor: '#111111',
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  scene: [BootScene, ErrorScene, GameScene],
});
