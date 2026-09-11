import React, { useState, useEffect } from 'react';
import { Video, Sparkles, Settings, Cpu, ShieldCheck, FolderOpen, Loader2, RotateCw, AlertTriangle, CheckCircle2, Wifi } from 'lucide-react';
import BandwidthModal from './BandwidthModal';

export default function Navbar({ onOpenSettings, engineStatus }) {
  const [openingFolder, setOpeningFolder] = useState(false);
  const [showRestartModal, setShowRestartModal] = useState(false);
  const [runUpdateScript, setRunUpdateScript] = useState(true);
  const [isRestarting, setIsRestarting] = useState(false);
  const [restartStatusText, setRestartStatusText] = useState('');
  const [restartError, setRestartError] = useState(null);
  const [showBandwidthModal, setShowBandwidthModal] = useState(false);
  const [bandwidthStats, setBandwidthStats] = useState(engineStatus?.bandwidthStats || null);

  const fetchBandwidthStats = async () => {
    try {
      const res = await fetch('/api/bandwidth-stats');
      if (res.ok) {
        const data = await res.json();
        if (data.stats) setBandwidthStats(data.stats);
      }
    } catch (e) {}
  };

  useEffect(() => {
    fetchBandwidthStats();
    const interval = setInterval(fetchBandwidthStats, 6000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (engineStatus?.bandwidthStats) {
      setBandwidthStats(engineStatus.bandwidthStats);
    }
  }, [engineStatus]);

  const handleResetBandwidth = async (scope = 'session') => {
    try {
      const res = await fetch('/api/bandwidth-stats/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.stats) setBandwidthStats(data.stats);
      }
    } catch (e) {}
  };

  const handleOpenFolder = async () => {
    setOpeningFolder(true);
    try {
      await fetch('/api/open-folder', { method: 'POST' });
    } catch (err) {
      console.warn('Could not open folder:', err);
    } finally {
      setTimeout(() => setOpeningFolder(false), 800);
    }
  };

  const handleRestartServer = async () => {
    setIsRestarting(true);
    setRestartError(null);
    setRestartStatusText(runUpdateScript ? 'Mengambil commit terbaru dari GitHub (Git Pull) & menyiapkan server...' : 'Mengirim sinyal restart backend...');

    try {
      const response = await fetch('/api/restart', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runUpdate: runUpdateScript }),
      });
      const data = await response.json();
      setRestartStatusText('Server sedang me-restart... Menunggu koneksi kembali online...');
    } catch (err) {
      console.log('Restart trigger dispatched:', err.message);
      setRestartStatusText('Server sedang me-restart... Menunggu koneksi kembali online...');
    }

    // Start polling health endpoint until server is back online
    let attempts = 0;
    const pollInterval = setInterval(async () => {
      attempts++;
      setRestartStatusText(`Menunggu backend aktif kembali (${attempts}s)...`);
      try {
        const check = await fetch('/api/health', { cache: 'no-store' });
        if (check.ok) {
          const res = await check.json();
          if (res.status === 'ok') {
            clearInterval(pollInterval);
            setRestartStatusText('✅ Server online! Memuat ulang halaman...');
            setTimeout(() => {
              window.location.reload();
            }, 1000);
          }
        }
      } catch (e) {
        // Backend still down/restarting, keep waiting
      }

      if (attempts > 45) {
        clearInterval(pollInterval);
        setRestartError('Waktu tunggu habis (45s). Jika server belum aktif, cek terminal Termux.');
      }
    }, 1500);
  };

  return (
    <>
      <header className="border-b border-slate-800/80 bg-slate-900/60 backdrop-blur-md sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          
          {/* Brand Logo & Name */}
          <div className="flex items-center gap-3">
            <div className="relative">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-shopee-500 via-orange-500 to-amber-400 flex items-center justify-center shadow-lg shadow-shopee-500/25">
                <Video className="w-5 h-5 text-white stroke-[2.5]" />
              </div>
              <div className="absolute -bottom-1 -right-1 w-4 h-4 bg-emerald-500 rounded-full border-2 border-slate-900 flex items-center justify-center" title="Local Processing Engine Online">
                <span className="w-1.5 h-1.5 bg-white rounded-full animate-pulse"></span>
              </div>
            </div>

            <div>
              <div className="flex items-center gap-2">
                <h1 className="font-bold text-lg text-white tracking-tight">
                  Local AI Affiliate Clipper
                </h1>
                <span className="bg-gradient-to-r from-orange-500/20 to-amber-500/20 border border-orange-500/30 text-orange-400 text-[10px] font-semibold uppercase px-2 py-0.5 rounded-full">
                  9:16 Reels Engine
                </span>
              </div>
              <p className="text-xs text-slate-400 hidden sm:block">
                Auto-generate viral Shopee Affiliate clips via openrouter/free &amp; FFmpeg
              </p>
            </div>
          </div>

          {/* Right side stats & settings */}
          <div className="flex items-center gap-2 sm:gap-2.5">
            {/* Internet Bandwidth Counter Display Badge */}
            <button
              onClick={() => setShowBandwidthModal(true)}
              className="flex items-center gap-1.5 px-2.5 sm:px-3 py-1.5 rounded-lg bg-sky-500/10 hover:bg-sky-500/20 border border-sky-500/30 text-sky-300 text-xs font-semibold transition-all hover:scale-[1.02] active:scale-[0.98] group"
              title="Klik untuk melihat rincian penggunaan kuota internet (MB)"
            >
              <div className="relative flex items-center justify-center">
                <Wifi className="w-3.5 h-3.5 text-sky-400 group-hover:animate-pulse" />
                <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 bg-emerald-400 rounded-full animate-ping"></span>
              </div>
              <span className="font-mono font-bold text-white tracking-tight">
                {bandwidthStats?.totalFormatted || '0.00 MB'}
              </span>
              <span className="text-[10px] text-sky-400/80 font-normal hidden md:inline">
                Kuota
              </span>
            </button>

            {/* Quick Open Output Folder Button */}
            <button
              onClick={handleOpenFolder}
              disabled={openingFolder}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/30 text-amber-300 text-xs font-semibold transition-all hover:scale-[1.02] active:scale-[0.98]"
              title="Buka folder output video di File Explorer"
            >
              {openingFolder ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <FolderOpen className="w-3.5 h-3.5" />
              )}
              <span className="hidden sm:inline">Folder Video</span>
            </button>

            {/* Restart Server (Termux / Local) Button */}
            <button
              onClick={() => setShowRestartModal(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-rose-500/10 hover:bg-rose-500/20 border border-rose-500/30 text-rose-300 text-xs font-semibold transition-all hover:scale-[1.02] active:scale-[0.98]"
              title="Restart backend server Termux & jalankan ./update.sh"
            >
              <RotateCw className="w-3.5 h-3.5 text-rose-400" />
              <span className="hidden sm:inline">Restart Server</span>
            </button>

            {/* AI Model Badge */}
            <div className="hidden md:flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800/80 border border-slate-700/60 text-xs">
                <>
                  <Sparkles className="w-3.5 h-3.5 text-emerald-400" />
                  <span className="text-slate-300 font-medium font-mono text-[11px]">openrouter/free</span>
                  <span className="text-slate-500">|</span>
                  <span className="text-emerald-400 font-mono text-[10px]">Free Tier</span>
                </>
            </div>

            {/* Anti-detection badge */}
            <div className="hidden lg:flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800/80 border border-slate-700/60 text-xs text-emerald-400">
              <ShieldCheck className="w-3.5 h-3.5" />
              <span>Anti-Detection</span>
            </div>

            {/* Settings Button */}
            <button
              onClick={onOpenSettings}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 text-sm font-medium transition-colors"
              title="Configure anti-detection & rendering settings"
            >
              <Settings className="w-4 h-4 text-slate-400" />
              <span className="hidden sm:inline">Settings</span>
            </button>
          </div>

        </div>
      </header>

      {/* Confirmation Modal for Restart */}
      {showRestartModal && !isRestarting && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-md w-full p-6 shadow-2xl animate-in fade-in zoom-in duration-200">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-xl bg-rose-500/10 border border-rose-500/30 flex items-center justify-center text-rose-400">
                <RotateCw className="w-5 h-5" />
              </div>
              <div>
                <h3 className="font-bold text-base text-white">Restart & Update Server</h3>
                <p className="text-xs text-slate-400">Tarik update repo GitHub & restart service</p>
              </div>
            </div>

            <p className="text-sm text-slate-300 mb-4 leading-relaxed">
              Apakah Anda ingin me-restart server? Server akan mengambil commit terbaru dari GitHub sebelum kembali dijalankan.
            </p>

            <div className="bg-slate-800/60 border border-slate-700/60 rounded-xl p-3 mb-6">
              <label className="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={runUpdateScript}
                  onChange={(e) => setRunUpdateScript(e.target.checked)}
                  className="mt-1 rounded border-slate-700 text-orange-500 focus:ring-orange-500/30 w-4 h-4 bg-slate-900"
                />
                <div>
                  <span className="text-sm font-medium text-slate-200 block">Tarik update repo terbaru dari GitHub (Git Pull)</span>
                  <span className="text-xs text-slate-400 block mt-0.5">Otomatis sinkronisasi seluruh perubahan kode dari GitHub sebelum server dijalankan kembali.</span>
                </div>
              </label>
            </div>

            <div className="flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={() => setShowRestartModal(false)}
                className="px-4 py-2 rounded-xl text-sm font-medium text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
              >
                Batal
              </button>
              <button
                type="button"
                onClick={handleRestartServer}
                className="px-4 py-2 rounded-xl text-sm font-semibold bg-rose-600 hover:bg-rose-500 text-white shadow-lg shadow-rose-600/25 transition-all active:scale-95 flex items-center gap-2"
              >
                <RotateCw className="w-4 h-4" />
                <span>Tarik Update & Restart Server</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Fullscreen Overlay during Restart & Health Polling */}
      {isRestarting && (
        <div className="fixed inset-0 z-50 bg-slate-950/90 backdrop-blur-md flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-md w-full p-8 shadow-2xl text-center">
            <div className="w-16 h-16 rounded-2xl bg-orange-500/10 border border-orange-500/30 flex items-center justify-center text-orange-400 mx-auto mb-5 shadow-lg shadow-orange-500/10">
              <RotateCw className="w-8 h-8 animate-spin" />
            </div>

            <h3 className="font-bold text-lg text-white mb-2">Sedang Me-restart Server...</h3>
            <p className="text-sm text-slate-400 mb-6">
              {restartStatusText || 'Memproses permintaan restart server...'}
            </p>

            {restartError ? (
              <div className="bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs rounded-xl p-3 mb-4 text-left">
                <div className="flex items-center gap-2 font-semibold mb-1">
                  <AlertTriangle className="w-4 h-4" />
                  <span>Peringatan</span>
                </div>
                <p className="mb-2">{restartError}</p>
                <p className="text-[11px] text-slate-400 mb-3">
                  Di Termux, Anda dapat menjalankan: <code className="text-orange-400 bg-slate-950 px-1 py-0.5 rounded font-mono">npm run dev</code>
                </p>
                <button
                  onClick={() => window.location.reload()}
                  className="w-full py-1.5 bg-rose-600 text-white rounded-lg text-xs font-semibold hover:bg-rose-500 transition-colors"
                >
                  Coba Refresh Halaman
                </button>
              </div>
            ) : (
              <div className="w-full bg-slate-800 rounded-full h-1.5 overflow-hidden">
                <div className="bg-gradient-to-r from-orange-500 to-amber-400 h-full w-2/3 animate-pulse rounded-full"></div>
              </div>
            )}
          </div>
        </div>
      )}
      {/* Bandwidth Usage Detail Modal */}
      <BandwidthModal
        isOpen={showBandwidthModal}
        onClose={() => setShowBandwidthModal(false)}
        stats={bandwidthStats}
        onRefresh={fetchBandwidthStats}
        onReset={handleResetBandwidth}
      />
    </>
  );
}

