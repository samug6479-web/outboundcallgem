import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Ban, Search, Download, Trash2, UploadCloud, Plus, Loader2, Bot, User, X } from 'lucide-react';
import * as XLSX from 'xlsx';
import { authFetch } from '../lib/authFetch';
import { cn } from '../lib/utils';
import { useCampaign } from '../context/CampaignContext';
import { ConfirmModal } from './ConfirmModal';

interface Voce {
  numero: string;
  nome: string | null;
  motivo: string | null;
  fonte: string;
  created_by: string | null;
  created_at: string;
}

const pareNumero = (v: string) => /^\+?[\d\s\-().]{6,20}$/.test(v) && v.replace(/\D/g, '').length >= 6;

// Da un file (Excel o CSV) prende in ogni riga il primo valore che sembra un
// numero di telefono e, se c'è, il primo testo come nome. Va bene anche un
// file con la sola colonna dei numeri.
function righeDaFile(rows: string[][]): { numero: string; nome: string }[] {
  const out: { numero: string; nome: string }[] = [];
  for (const row of rows) {
    const celle = row.map(c => String(c ?? '').trim()).filter(Boolean);
    const numero = celle.find(pareNumero);
    if (!numero) continue;
    out.push({ numero, nome: celle.find(c => c !== numero && !pareNumero(c)) || '' });
  }
  return out;
}

// Lista "Non chiamare": numeri che nessuna campagna chiama mai.
export function NonChiamareSection() {
  const { user } = useCampaign();
  const isAdmin = !!(user?.isAdmin || user?.role === 'Admin');
  const [voci, setVoci] = useState<Voce[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<{ tipo: 'ok' | 'err'; testo: string } | null>(null);
  const [search, setSearch] = useState('');
  const [numero, setNumero] = useState('');
  const [nome, setNome] = useState('');
  const [motivo, setMotivo] = useState('');
  const [saving, setSaving] = useState(false);
  const [daTogliere, setDaTogliere] = useState<Voce | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = async () => {
    setLoading(true);
    try {
      const res = await authFetch('/api/non-chiamare');
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error);
      setVoci(data.numeri || []);
    } catch (e: any) {
      setMsg({ tipo: 'err', testo: e?.message || 'Impossibile caricare la lista.' });
    }
    setLoading(false);
  };
  useEffect(() => { load(); }, []);

  const aggiungi = async (numeri: { numero: string; nome?: string }[], motivoTesto: string) => {
    setSaving(true);
    try {
      const res = await authFetch('/api/non-chiamare', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ numeri, motivo: motivoTesto || undefined }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || `Errore HTTP ${res.status}`);
      const parti = [`${data.aggiunti} ${data.aggiunti === 1 ? 'numero aggiunto' : 'numeri aggiunti'}`];
      if (data.giaPresenti) parti.push(`${data.giaPresenti} già in lista`);
      if (data.scartati) parti.push(`${data.scartati} non validi`);
      setMsg({ tipo: 'ok', testo: parti.join(' · ') });
      await load();
      return true;
    } catch (e: any) {
      setMsg({ tipo: 'err', testo: e?.message || 'Errore di rete' });
      return false;
    } finally {
      setSaving(false);
    }
  };

  const aggiungiUno = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!numero.trim()) return;
    if (await aggiungi([{ numero: numero.trim(), nome: nome.trim() || undefined }], motivo.trim())) {
      setNumero(''); setNome(''); setMotivo('');
    }
  };

  const importa = (file: File) => {
    const reader = new FileReader();
    const fine = (rows: string[][]) => {
      const lette = righeDaFile(rows);
      if (lette.length === 0) { setMsg({ tipo: 'err', testo: 'Nel file non ho trovato numeri di telefono.' }); return; }
      aggiungi(lette, `Importato da ${file.name}`);
    };
    if (/\.(csv|txt)$/i.test(file.name)) {
      reader.onload = e => {
        const testo = String(e.target?.result || '').replace(/^﻿/, '');
        fine(testo.split(/\r?\n/).map(l => l.split(l.includes(';') ? ';' : l.includes('\t') ? '\t' : ',').map(p => p.replace(/^"|"$/g, ''))));
      };
      reader.readAsText(file);
    } else {
      reader.onload = e => {
        try {
          const wb = XLSX.read(e.target?.result, { type: 'array' });
          fine(XLSX.utils.sheet_to_json<string[]>(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '', raw: false }));
        } catch { setMsg({ tipo: 'err', testo: 'File non leggibile.' }); }
      };
      reader.readAsArrayBuffer(file);
    }
    if (fileRef.current) fileRef.current.value = '';
  };

  const togli = async (v: Voce) => {
    try {
      const res = await authFetch(`/api/non-chiamare/${encodeURIComponent(v.numero)}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || `Errore HTTP ${res.status}`);
      setVoci(prev => prev.filter(x => x.numero !== v.numero));
      setMsg({ tipo: 'ok', testo: `${v.nome || v.numero} tolto dalla lista: potrà essere chiamato di nuovo.` });
    } catch (e: any) {
      setMsg({ tipo: 'err', testo: e?.message || 'Errore di rete' });
    }
  };

  const filtrate = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return voci;
    const cifre = q.replace(/\D/g, '');
    return voci.filter(v => (v.nome || '').toLowerCase().includes(q) || (v.motivo || '').toLowerCase().includes(q) || (cifre && v.numero.includes(cifre)));
  }, [voci, search]);

  const esporta = () => {
    const ws = XLSX.utils.json_to_sheet(filtrate.map(v => ({
      Numero: v.numero, Nome: v.nome || '', Motivo: v.motivo || '',
      'Aggiunto da': v.fonte === 'wilma' ? 'Wilma (durante la chiamata)' : v.created_by || '',
      Data: new Date(v.created_at).toLocaleString('it-IT'),
    })));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Non chiamare');
    XLSX.writeFile(wb, `non-chiamare-${new Date().toISOString().slice(0, 10)}.xlsx`);
  };

  const daWilma = voci.filter(v => v.fonte === 'wilma').length;

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-300 max-w-4xl">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Aggiungi a mano */}
        <form onSubmit={aggiungiUno} className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-soft p-5 space-y-3">
          <h2 className="text-base font-bold text-slate-900 dark:text-white font-display flex items-center gap-2"><Plus className="w-4 h-4 text-brand-600" /> Aggiungi un numero</h2>
          <div className="grid grid-cols-2 gap-2">
            <input value={numero} onChange={e => setNumero(e.target.value)} placeholder="Numero *" inputMode="tel" aria-label="Numero"
              className="px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-brand-500" />
            <input value={nome} onChange={e => setNome(e.target.value)} placeholder="Nome (facoltativo)" aria-label="Nome"
              className="px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-brand-500" />
          </div>
          <input value={motivo} onChange={e => setMotivo(e.target.value)} placeholder="Motivo (es. cliente attivo, ha chiesto di non chiamare)" aria-label="Motivo"
            className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-brand-500" />
          <button type="submit" disabled={saving || !numero.trim()}
            className="w-full py-2 rounded-lg text-sm font-bold bg-brand-600 hover:bg-brand-700 text-white disabled:opacity-50 inline-flex items-center justify-center gap-2">
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Ban className="w-4 h-4" />} Non chiamare più
          </button>
        </form>

        {/* Importa da file */}
        <div
          onDragOver={e => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={e => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files?.[0]; if (f) importa(f); }}
          className={cn('rounded-2xl border-2 border-dashed p-5 flex flex-col items-center justify-center text-center gap-2 transition-colors',
            dragOver ? 'border-brand-500 bg-brand-50 dark:bg-brand-900/20' : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900')}>
          <UploadCloud className="w-8 h-8 text-slate-400" />
          <p className="text-sm font-semibold text-slate-700 dark:text-slate-200">Importa da Excel o CSV</p>
          <p className="text-xs text-slate-500 max-w-xs">Trascina qui il file o sceglilo. Basta una colonna con i numeri; se c'è anche il nome, viene salvato.</p>
          <button type="button" onClick={() => fileRef.current?.click()} disabled={saving}
            className="mt-1 px-3 py-1.5 rounded-lg text-xs font-semibold border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800">
            Scegli file
          </button>
          <input ref={fileRef} type="file" accept=".csv,.txt,.xls,.xlsx" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) importa(f); }} />
        </div>
      </div>

      {msg && (
        <div className={cn('flex items-center justify-between gap-3 p-3 rounded-xl border text-sm',
          msg.tipo === 'ok' ? 'border-green-200 bg-green-50 text-green-800 dark:border-green-900/50 dark:bg-green-900/10 dark:text-green-300'
            : 'border-red-200 bg-red-50 text-red-700 dark:border-red-900/50 dark:bg-red-900/10 dark:text-red-300')}>
          <span>{msg.testo}</span>
          <button onClick={() => setMsg(null)} className="p-1 hover:opacity-70" aria-label="Chiudi"><X className="w-4 h-4" /></button>
        </div>
      )}

      {/* Elenco */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-soft overflow-hidden">
        <div className="p-4 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/30 flex flex-wrap items-center gap-3">
          <h2 className="text-base font-bold text-slate-900 dark:text-white font-display">
            Numeri da non chiamare {!loading && <span className="ml-1 text-sm font-semibold text-slate-400">{voci.length}</span>}
          </h2>
          {daWilma > 0 && <span className="text-xs text-slate-500">{daWilma} aggiunti da Wilma</span>}
          <div className="relative ml-auto w-full sm:w-64">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Cerca numero, nome o motivo..."
              className="w-full pl-9 pr-3 py-1.5 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-brand-500" />
          </div>
          <button onClick={esporta} disabled={filtrate.length === 0} aria-label="Esporta in Excel" title="Esporta in Excel"
            className="p-1.5 text-slate-400 hover:text-brand-600 hover:bg-brand-50 rounded-lg transition-colors disabled:opacity-40">
            <Download className="w-4 h-4" />
          </button>
        </div>
        {loading ? (
          <div className="p-10 flex justify-center text-slate-400"><Loader2 className="w-5 h-5 animate-spin" /></div>
        ) : filtrate.length === 0 ? (
          <div className="p-10 text-center text-sm text-slate-500">{voci.length === 0 ? 'La lista è vuota.' : 'Nessun numero con questa ricerca.'}</div>
        ) : (
          <ul className="divide-y divide-slate-100 dark:divide-slate-800 max-h-[36rem] overflow-y-auto">
            {filtrate.map(v => (
              <li key={v.numero} className="px-4 py-3 flex items-center gap-3">
                <span className={cn('w-8 h-8 rounded-full flex items-center justify-center shrink-0',
                  v.fonte === 'wilma' ? 'bg-violet-50 text-violet-600 dark:bg-violet-900/30 dark:text-violet-300' : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400')}
                  title={v.fonte === 'wilma' ? 'Aggiunto da Wilma durante la chiamata' : 'Aggiunto a mano'}>
                  {v.fonte === 'wilma' ? <Bot className="w-4 h-4" /> : <User className="w-4 h-4" />}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold text-slate-900 dark:text-white truncate">
                    {v.nome || v.numero} {v.nome && <span className="ml-1 text-xs font-mono font-normal text-slate-400">{v.numero}</span>}
                  </div>
                  <div className="text-xs text-slate-500 truncate">
                    {v.motivo || 'Nessun motivo'} · {v.fonte === 'wilma' ? 'Wilma' : v.created_by || '—'} · {new Date(v.created_at).toLocaleDateString('it-IT')}
                  </div>
                </div>
                {isAdmin && (
                  <button onClick={() => setDaTogliere(v)} title="Togli dalla lista" aria-label={`Togli ${v.numero} dalla lista`}
                    className="p-1.5 rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40">
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="px-4 py-3 text-xs text-slate-500 border-t border-slate-100 dark:border-slate-800">
          Questi numeri vengono tolti da ogni campagna, anche da quelle già in coda. Wilma aggiunge da sola chi chiede di non essere più contattato.
          {!isAdmin && ' Solo un Admin può togliere un numero dalla lista.'}
        </p>
      </div>

      <ConfirmModal
        open={!!daTogliere}
        title="Togliere il numero dalla lista?"
        message={daTogliere ? `${daTogliere.nome || daTogliere.numero} potrà essere chiamato di nuovo dalle prossime campagne.` : ''}
        confirmLabel="Togli"
        onCancel={() => setDaTogliere(null)}
        onConfirm={() => { const v = daTogliere; setDaTogliere(null); if (v) togli(v); }}
      />
    </div>
  );
}
