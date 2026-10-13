// All settings come from environment variables (see .env.example).

function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`חסר משתנה סביבה: ${name} (ראו .env.example)`);
    process.exit(1);
  }
  return value;
}

function list(name, fallback) {
  return (process.env[name] || fallback)
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

const num = (name, fallback) => Number(process.env[name] || fallback);
const bool = (name, fallback) => (process.env[name] ?? String(fallback)) === 'true';

export const config = {
  email: required('EMAIL_ADDRESS'),
  password: required('EMAIL_PASSWORD'),

  imap: {
    host: process.env.IMAP_HOST || 'imap.gmail.com',
    port: num('IMAP_PORT', 993),
    secure: bool('IMAP_SECURE', true),
  },
  smtp: {
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: num('SMTP_PORT', 465),
    secure: bool('SMTP_SECURE', true),
  },

  // Optional: send replies over HTTPS through deploy/gmail-send-relay.gs instead of SMTP
  // (for hosts that block SMTP ports, like Railway).
  sendScriptUrl: process.env.SEND_SCRIPT_URL || '',
  sendScriptSecret: process.env.SEND_SCRIPT_SECRET || '',

  // Which links are handled: "*" = any public website (default), or a list of domains
  // (subdomains included), e.g. "leonardo.ai,freepik.com".
  allowedDomains: list('ALLOWED_DOMAINS', '*'),

  // Shared AI chats: every image / video in the conversation is sent, not just one.
  chatShareHosts: list(
    'CHAT_SHARE_HOSTS',
    'chatgpt.com,chat.openai.com,gemini.google.com,g.co,bard.google.com,claude.ai,copilot.microsoft.com,' +
      'grok.com,perplexity.ai,chat.deepseek.com,meta.ai,poe.com,chat.mistral.ai',
  ),
  maxFilesPerLink: num('MAX_FILES_PER_LINK', 10),

  // Gmail allows 25MB per email including encoding overhead, so ~18MB of actual files.
  // Bigger files are sent as a download link instead of an attachment.
  maxFileBytes: num('MAX_FILE_MB', 18) * 1024 * 1024,
  maxTotalBytes: num('MAX_TOTAL_MB', 18) * 1024 * 1024,
  maxLinksPerEmail: num('MAX_LINKS_PER_EMAIL', 10),
  maxEmailsPerSenderPerHour: num('MAX_EMAILS_PER_SENDER_PER_HOUR', 30),
  fetchTimeoutMs: num('FETCH_TIMEOUT_SECONDS', 20) * 1000,
  // If installed, use a headless browser for pages that only render with JavaScript.
  useBrowserFallback: bool('USE_BROWSER_FALLBACK', true),
  // Safety net in case the IMAP IDLE push notification is missed.
  pollIntervalMs: num('POLL_INTERVAL_SECONDS', 60) * 1000,
};

config.anySite = config.allowedDomains.includes('*');
