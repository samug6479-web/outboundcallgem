import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Radio, RefreshCw, AlertTriangle, PhoneCall, PhoneMissed, Phone, Clock, XCircle, ChevronDown, ChevronRight, Pause, Play, Square, Moon, Trash2 } from 'lucide-react';
import { authFetch } from '../lib/authFetch';
import { useCampaign } from '../context/CampaignContext';
import { cn } from '../lib/utils';
import { STATI, Stato, azioneCampagna, oraBreve } from './liveStati';
import { CampaignDetail } from './CampaignDetail';
import { ConfirmModal } from './ConfirmModal';

interface LiveCampaign {
  id: number;
  created_at: string;
  operatore: string | null;
  tipo_campagna: string;
  voicebot_nome: string | null;
  voicebot_exten: string | null;
  totale: number;
  scheduled_id: number | null;
  registrate: number;
  in_coda: number;
  avviate: number;
  senza_esito: number;
  risposte: number;
  interrotte: number;
  non_risposte: number;
  non_partite: number;
  errori: number;
  ultimo_aggiornamento: string | null;
  ultimo_avanzamento: string | null;
  modalita_coda?: boolean;
  in_pausa?: boolean;
  fermata_at?: string | null;
  retry_max?: number;
  da_richiamare?: number;
  prossima_richiamata?: string | null;
  annullate?: number;
  esclusi?: number;
}

interface OrariLive { attivo: boolean; descrizione: string; aperto: boolean; prossimaApertura: string | null }

// Stato della campagna mostrato sulla scheda.
export function statoCampagna(c: LiveCampaign, orari: OrariLive | null): { label: string; cls: string } {
  const attive = c.in_coda + c.avviate;
  if (c.fermata_at) return { label: 'Fermata', cls: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300' };
  if (attive === 0 && !(c.da_richiamare || 0)) return { label: 'Conclusa', cls: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300' };
  if (c.in_pausa) return { label: 'In pausa', cls: 'bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400' };
  if (c.modalita_coda && orari && !orari.aperto && c.avviate === 0) return { label: 'Fuori orario', cls: 'bg-indigo-50 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300' };
  if (attive === 0) return { label: 'Richiamate in attesa', cls: 'bg-violet-50 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300' };
  return { label: 'In corso', cls: 'bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-400' };
}

interface LiveEvent {
  id: number;
  campaign_id: number | null;
  numero: string;
  nome: string | null;
  stato: Stato;
  errore: string | null;
  durata_ms: number | null;
  queued_at: string;
  updated_at: string;
  operatore: string | null;
  voicebot_nome: string | null;
}

const POLL_MS = 4000;
// Oltre questi minuti senza avanzamenti la coda viene segnalata come ferma.
const CODA_FERMA_MIN = 10;
// Una chiamata avviata da più di tanti minuti senza esito viene segnalata.
const SENZA_ESITO_MIN = 15;


const minutiDa = (iso: string | null, now: number) => (iso ? (now - new Date(iso).getTime()) / 60000 : Infinity);
const ora = (iso: string) => new Date(iso).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const durata = (ms: number | null) => {
  if (!ms) return '';
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

// Pagina "In diretta": stato delle chiamate partite dalle campagne del sito,
// ognuna con il voicebot scelto per quella campagna. Si aggiorna ogni 4 secondi
// finché la pagina è visibile.
export function LiveSection() {
  const { user } = useCampaign();
  const [hours, setHours] = useState(12);
  const [campaigns, setCampaigns] = useState<LiveCampaign[]>([]);
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const [diagnostics, setDiagnostics] = useState<{ event_type: string; reason: string; totale: number }[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [now, setNow] = useState(Date.now());
  const [showDiag, setShowDiag] = useState(false);
  const [aperta, setAperta] = useState<number | null>(null);
  const [orari, setOrari] = useState<OrariLive | null>(null);
  const [daFermare, setDaFermare] = useState<LiveCampaign | null>(null);
  const [daEliminare, setDaEliminare] = useState<LiveCampaign | null>(null);
  const isAdmin = !!(user?.isAdmin || user?.role === 'Admin');
  const [azioneErr, setAzioneErr] = useState('');
  const [busy, setBusy] = useState<number | null>(null);
  const esegui = async (id: number, azione: 'pausa' | 'riprendi' | 'ferma' | 'elimina') => {
    setBusy(id);
    const r = await azioneCampagna(id, azione);
    setAzioneErr(r.ok ? '' : r.error || 'Operazione non riuscita');
    await load();
    setBusy(null);
  };
  const chiudiDettaglio = useCallback(() => setAperta(null), []);
  const timer = useRef<number | null>(null);

  const load = async (h = hours) => {
    try {
      const res = await authFetch(`/api/live?hours=${h}`);
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error();
      setCampaigns(data.campaigns || []);
      setEvents(data.events || []);
      setDiagnostics(data.diagnostics ?? null);
      setOrari(data.orari ?? null);
      setUpdatedAt(new Date());
      setError('');
    } catch {
      setError('Impossibile aggiornare i dati in diretta. Nuovo tentativo tra pochi secondi.');
    }
    setLoading(false);
    setNow(Date.now());
  };

  useEffect(() => {
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      if (document.visibilityState === 'visible') await load(hours);
      if (!stopped) timer.current = window.setTimeout(tick, POLL_MS);
    };
    setLoading(true);
    tick();
    return () => { stopped = true; if (timer.current) window.clearTimeout(timer.current); };
  }, [hours]);

  // Il cronometro delle chiamate in corso scorre anche tra un aggiornamento e l'altro
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  const tot = campaigns.reduce((a, c) => ({
    in_coda: a.in_coda + c.in_coda,
    avviate: a.avviate + c.avviate,
    risposte: a.risposte + c.risposte,
    non_risposte: a.non_risposte + c.non_risposte + c.interrotte + c.non_partite,
    errori: a.errori + c.errori,
  }), { in_coda: 0, avviate: 0, risposte: 0, non_risposte: 0, errori: 0 });

  // Avvisi: coda ferma o troppe chiamate in errore
  const avvisi: { id: string; text: string; tone: 'red' | 'amber' }[] = [];
  for (const c of campaigns) {
    const nome = `${c.operatore || 'Campagna'} · ${c.voicebot_nome || 'voicebot predefinito'}`;
    const gestite = c.registrate - c.in_coda - (c.da_richiamare || 0);
    const riuscite = c.avviate + c.risposte + c.interrotte + c.non_risposte;
    if (c.errori >= 3 && c.errori / Math.max(gestite, 1) >= 0.5) {
      avvisi.push({ id: `e${c.id}`, tone: 'red', text: `${nome}: ${c.errori} chiamate in errore su ${gestite}. Controlla lo scenario Make e il voicebot.` });
    } else if (riuscite === 0 && c.non_partite + c.errori >= 5) {
      // Nessuna chiamata partita: più probabile un problema di configurazione che 5 rifiuti di fila
      avvisi.push({ id: `n${c.id}`, tone: 'red', text: `${nome}: nessuna delle prime ${c.non_partite + c.errori} chiamate è partita. Controlla il voicebot e lo scenario Make.` });
    }
    const ultimo = c.ultimo_avanzamento || c.created_at;
    // In pausa, fermata o fuori orario la coda è ferma apposta.
    const fermaApposta = c.in_pausa || !!c.fermata_at || (c.modalita_coda && orari && !orari.aperto);
    if (c.in_coda > 0 && !fermaApposta && minutiDa(ultimo, now) > CODA_FERMA_MIN) {
      avvisi.push({ id: `c${c.id}`, tone: 'amber', text: `${nome}: ${c.in_coda} contatti in coda e nessun avanzamento da ${Math.floor(minutiDa(ultimo, now))} minuti. La coda di Make potrebbe essere ferma.` });
    }
  }

  const inCorso = events.filter(e => e.stato === 'avviata');
  const feed = events.filter(e => e.stato !== 'avviata').slice(0, 40);

  const kpi = [
    { label: 'In coda', value: tot.in_coda, icon: Clock, tone: 'text-slate-500' },
    { label: 'In corso', value: tot.avviate, icon: PhoneCall, tone: 'text-blue-600 dark:text-blue-400' },
    { label: 'Risposte', value: tot.risposte, icon: Phone, tone: 'text-green-600 dark:text-green-400' },
    { label: 'Non risposte', value: tot.non_risposte, icon: PhoneMissed, tone: 'text-slate-500 dark:text-slate-400' },
    { label: 'Errori', value: tot.errori, icon: XCircle, tone: 'text-red-600 dark:text-red-400' },
  ];

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-300">
      {aperta !== null && <CampaignDetail campaignId={aperta} onClose={chiudiDettaglio} onChange={() => load()} />}
      <ConfirmModal
        open={!!daFermare}
        title="Fermare la campagna?"
        message={daFermare ? `I ${daFermare.in_coda + (daFermare.da_richiamare || 0)} contatti non ancora chiamati non verranno chiamati. Le chiamate già partite finiscono normalmente. Non si può annullare.` : ''}
        confirmLabel="Ferma campagna"
        onCancel={() => setDaFermare(null)}
        onConfirm={() => { const c = daFermare; setDaFermare(null); if (c) esegui(c.id, 'ferma'); }}
      />
      <ConfirmModal
        open={!!daEliminare}
        title="Eliminare la campagna?"
        message={daEliminare ? `La campagna di ${daEliminare.operatore || '—'} delle ${ora(daEliminare.created_at).slice(0, 5)} sparisce da In diretta per tutti. Esiti Chiamate, follow-up e Storico Campagne restano; esce invece dal confronto tra voicebot nelle Statistiche. Non si può annullare.` : ''}
        confirmLabel="Elimina"
        onCancel={() => setDaEliminare(null)}
        onConfirm={() => { const c = daEliminare; setDaEliminare(null); if (c) esegui(c.id, 'elimina'); }}
      />
      {/* Barra superiore */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm text-slate-500">
          <span className="relative flex h-2.5 w-2.5">
            <span className={cn('absolute inline-flex h-full w-full rounded-full opacity-75', error ? 'bg-red-400' : 'bg-green-400 animate-ping')} />
            <span className={cn('relative inline-flex rounded-full h-2.5 w-2.5', error ? 'bg-red-500' : 'bg-green-500')} />
          </span>
          {updatedAt ? `Aggiornato alle ${updatedAt.toLocaleTimeString('it-IT')}` : 'Caricamento…'}
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden text-xs font-semibold">
            {[12, 24, 72].map(h => (
              <button key={h} onClick={() => setHours(h)}
                className={cn('px-3 py-1.5 transition-colors', hours === h ? 'bg-brand-600 text-white' : 'text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800')}>
                {h === 72 ? '3 giorni' : `${h} ore`}
              </button>
            ))}
          </div>
          <button onClick={() => load()} aria-label="Aggiorna" title="Aggiorna"
            className="p-1.5 text-slate-400 hover:text-brand-600 hover:bg-brand-50 rounded-lg transition-colors">
            <RefreshCw className={cn('w-4 h-4', loading && 'animate-spin')} />
          </button>
        </div>
      </div>

      {error && <p className="text-sm text-red-500">{error}</p>}
      {azioneErr && <p className="text-sm text-red-500">{azioneErr}</p>}

      {/* Fuori dagli orari consentiti le code aspettano l'apertura */}
      {orari?.attivo && !orari.aperto && campaigns.some(c => c.modalita_coda && !c.fermata_at && c.in_coda + (c.da_richiamare || 0) > 0) && (
        <div className="flex items-start gap-3 rounded-xl border px-4 py-3 text-sm bg-indigo-50 border-indigo-200 text-indigo-800 dark:bg-indigo-950/40 dark:border-indigo-900 dark:text-indigo-300">
          <Moon className="w-4 h-4 mt-0.5 shrink-0" />
          <span>Fuori dagli orari consentiti ({orari.descrizione}): le chiamate in coda ripartono {orari.prossimaApertura ? oraBreve(orari.prossimaApertura) : 'alla prossima apertura'}.</span>
        </div>
      )}

      {/* Contatori */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        {kpi.map(k => (
          <div key={k.label} className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-4 shadow-soft">
            <k.icon className={cn('w-4 h-4 mb-2', k.tone)} />
            <div className="text-2xl font-bold text-slate-900 dark:text-white tabular-nums">{k.value}</div>
            <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide mt-0.5">{k.label}</div>
          </div>
        ))}
      </div>

      {/* Avvisi */}
      {avvisi.length > 0 && (
        <div className="space-y-2">
          {avvisi.map(a => (
            <div key={a.id} className={cn('flex items-start gap-3 rounded-xl border px-4 py-3 text-sm',
              a.tone === 'red'
                ? 'bg-red-50 border-red-200 text-red-800 dark:bg-red-950/40 dark:border-red-900 dark:text-red-300'
                : 'bg-amber-50 border-amber-200 text-amber-800 dark:bg-amber-950/40 dark:border-amber-900 dark:text-amber-300')}>
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
              <span>{a.text}</span>
            </div>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-5 gap-6 items-start">
        {/* Campagne */}
        <div className="xl:col-span-3 space-y-4">
          <h2 className="text-sm font-bold text-slate-900 dark:text-white uppercase tracking-wide">Campagne</h2>
          {!loading && campaigns.length === 0 && (
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-8 text-center text-sm text-slate-500">
              Nessuna campagna lanciata dal sito {hours === 72 ? 'negli ultimi 3 giorni' : `nelle ultime ${hours} ore`}.
            </div>
          )}
          {campaigns.map(c => {
            const gestite = c.registrate - c.in_coda - (c.da_richiamare || 0) - (c.esclusi || 0) - (c.annullate || 0);
            const parts: [Stato, number][] = [
              ['risposta', c.risposte], ['interrotta', c.interrotte], ['non_risposta', c.non_risposte],
              ['non_partita', c.non_partite], ['errore', c.errori], ['senza_esito', c.senza_esito || 0], ['avviata', c.avviate],
              ['programmata', c.da_richiamare || 0], ['in_coda', c.in_coda], ['escluso', c.esclusi || 0], ['annullata', c.annullate || 0],
            ];
            const st = statoCampagna(c, orari);
            const finita = st.label === 'Conclusa' || st.label === 'Fermata';
            const azioni = c.modalita_coda && !finita;
            return (
              <div key={c.id} role="button" tabIndex={0} onClick={() => setAperta(c.id)}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setAperta(c.id); } }}
                title="Apri l'elenco dei numeri con esiti e riassunti"
                className="group block w-full text-left bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 shadow-soft hover:border-brand-300 dark:hover:border-brand-700 hover:shadow-md transition focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">
                <div className="flex flex-wrap items-start justify-between gap-2 mb-3">
                  <div className="min-w-0">
                    <div className="font-semibold text-slate-900 dark:text-white truncate">
                      {c.voicebot_nome || 'Voicebot predefinito'}
                      {c.voicebot_exten && <span className="ml-1.5 text-xs font-mono text-slate-400">({c.voicebot_exten})</span>}
                    </div>
                    <div className="text-xs text-slate-500 mt-0.5">
                      {c.operatore || '—'} · {c.tipo_campagna === 'appuntamenti' ? 'Conferma appuntamenti' : 'Standard'}
                      {c.scheduled_id ? ' · pianificata' : ''} · partita alle {ora(c.created_at).slice(0, 5)}
                    </div>
                  </div>
                  <span className={cn('text-[11px] font-bold px-2 py-0.5 rounded-full', st.cls)}>{st.label}</span>
                </div>
                <div className="flex items-baseline justify-between text-sm mb-1.5">
                  <span className="text-slate-500">Gestite</span>
                  <span className="font-bold text-slate-900 dark:text-white tabular-nums">{gestite} / {c.totale}</span>
                </div>
                <div className="flex h-2.5 w-full rounded-full overflow-hidden bg-slate-100 dark:bg-slate-800" role="img"
                  aria-label={parts.map(([s, n]) => `${STATI[s].label} ${n}`).join(', ')}>
                  {parts.map(([s, n]) => n > 0 && (
                    <div key={s} className={STATI[s].bar} style={{ width: `${(n / Math.max(c.totale, c.registrate, 1)) * 100}%` }} />
                  ))}
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1 mt-3 text-xs">
                  {parts.filter(([, n]) => n > 0).map(([s, n]) => (
                    <span key={s} className="inline-flex items-center gap-1.5 text-slate-600 dark:text-slate-300">
                      <span className={cn('w-2 h-2 rounded-full', STATI[s].bar)} />
                      {STATI[s].label} <span className="font-semibold tabular-nums">{n}</span>
                    </span>
                  ))}
                </div>
                {(c.da_richiamare || 0) > 0 && c.prossima_richiamata && !c.fermata_at && (
                  <p className="mt-2 text-xs text-violet-700 dark:text-violet-300">
                    Prossima richiamata: {oraBreve(c.prossima_richiamata)}{(c.retry_max || 0) > 0 ? ` · fino a ${c.retry_max} ${c.retry_max === 1 ? 'volta' : 'volte'}` : ''}
                  </p>
                )}
                <div className="mt-3 pt-3 border-t border-slate-100 dark:border-slate-800 flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-brand-600 dark:text-brand-400 inline-flex items-center gap-1">
                    Vedi numeri e riassunti <ChevronRight className="w-3.5 h-3.5 transition-transform group-hover:translate-x-0.5" />
                  </span>
                  {isAdmin && finita && (
                    <span onClick={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}>
                      <button type="button" disabled={busy === c.id} onClick={() => setDaEliminare(c)}
                        title="Elimina la campagna" aria-label="Elimina la campagna"
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold text-slate-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40 disabled:opacity-50">
                        <Trash2 className="w-3.5 h-3.5" /> Elimina
                      </button>
                    </span>
                  )}
                  {azioni && (
                    <span className="flex items-center gap-1.5" onClick={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}>
                      {c.in_pausa ? (
                        <button type="button" disabled={busy === c.id} onClick={() => esegui(c.id, 'riprendi')}
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold bg-green-600 text-white hover:bg-green-700 disabled:opacity-50">
                          <Play className="w-3.5 h-3.5" /> Riprendi
                        </button>
                      ) : (
                        <button type="button" disabled={busy === c.id} onClick={() => esegui(c.id, 'pausa')}
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50">
                          <Pause className="w-3.5 h-3.5" /> Pausa
                        </button>
                      )}
                      <button type="button" disabled={busy === c.id} onClick={() => setDaFermare(c)}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold border border-red-200 dark:border-red-900 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 disabled:opacity-50">
                        <Square className="w-3.5 h-3.5" /> Ferma
                      </button>
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Chiamate in corso + ultimi eventi */}
        <div className="xl:col-span-2 space-y-6">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-soft overflow-hidden">
            <div className="px-5 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center gap-2">
              <PhoneCall className="w-4 h-4 text-blue-600 dark:text-blue-400" />
              <h2 className="text-sm font-bold text-slate-900 dark:text-white">In corso</h2>
              <span className="text-sm font-semibold text-slate-400">{inCorso.length}</span>
            </div>
            {inCorso.length === 0 ? (
              <p className="px-5 py-6 text-sm text-slate-500 text-center">Nessuna chiamata in corso.</p>
            ) : (
              <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                {inCorso.map(e => {
                  const min = minutiDa(e.updated_at, now);
                  const sec = Math.max(0, Math.floor(min * 60));
                  return (
                    <li key={e.id} className="px-5 py-3 flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-sm font-semibold text-slate-900 dark:text-white truncate">{e.nome || e.numero}</div>
                        <div className="text-xs text-slate-500 truncate">{e.numero} · {e.voicebot_nome || 'voicebot'}</div>
                      </div>
                      <span className={cn('text-xs font-mono tabular-nums shrink-0', min > SENZA_ESITO_MIN ? 'text-amber-600 dark:text-amber-400' : 'text-blue-600 dark:text-blue-400')}
                        title={min > SENZA_ESITO_MIN ? 'Nessun esito ricevuto da Wildix' : 'Da quando è stata avviata'}>
                        {min > SENZA_ESITO_MIN ? 'senza esito' : `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-soft overflow-hidden">
            <div className="px-5 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center gap-2">
              <Radio className="w-4 h-4 text-brand-600" />
              <h2 className="text-sm font-bold text-slate-900 dark:text-white">Ultimi eventi</h2>
            </div>
            {feed.length === 0 ? (
              <p className="px-5 py-6 text-sm text-slate-500 text-center">Nessun evento.</p>
            ) : (
              <ul className="divide-y divide-slate-100 dark:divide-slate-800 max-h-[520px] overflow-y-auto">
                {feed.map(e => {
                  const st = STATI[e.stato] || STATI.in_coda;
                  return (
                    <li key={e.id} className="px-5 py-2.5 flex items-start gap-3">
                      <st.icon className={cn('w-4 h-4 mt-0.5 shrink-0', st.color)} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="text-sm font-medium text-slate-900 dark:text-white truncate">{e.nome || e.numero}</span>
                          <span className="text-[11px] text-slate-400 tabular-nums shrink-0">{ora(e.updated_at)}</span>
                        </div>
                        <div className="text-xs text-slate-500">
                          <span className={cn('font-semibold', st.color)}>{st.label}</span>
                          {e.durata_ms ? ` · ${durata(e.durata_ms)}` : ''}
                          {e.voicebot_nome ? ` · ${e.voicebot_nome}` : ''}
                        </div>
                        {e.errore && <div className={cn('text-xs mt-0.5', e.stato === 'errore' ? 'text-red-600 dark:text-red-400' : 'text-slate-500')}>{e.errore}</div>}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      </div>

      <p className="text-xs text-slate-500">
        Mostra solo le chiamate partite dalle campagne lanciate da questo sito, ciascuna con il voicebot scelto per la campagna.
        "In corso" significa che Wildix ha accettato la chiamata: l'esito arriva quando la chiamata finisce.
        "Non partita": Wildix non ha completato la chiamata (rifiutata, occupato, nessuna risposta o numero non raggiungibile).
        "Errore": la richiesta non è arrivata a Wildix.
        "Senza esito": Wildix ha accettato la chiamata ma dopo 30 minuti non ha ancora comunicato come è finita.
        "Da richiamare": non raggiunto, verrà richiamato in automatico. "Non chiamare": numero nella lista Non chiamare.
        "Annullata": la campagna è stata fermata prima di chiamarlo.
      </p>

      {/* Diagnostica (solo admin): eventi Wildix non usati */}
      {user?.isAdmin && diagnostics && (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl overflow-hidden">
          <button onClick={() => setShowDiag(v => !v)} className="w-full px-5 py-3 flex items-center justify-between text-sm font-semibold text-slate-700 dark:text-slate-300">
            Diagnostica: eventi Wildix ricevuti e non usati
            <ChevronDown className={cn('w-4 h-4 transition-transform', showDiag && 'rotate-180')} />
          </button>
          {showDiag && (
            <div className="px-5 pb-4">
              {diagnostics.length === 0 ? (
                <p className="text-sm text-slate-500">Nessun evento scartato registrato.</p>
              ) : (
                <table className="w-full text-sm">
                  <thead><tr className="text-left text-xs text-slate-500 uppercase"><th className="py-1">Evento</th><th>Motivo</th><th className="text-right">Totale</th></tr></thead>
                  <tbody>
                    {diagnostics.map(d => (
                      <tr key={d.event_type + d.reason} className="border-t border-slate-100 dark:border-slate-800">
                        <td className="py-1.5 font-mono text-xs text-slate-700 dark:text-slate-300">{d.event_type}</td>
                        <td className="text-xs text-slate-500">{d.reason}</td>
                        <td className="text-right tabular-nums text-slate-900 dark:text-white">{d.totale}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <p className="text-xs text-slate-500 mt-3">
                Se compare <span className="font-mono">call:live:progress</span>, Wildix invia già gli aggiornamenti delle chiamate in corso
                e si possono aggiungere gli stati "squilla" e "in conversazione".
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
