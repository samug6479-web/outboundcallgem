# GEM Outbound — Setup tecnico

Documentazione per sviluppo e deploy. Per la descrizione del prodotto vedi il [README](./README.md).

## Stack

- **Frontend**: React 19 + Vite 6 + Tailwind CSS 4
- **Backend**: Express (funzione serverless singola su Vercel, `api/index.ts`)
- **Database**: Neon Postgres (`@neondatabase/serverless`) — esiti chiamate, follow-up, contatti, access log
- **Utenti e voicebot**: file JSON versionati e letti/scritti via API GitHub (⚠️ il repo DEVE restare privato)
- **Integrazione**: webhook Wildix (esiti, trascrizioni, riassunti) con verifica firma HMAC-SHA256
- **Email**: nodemailer (SMTP) per notifiche e ticket di supporto
- **Auth**: sessioni JWT (12h) + 2FA TOTP (otplib)

## Prerequisiti

- Node.js 24.x
- Un database Neon Postgres
- Un Personal Access Token GitHub con permesso di scrittura sul repo (per persistere utenti/voicebot)

## Variabili d'ambiente

Copia `env.example` e configura i valori. Su Vercel vanno impostate nel pannello *Settings → Environment Variables*.

| Variabile | Obbligatoria | Descrizione |
|-----------|:---:|-------------|
| `JWT_SECRET` | ✅ | Segreto per firmare i token di sessione. **In produzione l'avvio fallisce se manca.** Genera un valore casuale lungo (es. `openssl rand -hex 32`). |
| `DATABASE_URL` | ✅ | Connection string Neon Postgres. |
| `WILDIX_WEBHOOK_SECRET` | ✅ | Segreto condiviso con Wildix per verificare la firma HMAC del webhook. |
| `GITHUB_TOKEN` | ✅* | PAT GitHub per leggere/scrivere `users.json` e `voicebots.json`. Senza, si usa il fallback su file locale (solo sviluppo). |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` | ⚠️ | Credenziali SMTP per l'invio email. Senza, le notifiche e il form di supporto restano disattivati. |
| `SMTP_SECURE` | ➖ | `"true"` per TLS implicito (porta 465). Default: STARTTLS. |
| `NOTIFY_EMAIL` | ⚠️ | Destinatario delle notifiche (follow-up e fine campagna). |
| `APP_URL` | ➖ | URL pubblico dell'app. |
| `MAKE_WEBHOOK_URL` / `MAKE_WEBHOOK_URL_APPUNTAMENTI` | ➖ | Webhook Make per il lancio campagne (standard / appuntamenti). Il browser non li vede più: li chiama il server. Se vuote, si usano gli URL storici. |
| `MAKE_WEBHOOK_SECRET` | ➖ | Inviato a Make nell'header `x-gem-secret`, da controllare con un filtro nello scenario. |
| `CALLS_DRY_RUN` | ➖ | `"true"` = lancio simulato (nessuna chiamata). Se vuota: chiamate reali **solo** in produzione Vercel. |
| `GITHUB_DATA_BRANCH` | ➖ | Branch per `users.json` / `voicebots.json`. Vuota = branch principale. Nelle anteprime Vercel, senza questa variabile, le scritture sono bloccate. |

`*` In produzione GitHub è di fatto necessario, perché su serverless il filesystem è effimero.

## Database — migrazioni

Le tabelle usate dal backend (`call_results`, `followups`, `contact_names`, `webhook_log`) vanno create su Neon. La tabella degli access log:

```bash
psql "$DATABASE_URL" -f scripts/migrations/001_access_logs.sql
```

La tabella `auth_attempts` (limite tentativi di login/OTP) viene creata dal backend al primo utilizzo; in alternativa `scripts/migrations/002_auth_attempts.sql`.

## Ambiente di test

Le anteprime Vercel (un deploy per ogni branch/PR) **non fanno chiamate reali**: il lancio campagna e la chiamata di prova vengono simulati, e l'app mostra il prefisso `[TEST]`. Anche l'email di riepilogo arriva con `[TEST - nessuna chiamata reale]` nell'oggetto.

Per un test isolato dalla produzione, nelle variabili d'ambiente Vercel con target **Preview**:

1. `DATABASE_URL` → un **branch Neon** dedicato (Neon → Branches → Create branch), non il database di produzione.
2. `GITHUB_DATA_BRANCH` → un branch dedicato ai dati di test (es. `test-data`, creato da `main`). Senza, le modifiche a utenti e voicebot sono bloccate in anteprima.
3. `CALLS_DRY_RUN` → lascia vuota (simulazione). Per provare una chiamata vera verso il tuo numero, impostala a `false` solo per il tempo del test.

## Sviluppo locale

```bash
npm install
cp env.example .env.local   # e compila i valori
npm run dev                 # server + Vite su http://localhost:3000
```

## Comandi

| Comando | Azione |
|---------|--------|
| `npm run dev` | Avvia server Express + Vite in dev (HMR). |
| `npm run build` | Build di produzione del frontend in `dist/`. |
| `npm run lint` | Type-check TypeScript (`tsc --noEmit`). |
| `npm run clean` | Rimuove `dist/`. |

## Deploy

Il deploy avviene su Vercel. Il routing è gestito da `vercel.json`: le richieste `/api/*` vanno alla funzione serverless, tutto il resto alla SPA. Assicurati che **tutte** le variabili d'ambiente obbligatorie siano configurate prima del primo deploy in produzione.

## Test del webhook

Simula un evento Wildix firmato senza fare una chiamata reale:

```bash
WILDIX_WEBHOOK_SECRET=xxx node scripts/test-webhook.js
```

## ⚠️ Note di sicurezza

- Il repository **deve restare privato**: `users.json` contiene hash password e segreti 2FA, `call-results.json` contiene dati dei clienti.
- Dopo qualsiasi esposizione del repo, **rigenera** i segreti 2FA e cambia le password.
- Non committare mai `.env*` (già in `.gitignore`).
