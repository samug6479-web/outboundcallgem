import React, { useState } from 'react';
import { useCampaign } from '../context/CampaignContext';
import { GemLogo } from './Icons';
import { LogOut, Sun, Moon, Plus, List, Clock, User, Headset, BarChart2, Users, Phone, Menu, X, ChevronRight, CalendarCheck, Check, ShieldAlert, Loader2, BellRing, UserCog, BookOpen, Radio, Bot, Ban, Settings } from 'lucide-react';
import { cn } from '../lib/utils';
import { authFetch } from '../lib/authFetch';
import { Step1Upload, Step2Preview, Step3Settings } from './CampaignSteps';
import { AppointmentPage } from './AppuntamentiSection';
import { LaunchSidebar } from './LaunchSidebar';
import { ContactLists } from './ContactLists';
import { AdminUsers } from './AdminUsers';
import { AdminVoicebots } from './AdminVoicebots';
import { SupportSection } from './SupportSection';
import { StatsDashboard } from './StatsDashboard';
import { ProfileSection } from './ProfileSection';
import { CallResultsSection } from './CallResultsSection';
import { FollowupsSection } from './FollowupsSection';
import { LiveSection } from './LiveSection';
import { ConfirmModal } from './ConfirmModal';
import { NonChiamareSection } from './NonChiamareSection';
import { ImpostazioniSection } from './ImpostazioniSection';
import { NotificheAvviso } from './NotificheAvviso';

type Tab = 'live' | 'campaign' | 'appointments' | 'lists' | 'dnc' | 'history' | 'callresults' | 'followups' | 'profile' | 'support' | 'stats' | 'users' | 'voicebots' | 'settings';

interface NavItem {
  id: Tab;
  label: string;
  icon: React.ElementType;
  adminOnly?: boolean;
  viewerHidden?: boolean;
  badge?: 'followups' | 'live';
}

interface NavGroup {
  label: string;
  items: NavItem[];
  adminOnly?: boolean;
  viewerOnly?: boolean;
}

// Menu diviso per scopo: preparare e lanciare, seguire le chiamate, analizzare,
// amministrare. Profilo e Assistenza stanno nella scheda utente in fondo.
const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Campagne',
    items: [
      { id: 'campaign' as Tab, label: 'Nuova Campagna', icon: Plus, viewerHidden: true },
      { id: 'appointments' as Tab, label: 'Conferma Appuntamenti', icon: CalendarCheck, viewerHidden: true },
      { id: 'lists' as Tab, label: 'Liste Salvate', icon: List, viewerHidden: true },
      { id: 'dnc' as Tab, label: 'Non chiamare', icon: Ban, viewerHidden: true },
    ]
  },
  {
    label: 'Monitoraggio',
    items: [
      { id: 'live' as Tab, label: 'In diretta', icon: Radio, viewerHidden: true, badge: 'live' },
      { id: 'callresults' as Tab, label: 'Esiti Chiamate', icon: Phone },
      { id: 'followups' as Tab, label: 'Follow-up', icon: BellRing, badge: 'followups' },
    ]
  },
  {
    label: 'Report',
    items: [
      { id: 'stats' as Tab, label: 'Statistiche', icon: BarChart2 },
      { id: 'history' as Tab, label: 'Storico Campagne', icon: Clock },
    ]
  },
  {
    label: 'Amministrazione',
    adminOnly: true,
    items: [
      { id: 'users' as Tab, label: 'Gestione Utenti', icon: Users, adminOnly: true },
      { id: 'voicebots' as Tab, label: 'Voicebot', icon: Bot, adminOnly: true },
      { id: 'settings' as Tab, label: 'Impostazioni', icon: Settings, adminOnly: true },
    ]
  },
];

const TAB_META: Record<Tab, { title: string; subtitle: string }> = {
  campaign: { title: 'Nuova Campagna', subtitle: 'Carica la lista contatti, definisci le tempistiche e avvia le chiamate sul centralino Wildix.' },
  appointments: { title: 'Conferma Appuntamenti', subtitle: 'Visualizza, importa e gestisci gli appuntamenti programmati per le campagne di richiamata.' },
  lists: { title: 'Liste Salvate', subtitle: 'Salva, gestisci o riutilizza le tue liste contatti precedentemente caricate.' },
  dnc: { title: 'Non chiamare', subtitle: 'Numeri che nessuna campagna chiama mai: chi lo ha chiesto, clienti attivi, numeri sbagliati.' },
  settings: { title: 'Impostazioni', subtitle: 'Orari in cui le campagne possono chiamare.' },
  history: { title: 'Storico Campagne', subtitle: 'Le campagne lanciate da tutti gli operatori, con i report da scaricare.' },
  live: { title: 'In diretta', subtitle: 'Le chiamate delle campagne in corso, aggiornate ogni pochi secondi.' },
  followups: { title: 'Follow-up', subtitle: 'Contatti da richiamare o gestire a mano: chiamate non risposte, rifiuti, disdette e trasferimenti.' },
  callresults: { title: 'Esiti Chiamate', subtitle: 'Esito, trascrizione e riassunto AI di ogni chiamata gestita dal voicebot.' },
  profile: { title: 'Il Mio Profilo', subtitle: 'Gestisci le tue informazioni di contatto e le impostazioni del tuo account.' },
  support: { title: 'Assistenza', subtitle: 'Invia una richiesta direttamente al nostro team tecnico o amministrativo.' },
  stats: { title: 'Statistiche', subtitle: 'Chiamate, risposte, follow-up e campagne per periodo, uguali su ogni dispositivo.' },
  users: { title: 'Gestione Utenti', subtitle: 'Gestisci accessi, ruoli e permessi per gli utenti della piattaforma.' },
  voicebots: { title: 'Gestione Voicebot', subtitle: 'Configura i voicebot disponibili sul centralino Wildix per le campagne.' },
};

function CampaignStepper() {
  const { contacts, validContacts, selectedVoicebot } = useCampaign();
  const steps = [
    { n: 1, label: 'Carica', done: contacts.length > 0 },
    { n: 2, label: 'Verifica', done: validContacts.length > 0 },
    { n: 3, label: 'Imposta', done: !!selectedVoicebot },
    { n: 4, label: 'Avvia', done: false },
  ];
  const current = steps.find(s => !s.done)?.n ?? 4;
  return (
    <div className="mb-8 flex items-center">
      {steps.map((s, i) => {
        const state = s.done ? 'done' : s.n === current ? 'current' : 'todo';
        return (
          <React.Fragment key={s.n}>
            <div className="flex items-center gap-2.5 shrink-0">
              <div className={cn(
                "w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold transition-colors",
                state === 'done' && "bg-brand-600 text-white",
                state === 'current' && "bg-brand-100 dark:bg-brand-900/40 text-brand-700 dark:text-brand-300 ring-2 ring-brand-500",
                state === 'todo' && "bg-slate-100 dark:bg-slate-800 text-slate-400"
              )}>
                {s.done ? <Check className="w-4 h-4" /> : s.n}
              </div>
              <span className={cn(
                "text-sm font-semibold hidden sm:block transition-colors",
                state === 'todo' ? "text-slate-400" : "text-slate-700 dark:text-slate-200"
              )}>{s.label}</span>
            </div>
            {i < steps.length - 1 && (
              <div className={cn("flex-1 h-0.5 mx-3 rounded-full transition-colors", s.done ? "bg-brand-500" : "bg-slate-200 dark:bg-slate-700")} />
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}

export function Dashboard() {
  const { user, darkMode, toggleTheme, logout, enable2FA, scheduledCampaigns, setCampaignType, appConfig } = useCampaign();
  const [confirmLogout, setConfirmLogout] = useState(false);
  const pendingScheduled = scheduledCampaigns.filter(c => c.status === 'pending').length;
  const isAdmin = user?.isAdmin || user?.role === 'Admin';
  const isViewer = user?.role === 'Viewer';
  // ?tab=... nell'indirizzo (es. il pulsante "Segui in diretta" dell'email)
  // ha la precedenza sulla scheda ricordata. I Viewer non aprono pagine a loro nascoste.
  const urlTab = new URLSearchParams(window.location.search).get('tab') as Tab | null;
  const viewerHiddenTabs: Tab[] = ['campaign', 'appointments', 'lists', 'live', 'dnc'];
  const linkTab = urlTab && urlTab in TAB_META && !(isViewer && viewerHiddenTabs.includes(urlTab)) ? urlTab : null;
  const savedTab = sessionStorage.getItem('gem_active_tab') as Tab | null;
  const [activeTab, setActiveTab] = useState<Tab>(linkTab || savedTab || (isViewer ? 'callresults' : 'campaign'));

  // Tolto ?tab= dall'indirizzo dopo l'apertura, così un ricaricamento non lo riapplica.
  React.useEffect(() => {
    if (urlTab) window.history.replaceState(null, '', window.location.pathname + window.location.hash);
  }, []);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [show2FABanner, setShow2FABanner] = useState(false);
  const [enabling2FA, setEnabling2FA] = useState(false);

  // Il valore di user.twoFactorEnabled può arrivare un istante dopo il mount
  // (viene rinfrescato dal server per evitare di fidarsi di una sessione
  // salvata potenzialmente non aggiornata), quindi il banner va ricalcolato
  // ogni volta che cambia, non solo alla prima render.
  React.useEffect(() => {
    if (user && !user.twoFactorEnabled && sessionStorage.getItem('gem_2fa_banner_dismissed') !== '1') {
      setShow2FABanner(true);
    } else if (user?.twoFactorEnabled) {
      setShow2FABanner(false);
    }
  }, [user?.twoFactorEnabled]);

  // Avviso profilo incompleto: l'email serve per i riepiloghi delle campagne,
  // email e telefono per le richieste di assistenza. Sparisce da solo appena
  // il profilo è completo; la X lo nasconde finché la scheda resta aperta.
  const [profileBannerDismissed, setProfileBannerDismissed] = useState(
    () => sessionStorage.getItem('gem_profile_banner_dismissed') === '1'
  );
  const missingProfile = [
    !user?.email?.trim() && 'email',
    !user?.telefono?.trim() && 'numero di telefono',
  ].filter(Boolean) as string[];
  const showProfileBanner = !!user && missingProfile.length > 0 && !profileBannerDismissed && activeTab !== 'profile';
  const dismissProfileBanner = () => {
    sessionStorage.setItem('gem_profile_banner_dismissed', '1');
    setProfileBannerDismissed(true);
  };

  const dismiss2FABanner = () => {
    sessionStorage.setItem('gem_2fa_banner_dismissed', '1');
    setShow2FABanner(false);
  };

  const handleEnable2FA = async () => {
    setEnabling2FA(true);
    const res = await enable2FA();
    if (!res.ok) {
      setEnabling2FA(false);
      alert(res.error || 'Errore durante l\'attivazione del 2FA');
    }
    // Se ok, enable2FA() esegue già il logout: si torna alla schermata di
    // login, dove al prossimo accesso comparirà il QR per il setup.
  };

  const handleNav = (tab: Tab) => {
    setActiveTab(tab);
    sessionStorage.setItem('gem_active_tab', tab);
    setSidebarOpen(false);
  };

  // Ascolta navigazione da altri componenti (es. link "Vai in Assistenza")
  React.useEffect(() => {
    const handler = (e: Event) => handleNav((e as CustomEvent).detail as Tab);
    window.addEventListener('gem:nav', handler);
    return () => window.removeEventListener('gem:nav', handler);
  }, []);

  // Il tipo di campagna è condiviso tra le pagine: "Conferma Appuntamenti" lo
  // imposta su appuntamenti, quindi tornando su "Nuova Campagna" va rimesso a
  // standard. Altrimenti una lista normale parte verso lo scenario appuntamenti.
  React.useEffect(() => {
    if (activeTab === 'campaign') setCampaignType('standard');
  }, [activeTab]);

  // Contatori del menu: follow-up da gestire e campagne in corso (In diretta).
  // Aggiornati ogni minuto e quando si cambia pagina.
  const [followupCount, setFollowupCount] = useState(0);
  const [liveActive, setLiveActive] = useState(false);
  React.useEffect(() => {
    let stopped = false;
    const refresh = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const r = await authFetch('/api/followups?stato=pending');
        const d = await r.json();
        if (!stopped && r.ok && d.ok) setFollowupCount((d.followups || []).length);
      } catch { /* il contatore è solo un aiuto: si riprova al prossimo giro */ }
      if (isViewer) return;
      try {
        const r = await authFetch('/api/live?hours=12');
        const d = await r.json();
        if (!stopped && r.ok && d.ok) setLiveActive((d.campaigns || []).some((c: any) => c.in_coda > 0 || c.avviate > 0));
      } catch { /* come sopra */ }
    };
    refresh();
    const t = window.setInterval(refresh, 60000);
    return () => { stopped = true; window.clearInterval(t); };
  }, [activeTab, isViewer]);

  // Titolo pagina dinamico
  React.useEffect(() => {
    const meta = TAB_META[activeTab];
    document.title = meta ? `${meta.title} | GEM Outbound` : 'GEM Outbound';
  }, [activeTab]);

  // Shortcut tastiera: Esc chiude sidebar mobile
  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSidebarOpen(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const meta = TAB_META[activeTab];

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 flex transition-colors duration-200" style={{minHeight:'100dvh'}}>

      {/* SIDEBAR */}
      <>
        {/* Mobile overlay */}
        {sidebarOpen && (
          <div className="fixed inset-0 z-40 bg-black/50 lg:hidden" onClick={() => setSidebarOpen(false)} />
        )}

        <aside className={cn(
          "fixed top-0 left-0 h-full z-50 bg-white dark:bg-slate-900 border-r border-slate-200 dark:border-slate-800 flex flex-col transition-transform duration-300 shadow-xl lg:shadow-none",
          "lg:sticky lg:translate-x-0",
          sidebarOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0"
        )} style={{width: 'clamp(220px, 16vw, 260px)', minHeight: '100dvh'}}>
          {/* Logo */}
          <div className="flex items-center justify-between px-5 h-16 border-b border-slate-200 dark:border-slate-800 shrink-0">
            <GemLogo className="w-28 text-slate-900 dark:text-white" />
            <button onClick={() => setSidebarOpen(false)} className="lg:hidden text-slate-400 hover:text-slate-700 dark:hover:text-white">
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Nav groups */}
          <nav className="flex-1 overflow-y-auto py-4 px-3 space-y-6">
            {NAV_GROUPS.map(group => {
              if (group.adminOnly && !isAdmin) return null;
              if (group.viewerOnly && !isViewer) return null;
              const visibleItems = group.items.filter(item => {
                if (item.adminOnly && !isAdmin) return false;
                if (item.viewerHidden && isViewer) return false;
                return true;
              });
              if (!visibleItems.length) return null;
              return (
                <div key={group.label}>
                  <div className="text-[10px] font-bold text-slate-400 uppercase tracking-widest px-3 mb-2">{group.label}</div>
                  <div className="space-y-0.5">
                    {visibleItems.map(item => {
                      const Icon = item.icon;
                      const active = activeTab === item.id;
                      return (
                        <button
                          key={item.id}
                          onClick={() => handleNav(item.id)}
                          className={cn(
                            "w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-semibold transition-all text-left",
                            active
                              ? "bg-brand-600 text-white shadow-sm"
                              : "text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-white"
                          )}
                        >
                          <Icon className="w-4 h-4 shrink-0" />
                          <span className="flex-1">{item.label}</span>
                          {item.badge === 'followups' && followupCount > 0 && (
                            <span className={cn('min-w-5 h-5 px-1.5 rounded-full text-[11px] font-bold flex items-center justify-center tabular-nums',
                              active ? 'bg-white/20 text-white' : 'bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-300')}
                              title={`${followupCount} da gestire`}>
                              {followupCount > 99 ? '99+' : followupCount}
                            </span>
                          )}
                          {item.badge === 'live' && liveActive && (
                            <span className="relative flex h-2 w-2" title="Campagna in corso">
                              <span className="absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75 animate-ping" />
                              <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
                            </span>
                          )}
                          {active && !item.badge && <ChevronRight className="w-3.5 h-3.5 opacity-70" />}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </nav>

          {/* Account: scheda utente (apre il profilo) e azioni */}
          <div className="border-t border-slate-200 dark:border-slate-800 p-3 shrink-0 space-y-2">
            <button
              onClick={() => handleNav('profile')}
              title="Il mio profilo"
              className={cn(
                "w-full flex items-center gap-3 px-3 py-2 rounded-xl text-left transition-colors",
                activeTab === 'profile' ? "bg-brand-50 dark:bg-brand-500/15 ring-1 ring-brand-200 dark:ring-brand-500/30" : "bg-slate-50 dark:bg-slate-800/50 hover:bg-slate-100 dark:hover:bg-slate-800"
              )}
            >
              <div className="w-8 h-8 rounded-full bg-brand-100 dark:bg-brand-500/25 flex items-center justify-center text-xs font-bold text-brand-700 dark:text-brand-200 uppercase shrink-0">
                {user?.nome?.charAt(0)}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold text-slate-900 dark:text-white truncate">{user?.nome}</div>
                <div className="text-xs text-slate-500 truncate">{user?.role || 'Editor'} · Profilo</div>
              </div>
              <ChevronRight className="w-3.5 h-3.5 text-slate-400 shrink-0" />
            </button>
            <div className="grid grid-cols-3 gap-1">
              {/* Guida utente in PDF (file in public/) */}
              <a
                href="/guida-gem-outbound.pdf?v=2026-10-23h"
                download="GEM-Outbound-Guida-utente.pdf"
                title="Scarica la guida utente (PDF)"
                className="flex flex-col items-center justify-center gap-1 py-2 text-[11px] font-semibold text-slate-500 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-colors"
              >
                <BookOpen className="w-3.5 h-3.5" />
                Guida
              </a>
              <button
                onClick={toggleTheme}
                title={darkMode ? 'Passa al tema chiaro' : 'Passa al tema scuro'}
                className="flex flex-col items-center justify-center gap-1 py-2 text-[11px] font-semibold text-slate-500 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-colors"
              >
                {darkMode ? <Sun className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
                {darkMode ? 'Chiaro' : 'Scuro'}
              </button>
              <button
                onClick={() => setConfirmLogout(true)}
                className="flex flex-col items-center justify-center gap-1 py-2 text-[11px] font-semibold text-slate-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition-colors"
              >
                <LogOut className="w-3.5 h-3.5" />
                Esci
              </button>
            </div>
          </div>
        </aside>

        <ConfirmModal
          open={confirmLogout}
          title="Vuoi uscire?"
          message={pendingScheduled > 0 && !appConfig.timerAttivo
            ? (pendingScheduled === 1
              ? "Hai 1 campagna pianificata in attesa: parte all'orario solo se l'app è aperta su almeno un dispositivo."
              : `Hai ${pendingScheduled} campagne pianificate in attesa: partono all'orario solo se l'app è aperta su almeno un dispositivo.`)
            : 'Dovrai rifare il login per rientrare.'}
          confirmLabel="Esci"
          cancelLabel="Annulla"
          variant="warning"
          onConfirm={() => { setConfirmLogout(false); logout(); }}
          onCancel={() => setConfirmLogout(false)}
        />
      </>

      {/* MAIN */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Mobile topbar */}
        <header className="lg:hidden sticky top-0 z-30 flex items-center justify-between h-14 px-4 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 shadow-sm">
          <button onClick={() => setSidebarOpen(true)} className="text-slate-500 hover:text-slate-900 dark:hover:text-white">
            <Menu className="w-5 h-5" />
          </button>
          <GemLogo className="w-24 text-slate-900 dark:text-white" />
          <div className="w-8 h-8 rounded-full bg-brand-100 dark:bg-brand-500/25 flex items-center justify-center text-xs font-bold text-brand-700 dark:text-brand-200 uppercase">
            {user?.nome?.charAt(0)}
          </div>
        </header>

        {/* Page header */}
        <div className="px-6 lg:px-10 pt-8 pb-6 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-2xl lg:text-3xl font-bold tracking-tight text-slate-900 dark:text-white">
              {meta.title}
            </h1>
            <p className="text-sm text-slate-500 dark:text-slate-400 mt-1 max-w-2xl">{meta.subtitle}</p>
          </div>
          {/* Assistenza: sempre a portata di mano, in alto a destra (in basso a destra c'è il Kite) */}
          <button
            onClick={() => handleNav('support')}
            title="Serve aiuto? Scrivi all'assistenza"
            aria-label="Assistenza"
            className={cn(
              "shrink-0 flex items-center gap-2 px-3 sm:px-4 py-2 rounded-xl text-sm font-semibold border transition-colors",
              activeTab === 'support'
                ? "bg-brand-600 border-brand-600 text-white dark:bg-brand-500 dark:border-brand-500"
                : "border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:border-brand-300 hover:text-brand-700 hover:bg-brand-50 dark:hover:bg-brand-500/15 dark:hover:text-white"
            )}
          >
            <Headset className="w-4 h-4" />
            <span className="hidden sm:inline">Assistenza</span>
          </button>
        </div>

        {/* Content */}
        <main className="flex-1 px-6 lg:px-10 py-8">

          {show2FABanner && (
            <div className="mb-6 flex items-start gap-3 p-4 rounded-2xl border border-amber-200 dark:border-amber-800/50 bg-amber-50 dark:bg-amber-900/10 animate-in fade-in slide-in-from-top-2">
              <ShieldAlert className="w-5 h-5 text-amber-500 mt-0.5 shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-slate-900 dark:text-white">Il tuo account non ha l'autenticazione a due fattori attiva</p>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">Ti consigliamo di attivarla per proteggere meglio il tuo accesso. Ti verrà richiesto di rifare il login per completare la configurazione.</p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={handleEnable2FA}
                  disabled={enabling2FA}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-500 hover:bg-amber-600 text-white text-xs font-bold rounded-lg transition-colors disabled:opacity-70"
                >
                  {enabling2FA && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  {enabling2FA ? 'Attivazione...' : 'Attiva ora'}
                </button>
                <button onClick={dismiss2FABanner} className="p-1.5 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 rounded-lg transition-colors">
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}

          <NotificheAvviso onApriFollowup={() => {
            try { sessionStorage.setItem('gem_followups_miei', '1'); } catch { /* niente */ }
            window.dispatchEvent(new Event('gem:followups-miei'));
            handleNav('followups');
          }} />

          {showProfileBanner && (
            <div className="mb-6 flex items-start gap-3 p-4 rounded-2xl border border-amber-200 dark:border-amber-800/50 bg-amber-50 dark:bg-amber-900/10 animate-in fade-in slide-in-from-top-2">
              <UserCog className="w-5 h-5 text-amber-500 mt-0.5 shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-slate-900 dark:text-white">Completa il tuo profilo: {missingProfile.length > 1 ? 'mancano' : 'manca'} {missingProfile.join(' e ')}</p>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">All'email arrivano i riepiloghi delle tue campagne; email e telefono servono anche per le richieste di assistenza.</p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={() => handleNav('profile')}
                  className="px-3 py-1.5 bg-amber-500 hover:bg-amber-600 text-white text-xs font-bold rounded-lg transition-colors"
                >
                  Completa profilo
                </button>
                <button onClick={dismissProfileBanner} aria-label="Nascondi avviso" className="p-1.5 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 rounded-lg transition-colors">
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}

          {activeTab === 'campaign' && !isViewer && (
            <div className="animate-in fade-in slide-in-from-bottom-4 duration-300">
              <CampaignStepper />
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 items-start">
                <div className="space-y-6 lg:col-span-2">
                  <Step1Upload />
                  <Step2Preview />
                  <Step3Settings />
                </div>
                <div className="lg:col-span-1 lg:border-l border-slate-200 dark:border-slate-800/50 lg:pl-8">
                  <LaunchSidebar mode="launch" />
                </div>
              </div>
            </div>
          )}

          {activeTab === 'appointments' && !isViewer && (
            <AppointmentPage />
          )}

          {activeTab === 'lists' && !isViewer && (
            <div className="animate-in fade-in slide-in-from-bottom-4 duration-300">
              <ContactLists onSelectProcess={() => handleNav('campaign')} />
            </div>
          )}

          {activeTab === 'history' && (
            <div className="max-w-3xl animate-in fade-in slide-in-from-bottom-4 duration-300">
              <LaunchSidebar mode="history" />
            </div>
          )}

          {activeTab === 'callresults' && (
            <CallResultsSection />
          )}

          {activeTab === 'followups' && (
            <FollowupsSection />
          )}

          {activeTab === 'live' && !isViewer && (
            <LiveSection />
          )}

          {activeTab === 'profile' && (
            <div className="animate-in fade-in slide-in-from-bottom-4 duration-300">
              <ProfileSection />
            </div>
          )}

          {activeTab === 'support' && (
            <div className="animate-in fade-in slide-in-from-bottom-4 duration-300">
              <SupportSection />
            </div>
          )}

          {activeTab === 'stats' && (
            <div className="animate-in fade-in slide-in-from-bottom-4 duration-300">
              <StatsDashboard />
            </div>
          )}

          {activeTab === 'users' && isAdmin && (
            <div className="animate-in fade-in slide-in-from-bottom-4 duration-300">
              <AdminUsers />
            </div>
          )}

          {activeTab === 'dnc' && !isViewer && (
            <NonChiamareSection />
          )}

          {activeTab === 'settings' && isAdmin && (
            <ImpostazioniSection />
          )}

          {activeTab === 'voicebots' && isAdmin && (
            <div className="animate-in fade-in slide-in-from-bottom-4 duration-300">
              <AdminVoicebots />
            </div>
          )}

        </main>
      </div>
    </div>
  );
}
