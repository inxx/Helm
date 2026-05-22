# Hermes Local API Guide

작성일: 2026-05-19
업데이트: 2026-05-22

이 문서는 Helm backend가 로컬 Docker Hermes를 호출해서 관리/관찰 보조 에이전트로 사용하는 방법을 정리한다.
Hermes는 Helm의 오케스트레이터가 아니다. Helm은 상태 전이, 승인, 감사 로그, Git 판단을 계속 소유하고, Hermes는 필요한 경우 모델 호출과 도구 실행을 보조하는 외부 agent runtime으로만 다룬다.

## 현재 로컬 구성

Docker 이미지:

```bash
nousresearch/hermes-agent:latest
```

고정 컨테이너:

```bash
hermes-local
```

Hermes 데이터 볼륨:

```bash
hermes-data
```

Ollama 모델:

```bash
qwen3:4b
```

Ollama context:

```bash
OLLAMA_CONTEXT_LENGTH=64000
```

확인 명령:

```bash
ollama list
ollama ps
docker ps --filter name=hermes-local
docker exec hermes-local /opt/hermes/.venv/bin/hermes config show
```

기대 상태:

```text
qwen3:4b    100% GPU    CONTEXT 64000
```

## 실행 방식

### 1. One-shot 호출

Helm에서 가장 단순하게 호출할 수 있는 방식은 고정 컨테이너에 `docker exec`로 one-shot prompt를 전달하는 것이다.

```bash
docker exec hermes-local /opt/hermes/.venv/bin/hermes --oneshot "상태를 한 문장으로 요약해"
```

Node backend에서 호출할 때는 shell string 조립 대신 `spawn`/`execFile` 인자 배열을 사용한다.

```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function callHermesOneshot(prompt: string) {
  const { stdout } = await execFileAsync("docker", [
    "exec",
    "hermes-local",
    "/opt/hermes/.venv/bin/hermes",
    "--oneshot",
    prompt,
  ]);

  return stdout.trim();
}
```

이 방식은 구현이 단순하고 Helm backend에서 타임아웃, 재시도, 감사 로그를 직접 관리하기 쉽다.
단점은 요청마다 Hermes 프로세스가 새로 뜨므로, 모델 호출 외에 Hermes runtime 초기화 비용이 있다.

### 2. MCP server 모드

Hermes는 MCP server 모드를 제공한다.

```bash
docker exec -i hermes-local /opt/hermes/.venv/bin/hermes mcp serve
```

이 방식은 Helm이 MCP client를 갖게 될 때 후보가 된다.
장점은 “Hermes 대화/도구”를 protocol boundary로 다룰 수 있다는 점이다.
단점은 Helm backend에 MCP lifecycle, stdio stream, tool result mapping, timeout 정책을 별도로 구현해야 한다.

Phase 3b 이전에는 MCP 연동을 제품 경로로 고정하지 않는다.

### 3. ACP mode

Hermes는 ACP mode도 제공한다.

```bash
docker exec -i hermes-local /opt/hermes/.venv/bin/hermes acp
```

ACP는 VS Code, Zed, JetBrains 같은 editor integration용이다.
Helm backend의 일반 server-to-agent API로 바로 채택하기보다는, protocol이 Helm의 태스크/승인/audit 모델과 맞는지 별도 검증이 필요하다.

## 비권장 방식

### Hermes를 Helm 오케스트레이터로 사용하지 않기

Helm의 핵심 책임은 다음이다.

- 태스크 상태 전이
- 사용자 승인
- Git snapshot/diff 판단
- 실행 기록과 감사 로그
- agent run lifecycle

Hermes가 이 책임을 대신 가지면 Helm의 결정론적 control plane 목표가 흐려진다.

### REST API가 있다고 가정하지 않기

현재 검증된 로컬 호출 경로는 다음이다.

- `hermes --oneshot`
- `hermes mcp serve`
- `hermes acp`

Hermes dashboard나 gateway가 있더라도, Helm integration용 stable REST API로 검증된 상태는 아니다.
REST 연동은 공식 endpoint, auth, request/response contract, lifecycle을 확인한 뒤 별도 문서로 승격한다.

## 성능 메모

2026-05-19 로컬 테스트 기준:

- Host: Apple M3 Pro, 36GB RAM
- Docker Hermes: `nousresearch/hermes-agent:latest`
- Ollama: `qwen3:4b`
- Ollama context: `64000`

관찰 결과:

- Ollama 직접 호출은 Hermes 경유보다 빠르다.
- Hermes one-shot 경유는 대략 1분대 응답을 보였다.
- `qwen3:4b`는 관리/요약/상태 판단 용도로는 가장 가벼운 Qwen 후보지만, 내부 thinking 출력 때문에 짧은 요청도 즉답형은 아니다.
- `qwen3:14b`, `llama3.1:8b`는 삭제했고, 현재 로컬 모델은 `qwen3:4b`만 유지한다.

따라서 Helm에서 Hermes를 호출할 때는 UX를 “즉시 채팅 응답”으로 설계하지 않는다.
백그라운드 관찰, 주기적 점검, 사용자가 기다릴 수 있는 보조 판단 작업에 먼저 사용한다.

## Helm 연동 원칙

Helm backend에서 Hermes를 호출할 때의 기본 정책:

- Helm이 요청 ID, task ID, timeout, retry count를 소유한다.
- Hermes stdout/stderr, exit code, duration을 `AgentRun` 또는 별도 observation log에 저장한다.
- Hermes 출력은 제안 또는 관찰 결과로만 저장하고, 상태 전이는 Helm rule이 결정한다.
- destructive command 실행 권한은 Hermes에 위임하지 않는다.
- 초기 integration은 `maxParallelRuns=1`을 유지한다.
- user-facing action은 Helm approval model을 거친다.

## Obsidian 기반 작업 맥락 전달

Hermes에 "사용자가 지금 대략 무슨 일을 하고 있는지" 전달할 때는 별도 `presence` 파일이나 상세 실행 로그를 만들지 않는다. Helm은 이미 사용자가 관리하는 Obsidian 히스토리를 장기 기억으로 다루므로, Hermes는 승인된 범위 안에서 최근 Obsidian 문서를 읽고 낮은 해상도의 작업 맥락만 추론한다.

기본 탐색 순서:

1. 설정된 vault의 `vault-index.md`를 먼저 읽어 프로젝트와 앱 경로를 좁힌다.
2. 현재 Helm 프로젝트와 매칭되는 `projects/{project}/{app}/` 아래만 후보로 본다.
3. `sessions/`, `plans/`, `reviews/`, `decisions/` 중 최근 수정 문서를 우선한다.
4. 후보 문서는 frontmatter, 제목, 첫 요약 구간처럼 앞부분만 읽는다.
5. 더 많은 본문이 필요하면 Helm backend가 사용자 승인 또는 명시된 allowlist를 확인한 뒤 추가 excerpt를 제공한다.

최근성 기준:

- 24시간 이내 기록은 현재 작업 힌트로 사용할 수 있다.
- 7일 이내 기록은 최근 작업 맥락으로만 사용한다.
- 7일보다 오래된 기록은 현재 작업으로 단정하지 않고 과거 히스토리로만 언급한다.
- 최근 기록이 없으면 "현재 작업은 Obsidian 기록만으로 판단할 수 없음"으로 처리한다.

Hermes가 생성해도 되는 요약 범위:

- 프로젝트명과 앱명
- 작업 종류: 조사, 설계, 구현, 리뷰, 테스트, 문서화, 배포 준비
- 대략적인 상태: 진행 중, 검토 중, 막힘, 완료 후보
- Obsidian에 명시된 blocker 여부

Hermes가 생성하면 안 되는 내용:

- 코드 diff, 파일별 상세 변경, 터미널 로그 전문
- Jira/Slack/계정/토큰/로컬 경로 같은 민감 정보
- 사용자가 문서에 적지 않은 현재 의도 추측
- 24시간이 지난 기록을 근거로 한 "지금 하고 있다"는 단정

Hermes prompt는 아래처럼 낮은 해상도 요약만 요구한다.

```text
아래 Obsidian excerpt만 근거로 사용자가 최근 어떤 종류의 일을 하는지 2문장 이하로 요약해.
세부 구현, 파일명, diff, 민감 정보는 말하지 마.
기록이 24시간보다 오래되었으면 현재 작업이라고 단정하지 말고 최근 히스토리라고 표현해.
근거가 부족하면 판단할 수 없다고 말해.
```

Hermes 응답은 Helm에서 바로 상태 전이 근거로 사용하지 않는다. 이 요약은 UI 보조 문구, 관찰 코멘트, 사용자에게 보여줄 낮은 해상도의 "최근 작업 맥락"으로만 저장한다.

권장 호출 timeout:

```text
120초
```

권장 실패 분류:

- Docker container 없음: environment error
- Ollama API 연결 실패: provider error
- Hermes exit code non-zero: agent runtime error
- stdout empty: invalid response
- timeout: slow model/runtime

## 다음 구현 후보

1. Helm backend에 `HermesAdapter` 인터페이스 추가
2. 초기 구현은 `docker exec ... hermes --oneshot`만 지원
3. adapter 결과를 `AgentRun` 또는 `Observation`으로 저장
4. UI에서는 “Hermes 관찰 요청 중” 상태로 표시
5. MCP server 모드는 one-shot adapter가 안정화된 뒤 재검토

초기 인터페이스 예시:

```ts
export interface HermesAdapter {
  oneshot(input: {
    taskId: string;
    prompt: string;
    timeoutMs: number;
  }): Promise<{
    stdout: string;
    stderr: string;
    durationMs: number;
    exitCode: number;
  }>;
}
```
