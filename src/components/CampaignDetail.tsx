import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Search, Download, RefreshCw, ChevronDown, Clock } from 'lucide-react';
import * as XLSX from 'xlsx';
import { authFetch } from '../lib/authFetch';
import { cn } from '../lib/utils';
import { STATI, Stato } from './liveStati';

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
  riassunto: Riassunto | null;
  trascrizione: string | null;
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
}

// Ordine dei filtri: prima chi ha parlato con il voicebot.
const ORDINE: Stato[] = ['risposta', 'interrotta', 'non_risposta', 'non_partita', 'errore', 'senza_esito', 'avviata', 'in_coda'];

const durata = (ms: number | null) => {
  if (!ms) return '';
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const dataOra = (iso: string) => new Date(iso).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const lista = (v: unknown) => (Array.isArray(v) ? v.filter(x => typeof x === 'string' && x.trim()) as string[] : []);

function RigaChiamata({ c }: { c: Chiamata }) {
  const [open, setOpen] = useState(false);
  const st = STATI[c.stato] || STATI.in_coda;
  const Icon = st.icon;
  const testo = c.riassunto?.testo || c.riassunto?.titolo || '';
  const decisioni = lista(c.riassunto?.decisioni);
  const argomenti = lista(c.riassunto?.argomenti);
  const problemi = lista(c.riassunto?.problemi);
  const dettagli = !!(c.trascrizione || decisioni.length || argomenti.length || problemi.length);

  return (
    <li className="px-5 py-3.5">
      <div className="flex items-start gap-3">
        <Icon className={cn('w-4 h-4 mt-0.5 shrink-0', st.color)} />
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="font-semibold text-sm text-slate-900 dark:text-white truncate">{c.nome || c.numero}</span>
            {c.nome && <span className="text-xs font-mono text-slate-400">{c.numero}</span>}
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-0.5 text-xs">
            <span className={cn('font-semibold', st.color)}>{st.label}</span>
            {c.durata_ms ? <span className="inline-flex items-center gap-1 text-slate-500"><Clock className="w-3 h-3" />{durata(c.durata_ms)}</span> : null}
            <span className="text-slate-400">{dataOra(c.updated_at)}</span>
          </div>
          {c.errore && <p className="text-xs text-slate-500 mt-1">{c.errore}</p>}
          {testo && <p className="text-sm text-slate-600 dark:text-slate-300 mt-1.5 leading-relaxed">{testo}</p>}
        </div>
        {dettagli && (
          <button onClick={() => setOpen(o => !o)} aria-expanded={open} aria-label={open ? 'Nascondi dettagli' : 'Mostra dettagli'}
            className="p-1 -m-1 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-white shrink-0">
            <ChevronDown className={cn('w-4 h-4 transition-transform', open && 'rotate-180')} />
          </button>
        )}
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
export function CampaignDetail({ campaignId, onClose }: { campaignId: number; onClose: () => void }) {
  const [campagna, setCampagna] = useState<Campagna | null>(null);
  const [chiamate, setChiamate] = useState<Chiamata[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filtro, setFiltro] = useState<Stato | 'tutte'>('tutte');
  const [search, setSearch] = useState('');

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
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [onClose]);

  const conteggi = useMemo(() => {
    const m = new Map<Stato, number>();
    for (const c of chiamate) m.set(c.stato, (m.get(c.stato) || 0) + 1);
    return ORDINE.filter(s => m.get(s)).map(s => [s, m.get(s)!] as [Stato, number]);
  }, [chiamate]);

  const filtrate = useMemo(() => {
    const q = search.trim().toLowerCase();
    return chiamate
      .filter(c => filtro === 'tutte' || c.stato === filtro)
      .filter(c => !q || [c.nome, c.numero, c.riassunto?.testo, c.riassunto?.titolo, c.errore]
        .some(v => v && v.toLowerCase().includes(q)))
      .sort((a, b) => ORDINE.indexOf(a.stato) - ORDINE.indexOf(b.stato) || a.id - b.id);
  }, [chiamate, filtro, search]);

  const esporta = () => {
    const rows = filtrate.map(c => ({
      Nome: c.nome || '',
      Numero: c.numero,
      Esito: STATI[c.stato]?.label || c.stato,
      Durata: durata(c.durata_ms),
      Ora: dataOra(c.updated_at),
      Riassunto: c.riassunto?.testo || c.riassunto?.titolo || '',
      Decisioni: lista(c.riassunto?.decisioni).join('; '),
      Note: c.errore || '',
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Chiamate');
    const giorno = campagna ? new Date(campagna.created_at).toISOString().slice(0, 10) : 'campagna';
    XLSX.writeFile(wb, `campagna-${giorno}-${campaignId}.xlsx`);
  };

  const conRiassunto = chiamate.filter(c => c.riassunto?.testo || c.riassunto?.titolo).length;

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
              </div>
            )}
          </div>
          <button onClick={load} disabled={loading} aria-label="Aggiorna"
            className="p-2 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 dark:hover:text-white">
            <RefreshCw className={cn('w-4 h-4', loading && 'animate-spin')} />
          </button>
          <button onClick={onClose} aria-label="Chiudi"
            className="p-2 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 dark:hover:text-white">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Filtri */}
        <div className="px-5 py-3 border-b border-slate-200 dark:border-slate-800 space-y-3">
          <div className="flex flex-wrap gap-1.5">
            {([['tutte', chiamate.length] as [Stato | 'tutte', number], ...conteggi]).map(([s, n]) => (
              <button key={s} onClick={() => setFiltro(s)}
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
              {filtrate.map(c => <RigaChiamata key={c.id} c={c} />)}
            </ul>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
