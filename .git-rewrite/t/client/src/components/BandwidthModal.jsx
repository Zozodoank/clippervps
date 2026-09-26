import React, { useState } from 'react';
import {
  X,
  Wifi,
  HardDriveDownload,
  TrendingDown,
  RefreshCw,
  Trash2,
  Sparkles,
  Clock,
  Film,
  Mic,
  Cpu,
  Layers,
  FileText,
  AlertCircle
} from 'lucide-react';

export default function BandwidthModal({ isOpen, onClose, stats, onRefresh, onReset }) {
  const [resetting, setResetting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  if (!isOpen) return null;

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      if (onRefresh) await onRefresh();
    } finally {
      setTimeout(() => setRefreshing(false), 400);
    }
  };

  const handleReset = async (scope = 'session') => {
    const label = scope === 'all' ? 'seluruh riwayat kuota (All-Time)' : 'kuota sesi saat ini';
    if (!window.confirm(`Yakin ingin mereset ${label}?`)) return;
    setResetting(true);
    try {
      if (onReset) await onReset(scope);
    } finally {
      setResetting(false);
    }
  };

  const getCategoryIcon = (key) => {
    switch (key) {
      case 'videoDownload':
        return <Film className="w-4 h-4 text-orange-400" />;
      case 'streamSampling':
        return <Layers className="w-4 h-4 text-sky-400" />;
      case 'metadata':
        return <FileText className="w-4 h-4 text-emerald-400" />;
      case 'voiceoverTTS':
        return <Mic className="w-4 h-4 text-purple-400" />;
      case 'aiRequests':
        return <Cpu className="w-4 h-4 text-amber-400" />;
      default:
        return <HardDriveDownload className="w-4 h-4 text-slate-400" />;
    }
  };

  const totalMB = stats?.totalMB || 0;
  const sessionMB = stats?.sessionMB || 0;
  const savedMB = stats?.savedMB || 0;
  const breakdown = stats?.breakdown || [];
  const recentLogs = stats?.recentLogs || [];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4 overflow-y-auto animate-in fade-in duration-200">
      <div className="bg-slate-900 border border-slate-700/80 rounded-2xl w-full max-w-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-800 bg-slate-950/40 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-sky-500/10 border border-sky-500/30 flex items-center justify-center text-sky-400">
              <Wifi className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-white tracking-tight flex items-center gap-2">
                Monitor Penggunaan Kuota Internet
                <span className="px-2 py-0.5 text-[10px] font-semibold tracking-wider uppercase rounded-full bg-sky-500/20 text-sky-300 border border-sky-500/30">
                  Real-time
                </span>
              </h2>
              <p className="text-xs text-slate-400">
                Statistik pemakaian bandwidth backend &amp; efisiensi stream sampling
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-6 overflow-y-auto space-y-6">
          
          {/* Top Metric Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3.5">
            {/* Total Bandwidth */}
            <div className="bg-slate-800/60 border border-slate-700/60 rounded-xl p-4 flex flex-col justify-between">
              <div className="flex items-center justify-between text-slate-400 text-xs mb-1">
                <span>Total Terpakai</span>
                <HardDriveDownload className="w-4 h-4 text-orange-400" />
              </div>
              <div className="text-2xl font-black text-white tracking-tight">
                {stats?.totalFormatted || `${totalMB.toFixed(2)} MB`}
              </div>
              <div className="text-[11px] text-slate-400 mt-1">
                All-time across sessions
              </div>
            </div>

            {/* Session Bandwidth */}
            <div className="bg-slate-800/60 border border-slate-700/60 rounded-xl p-4 flex flex-col justify-between">
              <div className="flex items-center justify-between text-slate-400 text-xs mb-1">
                <span>Sesi Saat Ini</span>
                <Wifi className="w-4 h-4 text-sky-400" />
              </div>
              <div className="text-2xl font-black text-sky-400 tracking-tight">
                {stats?.sessionFormatted || `${sessionMB.toFixed(2)} MB`}
              </div>
              <div className="text-[11px] text-slate-400 mt-1">
                Sejak server aktif
              </div>
            </div>

            {/* Saved Bandwidth */}
            <div className="bg-emerald-950/30 border border-emerald-500/30 rounded-xl p-4 flex flex-col justify-between">
              <div className="flex items-center justify-between text-emerald-300 text-xs mb-1">
                <span className="font-semibold">Kuota Dihemat</span>
                <Sparkles className="w-4 h-4 text-emerald-400" />
              </div>
              <div className="text-2xl font-black text-emerald-400 tracking-tight">
                {stats?.savedFormatted || `${savedMB.toFixed(2)} MB`}
              </div>
              <div className="text-[11px] text-emerald-300/80 mt-1 flex items-center gap-1">
                <TrendingDown className="w-3 h-3" />
                <span>Efisiensi 3-Tahap Funneling</span>
              </div>
            </div>
          </div>

          {/* Savings Highlight Banner */}
          <div className="bg-gradient-to-r from-emerald-500/10 via-teal-500/10 to-sky-500/10 border border-emerald-500/20 rounded-xl p-3.5 flex items-start gap-3">
            <div className="p-1.5 rounded-lg bg-emerald-500/20 text-emerald-400 shrink-0 mt-0.5">
              <Sparkles className="w-4 h-4" />
            </div>
            <div className="text-xs text-slate-300 leading-relaxed">
              <span className="font-bold text-emerald-300">Hemat Kuota Maksimal: </span>
              Video yang ditolak pada tahap metadata pre-filter (0 MB) dan stream sampling (~2 MB) mencegah pengunduhan file video penuh (30–60 MB per video). Anda telah menghemat sekitar{' '}
              <strong className="text-white font-mono">{stats?.savedFormatted || '0 MB'}</strong> kuota internet!
            </div>
          </div>

          {/* Breakdown per Category */}
          <div className="space-y-3">
            <h3 className="text-xs font-bold text-slate-300 uppercase tracking-wider">
              Rincian Penggunaan Data per Komponen
            </h3>
            <div className="bg-slate-950/40 border border-slate-800 rounded-xl divide-y divide-slate-800/80">
              {breakdown.map((item) => (
                <div key={item.key} className="p-3 sm:px-4 flex items-center justify-between gap-4">
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    <div className="p-2 rounded-lg bg-slate-800/80 shrink-0">
                      {getCategoryIcon(item.key)}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between mb-1.5">
                        <span className="text-xs font-medium text-slate-200 truncate">
                          {item.label}
                        </span>
                        <div className="flex items-center gap-2 shrink-0">
                          <span className="text-xs font-mono font-bold text-white">
                            {item.formatted}
                          </span>
                          <span className="text-[10px] text-slate-400 font-mono">
                            ({item.percentage}%)
                          </span>
                        </div>
                      </div>
                      {/* Progress Bar */}
                      <div className="w-full bg-slate-800 h-1.5 rounded-full overflow-hidden">
                        <div
                          className="bg-gradient-to-r from-sky-500 to-amber-500 h-full rounded-full transition-all duration-500"
                          style={{ width: `${Math.min(100, Math.max(item.bytes > 0 ? 3 : 0, item.percentage))}%` }}
                        />
                      </div>
                    </div>
                  </div>
                  <div className="text-right shrink-0 hidden sm:block">
                    <span className="text-[10px] text-slate-500 bg-slate-800/60 px-2 py-0.5 rounded-md font-mono">
                      {item.count}x request
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Recent Operations Log */}
          <div className="space-y-3">
            <h3 className="text-xs font-bold text-slate-300 uppercase tracking-wider flex items-center justify-between">
              <span>Riwayat Transaksi Jaringan Terkini</span>
              <span className="text-[11px] text-slate-500 font-normal">
                {recentLogs.length} entri terakhir
              </span>
            </h3>

            {recentLogs.length === 0 ? (
              <div className="bg-slate-950/30 border border-slate-800/60 rounded-xl p-6 text-center text-xs text-slate-500">
                Belum ada transaksi internet yang tercatat pada sesi ini.
              </div>
            ) : (
              <div className="bg-slate-950/40 border border-slate-800 rounded-xl overflow-hidden divide-y divide-slate-800/60 max-h-48 overflow-y-auto">
                {recentLogs.map((log) => (
                  <div key={log.id} className="p-2.5 px-3 flex items-center justify-between text-xs gap-3">
                    <div className="flex items-center gap-2.5 min-w-0 flex-1">
                      <Clock className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                      <span className="font-mono text-[11px] text-slate-400 shrink-0">
                        {log.timeFormatted}
                      </span>
                      <span className="text-slate-300 truncate">
                        {log.details || log.categoryLabel}
                      </span>
                    </div>
                    <span className="font-mono text-[11px] font-semibold text-sky-400 shrink-0 bg-sky-500/10 px-2 py-0.5 rounded border border-sky-500/20">
                      +{log.formattedSize}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Modal Footer */}
        <div className="px-6 py-3.5 border-t border-slate-800 bg-slate-950/60 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <button
              onClick={() => handleReset('session')}
              disabled={resetting}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 text-xs font-semibold transition-all"
              title="Reset hitungan sesi saat ini menjadi 0 MB"
            >
              <RotateCwIcon className={`w-3.5 h-3.5 ${resetting ? 'animate-spin' : ''}`} />
              <span>Reset Sesi</span>
            </button>
            <button
              onClick={() => handleReset('all')}
              disabled={resetting}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-rose-500/10 hover:bg-rose-500/20 border border-rose-500/30 text-rose-300 text-xs font-semibold transition-all"
              title="Hapus seluruh akumulasi kuota"
            >
              <Trash2 className="w-3.5 h-3.5 text-rose-400" />
              <span>Reset All</span>
            </button>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={handleRefresh}
              disabled={refreshing}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 text-xs font-medium transition-all"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
              <span>Refresh</span>
            </button>
            <button
              onClick={onClose}
              className="px-4 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-xs font-semibold shadow-lg shadow-sky-600/20 transition-all"
            >
              Tutup
            </button>
          </div>
        </div>

      </div>
    </div>
  );
}

function RotateCwIcon({ className }) {
  return (
    <svg className={className} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
    </svg>
  );
}
