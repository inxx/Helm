import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef, useState } from "react";
import { Bot, Loader2, Send, Square, User, Wrench } from "lucide-react";
import { api } from "../lib/api";

// Interactive ACP session with Hermes: Helm spawns `hermes acp`, streams the agent's
// message/tool updates over Tauri events, and surfaces permission requests as inline
// approvals. See docs/hermes-native-acp-architecture.md (ACP client).

type ChatItem =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; name: string; detail: string };

interface AcpUpdate {
  sessionId: string;
  update: {
    sessionUpdate?: string;
    content?: { text?: string } | { text?: string }[];
    title?: string;
  } | null;
}
interface AcpPermission {
  sessionId: string;
  requestId: unknown;
  params: { options?: { optionId: string; name?: string }[] } | null;
}

function chunkText(content: AcpUpdate["update"]): string {
  const c = content?.content;
  if (!c) return "";
  if (Array.isArray(c)) return c.map((part) => part.text ?? "").join("");
  return c.text ?? "";
}

export function HermesChat() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [items, setItems] = useState<ChatItem[]>([]);
  const [input, setInput] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [permission, setPermission] = useState<AcpPermission | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // create a session on mount, tear it down on unmount.
  useEffect(() => {
    let disposed = false;
    let created: string | null = null;
    void api
      .acpSessionNew()
      .then((id) => {
        if (disposed) {
          void api.acpSessionClose(id);
          return;
        }
        created = id;
        setSessionId(id);
      })
      .catch((err) => !disposed && setError(messageFromError(err, "ACP 세션을 시작하지 못했습니다.")));
    return () => {
      disposed = true;
      if (created) void api.acpSessionClose(created);
    };
  }, []);

  // subscribe to ACP stream events for this session.
  useEffect(() => {
    if (!sessionId) return;
    let disposed = false;
    const unlisteners: Array<() => void> = [];

    const sub = <T,>(event: string, handler: (payload: T) => void) => {
      void listen<T>(event, (e) => {
        if (!disposed) handler(e.payload);
      }).then((un) => (disposed ? un() : unlisteners.push(un)));
    };

    sub<AcpUpdate>("acp://update", (payload) => {
      if (payload.sessionId !== sessionId || !payload.update) return;
      const kind = payload.update.sessionUpdate;
      if (kind === "agent_message_chunk") {
        const text = chunkText(payload.update);
        if (!text) return;
        setItems((prev) => appendAssistant(prev, text));
      } else if (kind === "tool_call") {
        setItems((prev) => [...prev, { kind: "tool", name: payload.update?.title ?? "tool", detail: chunkText(payload.update) }]);
      }
    });
    sub<{ sessionId: string }>("acp://turn", (payload) => {
      if (payload.sessionId === sessionId) setWorking(false);
    });
    sub<{ sessionId: string }>("acp://closed", (payload) => {
      if (payload.sessionId === sessionId) {
        setWorking(false);
        setError("ACP 세션이 종료되었습니다.");
      }
    });
    sub<AcpPermission>("acp://permission", (payload) => {
      if (payload.sessionId === sessionId) setPermission(payload);
    });

    return () => {
      disposed = true;
      unlisteners.forEach((un) => un());
    };
  }, [sessionId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [items.length, working]);

  async function send() {
    const text = input.trim();
    if (!text || !sessionId || working) return;
    setInput("");
    setItems((prev) => [...prev, { kind: "user", text }]);
    setWorking(true);
    setError(null);
    try {
      await api.acpSessionPrompt(sessionId, text);
    } catch (err) {
      setWorking(false);
      setError(messageFromError(err, "프롬프트 전송에 실패했습니다."));
    }
  }

  async function cancel() {
    if (!sessionId) return;
    try {
      await api.acpSessionCancel(sessionId);
    } catch {
      /* best-effort */
    }
    setWorking(false);
  }

  async function respondPermission(optionId: string) {
    if (!permission || !sessionId) return;
    try {
      await api.acpPermissionRespond(sessionId, permission.requestId, optionId);
    } catch (err) {
      setError(messageFromError(err, "권한 응답에 실패했습니다."));
    } finally {
      setPermission(null);
    }
  }

  return (
    <section className="session-chat" aria-label="Hermes ACP chat">
      <header className="session-chat-header">
        <div>
          <h1>Hermes Chat</h1>
          <p>{sessionId ? `ACP 세션 · ${sessionId.slice(0, 8)}` : "세션 시작 중…"}</p>
        </div>
        {working ? (
          <button className="session-context-link" onClick={() => void cancel()} type="button">
            <Square size={12} aria-hidden /> 중단
          </button>
        ) : null}
      </header>

      {error ? (
        <div className="error-banner compact" role="alert">
          {error}
        </div>
      ) : null}

      <div className="session-chat-scroll" ref={scrollRef}>
        {items.length === 0 && !working ? (
          <p className="session-context-empty">메시지를 입력해 Hermes와 대화를 시작하세요.</p>
        ) : null}
        {items.map((item, index) => (
          <ChatBubble key={index} item={item} />
        ))}
        {working ? (
          <div className="session-working-indicator">
            <span className="session-working-spinner" aria-hidden="true" />
            <div>
              <strong>응답 생성 중…</strong>
            </div>
          </div>
        ) : null}
        {permission ? (
          <div className="hermes-permission" role="alertdialog" aria-label="권한 요청">
            <strong>권한 요청</strong>
            <div className="hermes-permission-actions">
              {(permission.params?.options ?? []).map((option) => (
                <button key={option.optionId} onClick={() => void respondPermission(option.optionId)} type="button">
                  {option.name ?? option.optionId}
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      <form
        className="session-orchestrator-composer"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <textarea
          aria-label="메시지"
          disabled={!sessionId || working}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
            event.preventDefault();
            void send();
          }}
          placeholder="Hermes에게 메시지…"
          rows={2}
          value={input}
        />
        <button className="primary-button loading-button" disabled={!input.trim() || !sessionId || working} type="submit">
          {working ? <Loader2 className="loading-icon" size={14} aria-hidden /> : <Send size={14} aria-hidden />}
          <span>{working ? "전송 중" : "전송"}</span>
        </button>
      </form>
    </section>
  );
}

function ChatBubble({ item }: { item: ChatItem }) {
  if (item.kind === "tool") {
    return (
      <article className="session-message tool">
        <div className="session-message-avatar">
          <Wrench size={14} />
        </div>
        <div className="session-message-body">
          <header>
            <strong>{item.name}</strong>
          </header>
          <div className="session-message-content">
            <code>{item.detail.slice(0, 200)}</code>
          </div>
        </div>
      </article>
    );
  }
  const isUser = item.kind === "user";
  return (
    <article className={`session-message ${item.kind}`}>
      <div className="session-message-avatar">{isUser ? <User size={14} /> : <Bot size={14} />}</div>
      <div className="session-message-body">
        <header>
          <strong>{isUser ? "나" : "Hermes"}</strong>
        </header>
        <div className="session-message-content">{item.text}</div>
      </div>
    </article>
  );
}

function appendAssistant(items: ChatItem[], text: string): ChatItem[] {
  const last = items[items.length - 1];
  if (last && last.kind === "assistant") {
    const next = items.slice(0, -1);
    next.push({ kind: "assistant", text: last.text + text });
    return next;
  }
  return [...items, { kind: "assistant", text }];
}

function messageFromError(error: unknown, fallback: string): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return fallback;
}
