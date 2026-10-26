import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Bot, Check, CircleAlert, LockKeyhole, MessageSquare, Plus, Send, X } from "lucide-react";
import { api, kiwiHostHeaders } from "@kw/lib/api";

type Session = { id: string; title: string };
type Selection = { quote: string };
type MessagePart = { type: string; text?: string; name?: string; state?: { status?: string } };
type Message = { id: string; type: string; text?: string; content?: MessagePart[] };
type Permission = { id: string; action: string; resources?: string[]; message?: string };
type Info = { enabled: boolean; agent?: string };
type Props = {
  open: boolean;
  path: string | null;
  space: string;
  editing: boolean;
  selection: string;
  onClose: () => void;
};

const savedSessionKey = "kiwifs-agent-chat-session";

function collect<T>(payload: unknown): T[] {
  if (!payload || typeof payload !== "object") return [];
  const entry = payload as { data?: unknown; items?: unknown };
  const list = entry.data ?? payload;
  if (Array.isArray(list)) return list as T[];
  if (list && typeof list === "object" && Array.isArray((list as { items?: unknown }).items)) {
    return (list as { items: T[] }).items;
  }
  return [];
}
function messageBody(message: Message): string {
  if (typeof message.text === "string") return message.text;
  return (message.content ?? []).filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text).join("\n");
}
function initialSession(): string {
  try { return sessionStorage.getItem(savedSessionKey) || ""; } catch { return ""; }
}

export function AgentChatPanel({ open, path, space, editing, selection, onClose }: Props) {
  const [info, setInfo] = useState<Info | null>(null);
  // Only store the chat key in memory, never persistent browser storage.
  const [key, setKey] = useState("");
  const [connected, setConnected] = useState(false);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionId, setSessionId] = useState(initialSession);
  const [messages, setMessages] = useState<Message[]>([]);
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [active, setActive] = useState(false);
  const [draft, setDraft] = useState("");
  const [attached, setAttached] = useState<"page" | "selection" | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const call = useCallback(async <T,>(route: string, init: RequestInit = {}): Promise<T> => {
    const res = await fetch("/api/kiwi/agent" + route, {
      ...init,
      headers: {
        ...kiwiHostHeaders(),
        "X-Kiwi-Agent-Key": key,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(res.status === 401 ? "Agent chat key rejected" : "Chat request failed (" + res.status + "): " + body.slice(0, 120));
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }, [key]);

  useEffect(() => {
    if (!open) return;
    let current = true;
    fetch("/api/kiwi/agent/info", { headers: kiwiHostHeaders() })
      .then((res) => {
        if (!res.ok) throw new Error("Chat configuration unavailable");
        return res.json() as Promise<Info>;
      })
      .then((value) => { if (current) setInfo(value); })
      .catch(() => { if (current) setError("Could not read chat configuration"); });
    return () => { current = false; };
  }, [open]);

  const refreshSessions = useCallback(async () => {
    const response = await call<{ sessions: Session[] }>("/sessions");
    setSessions(response.sessions || []);
    return response.sessions || [];
  }, [call]);

  async function connect() {
    if (!key) return;
    setLoading(true);
    setError("");
    try {
      const list = await refreshSessions();
      setConnected(true);
      if (!list.some((item) => item.id === sessionId)) setSessionId(list[0]?.id || "");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setLoading(false); }
  }

  async function startSession() {
    setLoading(true);
    setError("");
    try {
      const session = await call<Session>("/sessions", { method: "POST" });
      setSessions((items) => [session, ...items]);
      setSessionId(session.id);
      setMessages([]);
      setPermissions([]);
      setActive(false);
      setAttached(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setLoading(false); }
  }

  useEffect(() => {
    try {
      if (sessionId) sessionStorage.setItem(savedSessionKey, sessionId);
      else sessionStorage.removeItem(savedSessionKey);
    } catch { /* Optional UI preference only. */ }
  }, [sessionId]);

  useEffect(() => {
    if (!connected || !sessionId || !open) return;
    let cancelled = false;
    let inflight = false;
    setMessages([]);
    setPermissions([]);
    const poll = async () => {
      if (inflight) return;
      inflight = true;
      try {
        const id = encodeURIComponent(sessionId);
        const [history, activity, requests] = await Promise.all([
          call<unknown>("/sessions/" + id + "/messages"),
          call<{ active: boolean }>("/sessions/" + id + "/activity"),
          call<unknown>("/sessions/" + id + "/permissions"),
        ]);
        if (cancelled) return;
        setMessages(collect<Message>(history).reverse());
        setActive(Boolean(activity.active));
        setPermissions(collect<Permission>(requests));
        setError("");
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally { inflight = false; }
    };
    void poll();
    const timer = window.setInterval(() => { void poll(); }, 1500);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [call, connected, open, sessionId]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft.trim() || !sessionId || pending) return;
    setPending(true);
    setError("");
    try {
      let context: { path: string; space: string; version?: string; draft?: boolean; content?: string; truncated?: boolean; selection?: Selection } | undefined;
      if (attached && path) {
        // Read through KiwiFS's normal authenticated API; do not assume
        // OpenCode can access this workspace or silently drop failed reads.
        const file = await api.readFile(path);
        context = { path, space, draft: editing };
        if (file.etag) context.version = file.etag;
        if (attached === "page") {
          context.content = file.content.slice(0, 8000);
          context.truncated = file.content.length > 8000;
        }
        if (attached === "selection" && selection.trim()) {
          context.selection = { quote: selection.slice(0, 4000) };
        }
      }
      await call("/sessions/" + encodeURIComponent(sessionId) + "/messages", {
        method: "POST",
        body: JSON.stringify({ text: draft.trim(), context }),
      });
      setDraft("");
      setAttached(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setPending(false); }
  };

  async function reply(permission: Permission, decision: "once" | "reject") {
    if (!sessionId) return;
    setLoading(true);
    setError("");
    try {
      await call("/sessions/" + encodeURIComponent(sessionId) + "/permissions/" + encodeURIComponent(permission.id) + "/reply", {
        method: "POST", body: JSON.stringify({ decision }),
      });
      setPermissions((all) => all.filter((entry) => entry.id !== permission.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setLoading(false); }
  }

  return (
    <aside aria-label="Agent chat" aria-hidden={!open}
      className={(open ? "flex" : "hidden") + " fixed inset-0 z-40 flex-col border-l border-border bg-background md:relative md:inset-auto md:z-auto md:w-[390px] md:min-w-[310px] md:max-w-[45vw] md:shrink-0"}>
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
        <Bot className="h-4 w-4 text-primary" aria-hidden />
        <span className="text-sm font-semibold">{info?.agent || "Agent chat"}</span>
        {connected && <span className={"ml-1 text-[11px] " + (active ? "text-primary" : "text-muted-foreground")} role="status">{active ? "Working…" : "Idle"}</span>}
        <div className="flex-1" />
        {connected && <button type="button" onClick={() => void startSession()} disabled={loading}
          aria-label="New agent conversation" title="New conversation"
          className="rounded p-1.5 hover:bg-accent disabled:opacity-50"><Plus className="h-4 w-4" /></button>}
        <button type="button" onClick={onClose} aria-label="Close agent chat"
          className="rounded p-1.5 hover:bg-accent"><X className="h-4 w-4" /></button>
      </div>

      {!info?.enabled ? (
        <div className="space-y-2 p-5 text-sm text-muted-foreground">
          <CircleAlert className="h-5 w-5" aria-hidden />
          {info === null ? "Checking chat configuration…" : "Agent chat is disabled on this server."}
          <p className="text-xs">Set the server-side OpenCode URL and chat access key to enable it. No separate agent is created.</p>
        </div>
      ) : !connected ? (
        <form className="space-y-3 p-4" onSubmit={(event) => { event.preventDefault(); void connect(); }}>
          <div className="flex items-center gap-2 text-sm font-medium"><LockKeyhole className="h-4 w-4" /> Connect to agent chat</div>
          <p className="text-xs text-muted-foreground">Enter the chat key configured by the KiwiFS server owner. It is not saved in your browser.</p>
          <input type="password" autoComplete="off" aria-label="Agent chat access key"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            placeholder="Chat access key" value={key} onChange={(event) => setKey(event.target.value)} />
          <button type="submit" disabled={!key || loading}
            className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">
            {loading ? "Connecting…" : "Connect"}
          </button>
        </form>
      ) : (
        <>
          <div className="flex items-center gap-2 border-b border-border px-3 py-2">
            <label htmlFor="kiwi-agent-session" className="sr-only">Conversation</label>
            <select id="kiwi-agent-session" value={sessionId} onChange={(event) => setSessionId(event.target.value)}
              className="min-w-0 flex-1 rounded-md border border-input bg-background px-2 py-1.5 text-xs">
              {!sessionId && <option value="">Select a conversation</option>}
              {sessions.map((session) => (
                <option key={session.id} value={session.id}>{session.title.replace(/^KiwiFS ben-pa · /, "")} · {session.id.slice(-6)}</option>
              ))}
            </select>
          </div>
          <div className="flex-1 space-y-3 overflow-y-auto p-3" aria-live="polite">
            {sessionId === "" && <p className="pt-6 text-center text-sm text-muted-foreground">Start a conversation with your existing agent.</p>}
            {sessionId && messages.length === 0 && <p className="pt-6 text-center text-sm text-muted-foreground">Write a message below to get started.</p>}
            {messages.map((message) => {
              if (message.type !== "user" && message.type !== "assistant") return null;
              const body = messageBody(message);
              const tools = (message.content ?? []).filter((part) => part.type === "tool");
              if (!body && tools.length === 0) return null;
              return (
                <div key={message.id} className={"rounded-lg p-3 text-sm " + (message.type === "user" ? "ml-5 bg-accent" : "mr-3 border border-border")}>
                  <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    {message.type === "user" ? "You" : info.agent}
                  </div>
                  {body && <div className="whitespace-pre-wrap break-words leading-relaxed">{body}</div>}
                  {tools.map((tool, i) => (
                    <div key={i} className="mt-2 flex items-center gap-2 rounded border border-border px-2 py-1.5 text-xs text-muted-foreground">
                      <MessageSquare className="h-3 w-3" aria-hidden />
                      <span className="truncate">{tool.name || "Tool"}</span>
                      <span className="ml-auto">{tool.state?.status || "pending"}</span>
                    </div>
                  ))}
                </div>
              );
            })}
            {active && <div role="status" className="text-xs text-muted-foreground">Agent is working. Messages and tools update automatically…</div>}
            {permissions.map((permission) => (
              <div key={permission.id} className="rounded-lg border border-border bg-card p-3 text-sm">
                <div className="mb-1 font-semibold">Permission required</div>
                <div className="break-words text-xs">{permission.action}</div>
                {permission.resources?.length ? <div className="mt-1 break-all text-xs text-muted-foreground">{permission.resources.join(", ")}</div> : null}
                {permission.message && <p className="mt-1 text-xs">{permission.message}</p>}
                <div className="mt-3 flex gap-2">
                  <button type="button" disabled={loading} onClick={() => void reply(permission, "once")}
                    className="flex items-center gap-1 rounded bg-primary px-2 py-1 text-xs text-primary-foreground disabled:opacity-50">
                    <Check className="h-3 w-3" /> Allow once
                  </button>
                  <button type="button" disabled={loading} onClick={() => void reply(permission, "reject")}
                    className="rounded border border-border px-2 py-1 text-xs disabled:opacity-50">Reject</button>
                </div>
              </div>
            ))}
          </div>
          <form onSubmit={(event) => void submit(event)} className="shrink-0 space-y-2 border-t border-border p-3">
            {path && (
              <div className="flex flex-wrap items-center gap-1.5">
                <button type="button" onClick={() => setAttached(attached === "page" ? null : "page")}
                  className={"rounded border px-2 py-1 text-[11px] " + (attached === "page" ? "border-primary bg-accent" : "border-border")}>
                  {attached === "page" ? "✓ " : "+ "}Page: {path.split("/").pop()}
                </button>
                {selection.trim() && (
                  <button type="button" onClick={() => setAttached(attached === "selection" ? null : "selection")}
                    className={"rounded border px-2 py-1 text-[11px] " + (attached === "selection" ? "border-primary bg-accent" : "border-border")}>
                    {attached === "selection" ? "✓ " : "+ "}Selection
                  </button>
                )}
                {attached === "selection" && <p className="w-full truncate text-[11px] text-muted-foreground">“{selection}”</p>}
                {editing && attached && <p className="w-full text-[11px] text-muted-foreground">Editor open: selected text may be unsaved.</p>}
              </div>
            )}
            <div className="flex items-end gap-2">
              <textarea aria-label="Message your agent" value={draft} onChange={(event) => setDraft(event.target.value)}
                placeholder="Message your agent…" rows={3} disabled={!sessionId || pending}
                className="min-h-20 flex-1 resize-none rounded-md border border-input bg-background p-2 text-sm disabled:opacity-50" />
              <button type="submit" aria-label="Send message" disabled={!sessionId || !draft.trim() || pending}
                className="rounded-md bg-primary p-2.5 text-primary-foreground disabled:opacity-50">
                <Send className="h-4 w-4" />
              </button>
            </div>
          </form>
        </>
      )}
      {error && <div role="alert" className="border-t border-border px-3 py-2 text-xs text-destructive">{error}</div>}
    </aside>
  );
}
