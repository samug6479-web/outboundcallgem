import React, { useEffect, useState } from 'react';
import { BellRing, CheckCircle2, Loader2, Phone, RefreshCw, Download, StickyNote, UserCircle2, Search, UserPlus, X } from 'lucide-react';
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
function DettaglioFollowup({ f, utenti, io, onSaved }: { f: Followup; utenti: Utente[]; io?: string; onSaved: (f: Followup) => void }) {
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
        {assegnato && assegnato.toLowerCase() !== (f.assegnato_a || '').toLowerCase() && assegnato.toLowerCase() !== (io || '').toLowerCase() && (
          <span className="text-[11px] text-slate-500">
            Salvando, {utenti.find(u => u.username === assegnato)?.nome || assegnato} riceve un avviso nel sito e un'email.
          </span>
        )}
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

type FiltroChi = 'tutti' | 'miei' | 'nessuno' | string;

export function FollowupsSection() {
  const { user } = useCampaign();
  const io = (user?.username || '').toLowerCase();
  const puoGestire = user?.role !== 'Viewer';
  const [utenti, setUtenti] = useState<Utente[]>([]);
  // "Assegnati a me" già attivo se si arriva da una notifica o dall'email di assegnazione.
  const [chi, setChi] = useState<FiltroChi>(() => {
    let v = new URLSearchParams(window.location.search).get('miei') === '1';
    try { if (sessionStorage.getItem('gem_followups_miei') === '1') { v = true; sessionStorage.removeItem('gem_followups_miei'); } } catch { /* niente */ }
    return v ? 'miei' : 'tutti';
  });
  // Notifica aperta mentre questa pagina è già visibile.
  useEffect(() => {
    const on = () => { setChi('miei'); try { sessionStorage.removeItem('gem_followups_miei'); } catch { /* niente */ } };
    window.addEventListener('gem:followups-miei', on);
    return () => window.removeEventListener('gem:followups-miei', on);
  }, []);
  const [aperto, setAperto] = useState<number | null>(null);
  useEffect(() => {
    authFetch('/api/utenti/nomi').then(r => r.json()).then(d => { if (d?.ok) setUtenti(d.utenti || []); }).catch(() => {});
  }, []);
  const nomeUtente = (u?: string | null) => (u ? utenti.find(x => x.username.toLowerCase() === u.toLowerCase())?.nome || u : '');
  const [stato, setStato] = useState<Stato>('pending');
  const [items, setItems] = useState<Followup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [motivo, setMotivo] = useState('tutti');
  const [cerca, setCerca] = useState('');
  const [busyId, setBusyId] = useState<number | null>(null);

  // Selezione multipla (Admin ed Editor)
  const [selezionati, setSelezionati] = useState<Set<number>>(new Set());
  const [assegnaA, setAssegnaA] = useState('');
  const [messaggio, setMessaggio] = useState('');
  const [busyBulk, setBusyBulk] = useState(false);

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

  useEffect(() => { load(stato); setMotivo('tutti'); setSelezionati(new Set()); }, [stato]);

  const markDone = async (id: number) => {
    setBusyId(id);
    try {
      const res = await authFetch(`/api/followups/${id}/done`, { method: 'POST' });
      if (res.ok) { setItems(prev => prev.filter(f => f.id !== id)); setSelezionati(prev => { const n = new Set(prev); n.delete(id); return n; }); }
      else setError('Impossibile aggiornare il follow-up.');
    } catch {
      setError('Errore di rete.');
    }
    setBusyId(null);
  };

  const assegnatoA = (f: Followup) => (f.assegnato_a || '').toLowerCase();
  const motivi = [...new Set(items.map(f => f.motivo))];
  const q = cerca.trim().toLowerCase();
  const visible = items
    .filter(f => motivo === 'tutti' || f.motivo === motivo)
    .filter(f => chi === 'tutti' ? true : chi === 'miei' ? assegnatoA(f) === io : chi === 'nessuno' ? !f.assegnato_a : assegnatoA(f) === chi.toLowerCase())
    .filter(f => !q || [f.nome, f.numero, f.nota, f.motivo].some(v => (v || '').toLowerCase().includes(q)));
  const mieiCount = items.filter(f => assegnatoA(f) === io).length;
  const nessunoCount = items.filter(f => !f.assegnato_a).length;
  const perPersona = utenti.map(u => ({ ...u, n: items.filter(f => assegnatoA(f) === u.username.toLowerCase()).length })).filter(u => u.n > 0);

  const selezionabili = puoGestire && stato === 'pending';
  const selVisibili = visible.filter(f => selezionati.has(f.id));
  const tuttiSelezionati = visible.length > 0 && selVisibili.length === visible.length;
  const toggle = (id: number) => setSelezionati(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const toggleTutti = () => setSelezionati(tuttiSelezionati ? new Set() : new Set(visible.map(f => f.id)));

  const bulk = async (azione: 'assegna' | 'fatto') => {
    const ids = selVisibili.map(f => f.id);
    if (ids.length === 0) return;
    setBusyBulk(true);
    setError('');
    setMsg('');
    try {
      const res = await authFetch('/api/followups/bulk', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(azione === 'fatto' ? { azione, ids } : { azione, ids, assegnato_a: assegnaA || null, messaggio: messaggio.trim() || undefined }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || 'Operazione non riuscita');
      if (azione === 'fatto') {
        setItems(prev => prev.filter(f => !ids.includes(f.id)));
        setMsg(`${data.aggiornati} follow-up segnati come fatti.`);
      } else {
        const nuovi = new Map<number, Followup>((data.followups || []).map((f: Followup) => [f.id, f]));
        setItems(prev => prev.map(f => nuovi.get(f.id) ? { ...f, ...nuovi.get(f.id)! } : f));
        const nome = assegnaA ? nomeUtente(assegnaA) : '';
        setMsg(assegnaA
          ? `${data.aggiornati} follow-up assegnati a ${nome}.${assegnaA.toLowerCase() !== io ? (data.avvisato ? ` ${nome} ha ricevuto un'email e vedrà l'avviso nel sito.` : ` ${nome} vedrà l'avviso nel sito.`) : ''}`
          : `${data.aggiornati} follow-up senza assegnazione.`);
        setMessaggio('');
      }
      setSelezionati(new Set());
    } catch (e: any) {
      setError(e?.message || 'Errore di rete.');
    }
    setBusyBulk(false);
  };

  // Esporta in Excel l'elenco mostrato (stato e filtri correnti)
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

  const sel = 'text-xs px-2 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 dark:text-white';

  return (
    <div className="space-y-4 animate-in fade-in slide-in-from-bottom-4 duration-300">
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-soft overflow-hidden">
      <div className="p-5 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/30 space-y-3">
        <div className="flex flex-wrap items-center gap-3 justify-between">
          <div className="flex items-center gap-2">
            <BellRing className="w-4 h-4 text-brand-600" />
            <h2 className="text-base font-bold text-slate-900 dark:text-white font-display">
              {stato === 'pending' ? 'Da gestire' : 'Gestiti'}
              {!loading && <span className="ml-2 text-sm font-semibold text-slate-400">{visible.length}{visible.length !== items.length ? ` di ${items.length}` : ''}</span>}
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
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[12rem]">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <input value={cerca} onChange={e => setCerca(e.target.value)} placeholder="Cerca nome, numero o nota..." aria-label="Cerca"
              className="w-full pl-8 pr-3 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-brand-500" />
          </div>
          <select value={chi} onChange={e => setChi(e.target.value)} aria-label="Filtra per persona assegnata" className={sel}>
            <option value="tutti">Tutti</option>
            <option value="miei">Assegnati a me ({mieiCount})</option>
            <option value="nessuno">Non assegnati ({nessunoCount})</option>
            {perPersona.filter(u => u.username.toLowerCase() !== io).map(u => <option key={u.username} value={u.username}>{u.nome} ({u.n})</option>)}
          </select>
          {motivi.length > 1 && (
            <select value={motivo} onChange={e => setMotivo(e.target.value)} aria-label="Filtra per motivo" className={sel}>
              <option value="tutti">Tutti i motivi</option>
              {motivi.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          )}
        </div>
      </div>

      {error && <p className="px-5 pt-4 text-sm text-red-500">{error}</p>}
      {msg && <p className="mx-5 mt-4 px-3 py-2 rounded-lg text-sm bg-green-50 text-green-800 dark:bg-green-900/20 dark:text-green-300 flex items-center gap-2"><CheckCircle2 className="w-4 h-4 shrink-0" />{msg}</p>}

      {loading ? (
        <div className="p-10 flex justify-center text-slate-400"><Loader2 className="w-5 h-5 animate-spin" /></div>
      ) : visible.length === 0 ? (
        <div className="p-10 text-center text-sm text-slate-500">
          {items.length > 0 ? 'Nessun follow-up con questi filtri.' : stato === 'pending' ? 'Nessun contatto da gestire.' : 'Nessun follow-up gestito.'}
        </div>
      ) : (
        <>
        {selezionabili && (
          <label className="flex items-center gap-3 px-5 py-2 border-b border-slate-100 dark:border-slate-800 text-xs font-semibold text-slate-500 cursor-pointer select-none">
            <input type="checkbox" checked={tuttiSelezionati} ref={el => { if (el) el.indeterminate = selVisibili.length > 0 && !tuttiSelezionati; }}
              onChange={toggleTutti} className="w-4 h-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500" />
            {selVisibili.length > 0 ? `${selVisibili.length} selezionati` : `Seleziona tutti (${visible.length})`}
          </label>
        )}
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {visible.map(f => (
            <li key={f.id} className={cn('px-5 py-3', selezionati.has(f.id) && 'bg-brand-50/60 dark:bg-brand-500/10')}>
             <div className="flex items-center justify-between gap-3">
              {selezionabili && (
                <input type="checkbox" checked={selezionati.has(f.id)} onChange={() => toggle(f.id)}
                  aria-label={`Seleziona ${f.nome || f.numero || 'contatto'}`}
                  className="w-4 h-4 shrink-0 rounded border-slate-300 text-brand-600 focus:ring-brand-500" />
              )}
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
                  {f.assegnato_a
                    ? <span className={cn('inline-flex items-center gap-1', assegnatoA(f) === io && 'text-brand-600 dark:text-brand-300 font-semibold')}><UserCircle2 className="w-3 h-3" />{assegnatoA(f) === io ? 'Tu' : nomeUtente(f.assegnato_a)}</span>
                    : <span className="text-slate-400">Non assegnato</span>}
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
                <DettaglioFollowup f={f} utenti={utenti} io={user?.username}
                  onSaved={nf => { setItems(prev => prev.map(x => (x.id === nf.id ? { ...x, ...nf } : x))); setAperto(null); }} />
              )}
            </li>
          ))}
        </ul>
        </>
      )}
    </div>

    {/* Barra delle azioni sui selezionati */}
    {selezionabili && selVisibili.length > 0 && (
      <div role="region" aria-label="Azioni sui follow-up selezionati"
        className="sticky bottom-4 z-20 flex flex-wrap items-center gap-2 p-3 rounded-2xl border border-brand-200 dark:border-brand-500/30 bg-white/95 dark:bg-slate-900/95 backdrop-blur shadow-lg animate-in fade-in slide-in-from-bottom-2">
        <span className="text-sm font-bold text-slate-900 dark:text-white px-1">{selVisibili.length} selezionati</span>
        <span className="hidden sm:block w-px h-6 bg-slate-200 dark:bg-slate-700" />
        <label htmlFor="assegna-a" className="text-xs font-semibold text-slate-500">Assegna a</label>
        <select id="assegna-a" value={assegnaA} onChange={e => setAssegnaA(e.target.value)} className={sel}>
          <option value="">Nessuno (togli)</option>
          {utenti.map(u => <option key={u.username} value={u.username}>{u.username.toLowerCase() === io ? `${u.nome} (tu)` : u.nome}</option>)}
        </select>
        {assegnaA && assegnaA.toLowerCase() !== io && (
          <input value={messaggio} onChange={e => setMessaggio(e.target.value)} maxLength={500} placeholder="Messaggio (facoltativo)" aria-label="Messaggio per chi riceve"
            className="flex-1 min-w-[10rem] text-xs px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-brand-500" />
        )}
        <button onClick={() => bulk('assegna')} disabled={busyBulk}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold bg-brand-600 hover:bg-brand-700 text-white disabled:opacity-50">
          {busyBulk ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <UserPlus className="w-3.5 h-3.5" />} Assegna
        </button>
        <button onClick={() => bulk('fatto')} disabled={busyBulk}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold text-green-700 dark:text-green-400 border border-green-200 dark:border-green-900/50 hover:bg-green-50 dark:hover:bg-green-900/20 disabled:opacity-50">
          <CheckCircle2 className="w-3.5 h-3.5" /> Segna fatti
        </button>
        <button onClick={() => setSelezionati(new Set())} aria-label="Annulla selezione" title="Annulla selezione"
          className="ml-auto p-1.5 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 rounded-lg">
          <X className="w-4 h-4" />
        </button>
      </div>
    )}
    </div>
  );
}
