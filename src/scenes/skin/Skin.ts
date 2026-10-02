// 스킨 (§5.23-1, §5.16-2): has(key)면 그림, 아니면 각 View가 지금 도형 그대로.
// 모드: ?skin=0 → off(전부 도형·연출 추가분도 끔 = M8.12 화면) / ?skin=gen → 직접 그린 그림 기호만으로 미리보기 /
//       기본 auto → 로드된 팩이 하나라도 있으면 그림(팩 → 없으면 직접 그린 임시 그림), 팩이 없으면 도형 그대로.
// 픽셀 아트 팩 텍스처만 NEAREST·정수 배율 (전역 pixelArt는 켜지 않는다).
import Phaser from 'phaser';
import { GENERATED, PACKS, PACK_ENTRIES, type PackId, textureKey } from './manifest';
import { genSize } from './generated';

export type SkinMode = 'off' | 'auto' | 'gen';

export function skinModeFromUrl(search: string = typeof location !== 'undefined' ? location.search : ''): SkinMode {
  const v = new URLSearchParams(search).get('skin');
  if (v === '0') return 'off';
  if (v === 'gen') return 'gen';
  return 'auto';
}

export class Skin {
  /** 텍스처가 실제로 로드된 팩 */
  readonly loadedPacks = new Set<PackId>();
  /** 로드에 성공한 팩 그림 키 */
  readonly packKeys = new Set<string>();

  constructor(readonly mode: SkinMode) {}

  /** 그림을 쓰는지 (팩이 있거나 gen 미리보기) */
  get active(): boolean {
    return this.mode === 'gen' || (this.mode === 'auto' && this.loadedPacks.size > 0);
  }

  /** 1챕터 연출 추가분(§5.23-2)을 켜는지: ?skin=0이면 끔 (M8.12 화면과 같게) */
  get fx(): boolean {
    return this.mode !== 'off';
  }

  has(key: string): boolean {
    if (!this.active) return false;
    if (this.mode !== 'gen' && this.packKeys.has(key)) return true;
    return GENERATED.has(key);
  }

  /** 의미 키 → 텍스처·프레임 (has가 true일 때만) */
  frame(key: string): { texture: string; frame?: string | number; packed: boolean } {
    if (this.mode !== 'gen' && this.packKeys.has(key)) {
      const e = PACK_ENTRIES[key]!;
      return { texture: `pack:${key}`, frame: e.frame, packed: true };
    }
    return { texture: textureKey(key), packed: false };
  }

  /**
   * 그림 하나 (가운데 기준). size = 논리 px 높이(없으면 생성 그림 기본 크기).
   * 팩 그림은 정수 배율로 맞추고, 생성 그림은 RENDER_SCALE로 그려 둔 것을 논리 크기로 줄인다.
   */
  image(scene: Phaser.Scene, key: string, x: number, y: number, size?: number): Phaser.GameObjects.Image {
    const f = this.frame(key);
    const img = scene.add.image(x, y, f.texture, f.frame);
    if (f.packed) {
      const e = PACK_ENTRIES[key]!;
      const h = img.frame.realHeight;
      const k = size ? Math.max(1, Math.round(size / h)) : (e.scale ?? 1);
      img.setScale(k);
      if (e.tint !== undefined) img.setTint(e.tint);
    } else {
      const g = genSize(key);
      const h = size ?? g.h;
      img.setDisplaySize((g.w * h) / g.h, h);
    }
    return img;
  }

  /** 크레딧: 로드된 팩만 (§5.16-6) */
  credits(): { name: string; author: string; url: string }[] {
    return [...this.loadedPacks].map((p) => PACKS[p]);
  }
}

/** scene registry에서 스킨 (없으면 도형만 쓰는 꺼진 스킨) */
export function skinOf(scene: Phaser.Scene): Skin {
  return (scene.registry.get('skin') as Skin | undefined) ?? new Skin('off');
}
