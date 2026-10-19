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
async function createFollowup(entry: { callId: string; numero: string | null; nome: string | null; motivo: string }) {
  try {
    await sql`
      INSERT INTO followups (call_id, numero, nome, motivo)
      VALUES (${entry.callId}, ${entry.numero}, ${entry.nome}, ${entry.motivo})
    `;
  } catch (err) {
    console.error("Error creating followup:", err);
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
app.get("/api/health", (req, res) => {
  res.json({ status: "ok" });
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
app.get("/api/voicebots", requireAuth, async (_req, res) => {
  res.json({ ok: true, voicebots: await readVoicebots() });
});

app.post("/api/voicebots", requireAuth, requireAdmin, async (req, res) => {
  const { nome, exten, context, descrizione } = req.body;
  if (!nome || !exten || !context) return res.status(400).json({ ok: false, error: "Nome, interno e contesto sono obbligatori" });
  const bots = await readVoicebots();
  const id = `vb${Date.now()}`;
  bots.push({ id, nome, exten: parseInt(exten), context, descrizione: descrizione || "", attivo: true });
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
  bots[idx] = { ...bots[idx], ...req.body, id: req.params.id };
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
}): Promise<void> {
  const { operatore, count, scheduledAt, note, userEmail, test } = opts;
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
  const ora = new Date().toLocaleString('it-IT', { timeZone: 'Europe/Rome' });
  const pianificata = scheduledAt && new Date(scheduledAt).getTime() > Date.now();
  const titolo = pianificata ? 'La tua campagna è pianificata.' : 'La tua campagna è partita.';
  const nContatti = Number(count) || 0;
  const contattiLabel = `${nContatti} ${nContatti === 1 ? 'contatto' : 'contatti'}`;
  const appUrl = (process.env.APP_URL || 'https://outboundcallgem.vercel.app').replace(/\/$/, '');
  const logoUrl = `${appUrl}/gem-logo-white.png`;
  const quandoFrase = pianificata
    ? `pianificata per ${escapeHtml(new Date(scheduledAt).toLocaleString('it-IT', { timeZone: 'Europe/Rome' }))}`
    : `dalle ${ora}`;

  const capRow = (icon: string, t: string, d: string, last = false) => {
    const border = last ? '' : 'border-bottom:1px solid #eef1f6;';
    return `<tr>
      <td style="padding:16px 0;${border}vertical-align:middle;width:44px;"><img src="${appUrl}/${icon}" width="30" height="30" style="display:block;" alt="" /></td>
      <td style="padding:16px 0 16px 14px;${border}vertical-align:middle;line-height:1.5;">
        <strong style="color:#0f172a;font-size:15px;">${t}</strong><br>
        <span style="color:#64748b;font-size:14px;">${d}</span></td></tr>`;
  };

  try {
    await transporter.sendMail({
      from: `"GEM Campagne Out" <${process.env.SMTP_USER}>`,
      to,
      subject: `${test ? '[TEST - nessuna chiamata reale] ' : ''}${titolo} — ${contattiLabel}`,
      html: `
      <div style="background:#e8ebf2;padding:24px 0;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(6,8,18,0.12);">
          <tr>
            <td style="background:linear-gradient(135deg,#1e3dc8 0%,#0a1a6b 55%,#060812 100%);padding:36px 40px 30px;text-align:center;">
              <img src="${logoUrl}" width="115" style="display:inline-block;max-width:115px;height:auto;margin-bottom:16px;" alt="GEM Group" />
              <div style="color:#ffffff;font-size:23px;font-weight:700;letter-spacing:-0.2px;line-height:1.25;">${titolo}</div>
              <div style="color:#aeb9ee;font-size:15px;margin-top:6px;">Da qui in poi, ci pensa l'AI.</div>
            </td>
          </tr>
          <tr>
            <td style="padding:30px 40px 0;">
              <p style="margin:0 0 22px;font-size:15px;color:#334155;line-height:1.6;">Ciao ${escapeHtml(operatore)}, la campagna outbound è stata avviata. Gli assistenti vocali GEM stanno contattando i tuoi clienti — <strong style="color:#0f172a;">${escapeHtml(contattiLabel)}</strong>, ${quandoFrase}. Ogni chiamata viene poi elaborata così, in automatico:</p>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                ${capRow('icon-phone.png', 'Chiamate vocali AI', 'Il voicebot conduce ogni conversazione in modo naturale.')}
                ${capRow('icon-doc.png', 'Trascrizione e riassunto', 'Ogni chiamata diventa testo, con sintesi AI dei punti chiave.')}
                ${capRow('icon-bell.png', 'Follow-up automatici', 'Se un cliente va richiamato, ricevi subito un avviso.', true)}
              </table>
              ${note ? `<p style="margin:20px 0 0;font-size:14px;color:#475569;"><strong style="color:#0f172a;">Note:</strong> ${escapeHtml(note)}</p>` : ''}
            </td>
          </tr>
          <tr>
            <td style="padding:28px 40px 36px;text-align:center;">
              <a href="${appUrl}" style="display:inline-block;background:#1e3dc8;color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;padding:15px 40px;border-radius:9px;box-shadow:0 2px 8px rgba(30,61,200,0.3);">Segui gli esiti in tempo reale</a>
              <p style="margin:15px 0 0;font-size:13px;color:#94a3b8;">Risposte, trascrizioni e follow-up compaiono nella dashboard man mano che arrivano.</p>
            </td>
          </tr>
          <tr>
            <td style="background:#060812;padding:22px 40px;text-align:center;">
              <div style="color:#ffffff;font-size:14px;font-weight:600;margin-bottom:3px;">GEM Group</div>
              <div style="color:#6b7699;font-size:12px;line-height:1.6;">Soluzioni di comunicazione e automazione AI su tecnologia Wildix</div>
            </td>
          </tr>
        </table>
      </div>
      `,
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

app.post("/api/campaigns/launch", requireAuth, async (req: any, res) => {
  const { contatti, tipo_campagna, scheduledAt, note, voicebot_id, concurrency } = req.body || {};
  const campaignType = tipo_campagna === "appuntamenti" ? "appuntamenti" : "standard";

  const parsed = parseLaunchContacts(contatti, campaignType === "appuntamenti");
  if ("error" in parsed) return res.status(400).json({ ok: false, error: parsed.error });
  const contacts = parsed.contacts;

  const user = await findSessionUser(req.session.username);
  if (!user) return res.status(401).json({ ok: false, error: "Utente non trovato" });

  let targetAt: string | null = null;
  if (scheduledAt) {
    // Stessa regola del login (canSchedule === true), quindi dell'interfaccia.
    if (user.canSchedule !== true) {
      return res.status(403).json({ ok: false, error: "Non hai il permesso di pianificare campagne" });
    }
    const t = new Date(scheduledAt);
    if (isNaN(t.getTime()) || t.getTime() <= Date.now()) {
      return res.status(400).json({ ok: false, error: "Seleziona un orario futuro" });
    }
    targetAt = t.toISOString();
  }

  // Voicebot: estensione e contesto vengono dalla configurazione salvata,
  // non dal browser, così non si possono indirizzare chiamate altrove.
  const bots = await readVoicebots();
  const bot = voicebot_id ? bots.find((b: any) => b.id === voicebot_id && b.attivo !== false) : null;
  if (voicebot_id && !bot) return res.status(400).json({ ok: false, error: "Voicebot non trovato o disattivato" });

  const chunkSize = Math.min(Math.max(parseInt(concurrency) || 1, 1), 10);
  const chunks: LaunchContact[][] = [];
  for (let i = 0; i < contacts.length; i += chunkSize) chunks.push(contacts.slice(i, i + chunkSize));

  const webhookUrl = campaignType === "appuntamenti" ? MAKE_WEBHOOK_URL_APPUNTAMENTI : MAKE_WEBHOOK_URL_DEFAULT;
  const avviatoIl = new Date().toISOString();
  const cleanNote = cleanText(note, 1000);
  const payloads = chunks.map((chunk, idx) => ({
    contatti: chunk,
    tipo_campagna: campaignType,
    totale: chunk.length,
    avviatoIl,
    scheduledAt: targetAt,
    modalita: targetAt ? "scheduled" : "immediate",
    operatore: user.nome,
    fonte: "gem-dashboard-react",
    note: cleanNote,
    voicebot_nome: bot?.nome,
    voicebot_exten: bot?.exten || 8000,
    voicebot_context: bot?.context || "outbound-voicebot",
    chunk: idx + 1,
    chunks_totali: chunks.length,
  }));

  const dryRun = isCallsDryRun();
  let results: boolean[];
  if (dryRun) {
    console.log(`[DRY-RUN] Lancio simulato: ${contacts.length} contatti in ${chunks.length} blocchi, utente ${user.username}`);
    results = payloads.map(() => true);
  } else {
    results = await runLimited(payloads.map(p => () => postToMake(webhookUrl, p)), MAKE_PARALLEL_REQUESTS);
  }

  const sentContacts = chunks.filter((_, i) => results[i]).flat();
  const failedContacts = chunks.filter((_, i) => !results[i]).flat();

  if (sentContacts.length > 0) {
    // Numero → nome, per mostrare il nome reale negli Esiti Voicebot.
    // In modalità test non si scrive nel database.
    if (!dryRun) await upsertContactNames(sentContacts);
    await sendCampaignEmail({
      operatore: user.nome,
      count: sentContacts.length,
      scheduledAt: targetAt,
      note: cleanNote,
      userEmail: user.email,
      test: dryRun,
    });
  }

  res.json({
    ok: failedContacts.length === 0,
    dryRun,
    sent: sentContacts.length,
    failed: failedContacts.length,
    chunksOk: results.filter(Boolean).length,
    chunksTotal: chunks.length,
    sentContacts,
    failedContacts,
    scheduledAt: targetAt,
  });
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
