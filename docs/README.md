# docs — 문서 목차

| 폴더 | 문서 | 내용 | 상태 |
|---|---|---|---|
| (루트) | [00-current-design.md](00-current-design.md) | **현재 기획 한 장 정리 — 기준 문서.** 확정 / 미결정 / 다음 순서 | 최신 (2026-10-01) |
| `01-planning/` | [worldview.md](01-planning/worldview.md) | 세계관, 코어 판타지, 핵심 조작, 추억 체인, 결말, 톤 | 최신 (2026-09-30) |
| `01-planning/` | [content-guidelines.md](01-planning/content-guidelines.md) | 소재 수위 기준 (다루지 않는 것 / 조심해서 다루는 것 / 점검 질문) | 최신 (2026-10-01) |
| `01-planning/stories/` | [ch01-sun-and-moon.md](01-planning/stories/ch01-sun-and-moon.md) | 1챕터 "해와 달이 된 오누이" 초안: 교훈, 장면 1-1~1-10, 적, 체인, 전설, 길잡이 | 초안 (2026-10-01) |
| `02-spec/` | [prototype-spec.md](02-spec/prototype-spec.md) | 프로토타입 구현 스펙 v0.10 (자라는 날 §5.14, 영웅 개편 §5.13, M8.5 §5.12, 낮/밤 구조·가로 레인 §5.11, M6 gating·저장·결말, M7 metrics, 방어 유닛 이동 포함) | 최신 (2026-09-30) |
| `03-decisions/` | [decision-log.md](03-decisions/decision-log.md) | 기획 결정 기록 (결정 / 이유 / 버린 대안) | 최신 (2026-09-30) |
| `04-playtest/` | [playtest-plan.md](04-playtest/playtest-plan.md) | 사람 플레이 테스트 계획 (트랙 A 실제 일생 / 트랙 B 그리드 비교), 매일 체크리스트, 판정표 | 최신 (2026-10-01) |

## 문서 규칙
- 기획 결정이 바뀌면 `decision-log.md`에 항목을 추가하고, `worldview.md`를 갱신한다.
- 구현 스펙은 `02-spec/`에만 둔다. 스펙과 세계관이 충돌하면 세계관(결정 기록)이 우선이며, 스펙을 개정한다.
- 루트의 `CLAUDE.md`는 Claude Code가 읽는 구현 규칙이라 루트에 둔다.
