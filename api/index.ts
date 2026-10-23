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
        esitoCommerciale: r.risposto ? classificaEsitoCommerciale(r.riassunto) : null,
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
// Restituisce true se il follow-up è nuovo (serve per non mandare due volte la stessa notifica).
async function createFollowup(entry: { callId: string; numero: string | null; nome: string | null; motivo: string; assegnatoA?: string | null }): Promise<boolean> {
  try {
    await ensureFollowupsExtra();
    const r = (await sql`
      INSERT INTO followups (call_id, numero, nome, motivo, assegnato_a)
      SELECT ${entry.callId}, ${entry.numero}, ${entry.nome}, ${entry.motivo}, ${entry.assegnatoA || null}
      WHERE NOT EXISTS (
        SELECT 1 FROM followups WHERE call_id = ${entry.callId} AND motivo = ${entry.motivo}
      )
      RETURNING id
    `) as any[];
    return r.length > 0;
  } catch (err) {
    console.error("Error creating followup:", err);
    return false;
  }
}

// Follow-up: note e persona assegnata (colonne aggiunte dopo).
let followupsExtraReady: Promise<void> | null = null;
function ensureFollowupsExtra(): Promise<void> {
  if (!followupsExtraReady) {
    followupsExtraReady = (async () => {
      await sql!`ALTER TABLE followups ADD COLUMN IF NOT EXISTS nota TEXT`;
      await sql!`ALTER TABLE followups ADD COLUMN IF NOT EXISTS assegnato_a TEXT`;
      await sql!`ALTER TABLE followups ADD COLUMN IF NOT EXISTS aggiornato_at TIMESTAMPTZ`;
      await sql!`ALTER TABLE followups ADD COLUMN IF NOT EXISTS aggiornato_da TEXT`;
    })().catch(err => { followupsExtraReady = null; throw err; });
  }
  return followupsExtraReady;
}

// La campagna più recente del sito che ha chiamato questo numero (ultimi giorni).
async function campagnaDelNumero(numero: string | null): Promise<any | null> {
  if (!sql || !numero) return null;
  try {
    await ensureLiveSchema();
    const r = (await sql`
      SELECT c.id, c.username, c.operatore, c.tipo_campagna, c.voicebot_nome, l.nome
      FROM live_calls l JOIN live_campaigns c ON c.id = l.campaign_id
      WHERE l.numero = ${numero} AND l.queued_at > now() - make_interval(days => ${CODA_GIORNI_MAX}::int)
      ORDER BY l.queued_at DESC LIMIT 1
    `) as any[];
    return r[0] || null;
  } catch { return null; }
}

// Cliente caldo (interessato o appuntamento): email subito a chi ha lanciato la
// campagna, così lo richiama finché è ancora "caldo".
async function notificaClienteCaldo(info: { numero: string | null; nome: string | null; esito: EsitoCommerciale; riassunto: any; campagna: any }) {
  if (!process.env.SMTP_USER) return;
  const user = info.campagna?.username ? await findSessionUser(info.campagna.username).catch(() => null) : null;
  const to = user?.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user.email) ? user.email : process.env.NOTIFY_EMAIL;
  if (!to) return;
  const appUrl = (process.env.APP_URL || "https://outboundcallgem.vercel.app").replace(/\/$/, "");
  const etichetta = ESITO_COMMERCIALE_LABEL[info.esito].label;
  const chi = info.nome || info.numero || "Contatto";
  const testo = String(info.riassunto?.testo || info.riassunto?.titolo || "").trim();
  const decisioni = (Array.isArray(info.riassunto?.decisioni) ? info.riassunto.decisioni : []).filter((d: any) => typeof d === "string");
  try {
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || "smtp.gmail.com",
      port: parseInt(process.env.SMTP_PORT || "587"),
      secure: process.env.SMTP_SECURE === "true",
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
    await transporter.sendMail({
      from: `"GEM Outbound" <${process.env.SMTP_USER}>`,
      to,
      subject: `${info.esito === "appuntamento" ? "Appuntamento" : "Cliente interessato"}: ${chi}${info.campagna?.voicebot_nome ? ` · ${info.campagna.voicebot_nome}` : ""}`,
      text: [`${etichetta}: ${chi}${info.numero ? ` (${info.numero})` : ""}`, "", testo, ...decisioni.map((d: string) => `- ${d}`), "", `Follow-up: ${appUrl}/?tab=followups`].join("\n"),
      html: `
<div style="background:#eef1f6;padding:28px 12px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e2e8f0;">
  <tr><td style="padding:26px 36px 0;"><span style="display:inline-block;background:${ESITO_COMMERCIALE_LABEL[info.esito].bg};color:${ESITO_COMMERCIALE_LABEL[info.esito].fg};font-size:12px;font-weight:700;padding:5px 12px;border-radius:999px;">${etichetta}</span></td></tr>
  <tr><td style="padding:14px 36px 4px;font-size:22px;font-weight:700;color:#0f172a;">${escapeHtml(chi)}</td></tr>
  ${info.numero ? `<tr><td style="padding:0 36px 14px;"><a href="tel:${escapeHtml(info.numero)}" style="font-size:16px;color:#1e3dc8;font-weight:600;text-decoration:none;">${escapeHtml(info.numero)}</a></td></tr>` : ""}
  ${testo ? `<tr><td style="padding:0 36px 10px;font-size:15px;color:#334155;line-height:1.6;">${escapeHtml(testo)}</td></tr>` : ""}
  ${decisioni.length ? `<tr><td style="padding:0 36px 10px;font-size:14px;color:#475569;line-height:1.6;"><ul style="margin:0;padding-left:18px;">${decisioni.map((d: string) => `<li>${escapeHtml(d)}</li>`).join("")}</ul></td></tr>` : ""}
  <tr><td style="padding:16px 36px 28px;"><a href="${appUrl}/?tab=followups" style="display:block;background:#1e3dc8;color:#ffffff;text-decoration:none;text-align:center;font-size:15px;font-weight:600;padding:13px 20px;border-radius:9px;">Apri i Follow-up</a></td></tr>
  <tr><td style="padding:16px 36px;border-top:1px solid #eef1f6;font-size:12px;color:#94a3b8;">Richiamalo presto: è il momento migliore. Email automatica di GEM Outbound.</td></tr>
</table></div>`,
    });
  } catch (err) {
    console.error("Errore invio notifica cliente caldo:", err);
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
    await ensureFollowupsExtra().catch(err => console.error("Colonne follow-up:", err));
    const rows = await sql`
      SELECT * FROM followups WHERE stato = ${stato} ORDER BY created_at DESC LIMIT 200
    `;
    res.json({ ok: true, followups: rows });
  } catch (err) {
    console.error("Error reading followups:", err);
    res.status(500).json({ ok: false, followups: [] });
  }
});

// Nota e persona assegnata di un follow-up.
app.put("/api/followups/:id", requireAuth, express.json(), async (req: any, res) => {
  const id = parseInt(req.params.id, 10);
  if (!sql || !(id > 0)) return res.status(400).json({ ok: false, error: "Richiesta non valida" });
  const body = req.body || {};
  const nota = body.nota === undefined ? undefined : (cleanText(body.nota, 2000) || null);
  let assegnato: string | null | undefined = undefined;
  if (body.assegnato_a !== undefined) {
    if (body.assegnato_a === null || body.assegnato_a === "") assegnato = null;
    else {
      const u = await findSessionUser(String(body.assegnato_a));
      if (!u) return res.status(400).json({ ok: false, error: "Utente non trovato" });
      assegnato = u.username;
    }
  }
  try {
    await ensureFollowupsExtra();
    const r = (await sql`
      UPDATE followups SET
        nota = CASE WHEN ${nota !== undefined}::boolean THEN ${nota ?? null} ELSE nota END,
        assegnato_a = CASE WHEN ${assegnato !== undefined}::boolean THEN ${assegnato ?? null} ELSE assegnato_a END,
        aggiornato_at = now(), aggiornato_da = ${req.session.username}
      WHERE id = ${id}
      RETURNING *
    `) as any[];
    if (!r[0]) return res.status(404).json({ ok: false, error: "Follow-up non trovato" });
    res.json({ ok: true, followup: r[0] });
  } catch (err) {
    console.error("Errore aggiornamento follow-up:", err);
    res.status(500).json({ ok: false, error: "Errore aggiornamento" });
  }
});

// Nomi degli utenti (per assegnare i follow-up). Niente dati riservati.
app.get("/api/utenti/nomi", requireAuth, async (_req, res) => {
  const users = await readUsers();
  res.json({ ok: true, utenti: users.map((u: any) => ({ username: u.username, nome: u.nome || u.username })) });
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

    // Confronto tra voicebot e tra fasce orarie, dalle chiamate delle campagne del sito.
    const confronto = await safe(async () => {
      await ensureLiveSchema();
      const righe = (await sql`
        SELECT COALESCE(c.voicebot_nome, 'Voicebot predefinito') AS voicebot, l.stato, l.durata_ms,
               extract(hour FROM l.updated_at AT TIME ZONE 'Europe/Rome')::int AS ora,
               r.riassunto
        FROM live_calls l
        JOIN live_campaigns c ON c.id = l.campaign_id
        LEFT JOIN call_results r ON r.call_id = l.call_id
        WHERE l.updated_at >= ${da} AND l.stato IN ('risposta', 'interrotta', 'non_risposta', 'non_partita')
        LIMIT 50000
      `) as any[];
      const vuoto = () => ({ chiamate: 0, risposte: 0, interrotte: 0, nonRaggiunte: 0, interessati: 0, durataTot: 0, durataN: 0 });
      const perBot = new Map<string, ReturnType<typeof vuoto>>();
      const perOra = new Map<number, ReturnType<typeof vuoto>>();
      for (const r of righe) {
        const ec = r.stato === "risposta" || r.stato === "interrotta" ? classificaEsitoCommerciale(r.riassunto) : null;
        for (const [m, k] of [[perBot, r.voicebot], [perOra, r.ora]] as [Map<any, ReturnType<typeof vuoto>>, any][]) {
          const a = m.get(k) || vuoto();
          a.chiamate++;
          if (r.stato === "risposta") { a.risposte++; if (r.durata_ms > 0) { a.durataTot += r.durata_ms; a.durataN++; } }
          if (r.stato === "interrotta") a.interrotte++;
          if (r.stato === "non_risposta" || r.stato === "non_partita") a.nonRaggiunte++;
          if (ec === "interessato" || ec === "appuntamento") a.interessati++;
          m.set(k, a);
        }
      }
      const fuori = (a: ReturnType<typeof vuoto>) => ({
        chiamate: a.chiamate, risposte: a.risposte, interrotte: a.interrotte, nonRaggiunte: a.nonRaggiunte, interessati: a.interessati,
        durataMediaMs: a.durataN ? Math.round(a.durataTot / a.durataN) : null,
      });
      return {
        perVoicebot: [...perBot.entries()].map(([voicebot, a]) => ({ voicebot, ...fuori(a) })).sort((x, y) => y.chiamate - x.chiamate),
        perFascia: [...perOra.entries()].map(([ora, a]) => ({ ora, ...fuori(a) })).sort((x, y) => x.ora - y.ora),
      };
    }, { perVoicebot: [] as any[], perFascia: [] as any[] });

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
      perVoicebot: confronto.perVoicebot,
      perFascia: confronto.perFascia,
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

        // ── Esito commerciale (campagne standard del sito) ──
        const campagna = await campagnaDelNumero(numero);
        const esitoComm = classificaEsitoCommerciale(riassunto);
        if (esitoComm === "non_chiamare" && numero) {
          // Ha chiesto di non essere più chiamato: entra nella lista "Non chiamare".
          await aggiungiNonChiamare([{ numero, nome: nome || campagna?.nome }], "Chiesto durante la chiamata con il voicebot", "wilma", null)
            .catch(err => console.error("Errore aggiunta Non chiamare da Wilma:", err));
        }
        if (campagna && campagna.tipo_campagna !== "appuntamenti" && !motivoFollowup) {
          const nomeContatto = nome || campagna.nome || null;
          const motivoComm = esitoComm === "appuntamento" ? "Appuntamento fissato"
            : esitoComm === "interessato" ? "Cliente interessato"
            : esitoComm === "richiamare" ? "Da richiamare (chiesto dal cliente)" : null;
          if (motivoComm) {
            const nuovo = await createFollowup({ callId, numero, nome: nomeContatto, motivo: motivoComm, assegnatoA: campagna.username || null });
            if (nuovo && (esitoComm === "appuntamento" || esitoComm === "interessato")) {
              await notificaClienteCaldo({ numero, nome: nomeContatto, esito: esitoComm, riassunto, campagna });
            }
          }
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

// ── Dati di configurazione (utenti e voicebot) nel database ──
// Prima stavano in users.json e voicebots.json su GitHub: ogni modifica
// (abilitare un voicebot, cambiare un ruolo, il profilo, il 2FA) faceva un
// commit su main e quindi un nuovo deploy su Vercel. Ora stanno nella tabella
// dati_config. Alla prima lettura, se la riga manca, si copiano i dati
// attuali da GitHub (o dal file locale), poi GitHub non viene più toccato.
let datiConfigReady: Promise<void> | null = null;
function ensureDatiConfig(): Promise<void> {
  if (!datiConfigReady) {
    datiConfigReady = sql!`
      CREATE TABLE IF NOT EXISTS dati_config (
        chiave        TEXT PRIMARY KEY,
        valore        JSONB       NOT NULL,
        aggiornato_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `.then(() => undefined).catch(err => { datiConfigReady = null; throw err; });
  }
  return datiConfigReady;
}

// Valore dal database; undefined se la riga non c'è ancora.
async function leggiDatiConfig(chiave: string): Promise<any[] | undefined> {
  await ensureDatiConfig();
  const r = (await withRetry(() => sql!`SELECT valore FROM dati_config WHERE chiave = ${chiave}`)) as any[];
  if (!r[0]) return undefined;
  const v = typeof r[0].valore === "string" ? JSON.parse(r[0].valore) : r[0].valore;
  return Array.isArray(v) ? v : [];
}

async function scriviDatiConfig(chiave: string, valore: any[]): Promise<void> {
  await ensureDatiConfig();
  await withRetry(() => sql!`
    INSERT INTO dati_config (chiave, valore, aggiornato_at) VALUES (${chiave}, ${JSON.stringify(valore)}::jsonb, now())
    ON CONFLICT (chiave) DO UPDATE SET valore = EXCLUDED.valore, aggiornato_at = now()
  `);
}

// Prima lettura: copia nel database i dati presi da GitHub, senza
// sovrascrivere una riga creata nel frattempo da un'altra richiesta.
async function importaDatiConfig(chiave: string, valore: any[]): Promise<any[]> {
  if (!sql || !Array.isArray(valore) || valore.length === 0) return valore;
  try {
    await ensureDatiConfig();
    await sql`INSERT INTO dati_config (chiave, valore) VALUES (${chiave}, ${JSON.stringify(valore)}::jsonb) ON CONFLICT (chiave) DO NOTHING`;
    return (await leggiDatiConfig(chiave)) ?? valore;
  } catch (err) {
    console.error(`Errore importazione ${chiave} nel database:`, err);
    return valore;
  }
}

async function readVoicebots() {
  if (sql) {
    try {
      const v = await leggiDatiConfig("voicebots");
      if (v !== undefined) return v;
      return await importaDatiConfig("voicebots", await readVoicebotsGithub());
    } catch (err) {
      console.error("Errore lettura voicebot dal database, uso GitHub:", err);
    }
  }
  return readVoicebotsGithub();
}

async function writeVoicebots(bots: any[]) {
  if (githubWritesBlocked()) {
    console.warn(GITHUB_WRITE_BLOCKED_MSG);
    throw new Error(GITHUB_WRITE_BLOCKED_MSG);
  }
  if (sql) return scriviDatiConfig("voicebots", bots);
  return writeVoicebotsGithub(bots);
}

async function readUsers() {
  if (sql) {
    try {
      const v = await leggiDatiConfig("users");
      if (v !== undefined) return v;
      return await importaDatiConfig("users", await readUsersGithub());
    } catch (err) {
      console.error("Errore lettura utenti dal database, uso GitHub:", err);
    }
  }
  return readUsersGithub();
}

async function writeUsers(users: any[]) {
  if (githubWritesBlocked()) {
    console.warn(GITHUB_WRITE_BLOCKED_MSG);
    return;
  }
  if (sql) {
    // Come prima con GitHub, un errore viene registrato ma non blocca la richiesta.
    try { return await scriviDatiConfig("users", users); }
    catch (err) { console.error("Errore scrittura utenti nel database:", err); return; }
  }
  return writeUsersGithub(users);
}

async function readVoicebotsGithub() {
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

async function writeVoicebotsGithub(bots: any[]) {
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

async function readUsersGithub() {
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

async function writeUsersGithub(users: any[]) {
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
  // Richiamate automatiche dei non raggiunti (solo con la coda del sito).
  retryMax?: number;
  retryIntervalloMin?: number;
}

// Opzioni di richiamata ricevute dal browser: 0–3 tentativi in più, ogni 30 minuti – 24 ore.
const RETRY_INTERVALLI_MIN = [30, 60, 120, 240, 1440];
function parseRichiamate(raw: any): { retryMax: number; retryIntervalloMin: number } {
  const n = Math.min(Math.max(parseInt(raw?.tentativi, 10) || 0, 0), 3);
  const i = parseInt(raw?.intervalloMin, 10);
  return { retryMax: n, retryIntervalloMin: RETRY_INTERVALLI_MIN.includes(i) ? i : 120 };
}

// Invia una campagna a Make a blocchi. Usata sia per il lancio immediato sia
// per le campagne pianificate quando arriva il loro orario.
async function sendCampaignToMake(spec: CampaignSpec) {
  // I numeri nella lista "Non chiamare" non partono mai.
  const esclusi = await numeriNonChiamare(spec.contacts.map(c => c.numero));
  if (esclusi.size > 0) {
    const tutti = spec.contacts;
    spec = { ...spec, contacts: tutti.filter(c => !esclusi.has(normalizePhone(c.numero) || c.numero)) };
  }
  const esclusiContatti = esclusi.size;
  if (spec.contacts.length === 0) {
    return { dryRun: isCallsDryRun(), sentContacts: [] as LaunchContact[], failedContacts: [] as LaunchContact[], chunksOk: 0, chunksTotal: 0, esclusi: esclusiContatti };
  }
  const chunks: LaunchContact[][] = [];
  for (let i = 0; i < spec.contacts.length; i += spec.chunkSize) chunks.push(spec.contacts.slice(i, i + spec.chunkSize));

  const webhookUrl = spec.campaignType === "appuntamenti" ? MAKE_WEBHOOK_URL_APPUNTAMENTI : MAKE_WEBHOOK_URL_DEFAULT;
  const avviatoIl = new Date().toISOString();
  const dryRun = isCallsDryRun();

  if (!dryRun && isCodaSito()) {
    const concurrency = Math.min(Math.max(spec.chunkSize || 1, 1), maxSimultanee(spec.campaignType));
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
      return { dryRun, sentContacts: spec.contacts, failedContacts: [] as LaunchContact[], chunksOk: 1, chunksTotal: 1, esclusi: esclusiContatti };
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
  return { dryRun, sentContacts, failedContacts, chunksOk: results.filter(Boolean).length, chunksTotal: chunks.length, esclusi: esclusiContatti };
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
      // Pausa e stop della campagna, richiamate automatiche dei non raggiunti.
      await sql!`ALTER TABLE live_campaigns ADD COLUMN IF NOT EXISTS in_pausa BOOLEAN NOT NULL DEFAULT false`;
      await sql!`ALTER TABLE live_campaigns ADD COLUMN IF NOT EXISTS fermata_at TIMESTAMPTZ`;
      await sql!`ALTER TABLE live_campaigns ADD COLUMN IF NOT EXISTS fermata_da TEXT`;
      await sql!`ALTER TABLE live_campaigns ADD COLUMN IF NOT EXISTS retry_max INT NOT NULL DEFAULT 0`;
      await sql!`ALTER TABLE live_campaigns ADD COLUMN IF NOT EXISTS retry_intervallo_min INT NOT NULL DEFAULT 120`;
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
      // Richiamate: numero del tentativo, quando può ripartire, esito del tentativo prima.
      await sql!`ALTER TABLE live_calls ADD COLUMN IF NOT EXISTS tentativo INT NOT NULL DEFAULT 1`;
      await sql!`ALTER TABLE live_calls ADD COLUMN IF NOT EXISTS programmata_at TIMESTAMPTZ`;
      await sql!`ALTER TABLE live_calls ADD COLUMN IF NOT EXISTS esito_precedente TEXT`;
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
                                  modalita_coda, concurrency, webhook_url, payload_base, retry_max, retry_intervallo_min)
      VALUES (${spec.username || null}, ${spec.operatore || null}, ${spec.campaignType}, ${spec.bot?.nome || null},
              ${spec.bot?.exten != null ? String(spec.bot.exten) : null}, ${spec.contacts.length}, ${spec.scheduledId ?? null},
              ${webhookEsitiValido(spec.bot?.webhookEsiti)},
              ${!!coda}, ${coda?.concurrency ?? 1}, ${coda?.webhookUrl ?? null},
              ${coda ? JSON.stringify(coda.payloadBase) : null}::jsonb,
              ${coda ? spec.retryMax || 0 : 0}, ${spec.retryIntervalloMin || 120})
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

// ── Orari consentiti ──
// Un Admin sceglie giorni e fasce orarie (ora italiana) in cui si può
// chiamare. Fuori orario le code non mandano contatti a Make: le chiamate
// aspettano la prossima apertura (anche il giorno dopo). Spenti finché un
// Admin non li attiva.
interface Fascia { da: string; a: string }
interface OrariConsentiti { attivo: boolean; giorni: number[]; fasce: Fascia[] }
const ORARI_PREDEFINITI: OrariConsentiti = {
  attivo: false,
  giorni: [1, 2, 3, 4, 5],
  fasce: [{ da: "09:00", a: "13:00" }, { da: "14:30", a: "18:30" }],
};
const GIORNI_BREVI = ["dom", "lun", "mar", "mer", "gio", "ven", "sab"];

function minutiOra(hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || "");
  return m ? Math.min(parseInt(m[1], 10), 24) * 60 + Math.min(parseInt(m[2], 10), 59) : -1;
}

function validaOrari(raw: any): OrariConsentiti | null {
  if (!raw || typeof raw !== "object") return null;
  const giorni = [...new Set((Array.isArray(raw.giorni) ? raw.giorni : []).map((g: any) => parseInt(g, 10)))]
    .filter((g: any) => Number.isInteger(g) && g >= 0 && g <= 6) as number[];
  const fasce: Fascia[] = (Array.isArray(raw.fasce) ? raw.fasce : []).slice(0, 4)
    .map((f: any) => ({ da: String(f?.da || "").trim(), a: String(f?.a || "").trim() }))
    .filter((f: Fascia) => minutiOra(f.da) >= 0 && minutiOra(f.a) > minutiOra(f.da))
    .sort((x: Fascia, y: Fascia) => minutiOra(x.da) - minutiOra(y.da));
  const attivo = raw.attivo === true;
  if (attivo && (giorni.length === 0 || fasce.length === 0)) return null;
  return { attivo, giorni: giorni.sort(), fasce };
}

let orariCache: { v: OrariConsentiti; t: number } | null = null;
async function leggiOrari(): Promise<OrariConsentiti> {
  if (orariCache && Date.now() - orariCache.t < 30_000) return orariCache.v;
  let v = ORARI_PREDEFINITI;
  if (sql) {
    try {
      await ensureAppState();
      const r = (await sql`SELECT value FROM app_state WHERE key = 'orari'`) as any[];
      if (r[0]?.value) v = validaOrari(JSON.parse(r[0].value)) || ORARI_PREDEFINITI;
    } catch (err) {
      console.error("Errore lettura orari consentiti:", err);
    }
  }
  orariCache = { v, t: Date.now() };
  return v;
}

// Giorno della settimana, data e minuti dall'inizio del giorno, in ora italiana.
function parteRoma(d: Date): { y: number; m: number; g: number; dow: number; min: number } {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Rome", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short",
  }).formatToParts(d).map(x => [x.type, x.value]));
  const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday);
  return { y: +p.year, m: +p.month, g: +p.day, dow, min: +p.hour * 60 + +p.minute };
}

// L'istante UTC di una data e ora italiane (gestisce l'ora legale).
function daOraRoma(y: number, m: number, g: number, minuti: number): Date {
  const guess = Date.UTC(y, m - 1, g, Math.floor(minuti / 60), minuti % 60);
  let t = guess;
  for (let i = 0; i < 2; i++) {
    const p = parteRoma(new Date(t));
    const visto = Date.UTC(p.y, p.m - 1, p.g, Math.floor(p.min / 60), p.min % 60);
    t += guess - visto;
  }
  return new Date(t);
}

function dentroOrari(o: OrariConsentiti, d: Date): boolean {
  if (!o.attivo) return true;
  const p = parteRoma(d);
  return o.giorni.includes(p.dow) && o.fasce.some(f => p.min >= minutiOra(f.da) && p.min < minutiOra(f.a));
}

// Il primo istante, da "d" in poi, in cui si può chiamare.
function prossimaApertura(o: OrariConsentiti, d: Date): Date | null {
  if (dentroOrari(o, d)) return d;
  const p = parteRoma(d);
  for (let k = 0; k <= 7; k++) {
    const giorno = new Date(Date.UTC(p.y, p.m - 1, p.g + k));
    const dow = giorno.getUTCDay();
    if (!o.giorni.includes(dow)) continue;
    for (const f of o.fasce) {
      const t = daOraRoma(giorno.getUTCFullYear(), giorno.getUTCMonth() + 1, giorno.getUTCDate(), minutiOra(f.da));
      if (t.getTime() > d.getTime()) return t;
    }
  }
  return null;
}

function descriviOrari(o: OrariConsentiti): string {
  if (!o.attivo) return "sempre";
  return `${o.giorni.map(g => GIORNI_BREVI[g]).join(", ")} · ${o.fasce.map(f => `${f.da}–${f.a}`).join(", ")}`;
}

// ── Lista "Non chiamare" ──
// Numeri da non chiamare mai: chi lo ha chiesto, clienti attivi, numeri
// sbagliati. Vengono tolti da ogni campagna, anche da quelle già in coda.
// Wilma aggiunge da sola chi chiede di non essere più contattato.
let dncReady: Promise<void> | null = null;
function ensureDncSchema(): Promise<void> {
  if (!dncReady) {
    dncReady = sql!`
      CREATE TABLE IF NOT EXISTS do_not_call (
        numero     TEXT PRIMARY KEY,
        nome       TEXT,
        motivo     TEXT,
        fonte      TEXT        NOT NULL DEFAULT 'manuale',
        created_by TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `.then(() => undefined).catch(err => { dncReady = null; throw err; });
  }
  return dncReady;
}

async function numeriNonChiamare(numeri: string[]): Promise<Set<string>> {
  if (!sql || numeri.length === 0) return new Set();
  try {
    await ensureDncSchema();
    const norm = [...new Set(numeri.map(n => normalizePhone(n) || n))];
    const rows = (await sql`SELECT numero FROM do_not_call WHERE numero = ANY(${norm}::text[])`) as any[];
    return new Set(rows.map(r => r.numero));
  } catch (err) {
    console.error("Errore lettura lista Non chiamare:", err);
    return new Set();
  }
}

async function aggiungiNonChiamare(voci: { numero: string; nome?: string | null }[], motivo: string | null, fonte: string, autore: string | null): Promise<number> {
  const mappa = new Map<string, string | null>();
  for (const v of voci) {
    const n = normalizePhone(v.numero);
    if (n && /^\+?\d{6,15}$/.test(n)) mappa.set(n, v.nome ? String(v.nome).slice(0, 200) : null);
  }
  if (!sql || mappa.size === 0) return 0;
  await ensureDncSchema();
  const numeri = [...mappa.keys()];
  const nomi = numeri.map(n => mappa.get(n) || null);
  const r = (await sql`
    INSERT INTO do_not_call (numero, nome, motivo, fonte, created_by)
    SELECT n, nm, ${motivo}, ${fonte}, ${autore} FROM unnest(${numeri}::text[], ${nomi}::text[]) AS t(n, nm)
    ON CONFLICT (numero) DO UPDATE SET nome = COALESCE(do_not_call.nome, EXCLUDED.nome)
    RETURNING (xmax = 0) AS nuovo
  `) as any[];
  return r.filter(x => x.nuovo).length;
}

// ── Coda gestita dal sito (modalità predefinita) ──
// Il sito tiene la coda: manda a Make un contatto per esecuzione e al massimo
// N chiamate in corso per campagna. Quando una chiamata finisce (esito da Make
// o fine chiamata da Wildix) parte la successiva. Così si possono mettere in
// pausa le campagne, rispettare gli orari consentiti, richiamare i non
// raggiunti e saltare i numeri "Non chiamare". Il timer (/api/cron/tick) fa
// ripartire le code rimaste ferme.
// CAMPAIGN_QUEUE_MODE=make torna al vecchio invio: tutta la lista a Make.
function isCodaSito(): boolean {
  return (process.env.CAMPAIGN_QUEUE_MODE || "").trim().toLowerCase() !== "make";
}
// Chiamate contemporanee per campagna. Standard: 1, perché lo scenario Make
// aspetta la risposta del cliente e lavora una richiesta alla volta (per
// alzarlo va tolta l'elaborazione sequenziale in Make). Appuntamenti: 3,
// perché lo scenario avvia la chiamata senza aspettare.
function maxSimultanee(tipo: string = "standard"): number {
  const env = tipo === "appuntamenti" ? process.env.MAX_CHIAMATE_SIMULTANEE_APPUNTAMENTI : process.env.MAX_CHIAMATE_SIMULTANEE;
  const def = tipo === "appuntamenti" ? 3 : 1;
  return Math.min(Math.max(parseInt(env || String(def), 10) || def, 1), 10);
}
// Una chiamata passata a Make occupa un posto finché non ha un esito. Senza
// notizie entro questi tempi il posto si libera, così la coda non si blocca.
const CODA_ATTESA_MAKE_MIN = 10;
const CODA_DURATA_MAX_MIN = 15;
// Le code (richiamate comprese) restano attive al massimo per questi giorni.
const CODA_GIORNI_MAX = 7;

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
      WHERE c.id = ${campaignId} AND c.modalita_coda AND NOT c.in_pausa AND c.fermata_at IS NULL AND l.campaign_id = c.id
        AND l.id IN (
          SELECT id FROM live_calls
          WHERE campaign_id = ${campaignId} AND stato = 'in_coda' AND inviata_at IS NULL
            AND (programmata_at IS NULL OR programmata_at <= now())
          ORDER BY tentativo, id
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
    await programmaRichiamate(campaignId);
    await escludiNonChiamare(campaignId);
    // Fuori dagli orari consentiti non parte nessuno: ci pensa la sveglia all'apertura.
    const aperto = dentroOrari(await leggiOrari(), new Date());
    for (let giro = 0; aperto && giro < 5; giro++) {
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

// Non raggiunti (rifiutata, occupato, senza risposta): se la campagna prevede
// richiamate e restano tentativi, il contatto torna in coda e ripartirà dopo
// l'intervallo scelto. L'esito va allo Sheets solo dopo l'ultimo tentativo.
async function programmaRichiamate(campaignId: number): Promise<number> {
  const r = (await sql!`
    UPDATE live_calls l SET
      stato = 'in_coda', inviata_at = NULL, esito_precedente = l.stato,
      tentativo = l.tentativo + 1, call_id = NULL, durata_ms = NULL,
      programmata_at = now() + make_interval(mins => c.retry_intervallo_min),
      updated_at = now()
    FROM live_campaigns c
    WHERE l.campaign_id = ${campaignId} AND c.id = l.campaign_id
      AND c.modalita_coda AND c.fermata_at IS NULL AND l.tentativo <= c.retry_max
      AND l.stato IN ('non_partita', 'non_risposta') AND l.esito_inviato = false
    RETURNING l.id
  `) as any[];
  return r.length;
}

// Numeri entrati nella lista "Non chiamare" mentre aspettavano in coda.
async function escludiNonChiamare(campaignId: number): Promise<void> {
  await ensureDncSchema();
  await sql!`
    UPDATE live_calls l SET stato = 'escluso', errore = 'Nella lista Non chiamare', programmata_at = NULL, updated_at = now()
    FROM do_not_call d
    WHERE l.campaign_id = ${campaignId} AND l.stato = 'in_coda' AND l.inviata_at IS NULL AND d.numero = l.numero
  `;
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
    WHERE c.modalita_coda AND NOT c.in_pausa AND c.fermata_at IS NULL
      AND l.queued_at > now() - make_interval(days => ${CODA_GIORNI_MAX}::int)
      AND ((l.stato = 'in_coda' AND l.inviata_at IS NULL AND (l.programmata_at IS NULL OR l.programmata_at <= now()))
        OR (l.stato IN ('non_partita', 'non_risposta') AND l.tentativo <= c.retry_max AND l.esito_inviato = false))
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
          count(*) FILTER (WHERE l.stato IN ('in_coda', 'avviata')
            OR (l.stato IN ('non_partita', 'non_risposta') AND c.modalita_coda AND c.fermata_at IS NULL
                AND l.tentativo <= c.retry_max AND l.esito_inviato = false)) AS aperte,
          -- Contatti che aspettano il loro turno (pausa, orari, richiamata): la campagna non è ferma.
          count(*) FILTER (WHERE l.stato = 'in_coda' AND l.inviata_at IS NULL) AS da_inviare,
          count(*) FILTER (WHERE l.stato = 'risposta' AND NOT EXISTS (
            SELECT 1 FROM call_results r
            WHERE r.riassunto IS NOT NULL
              AND (r.call_id = l.call_id OR (r.numero = l.numero AND r.ts::timestamptz > c.created_at))
          )) AS senza_riassunto
        FROM live_campaigns c JOIN live_calls l ON l.campaign_id = c.id
        WHERE c.riepilogo_inviato_at IS NULL AND c.created_at > now() - make_interval(days => ${CODA_GIORNI_MAX}::int)
          AND (${soloId ?? null}::int IS NULL OR c.id = ${soloId ?? null}::int)
        GROUP BY c.id
      )
      SELECT id FROM stato
      WHERE (aperte = 0 AND (senza_riassunto = 0 OR ultimo < now() - make_interval(mins => ${FINE_ATTESA_RIASSUNTI_MIN}::int)))
         OR (da_inviare = 0 AND ultimo < now() - make_interval(mins => ${FINE_MAX_INATTIVITA_MIN}::int))
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

// ── Esito commerciale ──
// Dal riassunto di Wilma: com'è andata per il commerciale, oltre all'esito
// tecnico (risposto / non risposto). Regole sulle parole del riassunto, in
// quest'ordine: chi non vuole essere chiamato, chi rifiuta, appuntamento,
// interessato, richiamare. Senza una regola che corrisponde: "da valutare".
type EsitoCommerciale = "non_chiamare" | "non_interessato" | "appuntamento" | "richiamare" | "interessato" | "da_valutare";
const ESITO_COMMERCIALE_LABEL: Record<EsitoCommerciale, { label: string; bg: string; fg: string }> = {
  appuntamento: { label: "Appuntamento", bg: "#dcfce7", fg: "#166534" },
  interessato: { label: "Interessato", bg: "#dbeafe", fg: "#1e40af" },
  richiamare: { label: "Da richiamare", bg: "#ede9fe", fg: "#5b21b6" },
  non_interessato: { label: "Non interessato", bg: "#f1f5f9", fg: "#475569" },
  non_chiamare: { label: "Non chiamare", bg: "#fee2e2", fg: "#991b1b" },
  da_valutare: { label: "Da valutare", bg: "#f8fafc", fg: "#64748b" },
};
const RE_NON_CHIAMARE = /(non (vuole|vogliono|desidera|desiderano) (pi[uù] )?essere (ri)?(contattat|chiamat|disturbat)|di non essere (pi[uù] )?(ri)?(contattat|chiamat|disturbat)|non (mi|lo|la|ci|li|le) (chiamate|contattate|richiamate|disturbate) pi[uù]|(non (deve|devono) (pi[uù] )?(essere )?(ri)?(chiamar|contattar))|(rimozion|rimuover|cancellar|cancellazion|eliminar)\w*.{0,50}(numer|nominativ|dati|lista|elenc|contatt)|registro (pubblico )?(delle |dell'?)?opposizion|non disturbar|smettere di (chiamar|contattar)|stop (alle )?chiamate|chiamate indesiderate)/;
const RE_NON_INTERESSATO = /(non (è|e'|sono|risulta|risultano|si dichiara|si è detto|si e' detto|appare) (\w+ )?interessat|nessun interesse|non (ha|hanno|mostra|mostrano|manifesta) (alcun |nessun )?interesse|disinteress|rifiut|non conferm|disdett|disdic|annullat\w* l'appuntamento|non (gli|le|ci) interessa|non interessa|gi[aà] (un |altro )?fornitore|gi[aà] (soddisfatt|servit|client)|non ne (ha|hanno) bisogno|non (gli|le) serve|non serve)/;
const RE_APPUNTAMENTO = /((appuntament|incontr|demo|dimostrazion|sopralluog|videochiamat|visita|consulenz)\w*.{0,50}(fissat|confermat|concordat|prenotat|programmat|issat|stabilit|accettat)|(fissat|concordat|prenotat|conferm|programmat|accetta)\w*.{0,40}(appuntament|incontr|demo|dimostrazion|sopralluog|videochiamat|visita|consulenz))/;
const RE_RICHIAMARE = /(richiam|ricontatt|risentir|chiamare (pi[uù] )?tardi|(in un |un )?altro momento|un altro giorno|(era|è|e') occupat|non (pu[oò]|poteva|potevano) parlare|ripassare|inviare (una |un'?)?(e-?mail|informazion|preventiv|materiale|brochure)|mandare (una |un'?)?(e-?mail|informazion|preventiv)|pi[uù] tardi)/;
const RE_INTERESSATO = /(interessat|interesse|vuole (sapere|ricevere|avere|un preventivo|maggiori|approfondire)|chiede(va|ndo)? (informazion|un preventivo|dettagli|maggiori|costi|prezz)|preventiv|valutare (l'offerta|la proposta|il servizio)|curios|disponibil\w* a (ricevere|valutare|approfondire|un incontro))/;

function leggiRiassunto(v: any): any {
  if (v == null) return null;
  if (typeof v !== "string") return v;
  try { return JSON.parse(v); } catch { return { testo: v }; }
}

function classificaEsitoCommerciale(riassuntoRaw: any): EsitoCommerciale | null {
  const r = leggiRiassunto(riassuntoRaw);
  if (!r) return null;
  const testo = [r.titolo, r.testo, ...(Array.isArray(r.decisioni) ? r.decisioni : []), ...(Array.isArray(r.problemi) ? r.problemi : [])]
    .filter(x => typeof x === "string").join(" ").toLowerCase().replace(/\s+/g, " ");
  if (!testo.trim()) return null;
  if (RE_NON_CHIAMARE.test(testo)) return "non_chiamare";
  if (RE_NON_INTERESSATO.test(testo)) return "non_interessato";
  if (RE_APPUNTAMENTO.test(testo)) return "appuntamento";
  if (RE_INTERESSATO.test(testo)) return "interessato";
  if (RE_RICHIAMARE.test(testo)) return "richiamare";
  return "da_valutare";
}

const ESITO_LABEL: Record<string, { label: string; bg: string; fg: string }> = {
  risposta: { label: "Risposto", bg: "#dcfce7", fg: "#166534" },
  interrotta: { label: "Interrotta", bg: "#fef3c7", fg: "#92400e" },
  non_risposta: { label: "Non risposto", bg: "#f1f5f9", fg: "#475569" },
  non_partita: { label: "Non partita", bg: "#ffedd5", fg: "#9a3412" },
  errore: { label: "Errore", bg: "#fee2e2", fg: "#991b1b" },
  in_coda: { label: "Senza esito", bg: "#f1f5f9", fg: "#64748b" },
  avviata: { label: "Senza esito", bg: "#f1f5f9", fg: "#64748b" },
  annullata: { label: "Annullata", bg: "#f1f5f9", fg: "#64748b" },
  escluso: { label: "Non chiamare", bg: "#fee2e2", fg: "#991b1b" },
};

// Tutte le chiamate di una campagna con il riassunto e la trascrizione di
// Wilma: prima per call_id, altrimenti (risposte e interrotte) il primo
// risultato dello stesso numero arrivato dopo il lancio della campagna.
async function chiamateCampagna(campaignId: number, createdAt: any): Promise<any[]> {
  return (await sql!`
    SELECT l.id, l.nome, l.numero, l.stato, l.errore, l.durata_ms, l.queued_at, l.updated_at,
      l.tentativo, l.programmata_at, l.esito_precedente, l.inviata_at,
      r.riassunto, r.trascrizione
    FROM live_calls l
    LEFT JOIN LATERAL (
      SELECT x.riassunto, x.trascrizione FROM (
        (SELECT r1.riassunto, r1.trascrizione, 0 AS prio, now() AS t FROM call_results r1
         WHERE l.call_id IS NOT NULL AND r1.call_id = l.call_id
           AND (r1.riassunto IS NOT NULL OR r1.trascrizione IS NOT NULL) LIMIT 1)
        UNION ALL
        (SELECT r2.riassunto, r2.trascrizione, 1 AS prio, r2.ts::timestamptz AS t FROM call_results r2
         WHERE l.stato IN ('risposta', 'interrotta') AND r2.numero = l.numero
           AND (r2.riassunto IS NOT NULL OR r2.trascrizione IS NOT NULL) AND r2.ts::timestamptz > ${createdAt}
         ORDER BY r2.ts::timestamptz ASC LIMIT 1)
      ) x ORDER BY x.prio, x.t LIMIT 1
    ) r ON true
    WHERE l.campaign_id = ${campaignId} ORDER BY l.id
  `) as any[];
}

async function inviaRiepilogoCampagna(c: any): Promise<void> {
  const righe = await chiamateCampagna(c.id, c.created_at);
  if (righe.length === 0) return;

  const conta = (stati: string[]) => righe.filter(r => stati.includes(r.stato)).length;
  const tot = righe.length;
  const risposte = conta(["risposta"]);
  const interrotte = conta(["interrotta"]);
  const nonRisposte = conta(["non_risposta", "non_partita"]);
  const errori = conta(["errore"]);
  const senzaEsito = conta(["in_coda", "avviata"]);
  const commerciale = (r: any) => (r.stato === "risposta" || r.stato === "interrotta") ? classificaEsitoCommerciale(r.riassunto) : null;
  const interessati = righe.filter(r => ["interessato", "appuntamento"].includes(commerciale(r) || "")).length;
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
    ...(interessati ? [["Interessati o appuntamenti", String(interessati)] as [string, string]] : []),
    ...(errori ? [["Errori", String(errori)] as [string, string]] : []),
    ...(c.retry_max ? [["Richiamate dei non raggiunti", `fino a ${c.retry_max} ${c.retry_max === 1 ? "volta" : "volte"}`] as [string, string]] : []),
    ...(conta(["escluso"]) ? [["Esclusi (Non chiamare)", String(conta(["escluso"]))] as [string, string]] : []),
    ...(conta(["annullata"]) ? [["Annullate (campagna fermata)", String(conta(["annullata"]))] as [string, string]] : []),
    ...(c.operatore ? [["Lanciata da", c.operatore] as [string, string]] : []),
  ];
  const datiRows = dati.map(([k, v], i) => {
    const b = i < dati.length - 1 ? "border-bottom:1px solid #eef1f6;" : "";
    return `<tr><td style="padding:10px 0;${b}font-size:14px;color:#64748b;width:45%;">${k}</td><td style="padding:10px 0;${b}font-size:14px;color:#0f172a;font-weight:600;text-align:right;">${escapeHtml(v)}</td></tr>`;
  }).join("");

  const MAX_RIGHE_EMAIL = 200;
  // Prima le risposte (con il riassunto), poi le altre.
  const ordine = ["risposta", "interrotta", "non_risposta", "non_partita", "errore", "avviata", "in_coda", "escluso", "annullata"];
  const ordinate = [...righe].sort((a, b) => ordine.indexOf(a.stato) - ordine.indexOf(b.stato));
  const callRows = ordinate.slice(0, MAX_RIGHE_EMAIL).map(r => {
    const e = ESITO_LABEL[r.stato] || ESITO_LABEL.in_coda;
    const ec = commerciale(r);
    const ecl = ec && ec !== "da_valutare" ? ESITO_COMMERCIALE_LABEL[ec] : null;
    const riass = testoRiassunto(r);
    const extra = riass ? escapeHtml(riass.length > 320 ? riass.slice(0, 317) + "…" : riass)
      : r.stato === "non_partita" || r.stato === "errore" ? escapeHtml(r.errore || "") : "";
    return `<tr><td style="padding:12px 0;border-bottom:1px solid #eef1f6;vertical-align:top;">
      <div style="font-size:14px;font-weight:600;color:#0f172a;">${escapeHtml(r.nome || r.numero)}
        <span style="display:inline-block;margin-left:6px;background:${e.bg};color:${e.fg};font-size:11px;font-weight:700;padding:2px 8px;border-radius:999px;">${e.label}</span>
        ${ecl ? `<span style="display:inline-block;margin-left:4px;background:${ecl.bg};color:${ecl.fg};font-size:11px;font-weight:700;padding:2px 8px;border-radius:999px;">${ecl.label}</span>` : ""}
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
    ["Nome", "Numero", "Esito", "Esito commerciale", "Tentativi", "Durata (secondi)", "Riassunto", "Dettaglio"].map(cella).join(";"),
    ...ordinate.map(r => [
      r.nome || "", r.numero, (ESITO_LABEL[r.stato] || ESITO_LABEL.in_coda).label,
      commerciale(r) ? ESITO_COMMERCIALE_LABEL[commerciale(r)!].label : "", r.tentativo || 1,
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
        AND l.inviata_at > now() - interval '12 hours'
      ORDER BY l.inviata_at DESC
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
    await aggiornaSveglia();
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
          AND inviata_at > now() - interval '12 hours'
        ORDER BY inviata_at ASC LIMIT 1
      )
      RETURNING id, campaign_id
    `) as any[];
    // Chiamata non partita: il posto si libera subito per il contatto dopo.
    if (updated.length > 0 && stato !== "avviata") {
      await pumpCampaign(updated[0].campaign_id);
      await controllaFineCampagne(updated[0].campaign_id);
      await aggiornaSveglia();
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
    // Sveglia Make configurata e ultima programmazione riuscita…
    if (svegliaConfigurata()) {
      const st = (await sql`SELECT value FROM app_state WHERE key = 'sveglia_stato'`) as any[];
      if (st[0]?.value !== "errore") return true;
    }
    // …oppure un timer a intervalli che ha chiamato da poco.
    const rows = (await sql`
      SELECT 1 FROM app_state
      WHERE key = 'ultimo_tick' AND updated_at > now() - make_interval(mins => ${TIMER_ATTIVO_MIN}::int)
    `) as any[];
    return rows.length > 0;
  } catch { return false; }
}

// ── Sveglia Make ──
// Invece di uno scenario che gira ogni 5 minuti (e consuma operazioni anche
// quando non c'è niente da fare), il sito programma lo scenario "Timer
// campagne" per UNA esecuzione all'orario che serve: la prossima campagna
// pianificata, oppure il controllo di fine campagna. Quando suona, il tick fa
// il lavoro e ricalcola la sveglia successiva. Le chiamate alle API di Make
// non consumano operazioni. Serve MAKE_API_TOKEN (permesso scenarios:write).
//
// Gli scenari sono due e si alternano: Make spegne uno scenario "una volta"
// appena finisce di girare, quindi lo scenario che sta chiamando il tick non
// si può riattivare da dentro il tick. Il tick arma l'altro, che è fermo.
// Nell'URL di ogni scenario c'è ?s=1 o ?s=2, così il sito sa chi lo chiama.
const MAKE_API_URL = (process.env.MAKE_API_URL || "https://eu1.make.com/api/v2").replace(/\/$/, "");
const MAKE_TIMER_SCENARIO_ID = (process.env.MAKE_TIMER_SCENARIO_ID || "8130692").trim();
const MAKE_TIMER_SCENARI = [...new Set([MAKE_TIMER_SCENARIO_ID, (process.env.MAKE_TIMER_SCENARIO_ID_2 || "8132573").trim()].filter(Boolean))];
// Su Vercel la variabile è stata creata come MAKE_API_TOKE: si accettano entrambi i nomi.
function makeApiToken(): string {
  return (process.env.MAKE_API_TOKEN || process.env.MAKE_API_TOKE || "").trim();
}
function svegliaConfigurata(): boolean {
  return !!makeApiToken() && !!MAKE_TIMER_SCENARIO_ID;
}

async function makeApi(path: string, method: string, body?: unknown): Promise<{ ok: boolean; status: number; testo: string }> {
  const r = await fetch(`${MAKE_API_URL}${path}`, {
    method,
    headers: { Authorization: `Token ${makeApiToken()}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  return { ok: r.ok, status: r.status, testo: (await r.text().catch(() => "")).slice(0, 300) };
}

// Il primo momento in cui serve il timer, o null se non serve.
async function prossimaSveglia(): Promise<Date | null> {
  const candidati: number[] = [];
  await ensureScheduleSchema();
  const pian = (await sql!`SELECT min(scheduled_at) AS t FROM scheduled_campaigns WHERE status = 'pending'`) as any[];
  if (pian[0]?.t) candidati.push(new Date(pian[0].t).getTime());
  await ensureLiveSchema();
  // Campagne che aspettano l'email di fine: allo scadere dell'attesa dei
  // riassunti (se le chiamate sono finite) o del limite di inattività.
  const aperte = (await sql!`
    SELECT max(l.updated_at) AS ultimo, count(*) FILTER (WHERE l.stato IN ('in_coda', 'avviata')) AS aperte,
      count(*) FILTER (WHERE l.stato = 'in_coda' AND l.inviata_at IS NULL) AS da_inviare
    FROM live_campaigns c JOIN live_calls l ON l.campaign_id = c.id
    WHERE c.riepilogo_inviato_at IS NULL AND c.created_at > now() - make_interval(days => ${CODA_GIORNI_MAX}::int)
    GROUP BY c.id
  `) as any[];
  for (const a of aperte) {
    // Contatti che aspettano il turno: ci pensano i controlli delle code qui sotto.
    if (Number(a.da_inviare) > 0) continue;
    const min = Number(a.aperte) === 0 ? FINE_ATTESA_RIASSUNTI_MIN : FINE_MAX_INATTIVITA_MIN;
    candidati.push(new Date(a.ultimo).getTime() + (min + 1) * 60_000);
  }
  // Code del sito: quando si libera un posto bloccato, quando scade una
  // richiamata, quando riaprono gli orari consentiti.
  const code = (await sql!`
    SELECT c.id,
      count(*) FILTER (WHERE l.stato = 'in_coda' AND l.inviata_at IS NULL
                         AND (l.programmata_at IS NULL OR l.programmata_at <= now())) AS pronte,
      min(l.programmata_at) FILTER (WHERE l.stato = 'in_coda' AND l.inviata_at IS NULL AND l.programmata_at > now()) AS prossima_richiamata,
      min(CASE WHEN l.stato = 'in_coda' AND l.inviata_at IS NOT NULL
                 THEN l.inviata_at + make_interval(mins => ${CODA_ATTESA_MAKE_MIN}::int)
               WHEN l.stato = 'avviata'
                 THEN l.updated_at + make_interval(mins => ${CODA_DURATA_MAX_MIN}::int) END) AS scadenza_posto
    FROM live_campaigns c JOIN live_calls l ON l.campaign_id = c.id
    WHERE c.modalita_coda AND NOT c.in_pausa AND c.fermata_at IS NULL
      AND l.stato IN ('in_coda', 'avviata') AND l.queued_at > now() - make_interval(days => ${CODA_GIORNI_MAX}::int)
    GROUP BY c.id
  `) as any[];
  if (code.length) {
    const orari = await leggiOrari();
    const ora = new Date();
    for (const q of code) {
      if (q.scadenza_posto) candidati.push(new Date(q.scadenza_posto).getTime() + 60_000);
      if (Number(q.pronte) > 0) {
        // Contatti pronti: se gli orari sono chiusi, alla riapertura; se sono
        // aperti e nessun posto è occupato, la coda è ferma: controllo a breve.
        const ap = prossimaApertura(orari, ora);
        if (ap && ap.getTime() > ora.getTime()) candidati.push(ap.getTime() + 30_000);
        else if (!q.scadenza_posto) candidati.push(ora.getTime());
      }
      if (q.prossima_richiamata) {
        const ap = prossimaApertura(orari, new Date(q.prossima_richiamata));
        if (ap) candidati.push(ap.getTime() + 30_000);
      }
    }
  }
  if (!candidati.length) return null;
  // Make ha bisogno di un orario nel futuro.
  return new Date(Math.max(Math.min(...candidati), Date.now() + 90_000));
}

// dopoTick: la sveglia è appena suonata, quindi va sempre riprogrammata (o
// spenta), sull'altro scenario. Negli altri casi si cambia solo se va
// anticipata: una sveglia in anticipo costa al massimo un'esecuzione, poi il
// tick la sposta.
async function aggiornaSveglia(opts: { dopoTick?: boolean; chiamante?: string | null } = {}): Promise<void> {
  if (!sql || !svegliaConfigurata()) return;
  try {
    await ensureAppState();
    const prossima = await prossimaSveglia();
    const leggi = async (k: string) => ((await sql!`SELECT value FROM app_state WHERE key = ${k}`) as any[])[0]?.value as string | undefined;
    const cur = (await leggi("sveglia")) || "spenta";
    const armatoSalvato = await leggi("sveglia_scenario");
    const armato = armatoSalvato && MAKE_TIMER_SCENARI.includes(armatoSalvato) ? armatoSalvato : MAKE_TIMER_SCENARI[0];
    const curData = cur !== "spenta" ? new Date(cur) : null;
    const curFutura = !!curData && curData.getTime() > Date.now();
    const salva = (k: string, v: string) => sql!`
      INSERT INTO app_state (key, value, updated_at) VALUES (${k}, ${v}, now())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
    // Lo scenario che sta girando adesso si spegne da solo a fine esecuzione.
    const inCorso = opts.dopoTick ? (opts.chiamante || armato) : null;
    const ferma = async (id: string) => {
      if (id === inCorso) return;
      const r = await makeApi(`/scenarios/${id}/stop`, "POST");
      if (!r.ok && r.status !== 400) console.error("Sveglia Make: stop non riuscito", id, r.status, r.testo);
    };

    if (!prossima) {
      if (cur === "spenta" || (!opts.dopoTick && curFutura)) return;
      await ferma(armato);
      await salva("sveglia", "spenta");
      return;
    }
    const daCambiare = opts.dopoTick || !curFutura || prossima.getTime() < curData!.getTime() - 30_000;
    if (!daCambiare) return;

    // Dopo un tick si arma lo scenario fermo; altrimenti quello già armato.
    const target = inCorso ? (MAKE_TIMER_SCENARI.find(id => id !== inCorso) || inCorso) : armato;
    const patch = await makeApi(`/scenarios/${target}`, "PATCH", {
      scheduling: JSON.stringify({ type: "once", date: prossima.toISOString() }),
    });
    if (!patch.ok) {
      console.error("Sveglia Make: programmazione non riuscita", target, patch.status, patch.testo);
      await salva("sveglia_stato", "errore");
      return;
    }
    // Avvia lo scenario (se è già attivo Make risponde con un errore innocuo).
    const start = await makeApi(`/scenarios/${target}/start`, "POST");
    if (!start.ok && !/already|attiv|active/i.test(start.testo)) {
      console.error("Sveglia Make: avvio non riuscito", target, start.status, start.testo);
      await salva("sveglia_stato", "errore");
      return;
    }
    // Una sola sveglia armata: l'altro scenario si ferma (se non sta girando).
    if (target !== armato) await ferma(armato);
    await salva("sveglia", prossima.toISOString());
    await salva("sveglia_scenario", target);
    await salva("sveglia_stato", "ok");
  } catch (err) {
    console.error("Errore sveglia Make (non bloccante):", err);
    try { await sql`INSERT INTO app_state (key, value, updated_at) VALUES ('sveglia_stato', 'errore', now()) ON CONFLICT (key) DO UPDATE SET value = 'errore', updated_at = now()`; } catch { /* ignora */ }
  }
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
    // ?s=1 / ?s=2: quale dei due scenari sveglia sta chiamando.
    const n = parseInt(String(req.query?.s || ""), 10);
    const chiamante = n >= 1 && n <= MAKE_TIMER_SCENARI.length ? MAKE_TIMER_SCENARI[n - 1] : null;
    await aggiornaSveglia({ dopoTick: true, chiamante });
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
  const orari = await leggiOrari();
  res.json({
    ok: true,
    // In anteprima (prova) le chiamate sono simulate: niente coda, quindi niente richiamate o pausa.
    codaSito: isCodaSito() && !isCallsDryRun(),
    maxSimultanee: isCodaSito() ? maxSimultanee("standard") : 1,
    maxSimultaneeAppuntamenti: isCodaSito() ? maxSimultanee("appuntamenti") : 1,
    timerAttivo: await timerAttivo(),
    orari,
    orariDescrizione: descriviOrari(orari),
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

// Una chiamata accettata da Wildix senza evento di fine da più di tanti minuti
// viene mostrata come "Senza esito" (nessuna chiamata del voicebot dura così a
// lungo). Lo stato nel database resta "avviata": se l'evento arriva in ritardo
// l'esito viene comunque corretto.
const LIVE_SENZA_ESITO_MIN = 30;

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
        c.modalita_coda, c.in_pausa, c.fermata_at, c.retry_max, c.retry_intervallo_min, c.username,
        count(l.id)::int AS registrate,
        count(*) FILTER (WHERE l.stato = 'in_coda' AND (l.programmata_at IS NULL OR l.programmata_at <= now()))::int AS in_coda,
        count(*) FILTER (WHERE l.stato = 'in_coda' AND l.programmata_at > now())::int AS da_richiamare,
        min(l.programmata_at) FILTER (WHERE l.stato = 'in_coda' AND l.programmata_at > now()) AS prossima_richiamata,
        count(*) FILTER (WHERE l.stato = 'annullata')::int    AS annullate,
        count(*) FILTER (WHERE l.stato = 'escluso')::int      AS esclusi,
        count(*) FILTER (WHERE l.stato = 'avviata' AND l.updated_at > now() - make_interval(mins => ${LIVE_SENZA_ESITO_MIN}::int))::int AS avviate,
        count(*) FILTER (WHERE l.stato = 'avviata' AND l.updated_at <= now() - make_interval(mins => ${LIVE_SENZA_ESITO_MIN}::int))::int AS senza_esito,
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
         -- Anche le campagne più vecchie che hanno ancora contatti in coda (pausa, richiamate).
         OR (c.modalita_coda AND c.created_at > now() - make_interval(days => ${CODA_GIORNI_MAX}::int) AND c.fermata_at IS NULL
             AND EXISTS (SELECT 1 FROM live_calls x WHERE x.campaign_id = c.id AND x.stato IN ('in_coda', 'avviata')))
      GROUP BY c.id
      ORDER BY c.created_at DESC
      LIMIT 30
    `) as any[];
    const events = (await sql`
      SELECT l.id, l.campaign_id, l.numero, l.nome,
             CASE WHEN l.stato = 'avviata' AND l.updated_at <= now() - make_interval(mins => ${LIVE_SENZA_ESITO_MIN}::int)
                  THEN 'senza_esito' ELSE l.stato END AS stato,
             l.errore, l.durata_ms, l.queued_at, l.updated_at, l.tentativo, l.esito_precedente, l.programmata_at,
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
    const orari = await leggiOrari();
    const ora = new Date();
    const aperto = dentroOrari(orari, ora);
    res.json({
      ok: true, hours, serverTime: ora.toISOString(), campaigns, events, diagnostics,
      orari: { attivo: orari.attivo, descrizione: descriviOrari(orari), aperto, prossimaApertura: aperto ? null : prossimaApertura(orari, ora)?.toISOString() || null },
    });
  } catch (err) {
    console.error("Errore /api/live:", err);
    res.status(500).json({ ok: false, error: "Errore caricamento dati in diretta" });
  }
});

// Dettaglio di una campagna della pagina "In diretta": tutti i numeri con
// esito, durata e riassunto di Wilma. Solo Editor e Admin.
app.get("/api/live/campaigns/:id", requireAuth, async (req: any, res) => {
  const user = await findSessionUser(req.session.username);
  if (!user) return res.status(401).json({ ok: false, error: "Utente non trovato" });
  if (user.role === "Viewer") return res.status(403).json({ ok: false, error: "Non autorizzato" });
  const id = parseInt(String(req.params.id), 10);
  if (!sql || !(id > 0)) return res.status(404).json({ ok: false, error: "Campagna non trovata" });
  try {
    await ensureLiveSchema();
    const c = ((await sql`
      SELECT id, created_at, operatore, tipo_campagna, voicebot_nome, voicebot_exten, totale, scheduled_id,
             modalita_coda, in_pausa, fermata_at, fermata_da, retry_max, retry_intervallo_min
      FROM live_campaigns WHERE id = ${id}
    `) as any[])[0];
    if (!c) return res.status(404).json({ ok: false, error: "Campagna non trovata" });
    const limiteSenzaEsito = Date.now() - LIVE_SENZA_ESITO_MIN * 60000;
    const leggi = (v: any) => {
      if (v == null) return null;
      if (typeof v !== "string") return v;
      try { return JSON.parse(v); } catch { return { testo: v }; }
    };
    const calls = (await chiamateCampagna(id, c.created_at)).map(r => {
      return {
        id: r.id,
        nome: r.nome,
        numero: r.numero,
        stato: r.stato === "avviata" && new Date(r.updated_at).getTime() <= limiteSenzaEsito ? "senza_esito"
          : r.stato === "in_coda" && r.programmata_at && new Date(r.programmata_at).getTime() > Date.now() ? "programmata" : r.stato,
        errore: r.errore,
        durata_ms: r.durata_ms,
        updated_at: r.updated_at,
        tentativo: r.tentativo || 1,
        programmata_at: r.programmata_at,
        esito_precedente: r.esito_precedente,
        riassunto: leggi(r.riassunto),
        trascrizione: typeof r.trascrizione === "string" ? r.trascrizione : null,
        esito_commerciale: r.stato === "risposta" || r.stato === "interrotta" ? classificaEsitoCommerciale(r.riassunto) : null,
      };
    });
    const dnc = await numeriNonChiamare(calls.map(x => x.numero));
    res.json({ ok: true, campaign: c, calls: calls.map(x => ({ ...x, non_chiamare: dnc.has(x.numero) })) });
  } catch (err) {
    console.error("Errore /api/live/campaigns/:id:", err);
    res.status(500).json({ ok: false, error: "Errore caricamento campagna" });
  }
});

// Pausa e ripresa di una campagna in coda: in pausa non partono nuove
// chiamate (quelle già avviate finiscono normalmente).
app.post("/api/live/campaigns/:id/pausa", requireAuth, async (req: any, res) => {
  const user = await requireEditor(req, res);
  if (!user) return;
  const id = parseInt(String(req.params.id), 10);
  const pausa = req.body?.pausa === true;
  if (!sql || !(id > 0)) return res.status(400).json({ ok: false, error: "Richiesta non valida" });
  try {
    await ensureLiveSchema();
    const r = (await sql`
      UPDATE live_campaigns SET in_pausa = ${pausa}
      WHERE id = ${id} AND modalita_coda AND fermata_at IS NULL
      RETURNING id
    `) as any[];
    if (!r[0]) return res.status(409).json({ ok: false, error: "Questa campagna non si può mettere in pausa (già fermata o inviata tutta a Make)" });
    if (!pausa) await pumpCampaign(id);
    await aggiornaSveglia();
    res.json({ ok: true, pausa });
  } catch (err) {
    console.error("Errore pausa campagna:", err);
    res.status(500).json({ ok: false, error: "Errore" });
  }
});

// Eliminazione di una campagna (solo Admin): toglie la campagna e le sue
// chiamate da "In diretta" (e dal confronto voicebot delle Statistiche).
// Esiti Chiamate, follow-up e Storico Campagne restano. Una campagna con
// chiamate ancora da fare va prima fermata.
app.delete("/api/live/campaigns/:id", requireAuth, requireAdmin, async (req: any, res) => {
  const id = parseInt(String(req.params.id), 10);
  if (!sql || !(id > 0)) return res.status(400).json({ ok: false, error: "Richiesta non valida" });
  try {
    await ensureLiveSchema();
    const aperte = (await sql`
      SELECT count(*)::int AS n FROM live_calls l JOIN live_campaigns c ON c.id = l.campaign_id
      WHERE l.campaign_id = ${id} AND c.fermata_at IS NULL
        AND ((l.stato = 'in_coda' AND l.inviata_at IS NULL AND c.modalita_coda)
          OR (l.stato = 'avviata' AND l.updated_at > now() - make_interval(mins => ${LIVE_SENZA_ESITO_MIN}::int)))
    `) as any[];
    if (aperte[0]?.n > 0) {
      return res.status(409).json({ ok: false, error: "La campagna ha ancora chiamate in corso o da fare: fermala prima di eliminarla." });
    }
    await sql`DELETE FROM live_calls WHERE campaign_id = ${id}`;
    const r = (await sql`DELETE FROM live_campaigns WHERE id = ${id} RETURNING id`) as any[];
    if (!r[0]) return res.status(404).json({ ok: false, error: "Campagna non trovata" });
    await aggiornaSveglia();
    res.json({ ok: true });
  } catch (err) {
    console.error("Errore eliminazione campagna:", err);
    res.status(500).json({ ok: false, error: "Errore eliminazione" });
  }
});

// Stop definitivo: i contatti non ancora chiamati diventano "annullata".
app.post("/api/live/campaigns/:id/ferma", requireAuth, async (req: any, res) => {
  const user = await requireEditor(req, res);
  if (!user) return;
  const id = parseInt(String(req.params.id), 10);
  if (!sql || !(id > 0)) return res.status(400).json({ ok: false, error: "Richiesta non valida" });
  try {
    await ensureLiveSchema();
    const r = (await sql`
      UPDATE live_campaigns SET fermata_at = now(), fermata_da = ${user.nome || user.username}, in_pausa = false
      WHERE id = ${id} AND modalita_coda AND fermata_at IS NULL
      RETURNING id
    `) as any[];
    if (!r[0]) return res.status(409).json({ ok: false, error: "Questa campagna non si può fermare (già fermata o inviata tutta a Make)" });
    const annullate = (await sql`
      UPDATE live_calls SET stato = 'annullata', errore = ${`Campagna fermata da ${user.nome || user.username}`},
        programmata_at = NULL, updated_at = now()
      WHERE campaign_id = ${id} AND stato = 'in_coda' AND inviata_at IS NULL
      RETURNING id
    `) as any[];
    await inviaEsitiFalliti(id);
    await controllaFineCampagne(id);
    await aggiornaSveglia();
    res.json({ ok: true, annullate: annullate.length });
  } catch (err) {
    console.error("Errore stop campagna:", err);
    res.status(500).json({ ok: false, error: "Errore" });
  }
});

// ── Lista "Non chiamare": Editor e Admin la vedono e la riempiono, solo un Admin toglie numeri ──
app.get("/api/non-chiamare", requireAuth, async (req: any, res) => {
  const user = await requireEditor(req, res);
  if (!user) return;
  if (!sql) return res.json({ ok: true, numeri: [] });
  try {
    await ensureDncSchema();
    const rows = (await sql`SELECT * FROM do_not_call ORDER BY created_at DESC LIMIT 10000`) as any[];
    res.json({ ok: true, numeri: rows });
  } catch (err) {
    console.error("Errore lettura Non chiamare:", err);
    res.status(500).json({ ok: false, error: "Errore lettura" });
  }
});

app.post("/api/non-chiamare", requireAuth, async (req: any, res) => {
  const user = await requireEditor(req, res);
  if (!user) return;
  const voci = Array.isArray(req.body?.numeri) ? req.body.numeri.slice(0, MAX_CONTACTS_PER_LAUNCH) : [];
  if (voci.length === 0) return res.status(400).json({ ok: false, error: "Nessun numero" });
  const validi = voci.filter((v: any) => /^\+?\d{6,15}$/.test(String(v?.numero || "").replace(/[\s\-().]/g, "")));
  if (validi.length === 0) return res.status(400).json({ ok: false, error: "Nessun numero valido" });
  if (!sql) return res.status(503).json({ ok: false, error: "Database non disponibile" });
  try {
    const aggiunti = await aggiungiNonChiamare(
      validi.map((v: any) => ({ numero: String(v.numero), nome: cleanText(v.nome) || null })),
      cleanText(req.body?.motivo, 300) || null, "manuale", user.nome || user.username,
    );
    // I numeri aggiunti spariscono subito dalle code delle campagne in corso.
    await ensureLiveSchema();
    await sql`
      UPDATE live_calls l SET stato = 'escluso', errore = 'Nella lista Non chiamare', programmata_at = NULL, updated_at = now()
      FROM do_not_call d WHERE l.stato = 'in_coda' AND l.inviata_at IS NULL AND d.numero = l.numero
    `;
    res.json({ ok: true, aggiunti, giaPresenti: validi.length - aggiunti, scartati: voci.length - validi.length });
  } catch (err) {
    console.error("Errore aggiunta Non chiamare:", err);
    res.status(500).json({ ok: false, error: "Errore salvataggio" });
  }
});

app.delete("/api/non-chiamare/:numero", requireAuth, requireAdmin, async (req: any, res) => {
  if (!sql) return res.status(503).json({ ok: false });
  try {
    await ensureDncSchema();
    const n = normalizePhone(decodeURIComponent(String(req.params.numero))) || "";
    const r = (await sql`DELETE FROM do_not_call WHERE numero = ${n} RETURNING numero`) as any[];
    res.json({ ok: true, rimossi: r.length });
  } catch (err) {
    console.error("Errore rimozione Non chiamare:", err);
    res.status(500).json({ ok: false, error: "Errore" });
  }
});

// ── Orari consentiti: tutti li leggono, solo un Admin li cambia ──
app.get("/api/impostazioni/orari", requireAuth, async (_req, res) => {
  const orari = await leggiOrari();
  const ora = new Date();
  res.json({ ok: true, orari, descrizione: descriviOrari(orari), aperto: dentroOrari(orari, ora), prossimaApertura: prossimaApertura(orari, ora)?.toISOString() || null });
});

app.put("/api/impostazioni/orari", requireAuth, requireAdmin, async (req: any, res) => {
  const orari = validaOrari(req.body);
  if (!orari) return res.status(400).json({ ok: false, error: "Orari non validi: scegli almeno un giorno e una fascia con l'inizio prima della fine" });
  if (!sql) return res.status(503).json({ ok: false, error: "Database non disponibile" });
  try {
    await ensureAppState();
    await sql`
      INSERT INTO app_state (key, value, updated_at) VALUES ('orari', ${JSON.stringify(orari)}, now())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
    `;
    orariCache = null;
    // Le code ferme per orario ripartono (o aspettano la nuova apertura).
    await pumpAllQueues();
    await aggiornaSveglia();
    res.json({ ok: true, orari, descrizione: descriviOrari(orari) });
  } catch (err) {
    console.error("Errore salvataggio orari:", err);
    res.status(500).json({ ok: false, error: "Errore salvataggio" });
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
      await sql!`ALTER TABLE scheduled_campaigns ADD COLUMN IF NOT EXISTS retry_max INT NOT NULL DEFAULT 0`;
      await sql!`ALTER TABLE scheduled_campaigns ADD COLUMN IF NOT EXISTS retry_intervallo_min INT NOT NULL DEFAULT 120`;
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
          retryMax: row.retry_max || 0,
          retryIntervalloMin: row.retry_intervallo_min || 120,
        });
        const status = result.failedContacts.length === 0 ? (result.sentContacts.length > 0 || !result.esclusi ? "sent" : "failed") : result.sentContacts.length > 0 ? "partial" : "failed";
        await sql`
          UPDATE scheduled_campaigns
          SET status = ${status}, sent_count = ${result.sentContacts.length}, failed_count = ${result.failedContacts.length},
              error = ${result.esclusi ? `${result.esclusi} ${result.esclusi === 1 ? "numero escluso" : "numeri esclusi"}: nella lista Non chiamare` : null}
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
  const { contatti, tipo_campagna, scheduledAt, note, voicebot_id, concurrency, richiamate } = req.body || {};
  const { retryMax, retryIntervalloMin } = parseRichiamate(richiamate);
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
          (created_by, operatore, user_email, scheduled_at, tipo_campagna, voicebot_id, chunk_size, note, contacts, retry_max, retry_intervallo_min)
        VALUES
          (${user.username}, ${user.nome || user.username}, ${user.email || null}, ${t.toISOString()},
           ${campaignType}, ${bot?.id || null}, ${chunkSize}, ${cleanNote || null}, ${JSON.stringify(contacts)}::jsonb,
           ${retryMax}, ${retryIntervalloMin})
        RETURNING id
      `) as any[];
      await recordHistory({
        username: user.username, operatore: user.nome || user.username, count: contacts.length,
        scheduledAt: t.toISOString(), chunkSize, note: cleanNote, tipoCampagna: campaignType,
        voicebotNome: bot?.nome, contatti: contacts, test: isCallsDryRun(),
      });
      // Programma la sveglia Make per l'orario della campagna (se è la prima).
      await aggiornaSveglia();
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
      // Avvisi per l'operatore: numeri oggi in "Non chiamare" e orario fuori fascia.
      const esclusi = (await numeriNonChiamare(contacts.map(c => c.numero))).size;
      const orari = await leggiOrari();
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
        esclusi,
        inAttesaFino: dentroOrari(orari, t) ? null : prossimaApertura(orari, t)?.toISOString() || null,
      });
    } catch (err) {
      console.error("Errore salvataggio campagna pianificata:", err);
      return res.status(500).json({ ok: false, error: "Errore nel salvataggio della campagna pianificata" });
    }
  }

  // ── Immediata ──
  // Fuori dagli orari consentiti la campagna si crea lo stesso, ma le chiamate
  // aspettano l'apertura. Con il vecchio invio (tutto a Make) non si può: si blocca.
  const orari = await leggiOrari();
  const adesso = new Date();
  if (!dentroOrari(orari, adesso) && !isCodaSito()) {
    return res.status(400).json({ ok: false, error: `Fuori dagli orari consentiti (${descriviOrari(orari)}). Pianifica la campagna per un orario consentito.` });
  }
  const result = await sendCampaignToMake({
    contacts, campaignType, bot, chunkSize, note: cleanNote, operatore: user.nome, scheduledAt: null,
    username: user.username, retryMax, retryIntervalloMin,
  });
  // Sveglia per l'email di fine campagna, se nessuno avrà l'app aperta.
  if (!result.dryRun) await aggiornaSveglia();
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
    esclusi: result.esclusi || 0,
    inAttesaFino: !result.dryRun && result.sentContacts.length > 0 && !dentroOrari(orari, adesso)
      ? prossimaApertura(orari, adesso)?.toISOString() || null : null,
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
