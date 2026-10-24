import React, { useEffect, useState } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import { authFetch } from '../lib/authFetch';
import { cn } from '../lib/utils';

interface Traccia {
  sessionId: string; botName?: string; callerName?: string; callerNumber?: string;
  language?: string; status?: string; createdAt?: string | null;
}
interface Dettaglio { usage: unknown; cost: unknown; activities: unknown[] }

const STATI: Record<string, { testo: string; classe: string }> = {
  pending: { testo: 'In attesa', classe: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300' },
  start: { testo: 'In corso', classe: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300' },
  complete: { testo: 'Completata', classe: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300' },
  complete_with_error: { testo: 'Errore', classe: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300' },
};

// Wildix non documenta la forma di usage/cost: li mostriamo come arrivano.
const mostra = (v: unknown) => v == null ? '—' : typeof v === 'object' ? JSON.stringify(v, null, 2) : String(v);

// Sessioni del voicebot lette da Wildix: stato reale, uso e costo di ognuna.
export function TracceWildix() {
  const [tracce, setTracce] = useState<Traccia[] | null>(null);
  const [errore, setErrore] = useState('');
  const [loading, setLoading] = useState(true);
  const [aperta, setAperta] = useState<string | null>(null);
  const [dettagli, setDettagli] = useState<Record<string, Dettaglio | 'errore'>>({});

  const carica = async () => {
    setLoading(true); setErrore('');
    try {
      const r = await authFetch('/api/wildix/tracce');
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'Errore');
      setTracce(j.tracce);
    } catch (e: any) {
      setErrore(e.message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { carica(); }, []);

  const apri = async (id: string) => {
    setAperta(aperta === id ? null : id);
    if (dettagli[id]) return;
    try {
      const r = await authFetch(`/api/wildix/tracce/${encodeURIComponent(id)}`);
      const j = await r.json();
      setDettagli(d => ({ ...d, [id]: j.ok ? j : 'errore' }));
    } catch {
      setDettagli(d => ({ ...d, [id]: 'errore' }));
    }
  };

  const errori = tracce?.filter(t => t.status === 'complete_with_error').length || 0;

  return (
    <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-soft p-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs font-bold text-slate-500 uppercase tracking-wider">
          Sessioni voicebot (Wildix) {tracce && <span className="text-slate-400">{tracce.length}</span>}
          {errori > 0 && <span className="ml-2 text-red-600">{errori} con errore</span>}
        </h3>
        <button onClick={carica} disabled={loading} className="p-1.5 rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800" aria-label="Aggiorna">
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
        </button>
      </div>
      {errore ? <p className="text-sm text-slate-400">Tracce Wildix non disponibili: {errore}</p>
        : !tracce ? null
        : tracce.length === 0 ? <p className="text-sm text-slate-400">Nessuna sessione.</p> : (
          <div className="overflow-x-auto max-h-96">
            <table className="w-full text-sm">
              <thead className="text-xs text-slate-500 sticky top-0 bg-white dark:bg-slate-900">
                <tr><th className="text-left py-1.5">Quando</th><th className="text-left">Voicebot</th><th className="text-left">Chiamato</th><th className="text-left">Stato</th></tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800 text-slate-700 dark:text-slate-300">
                {tracce.map(t => {
                  const s = STATI[t.status || ''] || { testo: t.status || '—', classe: STATI.pending.classe };
                  const d = dettagli[t.sessionId];
                  return (
                    <React.Fragment key={t.sessionId}>
                      <tr onClick={() => apri(t.sessionId)} className="cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/50">
                        <td className="py-1.5 whitespace-nowrap tabular-nums">{t.createdAt ? new Date(t.createdAt).toLocaleString('it-IT', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'}</td>
                        <td className="pr-2">{t.botName || '—'}</td>
                        <td className="pr-2">{t.callerName || t.callerNumber || '—'}</td>
                        <td><span className={cn('text-xs font-semibold px-2 py-0.5 rounded-full', s.classe)}>{s.testo}</span></td>
                      </tr>
                      {aperta === t.sessionId && (
                        <tr><td colSpan={4} className="py-2">
                          {!d ? <Loader2 className="w-4 h-4 animate-spin text-slate-400" />
                            : d === 'errore' ? <p className="text-xs text-slate-400">Dettaglio non disponibile.</p> : (
                              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                                <div><div className="font-bold text-slate-500 mb-1">Costo</div><pre className="whitespace-pre-wrap bg-slate-50 dark:bg-slate-800 rounded-lg p-2">{mostra(d.cost)}</pre></div>
                                <div><div className="font-bold text-slate-500 mb-1">Uso</div><pre className="whitespace-pre-wrap bg-slate-50 dark:bg-slate-800 rounded-lg p-2">{mostra(d.usage)}</pre></div>
                              </div>
                            )}
                        </td></tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
    </section>
  );
}
