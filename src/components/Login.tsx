import React, { useEffect, useState } from 'react';
import { useCampaign } from '../context/CampaignContext';
import { GemLogo } from './Icons';
import { LogIn, Loader2, AlertCircle, KeyRound, ArrowLeft, CheckCircle2 } from 'lucide-react';
import { cn } from '../lib/utils';

export function Login() {
  const { login, verifyOtp, setUser } = useCampaign();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [otp, setOtp] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  
  const [isOtpStep, setIsOtpStep] = useState(false);
  const [setup2FA, setSetup2FA] = useState(false);
  const [qrUrl, setQrUrl] = useState('');
  const [otpToken, setOtpToken] = useState('');

  // Invito: ?invito=... nell'indirizzo (link dell'email). Si sceglie la password.
  const [invito, setInvito] = useState(() => new URLSearchParams(window.location.search).get('invito') || '');
  const [invitato, setInvitato] = useState<{ nome: string; username: string; tipo?: string } | null>(null);
  // Password dimenticata
  const [dimenticata, setDimenticata] = useState(false);
  const [chi, setChi] = useState('');
  const [pw2, setPw2] = useState('');
  const [fatto, setFatto] = useState('');
  useEffect(() => {
    if (!invito) return;
    setLoading(true);
    fetch(`/api/invito/${encodeURIComponent(invito)}`).then(r => r.json())
      .then(d => { if (d?.ok) setInvitato({ nome: d.nome, username: d.username, tipo: d.tipo }); else setError(d?.error || 'Link non valido o scaduto.'); })
      .catch(() => setError('Errore di rete'))
      .finally(() => setLoading(false));
  }, [invito]);
  const lasciaInvito = () => {
    window.history.replaceState(null, '', window.location.pathname);
    setInvito(''); setInvitato(null); setPassword(''); setPw2('');
  };
  const chiediReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(''); setFatto('');
    if (!chi.trim()) { setError('Scrivi la tua email o il nome utente.'); return; }
    setLoading(true);
    try {
      const res = await fetch('/api/password-dimenticata', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chi: chi.trim() }) });
      const d = await res.json().catch(() => ({}));
      if (!res.ok || !d.ok) throw new Error(d.error || 'Non riuscito');
      setDimenticata(false);
      setFatto(d.messaggio);
    } catch (err: any) {
      setError(err?.message || 'Errore di rete');
    }
    setLoading(false);
  };

  const confermaInvito = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (password.length < 8) { setError('La password deve avere almeno 8 caratteri.'); return; }
    if (password !== pw2) { setError('Le due password non coincidono.'); return; }
    setLoading(true);
    try {
      const res = await fetch('/api/invito', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: invito, password }) });
      const d = await res.json().catch(() => ({}));
      if (!res.ok || !d.ok) throw new Error(d.error || 'Non riuscito');
      const u = d.username || invitato?.username || '';
      lasciaInvito();
      setUsername(u);
      setFatto('Password impostata. Ora accedi con il tuo nome utente e la nuova password.');
    } catch (err: any) {
      setError(err?.message || 'Errore di rete');
    }
    setLoading(false);
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username || !password) {
      setError('Inserisci username e password');
      return;
    }
    
    setLoading(true);
    setError('');
    const res = await login(username, password);
    setLoading(false);
    
    if (res && res.requires2FA) {
      setIsOtpStep(true);
      setSetup2FA(res.setup2FA);
      setQrUrl(res.qrUrl);
      setOtpToken(res.otpToken || '');
      setError('');
    } else if (res && res.ok) {
      const loggedUser = { username: res.username, nome: res.nome, role: res.role, isAdmin: res.isAdmin, canSchedule: res.canSchedule, email: res.email || '', telefono: res.telefono || '', twoFactorEnabled: res.twoFactorEnabled, twoFactorRequired: res.twoFactorRequired,
        soloPropriFollowup: res.soloPropriFollowup === true, puoEsportare: res.puoEsportare !== false, limiteNumeri: res.limiteNumeri ?? null,
        azienda: res.azienda, aziendaNome: res.aziendaNome, superAdmin: res.superAdmin === true };
      setUser(loggedUser);
      sessionStorage.setItem('gem_session', JSON.stringify(loggedUser));
      if (res.token) sessionStorage.setItem('gem_token', res.token);
    } else {
      setError(res?.error || 'Credenziali non valide');
    }
  };

  const handleVerifyOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!otp) {
      setError('Inserisci il codice OTP');
      return;
    }

    setLoading(true);
    setError('');
    const res = await verifyOtp(username, otp, otpToken);
    setLoading(false);

    if (!res || !res.ok) {
      setError(res?.error || 'Codice OTP non valido o scaduto');
    }
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-slate-100 dark:bg-slate-950 relative overflow-hidden px-4 transition-colors">
      {/* Decorative Minimal Background */}
      <div className="absolute inset-0 z-0">
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-full max-w-4xl h-[400px] bg-slate-200/50 dark:bg-slate-900/50 blur-[100px] rounded-full pointer-events-none"></div>
      </div>

      <div className="bg-white/80 dark:bg-slate-900/80 backdrop-blur-xl rounded-2xl p-10 w-full max-w-[420px] shadow-soft relative z-10 border border-slate-200/50 dark:border-slate-800/50">
        <div className="flex justify-center mb-10">
          <GemLogo className="w-40 text-slate-900 dark:text-white" />
        </div>

        <div className="text-center mb-8">
          <h1 className="text-2xl font-bold font-serif text-slate-900 dark:text-white mb-2 tracking-tight">Accesso Sistema</h1>
          <p className="text-sm font-medium text-slate-500 uppercase tracking-widest">{invito ? 'Scegli la tua password' : dimenticata ? 'Password dimenticata' : isOtpStep ? 'Verifica in due passaggi' : 'Campagne Outbound'}</p>
        </div>

        {fatto && !invito && (
          <div className="mb-5 p-3 bg-green-50 dark:bg-green-900/20 text-green-800 dark:text-green-300 border border-green-100 dark:border-green-900/50 rounded-xl text-xs font-medium flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 shrink-0" /><span>{fatto}</span>
          </div>
        )}
        {invito ? (
          <form onSubmit={confermaInvito} className="space-y-5 animate-in fade-in duration-300">
            {invitato ? (
              <>
                <p className="text-sm text-slate-600 dark:text-slate-300 text-center">
                  {invitato.tipo === 'reset' ? 'Scegli la nuova password per ' : 'Ciao '}<strong>{invitato.nome}</strong>{invitato.tipo === 'reset' ? '.' : ','} {invitato.tipo === 'reset' ? 'Nome utente:' : 'il tuo nome utente è'} <strong className="font-mono">{invitato.username}</strong>. Scegli una password di almeno 8 caratteri.
                </p>
                <div className="space-y-2">
                  <label htmlFor="inv-pw" className="block text-xs font-bold text-slate-500 uppercase tracking-wider">Nuova password</label>
                  <input id="inv-pw" type="password" autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)}
                    className="w-full px-4 py-3.5 bg-slate-50 dark:bg-slate-950/50 border border-slate-200 dark:border-slate-800 rounded-xl text-sm focus:outline-none focus:ring-1 focus:ring-slate-900 dark:focus:ring-slate-100 text-slate-900 dark:text-slate-100" />
                </div>
                <div className="space-y-2">
                  <label htmlFor="inv-pw2" className="block text-xs font-bold text-slate-500 uppercase tracking-wider">Ripeti la password</label>
                  <input id="inv-pw2" type="password" autoComplete="new-password" value={pw2} onChange={e => setPw2(e.target.value)}
                    className="w-full px-4 py-3.5 bg-slate-50 dark:bg-slate-950/50 border border-slate-200 dark:border-slate-800 rounded-xl text-sm focus:outline-none focus:ring-1 focus:ring-slate-900 dark:focus:ring-slate-100 text-slate-900 dark:text-slate-100" />
                </div>
                <button type="submit" disabled={loading}
                  className={cn("w-full py-4 bg-slate-900 dark:bg-brand-500 text-white font-bold rounded-xl text-sm shadow-md flex items-center justify-center gap-2", loading && "opacity-70 pointer-events-none")}>
                  {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : <KeyRound className="w-5 h-5" />} Salva la password
                </button>
              </>
            ) : loading ? (
              <div className="flex justify-center py-6 text-slate-400"><Loader2 className="w-6 h-6 animate-spin" /></div>
            ) : null}
            <button type="button" onClick={() => { lasciaInvito(); setError(''); }}
              className="w-full flex items-center justify-center gap-2 text-sm font-bold text-slate-500 hover:text-slate-800 dark:hover:text-slate-200">
              <ArrowLeft className="w-4 h-4" /> Vai all'accesso
            </button>
          </form>
        ) : dimenticata ? (
          <form onSubmit={chiediReset} className="space-y-5 animate-in fade-in duration-300">
            <p className="text-sm text-slate-600 dark:text-slate-300 text-center">Scrivi la tua email o il nome utente: ti mandiamo un link per scegliere una nuova password.</p>
            <div className="space-y-2">
              <label htmlFor="pd-chi" className="block text-xs font-bold text-slate-500 uppercase tracking-wider">Email o nome utente</label>
              <input id="pd-chi" type="text" autoComplete="username" value={chi} onChange={e => setChi(e.target.value)} autoFocus
                className="w-full px-4 py-3.5 bg-slate-50 dark:bg-slate-950/50 border border-slate-200 dark:border-slate-800 rounded-xl text-sm focus:outline-none focus:ring-1 focus:ring-slate-900 dark:focus:ring-slate-100 text-slate-900 dark:text-slate-100" />
            </div>
            <button type="submit" disabled={loading}
              className={cn("w-full py-4 bg-slate-900 dark:bg-brand-500 text-white font-bold rounded-xl text-sm shadow-md flex items-center justify-center gap-2", loading && "opacity-70 pointer-events-none")}>
              {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : <KeyRound className="w-5 h-5" />} Mandami il link
            </button>
            <button type="button" onClick={() => { setDimenticata(false); setError(''); }}
              className="w-full flex items-center justify-center gap-2 text-sm font-bold text-slate-500 hover:text-slate-800 dark:hover:text-slate-200">
              <ArrowLeft className="w-4 h-4" /> Torna all'accesso
            </button>
          </form>
        ) : isOtpStep ? (
          <form onSubmit={handleVerifyOtp} className="space-y-6 animate-in fade-in slide-in-from-right-4 duration-300">
            {setup2FA ? (
              <div className="bg-brand-50 dark:bg-brand-900/20 border border-brand-100 dark:border-brand-800/50 p-6 rounded-xl text-center mb-6 flex flex-col items-center">
                <p className="text-sm font-bold text-slate-800 dark:text-slate-200 mb-4">
                  Configurazione 2FA Iniziale
                </p>
                <p className="text-sm text-slate-600 dark:text-slate-400 mb-4">
                  Scansiona questo codice QR con la tua app Authenticator (es. Google Authenticator, Authy).
                </p>
                {qrUrl && (
                  <div className="bg-white p-3 rounded-xl mb-4 shadow-sm inline-block">
                    <img src={qrUrl} alt="QR Code per Authenticator" className="w-48 h-48 mx-auto" />
                  </div>
                )}
              </div>
            ) : (
              <div className="bg-brand-50 dark:bg-brand-900/20 border border-brand-100 dark:border-brand-800/50 p-4 rounded-xl text-center mb-6">
                <KeyRound className="w-8 h-8 text-brand-500 mx-auto mb-2" />
                <p className="text-sm font-medium text-slate-700 dark:text-slate-300">
                  Inserisci il codice generato dalla tua app Authenticator.
                </p>
              </div>
            )}

            <div className="space-y-2">
              <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider text-center">Codice OTP</label>
              <input 
                type="text" 
                maxLength={6}
                className="w-full px-4 py-4 bg-slate-50 dark:bg-slate-950/50 border border-slate-200 dark:border-slate-800 rounded-xl text-2xl tracking-[0.5em] text-center font-mono font-bold focus:outline-none focus:ring-1 focus:ring-slate-900 dark:focus:ring-slate-100 focus:border-slate-900 dark:focus:border-slate-100 text-slate-900 dark:text-slate-100 placeholder:text-slate-300 transition-all duration-200"
                placeholder="000000"
                value={otp}
                onChange={e => setOtp(e.target.value.replace(/\D/g, ''))}
              />
            </div>

            <button 
              type="submit" 
              disabled={loading || otp.length !== 6}
              className={cn(
                "w-full py-4 mt-2 bg-slate-900 dark:bg-brand-500 text-white dark:text-white font-bold rounded-xl text-sm shadow-md transition-all duration-200 flex items-center justify-center gap-2",
                "hover:shadow-lg hover:-translate-y-0.5 active:translate-y-0",
                (loading || otp.length !== 6) && "opacity-70 pointer-events-none"
              )}
            >
              {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : <LogIn className="w-5 h-5" />}
              {loading ? "Verifica in corso..." : "Verifica e Accedi"}
            </button>
            
            <button 
              type="button" 
              onClick={() => { setIsOtpStep(false); setOtp(''); setError(''); setSetup2FA(false); setQrUrl(''); }}
              className="w-full mt-4 flex items-center justify-center gap-2 text-sm font-bold text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 transition-colors"
            >
              <ArrowLeft className="w-4 h-4" /> Torna al login
            </button>
          </form>
        ) : (
          <form onSubmit={handleLogin} className="space-y-6 animate-in fade-in slide-in-from-left-4 duration-300">
            <div className="space-y-2">
              <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider">Username</label>
              <input 
                type="text" 
                className="w-full px-4 py-3.5 bg-slate-50 dark:bg-slate-950/50 border border-slate-200 dark:border-slate-800 rounded-xl text-sm focus:outline-none focus:ring-1 focus:ring-slate-900 dark:focus:ring-slate-100 focus:border-slate-900 dark:focus:border-slate-100 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 transition-all duration-200"
                placeholder="Il tuo username"
                value={username}
                onChange={e => setUsername(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider">Password</label>
              <input 
                type="password" 
                className="w-full px-4 py-3.5 bg-slate-50 dark:bg-slate-950/50 border border-slate-200 dark:border-slate-800 rounded-xl text-sm focus:outline-none focus:ring-1 focus:ring-slate-900 dark:focus:ring-slate-100 focus:border-slate-900 dark:focus:border-slate-100 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 transition-all duration-200"
                placeholder="••••••••"
                value={password}
                onChange={e => setPassword(e.target.value)}
              />
            </div>

            <button 
              type="submit" 
              disabled={loading}
              className={cn(
                "w-full py-4 mt-2 bg-slate-900 dark:bg-brand-500 text-white dark:text-white font-bold rounded-xl text-sm shadow-md transition-all duration-200 flex items-center justify-center gap-2",
                "hover:shadow-lg hover:-translate-y-0.5 active:translate-y-0",
                loading && "opacity-70 pointer-events-none"
              )}
            >
              {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : <LogIn className="w-5 h-5" />}
              {loading ? "Accesso in corso..." : "Accedi in Sicurezza"}
            </button>
            <button type="button" onClick={() => { setDimenticata(true); setError(''); setFatto(''); setChi(username); }}
              className="w-full text-center text-xs font-semibold text-slate-500 hover:text-slate-800 dark:hover:text-slate-200">
              Password dimenticata?
            </button>
          </form>
        )}

        {error && (
          <div className="mt-5 p-3 bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400 border border-red-100 dark:border-red-900/50 rounded-xl text-xs font-medium flex items-center gap-2 animate-in fade-in slide-in-from-bottom-2">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}
      </div>

      <div className="mt-12 text-center text-xs text-slate-400 font-medium tracking-wide z-10 relative">
        WILDIX VOICEBOT INTEGRATION &copy; {new Date().getFullYear()}
      </div>
    </div>
  );
}
