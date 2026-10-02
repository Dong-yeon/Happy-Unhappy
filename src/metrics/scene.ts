// 씬에서 metrics 화면 카운터 쓰기 (GameScene이 registry 'metrics'에 recorder를 둔다). 없으면 아무것도 안 함.
import type Phaser from 'phaser';
import type { SessionUi } from './model';
import type { MetricsRecorder } from './recorder';

export function metricsOf(scene: Phaser.Scene): MetricsRecorder | undefined {
  return scene.registry.get('metrics') as MetricsRecorder | undefined;
}

/** 화면 카운터 +amount (편성·이야기책·영웅 상세 연 횟수, 편성 바꿈, 잉크 부은 양) */
export function countUi(scene: Phaser.Scene, key: keyof SessionUi, amount = 1): void {
  metricsOf(scene)?.ui(key, amount);
}
