// 그리드 조각 표시 + 드래그 입력. 규칙 판정은 core(GameState), 드롭 위치 판정은 layout.dropTarget.
// 모든 조작은 드래그 하나: 칸(이동·머지·교환) / 놓아주기 영역 / 포탈·레인(M3) (v0.3.2, D-019).
import Phaser from 'phaser';
import type { GameState } from '../core/game';
import { isWildcard, type Piece } from '../core/grid';
import type { Chain } from '../data/types';
import { CELL_H, CELL_W, DRAG_THRESHOLD, cellAt, cellCenter, dropTarget } from './layout';
import { releaseHoverLabel, type ReleaseHover } from './ReleaseZoneView';
import { COLOR, text } from './ui';

interface Press {
  pointerId: number;
  from: number;
  startX: number;
  startY: number;
  dragging: boolean;
}

export interface GridViewHooks {
  /** core 상태가 바뀐 뒤 (HUD·버튼 갱신) */
  onChange(): void;
  /** 드래그 중 놓아주기 영역 위 여부 */
  onReleaseHover(hover: ReleaseHover): void;
}

/** 놓아주기 연출: 위로 떠오르며 사라짐 */
const RELEASE_FLOAT_PX = 36;
const RELEASE_FLOAT_MS = 350;
/** 드래그 중 조각 위 미리보기 태그 (조각·손가락이 영역 라벨을 가리므로) */
const TAG_OFFSET_Y = -34;

export class GridView {
  private views: (Phaser.GameObjects.Container | null)[] = [];
  private press: Press | null = null;
  private readonly chainColor = new Map<string, number>();
  private readonly tag: Phaser.GameObjects.Text;

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly state: GameState,
    chains: Chain[],
    private readonly hooks: GridViewHooks,
  ) {
    for (const c of chains) this.chainColor.set(c.archetypeId, parseInt(c.color.slice(1), 16));
    this.tag = text(scene, 0, 0, '', { fontSize: '11px', backgroundColor: '#1b1d24', padding: { x: 4, y: 2 } })
      .setOrigin(0.5)
      .setDepth(30)
      .setVisible(false);
    scene.input.on('pointerdown', this.onDown, this);
    scene.input.on('pointermove', this.onMove, this);
    scene.input.on('pointerup', this.onUp, this);
    scene.input.on('pointerupoutside', this.cancel, this);
    // 드래그 중 백그라운드로 가면 취소 → 원위치
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') this.cancel();
    };
    document.addEventListener('visibilitychange', onVisibility);
    scene.events.once(Phaser.Scenes.Events.SHUTDOWN, () => document.removeEventListener('visibilitychange', onVisibility));
    this.refresh();
  }

  /** core 상태대로 조각을 다시 그린다 */
  refresh(): void {
    for (const v of this.views) v?.destroy();
    this.views = this.state.grid.cells.map((p, i) => (p ? this.makePiece(p, i) : null));
  }

  /** 진행 중인 누름·드래그 취소 → 원위치 */
  cancel(): void {
    if (!this.press) return;
    const { from, dragging } = this.press;
    this.press = null;
    this.setHover(null);
    if (dragging) this.placeAt(from);
  }

  private makePiece(p: Piece, index: number): Phaser.GameObjects.Container {
    const { cols, rows, maxTier } = this.state.grid;
    const { x, y } = cellCenter(cols, rows, index);
    const wild = isWildcard(p);
    const fill = wild ? COLOR.wildcard : (this.chainColor.get(p.chain) ?? 0x999999);
    const rect = this.scene.add.rectangle(0, 0, CELL_W - 8, CELL_H - 8, fill).setStrokeStyle(1, 0x1b1d24);
    const label = wild ? '?' : p.tier >= maxTier ? '★' : String(p.tier);
    const t = text(this.scene, 0, 0, label, { fontSize: '16px', color: '#1b1d24', fontStyle: 'bold' }).setOrigin(0.5);
    return this.scene.add.container(x, y, [rect, t]);
  }

  private placeAt(index: number): void {
    const v = this.views[index];
    if (!v) return;
    const { cols, rows } = this.state.grid;
    const { x, y } = cellCenter(cols, rows, index);
    v.setPosition(x, y).setDepth(0).setScale(1);
  }

  private world(p: Phaser.Input.Pointer): Phaser.Math.Vector2 {
    return this.scene.cameras.main.getWorldPoint(p.x, p.y);
  }

  private onDown(p: Phaser.Input.Pointer): void {
    if (this.press) return; // 동시에 한 조각만 (두 번째 포인터 무시)
    const w = this.world(p);
    const { cols, rows } = this.state.grid;
    const from = cellAt(cols, rows, w.x, w.y);
    if (from === null || !this.state.grid.cells[from]) return;
    this.press = { pointerId: p.id, from, startX: w.x, startY: w.y, dragging: false };
  }

  private onMove(p: Phaser.Input.Pointer): void {
    const press = this.press;
    if (!press || press.pointerId !== p.id) return;
    const w = this.world(p);
    if (!press.dragging && Math.hypot(w.x - press.startX, w.y - press.startY) < DRAG_THRESHOLD) return;
    press.dragging = true;
    this.views[press.from]?.setPosition(w.x, w.y).setDepth(10).setScale(1.1);

    let hover: ReleaseHover = null;
    if (dropTarget(this.state.grid, w.x, w.y).kind === 'release') {
      const refund = this.state.releasePreview(press.from);
      hover = refund === null ? 'blocked' : { refund };
    }
    this.setHover(hover, w.x, w.y);
  }

  private setHover(hover: ReleaseHover, x = 0, y = 0): void {
    this.hooks.onReleaseHover(hover);
    if (hover === null) {
      this.tag.setVisible(false);
      return;
    }
    this.tag
      .setText(releaseHoverLabel(hover))
      .setColor(hover === 'blocked' ? '#8a8f9e' : '#ffffff')
      .setPosition(x, y + TAG_OFFSET_Y)
      .setVisible(true);
  }

  private onUp(p: Phaser.Input.Pointer): void {
    const press = this.press;
    if (!press || press.pointerId !== p.id) return;
    this.press = null;
    this.setHover(null);
    // 임계값 미만 이동: 드래그가 아님 (탭 동작 없음) → 원위치
    if (!press.dragging) return;

    const w = this.world(p);
    const target = dropTarget(this.state.grid, w.x, w.y);
    switch (target.kind) {
      case 'cell':
        if (this.state.drop(press.from, target.index) === 'none') break;
        this.refresh();
        this.hooks.onChange();
        return;
      case 'release':
        if (this.state.release(press.from) === null) break; // 와일드카드 → 원위치
        this.floatAway(press.from);
        this.hooks.onChange();
        return;
      case 'summon':
        // M3에서 소환으로 연결. 지금은 원위치
        console.debug(`[grid] ${target.portal} 쪽 드롭 — M3 전이라 원위치`);
        break;
      case 'none':
        break;
    }
    this.placeAt(press.from);
  }

  /** core는 이미 제거·환급했다. 떼어낸 조각 표시만 떠올려 사라지게 하고 나머지는 다시 그린다 */
  private floatAway(index: number): void {
    const v = this.views[index];
    this.views[index] = null;
    this.refresh(); // 귀환 대기열이 그 칸을 채웠을 수 있음
    if (!v) return;
    v.setDepth(20);
    this.scene.tweens.add({
      targets: v,
      y: v.y - RELEASE_FLOAT_PX,
      alpha: 0,
      scale: 0.8,
      duration: RELEASE_FLOAT_MS,
      ease: 'Sine.easeOut',
      onComplete: () => v.destroy(),
    });
  }
}
