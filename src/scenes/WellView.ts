// 이야기 우물 (§5.21, D-065): 머지 판의 조각이 물고기처럼 헤엄친다. 헤엄·합치기 판정은 pond.ts(Phaser 없음),
// 이 파일은 그리기와 입력만. core 칸(5×4)은 그대로이고 화면에는 칸을 그리지 않는다.
// 판을 누르면 전부 정지 → 끄는 조각만 손가락을 따라감 → 놓은 곳 반지름 30px 안 같은 조각과 합침(core drop) / 놓아주기 칸 / 그 자리에서 다시 헤엄.
// 새 조각: 저절로 = 가장자리에서 퐁, 처치 드롭 = 전장에서 날아와 물에 떨어짐(물결 0.3초). 합쳐지면 톡 튀어 오른 뒤 헤엄.
import Phaser from 'phaser';
import type { CoreEvent, GameState } from '../core/game';
import { isWildcard, type Piece } from '../core/grid';
import type { GameData } from '../data/types';
import { DRAG_THRESHOLD, REGION, RELEASE_HIT, SKILL_BTN_R, WELL, inRect, skillButtonCenter, toScreen } from './layout';
import { Pond, type Fish } from './pond';
import { releaseHoverLabel, type ReleaseHover } from './ReleaseZoneView';
import { skinOf } from './skin/Skin';
import { COLOR, text } from './ui';

/** 드래그 중 조각이 올라가 있는 드롭 대상 */
export type DragHover = { kind: 'release'; hover: Exclude<ReleaseHover, null> } | null;

export interface WellViewHooks {
  /** core 상태가 바뀐 뒤 (HUD·버튼 갱신) */
  onChange(): void;
  /** 드래그 중 놓아주기 영역 위 여부 */
  onHover(hover: DragHover): void;
  /** 지금 판을 만질 수 있는지 (낮·밤이고 모달이 없을 때) */
  canInteract(): boolean;
  /** metrics: 드래그를 놓은 결과 (실패 사유 없으면 null) + 시작 → 놓은 점 거리 (논리 px) */
  onDropResult?(fail: 'invalid' | 'laneFull' | 'wildcard' | null, distance: number): void;
}

/** 조각 라벨: 와일드카드 ? / 최고 단계 ★ / 단계 숫자 */
export function pieceLabel(p: Piece, maxTier: number): string {
  if (isWildcard(p)) return '?';
  return p.tier >= maxTier ? '★' : String(p.tier);
}

const DEPTH = 4;
/** 날아오기 / 물결 / 퐁 / 톡 / 놓아주기 연출 (ms) */
const FLY_MS = 420;
const RIPPLE_MS = 300;
const POP_MS = 260;
const HOP_MS = 280;
/** 자동 뭉침: 사라진 조각이 짝에게 빨려 들어가는 시간 (D-070) */
const ABSORB_MS = 200;
const HOP_PX = 10;
const RELEASE_FLOAT_PX = 36;
const RELEASE_FLOAT_MS = 350;
const TAG_OFFSET_Y = -32;
/** 한 프레임 dt 상한 (백그라운드 복귀 직후 순간이동 방지) */
const MAX_DT = 0.1;

interface View {
  c: Phaser.GameObjects.Container;
  disc: Phaser.GameObjects.Arc;
  label: Phaser.GameObjects.Text;
  /** 톡 튀어 오름 높이 (위치에 더함) */
  lift: { v: number };
}

interface Press {
  pointerId: number;
  /** 집은 조각 (빈 물을 누르면 null) */
  id: number | null;
  startX: number;
  startY: number;
  dragging: boolean;
}

export class WellView {
  readonly pond: Pond;
  private readonly views = new Map<number, View>();
  private readonly chainColor = new Map<string, number>();
  private readonly chainInitial = new Map<string, string>();
  private readonly tag: Phaser.GameObjects.Text;
  private press: Press | null = null;
  /** 이번 프레임에 core가 알린 새 조각: piece.id → 생긴 길 */
  private readonly arrivals = new Map<number, Extract<CoreEvent, { type: 'piece' }>>();

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly state: GameState,
    data: GameData,
    private readonly hooks: WellViewHooks,
  ) {
    for (const c of data.chains) {
      this.chainColor.set(c.archetypeId, parseInt(c.color.slice(1), 16));
      this.chainInitial.set(c.archetypeId, c.name.slice(0, 1));
    }
    const n = data.balance.team.teamSize;
    // 스킬 버튼을 피해서 헤엄 (팀 인원 수와 상관없이 최대 줄 전체를 비워 둔다)
    const obstacles = Array.from({ length: n }, (_, i) => ({ ...skillButtonCenter(i, n), r: SKILL_BTN_R + 6 }));
    this.pond = new Pond(Math.random, obstacles);
    this.tag = text(scene, 0, 0, '', { fontSize: '11px', backgroundColor: '#1b1d24', padding: { x: 4, y: 2 } })
      .setOrigin(0.5)
      .setDepth(30)
      .setVisible(false);
    scene.input.on('pointerdown', this.onDown, this);
    scene.input.on('pointermove', this.onMove, this);
    scene.input.on('pointerup', this.onUp, this);
    scene.input.on('pointerupoutside', this.cancel, this);
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') this.cancel();
    };
    document.addEventListener('visibilitychange', onVisibility);
    scene.events.once(Phaser.Scenes.Events.SHUTDOWN, () => document.removeEventListener('visibilitychange', onVisibility));
    this.refresh();
  }

  /** 우물 그리기: 판 배경 + 돌테 + 물빛 (칸·자리 표시 없음) */
  static drawWell(scene: Phaser.Scene): void {
    const b = REGION.board;
    scene.add.rectangle(b.x, b.y, b.w, b.h, COLOR.grid).setOrigin(0).setDepth(0);
    const w = WELL;
    // 스킨: 직접 그린 우물 (§5.23-1 ui.well)
    const skin = skinOf(scene);
    if (skin.has('ui.well')) {
      skin.image(scene, 'ui.well', w.x + w.w / 2, w.y + w.h / 2, w.h + w.rim * 2).setDepth(1);
      return;
    }
    const g = scene.add.graphics().setDepth(1);
    // 돌테 (바깥 → 안쪽 두 겹)
    g.fillStyle(0x5d5a52, 1).fillRoundedRect(w.x - w.rim, w.y - w.rim, w.w + w.rim * 2, w.h + w.rim * 2, w.r + w.rim);
    g.lineStyle(1, 0x8a857a, 1).strokeRoundedRect(w.x - w.rim, w.y - w.rim, w.w + w.rim * 2, w.h + w.rim * 2, w.r + w.rim);
    // 물빛: 깊은 물 + 가운데 밝은 물
    g.fillStyle(0x1f4e6b, 1).fillRoundedRect(w.x, w.y, w.w, w.h, w.r);
    g.fillStyle(0x2c6a8a, 0.55).fillRoundedRect(w.x + 18, w.y + 18, w.w - 36, w.h - 36, w.r - 14);
    g.fillStyle(0x3d86a8, 0.25).fillEllipse(w.x + w.w / 2, w.y + w.h / 2, w.w * 0.55, w.h * 0.45);
    g.lineStyle(2, 0x10324a, 0.9).strokeRoundedRect(w.x, w.y, w.w, w.h, w.r);
  }

  /** core 그리드와 맞춘다 (보스 보상·편성 재시작·디버그 지급 뒤). 이미 있는 조각은 제자리에서 계속 헤엄 */
  refresh(): void {
    const res = this.pond.sync(this.state.grid);
    for (const f of res.removed) this.dropView(f.id);
    for (const f of [...res.added, ...res.changed]) this.rebuild(f);
  }

  /** 진행 중인 누름·드래그 취소 → 그 자리에서 다시 헤엄 */
  cancel(): void {
    if (!this.press) return;
    this.press = null;
    this.state.heldCells.clear();
    this.setHover(null);
    this.pond.cancel();
  }

  /** core 이벤트: 새 조각이 어디서 왔는지 기억 (다음 sync에서 연출) */
  handle(events: CoreEvent[]): void {
    let any = false;
    for (const e of events) {
      if (e.type === 'piece') {
        if (e.index !== null) this.arrivals.set(e.piece.id, e);
        else if (e.from) this.discardFx(e);
        any = true;
      } else if (e.type === 'autoMerge') {
        this.absorbFx(e.from, e.to);
      }
    }
    if (any) this.syncArrivals();
  }

  /** 매 프레임: 헤엄 → 표시 위치 */
  update(dtMs: number): void {
    this.pond.step(Math.min(MAX_DT, dtMs / 1000), this.state.grid.maxTier, this.state.autoMergeMaxTier);
    for (const [id, v] of this.views) {
      const f = this.pond.fish.get(id);
      if (f) v.c.setPosition(f.x, f.y - v.lift.v);
    }
  }

  private syncArrivals(): void {
    const res = this.pond.sync(this.state.grid, (p) => {
      const e = this.arrivals.get(p.id);
      if (!e) return null;
      return e.source === 'auto' ? this.pond.rimPoint() : this.pond.randomPoint();
    });
    for (const f of res.removed) this.dropView(f.id);
    for (const f of res.changed) this.rebuild(f);
    for (const f of res.added) {
      const v = this.rebuild(f);
      const e = this.arrivals.get(f.id);
      if (!e) continue;
      if (e.source === 'auto' || !e.from) {
        // 가장자리에서 퐁
        v.c.setScale(0.2);
        this.scene.tweens.add({ targets: v.c, scale: 1, duration: POP_MS, ease: 'Back.easeOut' });
        this.ripple(f.x, f.y);
      } else {
        // 전장에서 날아와 물에 떨어짐
        const from = toScreen(e.from.role === 'offense' ? 'abyss' : 'defense', e.from.x, e.from.y);
        f.hold = FLY_MS / 1000;
        v.c.setVisible(false);
        const ghost = this.scene.add.circle(from.x, from.y, this.pond.r * 0.5, this.colorOf(e.piece)).setStrokeStyle(1, 0xffffff).setDepth(25);
        this.scene.tweens.add({
          targets: ghost,
          x: f.x,
          y: f.y,
          scale: 2,
          duration: FLY_MS,
          ease: 'Sine.easeIn',
          onComplete: () => {
            ghost.destroy();
            v.c.setVisible(true);
            this.ripple(f.x, f.y);
          },
        });
      }
    }
    this.arrivals.clear();
  }

  /** 그리드가 가득이라 버려진 조각: 처치 지점에서 잠깐 보였다 사라짐 */
  private discardFx(e: Extract<CoreEvent, { type: 'piece' }>): void {
    const p = toScreen(e.from!.role === 'offense' ? 'abyss' : 'defense', e.from!.x, e.from!.y);
    const ghost = this.scene.add.circle(p.x, p.y, 7, this.colorOf(e.piece), 0.8).setDepth(25);
    this.scene.tweens.add({ targets: ghost, alpha: 0, scale: 0.4, duration: 600, onComplete: () => ghost.destroy() });
  }

  /** 물결 0.3초 */
  private ripple(x: number, y: number): void {
    const r = this.scene.add.circle(x, y, this.pond.r * 0.8, 0xffffff, 0).setStrokeStyle(2, 0xcfeaff, 0.8).setDepth(DEPTH - 1);
    this.scene.tweens.add({ targets: r, scale: 1.8, alpha: 0, duration: RIPPLE_MS, onComplete: () => r.destroy() });
  }

  /** 조각 표시 (새로 만들거나 단계가 바뀌면 다시) */
  /** 스킨 그림 키 (조각 4체인 × 5단계 + 와일드카드) */
  private pieceKey(p: Piece): string {
    return isWildcard(p) ? 'piece.wildcard' : `piece.${p.chain}.t${Math.min(5, p.tier)}`;
  }

  private rebuild(f: Fish): View {
    const p = this.state.grid.cells[f.cell]!;
    const skin = skinOf(this.scene);
    const key = this.pieceKey(p);
    if (skin.has(key)) {
      // 그림 조각 (§5.23-1): 단계가 바뀌면 다시 만든다. 단계 라벨은 작게 남긴다 (§5.16-2)
      const old = this.views.get(f.id);
      const x = old?.c.x ?? f.x;
      const y = old?.c.y ?? f.y;
      if (old) this.dropView(f.id);
      const img = skin.image(this.scene, key, 0, 0, this.pond.r * 2 + 2);
      const disc = this.scene.add.circle(0, 0, this.pond.r, 0, 0);
      const label = text(this.scene, this.pond.r * 0.62, this.pond.r * 0.55, isWildcard(p) ? '?' : pieceLabel(p, this.state.grid.maxTier), {
        fontSize: '10px',
        color: '#ffffff',
        fontStyle: 'bold',
        stroke: '#1b1d24',
        strokeThickness: 3,
      }).setOrigin(0.5);
      const c = this.scene.add.container(x, y, [disc, img, label]).setDepth(DEPTH);
      const v: View = { c, disc, label, lift: { v: 0 } };
      this.views.set(f.id, v);
      return v;
    }
    const old = this.views.get(f.id);
    if (old) {
      old.disc.setFillStyle(this.colorOf(p));
      const top = !isWildcard(p) && p.tier >= this.state.grid.maxTier;
      old.disc.setStrokeStyle(top ? 3 : 1, top ? 0xffffff : 0x1b1d24);
      old.label.setText(this.labelOf(p));
      return old;
    }
    const top = !isWildcard(p) && p.tier >= this.state.grid.maxTier;
    const disc = this.scene.add.circle(0, 0, this.pond.r, this.colorOf(p)).setStrokeStyle(top ? 3 : 1, top ? 0xffffff : 0x1b1d24);
    const shine = this.scene.add.circle(-this.pond.r * 0.35, -this.pond.r * 0.4, this.pond.r * 0.28, 0xffffff, 0.25);
    const label = text(this.scene, 0, 0, this.labelOf(p), { fontSize: '13px', color: '#1b1d24', fontStyle: 'bold' }).setOrigin(0.5);
    const c = this.scene.add.container(f.x, f.y, [disc, shine, label]).setDepth(DEPTH);
    const v: View = { c, disc, label, lift: { v: 0 } };
    this.views.set(f.id, v);
    return v;
  }

  private labelOf(p: Piece): string {
    return isWildcard(p) ? '?' : `${this.chainInitial.get(p.chain) ?? ''}${pieceLabel(p, this.state.grid.maxTier)}`;
  }

  colorOf(p: Piece): number {
    return isWildcard(p) ? COLOR.wildcard : (this.chainColor.get(p.chain) ?? 0x999999);
  }

  private dropView(id: number): void {
    const v = this.views.get(id);
    if (!v) return;
    this.views.delete(id);
    this.scene.tweens.killTweensOf(v.c);
    v.c.destroy();
  }

  private world(p: Phaser.Input.Pointer): Phaser.Math.Vector2 {
    return this.scene.cameras.main.getWorldPoint(p.x, p.y);
  }

  private onDown(p: Phaser.Input.Pointer): void {
    if (this.press) return; // 동시에 한 조각만
    if (!this.hooks.canInteract()) return;
    const w = this.world(p);
    if (!inRect(REGION.board, w.x, w.y)) return;
    // 스킬 버튼 위는 버튼 몫
    const n = this.state.activeTeamIds(this.state.laneRole).length;
    for (let i = 0; i < n; i++) {
      const c = skillButtonCenter(i, n);
      if (Math.hypot(w.x - c.x, w.y - c.y) <= SKILL_BTN_R + 2) return;
    }
    // 판을 누르는 순간 전부 정지 (§5.21-3)
    const id = this.pond.press(w.x, w.y);
    this.press = { pointerId: p.id, id, startX: w.x, startY: w.y, dragging: false };
    // 잡은 조각은 자동 뭉침 대상에서 뺀다 (D-070)
    this.state.heldCells.clear();
    const held = id === null ? undefined : this.pond.fish.get(id);
    if (held) this.state.heldCells.add(held.cell);
  }

  private onMove(p: Phaser.Input.Pointer): void {
    const press = this.press;
    if (!press || press.pointerId !== p.id || press.id === null) return;
    const w = this.world(p);
    if (!press.dragging && Math.hypot(w.x - press.startX, w.y - press.startY) < DRAG_THRESHOLD) return;
    press.dragging = true;
    this.pond.moveTo(w.x, w.y);
    this.views.get(press.id)?.c.setDepth(10).setScale(1.1);
    let hover: DragHover = null;
    if (inRect(RELEASE_HIT, w.x, w.y)) {
      const piece = this.state.grid.cells[this.pond.fish.get(press.id)!.cell];
      hover = { kind: 'release', hover: !piece || isWildcard(piece) ? 'blocked' : 'ok' };
    }
    this.setHover(hover, w.x, w.y);
  }

  private setHover(hover: DragHover, x = 0, y = 0): void {
    this.hooks.onHover(hover);
    if (hover?.kind !== 'release') {
      this.tag.setVisible(false);
      return;
    }
    this.tag
      .setText(releaseHoverLabel(hover.hover))
      .setColor(hover.hover === 'blocked' ? '#8a8f9e' : '#ffffff')
      .setPosition(x, y + TAG_OFFSET_Y)
      .setVisible(true);
  }

  private onUp(p: Phaser.Input.Pointer): void {
    const press = this.press;
    if (!press || press.pointerId !== p.id) return;
    this.press = null;
    this.state.heldCells.clear();
    this.setHover(null);
    const id = press.id;
    if (id === null || !press.dragging) {
      // 빈 물을 눌렀거나 탭: 정지만 풀림
      this.pond.cancel();
      if (id !== null) this.views.get(id)?.c.setDepth(DEPTH).setScale(1);
      return;
    }
    const w = this.world(p);
    const distance = Math.hypot(w.x - press.startX, w.y - press.startY);
    this.hooks.onDropResult?.(null, distance);
    const v = this.views.get(id);
    v?.c.setDepth(DEPTH).setScale(1);
    const f = this.pond.fish.get(id);
    if (f && inRect(RELEASE_HIT, w.x, w.y)) {
      // 놓아주기 칸 (와일드카드는 core가 거절 → 그 자리에서 다시 헤엄)
      if (this.state.release(f.cell)) {
        this.pond.cancel();
        this.floatAway(id);
        this.refresh();
        this.hooks.onChange();
        return;
      }
      this.pond.cancel(); // 다음 헤엄 프레임에 우물 안으로 돌아온다
      return;
    }
    const res = this.pond.release(w.x, w.y, this.state);
    if (res.kind === 'merge') {
      // pond가 이미 core와 맞췄다: 사라진 조각 표시를 지우고 남은 조각을 새 단계로
      for (const vid of [...this.views.keys()]) if (!this.pond.fish.has(vid)) this.dropView(vid);
      const kf = this.pond.fish.get(res.kept);
      if (kf) this.hop(this.rebuild(kf));
      this.refresh();
      this.hooks.onChange();
    }
  }

  /**
   * 자동 뭉침 연출 (D-070): core가 정한 쌍 — 사라진 조각이 남은 조각 쪽으로 0.2초 빨려 들어가고 작은 반짝임, 남은 조각은 새 단계로 톡.
   * 판정·보상은 core가 이미 끝냈다 (화면은 보기만)
   */
  private absorbFx(fromCell: number, toCell: number): void {
    const { from, to } = this.pond.absorb(fromCell, toCell);
    const v = from ? this.views.get(from.id) : undefined;
    if (from) this.views.delete(from.id);
    const target = to;
    const done = () => {
      if (target) {
        this.sparkle(target.x, target.y);
        const kv = this.views.get(target.id);
        if (kv) this.hop(kv);
      }
    };
    if (v && target) {
      v.c.setDepth(DEPTH + 1);
      const sx = v.c.x;
      const sy = v.c.y;
      const t = { k: 0 };
      this.scene.tweens.add({
        targets: t,
        k: 1,
        duration: ABSORB_MS,
        ease: 'Quad.easeIn',
        onUpdate: () => v.c.setPosition(sx + (target.x - sx) * t.k, sy + (target.y - sy) * t.k).setScale(1 - 0.4 * t.k),
        onComplete: () => {
          v.c.destroy();
          done();
        },
      });
    } else {
      v?.c.destroy();
      done();
    }
    // 남은 조각 단계 갱신 (rebuild)
    this.refresh();
  }

  /** 작은 반짝임 (자동 뭉침) */
  private sparkle(x: number, y: number): void {
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI * 2 * i) / 6;
      const p = this.scene.add.circle(x, y, 2, 0xfff1c4).setDepth(DEPTH + 2);
      this.scene.tweens.add({ targets: p, x: x + Math.cos(a) * 16, y: y + Math.sin(a) * 16, alpha: 0, duration: 260, ease: 'Sine.easeOut', onComplete: () => p.destroy() });
    }
  }

  /** 합쳐진 조각: 톡 튀어 오른 뒤 헤엄 */
  private hop(v: View): void {
    this.scene.tweens.add({ targets: v.lift, v: HOP_PX, duration: HOP_MS / 2, yoyo: true, ease: 'Sine.easeOut' });
    this.scene.tweens.add({ targets: v.c, scale: 1.25, duration: HOP_MS / 2, yoyo: true });
  }

  /** core는 이미 제거했다. 떼어낸 조각 표시만 떠올려 사라지게 한다 */
  private floatAway(id: number): void {
    const v = this.views.get(id);
    this.views.delete(id);
    if (!v) return;
    v.c.setDepth(20);
    this.scene.tweens.add({
      targets: v.c,
      y: v.c.y - RELEASE_FLOAT_PX,
      alpha: 0,
      scale: 0.8,
      duration: RELEASE_FLOAT_MS,
      ease: 'Sine.easeOut',
      onComplete: () => v.c.destroy(),
    });
  }
}
