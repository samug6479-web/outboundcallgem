import express from "express";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import nodemailer from "nodemailer";
import bcrypt from "bcryptjs";
import { generateSecret as generateTotpSecret, generateURI as generateTotpURI, verify as verifyTotp } from "otplib";
import QRCode from "qrcode";
import jwt from "jsonwebtoken";

// IMPORTANTE: disabilita il body-parsing automatico di Vercel.
// Senza questo, Vercel consuma lo stream della richiesta prima che
// express.raw() possa leggerlo, rendendo impossibile la verifica
// della firma HMAC del webhook Wildix (causa dei 401 ricevuti finora).
export const config = {
  api: {
    bodyParser: false,
  },
};

const app = express();

// ══════════════════════════════════════════════════════════════
// WILDIX WEBHOOK: risultati chiamate + trascrizioni
// IMPORTANTE: questa rotta va registrata PRIMA di app.use(express.json())
// perché la verifica della firma richiede il body grezzo (raw), non parsato.
// ══════════════════════════════════════════════════════════════

import { neon } from "@neondatabase/serverless";

// ── Retry con backoff per errori transitori di rete (fetch failed, ECONNRESET,
// socket chiuso, 502 da GitHub, ecc.) — sia verso Postgres (Neon) che verso
// l'API GitHub. Senza questo, un singolo blip di rete (comune su funzioni
// serverless "cold") fa fallire l'intera operazione anche se il servizio
// remoto è perfettamente sano un istante dopo.
async function withRetry<T>(fn: () => Promise<T>, attempts = 3, baseDelayMs = 250): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) {
        await new Promise(r => setTimeout(r, baseDelayMs * Math.pow(2, i)));
      }
    }
  }
  throw lastErr;
}

// Inizializzazione "difensiva": se DATABASE_URL manca o non è valida, neon()
// lancia subito un'eccezione. Senza il try/catch questo farebbe fallire il
// caricamento dell'intero modulo, portando giù anche le rotte che non
// dipendono da Postgres (login, utenti, voicebot su GitHub, ecc.).
// Le funzioni che usano sql() gestiscono già singolarmente gli errori delle
// query con try/catch, quindi qui basta evitare il crash in fase di boot.
let sql: ReturnType<typeof neon> | null = null;
try {
  sql = neon(process.env.DATABASE_URL!);
} catch (err) {
  console.error("DATABASE_URL non configurata o non valida — funzionalità Postgres (esiti chiamate, follow-up, statistiche) disabilitate:", err);
}

// ── Sessioni JWT ──────────────────────────────────────────────────────
// ATTENZIONE: questa logica era originariamente in lib/auth.ts, ma è stata
// spostata qui perché Vercel impacchetta api/index.ts come funzione
// serverless standalone e NON include file al di fuori della cartella
// /api (un import relativo tipo "../lib/auth" causa un crash in produzione
// con ERR_MODULE_NOT_FOUND, non riproducibile in locale con tsc/vite).
interface SessionPayload {
  username: string;
  isAdmin: boolean;
}

const JWT_SECRET = process.env.JWT_SECRET;
const IS_PRODUCTION = process.env.NODE_ENV === "production" || !!process.env.VERCEL;
if (!JWT_SECRET) {
  // In produzione un JWT firmato con un segreto noto/pubblico permetterebbe a
  // chiunque di forgiare una sessione admin. Meglio interrompere l'avvio con un
  // errore esplicito che degradare silenziosamente a un segreto insicuro.
  if (IS_PRODUCTION) {
    throw new Error(
      "JWT_SECRET non configurato in produzione. Imposta la variabile d'ambiente JWT_SECRET su Vercel prima del deploy."
    );
  }
  console.error(
    "JWT_SECRET non configurato — uso un segreto di fallback INSICURO (consentito solo in sviluppo locale)."
  );
}
const SESSION_SECRET = JWT_SECRET || "dev-only-insecure-secret-do-not-use-in-production";

function issueSessionToken(payload: SessionPayload): string {
  return jwt.sign(payload, SESSION_SECRET, { expiresIn: "12h" });
}

function verifySessionToken(token: string): SessionPayload | null {
  try {
    return jwt.verify(token, SESSION_SECRET) as SessionPayload;
  } catch {
    return null;
  }
}

function requireAuth(req: express.Request & { session?: SessionPayload }, res: express.Response, next: express.NextFunction) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ ok: false, error: "Autenticazione richiesta" });
  }
  const session = verifySessionToken(token);
  if (!session) {
    return res.status(401).json({ ok: false, error: "Sessione non valida o scaduta" });
  }
  req.session = session;
  next();
}

function requireAdmin(req: express.Request & { session?: SessionPayload }, res: express.Response, next: express.NextFunction) {
  if (!req.session?.isAdmin) {
    return res.status(403).json({ ok: false, error: "Permessi insufficienti (richiesto ruolo Admin)" });
  }
  next();
}

// ── Token temporaneo per il secondo passaggio del login (2FA) ─────────
// Viene rilasciato solo dopo username+password corretti e serve per
// chiamare /api/verify-otp. Senza, chiunque conoscesse uno username
// potrebbe tentare i codici a 6 cifre saltando la password.
function issueOtpToken(username: string): string {
  return jwt.sign({ username, purpose: "otp" }, SESSION_SECRET, { expiresIn: "10m" });
}

function verifyOtpToken(token: unknown, username: string): boolean {
  if (typeof token !== "string" || !token) return false;
  try {
    const p = jwt.verify(token, SESSION_SECRET) as any;
    return p?.purpose === "otp" && String(p.username).toLowerCase() === username.toLowerCase();
  } catch {
    return false;
  }
}

// ── Limite tentativi (login, OTP, supporto) ───────────────────────────
// Su serverless la memoria non è condivisa tra istanze, quindi i
// tentativi falliti si contano su Postgres. Se il database non è
// raggiungibile il controllo non blocca nessuno (meglio che impedire
// l'accesso a tutti).
let securitySchemaReady: Promise<void> | null = null;
function ensureSecuritySchema(): Promise<void> {
  if (!securitySchemaReady) {
    securitySchemaReady = (async () => {
      await sql!`
        CREATE TABLE IF NOT EXISTS auth_attempts (
          id  SERIAL PRIMARY KEY,
          key TEXT NOT NULL,
          ts  TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
      await sql!`CREATE INDEX IF NOT EXISTS idx_auth_attempts_key_ts ON auth_attempts (key, ts DESC)`;
    })().catch(err => {
      securitySchemaReady = null;
      throw err;
    });
  }
  return securitySchemaReady;
}

async function countAttempts(key: string, windowMinutes: number): Promise<number> {
  try {
    await ensureSecuritySchema();
    const rows = await sql!`
      SELECT COUNT(*)::int AS n FROM auth_attempts
      WHERE key = ${key} AND ts > now() - make_interval(mins => ${windowMinutes}::int)
    `;
    return (rows as any[])[0]?.n ?? 0;
  } catch (err) {
    console.error("Limite tentativi non disponibile (DB):", err);
    return 0;
  }
}

async function recordAttempt(key: string): Promise<void> {
  try {
    await ensureSecuritySchema();
    await sql!`INSERT INTO auth_attempts (key) VALUES (${key})`;
    // Pulizia leggera dei record vecchi
    if (Math.random() < 0.05) await sql!`DELETE FROM auth_attempts WHERE ts < now() - interval '1 day'`;
  } catch (err) {
    console.error("Impossibile registrare il tentativo (DB):", err);
  }
}

async function clearAttempts(key: string): Promise<void> {
  try {
    await ensureSecuritySchema();
    await sql!`DELETE FROM auth_attempts WHERE key = ${key}`;
  } catch (err) {
    console.error("Impossibile azzerare i tentativi (DB):", err);
  }
}

function clientIp(req: express.Request): string {
  const fwd = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return fwd || req.socket.remoteAddress || "unknown";
}

const LOGIN_MAX_PER_USER = 10; // tentativi falliti per utente in 15 minuti
const LOGIN_MAX_PER_IP = 30;   // tentativi falliti per IP in 15 minuti
const OTP_MAX_PER_USER = 5;    // codici OTP errati per utente in 15 minuti
const SUPPORT_MAX_PER_USER = 5; // ticket di supporto per utente all'ora
const TOO_MANY = "Troppi tentativi. Riprova tra qualche minuto.";

// ── Registro accessi: scritto dal server, non più dal browser ─────────
async function logAccess(username: string, nome: string | undefined, action: "login" | "logout") {
  try {
    await withRetry(() => sql!`
      INSERT INTO access_logs (username, nome, action)
      VALUES (${username}, ${nome || username}, ${action})
    `);
  } catch (err) {
    // Non bloccante: un log di accesso mancato non deve impedire login/logout.
    console.error("Error writing access_logs:", err);
  }
}

// ── Modalità test (dry-run) per il lancio campagne ────────────────────
// Le chiamate vere partono solo in produzione su Vercel. Negli ambienti
// di anteprima/test e in locale il lancio viene simulato: il server
// valida tutto ma NON inoltra a Make, quindi nessun numero viene chiamato.
// CALLS_DRY_RUN="true" forza la simulazione ovunque, "false" la disattiva.
function isCallsDryRun(): boolean {
  const flag = (process.env.CALLS_DRY_RUN || "").toLowerCase();
  if (flag === "true") return true;
  if (flag === "false") return false;
  return process.env.VERCEL_ENV !== "production";
}

async function readCallResults(limit = 50, offset = 0): Promise<{ rows: any[]; total: number }> {
  try {
    const rows = await sql`
      SELECT * FROM call_results ORDER BY ts DESC LIMIT ${limit} OFFSET ${offset}
    `;
    const countRes = await sql`SELECT COUNT(*)::int AS total FROM call_results`;
    return {
      rows: (rows as any[]).map((r: any) => ({
        callId: r.call_id,
        numero: r.numero,
        nome: r.nome,
        risposto: r.risposto,
        durata: r.durata,
        timestamp: r.ts,
        trascrizione: r.trascrizione,
        riassunto: r.riassunto,
      })),
      total: (countRes[0] as any).total,
    };
  } catch (err) {
    console.error("Error reading call_results from Postgres:", err);
    return { rows: [], total: 0 };
  }
}

async function upsertCallResult(entry: any) {
  try {
    await withRetry(() => sql`
      INSERT INTO call_results (call_id, numero, nome, risposto, durata, ts, trascrizione, riassunto)
      VALUES (${entry.callId}, ${entry.numero}, ${entry.nome || null}, ${entry.risposto}, ${entry.durata}, ${entry.timestamp}, ${entry.trascrizione}, ${entry.riassunto ? JSON.stringify(entry.riassunto) : null})
      ON CONFLICT (call_id) DO UPDATE SET
        numero = COALESCE(EXCLUDED.numero, call_results.numero),
        nome = COALESCE(EXCLUDED.nome, call_results.nome),
        risposto = COALESCE(EXCLUDED.risposto, call_results.risposto),
        durata = COALESCE(EXCLUDED.durata, call_results.durata),
        trascrizione = COALESCE(EXCLUDED.trascrizione, call_results.trascrizione),
        riassunto = COALESCE(EXCLUDED.riassunto, call_results.riassunto)
    `);
  } catch (err) {
    console.error("Error upserting call_results in Postgres (dopo retry):", err);
  }
}

// ── Password: hashing bcrypt con migrazione trasparente da testo in chiaro ──
// Gli utenti esistenti hanno la password salvata in chiaro in users.json.
// Invece di forzare un reset per tutti, verifichiamo prima se è già un hash
// bcrypt; se non lo è, confrontiamo in chiaro come prima e, se corretto,
// la ri-salviamo hashata — la migrazione avviene da sola al primo login.
function isBcryptHash(value: string): boolean {
  return /^\$2[aby]\$\d{2}\$/.test(value);
}

async function checkPassword(plain: string, stored: string): Promise<boolean> {
  if (isBcryptHash(stored)) {
    return bcrypt.compare(plain, stored);
  }
  return plain === stored; // legacy in chiaro
}

// ── 2FA: nuovo default per tutti gli utenti è "disattivato" (off), tranne
// per chi lo ha già configurato e attivato in passato prima che esistesse
// il flag esplicito twoFactorRequired: in quel caso preserviamo la scelta
// già fatta, invece di disattivarlo a sua insaputa. Se il flag è già stato
// impostato esplicitamente (true o false, es. da un Admin o dall'utente
// stesso tramite auto-attivazione), rispettiamo sempre quello.
function isTwoFactorRequired(user: any): boolean {
  if (typeof user.twoFactorRequired === "boolean") return user.twoFactorRequired;
  return user.twoFactorEnabled === true;
}

function verifyWildixSignature(rawBody: string, signature: string | undefined): boolean {
  if (!signature) return false;
  const secret = process.env.WILDIX_WEBHOOK_SECRET;
  if (!secret) {
    console.error("WILDIX_WEBHOOK_SECRET non configurato!");
    return false;
  }
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  try {
    const expectedBuf = Buffer.from(expected, "utf-8");
    const signatureBuf = Buffer.from(signature, "utf-8");
    if (expectedBuf.length !== signatureBuf.length) return false;
    return crypto.timingSafeEqual(expectedBuf, signatureBuf);
  } catch {
    return false;
  }
}

// Normalizza un numero in formato E.164-ish (solo cifre + prefisso +),
// per evitare mismatch tra "+393533266370", "3533266370", "393533266370", ecc.
function normalizePhone(numero: string | null | undefined): string | null {
  if (!numero) return null;
  const cleaned = numero.replace(/[^\d+]/g, "");
  if (!cleaned) return null;
  if (cleaned.startsWith("+")) return cleaned;
  if (cleaned.startsWith("00")) return "+" + cleaned.slice(2);
  if (cleaned.startsWith("39") && cleaned.length >= 11) return "+" + cleaned;
  if (cleaned.length === 10) return "+39" + cleaned; // numero italiano senza prefisso
  return cleaned;
}

// ── Nome contatto: lookup numero → nome, popolato dall'app al lancio campagna ──
async function readContactNames(): Promise<Record<string, string>> {
  try {
    const rows = await sql`SELECT numero, nome FROM contact_names`;
    const map: Record<string, string> = {};
    for (const r of rows as any[]) map[r.numero] = r.nome;
    return map;
  } catch (err) {
    console.error("Error reading contact_names from Postgres:", err);
    return {};
  }
}

// Versione "a blocchi": una sola query per tutta la lista (invece di una per
// contatto), con i doppioni rimossi prima dell'inserimento.
async function upsertContactNames(contacts: { numero: string; nome: string }[]) {
  const map = new Map<string, string>();
  for (const c of contacts) {
    const n = normalizePhone(c.numero);
    if (n && c.nome) map.set(n, String(c.nome).slice(0, 200));
  }
  if (map.size === 0) return;
  const numeri = [...map.keys()];
  const nomi = [...map.values()];
  try {
    await withRetry(() => sql!`
      INSERT INTO contact_names (numero, nome)
      SELECT * FROM unnest(${numeri}::text[], ${nomi}::text[])
      ON CONFLICT (numero) DO UPDATE SET nome = EXCLUDED.nome
    `);
  } catch (err) {
    console.error("Error upserting contact_names (batch) in Postgres:", err);
  }
}

// ── Log eventi webhook scartati (firma invalida, chiamate non-voicebot) ──
// Utile per debug senza dover rifrugare i log Vercel.
async function logWebhookEvent(eventType: string, reason: string) {
  try {
    await withRetry(() => sql`INSERT INTO webhook_log (event_type, reason) VALUES (${eventType}, ${reason})`);
  } catch (err) {
    console.error("Error writing webhook_log (dopo retry):", err);
  }
}

// ── Follow-up: appuntamenti che richiedono un intervento umano ──
// (disdetta, richiesta informazioni, trasferimento, non risposto)
// Non crea doppioni: Wildix può reinviare lo stesso evento, quindi lo stesso
// motivo per la stessa chiamata viene registrato una volta sola.
async function createFollowup(entry: { callId: string; numero: string | null; nome: string | null; motivo: string }) {
  try {
    await sql`
      INSERT INTO followups (call_id, numero, nome, motivo)
      SELECT ${entry.callId}, ${entry.numero}, ${entry.nome}, ${entry.motivo}
      WHERE NOT EXISTS (
        SELECT 1 FROM followups WHERE call_id = ${entry.callId} AND motivo = ${entry.motivo}
      )
    `;
  } catch (err) {
    console.error("Error creating followup:", err);
  }
}

// ── Follow-up automatici dall'esito della chiamata ──
// "Non risposto": nessuno ha risposto.
// "Chiamata interrotta": ha risposto ma la chiamata è durata meno di
// INTERRUPTED_CALL_MAX_MS (di solito il contatto ha attaccato subito).
// Ne resta aperto uno solo per numero e per motivo, così non si accumulano
// righe; quando lo stesso numero completa una chiamata più lunga, i due
// follow-up automatici si chiudono da soli.
const MOTIVO_NON_RISPOSTO = "Non risposto";
const MOTIVO_INTERROTTA = "Chiamata interrotta";
const INTERRUPTED_CALL_MAX_MS = 20_000; // talkTime di Wildix è in millisecondi

async function createAutoFollowup(entry: { callId: string; numero: string | null; nome: string | null; motivo: string }) {
  if (!entry.numero) return;
  try {
    await sql`
      INSERT INTO followups (call_id, numero, nome, motivo)
      SELECT ${entry.callId}, ${entry.numero}, ${entry.nome}, ${entry.motivo}
      WHERE NOT EXISTS (
        SELECT 1 FROM followups
        WHERE numero = ${entry.numero} AND motivo = ${entry.motivo} AND stato = 'pending'
      )
    `;
  } catch (err) {
    console.error("Error creating auto followup:", err);
  }
}

async function closeAutoFollowups(numero: string | null, motivi: string[]) {
  if (!numero || motivi.length === 0) return;
  try {
    await sql`
      UPDATE followups SET stato = 'done'
      WHERE numero = ${numero} AND motivo = ANY(${motivi}::text[]) AND stato = 'pending'
    `;
  } catch (err) {
    console.error("Error closing auto followups:", err);
  }
}

app.get("/api/followups", requireAuth, async (req, res) => {
  const stato = (req.query.stato as string) || "pending";
  try {
    const rows = await sql`
      SELECT * FROM followups WHERE stato = ${stato} ORDER BY created_at DESC LIMIT 200
    `;
    res.json({ ok: true, followups: rows });
  } catch (err) {
    console.error("Error reading followups:", err);
    res.status(500).json({ ok: false, followups: [] });
  }
});

app.post("/api/followups/:id/done", requireAuth, express.json(), async (req, res) => {
  try {
    await sql`UPDATE followups SET stato = 'done' WHERE id = ${parseInt(req.params.id)}`;
    res.json({ ok: true });
  } catch (err) {
    console.error("Error updating followup:", err);
    res.status(500).json({ ok: false });
  }
});

// ── Statistiche aggregate sui risultati del voicebot ──
app.get("/api/voicebot-stats", requireAuth, async (_req, res) => {
  try {
    const totals = await sql`
      SELECT
        COUNT(*)::int AS totale,
        COUNT(*) FILTER (WHERE risposto = true)::int AS risposte,
        COUNT(*) FILTER (WHERE risposto = false)::int AS non_risposte,
        AVG(durata) FILTER (WHERE durata > 0)::int AS durata_media_ms
      FROM call_results
    `;
    const perGiorno = await sql`
      SELECT DATE(ts) AS giorno, COUNT(*)::int AS totale
      FROM call_results
      WHERE ts > now() - interval '30 days'
      GROUP BY DATE(ts)
      ORDER BY giorno ASC
    `;
    res.json({ ok: true, totali: totals[0], perGiorno });
  } catch (err) {
    console.error("Error reading voicebot-stats:", err);
    res.status(500).json({ ok: false });
  }
});

// ── Statistiche per periodo ──
// days = 1 (oggi), 7, 30 o 90. Il periodo parte dalla mezzanotte (ora
// italiana) di days-1 giorni fa, così "oggi" e i grafici per giorno
// seguono il calendario italiano e non quello UTC.
app.get("/api/stats", requireAuth, async (req, res) => {
  const allowed = [1, 7, 30, 90];
  const days = allowed.includes(parseInt(req.query.days as string)) ? parseInt(req.query.days as string) : 30;
  if (!sql) return res.status(503).json({ ok: false, error: "Database non disponibile" });

  const empty = { totale: 0, risposte: 0, non_risposte: 0, durata_media_ms: null };
  const safe = async <T,>(fn: () => Promise<T>, fallback: T): Promise<T> => {
    try { return await fn(); } catch (err) { console.error("Errore statistiche:", err); return fallback; }
  };

  try {
    await ensureCampaignLogSchema().catch(() => {});
    await ensureScheduleSchema().catch(() => {});

    const from = (await sql`
      SELECT ((date_trunc('day', now() AT TIME ZONE 'Europe/Rome') - make_interval(days => ${days}::int - 1))
              AT TIME ZONE 'Europe/Rome') AS da
    `) as any[];
    const da = from[0].da;

    const [chiamate, perGiorno, followupAperti, campagne, perOperatore, pianificateInAttesa] = await Promise.all([
      safe(async () => ((await sql`
        SELECT COUNT(*)::int AS totale,
               COUNT(*) FILTER (WHERE risposto = true)::int AS risposte,
               COUNT(*) FILTER (WHERE risposto = false)::int AS non_risposte,
               AVG(durata) FILTER (WHERE durata > 0)::int AS durata_media_ms
        FROM call_results WHERE ts >= ${da}`) as any[])[0] || empty, empty),
      safe(async () => (await sql`
        SELECT to_char(DATE(ts AT TIME ZONE 'Europe/Rome'), 'YYYY-MM-DD') AS giorno,
               COUNT(*) FILTER (WHERE risposto = true)::int AS risposte,
               COUNT(*) FILTER (WHERE risposto = false)::int AS non_risposte
        FROM call_results WHERE ts >= ${da}
        GROUP BY 1 ORDER BY 1`) as any[], [] as any[]),
      safe(async () => (await sql`
        SELECT motivo, COUNT(*)::int AS totale FROM followups
        WHERE stato = 'pending' GROUP BY motivo ORDER BY totale DESC`) as any[], [] as any[]),
      safe(async () => ((await sql`
        SELECT COUNT(*)::int AS campagne,
               COALESCE(SUM(sent_count), 0)::int AS contatti,
               COUNT(*) FILTER (WHERE mode = 'immediate')::int AS immediate,
               COUNT(*) FILTER (WHERE mode = 'scheduled')::int AS pianificate
        FROM campaign_log WHERE created_at >= ${da} AND dry_run = false`) as any[])[0] || null, null),
      safe(async () => (await sql`
        SELECT COALESCE(operatore, username) AS operatore,
               COUNT(*)::int AS campagne,
               COALESCE(SUM(sent_count), 0)::int AS contatti
        FROM campaign_log WHERE created_at >= ${da} AND dry_run = false
        GROUP BY 1 ORDER BY contatti DESC`) as any[], [] as any[]),
      safe(async () => ((await sql`
        SELECT COUNT(*)::int AS n FROM scheduled_campaigns WHERE status = 'pending'`) as any[])[0]?.n ?? 0, 0),
    ]);

    const logStart = await safe(async () => ((await sql`SELECT MIN(created_at) AS inizio FROM campaign_log`) as any[])[0]?.inizio ?? null, null);

    res.json({
      ok: true,
      days,
      da,
      chiamate,
      perGiorno,
      followupAperti,
      campagne,
      perOperatore,
      pianificateInAttesa,
      registroCampagneDal: logStart,
    });
  } catch (err) {
    console.error("Errore /api/stats:", err);
    res.status(500).json({ ok: false, error: "Errore caricamento statistiche" });
  }
});

// Endpoint chiamato dal frontend al lancio di una campagna, per registrare
// l'associazione numero → nome contatto (serve ad arricchire i risultati
// del voicebot, dato che il webhook Wildix restituisce solo il numero).
app.post("/api/register-campaign-contacts", requireAuth, express.json({ limit: "5mb" }), async (req, res) => {
  const { contacts } = req.body as { contacts: { numero: string; nome: string }[] };
  if (!Array.isArray(contacts)) {
    return res.status(400).json({ ok: false, error: "contacts deve essere un array" });
  }
  if (contacts.length > MAX_CONTACTS_PER_LAUNCH) {
    return res.status(400).json({ ok: false, error: "Troppi contatti" });
  }
  await upsertContactNames(contacts);
  res.json({ ok: true, count: contacts.length });
});

app.post(
  "/api/wildix-webhook",
  express.raw({ type: "application/json" }), // body grezzo, necessario per la firma
  async (req, res) => {
    const rawBody = req.body.toString("utf-8");
    const signature = req.headers["x-signature"] as string | undefined;

    if (!verifyWildixSignature(rawBody, signature)) {
      console.warn("Wildix webhook: firma non valida, richiesta rifiutata");
      logWebhookEvent("unknown", "invalid-signature").catch(() => {});
      return res.status(401).json({ ok: false, error: "Invalid signature" });
    }

    let event: any;
    try {
      event = JSON.parse(rawBody);
    } catch {
      return res.status(400).json({ ok: false, error: "Invalid JSON" });
    }

    // ── FILTRO: interessano solo le chiamate gestite da un Voicebot ──
    // (campagne outbound / conferme appuntamento), non tutte le chiamate del PBX.
    function isVoicebotCall(ev: any): boolean {
      if (ev.type === "call:completed") {
        const flow = ev.data?.flows?.[0] || {};
        return flow.callee?.userDevice === "VOICEBOT" || flow.caller?.userDevice === "VOICEBOT";
      }
      if (ev.type === "call:transcription:completed" || ev.type === "call:summary:completed") {
        const call = ev.data?.call || {};
        return call.callee?.userDevice === "VOICEBOT" || call.caller?.userDevice === "VOICEBOT";
      }
      return false;
    }

    if (!isVoicebotCall(event)) {
      // Non è una chiamata del voicebot: la ignoriamo, ma rispondiamo comunque 200
      // per evitare che Wildix la re-invii inutilmente come se fosse fallita.
      logWebhookEvent(event.type, "not-voicebot").catch(() => {});
      return res.sendStatus(200);
    }

    // NOTA: con Postgres l'UPSERT gestisce da solo il merge dei campi già
    // presenti (COALESCE), quindi non serve più leggere tutto l'array e
    // cercare l'indice manualmente come si faceva con GitHub.
    try {
      const contactNames = await readContactNames();

      if (event.type === "call:completed") {
        const flow = event.data?.flows?.[0] || {};
        // remotePhone è il vero numero esterno per chiamate outbound reali;
        // callee.phone/destination possono essere un'estensione interna
        // (es. nei test diretti su un interno del voicebot).
        const numero = normalizePhone(flow.remotePhone || flow.callee?.phone || event.data?.destination || null);
        const risposto = (flow.talkTime || 0) > 0;
        const nome = numero ? contactNames[numero] || null : null;

        await upsertCallResult({
          callId: event.id,
          numero,
          nome,
          risposto,
          durata: flow.talkTime || 0,
          timestamp: new Date(event.time).toISOString(),
          trascrizione: null,
        });

        const durataMs = flow.talkTime || 0;
        await markLiveCallCompleted(numero, risposto, durataMs, event.id, rawBody);
        if (!risposto) {
          await createAutoFollowup({ callId: event.id, numero, nome, motivo: MOTIVO_NON_RISPOSTO });
        } else if (durataMs < INTERRUPTED_CALL_MAX_MS) {
          // Ha risposto, quindi l'eventuale "Non risposto" è superato
          await closeAutoFollowups(numero, [MOTIVO_NON_RISPOSTO]);
          await createAutoFollowup({ callId: event.id, numero, nome, motivo: MOTIVO_INTERROTTA });
        } else {
          await closeAutoFollowups(numero, [MOTIVO_NON_RISPOSTO, MOTIVO_INTERROTTA]);
        }
      }

      if (event.type === "call:transcription:completed") {
        const callId = event.id || event.data?.call?.id;
        const numero = normalizePhone(event.data?.call?.remotePhone || event.data?.call?.destination || null);

        // La trascrizione arriva come array di "chunks" (battute per parlante),
        // non come singolo campo transcription/summary.
        const chunks = event.data?.chunks || [];
        const trascrizione = chunks
          .map((c: any) => `[${c.time}] ${c.name}: ${c.text}`)
          .join("\n");

        await upsertCallResult({
          callId,
          numero,
          nome: numero ? contactNames[numero] || null : null,
          risposto: (event.data?.call?.talkTime || 0) > 0,
          durata: event.data?.call?.talkTime || null,
          timestamp: new Date().toISOString(),
          trascrizione,
        });
      }

      if (event.type === "call:summary:completed") {
        const callId = event.id || event.data?.call?.id;
        const numero = normalizePhone(event.data?.call?.remotePhone || event.data?.call?.destination || null);
        const nome = numero ? contactNames[numero] || null : null;
        const summary = event.data?.summary || {};

        const riassunto = {
          titolo: summary.title || null,
          testo: summary.brief || null,
          argomenti: summary.json?.topics || [],
          decisioni: summary.json?.decisions || [],
          problemi: summary.json?.issues || [],
        };

        await upsertCallResult({
          callId,
          numero,
          nome,
          risposto: (event.data?.call?.talkTime || 0) > 0,
          durata: event.data?.call?.talkTime || null,
          timestamp: new Date().toISOString(),
          trascrizione: null,
          riassunto,
        });

        // ── Follow-up: qualsiasi esito che richiede intervento umano ──
        const testoCompleto = [riassunto.testo, ...riassunto.decisioni, ...riassunto.problemi].join(" ").toLowerCase();
        let motivoFollowup: string | null = null;
        if (/non conferm|rifiut/.test(testoCompleto)) motivoFollowup = "Appuntamento rifiutato";
        else if (/disdett|riprogramm/.test(testoCompleto)) motivoFollowup = "Disdetta / da riprogrammare";
        else if (/informazio.*trasfer|trasfer.*informazio/.test(testoCompleto)) motivoFollowup = "Richiesta informazioni — trasferito";
        else if (/trasferit.*assist|assist.*trasferit/.test(testoCompleto)) motivoFollowup = "Paziente da assistere";
        else if (/loop/.test(testoCompleto)) motivoFollowup = "Conversazione in loop — trasferito";
        else if (/non trovat/.test(testoCompleto)) motivoFollowup = "Appuntamento non trovato";

        if (motivoFollowup) {
          await createFollowup({ callId, numero, nome, motivo: motivoFollowup });
        }
        // È arrivato un riassunto: forse una campagna aspettava solo questo.
        await controllaFineCampagne();

        // ── Notifica: qualsiasi esito che richiede un operatore ──
        if (motivoFollowup && process.env.SMTP_USER && process.env.NOTIFY_EMAIL) {
          try {
            const transporter = nodemailer.createTransport({
              host: process.env.SMTP_HOST || "smtp.gmail.com",
              port: parseInt(process.env.SMTP_PORT || "587"),
              secure: process.env.SMTP_SECURE === "true",
              auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
            });
            await transporter.sendMail({
              from: `"GEM Voicebot Alert" <${process.env.SMTP_USER}>`,
              to: process.env.NOTIFY_EMAIL,
              subject: `⚠️ ${motivoFollowup} — ${nome || numero || callId}`,
              html: `
                <h2>${motivoFollowup}</h2>
                <p><strong>Contatto:</strong> ${nome || '—'} (${numero || '—'})</p>
                <p><strong>Riassunto:</strong> ${riassunto.testo || '—'}</p>
                <p><strong>Decisione rilevata:</strong> ${riassunto.decisioni.join('; ') || '—'}</p>
                <p>Serve un follow-up manuale.</p>
              `,
            });
          } catch (err) {
            console.error("Errore invio notifica rifiuto:", err);
          }
        }
      }

      res.sendStatus(200);
    } catch (err) {
      console.error("Errore elaborazione evento Wildix webhook:", err);
      // Rispondiamo comunque 200: l'evento è stato ricevuto e verificato,
      // un 5xx farebbe scattare inutili retry da parte di Wildix.
      res.sendStatus(200);
    }
  }
);

app.get("/api/call-results", requireAuth, async (req, res) => {
  const limit = Math.min(parseInt((req.query.limit as string) || "50"), 200);
  const offset = parseInt((req.query.offset as string) || "0");
  const { rows, total } = await readCallResults(limit, offset);
  res.json({ ok: true, results: rows, total, limit, offset });
});

// ══════════════════════════════════════════════════════════════
// Da qui in poi: parsing JSON standard per tutte le altre rotte
// ══════════════════════════════════════════════════════════════
// Limite alzato per le liste contatti grandi inviate al lancio campagna.
app.use(express.json({ limit: "5mb" }));

const USERS_FILE = path.join(process.cwd(), "users.json");
const GITHUB_REPO = "info4assistance25-maker/outboundcallgem";
const GITHUB_FILE_PATH = "users.json";
const VOICEBOTS_FILE_PATH = "voicebots.json";
const VOICEBOTS_LOCAL = path.join(process.cwd(), "voicebots.json");

// Branch GitHub da cui leggere/scrivere users.json e voicebots.json.
// Vuoto = branch principale del repo (produzione). Negli ambienti di test
// va impostato su un branch dedicato (es. "test-data"), così le modifiche
// fatte in test non toccano gli utenti e i voicebot di produzione.
const GITHUB_DATA_BRANCH = (process.env.GITHUB_DATA_BRANCH || "").trim();

function githubContentsUrl(file: string): string {
  const base = `https://api.github.com/repos/${GITHUB_REPO}/contents/${file}`;
  return GITHUB_DATA_BRANCH ? `${base}?ref=${encodeURIComponent(GITHUB_DATA_BRANCH)}` : base;
}

// In un'anteprima Vercel senza branch dedicato, le scritture finirebbero sui
// dati di produzione: le blocchiamo.
function githubWritesBlocked(): boolean {
  return process.env.VERCEL_ENV === "preview" && !GITHUB_DATA_BRANCH;
}
const GITHUB_WRITE_BLOCKED_MSG =
  "Scrittura bloccata: ambiente di test senza GITHUB_DATA_BRANCH (eviterebbe di modificare i dati di produzione).";

async function readVoicebots() {
  const token = process.env.GITHUB_TOKEN;
  if (token) {
    try {
      const fileData = await withRetry(async () => {
        const getRes = await fetch(
          githubContentsUrl(VOICEBOTS_FILE_PATH),
          { headers: { Authorization: `token ${token}`, Accept: "application/vnd.github.v3+json", "User-Agent": "gem-app" } }
        );
        if (!getRes.ok) {
          console.error("GitHub GET voicebots error:", getRes.status);
          throw new Error(`GitHub GET voicebots failed with status ${getRes.status}`);
        }
        return getRes.json() as Promise<any>;
      });
      const content = Buffer.from(fileData.content, "base64").toString("utf-8");
      return JSON.parse(content);
    } catch (err) { console.error("Error reading voicebots from GitHub (dopo retry):", err); }
  }
  // Fallback: file locale (ambiente senza GITHUB_TOKEN, es. sviluppo locale)
  try {
    if (!fs.existsSync(VOICEBOTS_LOCAL)) return [];
    return JSON.parse(fs.readFileSync(VOICEBOTS_LOCAL, "utf-8"));
  } catch { return []; }
}

async function writeVoicebots(bots: any[]) {
  if (githubWritesBlocked()) {
    console.warn(GITHUB_WRITE_BLOCKED_MSG);
    throw new Error(GITHUB_WRITE_BLOCKED_MSG);
  }
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    try { fs.writeFileSync(VOICEBOTS_LOCAL, JSON.stringify(bots, null, 2)); } catch {}
    return;
  }
  try {
    await withRetry(async () => {
      const getRes = await fetch(
        githubContentsUrl(VOICEBOTS_FILE_PATH),
        { headers: { Authorization: `token ${token}`, Accept: "application/vnd.github.v3+json", "User-Agent": "gem-app" } }
      );
      const sha = getRes.ok ? (await getRes.json() as any).sha : undefined;
      const content = Buffer.from(JSON.stringify(bots, null, 2)).toString("base64");
      const putRes = await fetch(
        githubContentsUrl(VOICEBOTS_FILE_PATH),
        {
          method: "PUT",
          headers: { Authorization: `token ${token}`, Accept: "application/vnd.github.v3+json", "Content-Type": "application/json", "User-Agent": "gem-app" },
          body: JSON.stringify({ message: "chore: update voicebots", content, ...(sha ? { sha } : {}), ...(GITHUB_DATA_BRANCH ? { branch: GITHUB_DATA_BRANCH } : {}) })
        }
      );
      if (!putRes.ok) {
        const errText = await putRes.text();
        console.error("GitHub PUT voicebots error:", putRes.status, errText);
        throw new Error("GitHub write failed");
      }
    });
  } catch (err) { console.error("Error writing voicebots to GitHub (dopo retry):", err); throw err; }
}

async function readUsers() {
  const token = process.env.GITHUB_TOKEN;
  if (token) {
    try {
      const fileData = await withRetry(async () => {
        const getRes = await fetch(
          githubContentsUrl(GITHUB_FILE_PATH),
          { headers: { Authorization: `token ${token}`, Accept: "application/vnd.github.v3+json", "User-Agent": "gem-app" } }
        );
        if (!getRes.ok) {
          console.error("GitHub GET users error:", getRes.status);
          throw new Error(`GitHub GET users failed with status ${getRes.status}`);
        }
        return getRes.json() as Promise<any>;
      });
      const content = Buffer.from(fileData.content, "base64").toString("utf-8");
      return JSON.parse(content);
    } catch (err) {
      console.error("Error reading users from GitHub (dopo retry), uso fallback locale:", err);
    }
  }
  // Fallback: file locale bundlato nel deployment (può essere non aggiornato
  // rispetto a GitHub se manca GITHUB_TOKEN o se GitHub non è raggiungibile)
  try {
    if (!fs.existsSync(USERS_FILE)) return [];
    return JSON.parse(fs.readFileSync(USERS_FILE, "utf-8"));
  } catch (err) {
    console.error("Error reading users.json locale:", err);
    return [];
  }
}

async function writeUsers(users: any[]) {
  if (githubWritesBlocked()) {
    console.warn(GITHUB_WRITE_BLOCKED_MSG);
    return;
  }
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.error("GITHUB_TOKEN non configurato — impossibile salvare su GitHub");
    try { fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2)); } catch {}
    return;
  }
  try {
    // 1. Leggi SHA attuale
    const getRes = await fetch(
      githubContentsUrl(GITHUB_FILE_PATH),
      { headers: { Authorization: `token ${token}`, Accept: "application/vnd.github.v3+json", "User-Agent": "gem-app" } }
    );
    if (!getRes.ok) {
      const errText = await getRes.text();
      console.error("GitHub GET error:", getRes.status, errText);
      return;
    }
    const fileData = await getRes.json() as any;
    const sha = fileData.sha;

    // 2. Scrivi contenuto aggiornato
    const content = Buffer.from(JSON.stringify(users, null, 2)).toString("base64");
    const putRes = await fetch(
      githubContentsUrl(GITHUB_FILE_PATH),
      {
        method: "PUT",
        headers: {
          Authorization: `token ${token}`,
          Accept: "application/vnd.github.v3+json",
          "Content-Type": "application/json",
          "User-Agent": "gem-app"
        },
        body: JSON.stringify({ message: "chore: update users permissions", content, sha, ...(GITHUB_DATA_BRANCH ? { branch: GITHUB_DATA_BRANCH } : {}) })
      }
    );
    if (!putRes.ok) {
      const errText = await putRes.text();
      console.error("GitHub PUT error:", putRes.status, errText);
    } else {
      console.log("users.json aggiornato su GitHub con successo");
    }
  } catch (err) {
    console.error("Error writing users to GitHub:", err);
  }
}

// API
// ?db=1 controlla anche il database (usato dalla verifica automatica dopo il deploy).
app.get("/api/health", async (req, res) => {
  if (req.query.db !== "1") return res.json({ status: "ok" });
  let db = "assente";
  if (sql) {
    try { await sql`SELECT 1`; db = "ok"; } catch { db = "errore"; }
  }
  res.status(db === "ok" ? 200 : 503).json({ status: db === "ok" ? "ok" : "degradato", db });
});

app.post("/api/login", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ ok: false, error: "Username e password richiesti" });
  }

  const userKey = `login:user:${String(username).toLowerCase()}`;
  const ipKey = `login:ip:${clientIp(req)}`;
  const [userFails, ipFails] = await Promise.all([countAttempts(userKey, 15), countAttempts(ipKey, 15)]);
  if (userFails >= LOGIN_MAX_PER_USER || ipFails >= LOGIN_MAX_PER_IP) {
    return res.status(429).json({ ok: false, error: TOO_MANY });
  }

  const users = await readUsers();
  const idx = users.findIndex((u: any) => u.username.toLowerCase() === String(username).toLowerCase());
  const user = idx !== -1 ? users[idx] : null;

  if (!user || !(await checkPassword(password, user.password))) {
    await Promise.all([recordAttempt(userKey), recordAttempt(ipKey)]);
    return res.status(401).json({ ok: false, error: "Credenziali errate" });
  }
  await clearAttempts(userKey);

  // Migrazione trasparente: se la password era ancora in chiaro, la
  // sostituiamo subito con l'hash bcrypt corrispondente.
  if (!isBcryptHash(user.password)) {
    try {
      users[idx] = { ...user, password: await bcrypt.hash(password, 12) };
      await writeUsers(users);
    } catch (err) {
      console.error("Errore migrazione password a bcrypt (non bloccante):", err);
    }
  }

  // ── 2FA: gli admin possono disattivarlo per singolo utente (vedi rotta
  // PUT /api/users/:username/2fa). Se disattivato, si accede subito con
  // solo utente+password, come prima dell'introduzione del 2FA. ──
  if (!isTwoFactorRequired(user)) {
    const role = user.role || (user.isAdmin ? "Admin" : "Editor");
    const isAdmin = user.isAdmin === true || user.role === "Admin";
    const token = issueSessionToken({ username: user.username, isAdmin });
    await logAccess(user.username, user.nome, "login");
    return res.json({
      ok: true,
      token,
      username: user.username,
      nome: user.nome,
      role,
      isAdmin,
      canSchedule: user.canSchedule === true,
      email: user.email || "",
      telefono: user.telefono || "",
      twoFactorEnabled: false,
      twoFactorRequired: false,
    });
  }

  // ── 2FA: se l'utente non ha ancora un segreto TOTP, lo generiamo ora e
  // chiediamo di completare il setup scansionando il QR code. Se ha già un
  // segreto ma non ha ancora completato la verifica (setup in sospeso),
  // riusiamo LO STESSO segreto invece di generarne uno nuovo: altrimenti
  // ogni login ripetuto prima di inserire il primo codice OTP (doppio
  // click, refresh, retry di rete) invalida il QR appena scansionato,
  // perché l'app Authenticator continuerebbe a calcolare codici sul
  // segreto vecchio mentre il server ne aspetta uno nuovo — causa esatta
  // del "codice sempre errato" segnalato dagli utenti. Se ce l'ha già ed
  // è attivo, chiediamo semplicemente il codice a 6 cifre. ──
  if (!user.twoFactorEnabled) {
    const secret = user.twoFactorSecret || generateTotpSecret();
    if (!user.twoFactorSecret) {
      users[idx] = { ...users[idx], twoFactorSecret: secret, twoFactorEnabled: false };
      try {
        await writeUsers(users);
      } catch (err) {
        console.error("Errore salvataggio segreto 2FA:", err);
        return res.status(500).json({ ok: false, error: "Errore configurazione 2FA, riprova." });
      }
    }
    const otpauthUrl = generateTotpURI({ issuer: "GEM Outbound", label: user.username, secret });
    const qrUrl = await QRCode.toDataURL(otpauthUrl);
    return res.json({ ok: false, requires2FA: true, setup2FA: true, qrUrl, otpToken: issueOtpToken(user.username) });
  }

  return res.json({ ok: false, requires2FA: true, setup2FA: false, otpToken: issueOtpToken(user.username) });
});

app.post("/api/verify-otp", async (req, res) => {
  const { username, otp, otpToken } = req.body;
  if (!username || !otp) {
    return res.status(400).json({ ok: false, error: "Username e codice OTP richiesti" });
  }

  // Il codice OTP è accettato solo dopo aver superato il passaggio password.
  if (!verifyOtpToken(otpToken, String(username))) {
    return res.status(401).json({ ok: false, error: "Sessione di accesso scaduta. Effettua di nuovo il login." });
  }

  const otpKey = `otp:user:${String(username).toLowerCase()}`;
  if ((await countAttempts(otpKey, 15)) >= OTP_MAX_PER_USER) {
    return res.status(429).json({ ok: false, error: TOO_MANY });
  }

  const users = await readUsers();
  const idx = users.findIndex((u: any) => u.username.toLowerCase() === String(username).toLowerCase());
  const user = idx !== -1 ? users[idx] : null;

  if (!user || !user.twoFactorSecret) {
    return res.status(400).json({ ok: false, error: "2FA non configurato per questo utente. Effettua di nuovo il login." });
  }

  let valid = false;
  try {
    const result = await verifyTotp({ secret: user.twoFactorSecret, token: String(otp) });
    valid = result.valid === true;
  } catch (err) {
    console.error("Errore verifica OTP:", err);
  }

  if (!valid) {
    await recordAttempt(otpKey);
    return res.status(401).json({ ok: false, error: "Codice OTP non valido o scaduto" });
  }
  await clearAttempts(otpKey);

  // Al primo codice corretto, il 2FA passa da "in configurazione" ad "attivo"
  if (!user.twoFactorEnabled) {
    users[idx] = { ...user, twoFactorEnabled: true };
    try {
      await writeUsers(users);
    } catch (err) {
      console.error("Errore attivazione 2FA (non bloccante):", err);
    }
  }

  const role = user.role || (user.isAdmin ? "Admin" : "Editor");
  const isAdmin = user.isAdmin === true || user.role === "Admin";
  const token = issueSessionToken({ username: user.username, isAdmin });
  await logAccess(user.username, user.nome, "login");

  res.json({
    ok: true,
    token,
    username: user.username,
    nome: user.nome,
    role,
    isAdmin,
    canSchedule: user.canSchedule === true,
    email: user.email || "",
    telefono: user.telefono || "",
    twoFactorEnabled: true,
    twoFactorRequired: true,
  });
});

app.get("/api/users", requireAuth, requireAdmin, async (req, res) => {
  const users = await readUsers();
  // Password e segreto 2FA non vengono mai esposti al client.
  const safeUsers = users.map((u: any) => ({ 
    username: u.username, 
    nome: u.nome, 
    role: u.role || (u.isAdmin ? 'Admin' : 'Editor'),
    canSchedule: u.canSchedule === true,
    twoFactorEnabled: u.twoFactorEnabled === true,
    twoFactorRequired: isTwoFactorRequired(u),
  }));
  res.json(safeUsers);
});

app.post("/api/users", requireAuth, requireAdmin, async (req, res) => {
  const { username, password, nome, role, canSchedule } = req.body;
  
  if (!username || !password || !nome || !role) {
    return res.status(400).json({ error: "Dati mancanti" });
  }

  const users = await readUsers();
  if (users.find((u: any) => u.username.toLowerCase() === username.toLowerCase())) {
    return res.status(400).json({ error: "Username già esistente" });
  }

  const hashed = await bcrypt.hash(password, 12);
  users.push({ username, password: hashed, nome, role, isAdmin: role === 'Admin', canSchedule: canSchedule === true, twoFactorRequired: false, twoFactorEnabled: false });
  await writeUsers(users);

  res.json({ ok: true });
});

app.put("/api/users/:username", requireAuth, requireAdmin, async (req, res) => {
  const { username } = req.params;
  const { password, nome, role, canSchedule } = req.body;

  if (!nome || !role) {
    return res.status(400).json({ error: "Dati mancanti" });
  }

  let users = await readUsers();
  const index = users.findIndex((u: any) => u.username.toLowerCase() === username.toLowerCase());

  if (index === -1) {
    return res.status(404).json({ error: "Utente non trovato" });
  }

  // La password è opzionale in modifica: se lasciata vuota, manteniamo
  // quella esistente invece di richiedere di reinserirla ogni volta
  // (ora che non viene più restituita in chiaro dal GET /api/users).
  const newPassword = password && password.trim() ? await bcrypt.hash(password, 12) : users[index].password;

  users[index] = { 
    ...users[index], 
    password: newPassword, 
    nome, 
    role, 
    isAdmin: role === 'Admin',
    canSchedule: canSchedule === true
  };
  await writeUsers(users);
  
  res.json({ ok: true });
});

app.delete("/api/users/:username", requireAuth, requireAdmin, async (req, res) => {
  const { username } = req.params;
  
  let users = await readUsers();
  const initialLength = users.length;
  users = users.filter((u: any) => u.username.toLowerCase() !== username.toLowerCase());

  if (users.length === initialLength) {
    return res.status(404).json({ error: "Utente non trovato" });
  }

  await writeUsers(users);
  res.json({ ok: true });
});

// ── Attiva/disattiva il requisito 2FA per un utente ──
// Permessi: chiunque sia autenticato può ATTIVARE il proprio 2FA (azione
// che aumenta la sicurezza, nessun rischio). DISATTIVARLO — per sé o per
// altri — richiede invece il ruolo Admin, così come attivarlo per un
// account diverso dal proprio: abbassare la protezione di qualcuno non
// deve essere una scelta unilaterale dell'utente stesso.
// Se disattivato, l'utente accede subito con utente+password, senza OTP.
// Se attivato, al login successivo dovrà fare il setup da zero (nuovo QR):
// il vecchio segreto viene cancellato per evitare stati incoerenti tra ciò
// che l'app Authenticator dell'utente ha memorizzato e quello che il
// server si aspetta.
app.put("/api/users/:username/2fa", requireAuth, async (req: any, res) => {
  const { username } = req.params;
  const { enabled } = req.body;
  if (typeof enabled !== "boolean") {
    return res.status(400).json({ ok: false, error: "Campo 'enabled' booleano richiesto" });
  }

  const isSelf = req.session?.username?.toLowerCase() === username.toLowerCase();
  const isAdmin = req.session?.isAdmin === true;

  if (!isAdmin && !(enabled && isSelf)) {
    return res.status(403).json({
      ok: false,
      error: enabled
        ? "Puoi attivare il 2FA solo per il tuo account"
        : "Solo un Admin può disattivare il 2FA",
    });
  }

  const users = await readUsers();
  const idx = users.findIndex((u: any) => u.username.toLowerCase() === username.toLowerCase());
  if (idx === -1) return res.status(404).json({ ok: false, error: "Utente non trovato" });

  if (enabled) {
    // Attivazione: richiede un nuovo setup da zero al prossimo login.
    users[idx] = { ...users[idx], twoFactorRequired: true, twoFactorSecret: undefined, twoFactorEnabled: false };
  } else {
    users[idx] = { ...users[idx], twoFactorRequired: false };
  }

  await writeUsers(users);
  res.json({ ok: true });
});


app.post("/api/support", requireAuth, async (req: any, res) => {
  const { name, email, phone, company, subject, message } = req.body;
  if (!subject || !message || !email || !phone) {
    return res.status(400).json({ ok: false, error: "Dati mancanti (email, telefono, oggetto e messaggio sono obbligatori)" });
  }
  if ([name, email, phone, company, subject].some(v => v != null && String(v).length > 300) || String(message).length > 10000) {
    return res.status(400).json({ ok: false, error: "Testo troppo lungo" });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email))) {
    return res.status(400).json({ ok: false, error: "Email non valida" });
  }

  const supportKey = `support:user:${req.session.username.toLowerCase()}`;
  if ((await countAttempts(supportKey, 60)) >= SUPPORT_MAX_PER_USER) {
    return res.status(429).json({ ok: false, error: "Hai inviato troppe richieste. Riprova tra un'ora." });
  }
  await recordAttempt(supportKey);

  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    return res.status(500).json({ ok: false, error: "Credenziali SMTP non configurate." });
  }

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || "smtp.gmail.com",
    port: parseInt(process.env.SMTP_PORT || "587"),
    secure: process.env.SMTP_SECURE === "true",
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  const subjectLine = `[Supporto Campagne Out] ${String(name || "").replace(/[\r\n]/g, " ")} ${String(phone).replace(/[\r\n]/g, " ")}`;

  const html = `
    <p><strong>Da:</strong> ${escapeHtml(name)}</p>
    <p><strong>Utente app:</strong> ${escapeHtml(req.session.username)}</p>
    <p><strong>Email:</strong> ${escapeHtml(email)}</p>
    <p><strong>Telefono:</strong> ${escapeHtml(phone)}</p>
    ${company ? `<p><strong>Azienda:</strong> ${escapeHtml(company)}</p>` : ''}
    <p><strong>Oggetto:</strong> ${escapeHtml(subject)}</p>
    <hr>
    <p><strong>Messaggio:</strong></p>
    <p>${escapeHtml(message).replace(/\n/g, '<br>')}</p>
  `;

  try {
    await transporter.sendMail({
      from: `"GEM Campagne Out" <${process.env.SMTP_USER}>`,
      replyTo: email,
      to: "ticket@gemgroup.odoo.com",
      subject: subjectLine,
      text: `Da: ${name}\nEmail: ${email}\nTelefono: ${phone}\n${company ? `Azienda: ${company}\n` : ''}Oggetto: ${subject}\n\n${message}`,
      html,
    });
    res.json({ ok: true });
  } catch (error) {
    console.error("Errore invio email:", error);
    res.status(500).json({ ok: false, error: "Errore invio email. Verifica la configurazione SMTP." });
  }
});

// ── PROFILO UTENTE ──
app.get("/api/me", requireAuth, async (req: any, res) => {
  const { username } = req.query;
  if (!username) return res.status(400).json({ ok: false });
  if (req.session?.username?.toLowerCase() !== String(username).toLowerCase() && !req.session?.isAdmin) {
    return res.status(403).json({ ok: false, error: 'Non puoi vedere il profilo di un altro utente' });
  }
  const users = await readUsers();
  const user = users.find((u: any) => u.username.toLowerCase() === String(username).toLowerCase());
  if (!user) return res.status(404).json({ ok: false });
  res.json({
    ok: true,
    email: user.email || '',
    telefono: user.telefono || '',
    twoFactorEnabled: user.twoFactorEnabled === true,
    twoFactorRequired: isTwoFactorRequired(user),
  });
});

app.put("/api/me", requireAuth, async (req: any, res) => {
  const { username, email, telefono } = req.body;
  if (!username) return res.status(400).json({ ok: false, error: 'Username richiesto' });
  // Un utente può modificare solo il proprio profilo, salvo sia Admin
  if (req.session?.username?.toLowerCase() !== String(username).toLowerCase() && !req.session?.isAdmin) {
    return res.status(403).json({ ok: false, error: 'Non puoi modificare il profilo di un altro utente' });
  }
  const users = await readUsers();
  const idx = users.findIndex((u: any) => u.username.toLowerCase() === username.toLowerCase());
  if (idx === -1) return res.status(404).json({ ok: false, error: 'Utente non trovato' });
  users[idx].email = email || '';
  users[idx].telefono = telefono || '';
  await writeUsers(users);
  res.json({ ok: true });
});

// ── VOICEBOT ENDPOINTS ──
app.get("/api/voicebots", requireAuth, async (req: any, res) => {
  const bots = await readVoicebots();
  // Il webhook esiti lo vedono solo gli Admin: chi ha l'indirizzo può scrivere nello Sheets.
  res.json({ ok: true, voicebots: req.session?.isAdmin ? bots : bots.map(({ webhookEsiti, ...b }: any) => b) });
});

app.post("/api/voicebots", requireAuth, requireAdmin, async (req, res) => {
  const { nome, exten, context, descrizione, webhookEsiti } = req.body;
  if (!nome || !exten || !context) return res.status(400).json({ ok: false, error: "Nome, interno e contesto sono obbligatori" });
  if (webhookEsiti && !webhookEsitiValido(webhookEsiti)) return res.status(400).json({ ok: false, error: "Webhook esiti non valido: incolla l'indirizzo del webhook Make (https://hook...make.com/...)" });
  const bots = await readVoicebots();
  const id = `vb${Date.now()}`;
  bots.push({ id, nome, exten: parseInt(exten), context, descrizione: descrizione || "", attivo: true, webhookEsiti: webhookEsitiValido(webhookEsiti) || "" });
  try {
    await writeVoicebots(bots);
    res.json({ ok: true, id });
  } catch {
    res.status(500).json({ ok: false, error: "Errore salvataggio su GitHub" });
  }
});

app.put("/api/voicebots/:id", requireAuth, requireAdmin, async (req, res) => {
  const bots = await readVoicebots();
  const idx = bots.findIndex((b: any) => b.id === req.params.id);
  if (idx === -1) return res.status(404).json({ ok: false, error: "Voicebot non trovato" });
  if (req.body?.webhookEsiti && !webhookEsitiValido(req.body.webhookEsiti)) {
    return res.status(400).json({ ok: false, error: "Webhook esiti non valido: incolla l'indirizzo del webhook Make (https://hook...make.com/...)" });
  }
  bots[idx] = { ...bots[idx], ...req.body, id: req.params.id };
  if ("webhookEsiti" in (req.body || {})) bots[idx].webhookEsiti = webhookEsitiValido(req.body.webhookEsiti) || "";
  try {
    await writeVoicebots(bots);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ ok: false, error: "Errore salvataggio su GitHub" });
  }
});

app.delete("/api/voicebots/:id", requireAuth, requireAdmin, async (req, res) => {
  const bots = (await readVoicebots()).filter((b: any) => b.id !== req.params.id);
  try {
    await writeVoicebots(bots);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ ok: false, error: "Errore eliminazione su GitHub" });
  }
});

// ── ACCESS LOGS ──
// Persistiti su Postgres (Neon): su serverless il filesystem è effimero e
// read-only fuori da /tmp, quindi la vecchia scrittura su access-logs.json
// perdeva i log a ogni cold start (o falliva del tutto in produzione).
// Lo schema atteso:
//   CREATE TABLE access_logs (
//     id SERIAL PRIMARY KEY,
//     ts TIMESTAMPTZ NOT NULL DEFAULT now(),
//     username TEXT NOT NULL,
//     nome TEXT,
//     action TEXT NOT NULL
//   );
// Il login viene registrato dal server dentro /api/login e /api/verify-otp.
// Dal browser arriva solo il logout, e l'utente è quello della sessione:
// nessuno può più scrivere voci a nome di altri.
app.post("/api/access-log", requireAuth, async (req: any, res) => {
  if (req.body?.action !== "logout") return res.status(400).json({ ok: false });
  const users = await readUsers();
  const user = users.find((u: any) => u.username.toLowerCase() === req.session.username.toLowerCase());
  await logAccess(req.session.username, user?.nome, "logout");
  res.json({ ok: true });
});

app.get("/api/access-logs", requireAuth, requireAdmin, async (_req, res) => {
  try {
    const logs = await sql`
      SELECT to_char(ts, 'YYYY-MM-DD"T"HH24:MI:SS.MSOF') AS ts, username, nome, action
      FROM access_logs ORDER BY ts DESC LIMIT 200
    `;
    res.json({ logs });
  } catch (err) {
    console.error("Error reading access_logs:", err);
    res.json({ logs: [] });
  }
});

// ── NOTIFICA EMAIL COMPLETAMENTO CAMPAGNA ──
// Escape dei valori inseriti nell'HTML dell'email, per evitare HTML injection
// (i campi arrivano dall'utente: operatore, note...).
function escapeHtml(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Prima era una rotta pubblica (/api/notify-campaign) che accettava qualsiasi
// destinatario: chiunque poteva usarla per inviare email dal nostro server.
// Ora la chiama solo il server, dopo un lancio campagna riuscito, e il
// destinatario è l'email a profilo dell'utente loggato.
async function sendCampaignEmail(opts: {
  operatore?: string; count: number; scheduledAt: string | null; note?: string; userEmail?: string; test?: boolean;
  voicebot?: string; tipoCampagna?: string;
}): Promise<void> {
  const { operatore, count, scheduledAt, note, userEmail, test, voicebot, tipoCampagna } = opts;
  if (!process.env.SMTP_USER) return;

  // Destinatario: l'email dell'utente che ha lanciato la campagna.
  // Fallback a NOTIFY_EMAIL se l'utente non ha un'email a profilo.
  const isValidEmail = typeof userEmail === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(userEmail);
  const to = isValidEmail ? userEmail : process.env.NOTIFY_EMAIL;
  if (!to) return;

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });

  // "martedì 21 ottobre, ore 14:41" (ora di Roma)
  const formatQuando = (d: Date) => {
    const giorno = d.toLocaleDateString('it-IT', { timeZone: 'Europe/Rome', weekday: 'long', day: 'numeric', month: 'long' });
    const ora = d.toLocaleTimeString('it-IT', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit' });
    return `${giorno}, ore ${ora}`;
  };
  const pianificata = !!scheduledAt && new Date(scheduledAt).getTime() > Date.now();
  const quando = formatQuando(pianificata ? new Date(scheduledAt!) : new Date());
  const nContatti = Number(count) || 0;
  const contattiLabel = `${nContatti} ${nContatti === 1 ? 'contatto' : 'contatti'}`;
  const tipoLabel = tipoCampagna === 'appuntamenti' ? 'Conferma appuntamenti' : 'Standard';
  const nome = escapeHtml(operatore || '');
  const appUrl = (process.env.APP_URL || 'https://outboundcallgem.vercel.app').replace(/\/$/, '');
  const titolo = pianificata ? 'Campagna pianificata' : 'Campagna avviata';
  const intro = pianificata
    ? `la campagna partirà da sola all'orario indicato. Puoi annullarla dalla dashboard fino alla partenza.`
    : `il voicebot sta chiamando i contatti. Puoi seguire ogni chiamata in diretta dal sito.`;
  // Il pulsante apre direttamente la pagina giusta (?tab=...)
  const ctaUrl = `${appUrl}/?tab=${pianificata ? 'campaign' : 'live'}`;
  const ctaLabel = pianificata ? 'Vedi le campagne pianificate' : 'Segui in diretta';

  // Valori in chiaro: l'escape HTML si fa solo quando si costruisce l'HTML.
  const dati: [string, string][] = [
    ['Contatti', contattiLabel],
    ...(voicebot ? [['Voicebot', voicebot] as [string, string]] : []),
    ['Tipo', tipoLabel],
    [pianificata ? 'Partenza' : 'Avviata', quando],
    ...(operatore ? [['Lanciata da', operatore] as [string, string]] : []),
  ];
  const datiRows = dati.map(([k, v], i) => {
    const border = i < dati.length - 1 ? 'border-bottom:1px solid #eef1f6;' : '';
    return `<tr><td style="padding:11px 0;${border}font-size:14px;color:#64748b;width:40%;">${k}</td>
      <td style="padding:11px 0;${border}font-size:14px;color:#0f172a;font-weight:600;text-align:right;">${escapeHtml(v)}</td></tr>`;
  }).join('');

  const step = (n: number, t: string, d: string) => `<tr>
      <td style="vertical-align:top;width:34px;padding:0 0 14px;"><div style="width:24px;height:24px;line-height:24px;border-radius:999px;background:#e0e7ff;color:#1e3dc8;font-size:12px;font-weight:700;text-align:center;">${n}</div></td>
      <td style="padding:2px 0 14px;font-size:14px;color:#475569;line-height:1.5;"><strong style="color:#0f172a;">${t}</strong> ${d}</td></tr>`;

  const stato = pianificata
    ? `<span style="display:inline-block;background:#fef3c7;color:#92400e;font-size:12px;font-weight:700;padding:5px 12px;border-radius:999px;">&#9679; Pianificata</span>`
    : `<span style="display:inline-block;background:#dcfce7;color:#166534;font-size:12px;font-weight:700;padding:5px 12px;border-radius:999px;">&#9679; In corso</span>`;

  const html = `
<div style="background:#eef1f6;padding:28px 12px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e2e8f0;">
  ${test ? `<tr><td style="background:#fef3c7;color:#92400e;font-size:13px;font-weight:600;text-align:center;padding:10px 24px;">Modalità test: nessuna chiamata reale è stata effettuata.</td></tr>` : ''}
  <tr><td style="padding:28px 40px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
    <td><img src="${appUrl}/gem-logo-color.png" width="96" alt="GEM Group" style="display:block;width:96px;height:auto;"></td>
    <td style="text-align:right;">${stato}</td></tr></table></td></tr>
  <tr><td style="padding:26px 40px 6px;font-size:24px;font-weight:700;color:#0f172a;letter-spacing:-0.3px;">${titolo}</td></tr>
  <tr><td style="padding:0 40px 20px;font-size:15px;color:#475569;line-height:1.6;">Ciao${nome ? ` ${nome}` : ''}, ${intro}</td></tr>
  <tr><td style="padding:0 40px 8px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border-radius:10px;"><tr><td style="padding:6px 20px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${datiRows}</table></td></tr></table></td></tr>
  ${note ? `<tr><td style="padding:12px 40px 0;"><div style="background:#f8fafc;border-left:3px solid #1e3dc8;padding:12px 16px;font-size:14px;color:#475569;line-height:1.5;"><strong style="color:#0f172a;">Note:</strong> ${escapeHtml(note)}</div></td></tr>` : ''}
  <tr><td style="padding:24px 40px 4px;font-size:13px;font-weight:700;color:#0f172a;text-transform:uppercase;letter-spacing:0.6px;">Cosa succede ora</td></tr>
  <tr><td style="padding:8px 40px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">
    ${pianificata
      ? step(1, "All'orario indicato", 'la campagna parte da sola, senza bisogno della tua presenza.')
      : step(1, 'In diretta', 'mostra la coda, le chiamate in corso e gli esiti, aggiornati ogni pochi secondi.')}
    ${pianificata
      ? step(2, 'In diretta', 'dalla partenza mostra la coda, le chiamate in corso e gli esiti.')
      : step(2, 'Esiti Chiamate', 'mostra esito, trascrizione e riassunto di ogni chiamata.')}
    ${step(3, 'Follow-up', 'raccoglie chi non ha risposto o va richiamato.')}
  </table></td></tr>
  <tr><td style="padding:12px 40px 34px;"><a href="${ctaUrl}" style="display:block;background:#1e3dc8;color:#ffffff;text-decoration:none;text-align:center;font-size:15px;font-weight:600;padding:14px 20px;border-radius:9px;">${ctaLabel}</a></td></tr>
  <tr><td style="padding:18px 40px;border-top:1px solid #eef1f6;font-size:12px;color:#94a3b8;line-height:1.6;">GEM Group &middot; Soluzioni di comunicazione e automazione AI su tecnologia Wildix<br>Email automatica inviata da GEM Outbound.</td></tr>
</table></div>`;

  // Versione solo testo: alcuni client la mostrano al posto dell'HTML e aiuta a non finire nello spam.
  const text = [
    ...(test ? ['MODALITÀ TEST: nessuna chiamata reale è stata effettuata.', ''] : []),
    `${titolo}`,
    '',
    `Ciao${operatore ? ` ${operatore}` : ''}, ${intro}`,
    '',
    ...dati.map(([k, v]) => `${k}: ${v}`),
    ...(note ? ['', `Note: ${note}`] : []),
    '',
    `${ctaLabel}: ${ctaUrl}`,
  ].join('\n');

  try {
    await transporter.sendMail({
      from: `"GEM Campagne Out" <${process.env.SMTP_USER}>`,
      to,
      subject: `${test ? '[TEST - nessuna chiamata reale] ' : ''}${titolo}: ${contattiLabel}${pianificata ? ` - ${quando}` : ''}`,
      text,
      html,
    });
  } catch (e) {
    console.error('Errore invio notifica campagna:', e);
  }
}

// ══════════════════════════════════════════════════════════════
// LANCIO CAMPAGNE
// Prima il browser chiamava direttamente i webhook Make, i cui URL erano
// quindi visibili a chiunque aprisse il sito (e utilizzabili per far partire
// chiamate a spese dell'azienda). Ora il browser chiama queste rotte, che
// richiedono il login, validano i dati e inoltrano a Make dal server.
// ══════════════════════════════════════════════════════════════
const MAKE_WEBHOOK_URL_DEFAULT =
  process.env.MAKE_WEBHOOK_URL || "https://hook.eu1.make.com/ac3icgiyh1nbvvh463w33qh58uenvfgo";
const MAKE_WEBHOOK_URL_APPUNTAMENTI =
  process.env.MAKE_WEBHOOK_URL_APPUNTAMENTI || "https://hook.eu1.make.com/9f7h1ebgktojphmiulyqte4ux7f3tjqv";
const MAX_CONTACTS_PER_LAUNCH = 5000;
const MAKE_PARALLEL_REQUESTS = 20;

interface LaunchContact {
  nome: string;
  numero: string;
  data_appuntamento?: string;
  ora_appuntamento?: string;
  prestazione?: string;
}

function cleanText(v: unknown, max = 200): string | undefined {
  if (v == null) return undefined;
  const t = String(v).trim().slice(0, max);
  return t || undefined;
}

// Valida e ripulisce i contatti ricevuti dal browser. Restituisce null se
// la lista non è valida (vuota, troppo lunga o con numeri non validi).
function parseLaunchContacts(raw: unknown, withAppointment: boolean): { contacts: LaunchContact[] } | { error: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { error: "Nessun contatto da chiamare" };
  if (raw.length > MAX_CONTACTS_PER_LAUNCH) return { error: `Massimo ${MAX_CONTACTS_PER_LAUNCH} contatti per lancio` };
  const contacts: LaunchContact[] = [];
  for (const c of raw as any[]) {
    const numero = String(c?.numero ?? "").replace(/[\s\-().]/g, "");
    if (!/^\+?\d{6,15}$/.test(numero)) return { error: `Numero non valido: ${String(c?.numero ?? "").slice(0, 30)}` };
    const contact: LaunchContact = { nome: cleanText(c?.nome) || numero, numero };
    if (withAppointment) {
      const d = cleanText(c?.data_appuntamento, 50);
      const o = cleanText(c?.ora_appuntamento, 50);
      const pr = cleanText(c?.prestazione);
      if (d) contact.data_appuntamento = d;
      if (o) contact.ora_appuntamento = o;
      if (pr) contact.prestazione = pr;
    }
    contacts.push(contact);
  }
  return { contacts };
}

async function postToMake(url: string, payload: unknown): Promise<boolean> {
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    // Segreto opzionale: in Make si può aggiungere un filtro che accetta
    // solo le richieste con questo header, così l'URL da solo non basta.
    if (process.env.MAKE_WEBHOOK_SECRET) headers["x-gem-secret"] = process.env.MAKE_WEBHOOK_SECRET;
    const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload) });
    if (!r.ok) console.error("Make webhook risponde", r.status);
    return r.ok;
  } catch (err) {
    console.error("Errore di rete verso Make:", err);
    return false;
  }
}

// Esegue i task con un numero massimo di richieste contemporanee.
async function runLimited<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const out: T[] = new Array(tasks.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (next < tasks.length) {
      const i = next++;
      out[i] = await tasks[i]();
    }
  });
  await Promise.all(workers);
  return out;
}

async function findSessionUser(username: string) {
  const users = await readUsers();
  return users.find((u: any) => u.username.toLowerCase() === username.toLowerCase()) || null;
}

interface CampaignSpec {
  contacts: LaunchContact[];
  campaignType: "standard" | "appuntamenti";
  bot: any | null;
  chunkSize: number;
  note?: string;
  operatore: string;
  scheduledAt: string | null;
  username?: string;
  scheduledId?: number | null;
}

// Invia una campagna a Make a blocchi. Usata sia per il lancio immediato sia
// per le campagne pianificate quando arriva il loro orario.
async function sendCampaignToMake(spec: CampaignSpec) {
  const chunks: LaunchContact[][] = [];
  for (let i = 0; i < spec.contacts.length; i += spec.chunkSize) chunks.push(spec.contacts.slice(i, i + spec.chunkSize));

  const webhookUrl = spec.campaignType === "appuntamenti" ? MAKE_WEBHOOK_URL_APPUNTAMENTI : MAKE_WEBHOOK_URL_DEFAULT;
  const avviatoIl = new Date().toISOString();
  const dryRun = isCallsDryRun();

  if (!dryRun && isCodaSito()) {
    const concurrency = Math.min(Math.max(spec.chunkSize || 1, 1), maxSimultanee());
    const payloadBase = {
      tipo_campagna: spec.campaignType,
      avviatoIl,
      scheduledAt: spec.scheduledAt,
      modalita: spec.scheduledAt ? "scheduled" : "immediate",
      operatore: spec.operatore,
      fonte: "gem-dashboard-react",
      note: spec.note,
      voicebot_nome: spec.bot?.nome,
      voicebot_exten: spec.bot?.exten || 8000,
      voicebot_context: spec.bot?.context || "outbound-voicebot",
    };
    const codaId = await createLiveCampaign(spec, { concurrency, webhookUrl, payloadBase });
    if (codaId && await recordQueuedCalls(codaId, spec.contacts)) {
      await upsertContactNames(spec.contacts);
      await pumpCampaign(codaId);
      // I contatti sono tutti in coda: chi non parte compare in "In diretta" come errore.
      return { dryRun, sentContacts: spec.contacts, failedContacts: [] as LaunchContact[], chunksOk: 1, chunksTotal: 1 };
    }
    // Database non disponibile: si usa l'invio classico.
  }

  // Campagna per la pagina "In diretta": Make rimanda indietro campagna_id
  // per ogni chiamata avviata o fallita. In modalità test non si registra.
  const liveId = dryRun ? null : await createLiveCampaign(spec);
  const payloads = chunks.map((chunk, idx) => ({
    contatti: chunk,
    tipo_campagna: spec.campaignType,
    totale: chunk.length,
    avviatoIl,
    scheduledAt: spec.scheduledAt,
    modalita: spec.scheduledAt ? "scheduled" : "immediate",
    operatore: spec.operatore,
    fonte: "gem-dashboard-react",
    note: spec.note,
    voicebot_nome: spec.bot?.nome,
    voicebot_exten: spec.bot?.exten || 8000,
    voicebot_context: spec.bot?.context || "outbound-voicebot",
    chunk: idx + 1,
    chunks_totali: chunks.length,
    campagna_id: liveId,
  }));

  let results: boolean[];
  if (dryRun) {
    console.log(`[DRY-RUN] Invio simulato: ${spec.contacts.length} contatti in ${chunks.length} blocchi, operatore ${spec.operatore}`);
    results = payloads.map(() => true);
  } else {
    results = await runLimited(payloads.map(p => () => postToMake(webhookUrl, p)), MAKE_PARALLEL_REQUESTS);
  }

  const sentContacts = chunks.filter((_, i) => results[i]).flat();
  const failedContacts = chunks.filter((_, i) => !results[i]).flat();
  // Numero → nome, per mostrare il nome reale negli Esiti Chiamate.
  // In modalità test non si scrive nel database.
  if (sentContacts.length > 0 && !dryRun) await upsertContactNames(sentContacts);
  if (liveId) {
    await recordLiveCalls(liveId, chunks, results);
    if (results.some(ok => !ok)) await inviaEsitiFalliti(liveId);
  }
  return { dryRun, sentContacts, failedContacts, chunksOk: results.filter(Boolean).length, chunksTotal: chunks.length };
}

// ══════════════════════════════════════════════════════════════
// REGISTRO CAMPAGNE (per le statistiche)
// Ogni invio a Make viene registrato qui, così le statistiche per operatore
// sono uguali su ogni dispositivo (prima stavano nel browser).
// ══════════════════════════════════════════════════════════════
let campaignLogReady: Promise<void> | null = null;
function ensureCampaignLogSchema(): Promise<void> {
  if (!campaignLogReady) {
    campaignLogReady = (async () => {
      await sql!`
        CREATE TABLE IF NOT EXISTS campaign_log (
          id             SERIAL PRIMARY KEY,
          created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
          username       TEXT        NOT NULL,
          operatore      TEXT,
          tipo_campagna  TEXT        NOT NULL,
          voicebot_nome  TEXT,
          mode           TEXT        NOT NULL,
          contacts_count INT         NOT NULL,
          sent_count     INT         NOT NULL,
          failed_count   INT         NOT NULL,
          scheduled_id   INT,
          dry_run        BOOLEAN     NOT NULL DEFAULT false
        )
      `;
      await sql!`CREATE INDEX IF NOT EXISTS idx_campaign_log_created ON campaign_log (created_at DESC)`;
    })().catch(err => {
      campaignLogReady = null;
      throw err;
    });
  }
  return campaignLogReady;
}

async function logCampaign(entry: {
  username: string; operatore?: string | null; tipoCampagna: string; voicebotNome?: string | null;
  mode: "immediate" | "scheduled"; contactsCount: number; sentCount: number; failedCount: number;
  scheduledId?: number | null; dryRun: boolean;
}) {
  if (!sql) return;
  try {
    await ensureCampaignLogSchema();
    await sql`
      INSERT INTO campaign_log
        (username, operatore, tipo_campagna, voicebot_nome, mode, contacts_count, sent_count, failed_count, scheduled_id, dry_run)
      VALUES
        (${entry.username}, ${entry.operatore || null}, ${entry.tipoCampagna}, ${entry.voicebotNome || null}, ${entry.mode},
         ${entry.contactsCount}, ${entry.sentCount}, ${entry.failedCount}, ${entry.scheduledId ?? null}, ${entry.dryRun}::boolean)
    `;
  } catch (err) {
    console.error("Errore scrittura campaign_log (non bloccante):", err);
  }
}

// ══════════════════════════════════════════════════════════════
// IN DIRETTA
// Stato di ogni chiamata lanciata dal sito, per la pagina "In diretta":
//   in_coda      → inviata a Make
//   avviata      → Wildix ha accettato la chiamata (Originate riuscito)
//   non_partita  → Wildix ha risposto all'Originate con un errore. L'Originate
//                  aspetta la risposta del cliente, quindi qui finiscono anche
//                  le chiamate rifiutate, occupate o senza risposta
//   errore       → Make non ha raggiunto Wildix, o l'invio a Make è fallito
//   risposta / interrotta / non_risposta → chiamata conclusa (webhook Wildix),
//                  che ha sempre l'ultima parola sugli stati precedenti
// Make avvisa il sito dopo ogni Originate (POST /api/live/make-event).
// ══════════════════════════════════════════════════════════════
const LIVE_STATI_APERTI = ["in_coda", "avviata"];
// Stati che il webhook Wildix di fine chiamata può ancora correggere.
const LIVE_STATI_CORREGGIBILI = ["in_coda", "avviata", "non_partita", "errore"];

let liveSchemaReady: Promise<void> | null = null;
function ensureLiveSchema(): Promise<void> {
  if (!liveSchemaReady) {
    liveSchemaReady = (async () => {
      await sql!`
        CREATE TABLE IF NOT EXISTS live_campaigns (
          id            SERIAL PRIMARY KEY,
          created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
          username      TEXT,
          operatore     TEXT,
          tipo_campagna TEXT        NOT NULL,
          voicebot_nome TEXT,
          totale        INT         NOT NULL,
          scheduled_id  INT
        )
      `;
      await sql!`ALTER TABLE live_campaigns ADD COLUMN IF NOT EXISTS voicebot_exten TEXT`;
      await sql!`ALTER TABLE live_campaigns ADD COLUMN IF NOT EXISTS webhook_esiti TEXT`;
      // Coda gestita dal sito (CAMPAIGN_QUEUE_MODE=sito): il sito tiene i contatti
      // e ne manda a Make al massimo "concurrency" alla volta.
      await sql!`ALTER TABLE live_campaigns ADD COLUMN IF NOT EXISTS modalita_coda BOOLEAN NOT NULL DEFAULT false`;
      await sql!`ALTER TABLE live_campaigns ADD COLUMN IF NOT EXISTS concurrency INT NOT NULL DEFAULT 1`;
      await sql!`ALTER TABLE live_campaigns ADD COLUMN IF NOT EXISTS webhook_url TEXT`;
      await sql!`ALTER TABLE live_campaigns ADD COLUMN IF NOT EXISTS payload_base JSONB`;
      // Email di fine campagna: quando è stata inviata. Le campagne già
      // esistenti al momento dell'aggiunta della colonna risultano "inviate",
      // così non partono email per campagne vecchie.
      await sql!`ALTER TABLE live_campaigns ADD COLUMN IF NOT EXISTS riepilogo_inviato_at TIMESTAMPTZ DEFAULT now()`;
      await sql!`ALTER TABLE live_campaigns ALTER COLUMN riepilogo_inviato_at DROP DEFAULT`;
      await sql!`
        CREATE TABLE IF NOT EXISTS live_calls (
          id          SERIAL PRIMARY KEY,
          campaign_id INT,
          numero      TEXT        NOT NULL,
          nome        TEXT,
          stato       TEXT        NOT NULL,
          errore      TEXT,
          call_id     TEXT,
          durata_ms   INT,
          queued_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
      await sql!`ALTER TABLE live_calls ADD COLUMN IF NOT EXISTS esito_inviato BOOLEAN NOT NULL DEFAULT false`;
      // Quando il contatto è stato passato a Make. Nell'invio classico coincide
      // con l'inserimento (default now()); nella coda del sito resta NULL finché
      // il contatto aspetta il suo turno.
      await sql!`ALTER TABLE live_calls ADD COLUMN IF NOT EXISTS inviata_at TIMESTAMPTZ DEFAULT now()`;
      await sql!`ALTER TABLE live_calls ADD COLUMN IF NOT EXISTS dati JSONB`;
      await sql!`CREATE INDEX IF NOT EXISTS idx_live_calls_coda ON live_calls (campaign_id, stato, inviata_at)`;
      await sql!`CREATE INDEX IF NOT EXISTS idx_live_calls_numero ON live_calls (numero, queued_at DESC)`;
      await sql!`CREATE INDEX IF NOT EXISTS idx_live_calls_campaign ON live_calls (campaign_id)`;
      await sql!`CREATE INDEX IF NOT EXISTS idx_live_calls_updated ON live_calls (updated_at DESC)`;
      await sql!`CREATE INDEX IF NOT EXISTS idx_live_campaigns_created ON live_campaigns (created_at DESC)`;
    })().catch(err => {
      liveSchemaReady = null;
      throw err;
    });
  }
  return liveSchemaReady;
}

async function createLiveCampaign(
  spec: CampaignSpec,
  coda?: { concurrency: number; webhookUrl: string; payloadBase: Record<string, unknown> },
): Promise<number | null> {
  if (!sql) return null;
  try {
    await ensureLiveSchema();
    const rows = (await sql`
      INSERT INTO live_campaigns (username, operatore, tipo_campagna, voicebot_nome, voicebot_exten, totale, scheduled_id, webhook_esiti,
                                  modalita_coda, concurrency, webhook_url, payload_base)
      VALUES (${spec.username || null}, ${spec.operatore || null}, ${spec.campaignType}, ${spec.bot?.nome || null},
              ${spec.bot?.exten != null ? String(spec.bot.exten) : null}, ${spec.contacts.length}, ${spec.scheduledId ?? null},
              ${webhookEsitiValido(spec.bot?.webhookEsiti)},
              ${!!coda}, ${coda?.concurrency ?? 1}, ${coda?.webhookUrl ?? null},
              ${coda ? JSON.stringify(coda.payloadBase) : null}::jsonb)
      RETURNING id
    `) as any[];
    return rows[0]?.id ?? null;
  } catch (err) {
    console.error("Errore creazione campagna in diretta (non bloccante):", err);
    return null;
  }
}

async function recordLiveCalls(campaignId: number, chunks: LaunchContact[][], results: boolean[]) {
  if (!sql) return;
  const numeri: string[] = [], nomi: string[] = [], stati: string[] = [], errori: (string | null)[] = [];
  chunks.forEach((chunk, i) => {
    for (const c of chunk) {
      numeri.push(normalizePhone(c.numero) || c.numero);
      nomi.push(c.nome || "");
      stati.push(results[i] ? "in_coda" : "errore");
      errori.push(results[i] ? null : "Invio a Make non riuscito");
    }
  });
  try {
    await sql`
      INSERT INTO live_calls (campaign_id, numero, nome, stato, errore)
      SELECT ${campaignId}, n, nm, st, er
      FROM unnest(${numeri}::text[], ${nomi}::text[], ${stati}::text[], ${errori}::text[]) AS t(n, nm, st, er)
    `;
  } catch (err) {
    console.error("Errore registrazione chiamate in diretta (non bloccante):", err);
  }
}

// ── Coda gestita dal sito (CAMPAIGN_QUEUE_MODE=sito) ──
// Lo scenario Make con la coda "sequenziale" fa una chiamata alla volta.
// In questa modalità invece il sito tiene la coda: manda a Make un contatto
// per esecuzione e al massimo N chiamate in corso per campagna. Quando una
// chiamata finisce (esito da Make o fine chiamata da Wildix) parte la
// successiva. Il timer (/api/cron/tick) fa ripartire le code rimaste ferme.
function isCodaSito(): boolean {
  return (process.env.CAMPAIGN_QUEUE_MODE || "").trim().toLowerCase() === "sito";
}
function maxSimultanee(): number {
  return Math.min(Math.max(parseInt(process.env.MAX_CHIAMATE_SIMULTANEE || "3", 10) || 3, 1), 10);
}
// Una chiamata passata a Make occupa un posto finché non ha un esito. Senza
// notizie entro questi tempi il posto si libera, così la coda non si blocca.
const CODA_ATTESA_MAKE_MIN = 10;
const CODA_DURATA_MAX_MIN = 20;

async function recordQueuedCalls(campaignId: number, contacts: LaunchContact[]): Promise<boolean> {
  if (!sql) return false;
  const numeri = contacts.map(c => normalizePhone(c.numero) || c.numero);
  const nomi = contacts.map(c => c.nome || "");
  const dati = contacts.map(c => JSON.stringify(c));
  try {
    await sql`
      INSERT INTO live_calls (campaign_id, numero, nome, stato, inviata_at, dati)
      SELECT ${campaignId}, n, nm, 'in_coda', NULL, d::jsonb
      FROM unnest(${numeri}::text[], ${nomi}::text[], ${dati}::text[]) WITH ORDINALITY AS t(n, nm, d, ord)
      ORDER BY ord
    `;
    return true;
  } catch (err) {
    console.error("Errore registrazione coda campagna:", err);
    return false;
  }
}

// Prende i prossimi contatti della coda, nei posti liberi. Il lock sulla
// campagna evita che due richieste insieme superino il limite.
async function claimNextCalls(campaignId: number): Promise<any[]> {
  const [, rows] = await (sql as any).transaction([
    sql!`SELECT pg_advisory_xact_lock(4711, ${campaignId}::int)`,
    sql!`
      UPDATE live_calls l SET inviata_at = now(), updated_at = now()
      FROM live_campaigns c
      WHERE c.id = ${campaignId} AND c.modalita_coda AND l.campaign_id = c.id
        AND l.id IN (
          SELECT id FROM live_calls
          WHERE campaign_id = ${campaignId} AND stato = 'in_coda' AND inviata_at IS NULL
          ORDER BY id
          LIMIT GREATEST(0,
            (SELECT concurrency FROM live_campaigns WHERE id = ${campaignId})
            - (SELECT count(*) FROM live_calls
               WHERE campaign_id = ${campaignId} AND inviata_at IS NOT NULL
                 AND ((stato = 'in_coda' AND inviata_at > now() - make_interval(mins => ${CODA_ATTESA_MAKE_MIN}::int))
                   OR (stato = 'avviata' AND updated_at > now() - make_interval(mins => ${CODA_DURATA_MAX_MIN}::int)))))
        )
      RETURNING l.id, l.dati, l.numero, l.nome, c.webhook_url, c.payload_base
    `,
  ], { isolationLevel: "ReadCommitted" });
  return rows as any[];
}

// Riempie i posti liberi della campagna. Restituisce quanti contatti ha passato a Make.
async function pumpCampaign(campaignId: number | null | undefined): Promise<number> {
  if (!sql || !campaignId) return 0;
  let inviati = 0;
  try {
    await ensureLiveSchema();
    for (let giro = 0; giro < 5; giro++) {
      const presi = await claimNextCalls(campaignId);
      if (presi.length === 0) break;
      const esiti = await Promise.all(presi.map(row => {
        const contatto = row.dati || { nome: row.nome || "", numero: row.numero };
        return postToMake(row.webhook_url, {
          ...(row.payload_base || {}),
          contatti: [contatto],
          totale: 1,
          chunk: 1,
          chunks_totali: 1,
          campagna_id: campaignId,
        });
      }));
      const falliti = presi.filter((_, i) => !esiti[i]).map(row => row.id);
      inviati += presi.length - falliti.length;
      if (falliti.length === 0) break;
      // Make non ha accettato: la chiamata va in errore e il posto passa al contatto dopo.
      await sql`
        UPDATE live_calls SET stato = 'errore', errore = 'Invio a Make non riuscito', updated_at = now()
        WHERE id = ANY(${falliti}::int[])
      `;
    }
    await inviaEsitiFalliti(campaignId);
  } catch (err) {
    console.error("Errore coda campagna", campaignId, err);
  }
  return inviati;
}

// Lavoro del timer sulle code: chiude le chiamate rimaste senza risposta da
// Make e fa ripartire le campagne con contatti in attesa.
async function pumpAllQueues(): Promise<{ campagne: number; inviati: number; scadute: number }> {
  if (!sql) return { campagne: 0, inviati: 0, scadute: 0 };
  await ensureLiveSchema();
  const scadute = (await sql`
    UPDATE live_calls l SET stato = 'errore', updated_at = now(),
      errore = ${`Nessuna conferma da Make entro ${CODA_ATTESA_MAKE_MIN} minuti`}
    FROM live_campaigns c
    WHERE c.id = l.campaign_id AND c.modalita_coda
      AND l.stato = 'in_coda' AND l.inviata_at IS NOT NULL
      AND l.inviata_at < now() - make_interval(mins => ${CODA_ATTESA_MAKE_MIN}::int)
      AND l.inviata_at > now() - interval '24 hours'
    RETURNING l.campaign_id
  `) as any[];
  const conCoda = (await sql`
    SELECT DISTINCT l.campaign_id FROM live_calls l JOIN live_campaigns c ON c.id = l.campaign_id
    WHERE c.modalita_coda AND l.stato = 'in_coda' AND l.inviata_at IS NULL AND l.queued_at > now() - interval '24 hours'
  `) as any[];
  const ids = [...new Set([...scadute.map(r => r.campaign_id), ...conCoda.map(r => r.campaign_id)])];
  let inviati = 0;
  for (const id of ids) inviati += await pumpCampaign(id);
  return { campagne: ids.length, inviati, scadute: scadute.length };
}

// ── Email di fine campagna ──
// Quando tutte le chiamate di una campagna hanno un esito, a chi l'ha
// lanciata arriva un'email con i numeri della campagna, l'esito e il
// riassunto di ogni chiamata e un CSV con tutto. I riassunti arrivano da
// Wildix qualche minuto dopo la fine della chiamata: si aspettano al massimo
// FINE_ATTESA_RIASSUNTI_MIN minuti. Una campagna ferma da più di
// FINE_MAX_INATTIVITA_MIN minuti riceve comunque l'email, con le chiamate
// rimaste senza esito.
const FINE_ATTESA_RIASSUNTI_MIN = 10;
const FINE_MAX_INATTIVITA_MIN = 60;

async function controllaFineCampagne(soloId?: number | null): Promise<void> {
  if (!sql || !process.env.SMTP_USER) return;
  try {
    await ensureLiveSchema();
    const pronte = (await sql`
      WITH stato AS (
        SELECT c.id,
          max(l.updated_at) AS ultimo,
          count(*) FILTER (WHERE l.stato IN ('in_coda', 'avviata')) AS aperte,
          count(*) FILTER (WHERE l.stato = 'risposta' AND NOT EXISTS (
            SELECT 1 FROM call_results r
            WHERE r.riassunto IS NOT NULL
              AND (r.call_id = l.call_id OR (r.numero = l.numero AND r.ts::timestamptz > c.created_at))
          )) AS senza_riassunto
        FROM live_campaigns c JOIN live_calls l ON l.campaign_id = c.id
        WHERE c.riepilogo_inviato_at IS NULL AND c.created_at > now() - interval '24 hours'
          AND (${soloId ?? null}::int IS NULL OR c.id = ${soloId ?? null}::int)
        GROUP BY c.id
      )
      SELECT id FROM stato
      WHERE (aperte = 0 AND (senza_riassunto = 0 OR ultimo < now() - make_interval(mins => ${FINE_ATTESA_RIASSUNTI_MIN}::int)))
         OR ultimo < now() - make_interval(mins => ${FINE_MAX_INATTIVITA_MIN}::int)
    `) as any[];
    for (const { id } of pronte) {
      // Una sola richiesta "prende" la campagna: l'email parte una volta sola.
      const presa = (await sql`
        UPDATE live_campaigns SET riepilogo_inviato_at = now()
        WHERE id = ${id} AND riepilogo_inviato_at IS NULL
        RETURNING *
      `) as any[];
      if (presa[0]) await inviaRiepilogoCampagna(presa[0]);
    }
  } catch (err) {
    console.error("Errore controllo fine campagne (non bloccante):", err);
  }
}

const ESITO_LABEL: Record<string, { label: string; bg: string; fg: string }> = {
  risposta: { label: "Risposto", bg: "#dcfce7", fg: "#166534" },
  interrotta: { label: "Interrotta", bg: "#fef3c7", fg: "#92400e" },
  non_risposta: { label: "Non risposto", bg: "#f1f5f9", fg: "#475569" },
  non_partita: { label: "Non partita", bg: "#ffedd5", fg: "#9a3412" },
  errore: { label: "Errore", bg: "#fee2e2", fg: "#991b1b" },
  in_coda: { label: "Senza esito", bg: "#f1f5f9", fg: "#64748b" },
  avviata: { label: "Senza esito", bg: "#f1f5f9", fg: "#64748b" },
};

async function inviaRiepilogoCampagna(c: any): Promise<void> {
  const righe = (await sql!`
    SELECT l.nome, l.numero, l.stato, l.errore, l.durata_ms,
      COALESCE(
        (SELECT r.riassunto FROM call_results r WHERE r.call_id = l.call_id AND r.riassunto IS NOT NULL LIMIT 1),
        CASE WHEN l.stato IN ('risposta', 'interrotta') THEN
          (SELECT r.riassunto FROM call_results r
           WHERE r.numero = l.numero AND r.riassunto IS NOT NULL AND r.ts::timestamptz > ${c.created_at}
           ORDER BY r.ts::timestamptz ASC LIMIT 1)
        END
      ) AS riassunto
    FROM live_calls l WHERE l.campaign_id = ${c.id} ORDER BY l.id
  `) as any[];
  if (righe.length === 0) return;

  const conta = (stati: string[]) => righe.filter(r => stati.includes(r.stato)).length;
  const tot = righe.length;
  const risposte = conta(["risposta"]);
  const interrotte = conta(["interrotta"]);
  const nonRisposte = conta(["non_risposta", "non_partita"]);
  const errori = conta(["errore"]);
  const senzaEsito = conta(["in_coda", "avviata"]);
  const durate = righe.filter(r => r.stato === "risposta" && r.durata_ms > 0).map(r => r.durata_ms / 1000);
  const durataMedia = durate.length ? Math.round(durate.reduce((a, b) => a + b, 0) / durate.length) : 0;
  const mmss = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, "0")}`;
  const testoRiassunto = (r: any) => {
    const j = typeof r.riassunto === "string" ? (() => { try { return JSON.parse(r.riassunto); } catch { return null; } })() : r.riassunto;
    return String(j?.testo || j?.titolo || "").trim();
  };

  const user = c.username ? await findSessionUser(c.username).catch(() => null) : null;
  const email = user?.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user.email) ? user.email : process.env.NOTIFY_EMAIL;
  if (!email) return;

  const appUrl = (process.env.APP_URL || "https://outboundcallgem.vercel.app").replace(/\/$/, "");
  const quando = (d: Date) => `${d.toLocaleDateString("it-IT", { timeZone: "Europe/Rome", weekday: "long", day: "numeric", month: "long" })}, ore ${d.toLocaleTimeString("it-IT", { timeZone: "Europe/Rome", hour: "2-digit", minute: "2-digit" })}`;
  const ferma = senzaEsito > 0;
  const titolo = ferma ? "Campagna ferma" : "Campagna conclusa";
  const intro = ferma
    ? `la campagna non ha più avanzamenti da oltre ${FINE_MAX_INATTIVITA_MIN} minuti: ${senzaEsito} ${senzaEsito === 1 ? "chiamata è rimasta" : "chiamate sono rimaste"} senza esito. Controlla la pagina In diretta.`
    : `tutte le chiamate hanno un esito. Ecco com'è andata.`;
  const nome = escapeHtml(c.operatore || "");
  const pct = (n: number) => (tot ? Math.round((n / tot) * 100) : 0);

  const kpi = (v: string | number, l: string, col: string) => `<td style="width:25%;text-align:center;padding:16px 4px;">
    <div style="font-size:24px;font-weight:700;color:${col};">${v}</div><div style="font-size:12px;color:#64748b;margin-top:2px;">${l}</div></td>`;
  const dati: [string, string][] = [
    ...(c.voicebot_nome ? [["Voicebot", c.voicebot_nome] as [string, string]] : []),
    ["Tipo", c.tipo_campagna === "appuntamenti" ? "Conferma appuntamenti" : "Standard"],
    ["Avviata", quando(new Date(c.created_at))],
    ...(durate.length ? [["Durata media risposte", mmss(durataMedia)] as [string, string]] : []),
    ...(errori ? [["Errori", String(errori)] as [string, string]] : []),
    ...(c.operatore ? [["Lanciata da", c.operatore] as [string, string]] : []),
  ];
  const datiRows = dati.map(([k, v], i) => {
    const b = i < dati.length - 1 ? "border-bottom:1px solid #eef1f6;" : "";
    return `<tr><td style="padding:10px 0;${b}font-size:14px;color:#64748b;width:45%;">${k}</td><td style="padding:10px 0;${b}font-size:14px;color:#0f172a;font-weight:600;text-align:right;">${escapeHtml(v)}</td></tr>`;
  }).join("");

  const MAX_RIGHE_EMAIL = 200;
  // Prima le risposte (con il riassunto), poi le altre.
  const ordine = ["risposta", "interrotta", "non_risposta", "non_partita", "errore", "avviata", "in_coda"];
  const ordinate = [...righe].sort((a, b) => ordine.indexOf(a.stato) - ordine.indexOf(b.stato));
  const callRows = ordinate.slice(0, MAX_RIGHE_EMAIL).map(r => {
    const e = ESITO_LABEL[r.stato] || ESITO_LABEL.in_coda;
    const riass = testoRiassunto(r);
    const extra = riass ? escapeHtml(riass.length > 320 ? riass.slice(0, 317) + "…" : riass)
      : r.stato === "non_partita" || r.stato === "errore" ? escapeHtml(r.errore || "") : "";
    return `<tr><td style="padding:12px 0;border-bottom:1px solid #eef1f6;vertical-align:top;">
      <div style="font-size:14px;font-weight:600;color:#0f172a;">${escapeHtml(r.nome || r.numero)}
        <span style="display:inline-block;margin-left:6px;background:${e.bg};color:${e.fg};font-size:11px;font-weight:700;padding:2px 8px;border-radius:999px;">${e.label}</span>
        ${r.stato === "risposta" && r.durata_ms ? `<span style="font-size:12px;color:#94a3b8;font-weight:400;margin-left:4px;">${mmss(r.durata_ms / 1000)}</span>` : ""}</div>
      <div style="font-size:12px;color:#94a3b8;margin-top:2px;">${escapeHtml(r.numero)}</div>
      ${extra ? `<div style="font-size:13px;color:#475569;line-height:1.5;margin-top:6px;">${extra}</div>` : ""}
    </td></tr>`;
  }).join("");

  const html = `
<div style="background:#eef1f6;padding:28px 12px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e2e8f0;">
  <tr><td style="padding:28px 40px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
    <td><img src="${appUrl}/gem-logo-color.png" width="96" alt="GEM Group" style="display:block;width:96px;height:auto;"></td>
    <td style="text-align:right;"><span style="display:inline-block;background:${ferma ? "#fef3c7" : "#e0e7ff"};color:${ferma ? "#92400e" : "#1e3dc8"};font-size:12px;font-weight:700;padding:5px 12px;border-radius:999px;">&#9679; ${ferma ? "Ferma" : "Conclusa"}</span></td></tr></table></td></tr>
  <tr><td style="padding:26px 40px 6px;font-size:24px;font-weight:700;color:#0f172a;letter-spacing:-0.3px;">${titolo}</td></tr>
  <tr><td style="padding:0 40px 18px;font-size:15px;color:#475569;line-height:1.6;">Ciao${nome ? ` ${nome}` : ""}, ${intro}</td></tr>
  <tr><td style="padding:0 40px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #eef1f6;border-radius:10px;"><tr>
    ${kpi(risposte, `risposte (${pct(risposte)}%)`, "#166534")}${kpi(nonRisposte, "non risposte", "#475569")}${kpi(interrotte, "interrotte", "#92400e")}${kpi(tot, "chiamate", "#0f172a")}
  </tr></table></td></tr>
  <tr><td style="padding:16px 40px 8px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border-radius:10px;"><tr><td style="padding:6px 20px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${datiRows}</table></td></tr></table></td></tr>
  <tr><td style="padding:22px 40px 4px;font-size:13px;font-weight:700;color:#0f172a;text-transform:uppercase;letter-spacing:0.6px;">Le chiamate</td></tr>
  <tr><td style="padding:0 40px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${callRows}</table></td></tr>
  ${righe.length > MAX_RIGHE_EMAIL ? `<tr><td style="padding:10px 40px 0;font-size:13px;color:#64748b;">Qui ci sono le prime ${MAX_RIGHE_EMAIL} chiamate: l'elenco completo è nel file allegato.</td></tr>` : ""}
  <tr><td style="padding:22px 40px 6px;"><a href="${appUrl}/?tab=callresults" style="display:block;background:#1e3dc8;color:#ffffff;text-decoration:none;text-align:center;font-size:15px;font-weight:600;padding:14px 20px;border-radius:9px;">Apri Esiti Chiamate</a></td></tr>
  <tr><td style="padding:0 40px 30px;text-align:center;"><a href="${appUrl}/?tab=followups" style="font-size:14px;color:#1e3dc8;text-decoration:none;font-weight:600;">Vedi chi richiamare in Follow-up</a></td></tr>
  <tr><td style="padding:18px 40px;border-top:1px solid #eef1f6;font-size:12px;color:#94a3b8;line-height:1.6;">In allegato il file con tutte le chiamate (si apre con Excel).<br>GEM Group &middot; Email automatica inviata da GEM Outbound.</td></tr>
</table></div>`;

  const text = [
    titolo, "",
    `Ciao${c.operatore ? ` ${c.operatore}` : ""}, ${intro}`, "",
    `Risposte: ${risposte} su ${tot} (${pct(risposte)}%)`,
    `Non risposte: ${nonRisposte}`, `Interrotte: ${interrotte}`,
    ...(errori ? [`Errori: ${errori}`] : []), ...(senzaEsito ? [`Senza esito: ${senzaEsito}`] : []),
    ...dati.filter(([k]) => k !== "Errori").map(([k, v]) => `${k}: ${v}`), "",
    ...ordinate.slice(0, MAX_RIGHE_EMAIL).map(r => `- ${r.nome || r.numero} (${r.numero}): ${(ESITO_LABEL[r.stato] || ESITO_LABEL.in_coda).label}${testoRiassunto(r) ? ` — ${testoRiassunto(r)}` : ""}`),
    "", `Esiti Chiamate: ${appUrl}/?tab=callresults`,
  ].join("\n");

  // CSV per Excel in italiano: punto e virgola e BOM UTF-8.
  const cella = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""').replace(/\r?\n/g, " ")}"`;
  const csv = "﻿" + [
    ["Nome", "Numero", "Esito", "Durata (secondi)", "Riassunto", "Dettaglio"].map(cella).join(";"),
    ...ordinate.map(r => [
      r.nome || "", r.numero, (ESITO_LABEL[r.stato] || ESITO_LABEL.in_coda).label,
      r.durata_ms ? Math.round(r.durata_ms / 1000) : "", testoRiassunto(r), r.errore || "",
    ].map(cella).join(";")),
  ].join("\r\n");
  const dataFile = new Date(c.created_at).toLocaleDateString("sv-SE", { timeZone: "Europe/Rome" });

  try {
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || "smtp.gmail.com",
      port: parseInt(process.env.SMTP_PORT || "587"),
      secure: process.env.SMTP_SECURE === "true",
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
    await transporter.sendMail({
      from: `"GEM Campagne Out" <${process.env.SMTP_USER}>`,
      to: email,
      subject: `${titolo}: ${risposte} ${risposte === 1 ? "risposta" : "risposte"} su ${tot} ${tot === 1 ? "chiamata" : "chiamate"}${c.voicebot_nome ? ` · ${c.voicebot_nome}` : ""}`,
      text,
      html,
      attachments: [{ filename: `campagna-${dataFile}-${c.id}.csv`, content: csv, contentType: "text/csv; charset=utf-8" }],
    });
  } catch (err) {
    console.error("Errore invio email di fine campagna:", err);
  }
}

// ── Esiti delle chiamate non riuscite verso lo Sheets del voicebot ──
// Il voicebot scrive l'esito con il suo tool (es. salva_lead) solo quando parla
// con il cliente. Le chiamate rifiutate, senza risposta o in errore non
// arrivano mai al bot: le invia il sito allo stesso webhook Make, se il
// voicebot ne ha uno configurato ("Webhook esiti" in Voicebot). Ogni chiamata
// viene inviata una sola volta (colonna esito_inviato).
const LIVE_STATI_FALLITI = ["non_partita", "non_risposta", "errore"];

function webhookEsitiValido(url: unknown): string | null {
  const u = String(url || "").trim();
  return /^https:\/\/hook\.[a-z0-9.-]+\.make\.com\/[A-Za-z0-9]+$/.test(u) ? u : null;
}

function esitoFallitoPerSheets(stato: string, errore: string | null) {
  if (stato === "errore") {
    return { esito: "ERRORE", riepilogo: `Chiamata non partita per un errore tecnico${errore ? `: ${errore}` : ""}.` };
  }
  if (stato === "non_risposta") {
    return { esito: "NON_RAGGIUNTO", riepilogo: "Il telefono ha squillato ma nessuno ha risposto." };
  }
  return {
    esito: "NON_RAGGIUNTO",
    riepilogo: errore === "Rifiutata, occupato o senza risposta" || !errore
      ? "Chiamata rifiutata, occupato o senza risposta."
      : `Chiamata non partita: ${errore}.`,
  };
}

async function inviaEsitiFalliti(campaignId: number | null | undefined) {
  if (!sql || !campaignId) return;
  try {
    // Prima si segnano come inviate (una sola richiesta vince), poi si inviano.
    const rows = (await sql`
      UPDATE live_calls l SET esito_inviato = true
      FROM live_campaigns c
      WHERE l.campaign_id = ${campaignId} AND c.id = l.campaign_id
        AND c.webhook_esiti IS NOT NULL AND l.esito_inviato = false
        AND l.stato = ANY(${LIVE_STATI_FALLITI}::text[])
      RETURNING l.numero, l.nome, l.stato, l.errore, c.webhook_esiti
    `) as any[];
    await Promise.all(rows.map(async row => {
      const { esito, riepilogo } = esitoFallitoPerSheets(row.stato, row.errore);
      const body = {
        esito,
        nome: row.nome || "non indicato",
        azienda: "non indicato",
        ruolo: "non indicato",
        numero: row.numero,
        fascia: "non indicato",
        esigenza: "non indicato",
        email: "non indicato",
        riepilogo,
        note: "Registrato da GEM Outbound: il voicebot non ha parlato con il cliente.",
      };
      try {
        const r = await fetch(row.webhook_esiti, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(8000),
        });
        if (!r.ok) console.error("Webhook esiti: risposta", r.status, "per", row.numero);
      } catch (err) {
        console.error("Webhook esiti non raggiunto per", row.numero, err);
      }
    }));
  } catch (err) {
    console.error("Errore invio esiti non riusciti (non bloccante):", err);
  }
}

// Fine chiamata (webhook Wildix): aggiorna la chiamata aperta verso quel numero.
// Si considerano solo le chiamate partite dalle campagne del sito. Se l'evento
// Wildix contiene l'interno del voicebot, si sceglie la campagna con quel bot,
// così una chiamata di un altro bot verso lo stesso numero non si confonde.
async function markLiveCallCompleted(numero: string | null, risposto: boolean, durataMs: number, callId: string, rawEvent: string) {
  if (!sql || !numero) return;
  const stato = !risposto ? "non_risposta" : durataMs < INTERRUPTED_CALL_MAX_MS ? "interrotta" : "risposta";
  try {
    await ensureLiveSchema();
    const open = (await sql`
      SELECT l.id, l.campaign_id, c.voicebot_exten
      FROM live_calls l JOIN live_campaigns c ON c.id = l.campaign_id
      WHERE l.numero = ${numero} AND l.stato = ANY(${LIVE_STATI_CORREGGIBILI}::text[]) AND l.inviata_at IS NOT NULL
        AND l.queued_at > now() - interval '12 hours'
      ORDER BY l.queued_at DESC
    `) as any[];
    if (open.length === 0) return;
    const conBot = open.filter(r => r.voicebot_exten && rawEvent.includes(`"${r.voicebot_exten}"`));
    const target = conBot[0] || open[0];
    await sql`
      UPDATE live_calls SET stato = ${stato}, durata_ms = ${durataMs}, call_id = ${callId}, errore = NULL, updated_at = now()
      WHERE id = ${target.id}
    `;
    // Chiamata finita: invia l'esito allo Sheets se serve e libera il posto in coda.
    await pumpCampaign(target.campaign_id);
    await controllaFineCampagne(target.campaign_id);
  } catch (err) {
    console.error("Errore aggiornamento chiamata in diretta (non bloccante):", err);
  }
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a), bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

// Make → sito, dopo ogni richiesta di chiamata a Wildix (Originate).
// Protetto dallo stesso segreto che il sito invia a Make (MAKE_WEBHOOK_SECRET).
app.post("/api/live/make-event", express.json({ limit: "20kb" }), express.urlencoded({ extended: false, limit: "20kb" }), async (req, res) => {
  const secret = process.env.MAKE_WEBHOOK_SECRET;
  const given = String(req.headers["x-gem-secret"] || "");
  if (!secret || !safeEqual(given, secret)) return res.status(401).json({ ok: false });
  if (!sql) return res.status(503).json({ ok: false });

  const numero = normalizePhone(String(req.body?.numero || ""));
  if (!numero) return res.status(400).json({ ok: false, error: "numero mancante" });
  const campaignId = parseInt(String(req.body?.campagna_id || ""), 10) || null;
  // Due forme: { esito: "ok" | "errore", dettaglio } oppure la risposta di
  // Wildix all'Originate { status, tipo, risultato, motivo, testo }.
  const status = parseInt(String(req.body?.status || ""), 10) || null;
  let stato: string;
  let dettaglio: string | null = null;
  if (req.body?.esito === "errore") {
    stato = "errore";
    dettaglio = cleanText(req.body?.dettaglio, 300) || "Make non ha raggiunto Wildix";
  } else if (status !== null) {
    const tipo = String(req.body?.tipo || "").toLowerCase();
    const ok = status >= 200 && status < 300 && tipo !== "error";
    stato = ok ? "avviata" : "non_partita";
    if (!ok) {
      const testo = [req.body?.motivo, req.body?.risultato, req.body?.testo]
        .map(v => cleanText(v, 200)).filter(v => v && v !== "[object Object]")[0];
      // Wildix risponde 500 "Internal Server Error" quando il cliente rifiuta,
      // è occupato o non risponde (verificato con una chiamata rifiutata).
      dettaglio = status === 500 && (!testo || /internal server error/i.test(testo))
        ? "Rifiutata, occupato o senza risposta"
        : `Wildix ${status}${testo ? `: ${testo}` : ""}`.slice(0, 300);
    }
  } else {
    stato = "avviata";
  }

  try {
    await ensureLiveSchema();
    const updated = (await sql`
      UPDATE live_calls SET stato = ${stato}, errore = ${dettaglio}, updated_at = now()
      WHERE id = (
        SELECT id FROM live_calls
        WHERE numero = ${numero} AND stato = 'in_coda' AND inviata_at IS NOT NULL
          AND (${campaignId}::int IS NULL OR campaign_id = ${campaignId}::int)
          AND queued_at > now() - interval '12 hours'
        ORDER BY queued_at ASC LIMIT 1
      )
      RETURNING id, campaign_id
    `) as any[];
    // Chiamata non partita: il posto si libera subito per il contatto dopo.
    if (updated.length > 0 && stato !== "avviata") {
      await pumpCampaign(updated[0].campaign_id);
      await controllaFineCampagne(updated[0].campaign_id);
    }
    // Nessuna corrispondenza: chiamata non partita da una campagna del sito
    // (es. "Testa chiamata singola"). Non la registriamo.
    res.json({ ok: true, registrata: updated.length > 0 });
  } catch (err) {
    console.error("Errore /api/live/make-event:", err);
    res.status(500).json({ ok: false });
  }
});

// ══════════════════════════════════════════════════════════════
// TIMER DEL SERVER
// Uno scenario Make programmato (es. ogni 5 minuti) chiama /api/cron/tick:
// fa partire le campagne pianificate anche se nessuno ha l'app aperta e fa
// ripartire le code ferme. Protetto da MAKE_WEBHOOK_SECRET (header
// x-gem-secret) oppure da CRON_SECRET (Authorization: Bearer, per Vercel Cron).
// ══════════════════════════════════════════════════════════════
const TIMER_ATTIVO_MIN = 15;

let appStateReady: Promise<void> | null = null;
function ensureAppState(): Promise<void> {
  if (!appStateReady) {
    appStateReady = sql!`
      CREATE TABLE IF NOT EXISTS app_state (
        key        TEXT PRIMARY KEY,
        value      TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `.then(() => undefined).catch(err => { appStateReady = null; throw err; });
  }
  return appStateReady;
}

async function timerAttivo(): Promise<boolean> {
  if (!sql) return false;
  try {
    await ensureAppState();
    const rows = (await sql`
      SELECT 1 FROM app_state
      WHERE key = 'ultimo_tick' AND updated_at > now() - make_interval(mins => ${TIMER_ATTIVO_MIN}::int)
    `) as any[];
    return rows.length > 0;
  } catch { return false; }
}

function tickAutorizzato(req: any): boolean {
  const make = process.env.MAKE_WEBHOOK_SECRET;
  const given = String(req.headers["x-gem-secret"] || "");
  if (make && given && safeEqual(given, make)) return true;
  const cron = process.env.CRON_SECRET;
  const auth = String(req.headers.authorization || "");
  return !!cron && auth.startsWith("Bearer ") && safeEqual(auth.slice(7), cron);
}

async function handleTick(req: any, res: any) {
  if (!tickAutorizzato(req)) return res.status(401).json({ ok: false });
  if (!sql) return res.status(503).json({ ok: false });
  try {
    await ensureAppState();
    await sql`
      INSERT INTO app_state (key, value, updated_at) VALUES ('ultimo_tick', 'ok', now())
      ON CONFLICT (key) DO UPDATE SET value = 'ok', updated_at = now()
    `;
    await dispatchDueCampaigns();
    const code = await pumpAllQueues();
    await controllaFineCampagne();
    res.json({ ok: true, ...code });
  } catch (err) {
    console.error("Errore timer:", err);
    res.status(500).json({ ok: false });
  }
}
app.post("/api/cron/tick", handleTick);
app.get("/api/cron/tick", handleTick);

// Impostazioni che l'interfaccia deve conoscere.
app.get("/api/config", requireAuth, async (_req, res) => {
  res.json({
    ok: true,
    codaSito: isCodaSito() && !isCallsDryRun(),
    maxSimultanee: isCodaSito() ? maxSimultanee() : 1,
    timerAttivo: await timerAttivo(),
  });
});

// ══════════════════════════════════════════════════════════════
// STORICO CAMPAGNE E LISTE SALVATE (database, condivisi tra dispositivi)
// Prima stavano nel browser (localStorage): l'app al primo accesso importa
// quelle vecchie con /api/archivio/importa.
// ══════════════════════════════════════════════════════════════
let archivioReady: Promise<void> | null = null;
function ensureArchivioSchema(): Promise<void> {
  if (!archivioReady) {
    archivioReady = (async () => {
      await sql!`
        CREATE TABLE IF NOT EXISTS campaign_history (
          id            SERIAL PRIMARY KEY,
          created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
          username      TEXT,
          operatore     TEXT,
          count         INT         NOT NULL,
          scheduled_at  TIMESTAMPTZ,
          chunk_size    INT         NOT NULL DEFAULT 1,
          note          TEXT,
          tipo_campagna TEXT,
          voicebot_nome TEXT,
          contatti      JSONB,
          origine       TEXT        NOT NULL DEFAULT 'app',
          test          BOOLEAN     NOT NULL DEFAULT false
        )
      `;
      await sql!`CREATE INDEX IF NOT EXISTS idx_campaign_history_created ON campaign_history (created_at DESC)`;
      await sql!`CREATE UNIQUE INDEX IF NOT EXISTS uq_campaign_history_import ON campaign_history (origine, username, created_at)`;
      await sql!`
        CREATE TABLE IF NOT EXISTS contact_lists (
          id              SERIAL PRIMARY KEY,
          created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
          created_by      TEXT        NOT NULL,
          created_by_nome TEXT,
          nome            TEXT        NOT NULL,
          contatti        JSONB       NOT NULL
        )
      `;
      await sql!`CREATE UNIQUE INDEX IF NOT EXISTS uq_contact_lists_import ON contact_lists (created_by, nome, created_at)`;
    })().catch(err => { archivioReady = null; throw err; });
  }
  return archivioReady;
}

const ARCHIVIO_MAX_CONTATTI = 5000;

function pulisciContattiArchivio(raw: unknown): any[] | null {
  if (!Array.isArray(raw) || raw.length > ARCHIVIO_MAX_CONTATTI) return null;
  return raw.filter(c => c && typeof c === "object").map((c: any) => {
    const out: Record<string, string> = {};
    for (const k of ["nome", "numero", "data_appuntamento", "ora_appuntamento", "prestazione"]) {
      if (c[k] != null && String(c[k]).trim()) out[k] = String(c[k]).slice(0, 200);
    }
    return out;
  });
}

async function recordHistory(h: {
  username: string; operatore: string; count: number; scheduledAt: string | null; chunkSize: number;
  note?: string; tipoCampagna: string; voicebotNome?: string; contatti: any[]; test: boolean;
}) {
  if (!sql) return;
  try {
    await ensureArchivioSchema();
    await sql`
      INSERT INTO campaign_history (username, operatore, count, scheduled_at, chunk_size, note, tipo_campagna, voicebot_nome, contatti, test)
      VALUES (${h.username}, ${h.operatore}, ${h.count}, ${h.scheduledAt}, ${h.chunkSize}, ${h.note || null},
              ${h.tipoCampagna}, ${h.voicebotNome || null}, ${JSON.stringify(pulisciContattiArchivio(h.contatti) || [])}::jsonb, ${h.test})
    `;
  } catch (err) {
    console.error("Errore scrittura storico (non bloccante):", err);
  }
}

function mapHistoryRow(r: any) {
  return {
    id: String(r.id),
    ts: new Date(r.created_at).toISOString(),
    count: r.count,
    scheduledAt: r.scheduled_at ? new Date(r.scheduled_at).toISOString() : null,
    opt: r.operatore || r.username || "Operatore",
    chunkSize: r.chunk_size || 1,
    contactsList: Array.isArray(r.contatti) ? r.contatti : [],
    note: r.note || undefined,
    tipoCampagna: r.tipo_campagna || undefined,
    voicebot: r.voicebot_nome || undefined,
  };
}

async function requireEditor(req: any, res: any): Promise<any | null> {
  const user = await findSessionUser(req.session.username);
  if (!user) { res.status(401).json({ ok: false, error: "Utente non trovato" }); return null; }
  if (user.role === "Viewer") { res.status(403).json({ ok: false, error: "Non autorizzato" }); return null; }
  return user;
}

app.get("/api/history", requireAuth, async (_req, res) => {
  if (!sql) return res.json({ ok: true, history: [] });
  try {
    await ensureArchivioSchema();
    // In produzione non si vedono le campagne di prova fatte negli ambienti di test.
    const rows = (await sql`
      SELECT * FROM campaign_history
      WHERE test = false OR ${isCallsDryRun()}
      ORDER BY created_at DESC LIMIT 200
    `) as any[];
    res.json({ ok: true, history: rows.map(mapHistoryRow) });
  } catch (err) {
    console.error("Errore lettura storico:", err);
    res.status(500).json({ ok: false, error: "Errore caricamento storico" });
  }
});

app.delete("/api/history", requireAuth, requireAdmin, async (_req, res) => {
  if (!sql) return res.status(503).json({ ok: false });
  try {
    await ensureArchivioSchema();
    await sql`DELETE FROM campaign_history WHERE test = ${isCallsDryRun()}`;
    res.json({ ok: true });
  } catch (err) {
    console.error("Errore svuotamento storico:", err);
    res.status(500).json({ ok: false, error: "Errore svuotamento storico" });
  }
});

function mapListRow(r: any, user: any) {
  return {
    id: String(r.id),
    name: r.nome,
    createdBy: r.created_by_nome || r.created_by,
    createdAt: new Date(r.created_at).toISOString(),
    contacts: Array.isArray(r.contatti) ? r.contatti.map((c: any, i: number) => ({ id: `${r.id}-${i}`, ...c })) : [],
    canDelete: user.role === "Admin" || user.isAdmin === true || String(r.created_by).toLowerCase() === String(user.username).toLowerCase(),
  };
}

app.get("/api/lists", requireAuth, async (req: any, res) => {
  const user = await requireEditor(req, res); if (!user) return;
  if (!sql) return res.json({ ok: true, lists: [] });
  try {
    await ensureArchivioSchema();
    const rows = (await sql`SELECT * FROM contact_lists ORDER BY created_at DESC LIMIT 300`) as any[];
    res.json({ ok: true, lists: rows.map(r => mapListRow(r, user)) });
  } catch (err) {
    console.error("Errore lettura liste:", err);
    res.status(500).json({ ok: false, error: "Errore caricamento liste" });
  }
});

app.post("/api/lists", requireAuth, async (req: any, res) => {
  const user = await requireEditor(req, res); if (!user) return;
  if (!sql) return res.status(503).json({ ok: false, error: "Database non disponibile" });
  const nome = cleanText(req.body?.name, 120);
  const contatti = pulisciContattiArchivio(req.body?.contacts);
  if (!nome) return res.status(400).json({ ok: false, error: "Dai un nome alla lista" });
  if (!contatti || contatti.length === 0) return res.status(400).json({ ok: false, error: `La lista deve avere da 1 a ${ARCHIVIO_MAX_CONTATTI} contatti` });
  try {
    await ensureArchivioSchema();
    const rows = (await sql`
      INSERT INTO contact_lists (created_by, created_by_nome, nome, contatti)
      VALUES (${user.username}, ${user.nome || user.username}, ${nome}, ${JSON.stringify(contatti)}::jsonb)
      RETURNING *
    `) as any[];
    res.json({ ok: true, list: mapListRow(rows[0], user) });
  } catch (err) {
    console.error("Errore salvataggio lista:", err);
    res.status(500).json({ ok: false, error: "Errore salvataggio lista" });
  }
});

app.delete("/api/lists/:id", requireAuth, async (req: any, res) => {
  const user = await requireEditor(req, res); if (!user) return;
  if (!sql) return res.status(503).json({ ok: false });
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ ok: false });
  const admin = user.role === "Admin" || user.isAdmin === true;
  try {
    await ensureArchivioSchema();
    const rows = (await sql`
      DELETE FROM contact_lists
      WHERE id = ${id} AND (${admin} OR lower(created_by) = lower(${user.username}))
      RETURNING id
    `) as any[];
    if (rows.length === 0) return res.status(403).json({ ok: false, error: "Puoi eliminare solo le liste create da te" });
    res.json({ ok: true });
  } catch (err) {
    console.error("Errore eliminazione lista:", err);
    res.status(500).json({ ok: false, error: "Errore eliminazione lista" });
  }
});

// Importa storico e liste che erano salvati nel browser (una volta per browser).
app.post("/api/archivio/importa", requireAuth, async (req: any, res) => {
  const user = await requireEditor(req, res); if (!user) return;
  if (!sql) return res.status(503).json({ ok: false });
  const liste = Array.isArray(req.body?.liste) ? req.body.liste.slice(0, 200) : [];
  const storico = Array.isArray(req.body?.storico) ? req.body.storico.slice(0, 100) : [];
  const data = (v: unknown) => { const t = new Date(String(v || "")); return isNaN(t.getTime()) ? null : t.toISOString(); };
  let listeImportate = 0, storicoImportato = 0;
  try {
    await ensureArchivioSchema();
    for (const l of liste) {
      const nome = cleanText(l?.name, 120);
      const contatti = pulisciContattiArchivio(l?.contacts);
      const creata = data(l?.createdAt);
      if (!nome || !contatti?.length || !creata) continue;
      const r = (await sql`
        INSERT INTO contact_lists (created_at, created_by, created_by_nome, nome, contatti)
        VALUES (${creata}, ${user.username}, ${cleanText(l?.createdBy, 120) || user.nome || user.username}, ${nome}, ${JSON.stringify(contatti)}::jsonb)
        ON CONFLICT DO NOTHING RETURNING id
      `) as any[];
      listeImportate += r.length;
    }
    for (const h of storico) {
      const ts = data(h?.ts);
      const count = parseInt(h?.count, 10);
      if (!ts || !(count >= 0)) continue;
      const r = (await sql`
        INSERT INTO campaign_history (created_at, username, operatore, count, scheduled_at, chunk_size, note, contatti, origine)
        VALUES (${ts}, ${user.username}, ${cleanText(h?.opt, 120) || user.nome || user.username}, ${count}, ${data(h?.scheduledAt)},
                ${Math.min(Math.max(parseInt(h?.chunkSize, 10) || 1, 1), 10)}, ${cleanText(h?.note, 1000) || null},
                ${JSON.stringify(pulisciContattiArchivio(h?.contactsList) || [])}::jsonb, 'browser')
        ON CONFLICT DO NOTHING RETURNING id
      `) as any[];
      storicoImportato += r.length;
    }
    res.json({ ok: true, liste: listeImportate, storico: storicoImportato });
  } catch (err) {
    console.error("Errore importazione archivio:", err);
    res.status(500).json({ ok: false, error: "Errore importazione" });
  }
});

// Dati per la pagina "In diretta": campagne delle ultime ore con i conteggi
// per stato, ultimi eventi e (per gli admin) gli eventi ricevuti da Wildix.
app.get("/api/live", requireAuth, async (req: any, res) => {
  // Solo Editor e Admin: i Viewer non vedono la pagina "In diretta".
  const user = await findSessionUser(req.session.username);
  if (!user) return res.status(401).json({ ok: false, error: "Utente non trovato" });
  if (user.role === "Viewer") return res.status(403).json({ ok: false, error: "Non autorizzato" });
  if (!sql) return res.json({ ok: true, campaigns: [], events: [], diagnostics: null });
  const hours = Math.min(Math.max(parseInt(String(req.query.hours || "12"), 10) || 12, 1), 72);
  try {
    await ensureLiveSchema();
    const campaigns = (await sql`
      SELECT c.id, c.created_at, c.operatore, c.tipo_campagna, c.voicebot_nome, c.voicebot_exten, c.totale, c.scheduled_id,
        count(l.id)::int AS registrate,
        count(*) FILTER (WHERE l.stato = 'in_coda')::int      AS in_coda,
        count(*) FILTER (WHERE l.stato = 'avviata')::int      AS avviate,
        count(*) FILTER (WHERE l.stato = 'risposta')::int     AS risposte,
        count(*) FILTER (WHERE l.stato = 'interrotta')::int   AS interrotte,
        count(*) FILTER (WHERE l.stato = 'non_risposta')::int AS non_risposte,
        count(*) FILTER (WHERE l.stato = 'non_partita')::int  AS non_partite,
        count(*) FILTER (WHERE l.stato = 'errore')::int       AS errori,
        max(l.updated_at) AS ultimo_aggiornamento,
        max(l.updated_at) FILTER (WHERE l.stato <> 'in_coda') AS ultimo_avanzamento
      FROM live_campaigns c
      LEFT JOIN live_calls l ON l.campaign_id = c.id
      WHERE c.created_at > now() - make_interval(hours => ${hours})
      GROUP BY c.id
      ORDER BY c.created_at DESC
      LIMIT 30
    `) as any[];
    const events = (await sql`
      SELECT l.id, l.campaign_id, l.numero, l.nome, l.stato, l.errore, l.durata_ms, l.queued_at, l.updated_at,
             c.operatore, c.voicebot_nome
      FROM live_calls l
      LEFT JOIN live_campaigns c ON c.id = l.campaign_id
      WHERE l.updated_at > now() - make_interval(hours => ${hours}) AND l.stato <> 'in_coda'
      ORDER BY l.updated_at DESC
      LIMIT 80
    `) as any[];

    // Fase 0: quali tipi di evento manda Wildix oltre a quelli già gestiti
    // (es. call:live:progress per le chiamate in corso). Solo per gli admin.
    let diagnostics: any = null;
    if (req.session?.isAdmin) {
      try {
        diagnostics = (await sql`
          SELECT event_type, reason, count(*)::int AS totale FROM webhook_log GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 20
        `) as any[];
      } catch {
        diagnostics = [];
      }
    }
    res.json({ ok: true, hours, serverTime: new Date().toISOString(), campaigns, events, diagnostics });
  } catch (err) {
    console.error("Errore /api/live:", err);
    res.status(500).json({ ok: false, error: "Errore caricamento dati in diretta" });
  }
});

// ══════════════════════════════════════════════════════════════
// CAMPAGNE PIANIFICATE
// Make non sa aspettare un orario: chiama subito. Per questo le campagne
// pianificate restano nel database e partono dal server quando arriva
// l'orario. Il "timer" è l'app stessa: finché è aperta su almeno un
// dispositivo, ogni 30 secondi chiede al server di inviare quelle scadute.
// Se nessuno ha l'app aperta, una campagna in ritardo di oltre
// SCHEDULE_MAX_DELAY_MIN minuti non parte da sola: viene segnata "scaduta",
// per evitare chiamate fuori orario.
// ══════════════════════════════════════════════════════════════
const SCHEDULE_MAX_DELAY_MIN = 30;

let scheduleSchemaReady: Promise<void> | null = null;
function ensureScheduleSchema(): Promise<void> {
  if (!scheduleSchemaReady) {
    scheduleSchemaReady = (async () => {
      await sql!`
        CREATE TABLE IF NOT EXISTS scheduled_campaigns (
          id            SERIAL PRIMARY KEY,
          created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
          created_by    TEXT        NOT NULL,
          operatore     TEXT,
          user_email    TEXT,
          scheduled_at  TIMESTAMPTZ NOT NULL,
          status        TEXT        NOT NULL DEFAULT 'pending',
          tipo_campagna TEXT        NOT NULL,
          voicebot_id   TEXT,
          chunk_size    INT         NOT NULL DEFAULT 1,
          note          TEXT,
          contacts      JSONB       NOT NULL,
          sent_count    INT,
          failed_count  INT,
          dispatched_at TIMESTAMPTZ,
          error         TEXT
        )
      `;
      await sql!`CREATE INDEX IF NOT EXISTS idx_scheduled_campaigns_due ON scheduled_campaigns (status, scheduled_at)`;
    })().catch(err => {
      scheduleSchemaReady = null;
      throw err;
    });
  }
  return scheduleSchemaReady;
}

function mapScheduledRow(r: any) {
  return {
    id: r.id,
    createdAt: r.created_at,
    createdBy: r.created_by,
    operatore: r.operatore,
    scheduledAt: r.scheduled_at,
    status: r.status,
    tipoCampagna: r.tipo_campagna,
    note: r.note,
    count: Array.isArray(r.contacts) ? r.contacts.length : 0,
    sentCount: r.sent_count,
    failedCount: r.failed_count,
    dispatchedAt: r.dispatched_at,
    error: r.error,
  };
}

// Invia le campagne pianificate arrivate all'orario. L'UPDATE ... RETURNING
// "prenota" le righe in modo atomico: se due dispositivi chiamano insieme,
// ogni campagna viene presa da uno solo dei due e non parte due volte.
let dispatchRunning = false;
async function dispatchDueCampaigns(): Promise<void> {
  if (!sql || dispatchRunning) return;
  dispatchRunning = true;
  try {
    await ensureScheduleSchema();
    await sql`
      UPDATE scheduled_campaigns SET status = 'expired',
        error = 'Partenza mancata di oltre 30 minuti (né timer né app aperta): campagna non avviata'
      WHERE status = 'pending'
        AND scheduled_at < now() - make_interval(mins => ${SCHEDULE_MAX_DELAY_MIN}::int)
    `;
    const due = (await sql`
      UPDATE scheduled_campaigns SET status = 'sending', dispatched_at = now()
      WHERE status = 'pending' AND scheduled_at <= now()
      RETURNING *
    `) as any[];

    for (const row of due) {
      try {
        const bots = await readVoicebots();
        const bot = row.voicebot_id ? bots.find((b: any) => b.id === row.voicebot_id) : null;
        const result = await sendCampaignToMake({
          contacts: row.contacts,
          campaignType: row.tipo_campagna === "appuntamenti" ? "appuntamenti" : "standard",
          bot,
          chunkSize: row.chunk_size || 1,
          note: row.note || undefined,
          operatore: row.operatore || row.created_by,
          scheduledAt: new Date(row.scheduled_at).toISOString(),
          username: row.created_by,
          scheduledId: row.id,
        });
        const status = result.failedContacts.length === 0 ? "sent" : result.sentContacts.length > 0 ? "partial" : "failed";
        await sql`
          UPDATE scheduled_campaigns
          SET status = ${status}, sent_count = ${result.sentContacts.length}, failed_count = ${result.failedContacts.length}
          WHERE id = ${row.id}
        `;
        await logCampaign({
          username: row.created_by,
          operatore: row.operatore,
          tipoCampagna: row.tipo_campagna,
          voicebotNome: bot?.nome,
          mode: "scheduled",
          contactsCount: Array.isArray(row.contacts) ? row.contacts.length : 0,
          sentCount: result.sentContacts.length,
          failedCount: result.failedContacts.length,
          scheduledId: row.id,
          dryRun: result.dryRun,
        });
        if (result.sentContacts.length > 0) {
          await sendCampaignEmail({
            operatore: row.operatore,
            count: result.sentContacts.length,
            scheduledAt: null,
            note: row.note || undefined,
            userEmail: row.user_email || undefined,
            test: result.dryRun,
            voicebot: bot?.nome,
            tipoCampagna: row.tipo_campagna,
          });
        }
      } catch (err: any) {
        console.error("Errore invio campagna pianificata", row.id, err);
        await sql`UPDATE scheduled_campaigns SET status = 'failed', error = ${String(err?.message || err).slice(0, 500)} WHERE id = ${row.id}`;
      }
    }
  } catch (err) {
    console.error("Errore controllo campagne pianificate:", err);
  } finally {
    dispatchRunning = false;
  }
}

app.post("/api/campaigns/launch", requireAuth, async (req: any, res) => {
  const { contatti, tipo_campagna, scheduledAt, note, voicebot_id, concurrency } = req.body || {};
  const campaignType = tipo_campagna === "appuntamenti" ? "appuntamenti" : "standard";

  const parsed = parseLaunchContacts(contatti, campaignType === "appuntamenti");
  if ("error" in parsed) return res.status(400).json({ ok: false, error: parsed.error });
  const contacts = parsed.contacts;

  const user = await findSessionUser(req.session.username);
  if (!user) return res.status(401).json({ ok: false, error: "Utente non trovato" });

  // Voicebot: estensione e contesto vengono dalla configurazione salvata,
  // non dal browser, così non si possono indirizzare chiamate altrove.
  const bots = await readVoicebots();
  const bot = voicebot_id ? bots.find((b: any) => b.id === voicebot_id && b.attivo !== false) : null;
  if (voicebot_id && !bot) return res.status(400).json({ ok: false, error: "Voicebot non trovato o disattivato" });

  const chunkSize = Math.min(Math.max(parseInt(concurrency) || 1, 1), 10);
  const cleanNote = cleanText(note, 1000);

  // ── Pianificata: si salva e basta, partirà all'orario ──
  if (scheduledAt) {
    // Stessa regola del login (canSchedule === true), quindi dell'interfaccia.
    if (user.canSchedule !== true) {
      return res.status(403).json({ ok: false, error: "Non hai il permesso di pianificare campagne" });
    }
    const t = new Date(scheduledAt);
    if (isNaN(t.getTime()) || t.getTime() <= Date.now()) {
      return res.status(400).json({ ok: false, error: "Seleziona un orario futuro" });
    }
    if (!sql) return res.status(503).json({ ok: false, error: "Database non disponibile: impossibile pianificare" });
    try {
      await ensureScheduleSchema();
      const rows = (await sql`
        INSERT INTO scheduled_campaigns
          (created_by, operatore, user_email, scheduled_at, tipo_campagna, voicebot_id, chunk_size, note, contacts)
        VALUES
          (${user.username}, ${user.nome || user.username}, ${user.email || null}, ${t.toISOString()},
           ${campaignType}, ${bot?.id || null}, ${chunkSize}, ${cleanNote || null}, ${JSON.stringify(contacts)}::jsonb)
        RETURNING id
      `) as any[];
      await recordHistory({
        username: user.username, operatore: user.nome || user.username, count: contacts.length,
        scheduledAt: t.toISOString(), chunkSize, note: cleanNote, tipoCampagna: campaignType,
        voicebotNome: bot?.nome, contatti: contacts, test: isCallsDryRun(),
      });
      await sendCampaignEmail({
        operatore: user.nome,
        count: contacts.length,
        scheduledAt: t.toISOString(),
        note: cleanNote,
        userEmail: user.email,
        test: isCallsDryRun(),
        voicebot: bot?.nome,
        tipoCampagna: campaignType,
      });
      return res.json({
        ok: true,
        scheduled: true,
        id: rows[0]?.id,
        dryRun: isCallsDryRun(),
        sent: 0,
        failed: 0,
        sentContacts: contacts,
        failedContacts: [],
        scheduledAt: t.toISOString(),
      });
    } catch (err) {
      console.error("Errore salvataggio campagna pianificata:", err);
      return res.status(500).json({ ok: false, error: "Errore nel salvataggio della campagna pianificata" });
    }
  }

  // ── Immediata ──
  const result = await sendCampaignToMake({
    contacts, campaignType, bot, chunkSize, note: cleanNote, operatore: user.nome, scheduledAt: null,
    username: user.username,
  });
  await logCampaign({
    username: user.username,
    operatore: user.nome,
    tipoCampagna: campaignType,
    voicebotNome: bot?.nome,
    mode: "immediate",
    contactsCount: contacts.length,
    sentCount: result.sentContacts.length,
    failedCount: result.failedContacts.length,
    dryRun: result.dryRun,
  });

  if (result.sentContacts.length > 0) {
    await recordHistory({
      username: user.username, operatore: user.nome || user.username, count: result.sentContacts.length,
      scheduledAt: null, chunkSize, note: cleanNote, tipoCampagna: campaignType,
      voicebotNome: bot?.nome, contatti: result.sentContacts, test: result.dryRun,
    });
    await sendCampaignEmail({
      operatore: user.nome,
      count: result.sentContacts.length,
      scheduledAt: null,
      note: cleanNote,
      userEmail: user.email,
      test: result.dryRun,
      voicebot: bot?.nome,
      tipoCampagna: campaignType,
    });
  }

  res.json({
    ok: result.failedContacts.length === 0,
    dryRun: result.dryRun,
    sent: result.sentContacts.length,
    failed: result.failedContacts.length,
    chunksOk: result.chunksOk,
    chunksTotal: result.chunksTotal,
    sentContacts: result.sentContacts,
    failedContacts: result.failedContacts,
    scheduledAt: null,
  });
});

// Lista delle campagne pianificate (ultimi 14 giorni). Prima di rispondere
// invia quelle arrivate all'orario: è questa chiamata, ripetuta dall'app ogni
// 30 secondi, a fare da timer.
app.get("/api/campaigns/scheduled", requireAuth, async (req: any, res) => {
  if (!sql) return res.json({ ok: true, campaigns: [] });
  await dispatchDueCampaigns();
  // Senza timer, anche le email di fine campagna in attesa partono da qui.
  await controllaFineCampagne();
  try {
    await ensureScheduleSchema();
    const isAdmin = req.session.isAdmin === true;
    const rows = (isAdmin
      ? await sql`
          SELECT * FROM scheduled_campaigns
          WHERE status = 'pending' OR scheduled_at > now() - interval '14 days'
          ORDER BY scheduled_at DESC LIMIT 100`
      : await sql`
          SELECT * FROM scheduled_campaigns
          WHERE lower(created_by) = lower(${req.session.username})
            AND (status = 'pending' OR scheduled_at > now() - interval '14 days')
          ORDER BY scheduled_at DESC LIMIT 100`) as any[];
    res.json({ ok: true, campaigns: rows.map(mapScheduledRow), serverTime: new Date().toISOString() });
  } catch (err) {
    console.error("Errore lettura campagne pianificate:", err);
    res.status(500).json({ ok: false, error: "Errore lettura campagne pianificate" });
  }
});

// Annulla una campagna pianificata non ancora partita (autore o Admin).
app.post("/api/campaigns/scheduled/:id/cancel", requireAuth, async (req: any, res) => {
  const id = parseInt(req.params.id);
  if (!sql || !id) return res.status(400).json({ ok: false, error: "Richiesta non valida" });
  try {
    await ensureScheduleSchema();
    const isAdmin = req.session.isAdmin === true;
    const rows = (await sql`
      UPDATE scheduled_campaigns SET status = 'cancelled'
      WHERE id = ${id} AND status = 'pending'
        AND (${isAdmin}::boolean OR lower(created_by) = lower(${req.session.username}))
      RETURNING id
    `) as any[];
    if (rows.length === 0) {
      return res.status(409).json({ ok: false, error: "Campagna non annullabile: già partita, già annullata o non tua" });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error("Errore annullamento campagna:", err);
    res.status(500).json({ ok: false, error: "Errore annullamento" });
  }
});

app.post("/api/campaigns/test-call", requireAuth, async (req: any, res) => {
  const parsed = parseLaunchContacts([req.body?.contact], false);
  if ("error" in parsed) return res.status(400).json({ ok: false, error: parsed.error });
  const user = await findSessionUser(req.session.username);
  if (!user) return res.status(401).json({ ok: false, error: "Utente non trovato" });

  const dryRun = isCallsDryRun();
  if (dryRun) {
    console.log(`[DRY-RUN] Chiamata test simulata verso ${parsed.contacts[0].numero}, utente ${user.username}`);
    return res.json({ ok: true, dryRun });
  }
  const ok = await postToMake(MAKE_WEBHOOK_URL_DEFAULT, {
    contatti: parsed.contacts,
    totale: 1,
    avviatoIl: new Date().toISOString(),
    scheduledAt: null,
    modalita: "test",
    operatore: user.nome,
    fonte: "gem-test",
    chunk: 1,
    chunks_totali: 1,
  });
  res.status(ok ? 200 : 502).json({ ok, dryRun });
});

export default app;
