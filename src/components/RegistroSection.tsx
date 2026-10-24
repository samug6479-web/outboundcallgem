import React, { useEffect, useMemo, useState } from 'react';
import { Loader2, Download, ScrollText } from 'lucide-react';
import * as XLSX from 'xlsx';
import { authFetch } from '../lib/authFetch';
import { cn } from '../lib/utils';

interface Voce { id: number; ts: string; username: string | null; nome: string | null; azione: string; dettaglio: string | null; ip: string | null }

// Nomi leggibili delle azioni registrate dal server.
const AZIONI: Record<string, { label: string; tono: 'blu' | 'verde' | 'rosso' | 'grigio' | 'ambra' }> = {
  campagna_avviata: { label: 'Campagna avviata', tono: 'blu' },
  campagna_pianificata: { label: 'Campagna pianificata', tono: 'blu' },
  pianificata_annullata: { label: 'Pianificata annullata', tono: 'ambra' },
  campagna_pausa: { label: 'Campagna in pausa', tono: 'ambra' },
  campagna_ripresa: { label: 'Campagna ripresa', tono: 'blu' },
  campagna_fermata: { label: 'Campagna fermata', tono: 'rosso' },
  campagna_eliminata: { label: 'Campagna eliminata', tono: 'rosso' },
  storico_svuotato: { label: 'Storico svuotato', tono: 'rosso' },
  utente_creato: { label: 'Utente creato', tono: 'verde' },
  utente_modificato: { label: 'Utente modificato', tono: 'grigio' },
  utente_eliminato: { label: 'Utente eliminato', tono: 'rosso' },
  invito_inviato: { label: 'Invito inviato', tono: 'grigio' },
  '2fa': { label: 'Verifica in due passaggi', tono: 'grigio' },
  voicebot_creato: { label: 'Voicebot creato', tono: 'verde' },
  voicebot_modificato: { label: 'Voicebot modificato', tono: 'grigio' },
  voicebot_eliminato: { label: 'Voicebot eliminato', tono: 'rosso' },
  non_chiamare_aggiunti: { label: 'Aggiunti a Non chiamare', tono: 'ambra' },
  non_chiamare_rimosso: { label: 'Tolto da Non chiamare', tono: 'rosso' },
  orari_modificati: { label: 'Orari modificati', tono: 'grigio' },
  conservazione_modificata: { label: 'Conservazione dati modificata', tono: 'grigio' },
  conservazione_applicata: { label: 'Dati vecchi cancellati', tono: 'grigio' },
  followup_assegnato: { label: 'Follow-up assegnato', tono: 'grigio' },
  followup_assegnati: { label: 'Follow-up assegnati', tono: 'grigio' },
  followup_chiuso: { label: 'Follow-up chiuso', tono: 'verde' },
  followup_chiusi: { label: 'Follow-up chiusi', tono: 'verde' },
  esito_corretto: { label: 'Esito corretto a mano', tono: 'grigio' },
  lista_salvata: { label: 'Lista salvata', tono: 'grigio' },
  lista_eliminata: { label: 'Lista eliminata', tono: 'ambra' },
  dati_numero_consultati: { label: 'Dati di un numero consultati', tono: 'grigio' },
  dati_numero_cancellati: { label: 'Dati di un numero cancellati', tono: 'rosso' },
  azienda_creata: { label: 'Azienda creata', tono: 'verde' },
  azienda_modificata: { label: 'Azienda modificata', tono: 'grigio' },
  azienda_eliminata: { label: 'Azienda eliminata', tono: 'rosso' },
};
const TONI = {
  blu: 'bg-blue-50 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300',
  verde: 'bg-green-50 text-green-700 dark:bg-green-500/15 dark:text-green-300',
  rosso: 'bg-red-50 text-red-700 dark:bg-red-500/15 dark:text-red-300',
  ambra: 'bg-amber-50 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300',
  grigio: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
};
const etichetta = (a: string) => AZIONI[a]?.label || a;

// Registro attività (solo Admin): chi ha fatto cosa, con filtri ed Excel.
export function RegistroSection() {
  const [giorni, setGiorni] = useState(30);
  const [chi, setChi] = useState('');
  const [azione, setAzione] = useState('');
  const [voci, setVoci] = useState<Voce[]>([]);
  const [loading, setLoading] = useState(true);
  const [errore, setErrore] = useState('');

  useEffect(() => {
    setLoading(true);
    authFetch(`/api/registro?giorni=${giorni}`).then(r => r.json())
      .then(d => { if (d.ok) { setVoci(d.voci); setErrore(''); } else setErrore(d.error || 'Errore'); })
      .catch(() => setErrore('Errore di rete'))
      .finally(() => setLoading(false));
  }, [giorni]);

  const persone = useMemo(() => [...new Map(voci.filter(v => v.username).map(v => [v.username!.toLowerCase(), v.nome || v.username!])).entries()], [voci]);
  const azioni = useMemo(() => [...new Set(voci.map(v => v.azione))].sort((a, b) => etichetta(a).localeCompare(etichetta(b))), [voci]);
  const filtrate = voci.filter(v => (!chi || v.username?.toLowerCase() === chi) && (!azione || v.azione === azione));
  const quando = (ts: string) => new Date(ts).toLocaleString('it-IT', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  const esporta = () => {
    const ws = XLSX.utils.json_to_sheet(filtrate.map(v => ({ Quando: new Date(v.ts).toLocaleString('it-IT'), Chi: v.nome || v.username || 'Sistema', Utente: v.username || '', Azione: etichetta(v.azione), Dettaglio: v.dettaglio || '', IP: v.ip || '' })));
    ws['!cols'] = [{ wch: 20 }, { wch: 22 }, { wch: 18 }, { wch: 30 }, { wch: 70 }, { wch: 16 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Registro attività');
    XLSX.writeFile(wb, `registro-attivita-${new Date().toISOString().slice(0, 10)}.xlsx`);
  };

  const sel = 'px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm text-slate-900 dark:text-white';
  return (
    <div className="space-y-5 animate-in fade-in slide-in-from-bottom-4 duration-300">
      <div className="flex flex-wrap items-center gap-2">
        <select aria-label="Periodo" value={giorni} onChange={e => setGiorni(parseInt(e.target.value, 10))} className={sel}>
          <option value={1}>Oggi e ieri</option><option value={7}>Ultimi 7 giorni</option><option value={30}>Ultimi 30 giorni</option>
          <option value={90}>Ultimi 90 giorni</option><option value={365}>Ultimo anno</option>
        </select>
        <select aria-label="Persona" value={chi} onChange={e => setChi(e.target.value)} className={sel}>
          <option value="">Tutte le persone</option>
          {persone.map(([u, n]) => <option key={u} value={u}>{n}</option>)}
        </select>
        <select aria-label="Azione" value={azione} onChange={e => setAzione(e.target.value)} className={sel}>
          <option value="">Tutte le azioni</option>
          {azioni.map(a => <option key={a} value={a}>{etichetta(a)}</option>)}
        </select>
        <div className="flex-1" />
        <button onClick={esporta} disabled={!filtrate.length}
          className="inline-flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-semibold border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50">
          <Download className="w-4 h-4" /> Esporta Excel
        </button>
      </div>

      <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-soft overflow-hidden">
        {loading ? <div className="p-10 flex justify-center text-slate-400"><Loader2 className="w-5 h-5 animate-spin" /></div>
          : errore ? <p className="p-5 text-sm text-red-600">{errore}</p>
          : filtrate.length === 0 ? (
            <div className="p-10 text-center text-sm text-slate-400"><ScrollText className="w-6 h-6 mx-auto mb-2" />Nessuna attività nel periodo.</div>
          ) : (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {filtrate.map(v => (
                <li key={v.id} className="px-5 py-3 flex flex-wrap items-start gap-x-4 gap-y-1">
                  <span className="text-xs text-slate-400 tabular-nums w-36 shrink-0 pt-0.5">{quando(v.ts)}</span>
                  <span className="text-sm font-semibold text-slate-900 dark:text-white w-40 shrink-0 truncate">{v.nome || v.username || 'Sistema'}</span>
                  <span className={cn('text-[11px] font-bold px-2 py-0.5 rounded-full shrink-0', TONI[AZIONI[v.azione]?.tono || 'grigio'])}>{etichetta(v.azione)}</span>
                  {v.dettaglio && <span className="text-sm text-slate-600 dark:text-slate-300 flex-1 min-w-[12rem]">{v.dettaglio}</span>}
                </li>
              ))}
            </ul>
          )}
      </section>
      <p className="text-xs text-slate-500">Le voci restano 24 mesi. Gli accessi (login e uscite) sono in Statistiche.</p>
    </div>
  );
}
