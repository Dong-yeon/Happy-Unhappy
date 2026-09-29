# Happy And Unhappy — Prototype

## 이 repo의 성격
- 재미 검증용 프로토타입. 버리는 코드. 본 개발은 Godot에서 새로 한다.
- 스펙: docs/prototype-spec.md / 세계관: docs/worldview.md

## 규칙
- 스펙의 "제외" 항목은 구현하지 않는다. 범위 밖 기능이 필요해 보이면 구현 전에 물어본다.
- 수치는 src/data/*.json에서만 읽는다. 코드에 밸런스 수치 하드코딩 금지.
- 게임 규칙은 src/core에 Phaser 의존 없이 작성한다. scenes는 표시와 입력만 담당.
- 에셋은 도형 + 텍스트만 사용한다.
- 스택: Phaser 3 (package.json에 버전 고정) + TypeScript + Vite. Phaser 4 API를 섞지 않는다.
- core 변경 시 Vitest 테스트를 함께 수정한다.
