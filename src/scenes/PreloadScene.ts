// 스킨 로드 (§5.23-1, §5.16-2): Boot(데이터) → Preload(팩 그림·직접 그린 그림) → Game.
// 매니페스트의 팩 그림을 전부 load, 실패(loaderror)는 경고 한 줄 후 그 키만 빠진다 (게임은 계속). 진행률 막대 하나.
// ?skin=0이면 아무것도 로드하지 않는다.
import Phaser from 'phaser';
import type { GameData } from '../data/types';
import { drawGeneratedTextures } from './skin/generated';
import { PACKS, PACK_ENTRIES } from './skin/manifest';
import { Skin, skinModeFromUrl } from './skin/Skin';
import { VIEW_H, VIEW_W } from './layout';
import { setupCamera } from './ui';

export class PreloadScene extends Phaser.Scene {
  private skin!: Skin;

  constructor() {
    super('Preload');
  }

  preload(): void {
    setupCamera(this);
    this.skin = new Skin(skinModeFromUrl());
    if (this.skin.mode === 'off') return;
    const bar = this.add.rectangle(VIEW_W / 2 - 80, VIEW_H / 2, 0, 4, 0x9fb4e0).setOrigin(0, 0.5);
    this.add.rectangle(VIEW_W / 2, VIEW_H / 2, 160, 6).setStrokeStyle(1, 0x566081);
    this.load.on('progress', (v: number) => (bar.width = 160 * v));
    const failed = new Set<string>();
    this.load.on('loaderror', (file: Phaser.Loader.File) => {
      failed.add(file.key);
      console.warn(`[skin] 로드 실패 (도형으로): ${file.key} ← ${String(file.src)}`);
    });
    for (const [key, e] of Object.entries(PACK_ENTRIES)) {
      if (!e) continue;
      const url = `${PACKS[e.pack].dir}/${e.file}`;
      if (e.frameW && e.frameH) this.load.spritesheet(`pack:${key}`, url, { frameWidth: e.frameW, frameHeight: e.frameH });
      else this.load.image(`pack:${key}`, url);
    }
    this.load.once('complete', () => {
      for (const [key, e] of Object.entries(PACK_ENTRIES)) {
        if (!e || failed.has(`pack:${key}`) || !this.textures.exists(`pack:${key}`)) continue;
        // 픽셀 아트: 이 텍스처만 NEAREST
        this.textures.get(`pack:${key}`).setFilter(Phaser.Textures.FilterMode.NEAREST);
        this.skin.packKeys.add(key);
        this.skin.loadedPacks.add(e.pack);
      }
    });
  }

  create(): void {
    const data = this.registry.get('data') as GameData;
    if (this.skin.mode !== 'off') drawGeneratedTextures(this, data);
    this.registry.set('skin', this.skin);
    if (this.skin.active) console.info(`[skin] ${this.skin.mode} · 팩 ${[...this.skin.loadedPacks].join(', ') || '없음'} · 팩 그림 ${this.skin.packKeys.size}개`);
    this.scene.start('Game');
  }
}
