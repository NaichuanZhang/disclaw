import React, { useState, useEffect } from "react";
import Status from "./pages/Status";
import Sessions from "./pages/Sessions";
import Channels from "./pages/Channels";
import Config from "./pages/Config";
import Cron from "./pages/Cron";
import Skills from "./pages/Skills";
import Logs from "./pages/Logs";
import Evolution from "./pages/Evolution";

// Re-export shared utilities so existing imports from "../App" still work
export { apiFetch, relativeTime, formatDuration, C, S } from "./shared";
import { C } from "./shared";

// ── Pages map ────────────────────────────────────────────────────────

const pages: Record<string, { label: string; component: React.FC }> = {
  status: { label: "Status", component: Status },
  sessions: { label: "Sessions", component: Sessions },
  channels: { label: "Channels", component: Channels },
  config: { label: "Config", component: Config },
  cron: { label: "Cron", component: Cron },
  skills: { label: "Skills", component: Skills },
  evolution: { label: "Evolution", component: Evolution },
  logs: { label: "Logs", component: Logs },
};

function getHash(): string {
  const h = window.location.hash.replace("#", "").toLowerCase();
  return h && pages[h] ? h : "status";
}

// ── App ──────────────────────────────────────────────────────────────

export default function App() {
  const [page, setPage] = useState(getHash);

  useEffect(() => {
    const onHash = () => setPage(getHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const PageComponent = pages[page].component;

  return (
    <div style={{ display: "flex", minHeight: "100vh" }}>
      {/* Sidebar */}
      <nav
        style={{
          width: 200,
          minWidth: 200,
          background: C.surface,
          borderRight: `1px solid ${C.border}`,
          display: "flex",
          flexDirection: "column",
          padding: "16px 0",
        }}
      >
        <div
          style={{
            padding: "0 16px 16px",
            borderBottom: `1px solid ${C.border}`,
            marginBottom: 8,
          }}
        >
          <div
            style={{
              fontSize: 16,
              fontWeight: 700,
              letterSpacing: "0.5px",
              marginBottom: 12,
              color: C.text,
            }}
          >
            discordclaw
          </div>
        </div>

        {Object.entries(pages).map(([key, { label }]) => (
          <a
            key={key}
            href={`#${key}`}
            style={{
              display: "block",
              padding: "8px 16px",
              color: page === key ? C.text : C.textDim,
              textDecoration: "none",
              fontSize: 14,
              background: page === key ? C.primary + "44" : "transparent",
              borderLeft:
                page === key
                  ? `3px solid ${C.accent}`
                  : "3px solid transparent",
              transition: "all 0.15s",
            }}
          >
            {label}
          </a>
        ))}
      </nav>

      {/* Main content */}
      <main
        style={{
          flex: 1,
          padding: 24,
          overflowY: "auto",
          maxHeight: "100vh",
        }}
      >
        <PageComponent />
      </main>
    </div>
  );
}
