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
| `MAKE_WEBHOOK_SECRET` | ➖ | Inviato a Make nell'header `x-gem-secret`, da controllare con un filtro nello scenario. Lo stesso valore protegge `/api/live/make-event`, con cui Make avvisa il sito dopo ogni richiesta di chiamata (pagina "In diretta"). |
| `CALLS_DRY_RUN` | ➖ | `"true"` = lancio simulato (nessuna chiamata). Se vuota: chiamate reali **solo** in produzione Vercel. |
| `GITHUB_DATA_BRANCH` | ➖ | Branch per `users.json` / `voicebots.json`. Vuota = branch principale. Nelle anteprime Vercel, senza questa variabile, le scritture sono bloccate. |
| `CAMPAIGN_QUEUE_MODE` | ➖ | Vuota (predefinito) = la coda delle chiamate la gestisce il sito: manda a Make un contatto per volta (vedi sotto). Serve per pausa, orari consentiti, richiamate e "Non chiamare" in coda. `make` = vecchio invio, tutta la lista a Make. |
| `MAX_CHIAMATE_SIMULTANEE` | ➖ | Campagne standard: quante chiamate al massimo insieme (1–10, default 1). Per alzarlo va tolta la coda sequenziale nello scenario Make "Chiama Lista". |
| `MAX_CHIAMATE_SIMULTANEE_APPUNTAMENTI` | ➖ | Campagne conferma appuntamenti: quante chiamate al massimo insieme (1–10, default 3). |
| `MAKE_API_TOKEN` | ➖ | Token API di Make (permesso `scenarios:write`): il sito programma lo scenario "Timer campagne" solo quando serve (vedi "Timer del server"). |
| `CRON_SECRET` | ➖ | Alternativa a `MAKE_WEBHOOK_SECRET` per il timer `/api/cron/tick` (header `Authorization: Bearer …`, formato di Vercel Cron). |

`*` In produzione GitHub è di fatto necessario, perché su serverless il filesystem è effimero.

## Database — migrazioni

Le tabelle usate dal backend (`call_results`, `followups`, `contact_names`, `webhook_log`) vanno create su Neon. La tabella degli access log:

```bash
psql "$DATABASE_URL" -f scripts/migrations/001_access_logs.sql
```

La tabella `auth_attempts` (limite tentativi di login/OTP) viene creata dal backend al primo utilizzo; in alternativa `scripts/migrations/002_auth_attempts.sql`.

## Campagne pianificate

Make non sa aspettare un orario, quindi le campagne pianificate restano nella tabella `scheduled_campaigns` e partono dal server all'orario scelto. Il "timer" è l'app: finché è aperta su almeno un dispositivo, ogni 30 secondi chiama `GET /api/campaigns/scheduled`, che prima di rispondere invia a Make le campagne arrivate all'orario.

- Nessuna app aperta all'orario → la campagna non parte. Se il ritardo supera 30 minuti viene segnata **scaduta** (evita chiamate fuori orario).
- Una campagna può essere annullata finché è "in attesa" (dal suo autore o da un Admin).
- La tabella viene creata in automatico; in alternativa `scripts/migrations/003_scheduled_campaigns.sql`.

## Ambiente di test

Le anteprime Vercel (un deploy per ogni branch/PR) **non fanno chiamate reali**: il lancio campagna e la chiamata di prova vengono simulati, e l'app mostra il prefisso `[TEST]`. Anche l'email di riepilogo arriva con `[TEST - nessuna chiamata reale]` nell'oggetto.

Per un test isolato dalla produzione, nelle variabili d'ambiente Vercel con target **Preview**:

1. `DATABASE_URL` → un **branch Neon** dedicato (Neon → Branches → Create branch), non il database di produzione.
2. `GITHUB_DATA_BRANCH` → un branch dedicato ai dati di test (es. `test-data`, creato da `main`). Senza, le modifiche a utenti e voicebot sono bloccate in anteprima.
3. `CALLS_DRY_RUN` → lascia vuota (simulazione). Per provare una chiamata vera verso il tuo numero, impostala a `false` solo per il tempo del test.

### Timer del server: la "sveglia" Make

Le campagne pianificate partono quando il server viene "svegliato". Senza sveglia lo fa l'app aperta su un dispositivo, ogni 30 secondi.

Con la sveglia il sito programma lo scenario Make **"GEM Outbound - Timer campagne (sveglia)"** (id 8130692) per **una sola esecuzione** all'orario che serve:
- la prossima campagna pianificata;
- oppure il controllo per l'email di fine campagna.

Quando suona, lo scenario chiama `/api/cron/tick`. Il sito fa partire le campagne arrivate all'orario e programma la sveglia successiva. Se non c'è più niente in programma, la spegne.

Gli scenari sveglia sono **due** e si alternano ("Timer campagne (sveglia)" con `?s=1` nell'URL e "sveglia 2" con `?s=2`). Make spegne uno scenario "una volta" appena finisce di girare: lo scenario che sta chiamando il tick non si può riattivare da dentro il tick, quindi il sito arma l'altro.

Con più campagne pianificate la sveglia è una sola, sulla prima. Una campagna pianificata prima di quella in programma la fa anticipare. Una campagna annullata può lasciare una sveglia "a vuoto", che costa una sola operazione.

Le chiamate alle API di Make non consumano operazioni: si paga solo un'esecuzione quando c'è davvero qualcosa da fare.

Per attivarla, su Vercel (Production):
- `MAKE_API_TOKEN` (accettato anche `MAKE_API_TOKE`): token API di Make (profilo → API → Add token) con permesso `scenarios:write`.
- `MAKE_TIMER_SCENARIO_ID` e `MAKE_TIMER_SCENARIO_ID_2` (facoltative, default `8130692` e `8132573`) e `MAKE_API_URL` (facoltativa, default `https://eu1.make.com/api/v2`).

In alternativa, qualsiasi servizio può chiamare `/api/cron/tick` a intervalli fissi (header `x-gem-secret`), ma consuma un'esecuzione a ogni giro.

### Email di fine campagna

Quando tutte le chiamate di una campagna hanno un esito, a chi l'ha lanciata (email del profilo, altrimenti `NOTIFY_EMAIL`) arriva un'email:
- numeri della campagna (risposte, non risposte, interrotte, durata media);
- esito e riassunto di ogni chiamata;
- CSV allegato da aprire con Excel.

I riassunti arrivano da Wildix qualche minuto dopo la fine della chiamata: l'email li aspetta al massimo 10 minuti. Una campagna senza avanzamenti da oltre 60 minuti riceve un'email "Campagna ferma" con le chiamate rimaste senza esito.

Il controllo parte:
- a ogni esito di chiamata;
- a ogni riassunto ricevuto;
- dal timer, o dall'app aperta ogni 30 secondi.

### Coda gestita dal sito (predefinita)

Il sito tiene la coda di ogni campagna e manda a Make **un contatto per esecuzione**:

- non ci sono mai più di N chiamate in corso per campagna (N = scelta dell'operatore, fino a `MAX_CHIAMATE_SIMULTANEE` o `MAX_CHIAMATE_SIMULTANEE_APPUNTAMENTI`);
- una chiamata libera il posto quando ha un esito:
  - esito da Make (non partita, errore);
  - fine chiamata dal webhook Wildix `call:completed` (risposta, interrotta, non risposta);
- senza notizie da Make entro 10 minuti la chiamata va in errore. Dopo 15 minuti dall'avvio senza fine chiamata il posto si libera comunque.

Lo scenario Make "Chiama Lista" aspetta la risposta del cliente e ha la coda **sequenziale**: per più di 1 chiamata insieme nelle campagne standard va disattivato **Sequential processing** e alzato `MAX_CHIAMATE_SIMULTANEE`. Il webhook Wildix `call:completed` deve arrivare allo stesso dominio dell'app, altrimenti ogni posto si libera solo dopo 15 minuti.

Con la coda del sito funzionano anche:

- **Pausa, ripresa e stop** di una campagna da In diretta. In pausa non partono nuove chiamate; con lo stop i contatti non ancora chiamati diventano "Annullata".
- **Richiamate dei non raggiunti** (rifiutata, occupato, senza risposta): 0–3 tentativi in più, dopo 30 minuti – 24 ore, scelti al lancio. L'esito va allo Sheets solo dopo l'ultimo tentativo.
- **Orari consentiti** (Amministrazione → Impostazioni): giorni e fasce in ora italiana. Fuori orario le chiamate restano in coda e la sveglia Make le fa ripartire all'apertura. Spenti finché un Admin non li attiva.
- **Lista Non chiamare** (tabella `do_not_call`): i numeri vengono tolti al lancio e dalle code in corso. Wilma aggiunge chi chiede di non essere più contattato (dal riassunto della chiamata).

### Esito commerciale e clienti caldi

Dal riassunto di Wilma il sito ricava l'esito commerciale: Appuntamento, Interessato, Da richiamare, Non interessato, Non chiamare, Da valutare (regole sulle parole del riassunto, `classificaEsitoCommerciale`). Nelle campagne standard:

- Interessato e Appuntamento creano un follow-up assegnato a chi ha lanciato la campagna e gli mandano subito un'email;
- Da richiamare crea un follow-up.

L'esito commerciale compare in In diretta, Esiti Chiamate, nell'email di fine campagna e nelle Statistiche (confronto tra voicebot e per fascia oraria).

### Ambiente di test completo

Per provare timer, coda e chiamate simultanee senza toccare la produzione, sull'anteprima Vercel del branch:

1. `DATABASE_URL` (Preview) → branch Neon dedicato.
2. **Protection Bypass for Automation** (Vercel → Settings → Deployment Protection): genera il segreto. Make e Wildix lo devono inviare nell'header `x-vercel-protection-bypass`, altrimenti l'anteprima li blocca.
3. In Make, copie di prova degli scenari:
   - "Chiama Lista" e "Conferma Appuntamenti", con nuovo webhook, Sequential processing disattivato e richiami verso l'URL dell'anteprima;
   - il timer, verso l'URL dell'anteprima.
4. Variabili Preview:
   - `MAKE_WEBHOOK_URL` e `MAKE_WEBHOOK_URL_APPUNTAMENTI` → i webhook delle copie;
   - `MAX_CHIAMATE_SIMULTANEE` (la coda del sito è già predefinita);
   - `CALLS_DRY_RUN=false` solo durante la prova.
5. In Wildix (WMS → Integrazioni → Webhook), un secondo webhook `call:completed` verso `https://<anteprima>/api/wildix-webhook` con lo stesso segreto.

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
