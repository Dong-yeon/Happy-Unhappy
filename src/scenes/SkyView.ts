// 해·달 띠 (§5.20-13, 높이 24): 낮(핵 찾아 돌아오기)에는 해가 왼쪽에서 오른쪽으로 가며 남은 시간을, 밤(핵 지키기)에는 달이 웨이브 진행도를 보여준다.
// 낮 → 밤 전환 연출 1.5초: 하늘색 보간(따뜻 → 남색), 해가 지고 달이 뜸. HUD에 별도 진행 막대는 두지 않는다.
import Phaser from 'phaser';
import type { GameState } from '../core/game';
import { REGION, skyArc } from './layout';
import { text } from './ui';

export const TRANSITION_MS = 1500;
const DAY_SKY = 0x7da7d9;
const DUSK_SKY = 0xc98a6a;
const NIGHT_SKY = 0x1b2340;
const SUN = 0xffd36b;
const MOON = 0xe6e9f5;
/** 해·달이 띠 아래로 내려가 숨는 거리 */
const SET_DROP = 14;

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
  private readonly sky: Phaser.GameObjects.Rectangle;
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
    this.sky = scene.add.rectangle(r.x, r.y, r.w, r.h, DAY_SKY).setOrigin(0).setDepth(0);
    // 지평선
    scene.add.rectangle(r.x, r.y + r.h - 1, r.w, 1, 0x000000, 0.25).setOrigin(0).setDepth(0);
    this.sun = scene.add.circle(0, 0, 8, SUN).setStrokeStyle(2, 0xfff1c4).setDepth(1);
    const moonBody = scene.add.circle(0, 0, 7, MOON);
    const moonShade = scene.add.circle(3, -2, 6, NIGHT_SKY); // 초승달 모양
    this.moon = scene.add.container(0, 0, [moonBody, moonShade]).setDepth(1).setVisible(false);
    this.label = text(scene, r.x + r.w - 6, r.y + r.h / 2, '', { fontSize: '10px', color: '#ffffff' }).setOrigin(1, 0.5).setDepth(2).setAlpha(0.9);
    this.setMode('day');
  }

  /** 단계에 맞게 즉시 (부팅·새 하루) */
  setMode(mode: SkyMode): void {
    this.mode = mode;
    this.sky.setFillStyle(mode === 'day' ? DAY_SKY : NIGHT_SKY);
    this.sun.setVisible(mode === 'day').setAlpha(1);
    this.moon.setVisible(mode === 'night').setAlpha(1);
    (this.moon.list[1] as Phaser.GameObjects.Arc).setFillStyle(NIGHT_SKY);
    this.sync();
  }

  /** 낮 → 밤 1.5초: 하늘색 보간, 해가 지고 달이 뜸. 절반 지점에서 onMid(땅 띠 교체), 끝나면 onDone */
  dusk(onMid: () => void, onDone: () => void): void {
    this.transitioning = true;
    const sunFrom = skyArc(1);
    const moonFrom = skyArc(0);
    let swapped = false;
    this.moon.setVisible(true).setAlpha(0).setPosition(moonFrom.x, moonFrom.y + SET_DROP);
    this.scene.tweens.addCounter({
      from: 0,
      to: 1,
      duration: TRANSITION_MS,
      onUpdate: (tw) => {
        const t = tw.getValue() ?? 0;
        // 따뜻한 낮 → 노을 → 남색 밤
        const color = t < 0.5 ? lerpColor(DAY_SKY, DUSK_SKY, t * 2) : lerpColor(DUSK_SKY, NIGHT_SKY, (t - 0.5) * 2);
        this.sky.setFillStyle(color);
        (this.moon.list[1] as Phaser.GameObjects.Arc).setFillStyle(color);
        const a = Math.min(1, t * 2);
        this.sun.setPosition(sunFrom.x, sunFrom.y + SET_DROP * a).setAlpha(1 - a);
        const b = Math.max(0, t * 2 - 1);
        this.moon.setPosition(moonFrom.x, moonFrom.y + SET_DROP * (1 - b)).setAlpha(b);
        if (!swapped && t >= 0.5) {
          swapped = true;
          onMid();
        }
      },
      onComplete: () => {
        this.transitioning = false;
        this.mode = 'night';
        this.sun.setVisible(false);
        onDone();
      },
    });
  }

  /** 매 프레임: 해·달 위치 (전환 중에는 연출이 움직인다) */
  sync(): void {
    if (this.transitioning) return;
    const s = this.state;
    if (this.mode === 'day') {
      const p = skyArc(dayProgress(s));
      this.sun.setPosition(p.x, p.y);
      this.setLabel(s.phase === 'day' ? `해가 지기까지 ${Math.ceil(Math.max(0, s.offenseTimer))}초` : '');
    } else {
      const p = skyArc(nightProgress(s));
      this.moon.setPosition(p.x, p.y);
      const w = s.wave;
      const boss = w.waves[w.slot]?.boss ? ' · 보스' : '';
      this.setLabel(s.phase === 'night' ? `밤 ${Math.min(w.slot + 1, w.waveCount)}/${w.waveCount}웨이브${boss}` : '');
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
