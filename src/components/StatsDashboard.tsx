import React, { useEffect, useState } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend } from 'recharts';
import { Phone, PhoneIncoming, PhoneOff, Timer, BellRing, Send, RefreshCw, BarChart2, CalendarClock, LogIn, Download } from 'lucide-react';
import * as XLSX from 'xlsx';
import { format, subDays, startOfDay } from 'date-fns';
import { useCampaign } from '../context/CampaignContext';
import { authFetch } from '../lib/authFetch';
import { cn } from '../lib/utils';

type Days = 1 | 7 | 30 | 90;

interface StatsResponse {
  ok: boolean;
  days: Days;
  chiamate: { totale: number; risposte: number; non_risposte: number; durata_media_ms: number | null };
  perGiorno: { giorno: string; risposte: number; non_risposte: number }[];
  followupAperti: { motivo: string; totale: number }[];
  campagne: { campagne: number; contatti: number; immediate: number; pianificate: number } | null;
  perOperatore: { operatore: string; campagne: number; contatti: number }[];
  pianificateInAttesa: number;
  registroCampagneDal: string | null;
  perVoicebot?: Confronto[];
  perFascia?: (Confronto & { ora: number })[];
  esitiFollowup?: { totale: number; positivi: number; perEsito: { esito: string; label: string; n: number }[]; perPersona: { persona: string; chiusi: number; positivi: number }[] };
}

// Confronto tra voicebot e tra fasce orarie (chiamate delle campagne del sito).
interface Confronto {
  voicebot?: string;
  chiamate: number;
  risposte: number;
  interrotte: number;
  nonRaggiunte: number;
  interessati: number;
  durataMediaMs: number | null;
}

const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 100) : 0);

interface AccessLog { ts: string; username: string; nome: string; action: string }

const PERIODS: { days: Days; label: string }[] = [
  { days: 1, label: 'Oggi' },
  { days: 7, label: '7 giorni' },
  { days: 30, label: '30 giorni' },
  { days: 90, label: '90 giorni' },
];

// Colori dei due esiti, verificati per daltonismo e contrasto su sfondo
// chiaro e scuro (validatore palette): blu = risposte, ambra = non risposte.
const COLORS = {
  light: { risposte: '#2563eb', nonRisposte: '#d97706' },
  dark: { risposte: '#3b82f6', nonRisposte: '#d97706' },
};

function formatDurata(ms: number | null) {
  if (!ms) return '—';
  const sec = Math.round(ms / 1000);
  return `${Math.floor(sec / 60)}:${(sec % 60).toString().padStart(2, '0')}`;
}

function StatCard({ label, value, sub, icon: Icon, loading }: { label: string; value: React.ReactNode; sub?: string; icon: any; loading: boolean }) {
  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 shadow-soft">
      <div className="w-10 h-10 rounded-xl flex items-center justify-center mb-3 bg-slate-100 dark:bg-slate-800">
        <Icon className="w-5 h-5 text-slate-500 dark:text-slate-400" />
      </div>
      <div className="text-2xl font-extrabold text-slate-900 dark:text-white font-display">{loading ? '…' : value}</div>
      <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider mt-1">{label}</div>
      {sub && !loading && <div className="text-xs text-slate-400 mt-0.5">{sub}</div>}
    </div>
  );
}

function Card({ title, children, right }: { title: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 shadow-soft">
      <div className="flex items-center justify-between mb-5 gap-3">
        <h3 className="text-sm font-bold text-slate-900 dark:text-white uppercase tracking-wider">{title}</h3>
        {right}
      </div>
      {children}
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div className="h-40 flex flex-col items-center justify-center gap-3 text-slate-400">
      <BarChart2 className="w-10 h-10 opacity-30" />
      <span className="text-sm">{text}</span>
    </div>
  );
}

export function StatsDashboard() {
  const { user, darkMode } = useCampaign();
  const isAdmin = user?.isAdmin || user?.role === 'Admin';
  const [days, setDays] = useState<Days>(() => {
    try { return (Number(localStorage.getItem('gem_stats_days')) as Days) || 30; } catch { return 30; }
  });
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [logs, setLogs] = useState<AccessLog[]>([]);
  const [showTable, setShowTable] = useState(false);

  const load = async (d: Days = days) => {
    setLoading(true);
    setError('');
    try {
      const res = await authFetch(`/api/stats?days=${d}`);
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error);
      setStats(data);
    } catch (e: any) {
      setError(e?.message || 'Impossibile caricare le statistiche.');
    }
    setLoading(false);
  };

  useEffect(() => {
    load(days);
    try { localStorage.setItem('gem_stats_days', String(days)); } catch { /* storage non disponibile */ }
  }, [days]);

  // Il periodo scelto è salvato anche sul server, così è uguale su ogni dispositivo.
  useEffect(() => {
    authFetch('/api/preferenze').then(r => r.ok ? r.json() : null)
      .then(d => { const g = Number(d?.preferenze?.statsGiorni); if ([1, 7, 30, 90].includes(g)) setDays(g as Days); })
      .catch(() => {});
  }, []);
  const scegliPeriodo = (d: Days) => {
    setDays(d);
    authFetch('/api/preferenze', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ statsGiorni: d }) }).catch(() => {});
  };

  useEffect(() => {
    if (!isAdmin) return;
    authFetch('/api/access-logs').then(r => r.json()).then(d => setLogs(d.logs || [])).catch(() => setLogs([]));
  }, [isAdmin]);

  const c = stats?.chiamate;
  const tasso = c && c.totale > 0 ? Math.round((c.risposte / c.totale) * 100) : null;
  const followupTot = (stats?.followupAperti || []).reduce((s, f) => s + f.totale, 0);
  const maxFollowup = Math.max(1, ...(stats?.followupAperti || []).map(f => f.totale));
  const maxOperatore = Math.max(1, ...(stats?.perOperatore || []).map(o => o.contatti));
  const palette = darkMode ? COLORS.dark : COLORS.light;

  // Un punto per ogni giorno del periodo, anche quelli senza chiamate
  const giorni = Array.from({ length: days }, (_, i) => {
    const d = startOfDay(subDays(new Date(), days - 1 - i));
    const key = format(d, 'yyyy-MM-dd');
    const found = stats?.perGiorno.find(g => g.giorno === key);
    return { label: format(d, 'dd/MM'), risposte: found?.risposte || 0, non_risposte: found?.non_risposte || 0 };
  });

  const periodLabel = PERIODS.find(p => p.days === days)?.label.toLowerCase();

  // Esporta il periodo scelto in un file Excel, un foglio per sezione
  const exportXlsx = () => {
    if (!stats) return;
    const wb = XLSX.utils.book_new();
    const add = (name: string, rows: Record<string, any>[], cols: number[]) => {
      const ws = XLSX.utils.json_to_sheet(rows.length ? rows : [{ Nota: 'Nessun dato nel periodo' }]);
      ws['!cols'] = cols.map(wch => ({ wch }));
      XLSX.utils.book_append_sheet(wb, ws, name);
    };
    add('Riepilogo', [
      { Voce: 'Periodo', Valore: PERIODS.find(p => p.days === days)?.label },
      { Voce: 'Esportato il', Valore: new Date().toLocaleString('it-IT') },
      { Voce: 'Chiamate', Valore: c?.totale ?? 0 },
      { Voce: 'Risposte', Valore: c?.risposte ?? 0 },
      { Voce: 'Non risposte', Valore: c?.non_risposte ?? 0 },
      { Voce: 'Tasso di risposta (%)', Valore: tasso ?? '' },
      { Voce: 'Durata media (min:sec)', Valore: formatDurata(c?.durata_media_ms ?? null) },
      { Voce: 'Follow-up aperti (totale)', Valore: followupTot },
      { Voce: 'Campagne avviate', Valore: stats.campagne?.campagne ?? 0 },
      { Voce: 'Contatti chiamati', Valore: stats.campagne?.contatti ?? 0 },
      { Voce: 'Campagne immediate', Valore: stats.campagne?.immediate ?? 0 },
      { Voce: 'Campagne pianificate', Valore: stats.campagne?.pianificate ?? 0 },
      { Voce: 'Pianificate in attesa', Valore: stats.pianificateInAttesa },
    ], [28, 22]);
    add('Chiamate per giorno', giorni.map(g => ({
      Giorno: g.label, Risposte: g.risposte, 'Non risposte': g.non_risposte, Totale: g.risposte + g.non_risposte,
    })), [12, 10, 14, 10]);
    add('Follow-up per motivo', stats.followupAperti.map(f => ({ Motivo: f.motivo, 'Da gestire': f.totale })), [34, 12]);
    add('Per operatore', stats.perOperatore.map(o => ({ Operatore: o.operatore, Campagne: o.campagne, Contatti: o.contatti })), [24, 10, 10]);
    add('Per voicebot', (stats.perVoicebot || []).map(v => ({
      Voicebot: v.voicebot, Chiamate: v.chiamate, Risposte: v.risposte, 'Risposte (%)': pct(v.risposte, v.chiamate),
      Interrotte: v.interrotte, 'Non raggiunti': v.nonRaggiunte, 'Interessati o appuntamenti': v.interessati,
      'Durata media': formatDurata(v.durataMediaMs),
    })), [28, 10, 10, 12, 10, 14, 24, 14]);
    if (stats.esitiFollowup?.totale) add('Esiti follow-up', stats.esitiFollowup.perEsito.map(x => ({ Esito: x.label, 'Follow-up chiusi': x.n })), [28, 16]);
    add('Per fascia oraria', (stats.perFascia || []).map(f => ({
      Ora: `${String(f.ora).padStart(2, '0')}:00–${String(f.ora + 1).padStart(2, '0')}:00`, Chiamate: f.chiamate, Risposte: f.risposte,
      'Risposte (%)': pct(f.risposte, f.chiamate), 'Interessati o appuntamenti': f.interessati,
    })), [14, 10, 10, 12, 24]);
    if (isAdmin) {
      add('Registro accessi', logs.map(l => ({
        Quando: new Date(l.ts).toLocaleString('it-IT'), Utente: l.nome || l.username, Username: l.username,
        Azione: l.action === 'login' ? 'Accesso' : l.action === 'logout' ? 'Uscita' : l.action,
      })), [20, 20, 16, 10]);
    }
    XLSX.writeFile(wb, `statistiche-${days === 1 ? 'oggi' : `${days}-giorni`}-${new Date().toISOString().slice(0, 10)}.xlsx`);
  };

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-300">

      {/* Filtri */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex rounded-xl border border-slate-200 dark:border-slate-700 overflow-hidden text-sm font-semibold bg-white dark:bg-slate-900" role="tablist" aria-label="Periodo">
          {PERIODS.map(p => (
            <button key={p.days} role="tab" aria-selected={days === p.days} onClick={() => scegliPeriodo(p.days)}
              className={cn('px-4 py-2 transition-colors', days === p.days ? 'bg-brand-600 text-white' : 'text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800')}>
              {p.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <button onClick={exportXlsx} disabled={loading || !stats} className="inline-flex items-center gap-2 text-sm font-semibold text-slate-500 hover:text-brand-600 px-3 py-2 rounded-lg hover:bg-brand-50 dark:hover:bg-slate-800 transition-colors disabled:opacity-40">
            <Download className="w-4 h-4" /> Esporta Excel
          </button>
          <button onClick={() => load()} className="inline-flex items-center gap-2 text-sm font-semibold text-slate-500 hover:text-brand-600 px-3 py-2 rounded-lg hover:bg-brand-50 dark:hover:bg-slate-800 transition-colors">
            <RefreshCw className={cn('w-4 h-4', loading && 'animate-spin')} /> Aggiorna
          </button>
        </div>
      </div>

      {error && <p className="text-sm text-red-500">{error}</p>}

      {/* KPI */}
      <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
        <StatCard loading={loading} icon={Phone} label="Chiamate" value={c?.totale ?? '—'} sub={periodLabel} />
        <StatCard loading={loading} icon={PhoneIncoming} label="Tasso di risposta" value={tasso !== null ? `${tasso}%` : '—'} sub={c ? `${c.risposte} risposte` : undefined} />
        <StatCard loading={loading} icon={PhoneOff} label="Non risposte" value={c?.non_risposte ?? '—'} />
        <StatCard loading={loading} icon={Timer} label="Durata media" value={formatDurata(c?.durata_media_ms ?? null)} sub="min:sec, solo risposte" />
        <StatCard loading={loading} icon={BellRing} label="Follow-up aperti" value={followupTot} sub="da gestire, totale" />
        <StatCard loading={loading} icon={Send} label="Campagne avviate" value={stats?.campagne?.campagne ?? 0}
          sub={stats?.campagne ? `${stats.campagne.contatti} contatti · ${stats.pianificateInAttesa} pianificate in attesa` : undefined} />
      </div>

      {/* Chiamate per giorno */}
      <Card title={`Chiamate per giorno — ${periodLabel}`}
        right={c && c.totale > 0 ? (
          <button onClick={() => setShowTable(v => !v)} className="text-xs font-semibold text-brand-600 dark:text-brand-400 hover:underline">
            {showTable ? 'Mostra grafico' : 'Mostra tabella'}
          </button>
        ) : undefined}>
        {loading ? <div className="h-56" /> : !c || c.totale === 0 ? <Empty text="Nessuna chiamata nel periodo" /> : showTable ? (
          <div className="max-h-72 overflow-auto">
            <table className="w-full text-sm">
              <thead className="text-xs text-slate-500 uppercase">
                <tr><th className="text-left py-2">Giorno</th><th className="text-right">Risposte</th><th className="text-right">Non risposte</th><th className="text-right">Totale</th></tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800 text-slate-700 dark:text-slate-300">
                {giorni.filter(g => g.risposte + g.non_risposte > 0).reverse().map(g => (
                  <tr key={g.label}><td className="py-1.5">{g.label}</td><td className="text-right">{g.risposte}</td><td className="text-right">{g.non_risposte}</td><td className="text-right font-semibold">{g.risposte + g.non_risposte}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={giorni} barCategoryGap="20%">
              <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="rgba(100,116,139,0.15)" />
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false}
                interval={days > 30 ? 9 : days > 7 ? 4 : 0} />
              <YAxis tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} allowDecimals={false} width={32} />
              <Tooltip cursor={{ fill: 'rgba(100,116,139,0.08)' }}
                contentStyle={{ background: '#1e293b', border: 'none', borderRadius: 8, fontSize: 12 }}
                labelStyle={{ color: '#94a3b8' }} itemStyle={{ color: '#e2e8f0' }} />
              <Legend formatter={(v) => <span className="text-xs text-slate-500">{v}</span>} />
              <Bar dataKey="risposte" name="Risposte" stackId="a" fill={palette.risposte} stroke={darkMode ? '#0f172a' : '#ffffff'} strokeWidth={1} />
              <Bar dataKey="non_risposte" name="Non risposte" stackId="a" fill={palette.nonRisposte} radius={[4, 4, 0, 0]} stroke={darkMode ? '#0f172a' : '#ffffff'} strokeWidth={1} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Follow-up aperti per motivo */}
        <Card title="Follow-up da gestire, per motivo">
          {loading ? <div className="h-40" /> : followupTot === 0 ? <Empty text="Nessun follow-up aperto" /> : (
            <div className="space-y-3">
              {stats!.followupAperti.map(f => (
                <div key={f.motivo}>
                  <div className="flex items-center justify-between mb-1 text-sm">
                    <span className="text-slate-700 dark:text-slate-300">{f.motivo}</span>
                    <span className="font-bold text-slate-900 dark:text-white">{f.totale}</span>
                  </div>
                  <div className="w-full h-2 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
                    <div className="h-full rounded-full" style={{ width: `${Math.round((f.totale / maxFollowup) * 100)}%`, background: palette.risposte }} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

        {/* Per operatore */}
        <Card title={`Campagne per operatore — ${periodLabel}`}>
          {loading ? <div className="h-40" /> : (stats?.perOperatore.length || 0) === 0 ? (
            <Empty text="Nessuna campagna registrata nel periodo" />
          ) : (
            <div className="space-y-3">
              {stats!.perOperatore.map(o => (
                <div key={o.operatore}>
                  <div className="flex items-center justify-between mb-1 text-sm">
                    <span className="font-semibold text-slate-900 dark:text-white">{o.operatore}</span>
                    <span className="text-slate-500">{o.contatti} contatti · {o.campagne} {o.campagne === 1 ? 'campagna' : 'campagne'}</span>
                  </div>
                  <div className="w-full h-2 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
                    <div className="h-full rounded-full" style={{ width: `${Math.round((o.contatti / maxOperatore) * 100)}%`, background: palette.risposte }} />
                  </div>
                </div>
              ))}
              {stats?.campagne && stats.campagne.campagne > 0 && (
                <p className="text-xs text-slate-400 pt-1 flex items-center gap-1">
                  <CalendarClock className="w-3.5 h-3.5" />
                  {stats.campagne.immediate} immediate · {stats.campagne.pianificate} pianificate
                </p>
              )}
            </div>
          )}
          {stats?.registroCampagneDal && (
            <p className="text-xs text-slate-400 mt-4">
              Campagne registrate dal {new Date(stats.registroCampagneDal).toLocaleDateString('it-IT')}.
            </p>
          )}
        </Card>
      </div>

      {/* Confronto voicebot e fasce orarie */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card title={`Confronto voicebot — ${periodLabel}`}>
          {loading ? <div className="h-40" /> : (stats?.perVoicebot?.length || 0) === 0 ? (
            <Empty text="Nessuna chiamata delle campagne del sito nel periodo" />
          ) : (
            <div className="overflow-x-auto -mx-2">
              <table className="w-full text-sm min-w-[26rem]">
                <thead className="text-[11px] text-slate-500 uppercase tracking-wide">
                  <tr>
                    <th className="text-left font-semibold px-2 pb-2">Voicebot</th>
                    <th className="text-right font-semibold px-2 pb-2">Chiamate</th>
                    <th className="text-left font-semibold px-2 pb-2 w-36">Risposte</th>
                    <th className="text-right font-semibold px-2 pb-2" title="Interessati o appuntamento fissato, dal riassunto di Wilma">Interessati</th>
                    <th className="text-right font-semibold px-2 pb-2">Durata</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800 text-slate-700 dark:text-slate-300">
                  {stats!.perVoicebot!.map(v => (
                    <tr key={v.voicebot}>
                      <td className="px-2 py-2 font-semibold text-slate-900 dark:text-white min-w-[10rem]">{v.voicebot}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{v.chiamate}</td>
                      <td className="px-2 py-2">
                        <div className="flex items-center gap-2">
                          <div className="flex-1 h-2 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
                            <div className="h-full rounded-full" style={{ width: `${pct(v.risposte, v.chiamate)}%`, background: palette.risposte }} />
                          </div>
                          <span className="tabular-nums text-xs w-9 text-right">{pct(v.risposte, v.chiamate)}%</span>
                        </div>
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums">{v.interessati}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{formatDurata(v.durataMediaMs)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card title={`Risposte per fascia oraria — ${periodLabel}`}>
          {loading ? <div className="h-40" /> : (stats?.perFascia?.length || 0) === 0 ? (
            <Empty text="Nessuna chiamata delle campagne del sito nel periodo" />
          ) : (() => {
            const fasce = stats!.perFascia!;
            // La fascia migliore si indica solo con abbastanza chiamate per essere affidabile.
            const migliore = fasce.filter(f => f.chiamate >= 5).sort((a, b) => pct(b.risposte, b.chiamate) - pct(a.risposte, a.chiamate))[0];
            return (
              <div className="space-y-2">
                {fasce.map(f => (
                  <div key={f.ora} className="flex items-center gap-3 text-sm">
                    <span className="w-24 shrink-0 tabular-nums text-slate-600 dark:text-slate-300">{String(f.ora).padStart(2, '0')}:00–{String(f.ora + 1).padStart(2, '0')}:00</span>
                    <div className="flex-1 h-2.5 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
                      <div className="h-full rounded-full" style={{ width: `${pct(f.risposte, f.chiamate)}%`, background: palette.risposte }} />
                    </div>
                    <span className="w-28 shrink-0 text-right text-xs text-slate-500 tabular-nums">
                      <strong className="text-slate-900 dark:text-white">{pct(f.risposte, f.chiamate)}%</strong> · {f.risposte}/{f.chiamate}
                    </span>
                  </div>
                ))}
                {migliore && (
                  <p className="text-xs text-slate-500 pt-2">
                    Fascia con più risposte: <strong className="text-slate-800 dark:text-slate-200">{String(migliore.ora).padStart(2, '0')}:00–{String(migliore.ora + 1).padStart(2, '0')}:00</strong> ({pct(migliore.risposte, migliore.chiamate)}% su {migliore.chiamate} chiamate).
                  </p>
                )}
              </div>
            );
          })()}
        </Card>
      </div>

      {/* Com'è finita: esito dei follow-up chiusi */}
      <Card title={`Esito dei follow-up chiusi — ${periodLabel}`}>
        {loading ? <div className="h-32" /> : !stats?.esitiFollowup?.totale ? (
          <Empty text="Nessun follow-up chiuso con esito nel periodo. Quando premi Fatto scegli com'è andata." />
        ) : (() => {
          const e = stats.esitiFollowup!;
          const max = Math.max(1, ...e.perEsito.map(x => x.n));
          const colore: Record<string, string> = { venduto: '#16a34a', appuntamento: '#059669', preventivo: '#2563eb', non_interessato: '#94a3b8', non_raggiungibile: '#d97706', altro: '#94a3b8', non_indicato: '#cbd5e1' };
          return (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <div className="space-y-2">
                <p className="text-sm text-slate-600 dark:text-slate-300">
                  <strong className="text-2xl font-bold text-slate-900 dark:text-white tabular-nums">{pct(e.positivi, e.totale)}%</strong>
                  <span className="ml-2">chiusi con vendita o appuntamento ({e.positivi} su {e.totale})</span>
                </p>
                {e.perEsito.map(x => (
                  <div key={x.esito} className="flex items-center gap-3 text-sm">
                    <span className="w-44 shrink-0 text-slate-600 dark:text-slate-300 truncate">{x.label}</span>
                    <div className="flex-1 h-2.5 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
                      <div className="h-full rounded-full" style={{ width: `${(x.n / max) * 100}%`, background: colore[x.esito] || '#94a3b8' }} />
                    </div>
                    <span className="w-10 shrink-0 text-right text-xs font-semibold text-slate-700 dark:text-slate-200 tabular-nums">{x.n}</span>
                  </div>
                ))}
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-xs text-slate-500 uppercase">
                    <tr><th className="text-left py-2">Persona</th><th className="text-right">Chiusi</th><th className="text-right">Vendite + appunt.</th><th className="text-right">%</th></tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800 text-slate-700 dark:text-slate-300">
                    {e.perPersona.map(p => (
                      <tr key={p.persona}>
                        <td className="py-1.5">{p.persona}</td>
                        <td className="text-right tabular-nums">{p.chiusi}</td>
                        <td className="text-right tabular-nums">{p.positivi}</td>
                        <td className="text-right tabular-nums font-semibold">{pct(p.positivi, p.chiusi)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          );
        })()}
      </Card>

      {/* Registro accessi (solo Admin) */}
      {isAdmin && (
        <Card title="Registro accessi" right={<LogIn className="w-4 h-4 text-slate-400" />}>
          {logs.length === 0 ? <Empty text="Nessun accesso registrato" /> : (
            <div className="max-h-72 overflow-auto">
              <table className="w-full text-sm">
                <thead className="text-xs text-slate-500 uppercase sticky top-0 bg-white dark:bg-slate-900">
                  <tr><th className="text-left py-2">Quando</th><th className="text-left">Utente</th><th className="text-left">Azione</th></tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800 text-slate-700 dark:text-slate-300">
                  {logs.slice(0, 100).map((l, i) => (
                    <tr key={i}>
                      <td className="py-1.5 whitespace-nowrap">{new Date(l.ts).toLocaleString('it-IT', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</td>
                      <td>{l.nome || l.username}</td>
                      <td>{l.action === 'login' ? 'Accesso' : l.action === 'logout' ? 'Uscita' : l.action}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
