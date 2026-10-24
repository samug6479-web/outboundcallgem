import React, { useCallback, useEffect, useState } from 'react';
import { AlertOctagon, X } from 'lucide-react';
import { authFetch } from '../lib/authFetch';

interface Problema { chiave: string; titolo: string; dettaglio: string }

const OGNI_MS = 5 * 60 * 1000;

// Solo Admin: avviso rosso se il controllo automatico trova problemi
// (sveglia Make, campagne ferme, chiamate in errore, esiti Wildix mancanti).
export function SaluteAvviso() {
  const [problemi, setProblemi] = useState<Problema[]>([]);
  const [nascosti, setNascosti] = useState<string[]>(() => {
    try { return JSON.parse(sessionStorage.getItem('gem_salute_nascosti') || '[]'); } catch { return []; }
  });

  const carica = useCallback(() => {
    authFetch('/api/salute').then(r => r.json())
      .then(d => { if (d?.ok) setProblemi(d.problemi || []); })
      .catch(() => {});
  }, []);
  useEffect(() => {
    carica();
    const t = window.setInterval(() => { if (document.visibilityState === 'visible') carica(); }, OGNI_MS);
    return () => window.clearInterval(t);
  }, [carica]);

  const visibili = problemi.filter(p => !nascosti.includes(p.chiave));
  if (!visibili.length) return null;
  const nascondi = () => {
    const n = [...new Set([...nascosti, ...visibili.map(p => p.chiave)])];
    setNascosti(n);
    try { sessionStorage.setItem('gem_salute_nascosti', JSON.stringify(n)); } catch { /* niente */ }
  };

  return (
    <div role="alert" className="mb-6 flex items-start gap-3 p-4 rounded-2xl border border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-900/10 animate-in fade-in slide-in-from-top-2">
      <AlertOctagon className="w-5 h-5 text-red-600 mt-0.5 shrink-0" />
      <div className="flex-1 min-w-0 space-y-1.5">
        {visibili.map(p => (
          <div key={p.chiave}>
            <p className="text-sm font-semibold text-red-900 dark:text-red-200">{p.titolo}</p>
            <p className="text-xs text-red-800/80 dark:text-red-300/80">{p.dettaglio}</p>
          </div>
        ))}
        <p className="text-[11px] text-red-700/70 dark:text-red-300/60">Lo stesso avviso arriva per email agli Admin.</p>
      </div>
      <button onClick={nascondi} aria-label="Nascondi avviso" title="Nascondi fino alla prossima apertura"
        className="p-1.5 text-red-400 hover:text-red-700 rounded-lg transition-colors">
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}
