// 스킨 매니페스트 (§5.23-1, §5.16-7): 모든 의미 키가 팩 그림을 갖거나 직접 그린 그림(임시)으로 명시됨 — 이미지 로드 없이 키만 검사
import { describe, expect, it } from 'vitest';
import { rawGameData } from '../src/data';
import { CHAINS, ENEMIES, GENERATED, HEROES, PACKS, PACK_ENTRIES, SKIN_KEYS } from '../src/scenes/skin/manifest';
import { Skin, skinModeFromUrl } from '../src/scenes/skin/Skin';

describe('스킨 매니페스트', () => {
  it('키가 데이터의 영웅·적·체인·단계를 모두 덮는다', () => {
    const maxTier = rawGameData.balance.grid.maxTier;
    const heroes = rawGameData.heroes.heroes.filter((h) => !('reward' in h) || h.reward !== 'debug').map((h) => h.id);
    expect([...HEROES].sort()).toEqual(heroes.sort());
    expect([...ENEMIES].sort()).toEqual(rawGameData.monsters.enemies.map((e) => e.id).sort());
    expect([...CHAINS].sort()).toEqual(rawGameData.chains.map((c) => c.archetypeId).sort());
    for (const c of CHAINS) {
      expect(SKIN_KEYS).toContain(`soldier.${c}`);
      for (let t = 1; t <= maxTier; t++) expect(SKIN_KEYS).toContain(`piece.${c}.t${t}`);
    }
    for (const k of ['ui.storybook', 'ui.seed', 'ui.well', 'bg.day', 'bg.night', 'ui.button', 'ui.panel', 'piece.wildcard']) expect(SKIN_KEYS).toContain(k);
  });

  it('모든 키 = 팩 그림 또는 직접 그린 그림 (ui.button·ui.panel만 팩 전용: 없으면 지금 도형 버튼)', () => {
    for (const k of SKIN_KEYS) {
      const ok = PACK_ENTRIES[k] !== undefined || GENERATED.has(k) || k === 'ui.button' || k === 'ui.panel';
      expect(ok, k).toBe(true);
    }
    for (const [k, e] of Object.entries(PACK_ENTRIES)) {
      expect(SKIN_KEYS, `알 수 없는 키 ${k}`).toContain(k);
      expect(PACKS[e!.pack]).toBeDefined();
    }
  });

  it('?skin=0 → off, ?skin=gen → gen, 그 밖 → auto', () => {
    expect(skinModeFromUrl('?skin=0')).toBe('off');
    expect(skinModeFromUrl('?debug=1&skin=gen')).toBe('gen');
    expect(skinModeFromUrl('?debug=1')).toBe('auto');
  });

  it('팩 없음·?skin=0 → 그림·연출 추가분 모두 꺼짐 (M8.12 화면 그대로, §5.23-5)', () => {
    for (const mode of ['off', 'auto'] as const) {
      const sk = new Skin(mode);
      expect(sk.active).toBe(false);
      expect(sk.fx).toBe(false);
      expect(sk.has('hero.sapsal')).toBe(false);
      expect(sk.credits()).toEqual([]);
    }
    const withPack = new Skin('auto');
    withPack.loadedPacks.add('cute_fantasy');
    expect(withPack.fx).toBe(true);
    expect(withPack.credits().map((c) => c.author)).toEqual(['Kenmi']);
    expect(new Skin('gen').fx).toBe(true);
  });
});
