// Keeps the last log lines in memory, so the owner can read them on the website (/logs?key=LOGS_KEY)
// where the host has no log viewer. Only when LOGS_KEY is set.

const MAX_LINES = 500;
const lines = [];

for (const level of ['log', 'warn', 'error']) {
  const original = console[level].bind(console);
  console[level] = (...args) => {
    original(...args);
    const text = args.map((a) => (typeof a === 'string' ? a : a instanceof Error ? a.stack : JSON.stringify(a))).join(' ');
    lines.push(text.length > 2000 ? `${text.slice(0, 2000)}…` : text);
    if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
  };
}

export const recentLogs = () => lines.join('\n');
