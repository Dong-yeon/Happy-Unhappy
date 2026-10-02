// 스킨 로드 (§5.23-1, §5.16-2): Boot(데이터) → Preload(팩 그림·직접 그린 그림) → Game.
// 매니페스트의 팩 그림을 전부 load, 실패(loaderror)는 경고 한 줄 후 그 키만 빠진다 (게임은 계속). 진행률 막대 하나.
// ?skin=0이면 아무것도 로드하지 않는다.
import Phaser from 'phaser';
import type { GameData } from '../data/types';
import { drawGeneratedTextures } from './skin/generated';
import { PACKS, PACK_ENTRIES } from './skin/manifest';
import { PACK_FRAME, Skin, skinModeFromUrl } from './skin/Skin';
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
    // 로드 실패(파일 없음·경로 오타): 그 키만 빠지고(도형/직접 그림으로) 게임은 계속. 경고는 끝나고 한 번에 1회.
    // (Vite 개발 서버는 없는 파일에 index.html을 200으로 돌려줘 loaderror가 안 날 수 있다 → 텍스처가 안 생긴 키를 실패로 본다)
    const failed = new Map<string, string>();
    for (const [key, e] of Object.entries(PACK_ENTRIES)) {
      if (!e) continue;
      this.load.image(`pack:${key}`, `${PACKS[e.pack].dir}/${e.file}`);
    }
    this.load.once('complete', () => {
      for (const [key, e] of Object.entries(PACK_ENTRIES)) {
        if (!e) continue;
        if (!this.textures.exists(`pack:${key}`)) {
          failed.set(key, `${PACKS[e.pack].dir}/${e.file}`);
          continue;
        }
        const tex = this.textures.get(`pack:${key}`);
        // 픽셀 아트: 이 텍스처만 NEAREST
        tex.setFilter(Phaser.Textures.FilterMode.NEAREST);
        if (e.rect) tex.add(PACK_FRAME, 0, ...e.rect);
        this.skin.packKeys.add(key);
        this.skin.loadedPacks.add(e.pack);
      }
      if (failed.size) console.warn(`[skin] 팩 그림 ${failed.size}개 로드 실패 → 그 키만 도형/직접 그림으로: ${[...failed].map(([k, src]) => `${k} ← ${src}`).join(', ')}`);
    });
  }

  create(): void {
    const data = this.registry.get('data') as GameData;
    if (this.skin.active) drawGeneratedTextures(this, data); // 팩 없음·?skin=0이면 그리지 않음 (도형 그대로)
    this.registry.set('skin', this.skin);
    if (this.skin.active) console.info(`[skin] ${this.skin.mode} · 팩 ${[...this.skin.loadedPacks].join(', ') || '없음'} · 팩 그림 ${this.skin.packKeys.size}개`);
    this.scene.start('Game');
  }
}
