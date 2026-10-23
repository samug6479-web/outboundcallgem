import React, { useCallback, useEffect, useState } from 'react';
import { BellRing, X } from 'lucide-react';
import { authFetch } from '../lib/authFetch';

interface Notifica {
  id: number;
  tipo: string;
  titolo: string;
  testo: string | null;
  followup_id: number | null;
  creata_da: string | null;
  creata_at: string;
}

const OGNI_MS = 2 * 60 * 1000;

// Avviso in cima alla pagina con le notifiche non lette (es. follow-up assegnati).
// Si aggiorna all'accesso, quando si torna sulla scheda e ogni 2 minuti.
export function NotificheAvviso({ onApriFollowup }: { onApriFollowup: () => void }) {
  const [notifiche, setNotifiche] = useState<Notifica[]>([]);

  const carica = useCallback(() => {
    authFetch('/api/notifiche')
      .then(r => r.json())
      .then(d => { if (d?.ok) setNotifiche(d.notifiche || []); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    carica();
    const t = window.setInterval(carica, OGNI_MS);
    const onFocus = () => { if (document.visibilityState === 'visible') carica(); };
    document.addEventListener('visibilitychange', onFocus);
    return () => { window.clearInterval(t); document.removeEventListener('visibilitychange', onFocus); };
  }, [carica]);

  const segnaLette = (ids?: number[]) => {
    setNotifiche(prev => (ids ? prev.filter(n => !ids.includes(n.id)) : []));
    authFetch('/api/notifiche/lette', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ids ? { ids } : {}),
    }).catch(() => {});
  };

  if (notifiche.length === 0) return null;
  const visibili = notifiche.slice(0, 3);
  const altre = notifiche.length - visibili.length;

  return (
    <div role="status" className="mb-6 flex items-start gap-3 p-4 rounded-2xl border border-brand-200 dark:border-brand-500/30 bg-brand-50 dark:bg-brand-500/10 animate-in fade-in slide-in-from-top-2">
      <BellRing className="w-5 h-5 text-brand-600 dark:text-brand-300 mt-0.5 shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-slate-900 dark:text-white">
          {notifiche.length === 1 ? 'Hai un nuovo follow-up assegnato' : `Hai ${notifiche.length} nuovi follow-up assegnati`}
        </p>
        <ul className="mt-1 space-y-0.5">
          {visibili.map(n => (
            <li key={n.id} className="text-xs text-slate-600 dark:text-slate-300">
              {n.titolo}{n.testo ? <span className="text-slate-400"> · {n.testo}</span> : null}
            </li>
          ))}
          {altre > 0 && <li className="text-xs text-slate-400">e altri {altre}</li>}
        </ul>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <button
          onClick={() => { segnaLette(); onApriFollowup(); }}
          className="px-3 py-1.5 bg-brand-600 hover:bg-brand-700 text-white text-xs font-bold rounded-lg transition-colors"
        >
          Apri i miei follow-up
        </button>
        <button onClick={() => segnaLette()} aria-label="Segna come lette" title="Segna come lette"
          className="p-1.5 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 rounded-lg transition-colors">
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
