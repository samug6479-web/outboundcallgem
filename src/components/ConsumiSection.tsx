import React, { useEffect, useState } from 'react';
import { Loader2, Download, Gauge, Info } from 'lucide-react';
import * as XLSX from 'xlsx';
import { authFetch } from '../lib/authFetch';
import { cn } from '../lib/utils';

interface Somma { partite: number; risposte: number; minuti: number; minutiFatturabili: number }
interface Riga extends Somma { chiave: string }
interface Campagna extends Somma { id: number; creata: string; operatore: string | null; voicebot: string; tipo: string }
interface Consumi {
  ok: boolean; mese: string; mesi: string[];
  totale: Somma; perVoicebot: Riga[]; perOperatore: Riga[]; perGiorno: Riga[]; campagne: Campagna[];
  altre: { chiamate: number; risposte: number; minuti: number };
}

const nomeMese = (m: string) => {
  const [a, mm] = m.split('-').map(Number);
  return new Date(a, mm - 1, 1).toLocaleDateString('it-IT', { month: 'long', year: 'numeric' });
};
const min = (n: number) => n.toLocaleString('it-IT', { maximumFractionDigits: 1 });
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);

function Tabella({ titolo, righe, etichetta }: { titolo: string; righe: Riga[]; etichetta: string }) {
  return (
    <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-soft p-5">
      <h3 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3">{titolo}</h3>
      {righe.length === 0 ? <p className="text-sm text-slate-400">Nessun dato.</p> : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs text-slate-500">
              <tr><th className="text-left py-1.5">{etichetta}</th><th className="text-right">Chiamate</th><th className="text-right">Risposte</th><th className="text-right">Minuti</th><th className="text-right">Fatturabili</th></tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800 text-slate-700 dark:text-slate-300 tabular-nums">
              {righe.map(r => (
                <tr key={r.chiave}>
                  <td className="py-1.5 pr-2">{r.chiave}</td>
                  <td className="text-right">{r.partite}</td>
                  <td className="text-right">{r.risposte} <span className="text-xs text-slate-400">({pct(r.risposte, r.partite)}%)</span></td>
                  <td className="text-right">{min(r.minuti)}</td>
                  <td className="text-right font-semibold text-slate-900 dark:text-white">{r.minutiFatturabili}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// Consumi del mese per la fatturazione: chiamate e minuti delle campagne del sito.
export function ConsumiSection() {
  const [mese, setMese] = useState('');
  const [d, setD] = useState<Consumi | null>(null);
  const [loading, setLoading] = useState(true);
  const [errore, setErrore] = useState('');

  useEffect(() => {
    setLoading(true);
    authFetch(`/api/consumi${mese ? `?mese=${mese}` : ''}`).then(r => r.json())
      .then(x => { if (x?.ok) { setD(x); setErrore(''); } else setErrore(x?.error || 'Errore'); })
      .catch(() => setErrore('Errore di rete'))
      .finally(() => setLoading(false));
  }, [mese]);

  const esporta = () => {
    if (!d) return;
    const wb = XLSX.utils.book_new();
    const foglio = (nome: string, righe: any[], larghezze: number[]) => {
      const ws = XLSX.utils.json_to_sheet(righe.length ? righe : [{ Nota: 'Nessun dato' }]);
      ws['!cols'] = larghezze.map(wch => ({ wch }));
      XLSX.utils.book_append_sheet(wb, ws, nome);
    };
    const r = (x: Somma) => ({ 'Chiamate partite': x.partite, Risposte: x.risposte, 'Minuti di conversazione': Math.round(x.minuti * 10) / 10, 'Minuti fatturabili': x.minutiFatturabili });
    foglio('Riepilogo', [{ Mese: nomeMese(d.mese), ...r(d.totale) }, { Mese: 'Altre chiamate del voicebot (fuori dalle campagne del sito)', 'Chiamate partite': d.altre.chiamate, Risposte: d.altre.risposte, 'Minuti di conversazione': Math.round(d.altre.minuti * 10) / 10 }], [52, 16, 10, 22, 18]);
    foglio('Per campagna', d.campagne.map(c => ({ Campagna: c.id, Creata: new Date(c.creata).toLocaleString('it-IT'), Voicebot: c.voicebot, Operatore: c.operatore || '', Tipo: c.tipo, ...r(c) })), [10, 18, 26, 18, 14, 16, 10, 22, 18]);
    foglio('Per voicebot', d.perVoicebot.map(x => ({ Voicebot: x.chiave, ...r(x) })), [28, 16, 10, 22, 18]);
    foglio('Per operatore', d.perOperatore.map(x => ({ Operatore: x.chiave, ...r(x) })), [24, 16, 10, 22, 18]);
    foglio('Per giorno', d.perGiorno.map(x => ({ Giorno: x.chiave, ...r(x) })), [12, 16, 10, 22, 18]);
    XLSX.writeFile(wb, `consumi-${d.mese}.xlsx`);
  };

  if (loading && !d) return <div className="p-10 flex justify-center text-slate-400"><Loader2 className="w-5 h-5 animate-spin" /></div>;
  if (!d) return <p className="text-sm text-red-600">{errore}</p>;

  const maxGiorno = Math.max(1, ...d.perGiorno.map(g => g.minutiFatturabili));
  const kpi = [
    { label: 'Chiamate partite', valore: d.totale.partite.toLocaleString('it-IT') },
    { label: 'Risposte', valore: `${d.totale.risposte.toLocaleString('it-IT')}`, sotto: `${pct(d.totale.risposte, d.totale.partite)}% delle chiamate` },
    { label: 'Minuti di conversazione', valore: min(d.totale.minuti) },
    { label: 'Minuti fatturabili', valore: d.totale.minutiFatturabili.toLocaleString('it-IT'), sotto: 'ogni chiamata arrotondata al minuto', forte: true },
  ];

  return (
    <div className={cn('space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-300', loading && 'opacity-60')}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Gauge className="w-5 h-5 text-brand-600" />
          <select value={d.mese} onChange={e => setMese(e.target.value)} aria-label="Mese"
            className="px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm font-semibold text-slate-900 dark:text-white capitalize">
            {d.mesi.map(m => <option key={m} value={m}>{nomeMese(m)}</option>)}
          </select>
        </div>
        <button onClick={esporta} className="inline-flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-semibold border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800">
          <Download className="w-4 h-4" /> Esporta Excel
        </button>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {kpi.map(k => (
          <div key={k.label} className={cn('rounded-2xl p-4 shadow-soft border', k.forte ? 'bg-brand-600 border-brand-600 text-white' : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800')}>
            <div className={cn('text-3xl font-bold tabular-nums', k.forte ? 'text-white' : 'text-slate-900 dark:text-white')}>{k.valore}</div>
            <div className={cn('text-xs font-semibold mt-1', k.forte ? 'text-white/80' : 'text-slate-500')}>{k.label}</div>
            {k.sotto && <div className={cn('text-[11px]', k.forte ? 'text-white/70' : 'text-slate-400')}>{k.sotto}</div>}
          </div>
        ))}
      </div>

      <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-soft p-5">
        <h3 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3">Minuti fatturabili per giorno</h3>
        {d.perGiorno.length === 0 ? <p className="text-sm text-slate-400">Nessuna chiamata nel mese.</p> : (
          <div className="flex items-end gap-1 h-36" role="img" aria-label="Minuti fatturabili per giorno">
            {d.perGiorno.map(g => (
              <div key={g.chiave} className="flex-1 min-w-[6px] flex flex-col items-center justify-end h-full group relative">
                <div className="w-full bg-brand-500 rounded-t" style={{ height: `${Math.max(2, (g.minutiFatturabili / maxGiorno) * 100)}%` }} title={`${g.chiave}: ${g.minutiFatturabili} min, ${g.partite} chiamate`} />
                <span className="text-[9px] text-slate-400 mt-1 tabular-nums">{Number(g.chiave.slice(8))}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Tabella titolo="Per voicebot" righe={d.perVoicebot} etichetta="Voicebot" />
        <Tabella titolo="Per operatore" righe={d.perOperatore} etichetta="Operatore" />
      </div>

      <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-soft p-5">
        <h3 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3">Per campagna <span className="text-slate-400">{d.campagne.length}</span></h3>
        {d.campagne.length === 0 ? <p className="text-sm text-slate-400">Nessuna campagna nel mese.</p> : (
          <div className="overflow-x-auto max-h-96">
            <table className="w-full text-sm">
              <thead className="text-xs text-slate-500 sticky top-0 bg-white dark:bg-slate-900">
                <tr><th className="text-left py-1.5">Creata</th><th className="text-left">Voicebot</th><th className="text-left">Operatore</th><th className="text-right">Chiamate</th><th className="text-right">Risposte</th><th className="text-right">Minuti</th><th className="text-right">Fatturabili</th></tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800 text-slate-700 dark:text-slate-300 tabular-nums">
                {d.campagne.map(c => (
                  <tr key={c.id}>
                    <td className="py-1.5 whitespace-nowrap">{new Date(c.creata).toLocaleString('it-IT', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</td>
                    <td className="pr-2">{c.voicebot}</td>
                    <td className="pr-2">{c.operatore || '—'}</td>
                    <td className="text-right">{c.partite}</td>
                    <td className="text-right">{c.risposte}</td>
                    <td className="text-right">{min(c.minuti)}</td>
                    <td className="text-right font-semibold text-slate-900 dark:text-white">{c.minutiFatturabili}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <p className="flex items-start gap-2 text-xs text-slate-500">
        <Info className="w-4 h-4 shrink-0 mt-0.5" />
        <span>
          Contano le chiamate delle campagne lanciate dal sito, nel mese in cui sono state fatte. "Minuti" è il tempo di conversazione reale;
          "fatturabili" arrotonda ogni chiamata risposta al minuto superiore.
          {d.altre.chiamate > 0 && ` Fuori dalle campagne del sito (prove, appuntamenti lanciati altrove) il voicebot ha fatto altre ${d.altre.chiamate} chiamate, ${min(d.altre.minuti)} minuti: sono nell'Excel.`}
        </span>
      </p>
    </div>
  );
}
