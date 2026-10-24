import React, { useEffect, useState } from 'react';
import { Loader2, CalendarClock, Phone, Flame, Radio, BellRing, ChevronRight, AlertTriangle, CheckCircle2, UserPlus, Plus, RefreshCw } from 'lucide-react';
import { authFetch } from '../lib/authFetch';
import { cn } from '../lib/utils';
import { useCampaign } from '../context/CampaignContext';

interface FollowupBreve {
  id: number; nome: string | null; numero: string | null; motivo: string; nota?: string | null;
  richiamare_at?: string | null; created_at: string; assegnato_nome?: string | null;
}
interface Giornata {
  ok: boolean;
  followup: { totale: number; scaduti: FollowupBreve[]; oggi: FollowupBreve[]; senzaData: FollowupBreve[]; senzaDataTotale: number; chiusiOggi: number };
  caldi: FollowupBreve[];
  daAssegnare: number;
  campagne: { id: number; voicebot_nome: string | null; operatore: string | null; tipo_campagna: string; created_at: string; in_pausa: boolean; totale: number; gestite: number; risposte: number }[];
  numeri: { chiamate: number; risposte: number; caldi: number };
}

const vai = (tab: string, miei = false) => {
  if (miei) { try { sessionStorage.setItem('gem_followups_miei', '1'); } catch { /* niente */ } window.dispatchEvent(new Event('gem:followups-miei')); }
  window.dispatchEvent(new CustomEvent('gem:nav', { detail: tab }));
};
const ora = (iso?: string | null) => (iso ? new Date(iso).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }) : '');
const giornoOra = (iso?: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  const ieri = new Date(); ieri.setDate(ieri.getDate() - 1);
  if (d.toDateString() === new Date().toDateString()) return `oggi ${ora(iso)}`;
  if (d.toDateString() === ieri.toDateString()) return `ieri ${ora(iso)}`;
  return d.toLocaleString('it-IT', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
};

function Riga({ f, destra, tono }: { f: FollowupBreve; destra?: React.ReactNode; tono?: 'rosso' | 'viola' }) {
  return (
    <li className="py-2.5 flex items-center gap-3">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold text-slate-900 dark:text-white truncate">{f.nome || f.numero || 'Contatto'}</div>
        <div className="text-xs text-slate-500 flex flex-wrap items-center gap-x-2">
          {f.numero && <a href={`tel:${f.numero}`} className="inline-flex items-center gap-1 text-brand-600 hover:underline"><Phone className="w-3 h-3" />{f.numero}</a>}
          <span>{f.motivo}</span>
          {f.nota && <span className="italic truncate max-w-[16rem]">“{f.nota}”</span>}
        </div>
      </div>
      {destra && <span className={cn('shrink-0 text-xs font-bold tabular-nums',
        tono === 'rosso' ? 'text-red-600 dark:text-red-400' : tono === 'viola' ? 'text-violet-700 dark:text-violet-300' : 'text-slate-500')}>{destra}</span>}
    </li>
  );
}

function Riquadro({ titolo, icona: Icona, conteggio, azione, children, tono }: {
  titolo: string; icona: React.ElementType; conteggio?: number; azione?: { label: string; onClick: () => void }; children: React.ReactNode; tono?: string;
}) {
  return (
    <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-soft overflow-hidden flex flex-col">
      <div className="px-5 py-3.5 border-b border-slate-100 dark:border-slate-800 flex items-center gap-2">
        <Icona className={cn('w-4 h-4', tono || 'text-brand-600')} />
        <h2 className="text-sm font-bold text-slate-900 dark:text-white flex-1">{titolo}{conteggio !== undefined && <span className="ml-1.5 text-slate-400 font-semibold tabular-nums">{conteggio}</span>}</h2>
        {azione && (
          <button onClick={azione.onClick} className="inline-flex items-center gap-0.5 text-xs font-semibold text-brand-600 dark:text-brand-400 hover:underline">
            {azione.label}<ChevronRight className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
      <div className="px-5 py-1 flex-1">{children}</div>
    </section>
  );
}

// "La mia giornata": cosa devo fare oggi, a colpo d'occhio.
export function GiornataSection() {
  const { user } = useCampaign();
  const isViewer = user?.role === 'Viewer';
  const [g, setG] = useState<Giornata | null>(null);
  const [loading, setLoading] = useState(true);
  const [errore, setErrore] = useState('');

  const carica = async () => {
    setLoading(true);
    try {
      const res = await authFetch('/api/giornata');
      const d = await res.json();
      // Senza database il server risponde ok ma senza dati.
      if (!res.ok || !d.ok || !d.followup) throw new Error();
      setG(d);
      setErrore('');
    } catch {
      setErrore('Impossibile caricare la giornata.');
    }
    setLoading(false);
  };
  useEffect(() => {
    carica();
    const t = window.setInterval(() => { if (document.visibilityState === 'visible') carica(); }, 60_000);
    return () => window.clearInterval(t);
  }, []);

  if (loading && !g) return <div className="p-10 flex justify-center text-slate-400"><Loader2 className="w-5 h-5 animate-spin" /></div>;
  if (!g) return <p className="text-sm text-red-600">{errore}</p>;

  const ore = new Date().getHours();
  const saluto = ore < 13 ? 'Buongiorno' : ore < 18 ? 'Buon pomeriggio' : 'Buonasera';
  const daFare = g.followup.scaduti.length + g.followup.oggi.length;
  const kpi = [
    { label: 'Da richiamare oggi', valore: daFare, cls: daFare ? 'text-violet-700 dark:text-violet-300' : '' },
    { label: 'Follow-up miei aperti', valore: g.followup.totale, cls: '' },
    { label: 'Clienti caldi oggi', valore: g.numeri.caldi, cls: g.numeri.caldi ? 'text-green-700 dark:text-green-400' : '' },
    { label: 'Chiamate di Wilma oggi', valore: g.numeri.chiamate, sotto: g.numeri.chiamate ? `${g.numeri.risposte} risposte` : '' },
  ];

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-300">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold text-slate-900 dark:text-white font-display">{saluto}{user?.nome ? `, ${user.nome.split(' ')[0]}` : ''}</h2>
          <p className="text-sm text-slate-500">
            {daFare > 0 ? `Oggi hai ${daFare} ${daFare === 1 ? 'contatto' : 'contatti'} da richiamare.` : 'Nessuna richiamata in programma per oggi.'}
            {g.followup.chiusiOggi > 0 && ` Ne hai già chiusi ${g.followup.chiusiOggi}.`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {!isViewer && (
            <button onClick={() => vai('campaign')} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-sm font-bold bg-brand-600 hover:bg-brand-700 text-white">
              <Plus className="w-4 h-4" /> Nuova campagna
            </button>
          )}
          <button onClick={carica} aria-label="Aggiorna" title="Aggiorna" className="p-2 rounded-xl text-slate-400 hover:text-brand-600 hover:bg-brand-50">
            <RefreshCw className={cn('w-4 h-4', loading && 'animate-spin')} />
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {kpi.map(k => (
          <div key={k.label} className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-4 shadow-soft">
            <div className={cn('text-3xl font-bold tabular-nums text-slate-900 dark:text-white', k.cls)}>{k.valore}</div>
            <div className="text-xs font-semibold text-slate-500 mt-1">{k.label}</div>
            {k.sotto && <div className="text-[11px] text-slate-400">{k.sotto}</div>}
          </div>
        ))}
      </div>

      {g.daAssegnare > 0 && !isViewer && (
        <button onClick={() => vai('followups')} className="w-full flex items-center gap-3 p-4 rounded-2xl border border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-900/10 text-left">
          <UserPlus className="w-5 h-5 text-amber-600 shrink-0" />
          <span className="flex-1 text-sm text-amber-900 dark:text-amber-200"><strong>{g.daAssegnare} follow-up</strong> non sono assegnati a nessuno.</span>
          <span className="text-xs font-bold text-amber-800 dark:text-amber-300 inline-flex items-center">Assegnali<ChevronRight className="w-3.5 h-3.5" /></span>
        </button>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Riquadro titolo="Da richiamare" icona={CalendarClock} conteggio={daFare} tono="text-violet-600" azione={{ label: 'I miei follow-up', onClick: () => vai('followups', true) }}>
          {daFare === 0 ? (
            <p className="py-6 text-sm text-slate-500 text-center">Niente in programma oggi. Nei follow-up puoi impostare "Richiamare il".</p>
          ) : (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {g.followup.scaduti.map(f => <Riga key={f.id} f={f} destra={<span className="inline-flex items-center gap-1"><AlertTriangle className="w-3.5 h-3.5" />{giornoOra(f.richiamare_at)}</span>} tono="rosso" />)}
              {g.followup.oggi.map(f => <Riga key={f.id} f={f} destra={ora(f.richiamare_at)} tono="viola" />)}
            </ul>
          )}
        </Riquadro>

        <Riquadro titolo="Clienti caldi di oggi" icona={Flame} conteggio={g.caldi.length} tono="text-orange-500" azione={{ label: 'Follow-up', onClick: () => vai('followups') }}>
          {g.caldi.length === 0 ? (
            <p className="py-6 text-sm text-slate-500 text-center">Nessun interessato o appuntamento oggi, per ora.</p>
          ) : (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {g.caldi.map(f => <Riga key={f.id} f={f} destra={f.assegnato_nome ? `→ ${f.assegnato_nome}` : <span className="text-amber-600">da assegnare</span>} />)}
            </ul>
          )}
        </Riquadro>

        <Riquadro titolo="Campagne in corso" icona={Radio} conteggio={g.campagne.length} tono="text-green-600" azione={{ label: 'In diretta', onClick: () => vai('live') }}>
          {g.campagne.length === 0 ? (
            <p className="py-6 text-sm text-slate-500 text-center">Nessuna campagna in corso.</p>
          ) : (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {g.campagne.map(c => (
                <li key={c.id} className="py-3">
                  <div className="flex items-center justify-between gap-2 text-sm">
                    <span className="font-semibold text-slate-900 dark:text-white truncate">{c.voicebot_nome || 'Campagna'}</span>
                    <span className="text-xs text-slate-500 tabular-nums">{c.gestite}/{c.totale}{c.in_pausa && <span className="ml-2 font-bold text-amber-600">in pausa</span>}</span>
                  </div>
                  <div className="mt-1.5 h-1.5 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
                    <div className="h-full bg-green-500 rounded-full" style={{ width: `${c.totale ? Math.round((c.gestite / c.totale) * 100) : 0}%` }} />
                  </div>
                  <div className="text-[11px] text-slate-400 mt-1">{c.operatore || '—'} · {c.risposte} risposte</div>
                </li>
              ))}
            </ul>
          )}
        </Riquadro>

        <Riquadro titolo="Miei follow-up senza data" icona={BellRing} conteggio={g.followup.senzaDataTotale} azione={{ label: 'Vedi tutti', onClick: () => vai('followups', true) }}>
          {g.followup.senzaDataTotale === 0 ? (
            <p className="py-6 text-sm text-slate-500 text-center inline-flex items-center gap-2 w-full justify-center"><CheckCircle2 className="w-4 h-4 text-green-600" />Tutti i tuoi follow-up hanno una data, o non ne hai.</p>
          ) : (
            <>
              <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                {g.followup.senzaData.map(f => <Riga key={f.id} f={f} destra={new Date(f.created_at).toLocaleDateString('it-IT', { day: 'numeric', month: 'short' })} />)}
              </ul>
              {g.followup.senzaDataTotale > g.followup.senzaData.length && (
                <p className="py-2 text-xs text-slate-400">e altri {g.followup.senzaDataTotale - g.followup.senzaData.length}</p>
              )}
            </>
          )}
        </Riquadro>
      </div>
    </div>
  );
}
