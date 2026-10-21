import React, { useEffect, useState } from 'react';
import { BellRing, CheckCircle2, Loader2, Phone, RefreshCw } from 'lucide-react';
import { authFetch } from '../lib/authFetch';
import { cn } from '../lib/utils';

interface Followup {
  id: number;
  call_id: string;
  numero: string | null;
  nome: string | null;
  motivo: string;
  stato: string;
  created_at: string;
}

type Stato = 'pending' | 'done';

function motivoClass(motivo: string) {
  if (motivo === 'Non risposto') return 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300';
  if (/rifiut|disdett/i.test(motivo)) return 'bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-400';
  return 'bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400';
}

// Elenco dei contatti da richiamare o gestire a mano: chiamate non risposte,
// appuntamenti rifiutati, disdette, trasferimenti, ecc.
export function FollowupsSection() {
  const [stato, setStato] = useState<Stato>('pending');
  const [items, setItems] = useState<Followup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [motivo, setMotivo] = useState('tutti');
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = async (s: Stato = stato) => {
    setLoading(true);
    setError('');
    try {
      const res = await authFetch(`/api/followups?stato=${s}`);
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error();
      setItems(data.followups || []);
    } catch {
      setError('Impossibile caricare i follow-up.');
      setItems([]);
    }
    setLoading(false);
  };

  useEffect(() => { load(stato); setMotivo('tutti'); }, [stato]);

  const markDone = async (id: number) => {
    setBusyId(id);
    try {
      const res = await authFetch(`/api/followups/${id}/done`, { method: 'POST' });
      if (res.ok) setItems(prev => prev.filter(f => f.id !== id));
      else setError('Impossibile aggiornare il follow-up.');
    } catch {
      setError('Errore di rete.');
    }
    setBusyId(null);
  };

  const motivi = [...new Set(items.map(f => f.motivo))];
  const visible = motivo === 'tutti' ? items : items.filter(f => f.motivo === motivo);

  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-soft overflow-hidden animate-in fade-in slide-in-from-bottom-4 duration-300">
      <div className="p-5 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/30 flex flex-wrap items-center gap-3 justify-between">
        <div className="flex items-center gap-2">
          <BellRing className="w-4 h-4 text-brand-600" />
          <h2 className="text-base font-bold text-slate-900 dark:text-white font-display">
            {stato === 'pending' ? 'Da gestire' : 'Gestiti'}
            {!loading && <span className="ml-2 text-sm font-semibold text-slate-400">{visible.length}</span>}
          </h2>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden text-xs font-semibold">
            {(['pending', 'done'] as Stato[]).map(s => (
              <button key={s} onClick={() => setStato(s)}
                className={cn('px-3 py-1.5 transition-colors', stato === s ? 'bg-brand-600 text-white' : 'text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800')}>
                {s === 'pending' ? 'Da gestire' : 'Gestiti'}
              </button>
            ))}
          </div>
          {motivi.length > 1 && (
            <select value={motivo} onChange={e => setMotivo(e.target.value)} aria-label="Filtra per motivo"
              className="text-xs px-2 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 dark:text-white">
              <option value="tutti">Tutti i motivi</option>
              {motivi.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          )}
          <button onClick={() => load()} aria-label="Aggiorna" title="Aggiorna"
            className="p-1.5 text-slate-400 hover:text-brand-600 hover:bg-brand-50 rounded-lg transition-colors">
            <RefreshCw className={cn('w-4 h-4', loading && 'animate-spin')} />
          </button>
        </div>
      </div>

      {error && <p className="px-5 pt-4 text-sm text-red-500">{error}</p>}

      {loading ? (
        <div className="p-10 flex justify-center text-slate-400"><Loader2 className="w-5 h-5 animate-spin" /></div>
      ) : visible.length === 0 ? (
        <div className="p-10 text-center text-sm text-slate-500">
          {stato === 'pending' ? 'Nessun contatto da gestire.' : 'Nessun follow-up gestito.'}
        </div>
      ) : (
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {visible.map(f => (
            <li key={f.id} className="px-5 py-3 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-semibold text-slate-900 dark:text-white truncate">{f.nome || f.numero || 'Contatto sconosciuto'}</span>
                  <span className={cn('text-[11px] font-bold px-2 py-0.5 rounded-full', motivoClass(f.motivo))}>{f.motivo}</span>
                </div>
                <div className="text-xs text-slate-500 mt-0.5 flex items-center gap-2 flex-wrap">
                  {f.numero && (
                    <a href={`tel:${f.numero}`} className="inline-flex items-center gap-1 text-brand-600 hover:underline">
                      <Phone className="w-3 h-3" />{f.numero}
                    </a>
                  )}
                  <span>{new Date(f.created_at).toLocaleString('it-IT', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
                </div>
              </div>
              {stato === 'pending' && (
                <button onClick={() => markDone(f.id)} disabled={busyId === f.id}
                  className="shrink-0 inline-flex items-center gap-1 text-xs font-semibold text-green-700 dark:text-green-400 hover:bg-green-50 dark:hover:bg-green-900/20 px-2.5 py-1.5 rounded-lg transition-colors disabled:opacity-50">
                  {busyId === f.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
                  Fatto
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
