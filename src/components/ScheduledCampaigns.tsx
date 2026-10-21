import React, { useState } from 'react';
import { CalendarClock, XCircle, Loader2 } from 'lucide-react';
import { useCampaign, ScheduledCampaign } from '../context/CampaignContext';
import { ConfirmModal } from './ConfirmModal';
import { cn } from '../lib/utils';

const STATUS: Record<ScheduledCampaign['status'], { label: string; cls: string }> = {
  pending:   { label: 'In attesa',  cls: 'bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400' },
  sending:   { label: 'In invio',   cls: 'bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400' },
  sent:      { label: 'Partita',    cls: 'bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-400' },
  partial:   { label: 'Parziale',   cls: 'bg-orange-50 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400' },
  failed:    { label: 'Errore',     cls: 'bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-400' },
  cancelled: { label: 'Annullata',  cls: 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400' },
  expired:   { label: 'Scaduta',    cls: 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400' },
};

function formatWhen(iso: string) {
  return new Date(iso).toLocaleString('it-IT', { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

// Elenco delle campagne pianificate, con stato e pulsante Annulla finché
// non sono partite. Le campagne partono solo se l'app è aperta all'orario.
export function ScheduledCampaigns() {
  const { user, scheduledCampaigns, cancelScheduledCampaign } = useCampaign();
  const [toCancel, setToCancel] = useState<ScheduledCampaign | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState('');

  if (scheduledCampaigns.length === 0) return null;

  const isAdmin = user?.isAdmin || user?.role === 'Admin';
  const pending = scheduledCampaigns.filter(c => c.status === 'pending').sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
  const others = scheduledCampaigns.filter(c => c.status !== 'pending').slice(0, 5);

  const confirmCancel = async () => {
    if (!toCancel) return;
    const id = toCancel.id;
    setToCancel(null);
    setBusyId(id);
    setError('');
    const r = await cancelScheduledCampaign(id);
    if (!r.ok) setError(r.error || 'Impossibile annullare');
    setBusyId(null);
  };

  const row = (c: ScheduledCampaign) => {
    const st = STATUS[c.status] || STATUS.pending;
    const canCancel = c.status === 'pending' && (isAdmin || c.createdBy.toLowerCase() === user?.username?.toLowerCase());
    return (
      <li key={c.id} className="flex items-start justify-between gap-3 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold text-slate-900 dark:text-white">{formatWhen(c.scheduledAt)}</span>
            <span className={cn('text-[11px] font-bold px-2 py-0.5 rounded-full', st.cls)}>{st.label}</span>
          </div>
          <div className="text-xs text-slate-500 mt-0.5">
            {c.count} contatti · {c.tipoCampagna === 'appuntamenti' ? 'Appuntamenti' : 'Standard'}
            {c.operatore ? ` · ${c.operatore}` : ''}
            {c.status === 'partial' && c.failedCount ? ` · ${c.failedCount} non inviati` : ''}
          </div>
          {c.note && <div className="text-xs text-slate-400 truncate mt-0.5">{c.note}</div>}
          {(c.status === 'failed' || c.status === 'expired') && c.error && (
            <div className="text-xs text-red-500 mt-0.5">{c.error}</div>
          )}
        </div>
        {canCancel && (
          <button
            onClick={() => setToCancel(c)}
            disabled={busyId === c.id}
            className="shrink-0 inline-flex items-center gap-1 text-xs font-semibold text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 px-2 py-1 rounded-lg transition-colors disabled:opacity-50"
          >
            {busyId === c.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <XCircle className="w-3.5 h-3.5" />}
            Annulla
          </button>
        )}
      </li>
    );
  };

  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-soft overflow-hidden">
      <div className="p-5 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/30 flex items-center gap-2">
        <CalendarClock className="w-4 h-4 text-brand-600" />
        <h2 className="text-base font-bold text-slate-900 dark:text-white font-display">Campagne pianificate</h2>
      </div>
      <div className="px-5 pb-2">
        {pending.length > 0 && (
          <p className="text-xs text-slate-500 pt-3">
            Partono all'orario solo se l'app è aperta su almeno un dispositivo. Oltre 30 minuti di ritardo vengono segnate come scadute.
          </p>
        )}
        {error && <p className="text-xs text-red-500 pt-3">{error}</p>}
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {pending.map(row)}
          {others.map(row)}
        </ul>
      </div>
      <ConfirmModal
        open={!!toCancel}
        title="Annullare la campagna?"
        message={toCancel ? `La campagna del ${formatWhen(toCancel.scheduledAt)} (${toCancel.count} contatti) non partirà.` : ''}
        confirmLabel="Annulla campagna"
        cancelLabel="Indietro"
        onConfirm={confirmCancel}
        onCancel={() => setToCancel(null)}
      />
    </div>
  );
}
