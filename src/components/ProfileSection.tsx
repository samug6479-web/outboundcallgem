import React, { useState } from 'react';
import { useCampaign } from '../context/CampaignContext';
import { User, Mail, Phone, Save, Loader2, CheckCircle2, AlertCircle, Shield, Building2 } from 'lucide-react';
import { cn } from '../lib/utils';

export function ProfileSection() {
  const { user, updateProfile } = useCampaign();
  const [email, setEmail] = useState(user?.email || '');
  const [telefono, setTelefono] = useState(user?.telefono || '');
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState('');

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true); setError(''); setSuccess(false);
    const res = await updateProfile(email, telefono);
    setLoading(false);
    if (res.ok) { setSuccess(true); setTimeout(() => setSuccess(false), 4000); }
    else setError(res.error || 'Errore durante il salvataggio');
  };

  return (
    <div className="max-w-2xl mx-auto space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-300">

      {/* Card info account */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 shadow-soft">
        <div className="flex items-center gap-4 mb-6">
          <div className="w-16 h-16 rounded-2xl bg-brand-100 dark:bg-brand-500/25 flex items-center justify-center text-2xl font-extrabold text-brand-600 dark:text-brand-200 font-display">
            {user?.nome?.charAt(0).toUpperCase()}
          </div>
          <div>
            <div className="text-xl font-bold text-slate-900 dark:text-white">{user?.nome}</div>
            <div className="text-sm text-slate-500">@{user?.username}</div>
            <div className={cn(
              "inline-flex items-center gap-1 mt-1 text-xs font-bold px-2 py-0.5 rounded-full",
              user?.isAdmin ? "bg-red-50 text-red-600 dark:bg-red-900/20 dark:text-red-400"
              : user?.role === 'Viewer' ? "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400"
              : "bg-brand-50 text-brand-600 dark:bg-brand-900/20 dark:text-brand-400"
            )}>
              <Shield className="w-3 h-3" />
              {user?.role || (user?.isAdmin ? 'Admin' : 'Editor')}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 p-4 bg-slate-50 dark:bg-slate-800/50 rounded-xl text-sm">
          <div>
            <div className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-1">Schedulazione</div>
            <div className={cn("font-semibold", user?.canSchedule ? "text-green-600 dark:text-green-400" : "text-slate-400")}>
              {user?.canSchedule ? '✓ Abilitata' : '✗ Disabilitata'}
            </div>
          </div>
          <div>
            <div className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-1">Sessione</div>
            <div className="font-semibold text-slate-700 dark:text-slate-300">Attiva</div>
          </div>
        </div>
      </div>

      {/* Form contatti */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 shadow-soft">
        <h2 className="text-base font-bold text-slate-900 dark:text-white mb-1">Informazioni di contatto</h2>
        <p className="text-sm text-slate-500 mb-5">Usate automaticamente nel modulo di assistenza.</p>

        {success && (
          <div className="mb-4 p-3 bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-900/50 rounded-xl flex items-center gap-2 text-emerald-700 dark:text-emerald-400 text-sm font-medium animate-in zoom-in-95">
            <CheckCircle2 className="w-4 h-4 shrink-0" /> Salvato con successo
          </div>
        )}
        {error && (
          <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-900/50 rounded-xl flex items-center gap-2 text-red-700 dark:text-red-400 text-sm font-medium animate-in zoom-in-95">
            <AlertCircle className="w-4 h-4 shrink-0" /> {error}
          </div>
        )}

        <form onSubmit={handleSave} className="space-y-4">
          <div>
            <label className="flex items-center gap-1.5 text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">
              <Mail className="w-3.5 h-3.5" /> Email
            </label>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)}
              placeholder="tua@email.com"
              className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-950/50 border border-slate-200 dark:border-slate-800 rounded-xl text-sm focus:outline-none focus:ring-1 focus:ring-brand-500/50 focus:border-brand-500 transition-colors dark:text-white" />
          </div>
          <div>
            <label className="flex items-center gap-1.5 text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">
              <Phone className="w-3.5 h-3.5" /> Telefono
            </label>
            <input type="tel" value={telefono} onChange={e => setTelefono(e.target.value)}
              placeholder="+39 06 12345678"
              className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-950/50 border border-slate-200 dark:border-slate-800 rounded-xl text-sm focus:outline-none focus:ring-1 focus:ring-brand-500/50 focus:border-brand-500 transition-colors dark:text-white" />
          </div>
          <button type="submit" disabled={loading}
            className="flex items-center gap-2 px-5 py-2.5 bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white font-bold rounded-xl text-sm transition-all shadow-sm hover:shadow-md hover:-translate-y-0.5 active:translate-y-0">
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            {loading ? 'Salvataggio...' : 'Salva modifiche'}
          </button>
        </form>
      </div>
    </div>
  );
}
