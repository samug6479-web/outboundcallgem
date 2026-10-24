import React, { useEffect, useState } from 'react';
import { Building2, Plus, Pencil, Trash2, Loader2, X, Users, Bot, ArrowRight, CheckCircle2, AlertCircle, PauseCircle } from 'lucide-react';
import { cn } from '../lib/utils';
import { authFetch, aziendaVista, CHIAVE_AZIENDA_VISTA } from '../lib/authFetch';
import { useCampaign } from '../context/CampaignContext';
import { ConfirmModal } from './ConfirmModal';

interface Azienda {
  id: string;
  nome: string;
  attiva: boolean;
  principale: boolean;
  webhookChiamate?: string;
  webhookAppuntamenti?: string;
  creataAt?: string;
  utenti: number;
  admin: number;
  voicebot: number;
}

const campo = 'w-full px-3 py-2 text-sm bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-lg focus:outline-none focus:border-brand-500 dark:text-white';
const etichetta = 'block text-xs font-bold text-slate-500 uppercase tracking-wider mb-1';

// Apre i dati di un'azienda (solo super-admin): il sito si ricarica con quella vista.
export function apriAzienda(id: string, propria: string | undefined, tab?: string) {
  if (!id || id === propria) sessionStorage.removeItem(CHIAVE_AZIENDA_VISTA);
  else sessionStorage.setItem(CHIAVE_AZIENDA_VISTA, id);
  if (tab) sessionStorage.setItem('gem_active_tab', tab);
  window.location.reload();
}

// Aziende clienti (solo Admin di GEM): ognuna ha utenti, voicebot e dati separati.
export function AziendeSection() {
  const { user } = useCampaign();
  const [aziende, setAziende] = useState<Azienda[]>([]);
  const [loading, setLoading] = useState(true);
  const [modulo, setModulo] = useState<{ id?: string; nome: string; attiva: boolean; webhookChiamate: string; webhookAppuntamenti: string } | null>(null);
  const [salvando, setSalvando] = useState(false);
  const [errore, setErrore] = useState('');
  const [avviso, setAvviso] = useState<{ tipo: 'ok' | 'err'; testo: string } | null>(null);
  const [daEliminare, setDaEliminare] = useState<Azienda | null>(null);
  const vista = aziendaVista() || user?.azienda;

  const carica = async () => {
    try {
      const r = await authFetch('/api/aziende');
      const d = await r.json();
      if (d.ok) setAziende(d.aziende);
    } catch { /* riprova */ }
    setLoading(false);
  };
  useEffect(() => { carica(); }, []);

  const mostra = (tipo: 'ok' | 'err', testo: string) => { setAvviso({ tipo, testo }); window.setTimeout(() => setAvviso(null), 5000); };

  const salva = async () => {
    if (!modulo) return;
    if (!modulo.nome.trim()) return setErrore("Scrivi il nome dell'azienda");
    setSalvando(true); setErrore('');
    try {
      const r = await authFetch(modulo.id ? `/api/aziende/${modulo.id}` : '/api/aziende', {
        method: modulo.id ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nome: modulo.nome, attiva: modulo.attiva, webhookChiamate: modulo.webhookChiamate, webhookAppuntamenti: modulo.webhookAppuntamenti }),
      });
      const d = await r.json();
      if (!d.ok) { setErrore(d.error || 'Errore'); setSalvando(false); return; }
      mostra('ok', modulo.id ? 'Azienda aggiornata' : `Azienda "${d.azienda.nome}" creata: aprila e crea il suo primo Admin in Gestione Utenti.`);
      setModulo(null);
      carica();
    } catch { setErrore('Errore di rete'); }
    setSalvando(false);
  };

  const elimina = async (a: Azienda) => {
    setDaEliminare(null);
    try {
      const r = await authFetch(`/api/aziende/${a.id}`, { method: 'DELETE' });
      const d = await r.json();
      if (d.ok) { mostra('ok', `Azienda "${a.nome}" eliminata`); carica(); }
      else mostra('err', d.error || 'Errore');
    } catch { mostra('err', 'Errore di rete'); }
  };

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-300">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-slate-500 max-w-2xl">
          Ogni azienda vede solo i suoi utenti, voicebot, campagne, esiti, follow-up, liste e numeri "Non chiamare".
          Per configurarla, aprila: il sito mostra i suoi dati finché non torni a GEM Group.
        </p>
        <button onClick={() => { setErrore(''); setModulo({ nome: '', attiva: true, webhookChiamate: '', webhookAppuntamenti: '' }); }}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold bg-brand-600 hover:bg-brand-700 text-white">
          <Plus className="w-4 h-4" /> Nuova azienda
        </button>
      </div>

      {avviso && (
        <div className={cn('flex items-center gap-2 p-3 rounded-xl text-sm', avviso.tipo === 'ok' ? 'bg-green-50 text-green-800 dark:bg-green-900/20 dark:text-green-300' : 'bg-red-50 text-red-800 dark:bg-red-900/20 dark:text-red-300')}>
          {avviso.tipo === 'ok' ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <AlertCircle className="w-4 h-4 shrink-0" />}
          {avviso.testo}
        </div>
      )}

      {loading ? (
        <div className="p-10 flex justify-center text-slate-400"><Loader2 className="w-5 h-5 animate-spin" /></div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {aziende.map(a => (
            <div key={a.id} className={cn('bg-white dark:bg-slate-900 border rounded-2xl shadow-soft p-5 flex flex-col',
              a.id === vista ? 'border-brand-400 ring-1 ring-brand-300 dark:ring-brand-500/40' : 'border-slate-200 dark:border-slate-800')}>
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-10 h-10 rounded-xl bg-brand-50 dark:bg-brand-500/15 flex items-center justify-center shrink-0">
                    <Building2 className="w-5 h-5 text-brand-600 dark:text-brand-300" />
                  </div>
                  <div className="min-w-0">
                    <div className="font-semibold text-slate-900 dark:text-white truncate">{a.nome}</div>
                    <div className="text-xs text-slate-400 font-mono">{a.id}</div>
                  </div>
                </div>
                {a.principale ? <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-brand-100 text-brand-700 dark:bg-brand-500/20 dark:text-brand-200">Principale</span>
                  : a.attiva ? <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-green-100 text-green-700 dark:bg-green-500/20 dark:text-green-300">Attiva</span>
                  : <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-300 inline-flex items-center gap-1"><PauseCircle className="w-3 h-3" />Sospesa</span>}
              </div>
              <div className="flex gap-4 mt-4 text-sm text-slate-600 dark:text-slate-300">
                <span className="inline-flex items-center gap-1.5"><Users className="w-4 h-4 text-slate-400" />{a.utenti} {a.utenti === 1 ? 'utente' : 'utenti'}</span>
                <span className="inline-flex items-center gap-1.5"><Bot className="w-4 h-4 text-slate-400" />{a.voicebot} voicebot</span>
              </div>
              {!a.principale && a.admin === 0 && (
                <p className="mt-3 text-xs text-amber-700 dark:text-amber-300">Nessun Admin: aprila e creane uno in Gestione Utenti.</p>
              )}
              {(a.webhookChiamate || a.webhookAppuntamenti) && (
                <p className="mt-2 text-xs text-slate-500">Scenari Make dedicati.</p>
              )}
              <div className="flex items-center gap-2 mt-auto pt-4">
                {a.id !== vista ? (
                  <button onClick={() => apriAzienda(a.id, user?.azienda, a.admin === 0 ? 'users' : 'home')}
                    className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-sm font-semibold bg-slate-900 dark:bg-white text-white dark:text-slate-900 hover:opacity-90">
                    Apri <ArrowRight className="w-4 h-4" />
                  </button>
                ) : (
                  <span className="flex-1 text-center text-xs font-semibold text-brand-600 dark:text-brand-300">Stai guardando questa</span>
                )}
                <button onClick={() => { setErrore(''); setModulo({ id: a.id, nome: a.nome, attiva: a.attiva, webhookChiamate: a.webhookChiamate || '', webhookAppuntamenti: a.webhookAppuntamenti || '' }); }}
                  aria-label={`Modifica ${a.nome}`} title="Modifica"
                  className="p-2 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800"><Pencil className="w-4 h-4" /></button>
                {!a.principale && (
                  <button onClick={() => setDaEliminare(a)} aria-label={`Elimina ${a.nome}`} title="Elimina (solo se vuota)"
                    className="p-2 rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20"><Trash2 className="w-4 h-4" /></button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {modulo && (
        <div className="fixed inset-0 z-50 flex justify-end">
          <div className="absolute inset-0 bg-black/40" onClick={() => setModulo(null)} />
          <div role="dialog" aria-label={modulo.id ? 'Modifica azienda' : 'Nuova azienda'} className="relative w-full max-w-md h-full bg-white dark:bg-slate-900 shadow-xl p-6 overflow-y-auto animate-in slide-in-from-right">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-lg font-bold text-slate-900 dark:text-white">{modulo.id ? 'Modifica azienda' : 'Nuova azienda'}</h2>
              <button onClick={() => setModulo(null)} aria-label="Chiudi" className="p-1.5 text-slate-400 hover:text-slate-700"><X className="w-5 h-5" /></button>
            </div>
            <div className="space-y-4">
              <div>
                <label htmlFor="az-nome" className={etichetta}>Nome</label>
                <input id="az-nome" value={modulo.nome} onChange={e => setModulo({ ...modulo, nome: e.target.value })} className={campo} placeholder="Rossi Srl" autoFocus />
              </div>
              {modulo.id !== 'gem' && (
                <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
                  <input type="checkbox" checked={modulo.attiva} onChange={e => setModulo({ ...modulo, attiva: e.target.checked })} />
                  Attiva (se la togli, i suoi utenti non possono entrare)
                </label>
              )}
              <div className="pt-2 border-t border-slate-100 dark:border-slate-800">
                <p className="text-xs text-slate-500 mb-3">Solo se l'azienda ha un suo centralino Wildix con i suoi scenari Make. Vuoto = gli scenari di GEM.</p>
                <label htmlFor="az-wh1" className={etichetta}>Webhook Make delle chiamate</label>
                <input id="az-wh1" value={modulo.webhookChiamate} onChange={e => setModulo({ ...modulo, webhookChiamate: e.target.value })} className={campo} placeholder="https://hook.eu1.make.com/..." />
                <label htmlFor="az-wh2" className={cn(etichetta, 'mt-3')}>Webhook Make conferma appuntamenti</label>
                <input id="az-wh2" value={modulo.webhookAppuntamenti} onChange={e => setModulo({ ...modulo, webhookAppuntamenti: e.target.value })} className={campo} placeholder="https://hook.eu1.make.com/..." />
              </div>
              {!modulo.id && (
                <p className="text-xs text-slate-500">Dopo averla creata: aprila, aggiungi il suo voicebot in Voicebot e il suo primo Admin in Gestione Utenti.</p>
              )}
              {errore && <p className="text-sm text-red-600">{errore}</p>}
              <button onClick={salva} disabled={salvando}
                className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold bg-brand-600 hover:bg-brand-700 text-white disabled:opacity-60">
                {salvando && <Loader2 className="w-4 h-4 animate-spin" />}
                {modulo.id ? 'Salva modifiche' : 'Crea azienda'}
              </button>
            </div>
          </div>
        </div>
      )}

      <ConfirmModal
        open={!!daEliminare}
        title={`Eliminare ${daEliminare?.nome}?`}
        message="Si può eliminare solo un'azienda senza utenti e voicebot. Se vuoi solo bloccarla, sospendila."
        onConfirm={() => daEliminare && elimina(daEliminare)}
        onCancel={() => setDaEliminare(null)}
      />
    </div>
  );
}

// Scelta dell'azienda da guardare, nel menu (solo super-admin).
export function SceltaAzienda() {
  const { user } = useCampaign();
  const [aziende, setAziende] = useState<{ id: string; nome: string; attiva: boolean }[]>([]);
  useEffect(() => {
    authFetch('/api/aziende').then(r => r.json()).then(d => { if (d.ok) setAziende(d.aziende); }).catch(() => {});
  }, []);
  const vista = aziendaVista() || user?.azienda || 'gem';
  if (aziende.length <= 1) return null;
  return (
    <div className="px-4 pt-3">
      <label htmlFor="scelta-azienda" className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1 px-1">Azienda</label>
      <select id="scelta-azienda" value={vista} onChange={e => apriAzienda(e.target.value, user?.azienda)}
        className="w-full px-2.5 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-sm font-semibold text-slate-900 dark:text-white">
        {aziende.map(a => <option key={a.id} value={a.id}>{a.nome}{a.attiva ? '' : ' (sospesa)'}</option>)}
      </select>
    </div>
  );
}
