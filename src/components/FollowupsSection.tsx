import React, { useEffect, useState } from 'react';
import { BellRing, CheckCircle2, Loader2, Phone, RefreshCw, Download, StickyNote, UserCircle2 } from 'lucide-react';
import { useCampaign } from '../context/CampaignContext';
import * as XLSX from 'xlsx';
import { authFetch } from '../lib/authFetch';
import { cn } from '../lib/utils';

interface Followup {
  id: number;
  call_id: string;
  numero: string | null;
  nome: string | null;
  motivo: string;
  stato: string;
  created_at: string;
  nota?: string | null;
  assegnato_a?: string | null;
  aggiornato_at?: string | null;
  aggiornato_da?: string | null;
}

interface Utente { username: string; nome: string }

type Stato = 'pending' | 'done';

function motivoClass(motivo: string) {
  if (motivo === 'Non risposto') return 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300';
  if (motivo === 'Appuntamento fissato') return 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300';
  if (motivo === 'Cliente interessato') return 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300';
  if (/richiamare/i.test(motivo)) return 'bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-300';
  if (/rifiut|disdett/i.test(motivo)) return 'bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-400';
  return 'bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400';
}

// Elenco dei contatti da richiamare o gestire a mano: chiamate non risposte,
// appuntamenti rifiutati, disdette, trasferimenti, ecc.
// Nota e persona assegnata: si apre sotto la riga.
function DettaglioFollowup({ f, utenti, onSaved }: { f: Followup; utenti: Utente[]; onSaved: (f: Followup) => void }) {
  const [nota, setNota] = useState(f.nota || '');
  const [assegnato, setAssegnato] = useState(f.assegnato_a || '');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const salva = async () => {
    setSaving(true);
    setErr('');
    try {
      const res = await authFetch(`/api/followups/${f.id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nota, assegnato_a: assegnato || null }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || 'Non salvato');
      onSaved(data.followup);
    } catch (e: any) {
      setErr(e?.message || 'Errore di rete');
    }
    setSaving(false);
  };
  return (
    <div className="mt-2 p-3 rounded-xl bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={`ass-${f.id}`} className="text-xs font-semibold text-slate-500">Assegnato a</label>
        <select id={`ass-${f.id}`} value={assegnato} onChange={e => setAssegnato(e.target.value)}
          className="text-xs px-2 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 dark:text-white">
          <option value="">Nessuno</option>
          {utenti.map(u => <option key={u.username} value={u.username}>{u.nome}</option>)}
        </select>
      </div>
      <textarea value={nota} onChange={e => setNota(e.target.value)} rows={2} placeholder="Nota (es. richiamato, vuole un preventivo)" aria-label="Nota"
        className="w-full text-sm px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-brand-500" />
      <div className="flex items-center gap-2">
        <button onClick={salva} disabled={saving}
          className="px-3 py-1.5 rounded-lg text-xs font-bold bg-brand-600 hover:bg-brand-700 text-white disabled:opacity-50 inline-flex items-center gap-1.5">
          {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Salva
        </button>
        {err && <span className="text-xs text-red-600">{err}</span>}
        {f.aggiornato_at && <span className="text-[11px] text-slate-400 ml-auto">Aggiornato {new Date(f.aggiornato_at).toLocaleString('it-IT', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}{f.aggiornato_da ? ` da ${f.aggiornato_da}` : ''}</span>}
      </div>
    </div>
  );
}

export function FollowupsSection() {
  const { user } = useCampaign();
  const [utenti, setUtenti] = useState<Utente[]>([]);
  const [soloMiei, setSoloMiei] = useState(false);
  const [aperto, setAperto] = useState<number | null>(null);
  useEffect(() => {
    authFetch('/api/utenti/nomi').then(r => r.json()).then(d => { if (d?.ok) setUtenti(d.utenti || []); }).catch(() => {});
  }, []);
  const nomeUtente = (u?: string | null) => (u ? utenti.find(x => x.username.toLowerCase() === u.toLowerCase())?.nome || u : '');
  const [stato, setStato] = useState<Stato>('pending');
  const [items, setItems] = useState<Followup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [motivo, setMotivo] = useState('tutti');
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = async (s: Stato = stato) => {
    setLoading(true);
    setError('');
    try {
      const res = await authFetch(`/api/followups?stato=${s}`);
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error();
      setItems(data.followups || []);
    } catch {
      setError('Impossibile caricare i follow-up.');
      setItems([]);
    }
    setLoading(false);
  };

  useEffect(() => { load(stato); setMotivo('tutti'); }, [stato]);

  const markDone = async (id: number) => {
    setBusyId(id);
    try {
      const res = await authFetch(`/api/followups/${id}/done`, { method: 'POST' });
      if (res.ok) setItems(prev => prev.filter(f => f.id !== id));
      else setError('Impossibile aggiornare il follow-up.');
    } catch {
      setError('Errore di rete.');
    }
    setBusyId(null);
  };

  const motivi = [...new Set(items.map(f => f.motivo))];
  const visible = items
    .filter(f => motivo === 'tutti' || f.motivo === motivo)
    .filter(f => !soloMiei || (f.assegnato_a || '').toLowerCase() === (user?.username || '').toLowerCase());
  const mieiCount = items.filter(f => (f.assegnato_a || '').toLowerCase() === (user?.username || '').toLowerCase()).length;

  // Esporta in Excel l'elenco mostrato (stato e filtro motivo correnti)
  const exportXlsx = () => {
    const rows = visible.map(f => ({
      Nome: f.nome || '',
      Numero: f.numero || '',
      Motivo: f.motivo,
      Stato: f.stato === 'done' ? 'Gestito' : 'Da gestire',
      Data: new Date(f.created_at).toLocaleString('it-IT'),
      'Assegnato a': nomeUtente(f.assegnato_a),
      Nota: f.nota || '',
      'ID chiamata': f.call_id,
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    ws['!cols'] = [{ wch: 24 }, { wch: 16 }, { wch: 34 }, { wch: 12 }, { wch: 20 }, { wch: 18 }, { wch: 40 }, { wch: 38 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, stato === 'pending' ? 'Da gestire' : 'Gestiti');
    const suffix = motivo === 'tutti' ? '' : `-${motivo.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
    XLSX.writeFile(wb, `follow-up-${stato === 'pending' ? 'da-gestire' : 'gestiti'}${suffix}-${new Date().toISOString().slice(0, 10)}.xlsx`);
  };

  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-soft overflow-hidden animate-in fade-in slide-in-from-bottom-4 duration-300">
      <div className="p-5 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/30 flex flex-wrap items-center gap-3 justify-between">
        <div className="flex items-center gap-2">
          <BellRing className="w-4 h-4 text-brand-600" />
          <h2 className="text-base font-bold text-slate-900 dark:text-white font-display">
            {stato === 'pending' ? 'Da gestire' : 'Gestiti'}
            {!loading && <span className="ml-2 text-sm font-semibold text-slate-400">{visible.length}</span>}
          </h2>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden text-xs font-semibold">
            {(['pending', 'done'] as Stato[]).map(s => (
              <button key={s} onClick={() => setStato(s)}
                className={cn('px-3 py-1.5 transition-colors', stato === s ? 'bg-brand-600 text-white' : 'text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800')}>
                {s === 'pending' ? 'Da gestire' : 'Gestiti'}
              </button>
            ))}
          </div>
          {mieiCount > 0 && (
            <button onClick={() => setSoloMiei(v => !v)} aria-pressed={soloMiei}
              className={cn('text-xs font-semibold px-2.5 py-1.5 rounded-lg border transition-colors',
                soloMiei ? 'bg-brand-600 text-white border-brand-600' : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800')}>
              Assegnati a me <span className="tabular-nums opacity-80">{mieiCount}</span>
            </button>
          )}
          {motivi.length > 1 && (
            <select value={motivo} onChange={e => setMotivo(e.target.value)} aria-label="Filtra per motivo"
              className="text-xs px-2 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 dark:text-white">
              <option value="tutti">Tutti i motivi</option>
              {motivi.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          )}
          <button onClick={exportXlsx} disabled={loading || visible.length === 0} aria-label="Esporta in Excel" title="Esporta in Excel"
            className="p-1.5 text-slate-400 hover:text-brand-600 hover:bg-brand-50 rounded-lg transition-colors disabled:opacity-40 disabled:hover:bg-transparent">
            <Download className="w-4 h-4" />
          </button>
          <button onClick={() => load()} aria-label="Aggiorna" title="Aggiorna"
            className="p-1.5 text-slate-400 hover:text-brand-600 hover:bg-brand-50 rounded-lg transition-colors">
            <RefreshCw className={cn('w-4 h-4', loading && 'animate-spin')} />
          </button>
        </div>
      </div>

      {error && <p className="px-5 pt-4 text-sm text-red-500">{error}</p>}

      {loading ? (
        <div className="p-10 flex justify-center text-slate-400"><Loader2 className="w-5 h-5 animate-spin" /></div>
      ) : visible.length === 0 ? (
        <div className="p-10 text-center text-sm text-slate-500">
          {stato === 'pending' ? 'Nessun contatto da gestire.' : 'Nessun follow-up gestito.'}
        </div>
      ) : (
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {visible.map(f => (
            <li key={f.id} className="px-5 py-3">
             <div className="flex items-center justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-semibold text-slate-900 dark:text-white truncate">{f.nome || f.numero || 'Contatto sconosciuto'}</span>
                  <span className={cn('text-[11px] font-bold px-2 py-0.5 rounded-full', motivoClass(f.motivo))}>{f.motivo}</span>
                </div>
                <div className="text-xs text-slate-500 mt-0.5 flex items-center gap-2 flex-wrap">
                  {f.numero && (
                    <a href={`tel:${f.numero}`} className="inline-flex items-center gap-1 text-brand-600 hover:underline">
                      <Phone className="w-3 h-3" />{f.numero}
                    </a>
                  )}
                  <span>{new Date(f.created_at).toLocaleString('it-IT', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
                  {f.assegnato_a && <span className="inline-flex items-center gap-1"><UserCircle2 className="w-3 h-3" />{nomeUtente(f.assegnato_a)}</span>}
                </div>
                {f.nota && aperto !== f.id && <p className="text-xs text-slate-600 dark:text-slate-300 mt-1 italic">“{f.nota}”</p>}
              </div>
              <button onClick={() => setAperto(aperto === f.id ? null : f.id)} aria-expanded={aperto === f.id}
                className={cn('shrink-0 inline-flex items-center gap-1 text-xs font-semibold px-2.5 py-1.5 rounded-lg transition-colors',
                  aperto === f.id ? 'bg-slate-100 dark:bg-slate-800 text-slate-800 dark:text-white' : 'text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800')}>
                <StickyNote className="w-3.5 h-3.5" /> {f.nota ? 'Nota' : 'Aggiungi nota'}
              </button>
              {stato === 'pending' && (
                <button onClick={() => markDone(f.id)} disabled={busyId === f.id}
                  className="shrink-0 inline-flex items-center gap-1 text-xs font-semibold text-green-700 dark:text-green-400 hover:bg-green-50 dark:hover:bg-green-900/20 px-2.5 py-1.5 rounded-lg transition-colors disabled:opacity-50">
                  {busyId === f.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
                  Fatto
                </button>
              )}
             </div>
              {aperto === f.id && (
                <DettaglioFollowup f={f} utenti={utenti}
                  onSaved={nf => { setItems(prev => prev.map(x => (x.id === nf.id ? { ...x, ...nf } : x))); setAperto(null); }} />
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
