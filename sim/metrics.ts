// metrics 분석 CLI (스펙 §5.10-6). Node 전용 (게임 번들 제외).
//   npm run metrics -- playtest/<파일>.json [--bot sim/out/<날짜>_balanced_life.json]
import { readFileSync } from 'node:fs';
import { parseMetrics } from '../src/metrics/model';
import { analyze, compareWithBot, formatAnalysis, formatSection } from './metricsReport';
import type { PolicyReport } from './report';

function fail(msg: string): never {
  console.error(`metrics: ${msg}`);
  process.exit(1);
}

function main(): void {
  const argv = process.argv.slice(2);
  const bi = argv.indexOf('--bot');
  const botFile = bi >= 0 ? (argv[bi + 1] ?? fail('--bot 다음에 봇 리포트 파일')) : null;
  const file = argv.find((a, i) => !a.startsWith('--') && (bi < 0 || i !== bi + 1));
  if (!file) fail('사용법: npm run metrics -- <metrics.json> [--bot sim/out/xxx_balanced_life.json]');

  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (e) {
    fail(`${file} 읽기 실패: ${(e as Error).message}`);
  }
  const r = parseMetrics(raw);
  if (!r.ok) fail(`${file}: ${r.reason}`);

  console.log(`metrics: ${file} (처음 기록 ${r.data.firstSeen})\n`);
  console.log(formatAnalysis(analyze(r.data)));
  if (botFile) {
    const bot = JSON.parse(readFileSync(botFile, 'utf8')) as PolicyReport;
    if (bot.policy !== 'balanced') console.warn(`metrics: 봇 리포트 정책이 balanced가 아님 (${bot.policy})`);
    console.log();
    console.log(formatSection(compareWithBot(r.data, bot)));
  }
}

main();
