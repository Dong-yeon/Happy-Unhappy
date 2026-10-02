// 해·달 진행선 (4px 막대): 낮에는 막대가 해 색으로 차오르며 지난 시간을, 밤에는 달 색으로 웨이브 진행도를 보여준다. 해·달 아이콘·남은 시간은 HUD 오른쪽 작게.
// 낮 → 밤 전환 연출 1.5초: 하늘색 보간(따뜻 → 남색), 해가 지고 달이 뜸. HUD에 별도 진행 막대는 두지 않는다.
import Phaser from 'phaser';
import type { GameState } from '../core/game';
import { REGION, SKY_ICON } from './layout';
import { COLOR, text } from './ui';

export const TRANSITION_MS = 1500;
const DAY_SKY = 0x7da7d9;
const DUSK_SKY = 0xc98a6a;
const NIGHT_SKY = 0x1b2340;
const SUN = 0xffd36b;
const MOON = 0xe6e9f5;
/** 해·달 아이콘이 지며 내려가는 거리 */
const SET_DROP = 8;

export type SkyMode = 'day' | 'night';

/** 낮 진행도: 지난 시간 / offense.seconds */
export function dayProgress(s: GameState): number {
  if (s.phase !== 'day') return s.phase === 'dayStart' ? 0 : 1;
  return 1 - Math.max(0, s.offenseTimer) / s.offenseSeconds;
}

/** 밤 진행도: 웨이브 칸 + 칸 안 진행 (마지막 웨이브가 끝나면 1 = 달이 짐) */
export function nightProgress(s: GameState): number {
  if (s.phase !== 'night') return s.phase === 'diary' || s.phase === 'chapterComplete' ? 1 : 0;
  const w = s.wave;
  const n = Math.max(1, w.waveCount);
  let inner = 0;
  if (w.phase === 'spawning') inner = w.count > 0 ? (w.spawned / w.count) * 0.8 : 0;
  else if (w.phase === 'clearing') inner = 0.9;
  else if (w.phase === 'done') return 1;
  return Math.min(1, (w.slot + inner) / n);
}

export class SkyView {
  /** 진행선 바탕 / 차오른 부분 */
  private readonly sky: Phaser.GameObjects.Rectangle;
  private readonly fill: Phaser.GameObjects.Rectangle;
  private readonly sun: Phaser.GameObjects.Arc;
  private readonly moon: Phaser.GameObjects.Container;
  private readonly label: Phaser.GameObjects.Text;
  mode: SkyMode = 'day';
  /** 전환 연출 중 (입력 막음) */
  transitioning = false;

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly state: GameState,
  ) {
    const r = REGION.sky;
    // 4px 진행선: 바탕 = 하늘색, 차오른 부분 = 해·달 색
    this.sky = scene.add.rectangle(r.x, r.y, r.w, r.h, DAY_SKY).setOrigin(0).setDepth(0);
    this.fill = scene.add.rectangle(r.x, r.y, 0, r.h, SUN).setOrigin(0).setDepth(1);
    // 아이콘은 HUD 오른쪽 작게 + 남은 시간·웨이브
    const ic = SKY_ICON;
    this.sun = scene.add.circle(ic.x, ic.y, ic.r, SUN).setStrokeStyle(1, 0xfff1c4).setDepth(9);
    const moonBody = scene.add.circle(0, 0, ic.r, MOON);
    const moonShade = scene.add.circle(2, -1.5, ic.r - 1, COLOR.hud); // 초승달 모양 (HUD 바탕색으로 깎음)
    this.moon = scene.add.container(ic.x, ic.y, [moonBody, moonShade]).setDepth(9).setVisible(false);
    this.label = text(scene, ic.x + ic.r + 4, ic.y, '', { fontSize: '10px', color: '#ffffff' }).setOrigin(0, 0.5).setDepth(9).setAlpha(0.9);
    this.setMode('day');
  }

  /** 단계에 맞게 즉시 (부팅·새 하루) */
  setMode(mode: SkyMode): void {
    this.mode = mode;
    this.sky.setFillStyle(mode === 'day' ? DAY_SKY : NIGHT_SKY);
    this.fill.setFillStyle(mode === 'day' ? SUN : MOON);
    this.sun.setVisible(mode === 'day').setAlpha(1).setPosition(SKY_ICON.x, SKY_ICON.y);
    this.moon.setVisible(mode === 'night').setAlpha(1).setPosition(SKY_ICON.x, SKY_ICON.y);
    this.sync();
  }

  /** 낮 → 밤 1.5초: 진행선 색 보간, 해 아이콘이 지고 달이 뜸. 절반 지점에서 onMid(땅 띠 교체), 끝나면 onDone */
  dusk(onMid: () => void, onDone: () => void): void {
    this.transitioning = true;
    const ic = SKY_ICON;
    let swapped = false;
    this.moon.setVisible(true).setAlpha(0).setPosition(ic.x, ic.y + SET_DROP);
    this.label.setText('');
    this.scene.tweens.addCounter({
      from: 0,
      to: 1,
      duration: TRANSITION_MS,
      onUpdate: (tw) => {
        const t = tw.getValue() ?? 0;
        // 따뜻한 낮 → 노을 → 남색 밤
        const color = t < 0.5 ? lerpColor(DAY_SKY, DUSK_SKY, t * 2) : lerpColor(DUSK_SKY, NIGHT_SKY, (t - 0.5) * 2);
        this.sky.setFillStyle(color);
        this.fill.width = REGION.sky.w * (1 - t);
        const a = Math.min(1, t * 2);
        this.sun.setPosition(ic.x, ic.y + SET_DROP * a).setAlpha(1 - a);
        const b = Math.max(0, t * 2 - 1);
        this.moon.setPosition(ic.x, ic.y + SET_DROP * (1 - b)).setAlpha(b);
        if (!swapped && t >= 0.5) {
          swapped = true;
          onMid();
        }
      },
      onComplete: () => {
        this.transitioning = false;
        this.mode = 'night';
        this.sun.setVisible(false);
        this.fill.setFillStyle(MOON);
        onDone();
      },
    });
  }

  /** 매 프레임: 진행선 길이·남은 시간 (전환 중에는 연출이 움직인다) */
  sync(): void {
    if (this.transitioning) return;
    const s = this.state;
    if (this.mode === 'day') {
      this.fill.width = REGION.sky.w * dayProgress(s);
      this.setLabel(s.phase === 'day' ? `${Math.ceil(Math.max(0, s.offenseTimer))}초` : '');
    } else {
      this.fill.width = REGION.sky.w * nightProgress(s);
      const w = s.wave;
      const boss = w.waves[w.slot]?.boss ? ' 보스' : '';
      this.setLabel(s.phase === 'night' ? `${Math.min(w.slot + 1, w.waveCount)}/${w.waveCount}${boss}` : '');
    }
  }

  private setLabel(t: string): void {
    if (this.label.text !== t) this.label.setText(t);
  }
}

export function lerpColor(a: number, b: number, t: number): number {
  const ch = (c: number, s: number) => (c >> s) & 0xff;
  const mix = (s: number) => Math.round(ch(a, s) + (ch(b, s) - ch(a, s)) * t);
  return (mix(16) << 16) | (mix(8) << 8) | mix(0);
}
