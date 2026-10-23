import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Search, Download, RefreshCw, ChevronDown, Clock, Ban, Pause, Play, Square, Rocket, Save, RotateCcw, Trash2 } from 'lucide-react';
import * as XLSX from 'xlsx';
import { authFetch } from '../lib/authFetch';
import { cn } from '../lib/utils';
import { STATI, Stato, ESITI_COMMERCIALI, EsitoCommerciale, azioneCampagna, oraBreve } from './liveStati';
import { useCampaign } from '../context/CampaignContext';
import { ConfirmModal } from './ConfirmModal';

interface Riassunto {
  titolo?: string | null;
  testo?: string | null;
  argomenti?: string[];
  decisioni?: string[];
  problemi?: string[];
}

interface Chiamata {
  id: number;
  nome: string | null;
  numero: string;
  stato: Stato;
  errore: string | null;
  durata_ms: number | null;
  updated_at: string;
  tentativo: number;
  programmata_at: string | null;
  esito_precedente: string | null;
  riassunto: Riassunto | null;
  trascrizione: string | null;
  esito_commerciale: EsitoCommerciale | null;
  esito_manuale: EsitoCommerciale | null;
  esito_manuale_da: string | null;
  non_chiamare: boolean;
  // Dati raccolti da Wilma con salva_lead
  lead: {
    esito: string; nome: string | null; azienda: string | null; ruolo: string | null; fascia: string | null;
    esigenza: string | null; email: string | null; note: string | null; riepilogo: string | null;
  } | null;
}

interface Campagna {
  id: number;
  created_at: string;
  operatore: string | null;
  tipo_campagna: string;
  voicebot_nome: string | null;
  voicebot_exten: string | null;
  totale: number;
  scheduled_id: number | null;
  modalita_coda: boolean;
  in_pausa: boolean;
  fermata_at: string | null;
  fermata_da: string | null;
  retry_max: number;
}

// Ordine dei filtri: prima chi ha parlato con il voicebot.
const ORDINE: Stato[] = ['risposta', 'interrotta', 'non_risposta', 'non_partita', 'errore', 'senza_esito', 'avviata', 'programmata', 'in_coda', 'escluso', 'annullata'];
const ORDINE_COMM: EsitoCommerciale[] = ['appuntamento', 'interessato', 'richiamare', 'non_interessato', 'non_chiamare',
  'segreteria', 'numero_errato', 'nessun_dialogo', 'da_valutare'];

const durata = (ms: number | null) => {
  if (!ms) return '';
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const dataOra = (iso: string) => new Date(iso).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const lista = (v: unknown) => (Array.isArray(v) ? v.filter(x => typeof x === 'string' && x.trim()) as string[] : []);

function RigaChiamata({ c, onNonChiamare, onEsito, busy }: {
  c: Chiamata; onNonChiamare: (c: Chiamata) => void; onEsito: (c: Chiamata, esito: EsitoCommerciale | null) => void; busy: boolean;
}) {
  const [open, setOpen] = useState(false);
  const st = STATI[c.stato] || STATI.in_coda;
  const Icon = st.icon;
  const testo = c.riassunto?.testo || c.riassunto?.titolo || c.lead?.riepilogo || '';
  const datiLead = c.lead ? [
    c.lead.nome && c.lead.nome !== c.nome ? c.lead.nome : null,
    [c.lead.azienda, c.lead.ruolo].filter(Boolean).join(', ') || null,
    c.lead.fascia ? `Quando: ${c.lead.fascia}` : null,
    c.lead.esigenza ? `Interesse: ${c.lead.esigenza}` : null,
    c.lead.email,
  ].filter(Boolean) as string[] : [];
  const decisioni = lista(c.riassunto?.decisioni);
  const argomenti = lista(c.riassunto?.argomenti);
  const problemi = lista(c.riassunto?.problemi);
  const dettagli = !!(c.trascrizione || decisioni.length || argomenti.length || problemi.length);
  const ec = c.esito_commerciale ? ESITI_COMMERCIALI[c.esito_commerciale] : null;
  // L'esito si può correggere sulle chiamate in cui qualcuno ha risposto.
  const correggibile = !!c.esito_commerciale || c.stato === 'risposta' || c.stato === 'interrotta';
  const precedente = c.esito_precedente ? STATI[c.esito_precedente as Stato]?.label : null;

  return (
    <li className="px-5 py-3.5">
      <div className="flex items-start gap-3">
        <Icon className={cn('w-4 h-4 mt-0.5 shrink-0', st.color)} />
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="font-semibold text-sm text-slate-900 dark:text-white truncate">{c.nome || c.numero}</span>
            {c.nome && <span className="text-xs font-mono text-slate-400">{c.numero}</span>}
            {correggibile && (
              busy ? (ec && <span className={cn('text-[11px] font-bold px-2 py-0.5 rounded-full', ec.cls)}>{ec.label}</span>) : (
                <select value={c.esito_commerciale || ''} title={c.esito_manuale ? `Corretto a mano${c.esito_manuale_da ? ` da ${c.esito_manuale_da}` : ''}` : 'Cambia esito commerciale'}
                  aria-label={`Esito commerciale di ${c.nome || c.numero}`}
                  onChange={e => onEsito(c, e.target.value === '__auto' ? null : (e.target.value as EsitoCommerciale))}
                  className={cn('text-[11px] font-bold pl-2 pr-1 py-0.5 rounded-full border-0 cursor-pointer focus:outline-none focus:ring-2 focus:ring-brand-500',
                    ec ? ec.cls : 'bg-slate-50 text-slate-400 dark:bg-slate-800/60')}>
                  {!c.esito_commerciale && <option value="">Esito?</option>}
                  {ORDINE_COMM.map(s => <option key={s} value={s}>{ESITI_COMMERCIALI[s].label}</option>)}
                  {c.esito_manuale && <option value="__auto">↺ Torna automatico</option>}
                </select>
              )
            )}
            {c.esito_manuale && <span className="text-[10px] text-slate-400" title={c.esito_manuale_da ? `Corretto da ${c.esito_manuale_da}` : undefined}>corretto a mano</span>}
            {c.non_chiamare && c.stato !== 'escluso' && (
              <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300">Non chiamare</span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-0.5 text-xs">
            <span className={cn('font-semibold', st.color)}>{st.label}</span>
            {c.durata_ms ? <span className="inline-flex items-center gap-1 text-slate-500"><Clock className="w-3 h-3" />{durata(c.durata_ms)}</span> : null}
            {c.tentativo > 1 && <span className="text-slate-500">{c.stato === 'programmata' ? `${c.tentativo}° tentativo` : `${c.tentativo} tentativi`}</span>}
            {c.stato === 'programmata' && c.programmata_at
              ? <span className="text-violet-600 dark:text-violet-400">richiamata {oraBreve(c.programmata_at)}</span>
              : <span className="text-slate-400">{dataOra(c.updated_at)}</span>}
          </div>
          {c.stato === 'programmata' && precedente && <p className="text-xs text-slate-500 mt-1">Tentativo prima: {precedente}{c.errore ? ` · ${c.errore}` : ''}</p>}
          {c.stato !== 'programmata' && c.errore && <p className="text-xs text-slate-500 mt-1">{c.errore}</p>}
          {testo && <p className="text-sm text-slate-600 dark:text-slate-300 mt-1.5 leading-relaxed">{testo}</p>}
          {datiLead.length > 0 && (
            <p className="text-xs text-slate-600 dark:text-slate-300 mt-1.5 px-2.5 py-1.5 rounded-lg bg-slate-50 dark:bg-slate-800/60 border border-slate-100 dark:border-slate-700">
              <span className="font-semibold text-slate-500">Raccolto da Wilma: </span>{datiLead.join(' · ')}
            </p>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {!c.non_chiamare && (
            <button onClick={() => onNonChiamare(c)} disabled={busy} title="Aggiungi alla lista Non chiamare" aria-label={`Non chiamare più ${c.nome || c.numero}`}
              className="p-1.5 rounded-lg text-slate-300 hover:text-rose-600 hover:bg-rose-50 dark:text-slate-600 dark:hover:text-rose-400 dark:hover:bg-rose-950/40 disabled:opacity-40">
              <Ban className="w-4 h-4" />
            </button>
          )}
          {dettagli && (
            <button onClick={() => setOpen(o => !o)} aria-expanded={open} aria-label={open ? 'Nascondi dettagli' : 'Mostra dettagli'}
              className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-white">
              <ChevronDown className={cn('w-4 h-4 transition-transform', open && 'rotate-180')} />
            </button>
          )}
        </div>
      </div>
      {open && (
        <div className="ml-7 mt-3 space-y-3 text-sm">
          {decisioni.length > 0 && (
            <div>
              <div className="text-xs font-semibold text-slate-500 mb-1">Decisioni</div>
              <ul className="list-disc pl-5 text-slate-600 dark:text-slate-300 space-y-0.5">{decisioni.map((d, i) => <li key={i}>{d}</li>)}</ul>
            </div>
          )}
          {problemi.length > 0 && (
            <div>
              <div className="text-xs font-semibold text-slate-500 mb-1">Problemi</div>
              <ul className="list-disc pl-5 text-slate-600 dark:text-slate-300 space-y-0.5">{problemi.map((d, i) => <li key={i}>{d}</li>)}</ul>
            </div>
          )}
          {argomenti.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {argomenti.map((a, i) => (
                <span key={i} className="text-[11px] px-2 py-0.5 rounded-full bg-brand-50 dark:bg-brand-900/20 text-brand-700 dark:text-brand-300">{a}</span>
              ))}
            </div>
          )}
          {c.trascrizione && (
            <details className="text-xs">
              <summary className="cursor-pointer font-semibold text-slate-500">Trascrizione completa</summary>
              <pre className="whitespace-pre-wrap mt-2 text-slate-600 dark:text-slate-300 font-sans">{c.trascrizione}</pre>
            </details>
          )}
        </div>
      )}
    </li>
  );
}

// Pannello laterale con tutti i numeri di una campagna, esito e riassunto di Wilma.
export function CampaignDetail({ campaignId, onClose, onChange }: { campaignId: number; onClose: () => void; onChange?: () => void }) {
  const { user, avviaConContatti, saveList } = useCampaign();
  const [campagna, setCampagna] = useState<Campagna | null>(null);
  const [chiamate, setChiamate] = useState<Chiamata[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [filtro, setFiltro] = useState<Stato | 'tutte'>('tutte');
  const [filtroComm, setFiltroComm] = useState<EsitoCommerciale | 'tutti'>('tutti');
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [chiediStop, setChiediStop] = useState(false);
  const [chiediElimina, setChiediElimina] = useState(false);
  const [nomeLista, setNomeLista] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const res = await authFetch(`/api/live/campaigns/${campaignId}`);
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error);
      setCampagna(data.campaign);
      setChiamate(data.calls || []);
      setError('');
    } catch (e: any) {
      setError(e?.message || 'Impossibile caricare la campagna.');
    }
    setLoading(false);
  };

  useEffect(() => { load(); }, [campaignId]);

  // Esc chiude il pannello; la pagina sotto non scorre.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !chiediStop && !chiediElimina) onClose(); };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [onClose, chiediStop, chiediElimina]);

  const conteggi = useMemo(() => {
    const m = new Map<Stato, number>();
    for (const c of chiamate) m.set(c.stato, (m.get(c.stato) || 0) + 1);
    return ORDINE.filter(s => m.get(s)).map(s => [s, m.get(s)!] as [Stato, number]);
  }, [chiamate]);

  const conteggiComm = useMemo(() => {
    const m = new Map<EsitoCommerciale, number>();
    for (const c of chiamate) if (c.esito_commerciale) m.set(c.esito_commerciale, (m.get(c.esito_commerciale) || 0) + 1);
    return ORDINE_COMM.filter(s => m.get(s)).map(s => [s, m.get(s)!] as [EsitoCommerciale, number]);
  }, [chiamate]);

  const filtrate = useMemo(() => {
    const q = search.trim().toLowerCase();
    return chiamate
      .filter(c => filtro === 'tutte' || c.stato === filtro)
      .filter(c => filtroComm === 'tutti' || c.esito_commerciale === filtroComm)
      .filter(c => !q || [c.nome, c.numero, c.riassunto?.testo, c.riassunto?.titolo, c.errore, c.lead?.azienda, c.lead?.nome, c.lead?.riepilogo]
        .some(v => v && v.toLowerCase().includes(q)))
      .sort((a, b) => ORDINE.indexOf(a.stato) - ORDINE.indexOf(b.stato) || a.id - b.id);
  }, [chiamate, filtro, filtroComm, search]);

  // Numeri richiamabili tra quelli mostrati: non quelli in "Non chiamare".
  const richiamabili = filtrate.filter(c => !c.non_chiamare && c.stato !== 'escluso');

  const esporta = () => {
    const rows = filtrate.map(c => ({
      Nome: c.nome || '',
      Numero: c.numero,
      Esito: STATI[c.stato]?.label || c.stato,
      'Esito commerciale': c.esito_commerciale ? ESITI_COMMERCIALI[c.esito_commerciale].label : '',
      Tentativi: c.tentativo || 1,
      Durata: durata(c.durata_ms),
      Ora: dataOra(c.updated_at),
      Riassunto: c.riassunto?.testo || c.riassunto?.titolo || '',
      Decisioni: lista(c.riassunto?.decisioni).join('; '),
      Note: c.errore || '',
      'Non chiamare': c.non_chiamare ? 'Sì' : '',
      'Esito Wilma': c.lead?.esito || '',
      Azienda: c.lead?.azienda || '',
      Ruolo: c.lead?.ruolo || '',
      'Quando richiamare': c.lead?.fascia || '',
      Interesse: c.lead?.esigenza || '',
      Email: c.lead?.email || '',
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Chiamate');
    const giorno = campagna ? new Date(campagna.created_at).toISOString().slice(0, 10) : 'campagna';
    XLSX.writeFile(wb, `campagna-${giorno}-${campaignId}.xlsx`);
  };

  const azione = async (a: 'pausa' | 'riprendi' | 'ferma' | 'elimina') => {
    setBusy(true);
    const r = await azioneCampagna(campaignId, a);
    if (a === 'elimina' && r.ok) { onChange?.(); onClose(); return; }
    setMsg(r.ok ? (a === 'pausa' ? 'Campagna in pausa: non partono nuove chiamate.' : a === 'riprendi' ? 'Campagna ripresa.' : 'Campagna fermata.') : r.error || 'Operazione non riuscita');
    await load();
    onChange?.();
    setBusy(false);
  };

  const nonChiamare = async (c: Chiamata) => {
    setBusy(true);
    try {
      const res = await authFetch('/api/non-chiamare', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ numeri: [{ numero: c.numero, nome: c.nome }], motivo: 'Aggiunto dal dettaglio campagna' }),
      });
      const data = await res.json().catch(() => ({}));
      setMsg(res.ok && data.ok ? `${c.nome || c.numero} non verrà più chiamato.` : data.error || 'Non aggiunto');
      await load();
    } catch {
      setMsg('Errore di rete');
    }
    setBusy(false);
  };

  const cambiaEsito = async (c: Chiamata, esito: EsitoCommerciale | null) => {
    setBusy(true);
    try {
      const res = await authFetch(`/api/live/calls/${c.id}/esito`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ esito }),
      });
      const data = await res.json().catch(() => ({}));
      setMsg(res.ok && data.ok
        ? (esito ? `${c.nome || c.numero}: esito impostato a "${ESITI_COMMERCIALI[esito].label}".` : `${c.nome || c.numero}: torna l'esito automatico.`)
        : data.error || 'Esito non salvato');
      await load();
    } catch {
      setMsg('Errore di rete');
    }
    setBusy(false);
  };

  const nuovaCampagna = () => {
    avviaConContatti(richiamabili.map(c => ({ nome: c.nome, numero: c.numero })));
    onClose();
  };

  const salvaLista = async () => {
    if (!nomeLista?.trim()) return;
    const r = await saveList(nomeLista.trim(), richiamabili.map((c, i) => ({ id: String(i), nome: c.nome || c.numero, numero: c.numero })));
    setMsg(r.ok ? `Lista "${nomeLista.trim()}" salvata con ${richiamabili.length} numeri.` : r.error || 'Lista non salvata');
    if (r.ok) setNomeLista(null);
  };

  const conRiassunto = chiamate.filter(c => c.riassunto?.testo || c.riassunto?.titolo).length;
  const daChiamare = chiamate.filter(c => c.stato === 'in_coda' || c.stato === 'programmata').length;
  const attiva = !!campagna?.modalita_coda && !campagna.fermata_at && daChiamare + chiamate.filter(c => c.stato === 'avviata').length > 0;
  const isViewer = user?.role === 'Viewer';
  const isAdmin = !!(user?.isAdmin || user?.role === 'Admin');

  // Nel body: i contenitori animati della pagina limiterebbero il "fixed".
  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end animate-in fade-in duration-150" role="dialog" aria-modal="true" aria-label="Dettaglio campagna">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-2xl h-full bg-white dark:bg-slate-900 border-l border-slate-200 dark:border-slate-800 shadow-xl flex flex-col animate-in slide-in-from-right duration-200">
        {/* Intestazione */}
        <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex items-start gap-3">
          <div className="flex-1 min-w-0">
            <div className="font-bold text-slate-900 dark:text-white truncate">
              {campagna?.voicebot_nome || 'Campagna'}
              {campagna?.voicebot_exten && <span className="ml-1.5 text-xs font-mono font-normal text-slate-400">({campagna.voicebot_exten})</span>}
            </div>
            {campagna && (
              <div className="text-xs text-slate-500 mt-0.5">
                {campagna.operatore || '—'} · {campagna.tipo_campagna === 'appuntamenti' ? 'Conferma appuntamenti' : 'Standard'}
                {' · '}partita il {dataOra(campagna.created_at)} · {chiamate.length} numeri · {conRiassunto} riassunti
                {campagna.retry_max > 0 && ` · richiamate fino a ${campagna.retry_max} ${campagna.retry_max === 1 ? 'volta' : 'volte'}`}
                {campagna.fermata_at && ` · fermata${campagna.fermata_da ? ` da ${campagna.fermata_da}` : ''}`}
                {campagna.in_pausa && !campagna.fermata_at && ' · in pausa'}
              </div>
            )}
          </div>
          {isAdmin && campagna && !attiva && !chiamate.some(c => c.stato === 'avviata') && (
            <button onClick={() => setChiediElimina(true)} disabled={busy} aria-label="Elimina la campagna" title="Elimina la campagna"
              className="p-2 rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40">
              <Trash2 className="w-4 h-4" />
            </button>
          )}
          <button onClick={load} disabled={loading} aria-label="Aggiorna"
            className="p-2 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 dark:hover:text-white">
            <RefreshCw className={cn('w-4 h-4', loading && 'animate-spin')} />
          </button>
          <button onClick={onClose} aria-label="Chiudi"
            className="p-2 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 dark:hover:text-white">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Pausa / ripresa / stop */}
        {attiva && !isViewer && (
          <div className="px-5 py-2.5 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center gap-2 bg-slate-50 dark:bg-slate-800/40">
            <span className="text-xs text-slate-500 mr-auto">{daChiamare} {daChiamare === 1 ? 'contatto ancora da chiamare' : 'contatti ancora da chiamare'}</span>
            {campagna?.in_pausa ? (
              <button onClick={() => azione('riprendi')} disabled={busy}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-green-600 text-white hover:bg-green-700 disabled:opacity-50">
                <Play className="w-3.5 h-3.5" /> Riprendi
              </button>
            ) : (
              <button onClick={() => azione('pausa')} disabled={busy}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50">
                <Pause className="w-3.5 h-3.5" /> Pausa
              </button>
            )}
            <button onClick={() => setChiediStop(true)} disabled={busy}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border border-red-200 dark:border-red-900 bg-white dark:bg-slate-900 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 disabled:opacity-50">
              <Square className="w-3.5 h-3.5" /> Ferma
            </button>
          </div>
        )}

        {/* Filtri */}
        <div className="px-5 py-3 border-b border-slate-200 dark:border-slate-800 space-y-2.5">
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filtra per esito">
            {([['tutte', chiamate.length] as [Stato | 'tutte', number], ...conteggi]).map(([s, n]) => (
              <button key={s} onClick={() => setFiltro(s)} aria-pressed={filtro === s}
                className={cn('text-xs font-semibold px-2.5 py-1 rounded-full border transition-colors inline-flex items-center gap-1.5',
                  filtro === s
                    ? 'bg-slate-900 text-white border-slate-900 dark:bg-white dark:text-slate-900 dark:border-white'
                    : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700 hover:border-slate-400')}>
                {s !== 'tutte' && <span className={cn('w-2 h-2 rounded-full', STATI[s].bar)} />}
                {s === 'tutte' ? 'Tutte' : STATI[s].label}
                <span className="tabular-nums opacity-70">{n}</span>
              </button>
            ))}
          </div>
          {conteggiComm.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filtra per esito commerciale">
              <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide mr-1">Commerciale</span>
              {conteggiComm.map(([s, n]) => (
                <button key={s} onClick={() => setFiltroComm(filtroComm === s ? 'tutti' : s)} aria-pressed={filtroComm === s}
                  className={cn('text-xs font-semibold px-2.5 py-1 rounded-full transition', ESITI_COMMERCIALI[s].cls,
                    filtroComm === s ? 'ring-2 ring-offset-1 ring-slate-900 dark:ring-white dark:ring-offset-slate-900' : 'opacity-80 hover:opacity-100')}>
                  {ESITI_COMMERCIALI[s].label} <span className="tabular-nums opacity-70">{n}</span>
                </button>
              ))}
            </div>
          )}
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Cerca nome, numero o riassunto..."
                className="w-full pl-9 pr-3 py-2 text-sm rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-brand-500" />
            </div>
            <button onClick={esporta} disabled={filtrate.length === 0}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-semibold rounded-xl border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50">
              <Download className="w-4 h-4" /><span className="hidden sm:inline">Excel</span>
            </button>
          </div>
          {msg && <p className="text-xs font-medium text-brand-700 dark:text-brand-300">{msg}</p>}
        </div>

        {/* Elenco */}
        <div className="flex-1 overflow-y-auto">
          {error ? (
            <div className="p-8 text-center text-sm text-red-600 dark:text-red-400">{error}</div>
          ) : loading && chiamate.length === 0 ? (
            <div className="p-8 text-center text-sm text-slate-500">Caricamento…</div>
          ) : filtrate.length === 0 ? (
            <div className="p-8 text-center text-sm text-slate-500">Nessuna chiamata con questi filtri.</div>
          ) : (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {filtrate.map(c => <RigaChiamata key={c.id} c={c} onNonChiamare={nonChiamare} onEsito={cambiaEsito} busy={busy || isViewer} />)}
            </ul>
          )}
        </div>

        {/* Riusare i numeri mostrati */}
        {!isViewer && richiamabili.length > 0 && (
          <div className="px-5 py-3 border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/40">
            {nomeLista === null ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-slate-500 mr-auto">{richiamabili.length} {richiamabili.length === 1 ? 'numero mostrato' : 'numeri mostrati'}</span>
                <button onClick={() => setNomeLista('')}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800">
                  <Save className="w-3.5 h-3.5" /> Salva come lista
                </button>
                <button onClick={nuovaCampagna}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-brand-600 text-white hover:bg-brand-700">
                  {filtro === 'non_partita' || filtro === 'non_risposta' ? <RotateCcw className="w-3.5 h-3.5" /> : <Rocket className="w-3.5 h-3.5" />}
                  Nuova campagna con questi numeri
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <input autoFocus value={nomeLista} onChange={e => setNomeLista(e.target.value)} placeholder="Nome della lista"
                  onKeyDown={e => { if (e.key === 'Enter') salvaLista(); }}
                  className="flex-1 px-3 py-1.5 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-brand-500" />
                <button onClick={() => setNomeLista(null)} className="px-3 py-1.5 text-xs font-semibold text-slate-500 hover:text-slate-800 dark:hover:text-white">Annulla</button>
                <button onClick={salvaLista} disabled={!nomeLista.trim()}
                  className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50">Salva</button>
              </div>
            )}
          </div>
        )}
      </div>
      <ConfirmModal
        open={chiediStop}
        title="Fermare la campagna?"
        message={`I ${daChiamare} contatti non ancora chiamati non verranno chiamati. Le chiamate già partite finiscono normalmente. Non si può annullare.`}
        confirmLabel="Ferma campagna"
        onCancel={() => setChiediStop(false)}
        onConfirm={() => { setChiediStop(false); azione('ferma'); }}
      />
      <ConfirmModal
        open={chiediElimina}
        title="Eliminare la campagna?"
        message="La campagna e l'elenco delle sue chiamate spariscono da In diretta per tutti. Esiti Chiamate, follow-up e Storico Campagne restano; esce invece dal confronto tra voicebot nelle Statistiche. Non si può annullare."
        confirmLabel="Elimina"
        onCancel={() => setChiediElimina(false)}
        onConfirm={() => { setChiediElimina(false); azione('elimina'); }}
      />
    </div>,
    document.body,
  );
}
