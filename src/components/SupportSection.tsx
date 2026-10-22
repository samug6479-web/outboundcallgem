import React, { useState } from 'react';
import { useCampaign } from '../context/CampaignContext';
import { Mail, Phone, Send, Loader2, CheckCircle2, AlertCircle, Building2 } from 'lucide-react';
import { cn } from '../lib/utils';
import { authFetch } from '../lib/authFetch';

export function SupportSection() {
  const { user } = useCampaign();
  
  const [email, setEmail] = useState(user?.email || '');
  const [phone, setPhone] = useState(user?.telefono || '');
  const [company, setCompany] = useState('');
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !phone.trim() || !subject.trim() || !message.trim()) {
      setError('Email, telefono, oggetto e messaggio sono obbligatori.');
      return;
    }

    setLoading(true);
    setError('');
    
    try {
      const res = await authFetch('/api/support', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: user?.nome,
          email,
          phone,
          company,
          subject,
          message
        })
      });
      
      const data = await res.json();
      if (data.ok) {
        setSuccess(true);
        setEmail(''); setPhone(''); setCompany(''); setSubject(''); setMessage('');
        setTimeout(() => setSuccess(false), 5000);
      } else {
        setError(data.error || 'Errore durante l\'invio della richiesta.');
      }
    } catch (err) {
      setError('Errore di rete. Riprova più tardi.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
      <div className="lg:col-span-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-soft p-6 lg:p-8 animate-in fade-in slide-in-from-bottom-4 duration-300">
        <div className="mb-6">
          <h2 className="text-xl font-bold font-serif text-slate-900 dark:text-white mb-2">Invia una Richiesta di Supporto</h2>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Compila il modulo sottostante per ricevere assistenza tecnica o amministrativa. Ti risponderemo il prima possibile.
          </p>
        </div>

        {success && (
          <div className="mb-6 p-4 bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-900/50 rounded-xl flex items-center gap-3 text-emerald-700 dark:text-emerald-400 animate-in zoom-in-95">
            <CheckCircle2 className="w-5 h-5 shrink-0" />
            <p className="text-sm font-medium">Richiesta inviata con successo! Riceverai una risposta a breve.</p>
          </div>
        )}

        {error && (
          <div className="mb-6 p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-900/50 rounded-xl flex items-center gap-3 text-red-700 dark:text-red-400 animate-in zoom-in-95">
            <AlertCircle className="w-5 h-5 shrink-0" />
            <p className="text-sm font-medium">{error}</p>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-5">
          {/* Riga 1: Nome + Email */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            <div>
              <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Nome Richiedente</label>
              <input
                type="text"
                value={user?.nome || ''}
                disabled
                className="w-full px-4 py-3 bg-slate-100 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-800 rounded-xl text-sm text-slate-500 cursor-not-allowed"
              />
            </div>
            <div>
              <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">
                Email <span className="text-red-400">*</span>
              </label>
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="tua@email.com"
                className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-950/50 border border-slate-200 dark:border-slate-800 rounded-xl text-sm focus:outline-none focus:ring-1 focus:ring-brand-500/50 focus:border-brand-500 transition-colors dark:text-white"
              />
            </div>
          </div>

          {/* Riga 2: Telefono + Azienda */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            <div>
              <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">
                Telefono <span className="text-red-400">*</span>
              </label>
              <input
                type="tel"
                value={phone}
                onChange={e => setPhone(e.target.value)}
                placeholder="+39 06 12345678"
                className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-950/50 border border-slate-200 dark:border-slate-800 rounded-xl text-sm focus:outline-none focus:ring-1 focus:ring-brand-500/50 focus:border-brand-500 transition-colors dark:text-white"
              />
            </div>
            <div>
              <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">
                Azienda <span className="text-slate-400 font-normal normal-case">(facoltativo)</span>
              </label>
              <input
                type="text"
                value={company}
                onChange={e => setCompany(e.target.value)}
                placeholder="Nome azienda..."
                className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-950/50 border border-slate-200 dark:border-slate-800 rounded-xl text-sm focus:outline-none focus:ring-1 focus:ring-brand-500/50 focus:border-brand-500 transition-colors dark:text-white"
              />
            </div>
          </div>

          {/* Oggetto */}
          <div>
            <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">
              Oggetto <span className="text-red-400">*</span>
            </label>
            <input
              type="text"
              value={subject}
              onChange={e => setSubject(e.target.value)}
              placeholder="Motivo della richiesta..."
              className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-950/50 border border-slate-200 dark:border-slate-800 rounded-xl text-sm focus:outline-none focus:ring-1 focus:ring-brand-500/50 focus:border-brand-500 transition-colors dark:text-white"
            />
          </div>

          {/* Messaggio */}
          <div>
            <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">
              Descrizione Dettagliata <span className="text-red-400">*</span>
            </label>
            <textarea
              rows={6}
              value={message}
              onChange={e => setMessage(e.target.value)}
              placeholder="Descrivi il problema o la richiesta nel modo più dettagliato possibile..."
              className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-950/50 border border-slate-200 dark:border-slate-800 rounded-xl text-sm focus:outline-none focus:ring-1 focus:ring-brand-500/50 focus:border-brand-500 transition-colors resize-none dark:text-white"
            ></textarea>
          </div>

          <button
            type="submit"
            disabled={loading || !email.trim() || !phone.trim() || !subject.trim() || !message.trim()}
            className={cn(
              "flex items-center justify-center gap-2 w-full py-3.5 bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white font-bold rounded-xl text-sm transition-all shadow-sm",
              !loading && email.trim() && phone.trim() && subject.trim() && message.trim() && "hover:shadow-md hover:-translate-y-0.5 active:translate-y-0"
            )}
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            {loading ? "Invio in corso..." : "Invia Richiesta"}
          </button>
        </form>
      </div>

      <div className="space-y-6 animate-in fade-in slide-in-from-bottom-6 duration-500">
        <div className="bg-gradient-to-br from-brand-600 to-brand-800 rounded-2xl p-5 xl:p-6 text-white shadow-soft">
          <h3 className="text-lg font-bold font-serif mb-4">Riferimenti Diretti</h3>
          <p className="text-brand-100 text-sm mb-6 leading-relaxed">
            Per questioni urgenti o comunicazioni amministrative, puoi utilizzare i nostri canali diretti.
          </p>
          <div className="space-y-4">
            <a href="mailto:ticket@gemgroup.odoo.com" className="flex items-center gap-2.5 xl:gap-3 p-3 bg-white/10 hover:bg-white/20 rounded-xl transition-colors backdrop-blur-sm group">
              <div className="w-9 h-9 xl:w-10 xl:h-10 rounded-full bg-white/20 flex items-center justify-center shrink-0 group-hover:scale-110 transition-transform">
                <Mail className="w-5 h-5 text-white" />
              </div>
              <div className="min-w-0">
                <div className="text-xs text-brand-200 font-medium tracking-wider uppercase mb-0.5">Email Supporto</div>
                {/* Va a capo dopo la @ quando il riquadro è stretto */}
                <div className="text-[13px] font-bold break-words">ticket@<wbr />gemgroup.odoo.com</div>
              </div>
            </a>
            <a href="tel:+390656556099" className="flex items-center gap-2.5 xl:gap-3 p-3 bg-white/10 hover:bg-white/20 rounded-xl transition-colors backdrop-blur-sm group">
              <div className="w-9 h-9 xl:w-10 xl:h-10 rounded-full bg-white/20 flex items-center justify-center shrink-0 group-hover:scale-110 transition-transform">
                <Phone className="w-5 h-5 text-white" />
              </div>
              <div className="min-w-0">
                <div className="text-xs text-brand-200 font-medium tracking-wider uppercase mb-0.5">Telefono Urgenze</div>
                <div className="text-sm font-bold">+39 0656556099</div>
              </div>
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
