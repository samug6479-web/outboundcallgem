import React, { createContext, useContext, useState, useEffect } from 'react';
import { isValidPhoneNumber, normalizePhoneNumber } from '../lib/utils';
import { authFetch } from '../lib/authFetch';
import { OrariConsentiti, dentroOrari, prossimaApertura, quandoBreve } from '../lib/orari';
import * as XLSX from 'xlsx';

export interface Voicebot {
  id: string;
  nome: string;
  exten: number;
  context: string;
  descrizione?: string;
  attivo: boolean;
  webhookEsiti?: string;
}

export interface User {
  username: string;
  nome: string;
  role?: string;
  isAdmin?: boolean;
  canSchedule?: boolean;
  email?: string;
  telefono?: string;
  twoFactorEnabled?: boolean;
  twoFactorRequired?: boolean;
  // Permessi in più impostati dall'Admin
  soloPropriFollowup?: boolean;
  puoEsportare?: boolean;
  limiteNumeri?: number | null;
}

export interface Contact {
  id: string;
  nome: string;
  numero: string;
  inv?: boolean;
  dup?: boolean;
  data_appuntamento?: string;
  ora_appuntamento?: string;
  prestazione?: string;
}

export interface ContactList {
  id: string;
  name: string;
  createdBy: string;
  createdAt: string;
  contacts: Contact[];
  canDelete?: boolean;
}

// Impostazioni del server che cambiano cosa mostra l'interfaccia.
export interface AppConfig {
  codaSito: boolean;       // il sito gestisce la coda: pausa, richiamate, orari, chiamate simultanee reali
  maxSimultanee: number;
  maxSimultaneeAppuntamenti: number;
  timerAttivo: boolean;    // il timer del server fa partire le pianificate anche ad app chiusa
  orari: OrariConsentiti | null;
}

// Richiamate automatiche dei non raggiunti.
export interface Richiamate { tentativi: number; intervalloMin: number }

export interface HistoryItem {
  id?: string;
  tipoCampagna?: string;
  voicebot?: string;
  ts: string;
  count: number;
  scheduledAt: string | null;
  opt: string;
  chunkSize: number;
  contactsList?: Contact[];
  note?: string;
  scenarioStatus?: 'pending' | 'running' | 'done' | 'error';
  executionId?: string;
}

export interface ScheduledCampaign {
  id: number;
  createdAt: string;
  createdBy: string;
  operatore: string | null;
  scheduledAt: string;
  status: 'pending' | 'sending' | 'sent' | 'partial' | 'failed' | 'cancelled' | 'expired';
  tipoCampagna: string;
  note: string | null;
  count: number;
  sentCount: number | null;
  failedCount: number | null;
  dispatchedAt: string | null;
  error: string | null;
}

export interface AccessLog {
  ts: string;
  username: string;
  nome: string;
  action: string;
}

interface CampaignContextType {
  user: User | null;
  setUser: React.Dispatch<React.SetStateAction<User | null>>;
  updateProfile: (email: string, telefono: string) => Promise<{ ok: boolean; error?: string }>;
  enable2FA: () => Promise<{ ok: boolean; error?: string }>;
  login: (u: string, p: string) => Promise<any>;
  verifyOtp: (u: string, otp: string, otpToken?: string) => Promise<any>;
  logout: () => void;
  
  contacts: Contact[];
  setContacts: React.Dispatch<React.SetStateAction<Contact[]>>;
  updateManualContacts: (newContacts: Contact[]) => void;
  validContacts: Contact[];
  invalidCount: number;
  duplicateCount: number;

  uploadMode: 'csv' | 'xls' | 'manual';
  setUploadMode: (m: 'csv' | 'xls' | 'manual') => void;

  scheduleMode: 'now' | 'later';
  setScheduleMode: (m: 'now' | 'later') => void;
  scheduledAt: string;
  setScheduledAt: (s: string) => void;
  concurrency: number;
  setConcurrency: (c: number) => void;

  isLaunching: boolean;
  launchStatus: { type: 'idle' | 'load' | 'ok' | 'err'; msg: string };
  launchCampaign: () => Promise<void>;
  testSingleCall: (contact: Contact) => Promise<void>;
  testStatus: { type: 'idle' | 'load' | 'ok' | 'err'; msg: string };
  
  campaignNote: string;
  setCampaignNote: (n: string) => void;
  campaignType: 'standard' | 'appuntamenti';
  setCampaignType: (t: 'standard' | 'appuntamenti') => void;

  voicebots: Voicebot[];
  selectedVoicebot: Voicebot | null;
  setSelectedVoicebot: (v: Voicebot | null) => void;
  loadVoicebots: () => Promise<void>;
  richiamate: Richiamate;
  setRichiamate: (r: Richiamate) => void;
  maxConcurrency: number;
  avviaConContatti: (contatti: { nome: string | null; numero: string }[]) => void;
  reloadConfig: () => void;

  historyFilter: { operator: string; dateFrom: string; dateTo: string; search: string };
  setHistoryFilter: React.Dispatch<React.SetStateAction<{ operator: string; dateFrom: string; dateTo: string; search: string }>>;
  filteredHistory: HistoryItem[];
  exportHistoryToXLSX: () => void;
  
  history: HistoryItem[];
  scheduledCampaigns: ScheduledCampaign[];
  loadScheduledCampaigns: () => Promise<void>;
  cancelScheduledCampaign: (id: number) => Promise<{ ok: boolean; error?: string }>;
  clearHistory: () => Promise<{ ok: boolean; error?: string }>;
  loadHistory: () => Promise<void>;
  appConfig: AppConfig;

  lists: ContactList[];
  saveList: (name: string, contactsToSave: Contact[]) => Promise<{ ok: boolean; error?: string }>;
  deleteList: (id: string) => Promise<{ ok: boolean; error?: string }>;
  loadList: (id: string) => void;

  darkMode: boolean;
  toggleTheme: () => void;
}

const CampaignContext = createContext<CampaignContextType | null>(null);

export function CampaignProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [contacts, setContacts] = useState<Contact[]>([]);
  
  // UI States
  const [uploadMode, setUploadMode] = useState<'csv' | 'xls' | 'manual'>('csv');
  const [scheduleMode, setScheduleMode] = useState<'now' | 'later'>('now');
  const [scheduledAt, setScheduledAt] = useState<string>('');
  const [concurrency, setConcurrency] = useState<number>(1);
  const [isLaunching, setIsLaunching] = useState(false);
  const [launchStatus, setLaunchStatus] = useState<{ type: 'idle' | 'load' | 'ok' | 'err', msg: string }>({ type: 'idle', msg: '' });
  const [testStatus, setTestStatus] = useState<{ type: 'idle' | 'load' | 'ok' | 'err', msg: string }>({ type: 'idle', msg: '' });
  const [campaignNote, setCampaignNote] = useState('');
  const [campaignType, setCampaignType] = useState<'standard' | 'appuntamenti'>('standard');
  const [voicebots, setVoicebots] = useState<Voicebot[]>([]);
  const [selectedVoicebot, setSelectedVoicebot] = useState<Voicebot | null>(null);
  const [richiamate, setRichiamate] = useState<Richiamate>({ tentativi: 0, intervalloMin: 120 });
  const [historyFilter, setHistoryFilter] = useState({ operator: '', dateFrom: '', dateTo: '', search: '' });
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [lists, setLists] = useState<ContactList[]>([]);
  const [darkMode, setDarkMode] = useState(false);

  // Load persistence
  useEffect(() => {
    const s = sessionStorage.getItem('gem_session');
    if (s) {
      const cachedUser = JSON.parse(s);
      setUser(cachedUser);
      // Il campo twoFactorEnabled/Required potrebbe essere non aggiornato se
      // la sessione salvata risale a un login precedente all'introduzione
      // di questi campi (o se un Admin ha cambiato l'impostazione altrove).
      // Lo aggiorniamo sempre da una fonte fresca, invece di fidarci solo
      // della cache — altrimenti il banner "2FA non attivo" può comparire
      // per errore anche quando è già stato attivato.
      authFetch(`/api/me?username=${encodeURIComponent(cachedUser.username)}`)
        .then(r => r.ok ? r.json() : null)
        .then(data => {
          if (data?.ok) {
            const updated = { ...cachedUser, twoFactorEnabled: data.twoFactorEnabled, twoFactorRequired: data.twoFactorRequired, email: data.email, telefono: data.telefono,
              ...(data.role ? { role: data.role, canSchedule: data.canSchedule } : {}),
              soloPropriFollowup: data.soloPropriFollowup === true, puoEsportare: data.puoEsportare !== false, limiteNumeri: data.limiteNumeri ?? null };
            setUser(updated);
            sessionStorage.setItem('gem_session', JSON.stringify(updated));
          }
        })
        .catch(() => {});
    }

    const theme = localStorage.getItem('gem_theme');
    if (theme === 'dark') {
      document.documentElement.classList.add('dark');
      setDarkMode(true);
    }
  }, []);

  // La lista voicebot richiede il login: la carichiamo quando c'è un utente.
  useEffect(() => {
    if (user) loadVoicebots();
  }, [user?.username]);

  // ── Campagne pianificate ──
  // Il server le invia a Make quando arriva l'orario, ma solo quando qualcuno
  // glielo chiede: questa lettura ogni 30 secondi (finché l'app è aperta)
  // fa da timer.
  const [scheduledCampaigns, setScheduledCampaigns] = useState<ScheduledCampaign[]>([]);
  const loadScheduledCampaigns = async () => {
    try {
      const res = await authFetch('/api/campaigns/scheduled');
      if (!res.ok) return;
      const data = await res.json();
      if (data.ok) setScheduledCampaigns(data.campaigns || []);
    } catch { /* rete assente: si riprova al giro successivo */ }
  };
  const cancelScheduledCampaign = async (id: number) => {
    try {
      const res = await authFetch(`/api/campaigns/scheduled/${id}/cancel`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      await loadScheduledCampaigns();
      return res.ok ? { ok: true } : { ok: false, error: data.error || `Errore HTTP ${res.status}` };
    } catch {
      return { ok: false, error: 'Errore di rete' };
    }
  };
  useEffect(() => {
    if (!user) { setScheduledCampaigns([]); return; }
    loadScheduledCampaigns();
    const timer = setInterval(loadScheduledCampaigns, 30_000);
    return () => clearInterval(timer);
  }, [user?.username]);

  // ── Storico, liste e impostazioni: sul server, uguali su ogni dispositivo ──
  const [appConfig, setAppConfig] = useState<AppConfig>({ codaSito: false, maxSimultanee: 1, maxSimultaneeAppuntamenti: 1, timerAttivo: false, orari: null });
  const reloadConfig = () => {
    authFetch('/api/config')
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (d?.ok) setAppConfig({
          codaSito: !!d.codaSito, maxSimultanee: d.maxSimultanee || 1, maxSimultaneeAppuntamenti: d.maxSimultaneeAppuntamenti || 1,
          timerAttivo: !!d.timerAttivo, orari: d.orari || null,
        });
      })
      .catch(() => {});
  };
  const loadHistory = async () => {
    try {
      const res = await authFetch('/api/history');
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) setHistory(data.history || []);
    } catch { /* rete assente */ }
  };
  const loadLists = async () => {
    try {
      const res = await authFetch('/api/lists');
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) setLists(data.lists || []);
    } catch { /* rete assente */ }
  };
  // Storico e liste salvati nel browser dalle versioni precedenti: si portano
  // sul server una volta sola, poi si tolgono dal browser.
  const importaArchivioLocale = async () => {
    let liste: any[] = [], storico: any[] = [];
    try {
      liste = JSON.parse(localStorage.getItem('gem_lists') || '[]');
      storico = JSON.parse(localStorage.getItem('gem_history') || '[]');
    } catch { /* dati illeggibili: niente da importare */ }
    if (!Array.isArray(liste)) liste = [];
    if (!Array.isArray(storico)) storico = [];
    if (liste.length === 0 && storico.length === 0) return;
    try {
      const res = await authFetch('/api/archivio/importa', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ liste, storico }),
      });
      if (res.ok) {
        localStorage.removeItem('gem_lists');
        localStorage.removeItem('gem_history');
      }
    } catch { /* si riprova al prossimo accesso */ }
  };
  useEffect(() => {
    if (!user) { setHistory([]); setLists([]); return; }
    const isViewer = user.role === 'Viewer';
    (async () => {
      if (!isViewer) await importaArchivioLocale();
      await Promise.all([loadHistory(), isViewer ? Promise.resolve() : loadLists()]);
    })();
    reloadConfig();
  }, [user?.username]);

  // Le chiamate simultanee non possono superare il limite del tipo di campagna.
  const maxConcurrency = campaignType === 'appuntamenti' ? appConfig.maxSimultaneeAppuntamenti : appConfig.maxSimultanee;
  useEffect(() => {
    if (concurrency > maxConcurrency) setConcurrency(Math.max(1, maxConcurrency));
  }, [maxConcurrency]);

  // Nuova campagna con questi contatti (es. i "Non partita" di una campagna).
  const avviaConContatti = (contatti: { nome: string | null; numero: string }[]) => {
    setContacts(contatti.map((c, i) => ({ id: `r${Date.now()}-${i}`, nome: c.nome || c.numero, numero: c.numero })));
    setUploadMode('manual');
    setLaunchStatus({ type: 'idle', msg: '' });
    window.dispatchEvent(new CustomEvent('gem:nav', { detail: 'campaign' }));
  };

  const login = async (u: string, p: string) => {
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: u, password: p })
      });
      const data = await res.json();
      return data;
    } catch (err) {
      console.error(err);
      return { ok: false, error: "Errore di rete" };
    }
  };

  const verifyOtp = async (u: string, otp: string, otpToken?: string) => {
    try {
      const res = await fetch('/api/verify-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: u, otp, otpToken })
      });
      const data = await res.json();
      
      if (res.ok && data.ok) {
        const loggedUser = { username: data.username, nome: data.nome, role: data.role, isAdmin: data.isAdmin, canSchedule: data.canSchedule, email: data.email || '', telefono: data.telefono || '', twoFactorEnabled: data.twoFactorEnabled, twoFactorRequired: data.twoFactorRequired, soloPropriFollowup: data.soloPropriFollowup === true, puoEsportare: data.puoEsportare !== false, limiteNumeri: data.limiteNumeri ?? null };
        setUser(loggedUser);
        sessionStorage.setItem('gem_session', JSON.stringify(loggedUser));
        if (data.token) sessionStorage.setItem('gem_token', data.token);
        return { ok: true };
      }
      return data;
    } catch (err) {
      console.error(err);
      return { ok: false, error: "Errore di rete" };
    }
  };

  const updateProfile = async (email: string, telefono: string) => {
    try {
      const res = await authFetch('/api/me', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: user?.username, email, telefono })
      });
      const data = await res.json();
      if (data.ok) {
        const updated = { ...user!, email, telefono };
        setUser(updated);
        sessionStorage.setItem('gem_session', JSON.stringify(updated));
        return { ok: true };
      }
      return { ok: false, error: data.error };
    } catch { return { ok: false, error: 'Errore di rete' }; }
  };

  const logout = () => {
    // Il token va letto prima di cancellarlo dalla sessione
    if (user) authFetch('/api/access-log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'logout' }) }).catch(() => {});
    sessionStorage.removeItem('gem_session');
    sessionStorage.removeItem('gem_token');
    setUser(null);
  };

  // Attiva il 2FA per l'utente corrente (self-service, non serve essere Admin).
  // Dopo l'attivazione serve rifare il login per completare il setup con un
  // nuovo QR code, quindi effettuiamo subito il logout.
  const enable2FA = async () => {
    if (!user) return { ok: false, error: 'Utente non loggato' };
    try {
      const res = await authFetch(`/api/users/${user.username}/2fa`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true })
      });
      const data = await res.json();
      if (data.ok) {
        logout();
        return { ok: true };
      }
      return { ok: false, error: data.error };
    } catch {
      return { ok: false, error: 'Errore di rete' };
    }
  };

  const applicaTema = (dark: boolean) => {
    document.documentElement.classList.toggle('dark', dark);
    setDarkMode(dark);
    try { localStorage.setItem('gem_theme', dark ? 'dark' : 'light'); } catch { /* storage non disponibile */ }
  };
  // Il tema è salvato anche sul server, così è uguale su ogni dispositivo.
  const toggleTheme = () => {
    const isDark = !document.documentElement.classList.contains('dark');
    applicaTema(isDark);
    authFetch('/api/preferenze', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tema: isDark ? 'scuro' : 'chiaro' }),
    }).catch(() => {});
  };
  useEffect(() => {
    if (!user) return;
    authFetch('/api/preferenze')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.preferenze?.tema) applicaTema(d.preferenze.tema === 'scuro'); })
      .catch(() => {});
  }, [user?.username]);

  // Contacts deduplication and validation logic
  const evaluateContacts = (raw: Contact[]) => {
    const seen = new Set();
    return raw.map(c => {
      const numStr = normalizePhoneNumber(String(c.numero || ''));
      const k = numStr.replace(/\s/g, '');
      const inv = !isValidPhoneNumber(numStr);
      const dup = Boolean(k && seen.has(k));
      if (!dup && k) seen.add(k);
      return { ...c, numero: numStr, inv, dup };
    });
  };

  const updateManualContacts = (newContacts: Contact[]) => {
    setContacts(evaluateContacts(newContacts));
  };

  // Keep derived state clean
  const evaluated = evaluateContacts(contacts);
  const validContacts = evaluated.filter(c => !c.inv && !c.dup && String(c.nome || '').trim() && String(c.numero || '').trim());
  const invalidCount = evaluated.filter(c => c.inv).length;
  const duplicateCount = evaluated.filter(c => c.dup).length;

  const clearHistory = async () => {
    try {
      const res = await authFetch('/api/history', { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, error: data.error || `Errore HTTP ${res.status}` };
      setHistory([]);
      return { ok: true };
    } catch {
      return { ok: false, error: 'Errore di rete' };
    }
  };

  const saveList = async (name: string, contactsToSave: Contact[]) => {
    try {
      const res = await authFetch('/api/lists', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          contacts: contactsToSave.map(c => ({
            nome: c.nome, numero: c.numero,
            data_appuntamento: c.data_appuntamento, ora_appuntamento: c.ora_appuntamento, prestazione: c.prestazione,
          })),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) return { ok: false, error: data.error || `Errore HTTP ${res.status}` };
      setLists(prev => [data.list, ...prev]);
      return { ok: true };
    } catch {
      return { ok: false, error: 'Errore di rete' };
    }
  };

  const deleteList = async (id: string) => {
    try {
      const res = await authFetch(`/api/lists/${encodeURIComponent(id)}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, error: data.error || `Errore HTTP ${res.status}` };
      setLists(prev => prev.filter(l => l.id !== id));
      return { ok: true };
    } catch {
      return { ok: false, error: 'Errore di rete' };
    }
  };

  const loadList = (id: string) => {
    const list = lists.find(l => l.id === id);
    if (list) {
      setContacts(list.contacts);
      setUploadMode('manual');
    }
  };

  const loadVoicebots = async () => {
    try {
      const res = await authFetch('/api/voicebots');
      const data = await res.json();
      if (data.ok) {
        const active = data.voicebots.filter((v: Voicebot) => v.attivo);
        setVoicebots(active);
        // Auto-seleziona solo se non è ancora stato scelto nulla
        setSelectedVoicebot(prev => {
          if (prev) {
            // Mantieni la selezione corrente se il voicebot esiste ancora
            const stillExists = active.find((v: Voicebot) => v.id === prev.id);
            return stillExists || (active.length > 0 ? active[0] : null);
          }
          return active.length > 0 ? active[0] : null;
        });
      }
    } catch {}
  };


  // Filtered history
  const filteredHistory = history.filter(h => {
    if (historyFilter.operator && !h.opt.toLowerCase().includes(historyFilter.operator.toLowerCase())) return false;
    if (historyFilter.dateFrom && new Date(h.ts) < new Date(historyFilter.dateFrom)) return false;
    if (historyFilter.dateTo && new Date(h.ts) > new Date(historyFilter.dateTo + 'T23:59:59')) return false;
    if (historyFilter.search) {
      const s = historyFilter.search.toLowerCase();
      const matchOp = h.opt?.toLowerCase().includes(s);
      const matchNote = h.note?.toLowerCase().includes(s);
      const matchContacts = h.contactsList?.some(c => c.nome?.toLowerCase().includes(s) || c.numero?.includes(s));
      if (!matchOp && !matchNote && !matchContacts) return false;
    }
    return true;
  });

  // Export history to XLSX — foglio riepilogo + un foglio per campagna
  const exportHistoryToXLSX = () => {
    const wb = XLSX.utils.book_new();

    // Foglio 1: Riepilogo campagne
    const rows = filteredHistory.map((h, i) => ({
      '#': i + 1,
      Data: new Date(h.ts).toLocaleString('it-IT'),
      Operatore: h.opt,
      Chiamate: h.count,
      Simultanee: h.chunkSize,
      'Durata stimata (min)': Math.ceil((h.count / h.chunkSize) * 45 / 60),
      Modalità: h.scheduledAt ? 'Pianificata' : 'Immediata',
      'Ora Pianificata': h.scheduledAt ? new Date(h.scheduledAt).toLocaleString('it-IT') : '-',
      Note: h.note || '-',
      Contatti: h.contactsList?.length || h.count,
    }));
    const wsSummary = XLSX.utils.json_to_sheet(rows);
    wsSummary['!cols'] = [
      {wch:4},{wch:20},{wch:16},{wch:10},{wch:12},{wch:18},{wch:12},{wch:20},{wch:24},{wch:10}
    ];
    XLSX.utils.book_append_sheet(wb, wsSummary, 'Riepilogo');

    // Foglio 2+: Un foglio per ogni campagna con i contatti
    filteredHistory.forEach((h, i) => {
      if (!h.contactsList || h.contactsList.length === 0) return;
      const label = `${String(i+1).padStart(2,'0')}_${new Date(h.ts).toLocaleDateString('it-IT').replace(/\//g,'-')}`;
      const rows = h.contactsList.map(c => ({
        Nome: c.nome,
        Numero: c.numero,
        ...(c.data_appuntamento ? { 'Data Appuntamento': c.data_appuntamento } : {}),
        ...(c.ora_appuntamento ? { 'Ora Appuntamento': c.ora_appuntamento } : {}),
        ...(c.prestazione ? { Prestazione: c.prestazione } : {}),
      }));
      const ws = XLSX.utils.json_to_sheet(rows);
      ws['!cols'] = [{wch:20},{wch:18},{wch:18},{wch:16},{wch:22}];
      XLSX.utils.book_append_sheet(wb, ws, label.slice(0, 31));
    });

    XLSX.writeFile(wb, `Storico_Campagne_${new Date().toLocaleDateString('it-IT').replace(/\//g, '-')}.xlsx`);
  };

  const SUPPORT_HINT = ' — Vai in Assistenza per aprire un ticket.';

  // Test single call
  const testSingleCall = async (contact: Contact) => {
    setTestStatus({ type: 'load', msg: `Test chiamata a ${contact.nome} (${contact.numero})...` });
    try {
      // La chiamata passa dal server (che conosce l'URL Make), non più dal browser.
      const res = await authFetch('/api/campaigns/test-call', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contact: { nome: contact.nome, numero: contact.numero } })
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.dryRun) { setTestStatus({ type: 'ok', msg: `✓ [TEST] Chiamata simulata verso ${contact.nome} — nessuna chiamata reale` }); }
      else if (res.ok) setTestStatus({ type: 'ok', msg: `✓ Chiamata test inviata a ${contact.nome}` });
      else setTestStatus({ type: 'err', msg: `Errore HTTP ${res.status}${SUPPORT_HINT}` });
    } catch(e: any) {
      setTestStatus({ type: 'err', msg: 'Errore di rete: ' + e.message + SUPPORT_HINT });
    }
    setTimeout(() => setTestStatus({ type: 'idle', msg: '' }), 5000);
  };

  const launchCampaign = async () => {
    if (!validContacts.length) return;

    let targetAt: string | null = null;
    if (scheduleMode === 'later') {
      if (!scheduledAt) { setLaunchStatus({ type: 'err', msg: 'Seleziona data e ora' }); return; }
      const target = new Date(scheduledAt);
      if (target <= new Date()) { setLaunchStatus({ type: 'err', msg: 'Seleziona un orario futuro' }); return; }
      targetAt = target.toISOString();
    }

    // Fuori dagli orari consentiti: con la coda del sito la campagna parte
    // all'apertura; con il vecchio invio non si può lanciare.
    const momento = targetAt ? new Date(targetAt) : new Date();
    if (!appConfig.codaSito && !dentroOrari(appConfig.orari, momento)) {
      const ap = prossimaApertura(appConfig.orari, momento);
      setLaunchStatus({ type: 'err', msg: `${targetAt ? "L'orario scelto è" : 'Adesso è'} fuori dagli orari consentiti${ap ? `: si può chiamare da ${quandoBreve(ap)}` : ''}.` });
      return;
    }

    setIsLaunching(true);
    setLaunchStatus({ type: 'load', msg: `Preparazione invio di ${validContacts.length} contatti...` });

    try {
      // Il server valida i dati, inoltra a Make e invia l'email di riepilogo.
      // Così gli URL dei webhook non sono più visibili nel browser.
      const res = await authFetch('/api/campaigns/launch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contatti: validContacts.map(c => ({
            nome: c.nome,
            numero: c.numero,
            ...(campaignType === 'appuntamenti' && c.data_appuntamento ? { data_appuntamento: c.data_appuntamento } : {}),
            ...(campaignType === 'appuntamenti' && c.ora_appuntamento ? { ora_appuntamento: c.ora_appuntamento } : {}),
            ...(campaignType === 'appuntamenti' && c.prestazione ? { prestazione: c.prestazione } : {}),
          })),
          tipo_campagna: campaignType,
          scheduledAt: targetAt,
          note: campaignNote || undefined,
          voicebot_id: selectedVoicebot?.id,
          concurrency,
          richiamate: appConfig.codaSito ? richiamate : undefined,
        })
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok && !data.sent) {
        setLaunchStatus({ type: 'err', msg: (data.error || `Errore HTTP ${res.status}`) + SUPPORT_HINT });
        return;
      }

      const testPrefix = data.dryRun ? '[TEST — nessuna chiamata reale] ' : '';
      const esclusiMsg = data.esclusi > 0
        ? ` ${data.esclusi} ${data.esclusi === 1 ? 'numero è nella lista Non chiamare e non verrà chiamato' : 'numeri sono nella lista Non chiamare e non verranno chiamati'}.`
        : '';
      const attesaMsg = data.inAttesaFino
        ? ` Fuori dagli orari consentiti: le chiamate partiranno ${quandoBreve(new Date(data.inAttesaFino))}.`
        : '';

      if (data.scheduled) {
        loadHistory();
        setCampaignNote('');
        loadScheduledCampaigns();
        const quando = new Date(data.scheduledAt).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' });
        const comeParte = appConfig.timerAttivo ? 'Partirà da sola all\'orario.' : 'Partirà all\'orario se l\'app è aperta su almeno un dispositivo.';
        setLaunchStatus({ type: 'ok', msg: `${testPrefix}Campagna pianificata per ${quando} — ${validContacts.length} contatti. ${comeParte}${esclusiMsg}${attesaMsg}` });
        return;
      }
      if (data.sent > 0) {
        loadHistory();
        setCampaignNote('');
      }

      if (data.failed > 0) {
        // Lasciamo in lista solo i contatti NON inviati, così "Avvia" li
        // riprova senza richiamare chi è già stato inoltrato.
        const failedNumbers = new Set<string>((data.failedContacts || []).map((c: any) => c.numero));
        setContacts(validContacts.filter(c => failedNumbers.has(String(c.numero).replace(/[\s\-().]/g, ''))));
        setLaunchStatus({ type: 'err', msg: `${testPrefix}${data.sent} contatti inviati, ${data.failed} non inviati. In lista sono rimasti solo quelli da riprovare.${SUPPORT_HINT}` });
      } else if (data.sent === 0 && data.esclusi > 0) {
        setLaunchStatus({ type: 'err', msg: `Nessuna chiamata: tutti i numeri sono nella lista Non chiamare.` });
      } else {
        setLaunchStatus({ type: 'ok', msg: `${testPrefix}Campagna inviata — ${data.sent} chiamate in elaborazione.${esclusiMsg}${attesaMsg}` });
      }
    } catch(err: any) {
      setLaunchStatus({ type: 'err', msg: 'Errore di rete: ' + err.message + SUPPORT_HINT });
    } finally {
      setIsLaunching(false);
    }
  };

  return (
    <CampaignContext.Provider value={{
      user, setUser, login, verifyOtp, logout, updateProfile, enable2FA,
      contacts, setContacts, updateManualContacts, validContacts, invalidCount, duplicateCount,
      uploadMode, setUploadMode,
      scheduleMode, setScheduleMode, scheduledAt, setScheduledAt,
      concurrency, setConcurrency,
      isLaunching, launchStatus, launchCampaign,
      testSingleCall, testStatus,
      campaignNote, setCampaignNote,
      campaignType, setCampaignType,
      voicebots, selectedVoicebot, setSelectedVoicebot, loadVoicebots,
      richiamate, setRichiamate, maxConcurrency, avviaConContatti, reloadConfig,
      historyFilter, setHistoryFilter, filteredHistory, exportHistoryToXLSX,
      history, clearHistory, loadHistory, appConfig,
      scheduledCampaigns, loadScheduledCampaigns, cancelScheduledCampaign,
      lists, saveList, deleteList, loadList,
      darkMode, toggleTheme,
    }}>
      {children}
    </CampaignContext.Provider>
  );
}

export function useCampaign() {
  const ctx = useContext(CampaignContext);
  if (!ctx) throw new Error("useCampaign must be used within a CampaignProvider");
  return ctx;
}
