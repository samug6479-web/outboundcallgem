import React from 'react';
import { PhoneCall, PhoneOff, PhoneMissed, PhoneForwarded, Phone, Clock, XCircle, AlertTriangle, RotateCcw, Ban, CircleSlash } from 'lucide-react';

// Stati di una chiamata nella pagina "In diretta" e nel dettaglio campagna.
export type Stato = 'in_coda' | 'avviata' | 'senza_esito' | 'programmata' | 'annullata' | 'escluso' | 'risposta' | 'interrotta' | 'non_risposta' | 'non_partita' | 'errore';

export const STATI: Record<Stato, { label: string; color: string; bar: string; icon: React.ElementType }> = {
  in_coda: { label: 'In coda', color: 'text-slate-500', bar: 'bg-slate-200 dark:bg-slate-700', icon: Clock },
  avviata: { label: 'In corso', color: 'text-blue-600 dark:text-blue-400', bar: 'bg-blue-500', icon: PhoneCall },
  risposta: { label: 'Risposto', color: 'text-green-600 dark:text-green-400', bar: 'bg-green-500', icon: Phone },
  interrotta: { label: 'Interrotta', color: 'text-amber-600 dark:text-amber-400', bar: 'bg-amber-500', icon: PhoneOff },
  non_risposta: { label: 'Non risposto', color: 'text-slate-500 dark:text-slate-400', bar: 'bg-slate-400', icon: PhoneMissed },
  // Wildix non ha completato la chiamata: rifiutata, occupato, nessuna risposta o numero non raggiungibile
  non_partita: { label: 'Non partita', color: 'text-orange-600 dark:text-orange-400', bar: 'bg-orange-400', icon: PhoneForwarded },
  errore: { label: 'Errore', color: 'text-red-600 dark:text-red-400', bar: 'bg-red-500', icon: XCircle },
  // Wildix ha accettato la chiamata ma da oltre 30 minuti non è arrivato l'evento di fine
  senza_esito: { label: 'Senza esito', color: 'text-slate-500 dark:text-slate-400', bar: 'bg-slate-300 dark:bg-slate-600', icon: AlertTriangle },
  // Non raggiunto: verrà richiamato in automatico all'orario indicato
  programmata: { label: 'Da richiamare', color: 'text-violet-600 dark:text-violet-400', bar: 'bg-violet-400', icon: RotateCcw },
  // Campagna fermata prima di chiamarlo
  annullata: { label: 'Annullata', color: 'text-slate-400 dark:text-slate-500', bar: 'bg-slate-200 dark:bg-slate-700', icon: CircleSlash },
  // Nella lista "Non chiamare"
  escluso: { label: 'Non chiamare', color: 'text-rose-600 dark:text-rose-400', bar: 'bg-rose-300 dark:bg-rose-700', icon: Ban },
};

// Esito commerciale ricavato dal riassunto di Wilma.
export type EsitoCommerciale = 'appuntamento' | 'interessato' | 'richiamare' | 'non_interessato' | 'non_chiamare' | 'da_valutare';
export const ESITI_COMMERCIALI: Record<EsitoCommerciale, { label: string; cls: string }> = {
  appuntamento: { label: 'Appuntamento', cls: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300' },
  interessato: { label: 'Interessato', cls: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300' },
  richiamare: { label: 'Da richiamare', cls: 'bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-300' },
  non_interessato: { label: 'Non interessato', cls: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300' },
  non_chiamare: { label: 'Non chiamare', cls: 'bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300' },
  da_valutare: { label: 'Da valutare', cls: 'bg-slate-50 text-slate-500 dark:bg-slate-800/60 dark:text-slate-400' },
};

// Pausa, ripresa e stop di una campagna (solo con la coda del sito).
export async function azioneCampagna(id: number, azione: 'pausa' | 'riprendi' | 'ferma' | 'elimina'): Promise<{ ok: boolean; error?: string }> {
  const { authFetch } = await import('../lib/authFetch');
  try {
    const res = azione === 'elimina'
      ? await authFetch(`/api/live/campaigns/${id}`, { method: 'DELETE' })
      : azione === 'ferma'
      ? await authFetch(`/api/live/campaigns/${id}/ferma`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      : await authFetch(`/api/live/campaigns/${id}/pausa`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pausa: azione === 'pausa' }),
        });
    const data = await res.json().catch(() => ({}));
    return res.ok && data.ok ? { ok: true } : { ok: false, error: data.error || `Errore HTTP ${res.status}` };
  } catch {
    return { ok: false, error: 'Errore di rete' };
  }
}

export const oraBreve = (iso: string) => new Date(iso).toLocaleString('it-IT', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
