import React, { useState, useEffect, useRef, useCallback } from "react";
import { apiFetch, relativeTime, C, S } from "../App";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface LiveLogEntry {
  timestamp: string;
  message: string;
  level?: string;
  [key: string]: any;
}

interface AppLogEntry {
  id: number;
  level: string;
  category: string;
  message: string;
  metadata: string | null;
  sessionId: string | null;
  userId: string | null;
  createdAt: number;
}

interface ErrorLogEntry {
  id: number;
  level: string;
  category: string;
  message: string;
  stack: string | null;
  metadata: string | null;
  sessionId: string | null;
  userId: string | null;
  createdAt: number;
}

type Tab = "live" | "app" | "errors";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const levelColor = (level?: string) => {
  if (!level) return C.text;
  const l = level.toLowerCase();
  if (l === "error" || l === "fatal") return C.error;
  if (l === "warn" || l === "warning") return C.warning;
  if (l === "debug" || l === "trace") return C.textDim;
  return C.text;
};

const formatTs = (iso: string | number) => {
  try {
    return new Date(iso).toLocaleTimeString("en-US", { hour12: false });
  } catch {
    return String(iso);
  }
};

const formatDateTime = (ts: number) => {
  try {
    const d = new Date(ts);
    return d.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  } catch {
    return String(ts);
  }
};

const TIME_OPTIONS: { label: string; hours: number }[] = [
  { label: "1h", hours: 1 },
  { label: "6h", hours: 6 },
  { label: "24h", hours: 24 },
  { label: "3d", hours: 72 },
  { label: "7d", hours: 168 },
];

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function TabBar({
  active,
  onChange,
}: {
  active: Tab;
  onChange: (t: Tab) => void;
}) {
  const tabs: { key: Tab; label: string }[] = [
    { key: "live", label: "🔴 Live" },
    { key: "app", label: "📋 App Logs" },
    { key: "errors", label: "⚠️ Errors" },
  ];

  return (
    <div style={{ display: "flex", gap: 2, marginBottom: 12 }}>
      {tabs.map(({ key, label }) => (
        <button
          key={key}
          onClick={() => onChange(key)}
          style={{
            padding: "6px 16px",
            background: active === key ? C.accent : C.surface,
            color: active === key ? "#fff" : C.textDim,
            border: "none",
            borderRadius: "4px 4px 0 0",
            cursor: "pointer",
            fontSize: 13,
            fontWeight: active === key ? 600 : 400,
            transition: "all 0.15s",
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function TimeWindowPicker({
  hours,
  onChange,
}: {
  hours: number;
  onChange: (h: number) => void;
}) {
  return (
    <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
      <span style={{ fontSize: 12, color: C.textDim, marginRight: 4 }}>
        Window:
      </span>
      {TIME_OPTIONS.map((opt) => (
        <button
          key={opt.hours}
          onClick={() => onChange(opt.hours)}
          style={{
            padding: "2px 8px",
            background: hours === opt.hours ? C.accent : C.primary,
            color: hours === opt.hours ? "#fff" : C.textDim,
            border: "none",
            borderRadius: 3,
            cursor: "pointer",
            fontSize: 11,
          }}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function ExpandableRow({
  label,
  content,
}: {
  label: string;
  content: string | null;
}) {
  const [open, setOpen] = useState(false);
  if (!content) return null;

  return (
    <div style={{ marginTop: 4 }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          background: "none",
          border: "none",
          color: C.accent,
          cursor: "pointer",
          fontSize: 11,
          padding: 0,
          textDecoration: "underline",
        }}
      >
        {open ? "▾" : "▸"} {label}
      </button>
      {open && (
        <pre
          style={{
            background: C.bg,
            padding: 8,
            borderRadius: 4,
            fontSize: 11,
            marginTop: 4,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            maxHeight: 300,
            overflow: "auto",
            color: C.textDim,
          }}
        >
          {content}
        </pre>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Live Stream Tab
// ---------------------------------------------------------------------------

function LiveTab() {
  const [logs, setLogs] = useState<LiveLogEntry[]>([]);
  const [filter, setFilter] = useState("");
  const [connected, setConnected] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${window.location.host}/ws/logs`;

    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => setConnected(true);

    ws.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data);
        const entry: LiveLogEntry =
          typeof data === "string"
            ? { timestamp: new Date().toISOString(), message: data }
            : {
                timestamp: data.timestamp || new Date().toISOString(),
                message:
                  data.message || data.msg || data.content || JSON.stringify(data),
                level: data.level,
                ...data,
              };
        setLogs((prev) => [...prev, entry]);
      } catch {
        setLogs((prev) => [
          ...prev,
          { timestamp: new Date().toISOString(), message: ev.data },
        ]);
      }
    };

    ws.onclose = () => {
      setConnected(false);
      reconnectTimer.current = setTimeout(connect, 3000);
    };

    ws.onerror = () => {
      ws.close();
    };
  }, []);

  useEffect(() => {
    connect();
    return () => {
      clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, [connect]);

  useEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  const handleScroll = () => {
    if (!containerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
    const atBottom = scrollHeight - scrollTop - clientHeight < 40;
    setAutoScroll(atBottom);
  };

  const clear = () => setLogs([]);

  const filtered = filter
    ? logs.filter((l) =>
        l.message.toLowerCase().includes(filter.toLowerCase()),
      )
    : logs;

  return (
    <>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 8,
        }}
      >
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            fontSize: 12,
          }}
        >
          <span
            style={{
              display: "inline-block",
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: connected ? C.success : C.error,
            }}
          />
          {connected ? "Connected" : "Disconnected"}
        </span>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter..."
            style={{ ...S.input, width: 200, fontSize: 12 }}
          />
          <button style={S.btnSmall} onClick={clear}>
            Clear
          </button>
          <span style={{ fontSize: 11, color: C.textDim }}>
            {filtered.length} entries
          </span>
        </div>
      </div>

      <div
        ref={containerRef}
        onScroll={handleScroll}
        style={{
          flex: 1,
          background: C.surface,
          borderRadius: 6,
          padding: 12,
          overflowY: "auto",
          fontFamily: "monospace",
          fontSize: 12,
          lineHeight: 1.7,
        }}
      >
        {filtered.length === 0 ? (
          <div style={{ color: C.textDim }}>
            {logs.length === 0
              ? "Waiting for log messages..."
              : "No matches for filter"}
          </div>
        ) : (
          filtered.map((entry, i) => (
            <div
              key={i}
              style={{
                borderBottom: `1px solid ${C.border}22`,
                padding: "2px 0",
                display: "flex",
                gap: 10,
              }}
            >
              <span style={{ color: C.textDim, flexShrink: 0 }}>
                {formatTs(entry.timestamp)}
              </span>
              {entry.level && (
                <span
                  style={{
                    color: levelColor(entry.level),
                    fontWeight: 600,
                    width: 42,
                    flexShrink: 0,
                    textTransform: "uppercase",
                  }}
                >
                  {entry.level.slice(0, 5)}
                </span>
              )}
              <span
                style={{
                  color: levelColor(entry.level),
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                }}
              >
                {entry.message}
              </span>
            </div>
          ))
        )}
      </div>

      {!autoScroll && (
        <button
          onClick={() => {
            setAutoScroll(true);
            if (containerRef.current) {
              containerRef.current.scrollTop =
                containerRef.current.scrollHeight;
            }
          }}
          style={{
            ...S.btnSmall,
            position: "fixed",
            bottom: 24,
            right: 24,
            background: C.accent,
            padding: "6px 14px",
            zIndex: 10,
          }}
        >
          ↓ Scroll to bottom
        </button>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// App Logs Tab
// ---------------------------------------------------------------------------

function AppLogsTab() {
  const [logs, setLogs] = useState<AppLogEntry[]>([]);
  const [hours, setHours] = useState(24);
  const [level, setLevel] = useState("");
  const [category, setCategory] = useState("");
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(false);

  const fetch_ = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ hours: String(hours), limit: "500" });
      if (level) params.set("level", level);
      if (category) params.set("category", category);
      const data = await apiFetch<{ logs: AppLogEntry[] }>(
        `/api/logs/app?${params}`,
      );
      setLogs(data.logs);
    } catch (err) {
      console.error("Failed to fetch app logs:", err);
    } finally {
      setLoading(false);
    }
  }, [hours, level, category]);

  useEffect(() => {
    fetch_();
  }, [fetch_]);

  const filtered = filter
    ? logs.filter(
        (l) =>
          l.message.toLowerCase().includes(filter.toLowerCase()) ||
          l.category.toLowerCase().includes(filter.toLowerCase()),
      )
    : logs;

  return (
    <>
      <div
        style={{
          display: "flex",
          gap: 12,
          alignItems: "center",
          flexWrap: "wrap",
          marginBottom: 8,
        }}
      >
        <TimeWindowPicker hours={hours} onChange={setHours} />
        <select
          value={level}
          onChange={(e) => setLevel(e.target.value)}
          style={{ ...S.input, fontSize: 12, width: 100 }}
        >
          <option value="">All levels</option>
          <option value="debug">Debug</option>
          <option value="info">Info</option>
          <option value="warn">Warn</option>
          <option value="error">Error</option>
        </select>
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          style={{ ...S.input, fontSize: 12, width: 120 }}
        >
          <option value="">All categories</option>
          {[
            "agent",
            "bot",
            "cron",
            "daemon",
            "db",
            "evolution",
            "gateway",
            "memory",
            "reflection",
            "skills",
            "soul",
            "startup",
            "shutdown",
          ].map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Search..."
          style={{ ...S.input, width: 180, fontSize: 12 }}
        />
        <button style={S.btnSmall} onClick={fetch_}>
          {loading ? "Loading..." : "Refresh"}
        </button>
        <span style={{ fontSize: 11, color: C.textDim }}>
          {filtered.length} entries
        </span>
      </div>

      <div
        style={{
          flex: 1,
          background: C.surface,
          borderRadius: 6,
          overflowY: "auto",
          fontFamily: "monospace",
          fontSize: 12,
        }}
      >
        <table style={S.table}>
          <thead>
            <tr>
              <th style={{ ...S.th, width: 140 }}>Time</th>
              <th style={{ ...S.th, width: 50 }}>Level</th>
              <th style={{ ...S.th, width: 90 }}>Category</th>
              <th style={S.th}>Message</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={4} style={{ ...S.td, color: C.textDim, textAlign: "center" }}>
                  {loading ? "Loading..." : "No log entries found"}
                </td>
              </tr>
            ) : (
              filtered.map((entry) => (
                <tr key={entry.id}>
                  <td style={{ ...S.td, color: C.textDim, fontSize: 11 }}>
                    {formatDateTime(entry.createdAt)}
                  </td>
                  <td style={S.td}>
                    <span
                      style={{
                        ...S.badge(levelColor(entry.level)),
                        textTransform: "uppercase",
                      }}
                    >
                      {entry.level}
                    </span>
                  </td>
                  <td style={{ ...S.td, color: C.textDim, fontSize: 11 }}>
                    {entry.category}
                  </td>
                  <td style={{ ...S.td, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                    <span style={{ color: levelColor(entry.level) }}>
                      {entry.message}
                    </span>
                    <ExpandableRow label="metadata" content={entry.metadata} />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Errors Tab
// ---------------------------------------------------------------------------

function ErrorsTab() {
  const [logs, setLogs] = useState<ErrorLogEntry[]>([]);
  const [stats, setStats] = useState<Record<string, number>>({});
  const [hours, setHours] = useState(24);
  const [category, setCategory] = useState("");
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(false);

  const fetch_ = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ hours: String(hours), limit: "500" });
      if (category) params.set("category", category);
      const [logData, statData] = await Promise.all([
        apiFetch<{ logs: ErrorLogEntry[] }>(`/api/logs/errors?${params}`),
        apiFetch<{ counts: Record<string, number> }>(
          `/api/logs/errors/stats?hours=${hours}`,
        ),
      ]);
      setLogs(logData.logs);
      setStats(statData.counts);
    } catch (err) {
      console.error("Failed to fetch error logs:", err);
    } finally {
      setLoading(false);
    }
  }, [hours, category]);

  useEffect(() => {
    fetch_();
  }, [fetch_]);

  const filtered = filter
    ? logs.filter(
        (l) =>
          l.message.toLowerCase().includes(filter.toLowerCase()) ||
          l.category.toLowerCase().includes(filter.toLowerCase()),
      )
    : logs;

  const statEntries = Object.entries(stats).sort((a, b) => b[1] - a[1]);

  return (
    <>
      {/* Error stats summary */}
      {statEntries.length > 0 && (
        <div
          style={{
            display: "flex",
            gap: 8,
            flexWrap: "wrap",
            marginBottom: 12,
          }}
        >
          {statEntries.map(([cat, count]) => (
            <div
              key={cat}
              onClick={() => setCategory(cat)}
              style={{
                ...S.card,
                marginBottom: 0,
                padding: "8px 14px",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                gap: 8,
                border:
                  category === cat
                    ? `1px solid ${C.error}`
                    : `1px solid ${C.border}`,
              }}
            >
              <span style={{ fontSize: 18, fontWeight: 700, color: C.error }}>
                {count}
              </span>
              <span style={{ fontSize: 12, color: C.textDim }}>{cat}</span>
            </div>
          ))}
        </div>
      )}

      <div
        style={{
          display: "flex",
          gap: 12,
          alignItems: "center",
          flexWrap: "wrap",
          marginBottom: 8,
        }}
      >
        <TimeWindowPicker hours={hours} onChange={setHours} />
        {category && (
          <button
            style={S.btnSmall}
            onClick={() => setCategory("")}
          >
            ✕ {category}
          </button>
        )}
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Search..."
          style={{ ...S.input, width: 180, fontSize: 12 }}
        />
        <button style={S.btnSmall} onClick={fetch_}>
          {loading ? "Loading..." : "Refresh"}
        </button>
        <span style={{ fontSize: 11, color: C.textDim }}>
          {filtered.length} errors
        </span>
      </div>

      <div
        style={{
          flex: 1,
          background: C.surface,
          borderRadius: 6,
          overflowY: "auto",
          fontFamily: "monospace",
          fontSize: 12,
        }}
      >
        <table style={S.table}>
          <thead>
            <tr>
              <th style={{ ...S.th, width: 140 }}>Time</th>
              <th style={{ ...S.th, width: 90 }}>Category</th>
              <th style={S.th}>Error</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={3} style={{ ...S.td, color: C.textDim, textAlign: "center" }}>
                  {loading ? "Loading..." : "No errors 🎉"}
                </td>
              </tr>
            ) : (
              filtered.map((entry) => (
                <tr key={entry.id}>
                  <td style={{ ...S.td, color: C.textDim, fontSize: 11 }}>
                    {formatDateTime(entry.createdAt)}
                  </td>
                  <td style={{ ...S.td, fontSize: 11 }}>
                    <span style={S.badge(C.error)}>{entry.category}</span>
                  </td>
                  <td style={{ ...S.td, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                    <span style={{ color: C.error }}>{entry.message}</span>
                    <ExpandableRow label="stack trace" content={entry.stack} />
                    <ExpandableRow label="metadata" content={entry.metadata} />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Main Logs Page
// ---------------------------------------------------------------------------

export default function Logs() {
  const [tab, setTab] = useState<Tab>("live");

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "calc(100vh - 48px)",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 4,
        }}
      >
        <h2 style={{ ...S.h2, marginBottom: 0 }}>Logs</h2>
      </div>

      <TabBar active={tab} onChange={setTab} />

      {tab === "live" && <LiveTab />}
      {tab === "app" && <AppLogsTab />}
      {tab === "errors" && <ErrorsTab />}
    </div>
  );
}
