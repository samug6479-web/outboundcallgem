import React, { useEffect, useState } from 'react';
import { ShieldCheck, Search, Download, Trash2, Loader2, CheckCircle2, AlertTriangle } from 'lucide-react';
import { authFetch } from '../lib/authFetch';
import { cn } from '../lib/utils';
import { ConfirmModal } from './ConfirmModal';

const ETICHETTA_MESI: Record<number, string> = { 0: 'Mai (conserva tutto)', 3: 'Dopo 3 mesi', 6: 'Dopo 6 mesi', 12: 'Dopo 12 mesi', 24: 'Dopo 24 mesi' };

interface Riepilogo { nome: string | null; chiamate: number; followup: number; datiWilma: number; campagne: number; listeEStorico: number; nonChiamare: boolean }

// Privacy (solo Admin): quanto tenere i dati delle chiamate e richieste di
// accesso o cancellazione di una persona.
export function PrivacySection() {
  const [mesi, setMesi] = useState<number | null>(null);
  const [opzioni, setOpzioni] = useState<number[]>([0, 3, 6, 12, 24]);
  const [salvando, setSalvando] = useState(false);
  const [msgCons, setMsgCons] = useState<{ tipo: 'ok' | 'err'; testo: string } | null>(null);

  const [numero, setNumero] = useState('');
  const [cercando, setCercando] = useState(false);
  const [trovato, setTrovato] = useState<{ numero: string; riepilogo: Riepilogo; dati: any } | null>(null);
  const [msgNum, setMsgNum] = useState<{ tipo: 'ok' | 'err'; testo: string } | null>(null);
  const [conferma, setConferma] = useState(false);
  const [nonChiamare, setNonChiamare] = useState(true);

  useEffect(() => {
    authFetch('/api/impostazioni/privacy').then(r => r.json())
      .then(d => { if (d.ok) { setMesi(d.mesi); setOpzioni(d.opzioni); } })
      .catch(() => setMsgCons({ tipo: 'err', testo: 'Impossibile leggere le impostazioni.' }));
  }, []);

  const salvaConservazione = async (m: number) => {
    setSalvando(true); setMsgCons(null);
    try {
      const r = await authFetch('/api/impostazioni/privacy', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mesi: m }) });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error || 'Errore');
      setMesi(d.mesi);
      const c = d.cancellati;
      const tot = c ? Object.values(c as Record<string, number>).reduce((a, b) => a + b, 0) : 0;
      setMsgCons({ tipo: 'ok', testo: d.mesi ? `Salvato. ${tot ? `Cancellati subito ${tot} dati più vecchi di ${d.mesi} mesi.` : 'Nessun dato da cancellare adesso.'} Il controllo si ripete da solo.` : 'Salvato: i dati restano finché non li cancelli.' });
    } catch (e: any) { setMsgCons({ tipo: 'err', testo: e?.message || 'Errore di rete' }); }
    setSalvando(false);
  };

  const cerca = async () => {
    setCercando(true); setMsgNum(null); setTrovato(null);
    try {
      const r = await authFetch(`/api/privacy/numero?numero=${encodeURIComponent(numero.trim())}`);
      const d = await r.json();
      if (!d.ok) throw new Error(d.error || 'Errore');
      setTrovato(d);
    } catch (e: any) { setMsgNum({ tipo: 'err', testo: e?.message || 'Errore di rete' }); }
    setCercando(false);
  };

  const scarica = () => {
    if (!trovato) return;
    const blob = new Blob([JSON.stringify({ numero: trovato.numero, esportatoIl: new Date().toISOString(), ...trovato.dati }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `dati-${trovato.numero.replace(/\D/g, '')}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const cancella = async () => {
    if (!trovato) return;
    setConferma(false); setMsgNum(null);
    try {
      const r = await authFetch('/api/privacy/cancella-numero', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ numero: trovato.numero, nonChiamare }) });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error || 'Errore');
      const c = d.cancellati;
      setMsgNum({ tipo: 'ok', testo: `Cancellati i dati di ${trovato.numero}: ${c.chiamate} chiamate, ${c.followup} follow-up, ${c.datiWilma} schede di Wilma, ${c.liste} liste.${d.nonChiamare ? ' Il numero è in Non chiamare.' : ''}` });
      setTrovato(null); setNumero('');
    } catch (e: any) { setMsgNum({ tipo: 'err', testo: e?.message || 'Errore di rete' }); }
  };

  const Avviso = ({ m }: { m: { tipo: 'ok' | 'err'; testo: string } }) => (
    <div className={cn('flex items-start gap-2 p-3 rounded-xl border text-sm',
      m.tipo === 'err' ? 'border-red-200 bg-red-50 text-red-700 dark:border-red-900/50 dark:bg-red-900/10 dark:text-red-300'
        : 'border-green-200 bg-green-50 text-green-800 dark:border-green-900/50 dark:bg-green-900/10 dark:text-green-300')}>
      {m.tipo === 'err' ? <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /> : <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />}
      <span>{m.testo}</span>
    </div>
  );

  const r = trovato?.riepilogo;
  const vuoto = r && !r.chiamate && !r.followup && !r.datiWilma && !r.campagne && !r.listeEStorico && !r.nome;

  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-soft overflow-hidden">
      <div className="p-5 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/30 flex items-center gap-3">
        <ShieldCheck className="w-5 h-5 text-brand-600" />
        <div>
          <h2 className="text-base font-bold text-slate-900 dark:text-white font-display">Privacy</h2>
          <p className="text-xs text-slate-500">Quanto tenere i dati delle chiamate e richieste delle persone chiamate.</p>
        </div>
      </div>

      <div className="p-5 space-y-3 border-b border-slate-200 dark:border-slate-800">
        <label htmlFor="cons-mesi" className="block text-sm font-semibold text-slate-900 dark:text-white">Cancella da solo trascrizioni, riassunti e dati raccolti da Wilma</label>
        <div className="flex flex-wrap items-center gap-3">
          <select id="cons-mesi" value={mesi ?? 0} disabled={mesi === null || salvando} onChange={e => salvaConservazione(parseInt(e.target.value, 10))}
            className="px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-sm font-semibold text-slate-900 dark:text-white">
            {opzioni.map(m => <option key={m} value={m}>{ETICHETTA_MESI[m] || `Dopo ${m} mesi`}</option>)}
          </select>
          {salvando && <Loader2 className="w-4 h-4 animate-spin text-slate-400" />}
        </div>
        <p className="text-xs text-slate-500">
          Con un periodo scelto, i dati più vecchi si cancellano da soli: trascrizioni e riassunti, schede raccolte da Wilma, follow-up chiusi e liste di contatti delle campagne passate.
          Restano i numeri delle statistiche e dei consumi, e la lista Non chiamare.
        </p>
        {msgCons && <Avviso m={msgCons} />}
      </div>

      <div className="p-5 space-y-3">
        <label htmlFor="priv-num" className="block text-sm font-semibold text-slate-900 dark:text-white">Una persona chiede i suoi dati o di cancellarli</label>
        <div className="flex gap-2">
          <input id="priv-num" value={numero} onChange={e => setNumero(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && numero.trim()) cerca(); }}
            placeholder="Numero di telefono, es. 3331234567" inputMode="tel"
            className="flex-1 min-w-0 px-3 py-2 text-sm rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-white" />
          <button onClick={cerca} disabled={!numero.trim() || cercando}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold bg-slate-900 dark:bg-white text-white dark:text-slate-900 disabled:opacity-50">
            {cercando ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />} Cerca
          </button>
        </div>
        {trovato && r && (
          <div className="rounded-xl border border-slate-200 dark:border-slate-700 p-4 space-y-3">
            <div className="text-sm text-slate-700 dark:text-slate-200">
              <strong>{trovato.numero}</strong>{r.nome ? ` · ${r.nome}` : ''}
              {vuoto ? <p className="text-slate-500 mt-1">Nessun dato su questo numero.</p> : (
                <ul className="mt-2 grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1 text-xs text-slate-600 dark:text-slate-300">
                  <li>{r.chiamate} chiamate con esito</li>
                  <li>{r.followup} follow-up</li>
                  <li>{r.datiWilma} schede di Wilma</li>
                  <li>{r.campagne} chiamate in campagne</li>
                  <li>{r.listeEStorico} liste e storico</li>
                  <li>{r.nonChiamare ? 'In Non chiamare' : 'Non è in Non chiamare'}</li>
                </ul>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              <button onClick={scarica} className="inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-semibold border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800">
                <Download className="w-4 h-4" /> Scarica i suoi dati
              </button>
              {!vuoto && (
                <button onClick={() => setConferma(true)} className="inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-semibold text-red-700 border border-red-200 hover:bg-red-50 dark:text-red-300 dark:border-red-900/50 dark:hover:bg-red-900/20">
                  <Trash2 className="w-4 h-4" /> Cancella i suoi dati
                </button>
              )}
            </div>
            {!vuoto && (
              <label className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
                <input type="checkbox" checked={nonChiamare} onChange={e => setNonChiamare(e.target.checked)} />
                Dopo la cancellazione metti il numero in Non chiamare (consigliato: è l'unico dato che resta, per non richiamarlo)
              </label>
            )}
          </div>
        )}
        {msgNum && <Avviso m={msgNum} />}
        <p className="text-xs text-slate-500">"Scarica i suoi dati" crea un file con chiamate, riassunti, follow-up e dati raccolti da Wilma, da mandare alla persona. Ogni ricerca e cancellazione resta nel Registro attività.</p>
      </div>

      <ConfirmModal
        open={conferma}
        title={`Cancellare i dati di ${trovato?.numero}?`}
        message="Chiamate, riassunti, trascrizioni, follow-up, schede di Wilma e presenza nelle liste vengono tolti per sempre. Le statistiche restano, senza il numero."
        confirmLabel="Cancella"
        onConfirm={cancella}
        onCancel={() => setConferma(false)}
      />
    </div>
  );
}
