import React, { useEffect, useState } from 'react';
import { Clock, Plus, Trash2, Loader2, CheckCircle2, AlertTriangle, Info } from 'lucide-react';
import { authFetch } from '../lib/authFetch';
import { cn } from '../lib/utils';
import { useCampaign } from '../context/CampaignContext';
import { PrivacySection } from './PrivacySection';
import { GIORNI, OrariConsentiti, descriviOrari, dentroOrari, prossimaApertura, quandoBreve } from '../lib/orari';

const PREDEFINITI: OrariConsentiti = { attivo: false, giorni: [1, 2, 3, 4, 5], fasce: [{ da: '09:00', a: '13:00' }, { da: '14:30', a: '18:30' }] };

// Impostazioni dell'app (solo Admin): orari in cui le campagne possono chiamare.
export function ImpostazioniSection() {
  const { appConfig, reloadConfig } = useCampaign();
  const [orari, setOrari] = useState<OrariConsentiti>(PREDEFINITI);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ tipo: 'ok' | 'err'; testo: string } | null>(null);

  useEffect(() => {
    authFetch('/api/impostazioni/orari')
      .then(r => r.json())
      .then(d => { if (d?.ok && d.orari) setOrari({ ...PREDEFINITI, ...d.orari, fasce: d.orari.fasce?.length ? d.orari.fasce : PREDEFINITI.fasce }); })
      .catch(() => setMsg({ tipo: 'err', testo: 'Impossibile leggere gli orari.' }))
      .finally(() => setLoading(false));
  }, []);

  const cambiaFascia = (i: number, campo: 'da' | 'a', v: string) =>
    setOrari(o => ({ ...o, fasce: o.fasce.map((f, j) => (j === i ? { ...f, [campo]: v } : f)) }));

  const errore = (() => {
    if (!orari.attivo) return '';
    if (orari.giorni.length === 0) return 'Scegli almeno un giorno.';
    if (orari.fasce.length === 0) return 'Aggiungi almeno una fascia oraria.';
    if (orari.fasce.some(f => !f.da || !f.a || f.a <= f.da)) return "In ogni fascia l'inizio deve essere prima della fine.";
    return '';
  })();

  const salva = async () => {
    if (errore) return;
    setSaving(true);
    setMsg(null);
    try {
      const res = await authFetch('/api/impostazioni/orari', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(orari),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || `Errore HTTP ${res.status}`);
      setOrari(data.orari);
      reloadConfig();
      setMsg({ tipo: 'ok', testo: data.orari.attivo ? `Salvato. Le campagne chiamano solo: ${data.descrizione}.` : 'Salvato. Le campagne possono chiamare a qualsiasi ora.' });
    } catch (e: any) {
      setMsg({ tipo: 'err', testo: e?.message || 'Errore di rete' });
    }
    setSaving(false);
  };

  if (loading) return <div className="p-10 flex justify-center text-slate-400"><Loader2 className="w-5 h-5 animate-spin" /></div>;

  const aperto = dentroOrari(orari);
  const ap = prossimaApertura(orari);

  return (
    <div className="space-y-6 max-w-2xl animate-in fade-in slide-in-from-bottom-4 duration-300">
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-soft overflow-hidden">
        <div className="p-5 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/30 flex items-center gap-3">
          <Clock className="w-5 h-5 text-brand-600" />
          <div className="flex-1">
            <h2 className="text-base font-bold text-slate-900 dark:text-white font-display">Orari consentiti</h2>
            <p className="text-xs text-slate-500">Quando le campagne possono chiamare (ora italiana).</p>
          </div>
          <button type="button" role="switch" aria-checked={orari.attivo} aria-label="Attiva orari consentiti"
            onClick={() => setOrari(o => ({ ...o, attivo: !o.attivo }))}
            className={cn('relative w-11 h-6 rounded-full transition-colors shrink-0', orari.attivo ? 'bg-brand-600' : 'bg-slate-300 dark:bg-slate-600')}>
            <span className={cn('absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform', orari.attivo ? 'translate-x-5' : 'translate-x-0')} />
          </button>
        </div>

        <div className={cn('p-5 space-y-5', !orari.attivo && 'opacity-50 pointer-events-none')} aria-disabled={!orari.attivo}>
          <div>
            <div className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Giorni</div>
            <div className="flex flex-wrap gap-1.5">
              {GIORNI.map(g => {
                const on = orari.giorni.includes(g.d);
                return (
                  <button key={g.d} type="button" aria-pressed={on} title={g.nome}
                    onClick={() => setOrari(o => ({ ...o, giorni: on ? o.giorni.filter(x => x !== g.d) : [...o.giorni, g.d] }))}
                    className={cn('w-10 h-10 rounded-xl text-sm font-bold transition-colors',
                      on ? 'bg-brand-600 text-white' : 'bg-slate-100 dark:bg-slate-800 text-slate-500 hover:bg-slate-200 dark:hover:bg-slate-700')}>
                    {g.breve}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <div className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Fasce orarie</div>
            <div className="space-y-2">
              {orari.fasce.map((f, i) => (
                <div key={i} className="flex items-center gap-2">
                  <span className="text-sm text-slate-500 w-8">dalle</span>
                  <input type="time" value={f.da} onChange={e => cambiaFascia(i, 'da', e.target.value)} aria-label={`Fascia ${i + 1}: inizio`}
                    className="px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-brand-500" />
                  <span className="text-sm text-slate-500">alle</span>
                  <input type="time" value={f.a} onChange={e => cambiaFascia(i, 'a', e.target.value)} aria-label={`Fascia ${i + 1}: fine`}
                    className="px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-brand-500" />
                  {orari.fasce.length > 1 && (
                    <button type="button" onClick={() => setOrari(o => ({ ...o, fasce: o.fasce.filter((_, j) => j !== i) }))} aria-label={`Togli fascia ${i + 1}`}
                      className="p-2 rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40">
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                </div>
              ))}
              {orari.fasce.length < 4 && (
                <button type="button" onClick={() => setOrari(o => ({ ...o, fasce: [...o.fasce, { da: '15:00', a: '18:00' }] }))}
                  className="inline-flex items-center gap-1.5 text-sm font-semibold text-brand-600 dark:text-brand-400 hover:underline">
                  <Plus className="w-4 h-4" /> Aggiungi fascia
                </button>
              )}
            </div>
          </div>
        </div>

        <div className="px-5 py-4 border-t border-slate-200 dark:border-slate-800 flex flex-wrap items-center gap-3">
          <p className="text-sm text-slate-600 dark:text-slate-300 flex-1 min-w-[12rem]">
            {orari.attivo
              ? <>{descriviOrari(orari)}. Adesso: <strong>{aperto ? 'si può chiamare' : `chiuso${ap ? `, riapre ${quandoBreve(ap)}` : ''}`}</strong>.</>
              : 'Spenti: le campagne chiamano a qualsiasi ora.'}
          </p>
          <button onClick={salva} disabled={saving || !!errore}
            className="px-4 py-2 rounded-xl text-sm font-bold bg-brand-600 hover:bg-brand-700 text-white disabled:opacity-50 inline-flex items-center gap-2">
            {saving && <Loader2 className="w-4 h-4 animate-spin" />} Salva
          </button>
        </div>
        {(errore || msg) && (
          <div className={cn('mx-5 mb-5 flex items-start gap-2 p-3 rounded-xl border text-sm',
            errore || msg?.tipo === 'err' ? 'border-red-200 bg-red-50 text-red-700 dark:border-red-900/50 dark:bg-red-900/10 dark:text-red-300'
              : 'border-green-200 bg-green-50 text-green-800 dark:border-green-900/50 dark:bg-green-900/10 dark:text-green-300')}>
            {errore || msg?.tipo === 'err' ? <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /> : <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />}
            <span>{errore || msg?.testo}</span>
          </div>
        )}
      </div>

      <div className="flex items-start gap-3 p-4 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-sm text-slate-600 dark:text-slate-300">
        <Info className="w-4 h-4 mt-0.5 shrink-0 text-brand-600" />
        <div className="space-y-1.5">
          <p>Fuori orario le campagne non si bloccano: le chiamate restano in coda e ripartono da sole all'apertura, anche il giorno dopo. Lo stesso vale per le richiamate dei non raggiunti.</p>
          <p>Una campagna lanciata fuori orario parte alla prima apertura. La chiamata di prova singola non ha limiti di orario.</p>
          {!appConfig.codaSito && <p className="text-amber-700 dark:text-amber-400">In questo ambiente le chiamate sono simulate: gli orari valgono solo per gli avvisi.</p>}
        </div>
      </div>

      <PrivacySection />
    </div>
  );
}
