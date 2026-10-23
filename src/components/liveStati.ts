import React from 'react';
import { PhoneCall, PhoneOff, PhoneMissed, PhoneForwarded, Phone, Clock, XCircle, AlertTriangle } from 'lucide-react';

// Stati di una chiamata nella pagina "In diretta" e nel dettaglio campagna.
export type Stato = 'in_coda' | 'avviata' | 'senza_esito' | 'risposta' | 'interrotta' | 'non_risposta' | 'non_partita' | 'errore';

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
};
