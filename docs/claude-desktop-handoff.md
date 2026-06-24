# Claude Desktop to Helm Handoff

Claude Code Desktop에서 계획이 끝난 작업을 Helm이 자동 실행하도록 넘기는 로컬 파일 기반 계약이다.

## 흐름

```text
Claude Desktop
  -> .helm/inbox/*.md 또는 *.json 작성
Helm handoff watcher
  -> node src/cli.ts run --agent codex "<작업 지시>"
  -> .helm/sessions/* 기록
  -> .helm/outbox/reports/*.md 완료 보고 작성
```

실행 중 작업 파일은 `.helm/processing/`으로 이동한다. 성공한 원본 작업은 `.helm/outbox/archive/`로 이동하고, 실패한 작업과 실패 보고는 `.helm/outbox/failed/`에 남긴다.

## 실행

Helm 저장소 루트에서 watcher를 켠다.

```bash
npm run handoff
```

작업 하나만 처리하고 종료하려면 다음을 쓴다.

```bash
npm run handoff:once
```

agent 실행 없이 흐름만 확인하려면 다음을 쓴다.

```bash
npm run handoff -- --dry-run
```

## 작업 파일 형식

Markdown 작업 파일은 front matter를 선택적으로 지원한다.

```md
---
id: admin-bo-product-filter
title: 상품 필터 추가
agent: codex
repoPath: /Users/me/Desktop/work/example-app
---

목표:
- 상품 목록에 신규 필터를 추가한다.

성공 기준:
- 필터 값이 API query parameter에 포함된다.
- TanStack Query queryKey에 신규 필터 값이 포함된다.
- 관련 lint/test를 실행하고 결과를 보고한다.

범위:
- 상품 목록 화면과 관련 query hook만 수정한다.

제외 범위:
- 백엔드 API 변경
- 관련 없는 UI 리팩터링
```

JSON 작업 파일도 지원한다.

```json
{
  "id": "admin-bo-product-filter",
  "title": "상품 필터 추가",
  "agent": "codex",
  "repoPath": "/Users/me/Desktop/work/example-app",
  "prompt": "목표와 성공 기준을 포함한 Helm 실행 지시문"
}
```

`agent`는 `codex`, `claude`, `gemini` 중 하나다. 생략하면 `codex`를 사용한다. `repoPath`를 생략하면 Helm 저장소 루트에서 실행한다.

## Claude Desktop 운영 규칙

Claude Desktop은 계획이 승인되면 직접 구현하지 않고 `.helm/inbox/`에 작업 파일을 생성한다.

작업 파일에는 최소한 다음 항목을 포함한다.

- 목표
- 성공 기준
- 범위
- 제외 범위
- 검증 방법
- 완료 보고 형식

Helm은 작업 파일 하나를 하나의 agent session으로 처리한다. watcher는 병렬 실행하지 않으므로, 여러 파일을 넣으면 파일명 정렬 순서대로 하나씩 실행한다.
