// 그리드 조각 표시 + 드래그 입력. 규칙 판정은 core(GameState), 드롭 위치 판정은 layout.dropTarget.
// 모든 조작은 드래그 하나: 칸(이동·머지·교환) / 놓아주기 영역 / 포탈·땅 띠(소환·맡기기) (v0.3.2, D-019, §4.3.1, §5.11-2).
import Phaser from 'phaser';
import type { GameState, SummonBlock, SummonResult } from '../core/game';
import { isWildcard, type Piece } from '../core/grid';
import type { Chain } from '../data/types';
import { CELL_H, CELL_W, DRAG_THRESHOLD, PORTAL, PORTAL_RADIUS, cellAt, cellCenter, dropTarget, type PortalId } from './layout';
import { portalBubble } from './portalBubble';
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
  | { kind: 'summon'; portal: PortalId; block: SummonBlock | null }
  | null;

export interface GridViewHooks {
  /** core 상태가 바뀐 뒤 (HUD·버튼 갱신) */
  onChange(): void;
  /** 드래그 중 놓아주기 영역·포탈 위 여부 */
  onHover(hover: DragHover): void;
  /** 소환·맡기기 성공: 드롭 지점에서 연출 시작 (core는 이미 유닛 생성 / nightParty에 넣음) */
  onSummon(result: Extract<SummonResult, { ok: true }>, fromX: number, fromY: number): void;
  /** 지금 단계에서 땅 띠가 맡는 포탈 (낮 창문 / 밤 손거울, 아니면 null) */
  groundPortal(): PortalId | null;
  /** 지금 그리드를 만질 수 있는지 (하루 단계가 waves이고 모달이 없을 때) */
  canInteract(): boolean;
  /** metrics: 드래그를 놓은 결과 (실패 사유 없으면 null) + 시작 → 놓은 점 거리 (논리 px) */
  onDropResult?(fail: 'invalid' | 'laneFull' | 'wildcard' | null, distance: number): void;
}

/** 전설·조합 미리보기 금색 */
const GOLD = 0xf2c94c;

/** 조각 라벨: 와일드카드 ? / 전설 ◆ / 영웅 ★ / 단계 숫자 */
export function pieceLabel(p: Piece, maxTier: number): string {
  if (isWildcard(p)) return '?';
  if (p.legend) return '◆';
  return p.tier >= maxTier ? '★' : String(p.tier);
}

const SUMMON_BLOCKED_LABEL: Partial<Record<SummonBlock, string>> = {
  wildcard: '보낼 수 없음',
  closed: '밤에는 닫힘',
  partyFull: '맡길 자리 없음',
};

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
  /** 포탈 위 말풍선: 쉬는 조각 "쉬는 중이에요" (§5.13-2) */
  private readonly bubble: Phaser.GameObjects.Container;
  private readonly bubbleText: Phaser.GameObjects.Text;
  /** 조합 미리보기: 대상 칸 금색 테두리 (§5.13-5) */
  private readonly combineFrame: Phaser.GameObjects.Rectangle;

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
    this.bubbleText = text(scene, 0, 0, '', {
      fontSize: '11px',
      color: '#2a2418',
      backgroundColor: '#f6e7b8',
      padding: { x: 6, y: 4 },
    }).setOrigin(0.5, 1);
    const tail = scene.add.triangle(0, 0, -5, 0, 5, 0, 0, 6, 0xf6e7b8).setOrigin(0.5, 0);
    this.bubble = scene.add.container(0, 0, [this.bubbleText, tail]).setDepth(31).setVisible(false);
    this.combineFrame = scene.add
      .rectangle(0, 0, CELL_W - 2, CELL_H - 2)
      .setStrokeStyle(3, GOLD)
      .setFillStyle(GOLD, 0.12)
      .setDepth(9)
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

  /**
   * 조각 표시: 빛나는 영웅 = 금빛 테두리 + ✦ / 전설 = 굵은 금 테두리 + ◆ / 쉬는 중 = 흐리게 + 붕대 띠 (§5.13)
   */
  private makePiece(p: Piece, index: number): Phaser.GameObjects.Container {
    const { cols, rows } = this.state.grid;
    const { x, y } = cellCenter(cols, rows, index);
    const parts: Phaser.GameObjects.GameObject[] = [];
    const fill = isWildcard(p) ? COLOR.wildcard : (this.chainColor.get(p.chain) ?? 0x999999);
    const rect = this.scene.add.rectangle(0, 0, CELL_W - 8, CELL_H - 8, fill);
    if (p.legend) rect.setStrokeStyle(3, GOLD);
    else if (p.shining) rect.setStrokeStyle(2, 0xfff1a8);
    else rect.setStrokeStyle(1, 0x1b1d24);
    parts.push(rect);
    const t = text(this.scene, 0, 0, pieceLabel(p, this.state.grid.maxTier), { fontSize: '16px', color: '#1b1d24', fontStyle: 'bold' }).setOrigin(0.5);
    parts.push(t);
    if (p.shining && !p.legend) parts.push(text(this.scene, CELL_W / 2 - 10, -CELL_H / 2 + 8, '✦', { fontSize: '10px', color: '#fff1a8' }).setOrigin(0.5));
    if (p.legend) {
      const name = this.state.recipes.find((r) => r.id === p.legend)?.name ?? '';
      parts.push(text(this.scene, 0, CELL_H / 2 - 9, name, { fontSize: '7px', color: '#3b2a00' }).setOrigin(0.5));
    }
    if (p.restUntil) {
      // 붕대: 흰 띠 두 줄 + 흐리게 (쉬는 동안 포탈 거부)
      rect.setAlpha(0.55);
      t.setAlpha(0.6);
      parts.push(this.scene.add.rectangle(0, 0, CELL_W - 10, 6, 0xf5f2e8).setAngle(-28).setStrokeStyle(1, 0xc9c2ad));
      parts.push(this.scene.add.rectangle(0, 0, CELL_W - 10, 6, 0xf5f2e8).setAngle(28).setStrokeStyle(1, 0xc9c2ad));
    }
    return this.scene.add.container(x, y, parts);
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

    const target = dropTarget(this.state.grid, w.x, w.y, this.hooks.groundPortal());
    let hover: DragHover = null;
    if (target.kind === 'release') {
      const refund = this.state.releasePreview(press.from);
      hover = { kind: 'release', hover: refund === null ? 'blocked' : { refund } };
    } else if (target.kind === 'summon') {
      hover = { kind: 'summon', portal: target.portal, block: this.state.canSummon(press.from, target.portal) };
    }
    this.setHover(hover, w.x, w.y);
    // 쉬는 조각을 포탈에 올리면 "쉬는 중이에요" (§5.13-2)
    const portal = hover?.kind === 'summon' ? hover.portal : null;
    const msg = portalBubble(this.state, press.from, portal);
    this.bubble.setVisible(msg !== null);
    if (msg && portal) {
      this.bubbleText.setText(msg);
      this.bubble.setPosition(PORTAL[portal].x, PORTAL[portal].y - PORTAL_RADIUS - 10);
    }
    // 조합 미리보기: 조합되는 칸이면 금색 테두리 + 결과 이름 (§5.13-5)
    const recipe = target.kind === 'cell' ? this.state.combinePreview(press.from, target.index) : null;
    this.combineFrame.setVisible(recipe !== null);
    if (recipe && target.kind === 'cell') {
      const c = cellCenter(this.state.grid.cols, this.state.grid.rows, target.index);
      this.combineFrame.setPosition(c.x, c.y);
      this.tag.setText(`✦ ${recipe.name}`).setColor('#ffe08a').setPosition(w.x, w.y + TAG_OFFSET_Y).setVisible(true);
    }
  }

  /** 영역·포탈 표시는 scene에, 조각 위 태그는 여기서 (조각·손가락이 영역 라벨을 가리므로) */
  private setHover(hover: DragHover, x = 0, y = 0): void {
    this.hooks.onHover(hover);
    if (hover === null) {
      this.bubble.setVisible(false);
      this.combineFrame.setVisible(false);
    }
    let label: string | null = null;
    let blocked = false;
    if (hover?.kind === 'release') {
      label = releaseHoverLabel(hover.hover);
      blocked = hover.hover === 'blocked';
    } else if (hover?.kind === 'summon' && hover.block && SUMMON_BLOCKED_LABEL[hover.block]) {
      // laneFull은 닫힌 포탈로 보여 주므로 태그 없음
      label = SUMMON_BLOCKED_LABEL[hover.block]!;
      blocked = true;
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
    const target = dropTarget(this.state.grid, w.x, w.y, this.hooks.groundPortal());
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
        if (this.state.release(press.from) === null) break; // 와일드카드 → 원위치
        this.floatAway(press.from);
        this.hooks.onChange();
        return;
      case 'summon': {
        const r = this.state.summon(press.from, target.portal);
        // metrics: 닫힌 포탈(밤의 창문)·맡길 자리 없음도 "닫힌 포탈(정원)"으로 센다
        report(r.ok ? null : r.reason === 'empty' ? 'invalid' : r.reason === 'wildcard' ? 'wildcard' : 'laneFull');
        if (!r.ok) break;
        const v = this.views[press.from];
        this.views[press.from] = null;
        v?.destroy(); // 소환·맡기기 연출은 레인·맡긴 추억 줄 쪽에서 새 표시로
        this.refresh(); // 귀환 대기열이 그 칸을 채웠을 수 있음
        this.hooks.onSummon(r, w.x, w.y);
        this.hooks.onChange();
        return;
      }
      case 'none':
        report('invalid');
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
