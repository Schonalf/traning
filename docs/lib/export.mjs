const SECRET_KEYS = ["token", "authorization", "password", "pat", "secret", "access_token"];

function scrub(value) {
  if (Array.isArray(value)) return value.map(scrub);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_KEYS.includes(key.toLowerCase())) continue;
    out[key] = scrub(item);
  }
  return out;
}

export function buildBackup({ plan, sessions, events }) {
  return scrub({
    exportedAt: new Date().toISOString(),
    note: "Token-fri säkerhetskopia. Innehåller träningslogg från den här webbläsaren.",
    plan: plan || null,
    sessions: sessions || [],
    events: events || [],
  });
}
