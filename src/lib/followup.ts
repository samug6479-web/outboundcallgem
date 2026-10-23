// Esiti con cui si chiude un follow-up e aiuti per la data di richiamo.

export type EsitoFinale = 'venduto' | 'appuntamento' | 'preventivo' | 'non_interessato' | 'non_raggiungibile' | 'altro';

export const ESITI_FINALI: { id: EsitoFinale; label: string; cls: string }[] = [
  { id: 'venduto', label: 'Venduto', cls: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300' },
  { id: 'appuntamento', label: 'Appuntamento fissato', cls: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300' },
  { id: 'preventivo', label: 'Preventivo / info inviate', cls: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300' },
  { id: 'non_interessato', label: 'Non interessato', cls: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300' },
  { id: 'non_raggiungibile', label: 'Non raggiungibile', cls: 'bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300' },
  { id: 'altro', label: 'Altro', cls: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300' },
];
export const esitoFinale = (id?: string | null) => ESITI_FINALI.find(e => e.id === id) || null;

// "2026-10-24T09:30" per <input type="datetime-local">, nell'ora del browser.
export const perInputLocale = (iso?: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

// Scorciatoie: tra un'ora, domani mattina, lunedì mattina.
export const scorciatoieRichiamo = (): { label: string; data: Date }[] => {
  const ora = new Date();
  const traUnOra = new Date(ora.getTime() + 60 * 60_000);
  traUnOra.setMinutes(Math.ceil(traUnOra.getMinutes() / 15) * 15, 0, 0);
  const domani = new Date(ora); domani.setDate(ora.getDate() + 1); domani.setHours(9, 30, 0, 0);
  const pomeriggio = new Date(ora); pomeriggio.setHours(15, 0, 0, 0);
  const lunedi = new Date(ora); lunedi.setDate(ora.getDate() + ((8 - ora.getDay()) % 7 || 7)); lunedi.setHours(9, 30, 0, 0);
  const out = [{ label: 'Tra un\'ora', data: traUnOra }];
  if (pomeriggio.getTime() > ora.getTime() + 30 * 60_000) out.push({ label: 'Oggi alle 15', data: pomeriggio });
  out.push({ label: 'Domani 9:30', data: domani });
  if (lunedi.toDateString() !== domani.toDateString()) out.push({ label: 'Lunedì 9:30', data: lunedi });
  return out;
};

// Come mostrare la data di richiamo: scaduta, oggi, domani o data.
export const statoRichiamo = (iso?: string | null): { testo: string; cls: string; tipo: 'scaduto' | 'oggi' | 'futuro' } | null => {
  if (!iso) return null;
  const d = new Date(iso);
  const ora = new Date();
  const hhmm = d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
  const stessoGiorno = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  const domani = new Date(ora); domani.setDate(ora.getDate() + 1);
  const ieri = new Date(ora); ieri.setDate(ora.getDate() - 1);
  const giorno = stessoGiorno(d, ora) ? 'oggi' : stessoGiorno(d, domani) ? 'domani' : stessoGiorno(d, ieri) ? 'ieri'
    : d.toLocaleDateString('it-IT', { weekday: 'short', day: 'numeric', month: 'short' });
  if (d.getTime() < ora.getTime()) {
    return { testo: `Scaduto · ${giorno} ${hhmm}`, cls: 'bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300', tipo: 'scaduto' };
  }
  if (stessoGiorno(d, ora)) return { testo: `Richiamare oggi ${hhmm}`, cls: 'bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-300', tipo: 'oggi' };
  return { testo: `Richiamare ${giorno} ${hhmm}`, cls: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300', tipo: 'futuro' };
};
