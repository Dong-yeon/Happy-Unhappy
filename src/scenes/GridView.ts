// 머지 판 조각 표시 + 드래그 입력. 규칙 판정은 core(GameState), 드롭 위치 판정은 layout.dropTarget.
// 모든 조작은 드래그 하나: 자리(이동·머지·교환) / 놓아주기 영역 (v0.3.2, D-019). 먹이기는 §5.20에서 삭제.
// §5.20-13: 칸 테두리 없이 체인 색 동그라미 + "체인 첫 글자·단계". 저절로·처치 드롭 조각은 처치 지점에서 날아와 자리에 앉는다.
import Phaser from 'phaser';
import type { CoreEvent, GameState } from '../core/game';
import { isWildcard, type Piece } from '../core/grid';
import type { GameData } from '../data/types';
import { DRAG_THRESHOLD, cellAt, cellCenter, dropTarget, gridLayout, toScreen } from './layout';
import { chainShortName } from './laneUnits';
import { releaseHoverLabel, type ReleaseHover } from './ReleaseZoneView';
import { COLOR, text } from './ui';

interface Press {
  pointerId: number;
  from: number;
  startX: number;
  startY: number;
  dragging: boolean;
}

/** 드래그 중 조각이 올라가 있는 드롭 대상 */
export type DragHover =
  | { kind: 'release'; hover: Exclude<ReleaseHover, null> }
  | null;

export interface GridViewHooks {
  /** core 상태가 바뀐 뒤 (HUD·버튼 갱신) */
  onChange(): void;
  /** 드래그 중 놓아주기 영역 위 여부 */
  onHover(hover: DragHover): void;
  /** 지금 그리드를 만질 수 있는지 (낮·밤이고 모달이 없을 때) */
  canInteract(): boolean;
  /** metrics: 드래그를 놓은 결과 (실패 사유 없으면 null) + 시작 → 놓은 점 거리 (논리 px) */
  onDropResult?(fail: 'invalid' | 'laneFull' | 'wildcard' | null, distance: number): void;
}

/** 조각 라벨: 와일드카드 ? / 최고 단계 ★ / 단계 숫자 */
export function pieceLabel(p: Piece, maxTier: number): string {
  if (isWildcard(p)) return '?';
  return p.tier >= maxTier ? '★' : String(p.tier);
}

/** 조각이 날아와 앉는 시간 / 버려진 조각 표시 시간 */
const FLY_MS = 380;
const DISCARD_MS = 600;

/** 놓아주기 연출: 위로 떠오르며 사라짐 */
const RELEASE_FLOAT_PX = 36;
const RELEASE_FLOAT_MS = 350;
/** 드래그 중 조각 위 미리보기 태그 (조각·손가락이 영역 라벨을 가리므로) */
const TAG_OFFSET_Y = -34;

export class GridView {
  private views: (Phaser.GameObjects.Container | null)[] = [];
  private press: Press | null = null;
  private readonly chainColor = new Map<string, number>();
  private readonly chainInitial = new Map<string, string>();
  private readonly tag: Phaser.GameObjects.Text;

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly state: GameState,
    data: GameData,
    private readonly hooks: GridViewHooks,
  ) {
    for (const c of data.chains) {
      this.chainColor.set(c.archetypeId, parseInt(c.color.slice(1), 16));
      this.chainInitial.set(c.archetypeId, chainShortName(c).slice(0, 1));
    }
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

  /** 조각 표시: 체인 색 동그라미 + "체인 첫 글자 + 단계" (최고 단계 ★, 와일드카드 ?) (§5.20-13) */
  private makePiece(p: Piece, index: number): Phaser.GameObjects.Container {
    const { cols, rows } = this.state.grid;
    const { x, y } = cellCenter(cols, rows, index);
    const r = gridLayout(cols, rows).tokenR;
    const top = !isWildcard(p) && p.tier >= this.state.grid.maxTier;
    const disc = this.scene.add.circle(0, 0, r, this.colorOf(p)).setStrokeStyle(top ? 3 : 1, top ? 0xffffff : 0x1b1d24);
    const label = isWildcard(p) ? '?' : `${this.chainInitial.get(p.chain) ?? ''}${pieceLabel(p, this.state.grid.maxTier)}`;
    const t = text(this.scene, 0, 0, label, { fontSize: '13px', color: '#1b1d24', fontStyle: 'bold' }).setOrigin(0.5);
    return this.scene.add.container(x, y, [disc, t]);
  }

  /**
   * 조각이 생김 (core가 이미 그리드에 넣었다): 처치 지점(없으면 판 위쪽)에서 날아와 자리에 앉는다.
   * 버려진 조각(그리드 가득)은 처치 지점에서 잠깐 보였다 사라진다. 드래그 중인 조각은 건드리지 않는다.
   */
  handle(events: CoreEvent[]): void {
    for (const e of events) {
      if (e.type !== 'piece') continue;
      const from = e.from ? toScreen(e.from.role === 'offense' ? 'abyss' : 'defense', e.from.x, e.from.y) : null;
      if (e.index === null) {
        if (!from) continue;
        const ghost = this.scene.add.circle(from.x, from.y, 7, this.colorOf(e.piece), 0.8).setDepth(25);
        this.scene.tweens.add({ targets: ghost, alpha: 0, scale: 0.4, duration: DISCARD_MS, onComplete: () => ghost.destroy() });
        continue;
      }
      if (this.views[e.index] || this.state.grid.cells[e.index]?.id !== e.piece.id) continue;
      const v = this.makePiece(this.state.grid.cells[e.index]!, e.index);
      this.views[e.index] = v;
      const to = { x: v.x, y: v.y };
      const start = from ?? { x: to.x, y: to.y - 18 };
      v.setPosition(start.x, start.y).setScale(0.35).setAlpha(from ? 1 : 0).setDepth(5);
      this.scene.tweens.add({
        targets: v,
        x: to.x,
        y: to.y,
        scale: 1,
        alpha: 1,
        duration: FLY_MS,
        ease: 'Sine.easeOut',
        onComplete: () => v.active && v.setDepth(0),
      });
    }
  }

  colorOf(p: Piece): number {
    return isWildcard(p) ? COLOR.wildcard : (this.chainColor.get(p.chain) ?? 0x999999);
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
    if (!this.hooks.canInteract()) return;
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

    const target = dropTarget(this.state.grid, w.x, w.y);
    let hover: DragHover = null;
    if (target.kind === 'release') {
      const p = this.state.grid.cells[press.from];
      hover = { kind: 'release', hover: !p || isWildcard(p) ? 'blocked' : 'ok' };
    }
    this.setHover(hover, w.x, w.y, press.from);
  }

  /** 영역 표시는 scene에, 조각 위 태그는 여기서 (조각·손가락이 영역 라벨을 가리므로) */
  private setHover(hover: DragHover, x = 0, y = 0, _from = -1): void {
    this.hooks.onHover(hover);
    let label: string | null = null;
    let blocked = false;
    if (hover?.kind === 'release') {
      label = releaseHoverLabel(hover.hover);
      blocked = hover.hover === 'blocked';
    }
    if (label === null) {
      this.tag.setVisible(false);
      return;
    }
    this.tag
      .setText(label)
      .setColor(blocked ? '#8a8f9e' : '#ffffff')
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
    const distance = Math.hypot(w.x - press.startX, w.y - press.startY);
    const report = (fail: 'invalid' | 'laneFull' | 'wildcard' | null) => this.hooks.onDropResult?.(fail, distance);
    switch (target.kind) {
      case 'cell':
        report(null); // 같은 칸·놓을 수 없는 칸은 원위치일 뿐 영역 밖은 아니다
        if (this.state.drop(press.from, target.index) === 'none') break;
        this.refresh();
        this.hooks.onChange();
        return;
      case 'release':
        report(null);
        if (!this.state.release(press.from)) break; // 와일드카드 → 원위치
        this.floatAway(press.from);
        this.hooks.onChange();
        return;
      case 'none':
        report('invalid');
        break;
    }
    this.placeAt(press.from);
  }

  /** core는 이미 제거했다. 떼어낸 조각 표시만 떠올려 사라지게 한다 */
  private floatAway(index: number): void {
    const v = this.views[index];
    this.views[index] = null;
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
