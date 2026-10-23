import React, { useState } from 'react';
import { useCampaign } from '../context/CampaignContext';
import { Play, AlertTriangle, Loader2, Trash2, DownloadCloud, Save, Phone, Clock, Filter, X, StickyNote, CheckCircle2 } from 'lucide-react';
import { format, isToday, isYesterday } from 'date-fns';
import { it } from 'date-fns/locale';
import { cn } from '../lib/utils';
import { ScheduledCampaigns } from './ScheduledCampaigns';
import * as XLSX from 'xlsx';
import { dentroOrari, prossimaApertura, descriviOrari, quandoBreve } from '../lib/orari';

export const intervalloLabel = (min: number) =>
  min >= 1440 ? 'il giorno dopo' : min >= 60 ? `dopo ${min / 60} ${min === 60 ? 'ora' : 'ore'}` : `dopo ${min} minuti`;

function dayLabel(date: Date): string {
  if (isToday(date)) return 'Oggi';
  if (isYesterday(date)) return 'Ieri';
  return format(date, 'EEEE d MMMM', { locale: it });
}

// Raggruppa lo storico per giorno, come un registro chiamate: { "Oggi": [...], "Ieri": [...], ... }
function groupHistoryByDay<T extends { ts: string }>(items: T[]): { label: string; items: T[] }[] {
  const groups: { label: string; items: T[] }[] = [];
  for (const item of items) {
    const label = dayLabel(new Date(item.ts));
    const last = groups[groups.length - 1];
    if (last && last.label === label) {
      last.items.push(item);
    } else {
      groups.push({ label, items: [item] });
    }
  }
  return groups;
}

export function LaunchSidebar({ mode = 'all' }: { mode?: 'launch' | 'history' | 'all' }) {
  const { 
    user, validContacts, contacts, invalidCount, duplicateCount,
    scheduleMode, scheduledAt, concurrency, setConcurrency, appConfig,
    isLaunching, launchStatus, launchCampaign,
    selectedVoicebot, campaignType,
    testSingleCall, testStatus,
    campaignNote, setCampaignNote,
    richiamate, maxConcurrency,
    historyFilter, setHistoryFilter, filteredHistory, exportHistoryToXLSX,
    history, clearHistory, saveList,
  } = useCampaign();

  const [expandedHistory, setExpandedHistory] = useState<string | null>(null);
  const [isSavingList, setIsSavingList] = useState(false);
  const [listName, setListName] = useState('');
  const [showFilters, setShowFilters] = useState(false);
  const [showTestModal, setShowTestModal] = useState(false);
  const [testNome, setTestNome] = useState('');
  const [testNumero, setTestNumero] = useState('');

  const isViewer = user?.role === 'Viewer';

  const exportSingleHistory = (h: any) => {
    if (!h.contactsList) return;
    const wb = XLSX.utils.book_new();

    // Foglio contatti con tutti i campi disponibili
    const data = h.contactsList.map((c: any) => ({
      Nome: c.nome,
      Numero: c.numero,
      ...(c.data_appuntamento ? { 'Data Appuntamento': c.data_appuntamento } : {}),
      ...(c.ora_appuntamento ? { 'Ora': c.ora_appuntamento } : {}),
      ...(c.prestazione ? { Prestazione: c.prestazione } : {}),
    }));
    const wsContatti = XLSX.utils.json_to_sheet(data);
    wsContatti['!cols'] = [{wch:22},{wch:18},{wch:18},{wch:10},{wch:24}];
    XLSX.utils.book_append_sheet(wb, wsContatti, 'Contatti');

    // Foglio info campagna
    const info = [
      { Campo: 'Data avvio', Valore: new Date(h.ts).toLocaleString('it-IT') },
      { Campo: 'Operatore', Valore: h.opt },
      { Campo: 'Chiamate', Valore: h.count },
      { Campo: 'Chiamate simultanee', Valore: h.chunkSize },
      { Campo: 'Modalità', Valore: h.scheduledAt ? 'Pianificata' : 'Immediata' },
      { Campo: 'Note', Valore: h.note || '-' },
    ];
    const wsInfo = XLSX.utils.json_to_sheet(info);
    wsInfo['!cols'] = [{wch:22},{wch:30}];
    XLSX.utils.book_append_sheet(wb, wsInfo, 'Info Campagna');

    XLSX.writeFile(wb, `Campagna_${format(new Date(h.ts), 'yyyyMMdd_HHmm')}.xlsx`);
  };

  const handleSaveList = async () => {
    if (listName.trim() && validContacts.length > 0) {
      const r = await saveList(listName.trim(), validContacts);
      if (r.ok) { setIsSavingList(false); setListName(''); }
      else window.alert(r.error || 'Lista non salvata');
    }
  };

  const handleTestCall = async () => {
    if (!testNome.trim() || !testNumero.trim()) return;
    await testSingleCall({ id: 'test', nome: testNome, numero: testNumero });
    setTestNome(''); setTestNumero('');
  };

  const getButtonText = () => {
    if (isLaunching) return 'Avvio in corso...';
    if (validContacts.length === 0) return 'Avvia Campagna';
    if (scheduleMode === 'later' && scheduledAt) {
      try { return `Pianifica per le ${format(new Date(scheduledAt), 'HH:mm')}`; }
      catch { return 'Pianifica Campagna'; }
    }
    return 'Avvia Campagna Wildix';
  };

  const operators = [...new Set(history.map(h => h.opt))];

  return (
    <div className="space-y-6 sticky top-24">

      {/* LAUNCH CARD */}
      {!isViewer && (mode === 'all' || mode === 'launch') && (
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-soft overflow-hidden">
        <div className="h-1.5 w-full bg-slate-800 dark:bg-brand-500"></div>
        <div className="p-6">
          <div className="flex items-center gap-3 mb-5">
            <div className="w-8 h-8 rounded-full bg-brand-100 dark:bg-brand-700/50 text-brand-700 dark:text-brand-300 flex items-center justify-center font-display font-bold">4</div>
            <h2 className="text-lg font-bold text-slate-900 dark:text-white font-display">Riepilogo e Avvio</h2>
          </div>

          {/* Warning contatti non validi */}
          {(invalidCount > 0 || duplicateCount > 0) && contacts.length > 0 && (
            <div className="flex items-start gap-2 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-xl p-3 mb-4">
              <AlertTriangle className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" />
              <p className="text-xs font-medium text-amber-700 dark:text-amber-400">
                {invalidCount > 0 && <span>{invalidCount} numero{invalidCount > 1 ? 'i non valido' : ' non valido'}{duplicateCount > 0 ? ' · ' : ''}</span>}
                {duplicateCount > 0 && <span>{duplicateCount} duplicato{duplicateCount > 1 ? 'i' : ''}</span>}
                {' '}— verranno esclusi dall'invio
              </p>
            </div>
          )}

          {/* Summary */}
          <div className="bg-slate-50 dark:bg-slate-800/50 border border-slate-100 dark:border-slate-800 rounded-xl p-4 mb-4 space-y-3">
            <div className="flex justify-between items-center pb-3 border-b border-slate-200 dark:border-slate-700">
              <span className="text-sm font-semibold text-slate-500">Contatti Validi</span>
              <span className={cn("text-base font-bold", validContacts.length > 0 ? "text-slate-900 dark:text-white" : "text-slate-400")}>
                {validContacts.length} / {contacts.length}
              </span>
            </div>
            {selectedVoicebot && (
              <div className="flex justify-between items-center pb-3 border-b border-slate-200 dark:border-slate-700">
                <span className="text-sm font-semibold text-slate-500">Voicebot</span>
                <span className="text-sm font-bold text-slate-900 dark:text-white truncate max-w-[160px]" title={selectedVoicebot.nome}>
                  {selectedVoicebot.nome} <span className="font-mono text-xs text-slate-400">({selectedVoicebot.exten})</span>
                </span>
              </div>
            )}
            <div className="flex justify-between items-center pb-3 border-b border-slate-200 dark:border-slate-700">
              <span className="text-sm font-semibold text-slate-500">Chiamate Simultanee</span>
              {/* Scelta possibile solo con la coda gestita dal sito: con lo scenario
                  Make sequenziale le chiamate partono comunque una alla volta. */}
              {appConfig.codaSito && maxConcurrency > 1 ? (
                <div className="flex items-center gap-1" role="group" aria-label="Chiamate simultanee">
                  {Array.from({ length: maxConcurrency }, (_, i) => i + 1).map(n => (
                    <button key={n} type="button" onClick={() => setConcurrency(n)} disabled={isLaunching}
                      className={cn("w-7 h-7 rounded-lg text-xs font-bold transition-colors",
                        concurrency === n ? "bg-brand-600 text-white dark:bg-brand-500" : "bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700")}>
                      {n}
                    </button>
                  ))}
                </div>
              ) : (
                <span className="text-sm font-bold text-slate-900 dark:text-white">x{concurrency}</span>
              )}
            </div>
            {validContacts.length > 0 && (
              <div className="flex justify-between items-center pb-3 border-b border-slate-200 dark:border-slate-700">
                <span className="text-sm font-semibold text-slate-500">Durata stimata</span>
                <span className="text-sm font-bold text-slate-900 dark:text-white">
                  {(() => {
                    const secsPerCall = 45;
                    const totalSecs = Math.ceil(validContacts.length / concurrency) * secsPerCall;
                    if (totalSecs < 60) return `~${totalSecs}s`;
                    const mins = Math.ceil(totalSecs / 60);
                    return `~${mins} min`;
                  })()}
                </span>
              </div>
            )}
            <div className="flex justify-between items-center">
              <span className="text-sm font-semibold text-slate-500">Tipo</span>
              <span className="text-sm font-bold text-slate-900 dark:text-white">
                {campaignType === 'appuntamenti' ? 'Conferma appuntamenti' : 'Standard'}
              </span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-sm font-semibold text-slate-500">Modalità</span>
              <span className="text-sm font-bold text-brand-600 dark:text-brand-400">
                {scheduleMode === 'now' ? 'Immediata' : 'Pianificata'}
              </span>
            </div>
            {scheduleMode === 'later' && scheduledAt && (
              <div className="flex justify-between items-center pt-3 border-t border-slate-200 dark:border-slate-700">
                <span className="text-sm font-semibold text-slate-500">Data e Ora</span>
                <span className="text-sm font-bold text-slate-900 dark:text-white">
                  {format(new Date(scheduledAt), 'dd MMM HH:mm', { locale: it })}
                </span>
              </div>
            )}
            {appConfig.codaSito && (
              <div className="flex justify-between items-center pt-3 border-t border-slate-200 dark:border-slate-700">
                <span className="text-sm font-semibold text-slate-500">Richiamate</span>
                <span className="text-sm font-bold text-slate-900 dark:text-white text-right">
                  {richiamate.tentativi === 0 ? 'No' : `${richiamate.tentativi} ${richiamate.tentativi === 1 ? 'volta' : 'volte'}, ${intervalloLabel(richiamate.intervalloMin)}`}
                </span>
              </div>
            )}
            {appConfig.orari?.attivo && (
              <div className="flex justify-between items-start gap-3 pt-3 border-t border-slate-200 dark:border-slate-700">
                <span className="text-sm font-semibold text-slate-500 shrink-0">Orari consentiti</span>
                <span className="text-xs font-bold text-slate-900 dark:text-white text-right">{descriviOrari(appConfig.orari)}</span>
              </div>
            )}
          </div>

          {/* Fuori orario: la campagna si crea, le chiamate aspettano l'apertura */}
          {appConfig.orari?.attivo && validContacts.length > 0 && (() => {
            const momento = scheduleMode === 'later' && scheduledAt ? new Date(scheduledAt) : new Date();
            if (isNaN(momento.getTime()) || dentroOrari(appConfig.orari, momento)) return null;
            const ap = prossimaApertura(appConfig.orari, momento);
            return (
              <div className="flex items-start gap-2 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-xl p-3 mb-4">
                <Clock className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" />
                <p className="text-xs font-medium text-amber-700 dark:text-amber-400">
                  {scheduleMode === 'later' ? "L'orario scelto è" : 'Adesso è'} fuori dagli orari consentiti.
                  {appConfig.codaSito
                    ? <> Le chiamate partiranno {ap ? quandoBreve(ap) : 'alla prossima apertura'}.</>
                    : <> Scegli un orario consentito.</>}
                </p>
              </div>
            );
          })()}

          {/* Note campagna */}
          <div className="mb-4">
            <label className="flex items-center gap-1.5 text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">
              <StickyNote className="w-3 h-3" /> Note campagna (facoltativo)
            </label>
            <input
              type="text"
              value={campaignNote}
              onChange={e => setCampaignNote(e.target.value)}
              placeholder="Es. Promo estiva clienti VIP..."
              className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-950/50 border border-slate-200 dark:border-slate-800 rounded-lg text-sm focus:outline-none focus:border-brand-500 dark:text-white"
            />
          </div>

          {/* Test chiamata singola */}
          <button
            onClick={() => setShowTestModal(!showTestModal)}
            className="w-full mb-3 py-2 text-xs font-bold text-amber-600 hover:text-amber-700 dark:text-amber-400 border border-amber-200 dark:border-amber-800 hover:bg-amber-50 dark:hover:bg-amber-900/20 rounded-lg flex items-center justify-center gap-2 transition-colors"
          >
            <Phone className="w-3.5 h-3.5" /> {showTestModal ? 'Chiudi test chiamata' : 'Testa chiamata singola'}
          </button>
          {showTestModal && (
            <div className="mb-4 p-3 bg-amber-50 dark:bg-amber-900/10 rounded-lg border border-amber-200 dark:border-amber-800 animate-in fade-in slide-in-from-top-2">
              <div className="grid grid-cols-2 gap-2 mb-2">
                <input type="text" placeholder="Nome" value={testNome} onChange={e => setTestNome(e.target.value)}
                  className="px-2 py-1.5 text-xs border border-slate-200 dark:border-slate-700 rounded bg-white dark:bg-slate-900 dark:text-white focus:outline-none focus:border-brand-500" />
                <input type="tel" placeholder="+39..." value={testNumero} onChange={e => setTestNumero(e.target.value)}
                  className="px-2 py-1.5 text-xs border border-slate-200 dark:border-slate-700 rounded bg-white dark:bg-slate-900 dark:text-white focus:outline-none focus:border-brand-500" />
              </div>
              <button onClick={handleTestCall} disabled={testStatus.type === 'load' || !testNome.trim() || !testNumero.trim()}
                className="w-full py-1.5 text-xs font-bold bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-white rounded flex items-center justify-center gap-1.5 transition-colors">
                {testStatus.type === 'load' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Phone className="w-3 h-3" />}
                Chiama ora
              </button>
              {testStatus.type !== 'idle' && (
                <div className={cn("mt-2 text-xs font-medium p-2 rounded", testStatus.type === 'ok' ? 'text-green-700 bg-green-50' : testStatus.type === 'err' ? 'text-red-700 bg-red-50' : 'text-brand-700 bg-brand-50')}>
                  {testStatus.msg}
                </div>
              )}
            </div>
          )}

          {/* Salva lista */}
          {validContacts.length > 0 && !isSavingList && (
            <button onClick={() => setIsSavingList(true)}
              className="w-full mb-3 py-2 text-sm font-bold text-brand-600 hover:text-brand-700 dark:text-brand-400 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800/50 rounded-lg flex items-center justify-center gap-2 transition-colors">
              <Save className="w-4 h-4" /> Salva come Lista
            </button>
          )}
          {isSavingList && (
            <div className="mb-4 p-3 bg-slate-50 dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700 animate-in fade-in">
              <label className="block text-xs font-bold text-slate-500 mb-2">NOME LISTA</label>
              <input type="text" placeholder="Es. Clienti VIP" value={listName} onChange={e => setListName(e.target.value)}
                className="w-full px-3 py-2 bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-md text-sm mb-3 focus:outline-none focus:border-brand-500 dark:text-white" />
              <div className="flex gap-2">
                <button onClick={() => setIsSavingList(false)} className="flex-1 py-1.5 text-xs font-bold text-slate-500 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-md transition-colors">Annulla</button>
                <button onClick={handleSaveList} disabled={!listName.trim()} className="flex-1 py-1.5 text-xs font-bold bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white rounded-md transition-colors">Salva</button>
              </div>
            </div>
          )}

          {/* Launch button */}
          <button onClick={launchCampaign} disabled={isLaunching || validContacts.length === 0}
            className={cn(
              "w-full py-4 px-6 rounded-xl font-display font-extrabold text-base flex items-center justify-center gap-3 transition-all duration-200",
              validContacts.length === 0 ? "bg-slate-100 dark:bg-slate-800 text-slate-400 cursor-not-allowed"
                : "bg-brand-600 hover:bg-brand-700 text-white shadow-soft-blue hover:shadow-lg hover:-translate-y-0.5",
              isLaunching && "opacity-80 pointer-events-none"
            )}>
            {isLaunching ? <Loader2 className="w-5 h-5 animate-spin" /> : <Play className="w-5 h-5 fill-current" />}
            {getButtonText()}
          </button>

          {validContacts.length === 0 && !isLaunching && (
            <p className="mt-3 text-xs text-center font-medium text-slate-400">
              Carica almeno un contatto valido per avviare la campagna.
            </p>
          )}

          {launchStatus.type !== 'idle' && (
            <div className={cn(
              "mt-4 p-4 rounded-xl border flex items-start gap-3 text-sm font-medium animate-in fade-in zoom-in-95",
              launchStatus.type === 'ok' && "bg-green-50 border-green-200 text-green-700",
              launchStatus.type === 'err' && "bg-red-50 border-red-200 text-red-700",
              launchStatus.type === 'load' && "bg-brand-50 border-brand-200 text-brand-700"
            )}>
              {launchStatus.type === 'ok' ? <CheckCircle2 className="w-5 h-5 shrink-0 mt-0.5" /> : launchStatus.type === 'err' ? <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" /> : <Loader2 className="w-5 h-5 animate-spin shrink-0 mt-0.5" />}
              <span>
                {launchStatus.msg.replace(' — Vai in Assistenza per aprire un ticket.', '')}
                {launchStatus.type === 'err' && (
                  <> — <button
                    onClick={() => window.dispatchEvent(new CustomEvent('gem:nav', { detail: 'support' }))}
                    className="underline font-bold hover:opacity-80 transition-opacity"
                  >Vai in Assistenza</button> per aprire un ticket.</>
                )}
              </span>
            </div>
          )}
        </div>
      </div>
      )}

      {(mode === 'all' || mode === 'launch') && <ScheduledCampaigns />}

      {/* HISTORY CARD */}
      {(mode === 'all' || mode === 'history') && (
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-soft overflow-hidden">
        <div className="p-5 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/30 flex items-center justify-between">
          <h2 className="text-base font-bold text-slate-900 dark:text-white font-display">Storico Campagne</h2>
          <div className="flex items-center gap-2">
            <button onClick={exportHistoryToXLSX} title="Esporta tutto in Excel" aria-label="Esporta tutto in Excel"
              className="p-1.5 text-slate-400 hover:text-brand-600 hover:bg-brand-50 rounded-lg transition-colors">
              <DownloadCloud className="w-4 h-4" />
            </button>
            <button onClick={() => setShowFilters(!showFilters)} aria-label="Mostra filtri" aria-pressed={showFilters}
              className={cn("p-1.5 rounded-lg transition-colors", showFilters ? "text-brand-600 bg-brand-50" : "text-slate-400 hover:text-brand-600 hover:bg-brand-50")}>
              <Filter className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Filtri */}
        {showFilters && (
          <div className="p-4 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/20 space-y-3 animate-in fade-in slide-in-from-top-2">
            <div>
              <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-1">Operatore</label>
              <select value={historyFilter.operator} onChange={e => setHistoryFilter({...historyFilter, operator: e.target.value})}
                className="w-full px-3 py-2 text-xs bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg focus:outline-none dark:text-white">
                <option value="">Tutti</option>
                {operators.map(op => <option key={op} value={op}>{op}</option>)}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-1">Dal</label>
                <input type="date" value={historyFilter.dateFrom} onChange={e => setHistoryFilter({...historyFilter, dateFrom: e.target.value})}
                  className="w-full px-2 py-1.5 text-xs bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg focus:outline-none dark:text-white" />
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-1">Al</label>
                <input type="date" value={historyFilter.dateTo} onChange={e => setHistoryFilter({...historyFilter, dateTo: e.target.value})}
                  className="w-full px-2 py-1.5 text-xs bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg focus:outline-none dark:text-white" />
              </div>
            </div>
            {(historyFilter.operator || historyFilter.dateFrom || historyFilter.dateTo) && (
              <button onClick={() => setHistoryFilter({ operator: '', dateFrom: '', dateTo: '', search: '' })}
                className="flex items-center gap-1 text-xs font-bold text-red-500 hover:text-red-700 transition-colors">
                <X className="w-3 h-3" /> Rimuovi filtri
              </button>
            )}
          </div>
        )}

        <div>
          {filteredHistory.length === 0 ? (
            <div className="p-10 text-center">
              <div className="w-12 h-12 mx-auto mb-3 rounded-2xl bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-slate-400">
                <Clock className="w-6 h-6" />
              </div>
              <p className="text-sm font-semibold text-slate-500 dark:text-slate-400">
                {history.length === 0 ? 'Nessuna campagna ancora avviata' : 'Nessun risultato con i filtri attivi'}
              </p>
              {history.length === 0 && !isViewer && (
                <button onClick={() => window.dispatchEvent(new CustomEvent('gem:nav', { detail: 'campaign' }))}
                  className="mt-4 inline-flex items-center gap-2 px-4 py-2 bg-brand-600 hover:bg-brand-700 text-white text-sm font-bold rounded-lg transition-colors">
                  <Play className="w-3.5 h-3.5 fill-current" /> Crea la prima campagna
                </button>
              )}
            </div>
          ) : (
            <div className="max-h-[32rem] overflow-y-auto">
              {groupHistoryByDay(filteredHistory).map((group, gi) => (
                <div key={gi}>
                  {/* Header giorno, sticky come nel registro chiamate del telefono */}
                  <div className="sticky top-0 z-10 px-4 py-1.5 bg-slate-100/90 dark:bg-slate-800/90 backdrop-blur-sm text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider capitalize">
                    {group.label}
                  </div>
                  <div className="divide-y divide-slate-100 dark:divide-slate-800">
                    {group.items.map((h, i) => (
                      <div key={i} className="flex items-center gap-3 px-4 py-3 hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors">
                        {/* Icona tipo campagna, come icone chiamata in/out */}
                        <div className={cn(
                          "w-9 h-9 rounded-full flex items-center justify-center shrink-0",
                          h.scheduledAt ? "bg-accent-50 dark:bg-accent-900/30 text-accent-600 dark:text-accent-400" : "bg-green-50 dark:bg-green-900/30 text-green-600 dark:text-green-400"
                        )}>
                          <Phone className="w-4 h-4" />
                        </div>

                        {/* Info principale */}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-semibold text-slate-900 dark:text-white">
                              {h.scheduledAt ? 'Campagna pianificata' : 'Campagna immediata'}
                            </span>
                          </div>
                          <div className="text-xs text-slate-500 truncate">
                            {h.opt}{h.chunkSize > 1 ? ` · ${h.chunkSize} simul.` : ''}
                            {h.note && <span className="italic"> · "{h.note}"</span>}
                          </div>
                        </div>

                        {/* Orario + numero chiamate, come il registro del telefono */}
                        <div className="text-right shrink-0">
                          <div className="text-sm font-bold text-slate-900 dark:text-white leading-none">
                            {format(new Date(h.ts), 'HH:mm')}
                          </div>
                          <div className="text-[10px] font-semibold text-brand-600 dark:text-brand-400 mt-1">
                            {h.count} chiamate
                          </div>
                        </div>

                        {h.contactsList && h.contactsList.length > 0 && (
                          <button onClick={() => exportSingleHistory(h)} title="Esporta in Excel" aria-label="Esporta in Excel"
                            className="p-1.5 text-slate-400 hover:text-brand-600 hover:bg-brand-50 dark:hover:bg-brand-900/20 rounded-lg transition-colors shrink-0">
                            <DownloadCloud className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
              {/* Lo storico è condiviso: lo può svuotare solo un Admin */}
              {user?.isAdmin && (
                <button onClick={async () => {
                    if (!window.confirm('Vuoi cancellare lo storico di tutte le campagne? Sparisce per tutti gli utenti.')) return;
                    const r = await clearHistory();
                    if (!r.ok) window.alert(r.error || 'Storico non cancellato');
                  }}
                  className="w-full p-3 text-xs font-bold text-red-500 hover:bg-red-50 dark:hover:bg-red-900/10 transition-colors flex items-center justify-center gap-2">
                  <Trash2 className="w-3.5 h-3.5" /> Cancella Storico
                </button>
              )}
            </div>
          )}
        </div>
      </div>
      )}
    </div>
  );
}
