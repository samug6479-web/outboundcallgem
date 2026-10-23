import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useCampaign } from '../context/CampaignContext';
import {
  Users, Trash2, Plus, Loader2, Pencil, X, ShieldCheck, ShieldOff, ShieldAlert, Search, Mail, Phone,
  CalendarClock, KeyRound, Copy, Check, AlertTriangle, BellRing, Send, Hourglass,
} from 'lucide-react';
import { cn } from '../lib/utils';
import { ConfirmModal } from './ConfirmModal';
import { authFetch } from '../lib/authFetch';

type Ruolo = 'Admin' | 'Editor' | 'Viewer';

interface Utente {
  username: string;
  nome: string;
  role: Ruolo;
  canSchedule: boolean;
  twoFactorEnabled: boolean;
  twoFactorRequired: boolean;
  email: string;
  telefono: string;
  ultimoAccesso: string | null;
  followupAperti: number;
  soloPropriFollowup: boolean;
  puoEsportare: boolean;
  limiteNumeri: number | null;
  invitoInAttesa?: boolean;
}

interface Modulo {
  nuovo: boolean;
  username: string;
  nome: string;
  email: string;
  telefono: string;
  role: Ruolo;
  canSchedule: boolean;
  password: string;
  soloPropriFollowup: boolean;
  puoEsportare: boolean;
  limiteNumeri: string;
  invito: boolean;
}

const RUOLI: { id: Ruolo; descr: string }[] = [
  { id: 'Admin', descr: 'Tutto, più utenti, voicebot e impostazioni.' },
  { id: 'Editor', descr: 'Carica liste, lancia campagne, gestisce follow-up e Non chiamare.' },
  { id: 'Viewer', descr: 'Solo lettura: In diretta, esiti, follow-up e statistiche. Non può modificare nulla.' },
];

const ruoloCls = (r: Ruolo) =>
  r === 'Admin' ? 'bg-red-50 text-red-600 dark:bg-red-900/20 dark:text-red-400'
  : r === 'Viewer' ? 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400'
  : 'bg-brand-50 text-brand-600 dark:bg-brand-900/20 dark:text-brand-400';

const quandoFa = (iso: string | null) => {
  if (!iso) return 'mai';
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (min < 2) return 'adesso';
  if (min < 60) return `${min} min fa`;
  const ore = Math.round(min / 60);
  if (ore < 24) return `${ore} ore fa`;
  const g = Math.round(ore / 24);
  if (g === 1) return 'ieri';
  if (g < 30) return `${g} giorni fa`;
  return new Date(iso).toLocaleDateString('it-IT', { day: '2-digit', month: 'short', year: 'numeric' });
};

// Password casuale leggibile (senza caratteri ambigui).
const generaPassword = () => {
  const c = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const a = new Uint32Array(12);
  crypto.getRandomValues(a);
  return Array.from(a, n => c[n % c.length]).join('');
};

const campo = 'w-full px-3 py-2 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-lg text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20';
const etichetta = 'block text-xs font-semibold text-slate-500 mb-1';

function Stato2FA({ u }: { u: Utente }) {
  if (!u.twoFactorRequired) return <span className="inline-flex items-center gap-1 text-slate-400"><ShieldOff className="w-3.5 h-3.5" />2FA spento</span>;
  if (u.twoFactorEnabled) return <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400"><ShieldCheck className="w-3.5 h-3.5" />2FA attivo</span>;
  return <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400"><ShieldAlert className="w-3.5 h-3.5" />2FA da configurare</span>;
}

export function AdminUsers() {
  const { user } = useCampaign();
  const io = (user?.username || '').toLowerCase();
  const [utenti, setUtenti] = useState<Utente[]>([]);
  const [loading, setLoading] = useState(true);
  const [cerca, setCerca] = useState('');
  const [filtro, setFiltro] = useState<'tutti' | Ruolo | 'senza2fa' | 'senzaemail'>('tutti');
  const [modulo, setModulo] = useState<Modulo | null>(null);
  const [salvando, setSalvando] = useState(false);
  const [errore, setErrore] = useState('');
  const [creato, setCreato] = useState<{ username: string; password: string; invitoA?: string; invitoInviato?: boolean } | null>(null);
  const [invitando, setInvitando] = useState<string | null>(null);
  const [copiato, setCopiato] = useState(false);
  const [msg, setMsg] = useState('');
  const [daEliminare, setDaEliminare] = useState<Utente | null>(null);

  const carica = async () => {
    setLoading(true);
    try {
      const res = await authFetch('/api/users');
      if (res.ok) setUtenti(await res.json());
    } catch { /* niente */ }
    setLoading(false);
  };
  useEffect(() => { if (user?.isAdmin) carica(); }, [user]);

  const conta = useMemo(() => ({
    Admin: utenti.filter(u => u.role === 'Admin').length,
    Editor: utenti.filter(u => u.role === 'Editor').length,
    Viewer: utenti.filter(u => u.role === 'Viewer').length,
    senza2fa: utenti.filter(u => !u.twoFactorRequired || !u.twoFactorEnabled).length,
    senzaemail: utenti.filter(u => !u.email).length,
  }), [utenti]);

  const q = cerca.trim().toLowerCase();
  const visibili = utenti
    .filter(u => filtro === 'tutti' ? true : filtro === 'senza2fa' ? (!u.twoFactorRequired || !u.twoFactorEnabled) : filtro === 'senzaemail' ? !u.email : u.role === filtro)
    .filter(u => !q || [u.nome, u.username, u.email, u.telefono].some(v => (v || '').toLowerCase().includes(q)))
    .sort((a, b) => a.nome.localeCompare(b.nome, 'it'));

  const apriNuovo = () => {
    setErrore(''); setCreato(null); setCopiato(false);
    setModulo({ nuovo: true, username: '', nome: '', email: '', telefono: '', role: 'Editor', canSchedule: true, password: generaPassword(), soloPropriFollowup: false, puoEsportare: true, limiteNumeri: '', invito: true });
  };
  const apriModifica = (u: Utente) => {
    setErrore(''); setCreato(null); setCopiato(false);
    setModulo({ nuovo: false, username: u.username, nome: u.nome, email: u.email, telefono: u.telefono, role: u.role, canSchedule: u.canSchedule, password: '',
      soloPropriFollowup: u.soloPropriFollowup, puoEsportare: u.puoEsportare, limiteNumeri: u.limiteNumeri ? String(u.limiteNumeri) : '', invito: false });
  };
  const chiudi = () => { setModulo(null); setCreato(null); };

  // Esc chiude il pannello
  useEffect(() => {
    if (!modulo) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') chiudi(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [modulo]);

  // Suggerisce lo username dal nome ("Mario Rossi" → "mario.rossi") finché non lo si tocca.
  const [usernameToccato, setUsernameToccato] = useState(false);
  const cambiaNome = (nome: string) => {
    if (!modulo) return;
    const sugg = nome.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '.').replace(/^\.|\.$/g, '');
    setModulo({ ...modulo, nome, ...(modulo.nuovo && !usernameToccato ? { username: sugg } : {}) });
  };

  const salva = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!modulo) return;
    setErrore('');
    const conInvito = modulo.nuovo && modulo.invito;
    if (conInvito && !modulo.email.trim()) { setErrore("Per mandare l'invito serve l'email. Oppure togli l'invito e scegli tu la password."); return; }
    if (!modulo.nome.trim() || (modulo.nuovo && (!modulo.username.trim() || (!conInvito && !modulo.password)))) { setErrore('Compila nome, username e password.'); return; }
    setSalvando(true);
    try {
      const body = {
        nome: modulo.nome.trim(), role: modulo.role, canSchedule: modulo.canSchedule,
        email: modulo.email.trim(), telefono: modulo.telefono.trim(),
        soloPropriFollowup: modulo.soloPropriFollowup, puoEsportare: modulo.puoEsportare,
        limiteNumeri: modulo.limiteNumeri.trim() ? parseInt(modulo.limiteNumeri, 10) || null : null,
        password: conInvito ? undefined : modulo.password || undefined,
        ...(modulo.nuovo ? { username: modulo.username.trim(), invito: conInvito } : {}),
      };
      const res = await authFetch(modulo.nuovo ? '/api/users' : `/api/users/${encodeURIComponent(modulo.username)}`, {
        method: modulo.nuovo ? 'POST' : 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || 'Salvataggio non riuscito');
      await carica();
      if (conInvito) {
        setCreato({ username: modulo.username.trim(), password: '', invitoA: modulo.email.trim(), invitoInviato: data.invitoInviato === true });
      } else if (modulo.nuovo || modulo.password) {
        setCreato({ username: modulo.username.trim(), password: modulo.password });
      } else {
        setMsg(`Modifiche a ${modulo.nome} salvate.`);
        chiudi();
      }
    } catch (err: any) {
      setErrore(err?.message || 'Errore di rete');
    }
    setSalvando(false);
  };

  const cambia2FA = async (u: Utente) => {
    const attiva = !u.twoFactorRequired;
    try {
      const res = await authFetch(`/api/users/${encodeURIComponent(u.username)}/2fa`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: attiva }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Non riuscito');
      setMsg(attiva ? `${u.nome} dovrà configurare il 2FA al prossimo accesso.` : `2FA spento per ${u.nome}.`);
      await carica();
    } catch (err: any) {
      alert(err?.message || 'Errore di rete');
    }
  };

  // Manda (o rimanda) il link per scegliere la password.
  const invita = async (u: Utente) => {
    setInvitando(u.username);
    try {
      const res = await authFetch(`/api/users/${encodeURIComponent(u.username)}/invito`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || 'Invio non riuscito');
      setMsg(`Link per scegliere la password mandato a ${data.email}. Vale 72 ore.`);
      await carica();
    } catch (err: any) {
      alert(err?.message || 'Errore di rete');
    }
    setInvitando(null);
  };

  const elimina = async (u: Utente) => {
    setDaEliminare(null);
    try {
      const res = await authFetch(`/api/users/${encodeURIComponent(u.username)}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Eliminazione non riuscita');
      setMsg(`${u.nome} eliminato.`);
      await carica();
    } catch (err: any) {
      setMsg('');
      alert(err?.message || 'Errore di rete');
    }
  };

  const testoAccesso = creato
    ? `Accesso a GEM Outbound\nSito: ${window.location.origin}\nUtente: ${creato.username}\nPassword: ${creato.password}`
    : '';
  const copia = async () => {
    try { await navigator.clipboard.writeText(testoAccesso); setCopiato(true); setTimeout(() => setCopiato(false), 2500); } catch { /* niente */ }
  };

  if (!user?.isAdmin) return null;

  const chip = (id: typeof filtro, label: string, n: number, warn = false) => (
    <button key={id} onClick={() => setFiltro(filtro === id ? 'tutti' : id)} aria-pressed={filtro === id}
      className={cn('inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1.5 rounded-lg border transition-colors',
        filtro === id ? 'bg-slate-900 text-white border-slate-900 dark:bg-white dark:text-slate-900 dark:border-white'
          : warn && n > 0 ? 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900/50 dark:bg-amber-900/10 dark:text-amber-300'
          : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800')}>
      {label} <span className="tabular-nums opacity-70">{n}</span>
    </button>
  );

  return (
    <>
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-soft overflow-hidden animate-in fade-in slide-in-from-bottom-4 duration-300">
        <div className="p-5 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/30 space-y-3">
          <div className="flex flex-wrap items-center gap-3 justify-between">
            <div className="flex items-center gap-2">
              <Users className="w-4 h-4 text-brand-600" />
              <h2 className="text-base font-bold text-slate-900 dark:text-white font-display">
                Utenti {!loading && <span className="ml-1 text-sm font-semibold text-slate-400">{utenti.length}</span>}
              </h2>
            </div>
            <div className="flex items-center gap-2 w-full sm:w-auto justify-end">
              <div className="relative flex-1 sm:w-64 sm:flex-none">
                <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
                <input value={cerca} onChange={e => setCerca(e.target.value)} placeholder="Cerca nome, username, email..." aria-label="Cerca utente"
                  className="w-full pl-8 pr-3 py-1.5 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-brand-500" />
              </div>
              <button onClick={apriNuovo}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-bold bg-brand-600 hover:bg-brand-700 text-white shrink-0">
                <Plus className="w-4 h-4" /> Nuovo utente
              </button>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filtra utenti">
            {chip('tutti', 'Tutti', utenti.length)}
            {chip('Admin', 'Admin', conta.Admin)}
            {chip('Editor', 'Editor', conta.Editor)}
            {chip('Viewer', 'Viewer', conta.Viewer)}
            {chip('senza2fa', 'Senza 2FA attivo', conta.senza2fa, true)}
            {chip('senzaemail', 'Senza email', conta.senzaemail, true)}
          </div>
        </div>

        {msg && (
          <p className="mx-5 mt-4 px-3 py-2 rounded-lg text-sm bg-green-50 text-green-800 dark:bg-green-900/20 dark:text-green-300 flex items-center gap-2">
            <Check className="w-4 h-4 shrink-0" /><span className="flex-1">{msg}</span>
            <button onClick={() => setMsg('')} aria-label="Chiudi" className="text-green-700/60 hover:text-green-800"><X className="w-4 h-4" /></button>
          </p>
        )}

        {loading ? (
          <div className="p-10 flex justify-center text-slate-400"><Loader2 className="w-5 h-5 animate-spin" /></div>
        ) : visibili.length === 0 ? (
          <div className="p-10 text-center text-sm text-slate-500">Nessun utente con questi filtri.</div>
        ) : (
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {visibili.map(u => {
              const tu = u.username.toLowerCase() === io;
              return (
                <li key={u.username} className="px-5 py-4 flex flex-wrap sm:flex-nowrap items-center gap-4 hover:bg-slate-50/60 dark:hover:bg-slate-800/30">
                  <div className="w-10 h-10 rounded-xl bg-brand-100 dark:bg-brand-500/25 flex items-center justify-center text-base font-extrabold text-brand-600 dark:text-brand-200 shrink-0">
                    {u.nome.charAt(0).toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold text-slate-900 dark:text-white">{u.nome}</span>
                      {tu && <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">tu</span>}
                      {u.invitoInAttesa && <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 dark:bg-amber-900/20 dark:text-amber-300"><Hourglass className="w-3 h-3" />Invito in attesa</span>}
                      <span className={cn('text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full', ruoloCls(u.role))}>{u.role}</span>
                    </div>
                    <div className="text-xs text-slate-500 mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5">
                      <span>@{u.username}</span>
                      {u.email
                        ? <a href={`mailto:${u.email}`} className="inline-flex items-center gap-1 hover:text-brand-600"><Mail className="w-3 h-3" />{u.email}</a>
                        : <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400"><AlertTriangle className="w-3 h-3" />manca l'email</span>}
                      {u.telefono && <a href={`tel:${u.telefono}`} className="inline-flex items-center gap-1 hover:text-brand-600"><Phone className="w-3 h-3" />{u.telefono}</a>}
                    </div>
                    <div className="text-xs mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-slate-500">
                      <Stato2FA u={u} />
                      {u.role !== 'Viewer' && <span className={cn('inline-flex items-center gap-1', u.canSchedule ? 'text-slate-600 dark:text-slate-300' : 'text-slate-400')}>
                        <CalendarClock className="w-3.5 h-3.5" />{u.canSchedule ? 'Può pianificare' : 'Non pianifica'}
                      </span>}
                      <span>Ultimo accesso: <strong className="font-semibold text-slate-600 dark:text-slate-300">{quandoFa(u.ultimoAccesso)}</strong></span>
                      {u.followupAperti > 0 && <span className="inline-flex items-center gap-1"><BellRing className="w-3.5 h-3.5" />{u.followupAperti} follow-up aperti</span>}
                      {u.role !== 'Admin' && u.soloPropriFollowup && <span className="text-slate-600 dark:text-slate-300">Solo i propri follow-up</span>}
                      {u.role !== 'Admin' && !u.puoEsportare && <span className="text-slate-600 dark:text-slate-300">Niente Excel</span>}
                      {u.role === 'Editor' && u.limiteNumeri && <span className="text-slate-600 dark:text-slate-300">Max {u.limiteNumeri} numeri</span>}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0 ml-auto">
                    <button onClick={() => cambia2FA(u)}
                      title={u.twoFactorRequired ? 'Spegni il 2FA (accederà con solo utente e password)' : 'Richiedi il 2FA (al prossimo accesso dovrà configurarlo)'}
                      className="px-2.5 py-1.5 rounded-lg text-xs font-semibold text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800">
                      {u.twoFactorRequired ? 'Spegni 2FA' : 'Richiedi 2FA'}
                    </button>
                    {u.email && !tu && (
                      <button onClick={() => invita(u)} disabled={invitando === u.username}
                        title={u.invitoInAttesa ? "Rimanda l'invito" : 'Manda un link per scegliere una nuova password'} aria-label={`Manda link password a ${u.nome}`}
                        className="p-2 rounded-lg text-slate-400 hover:text-brand-600 hover:bg-brand-50 dark:hover:bg-brand-900/30 disabled:opacity-50">
                        {invitando === u.username ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                      </button>
                    )}
                    <button onClick={() => apriModifica(u)} aria-label={`Modifica ${u.nome}`} title="Modifica"
                      className="p-2 rounded-lg text-slate-400 hover:text-brand-600 hover:bg-brand-50 dark:hover:bg-brand-900/30">
                      <Pencil className="w-4 h-4" />
                    </button>
                    {!tu && (
                      <button onClick={() => setDaEliminare(u)} aria-label={`Elimina ${u.nome}`} title="Elimina"
                        className="p-2 rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/30">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {modulo && createPortal(
        <div className="fixed inset-0 z-50 flex justify-end">
          <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-[1px]" onClick={chiudi} />
          <aside role="dialog" aria-modal="true" aria-label={modulo.nuovo ? 'Nuovo utente' : `Modifica ${modulo.nome}`}
            className="relative w-full max-w-md h-full bg-white dark:bg-slate-900 shadow-2xl flex flex-col animate-in slide-in-from-right duration-200">
            <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
              <h3 className="text-base font-bold text-slate-900 dark:text-white">{modulo.nuovo ? 'Nuovo utente' : `Modifica ${modulo.nome}`}</h3>
              <button onClick={chiudi} aria-label="Chiudi" className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800"><X className="w-5 h-5" /></button>
            </div>

            {creato?.invitoA ? (
              <div className="p-5 space-y-4 overflow-y-auto">
                <div className={cn('flex items-start gap-2 p-3 rounded-xl text-sm', creato.invitoInviato ? 'bg-green-50 text-green-800 dark:bg-green-900/20 dark:text-green-300' : 'bg-amber-50 text-amber-800 dark:bg-amber-900/20 dark:text-amber-300')}>
                  {creato.invitoInviato ? <Check className="w-4 h-4 mt-0.5 shrink-0" /> : <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />}
                  <span>{creato.invitoInviato
                    ? <>Utente creato. Abbiamo mandato l'invito a <strong>{creato.invitoA}</strong>: con il link sceglie la sua password (vale 72 ore).</>
                    : <>Utente creato, ma l'email non è partita. Riprova dal pulsante con l'aereo di carta sulla sua riga.</>}</span>
                </div>
                <p className="text-sm text-slate-600 dark:text-slate-300">Nome utente: <strong className="font-mono">{creato.username}</strong></p>
                <button onClick={chiudi} className="w-full px-4 py-2 rounded-lg text-sm font-semibold border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800">Chiudi</button>
              </div>
            ) : creato ? (
              <div className="p-5 space-y-4 overflow-y-auto">
                <div className="flex items-start gap-2 p-3 rounded-xl bg-green-50 text-green-800 dark:bg-green-900/20 dark:text-green-300 text-sm">
                  <Check className="w-4 h-4 mt-0.5 shrink-0" />
                  <span>{modulo.nuovo ? `${modulo.nome} può entrare con questi dati.` : `Nuova password salvata per ${modulo.nome}.`} Copiali e mandali tu: la password non sarà più visibile.</span>
                </div>
                <pre className="p-4 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 text-sm text-slate-800 dark:text-slate-100 whitespace-pre-wrap font-mono">{testoAccesso}</pre>
                <div className="flex gap-2">
                  <button onClick={copia} className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-sm font-bold bg-brand-600 hover:bg-brand-700 text-white">
                    {copiato ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}{copiato ? 'Copiato' : 'Copia dati di accesso'}
                  </button>
                  <button onClick={chiudi} className="px-4 py-2 rounded-lg text-sm font-semibold border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800">Chiudi</button>
                </div>
              </div>
            ) : (
              <form onSubmit={salva} className="flex-1 flex flex-col min-h-0">
                <div className="p-5 space-y-4 overflow-y-auto flex-1">
                  <div>
                    <label className={etichetta} htmlFor="u-nome">Nome e cognome</label>
                    <input id="u-nome" value={modulo.nome} onChange={e => cambiaNome(e.target.value)} className={campo} placeholder="Mario Rossi" autoFocus />
                  </div>
                  <div>
                    <label className={etichetta} htmlFor="u-user">Username</label>
                    {modulo.nuovo
                      ? <input id="u-user" value={modulo.username} onChange={e => { setUsernameToccato(true); setModulo({ ...modulo, username: e.target.value.trim() }); }} className={campo} placeholder="mario.rossi" />
                      : <div className="px-3 py-2 text-sm text-slate-500 bg-slate-50 dark:bg-slate-800/50 rounded-lg">@{modulo.username}</div>}
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className={etichetta} htmlFor="u-email">Email</label>
                      <input id="u-email" type="email" value={modulo.email} onChange={e => setModulo({ ...modulo, email: e.target.value })} className={campo} placeholder="mario@azienda.it" />
                    </div>
                    <div>
                      <label className={etichetta} htmlFor="u-tel">Telefono</label>
                      <input id="u-tel" type="tel" value={modulo.telefono} onChange={e => setModulo({ ...modulo, telefono: e.target.value })} className={campo} placeholder="+39 ..." />
                    </div>
                  </div>
                  <p className="text-[11px] text-slate-400 -mt-2">All'email arrivano riepiloghi delle campagne e avvisi dei follow-up.</p>

                  <fieldset>
                    <legend className={etichetta}>Ruolo</legend>
                    <div className="space-y-2">
                      {RUOLI.map(r => (
                        <label key={r.id} className={cn('flex items-start gap-3 p-3 rounded-xl border cursor-pointer transition-colors',
                          modulo.role === r.id ? 'border-brand-500 bg-brand-50/60 dark:bg-brand-500/10' : 'border-slate-200 dark:border-slate-700 hover:border-slate-300')}>
                          <input type="radio" name="ruolo" checked={modulo.role === r.id} onChange={() => setModulo({ ...modulo, role: r.id })} className="mt-0.5 text-brand-600 focus:ring-brand-500" />
                          <span>
                            <span className="block text-sm font-semibold text-slate-900 dark:text-white">{r.id}</span>
                            <span className="block text-xs text-slate-500">{r.descr}</span>
                          </span>
                        </label>
                      ))}
                    </div>
                  </fieldset>

                  {(
                    <fieldset className="rounded-xl border border-slate-200 dark:border-slate-700 divide-y divide-slate-100 dark:divide-slate-800">
                      <legend className="sr-only">Permessi</legend>
                      {modulo.role !== 'Viewer' && (
                        <label className="flex items-center justify-between gap-3 p-3 cursor-pointer">
                          <span>
                            <span className="block text-sm font-semibold text-slate-900 dark:text-white">Può pianificare campagne</span>
                            <span className="block text-xs text-slate-500">Lanciarle a una data e ora future.</span>
                          </span>
                          <input type="checkbox" checked={modulo.canSchedule} onChange={e => setModulo({ ...modulo, canSchedule: e.target.checked })} className="w-4 h-4 text-brand-600 rounded focus:ring-brand-500" />
                        </label>
                      )}
                      {modulo.role !== 'Admin' && <>
                      <label className="flex items-center justify-between gap-3 p-3 cursor-pointer">
                        <span>
                          <span className="block text-sm font-semibold text-slate-900 dark:text-white">Vede solo i propri follow-up</span>
                          <span className="block text-xs text-slate-500">Solo quelli assegnati a lui, non quelli dei colleghi.</span>
                        </span>
                        <input type="checkbox" checked={modulo.soloPropriFollowup} onChange={e => setModulo({ ...modulo, soloPropriFollowup: e.target.checked })} className="w-4 h-4 text-brand-600 rounded focus:ring-brand-500" />
                      </label>
                      <label className="flex items-center justify-between gap-3 p-3 cursor-pointer">
                        <span>
                          <span className="block text-sm font-semibold text-slate-900 dark:text-white">Può esportare in Excel</span>
                          <span className="block text-xs text-slate-500">Scaricare elenchi di contatti, esiti e follow-up.</span>
                        </span>
                        <input type="checkbox" checked={modulo.puoEsportare} onChange={e => setModulo({ ...modulo, puoEsportare: e.target.checked })} className="w-4 h-4 text-brand-600 rounded focus:ring-brand-500" />
                      </label>
                      </>}
                      {modulo.role === 'Editor' && (
                        <div className="flex items-center justify-between gap-3 p-3">
                          <label htmlFor="u-lim">
                            <span className="block text-sm font-semibold text-slate-900 dark:text-white">Massimo numeri per campagna</span>
                            <span className="block text-xs text-slate-500">Vuoto = nessun limite.</span>
                          </label>
                          <input id="u-lim" type="number" min={1} max={5000} inputMode="numeric" value={modulo.limiteNumeri}
                            onChange={e => setModulo({ ...modulo, limiteNumeri: e.target.value })} placeholder="—"
                            className="w-24 px-2.5 py-1.5 text-sm text-right rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-slate-900 dark:text-white focus:outline-none focus:border-brand-500" />
                        </div>
                      )}
                    </fieldset>
                  )}

                  {modulo.nuovo && (
                    <label className="flex items-center justify-between gap-3 p-3 rounded-xl border border-slate-200 dark:border-slate-700 cursor-pointer">
                      <span>
                        <span className="block text-sm font-semibold text-slate-900 dark:text-white">Manda invito via email</span>
                        <span className="block text-xs text-slate-500">Riceve un link e sceglie lui la password. Serve l'email.</span>
                      </span>
                      <input type="checkbox" checked={modulo.invito} onChange={e => setModulo({ ...modulo, invito: e.target.checked })} className="w-4 h-4 text-brand-600 rounded focus:ring-brand-500" />
                    </label>
                  )}
                  {!(modulo.nuovo && modulo.invito) && <div>
                    <label className={etichetta} htmlFor="u-pw">{modulo.nuovo ? 'Password' : 'Nuova password'}</label>
                    <div className="flex gap-2">
                      <input id="u-pw" value={modulo.password} onChange={e => setModulo({ ...modulo, password: e.target.value })} className={cn(campo, 'font-mono')}
                        placeholder={modulo.nuovo ? 'almeno 8 caratteri' : 'lascia vuoto per non cambiarla'} autoComplete="new-password" />
                      <button type="button" onClick={() => setModulo({ ...modulo, password: generaPassword() })} title="Genera una password"
                        className="shrink-0 inline-flex items-center gap-1.5 px-3 rounded-lg text-xs font-semibold border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800">
                        <KeyRound className="w-3.5 h-3.5" /> Genera
                      </button>
                    </div>
                    {!modulo.nuovo && modulo.email && <p className="text-[11px] text-slate-400 mt-1">Oppure chiudi e usa l'aereo di carta sulla riga: gli arriva un link per sceglierla lui.</p>}
                  </div>}

                  {errore && <div className="flex items-start gap-2 p-3 rounded-xl bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-300 text-sm"><AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />{errore}</div>}
                </div>
                <div className="p-4 border-t border-slate-200 dark:border-slate-800 flex gap-2">
                  <button type="submit" disabled={salvando}
                    className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-bold bg-brand-600 hover:bg-brand-700 text-white disabled:opacity-60">
                    {salvando && <Loader2 className="w-4 h-4 animate-spin" />}{modulo.nuovo ? (modulo.invito ? 'Crea e manda invito' : 'Crea utente') : 'Salva modifiche'}
                  </button>
                  <button type="button" onClick={chiudi} className="px-4 py-2.5 rounded-lg text-sm font-semibold border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800">Annulla</button>
                </div>
              </form>
            )}
          </aside>
        </div>,
        document.body,
      )}

      <ConfirmModal
        open={!!daEliminare}
        title="Elimina utente"
        message={daEliminare ? `Vuoi eliminare ${daEliminare.nome} (@${daEliminare.username})? Non potrà più entrare.${daEliminare.followupAperti ? ` Ha ${daEliminare.followupAperti} follow-up aperti assegnati: riassegnali prima.` : ''}` : ''}
        confirmLabel="Elimina"
        onConfirm={() => daEliminare && elimina(daEliminare)}
        onCancel={() => setDaEliminare(null)}
      />
    </>
  );
}
