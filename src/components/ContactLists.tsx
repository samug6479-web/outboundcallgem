import React, { useState, useRef } from 'react';
import { useCampaign } from '../context/CampaignContext';
import { List, DownloadCloud, Play, Trash2, Plus, Users, UploadCloud, FileSpreadsheet, X, Keyboard } from 'lucide-react';
import { format } from 'date-fns';
import { it } from 'date-fns/locale';
import * as XLSX from 'xlsx';
import { cn, parseContactsCsv } from '../lib/utils';
import { ConfirmModal } from './ConfirmModal';

export function ContactLists({ onSelectProcess }: { onSelectProcess: () => void }) {
  const { lists, saveList, deleteList, loadList, isLaunching } = useCampaign();
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  const [isUploading, setIsUploading] = useState(false);
  const [uploadMode, setUploadMode] = useState<'file' | 'manual'>('file');
  const [newListName, setNewListName] = useState('');
  const [tempContacts, setTempContacts] = useState<any[]>([]);
  
  // Stato per la modale di conferma eliminazione (Evita l'errore di riferimento)
  const [confirmDeleteList, setConfirmDeleteList] = useState<string | null>(null);

  const [dragOver, setDragOver] = useState(false);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
  };

  // Usata sia dal selettore file sia dal trascinamento.
  const handleFile = (file: File) => {

    const reader = new FileReader();
    
    if (/\.(csv|txt)$/i.test(file.name)) {
      reader.onload = (e) => {
        try {
          // Stesso lettore di Nuova Campagna: accetta anche il punto e virgola.
          const out = parseContactsCsv(e.target?.result as string).map(c => ({ id: crypto.randomUUID(), ...c }));
          setTempContacts(out);
        } catch (err) {
          console.error(err);
        }
      };
      reader.readAsText(file);
    } else {
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
          setTempContacts(out);
        } catch (err) {
          console.error(err);
        }
      };
      reader.readAsArrayBuffer(file);
    }
  };

  const cancelUpload = () => {
    setIsUploading(false);
    setNewListName('');
    setTempContacts([]);
    if (fileInputRef.current) fileInputRef.current.value = '';
    setUploadMode('file');
  };

  const handleSaveUpload = () => {
    if (newListName.trim() && tempContacts.length > 0) {
      saveList(newListName.trim(), tempContacts);
      cancelUpload();
    }
  };

  const updateTempContact = (id: string, field: 'nome' | 'numero', value: string) => {
    setTempContacts(prev => prev.map(c => c.id === id ? { ...c, [field]: value } : c));
  };

  const removeTempContact = (id: string) => {
    setTempContacts(prev => prev.filter(c => c.id !== id));
  };

  const addTempContact = () => {
    setTempContacts(prev => [{ id: crypto.randomUUID(), nome: '', numero: '' }, ...prev]);
  };

  return (
    <>
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-300">
      
      <div className="flex justify-end">
        <button 
          onClick={() => {
            setIsUploading(true);
            setUploadMode('file');
            setTempContacts([]);
          }}
          className="flex items-center gap-2 px-4 py-2 bg-brand-600 hover:bg-brand-700 text-white font-bold rounded-lg text-sm transition-colors"
        >
          <UploadCloud className="w-4 h-4" />
          Crea Nuova Lista
        </button>
      </div>

      {isUploading && (
        <div className="bg-white dark:bg-slate-900 border border-brand-200 dark:border-brand-800 rounded-2xl shadow-soft p-6 relative">
          <button 
            onClick={cancelUpload}
            className="absolute top-4 right-4 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-1"
          >
            <X className="w-5 h-5" />
          </button>
          
          <h3 className="text-lg font-bold text-slate-900 dark:text-white mb-6">Crea una nuova lista di contatti</h3>
          
          <div className="mb-6 flex bg-slate-50 dark:bg-slate-800/50 rounded-xl overflow-hidden border border-slate-200 dark:border-slate-800">
            <button
              onClick={() => { setUploadMode('file'); setTempContacts([]); }}
              className={cn("flex-1 py-3 text-sm font-bold flex items-center justify-center gap-2 transition-colors", uploadMode === 'file' ? "bg-white dark:bg-slate-950 text-brand-600 dark:text-brand-400 shadow-sm" : "text-slate-500 hover:text-slate-700")}
            >
              <FileSpreadsheet className="w-4 h-4" /> Carica File
            </button>
            <button
              onClick={() => { setUploadMode('manual'); if (tempContacts.length === 0) setTempContacts([{ id: crypto.randomUUID(), nome: '', numero: '' }]); }}
              className={cn("flex-1 py-3 text-sm font-bold flex items-center justify-center gap-2 transition-colors", uploadMode === 'manual' ? "bg-white dark:bg-slate-950 text-brand-600 dark:text-brand-400 shadow-sm" : "text-slate-500 hover:text-slate-700")}
            >
              <Keyboard className="w-4 h-4" /> Inserimento Manuale
            </button>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
            <div className="space-y-6">
              <div>
                <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Nome della lista</label>
                <input
                  type="text"
                  value={newListName}
                  onChange={e => setNewListName(e.target.value)}
                  placeholder="Es. Clienti VIP Gennaio"
                  className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-950/50 border border-slate-200 dark:border-slate-800 rounded-xl text-sm focus:outline-none focus:ring-1 focus:ring-brand-500/50 focus:border-brand-500"
                />
              </div>
              
              {uploadMode === 'file' && (
                <div>
                  <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">File (CSV / XLS / XLSX)</label>
                  <input
                    type="file"
                    id="listUpload"
                    accept=".csv,.txt,.xls,.xlsx"
                    onChange={handleFileChange}
                    ref={fileInputRef}
                    className="hidden"
                  />
                  <label
                    htmlFor="listUpload"
                    onDragOver={e => { e.preventDefault(); setDragOver(true); }}
                    onDragLeave={() => setDragOver(false)}
                    onDrop={e => {
                      e.preventDefault();
                      setDragOver(false);
                      const file = e.dataTransfer.files?.[0];
                      if (file) handleFile(file);
                    }}
                    className={cn("flex flex-col items-center justify-center gap-3 w-full px-4 py-10 border-2 border-dashed rounded-xl cursor-pointer transition-colors text-sm font-medium text-slate-600 dark:text-slate-300 text-center",
                      dragOver
                        ? "border-brand-500 bg-brand-50 dark:bg-brand-500/10"
                        : "border-slate-300 dark:border-slate-700 hover:border-brand-500 dark:hover:border-brand-500 hover:bg-slate-50 dark:hover:bg-slate-800/50")}
                  >
                    <UploadCloud className="w-8 h-8 text-brand-500 mb-2" />
                    <span className="font-bold text-base">{tempContacts.length > 0 ? "File caricato!" : "Scegli un file o trascinalo qui"}</span>
                    <span className="text-xs text-slate-500 font-normal">Supportato: Excel (.xlsx, .xls) o CSV</span>
                  </label>
                </div>
              )}

              {uploadMode === 'manual' && (
                <div className="border border-slate-200 dark:border-slate-700 rounded-xl overflow-hidden">
                  <div className="grid grid-cols-[1fr_1fr_40px] bg-slate-50 dark:bg-slate-800/80 p-3 border-b border-slate-200 dark:border-slate-700 gap-3">
                    <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">Nome Cliente</span>
                    <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">Numero</span>
                    <span />
                  </div>
                  <div className="max-h-[250px] overflow-y-auto">
                    {tempContacts.length === 0 && (
                      <div className="p-8 text-center text-slate-400 text-sm">Nessun contatto inserito</div>
                    )}
                    {tempContacts.map((c) => (
                      <div key={c.id} className="grid grid-cols-[1fr_1fr_40px] gap-3 p-2 items-center border-b border-slate-100 dark:border-slate-800 last:border-0">
                        <input 
                          type="text" 
                          placeholder="Mario Rossi" 
                          value={c.nome}
                          onChange={(e) => updateTempContact(c.id, 'nome', e.target.value)}
                          className="w-full px-3 py-1.5 bg-transparent border border-transparent hover:border-slate-200 focus:border-brand-500 dark:hover:border-slate-700 text-sm rounded-md focus:outline-none transition-colors dark:text-white"
                        />
                        <input 
                          type="text" 
                          placeholder="+39..." 
                          value={c.numero}
                          onChange={(e) => updateTempContact(c.id, 'numero', e.target.value)}
                          className="w-full px-3 py-1.5 bg-transparent border border-transparent hover:border-slate-200 focus:border-brand-500 dark:hover:border-slate-700 text-sm rounded-md focus:outline-none transition-colors dark:text-white"
                        />
                        <button 
                          onClick={() => removeTempContact(c.id)}
                          className="p-1.5 text-slate-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-md transition-colors flex justify-center"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    ))}
                  </div>
                  <div className="p-3 bg-slate-50 dark:bg-slate-800/80 border-t border-slate-200 dark:border-slate-700">
                    <button 
                      onClick={addTempContact}
                      className="flex items-center gap-2 text-sm font-bold text-brand-600 hover:text-brand-700 dark:text-brand-400 transition-colors"
                    >
                      <Plus className="w-4 h-4" /> Aggiungi riga
                    </button>
                  </div>
                </div>
              )}
            </div>

            <div className="bg-slate-50 dark:bg-slate-800/50 rounded-xl p-6 h-full flex flex-col items-center justify-center text-center border border-slate-100 dark:border-slate-800">
              {tempContacts.length > 0 ? (
                <>
                  <div className="w-16 h-16 rounded-full bg-brand-100 dark:bg-brand-900/30 flex items-center justify-center mb-4">
                    <Users className="w-7 h-7 text-brand-600 dark:text-brand-400" />
                  </div>
                  <div className="text-4xl font-black text-slate-900 dark:text-white mb-2">{tempContacts.filter(c => String(c.nome || '').trim() && String(c.numero || '').trim()).length}</div>
                  <div className="text-sm font-medium text-slate-500 dark:text-slate-400">Contatti Validi Rilevati</div>
                  
                  <button 
                    onClick={handleSaveUpload}
                    disabled={!newListName.trim() || tempContacts.filter(c => String(c.nome || '').trim() && String(c.numero || '').trim()).length === 0}
                    className="mt-8 w-full max-w-[200px] py-3 bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white font-bold rounded-xl text-sm transition-all shadow-sm hover:shadow active:scale-95"
                  >
                    Salva Lista
                  </button>
                </>
              ) : (
                <div className="text-sm text-slate-500 dark:text-slate-400">
                  {uploadMode === 'file' ? "Carica un file per vedere l'anteprima dei contatti." : "Inserisci dei contatti manualmente nella tabella."} 
                  <br/><br/>
                  Ricorda che sono necessari sia il <b>Nome</b> che il <b>Numero</b> per ogni contatto.
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {(lists || []).length === 0 ? (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-soft p-12 text-center">
          <div className="w-16 h-16 bg-slate-50 dark:bg-slate-800 rounded-full flex items-center justify-center mx-auto mb-4">
            <List className="w-8 h-8 text-slate-400" />
          </div>
          <h3 className="text-lg font-bold text-slate-900 dark:text-white mb-2">Nessuna lista salvata.</h3>
          <p className="text-sm text-slate-500 mb-6 max-w-md mx-auto">
            Crea una nuova lista in questa sezione oppure salva i contatti caricati nella pagina 'Nuova Campagna'.
          </p>
          <button 
            onClick={() => {
              setIsUploading(true);
              setUploadMode('file');
              setTempContacts([]);
            }}
            className="inline-flex items-center justify-center gap-2 px-6 py-2 bg-brand-50 hover:bg-brand-100 dark:bg-brand-900/20 dark:hover:bg-brand-900/40 text-brand-700 dark:text-brand-400 font-bold rounded-lg transition-colors text-sm"
          >
            <Plus className="w-4 h-4" /> Crea Nuova Lista
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {(lists || []).map((list) => (
            <div key={list.id} className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-soft overflow-hidden group hover:border-brand-300 dark:hover:border-brand-700 transition-colors">
              <div className="p-6">
                <div className="flex justify-between items-start mb-4">
                  <div className="w-10 h-10 rounded-full bg-brand-50 dark:bg-brand-900/30 flex items-center justify-center text-brand-600 dark:text-brand-400 mb-4">
                    <List className="w-5 h-5" />
                  </div>
                  <button 
                    onClick={() => {
                      setConfirmDeleteList(list.id);
                    }}
                    className="text-slate-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 p-2 rounded-lg transition-colors"
                    title="Elimina lista"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
                
                <h3 className="text-xl font-bold text-slate-900 dark:text-white mb-2 truncate" title={list.name}>{list.name}</h3>
                
                <div className="flex items-center gap-4 text-xs font-medium text-slate-500 mb-6">
                  <span className="flex items-center gap-1.5"><Users className="w-3.5 h-3.5" /> {(list.contacts || []).length} contatti</span>
                  <span>&bull;</span>
                  {/* Blocco Try/Catch in tempo reale per blindare la formattazione delle date */}
                  <span>
                    {(() => {
                      try {
                        if (!list.createdAt) return 'Data non definita';
                        return format(new Date(list.createdAt), "d MMM yyyy", { locale: it });
                      } catch (e) {
                        return 'Data non valida';
                      }
                    })()}
                  </span>
                </div>

                <div className="flex items-center justify-between border-t border-slate-100 dark:border-slate-800 pt-5 mt-2">
                  <span className="text-xs font-semibold text-slate-400 uppercase tracking-widest truncate max-w-[120px]">{list.createdBy}</span>
                  
                  <button
                    disabled={isLaunching}
                    onClick={() => {
                      loadList(list.id);
                      onSelectProcess();
                    }}
                    className="flex items-center gap-1.5 px-4 py-1.5 bg-slate-900 hover:bg-slate-800 dark:bg-brand-500 dark:hover:bg-brand-400 dark:text-white text-white font-bold rounded-lg transition-all text-sm"
                  >
                    <Play className="w-3.5 h-3.5" /> 
                    Usa
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
    
    <ConfirmModal
        open={!!confirmDeleteList}
        title="Elimina lista"
        message="Vuoi eliminare questa lista salvata? Questa azione non può essere annullata."
        confirmLabel="Elimina"
        onConfirm={() => { if (confirmDeleteList) { deleteList(confirmDeleteList); setConfirmDeleteList(null); } }}
        onCancel={() => setConfirmDeleteList(null)}
      />
    </>
  );
}
