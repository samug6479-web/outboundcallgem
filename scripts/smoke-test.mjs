// Verifica automatica del sito pubblicato (nessun login, nessuna chiamata).
// Uso: BASE_URL=https://outboundcallgem.vercel.app node scripts/smoke-test.mjs
// Esce con codice 1 se un controllo fallisce.
const BASE = (process.env.BASE_URL || "https://outboundcallgem.vercel.app").replace(/\/$/, "");
const headers = process.env.VERCEL_BYPASS ? { "x-vercel-protection-bypass": process.env.VERCEL_BYPASS } : {};

const risultati = [];
async function controlla(nome, fn) {
  try {
    await fn();
    risultati.push({ nome, ok: true });
  } catch (err) {
    risultati.push({ nome, ok: false, errore: err.message });
  }
}
async function get(path, init = {}) {
  return fetch(BASE + path, { redirect: "manual", ...init, headers: { ...headers, ...(init.headers || {}) }, signal: AbortSignal.timeout(20000) });
}
function atteso(cond, msg) { if (!cond) throw new Error(msg); }

await controlla("Pagina principale", async () => {
  const r = await get("/");
  atteso(r.status === 200, `stato ${r.status}`);
  const html = await r.text();
  atteso(html.includes('id="root"'), "manca il contenitore dell'app");
  const js = html.match(/src="(\/assets\/[^"]+\.js)"/)?.[1];
  atteso(js, "manca lo script dell'app");
  const rj = await get(js);
  atteso(rj.status === 200, `script dell'app: stato ${rj.status}`);
});

await controlla("Server (API)", async () => {
  const r = await get("/api/health");
  atteso(r.status === 200, `stato ${r.status}`);
  atteso((await r.json()).status === "ok", "risposta inattesa");
});

await controlla("Database", async () => {
  const r = await get("/api/health?db=1");
  const j = await r.json().catch(() => ({}));
  atteso(r.status === 200 && j.db === "ok", `database: ${j.db || "stato " + r.status}`);
});

await controlla("Guida PDF", async () => {
  const r = await get("/guida-gem-outbound.pdf");
  atteso(r.status === 200, `stato ${r.status}`);
  atteso((r.headers.get("content-type") || "").includes("pdf"), "non è un PDF");
});

await controlla("Logo nelle email", async () => {
  const r = await get("/gem-logo-color.png");
  atteso(r.status === 200, `stato ${r.status}`);
});

// Le pagine riservate devono chiedere il login.
for (const [path, metodo] of [["/api/config", "GET"], ["/api/history", "GET"], ["/api/lists", "GET"], ["/api/live", "GET"], ["/api/call-results", "GET"], ["/api/campaigns/launch", "POST"]]) {
  await controlla(`Protetto senza login: ${metodo} ${path}`, async () => {
    const r = await get(path, { method: metodo, headers: { "Content-Type": "application/json" }, body: metodo === "POST" ? "{}" : undefined });
    atteso(r.status === 401, `stato ${r.status} invece di 401`);
  });
}

// I webhook devono rifiutare chi non ha il segreto.
for (const path of ["/api/cron/tick", "/api/live/make-event"]) {
  await controlla(`Protetto senza segreto: POST ${path}`, async () => {
    const r = await get(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    atteso(r.status === 401, `stato ${r.status} invece di 401`);
  });
}

await controlla("Login con credenziali sbagliate rifiutato", async () => {
  const r = await get("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "verifica-automatica", password: "x" }) });
  const j = await r.json().catch(() => ({}));
  atteso(r.status >= 400 && r.status < 500 && j.ok === false, `stato ${r.status}`);
});

const falliti = risultati.filter(r => !r.ok);
console.log(`Verifica di ${BASE}\n`);
for (const r of risultati) console.log(`${r.ok ? "OK  " : "ERRORE"}  ${r.nome}${r.ok ? "" : " — " + r.errore}`);
console.log(`\n${risultati.length - falliti.length}/${risultati.length} controlli superati.`);
if (process.env.GITHUB_STEP_SUMMARY) {
  const fs = await import("fs");
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `## Verifica del sito\n\n${BASE}\n\n| Controllo | Esito |\n| --- | --- |\n` +
    risultati.map(r => `| ${r.nome} | ${r.ok ? "OK" : "ERRORE: " + r.errore} |`).join("\n") + "\n");
}
process.exit(falliti.length ? 1 : 0);
