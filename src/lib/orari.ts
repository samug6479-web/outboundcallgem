// Orari consentiti per le chiamate (ora italiana). Stessa logica del server
// (api/index.ts): qui serve solo per avvisare l'operatore prima del lancio.
export interface Fascia { da: string; a: string }
export interface OrariConsentiti { attivo: boolean; giorni: number[]; fasce: Fascia[] }

export const GIORNI = [
  { d: 1, breve: 'Lu', nome: 'lunedì' }, { d: 2, breve: 'Ma', nome: 'martedì' }, { d: 3, breve: 'Me', nome: 'mercoledì' },
  { d: 4, breve: 'Gi', nome: 'giovedì' }, { d: 5, breve: 'Ve', nome: 'venerdì' }, { d: 6, breve: 'Sa', nome: 'sabato' },
  { d: 0, breve: 'Do', nome: 'domenica' },
];

const minuti = (hhmm: string) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || '');
  return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : -1;
};

function parteRoma(d: Date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Rome', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d).map(x => [x.type, x.value]));
  return { dow: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday), min: +p.hour * 60 + +p.minute };
}

export function dentroOrari(o: OrariConsentiti | null | undefined, d: Date = new Date()): boolean {
  if (!o || !o.attivo) return true;
  const p = parteRoma(d);
  return o.giorni.includes(p.dow) && o.fasce.some(f => p.min >= minuti(f.da) && p.min < minuti(f.a));
}

// Prima apertura dopo "d", cercata a passi di 5 minuti (basta per un avviso).
export function prossimaApertura(o: OrariConsentiti | null | undefined, d: Date = new Date()): Date | null {
  if (dentroOrari(o, d)) return d;
  const passo = 5 * 60_000;
  let t = Math.ceil(d.getTime() / passo) * passo;
  for (let i = 0; i < 8 * 24 * 12; i++, t += passo) if (dentroOrari(o, new Date(t))) return new Date(t);
  return null;
}

export function descriviOrari(o: OrariConsentiti | null | undefined): string {
  if (!o || !o.attivo) return 'Sempre';
  const giorni = GIORNI.filter(g => o.giorni.includes(g.d)).map(g => g.breve).join(' ');
  return `${giorni} · ${o.fasce.map(f => `${f.da}–${f.a}`).join(', ')}`;
}

export const quandoBreve = (d: Date) =>
  d.toLocaleString('it-IT', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
