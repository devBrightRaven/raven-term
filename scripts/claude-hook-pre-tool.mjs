// raven-term PreToolUse hook — cross-platform (Node.js)
const body = JSON.stringify({
  event: "PreToolUse",
  toolName: process.env.CLAUDE_TOOL_NAME,
  sessionId: process.env.CLAUDE_SESSION_ID,
  agentId: "main",
});

try {
  await fetch("http://127.0.0.1:27182/hook", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    signal: AbortSignal.timeout(1000),
  });
} catch {}
