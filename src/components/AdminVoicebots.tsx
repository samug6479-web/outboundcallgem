import React, { useEffect, useState } from 'react';
import { useCampaign, Voicebot } from '../context/CampaignContext';
import { Plus, Pencil, Trash2, Save, X, Phone, CheckCircle2, AlertCircle, ToggleLeft, ToggleRight } from 'lucide-react';
import { cn } from '../lib/utils';
import { ConfirmModal } from './ConfirmModal';
import { SkeletonRow, EmptyState } from './Skeleton';
import { authFetch } from '../lib/authFetch';

function FormRow({ label, field, placeholder, type = 'text', form, setForm }: any) {
  return (
    <div>
      <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-1">{label}</label>
      <input
        type={type}
        value={form[field]}
        onChange={e => setForm((prev: any) => ({ ...prev, [field]: e.target.value }))}
        placeholder={placeholder}
        className="w-full px-3 py-2 text-sm bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-lg focus:outline-none focus:border-brand-500 dark:text-white"
      />
    </div>
  );
}

export function AdminVoicebots() {
  const { loadVoicebots, user } = useCampaign();
  const isAdmin = user?.isAdmin || user?.role === 'Admin';
  const [bots, setBots] = useState<Voicebot[]>([]);
  const [loading, setLoading] = useState(true);
  const [editId, setEditId] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [status, setStatus] = useState<{ type: 'ok' | 'err'; msg: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Voicebot | null>(null);

  const emptyForm = { nome: '', exten: '', context: 'outbound-voicebot', descrizione: '', attivo: true, webhookEsiti: '' };
  const [form, setForm] = useState<any>(emptyForm);

  const load = async () => {
    setLoading(true);
    try {
      const res = await authFetch('/api/voicebots');
      const data = await res.json();
      if (data.ok) setBots(data.voicebots);
    } catch {}
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const notify = (type: 'ok' | 'err', msg: string) => {
    setStatus({ type, msg });
    setTimeout(() => setStatus(null), 3000);
  };

  const handleSaveNew = async () => {
    if (!form.nome || !form.exten || !form.context) return notify('err', 'Nome, interno e contesto sono obbligatori');
    const res = await authFetch('/api/voicebots', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...form, exten: parseInt(form.exten) })
    });
    const data = await res.json();
    if (data.ok) { notify('ok', 'Voicebot aggiunto'); setShowNew(false); setForm(emptyForm); load(); loadVoicebots(); }
    else notify('err', data.error || 'Errore');
  };

  const handleSaveEdit = async (id: string) => {
    if (!form.nome || !form.exten || !form.context) return notify('err', 'Nome, interno e contesto sono obbligatori');
    const exten = parseInt(form.exten);
    if (isNaN(exten)) return notify('err', 'Interno non valido');
    const updated = { ...bots.find(b => b.id === id)!, ...form, exten, id };
    setBots(prev => prev.map(b => b.id === id ? updated : b));
    setEditId(null);
    notify('ok', 'Salvato');
    authFetch(`/api/voicebots/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updated)
    }).then(r => r.json()).then(data => {
      if (!data.ok) { notify('err', data.error || 'Errore salvataggio'); load(); }
      loadVoicebots();
    }).catch(() => { notify('err', 'Errore di rete'); load(); loadVoicebots(); });
  };

  const handleDelete = async (id: string) => {
    setBots(prev => prev.filter(b => b.id !== id));
    setConfirmDelete(null);
    notify('ok', 'Eliminato');
    authFetch(`/api/voicebots/${id}`, { method: 'DELETE' })
      .then(() => loadVoicebots())
      .catch(() => { notify('err', 'Errore eliminazione'); load(); loadVoicebots(); });
  };

  const handleToggle = async (bot: Voicebot) => {
    const nuovoStato = !bot.attivo;
    setBots(prev => prev.map(b => b.id === bot.id ? { ...b, attivo: nuovoStato } : b));
    try {
      const res = await authFetch(`/api/voicebots/${bot.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...bot, attivo: nuovoStato })
      });
      const data = await res.json();
      if (data.ok) {
        notify('ok', nuovoStato ? `${bot.nome} attivato` : `${bot.nome} disattivato`);
      } else {
        setBots(prev => prev.map(b => b.id === bot.id ? { ...b, attivo: bot.attivo } : b));
        notify('err', data.error || 'Errore aggiornamento');
      }
    } catch {
      setBots(prev => prev.map(b => b.id === bot.id ? { ...b, attivo: bot.attivo } : b));
      notify('err', 'Errore di rete');
    } finally {
      loadVoicebots();
    }
  };

  const startEdit = (bot: Voicebot) => {
    setEditId(bot.id);
    setForm({ nome: bot.nome, exten: String(bot.exten), context: bot.context, descrizione: bot.descrizione || '', attivo: bot.attivo, webhookEsiti: bot.webhookEsiti || '' });
    setShowNew(false);
  };

  return (
    <>
      <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-300">
        {status && (
          <div className={cn("flex items-center gap-2 p-3 rounded-xl text-sm font-medium animate-in zoom-in-95",
            status.type === 'ok' ? "bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-400"
            : "bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-400")}>
            {status.type === 'ok' ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <AlertCircle className="w-4 h-4 shrink-0" />}
            {status.msg}
          </div>
        )}

        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-soft overflow-hidden">
          <div className="flex items-center justify-between p-5 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/30">
            <div>
              <h2 className="text-base font-bold text-slate-900 dark:text-white">Voicebot configurati</h2>
              <p className="text-xs text-slate-500 mt-0.5">{bots.length} voicebot · {bots.filter(b => b.attivo).length} attivi</p>
            </div>
            <button onClick={() => { setShowNew(!showNew); setEditId(null); setForm(emptyForm); }}
              className="flex items-center gap-2 px-4 py-2 bg-brand-600 hover:bg-brand-700 text-white text-sm font-bold rounded-xl transition-colors shadow-sm">
              <Plus className="w-4 h-4" /> Aggiungi
            </button>
          </div>

          {showNew && (
            <div className="p-5 border-b border-slate-200 dark:border-slate-800 bg-brand-50 dark:bg-brand-900/10 animate-in fade-in slide-in-from-top-2">
              <h3 className="text-sm font-bold text-slate-900 dark:text-white mb-4">Nuovo Voicebot</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                <FormRow label="Nome" field="nome" placeholder="Es. Sondaggio Clienti" form={form} setForm={setForm} />
                <FormRow label="Interno Wildix (exten)" field="exten" placeholder="Es. 8000" type="number" form={form} setForm={setForm} />
                {isAdmin && <FormRow label="Contesto (context)" field="context" placeholder="outbound-voicebot" form={form} setForm={setForm} />}
                <FormRow label="Descrizione (facoltativa)" field="descrizione" placeholder="Es. Sondaggio post-vendita" form={form} setForm={setForm} />
                {isAdmin && <FormRow label="Webhook esiti (facoltativo)" field="webhookEsiti" placeholder="https://hook.eu1.make.com/..." form={form} setForm={setForm} />}
              </div>
              <div className="flex gap-2">
                <button onClick={handleSaveNew} className="flex items-center gap-2 px-4 py-2 bg-brand-600 hover:bg-brand-700 text-white text-sm font-bold rounded-xl transition-colors">
                  <Save className="w-4 h-4" /> Salva
                </button>
                <button onClick={() => setShowNew(false)} className="flex items-center gap-2 px-4 py-2 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 text-slate-700 dark:text-slate-300 text-sm font-bold rounded-xl transition-colors">
                  <X className="w-4 h-4" /> Annulla
                </button>
              </div>
            </div>
          )}

          {loading ? (
            <div className="divide-y divide-slate-100 dark:divide-slate-800">
              {[...Array(3)].map((_, i) => <SkeletonRow key={i} />)}
            </div>
          ) : bots.length === 0 ? (
            <EmptyState
              icon={<Phone className="w-7 h-7" />}
              title="Nessun voicebot configurato"
              description='Clicca "+ Aggiungi" per creare il primo voicebot da usare nelle campagne.'
            />
          ) : (
            <div className="divide-y divide-slate-100 dark:divide-slate-800">
              {bots.map(bot => (
                <div key={bot.id}>
                  {editId === bot.id ? (
                    <div className="p-5 bg-slate-50 dark:bg-slate-800/30 animate-in fade-in">
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                        <FormRow label="Nome" field="nome" placeholder="Nome voicebot" form={form} setForm={setForm} />
                        <FormRow label="Interno (exten)" field="exten" placeholder="8000" type="number" form={form} setForm={setForm} />
                        {isAdmin && <FormRow label="Contesto" field="context" placeholder="outbound-voicebot" form={form} setForm={setForm} />}
                        <FormRow label="Descrizione" field="descrizione" placeholder="Facoltativa" form={form} setForm={setForm} />
                        {isAdmin && <FormRow label="Webhook esiti" field="webhookEsiti" placeholder="https://hook.eu1.make.com/... (facoltativo)" form={form} setForm={setForm} />}
                      </div>
                      <div className="flex gap-2">
                        <button onClick={() => handleSaveEdit(bot.id)} className="flex items-center gap-2 px-4 py-2 bg-brand-600 hover:bg-brand-700 text-white text-sm font-bold rounded-xl transition-colors">
                          <Save className="w-4 h-4" /> Salva
                        </button>
                        <button onClick={() => setEditId(null)} className="flex items-center gap-2 px-4 py-2 bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 text-sm font-bold rounded-xl transition-colors">
                          <X className="w-4 h-4" /> Annulla
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center gap-4 px-5 py-4 hover:bg-slate-50 dark:hover:bg-slate-800/30 transition-colors">
                      <div className={cn("w-10 h-10 rounded-xl flex items-center justify-center shrink-0", bot.attivo ? "bg-brand-100 dark:bg-brand-900/30" : "bg-slate-100 dark:bg-slate-800")}>
                        <Phone className={cn("w-4 h-4", bot.attivo ? "text-brand-600 dark:text-brand-400" : "text-slate-400")} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-semibold text-slate-900 dark:text-white">{bot.nome}</span>
                          <span className={cn("text-[10px] font-bold px-2 py-0.5 rounded-full", bot.attivo ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400" : "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-500")}>
                            {bot.attivo ? 'ATTIVO' : 'DISATTIVO'}
                          </span>
                        </div>
                        <div className="text-xs text-slate-500 mt-0.5">
                          Interno: <span className="font-mono font-semibold">{bot.exten}</span>
                          {isAdmin && <><span className="mx-2">·</span>Context: <span className="font-mono">{bot.context}</span></>}
                          {bot.descrizione && <><span className="mx-2">·</span>{bot.descrizione}</>}
                          {isAdmin && bot.webhookEsiti && <><span className="mx-2">·</span>Esiti non riusciti nello Sheets</>}
                        </div>
                      </div>
                      <div className="flex items-center gap-1">
                        <button onClick={() => handleToggle(bot)} className="p-2 rounded-lg text-slate-400 hover:text-brand-600 hover:bg-brand-50 dark:hover:bg-brand-900/20 transition-colors" title={bot.attivo ? 'Disattiva' : 'Attiva'}>
                          {bot.attivo ? <ToggleRight className="w-5 h-5 text-brand-500" /> : <ToggleLeft className="w-5 h-5" />}
                        </button>
                        <button onClick={() => startEdit(bot)} className="p-2 rounded-lg text-slate-400 hover:text-brand-600 hover:bg-brand-50 dark:hover:bg-brand-900/20 transition-colors">
                          <Pencil className="w-4 h-4" />
                        </button>
                        <button onClick={() => setConfirmDelete(bot)} className="p-2 rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors">
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <ConfirmModal
        open={!!confirmDelete}
        title="Elimina voicebot"
        message={`Vuoi eliminare "${confirmDelete?.nome}"? Questa azione non può essere annullata.`}
        confirmLabel="Elimina"
        onConfirm={() => confirmDelete && handleDelete(confirmDelete.id)}
        onCancel={() => setConfirmDelete(null)}
      />
    </>
  );
}
