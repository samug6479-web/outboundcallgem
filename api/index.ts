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

// ── Più aziende (clienti separati) ──
// Ogni utente, voicebot e dato (chiamate, follow-up, campagne, liste, Non
// chiamare, orari) appartiene a un'azienda. Chi entra vede solo la sua.
// Gli Admin dell'azienda principale (GEM) sono "super-admin": creano le
// aziende e possono guardare quella che vogliono (header X-Azienda).
// I dati di prima, senza azienda, sono di quella principale.
const AZIENDA_PRINCIPALE = "gem";
const aziendaDi = (x: any): string => (typeof x?.azienda === "string" && x.azienda.trim()) || AZIENDA_PRINCIPALE;
interface Azienda { id: string; nome: string; attiva: boolean; webhookChiamate?: string; webhookAppuntamenti?: string; creataAt?: string }

async function leggiAziende(): Promise<Azienda[]> {
  let v: any[] | undefined;
  if (sql) {
    try { v = await leggiDatiConfig("aziende"); } catch (err) { console.error("Errore lettura aziende:", err); }
  }
  const lista: Azienda[] = (v || []).filter((a: any) => a && typeof a.id === "string" && a.id);
  if (!lista.some(a => a.id === AZIENDA_PRINCIPALE)) lista.unshift({ id: AZIENDA_PRINCIPALE, nome: "GEM Group", attiva: true });
  return lista.map(a => ({ ...a, nome: a.nome || a.id, attiva: a.id === AZIENDA_PRINCIPALE ? true : a.attiva !== false }));
}

// Contesto della richiesta, messo da requireAuth.
interface RichiestaAutenticata { session?: SessionPayload; utente?: any; azienda?: string; superAdmin?: boolean }

// Verifica il token e rilegge l'utente a ogni richiesta: ruolo, azienda e
// account eliminati valgono subito, senza aspettare la scadenza del token.
async function requireAuth(req: express.Request & RichiestaAutenticata, res: express.Response, next: express.NextFunction) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ ok: false, error: "Autenticazione richiesta" });
  }
  const session = verifySessionToken(token);
  if (!session) {
    return res.status(401).json({ ok: false, error: "Sessione non valida o scaduta" });
  }
  try {
    const users = await readUsers();
    if (!Array.isArray(users) || users.length === 0) return res.status(503).json({ ok: false, error: "Servizio non disponibile, riprova tra poco" });
    const user = users.find((u: any) => String(u.username).toLowerCase() === String(session.username).toLowerCase());
    if (!user) return res.status(401).json({ ok: false, error: "Utente non più attivo" });
    const az = aziendaDi(user);
    const aziende = await leggiAziende();
    if (!aziende.find(a => a.id === az)?.attiva) return res.status(403).json({ ok: false, error: "L'accesso per la tua azienda è sospeso. Contatta GEM Group." });
    const isAdmin = ruoloDi(user) === "Admin";
    const superAdmin = isAdmin && az === AZIENDA_PRINCIPALE;
    const chiesta = String(req.headers["x-azienda"] || "").trim();
    req.session = { username: user.username, isAdmin };
    req.utente = user;
    req.superAdmin = superAdmin;
    req.azienda = superAdmin && chiesta && aziende.some(a => a.id === chiesta) ? chiesta : az;
    if (sql) await ensureSchemaAziende().catch(err => console.error("Schema aziende:", err));
  } catch (err) {
    console.error("Errore autenticazione:", err);
    return res.status(503).json({ ok: false, error: "Servizio non disponibile, riprova tra poco" });
  }
  next();
}

function requireAdmin(req: express.Request & { session?: SessionPayload }, res: express.Response, next: express.NextFunction) {
  if (!req.session?.isAdmin) {
    return res.status(403).json({ ok: false, error: "Permessi insufficienti (richiesto ruolo Admin)" });
  }
  next();
}

function requireSuperAdmin(req: express.Request & RichiestaAutenticata, res: express.Response, next: express.NextFunction) {
  if (!req.superAdmin) {
    return res.status(403).json({ ok: false, error: "Solo gli Admin di GEM Group" });
  }
  next();
}

// Colonna "azienda" su tutte le tabelle dei dati (una volta per istanza).
// Le tabelle create a mano su Neon (call_results, followups, contact_names,
// access_logs) la ricevono qui; le altre nelle loro funzioni ensure.
let schemaAziendeReady: Promise<void> | null = null;
function ensureSchemaAziende(): Promise<void> {
  if (!schemaAziendeReady) {
    schemaAziendeReady = (async () => {
      for (const t of ["call_results", "followups", "contact_names", "access_logs"]) {
        try {
          await sql!(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS azienda TEXT NOT NULL DEFAULT '${AZIENDA_PRINCIPALE}'`);
        } catch (err) { console.error(`Colonna azienda su ${t}:`, err); }
      }
      try {
        await sql!`CREATE INDEX IF NOT EXISTS idx_followups_azienda ON followups (azienda, stato)`;
        await sql!`CREATE INDEX IF NOT EXISTS idx_call_results_azienda ON call_results (azienda)`;
      } catch (err) { console.error("Indici azienda:", err); }
      // Lo stesso numero può avere un nome diverso in ogni azienda.
      await sql!`CREATE UNIQUE INDEX IF NOT EXISTS uq_contact_names_azienda ON contact_names (azienda, numero)`;
      await togliChiaveSoloNumero("contact_names");
      await ensureFollowupsExtra();
      await ensureLiveSchema();
      await ensureDncSchema();
      await ensureArchivioSchema();
      await ensureScheduleSchema();
      await ensureCampaignLogSchema();
      await ensureEsitiVoicebot();
    })().catch(err => { schemaAziendeReady = null; throw err; });
  }
  return schemaAziendeReady;
}

// Toglie la chiave primaria sul solo "numero" (ora l'unicità è azienda + numero).
async function togliChiaveSoloNumero(tabella: string): Promise<void> {
  const pk = (await sql!`
    SELECT c.conname FROM pg_constraint c
    WHERE c.conrelid = ${tabella}::regclass AND c.contype = 'p' AND array_length(c.conkey, 1) = 1
  `) as any[];
  if (pk[0]?.conname) await sql!(`ALTER TABLE ${tabella} DROP CONSTRAINT "${String(pk[0].conname).replace(/"/g, "")}"`);
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
async function logAccess(username: string, nome: string | undefined, action: "login" | "logout", azienda: string) {
  try {
    await ensureSchemaAziende().catch(() => {});
    await withRetry(() => sql!`
      INSERT INTO access_logs (username, nome, action, azienda)
      VALUES (${username}, ${nome || username}, ${action}, ${azienda})
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

async function readCallResults(azienda: string, limit = 50, offset = 0): Promise<{ rows: any[]; total: number }> {
  try {
    const rows = await sql`
      SELECT * FROM call_results WHERE azienda = ${azienda} ORDER BY ts DESC LIMIT ${limit} OFFSET ${offset}
    `;
    const countRes = await sql`SELECT COUNT(*)::int AS total FROM call_results WHERE azienda = ${azienda}`;
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
      INSERT INTO call_results (call_id, numero, nome, risposto, durata, ts, trascrizione, riassunto, azienda)
      VALUES (${entry.callId}, ${entry.numero}, ${entry.nome || null}, ${entry.risposto}, ${entry.durata}, ${entry.timestamp}, ${entry.trascrizione}, ${entry.riassunto ? JSON.stringify(entry.riassunto) : null}, ${entry.azienda || AZIENDA_PRINCIPALE})
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
async function nomeContatto(numero: string | null, azienda: string): Promise<string | null> {
  if (!sql || !numero) return null;
  try {
    const rows = (await sql`SELECT nome FROM contact_names WHERE numero = ${numero} AND azienda = ${azienda} LIMIT 1`) as any[];
    return rows[0]?.nome || null;
  } catch (err) {
    console.error("Error reading contact_names from Postgres:", err);
    return null;
  }
}

// A quale azienda appartiene una chiamata arrivata da Wildix: quella della
// campagna del sito che ha chiamato il numero (preferendo la campagna con
// l'interno del voicebot citato nell'evento), altrimenti quella del voicebot
// citato, altrimenti la principale.
async function aziendaDellaChiamata(numero: string | null, rawEvent: string): Promise<string> {
  if (sql && numero) {
    try {
      await ensureLiveSchema();
      const r = (await sql`
        SELECT c.azienda, c.voicebot_exten FROM live_calls l JOIN live_campaigns c ON c.id = l.campaign_id
        WHERE l.numero = ${numero} AND l.queued_at > now() - interval '2 days'
        ORDER BY COALESCE(l.inviata_at, l.queued_at) DESC LIMIT 20
      `) as any[];
      const scelta = r.find(x => x.voicebot_exten && rawEvent.includes(`"${x.voicebot_exten}"`)) || r[0];
      if (scelta) return aziendaDi(scelta);
    } catch (err) { console.error("Azienda della chiamata:", err); }
  }
  try {
    const bot = (await readVoicebots()).find((b: any) => b.exten != null && rawEvent.includes(`"${b.exten}"`));
    if (bot) return aziendaDi(bot);
  } catch { /* principale */ }
  return AZIENDA_PRINCIPALE;
}

// Versione "a blocchi": una sola query per tutta la lista (invece di una per
// contatto), con i doppioni rimossi prima dell'inserimento.
async function upsertContactNames(contacts: { numero: string; nome: string }[], azienda: string) {
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
      INSERT INTO contact_names (azienda, numero, nome)
      SELECT ${azienda}, n, nm FROM unnest(${numeri}::text[], ${nomi}::text[]) AS t(n, nm)
      ON CONFLICT (azienda, numero) DO UPDATE SET nome = EXCLUDED.nome
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
async function createFollowup(entry: { callId: string; numero: string | null; nome: string | null; motivo: string; assegnatoA?: string | null; azienda: string }): Promise<boolean> {
  try {
    await ensureFollowupsExtra();
    const r = (await sql`
      INSERT INTO followups (call_id, numero, nome, motivo, assegnato_a, azienda)
      SELECT ${entry.callId}, ${entry.numero}, ${entry.nome}, ${entry.motivo}, ${entry.assegnatoA || null}, ${entry.azienda}
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

// Esito con cui si chiude un follow-up (pulsante Fatto).
const ESITI_FINALI = ["venduto", "appuntamento", "preventivo", "non_interessato", "non_raggiungibile", "altro"];
const ESITO_FINALE_LABEL: Record<string, string> = {
  venduto: "Venduto", appuntamento: "Appuntamento fissato", preventivo: "Preventivo / info inviate",
  non_interessato: "Non interessato", non_raggiungibile: "Non raggiungibile", altro: "Altro",
};
const esitoFinaleValido = (v: any): string | null => (typeof v === "string" && ESITI_FINALI.includes(v) ? v : null);
// Minuti di anticipo del promemoria rispetto all'ora di richiamata.
const PROMEMORIA_ANTICIPO_MIN = 15;

// Follow-up: note e persona assegnata (colonne aggiunte dopo).
let followupsExtraReady: Promise<void> | null = null;
function ensureFollowupsExtra(): Promise<void> {
  if (!followupsExtraReady) {
    followupsExtraReady = (async () => {
      await sql!`ALTER TABLE followups ADD COLUMN IF NOT EXISTS nota TEXT`;
      await sql!`ALTER TABLE followups ADD COLUMN IF NOT EXISTS assegnato_a TEXT`;
      await sql!`ALTER TABLE followups ADD COLUMN IF NOT EXISTS aggiornato_at TIMESTAMPTZ`;
      await sql!`ALTER TABLE followups ADD COLUMN IF NOT EXISTS aggiornato_da TEXT`;
      // Data e ora in cui richiamare, e quando è partito il promemoria.
      await sql!`ALTER TABLE followups ADD COLUMN IF NOT EXISTS richiamare_at TIMESTAMPTZ`;
      await sql!`ALTER TABLE followups ADD COLUMN IF NOT EXISTS promemoria_at TIMESTAMPTZ`;
      // Com'è finita quando è stato chiuso (Fatto).
      await sql!`ALTER TABLE followups ADD COLUMN IF NOT EXISTS esito_finale TEXT`;
      await sql!`ALTER TABLE followups ADD COLUMN IF NOT EXISTS chiuso_at TIMESTAMPTZ`;
      await sql!`ALTER TABLE followups ADD COLUMN IF NOT EXISTS chiuso_da TEXT`;
    })().catch(err => { followupsExtraReady = null; throw err; });
  }
  return followupsExtraReady;
}

// La campagna più recente del sito che ha chiamato questo numero (ultimi giorni).
async function campagnaDelNumero(numero: string | null, azienda: string): Promise<any | null> {
  if (!sql || !numero) return null;
  try {
    await ensureLiveSchema();
    const r = (await sql`
      SELECT c.id, c.username, c.operatore, c.tipo_campagna, c.voicebot_nome, c.azienda, l.nome
      FROM live_calls l JOIN live_campaigns c ON c.id = l.campaign_id
      WHERE l.numero = ${numero} AND c.azienda = ${azienda} AND l.queued_at > now() - make_interval(days => ${CODA_GIORNI_MAX}::int)
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

async function createAutoFollowup(entry: { callId: string; numero: string | null; nome: string | null; motivo: string; azienda: string }) {
  if (!entry.numero) return;
  try {
    await sql`
      INSERT INTO followups (call_id, numero, nome, motivo, azienda)
      SELECT ${entry.callId}, ${entry.numero}, ${entry.nome}, ${entry.motivo}, ${entry.azienda}
      WHERE NOT EXISTS (
        SELECT 1 FROM followups
        WHERE numero = ${entry.numero} AND motivo = ${entry.motivo} AND stato = 'pending' AND azienda = ${entry.azienda}
      )
    `;
  } catch (err) {
    console.error("Error creating auto followup:", err);
  }
}

async function closeAutoFollowups(numero: string | null, motivi: string[], azienda: string) {
  if (!numero || motivi.length === 0) return;
  try {
    await sql`
      UPDATE followups SET stato = 'done'
      WHERE numero = ${numero} AND motivo = ANY(${motivi}::text[]) AND stato = 'pending' AND azienda = ${azienda}
    `;
  } catch (err) {
    console.error("Error closing auto followups:", err);
  }
}

app.get("/api/followups", requireAuth, async (req: any, res) => {
  const stato = (req.query.stato as string) || "pending";
  try {
    await ensureFollowupsExtra().catch(err => console.error("Colonne follow-up:", err));
    const me = req.utente;
    const solo = permessiUtente(me).soloPropriFollowup ? String(req.session.username).toLowerCase() : null;
    const rows = await sql`
      SELECT * FROM followups WHERE stato = ${stato} AND azienda = ${req.azienda}
        AND (${solo}::text IS NULL OR lower(assegnato_a) = ${solo})
      ORDER BY created_at DESC LIMIT 500
    `;
    res.json({ ok: true, followups: rows });
  } catch (err) {
    console.error("Error reading followups:", err);
    res.status(500).json({ ok: false, followups: [] });
  }
});

// Chi può modificare un follow-up: non i Viewer; chi vede solo i propri, solo quelli assegnati a sé.
async function puoModificareFollowup(req: any, res: any, id: number): Promise<boolean> {
  const me = req.utente;
  if (!me) { res.status(401).json({ ok: false, error: "Utente non trovato" }); return false; }
  if (me.role === "Viewer") { res.status(403).json({ ok: false, error: "In sola lettura" }); return false; }
  const r = (await sql!`SELECT assegnato_a FROM followups WHERE id = ${id} AND azienda = ${req.azienda}`) as any[];
  if (!r[0]) { res.status(404).json({ ok: false, error: "Follow-up non trovato" }); return false; }
  if (permessiUtente(me).soloPropriFollowup) {
    if ((r[0].assegnato_a || "").toLowerCase() !== String(req.session.username).toLowerCase()) {
      res.status(403).json({ ok: false, error: "Puoi gestire solo i follow-up assegnati a te" });
      return false;
    }
  }
  return true;
}

// Azioni su più follow-up insieme (Admin ed Editor): assegna a una persona o segna fatti.
// Chi riceve l'assegnazione ha un avviso nel sito per ogni contatto e una sola email riepilogativa.
app.post("/api/followups/bulk", requireAuth, express.json(), async (req: any, res) => {
  const me = req.utente;
  if (!me) return res.status(401).json({ ok: false, error: "Utente non trovato" });
  if (me.role === "Viewer") return res.status(403).json({ ok: false, error: "Non autorizzato" });
  const b = req.body || {};
  const ids = [...new Set((Array.isArray(b.ids) ? b.ids : []).map((x: any) => parseInt(x, 10)).filter((x: number) => x > 0))] as number[];
  if (!sql || ids.length === 0) return res.status(400).json({ ok: false, error: "Nessun follow-up selezionato" });
  if (ids.length > 500) return res.status(400).json({ ok: false, error: "Massimo 500 follow-up per volta" });
  try {
    await ensureFollowupsExtra();
    const diQui = (await sql`SELECT id FROM followups WHERE id = ANY(${ids}::int[]) AND azienda = ${req.azienda}`) as any[];
    if (diQui.length !== ids.length) return res.status(404).json({ ok: false, error: "Alcuni follow-up non esistono più" });
    if (permessiUtente(me).soloPropriFollowup) {
      const miei = (await sql`SELECT id FROM followups WHERE id = ANY(${ids}::int[]) AND lower(assegnato_a) = ${String(req.session.username).toLowerCase()}`) as any[];
      if (miei.length !== ids.length) return res.status(403).json({ ok: false, error: "Puoi gestire solo i follow-up assegnati a te" });
    }
    if (b.azione === "fatto") {
      const esito = esitoFinaleValido(b.esito);
      const r = (await sql`UPDATE followups SET stato = 'done', esito_finale = ${esito}, chiuso_at = now(), chiuso_da = ${req.session.username},
        aggiornato_at = now(), aggiornato_da = ${req.session.username} WHERE id = ANY(${ids}::int[]) AND stato = 'pending' AND azienda = ${req.azienda} RETURNING id`) as any[];
      await registra(req, "followup_chiusi", `${r.length} follow-up${esito ? `, esito ${ESITO_FINALE_LABEL[esito]}` : ""}`);
      return res.json({ ok: true, aggiornati: r.length });
    }
    if (b.azione !== "assegna") return res.status(400).json({ ok: false, error: "Azione non valida" });
    let assegnato: string | null = null;
    if (b.assegnato_a) {
      const u = await utenteDellAzienda(String(b.assegnato_a), req.azienda);
      if (!u) return res.status(400).json({ ok: false, error: "Utente non trovato" });
      assegnato = u.username;
    }
    const messaggio = cleanText(b.messaggio, 500) || null;
    const prima = new Map(((await sql`SELECT id, assegnato_a FROM followups WHERE id = ANY(${ids}::int[])`) as any[]).map(x => [x.id, (x.assegnato_a || "").toLowerCase()]));
    const r = (await sql`
      UPDATE followups SET assegnato_a = ${assegnato}, aggiornato_at = now(), aggiornato_da = ${req.session.username}
      WHERE id = ANY(${ids}::int[]) AND azienda = ${req.azienda} RETURNING *
    `) as any[];
    let avvisato = false;
    if (assegnato && assegnato.toLowerCase() !== String(req.session.username).toLowerCase()) {
      const cambiati = r.filter(x => prima.get(x.id) !== assegnato!.toLowerCase());
      if (cambiati.length) avvisato = await avvisaAssegnazioni(cambiati, assegnato, req.session.username, messaggio);
    }
    await registra(req, "followup_assegnati", `${r.length} follow-up a ${assegnato || "nessuno"}`);
    res.json({ ok: true, aggiornati: r.length, avvisato, followups: r });
  } catch (err) {
    console.error("Errore azione su più follow-up:", err);
    res.status(500).json({ ok: false, error: "Errore aggiornamento" });
  }
});

// Nota e persona assegnata di un follow-up.
app.put("/api/followups/:id", requireAuth, express.json(), async (req: any, res) => {
  const id = parseInt(req.params.id, 10);
  if (!sql || !(id > 0)) return res.status(400).json({ ok: false, error: "Richiesta non valida" });
  if (!(await puoModificareFollowup(req, res, id))) return;
  const body = req.body || {};
  const nota = body.nota === undefined ? undefined : (cleanText(body.nota, 2000) || null);
  let assegnato: string | null | undefined = undefined;
  if (body.assegnato_a !== undefined) {
    if (body.assegnato_a === null || body.assegnato_a === "") assegnato = null;
    else {
      const u = await utenteDellAzienda(String(body.assegnato_a), req.azienda);
      if (!u) return res.status(400).json({ ok: false, error: "Utente non trovato" });
      assegnato = u.username;
    }
  }
  // Data di richiamo: ISO, oppure null/"" per toglierla.
  let richiamare: string | null | undefined = undefined;
  if (body.richiamare_at !== undefined) {
    if (body.richiamare_at === null || body.richiamare_at === "") richiamare = null;
    else {
      const t = new Date(String(body.richiamare_at));
      if (isNaN(t.getTime())) return res.status(400).json({ ok: false, error: "Data di richiamo non valida" });
      richiamare = t.toISOString();
    }
  }
  try {
    await ensureFollowupsExtra();
    const prima = ((await sql`SELECT assegnato_a FROM followups WHERE id = ${id}`) as any[])[0];
    const r = (await sql`
      UPDATE followups SET
        nota = CASE WHEN ${nota !== undefined}::boolean THEN ${nota ?? null} ELSE nota END,
        assegnato_a = CASE WHEN ${assegnato !== undefined}::boolean THEN ${assegnato ?? null} ELSE assegnato_a END,
        promemoria_at = CASE WHEN ${richiamare !== undefined}::boolean AND richiamare_at IS DISTINCT FROM ${richiamare ?? null}::timestamptz THEN NULL ELSE promemoria_at END,
        richiamare_at = CASE WHEN ${richiamare !== undefined}::boolean THEN ${richiamare ?? null}::timestamptz ELSE richiamare_at END,
        aggiornato_at = now(), aggiornato_da = ${req.session.username}
      WHERE id = ${id} AND azienda = ${req.azienda}
      RETURNING *
    `) as any[];
    if (!r[0]) return res.status(404).json({ ok: false, error: "Follow-up non trovato" });
    // Assegnato a un'altra persona: notifica nel sito ed email (se non l'ha disattivata).
    let avvisato = false;
    if (assegnato && (prima?.assegnato_a || "").toLowerCase() !== assegnato.toLowerCase()
        && assegnato.toLowerCase() !== String(req.session.username).toLowerCase()) {
      avvisato = await avvisaAssegnazione(r[0], assegnato, req.session.username);
    }
    if (richiamare) aggiornaSveglia().catch(() => {});
    if (assegnato !== undefined) await registra(req, "followup_assegnato", `${r[0].nome || r[0].numero || "Contatto"} a ${assegnato || "nessuno"}`);
    res.json({ ok: true, followup: r[0], avvisato });
  } catch (err) {
    console.error("Errore aggiornamento follow-up:", err);
    res.status(500).json({ ok: false, error: "Errore aggiornamento" });
  }
});

// ── Notifiche nel sito (per ora: follow-up assegnati) ──
let notificheReady: Promise<void> | null = null;
function ensureNotifiche(): Promise<void> {
  if (!notificheReady) {
    notificheReady = (async () => {
      await sql!`
        CREATE TABLE IF NOT EXISTS notifiche (
          id          SERIAL PRIMARY KEY,
          username    TEXT NOT NULL,
          tipo        TEXT NOT NULL,
          titolo      TEXT NOT NULL,
          testo       TEXT,
          followup_id INT,
          creata_da   TEXT,
          creata_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
          letta_at    TIMESTAMPTZ
        )
      `;
      await sql!`CREATE INDEX IF NOT EXISTS idx_notifiche_utente ON notifiche (username, letta_at, creata_at DESC)`;
    })().catch(err => { notificheReady = null; throw err; });
  }
  return notificheReady;
}

async function preferenzeDi(username: string): Promise<Record<string, any>> {
  try {
    await ensurePreferenze();
    const r = (await sql!`SELECT valore FROM preferenze_utente WHERE username = ${username.toLowerCase()}`) as any[];
    return r[0]?.valore || {};
  } catch { return {}; }
}

// Follow-up assegnato a una persona: notifica nel sito + email.
// Restituisce true se l'email è partita.
async function avvisaAssegnazione(f: any, username: string, daUsername: string): Promise<boolean> {
  const destinatario = await findSessionUser(username).catch(() => null);
  const da = await findSessionUser(daUsername).catch(() => null);
  const daNome = da?.nome || daUsername;
  const chi = f.nome || f.numero || "Contatto";
  const titolo = `${daNome} ti ha assegnato un follow-up: ${chi}`;
  const testo = [f.motivo, f.numero, f.nota].filter(Boolean).join(" · ");
  try {
    await ensureNotifiche();
    // Una sola notifica non letta per follow-up e persona.
    await sql!`DELETE FROM notifiche WHERE username = ${username.toLowerCase()} AND followup_id = ${f.id} AND letta_at IS NULL`;
    await sql!`
      INSERT INTO notifiche (username, tipo, titolo, testo, followup_id, creata_da)
      VALUES (${username.toLowerCase()}, 'followup_assegnato', ${titolo}, ${testo || null}, ${f.id}, ${daNome})
    `;
  } catch (err) {
    console.error("Errore creazione notifica:", err);
  }

  if (!process.env.SMTP_USER) return false;
  const to = destinatario?.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(destinatario.email) ? destinatario.email : null;
  if (!to) return false;
  if ((await preferenzeDi(username)).emailAssegnazioni === false) return false;
  const appUrl = (process.env.APP_URL || "https://outboundcallgem.vercel.app").replace(/\/$/, "");
  const link = `${appUrl}/?tab=followups&miei=1`;
  const nomeDest = (destinatario?.nome || "").split(" ")[0];

  // Riassunto della chiamata e campagna, se ci sono: chi riceve sa già cosa è successo.
  let riassunto: any = null;
  try {
    if (f.call_id) {
      const rr = (await sql!`SELECT riassunto FROM call_results WHERE call_id = ${f.call_id} AND riassunto IS NOT NULL LIMIT 1`) as any[];
      riassunto = leggiRiassunto(rr[0]?.riassunto);
    }
  } catch { /* senza riassunto */ }
  const campagna = await campagnaDelNumero(f.numero, aziendaDi(f)).catch(() => null);
  const testoRiassunto = String(riassunto?.testo || riassunto?.titolo || "").trim();
  const quando = f.created_at
    ? new Date(f.created_at).toLocaleString("it-IT", { timeZone: "Europe/Rome", day: "2-digit", month: "long", hour: "2-digit", minute: "2-digit" })
    : "";

  const dati: [string, string, string?][] = [
    ["Contatto", chi],
    ...(f.numero ? [["Telefono", f.numero, `tel:${f.numero}`] as [string, string, string]] : []),
    ...(f.motivo ? [["Motivo", f.motivo] as [string, string]] : []),
    ...(campagna?.voicebot_nome ? [["Voicebot", campagna.voicebot_nome] as [string, string]] : []),
    ...(quando ? [["Chiamata del", quando] as [string, string]] : []),
    ["Assegnato da", daNome],
  ];
  const righe = dati.map(([k, v, href], i) => {
    const border = i < dati.length - 1 ? "border-bottom:1px solid #eef1f6;" : "";
    const val = href ? `<a href="${escapeHtml(href)}" style="color:#1e3dc8;text-decoration:none;">${escapeHtml(v)}</a>` : escapeHtml(v);
    return `<tr><td style="padding:11px 0;${border}font-size:14px;color:#64748b;width:40%;">${k}</td>
      <td style="padding:11px 0;${border}font-size:14px;color:#0f172a;font-weight:600;text-align:right;">${val}</td></tr>`;
  }).join("");
  const step = (n: number, t: string, d: string) => `<tr>
      <td style="vertical-align:top;width:34px;padding:0 0 14px;"><div style="width:24px;height:24px;line-height:24px;border-radius:999px;background:#e0e7ff;color:#1e3dc8;font-size:12px;font-weight:700;text-align:center;">${n}</div></td>
      <td style="padding:2px 0 14px;font-size:14px;color:#475569;line-height:1.5;"><strong style="color:#0f172a;">${t}</strong> ${d}</td></tr>`;

  const html = `
<div style="background:#eef1f6;padding:28px 12px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e2e8f0;">
  <tr><td style="padding:28px 40px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
    <td><img src="${appUrl}/gem-logo-color.png" width="96" alt="GEM Group" style="display:block;width:96px;height:auto;"></td>
    <td style="text-align:right;"><span style="display:inline-block;background:#e0e7ff;color:#1e3dc8;font-size:12px;font-weight:700;padding:5px 12px;border-radius:999px;">&#9679; Assegnato a te</span></td></tr></table></td></tr>
  <tr><td style="padding:26px 40px 6px;font-size:24px;font-weight:700;color:#0f172a;letter-spacing:-0.3px;">Nuovo follow-up da gestire</td></tr>
  <tr><td style="padding:0 40px 20px;font-size:15px;color:#475569;line-height:1.6;">Ciao${nomeDest ? ` ${escapeHtml(nomeDest)}` : ""}, <strong style="color:#0f172a;">${escapeHtml(daNome)}</strong> ti ha assegnato questo contatto da ricontattare.</td></tr>
  <tr><td style="padding:0 40px 8px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border-radius:10px;"><tr><td style="padding:6px 20px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${righe}</table></td></tr></table></td></tr>
  ${f.nota ? `<tr><td style="padding:12px 40px 0;"><div style="background:#f8fafc;border-left:3px solid #1e3dc8;padding:12px 16px;font-size:14px;color:#475569;line-height:1.5;"><strong style="color:#0f172a;">Nota di ${escapeHtml(daNome)}:</strong> ${escapeHtml(f.nota)}</div></td></tr>` : ""}
  ${testoRiassunto ? `<tr><td style="padding:12px 40px 0;"><div style="background:#f8fafc;border-left:3px solid #94a3b8;padding:12px 16px;font-size:14px;color:#475569;line-height:1.5;"><strong style="color:#0f172a;">Riassunto della chiamata:</strong> ${escapeHtml(testoRiassunto)}</div></td></tr>` : ""}
  <tr><td style="padding:24px 40px 4px;font-size:13px;font-weight:700;color:#0f172a;text-transform:uppercase;letter-spacing:0.6px;">Cosa fare</td></tr>
  <tr><td style="padding:8px 40px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">
    ${step(1, "Richiama il contatto", f.numero ? `al numero <a href="tel:${escapeHtml(f.numero)}" style="color:#1e3dc8;text-decoration:none;font-weight:600;">${escapeHtml(f.numero)}</a>.` : "appena puoi.")}
    ${step(2, "Aggiungi una nota", "nel follow-up con l'esito della telefonata.")}
    ${step(3, "Premi Fatto", "quando il contatto è gestito: sparisce dalla lista Da gestire.")}
  </table></td></tr>
  <tr><td style="padding:12px 40px 34px;"><a href="${link}" style="display:block;background:#1e3dc8;color:#ffffff;text-decoration:none;text-align:center;font-size:15px;font-weight:600;padding:14px 20px;border-radius:9px;">Apri i miei follow-up</a></td></tr>
  <tr><td style="padding:18px 40px;border-top:1px solid #eef1f6;font-size:12px;color:#94a3b8;line-height:1.6;">GEM Group &middot; Soluzioni di comunicazione e automazione AI su tecnologia Wildix<br>Email automatica inviata da GEM Outbound. Puoi disattivarla da Il Mio Profilo &rsaquo; Avvisi.</td></tr>
</table></div>`;

  const text = [
    "Nuovo follow-up da gestire",
    "",
    `Ciao${nomeDest ? ` ${nomeDest}` : ""}, ${daNome} ti ha assegnato questo contatto da ricontattare.`,
    "",
    ...dati.map(([k, v]) => `${k}: ${v}`),
    ...(f.nota ? ["", `Nota di ${daNome}: ${f.nota}`] : []),
    ...(testoRiassunto ? ["", `Riassunto della chiamata: ${testoRiassunto}`] : []),
    "",
    `Apri i miei follow-up: ${link}`,
  ].join("\n");

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
      subject: `Nuovo follow-up per te: ${chi}${f.motivo ? ` · ${f.motivo}` : ""}`,
      text,
      html,
    });
    return true;
  } catch (err) {
    console.error("Errore email assegnazione follow-up:", err);
    return false;
  }
}

// Più follow-up assegnati insieme: un avviso nel sito per ciascuno, una sola email.
async function avvisaAssegnazioni(fs: any[], username: string, daUsername: string, messaggio: string | null): Promise<boolean> {
  if (fs.length === 1 && !messaggio) return avvisaAssegnazione(fs[0], username, daUsername);
  const destinatario = await findSessionUser(username).catch(() => null);
  const da = await findSessionUser(daUsername).catch(() => null);
  const daNome = da?.nome || daUsername;
  try {
    await ensureNotifiche();
    const u = username.toLowerCase();
    const idsF = fs.map(f => f.id);
    await sql!`DELETE FROM notifiche WHERE username = ${u} AND followup_id = ANY(${idsF}::int[]) AND letta_at IS NULL`;
    for (const f of fs) {
      const chi = f.nome || f.numero || "Contatto";
      const testo = [f.motivo, f.numero, messaggio].filter(Boolean).join(" · ");
      await sql!`
        INSERT INTO notifiche (username, tipo, titolo, testo, followup_id, creata_da)
        VALUES (${u}, 'followup_assegnato', ${`${daNome} ti ha assegnato un follow-up: ${chi}`}, ${testo || null}, ${f.id}, ${daNome})
      `;
    }
  } catch (err) {
    console.error("Errore creazione notifiche:", err);
  }

  if (!process.env.SMTP_USER) return false;
  const to = destinatario?.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(destinatario.email) ? destinatario.email : null;
  if (!to) return false;
  if ((await preferenzeDi(username)).emailAssegnazioni === false) return false;
  const appUrl = (process.env.APP_URL || "https://outboundcallgem.vercel.app").replace(/\/$/, "");
  const link = `${appUrl}/?tab=followups&miei=1`;
  const nomeDest = (destinatario?.nome || "").split(" ")[0];
  const n = fs.length;
  const MAX_RIGHE = 25;
  const mostrati = fs.slice(0, MAX_RIGHE);
  const righe = mostrati.map((f, i) => {
    const border = i < mostrati.length - 1 ? "border-bottom:1px solid #eef1f6;" : "";
    const chi = f.nome || f.numero || "Contatto";
    return `<tr>
      <td style="padding:10px 0;${border}font-size:14px;color:#0f172a;font-weight:600;">${escapeHtml(chi)}${f.numero && f.nome ? `<br><a href="tel:${escapeHtml(f.numero)}" style="font-size:13px;color:#1e3dc8;font-weight:500;text-decoration:none;">${escapeHtml(f.numero)}</a>` : ""}</td>
      <td style="padding:10px 0;${border}font-size:13px;color:#64748b;text-align:right;">${escapeHtml(f.motivo || "")}</td></tr>`;
  }).join("");
  const step = (k: number, t: string, d: string) => `<tr>
      <td style="vertical-align:top;width:34px;padding:0 0 14px;"><div style="width:24px;height:24px;line-height:24px;border-radius:999px;background:#e0e7ff;color:#1e3dc8;font-size:12px;font-weight:700;text-align:center;">${k}</div></td>
      <td style="padding:2px 0 14px;font-size:14px;color:#475569;line-height:1.5;"><strong style="color:#0f172a;">${t}</strong> ${d}</td></tr>`;
  const titolo = n === 1 ? "Nuovo follow-up da gestire" : `${n} nuovi follow-up da gestire`;
  const html = `
<div style="background:#eef1f6;padding:28px 12px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e2e8f0;">
  <tr><td style="padding:28px 40px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
    <td><img src="${appUrl}/gem-logo-color.png" width="96" alt="GEM Group" style="display:block;width:96px;height:auto;"></td>
    <td style="text-align:right;"><span style="display:inline-block;background:#e0e7ff;color:#1e3dc8;font-size:12px;font-weight:700;padding:5px 12px;border-radius:999px;">&#9679; Assegnati a te</span></td></tr></table></td></tr>
  <tr><td style="padding:26px 40px 6px;font-size:24px;font-weight:700;color:#0f172a;letter-spacing:-0.3px;">${titolo}</td></tr>
  <tr><td style="padding:0 40px 20px;font-size:15px;color:#475569;line-height:1.6;">Ciao${nomeDest ? ` ${escapeHtml(nomeDest)}` : ""}, <strong style="color:#0f172a;">${escapeHtml(daNome)}</strong> ti ha assegnato ${n === 1 ? "questo contatto" : `questi ${n} contatti`} da ricontattare.</td></tr>
  ${messaggio ? `<tr><td style="padding:0 40px 16px;"><div style="background:#f8fafc;border-left:3px solid #1e3dc8;padding:12px 16px;font-size:14px;color:#475569;line-height:1.5;"><strong style="color:#0f172a;">Messaggio di ${escapeHtml(daNome)}:</strong> ${escapeHtml(messaggio)}</div></td></tr>` : ""}
  <tr><td style="padding:0 40px 8px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border-radius:10px;"><tr><td style="padding:6px 20px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${righe}</table></td></tr></table></td></tr>
  ${n > MAX_RIGHE ? `<tr><td style="padding:4px 40px 0;font-size:13px;color:#64748b;">e altri ${n - MAX_RIGHE}: li trovi tutti nel sito.</td></tr>` : ""}
  <tr><td style="padding:24px 40px 4px;font-size:13px;font-weight:700;color:#0f172a;text-transform:uppercase;letter-spacing:0.6px;">Cosa fare</td></tr>
  <tr><td style="padding:8px 40px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">
    ${step(1, "Richiama i contatti", "partendo da quelli più recenti.")}
    ${step(2, "Aggiungi una nota", "in ogni follow-up con l'esito della telefonata.")}
    ${step(3, "Premi Fatto", "quando un contatto è gestito: sparisce dalla lista Da gestire.")}
  </table></td></tr>
  <tr><td style="padding:12px 40px 34px;"><a href="${link}" style="display:block;background:#1e3dc8;color:#ffffff;text-decoration:none;text-align:center;font-size:15px;font-weight:600;padding:14px 20px;border-radius:9px;">Apri i miei follow-up</a></td></tr>
  <tr><td style="padding:18px 40px;border-top:1px solid #eef1f6;font-size:12px;color:#94a3b8;line-height:1.6;">GEM Group &middot; Soluzioni di comunicazione e automazione AI su tecnologia Wildix<br>Email automatica inviata da GEM Outbound. Puoi disattivarla da Il Mio Profilo &rsaquo; Avvisi.</td></tr>
</table></div>`;
  const text = [
    titolo, "",
    `Ciao${nomeDest ? ` ${nomeDest}` : ""}, ${daNome} ti ha assegnato ${n === 1 ? "questo contatto" : `questi ${n} contatti`} da ricontattare.`,
    ...(messaggio ? ["", `Messaggio di ${daNome}: ${messaggio}`] : []),
    "",
    ...mostrati.map(f => `- ${f.nome || f.numero || "Contatto"}${f.numero && f.nome ? ` (${f.numero})` : ""}${f.motivo ? ` · ${f.motivo}` : ""}`),
    ...(n > MAX_RIGHE ? [`e altri ${n - MAX_RIGHE}`] : []),
    "", `Apri i miei follow-up: ${link}`,
  ].join("\n");
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
      subject: n === 1 ? `Nuovo follow-up per te: ${fs[0].nome || fs[0].numero || "Contatto"}` : `${n} nuovi follow-up per te, da ${daNome}`,
      text,
      html,
    });
    return true;
  } catch (err) {
    console.error("Errore email assegnazione follow-up:", err);
    return false;
  }
}

// Promemoria dei follow-up con data di richiamo: avviso nel sito ed email a chi
// li ha in carico, PROMEMORIA_ANTICIPO_MIN minuti prima. Parte dal timer (sveglia
// Make) e, per sicurezza, anche quando qualcuno apre il sito.
async function inviaPromemoriaFollowup(): Promise<number> {
  if (!sql) return 0;
  try {
    await ensureFollowupsExtra();
    await ensureNotifiche();
    // Si "prende" il promemoria prima di mandarlo: nessun doppione anche con più richieste insieme.
    const dovuti = (await sql`
      UPDATE followups SET promemoria_at = now()
      WHERE id IN (
        SELECT id FROM followups
        WHERE stato = 'pending' AND assegnato_a IS NOT NULL AND promemoria_at IS NULL AND richiamare_at IS NOT NULL
          AND richiamare_at <= now() + make_interval(mins => ${PROMEMORIA_ANTICIPO_MIN}::int)
        ORDER BY richiamare_at LIMIT 200
      ) AND promemoria_at IS NULL
      RETURNING id, nome, numero, motivo, nota, richiamare_at, assegnato_a
    `) as any[];
    if (!dovuti.length) return 0;
    const perUtente = new Map<string, any[]>();
    for (const f of dovuti) {
      const u = String(f.assegnato_a).toLowerCase();
      const ora = new Date(f.richiamare_at).toLocaleString("it-IT", { timeZone: "Europe/Rome", hour: "2-digit", minute: "2-digit" });
      const chi = f.nome || f.numero || "Contatto";
      await sql`DELETE FROM notifiche WHERE username = ${u} AND followup_id = ${f.id} AND tipo = 'followup_promemoria' AND letta_at IS NULL`;
      await sql`
        INSERT INTO notifiche (username, tipo, titolo, testo, followup_id, creata_da)
        VALUES (${u}, 'followup_promemoria', ${`Promemoria: richiamare ${chi} alle ${ora}`}, ${[f.motivo, f.numero, f.nota].filter(Boolean).join(" · ") || null}, ${f.id}, 'promemoria')
      `;
      perUtente.set(u, [...(perUtente.get(u) || []), f]);
    }
    if (process.env.SMTP_USER) {
      const appUrl = (process.env.APP_URL || "https://outboundcallgem.vercel.app").replace(/\/$/, "");
      const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST || "smtp.gmail.com",
        port: parseInt(process.env.SMTP_PORT || "587"),
        secure: process.env.SMTP_SECURE === "true",
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      });
      for (const [u, fs] of perUtente) {
        try {
          const dest = await findSessionUser(u).catch(() => null);
          if (!dest?.email || !EMAIL_VALIDA_RE.test(dest.email)) continue;
          if ((await preferenzeDi(u)).emailAssegnazioni === false) continue;
          const oraDi = (f: any) => new Date(f.richiamare_at).toLocaleString("it-IT", { timeZone: "Europe/Rome", hour: "2-digit", minute: "2-digit" });
          const righe = fs.map((f, i) => {
            const border = i < fs.length - 1 ? "border-bottom:1px solid #eef1f6;" : "";
            return `<tr><td style="padding:10px 0;${border}font-size:14px;color:#0f172a;font-weight:600;">${escapeHtml(f.nome || f.numero || "Contatto")}${f.numero ? `<br><a href="tel:${escapeHtml(f.numero)}" style="font-size:13px;color:#1e3dc8;font-weight:500;text-decoration:none;">${escapeHtml(f.numero)}</a>` : ""}${f.nota ? `<br><span style="font-size:13px;color:#64748b;font-weight:400;">${escapeHtml(f.nota)}</span>` : ""}</td>
              <td style="padding:10px 0;${border}font-size:15px;color:#1e3dc8;font-weight:700;text-align:right;vertical-align:top;">${oraDi(f)}</td></tr>`;
          }).join("");
          const nome = (dest.nome || "").split(" ")[0];
          await transporter.sendMail({
            from: `"GEM Outbound" <${process.env.SMTP_USER}>`,
            to: dest.email,
            subject: fs.length === 1 ? `Promemoria: richiamare ${fs[0].nome || fs[0].numero} alle ${oraDi(fs[0])}` : `Promemoria: ${fs.length} contatti da richiamare`,
            text: [`Ciao${nome ? ` ${nome}` : ""}, è ora di richiamare:`, "", ...fs.map(f => `- ${oraDi(f)} ${f.nome || f.numero}${f.numero && f.nome ? ` (${f.numero})` : ""}${f.nota ? ` · ${f.nota}` : ""}`), "", `${appUrl}/?tab=followups&miei=1`].join("\n"),
            html: `
<div style="background:#eef1f6;padding:28px 12px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e2e8f0;">
  <tr><td style="padding:28px 40px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
    <td><img src="${appUrl}/gem-logo-color.png" width="96" alt="GEM Group" style="display:block;width:96px;height:auto;"></td>
    <td style="text-align:right;"><span style="display:inline-block;background:#ede9fe;color:#5b21b6;font-size:12px;font-weight:700;padding:5px 12px;border-radius:999px;">&#9679; Promemoria</span></td></tr></table></td></tr>
  <tr><td style="padding:26px 40px 6px;font-size:24px;font-weight:700;color:#0f172a;letter-spacing:-0.3px;">${fs.length === 1 ? "È ora di richiamare" : `${fs.length} contatti da richiamare`}</td></tr>
  <tr><td style="padding:0 40px 20px;font-size:15px;color:#475569;line-height:1.6;">Ciao${nome ? ` ${escapeHtml(nome)}` : ""}, ecco ${fs.length === 1 ? "il contatto che hai in programma" : "i contatti che hai in programma"} a breve.</td></tr>
  <tr><td style="padding:0 40px 8px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border-radius:10px;"><tr><td style="padding:6px 20px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${righe}</table></td></tr></table></td></tr>
  <tr><td style="padding:20px 40px 34px;"><a href="${appUrl}/?tab=followups&miei=1" style="display:block;background:#1e3dc8;color:#ffffff;text-decoration:none;text-align:center;font-size:15px;font-weight:600;padding:14px 20px;border-radius:9px;">Apri i miei follow-up</a></td></tr>
  <tr><td style="padding:18px 40px;border-top:1px solid #eef1f6;font-size:12px;color:#94a3b8;line-height:1.6;">GEM Group &middot; Email automatica inviata da GEM Outbound. Puoi disattivarla da Il Mio Profilo &rsaquo; Avvisi.</td></tr>
</table></div>`,
          });
        } catch (err) {
          console.error("Errore email promemoria:", err);
        }
      }
    }
    return dovuti.length;
  } catch (err) {
    console.error("Errore promemoria follow-up:", err);
    return 0;
  }
}
const EMAIL_VALIDA_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Notifiche non lette dell'utente collegato.
app.get("/api/notifiche", requireAuth, async (req: any, res) => {
  if (!sql) return res.json({ ok: true, notifiche: [] });
  try {
    await ensureNotifiche();
    await inviaPromemoriaFollowup();
    const r = (await sql`
      SELECT id, tipo, titolo, testo, followup_id, creata_da, creata_at FROM notifiche
      WHERE username = ${String(req.session.username).toLowerCase()} AND letta_at IS NULL
      ORDER BY creata_at DESC LIMIT 50
    `) as any[];
    res.json({ ok: true, notifiche: r });
  } catch (err) {
    console.error("Errore lettura notifiche:", err);
    res.json({ ok: true, notifiche: [] });
  }
});

// Segna come lette: le notifiche indicate, o tutte.
app.post("/api/notifiche/lette", requireAuth, express.json(), async (req: any, res) => {
  if (!sql) return res.json({ ok: true });
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map((x: any) => parseInt(x, 10)).filter((x: number) => x > 0) : null;
  try {
    await ensureNotifiche();
    const u = String(req.session.username).toLowerCase();
    if (ids && ids.length) await sql`UPDATE notifiche SET letta_at = now() WHERE username = ${u} AND letta_at IS NULL AND id = ANY(${ids}::int[])`;
    else await sql`UPDATE notifiche SET letta_at = now() WHERE username = ${u} AND letta_at IS NULL`;
    res.json({ ok: true });
  } catch (err) {
    console.error("Errore notifiche lette:", err);
    res.status(500).json({ ok: false });
  }
});

// "La mia giornata": i miei follow-up (con le richiamate di oggi e quelle
// scadute), i clienti caldi di oggi, le campagne in corso e i numeri del giorno.
app.get("/api/giornata", requireAuth, async (req: any, res) => {
  if (!sql) return res.json({ ok: true });
  const me = req.utente;
  const az = req.azienda as string;
  const io = String(me.username).toLowerCase();
  const solo = permessiUtente(me).soloPropriFollowup;
  const safe = async <T,>(fn: () => Promise<T>, fb: T): Promise<T> => { try { return await fn(); } catch (err) { console.error("Errore giornata:", err); return fb; } };
  try {
    await ensureFollowupsExtra();
    await inviaPromemoriaFollowup();
    conservazioneSeServe().catch(() => {});
    const inizioGiorno = ((await sql`SELECT (date_trunc('day', now() AT TIME ZONE 'Europe/Rome') AT TIME ZONE 'Europe/Rome') AS t`) as any[])[0].t;
    const fineGiorno = new Date(new Date(inizioGiorno).getTime() + 86_400_000).toISOString();
    const miei = await safe(async () => (await sql`
      SELECT id, nome, numero, motivo, nota, richiamare_at, created_at FROM followups
      WHERE stato = 'pending' AND lower(assegnato_a) = ${io} AND azienda = ${az}
      ORDER BY richiamare_at ASC NULLS LAST, created_at DESC LIMIT 200`) as any[], [] as any[]);
    const scaduti = miei.filter(f => f.richiamare_at && new Date(f.richiamare_at).getTime() < Date.now());
    const oggi = miei.filter(f => f.richiamare_at && new Date(f.richiamare_at).getTime() >= Date.now() && new Date(f.richiamare_at).getTime() < new Date(fineGiorno).getTime());
    const senzaData = miei.filter(f => !f.richiamare_at);
    const caldi = await safe(async () => (await sql`
      SELECT id, nome, numero, motivo, assegnato_a, created_at FROM followups
      WHERE created_at >= ${inizioGiorno} AND motivo IN ('Cliente interessato', 'Appuntamento fissato') AND azienda = ${az}
        AND (${solo}::boolean = false OR lower(assegnato_a) = ${io})
      ORDER BY created_at DESC LIMIT 20`) as any[], [] as any[]);
    const daAssegnare = solo || me.role === "Viewer" ? 0 : await safe(async () => ((await sql`
      SELECT count(*)::int AS n FROM followups WHERE stato = 'pending' AND assegnato_a IS NULL AND azienda = ${az}`) as any[])[0]?.n || 0, 0);
    await ensureLiveSchema();
    const campagne = await safe(async () => (await sql`
      SELECT c.id, c.voicebot_nome, c.operatore, c.tipo_campagna, c.created_at, c.in_pausa, count(*)::int AS totale,
        count(*) FILTER (WHERE l.stato NOT IN ('in_coda', 'avviata'))::int AS gestite,
        count(*) FILTER (WHERE l.stato = 'risposta')::int AS risposte
      FROM live_campaigns c JOIN live_calls l ON l.campaign_id = c.id
      WHERE c.fermata_at IS NULL AND c.azienda = ${az} AND c.created_at > now() - make_interval(days => ${CODA_GIORNI_MAX}::int)
      GROUP BY c.id HAVING count(*) FILTER (WHERE l.stato IN ('in_coda', 'avviata')) > 0
      ORDER BY c.created_at DESC LIMIT 10`) as any[], [] as any[]);
    const numeri = await safe(async () => ((await sql`
      SELECT count(*) FILTER (WHERE stato IN ('risposta', 'interrotta', 'non_risposta', 'non_partita', 'errore'))::int AS chiamate,
             count(*) FILTER (WHERE stato = 'risposta')::int AS risposte
      FROM live_calls WHERE updated_at >= ${inizioGiorno} AND azienda = ${az}`) as any[])[0] || { chiamate: 0, risposte: 0 }, { chiamate: 0, risposte: 0 });
    const chiusiOggi = await safe(async () => ((await sql`
      SELECT count(*)::int AS n FROM followups WHERE stato = 'done' AND chiuso_at >= ${inizioGiorno} AND lower(chiuso_da) = ${io} AND azienda = ${az}`) as any[])[0]?.n || 0, 0);
    const users = await utentiDellAzienda(az).catch(() => [] as any[]);
    const nomeDi = (u?: string | null) => (u ? users.find((x: any) => x.username.toLowerCase() === u.toLowerCase())?.nome || u : null);
    res.json({
      ok: true,
      followup: { totale: miei.length, scaduti, oggi, senzaData: senzaData.slice(0, 10), senzaDataTotale: senzaData.length, chiusiOggi },
      caldi: caldi.map(c => ({ ...c, assegnato_nome: nomeDi(c.assegnato_a) })),
      daAssegnare,
      campagne,
      numeri: { ...numeri, caldi: caldi.length },
    });
  } catch (err) {
    console.error("Errore /api/giornata:", err);
    res.status(500).json({ ok: false, error: "Errore caricamento" });
  }
});

// ── Consumi (per la fatturazione), solo Admin ──
// Per un mese: chiamate partite, risposte e minuti di conversazione delle campagne
// del sito, per campagna, voicebot, operatore e giorno. "Minuti fatturabili" =
// ogni chiamata con conversazione arrotondata al minuto superiore.
app.get("/api/consumi", requireAuth, requireAdmin, async (req: any, res) => {
  if (!sql) return res.json({ ok: true, mesi: [], campagne: [] });
  const az = req.azienda as string;
  const mese = /^\d{4}-\d{2}$/.test(String(req.query.mese || "")) ? String(req.query.mese)
    : new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Rome" }).slice(0, 7);
  try {
    await ensureLiveSchema();
    const da = ((await sql`SELECT (${mese + "-01"}::date::timestamp AT TIME ZONE 'Europe/Rome') AS t`) as any[])[0].t;
    const a = ((await sql`SELECT ((${mese + "-01"}::date + interval '1 month')::timestamp AT TIME ZONE 'Europe/Rome') AS t`) as any[])[0].t;
    const righe = (await sql`
      SELECT c.id, c.created_at, c.operatore, c.tipo_campagna, COALESCE(c.voicebot_nome, 'Voicebot predefinito') AS voicebot,
        to_char(l.updated_at AT TIME ZONE 'Europe/Rome', 'YYYY-MM-DD') AS giorno,
        count(*) FILTER (WHERE l.stato IN ('risposta', 'interrotta', 'non_risposta', 'non_partita', 'errore'))::int AS partite,
        count(*) FILTER (WHERE l.stato IN ('risposta', 'interrotta'))::int AS risposte,
        COALESCE(sum(l.durata_ms) FILTER (WHERE l.stato IN ('risposta', 'interrotta') AND l.durata_ms > 0), 0)::bigint AS ms,
        COALESCE(sum(ceil(l.durata_ms / 60000.0)) FILTER (WHERE l.stato IN ('risposta', 'interrotta') AND l.durata_ms > 0), 0)::int AS minuti_fatt
      FROM live_calls l JOIN live_campaigns c ON c.id = l.campaign_id
      WHERE l.updated_at >= ${da} AND l.updated_at < ${a} AND c.azienda = ${az}
      GROUP BY c.id, giorno
    `) as any[];
    const somma = (rs: any[]) => rs.reduce((t, r) => ({
      partite: t.partite + r.partite, risposte: t.risposte + r.risposte,
      minuti: t.minuti + Number(r.ms) / 60000, minutiFatturabili: t.minutiFatturabili + r.minuti_fatt,
    }), { partite: 0, risposte: 0, minuti: 0, minutiFatturabili: 0 });
    const gruppo = (chiave: (r: any) => string) => {
      const m = new Map<string, any[]>();
      for (const r of righe) m.set(chiave(r), [...(m.get(chiave(r)) || []), r]);
      return [...m.entries()].map(([k, rs]) => ({ chiave: k, ...somma(rs) }));
    };
    const campagne = (() => {
      const m = new Map<number, any[]>();
      for (const r of righe) m.set(r.id, [...(m.get(r.id) || []), r]);
      return [...m.values()].map(rs => ({
        id: rs[0].id, creata: rs[0].created_at, operatore: rs[0].operatore, voicebot: rs[0].voicebot,
        tipo: rs[0].tipo_campagna, ...somma(rs),
      })).sort((x, y) => new Date(y.creata).getTime() - new Date(x.creata).getTime());
    })();
    // Chiamate del voicebot fuori dalle campagne del sito (prove, appuntamenti lanciati altrove).
    const altre = await (async () => {
      try {
        const r = ((await sql`
          SELECT count(*)::int AS chiamate, count(*) FILTER (WHERE risposto)::int AS risposte,
            COALESCE(sum(durata) FILTER (WHERE durata > 0), 0)::bigint AS ms
          FROM call_results r
          WHERE r.ts::timestamptz >= ${da} AND r.ts::timestamptz < ${a} AND r.azienda = ${az}
            AND NOT EXISTS (SELECT 1 FROM live_calls l WHERE l.call_id IS NOT NULL AND l.call_id = r.call_id)
        `) as any[])[0];
        return { chiamate: r.chiamate, risposte: r.risposte, minuti: Number(r.ms) / 60000 };
      } catch { return { chiamate: 0, risposte: 0, minuti: 0 }; }
    })();
    const mesi = ((await sql`
      SELECT DISTINCT to_char(created_at AT TIME ZONE 'Europe/Rome', 'YYYY-MM') AS m FROM live_campaigns WHERE azienda = ${az} ORDER BY 1 DESC LIMIT 24
    `) as any[]).map(r => r.m);
    if (!mesi.includes(mese)) mesi.unshift(mese);
    // Super-admin: lo stesso mese per ogni azienda, per fatturare i clienti.
    let perAzienda: any[] | undefined;
    if (req.superAdmin) {
      const aziende = await leggiAziende();
      const pa = (await sql`
        SELECT c.azienda,
          count(*) FILTER (WHERE l.stato IN ('risposta', 'interrotta', 'non_risposta', 'non_partita', 'errore'))::int AS partite,
          count(*) FILTER (WHERE l.stato IN ('risposta', 'interrotta'))::int AS risposte,
          COALESCE(sum(l.durata_ms) FILTER (WHERE l.stato IN ('risposta', 'interrotta') AND l.durata_ms > 0), 0)::bigint AS ms,
          COALESCE(sum(ceil(l.durata_ms / 60000.0)) FILTER (WHERE l.stato IN ('risposta', 'interrotta') AND l.durata_ms > 0), 0)::int AS minuti_fatt
        FROM live_calls l JOIN live_campaigns c ON c.id = l.campaign_id
        WHERE l.updated_at >= ${da} AND l.updated_at < ${a}
        GROUP BY c.azienda
      `) as any[];
      perAzienda = aziende.map(x => {
        const r = pa.find(y => y.azienda === x.id);
        return { id: x.id, chiave: x.nome, attiva: x.attiva, partite: r?.partite || 0, risposte: r?.risposte || 0, minuti: Number(r?.ms || 0) / 60000, minutiFatturabili: r?.minuti_fatt || 0 };
      }).sort((x, y) => y.minutiFatturabili - x.minutiFatturabili);
    }
    res.json({
      perAzienda,
      ok: true, mese, mesi,
      totale: somma(righe),
      perVoicebot: gruppo(r => r.voicebot).sort((x, y) => y.minuti - x.minuti),
      perOperatore: gruppo(r => r.operatore || "—").sort((x, y) => y.minuti - x.minuti),
      perGiorno: gruppo(r => r.giorno).sort((x, y) => x.chiave.localeCompare(y.chiave)),
      campagne,
      altre,
    });
  } catch (err) {
    console.error("Errore /api/consumi:", err);
    res.status(500).json({ ok: false, error: "Errore caricamento consumi" });
  }
});

// ── Tracce voicebot Wildix (solo lettura) ─────────────────────────────
// Stato, uso e costo reale di ogni sessione del voicebot, letti dalle API
// Wildix. Solo per GEM: le aziende con un loro centralino non passano da qui.
const WILDIX_API_URL = (process.env.WILDIX_API_URL || "https://gem.wildixin.com").replace(/\/$/, "");

async function wildixGet(path: string): Promise<any> {
  const token = process.env.WILDIX_API_TOKEN;
  if (!token) throw Object.assign(new Error("WILDIX_API_TOKEN non configurato"), { status: 503 });
  const r = await fetch(`${WILDIX_API_URL}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw Object.assign(new Error(`Wildix ha risposto ${r.status}`), { status: r.status === 404 ? 404 : 502 });
  return r.json();
}

app.get("/api/wildix/tracce", requireAuth, requireAdmin, async (req: any, res) => {
  if (req.azienda !== AZIENDA_PRINCIPALE) return res.status(403).json({ ok: false, error: "Non disponibile" });
  try {
    const search = typeof req.query.search === "string" ? req.query.search.slice(0, 100) : "";
    const data = await wildixGet(`/v2/voicebots/traces${search ? `?search=${encodeURIComponent(search)}` : ""}`);
    const lista: any[] = Array.isArray(data) ? data : data?.traces || data?.items || [];
    res.json({
      ok: true,
      tracce: lista.slice(0, 200).map(t => ({
        sessionId: t.sessionId, botName: t.botName, callerName: t.callerName, callerNumber: t.callerNumber,
        language: t.language, status: t.status, createdAt: t.createdAt || t.startedAt || null,
      })),
    });
  } catch (err: any) {
    console.error("Errore /api/wildix/tracce:", err.message);
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

app.get("/api/wildix/tracce/:sessionId", requireAuth, requireAdmin, async (req: any, res) => {
  if (req.azienda !== AZIENDA_PRINCIPALE) return res.status(403).json({ ok: false, error: "Non disponibile" });
  try {
    const data = await wildixGet(`/v2/voicebots/traces/${encodeURIComponent(req.params.sessionId)}`);
    const t = data?.trace || data;
    res.json({ ok: true, usage: t?.usage ?? null, cost: t?.cost ?? null, activities: (t?.activities || []).slice(0, 200) });
  } catch (err: any) {
    console.error("Errore /api/wildix/tracce/:id:", err.message);
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

// Nomi degli utenti (per assegnare i follow-up). Niente dati riservati.
app.get("/api/utenti/nomi", requireAuth, async (req: any, res) => {
  const users = await utentiDellAzienda(req.azienda);
  res.json({ ok: true, utenti: users.map((u: any) => ({ username: u.username, nome: u.nome || u.username })) });
});

app.post("/api/followups/:id/done", requireAuth, express.json(), async (req, res) => {
  const fid = parseInt(req.params.id, 10);
  if (!sql || !(fid > 0)) return res.status(400).json({ ok: false });
  if (!(await puoModificareFollowup(req, res, fid))) return;
  try {
    await ensureFollowupsExtra();
    const esito = esitoFinaleValido(req.body?.esito);
    const user = (req as any).session.username;
    await sql`UPDATE followups SET stato = 'done', esito_finale = ${esito}, chiuso_at = now(), chiuso_da = ${user},
      aggiornato_at = now(), aggiornato_da = ${user} WHERE id = ${fid} AND azienda = ${(req as any).azienda}`;
    await registra(req, "followup_chiuso", `Follow-up ${fid}${esito ? `, esito ${ESITO_FINALE_LABEL[esito]}` : ""}`);
    res.json({ ok: true });
  } catch (err) {
    console.error("Error updating followup:", err);
    res.status(500).json({ ok: false });
  }
});

// ── Statistiche aggregate sui risultati del voicebot ──
app.get("/api/voicebot-stats", requireAuth, async (req: any, res) => {
  try {
    const totals = await sql`
      SELECT
        COUNT(*)::int AS totale,
        COUNT(*) FILTER (WHERE risposto = true)::int AS risposte,
        COUNT(*) FILTER (WHERE risposto = false)::int AS non_risposte,
        AVG(durata) FILTER (WHERE durata > 0)::int AS durata_media_ms
      FROM call_results WHERE azienda = ${req.azienda}
    `;
    const perGiorno = await sql`
      SELECT DATE(ts) AS giorno, COUNT(*)::int AS totale
      FROM call_results
      WHERE ts > now() - interval '30 days' AND azienda = ${req.azienda}
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
app.get("/api/stats", requireAuth, async (req: any, res) => {
  const az = req.azienda as string;
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

    // Com'è finita: follow-up chiusi nel periodo, per esito e per persona.
    const esitiFollowup = await safe(async () => {
      await ensureFollowupsExtra();
      const righe = (await sql`
        SELECT COALESCE(esito_finale, 'non_indicato') AS esito, lower(COALESCE(chiuso_da, '')) AS chi, COUNT(*)::int AS n
        FROM followups WHERE stato = 'done' AND chiuso_at >= ${da} AND azienda = ${az}
        GROUP BY 1, 2`) as any[];
      const users = await utentiDellAzienda(az).catch(() => [] as any[]);
      const nomeDi = (u: string) => users.find((x: any) => x.username.toLowerCase() === u)?.nome || u || "—";
      const perEsito = new Map<string, number>();
      const perPersona = new Map<string, { chiusi: number; positivi: number }>();
      for (const r of righe) {
        perEsito.set(r.esito, (perEsito.get(r.esito) || 0) + r.n);
        const p = perPersona.get(r.chi) || { chiusi: 0, positivi: 0 };
        p.chiusi += r.n;
        if (["venduto", "appuntamento"].includes(r.esito)) p.positivi += r.n;
        perPersona.set(r.chi, p);
      }
      const totale = [...perEsito.values()].reduce((a, b) => a + b, 0);
      const positivi = (perEsito.get("venduto") || 0) + (perEsito.get("appuntamento") || 0);
      return {
        totale, positivi,
        perEsito: [...ESITI_FINALI, "non_indicato"].map(e => ({ esito: e, label: ESITO_FINALE_LABEL[e] || "Non indicato", n: perEsito.get(e) || 0 })).filter(x => x.n > 0),
        perPersona: [...perPersona.entries()].map(([u, v]) => ({ persona: nomeDi(u), ...v })).sort((a, b) => b.chiusi - a.chiusi),
      };
    }, { totale: 0, positivi: 0, perEsito: [], perPersona: [] });

    const [chiamate, perGiorno, followupAperti, campagne, perOperatore, pianificateInAttesa] = await Promise.all([
      safe(async () => ((await sql`
        SELECT COUNT(*)::int AS totale,
               COUNT(*) FILTER (WHERE risposto = true)::int AS risposte,
               COUNT(*) FILTER (WHERE risposto = false)::int AS non_risposte,
               AVG(durata) FILTER (WHERE durata > 0)::int AS durata_media_ms
        FROM call_results WHERE ts >= ${da} AND azienda = ${az}`) as any[])[0] || empty, empty),
      safe(async () => (await sql`
        SELECT to_char(DATE(ts AT TIME ZONE 'Europe/Rome'), 'YYYY-MM-DD') AS giorno,
               COUNT(*) FILTER (WHERE risposto = true)::int AS risposte,
               COUNT(*) FILTER (WHERE risposto = false)::int AS non_risposte
        FROM call_results WHERE ts >= ${da} AND azienda = ${az}
        GROUP BY 1 ORDER BY 1`) as any[], [] as any[]),
      safe(async () => (await sql`
        SELECT motivo, COUNT(*)::int AS totale FROM followups
        WHERE stato = 'pending' AND azienda = ${az} GROUP BY motivo ORDER BY totale DESC`) as any[], [] as any[]),
      safe(async () => ((await sql`
        SELECT COUNT(*)::int AS campagne,
               COALESCE(SUM(sent_count), 0)::int AS contatti,
               COUNT(*) FILTER (WHERE mode = 'immediate')::int AS immediate,
               COUNT(*) FILTER (WHERE mode = 'scheduled')::int AS pianificate
        FROM campaign_log WHERE created_at >= ${da} AND dry_run = false AND azienda = ${az}`) as any[])[0] || null, null),
      safe(async () => (await sql`
        SELECT COALESCE(operatore, username) AS operatore,
               COUNT(*)::int AS campagne,
               COALESCE(SUM(sent_count), 0)::int AS contatti
        FROM campaign_log WHERE created_at >= ${da} AND dry_run = false AND azienda = ${az}
        GROUP BY 1 ORDER BY contatti DESC`) as any[], [] as any[]),
      safe(async () => ((await sql`
        SELECT COUNT(*)::int AS n FROM scheduled_campaigns WHERE status = 'pending' AND azienda = ${az}`) as any[])[0]?.n ?? 0, 0),
    ]);

    const logStart = await safe(async () => ((await sql`SELECT MIN(created_at) AS inizio FROM campaign_log WHERE azienda = ${az}`) as any[])[0]?.inizio ?? null, null);

    // Confronto tra voicebot e tra fasce orarie, dalle chiamate delle campagne del sito.
    const confronto = await safe(async () => {
      await ensureLiveSchema();
      await ensureEsitiVoicebot();
      const righe = (await sql`
        SELECT COALESCE(c.voicebot_nome, 'Voicebot predefinito') AS voicebot, l.stato, l.durata_ms,
               extract(hour FROM l.updated_at AT TIME ZONE 'Europe/Rome')::int AS ora,
               r.riassunto, r.trascrizione, l.esito_manuale,
               (SELECT e.esito FROM voicebot_esiti e WHERE e.live_call_id = l.id ORDER BY e.id LIMIT 1) AS lead_esito
        FROM live_calls l
        JOIN live_campaigns c ON c.id = l.campaign_id
        LEFT JOIN call_results r ON r.call_id = l.call_id
        WHERE l.updated_at >= ${da} AND c.azienda = ${az} AND l.stato IN ('risposta', 'interrotta', 'non_risposta', 'non_partita')
        LIMIT 50000
      `) as any[];
      const vuoto = () => ({ chiamate: 0, risposte: 0, interrotte: 0, nonRaggiunte: 0, interessati: 0, durataTot: 0, durataN: 0 });
      const perBot = new Map<string, ReturnType<typeof vuoto>>();
      const perOra = new Map<number, ReturnType<typeof vuoto>>();
      for (const r of righe) {
        const ec = esitoCommercialeChiamata(r);
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
      esitiFollowup,
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
  await upsertContactNames(contacts, (req as any).azienda);
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
      await ensureSchemaAziende().catch(err => console.error("Schema aziende:", err));

      if (event.type === "call:completed") {
        const flow = event.data?.flows?.[0] || {};
        // remotePhone è il vero numero esterno per chiamate outbound reali;
        // callee.phone/destination possono essere un'estensione interna
        // (es. nei test diretti su un interno del voicebot).
        const numero = normalizePhone(flow.remotePhone || flow.callee?.phone || event.data?.destination || null);
        const risposto = (flow.talkTime || 0) > 0;
        const az = await aziendaDellaChiamata(numero, rawBody);
        const nome = await nomeContatto(numero, az);

        await upsertCallResult({
          callId: event.id,
          numero,
          nome,
          risposto,
          durata: flow.talkTime || 0,
          timestamp: new Date(event.time).toISOString(),
          trascrizione: null,
          azienda: az,
        });

        const durataMs = flow.talkTime || 0;
        await markLiveCallCompleted(numero, risposto, durataMs, event.id, rawBody);
        if (!risposto) {
          await createAutoFollowup({ callId: event.id, numero, nome, motivo: MOTIVO_NON_RISPOSTO, azienda: az });
        } else if (durataMs < INTERRUPTED_CALL_MAX_MS) {
          // Ha risposto, quindi l'eventuale "Non risposto" è superato
          await closeAutoFollowups(numero, [MOTIVO_NON_RISPOSTO], az);
          await createAutoFollowup({ callId: event.id, numero, nome, motivo: MOTIVO_INTERROTTA, azienda: az });
        } else {
          await closeAutoFollowups(numero, [MOTIVO_NON_RISPOSTO, MOTIVO_INTERROTTA], az);
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
        const az = await aziendaDellaChiamata(numero, rawBody);

        await upsertCallResult({
          callId,
          numero,
          azienda: az,
          nome: await nomeContatto(numero, az),
          risposto: (event.data?.call?.talkTime || 0) > 0,
          durata: event.data?.call?.talkTime || null,
          timestamp: new Date().toISOString(),
          trascrizione,
        });
      }

      if (event.type === "call:summary:completed") {
        const callId = event.id || event.data?.call?.id;
        const numero = normalizePhone(event.data?.call?.remotePhone || event.data?.call?.destination || null);
        const az = await aziendaDellaChiamata(numero, rawBody);
        const nome = await nomeContatto(numero, az);
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
          azienda: az,
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
          await createFollowup({ callId, numero, nome, motivo: motivoFollowup, azienda: az });
        }

        // ── Esito commerciale (campagne standard del sito) ──
        const campagna = await campagnaDelNumero(numero, az);
        const esitoComm = classificaEsitoCommerciale(riassunto);
        if (esitoComm === "non_chiamare" && numero) {
          // Ha chiesto di non essere più chiamato: entra nella lista "Non chiamare".
          await aggiungiNonChiamare([{ numero, nome: nome || campagna?.nome }], "Chiesto durante la chiamata con il voicebot", "wilma", null, az)
            .catch(err => console.error("Errore aggiunta Non chiamare da Wilma:", err));
        }
        // Se Wilma ha già salvato l'esito con salva_lead, il follow-up è già stato creato da lì.
        let haLead = false;
        if (numero) {
          try {
            await ensureEsitiVoicebot();
            haLead = ((await sql`SELECT 1 FROM voicebot_esiti WHERE numero = ${numero} AND cliente = ${az} AND ricevuto_at > now() - interval '2 hours' LIMIT 1`) as any[]).length > 0;
          } catch { /* senza tabella si procede come prima */ }
        }
        if (campagna && campagna.tipo_campagna !== "appuntamenti" && !motivoFollowup && !haLead) {
          const nomeContatto = nome || campagna.nome || null;
          const motivoComm = esitoComm === "appuntamento" ? "Appuntamento fissato"
            : esitoComm === "interessato" ? "Cliente interessato"
            : esitoComm === "richiamare" ? "Da richiamare (chiesto dal cliente)" : null;
          if (motivoComm) {
            const nuovo = await createFollowup({ callId, numero, nome: nomeContatto, motivo: motivoComm, assegnatoA: campagna.username || null, azienda: az });
            if (nuovo && (esitoComm === "appuntamento" || esitoComm === "interessato")) {
              await notificaClienteCaldo({ numero, nome: nomeContatto, esito: esitoComm, riassunto, campagna });
            }
          }
        }
        // È arrivato un riassunto: forse una campagna aspettava solo questo.
        await controllaFineCampagne();

        // ── Notifica: qualsiasi esito che richiede un operatore ──
        const destIntervento = az === AZIENDA_PRINCIPALE
          ? (process.env.NOTIFY_EMAIL || "")
          : (await utentiDellAzienda(az)).filter((u: any) => ruoloDi(u) === "Admin" && u.email && EMAIL_VALIDA_RE.test(u.email)).map((u: any) => u.email).join(", ");
        if (motivoFollowup && process.env.SMTP_USER && destIntervento) {
          try {
            const transporter = nodemailer.createTransport({
              host: process.env.SMTP_HOST || "smtp.gmail.com",
              port: parseInt(process.env.SMTP_PORT || "587"),
              secure: process.env.SMTP_SECURE === "true",
              auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
            });
            await transporter.sendMail({
              from: `"GEM Voicebot Alert" <${process.env.SMTP_USER}>`,
              to: destIntervento,
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
  const { rows, total } = await readCallResults((req as any).azienda, limit, offset);
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
// Cache breve: utenti e aziende si leggono a ogni richiesta (requireAuth).
// Si restituisce sempre una copia, così chi modifica la lista non tocca la cache.
const DATI_CONFIG_CACHE_MS = 3000;
const datiConfigCache = new Map<string, { v: any[] | undefined; t: number }>();
async function leggiDatiConfig(chiave: string): Promise<any[] | undefined> {
  const c = datiConfigCache.get(chiave);
  if (c && Date.now() - c.t < DATI_CONFIG_CACHE_MS) return c.v === undefined ? undefined : structuredClone(c.v);
  await ensureDatiConfig();
  const r = (await withRetry(() => sql!`SELECT valore FROM dati_config WHERE chiave = ${chiave}`)) as any[];
  let v: any[] | undefined = undefined;
  if (r[0]) {
    const x = typeof r[0].valore === "string" ? JSON.parse(r[0].valore) : r[0].valore;
    v = Array.isArray(x) ? x : [];
  }
  datiConfigCache.set(chiave, { v, t: Date.now() });
  return v === undefined ? undefined : structuredClone(v);
}

async function scriviDatiConfig(chiave: string, valore: any[]): Promise<void> {
  datiConfigCache.delete(chiave);
  await ensureDatiConfig();
  await withRetry(() => sql!`
    INSERT INTO dati_config (chiave, valore, aggiornato_at) VALUES (${chiave}, ${JSON.stringify(valore)}::jsonb, now())
    ON CONFLICT (chiave) DO UPDATE SET valore = EXCLUDED.valore, aggiornato_at = now()
  `);
  datiConfigCache.delete(chiave);
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

// Azienda dell'utente, per l'interfaccia (nome nel menu, scelta azienda dei super-admin).
async function infoAzienda(user: any) {
  const az = aziendaDi(user);
  const a = (await leggiAziende()).find(x => x.id === az);
  return { azienda: az, aziendaNome: a?.nome || az, aziendaAttiva: !!a?.attiva, superAdmin: ruoloDi(user) === "Admin" && az === AZIENDA_PRINCIPALE };
}

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
  const infoAz = await infoAzienda(user);
  if (!infoAz.aziendaAttiva) return res.status(403).json({ ok: false, error: "L'accesso per la tua azienda è sospeso. Contatta GEM Group." });

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
    await logAccess(user.username, user.nome, "login", aziendaDi(user));
    return res.json({
      ok: true,
      token,
      ...infoAz,
      username: user.username,
      nome: user.nome,
      role,
      isAdmin,
      canSchedule: user.canSchedule === true,
      email: user.email || "",
      telefono: user.telefono || "",
      ...permessiUtente(user),
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
  const infoAz = await infoAzienda(user);
  if (!infoAz.aziendaAttiva) return res.status(403).json({ ok: false, error: "L'accesso per la tua azienda è sospeso. Contatta GEM Group." });
  const token = issueSessionToken({ username: user.username, isAdmin });
  await logAccess(user.username, user.nome, "login", aziendaDi(user));

  res.json({
    ok: true,
    token,
    ...infoAz,
    username: user.username,
    nome: user.nome,
    role,
    isAdmin,
    canSchedule: user.canSchedule === true,
    email: user.email || "",
    telefono: user.telefono || "",
    ...permessiUtente(user),
    twoFactorEnabled: true,
    twoFactorRequired: true,
  });
});

app.get("/api/users", requireAuth, requireAdmin, async (req: any, res) => {
  const users = await utentiDellAzienda(req.azienda);
  // Ultimo accesso e follow-up aperti assegnati: aiutano l'Admin a capire chi usa il sito.
  const accessi = new Map<string, string>();
  const followup = new Map<string, number>();
  const inviti = new Set<string>();
  if (sql) {
    try {
      await ensureInviti();
      for (const r of (await sql`SELECT DISTINCT lower(username) AS u FROM inviti WHERE usato_at IS NULL AND scade_at > now() AND tipo = 'invito'`) as any[]) inviti.add(r.u);
    } catch { /* niente */ }
    try {
      for (const r of (await sql`SELECT lower(username) AS u, max(ts) AS ts FROM access_logs WHERE action = 'login' AND azienda = ${req.azienda} GROUP BY 1`) as any[]) accessi.set(r.u, r.ts);
    } catch { /* registro non disponibile */ }
    try {
      await ensureFollowupsExtra();
      for (const r of (await sql`SELECT lower(assegnato_a) AS u, count(*)::int AS n FROM followups WHERE stato = 'pending' AND assegnato_a IS NOT NULL AND azienda = ${req.azienda} GROUP BY 1`) as any[]) followup.set(r.u, r.n);
    } catch { /* niente */ }
  }
  // Password e segreto 2FA non vengono mai esposti al client.
  const safeUsers = users.map((u: any) => ({
    username: u.username,
    nome: u.nome,
    role: u.role || (u.isAdmin ? 'Admin' : 'Editor'),
    canSchedule: u.canSchedule === true,
    twoFactorEnabled: u.twoFactorEnabled === true,
    twoFactorRequired: isTwoFactorRequired(u),
    email: u.email || "",
    telefono: u.telefono || "",
    ultimoAccesso: accessi.get(String(u.username).toLowerCase()) || null,
    soloPropriFollowup: u.soloPropriFollowup === true,
    invitoInAttesa: inviti.has(String(u.username).toLowerCase()),
    puoEsportare: u.puoEsportare !== false,
    limiteNumeri: parseInt(u.limiteNumeri, 10) > 0 ? parseInt(u.limiteNumeri, 10) : null,
    followupAperti: followup.get(String(u.username).toLowerCase()) || 0,
  }));
  res.json(safeUsers);
});

const EMAIL_VALIDA = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RUOLI = ["Admin", "Editor", "Viewer"];
const ruoloDi = (u: any) => u.role || (u.isAdmin ? "Admin" : "Editor");
// Permessi in più dal modulo Admin (campi assenti = lasciati com'erano).
function leggiPermessi(b: any): Record<string, any> {
  const p: Record<string, any> = {};
  if (typeof b.soloPropriFollowup === "boolean") p.soloPropriFollowup = b.soloPropriFollowup;
  if (typeof b.puoEsportare === "boolean") p.puoEsportare = b.puoEsportare;
  if (b.limiteNumeri !== undefined) {
    const n = parseInt(b.limiteNumeri, 10);
    p.limiteNumeri = n > 0 ? Math.min(n, MAX_CONTACTS_PER_LAUNCH) : null;
  }
  return p;
}

app.post("/api/users", requireAuth, requireAdmin, async (req: any, res) => {
  const { username, password, nome, role, canSchedule } = req.body;
  const email = String(req.body.email || "").trim().toLowerCase();
  const telefono = String(req.body.telefono || "").trim().slice(0, 40);

  const invito = req.body.invito === true;
  if (!username || (!password && !invito) || !nome || !role) {
    return res.status(400).json({ error: "Dati mancanti" });
  }
  if (!RUOLI.includes(role)) return res.status(400).json({ error: "Ruolo non valido" });
  if (!/^[a-zA-Z0-9._-]{2,40}$/.test(String(username))) return res.status(400).json({ error: "Username: solo lettere, numeri, punto, trattino (2-40 caratteri)" });
  if (password && String(password).length < 8) return res.status(400).json({ error: "La password deve avere almeno 8 caratteri" });
  if (email && !EMAIL_VALIDA.test(email)) return res.status(400).json({ error: "Email non valida" });
  if (invito && !email) return res.status(400).json({ error: "Per mandare l'invito serve l'email" });

  const users = await readUsers();
  if (users.find((u: any) => u.username.toLowerCase() === username.toLowerCase())) {
    return res.status(400).json({ error: "Username già esistente" });
  }

  // Con l'invito la password la sceglie la persona: intanto una casuale che nessuno conosce.
  const hashed = await bcrypt.hash(password || crypto.randomBytes(24).toString("hex"), 12);
  users.push({ username, password: hashed, nome, role, isAdmin: role === 'Admin', canSchedule: canSchedule === true, twoFactorRequired: false, twoFactorEnabled: false, azienda: req.azienda, ...(email ? { email } : {}), ...(telefono ? { telefono } : {}), ...leggiPermessi(req.body) });
  await writeUsers(users);

  if (invito) {
    const inviato = await creaEInviaInvito(username, (req as any).session.username).catch(err => { console.error("Errore invito:", err); return false; });
    await registra(req, "utente_creato", `${username} (${role}), invito via email`);
    return res.json({ ok: true, invitoInviato: inviato });
  }
  // Senza invito ma con l'email: benvenuto con i dati di accesso (se l'Admin lo lascia attivo).
  if (email && req.body.inviaCredenziali !== false) {
    const inviata = await inviaCredenziali(username, String(password), (req as any).session.username).catch(err => { console.error("Errore email credenziali:", err); return false; });
    await registra(req, "utente_creato", `${username} (${role}), dati di accesso via email`);
    return res.json({ ok: true, credenzialiInviate: inviata });
  }
  await registra(req, "utente_creato", `${username} (${role})`);
  res.json({ ok: true });
});

// ── Inviti: la persona riceve un'email con un link per scegliere la password ──
const INVITO_ORE = 72;
let invitiReady: Promise<void> | null = null;
function ensureInviti(): Promise<void> {
  if (!invitiReady) {
    invitiReady = sql!`
      CREATE TABLE IF NOT EXISTS inviti (
        token_hash TEXT PRIMARY KEY,
        username   TEXT NOT NULL,
        creato_da  TEXT,
        creato_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        scade_at   TIMESTAMPTZ NOT NULL,
        usato_at   TIMESTAMPTZ
      )
    `.then(() => sql!`ALTER TABLE inviti ADD COLUMN IF NOT EXISTS tipo TEXT NOT NULL DEFAULT 'invito'`)
     .then(() => undefined).catch(err => { invitiReady = null; throw err; });
  }
  return invitiReady;
}
const hashToken = (t: string) => crypto.createHash("sha256").update(t).digest("hex");

// Email di benvenuto con nome utente e password scelti dall'Admin.
async function inviaCredenziali(username: string, password: string, daUsername: string): Promise<boolean> {
  if (!process.env.SMTP_USER) return false;
  const u = (await readUsers()).find((x: any) => x.username.toLowerCase() === username.toLowerCase());
  if (!u?.email || !EMAIL_VALIDA.test(u.email)) return false;
  const da = await findSessionUser(daUsername).catch(() => null);
  const daNome = da?.nome || daUsername;
  const appUrl = (process.env.APP_URL || "https://outboundcallgem.vercel.app").replace(/\/$/, "");
  const nome = String(u.nome || "").split(" ")[0];
  const ruolo = ruoloDi(u);
  const riga = (k: string, v: string, ultima = false) => `<tr><td style="padding:11px 0;${ultima ? "" : "border-bottom:1px solid #eef1f6;"}font-size:14px;color:#64748b;">${k}</td><td style="padding:11px 0;${ultima ? "" : "border-bottom:1px solid #eef1f6;"}font-size:14px;color:#0f172a;font-weight:700;text-align:right;font-family:monospace;">${escapeHtml(v)}</td></tr>`;
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || "smtp.gmail.com",
    port: parseInt(process.env.SMTP_PORT || "587"),
    secure: process.env.SMTP_SECURE === "true",
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  await transporter.sendMail({
    from: `"GEM Outbound" <${process.env.SMTP_USER}>`,
    to: u.email,
    subject: `${daNome} ti ha dato accesso a GEM Outbound`,
    text: [`Ciao${nome ? ` ${nome}` : ""}, ${daNome} ti ha dato accesso a GEM Outbound.`, "", `Sito: ${appUrl}`, `Nome utente: ${u.username}`, `Password: ${password}`, `Ruolo: ${ruolo}`, "", "Ti consigliamo di non inoltrare questa email e di cancellarla dopo il primo accesso."].join("\n"),
    html: `
<div style="background:#eef1f6;padding:28px 12px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e2e8f0;">
  <tr><td style="padding:28px 40px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
    <td><img src="${appUrl}/gem-logo-color.png" width="96" alt="GEM Group" style="display:block;width:96px;height:auto;"></td>
    <td style="text-align:right;"><span style="display:inline-block;background:#dcfce7;color:#166534;font-size:12px;font-weight:700;padding:5px 12px;border-radius:999px;">&#9679; Nuovo accesso</span></td></tr></table></td></tr>
  <tr><td style="padding:26px 40px 6px;font-size:24px;font-weight:700;color:#0f172a;letter-spacing:-0.3px;">Benvenuto in GEM Outbound</td></tr>
  <tr><td style="padding:0 40px 20px;font-size:15px;color:#475569;line-height:1.6;">Ciao${nome ? ` ${escapeHtml(nome)}` : ""}, <strong style="color:#0f172a;">${escapeHtml(daNome)}</strong> ti ha dato accesso alla piattaforma delle campagne di chiamate con Wilma. Ecco i tuoi dati.</td></tr>
  <tr><td style="padding:0 40px 8px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border-radius:10px;"><tr><td style="padding:6px 20px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${riga("Nome utente", u.username)}${riga("Password", password)}${riga("Ruolo", ruolo, true)}</table></td></tr></table></td></tr>
  <tr><td style="padding:20px 40px 8px;"><a href="${appUrl}" style="display:block;background:#1e3dc8;color:#ffffff;text-decoration:none;text-align:center;font-size:15px;font-weight:600;padding:14px 20px;border-radius:9px;">Accedi a GEM Outbound</a></td></tr>
  <tr><td style="padding:4px 40px 30px;font-size:13px;color:#64748b;line-height:1.5;text-align:center;">Non inoltrare questa email e cancellala dopo il primo accesso.</td></tr>
  <tr><td style="padding:18px 40px;border-top:1px solid #eef1f6;font-size:12px;color:#94a3b8;line-height:1.6;">GEM Group &middot; Soluzioni di comunicazione e automazione AI su tecnologia Wildix<br>Se non aspettavi questa email puoi ignorarla.</td></tr>
</table></div>`,
  });
  return true;
}

// Crea un link nuovo (quelli vecchi non usati smettono di valere) e lo manda per email.
// tipo "reset": l'utente ha chiesto "Password dimenticata" (link valido 1 ora, testo diverso).
async function creaEInviaInvito(username: string, daUsername: string, tipo: "invito" | "reset" = "invito"): Promise<boolean> {
  if (!sql) return false;
  const users = await readUsers();
  const u = users.find((x: any) => x.username.toLowerCase() === username.toLowerCase());
  if (!u?.email || !EMAIL_VALIDA.test(u.email)) return false;
  await ensureInviti();
  await sql`UPDATE inviti SET usato_at = now() WHERE lower(username) = ${u.username.toLowerCase()} AND usato_at IS NULL`;
  const token = crypto.randomBytes(32).toString("base64url");
  const ore = tipo === "reset" ? 1 : INVITO_ORE;
  await sql`INSERT INTO inviti (token_hash, username, creato_da, scade_at, tipo) VALUES (${hashToken(token)}, ${u.username}, ${daUsername}, now() + make_interval(hours => ${ore}::int), ${tipo})`;
  if (!process.env.SMTP_USER) return false;
  const da = await findSessionUser(daUsername).catch(() => null);
  const daNome = da?.nome || daUsername;
  const appUrl = (process.env.APP_URL || "https://outboundcallgem.vercel.app").replace(/\/$/, "");
  const link = `${appUrl}/?invito=${token}`;
  const nome = String(u.nome || "").split(" ")[0];
  const ruolo = ruoloDi(u);
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || "smtp.gmail.com",
    port: parseInt(process.env.SMTP_PORT || "587"),
    secure: process.env.SMTP_SECURE === "true",
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  if (tipo === "reset") {
    await transporter.sendMail({
      from: `"GEM Outbound" <${process.env.SMTP_USER}>`,
      to: u.email,
      subject: "Reimposta la tua password di GEM Outbound",
      text: [`Ciao${nome ? ` ${nome}` : ""}, hai chiesto di reimpostare la password di GEM Outbound.`, "", `Nome utente: ${u.username}`, "", "Scegli la nuova password da qui (il link vale 1 ora):", link, "", "Se non sei stato tu, ignora questa email: la password resta quella di prima."].join("\n"),
      html: `
<div style="background:#eef1f6;padding:28px 12px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e2e8f0;">
  <tr><td style="padding:28px 40px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
    <td><img src="${appUrl}/gem-logo-color.png" width="96" alt="GEM Group" style="display:block;width:96px;height:auto;"></td>
    <td style="text-align:right;"><span style="display:inline-block;background:#fef3c7;color:#92400e;font-size:12px;font-weight:700;padding:5px 12px;border-radius:999px;">&#9679; Password</span></td></tr></table></td></tr>
  <tr><td style="padding:26px 40px 6px;font-size:24px;font-weight:700;color:#0f172a;letter-spacing:-0.3px;">Reimposta la password</td></tr>
  <tr><td style="padding:0 40px 20px;font-size:15px;color:#475569;line-height:1.6;">Ciao${nome ? ` ${escapeHtml(nome)}` : ""}, hai chiesto di reimpostare la password per il nome utente <strong style="color:#0f172a;font-family:monospace;">${escapeHtml(u.username)}</strong>.</td></tr>
  <tr><td style="padding:4px 40px 8px;"><a href="${link}" style="display:block;background:#1e3dc8;color:#ffffff;text-decoration:none;text-align:center;font-size:15px;font-weight:600;padding:14px 20px;border-radius:9px;">Scegli la nuova password</a></td></tr>
  <tr><td style="padding:4px 40px 30px;font-size:13px;color:#64748b;line-height:1.5;text-align:center;">Il link vale 1 ora e si può usare una volta sola. Se non sei stato tu, ignora questa email: la password resta quella di prima.</td></tr>
  <tr><td style="padding:18px 40px;border-top:1px solid #eef1f6;font-size:12px;color:#94a3b8;line-height:1.6;">GEM Group &middot; Email automatica inviata da GEM Outbound.</td></tr>
</table></div>`,
    });
    return true;
  }
  await transporter.sendMail({
    from: `"GEM Outbound" <${process.env.SMTP_USER}>`,
    to: u.email,
    subject: `${daNome} ti ha dato accesso a GEM Outbound`,
    text: [`Ciao${nome ? ` ${nome}` : ""}, ${daNome} ti ha dato accesso a GEM Outbound.`, "", `Il tuo nome utente: ${u.username}`, `Ruolo: ${ruolo}`, "", `Scegli la tua password da qui (il link vale ${INVITO_ORE} ore):`, link].join("\n"),
    html: `
<div style="background:#eef1f6;padding:28px 12px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e2e8f0;">
  <tr><td style="padding:28px 40px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
    <td><img src="${appUrl}/gem-logo-color.png" width="96" alt="GEM Group" style="display:block;width:96px;height:auto;"></td>
    <td style="text-align:right;"><span style="display:inline-block;background:#dcfce7;color:#166534;font-size:12px;font-weight:700;padding:5px 12px;border-radius:999px;">&#9679; Invito</span></td></tr></table></td></tr>
  <tr><td style="padding:26px 40px 6px;font-size:24px;font-weight:700;color:#0f172a;letter-spacing:-0.3px;">Benvenuto in GEM Outbound</td></tr>
  <tr><td style="padding:0 40px 20px;font-size:15px;color:#475569;line-height:1.6;">Ciao${nome ? ` ${escapeHtml(nome)}` : ""}, <strong style="color:#0f172a;">${escapeHtml(daNome)}</strong> ti ha dato accesso alla piattaforma delle campagne di chiamate con Wilma.</td></tr>
  <tr><td style="padding:0 40px 8px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border-radius:10px;"><tr><td style="padding:6px 20px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr><td style="padding:11px 0;border-bottom:1px solid #eef1f6;font-size:14px;color:#64748b;">Nome utente</td><td style="padding:11px 0;border-bottom:1px solid #eef1f6;font-size:14px;color:#0f172a;font-weight:700;text-align:right;font-family:monospace;">${escapeHtml(u.username)}</td></tr>
      <tr><td style="padding:11px 0;font-size:14px;color:#64748b;">Ruolo</td><td style="padding:11px 0;font-size:14px;color:#0f172a;font-weight:600;text-align:right;">${escapeHtml(ruolo)}</td></tr>
    </table></td></tr></table></td></tr>
  <tr><td style="padding:20px 40px 8px;"><a href="${link}" style="display:block;background:#1e3dc8;color:#ffffff;text-decoration:none;text-align:center;font-size:15px;font-weight:600;padding:14px 20px;border-radius:9px;">Scegli la tua password</a></td></tr>
  <tr><td style="padding:4px 40px 30px;font-size:13px;color:#64748b;line-height:1.5;text-align:center;">Il link vale ${INVITO_ORE} ore e si può usare una volta sola.</td></tr>
  <tr><td style="padding:18px 40px;border-top:1px solid #eef1f6;font-size:12px;color:#94a3b8;line-height:1.6;">GEM Group &middot; Soluzioni di comunicazione e automazione AI su tecnologia Wildix<br>Se non aspettavi questa email puoi ignorarla.</td></tr>
</table></div>`,
  });
  return true;
}

// Admin: manda (o rimanda) l'invito, anche per far reimpostare la password.
app.post("/api/users/:username/invito", requireAuth, requireAdmin, async (req: any, res) => {
  const u = await utenteDellAzienda(String(req.params.username), req.azienda);
  if (!u) return res.status(404).json({ ok: false, error: "Utente non trovato" });
  if (!u.email) return res.status(400).json({ ok: false, error: "Questo utente non ha l'email: aggiungila prima" });
  try {
    const ok = await creaEInviaInvito(u.username, req.session.username);
    if (!ok) return res.status(500).json({ ok: false, error: "Email non inviata: controlla la configurazione email del sito" });
    await registra(req, "invito_inviato", u.username);
    res.json({ ok: true, email: u.email });
  } catch (err) {
    console.error("Errore invito:", err);
    res.status(500).json({ ok: false, error: "Invio non riuscito" });
  }
});

// Pubblico: "Password dimenticata". Si scrive email o nome utente; se l'account
// esiste e ha l'email arriva un link (1 ora). La risposta è sempre la stessa,
// così non si scopre quali account esistono.
app.post("/api/password-dimenticata", async (req, res) => {
  const chi = String(req.body?.chi || "").trim().toLowerCase().slice(0, 200);
  const risposta = { ok: true, messaggio: "Se l'account esiste e ha un'email, ti abbiamo mandato un link per scegliere una nuova password. Vale 1 ora." };
  if (!chi) return res.status(400).json({ ok: false, error: "Scrivi la tua email o il nome utente" });
  const ipKey = `reset:ip:${clientIp(req)}`;
  const chiKey = `reset:chi:${chi}`;
  const [perIp, perChi] = await Promise.all([countAttempts(ipKey, 15), countAttempts(chiKey, 60)]);
  if (perIp >= 5 || perChi >= 3) return res.status(429).json({ ok: false, error: TOO_MANY });
  await Promise.all([recordAttempt(ipKey), recordAttempt(chiKey)]);
  try {
    const users = await readUsers();
    const trovati = users.filter((u: any) => u.username.toLowerCase() === chi || (u.email && String(u.email).toLowerCase() === chi));
    for (const u of trovati.slice(0, 3)) {
      await creaEInviaInvito(u.username, u.username, "reset").catch(err => console.error("Errore email reset:", err));
    }
  } catch (err) {
    console.error("Errore password dimenticata:", err);
  }
  res.json(risposta);
});

// Pubblico: dati dell'invito (per mostrare a chi è) e scelta della password.
async function invitoValido(token: string): Promise<any | null> {
  if (!sql || !token || token.length > 100) return null;
  await ensureInviti();
  const r = (await sql`SELECT username, tipo FROM inviti WHERE token_hash = ${hashToken(token)} AND usato_at IS NULL AND scade_at > now()`) as any[];
  return r[0] || null;
}
app.get("/api/invito/:token", async (req, res) => {
  try {
    const inv = await invitoValido(String(req.params.token));
    if (!inv) return res.status(404).json({ ok: false, error: "Link non valido o scaduto. Chiedi all'Admin di mandarne un altro." });
    const u = (await readUsers()).find((x: any) => x.username.toLowerCase() === inv.username.toLowerCase());
    if (!u) return res.status(404).json({ ok: false, error: "Utente non più presente" });
    res.json({ ok: true, username: u.username, nome: u.nome, tipo: inv.tipo || "invito" });
  } catch (err) {
    console.error("Errore lettura invito:", err);
    res.status(500).json({ ok: false, error: "Errore" });
  }
});
app.post("/api/invito", async (req, res) => {
  const token = String(req.body?.token || "");
  const password = String(req.body?.password || "");
  if (password.length < 8) return res.status(400).json({ ok: false, error: "La password deve avere almeno 8 caratteri" });
  try {
    const inv = await invitoValido(token);
    if (!inv) return res.status(404).json({ ok: false, error: "Link non valido o scaduto. Chiedi all'Admin di mandarne un altro." });
    // Il link si consuma subito, prima di cambiare la password.
    const preso = (await sql!`UPDATE inviti SET usato_at = now() WHERE token_hash = ${hashToken(token)} AND usato_at IS NULL RETURNING username`) as any[];
    if (!preso.length) return res.status(409).json({ ok: false, error: "Link già usato" });
    const users = await readUsers();
    const i = users.findIndex((x: any) => x.username.toLowerCase() === inv.username.toLowerCase());
    if (i === -1) return res.status(404).json({ ok: false, error: "Utente non più presente" });
    users[i] = { ...users[i], password: await bcrypt.hash(password, 12) };
    await writeUsers(users);
    await clearAttempts(`login:user:${String(users[i].username).toLowerCase()}`);
    res.json({ ok: true, username: users[i].username });
  } catch (err) {
    console.error("Errore conferma invito:", err);
    res.status(500).json({ ok: false, error: "Errore" });
  }
});

app.put("/api/users/:username", requireAuth, requireAdmin, async (req: any, res) => {
  const { username } = req.params;
  const { password, nome, role, canSchedule } = req.body;

  if (!nome || !role) {
    return res.status(400).json({ error: "Dati mancanti" });
  }
  if (!RUOLI.includes(role)) return res.status(400).json({ error: "Ruolo non valido" });
  if (password && String(password).trim() && String(password).trim().length < 8) return res.status(400).json({ error: "La password deve avere almeno 8 caratteri" });
  const email = req.body.email === undefined ? undefined : String(req.body.email || "").trim().toLowerCase();
  const telefono = req.body.telefono === undefined ? undefined : String(req.body.telefono || "").trim().slice(0, 40);
  if (email && !EMAIL_VALIDA.test(email)) return res.status(400).json({ error: "Email non valida" });

  let users = await readUsers();
  const index = users.findIndex((u: any) => u.username.toLowerCase() === username.toLowerCase() && aziendaDi(u) === req.azienda);

  if (index === -1) {
    return res.status(404).json({ error: "Utente non trovato" });
  }
  // Deve restare almeno un Admin (per azienda).
  if (ruoloDi(users[index]) === "Admin" && role !== "Admin" && users.filter((u: any) => ruoloDi(u) === "Admin" && aziendaDi(u) === req.azienda).length <= 1) {
    return res.status(400).json({ error: "Deve restare almeno un Admin" });
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
    canSchedule: canSchedule === true,
    ...(email !== undefined ? { email } : {}),
    ...(telefono !== undefined ? { telefono } : {}),
    ...leggiPermessi(req.body),
  };
  await writeUsers(users);
  
  await registra(req, "utente_modificato", `${username}: ${role}${password && String(password).trim() ? ", nuova password" : ""}`);
  res.json({ ok: true });
});

app.delete("/api/users/:username", requireAuth, requireAdmin, async (req: any, res) => {
  const { username } = req.params;
  if (String(username).toLowerCase() === String(req.session.username).toLowerCase()) {
    return res.status(400).json({ error: "Non puoi eliminare il tuo account" });
  }

  let users = await readUsers();
  const target = users.find((u: any) => u.username.toLowerCase() === String(username).toLowerCase() && aziendaDi(u) === req.azienda);
  if (!target) return res.status(404).json({ error: "Utente non trovato" });
  if (ruoloDi(target) === "Admin" && users.filter((u: any) => ruoloDi(u) === "Admin" && aziendaDi(u) === req.azienda).length <= 1) {
    return res.status(400).json({ error: "Deve restare almeno un Admin" });
  }
  const initialLength = users.length;
  users = users.filter((u: any) => u !== target);

  if (users.length === initialLength) {
    return res.status(404).json({ error: "Utente non trovato" });
  }

  await writeUsers(users);
  await registra(req, "utente_eliminato", username);
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
  const idx = users.findIndex((u: any) => u.username.toLowerCase() === username.toLowerCase() && (isSelf || aziendaDi(u) === req.azienda));
  if (idx === -1) return res.status(404).json({ ok: false, error: "Utente non trovato" });

  if (enabled) {
    // Attivazione: richiede un nuovo setup da zero al prossimo login.
    users[idx] = { ...users[idx], twoFactorRequired: true, twoFactorSecret: undefined, twoFactorEnabled: false };
  } else {
    users[idx] = { ...users[idx], twoFactorRequired: false };
  }

  await writeUsers(users);
  await registra(req, "2fa", `${username}: ${enabled ? "richiesto" : "spento"}`);
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
  const isSelf = req.session.username.toLowerCase() === String(username).toLowerCase();
  const user = isSelf ? req.utente : await utenteDellAzienda(String(username), req.azienda);
  if (!user) return res.status(404).json({ ok: false });
  res.json({
    ok: true,
    ...(isSelf ? await infoAzienda(user) : {}),
    email: user.email || '',
    telefono: user.telefono || '',
    twoFactorEnabled: user.twoFactorEnabled === true,
    twoFactorRequired: isTwoFactorRequired(user),
    role: user.role || (user.isAdmin ? "Admin" : "Editor"),
    canSchedule: user.canSchedule === true,
    ...permessiUtente(user),
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
  const isSelf = req.session.username.toLowerCase() === String(username).toLowerCase();
  const idx = users.findIndex((u: any) => u.username.toLowerCase() === username.toLowerCase() && (isSelf || aziendaDi(u) === req.azienda));
  if (idx === -1) return res.status(404).json({ ok: false, error: 'Utente non trovato' });
  users[idx].email = email || '';
  users[idx].telefono = telefono || '';
  await writeUsers(users);
  res.json({ ok: true });
});

// ── VOICEBOT ENDPOINTS ──
app.get("/api/voicebots", requireAuth, async (req: any, res) => {
  const bots = (await readVoicebots()).filter((b: any) => aziendaDi(b) === req.azienda);
  // Il webhook esiti lo vedono solo gli Admin: chi ha l'indirizzo può scrivere nello Sheets.
  res.json({ ok: true, voicebots: req.session?.isAdmin ? bots : bots.map(({ webhookEsiti, ...b }: any) => b) });
});

app.post("/api/voicebots", requireAuth, requireAdmin, async (req: any, res) => {
  const { nome, exten, context, descrizione, webhookEsiti } = req.body;
  if (!nome || !exten || !context) return res.status(400).json({ ok: false, error: "Nome, interno e contesto sono obbligatori" });
  if (webhookEsiti && !webhookEsitiValido(webhookEsiti)) return res.status(400).json({ ok: false, error: "Webhook esiti non valido: incolla l'indirizzo del webhook Make (https://hook...make.com/...)" });
  const bots = await readVoicebots();
  const id = `vb${Date.now()}`;
  bots.push({ id, nome, exten: parseInt(exten), context, descrizione: descrizione || "", attivo: true, webhookEsiti: webhookEsitiValido(webhookEsiti) || "", azienda: req.azienda });
  try {
    await writeVoicebots(bots);
    await registra(req, "voicebot_creato", `${nome} (interno ${exten})`);
    res.json({ ok: true, id });
  } catch {
    res.status(500).json({ ok: false, error: "Errore salvataggio su GitHub" });
  }
});

app.put("/api/voicebots/:id", requireAuth, requireAdmin, async (req: any, res) => {
  const bots = await readVoicebots();
  const idx = bots.findIndex((b: any) => b.id === req.params.id && aziendaDi(b) === req.azienda);
  if (idx === -1) return res.status(404).json({ ok: false, error: "Voicebot non trovato" });
  if (req.body?.webhookEsiti && !webhookEsitiValido(req.body.webhookEsiti)) {
    return res.status(400).json({ ok: false, error: "Webhook esiti non valido: incolla l'indirizzo del webhook Make (https://hook...make.com/...)" });
  }
  // L'azienda del voicebot non si cambia da qui.
  const { azienda: _ignora, ...modifiche } = req.body || {};
  bots[idx] = { ...bots[idx], ...modifiche, id: req.params.id };
  if ("webhookEsiti" in (req.body || {})) bots[idx].webhookEsiti = webhookEsitiValido(req.body.webhookEsiti) || "";
  try {
    await writeVoicebots(bots);
    await registra(req, "voicebot_modificato", `${bots[idx].nome}${"attivo" in modifiche ? (bots[idx].attivo === false ? ", disattivato" : ", attivo") : ""}`);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ ok: false, error: "Errore salvataggio su GitHub" });
  }
});

app.delete("/api/voicebots/:id", requireAuth, requireAdmin, async (req: any, res) => {
  const tutti = await readVoicebots();
  const bots = tutti.filter((b: any) => !(b.id === req.params.id && aziendaDi(b) === req.azienda));
  if (bots.length === tutti.length) return res.status(404).json({ ok: false, error: "Voicebot non trovato" });
  try {
    await writeVoicebots(bots);
    await registra(req, "voicebot_eliminato", tutti.find((b: any) => b.id === req.params.id)?.nome || req.params.id);
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
  await logAccess(req.session.username, req.utente?.nome, "logout", aziendaDi(req.utente));
  res.json({ ok: true });
});

app.get("/api/access-logs", requireAuth, requireAdmin, async (req: any, res) => {
  try {
    const logs = await sql`
      SELECT to_char(ts, 'YYYY-MM-DD"T"HH24:MI:SS.MSOF') AS ts, username, nome, action
      FROM access_logs WHERE azienda = ${req.azienda} ORDER BY ts DESC LIMIT 200
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
// Nessun URL di riserva nel codice: i vecchi erano pubblici nel repository.
const MAKE_WEBHOOK_URL_DEFAULT = process.env.MAKE_WEBHOOK_URL || "";
const MAKE_WEBHOOK_URL_APPUNTAMENTI = process.env.MAKE_WEBHOOK_URL_APPUNTAMENTI || "";
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

// Utente di una certa azienda (per assegnare follow-up, gestire utenti): gli altri non esistono.
async function utenteDellAzienda(username: string, azienda: string) {
  const u = await findSessionUser(username);
  return u && aziendaDi(u) === azienda ? u : null;
}
const utentiDellAzienda = async (azienda: string) => (await readUsers()).filter((u: any) => aziendaDi(u) === azienda);

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
  azienda: string;
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
  const esclusi = await numeriNonChiamare(spec.contacts.map(c => c.numero), spec.azienda);
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

  // Un'azienda con un suo centralino Wildix ha i suoi scenari Make.
  const az = (await leggiAziende()).find(a => a.id === spec.azienda);
  const webhookUrl = spec.campaignType === "appuntamenti"
    ? webhookMakeValido(az?.webhookAppuntamenti) || MAKE_WEBHOOK_URL_APPUNTAMENTI
    : webhookMakeValido(az?.webhookChiamate) || MAKE_WEBHOOK_URL_DEFAULT;
  const avviatoIl = new Date().toISOString();
  const dryRun = isCallsDryRun();
  if (!dryRun && !webhookUrl) {
    throw new Error(spec.campaignType === "appuntamenti"
      ? "Webhook Make appuntamenti non configurato: imposta MAKE_WEBHOOK_URL_APPUNTAMENTI su Vercel."
      : "Webhook Make non configurato: imposta MAKE_WEBHOOK_URL su Vercel.");
  }

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
    if (codaId && await recordQueuedCalls(codaId, spec.contacts, spec.azienda)) {
      await upsertContactNames(spec.contacts, spec.azienda);
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
  if (sentContacts.length > 0 && !dryRun) await upsertContactNames(sentContacts, spec.azienda);
  if (liveId) {
    await recordLiveCalls(liveId, chunks, results, spec.azienda);
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
      await sql!`ALTER TABLE campaign_log ADD COLUMN IF NOT EXISTS azienda TEXT NOT NULL DEFAULT 'gem'`;
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
  scheduledId?: number | null; dryRun: boolean; azienda: string;
}) {
  if (!sql) return;
  try {
    await ensureCampaignLogSchema();
    await sql`
      INSERT INTO campaign_log
        (username, operatore, tipo_campagna, voicebot_nome, mode, contacts_count, sent_count, failed_count, scheduled_id, dry_run, azienda)
      VALUES
        (${entry.username}, ${entry.operatore || null}, ${entry.tipoCampagna}, ${entry.voicebotNome || null}, ${entry.mode},
         ${entry.contactsCount}, ${entry.sentCount}, ${entry.failedCount}, ${entry.scheduledId ?? null}, ${entry.dryRun}::boolean, ${entry.azienda})
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
      await sql!`ALTER TABLE live_campaigns ADD COLUMN IF NOT EXISTS azienda TEXT NOT NULL DEFAULT 'gem'`;
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
      // Esito commerciale corretto a mano dal dettaglio campagna (vince sulle regole).
      await sql!`ALTER TABLE live_calls ADD COLUMN IF NOT EXISTS esito_manuale TEXT`;
      await sql!`ALTER TABLE live_calls ADD COLUMN IF NOT EXISTS esito_manuale_da TEXT`;
      await sql!`ALTER TABLE live_calls ADD COLUMN IF NOT EXISTS azienda TEXT NOT NULL DEFAULT 'gem'`;
      await sql!`CREATE INDEX IF NOT EXISTS idx_live_campaigns_azienda ON live_campaigns (azienda, created_at DESC)`;
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
                                  modalita_coda, concurrency, webhook_url, payload_base, retry_max, retry_intervallo_min, azienda)
      VALUES (${spec.username || null}, ${spec.operatore || null}, ${spec.campaignType}, ${spec.bot?.nome || null},
              ${spec.bot?.exten != null ? String(spec.bot.exten) : null}, ${spec.contacts.length}, ${spec.scheduledId ?? null},
              ${webhookEsitiValido(spec.bot?.webhookEsiti)},
              ${!!coda}, ${coda?.concurrency ?? 1}, ${coda?.webhookUrl ?? null},
              ${coda ? JSON.stringify(coda.payloadBase) : null}::jsonb,
              ${coda ? spec.retryMax || 0 : 0}, ${spec.retryIntervalloMin || 120}, ${spec.azienda})
      RETURNING id
    `) as any[];
    return rows[0]?.id ?? null;
  } catch (err) {
    console.error("Errore creazione campagna in diretta (non bloccante):", err);
    return null;
  }
}

async function recordLiveCalls(campaignId: number, chunks: LaunchContact[][], results: boolean[], azienda: string) {
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
      INSERT INTO live_calls (campaign_id, numero, nome, stato, errore, azienda)
      SELECT ${campaignId}, n, nm, st, er, ${azienda}
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

// Ogni azienda ha i suoi orari (chiave "orari" per la principale, come prima).
const chiaveOrari = (azienda: string) => (azienda === AZIENDA_PRINCIPALE ? "orari" : `orari:${azienda}`);
const orariCache = new Map<string, { v: OrariConsentiti; t: number }>();
async function leggiOrari(azienda: string): Promise<OrariConsentiti> {
  const c = orariCache.get(azienda);
  if (c && Date.now() - c.t < 30_000) return c.v;
  let v = ORARI_PREDEFINITI;
  if (sql) {
    try {
      await ensureAppState();
      const r = (await sql`SELECT value FROM app_state WHERE key = ${chiaveOrari(azienda)}`) as any[];
      if (r[0]?.value) v = validaOrari(JSON.parse(r[0].value)) || ORARI_PREDEFINITI;
    } catch (err) {
      console.error("Errore lettura orari consentiti:", err);
    }
  }
  orariCache.set(azienda, { v, t: Date.now() });
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
    `.then(async () => {
      // Ogni azienda ha la sua lista: lo stesso numero può stare in più liste.
      await sql!`ALTER TABLE do_not_call ADD COLUMN IF NOT EXISTS azienda TEXT NOT NULL DEFAULT 'gem'`;
      await sql!`CREATE UNIQUE INDEX IF NOT EXISTS uq_do_not_call_azienda ON do_not_call (azienda, numero)`;
      await togliChiaveSoloNumero("do_not_call");
    }).catch(err => { dncReady = null; throw err; });
  }
  return dncReady;
}

async function numeriNonChiamare(numeri: string[], azienda: string): Promise<Set<string>> {
  if (!sql || numeri.length === 0) return new Set();
  try {
    await ensureDncSchema();
    const norm = [...new Set(numeri.map(n => normalizePhone(n) || n))];
    const rows = (await sql`SELECT numero FROM do_not_call WHERE numero = ANY(${norm}::text[]) AND azienda = ${azienda}`) as any[];
    return new Set(rows.map(r => r.numero));
  } catch (err) {
    console.error("Errore lettura lista Non chiamare:", err);
    return new Set();
  }
}

async function aggiungiNonChiamare(voci: { numero: string; nome?: string | null }[], motivo: string | null, fonte: string, autore: string | null, azienda: string): Promise<number> {
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
    INSERT INTO do_not_call (numero, nome, motivo, fonte, created_by, azienda)
    SELECT n, nm, ${motivo}, ${fonte}, ${autore}, ${azienda} FROM unnest(${numeri}::text[], ${nomi}::text[]) AS t(n, nm)
    ON CONFLICT (azienda, numero) DO UPDATE SET nome = COALESCE(do_not_call.nome, EXCLUDED.nome)
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

async function recordQueuedCalls(campaignId: number, contacts: LaunchContact[], azienda: string): Promise<boolean> {
  if (!sql) return false;
  const numeri = contacts.map(c => normalizePhone(c.numero) || c.numero);
  const nomi = contacts.map(c => c.nome || "");
  const dati = contacts.map(c => JSON.stringify(c));
  try {
    await sql`
      INSERT INTO live_calls (campaign_id, numero, nome, stato, inviata_at, dati, azienda)
      SELECT ${campaignId}, n, nm, 'in_coda', NULL, d::jsonb, ${azienda}
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
    // Fuori dagli orari consentiti (dell'azienda della campagna) non parte nessuno: ci pensa la sveglia all'apertura.
    const azienda = aziendaDi(((await sql`SELECT azienda FROM live_campaigns WHERE id = ${campaignId}`) as any[])[0]);
    const aperto = dentroOrari(await leggiOrari(azienda), new Date());
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
    WHERE l.campaign_id = ${campaignId} AND l.stato = 'in_coda' AND l.inviata_at IS NULL AND d.numero = l.numero AND d.azienda = l.azienda
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
              AND (r.call_id = l.call_id OR (r.numero = l.numero AND r.azienda = c.azienda AND r.ts::timestamptz > c.created_at))
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
type EsitoCommerciale = "non_chiamare" | "non_interessato" | "appuntamento" | "richiamare" | "interessato"
  | "segreteria" | "numero_errato" | "nessun_dialogo" | "da_valutare";
const ESITI_COMMERCIALI_VALIDI: EsitoCommerciale[] = ["appuntamento", "interessato", "richiamare", "non_interessato", "non_chiamare",
  "segreteria", "numero_errato", "nessun_dialogo", "da_valutare"];
const ESITO_COMMERCIALE_LABEL: Record<EsitoCommerciale, { label: string; bg: string; fg: string }> = {
  appuntamento: { label: "Appuntamento", bg: "#dcfce7", fg: "#166534" },
  interessato: { label: "Interessato", bg: "#dbeafe", fg: "#1e40af" },
  richiamare: { label: "Da richiamare", bg: "#ede9fe", fg: "#5b21b6" },
  non_interessato: { label: "Non interessato", bg: "#f1f5f9", fg: "#475569" },
  non_chiamare: { label: "Non chiamare", bg: "#fee2e2", fg: "#991b1b" },
  segreteria: { label: "Segreteria / centralino", bg: "#fef3c7", fg: "#92400e" },
  numero_errato: { label: "Numero errato", bg: "#ffedd5", fg: "#9a3412" },
  nessun_dialogo: { label: "Nessun dialogo", bg: "#f1f5f9", fg: "#475569" },
  da_valutare: { label: "Da valutare", bg: "#f8fafc", fg: "#64748b" },
};
const RE_NON_CHIAMARE = /(non (vuole|vogliono|desidera|desiderano) (pi[uù] )?essere (ri)?(contattat|chiamat|disturbat)|di non essere (pi[uù] )?(ri)?(contattat|chiamat|disturbat)|non (mi|lo|la|ci|li|le) (chiamate|contattate|richiamate|disturbate) pi[uù]|(non (deve|devono) (pi[uù] )?(essere )?(ri)?(chiamar|contattar))|(rimozion|rimuover|cancellar|cancellazion|eliminar)\w*.{0,50}(numer|nominativ|dati|lista|elenc|contatt)|registro (pubblico )?(delle |dell'?)?opposizion|non disturbar|smettere di (chiamar|contattar)|stop (alle )?chiamate|chiamate indesiderate|do not call|don'?t call|not to be (called|contacted)|remove\w* .{0,30}(number|list))/;
const RE_NUMERO_ERRATO = /(numero (errato|sbagliato|non corretto|inesistente|non valido|non (più )?attivo)|(persona|azienda|destinatario) sbagliat|sbagliato numero|non (conosce|corrisponde a) (la persona|l'azienda|il nominativo|il destinatario|nessun)|non (è|e') (la persona|l'azienda) (cercat|indicat|richiest)|wrong (number|person))/;
// Segreteria telefonica: nessuna persona raggiunta. Viene prima delle altre
// regole perché il voicebot può lasciare un messaggio ("mi richiami").
const RE_SEGRETERIA = /(segreteria telefonica|casella vocale|voicemail|voice mail|answering machine|messaggio (della |in )?segreteria|(lasciat|lasciare) .{0,20}messaggio (in|nella) segreteria|al segnale acustico|dopo il segnale|(numero|utente|telefono|cellulare)\w* .{0,30}(non (è |e' )?(al momento )?raggiungibil|irraggiungibil)|(telefono|cellulare|apparecchio) .{0,15}spento|fuori copertura)/;
// Centralino o menu automatico: conta solo se nel riassunto non c'è altro.
const RE_CENTRALINO = /(centralino|opzioni (del sistema|del menu|multiple|automatiche)|interagi\w* (solo |soltanto |principalmente )?con (il sistema|le opzioni|il menu|un sistema)|(risposte|messaggi|frasi) (standard|automatic\w*|preregistrat\w*|registrat\w*)|(messaggi|risposte|frasi) di attesa|risponditore|menu (vocale|automatico|telefonico)|messaggio (automatico|registrato|preregistrato|vocale)|sistema (automatico|di risposta)|selezion\w* (il |un |l')?(tasto|opzione|interno)|premere (il )?(tasto|\d)|digit\w* (il |un )?(tasto|interno)|(mess\w*|tenut\w*) in attesa|attesa (in linea|telefonica)|musica d'attesa|\bivr\b|automated (message|system)|phone menu)/;
const RE_NON_INTERESSATO = /(non (è|e'|sono|risulta|risultano|si dichiara|si è detto|si e' detto|appare) (\w+ )?interessat|nessun interesse|non (ha|hanno|mostra|mostrano|manifesta) (alcun |nessun )?interesse|disinteress|rifiut|non conferm|disdett|disdic|annullat\w* l'appuntamento|non (gli|le|ci) interessa|non interessa|gi[aà] (un |altro )?fornitore|gi[aà] (soddisfatt|servit|client)|non ne (ha|hanno) bisogno|non (gli|le) serve|non serve|non c'(è|e') (alcun |nessun )?interesse|non (è |e' )?(emers|stat|manifestat)\w* (alcun |nessun |un )?interesse|senza (alcun |mostrare )?interesse|not interested|no interest|declin)/;
const RE_APPUNTAMENTO = /((appuntament|incontr|demo|dimostrazion|sopralluog|videochiamat|visita|consulenz)\w*.{0,50}(fissat|confermat|concordat|prenotat|programmat|issat|stabilit|accettat)|(fissat|concordat|prenotat|conferm|programmat|accetta)\w*.{0,40}(appuntament|incontr|demo|dimostrazion|sopralluog|videochiamat|visita|consulenz)|(appointment|meeting|demo)\w*.{0,30}(scheduled|booked|confirmed|set up|arranged))/;
const RE_RICHIAMARE = /(richiam|ricontatt|risentir|chiamare (pi[uù] )?tardi|(in un |un )?altro momento|un altro giorno|(era|è|e') occupat|non (pu[oò]|poteva|potevano) parlare|ripassare|inviare (una |un'?)?(e-?mail|informazion|preventiv|materiale|brochure)|mandare (una |un'?)?(e-?mail|informazion|preventiv)|pi[uù] tardi|assente|non (è|e'|era) (presente|disponibile|in ufficio|in sede)|in riunione|fuori (ufficio|sede)|in ferie|non c'(è|e'|era) (il |la |lo |l'|nessuno|in )|call ?back|call (again |)later|not available)/;
const RE_INTERESSATO = /(interessat|interesse|vuole (sapere|ricevere|avere|un preventivo|maggiori|approfondire)|chiede(va|ndo)? (informazion|un preventivo|dettagli|maggiori|costi|prezz)|preventiv|valutare (l'offerta|la proposta|il servizio)|curios|disponibil\w* a (ricevere|valutare|approfondire|un incontro)|interested|wants (more )?information)/;
// Nessuna conversazione utile: ha riattaccato subito, silenzio, nessuna risposta.
const RE_NESSUN_DIALOGO = /(riattacc|non (è|e') emers|nessun approfondimento|non ha avuto approfondiment|senza (domande|approfondiment|interagire|rispondere)|non (risponde|ha risposto) (direttamente )?alla proposta|(comunicazione|conversazione|chiamata) (è|e') (stata )?(solo |puramente )?(iniziale|informativa|introduttiva)|(ha |avrebbe )?chiuso (la chiamata|la comunicazione|subito)|chiamata .{0,20}(interrott|terminat|conclus)\w* .{0,20}(subito|bruscamente|prima|senza)|interrott|nessuna risposta|non (ha )?rispost|silenzi|non (ha )?parlat|nessun (dialogo|interlocutore|scambio|intervento)|non c'(è|e') stat\w* (alcuna |nessuna )?(conversazione|interazione|risposta)|senza (alcuna )?(risposta|interazione|conversazione)|non (ha )?(interagit|risposto alle domande)|(brev|corta|breve) .{0,20}(chiamata|conversazione)|hung up|no (response|answer|conversation)|did not (respond|speak))/;

function leggiRiassunto(v: any): any {
  if (v == null) return null;
  if (typeof v !== "string") return v;
  try { return JSON.parse(v); } catch { return { testo: v }; }
}

// Esito commerciale di una chiamata: quello dichiarato da Wilma con salva_lead,
// se c'è, altrimenti dalle regole sul riassunto.
function esitoCommercialeChiamata(r: any): EsitoCommerciale | null {
  if (r.esito_manuale && ESITI_COMMERCIALI_VALIDI.includes(r.esito_manuale)) return r.esito_manuale;
  if (r.stato !== "risposta" && r.stato !== "interrotta" && !r.lead_esito) return null;
  return (r.lead_esito && ESITO_VOICEBOT_COMMERCIALE[r.lead_esito]) || classificaEsitoCommerciale(r.riassunto, r.trascrizione);
}

function classificaEsitoCommerciale(riassuntoRaw: any, trascrizione?: string | null): EsitoCommerciale | null {
  const r = leggiRiassunto(riassuntoRaw);
  const lista = (v: any) => (Array.isArray(v) ? v : []).map((x: any) => (typeof x === "string" ? x : x?.title || x?.text || x?.name || ""));
  const testo = (r ? [r.titolo, r.testo, ...lista(r.decisioni), ...lista(r.problemi), ...lista(r.argomenti)] : [])
    .filter(x => typeof x === "string").join(" ").toLowerCase().replace(/\s+/g, " ");
  const trasc = typeof trascrizione === "string" ? trascrizione.toLowerCase().replace(/\s+/g, " ") : "";
  if (!testo.trim()) {
    // Senza riassunto: dalla trascrizione si riconoscono solo segreteria e centralino.
    if (trasc && (RE_SEGRETERIA.test(trasc) || RE_CENTRALINO.test(trasc))) return "segreteria";
    return null;
  }
  if (RE_NON_CHIAMARE.test(testo)) return "non_chiamare";
  if (RE_NUMERO_ERRATO.test(testo)) return "numero_errato";
  if (RE_SEGRETERIA.test(testo)) return "segreteria";
  if (RE_NON_INTERESSATO.test(testo)) return "non_interessato";
  if (RE_APPUNTAMENTO.test(testo)) return "appuntamento";
  if (RE_INTERESSATO.test(testo)) return "interessato";
  if (RE_RICHIAMARE.test(testo)) return "richiamare";
  if (RE_CENTRALINO.test(testo)) return "segreteria";
  if (RE_NESSUN_DIALOGO.test(testo)) return "nessun_dialogo";
  if (trasc && RE_SEGRETERIA.test(trasc)) return "segreteria";
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
  await ensureEsitiVoicebot();
  return (await sql!`
    SELECT l.id, l.nome, l.numero, l.stato, l.errore, l.durata_ms, l.queued_at, l.updated_at,
      l.tentativo, l.programmata_at, l.esito_precedente, l.inviata_at, l.esito_manuale, l.esito_manuale_da,
      r.riassunto, r.trascrizione,
      v.esito AS lead_esito, v.nome AS lead_nome, v.azienda AS lead_azienda, v.ruolo AS lead_ruolo, v.fascia AS lead_fascia,
      v.esigenza AS lead_esigenza, v.email AS lead_email, v.note AS lead_note, v.riepilogo AS lead_riepilogo
    FROM live_calls l
    LEFT JOIN LATERAL (
      SELECT * FROM voicebot_esiti e WHERE e.live_call_id = l.id ORDER BY e.id LIMIT 1
    ) v ON true
    LEFT JOIN LATERAL (
      SELECT x.riassunto, x.trascrizione FROM (
        (SELECT r1.riassunto, r1.trascrizione, 0 AS prio, now() AS t FROM call_results r1
         WHERE l.call_id IS NOT NULL AND r1.call_id = l.call_id
           AND (r1.riassunto IS NOT NULL OR r1.trascrizione IS NOT NULL) LIMIT 1)
        UNION ALL
        (SELECT r2.riassunto, r2.trascrizione, 1 AS prio, r2.ts::timestamptz AS t FROM call_results r2
         WHERE l.stato IN ('risposta', 'interrotta') AND r2.numero = l.numero AND r2.azienda = l.azienda
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
  const commerciale = (r: any) => esitoCommercialeChiamata(r);
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
    ["Nome", "Numero", "Esito", "Esito commerciale", "Tentativi", "Durata (secondi)", "Riassunto", "Dettaglio", "Azienda", "Ruolo", "Quando richiamare", "Interesse", "Email"].map(cella).join(";"),
    ...ordinate.map(r => [
      r.nome || "", r.numero, (ESITO_LABEL[r.stato] || ESITO_LABEL.in_coda).label,
      commerciale(r) ? ESITO_COMMERCIALE_LABEL[commerciale(r)!].label : "", r.tentativo || 1,
      r.durata_ms ? Math.round(r.durata_ms / 1000) : "", testoRiassunto(r) || r.lead_riepilogo || "", r.errore || "",
      r.lead_azienda || "", r.lead_ruolo || "", r.lead_fascia || "", r.lead_esigenza || "", r.lead_email || "",
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
    SELECT c.id, c.azienda,
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
    const ora = new Date();
    for (const q of code) {
      const orari = await leggiOrari(aziendaDi(q));
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
  // Promemoria dei follow-up con data di richiamo.
  try {
    await ensureFollowupsExtra();
    const pm = (await sql!`
      SELECT min(richiamare_at) AS t FROM followups
      WHERE stato = 'pending' AND assegnato_a IS NOT NULL AND promemoria_at IS NULL AND richiamare_at IS NOT NULL
    `) as any[];
    if (pm[0]?.t) candidati.push(new Date(pm[0].t).getTime() - PROMEMORIA_ANTICIPO_MIN * 60_000);
  } catch { /* niente */ }
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
    await inviaPromemoriaFollowup();
    await controlloSalute();
    await conservazioneSeServe();
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
// ══════════════════════════════════════════════════════════════
// CONTROLLO DI SALUTE
// Cerca i problemi che bloccano le campagne senza che nessuno se ne accorga
// e li manda per email agli Admin (al massimo una volta ogni 6 ore per
// problema). Parte dal timer, da uno scenario Make orario (/api/cron/salute)
// e quando un Admin apre il sito.
// ══════════════════════════════════════════════════════════════
const SALUTE_RIPETI_ORE = 6;
interface ProblemaSalute { chiave: string; titolo: string; dettaglio: string }

async function trovaProblemi(): Promise<ProblemaSalute[]> {
  if (!sql) return [];
  const problemi: ProblemaSalute[] = [];
  const prova = async (fn: () => Promise<void>) => { try { await fn(); } catch (err) { console.error("Controllo salute:", err); } };
  await ensureAppState();
  await prova(async () => {
    if (!svegliaConfigurata()) return;
    const st = (await sql!`SELECT value, updated_at FROM app_state WHERE key = 'sveglia_stato'`) as any[];
    if (st[0]?.value === "errore") problemi.push({
      chiave: "sveglia", titolo: "La sveglia Make non riesce a programmarsi",
      dettaglio: "Le campagne in coda, le richiamate e le campagne pianificate potrebbero non partire da sole. Controlla in Make che gli scenari \"sveglia\" siano attivi e che il token API sia valido.",
    });
  });
  await ensureLiveSchema();
  await prova(async () => {
    const tutte = (await sql!`
      SELECT c.id, c.azienda, COALESCE(c.voicebot_nome, 'Campagna') AS nome, c.operatore, max(l.updated_at) AS ultimo
      FROM live_campaigns c JOIN live_calls l ON l.campaign_id = c.id
      WHERE c.modalita_coda AND NOT c.in_pausa AND c.fermata_at IS NULL
        AND c.created_at > now() - make_interval(days => ${CODA_GIORNI_MAX}::int) AND c.created_at < now() - interval '20 minutes'
      GROUP BY c.id
      HAVING count(*) FILTER (WHERE l.stato = 'in_coda' AND l.inviata_at IS NULL AND (l.programmata_at IS NULL OR l.programmata_at <= now())) > 0
         AND count(*) FILTER (WHERE l.stato = 'avviata' OR (l.stato = 'in_coda' AND l.inviata_at IS NOT NULL)) = 0
         AND max(l.updated_at) < now() - interval '20 minutes'
    `) as any[];
    const ferme: any[] = [];
    for (const f of tutte) if (dentroOrari(await leggiOrari(aziendaDi(f)), new Date())) ferme.push(f);
    if (ferme.length) problemi.push({
      chiave: "coda_ferma", titolo: ferme.length === 1 ? "Una campagna è ferma" : `${ferme.length} campagne sono ferme`,
      dettaglio: `Hanno contatti da chiamare ma nessuna chiamata parte da oltre 20 minuti, dentro gli orari consentiti: ${ferme.map(f => `${f.nome}${f.operatore ? ` (${f.operatore})` : ""}`).join(", ")}. Di solito è la sveglia Make spenta: aprire In diretta la fa ripartire.`,
    });
  });
  await prova(async () => {
    const e = ((await sql!`
      SELECT count(*) FILTER (WHERE stato = 'errore')::int AS errori, count(*)::int AS totale,
        (array_agg(errore ORDER BY updated_at DESC) FILTER (WHERE stato = 'errore' AND errore IS NOT NULL))[1] AS ultimo
      FROM live_calls WHERE updated_at > now() - interval '1 hour' AND inviata_at IS NOT NULL
    `) as any[])[0];
    if (e && e.errori >= 5 && e.errori >= e.totale * 0.3) problemi.push({
      chiave: "errori_chiamate", titolo: `${e.errori} chiamate in errore nell'ultima ora`,
      dettaglio: `Su ${e.totale} chiamate inviate, ${e.errori} non sono arrivate a Wildix.${e.ultimo ? ` Ultimo errore: ${String(e.ultimo).slice(0, 200)}.` : ""} Controlla lo scenario Make che avvia le chiamate.`,
    });
  });
  await prova(async () => {
    const n = ((await sql!`
      SELECT count(*)::int AS n FROM live_calls
      WHERE stato = 'avviata' AND updated_at < now() - make_interval(mins => ${CODA_DURATA_MAX_MIN + 5}::int)
        AND updated_at > now() - interval '3 hours'
    `) as any[])[0]?.n || 0;
    if (n >= 3) problemi.push({
      chiave: "esiti_wildix", titolo: `${n} chiamate senza esito da Wildix`,
      dettaglio: "Le chiamate sono partite ma Wildix non ha mandato com'è finita. Controlla su Wildix che il webhook degli eventi di chiamata verso il sito sia attivo.",
    });
  });
  await prova(async () => {
    await ensureScheduleSchema();
    const sc = (await sql!`
      SELECT count(*)::int AS n FROM scheduled_campaigns
      WHERE (status = 'expired' AND scheduled_at > now() - interval '24 hours') OR (status = 'failed' AND scheduled_at > now() - interval '24 hours')
    `) as any[];
    if (sc[0]?.n > 0) problemi.push({
      chiave: "pianificate", titolo: sc[0].n === 1 ? "Una campagna pianificata non è partita" : `${sc[0].n} campagne pianificate non sono partite`,
      dettaglio: "Nelle ultime 24 ore. Le trovi in Storico Campagne > pianificate, con il motivo. Rilanciale se servono.",
    });
  });
  return problemi;
}

// Trova i problemi e avvisa gli Admin dei nuovi (o di quelli avvisati più di 6 ore fa).
async function controlloSalute(): Promise<ProblemaSalute[]> {
  const problemi = await trovaProblemi();
  if (!sql) return problemi;
  try {
    const avvisi = (await sql`SELECT key, updated_at FROM app_state WHERE key LIKE 'avviso:%'`) as any[];
    const ultimo = new Map(avvisi.map(a => [a.key.slice(7), new Date(a.updated_at).getTime()]));
    // Problemi risolti: si dimenticano, così se tornano si avvisa di nuovo.
    for (const k of ultimo.keys()) if (!problemi.some(p => p.chiave === k)) await sql`DELETE FROM app_state WHERE key = ${"avviso:" + k}`;
    const daAvvisare = problemi.filter(p => !ultimo.has(p.chiave) || Date.now() - ultimo.get(p.chiave)! > SALUTE_RIPETI_ORE * 3600_000);
    if (!daAvvisare.length || !process.env.SMTP_USER) return problemi;
    // Problemi della piattaforma: li ricevono gli Admin di GEM, non quelli dei clienti.
    const admin = (await utentiDellAzienda(AZIENDA_PRINCIPALE)).filter((u: any) => ruoloDi(u) === "Admin" && u.email && EMAIL_VALIDA_RE.test(u.email)).map((u: any) => u.email);
    const to = admin.length ? admin : process.env.NOTIFY_EMAIL ? [process.env.NOTIFY_EMAIL] : [];
    if (!to.length) return problemi;
    // Si segna prima di inviare: due controlli insieme non mandano due email.
    for (const p of daAvvisare) {
      await sql`INSERT INTO app_state (key, value, updated_at) VALUES (${"avviso:" + p.chiave}, ${p.titolo}, now())
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
    }
    const appUrl = (process.env.APP_URL || "https://outboundcallgem.vercel.app").replace(/\/$/, "");
    const blocchi = problemi.map(p => `<tr><td style="padding:12px 0;border-bottom:1px solid #eef1f6;"><div style="font-size:15px;font-weight:700;color:#991b1b;">${escapeHtml(p.titolo)}</div><div style="font-size:14px;color:#475569;line-height:1.5;margin-top:4px;">${escapeHtml(p.dettaglio)}</div></td></tr>`).join("");
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || "smtp.gmail.com",
      port: parseInt(process.env.SMTP_PORT || "587"),
      secure: process.env.SMTP_SECURE === "true",
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
    await transporter.sendMail({
      from: `"GEM Outbound" <${process.env.SMTP_USER}>`,
      to: to.join(", "),
      subject: `Attenzione: ${daAvvisare[0].titolo}${problemi.length > 1 ? ` (+${problemi.length - 1})` : ""}`,
      text: ["GEM Outbound ha trovato questi problemi:", "", ...problemi.map(p => `- ${p.titolo}: ${p.dettaglio}`), "", `In diretta: ${appUrl}/?tab=live`].join("\n"),
      html: `
<div style="background:#eef1f6;padding:28px 12px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e2e8f0;">
  <tr><td style="padding:28px 40px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
    <td><img src="${appUrl}/gem-logo-color.png" width="96" alt="GEM Group" style="display:block;width:96px;height:auto;"></td>
    <td style="text-align:right;"><span style="display:inline-block;background:#fee2e2;color:#991b1b;font-size:12px;font-weight:700;padding:5px 12px;border-radius:999px;">&#9679; Da controllare</span></td></tr></table></td></tr>
  <tr><td style="padding:26px 40px 6px;font-size:24px;font-weight:700;color:#0f172a;letter-spacing:-0.3px;">Qualcosa non va nelle campagne</td></tr>
  <tr><td style="padding:0 40px 8px;font-size:15px;color:#475569;line-height:1.6;">Il controllo automatico di GEM Outbound ha trovato:</td></tr>
  <tr><td style="padding:0 40px 8px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${blocchi}</table></td></tr>
  <tr><td style="padding:16px 40px 30px;"><a href="${appUrl}/?tab=live" style="display:block;background:#1e3dc8;color:#ffffff;text-decoration:none;text-align:center;font-size:15px;font-weight:600;padding:14px 20px;border-radius:9px;">Apri In diretta</a></td></tr>
  <tr><td style="padding:18px 40px;border-top:1px solid #eef1f6;font-size:12px;color:#94a3b8;line-height:1.6;">Email automatica agli Admin di GEM Outbound. Per lo stesso problema arriva al massimo ogni ${SALUTE_RIPETI_ORE} ore.</td></tr>
</table></div>`,
    });
  } catch (err) {
    console.error("Errore avviso salute:", err);
  }
  return problemi;
}

async function handleSalute(req: any, res: any) {
  if (!tickAutorizzato(req)) return res.status(401).json({ ok: false });
  const problemi = await controlloSalute();
  await conservazioneSeServe();
  res.json({ ok: true, problemi: problemi.map(p => p.chiave) });
}
app.post("/api/cron/salute", handleSalute);
app.get("/api/cron/salute", handleSalute);

// Per l'avviso rosso agli Admin dentro il sito.
app.get("/api/salute", requireAuth, requireSuperAdmin, async (_req, res) => {
  res.json({ ok: true, problemi: await controlloSalute() });
});

// ══════════════════════════════════════════════════════════════
// AZIENDE (solo super-admin, cioè gli Admin di GEM)
// ══════════════════════════════════════════════════════════════
const webhookMakeValido = webhookEsitiValido;
const slugAzienda = (nome: string) => nome.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30);

app.get("/api/aziende", requireAuth, requireSuperAdmin, async (_req: any, res) => {
  const [aziende, users, bots] = await Promise.all([leggiAziende(), readUsers(), readVoicebots()]);
  res.json({
    ok: true,
    aziende: aziende.map(a => ({
      ...a,
      principale: a.id === AZIENDA_PRINCIPALE,
      utenti: users.filter((u: any) => aziendaDi(u) === a.id).length,
      admin: users.filter((u: any) => aziendaDi(u) === a.id && ruoloDi(u) === "Admin").length,
      voicebot: bots.filter((b: any) => aziendaDi(b) === a.id).length,
    })),
  });
});

// Valida i campi modificabili di un'azienda (assenti = invariati).
function campiAzienda(b: any): { campi: Partial<Azienda>; errore?: string } {
  const campi: Partial<Azienda> = {};
  if (b.nome !== undefined) {
    const nome = cleanText(b.nome, 80);
    if (!nome) return { campi, errore: "Scrivi il nome dell'azienda" };
    campi.nome = nome;
  }
  if (typeof b.attiva === "boolean") campi.attiva = b.attiva;
  for (const k of ["webhookChiamate", "webhookAppuntamenti"] as const) {
    if (b[k] === undefined) continue;
    const v = String(b[k] || "").trim();
    if (v && !webhookMakeValido(v)) return { campi, errore: "Webhook non valido: incolla l'indirizzo del webhook Make (https://hook...make.com/...)" };
    campi[k] = v;
  }
  return { campi };
}

app.post("/api/aziende", requireAuth, requireSuperAdmin, async (req: any, res) => {
  const { campi, errore } = campiAzienda(req.body || {});
  if (errore) return res.status(400).json({ ok: false, error: errore });
  if (!campi.nome) return res.status(400).json({ ok: false, error: "Scrivi il nome dell'azienda" });
  if (!sql) return res.status(503).json({ ok: false, error: "Database non disponibile" });
  const aziende = await leggiAziende();
  if (aziende.some(a => a.nome.toLowerCase() === campi.nome!.toLowerCase())) return res.status(400).json({ ok: false, error: "Esiste già un'azienda con questo nome" });
  let id = slugAzienda(campi.nome) || "azienda";
  for (let i = 2; aziende.some(a => a.id === id); i++) id = `${slugAzienda(campi.nome) || "azienda"}-${i}`;
  const nuova: Azienda = { id, nome: campi.nome, attiva: campi.attiva !== false, webhookChiamate: campi.webhookChiamate || "", webhookAppuntamenti: campi.webhookAppuntamenti || "", creataAt: new Date().toISOString() };
  try {
    await scriviDatiConfig("aziende", [...aziende, nuova]);
    await registra(req, "azienda_creata", nuova.nome);
    res.json({ ok: true, azienda: nuova });
  } catch (err) {
    console.error("Errore creazione azienda:", err);
    res.status(500).json({ ok: false, error: "Errore salvataggio" });
  }
});

app.put("/api/aziende/:id", requireAuth, requireSuperAdmin, async (req: any, res) => {
  const { campi, errore } = campiAzienda(req.body || {});
  if (errore) return res.status(400).json({ ok: false, error: errore });
  const aziende = await leggiAziende();
  const i = aziende.findIndex(a => a.id === req.params.id);
  if (i === -1) return res.status(404).json({ ok: false, error: "Azienda non trovata" });
  if (aziende[i].id === AZIENDA_PRINCIPALE && campi.attiva === false) return res.status(400).json({ ok: false, error: "GEM Group non si può sospendere" });
  if (campi.nome && aziende.some((a, k) => k !== i && a.nome.toLowerCase() === campi.nome!.toLowerCase())) return res.status(400).json({ ok: false, error: "Esiste già un'azienda con questo nome" });
  aziende[i] = { ...aziende[i], ...campi };
  try {
    await scriviDatiConfig("aziende", aziende);
    await registra(req, "azienda_modificata", `${aziende[i].nome}${campi.attiva === false ? ", sospesa" : campi.attiva === true ? ", attiva" : ""}`);
    res.json({ ok: true, azienda: aziende[i] });
  } catch (err) {
    console.error("Errore modifica azienda:", err);
    res.status(500).json({ ok: false, error: "Errore salvataggio" });
  }
});

// Si elimina solo un'azienda vuota (senza utenti né voicebot): i dati restano nel database.
app.delete("/api/aziende/:id", requireAuth, requireSuperAdmin, async (req: any, res) => {
  const id = String(req.params.id);
  if (id === AZIENDA_PRINCIPALE) return res.status(400).json({ ok: false, error: "GEM Group non si può eliminare" });
  const [aziende, users, bots] = await Promise.all([leggiAziende(), readUsers(), readVoicebots()]);
  if (!aziende.some(a => a.id === id)) return res.status(404).json({ ok: false, error: "Azienda non trovata" });
  if (users.some((u: any) => aziendaDi(u) === id) || bots.some((b: any) => aziendaDi(b) === id)) {
    return res.status(409).json({ ok: false, error: "Prima elimina utenti e voicebot dell'azienda, oppure sospendila" });
  }
  try {
    await scriviDatiConfig("aziende", aziende.filter(a => a.id !== id));
    await registra(req, "azienda_eliminata", id);
    res.json({ ok: true });
  } catch (err) {
    console.error("Errore eliminazione azienda:", err);
    res.status(500).json({ ok: false, error: "Errore eliminazione" });
  }
});

app.post("/api/cron/tick", handleTick);
app.get("/api/cron/tick", handleTick);

// Impostazioni che l'interfaccia deve conoscere.
app.get("/api/config", requireAuth, async (req: any, res) => {
  const orari = await leggiOrari(req.azienda);
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
      await sql!`ALTER TABLE campaign_history ADD COLUMN IF NOT EXISTS azienda TEXT NOT NULL DEFAULT 'gem'`;
      await sql!`ALTER TABLE contact_lists ADD COLUMN IF NOT EXISTS azienda TEXT NOT NULL DEFAULT 'gem'`;
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
  note?: string; tipoCampagna: string; voicebotNome?: string; contatti: any[]; test: boolean; azienda: string;
}) {
  if (!sql) return;
  try {
    await ensureArchivioSchema();
    await sql`
      INSERT INTO campaign_history (username, operatore, count, scheduled_at, chunk_size, note, tipo_campagna, voicebot_nome, contatti, test, azienda)
      VALUES (${h.username}, ${h.operatore}, ${h.count}, ${h.scheduledAt}, ${h.chunkSize}, ${h.note || null},
              ${h.tipoCampagna}, ${h.voicebotNome || null}, ${JSON.stringify(pulisciContattiArchivio(h.contatti) || [])}::jsonb, ${h.test}, ${h.azienda})
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

// Permessi in più, impostati dall'Admin per ogni persona.
// soloPropriFollowup: vede e gestisce solo i follow-up assegnati a sé (non vale per gli Admin).
// puoEsportare: può scaricare Excel (predefinito sì).
// limiteNumeri: massimo di numeri per campagna (vuoto = nessun limite oltre quello del sito).
function permessiUtente(u: any) {
  const admin = u?.role === "Admin" || u?.isAdmin === true;
  const lim = parseInt(u?.limiteNumeri, 10);
  return {
    soloPropriFollowup: !admin && u?.soloPropriFollowup === true,
    puoEsportare: admin || u?.puoEsportare !== false,
    limiteNumeri: !admin && lim > 0 ? lim : null,
  };
}

async function requireEditor(req: any, res: any): Promise<any | null> {
  const user = req.utente || await findSessionUser(req.session.username);
  if (!user) { res.status(401).json({ ok: false, error: "Utente non trovato" }); return null; }
  if (user.role === "Viewer") { res.status(403).json({ ok: false, error: "Non autorizzato" }); return null; }
  return user;
}

app.get("/api/history", requireAuth, async (req: any, res) => {
  if (!sql) return res.json({ ok: true, history: [] });
  try {
    await ensureArchivioSchema();
    // In produzione non si vedono le campagne di prova fatte negli ambienti di test.
    const rows = (await sql`
      SELECT * FROM campaign_history
      WHERE (test = false OR ${isCallsDryRun()}) AND azienda = ${req.azienda}
      ORDER BY created_at DESC LIMIT 200
    `) as any[];
    res.json({ ok: true, history: rows.map(mapHistoryRow) });
  } catch (err) {
    console.error("Errore lettura storico:", err);
    res.status(500).json({ ok: false, error: "Errore caricamento storico" });
  }
});

app.delete("/api/history", requireAuth, requireAdmin, async (req: any, res) => {
  if (!sql) return res.status(503).json({ ok: false });
  try {
    await ensureArchivioSchema();
    await sql`DELETE FROM campaign_history WHERE test = ${isCallsDryRun()} AND azienda = ${req.azienda}`;
    await registra(req, "storico_svuotato", null);
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
    const rows = (await sql`SELECT * FROM contact_lists WHERE azienda = ${req.azienda} ORDER BY created_at DESC LIMIT 300`) as any[];
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
      INSERT INTO contact_lists (created_by, created_by_nome, nome, contatti, azienda)
      VALUES (${user.username}, ${user.nome || user.username}, ${nome}, ${JSON.stringify(contatti)}::jsonb, ${req.azienda})
      RETURNING *
    `) as any[];
    await registra(req, "lista_salvata", `${nome} (${contatti.length} contatti)`);
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
      WHERE id = ${id} AND azienda = ${req.azienda} AND (${admin} OR lower(created_by) = lower(${user.username}))
      RETURNING id
    `) as any[];
    if (rows.length === 0) return res.status(403).json({ ok: false, error: "Puoi eliminare solo le liste create da te" });
    await registra(req, "lista_eliminata", `Lista ${id}`);
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
        INSERT INTO contact_lists (created_at, created_by, created_by_nome, nome, contatti, azienda)
        VALUES (${creata}, ${user.username}, ${cleanText(l?.createdBy, 120) || user.nome || user.username}, ${nome}, ${JSON.stringify(contatti)}::jsonb, ${aziendaDi(user)})
        ON CONFLICT DO NOTHING RETURNING id
      `) as any[];
      listeImportate += r.length;
    }
    for (const h of storico) {
      const ts = data(h?.ts);
      const count = parseInt(h?.count, 10);
      if (!ts || !(count >= 0)) continue;
      const r = (await sql`
        INSERT INTO campaign_history (created_at, username, operatore, count, scheduled_at, chunk_size, note, contatti, origine, azienda)
        VALUES (${ts}, ${user.username}, ${cleanText(h?.opt, 120) || user.nome || user.username}, ${count}, ${data(h?.scheduledAt)},
                ${Math.min(Math.max(parseInt(h?.chunkSize, 10) || 1, 1), 10)}, ${cleanText(h?.note, 1000) || null},
                ${JSON.stringify(pulisciContattiArchivio(h?.contactsList) || [])}::jsonb, 'browser', ${aziendaDi(user)})
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
  // Tutti la vedono; i Viewer solo in lettura (le azioni sono bloccate nelle loro rotte).
  const az = req.azienda as string;
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
      WHERE c.azienda = ${az} AND (c.created_at > now() - make_interval(hours => ${hours})
         -- Anche le campagne più vecchie che hanno ancora contatti in coda (pausa, richiamate).
         OR (c.modalita_coda AND c.created_at > now() - make_interval(days => ${CODA_GIORNI_MAX}::int) AND c.fermata_at IS NULL
             AND EXISTS (SELECT 1 FROM live_calls x WHERE x.campaign_id = c.id AND x.stato IN ('in_coda', 'avviata'))))
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
      WHERE l.updated_at > now() - make_interval(hours => ${hours}) AND l.stato <> 'in_coda' AND l.azienda = ${az}
      ORDER BY l.updated_at DESC
      LIMIT 80
    `) as any[];

    // Fase 0: quali tipi di evento manda Wildix oltre a quelli già gestiti
    // (es. call:live:progress per le chiamate in corso). Solo per gli admin.
    let diagnostics: any = null;
    if (req.superAdmin) {
      try {
        diagnostics = (await sql`
          SELECT event_type, reason, count(*)::int AS totale FROM webhook_log GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 20
        `) as any[];
      } catch {
        diagnostics = [];
      }
    }
    const orari = await leggiOrari(req.azienda);
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
// esito, durata e riassunto di Wilma. I Viewer la vedono in sola lettura.
app.get("/api/live/campaigns/:id", requireAuth, async (req: any, res) => {
  const id = parseInt(String(req.params.id), 10);
  if (!sql || !(id > 0)) return res.status(404).json({ ok: false, error: "Campagna non trovata" });
  try {
    await ensureLiveSchema();
    const c = ((await sql`
      SELECT id, created_at, operatore, tipo_campagna, voicebot_nome, voicebot_exten, totale, scheduled_id,
             modalita_coda, in_pausa, fermata_at, fermata_da, retry_max, retry_intervallo_min
      FROM live_campaigns WHERE id = ${id} AND azienda = ${req.azienda}
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
        esito_commerciale: esitoCommercialeChiamata(r),
        esito_manuale: r.esito_manuale || null,
        esito_manuale_da: r.esito_manuale_da || null,
        lead: r.lead_esito ? {
          esito: r.lead_esito, nome: r.lead_nome, azienda: r.lead_azienda, ruolo: r.lead_ruolo, fascia: r.lead_fascia,
          esigenza: r.lead_esigenza, email: r.lead_email, note: r.lead_note, riepilogo: r.lead_riepilogo,
        } : null,
      };
    });
    const dnc = await numeriNonChiamare(calls.map(x => x.numero), req.azienda);
    res.json({ ok: true, campaign: c, calls: calls.map(x => ({ ...x, non_chiamare: dnc.has(x.numero) })) });
  } catch (err) {
    console.error("Errore /api/live/campaigns/:id:", err);
    res.status(500).json({ ok: false, error: "Errore caricamento campagna" });
  }
});

// Correzione a mano dell'esito commerciale di una chiamata (Editor e Admin).
// esito null = torna a quello automatico.
app.put("/api/live/calls/:id/esito", requireAuth, async (req: any, res) => {
  const user = req.utente;
  if (!user) return res.status(401).json({ ok: false, error: "Utente non trovato" });
  if (user.role === "Viewer") return res.status(403).json({ ok: false, error: "Non autorizzato" });
  const id = parseInt(String(req.params.id), 10);
  const esito = req.body?.esito == null || req.body.esito === "" ? null : String(req.body.esito);
  if (!sql || !(id > 0)) return res.status(404).json({ ok: false, error: "Chiamata non trovata" });
  if (esito !== null && !ESITI_COMMERCIALI_VALIDI.includes(esito as EsitoCommerciale)) {
    return res.status(400).json({ ok: false, error: "Esito non valido" });
  }
  try {
    await ensureLiveSchema();
    const righe = (await sql`
      UPDATE live_calls SET esito_manuale = ${esito}, esito_manuale_da = ${esito ? user.nome || user.username : null}
      WHERE id = ${id} AND azienda = ${req.azienda} RETURNING id
    `) as any[];
    if (righe.length === 0) return res.status(404).json({ ok: false, error: "Chiamata non trovata" });
    await registra(req, "esito_corretto", `Chiamata ${id}: ${esito || "automatico"}`);
    res.json({ ok: true });
  } catch (err) {
    console.error("Errore PUT /api/live/calls/:id/esito:", err);
    res.status(500).json({ ok: false, error: "Errore salvataggio esito" });
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
      WHERE id = ${id} AND azienda = ${req.azienda} AND modalita_coda AND fermata_at IS NULL
      RETURNING id
    `) as any[];
    if (!r[0]) return res.status(409).json({ ok: false, error: "Questa campagna non si può mettere in pausa (già fermata o inviata tutta a Make)" });
    if (!pausa) await pumpCampaign(id);
    await aggiornaSveglia();
    await registra(req, pausa ? "campagna_pausa" : "campagna_ripresa", `Campagna ${id}`);
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
    const mia = (await sql`SELECT id FROM live_campaigns WHERE id = ${id} AND azienda = ${req.azienda}`) as any[];
    if (!mia[0]) return res.status(404).json({ ok: false, error: "Campagna non trovata" });
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
    await registra(req, "campagna_eliminata", `Campagna ${id}`);
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
      WHERE id = ${id} AND azienda = ${req.azienda} AND modalita_coda AND fermata_at IS NULL
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
    await registra(req, "campagna_fermata", `Campagna ${id}, ${annullate.length} chiamate annullate`);
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
    const rows = (await sql`SELECT * FROM do_not_call WHERE azienda = ${req.azienda} ORDER BY created_at DESC LIMIT 10000`) as any[];
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
      cleanText(req.body?.motivo, 300) || null, "manuale", user.nome || user.username, req.azienda,
    );
    // I numeri aggiunti spariscono subito dalle code delle campagne in corso.
    await ensureLiveSchema();
    await sql`
      UPDATE live_calls l SET stato = 'escluso', errore = 'Nella lista Non chiamare', programmata_at = NULL, updated_at = now()
      FROM do_not_call d WHERE l.stato = 'in_coda' AND l.inviata_at IS NULL AND d.numero = l.numero
        AND d.azienda = l.azienda AND l.azienda = ${req.azienda}
    `;
    await registra(req, "non_chiamare_aggiunti", `${aggiunti} numeri${validi.length === 1 ? ` (${normalizePhone(String(validi[0].numero))})` : ""}`);
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
    const r = (await sql`DELETE FROM do_not_call WHERE numero = ${n} AND azienda = ${req.azienda} RETURNING numero`) as any[];
    if (r.length) await registra(req, "non_chiamare_rimosso", n);
    res.json({ ok: true, rimossi: r.length });
  } catch (err) {
    console.error("Errore rimozione Non chiamare:", err);
    res.status(500).json({ ok: false, error: "Errore" });
  }
});

// ── Orari consentiti: tutti li leggono, solo un Admin li cambia ──
app.get("/api/impostazioni/orari", requireAuth, async (req: any, res) => {
  const orari = await leggiOrari(req.azienda);
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
      INSERT INTO app_state (key, value, updated_at) VALUES (${chiaveOrari(req.azienda)}, ${JSON.stringify(orari)}, now())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
    `;
    orariCache.delete(req.azienda);
    // Le code ferme per orario ripartono (o aspettano la nuova apertura).
    await pumpAllQueues();
    await aggiornaSveglia();
    await registra(req, "orari_modificati", orari.attivo ? descriviOrari(orari) : "spenti");
    res.json({ ok: true, orari, descrizione: descriviOrari(orari) });
  } catch (err) {
    console.error("Errore salvataggio orari:", err);
    res.status(500).json({ ok: false, error: "Errore salvataggio" });
  }
});

// ══════════════════════════════════════════════════════════════
// DATI RACCOLTI DA WILMA (tool salva_lead)
// Lo scenario Make che scrive il foglio esiti del voicebot li manda anche qui
// (POST /api/voicebot/esito, header x-gem-secret): così nome, azienda, ruolo,
// fascia, esigenza, email ed esito stanno nel database e si vedono nel
// dettaglio campagna. Il foglio Google resta com'è.
// ══════════════════════════════════════════════════════════════
const ESITI_VOICEBOT = ["RICONTATTO", "EMAIL", "RICHIAMARE", "NON_INTERESSATO", "NON_CHIAMARE", "NESSUNA_RISPOSTA"];
// Esito del voicebot → esito commerciale (più affidabile delle regole sul riassunto).
const ESITO_VOICEBOT_COMMERCIALE: Record<string, EsitoCommerciale> = {
  RICONTATTO: "interessato",
  EMAIL: "interessato",
  RICHIAMARE: "richiamare",
  NON_INTERESSATO: "non_interessato",
  NON_CHIAMARE: "non_chiamare",
  NESSUNA_RISPOSTA: "nessun_dialogo",
};

let esitiVoicebotReady: Promise<void> | null = null;
function ensureEsitiVoicebot(): Promise<void> {
  if (!esitiVoicebotReady) {
    esitiVoicebotReady = (async () => {
      await sql!`
        CREATE TABLE IF NOT EXISTS voicebot_esiti (
          id             SERIAL PRIMARY KEY,
          ricevuto_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
          esito          TEXT,
          nome           TEXT,
          azienda        TEXT,
          ruolo          TEXT,
          numero         TEXT,
          fascia         TEXT,
          esigenza       TEXT,
          email          TEXT,
          note           TEXT,
          riepilogo      TEXT,
          voicebot_exten TEXT,
          campaign_id    INT,
          live_call_id   INT
        )
      `;
      await sql!`CREATE INDEX IF NOT EXISTS idx_voicebot_esiti_call ON voicebot_esiti (live_call_id)`;
      await sql!`CREATE INDEX IF NOT EXISTS idx_voicebot_esiti_numero ON voicebot_esiti (numero, ricevuto_at DESC)`;
      // "azienda" qui è già il campo raccolto da Wilma (l'azienda del cliente): il cliente di GEM è "cliente".
      await sql!`ALTER TABLE voicebot_esiti ADD COLUMN IF NOT EXISTS cliente TEXT NOT NULL DEFAULT 'gem'`;
    })().catch(err => { esitiVoicebotReady = null; throw err; });
  }
  return esitiVoicebotReady;
}

app.post("/api/voicebot/esito", express.urlencoded({ extended: false, limit: "50kb" }), async (req: any, res) => {
  const secret = process.env.MAKE_WEBHOOK_SECRET;
  const given = String(req.headers["x-gem-secret"] || "");
  if (!secret || !safeEqual(given, secret)) return res.status(401).json({ ok: false });
  if (!sql) return res.status(503).json({ ok: false });
  const b = req.body || {};
  const esito = String(b.esito || "").trim().toUpperCase().replace(/\s+/g, "_");
  // Gli esiti "non raggiunto" ed "errore" li manda il sito stesso al foglio: qui non servono.
  if (!ESITI_VOICEBOT.includes(esito)) return res.json({ ok: true, ignorato: true });
  const testo = (k: string, max = 500) => {
    const v = cleanText(b[k], max);
    return v && !/^non indicato$/i.test(v) ? v : null;
  };
  const numero = normalizePhone(String(b.numero || "")) || null;
  try {
    await ensureEsitiVoicebot();
    await ensureLiveSchema();
    // Il tool a volte parte più volte nella stessa chiamata: si tiene il primo.
    const doppio = numero ? (await sql`
      SELECT 1 FROM voicebot_esiti WHERE numero = ${numero} AND esito = ${esito} AND ricevuto_at > now() - interval '10 minutes' LIMIT 1
    `) as any[] : [];
    if (doppio.length) return res.json({ ok: true, doppione: true });
    // La chiamata del sito a cui appartiene: l'ultima inviata a quel numero nelle ultime ore.
    const chiamata = numero ? ((await sql`
      SELECT l.id, l.campaign_id, l.nome, c.tipo_campagna, c.username, c.voicebot_nome, c.azienda
      FROM live_calls l JOIN live_campaigns c ON c.id = l.campaign_id
      WHERE l.numero = ${numero} AND l.inviata_at > now() - interval '6 hours'
      ORDER BY l.inviata_at DESC LIMIT 1
    `) as any[])[0] : null;
    // Di quale cliente: della campagna, altrimenti del voicebot con quell'interno.
    const exten = cleanText(b.voicebot_exten, 20) || null;
    const cliente = chiamata ? aziendaDi(chiamata)
      : aziendaDi((await readVoicebots()).find((x: any) => exten && String(x.exten) === exten));
    const r = (await sql`
      INSERT INTO voicebot_esiti (esito, nome, azienda, ruolo, numero, fascia, esigenza, email, note, riepilogo, voicebot_exten, campaign_id, live_call_id, cliente)
      VALUES (${esito}, ${testo("nome", 200)}, ${testo("azienda", 200)}, ${testo("ruolo", 200)}, ${numero}, ${testo("fascia", 200)},
              ${testo("esigenza", 300)}, ${(testo("email", 200) || "").toLowerCase() || null}, ${testo("note", 1000)}, ${testo("riepilogo", 2000)},
              ${exten}, ${chiamata?.campaign_id ?? null}, ${chiamata?.id ?? null}, ${cliente})
      RETURNING id
    `) as any[];
    const nomeContatto = testo("nome", 200) || chiamata?.nome || null;
    if (esito === "NON_CHIAMARE" && numero) {
      await aggiungiNonChiamare([{ numero, nome: nomeContatto }], "Chiesto durante la chiamata con il voicebot", "wilma", null, cliente);
    }
    // Campagne standard: follow-up assegnato a chi l'ha lanciata, ed email subito se è interessato.
    const comm = ESITO_VOICEBOT_COMMERCIALE[esito];
    if (chiamata && chiamata.tipo_campagna !== "appuntamenti" && (comm === "interessato" || comm === "richiamare")) {
      const motivo = comm === "interessato" ? "Cliente interessato" : "Da richiamare (chiesto dal cliente)";
      const nuovo = await createFollowup({ callId: `lead-${r[0].id}`, numero, nome: nomeContatto, motivo, assegnatoA: chiamata.username || null, azienda: cliente });
      if (nuovo) {
        const dettagli = [testo("azienda", 200), testo("ruolo", 200), testo("fascia", 200) && `Quando: ${testo("fascia", 200)}`, testo("esigenza", 300) && `Interesse: ${testo("esigenza", 300)}`, testo("email", 200) && `Email: ${(testo("email", 200) || "").toLowerCase()}`].filter(Boolean) as string[];
        await ensureFollowupsExtra();
        if (dettagli.length) await sql`UPDATE followups SET nota = ${dettagli.join(" · ")} WHERE call_id = ${`lead-${r[0].id}`} AND nota IS NULL`;
        if (comm === "interessato") {
          await notificaClienteCaldo({
            numero, nome: nomeContatto, esito: "interessato",
            riassunto: { testo: testo("riepilogo", 2000), decisioni: dettagli },
            campagna: chiamata,
          });
        }
      }
    }
    res.json({ ok: true, id: r[0].id });
  } catch (err) {
    console.error("Errore /api/voicebot/esito:", err);
    res.status(500).json({ ok: false });
  }
});

// ── Preferenze personali (tema, periodo delle statistiche): uguali su ogni dispositivo ──
let preferenzeReady: Promise<void> | null = null;
function ensurePreferenze(): Promise<void> {
  if (!preferenzeReady) {
    preferenzeReady = sql!`
      CREATE TABLE IF NOT EXISTS preferenze_utente (
        username      TEXT PRIMARY KEY,
        valore        JSONB       NOT NULL DEFAULT '{}'::jsonb,
        aggiornato_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `.then(() => undefined).catch(err => { preferenzeReady = null; throw err; });
  }
  return preferenzeReady;
}

app.get("/api/preferenze", requireAuth, async (req: any, res) => {
  if (!sql) return res.json({ ok: true, preferenze: {} });
  try {
    await ensurePreferenze();
    const r = (await sql`SELECT valore FROM preferenze_utente WHERE username = ${String(req.session.username).toLowerCase()}`) as any[];
    res.json({ ok: true, preferenze: r[0]?.valore || {} });
  } catch (err) {
    console.error("Errore lettura preferenze:", err);
    res.json({ ok: true, preferenze: {} });
  }
});

app.put("/api/preferenze", requireAuth, async (req: any, res) => {
  if (!sql) return res.status(503).json({ ok: false });
  const b = req.body || {};
  const nuove: Record<string, unknown> = {};
  if (b.tema === "chiaro" || b.tema === "scuro") nuove.tema = b.tema;
  if ([1, 7, 30, 90].includes(Number(b.statsGiorni))) nuove.statsGiorni = Number(b.statsGiorni);
  if (typeof b.emailAssegnazioni === "boolean") nuove.emailAssegnazioni = b.emailAssegnazioni;
  if (Object.keys(nuove).length === 0) return res.status(400).json({ ok: false, error: "Nessuna preferenza valida" });
  try {
    await ensurePreferenze();
    const r = (await sql`
      INSERT INTO preferenze_utente (username, valore, aggiornato_at) VALUES (${String(req.session.username).toLowerCase()}, ${JSON.stringify(nuove)}::jsonb, now())
      ON CONFLICT (username) DO UPDATE SET valore = preferenze_utente.valore || EXCLUDED.valore, aggiornato_at = now()
      RETURNING valore
    `) as any[];
    res.json({ ok: true, preferenze: r[0]?.valore || nuove });
  } catch (err) {
    console.error("Errore salvataggio preferenze:", err);
    res.status(500).json({ ok: false });
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
      await sql!`ALTER TABLE scheduled_campaigns ADD COLUMN IF NOT EXISTS azienda TEXT NOT NULL DEFAULT 'gem'`;
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
        const azienda = aziendaDi(row);
        const bots = (await readVoicebots()).filter((b: any) => aziendaDi(b) === azienda);
        const bot = row.voicebot_id ? bots.find((b: any) => b.id === row.voicebot_id) : null;
        if (!bot && azienda !== AZIENDA_PRINCIPALE) throw new Error("Voicebot non più disponibile");
        const result = await sendCampaignToMake({
          azienda,
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
          azienda,
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
  // Dichiarazione dell'operatore: lista verificata nel Registro pubblico delle opposizioni (o con consenso).
  const rpoVerificato = req.body?.rpoVerificato === true;
  const { retryMax, retryIntervalloMin } = parseRichiamate(richiamate);
  const campaignType = tipo_campagna === "appuntamenti" ? "appuntamenti" : "standard";

  const parsed = parseLaunchContacts(contatti, campaignType === "appuntamenti");
  if ("error" in parsed) return res.status(400).json({ ok: false, error: parsed.error });
  const contacts = parsed.contacts;

  const user = req.utente;
  const azienda = req.azienda as string;
  if (!user) return res.status(401).json({ ok: false, error: "Utente non trovato" });
  if (user.role === "Viewer") return res.status(403).json({ ok: false, error: "Non autorizzato" });
  const limite = permessiUtente(user).limiteNumeri;
  if (limite && contacts.length > limite) {
    return res.status(400).json({ ok: false, error: `Puoi lanciare al massimo ${limite} numeri per campagna (questa ne ha ${contacts.length}). Dividila o chiedi all'Admin.` });
  }

  // Voicebot: estensione e contesto vengono dalla configurazione salvata,
  // non dal browser, così non si possono indirizzare chiamate altrove.
  const bots = (await readVoicebots()).filter((b: any) => aziendaDi(b) === azienda);
  const bot = voicebot_id ? bots.find((b: any) => b.id === voicebot_id && b.attivo !== false) : null;
  if (voicebot_id && !bot) return res.status(400).json({ ok: false, error: "Voicebot non trovato o disattivato" });
  // Il voicebot predefinito è quello di GEM: le altre aziende scelgono sempre il loro.
  if (!bot && azienda !== AZIENDA_PRINCIPALE) return res.status(400).json({ ok: false, error: "Scegli il voicebot da usare" });

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
          (created_by, operatore, user_email, scheduled_at, tipo_campagna, voicebot_id, chunk_size, note, contacts, retry_max, retry_intervallo_min, azienda)
        VALUES
          (${user.username}, ${user.nome || user.username}, ${user.email || null}, ${t.toISOString()},
           ${campaignType}, ${bot?.id || null}, ${chunkSize}, ${cleanNote || null}, ${JSON.stringify(contacts)}::jsonb,
           ${retryMax}, ${retryIntervalloMin}, ${azienda})
        RETURNING id
      `) as any[];
      await recordHistory({
        username: user.username, operatore: user.nome || user.username, count: contacts.length,
        scheduledAt: t.toISOString(), chunkSize, note: cleanNote, tipoCampagna: campaignType,
        voicebotNome: bot?.nome, contatti: contacts, test: isCallsDryRun(), azienda,
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
      await registra(req, "campagna_pianificata", `${contacts.length} contatti · ${bot?.nome || "voicebot predefinito"} · ${t.toLocaleString("it-IT", { timeZone: "Europe/Rome" })} · ${campaignType === "appuntamenti" ? "conferma appuntamenti" : `Registro opposizioni verificato: ${rpoVerificato ? "sì" : "no"}`}`);
      const esclusi = (await numeriNonChiamare(contacts.map(c => c.numero), azienda)).size;
      const orari = await leggiOrari(azienda);
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
  const orari = await leggiOrari(azienda);
  const adesso = new Date();
  if (!dentroOrari(orari, adesso) && !isCodaSito()) {
    return res.status(400).json({ ok: false, error: `Fuori dagli orari consentiti (${descriviOrari(orari)}). Pianifica la campagna per un orario consentito.` });
  }
  const result = await sendCampaignToMake({
    contacts, campaignType, bot, chunkSize, note: cleanNote, operatore: user.nome, scheduledAt: null,
    username: user.username, retryMax, retryIntervalloMin, azienda,
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
    azienda,
  });

  if (result.sentContacts.length > 0) {
    await recordHistory({
      username: user.username, operatore: user.nome || user.username, count: result.sentContacts.length,
      scheduledAt: null, chunkSize, note: cleanNote, tipoCampagna: campaignType,
      voicebotNome: bot?.nome, contatti: result.sentContacts, test: result.dryRun, azienda,
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

  if (result.sentContacts.length > 0) await registra(req, "campagna_avviata", `${result.sentContacts.length} contatti · ${bot?.nome || "voicebot predefinito"} · ${campaignType === "appuntamenti" ? "conferma appuntamenti" : `Registro opposizioni verificato: ${rpoVerificato ? "sì" : "no"}`}`);
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
          WHERE azienda = ${req.azienda} AND (status = 'pending' OR scheduled_at > now() - interval '14 days')
          ORDER BY scheduled_at DESC LIMIT 100`
      : await sql`
          SELECT * FROM scheduled_campaigns
          WHERE lower(created_by) = lower(${req.session.username}) AND azienda = ${req.azienda}
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
      WHERE id = ${id} AND status = 'pending' AND azienda = ${req.azienda}
        AND (${isAdmin}::boolean OR lower(created_by) = lower(${req.session.username}))
      RETURNING id
    `) as any[];
    if (rows.length === 0) {
      return res.status(409).json({ ok: false, error: "Campagna non annullabile: già partita, già annullata o non tua" });
    }
    await registra(req, "pianificata_annullata", `Campagna pianificata ${id}`);
    res.json({ ok: true });
  } catch (err) {
    console.error("Errore annullamento campagna:", err);
    res.status(500).json({ ok: false, error: "Errore annullamento" });
  }
});

app.post("/api/campaigns/test-call", requireAuth, async (req: any, res) => {
  const parsed = parseLaunchContacts([req.body?.contact], false);
  if ("error" in parsed) return res.status(400).json({ ok: false, error: parsed.error });
  const user = req.utente;
  if (!user) return res.status(401).json({ ok: false, error: "Utente non trovato" });
  if (user.role === "Viewer") return res.status(403).json({ ok: false, error: "Non autorizzato" });

  const dryRun = isCallsDryRun();
  if (dryRun) {
    console.log(`[DRY-RUN] Chiamata test simulata verso ${parsed.contacts[0].numero}, utente ${user.username}`);
    return res.json({ ok: true, dryRun });
  }
  const bot = req.body?.voicebot_id
    ? (await readVoicebots()).find((x: any) => x.id === req.body.voicebot_id && aziendaDi(x) === req.azienda && x.attivo !== false)
    : null;
  if (req.body?.voicebot_id && !bot) return res.status(400).json({ ok: false, error: "Voicebot non trovato o disattivato" });
  if (!bot && req.azienda !== AZIENDA_PRINCIPALE) return res.status(400).json({ ok: false, error: "Scegli il voicebot da usare" });
  const az = (await leggiAziende()).find(a => a.id === req.azienda);
  const ok = await postToMake(webhookMakeValido(az?.webhookChiamate) || MAKE_WEBHOOK_URL_DEFAULT, {
    ...(bot ? { voicebot_nome: bot.nome, voicebot_exten: bot.exten, voicebot_context: bot.context } : {}),
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

// ══════════════════════════════════════════════════════════════
// PRIVACY
// - Registro attività: chi ha fatto cosa (campagne, utenti, voicebot, Non
//   chiamare, follow-up, impostazioni). Lo vedono gli Admin della sua azienda.
// - Conservazione: ogni azienda sceglie dopo quanti mesi cancellare da sola
//   trascrizioni, riassunti, dati raccolti da Wilma e liste di contatti.
// - Diritti dell'interessato: dati di un numero da consegnare, o da cancellare.
// ══════════════════════════════════════════════════════════════
const REGISTRO_MESI = 24;
let registroReady: Promise<void> | null = null;
function ensureRegistro(): Promise<void> {
  if (!registroReady) {
    registroReady = (async () => {
      await sql!`
        CREATE TABLE IF NOT EXISTS registro_attivita (
          id        SERIAL PRIMARY KEY,
          ts        TIMESTAMPTZ NOT NULL DEFAULT now(),
          azienda   TEXT        NOT NULL,
          username  TEXT,
          nome      TEXT,
          azione    TEXT        NOT NULL,
          dettaglio TEXT,
          ip        TEXT
        )
      `;
      await sql!`CREATE INDEX IF NOT EXISTS idx_registro_azienda_ts ON registro_attivita (azienda, ts DESC)`;
    })().catch(err => { registroReady = null; throw err; });
  }
  return registroReady;
}

// Non blocca mai l'azione: se il registro non si scrive, lo si dice nei log.
async function registra(req: any, azione: string, dettaglio: string | null) {
  if (!sql) return;
  try {
    await ensureRegistro();
    const u = req.utente;
    await sql`
      INSERT INTO registro_attivita (azienda, username, nome, azione, dettaglio, ip)
      VALUES (${req.azienda || aziendaDi(u)}, ${u?.username || req.session?.username || null}, ${u?.nome || null}, ${azione},
              ${dettaglio ? String(dettaglio).slice(0, 1000) : null}, ${clientIp(req)})
    `;
  } catch (err) {
    console.error("Errore registro attività:", err);
  }
}

app.get("/api/registro", requireAuth, requireAdmin, async (req: any, res) => {
  if (!sql) return res.json({ ok: true, voci: [] });
  const giorni = Math.min(Math.max(parseInt(String(req.query.giorni || "30"), 10) || 30, 1), 730);
  const chi = String(req.query.chi || "").trim().toLowerCase() || null;
  const azione = String(req.query.azione || "").trim() || null;
  try {
    await ensureRegistro();
    const voci = (await sql`
      SELECT id, ts, username, nome, azione, dettaglio, ip FROM registro_attivita
      WHERE azienda = ${req.azienda} AND ts > now() - make_interval(days => ${giorni}::int)
        AND (${chi}::text IS NULL OR lower(username) = ${chi})
        AND (${azione}::text IS NULL OR azione = ${azione})
      ORDER BY ts DESC LIMIT 2000
    `) as any[];
    res.json({ ok: true, voci });
  } catch (err) {
    console.error("Errore lettura registro:", err);
    res.status(500).json({ ok: false, error: "Errore lettura registro" });
  }
});

// ── Conservazione dei dati ──
const MESI_CONSERVAZIONE = [0, 3, 6, 12, 24];
const chiaveConservazione = (azienda: string) => `conservazione:${azienda}`;
async function leggiConservazione(azienda: string): Promise<number> {
  if (!sql) return 0;
  await ensureAppState();
  const r = (await sql`SELECT value FROM app_state WHERE key = ${chiaveConservazione(azienda)}`) as any[];
  const m = parseInt(r[0]?.value || "0", 10);
  return MESI_CONSERVAZIONE.includes(m) ? m : 0;
}

// Cancella i dati personali più vecchi del limite di ogni azienda. Restano i
// conteggi (chiamate, esiti tecnici, durate) per statistiche e fatturazione.
async function applicaConservazione(azienda: string, mesi: number): Promise<Record<string, number>> {
  const prima = `${mesi} months`;
  const n = (r: any) => (Array.isArray(r) ? r.length : 0);
  const out: Record<string, number> = {};
  out.riassunti = n(await sql!`
    UPDATE call_results SET trascrizione = NULL, riassunto = NULL
    WHERE azienda = ${azienda} AND ts::timestamptz < now() - ${prima}::interval AND (trascrizione IS NOT NULL OR riassunto IS NOT NULL)
    RETURNING call_id`);
  await ensureEsitiVoicebot();
  out.datiWilma = n(await sql!`DELETE FROM voicebot_esiti WHERE cliente = ${azienda} AND ricevuto_at < now() - ${prima}::interval RETURNING id`);
  await ensureLiveSchema();
  out.chiamate = n(await sql!`
    UPDATE live_calls SET dati = NULL WHERE azienda = ${azienda} AND queued_at < now() - ${prima}::interval AND dati IS NOT NULL RETURNING id`);
  await ensureArchivioSchema();
  out.storico = n(await sql!`
    UPDATE campaign_history SET contatti = '[]'::jsonb
    WHERE azienda = ${azienda} AND created_at < now() - ${prima}::interval AND jsonb_array_length(COALESCE(contatti, '[]'::jsonb)) > 0 RETURNING id`);
  await ensureScheduleSchema();
  out.pianificate = n(await sql!`
    UPDATE scheduled_campaigns SET contacts = '[]'::jsonb
    WHERE azienda = ${azienda} AND status <> 'pending' AND scheduled_at < now() - ${prima}::interval
      AND jsonb_array_length(contacts) > 0 RETURNING id`);
  await ensureFollowupsExtra();
  out.followup = n(await sql!`
    DELETE FROM followups WHERE azienda = ${azienda} AND stato = 'done'
      AND COALESCE(chiuso_at, created_at) < now() - ${prima}::interval RETURNING id`);
  return out;
}

// Al massimo una volta ogni 6 ore (dal timer e dalle pagine più aperte).
async function conservazioneSeServe(): Promise<void> {
  if (!sql) return;
  try {
    await ensureAppState();
    const presa = (await sql`
      INSERT INTO app_state (key, value, updated_at) VALUES ('conservazione_ultima', 'ok', now())
      ON CONFLICT (key) DO UPDATE SET value = 'ok', updated_at = now()
      WHERE app_state.updated_at < now() - interval '6 hours'
      RETURNING key
    `) as any[];
    if (!presa.length) return;
    await ensureRegistro();
    await sql`DELETE FROM registro_attivita WHERE ts < now() - make_interval(months => ${REGISTRO_MESI}::int)`;
    for (const a of await leggiAziende()) {
      const mesi = await leggiConservazione(a.id);
      if (!mesi) continue;
      const fatti = await applicaConservazione(a.id, mesi);
      const tot = Object.values(fatti).reduce((x, y) => x + y, 0);
      if (tot > 0) {
        await sql`INSERT INTO registro_attivita (azienda, azione, dettaglio) VALUES (${a.id}, 'conservazione_applicata',
          ${`Dati più vecchi di ${mesi} mesi cancellati: ${fatti.riassunti} trascrizioni/riassunti, ${fatti.datiWilma} schede di Wilma, ${fatti.followup} follow-up chiusi, ${fatti.storico + fatti.pianificate} liste di campagne`})`;
      }
    }
  } catch (err) {
    console.error("Errore conservazione dati:", err);
  }
}

app.get("/api/impostazioni/privacy", requireAuth, requireAdmin, async (req: any, res) => {
  try {
    res.json({ ok: true, mesi: await leggiConservazione(req.azienda), opzioni: MESI_CONSERVAZIONE });
  } catch (err) {
    console.error("Errore lettura privacy:", err);
    res.status(500).json({ ok: false, error: "Errore" });
  }
});

app.put("/api/impostazioni/privacy", requireAuth, requireAdmin, async (req: any, res) => {
  const mesi = parseInt(req.body?.mesi, 10);
  if (!MESI_CONSERVAZIONE.includes(mesi)) return res.status(400).json({ ok: false, error: "Scegli un periodo valido" });
  if (!sql) return res.status(503).json({ ok: false, error: "Database non disponibile" });
  try {
    await ensureAppState();
    await sql`
      INSERT INTO app_state (key, value, updated_at) VALUES (${chiaveConservazione(req.azienda)}, ${String(mesi)}, now())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
    `;
    await registra(req, "conservazione_modificata", mesi ? `${mesi} mesi` : "nessuna cancellazione automatica");
    // Si applica subito, così l'Admin vede l'effetto.
    const fatti = mesi ? await applicaConservazione(req.azienda, mesi) : null;
    res.json({ ok: true, mesi, cancellati: fatti });
  } catch (err) {
    console.error("Errore salvataggio privacy:", err);
    res.status(500).json({ ok: false, error: "Errore salvataggio" });
  }
});

// ── Dati di un numero (richiesta di accesso o di cancellazione) ──
// Nelle liste salvate i numeri possono essere scritti in modi diversi: si
// confrontano normalizzati, dopo un primo filtro sulle ultime 9 cifre.
const ultimeCifre = (n: string) => n.replace(/\D/g, "").slice(-9);
async function righeConNumero(tabella: "campaign_history" | "contact_lists" | "scheduled_campaigns", colonna: "contatti" | "contacts", azienda: string, numero: string) {
  const like = `%${ultimeCifre(numero)}%`;
  // Solo le cifre: "340 555 5555" e "+39 3405555555" si trovano allo stesso modo (poi si confronta esatto).
  const rows = (await sql!(`SELECT id, ${colonna} AS c FROM ${tabella} WHERE azienda = $1 AND regexp_replace(${colonna}::text, '[^0-9]', '', 'g') LIKE $2`, [azienda, like])) as any[];
  return rows.map(r => ({ id: r.id, c: Array.isArray(r.c) ? r.c : [] }))
    .filter(r => r.c.some((x: any) => normalizePhone(String(x?.numero || "")) === numero));
}

async function datiDelNumero(azienda: string, numero: string) {
  await ensureFollowupsExtra();
  await ensureEsitiVoicebot();
  await ensureLiveSchema();
  await ensureArchivioSchema();
  await ensureScheduleSchema();
  await ensureDncSchema();
  const [chiamate, followup, wilma, campagne, nome, nonChiamare] = await Promise.all([
    sql!`SELECT call_id, ts, risposto, durata, riassunto, trascrizione FROM call_results WHERE azienda = ${azienda} AND numero = ${numero} ORDER BY ts DESC`,
    sql!`SELECT id, motivo, stato, nota, assegnato_a, created_at, esito_finale FROM followups WHERE azienda = ${azienda} AND numero = ${numero} ORDER BY created_at DESC`,
    sql!`SELECT ricevuto_at, esito, nome, azienda, ruolo, fascia, esigenza, email, note, riepilogo FROM voicebot_esiti WHERE cliente = ${azienda} AND numero = ${numero} ORDER BY ricevuto_at DESC`,
    sql!`SELECT l.id, l.stato, l.queued_at, c.voicebot_nome FROM live_calls l JOIN live_campaigns c ON c.id = l.campaign_id WHERE l.azienda = ${azienda} AND l.numero = ${numero} ORDER BY l.queued_at DESC`,
    nomeContatto(numero, azienda),
    sql!`SELECT motivo, fonte, created_at FROM do_not_call WHERE azienda = ${azienda} AND numero = ${numero}`,
  ]) as any[];
  const [storico, liste, pianificate] = await Promise.all([
    righeConNumero("campaign_history", "contatti", azienda, numero),
    righeConNumero("contact_lists", "contatti", azienda, numero),
    righeConNumero("scheduled_campaigns", "contacts", azienda, numero),
  ]);
  return { chiamate, followup, wilma, campagne, nome, nonChiamare, storico, liste, pianificate };
}

function numeroDaRichiesta(v: unknown): string | null {
  const n = normalizePhone(String(v || "").trim());
  return n && /^\+?\d{6,15}$/.test(n) ? n : null;
}

app.get("/api/privacy/numero", requireAuth, requireAdmin, async (req: any, res) => {
  const numero = numeroDaRichiesta(req.query.numero);
  if (!numero) return res.status(400).json({ ok: false, error: "Numero non valido" });
  if (!sql) return res.status(503).json({ ok: false });
  try {
    const d = await datiDelNumero(req.azienda, numero);
    await registra(req, "dati_numero_consultati", `…${numero.slice(-4)}`);
    res.json({
      ok: true, numero,
      riepilogo: {
        nome: d.nome, chiamate: d.chiamate.length, followup: d.followup.length, datiWilma: d.wilma.length,
        campagne: d.campagne.length, listeEStorico: d.storico.length + d.liste.length + d.pianificate.length,
        nonChiamare: d.nonChiamare.length > 0,
      },
      // Per la risposta all'interessato (diritto di accesso).
      dati: {
        nome: d.nome,
        chiamate: d.chiamate.map((c: any) => ({ data: c.ts, risposto: c.risposto, durataSecondi: c.durata ? Math.round(c.durata / 1000) : 0, riassunto: leggiRiassunto(c.riassunto)?.testo || null, trascrizione: c.trascrizione || null })),
        followup: d.followup.map((f: any) => ({ data: f.created_at, motivo: f.motivo, stato: f.stato, nota: f.nota, esito: f.esito_finale })),
        datiRaccoltiDalVoicebot: d.wilma,
        campagne: d.campagne.map((c: any) => ({ data: c.queued_at, voicebot: c.voicebot_nome, esito: c.stato })),
        nonChiamare: d.nonChiamare,
      },
    });
  } catch (err) {
    console.error("Errore dati del numero:", err);
    res.status(500).json({ ok: false, error: "Errore lettura" });
  }
});

// Diritto alla cancellazione: toglie il numero e i suoi dati da tutto il sito
// dell'azienda. Le chiamate restano nei conteggi, senza numero né nome. Se
// richiesto, il numero va (o resta) in "Non chiamare": è l'unico dato che si
// tiene, proprio per non richiamarlo.
app.post("/api/privacy/cancella-numero", requireAuth, requireAdmin, async (req: any, res) => {
  const numero = numeroDaRichiesta(req.body?.numero);
  if (!numero) return res.status(400).json({ ok: false, error: "Numero non valido" });
  if (!sql) return res.status(503).json({ ok: false });
  const az = req.azienda as string;
  const tieniNonChiamare = req.body?.nonChiamare !== false;
  try {
    const d = await datiDelNumero(az, numero);
    const n = (r: any) => (Array.isArray(r) ? r.length : 0);
    const fatti: Record<string, number> = {};
    fatti.chiamate = n(await sql`DELETE FROM call_results WHERE azienda = ${az} AND numero = ${numero} RETURNING call_id`);
    fatti.followup = n(await sql`DELETE FROM followups WHERE azienda = ${az} AND numero = ${numero} RETURNING id`);
    fatti.datiWilma = n(await sql`DELETE FROM voicebot_esiti WHERE cliente = ${az} AND numero = ${numero} RETURNING id`);
    await sql`DELETE FROM contact_names WHERE azienda = ${az} AND numero = ${numero}`;
    fatti.campagne = n(await sql`
      UPDATE live_calls SET numero = 'cancellato', nome = NULL, dati = NULL, stato = CASE WHEN stato = 'in_coda' THEN 'annullata' ELSE stato END
      WHERE azienda = ${az} AND numero = ${numero} RETURNING id`);
    const togli = (c: any[]) => c.filter((x: any) => normalizePhone(String(x?.numero || "")) !== numero);
    for (const r of d.storico) await sql`UPDATE campaign_history SET contatti = ${JSON.stringify(togli(r.c))}::jsonb WHERE id = ${r.id}`;
    for (const r of d.liste) await sql`UPDATE contact_lists SET contatti = ${JSON.stringify(togli(r.c))}::jsonb WHERE id = ${r.id}`;
    for (const r of d.pianificate) await sql`UPDATE scheduled_campaigns SET contacts = ${JSON.stringify(togli(r.c))}::jsonb WHERE id = ${r.id}`;
    fatti.liste = d.storico.length + d.liste.length + d.pianificate.length;
    await ensureNotifiche();
    await sql`DELETE FROM notifiche WHERE testo LIKE ${"%" + numero + "%"} AND username IN (SELECT unnest(${(await utentiDellAzienda(az)).map((u: any) => String(u.username).toLowerCase())}::text[]))`;
    if (tieniNonChiamare) await aggiungiNonChiamare([{ numero, nome: null }], "Richiesta di cancellazione dei dati", "privacy", req.utente?.nome || req.session.username, az);
    else await sql`DELETE FROM do_not_call WHERE azienda = ${az} AND numero = ${numero}`;
    // Nel registro non si scrive il numero intero: resta solo la parte finale.
    await registra(req, "dati_numero_cancellati", `…${numero.slice(-4)}: ${fatti.chiamate} chiamate, ${fatti.followup} follow-up, ${fatti.datiWilma} schede di Wilma, ${fatti.liste} liste${tieniNonChiamare ? ", messo in Non chiamare" : ""}`);
    res.json({ ok: true, cancellati: fatti, nonChiamare: tieniNonChiamare });
  } catch (err) {
    console.error("Errore cancellazione numero:", err);
    res.status(500).json({ ok: false, error: "Errore cancellazione" });
  }
});

export default app;
