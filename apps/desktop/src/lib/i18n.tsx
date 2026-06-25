import { createContext, useContext, type ReactNode } from "react";

export type AppLanguage = "en" | "ko";

export type MessageKey =
  | "nav.chat"
  | "nav.tasks"
  | "nav.git"
  | "nav.pr"
  | "nav.jira"
  | "nav.terminal"
  | "nav.editor"
  | "nav.settings"
  | "shell.domainTabs"
  | "shell.projects"
  | "shell.noProjects"
  | "shell.addProject"
  | "shell.processing"
  | "shell.removeProjectTitle"
  | "shell.removeProjectAria"
  | "app.restore.title"
  | "app.restore.description"
  | "app.error.unknown"
  | "settings.category.orchestrator.label"
  | "settings.category.orchestrator.hint"
  | "settings.category.connections.label"
  | "settings.category.connections.hint"
  | "settings.category.assignments.label"
  | "settings.category.assignments.hint"
  | "settings.category.usage.label"
  | "settings.category.usage.hint"
  | "settings.category.jira.label"
  | "settings.category.jira.hint"
  | "settings.category.worktree.label"
  | "settings.category.worktree.hint"
  | "settings.category.app.label"
  | "settings.category.app.hint"
  | "settings.category.advanced.label"
  | "settings.category.advanced.hint"
  | "settings.save.global"
  | "settings.save.default"
  | "settings.save.saving"
  | "settings.app.language.title"
  | "settings.app.language.description"
  | "settings.app.language.label"
  | "settings.app.language.english"
  | "settings.app.language.korean"
  | "settings.app.language.note"
  | "settings.app.projects.title"
  | "settings.app.projects.description"
  | "settings.app.update.title"
  | "settings.app.update.description"
  | "settings.app.projectRequired.title"
  | "settings.app.projectRequired.description"
  | "settings.app.openProject"
  | "settings.app.currentVersion"
  | "settings.app.versionUnknown"
  | "settings.app.checking"
  | "settings.app.checkUpdates"
  | "settings.app.newVersion"
  | "settings.app.noReleaseDate"
  | "settings.app.install"
  | "settings.toast.appSettingsSaved.title"
  | "settings.toast.appSettingsSaved.description"
  | "settings.toast.appSettingsFailed.title"
  | "settings.orchestrator.title"
  | "settings.orchestrator.description"
  | "settings.orchestrator.loading"
  | "settings.orchestrator.scope.title"
  | "settings.orchestrator.scope.description"
  | "settings.orchestrator.scope.enabled"
  | "settings.orchestrator.scope.disabled"
  | "settings.orchestrator.import.title"
  | "settings.orchestrator.import.description"
  | "settings.orchestrator.import.button"
  | "settings.orchestrator.enabled"
  | "settings.orchestrator.useCodex"
  | "settings.orchestrator.useClaude"
  | "settings.orchestrator.useGemini"
  | "settings.orchestrator.useCustom"
  | "settings.orchestrator.selectCli"
  | "settings.orchestrator.connection.subtitle"
  | "settings.orchestrator.promptOk"
  | "settings.orchestrator.checkRequired"
  | "settings.orchestrator.modelChecking"
  | "settings.connection.name"
  | "settings.connection.cliPath"
  | "settings.connection.defaultModel"
  | "settings.connection.modelList"
  | "settings.connection.commaSeparated"
  | "settings.connection.mode"
  | "settings.connection.modeObserve"
  | "settings.connection.modeGate"
  | "settings.connection.selectedModel"
  | "settings.connection.cliDefaultModel"
  | "settings.connection.env"
  | "settings.connection.planCommand"
  | "settings.connection.noCommand"
  | "settings.connection.loadingModels"
  | "settings.connection.loadModels"
  | "settings.connection.checking"
  | "settings.connection.check"
  | "settings.connection.remove"
  | "tasks.emptyProject.title"
  | "tasks.emptyProject.description"
  | "tasks.openProject"
  | "tasks.board.title"
  | "tasks.board.description"
  | "tasks.board.filterAria"
  | "tasks.board.all"
  | "tasks.board.syncing"
  | "tasks.board.emptyTitle"
  | "tasks.board.emptyDescription"
  | "tasks.board.loadFailed"
  | "tasks.board.allProjects"
  | "tasks.board.project"
  | "tasks.observer.aria"
  | "tasks.observer.activeRuns"
  | "tasks.observer.pendingApprovals"
  | "tasks.observer.dirtyFiles"
  | "tasks.observer.idle"
  | "tasks.status.Planned"
  | "tasks.status.Ready"
  | "tasks.status.Coding"
  | "tasks.status.PlanVerification"
  | "tasks.status.CodeReview"
  | "tasks.status.Testing"
  | "tasks.status.MergeWaiting"
  | "tasks.status.Merged"
  | "tasks.status.Done"
  | "tasks.status.Blocked"
  | "tasks.column.Planned.empty"
  | "tasks.column.Ready.empty"
  | "tasks.column.Coding.empty"
  | "tasks.column.PlanVerification.empty"
  | "tasks.column.CodeReview.empty"
  | "tasks.column.Testing.empty"
  | "tasks.column.MergeWaiting.empty"
  | "tasks.column.Merged.empty"
  | "tasks.column.Done.empty"
  | "tasks.column.Blocked.empty"
  | "tasks.card.run"
  | "tasks.card.next"
  | "tasks.card.currentStage"
  | "tasks.card.nextAction"
  | "tasks.run.approvalPending"
  | "tasks.run.retryPossible"
  | "tasks.run.checkDetails"
  | "tasks.failure.needsInspection"
  | "tasks.failure.blockingGate"
  | "tasks.failure.diffMismatch"
  | "tasks.failure.schemaInvalid"
  | "tasks.failure.timeout"
  | "tasks.failure.exitFailed"
  | "tasks.failure.canceled"
  | "tasks.failure.needsInspectionReason"
  | "tasks.failure.blockingGateReason"
  | "sessions.emptyProject.title"
  | "sessions.emptyProject.description"
  | "sessions.openProject"
  | "sessions.listAria"
  | "sessions.projects"
  | "sessions.addSession"
  | "sessions.projectMenu"
  | "sessions.deleteProject"
  | "sessions.noSessions"
  | "sessions.providerUnknown"
  | "sessions.addProject"
  | "sessions.chatAria"
  | "sessions.terminal"
  | "sessions.assistantTitle"
  | "sessions.requestTitle"
  | "sessions.progressTitle"
  | "sessions.waitingTitle"
  | "sessions.approvalTitle"
  | "sessions.summaryTitle"
  | "sessions.introMessage"
  | "sessions.noLinkedRun"
  | "sessions.composerPlaceholder"
  | "sessions.sending"
  | "sessions.send"
  | "sessions.stop"
  | "sessions.emptyChat.title"
  | "sessions.emptyChat.description";

const messages: Record<AppLanguage, Record<MessageKey, string>> = {
  en: {
    "nav.chat": "Chat",
    "nav.tasks": "Tasks",
    "nav.git": "Git",
    "nav.pr": "Pull Requests",
    "nav.jira": "Jira",
    "nav.terminal": "Terminal",
    "nav.editor": "Editor",
    "nav.settings": "Settings",
    "shell.domainTabs": "Domain tabs",
    "shell.projects": "Projects",
    "shell.noProjects": "No projects opened yet.",
    "shell.addProject": "Add project",
    "shell.processing": "Processing",
    "shell.removeProjectTitle": "Remove from project list",
    "shell.removeProjectAria": "Remove {name} from project list",
    "app.restore.title": "Opening last project",
    "app.restore.description": "Checking the Helm project and run state you opened previously.",
    "app.error.unknown": "An unknown error occurred.",
    "settings.category.orchestrator.label": "Orchestrator",
    "settings.category.orchestrator.hint": "Global conductor AI applied to every project",
    "settings.category.connections.label": "AI CLI Connections",
    "settings.category.connections.hint": "Codex, Claude Code, Gemini, and other LLM paths",
    "settings.category.assignments.label": "Role CLI Selection",
    "settings.category.assignments.hint": "Planner, coder, reviewer, and tester mappings",
    "settings.category.usage.label": "Stats & Usage",
    "settings.category.usage.hint": "Agent runs, work time, and provider mix",
    "settings.category.jira.label": "Jira",
    "settings.category.jira.hint": "Project key and default issue types",
    "settings.category.worktree.label": "Worktree",
    "settings.category.worktree.hint": "Parallel work directory location",
    "settings.category.app.label": "App",
    "settings.category.app.hint": "Language and Helm updates",
    "settings.category.advanced.label": "Advanced",
    "settings.category.advanced.hint": "Role presets JSON and legacy runner checks",
    "settings.save.global": "Save global",
    "settings.save.default": "Save",
    "settings.save.saving": "Saving...",
    "settings.app.language.title": "Language",
    "settings.app.language.description": "Choose the display language used by Helm Desktop.",
    "settings.app.language.label": "Display language",
    "settings.app.language.english": "English",
    "settings.app.language.korean": "Korean",
    "settings.app.language.note": "English is the default. The setting is saved globally for this app.",
    "settings.app.projects.title": "Projects",
    "settings.app.projects.description": "Open recent projects or remove them from the list.",
    "settings.app.update.title": "App Updates",
    "settings.app.update.description": "Run the Helm updater manually when needed instead of automatic checks.",
    "settings.app.projectRequired.title": "Settings are saved globally.",
    "settings.app.projectRequired.description": "Run history, Git, and terminal features become available after opening a project.",
    "settings.app.openProject": "Open project",
    "settings.app.currentVersion": "Current version {version}",
    "settings.app.versionUnknown": "not checked",
    "settings.app.checking": "Checking...",
    "settings.app.checkUpdates": "Check for updates",
    "settings.app.newVersion": "New version {version}",
    "settings.app.noReleaseDate": "No release date",
    "settings.app.install": "Download and install",
    "settings.toast.appSettingsSaved.title": "Global settings saved",
    "settings.toast.appSettingsSaved.description": "The app-wide settings have been saved.",
    "settings.toast.appSettingsFailed.title": "Failed to save global settings",
    "settings.orchestrator.title": "Global Orchestrator",
    "settings.orchestrator.description": "Helm supervisor handles next-step recovery. The conductor AI only records or confirms before queued runs start.",
    "settings.orchestrator.loading": "Loading global settings.",
    "settings.orchestrator.scope.title": "Scope",
    "settings.orchestrator.scope.description": "This setting is saved for the whole Helm app, not just the current project.",
    "settings.orchestrator.scope.enabled": "Global",
    "settings.orchestrator.scope.disabled": "Off",
    "settings.orchestrator.import.title": "This project has a legacy conductor setting.",
    "settings.orchestrator.import.description": "Import it into the global orchestrator to reuse the same setting across projects.",
    "settings.orchestrator.import.button": "Import globally",
    "settings.orchestrator.enabled": "Use orchestrator",
    "settings.orchestrator.useCodex": "Use Codex",
    "settings.orchestrator.useClaude": "Use Claude Code",
    "settings.orchestrator.useGemini": "Use Gemini",
    "settings.orchestrator.useCustom": "Use custom CLI",
    "settings.orchestrator.selectCli": "Select the AI CLI for the orchestrator.",
    "settings.orchestrator.connection.subtitle": "Global conductor AI connection",
    "settings.orchestrator.promptOk": "Prompt OK",
    "settings.orchestrator.checkRequired": "Check required",
    "settings.orchestrator.modelChecking": "Checking models",
    "settings.connection.name": "Name",
    "settings.connection.cliPath": "LLM path",
    "settings.connection.defaultModel": "Default model",
    "settings.connection.modelList": "Model list",
    "settings.connection.commaSeparated": "Comma separated",
    "settings.connection.mode": "Mode",
    "settings.connection.modeObserve": "Record only",
    "settings.connection.modeGate": "Confirm before run",
    "settings.connection.selectedModel": "Selected model",
    "settings.connection.cliDefaultModel": "CLI default model",
    "settings.connection.env": "Environment variables",
    "settings.connection.planCommand": "Check/plan",
    "settings.connection.noCommand": "No command",
    "settings.connection.loadingModels": "Loading...",
    "settings.connection.loadModels": "Load models",
    "settings.connection.checking": "Checking...",
    "settings.connection.check": "Check connection",
    "settings.connection.remove": "Remove connection",
    "tasks.emptyProject.title": "Open a project",
    "tasks.emptyProject.description": "Open a Git repository so Helm can prepare the repo-local DB and agent state view.",
    "tasks.openProject": "Open project",
    "tasks.board.title": "All Kanban Boards",
    "tasks.board.description": "View tasks from active projects grouped by stage.",
    "tasks.board.filterAria": "Project filter",
    "tasks.board.all": "All",
    "tasks.board.syncing": "Syncing",
    "tasks.board.emptyTitle": "No tasks to display.",
    "tasks.board.emptyDescription": "Tasks will appear in the Kanban columns as soon as a project creates them.",
    "tasks.board.loadFailed": "Failed to load {count} project states.",
    "tasks.board.allProjects": "All projects",
    "tasks.board.project": "Project",
    "tasks.observer.aria": "Workspace observer summary",
    "tasks.observer.activeRuns": "Watching {count} runs",
    "tasks.observer.pendingApprovals": "{count} approvals pending",
    "tasks.observer.dirtyFiles": "{count} changed files detected",
    "tasks.observer.idle": "No runs waiting",
    "tasks.status.Planned": "Planned",
    "tasks.status.Ready": "Ready",
    "tasks.status.Coding": "Coding",
    "tasks.status.PlanVerification": "Plan Review",
    "tasks.status.CodeReview": "Code Review",
    "tasks.status.Testing": "Testing",
    "tasks.status.MergeWaiting": "Merge Waiting",
    "tasks.status.Merged": "Merged",
    "tasks.status.Done": "Done",
    "tasks.status.Blocked": "Blocked",
    "tasks.column.Planned.empty": "New plan candidates appear here.",
    "tasks.column.Ready.empty": "Approved plans move here while waiting for implementation.",
    "tasks.column.Coding.empty": "Implementation work in progress appears here.",
    "tasks.column.PlanVerification.empty": "This stage checks whether the diff matches the plan.",
    "tasks.column.CodeReview.empty": "Work that needs quality and risk review appears here.",
    "tasks.column.Testing.empty": "Work that needs test verification appears here.",
    "tasks.column.MergeWaiting.empty": "Work that passed every gate waits here for a merge decision.",
    "tasks.column.Merged.empty": "Tasks with landed branches appear here.",
    "tasks.column.Done.empty": "Fully closed tasks appear here.",
    "tasks.column.Blocked.empty": "Tasks needing a user decision or more input appear here.",
    "tasks.card.run": "run",
    "tasks.card.next": "next",
    "tasks.card.currentStage": "current stage",
    "tasks.card.nextAction": "next action",
    "tasks.run.approvalPending": "Do not proceed to the next step before approval.",
    "tasks.run.retryPossible": "retry available",
    "tasks.run.checkDetails": "Check details for evidence",
    "tasks.failure.needsInspection": "Needs inspection",
    "tasks.failure.blockingGate": "Gate blocked",
    "tasks.failure.diffMismatch": "Diff mismatch",
    "tasks.failure.schemaInvalid": "Result format mismatch",
    "tasks.failure.timeout": "Timed out",
    "tasks.failure.exitFailed": "Run failed",
    "tasks.failure.canceled": "Canceled",
    "tasks.failure.needsInspectionReason": "Manual inspection is required because there is not enough evidence for automatic judgment.",
    "tasks.failure.blockingGateReason": "A blocking issue was detected, so Helm did not proceed to the next step.",
    "sessions.emptyProject.title": "Open a project",
    "sessions.emptyProject.description": "Session chat is built from the project's run history and task context.",
    "sessions.openProject": "Open project",
    "sessions.listAria": "Session list",
    "sessions.projects": "Projects",
    "sessions.addSession": "Add session",
    "sessions.projectMenu": "Project menu",
    "sessions.deleteProject": "Delete project",
    "sessions.noSessions": "No sessions yet.",
    "sessions.providerUnknown": "provider unknown",
    "sessions.addProject": "Add project",
    "sessions.chatAria": "Session chat detail",
    "sessions.terminal": "Terminal",
    "sessions.assistantTitle": "Orchestrator",
    "sessions.requestTitle": "Request",
    "sessions.progressTitle": "Progress",
    "sessions.waitingTitle": "Waiting",
    "sessions.approvalTitle": "Approval request",
    "sessions.summaryTitle": "Summary",
    "sessions.introMessage": "Continue giving instructions below. Detailed events and artifacts accumulate in this chat, and the full progress is available in the Tasks tab.",
    "sessions.noLinkedRun": "No execution session is linked yet. Progress events will appear here after a run starts.",
    "sessions.composerPlaceholder": "Give the orchestrator a new task...",
    "sessions.sending": "Sending",
    "sessions.send": "Send",
    "sessions.stop": "Stop",
    "sessions.emptyChat.title": "Chat with the orchestrator",
    "sessions.emptyChat.description": "Send a new task instruction or select a session to inspect detailed progress.",
  },
  ko: {
    "nav.chat": "대화",
    "nav.tasks": "보드",
    "nav.git": "git",
    "nav.pr": "PR",
    "nav.jira": "jira",
    "nav.terminal": "터미널",
    "nav.editor": "에디터",
    "nav.settings": "설정",
    "shell.domainTabs": "도메인 탭",
    "shell.projects": "프로젝트",
    "shell.noProjects": "아직 열린 프로젝트가 없습니다.",
    "shell.addProject": "프로젝트 추가",
    "shell.processing": "처리 중",
    "shell.removeProjectTitle": "프로젝트 목록에서 삭제",
    "shell.removeProjectAria": "{name} 프로젝트 목록에서 삭제",
    "app.restore.title": "마지막 프로젝트 여는 중",
    "app.restore.description": "이전에 열었던 Helm 프로젝트와 실행 상태를 확인하고 있습니다.",
    "app.error.unknown": "알 수 없는 오류가 발생했습니다.",
    "settings.category.orchestrator.label": "오케스트레이터",
    "settings.category.orchestrator.hint": "모든 프로젝트에 적용되는 지휘자 AI",
    "settings.category.connections.label": "AI CLI 연결",
    "settings.category.connections.hint": "Codex · Claude Code · Gemini · 기타 LLM 경로",
    "settings.category.assignments.label": "작업별 CLI 선택",
    "settings.category.assignments.hint": "계획 · 구현 · 검수 · 테스트 매핑",
    "settings.category.usage.label": "통계 및 사용량",
    "settings.category.usage.hint": "Agent 실행, 작업 시간, provider 분포",
    "settings.category.jira.label": "Jira",
    "settings.category.jira.hint": "프로젝트 키와 기본 이슈 타입",
    "settings.category.worktree.label": "Worktree",
    "settings.category.worktree.hint": "병렬 작업 디렉터리 위치",
    "settings.category.app.label": "앱",
    "settings.category.app.hint": "언어와 Helm 업데이트 확인",
    "settings.category.advanced.label": "고급",
    "settings.category.advanced.hint": "Role presets JSON · 기존 runner 확인",
    "settings.save.global": "전역 저장",
    "settings.save.default": "저장",
    "settings.save.saving": "저장 중...",
    "settings.app.language.title": "언어",
    "settings.app.language.description": "Helm Desktop에서 사용할 표시 언어를 선택합니다.",
    "settings.app.language.label": "표시 언어",
    "settings.app.language.english": "영어",
    "settings.app.language.korean": "한국어",
    "settings.app.language.note": "기본값은 영어입니다. 이 설정은 앱 전역으로 저장됩니다.",
    "settings.app.projects.title": "프로젝트",
    "settings.app.projects.description": "최근 프로젝트 목록을 열거나 목록에서 제거합니다.",
    "settings.app.update.title": "앱 업데이트",
    "settings.app.update.description": "자동 확인 대신 필요할 때 Helm updater를 수동으로 실행합니다.",
    "settings.app.projectRequired.title": "설정은 전역으로 저장됩니다.",
    "settings.app.projectRequired.description": "실행 기록, Git, 터미널 기능은 프로젝트를 열면 사용할 수 있습니다.",
    "settings.app.openProject": "프로젝트 열기",
    "settings.app.currentVersion": "현재 버전 {version}",
    "settings.app.versionUnknown": "확인 전",
    "settings.app.checking": "확인 중...",
    "settings.app.checkUpdates": "업데이트 확인",
    "settings.app.newVersion": "새 버전 {version}",
    "settings.app.noReleaseDate": "배포일 정보 없음",
    "settings.app.install": "다운로드 및 설치",
    "settings.toast.appSettingsSaved.title": "전역 설정 저장 완료",
    "settings.toast.appSettingsSaved.description": "앱 전체에 적용될 설정을 저장했습니다.",
    "settings.toast.appSettingsFailed.title": "전역 설정 저장 실패",
    "settings.orchestrator.title": "전역 오케스트레이터",
    "settings.orchestrator.description": "다음 단계 복구는 Helm supervisor가 맡고, 지휘자 AI는 queued run 시작 전 기록 또는 확인만 맡습니다.",
    "settings.orchestrator.loading": "전역 설정을 불러오는 중입니다.",
    "settings.orchestrator.scope.title": "적용 범위",
    "settings.orchestrator.scope.description": "이 설정은 현재 프로젝트가 아니라 Helm 앱 전체에 저장됩니다.",
    "settings.orchestrator.scope.enabled": "전역 적용",
    "settings.orchestrator.scope.disabled": "꺼짐",
    "settings.orchestrator.import.title": "현재 프로젝트에 기존 지휘자 설정이 있습니다.",
    "settings.orchestrator.import.description": "전역 오케스트레이터로 가져오면 다른 프로젝트에서도 같은 설정을 사용합니다.",
    "settings.orchestrator.import.button": "전역으로 가져오기",
    "settings.orchestrator.enabled": "오케스트레이터 사용",
    "settings.orchestrator.useCodex": "Codex 사용",
    "settings.orchestrator.useClaude": "Claude Code 사용",
    "settings.orchestrator.useGemini": "Gemini 사용",
    "settings.orchestrator.useCustom": "기타 CLI 사용",
    "settings.orchestrator.selectCli": "오케스트레이터에 사용할 AI CLI를 선택하세요.",
    "settings.orchestrator.connection.subtitle": "전역 지휘자 AI 연결",
    "settings.orchestrator.promptOk": "프롬프트 OK",
    "settings.orchestrator.checkRequired": "확인 필요",
    "settings.orchestrator.modelChecking": "모델 확인 중",
    "settings.connection.name": "이름",
    "settings.connection.cliPath": "LLM 경로",
    "settings.connection.defaultModel": "기본 모델",
    "settings.connection.modelList": "모델 목록",
    "settings.connection.commaSeparated": "쉼표로 구분",
    "settings.connection.mode": "모드",
    "settings.connection.modeObserve": "기록만",
    "settings.connection.modeGate": "실행 전 확인",
    "settings.connection.selectedModel": "사용 모델",
    "settings.connection.cliDefaultModel": "CLI 기본 모델",
    "settings.connection.env": "환경 변수",
    "settings.connection.planCommand": "확인/계획",
    "settings.connection.noCommand": "command 없음",
    "settings.connection.loadingModels": "불러오는 중...",
    "settings.connection.loadModels": "모델 불러오기",
    "settings.connection.checking": "확인 중...",
    "settings.connection.check": "연동 확인",
    "settings.connection.remove": "연결 제거",
    "tasks.emptyProject.title": "프로젝트를 열어주세요",
    "tasks.emptyProject.description": "Git 저장소를 열면 Helm이 repo-local DB와 작업자 상태 화면을 준비합니다.",
    "tasks.openProject": "프로젝트 열기",
    "tasks.board.title": "전체 칸반보드",
    "tasks.board.description": "진행 중인 프로젝트의 Task를 단계별로 모아 봅니다.",
    "tasks.board.filterAria": "프로젝트 필터",
    "tasks.board.all": "전체",
    "tasks.board.syncing": "동기화 중",
    "tasks.board.emptyTitle": "표시할 태스크가 없습니다.",
    "tasks.board.emptyDescription": "프로젝트에서 Task가 생성되면 아래 칸반 컬럼에 바로 나타납니다.",
    "tasks.board.loadFailed": "{count}개 프로젝트 상태를 불러오지 못했습니다.",
    "tasks.board.allProjects": "전체 프로젝트",
    "tasks.board.project": "프로젝트",
    "tasks.observer.aria": "전체 관찰 요약",
    "tasks.observer.activeRuns": "{count}개 실행 관찰 중",
    "tasks.observer.pendingApprovals": "{count}개 승인 대기",
    "tasks.observer.dirtyFiles": "{count}개 변경 파일 감지",
    "tasks.observer.idle": "대기 중인 실행 없음",
    "tasks.status.Planned": "계획됨",
    "tasks.status.Ready": "준비됨",
    "tasks.status.Coding": "코딩중",
    "tasks.status.PlanVerification": "계획 검토",
    "tasks.status.CodeReview": "코드 리뷰",
    "tasks.status.Testing": "테스트",
    "tasks.status.MergeWaiting": "머지 대기",
    "tasks.status.Merged": "머지됨",
    "tasks.status.Done": "완료",
    "tasks.status.Blocked": "막힘",
    "tasks.column.Planned.empty": "새 계획 후보가 들어오면 여기에 쌓입니다.",
    "tasks.column.Ready.empty": "승인된 계획이 구현 대기 상태로 이동합니다.",
    "tasks.column.Coding.empty": "실행 중인 구현 작업이 여기에 표시됩니다.",
    "tasks.column.PlanVerification.empty": "구현 diff가 계획과 맞는지 확인하는 단계입니다.",
    "tasks.column.CodeReview.empty": "품질과 위험을 검토할 작업이 들어옵니다.",
    "tasks.column.Testing.empty": "테스트 검증이 필요한 작업이 들어옵니다.",
    "tasks.column.MergeWaiting.empty": "모든 gate를 통과한 작업이 merge 결정을 기다립니다.",
    "tasks.column.Merged.empty": "브랜치가 반영된 작업이 표시됩니다.",
    "tasks.column.Done.empty": "완전히 닫힌 작업이 표시됩니다.",
    "tasks.column.Blocked.empty": "사용자 결정이나 추가 입력이 필요한 작업이 표시됩니다.",
    "tasks.card.run": "run",
    "tasks.card.next": "next",
    "tasks.card.currentStage": "현재 단계",
    "tasks.card.nextAction": "다음 액션",
    "tasks.run.approvalPending": "승인 전에는 다음 단계로 진행하지 않습니다.",
    "tasks.run.retryPossible": "재시도 가능",
    "tasks.run.checkDetails": "상세에서 근거 확인",
    "tasks.failure.needsInspection": "점검 필요",
    "tasks.failure.blockingGate": "게이트 차단",
    "tasks.failure.diffMismatch": "diff 불일치",
    "tasks.failure.schemaInvalid": "결과 포맷 불일치",
    "tasks.failure.timeout": "시간 초과",
    "tasks.failure.exitFailed": "실행 실패",
    "tasks.failure.canceled": "취소됨",
    "tasks.failure.needsInspectionReason": "자동 판정에 필요한 근거가 부족해 수동 점검이 필요합니다.",
    "tasks.failure.blockingGateReason": "차단 이슈가 감지되어 다음 단계로 진행되지 않았습니다.",
    "sessions.emptyProject.title": "프로젝트를 열어주세요",
    "sessions.emptyProject.description": "세션 채팅은 프로젝트의 실행 기록과 작업 맥락을 기준으로 구성됩니다.",
    "sessions.openProject": "프로젝트 열기",
    "sessions.listAria": "세션 목록",
    "sessions.projects": "프로젝트",
    "sessions.addSession": "세션 추가",
    "sessions.projectMenu": "프로젝트 메뉴",
    "sessions.deleteProject": "프로젝트 삭제",
    "sessions.noSessions": "아직 세션이 없습니다.",
    "sessions.providerUnknown": "provider 미정",
    "sessions.addProject": "프로젝트 추가",
    "sessions.chatAria": "세션 채팅 상세",
    "sessions.terminal": "터미널",
    "sessions.assistantTitle": "오케스트레이터",
    "sessions.requestTitle": "요청",
    "sessions.progressTitle": "진행 상태",
    "sessions.waitingTitle": "대기",
    "sessions.approvalTitle": "승인 요청",
    "sessions.summaryTitle": "요약",
    "sessions.introMessage": "작업 지시는 아래 입력으로 이어서 받습니다. 상세 이벤트와 산출물은 이 채팅에 누적되고, 전체 진행상황은 태스크 탭에서 봅니다.",
    "sessions.noLinkedRun": "아직 연결된 실행 세션이 없습니다. 실행이 시작되면 이 화면에 진행 이벤트가 누적됩니다.",
    "sessions.composerPlaceholder": "오케스트레이터에게 새 작업 지시...",
    "sessions.sending": "전송 중",
    "sessions.send": "보내기",
    "sessions.stop": "멈춤",
    "sessions.emptyChat.title": "오케스트레이터와 대화하세요",
    "sessions.emptyChat.description": "새 작업 지시를 보내거나, 세션을 선택해 상세 진행사항을 확인합니다.",
  },
};

interface I18nContextValue {
  language: AppLanguage;
  t: (key: MessageKey, values?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nContextValue>({
  language: "en",
  t: (key, values) => formatMessage(messages.en[key], values),
});

export function I18nProvider({
  children,
  language,
}: {
  children: ReactNode;
  language: AppLanguage;
}) {
  const value: I18nContextValue = {
    language,
    t: (key, values) => formatMessage(messages[language][key] ?? messages.en[key], values),
  };
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  return useContext(I18nContext);
}

export function normalizeLanguage(value: unknown): AppLanguage {
  return value === "ko" ? "ko" : "en";
}

export function translate(language: AppLanguage, key: MessageKey, values?: Record<string, string | number>) {
  return formatMessage(messages[language][key] ?? messages.en[key], values);
}

function formatMessage(message: string, values?: Record<string, string | number>) {
  if (!values) return message;
  return Object.entries(values).reduce(
    (current, [key, value]) => current.replaceAll(`{${key}}`, String(value)),
    message,
  );
}
