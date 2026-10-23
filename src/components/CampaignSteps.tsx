import React, { useRef, useState } from 'react';
import { useCampaign } from '../context/CampaignContext';
import { FileText, FileSpreadsheet, Keyboard, UploadCloud, Plus, Trash2, DownloadCloud, AlertTriangle } from 'lucide-react';
import * as XLSX from 'xlsx';
import { cn, parseContactsCsv } from '../lib/utils';

export function Step1Upload() {
  const { user, uploadMode, setUploadMode, setContacts, updateManualContacts, contacts } = useCampaign();
  const fileInputRefCsv = useRef<HTMLInputElement>(null);
  const fileInputRefXls = useRef<HTMLInputElement>(null);
  const fileInputRefApp = useRef<HTMLInputElement>(null);

  const isViewer = user?.role === 'Viewer';

  const handleCSV = (file: File) => {
    if (!file || isViewer) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      if (!e.target?.result) return;
      const out = parseContactsCsv(e.target.result as string).map(c => ({ id: crypto.randomUUID(), ...c }));
      setContacts([]);
      updateManualContacts(out);
    };
    reader.readAsText(file);
  };

  const handleExcel = (file: File) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        if (!e.target?.result) return;
        const wb = XLSX.read(e.target.result, { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json<any[]>(ws, { header: 1, defval: '' });
        
        const out = [];
        for (const row of rows) {
          const nome = String(row[0] || '').trim();
          const numero = String(row[1] || '').trim();
          if (!nome || !numero) continue;
          if (['nome', 'name'].includes(nome.toLowerCase())) continue;
          out.push({ id: crypto.randomUUID(), nome, numero });
        }
        setContacts([]);
        updateManualContacts(out);
      } catch (err: any) {
        alert('Errore lettura Excel: ' + err.message);
      }
    };
    reader.readAsArrayBuffer(file);
  };

  const downloadTemplate = (type: 'csv' | 'xlsx') => {
    if (type === 'csv') {
      const blob = new Blob(['Nome,Numero\nMario Rossi,+393331234567\nGiulia Bianchi,0612345678'], { type: 'text/csv' });
      const a = document.createElement('a'); 
      a.href = URL.createObjectURL(blob); 
      a.download = 'template_contatti.csv'; 
      a.click();
    } else {
      const ws = XLSX.utils.aoa_to_sheet([['Nome', 'Numero'], ['Mario Rossi', '+393331234567'], ['Giulia Bianchi', '0612345678']]);
      const wb = XLSX.utils.book_new(); 
      XLSX.utils.book_append_sheet(wb, ws, 'Contatti');
      XLSX.writeFile(wb, 'template_contatti.xlsx');
    }
  };





  const handleManualRowAdd = () => {
    if (isViewer) return;
    updateManualContacts([...contacts, { id: crypto.randomUUID(), nome: '', numero: '' }]);
  };





  const updateManualRow = (id: string, field: 'nome' | 'numero', val: string) => {
    if (isViewer) return;
    const updated = contacts.map(c => c.id === id ? { ...c, [field]: val } : c);
    updateManualContacts(updated);
  };

  const deleteManualRow = (id: string) => {
    if (isViewer) return;
    updateManualContacts(contacts.filter(c => c.id !== id));
  };

  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-soft overflow-hidden">
      {/* Tabs */}
      <div className="flex bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-800">
        {[
          { id: 'csv', icon: FileText, label: 'CSV' },
          { id: 'xls', icon: FileSpreadsheet, label: 'Excel' },
          { id: 'manual', icon: Keyboard, label: 'Manuale' },
        ].map((tab) => {
          const isActive = uploadMode === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setUploadMode(tab.id as any)}
              className={cn(
                "flex-1 py-3.5 flex items-center justify-center gap-2 text-sm font-medium transition-all border-b-2",
                isActive 
                  ? "bg-white dark:bg-slate-900 text-brand-600 dark:text-brand-400 border-brand-500" 
                  : "text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 border-transparent hover:bg-slate-100 dark:hover:bg-slate-800"
              )}
            >
              <tab.icon className="w-4 h-4" />
              {tab.label}
            </button>
          );
        })}
      </div>

      <div className="p-6">
        {/* CSV & Excel Panels */}
        {(uploadMode === 'csv' || uploadMode === 'xls') && (
          <div className="space-y-4 animate-in fade-in zoom-in-95 duration-200">
            {isViewer ? (
              <div className="p-8 text-center text-slate-500 bg-slate-50 dark:bg-slate-800/50 rounded-xl border border-slate-200 dark:border-slate-700">
                Non hai i permessi per caricare contatti
              </div>
            ) : (
              <div 
                className="border-2 border-dashed border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/50 rounded-xl p-10 text-center hover:bg-accent-50 dark:hover:bg-accent-500/10 hover:border-accent-400 transition-colors cursor-pointer group"
                onClick={() => uploadMode === 'csv' ? fileInputRefCsv.current?.click() : fileInputRefXls.current?.click()}
                onDragOver={e => e.preventDefault()}
                onDrop={e => {
                  e.preventDefault();
                  const file = e.dataTransfer.files?.[0];
                  if (!file) return;
                  // Il tipo si decide dall'estensione, non dalla scheda aperta.
                  if (/\.(xlsx|xls)$/i.test(file.name)) handleExcel(file); else handleCSV(file);
                }}
              >
                <input 
                  type="file" 
                  accept={uploadMode === 'csv' ? ".csv,.txt" : ".xlsx,.xls"} 
                  className="hidden" 
                  ref={uploadMode === 'csv' ? fileInputRefCsv : fileInputRefXls}
                  onChange={e => {
                    const file = e.target.files?.[0];
                    if (file) { uploadMode === 'csv' ? handleCSV(file) : handleExcel(file); }
                    e.target.value = '';
                  }}
                />
                <div className="w-14 h-14 bg-brand-50 dark:bg-brand-700/30 text-brand-600 dark:text-brand-400 rounded-xl flex items-center justify-center mx-auto mb-4 border border-brand-100 dark:border-brand-700/50 group-hover:scale-110 transition-transform">
                  <UploadCloud className="w-6 h-6" />
                </div>
                <h3 className="font-semibold text-slate-900 dark:text-white mb-1">Trascina il file {uploadMode.toUpperCase()} qui</h3>
                <p className="text-sm text-slate-500">oppure clicca per selezionare dal tuo computer</p>
              </div>
            )}

            <div className="bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl p-4">
              <div className="flex items-center gap-3 mb-2">
                <AlertTriangle className="w-4 h-4 text-accent-500" />
                <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider">Formato Richiesto — 2 Colonne</h4>
              </div>
              <pre className="text-xs text-slate-600 dark:text-slate-400 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-3 rounded-lg font-mono">
                {uploadMode === 'csv' ? "Mario Rossi,+393331234567\nGiulia Bianchi,0612345678" : "Col A: Mario Rossi\nCol B: +393331234567"}
              </pre>
              <div className="mt-3 flex gap-2">
                <button 
                  onClick={() => downloadTemplate(uploadMode === 'csv' ? 'csv' : 'xlsx')}
                  className="inline-flex items-center gap-2 text-xs font-semibold text-brand-600 bg-brand-50 px-3 py-1.5 rounded-lg hover:bg-brand-100 transition-colors"
                >
                  <DownloadCloud className="w-3.5 h-3.5" />
                  Scarica Template
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Manual Panel */}
        {uploadMode === 'manual' && (
          <div className="space-y-4 animate-in fade-in zoom-in-95 duration-200">
            <div className="border border-slate-200 dark:border-slate-700 rounded-xl overflow-hidden">
              <div className="grid grid-cols-[1fr_1fr_40px] bg-slate-50 dark:bg-slate-800/80 p-3 border-b border-slate-200 dark:border-slate-700 gap-3">
                <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">Nome Cliente</span>
                <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">Numero</span>
                <span />
              </div>
              <div className="max-h-[300px] overflow-y-auto">
                {contacts.length === 0 && (
                  <div className="p-8 text-center text-slate-400 text-sm">{isViewer ? "Non hai i permessi per inserire contatti" : "Nessun contatto inserito"}</div>
                )}
                {contacts.map((c) => (
                  <div key={c.id} className="grid grid-cols-[1fr_1fr_40px] gap-3 p-2 items-center border-b border-slate-100 dark:border-slate-800 last:border-0 hover:bg-slate-50 dark:hover:bg-slate-800/40">
                    <input 
                      type="text" 
                      placeholder="Mario Rossi" 
                      value={c.nome}
                      disabled={isViewer}
                      onChange={(e) => updateManualRow(c.id, 'nome', e.target.value)}
                      className={cn(
                        "w-full bg-white dark:bg-slate-900 px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-600 focus:border-brand-500 dark:focus:border-brand-400 focus:ring-2 focus:ring-brand-500/20 transition-all text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:outline-none",
                        isViewer && "opacity-60 cursor-not-allowed border-transparent"
                      )}
                    />
                    <input 
                      type="text" 
                      placeholder="+39..." 
                      value={c.numero}
                      disabled={isViewer}
                      onChange={(e) => updateManualRow(c.id, 'numero', e.target.value)}
                      className={cn(
                        "w-full bg-white dark:bg-slate-900 px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-600 focus:border-brand-500 dark:focus:border-brand-400 focus:ring-2 focus:ring-brand-500/20 transition-all text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:outline-none",
                        c.inv && c.numero.length > 3 && "!border-red-400 !bg-red-50 dark:!bg-red-900/20 !text-red-700 dark:!text-red-300",
                        isViewer && "opacity-60 cursor-not-allowed border-transparent"
                      )}
                    />
                    {!isViewer && (
                      <button 
                        onClick={() => deleteManualRow(c.id)}
                        className="w-8 h-8 flex items-center justify-center text-slate-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/30 rounded-lg transition-colors"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                ))}
              </div>
              {!isViewer && (
                <button 
                  onClick={handleManualRowAdd}
                  className="w-full flex items-center justify-center gap-2 py-3 bg-slate-50 dark:bg-slate-800/50 hover:bg-slate-100 dark:hover:bg-slate-800 text-brand-600 dark:text-brand-400 font-semibold text-sm border-t border-slate-200 dark:border-slate-700 transition-colors"
                >
                  <Plus className="w-4 h-4" />
                  Aggiungi Riga
                </button>
              )}
            </div>
          </div>
        )}

      </div>
    </div>
  );
}

export function Step2Preview() {
  const { contacts, validContacts, invalidCount, duplicateCount, campaignType } = useCampaign();
  const [searchTerm, setSearchTerm] = useState('');
  const isAppointment = campaignType === 'appuntamenti';
    if (contacts.length === 0) return null;

  const filteredContacts = contacts.filter(c => 
    String(c.nome || '').toLowerCase().includes(searchTerm.toLowerCase()) || 
    String(c.numero || '').includes(searchTerm)
  );

  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-soft overflow-hidden animate-in fade-in slide-in-from-bottom-4 duration-300">
      <div className="p-5 border-b border-slate-200 dark:border-slate-800 flex items-center gap-3 bg-slate-50 dark:bg-slate-800/30">
        <div className="w-8 h-8 rounded-full bg-brand-100 dark:bg-brand-700/50 text-brand-700 dark:text-brand-300 flex items-center justify-center font-display font-bold">2</div>
        <h2 className="text-lg font-bold text-slate-900 dark:text-white font-display">Anteprima Lista</h2>
      </div>

      <div className="grid grid-cols-3 divide-x divide-slate-200 dark:divide-slate-800 border-b border-slate-200 dark:border-slate-800">
        <div className="p-4 text-center">
          <span className="block text-2xl font-extrabold text-brand-600 dark:text-brand-400 font-display leading-none">{contacts.length}</span>
          <span className="text-[10px] sm:text-xs font-bold text-slate-400 uppercase tracking-widest mt-1 block">Totale</span>
        </div>
        <div className="p-4 text-center">
          <span className="block text-2xl font-extrabold text-green-600 font-display leading-none">{validContacts.length}</span>
          <span className="text-[10px] sm:text-xs font-bold text-slate-400 uppercase tracking-widest mt-1 block">Validi</span>
        </div>
        <div className="p-4 text-center">
          <span className={cn("block text-2xl font-extrabold font-display leading-none", (invalidCount > 0 || duplicateCount > 0) ? "text-amber-500" : "text-slate-300")}>
            {invalidCount + duplicateCount}
          </span>
          <span className="text-[10px] sm:text-xs font-bold text-slate-400 uppercase tracking-widest mt-1 block">Problemi</span>
        </div>
      </div>

      {(invalidCount > 0 || duplicateCount > 0) && (
        <div className="mx-4 mt-4 p-3 bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400 text-sm font-medium rounded-xl border border-amber-200/50 flex flex-wrap gap-1">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>Attenzione: riscontrati</span>
          {duplicateCount > 0 && <span><strong>{duplicateCount}</strong> {duplicateCount > 1 ? 'duplicati' : 'duplicato'}</span>}
          {duplicateCount > 0 && invalidCount > 0 && <span>e</span>}
          {invalidCount > 0 && <span><strong>{invalidCount}</strong> non {invalidCount > 1 ? 'validi' : 'valido'}</span>}.
        </div>
      )}

      <div className="px-4 mt-4">
        <div className="relative">
          <input 
            type="text" 
            placeholder="Cerca per nome o numero..." 
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full pl-9 pr-4 py-2 bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700 rounded-lg text-sm focus:outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500 text-slate-900 dark:text-slate-100 placeholder:text-slate-500"
          />
          <svg className="w-4 h-4 absolute left-3 top-2.5 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"></path></svg>
        </div>
      </div>

      <div className="p-4">
        <div className="border border-slate-200 dark:border-slate-700 rounded-xl overflow-hidden">
          <div className={`grid ${isAppointment ? 'grid-cols-[1fr_1fr_auto_auto_1fr_auto]' : 'grid-cols-[1fr_1fr_auto]'} bg-slate-50 dark:bg-slate-800/80 p-3 border-b border-slate-200 dark:border-slate-700 gap-3 text-xs font-bold text-slate-500 uppercase tracking-wider`}>
            <span>Nome</span>
            <span>Numero</span>
            {isAppointment && <span>Data</span>}
            {isAppointment && <span>Ora</span>}
            {isAppointment && <span>Prestazione</span>}
            <span>Stato</span>
          </div>
          <div className="max-h-[220px] overflow-y-auto">
            {filteredContacts.slice(0, 50).map(c => (
              <div key={c.id} className={`grid ${isAppointment ? 'grid-cols-[1fr_1fr_auto_auto_1fr_auto]' : 'grid-cols-[1fr_1fr_auto]'} gap-3 p-3 items-center border-b border-slate-100 dark:border-slate-800/50 last:border-0 hover:bg-slate-50 dark:hover:bg-slate-800/30 text-sm`}>
                <span className="text-slate-900 dark:text-slate-200 font-medium truncate">{c.nome}</span>
                <span className="text-slate-500 truncate">{c.numero}</span>
                {isAppointment && <span className="text-slate-400 text-xs">{c.data_appuntamento || '—'}</span>}
                {isAppointment && <span className="text-slate-400 text-xs">{c.ora_appuntamento || '—'}</span>}
                {isAppointment && <span className="text-slate-400 text-xs truncate">{c.prestazione || '—'}</span>}
                <div className="flex justify-end min-w-[70px]">
                  {c.dup ? (
                    <span className="px-2 py-0.5 bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 text-[10px] font-bold rounded-full uppercase">Dup</span>
                  ) : c.inv ? (
                    <span className="px-2 py-0.5 bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400 text-[10px] font-bold rounded-full uppercase">Err</span>
                  ) : (
                    <span className="px-2 py-0.5 bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 text-[10px] font-bold rounded-full uppercase">Ok</span>
                  )}
                </div>
              </div>
            ))}
          </div>
          {contacts.length > 50 && (
            <div className="p-3 bg-slate-50 dark:bg-slate-800/30 text-center text-xs font-semibold text-slate-400 border-t border-slate-200 dark:border-slate-700">
              + altri {contacts.length - 50} contatti
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function Step3Settings() {
  const { user, contacts, scheduleMode, setScheduleMode, scheduledAt, setScheduledAt, concurrency, setConcurrency, voicebots, selectedVoicebot, setSelectedVoicebot,
    appConfig, maxConcurrency, richiamate, setRichiamate } = useCampaign();

  if (contacts.length === 0) return null;

  const canSchedule = user?.canSchedule !== false;
  const isAdmin = user?.isAdmin || user?.role === 'Admin';

  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-soft overflow-hidden animate-in fade-in slide-in-from-bottom-4 duration-300">
      <div className="p-5 border-b border-slate-200 dark:border-slate-800 flex items-center gap-3 bg-slate-50 dark:bg-slate-800/30">
        <div className="w-8 h-8 rounded-full bg-brand-100 dark:bg-brand-700/50 text-brand-700 dark:text-brand-300 flex items-center justify-center font-display font-bold">3</div>
        <h2 className="text-lg font-bold text-slate-900 dark:text-white font-display">Impostazioni di Invio</h2>
      </div>

      <div className="p-6 space-y-8">
        <div>
           <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <button
              onClick={() => setScheduleMode('now')}
              className={cn(
                "p-4 rounded-xl border-2 text-left transition-all",
                scheduleMode === 'now' 
                  ? "border-brand-500 bg-brand-50 dark:bg-brand-900/20" 
                  : "border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600 hover:bg-slate-50 dark:hover:bg-slate-800"
              )}
            >
              <div className={cn("w-10 h-10 rounded-lg flex items-center justify-center mb-3 transition-colors", scheduleMode === 'now' ? "bg-brand-600 text-white" : "bg-slate-100 dark:bg-slate-800 text-slate-500")}>
                <svg viewBox="0 0 24 24" className="w-5 h-5 fill-none stroke-current stroke-2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
              </div>
              <h4 className="font-bold text-slate-900 dark:text-white mb-1">Avvia Subito</h4>
              <p className="text-xs text-slate-500">La campagna parte immediatamente</p>
            </button>

            <button
              disabled={!canSchedule}
              onClick={() => setScheduleMode('later')}
              className={cn(
                "p-4 rounded-xl border-2 text-left transition-all relative",
                !canSchedule ? "opacity-50 cursor-not-allowed border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/50" :
                scheduleMode === 'later' 
                  ? "border-brand-500 bg-brand-50 dark:bg-brand-900/20" 
                  : "border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600 hover:bg-slate-50 dark:hover:bg-slate-800"
              )}
            >
              {!canSchedule && (
                <div className="absolute top-3 right-3 text-red-500" title="Schedulazione disabilitata per questo utente">
                  <AlertTriangle className="w-5 h-5" />
                </div>
              )}
              <div className={cn("w-10 h-10 rounded-lg flex items-center justify-center mb-3 transition-colors", scheduleMode === 'later' ? "bg-brand-600 text-white" : "bg-slate-100 dark:bg-slate-800 text-slate-500")}>
                <svg viewBox="0 0 24 24" className="w-5 h-5 fill-none stroke-current stroke-2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
              </div>
              <h4 className="font-bold text-slate-900 dark:text-white mb-1">Pianifica Orario</h4>
              <p className="text-xs text-slate-500">Scegli la data e l'ora desiderata</p>
            </button>
          </div>

          {scheduleMode === 'later' && canSchedule && (
            <div className="mt-4 p-4 border border-slate-200 dark:border-slate-700 rounded-xl bg-slate-50 dark:bg-slate-800/50 animate-in fade-in slide-in-from-top-2">
              <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2">Data e Ora di Avvio</label>
              <input 
                type="datetime-local" 
                value={scheduledAt}
                onChange={e => setScheduledAt(e.target.value)}
                className="w-full px-4 py-2 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand-500/50 focus:border-brand-500 dark:focus:border-brand-400 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500"
              />
            </div>
          )}
        </div>

        <div className="pt-6 border-t border-slate-200 dark:border-slate-800">
          <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-3">
            Voicebot
          </label>
          {voicebots.length === 0 ? (
            <div className="p-4 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-xl text-sm text-amber-700 dark:text-amber-400">
              Nessun voicebot configurato. Vai in Amministrazione → Voicebot per aggiungerne uno.
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-2">
              {voicebots.map(vb => (
                <button
                  key={vb.id}
                  onClick={() => setSelectedVoicebot(vb)}
                  className={cn(
                    "flex items-center gap-3 p-3 rounded-xl border-2 text-left transition-all",
                    selectedVoicebot?.id === vb.id
                      ? "border-brand-500 bg-brand-50 dark:bg-brand-900/20"
                      : "border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600"
                  )}
                >
                  <div className={cn(
                    "w-8 h-8 rounded-lg flex items-center justify-center shrink-0 text-sm font-bold",
                    selectedVoicebot?.id === vb.id ? "bg-brand-500 text-white" : "bg-slate-100 dark:bg-slate-800 text-slate-500"
                  )}>
                    {vb.exten}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold text-slate-900 dark:text-white truncate">{vb.nome}</div>
                    {vb.descrizione && <div className="text-xs text-slate-500 truncate">{vb.descrizione}</div>}
                    {isAdmin && <div className="text-xs text-slate-400 font-mono">interno: {vb.exten} · ctx: {vb.context}</div>}
                  </div>
                  {selectedVoicebot?.id === vb.id && (
                    <div className="w-2 h-2 rounded-full bg-brand-500 shrink-0" />
                  )}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="pt-6 border-t border-slate-200 dark:border-slate-800">
          <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-4">Chiamate Simultanee</label>
          {maxConcurrency > 1 ? (
            <>
              <div className="flex items-center gap-6">
                <input
                  type="range"
                  min="1" max={maxConcurrency}
                  value={Math.min(concurrency, maxConcurrency)}
                  onChange={e => setConcurrency(parseInt(e.target.value))}
                  aria-label="Chiamate simultanee"
                  className="flex-1 h-1.5 bg-slate-200 dark:bg-slate-700 rounded-lg appearance-none cursor-pointer accent-brand-500"
                />
                <div className="w-12 h-12 bg-brand-500 text-white rounded-xl flex items-center justify-center font-display font-extrabold text-xl shadow-md shrink-0">
                  {Math.min(concurrency, maxConcurrency)}
                </div>
              </div>
              <p className="text-xs font-medium text-slate-500 mt-3">
                {concurrency === 1 ? '1 chiamata alla volta' : `Fino a ${Math.min(concurrency, maxConcurrency)} chiamate in parallelo`}
              </p>
            </>
          ) : (
            <p className="text-sm text-slate-500">Una chiamata alla volta: la successiva parte quando finisce quella prima.</p>
          )}
        </div>

        {appConfig.codaSito && (
          <div className="pt-6 border-t border-slate-200 dark:border-slate-800">
            <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-1">Richiama i non raggiunti</label>
            <p className="text-xs text-slate-500 mb-3">Chi rifiuta, è occupato o non risponde viene richiamato in automatico.</p>
            <div className="flex flex-wrap gap-2" role="group" aria-label="Quante volte richiamare">
              {[0, 1, 2, 3].map(n => (
                <button key={n} type="button" onClick={() => setRichiamate({ ...richiamate, tentativi: n })}
                  className={cn("px-3 py-2 rounded-xl text-sm font-semibold border-2 transition-colors",
                    richiamate.tentativi === n
                      ? "border-brand-500 bg-brand-50 dark:bg-brand-900/20 text-brand-700 dark:text-brand-300"
                      : "border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:border-slate-300 dark:hover:border-slate-600")}>
                  {n === 0 ? 'No' : n === 1 ? '1 volta' : `${n} volte`}
                </button>
              ))}
            </div>
            {richiamate.tentativi > 0 && (
              <div className="mt-3 flex items-center gap-2 flex-wrap">
                <label htmlFor="intervallo-richiamate" className="text-sm text-slate-600 dark:text-slate-300">Richiama</label>
                <select id="intervallo-richiamate" value={richiamate.intervalloMin}
                  onChange={e => setRichiamate({ ...richiamate, intervalloMin: parseInt(e.target.value) })}
                  className="px-3 py-2 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-xl text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-brand-500/50">
                  <option value={30}>dopo 30 minuti</option>
                  <option value={60}>dopo 1 ora</option>
                  <option value={120}>dopo 2 ore</option>
                  <option value={240}>dopo 4 ore</option>
                  <option value={1440}>il giorno dopo</option>
                </select>
                {appConfig.orari?.attivo && <span className="text-xs text-slate-500">(sempre negli orari consentiti)</span>}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
