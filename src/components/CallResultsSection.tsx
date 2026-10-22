import React, { useEffect, useMemo, useState } from 'react';
import { PhoneCall, CheckCircle2, XCircle, ChevronDown, RefreshCw, Clock, Search, Download } from 'lucide-react';
import * as XLSX from 'xlsx';
import { cn } from '../lib/utils';
import { authFetch } from '../lib/authFetch';

interface CallResult {
  callId: string;
  numero: string | null;
  nome?: string | null;
  risposto: boolean | null;
  durata: number | null;
  timestamp: string;
  trascrizione: string | null;
  riassunto?: {
    titolo: string | null;
    testo: string | null;
    argomenti: string[];
    decisioni: string[];
    problemi: string[];
  } | null;
}

function formatDurata(ms: number | null) {
  if (!ms) return '—';
  const sec = Math.round(ms / 1000);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function isRifiutato(r: CallResult): boolean {
  const decisioni = r.riassunto?.decisioni || [];
  return decisioni.some(d => /non conferma|rifiut/i.test(d));
}

function isConfermato(r: CallResult): boolean {
  const decisioni = r.riassunto?.decisioni || [];
  return decisioni.some(d => /confer/i.test(d)) && !isRifiutato(r);
}

type Esito = 'confermato' | 'rifiutato' | 'non_risposto' | 'altro';

function getEsito(r: CallResult): Esito {
  if (r.risposto === false) return 'non_risposto';
  if (isRifiutato(r)) return 'rifiutato';
  if (isConfermato(r)) return 'confermato';
  return 'altro';
}

const ESITO_LABEL: Record<Esito, string> = {
  confermato: 'Confermato',
  rifiutato: 'Rifiutato',
  non_risposto: 'Non risposto',
  altro: 'Altro',
};

function ResultCard({ r }: { r: CallResult }) {
  const [open, setOpen] = useState(false);
  const rifiutato = isRifiutato(r);
  const confermato = isConfermato(r);

  return (
    <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
      <div className="p-4 flex items-start gap-3">
        <div className={cn(
          "w-9 h-9 rounded-full flex items-center justify-center shrink-0",
          r.risposto ? "bg-emerald-100 dark:bg-emerald-900/30 text-emerald-600" : "bg-slate-100 dark:bg-slate-800 text-slate-400"
        )}>
          <PhoneCall className="w-4 h-4" />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-sm text-slate-900 dark:text-white">
              {r.nome
                ? `${r.nome} — ${r.numero || ''}`
                : r.numero
                  ? `${r.numero} — ${r.riassunto?.titolo || r.callId}`
                  : (r.riassunto?.titolo || r.callId)}
            </span>

            {r.risposto === false && (
              <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-500">
                Non risposto
              </span>
            )}
            {confermato && (
              <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300 flex items-center gap-1">
                <CheckCircle2 className="w-3 h-3" /> Confermato
              </span>
            )}
            {rifiutato && (
              <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300 flex items-center gap-1">
                <XCircle className="w-3 h-3" /> Rifiutato
              </span>
            )}
          </div>

          <div className="flex items-center gap-3 mt-1 text-xs text-slate-500 dark:text-slate-400">
            <span className="flex items-center gap-1"><Clock className="w-3 h-3" /> {formatDurata(r.durata)}</span>
            <span>{new Date(r.timestamp).toLocaleString('it-IT')}</span>
          </div>

          {r.riassunto?.testo && (
            <p className="text-sm text-slate-600 dark:text-slate-300 mt-2">{r.riassunto.testo}</p>
          )}
        </div>

        {(r.trascrizione || r.riassunto) && (
          <button
            onClick={() => setOpen(o => !o)}
            className="text-slate-400 hover:text-slate-700 dark:hover:text-white shrink-0"
          >
            <ChevronDown className={cn("w-4 h-4 transition-transform", open && "rotate-180")} />
          </button>
        )}
      </div>

      {open && (
        <div className="px-4 pb-4 border-t border-slate-100 dark:border-slate-800 pt-3 space-y-3">
          {r.riassunto?.argomenti && r.riassunto.argomenti.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {r.riassunto.argomenti.map((a, i) => (
                <span key={i} className="text-[11px] px-2 py-0.5 rounded-full bg-brand-50 dark:bg-brand-900/20 text-brand-700 dark:text-brand-300">
                  {a}
                </span>
              ))}
            </div>
          )}

          {r.trascrizione && (
            <details className="text-xs">
              <summary className="cursor-pointer font-semibold text-slate-500 dark:text-slate-400">
                Trascrizione completa
              </summary>
              <pre className="whitespace-pre-wrap mt-2 text-slate-600 dark:text-slate-300 font-sans">
                {r.trascrizione}
              </pre>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

interface Stats {
  totale: number;
  risposte: number;
  non_risposte: number;
  durata_media_ms: number | null;
}

function StatsBar() {
  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    authFetch('/api/voicebot-stats')
      .then(r => r.json())
      .then(d => setStats(d.totali || null))
      .catch(() => setStats(null));
  }, []);

  if (!stats) return null;

  const items = [
    { label: 'Chiamate totali', value: stats.totale },
    { label: 'Risposte', value: stats.risposte },
    { label: 'Non risposte', value: stats.non_risposte },
    { label: 'Durata media', value: formatDurata(stats.durata_media_ms) },
  ];

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
      {items.map(it => (
        <div key={it.label} className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-3">
          <div className="text-lg font-bold text-slate-900 dark:text-white">{it.value}</div>
          <div className="text-[11px] text-slate-500 dark:text-slate-400">{it.label}</div>
        </div>
      ))}
    </div>
  );
}

export function CallResultsSection() {
  const [results, setResults] = useState<CallResult[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 20;
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [esitoFiltro, setEsitoFiltro] = useState<Esito | 'tutti'>('tutti');

  const load = async (p = page) => {
    setLoading(true);
    try {
      const res = await authFetch(`/api/call-results?limit=${PAGE_SIZE}&offset=${p * PAGE_SIZE}`);
      const data = await res.json();
      setResults(data.results || []);
      setTotal(data.total || 0);
    } catch {
      setResults([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return results.filter(r => {
      if (esitoFiltro !== 'tutti' && getEsito(r) !== esitoFiltro) return false;
      if (!q) return true;
      return (
        r.nome?.toLowerCase().includes(q) ||
        r.numero?.toLowerCase().includes(q) ||
        r.riassunto?.titolo?.toLowerCase().includes(q) ||
        r.riassunto?.testo?.toLowerCase().includes(q)
      );
    });
  }, [results, search, esitoFiltro]);

  const exportExcel = () => {
    const rows = filtered.map(r => ({
      Nome: r.nome || '',
      Numero: r.numero || '',
      Esito: ESITO_LABEL[getEsito(r)],
      Durata: formatDurata(r.durata),
      Data: new Date(r.timestamp).toLocaleString('it-IT'),
      Riassunto: r.riassunto?.testo || '',
      Decisioni: (r.riassunto?.decisioni || []).join('; '),
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Esiti Chiamate');
    XLSX.writeFile(wb, `esiti-voicebot-${new Date().toISOString().slice(0, 10)}.xlsx`);
  };

  return (
    <div className="animate-in fade-in slide-in-from-bottom-4 duration-300 max-w-3xl">
      <StatsBar />
      <div className="flex flex-col sm:flex-row sm:items-center gap-3 mb-4">
        <div className="relative flex-1">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Cerca per nome, numero o contenuto..."
            className="w-full pl-9 pr-3 py-2 text-sm rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-900 dark:text-white placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
        </div>

        <select
          value={esitoFiltro}
          onChange={e => setEsitoFiltro(e.target.value as Esito | 'tutti')}
          className="text-sm rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-900 dark:text-white px-3 py-2 focus:outline-none focus:ring-2 focus:ring-brand-500"
        >
          <option value="tutti">Tutti gli esiti</option>
          <option value="confermato">Confermato</option>
          <option value="rifiutato">Rifiutato</option>
          <option value="non_risposto">Non risposto</option>
          <option value="altro">Altro</option>
        </select>

        <button
          onClick={exportExcel}
          disabled={filtered.length === 0}
          className="flex items-center justify-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-xl bg-brand-600 hover:bg-brand-700 disabled:opacity-40 disabled:cursor-not-allowed text-white shrink-0"
        >
          <Download className="w-3.5 h-3.5" /> Esporta
        </button>

        <button
          onClick={() => load()}
          className="flex items-center justify-center gap-1.5 text-xs font-semibold text-slate-500 hover:text-slate-900 dark:hover:text-white shrink-0"
        >
          <RefreshCw className={cn("w-3.5 h-3.5", loading && "animate-spin")} /> Aggiorna
        </button>
      </div>

      <div className="text-xs text-slate-400 mb-3">
        {filtered.length} di {results.length} chiamate in questa pagina · {total} totali
      </div>

      {loading && results.length === 0 && (
        <p className="text-sm text-slate-400">Caricamento...</p>
      )}

      {!loading && results.length === 0 && (
        <p className="text-sm text-slate-400">Nessuna chiamata registrata finora.</p>
      )}

      {!loading && results.length > 0 && filtered.length === 0 && (
        <p className="text-sm text-slate-400">Nessun risultato per questa ricerca/filtro.</p>
      )}

      <div className="space-y-3">
        {filtered.map(r => <ResultCard key={r.callId} r={r} />)}
      </div>

      {total > PAGE_SIZE && (
        <div className="flex items-center justify-center gap-3 mt-6">
          <button
            onClick={() => { const p = Math.max(0, page - 1); setPage(p); load(p); }}
            disabled={page === 0}
            className="text-xs font-semibold px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-800 disabled:opacity-30 text-slate-600 dark:text-slate-300"
          >
            ← Precedente
          </button>
          <span className="text-xs text-slate-400">
            Pagina {page + 1} di {Math.ceil(total / PAGE_SIZE)}
          </span>
          <button
            onClick={() => { const p = page + 1; setPage(p); load(p); }}
            disabled={(page + 1) * PAGE_SIZE >= total}
            className="text-xs font-semibold px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-800 disabled:opacity-30 text-slate-600 dark:text-slate-300"
          >
            Successiva →
          </button>
        </div>
      )}
    </div>
  );
}
