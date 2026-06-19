import { createContext, useContext, type ReactNode } from "react";

export type AppLanguage = "en" | "ko";

type MessageKey =
  | "nav.chat"
  | "nav.tasks"
  | "nav.git"
  | "nav.terminal"
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
  | "settings.category.templates.label"
  | "settings.category.templates.hint"
  | "settings.category.connections.label"
  | "settings.category.connections.hint"
  | "settings.category.assignments.label"
  | "settings.category.assignments.hint"
  | "settings.category.policies.label"
  | "settings.category.policies.hint"
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
  | "sessions.emptyChat.title"
  | "sessions.emptyChat.description";

const messages: Record<AppLanguage, Record<MessageKey, string>> = {
  en: {
    "nav.chat": "Chat",
    "nav.tasks": "Tasks",
    "nav.git": "Git",
    "nav.terminal": "Terminal",
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
    "settings.category.templates.label": "Runner Templates",
    "settings.category.templates.hint": "Apply role presets and AI CLI connections together",
    "settings.category.connections.label": "AI CLI Connections",
    "settings.category.connections.hint": "Codex, Claude Code, Gemini, and other LLM paths",
    "settings.category.assignments.label": "Role CLI Selection",
    "settings.category.assignments.hint": "Planner, coder, reviewer, and tester mappings",
    "settings.category.policies.label": "Role Policies",
    "settings.category.policies.hint": "Default policy Markdown per role",
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
    "settings.app.update.title": "App Updates",
    "settings.app.update.description": "Run the Helm updater manually when needed instead of automatic checks.",
    "settings.app.projectRequired.title": "Project settings appear after opening a project.",
    "settings.app.projectRequired.description": "Global orchestrator and app updates can be managed without a project.",
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
    "sessions.emptyChat.title": "Chat with the orchestrator",
    "sessions.emptyChat.description": "Send a new task instruction or select a session to inspect detailed progress.",
  },
  ko: {
    "nav.chat": "채팅",
    "nav.tasks": "태스크",
    "nav.git": "깃",
    "nav.terminal": "터미널",
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
    "settings.category.templates.label": "Runner Templates",
    "settings.category.templates.hint": "역할 프리셋과 AI CLI 연결을 한 번에 적용",
    "settings.category.connections.label": "AI CLI 연결",
    "settings.category.connections.hint": "Codex · Claude Code · Gemini · 기타 LLM 경로",
    "settings.category.assignments.label": "작업별 CLI 선택",
    "settings.category.assignments.hint": "계획 · 구현 · 검수 · 테스트 매핑",
    "settings.category.policies.label": "역할 정책",
    "settings.category.policies.hint": "Role별 기본 정책 MD",
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
    "settings.app.update.title": "앱 업데이트",
    "settings.app.update.description": "자동 확인 대신 필요할 때 Helm updater를 수동으로 실행합니다.",
    "settings.app.projectRequired.title": "프로젝트별 설정은 프로젝트를 연 뒤 표시됩니다.",
    "settings.app.projectRequired.description": "전역 오케스트레이터와 앱 업데이트는 프로젝트 없이도 관리할 수 있습니다.",
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
