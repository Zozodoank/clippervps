import React, { useEffect, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, Loader2, Play, Square, Zap, ShieldCheck, Sparkles, Clock, Layers } from 'lucide-react';

const DEFAULT_NICHES = [
  {
    id: 'kitchen_tools',
    name: 'Alat Dapur & Kebutuhan Rumah',
    shortName: 'Alat Dapur',
    icon: '🍳',
    tagline: 'Video affiliate alat dapur, perabot praktis & pembersih faceless hands-on.',
    badgeColor: '#10b981',
  },
  {
    id: 'gadget_smartphone',
    name: 'Smartphone & Gadget Viral',
    shortName: 'Smartphone & Gadget',
    icon: '📱',
    tagline: 'Review smartphone, spesifikasi gahar, gaming & kamera B-roll faceless.',
    badgeColor: '#3b82f6',
  },
];

export default function AutoModePanel({ settings, onHistoryRefresh }) {
  const [run, setRun] = useState({ status: 'idle' });
  const [isStarting, setIsStarting] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [keywordStats, setKeywordStats] = useState({ totalUsedKeywords: 0, totalUsedTitles: 0 });
  const [dailyStats, setDailyStats] = useState({ limit: 20, count: 0, remaining: 20, isLimitReached: false });
  const [availableNiches, setAvailableNiches] = useState(DEFAULT_NICHES);
  const [selectedNiche, setSelectedNiche] = useState(() => {
    try {
      return localStorage.getItem('clipper_niche') || 'kitchen_tools';
    } catch {
      return 'kitchen_tools';
    }
  });

  const eventSourceRef = useRef(null);
  const lastSuccessCountRef = useRef(0);

  const isRunning = run.status === 'running' || run.status === 'stopping';
  const successfulJobs = run.successfulJobs || 0;
  const failedJobs = run.failedJobs || 0;
  const skippedProducts = run.skippedProducts || 0;
  const maxJobs = run.maxJobs || 'unlimited';
  const isUnlimited = maxJobs === 'unlimited' || maxJobs === Infinity;

  const activeNicheId = isRunning && run.niche ? run.niche : selectedNiche;
  const currentNichePreset = availableNiches.find((n) => n.id === activeNicheId) || availableNiches[0];

  const fetchDailyStats = () => {
    fetch('/api/daily-limit')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data) setDailyStats(data);
      })
      .catch((err) => console.warn('Could not fetch daily stats:', err.message));
  };

  const fetchKeywordStats = () => {
    fetch('/api/auto/keywords/stats')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data) setKeywordStats(data);
      })
      .catch((err) => console.warn('Could not fetch keyword stats:', err.message));
  };

  const fetchNiches = () => {
    fetch('/api/niches')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.niches && Array.isArray(data.niches) && data.niches.length > 0) {
          setAvailableNiches(data.niches);
        }
      })
      .catch((err) => console.warn('Could not fetch niches:', err.message));
  };

  useEffect(() => {
    fetchDailyStats();
    fetchKeywordStats();
    fetchNiches();

    fetch('/api/auto/status')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.run) {
          setRun(data.run);
          if (data.run.dailyStats) setDailyStats(data.run.dailyStats);
          if (data.run.niche && (data.run.status === 'running' || data.run.status === 'stopping')) {
            setSelectedNiche(data.run.niche);
            try {
              localStorage.setItem('clipper_niche', data.run.niche);
            } catch {}
          }
          lastSuccessCountRef.current = data.run.successfulJobs || 0;
          if (data.run.runId && (data.run.status === 'running' || data.run.status === 'stopping')) {
            connectProgress(data.run.runId);
          }
        }
      })
      .catch((err) => console.warn('Could not fetch auto status:', err.message));

    return () => {
      if (eventSourceRef.current) eventSourceRef.current.close();
    };
  }, []);

  const connectProgress = (runId) => {
    if (eventSourceRef.current) eventSourceRef.current.close();
    const sse = new EventSource(`/api/auto/progress/${runId}`);
    eventSourceRef.current = sse;

    sse.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (!data.run) return;
        setRun(data.run);
        if (data.run.dailyStats) setDailyStats(data.run.dailyStats);

        const nextSuccessCount = data.run.successfulJobs || 0;
        if (nextSuccessCount !== lastSuccessCountRef.current) {
          lastSuccessCountRef.current = nextSuccessCount;
          fetchKeywordStats();
          fetchDailyStats();
          onHistoryRefresh?.();
        }

        if (['completed', 'stopped', 'error'].includes(data.run.status)) {
          fetchKeywordStats();
          fetchDailyStats();
          onHistoryRefresh?.();
          sse.close();
        }
      } catch (err) {
        console.warn('Could not parse auto progress:', err.message);
      }
    };
    sse.onerror = () => sse.close();
  };

  const handleSelectNiche = (nicheId) => {
    if (isRunning) return;
    setSelectedNiche(nicheId);
    try {
      localStorage.setItem('clipper_niche', nicheId);
    } catch {}
  };

  const handleStart = async () => {
    setIsStarting(true);
    try {
      const response = await fetch('/api/auto/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          maxJobs: 'unlimited',
          niche: selectedNiche,
          candidateDepth: { shopee: 5, youtube: 10 },
          options: {
            hflip: settings.hflip !== undefined ? settings.hflip : false,
            speedMultiplier: settings.speedMultiplier || 1,
            niche: selectedNiche,
          },
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Gagal memulai Auto Mode.');
      setRun(data.run);
      if (data.run?.dailyStats) setDailyStats(data.run.dailyStats);
      lastSuccessCountRef.current = data.run.successfulJobs || 0;
      connectProgress(data.run.runId);
    } catch (err) {
      setRun((prev) => ({ ...prev, status: 'error', message: err.message }));
    } finally {
      setIsStarting(false);
    }
  };

  const handleStop = async () => {
    if (!run.runId) return;
    setIsStopping(true);
    try {
      const response = await fetch('/api/auto/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId: run.runId }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Gagal menghentikan Auto Mode.');
      setRun(data.run);
      if (data.run?.dailyStats) setDailyStats(data.run.dailyStats);
    } catch (err) {
      setRun((prev) => ({ ...prev, status: 'error', message: err.message }));
    } finally {
      setIsStopping(false);
    }
  };

  return (
    <div className="glass-panel rounded-2xl p-5 shadow-xl border border-slate-700/60">
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <Zap className="w-5 h-5 text-amber-400" />
            <h2 className="text-lg font-black text-white">Auto Mode</h2>
            <span className={`text-[10px] uppercase font-bold px-2 py-0.5 rounded-full border ${statusClass(run.status)}`}>
              {statusLabel(run.status)}
            </span>
          </div>
          <p className="text-xs text-slate-400 mt-1">
            Auto-Run Berkelanjutan: Pipeline 9:16 vertikal otomatis dengan batasan harian anti-blokir IP (maks. 20 video/hari).
          </p>

          <div className="flex flex-wrap items-center gap-2 mt-2.5">
            <span
              className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-medium border ${
                dailyStats.isLimitReached
                  ? 'bg-rose-500/10 text-rose-300 border-rose-500/30'
                  : 'bg-amber-500/10 text-amber-300 border-amber-500/30'
              }`}
            >
              <Clock className="w-3.5 h-3.5 text-amber-400" />
              <span>
                Batas Anti-Blokir: <strong>{dailyStats.count}/{dailyStats.limit}</strong> video/hari
              </span>
            </span>

            <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-medium bg-emerald-500/10 text-emerald-300 border border-emerald-500/30">
              <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
              <span>
                Anti-Duplikasi: <strong>{keywordStats.totalUsedKeywords || 0}</strong> kata kunci
              </span>
            </span>

            <span
              className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-medium border ${
                activeNicheId === 'gadget_smartphone'
                  ? 'bg-blue-500/10 text-blue-300 border-blue-500/30'
                  : 'bg-indigo-500/10 text-indigo-300 border-indigo-500/30'
              }`}
            >
              <Sparkles className="w-3.5 h-3.5 text-current" />
              <span>
                Niche Aktif: <strong>{currentNichePreset.shortName || currentNichePreset.name}</strong>
              </span>
            </span>
          </div>

          {/* Niche Selector Tabs */}
          <div className="mt-3.5 pt-3 border-t border-slate-700/50">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[11px] uppercase font-bold tracking-wider text-slate-400 flex items-center gap-1.5">
                <Layers className="w-3.5 h-3.5 text-slate-400" />
                Pilih Target Niche (Format 9:16 Vertikal):
              </span>
              {isRunning && (
                <span className="text-[10px] text-amber-400 font-medium">
                  Niche terkunci saat proses berjalan
                </span>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {availableNiches.map((n) => {
                const isActive = activeNicheId === n.id;
                const isGadget = n.id === 'gadget_smartphone';
                return (
                  <button
                    key={n.id}
                    type="button"
                    onClick={() => handleSelectNiche(n.id)}
                    disabled={isRunning}
                    className={`relative text-left p-3 rounded-xl border transition-all duration-200 ${
                      isActive
                        ? isGadget
                          ? 'bg-blue-500/15 border-blue-500/60 shadow-lg shadow-blue-900/20'
                          : 'bg-emerald-500/15 border-emerald-500/60 shadow-lg shadow-emerald-900/20'
                        : 'bg-slate-800/40 border-slate-700/60 hover:bg-slate-800/80 hover:border-slate-600/70'
                    } ${isRunning ? 'opacity-70 cursor-not-allowed' : 'cursor-pointer'}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="text-xl leading-none">{n.icon}</span>
                        <span className={`text-xs font-black ${isActive ? (isGadget ? 'text-blue-300' : 'text-emerald-300') : 'text-white'}`}>
                          {n.name}
                        </span>
                      </div>
                      {isActive && (
                        <span className={`text-[10px] uppercase font-bold px-2 py-0.5 rounded-full ${isGadget ? 'bg-blue-500/20 text-blue-300 border border-blue-500/40' : 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'}`}>
                          Aktif
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] text-slate-400 mt-1 line-clamp-1">
                      {n.tagline}
                    </p>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <div className="flex sm:flex-row lg:flex-col gap-2 w-full lg:w-44 flex-shrink-0 justify-center">
          <button
            type="button"
            onClick={handleStart}
            disabled={isRunning || isStarting || dailyStats.isLimitReached}
            title={
              dailyStats.isLimitReached
                ? `Batas harian ${dailyStats.limit} video telah tercapai untuk mencegah pemblokiran IP.`
                : 'Mulai Auto Mode'
            }
            className="flex-1 lg:flex-none min-h-[52px] px-5 rounded-xl bg-emerald-500 hover:bg-emerald-400 disabled:bg-slate-800 disabled:text-slate-500 disabled:border-slate-700 text-white font-black text-sm flex items-center justify-center gap-2 border border-emerald-300/30 shadow-lg shadow-emerald-900/20 transition-all"
          >
            {isStarting ? <Loader2 className="w-5 h-5 animate-spin" /> : <Play className="w-5 h-5 fill-current" />}
            <span>{dailyStats.isLimitReached ? 'Limit 20/Hari' : `Start (${currentNichePreset.shortName || 'Auto'})`}</span>
          </button>

          <button
            type="button"
            onClick={handleStop}
            disabled={!isRunning || isStopping}
            className="flex-1 lg:flex-none min-h-[52px] px-5 rounded-xl bg-red-500 hover:bg-red-400 disabled:bg-slate-800 disabled:text-slate-500 disabled:border-slate-700 text-white font-black text-sm flex items-center justify-center gap-2 border border-red-300/30 shadow-lg shadow-red-900/20 transition-all"
          >
            {isStopping ? <Loader2 className="w-5 h-5 animate-spin" /> : <Square className="w-5 h-5 fill-current" />}
            <span>Stop</span>
          </button>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-3 gap-2 text-center">
        <Metric label="Sukses" value={isUnlimited ? `${successfulJobs} video (∞)` : `${successfulJobs}/${maxJobs}`} tone="emerald" />
        <Metric label="Gagal" value={failedJobs} tone="red" />
        <Metric label="Skip" value={skippedProducts} tone="amber" />
      </div>

      <div className="mt-4">
        <div className="h-2 rounded-full bg-slate-800 overflow-hidden">
          <div
            className="h-full bg-gradient-to-r from-emerald-400 via-amber-400 to-shopee-500 transition-all"
            style={{ width: `${Math.max(0, Math.min(100, run.progress || 0))}%` }}
          />
        </div>
        <div className="mt-2 flex items-start gap-2 text-xs text-slate-300">
          {run.status === 'error' ? (
            <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
          ) : run.status === 'completed' || run.status === 'stopped' ? (
            <CheckCircle2 className="w-4 h-4 text-emerald-400 flex-shrink-0 mt-0.5" />
          ) : (
            <Loader2 className={`w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5 ${isRunning ? 'animate-spin' : ''}`} />
          )}
          <div className="min-w-0">
            <p className="font-semibold truncate">{run.message || 'Auto mode siap dijalankan.'}</p>
            {run.currentProductTitle && (
              <p className="text-[11px] text-slate-500 truncate mt-0.5">{run.currentProductTitle}</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Metric({ label, value, tone }) {
  const toneClasses = {
    emerald: 'text-emerald-300 border-emerald-500/20 bg-emerald-500/10',
    red: 'text-red-300 border-red-500/20 bg-red-500/10',
    amber: 'text-amber-300 border-amber-500/20 bg-amber-500/10',
  };

  return (
    <div className={`rounded-xl border px-3 py-2 ${toneClasses[tone]}`}>
      <div className="text-base font-black">{value}</div>
      <div className="text-[10px] uppercase font-bold opacity-80">{label}</div>
    </div>
  );
}

function statusLabel(status) {
  return (
    {
      running: 'Running',
      stopping: 'Stopping',
      stopped: 'Stopped',
      completed: 'Completed',
      error: 'Error',
      idle: 'Idle',
    }[status] || 'Idle'
  );
}

function statusClass(status) {
  return (
    {
      running: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
      stopping: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
      stopped: 'bg-slate-500/15 text-slate-300 border-slate-500/30',
      completed: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
      error: 'bg-red-500/15 text-red-300 border-red-500/30',
      idle: 'bg-slate-500/15 text-slate-300 border-slate-500/30',
    }[status] || 'bg-slate-500/15 text-slate-300 border-slate-500/30'
  );
}

