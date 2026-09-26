import React, { useEffect, useState, useRef } from 'react';
import {
  History, RefreshCw, Trash2, Film, CheckCircle2, AlertCircle,
  Clock, Download, Music, ChevronRight, X, Info, FolderOpen, ExternalLink,
  Sparkles, Volume2, AlertTriangle, Loader2, Search, Zap, Square
} from 'lucide-react';

const STAGE_CONFIG = {
  completed:          { label: 'Selesai (Final Video)', color: 'emerald', icon: CheckCircle2 },
  awaiting_voiceover: { label: 'Menunggu Voiceover', color: 'amber', icon: Music },
  error:              { label: 'Gagal (Dapat Retry)', color: 'red', icon: AlertCircle },
  interrupted:        { label: 'Terputus (Video Tersimpan)', color: 'orange', icon: AlertCircle },
  downloaded:         { label: 'Video Terunduh', color: 'blue', icon: Film },
  running:            { label: 'Sedang Berjalan', color: 'indigo', icon: RefreshCw },
  unknown:            { label: 'Tidak Diketahui', color: 'slate', icon: Clock },
};

function StageBadge({ stage }) {
  const cfg = STAGE_CONFIG[stage] || STAGE_CONFIG.unknown;
  const Icon = cfg.icon;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-${cfg.color}-500/20 text-${cfg.color}-300 border border-${cfg.color}-500/30`}>
      <Icon className="w-2.5 h-2.5" />
      {cfg.label}
    </span>
  );
}

export default function JobHistoryPanel({ onSelectJob, onRetryJob, currentJobId, refreshSignal = 0, settings }) {
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [isOpen, setIsOpen] = useState(false);
  const [deletingId, setDeletingId] = useState(null);
  const [retryingId, setRetryingId] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeFilter, setActiveFilter] = useState('all'); // 'all' | 'completed' | 'tts' | 'failed'
  const [autoRetryingJobs, setAutoRetryingJobs] = useState(new Set());
  const [isRefreshing, setIsRefreshing] = useState(false);

  // TTS processing state
  const [processingTtsId, setProcessingTtsId] = useState(null);
  const [batchStatus, setBatchStatus] = useState({
    isRunning: false,
    isStopping: false,
    totalJobs: 0,
    currentIndex: 0,
    currentJobId: null,
    currentProductTitle: '',
    successfulJobs: 0,
    failedJobs: 0,
    isQuotaExhausted: false,
  });

  const fetchJobs = async (silent = false) => {
    if (!silent) {
      setIsRefreshing(true);
      if (jobs.length === 0) {
        setLoading(true);
      }
    }
    try {
      const res = await fetch('/api/jobs');
      if (res.ok) {
        const data = await res.json();
        const loadedJobs = data.jobs || [];
        setJobs((prevJobs) => {
          if (JSON.stringify(prevJobs) === JSON.stringify(loadedJobs)) {
            return prevJobs;
          }
          return loadedJobs;
        });

        // Sync active auto retrying jobs
        const activeRetrySet = new Set();
        loadedJobs.forEach(j => {
          if (j.isAutoRetrying) activeRetrySet.add(j.jobId);
        });
        setAutoRetryingJobs((prevSet) => {
          if (prevSet.size === activeRetrySet.size && [...activeRetrySet].every(id => prevSet.has(id))) {
            return prevSet;
          }
          return activeRetrySet;
        });
      }
    } catch (err) {
      console.warn('Could not fetch job history:', err.message);
    } finally {
      setLoading(false);
      if (!silent) {
        setIsRefreshing(false);
      }
    }
  };

  // Poll server-side Batch TTS queue status
  const pollBatchStatus = async () => {
    try {
      const res = await fetch('/api/batch-tts/status');
      if (res.ok) {
        const data = await res.json();
        if (data?.batch) {
          setBatchStatus(data.batch);
          if (data.batch.isRunning) {
            setProcessingTtsId(data.batch.currentJobId);
          } else if (!processingTtsId) {
            setProcessingTtsId(null);
          }
        }
      }
    } catch (err) {
      console.warn('Could not poll batch TTS status:', err.message);
    }
  };

  useEffect(() => {
    fetchJobs();
    pollBatchStatus();
  }, [refreshSignal]);

  // Active polling while server is running batch TTS
  useEffect(() => {
    if (!batchStatus.isRunning) return;

    const interval = setInterval(async () => {
      try {
        const res = await fetch('/api/batch-tts/status');
        if (res.ok) {
          const data = await res.json();
          if (data?.batch) {
            setBatchStatus(data.batch);
            if (data.batch.isRunning) {
              setProcessingTtsId(data.batch.currentJobId);
            } else {
              setProcessingTtsId(null);
              fetchJobs(true);
              if (data.batch.isQuotaExhausted) {
                alert(`⚠️ Terjadi kendala saat memproses TTS setelah menyelesaikan ${data.batch.successfulJobs} job.`);
              } else if (data.batch.successfulJobs > 0) {
                alert(`✨ Selesai! Berhasil menyatukan ${data.batch.successfulJobs} video dengan suara Gadis & subtitle.`);
              }
            }
          }
        }
      } catch (err) {
        console.warn('Error polling batch status:', err);
      }
    }, 2500);

    return () => clearInterval(interval);
  }, [batchStatus.isRunning]);

  // Active polling while any job is in Auto Retry mode (silent in background without resetting UI)
  useEffect(() => {
    if (autoRetryingJobs.size === 0) return;
    const interval = setInterval(() => {
      fetchJobs(true);
    }, 3000);
    return () => clearInterval(interval);
  }, [autoRetryingJobs.size]);

  const handleOpenFolder = async (e, filename) => {
    e.stopPropagation();
    try {
      await fetch('/api/open-folder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(filename ? { filename } : {}),
      });
    } catch (err) {
      console.warn('Could not open folder:', err);
    }
  };

  const handleDelete = async (e, jobId) => {
    e.stopPropagation();
    if (!confirm('Hapus job dan file terkait dari riwayat?')) return;
    setDeletingId(jobId);
    try {
      await fetch(`/api/jobs/${jobId}`, { method: 'DELETE' });
      setJobs(prev => prev.filter(j => j.jobId !== jobId));
    } catch (err) {
      console.warn('Could not delete job:', err.message);
    } finally {
      setDeletingId(null);
    }
  };

  // 1. Single-Job Generate TTS & Merge Video via Gemini Flash / Edge-TTS with AI Phonetic Detection
  const handleGenerateTTSForJob = async (e, job) => {
    e.stopPropagation();
    if (processingTtsId || batchStatus.isRunning) return;

    setProcessingTtsId(job.jobId);
    try {
      const res = await fetch('/api/retry-job-tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jobId: job.jobId,
          ttsProvider: settings?.ttsProvider,
          ttsModel: settings?.ttsModel,
          ttsFallbackModel: settings?.ttsFallbackModel,
          ttsVoice: settings?.ttsVoice,
          apiKey: settings?.geminiApiKey,
        }),
      });
      const data = await res.json();

      if (!res.ok || !data.success) {
        if (data.isQuotaError || res.status === 402) {
          alert('⚠️ Terjadi kendala limit kuota/rate limit TTS. Silakan coba sesaat lagi.');
        } else {
          alert(`Gagal membuat TTS: ${data.error || 'Terjadi kesalahan pada server.'}`);
        }
        return;
      }

      // Update in state
      setJobs(prev => prev.map(j => j.jobId === job.jobId ? { ...j, ...data, stage: 'completed', hasFinalVideo: true } : j));

      // Auto-select this completed job so user can see it right away
      if (onSelectJob) {
        onSelectJob({ ...job, ...data, stage: 'completed', hasFinalVideo: true });
      }
    } catch (err) {
      console.error('Error generating TTS:', err);
      alert(`Gagal: ${err.message}`);
    } finally {
      setProcessingTtsId(null);
    }
  };

  // Dedicated Retry TTS with AI phonetic detection & automatic dictionary updating for existing history jobs
  const handleRetryTTSForJob = async (e, job) => {
    e.stopPropagation();
    if (processingTtsId || batchStatus.isRunning) return;

    setProcessingTtsId(job.jobId);
    try {
      const res = await fetch('/api/retry-job-tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jobId: job.jobId,
          ttsProvider: settings?.ttsProvider,
          ttsModel: settings?.ttsModel,
          ttsFallbackModel: settings?.ttsFallbackModel,
          ttsVoice: settings?.ttsVoice,
          apiKey: settings?.geminiApiKey,
        }),
      });
      const data = await res.json();

      if (!res.ok || !data.success) {
        if (data.isQuotaError || res.status === 402) {
          alert('⚠️ Terjadi kendala limit kuota/rate limit TTS. Silakan coba sesaat lagi.');
        } else {
          alert(`Gagal memproses Retry TTS: ${data.error || 'Terjadi kesalahan pada server.'}`);
        }
        return;
      }

      // Update in state
      setJobs(prev => prev.map(j => j.jobId === job.jobId ? { ...j, ...data, stage: 'completed', hasFinalVideo: true } : j));

      const newWords = Object.keys(data.newlyDetectedLexicon || {});
      const msg = newWords.length > 0
        ? `✨ Berhasil Retry TTS!\nAI mendeteksi & menambahkan ${newWords.length} istilah fonetik baru ke kamus:\n${newWords.map(w => `• ${w} -> ${data.newlyDetectedLexicon[w]}`).join('\n')}\n\nSubtitle video tetap menggunakan teks normal non-fonetik!`
        : '✨ Berhasil membuat ulang suara voiceover & subtitle dengan kamus fonetik terbaru!';
      alert(msg);

      // Auto-select this completed job so user can see it right away
      if (onSelectJob) {
        onSelectJob({ ...job, ...data, stage: 'completed', hasFinalVideo: true });
      }
    } catch (err) {
      console.error('Error in Retry TTS:', err);
      alert(`Gagal memproses Retry TTS: ${err.message}`);
    } finally {
      setProcessingTtsId(null);
    }
  };

  // 2. Server-Side Batch Generate TTS for ALL awaiting jobs
  const handleCancelBatch = async (e) => {
    e.stopPropagation();
    try {
      await fetch('/api/batch-tts/stop', { method: 'POST' });
      setBatchStatus(prev => ({ ...prev, isStopping: true }));
    } catch (err) {
      console.warn('Could not stop batch queue:', err);
    }
  };

  const handleBatchGenerateTTS = async (e) => {
    e.stopPropagation();
    if (awaitingVoiceoverJobs.length === 0) return;

    const isGemini = (settings?.ttsProvider || 'gemini_tts') === 'gemini_tts';
    const ttsEngineLabel = isGemini
      ? `Gemini Flash (${settings?.ttsModel || 'gemini-3.1-flash-tts-preview'})`
      : 'Edge-TTS (Gadis)';

    if (!confirm(`Generate TTS otomatis untuk ${awaitingVoiceoverJobs.length} job yang menunggu dengan ${ttsEngineLabel}?\n\nSistem di server akan memproses seluruh video satu per satu secara berurutan tanpa terputus.`)) {
      return;
    }

    try {
      const res = await fetch('/api/batch-tts/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ttsProvider: settings?.ttsProvider,
          ttsModel: settings?.ttsModel,
          ttsFallbackModel: settings?.ttsFallbackModel,
          ttsVoice: settings?.ttsVoice,
          apiKey: settings?.geminiApiKey,
        }),
      });
      const data = await res.json();

      if (!res.ok || !data.success) {
        alert(`Gagal memulai batch TTS: ${data.error || 'Terjadi kesalahan pada server.'}`);
        return;
      }

      if (data.batch) {
        setBatchStatus(data.batch);
        setProcessingTtsId(data.batch.currentJobId);
      }
    } catch (err) {
      console.error('Error starting batch TTS:', err);
      alert(`Gagal: ${err.message}`);
    }
  };

  const handleRetryJob = async (e, job) => {
    e.stopPropagation();
    if (onRetryJob) {
      setRetryingId(job.jobId);
      try {
        await onRetryJob(job);
      } finally {
        setRetryingId(null);
      }
    } else {
      onSelectJob(job);
    }
  };

  const handleStartAutoRetry = async (e, job) => {
    e.stopPropagation();
    if (autoRetryingJobs.has(job.jobId)) return;

    if (!confirm(`Mulai Auto Retry untuk "${job.productTitle || job.jobId}"?\n\nSistem akan mencari video YouTube secara terus-menerus yang cocok persis dengan produk ini dan 100% bebas wajah/manusia hingga selesai, atau sampai Anda menekan tombol Stop Auto Retry.`)) {
      return;
    }

    try {
      setAutoRetryingJobs((prev) => new Set(prev).add(job.jobId));
      const res = await fetch(`/api/jobs/${job.jobId}/auto-retry/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ttsProvider: settings?.ttsProvider,
          ttsModel: settings?.ttsModel,
          ttsFallbackModel: settings?.ttsFallbackModel,
          ttsVoice: settings?.ttsVoice,
          apiKey: settings?.geminiApiKey,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        alert(`Gagal memulai Auto Retry: ${data.error || 'Terjadi kesalahan'}`);
        setAutoRetryingJobs((prev) => {
          const next = new Set(prev);
          next.delete(job.jobId);
          return next;
        });
        return;
      }
      if (onSelectJob) {
        onSelectJob({ ...job, stage: 'running', isAutoRetrying: true });
      }
      fetchJobs(true);
    } catch (err) {
      console.error('Error starting auto retry:', err);
      alert(`Gagal: ${err.message}`);
      setAutoRetryingJobs((prev) => {
        const next = new Set(prev);
        next.delete(job.jobId);
        return next;
      });
    }
  };

  const handleStopAutoRetry = async (e, job) => {
    e.stopPropagation();
    try {
      await fetch(`/api/jobs/${job.jobId}/auto-retry/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      setAutoRetryingJobs((prev) => {
        const next = new Set(prev);
        next.delete(job.jobId);
        return next;
      });
      fetchJobs(true);
    } catch (err) {
      console.warn('Error stopping auto retry:', err);
    }
  };

  const completedJobs = jobs.filter(j => j.stage === 'completed');
  const retryableStages = ['error', 'interrupted', 'downloaded'];
  const retryableJobs = jobs.filter(j => retryableStages.includes(j.stage));

  // Eligible for TTS: job has 9:16 silent video ready (or marked awaiting_voiceover) and no final video yet
  const isJobReadyForTTS = (j) => {
    if (j.hasFinalVideo || j.stage === 'completed') return false;
    return j.stage === 'awaiting_voiceover' || j.hasSilentVideo;
  };
  const awaitingVoiceoverJobs = jobs.filter(isJobReadyForTTS);
  const hasNewItems = retryableJobs.length > 0 || awaitingVoiceoverJobs.length > 0;

  const filteredJobs = jobs.filter((job) => {
    if (activeFilter === 'completed' && job.stage !== 'completed') return false;
    if (activeFilter === 'tts' && !isJobReadyForTTS(job)) return false;
    if (activeFilter === 'failed' && !retryableStages.includes(job.stage)) return false;

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      const matchTitle = (job.productTitle || '').toLowerCase().includes(q);
      const matchId = (job.jobId || '').toLowerCase().includes(q);
      return matchTitle || matchId;
    }
    return true;
  });

  if (!isOpen) {
    return (
      <div className="flex items-center gap-2">
        <button
          onClick={() => { setIsOpen(true); fetchJobs(); }}
          className={`relative flex items-center gap-2 px-3 py-2 rounded-xl border text-xs font-semibold transition-all ${
            awaitingVoiceoverJobs.length > 0
              ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/25'
              : hasNewItems
              ? 'bg-amber-500/15 border-amber-500/40 text-amber-300 hover:bg-amber-500/25'
              : 'bg-slate-800/80 border-slate-700/60 text-slate-400 hover:text-slate-200'
          }`}
        >
          <History className="w-4 h-4" />
          <span>Riwayat Job & Output</span>
          {awaitingVoiceoverJobs.length > 0 ? (
            <span className="absolute -top-1.5 -right-1.5 px-1.5 py-0.5 bg-emerald-500 text-black text-[10px] font-black rounded-full flex items-center justify-center">
              {awaitingVoiceoverJobs.length}
            </span>
          ) : retryableJobs.length > 0 ? (
            <span className="absolute -top-1.5 -right-1.5 w-4 h-4 bg-amber-500 text-black text-[10px] font-black rounded-full flex items-center justify-center">
              {retryableJobs.length}
            </span>
          ) : null}
        </button>

        <button
          onClick={(e) => handleOpenFolder(e)}
          className="flex items-center gap-1.5 px-3 py-2 rounded-xl border border-slate-700/60 bg-slate-800/80 text-amber-400 hover:text-amber-300 hover:bg-slate-800 text-xs font-semibold transition-all"
          title="Buka folder output video di Windows Explorer"
        >
          <FolderOpen className="w-4 h-4" />
          <span className="hidden sm:inline">Buka Folder Output</span>
        </button>
      </div>
    );
  }

  return (
    <div className="glass-panel rounded-2xl shadow-2xl overflow-hidden border border-slate-700/60">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-slate-700/60 bg-slate-900/60 flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <History className="w-4 h-4 text-amber-400" />
          <h3 className="text-sm font-bold text-white">Riwayat Job & Video Output</h3>
          <span className="text-[11px] text-slate-400">({jobs.length} job)</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={(e) => handleOpenFolder(e)}
            className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/30 text-amber-300 text-xs font-semibold transition-colors"
            title="Buka folder output di Windows Explorer"
          >
            <FolderOpen className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Buka Folder</span>
          </button>
          <button
            onClick={() => fetchJobs(false)}
            disabled={isRefreshing}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors"
            title="Refresh riwayat"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isRefreshing ? 'animate-spin' : ''}`} />
          </button>
          <button
            onClick={() => setIsOpen(false)}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Banner 1: Awaiting Voiceover Batch Action */}
      {(awaitingVoiceoverJobs.length > 0 || batchStatus.isRunning) && (
        <div className="mx-4 mt-3 p-3.5 rounded-xl bg-gradient-to-r from-emerald-950/70 via-slate-900/90 to-teal-950/70 border border-emerald-500/40 text-xs shadow-lg shadow-emerald-950/25 animate-in fade-in">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="p-2 rounded-lg bg-emerald-500/20 text-emerald-400 flex-shrink-0">
                <Volume2 className={`w-4 h-4 ${batchStatus.isRunning ? 'animate-pulse' : ''}`} />
              </div>
              <div className="min-w-0">
                <div className="font-bold text-white flex items-center gap-1.5 flex-wrap">
                  <span>
                    {batchStatus.isRunning
                      ? `Memproses Antrean TTS Server (${batchStatus.currentIndex + 1}/${batchStatus.totalJobs})`
                      : `${awaitingVoiceoverJobs.length} Job Menunggu Voiceover`}
                  </span>
                  <span className="text-[10px] font-mono px-1.5 py-0.2 bg-emerald-500/20 text-emerald-300 rounded border border-emerald-500/30">
                    Edge-TTS Gadis
                  </span>
                </div>
                <p className="text-[11px] text-slate-300 mt-0.5 truncate max-w-[340px] sm:max-w-[480px]">
                  {batchStatus.isRunning
                    ? `Sedang memproses: "${batchStatus.currentProductTitle || 'Menyiapkan video...'}" · (${batchStatus.successfulJobs} Berhasil, ${batchStatus.failedJobs} Gagal)`
                    : 'Video 9:16 sudah selesai dipotong. Siap digabungkan dengan suara AI & subtitle satu per satu secara berurutan.'}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2 flex-shrink-0">
              {batchStatus.isRunning ? (
                <button
                  type="button"
                  onClick={handleCancelBatch}
                  disabled={batchStatus.isStopping}
                  className="px-3 py-1.5 rounded-lg bg-red-500/20 hover:bg-red-500/30 border border-red-500/40 text-red-300 text-xs font-bold transition-all disabled:opacity-50"
                >
                  {batchStatus.isStopping ? 'Menghentikan...' : 'Hentikan Antrean'}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleBatchGenerateTTS}
                  disabled={loading || awaitingVoiceoverJobs.length === 0}
                  className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-gradient-to-r from-emerald-500 via-teal-500 to-emerald-400 hover:from-emerald-400 hover:to-teal-300 text-white text-xs font-bold shadow-md shadow-emerald-500/25 transition-all hover:scale-[1.02] active:scale-[0.98]"
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  <span>Proses Semua ({awaitingVoiceoverJobs.length} Job)</span>
                </button>
              )}
            </div>
          </div>

          {batchStatus.isRunning && batchStatus.totalJobs > 0 && (
            <div className="w-full bg-slate-800/80 rounded-full h-1.5 mt-2.5 overflow-hidden border border-emerald-500/20">
              <div
                className="bg-gradient-to-r from-emerald-500 via-teal-400 to-emerald-300 h-full transition-all duration-500"
                style={{ width: `${Math.min(100, Math.round(((batchStatus.currentIndex + 1) / batchStatus.totalJobs) * 100))}%` }}
              />
            </div>
          )}
        </div>
      )}

      {/* Search Bar & Category Filters for quick navigation of 120+ jobs */}
      <div className="px-4 pt-3 pb-2 border-b border-slate-800/80 space-y-2">
        <div className="relative">
          <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="text"
            placeholder="Cari dari 120+ produk / Job ID..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full bg-slate-900/90 border border-slate-700/60 rounded-xl pl-8 pr-8 py-1.5 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-amber-500/50"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-200"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5 text-[11px] scrollbar-none">
          <button
            type="button"
            onClick={() => setActiveFilter('all')}
            className={`px-2.5 py-0.5 rounded-lg font-semibold transition-all whitespace-nowrap ${
              activeFilter === 'all'
                ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                : 'text-slate-400 hover:text-slate-200 bg-slate-800/40'
            }`}
          >
            Semua ({jobs.length})
          </button>
          <button
            type="button"
            onClick={() => setActiveFilter('completed')}
            className={`px-2.5 py-0.5 rounded-lg font-semibold transition-all whitespace-nowrap ${
              activeFilter === 'completed'
                ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                : 'text-slate-400 hover:text-slate-200 bg-slate-800/40'
            }`}
          >
            Selesai ({completedJobs.length})
          </button>
          <button
            type="button"
            onClick={() => setActiveFilter('tts')}
            className={`px-2.5 py-0.5 rounded-lg font-semibold transition-all whitespace-nowrap ${
              activeFilter === 'tts'
                ? 'bg-teal-500/20 text-teal-300 border border-teal-500/40'
                : 'text-slate-400 hover:text-slate-200 bg-slate-800/40'
            }`}
          >
            Siap TTS ({awaitingVoiceoverJobs.length})
          </button>
          {retryableJobs.length > 0 && (
            <button
              type="button"
              onClick={() => setActiveFilter('failed')}
              className={`px-2.5 py-0.5 rounded-lg font-semibold transition-all whitespace-nowrap ${
                activeFilter === 'failed'
                  ? 'bg-red-500/20 text-red-300 border border-red-500/40'
                  : 'text-slate-400 hover:text-slate-200 bg-slate-800/40'
              }`}
            >
              Gagal ({retryableJobs.length})
            </button>
          )}
        </div>
      </div>

      {/* Banner 2: Retryable failed jobs */}
      {retryableJobs.length > 0 && activeFilter === 'all' && (
        <div className="mx-4 mt-2.5 p-2.5 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-200 text-[11px] flex items-start gap-2">
          <Info className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />
          <p>
            <strong>{retryableJobs.length} job gagal</strong> dapat di-retry langsung.
          </p>
        </div>
      )}

      {/* Job List */}
      <div className="p-4 space-y-2.5 max-h-[440px] overflow-y-auto">
        {loading ? (
          <div className="text-center py-8 text-slate-500 text-xs">
            <RefreshCw className="w-5 h-5 animate-spin mx-auto mb-2" />
            Memuat riwayat job...
          </div>
        ) : filteredJobs.length === 0 ? (
          <div className="text-center py-8 text-slate-500 text-xs">
            <History className="w-6 h-6 mx-auto mb-2 opacity-40" />
            {searchQuery ? 'Tidak ada job yang sesuai pencarian.' : 'Belum ada riwayat job.'}
          </div>
        ) : (
          filteredJobs.map((job) => {
            const isRetryable = retryableStages.includes(job.stage);
            const isCurrent = job.jobId === currentJobId;
            const isAwaitingVoiceover = !job.hasFinalVideo && (job.stage === 'awaiting_voiceover' || job.hasSilentVideo);
            const isProcessingThis = processingTtsId === job.jobId || (batchStatus.isRunning && batchStatus.currentJobId === job.jobId);
            const isRetryingThis = retryingId === job.jobId;
            const isAutoRetryingThis = autoRetryingJobs.has(job.jobId) || job.isAutoRetrying;

            // Determine button label and style
            const actionConfig = (() => {
              if (job.stage === 'completed') return { label: 'Lihat & Unduh', icon: Download, style: 'bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/30' };
              if (isAwaitingVoiceover) return { label: 'Lanjut Upload', icon: Music, style: 'bg-purple-500/20 text-purple-300 hover:bg-purple-500/30' };
              return { label: 'Retry', icon: RefreshCw, style: 'bg-amber-500/20 text-amber-300 hover:bg-amber-500/30' };
            })();
            const ActionIcon = actionConfig.icon;

            return (
              <div
                key={job.jobId}
                className={`group relative p-3.5 rounded-xl border transition-all cursor-pointer ${
                  isCurrent
                    ? 'border-shopee-500/50 bg-shopee-500/10 ring-1 ring-shopee-500/30'
                    : isAutoRetryingThis
                    ? 'border-amber-500/50 bg-amber-950/20 ring-1 ring-amber-500/40 animate-pulse'
                    : isAwaitingVoiceover
                    ? 'border-emerald-500/30 bg-emerald-950/10 hover:bg-emerald-950/20 ring-1 ring-emerald-500/20'
                    : isRetryable
                    ? 'border-amber-500/30 bg-amber-500/5 hover:bg-amber-500/10'
                    : job.stage === 'completed'
                    ? 'border-emerald-500/20 bg-slate-900/60 hover:bg-slate-800/60'
                    : 'border-slate-700/50 bg-slate-900/40 hover:bg-slate-800/40'
                }`}
                onClick={() => onSelectJob(job)}
              >
                <div className="flex items-start justify-between gap-3 flex-wrap sm:flex-nowrap">
                  <div className="flex-1 min-w-0">
                    {/* Title */}
                    <p className="text-xs font-bold text-slate-200 truncate">
                      {job.productTitle || <span className="text-slate-500 italic">Judul tidak tersimpan</span>}
                    </p>
                    {/* Job ID & date */}
                    <p className="text-[10px] text-slate-500 font-mono mt-0.5">
                      ID: {job.jobId}
                      {job.createdAt && ` · ${new Date(job.createdAt).toLocaleString('id-ID', { dateStyle: 'short', timeStyle: 'short' })}`}
                    </p>
                    {/* Stage badge */}
                    <div className="mt-2 flex items-center gap-2 flex-wrap">
                      <StageBadge stage={job.stage} />
                      {isAutoRetryingThis && (
                        <span className="text-[10px] text-amber-300 font-bold bg-amber-500/20 px-2 py-0.5 rounded-full border border-amber-500/40 flex items-center gap-1 animate-pulse">
                          <Zap className="w-2.5 h-2.5 fill-current text-amber-400" />
                          Auto Retrying...
                        </span>
                      )}
                      {job.hasDownloadedVideo && (
                        <span className="text-[10px] text-blue-400 font-semibold bg-blue-500/10 px-1.5 py-0.5 rounded border border-blue-500/20">
                          📥 Video Tersimpan
                        </span>
                      )}
                      {job.hasSilentVideo && (
                        <span className="text-[10px] text-purple-400 font-semibold bg-purple-500/10 px-1.5 py-0.5 rounded border border-purple-500/20">
                          🎬 9:16 Clip Ready
                        </span>
                      )}
                      {isAwaitingVoiceover && (
                        <span className="text-[10px] text-emerald-400 font-semibold bg-emerald-500/10 px-1.5 py-0.5 rounded border border-emerald-500/20">
                          ✨ Siap TTS
                        </span>
                      )}
                      {job.ttsVoice && job.stage === 'completed' && (
                        <span className="text-[10px] text-blue-400 font-semibold bg-blue-500/10 px-1.5 py-0.5 rounded border border-blue-500/20">
                          🎙️ {job.ttsVoice}
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="flex-shrink-0 flex flex-col items-end gap-1.5">
                    <div className="flex items-center gap-1.5">
                      {/* If awaiting voiceover, show primary Generate TTS AI button */}
                      {isAwaitingVoiceover ? (
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            disabled={isProcessingThis || batchStatus.isRunning}
                            onClick={(e) => handleGenerateTTSForJob(e, job)}
                            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-all shadow-md ${
                              isProcessingThis
                                ? 'bg-slate-800 text-slate-400 border border-slate-700 cursor-not-allowed'
                                : 'bg-gradient-to-r from-emerald-600 via-teal-600 to-emerald-500 hover:from-emerald-500 hover:to-teal-400 text-white shadow-emerald-500/20 hover:scale-[1.02] active:scale-[0.98]'
                            }`}
                            title="Generate suara voiceover & satukan subtitle ke video final secara otomatis"
                          >
                            {isProcessingThis ? (
                              <>
                                <RefreshCw className="w-3.5 h-3.5 animate-spin text-emerald-400" />
                                <span>Memproses...</span>
                              </>
                            ) : (
                              <>
                                <Sparkles className="w-3.5 h-3.5 text-emerald-200" />
                                <span>Generate TTS</span>
                              </>
                            )}
                          </button>

                          <button
                            type="button"
                            className="flex items-center gap-1 px-2 py-1.5 rounded-lg text-[11px] font-semibold bg-slate-800/90 hover:bg-slate-700 text-purple-300 border border-purple-500/30 transition-all"
                            title="Upload audio sendiri secara manual"
                            onClick={(e) => { e.stopPropagation(); onSelectJob(job); }}
                          >
                            <Music className="w-3 h-3" />
                            <span className="hidden xl:inline">Manual</span>
                          </button>

                          {/* Retry button on awaiting voiceover */}
                          <button
                            type="button"
                            disabled={isRetryingThis}
                            className="flex items-center gap-1 px-2 py-1.5 rounded-lg text-[11px] font-bold bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/30 transition-all shadow-sm"
                            title="Generate ulang video & naskah dari awal"
                            onClick={(e) => handleRetryJob(e, job)}
                          >
                            <RefreshCw className={`w-3 h-3 ${isRetryingThis ? 'animate-spin' : ''}`} />
                            <span>{isRetryingThis ? '...' : 'Retry'}</span>
                          </button>
                        </div>
                      ) : (
                        <>
                          {job.stage === 'completed' && (
                            <>
                              <button
                                className="p-1.5 rounded-lg text-slate-400 hover:text-amber-300 hover:bg-slate-800 transition-colors"
                                title="Buka file ini di Windows Explorer"
                                onClick={(e) => handleOpenFolder(e, job.finalFileName || `final_clip_${job.jobId}.mp4`)}
                              >
                                <FolderOpen className="w-3.5 h-3.5" />
                              </button>

                              {/* Dedicated RETRY TTS button for completed jobs */}
                              <button
                                type="button"
                                disabled={isProcessingThis || batchStatus.isRunning}
                                onClick={(e) => handleRetryTTSForJob(e, job)}
                                className={`flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-bold transition-all shadow-sm ${
                                  isProcessingThis
                                    ? 'bg-slate-800 text-slate-400 border border-slate-700 cursor-not-allowed'
                                    : 'bg-gradient-to-r from-teal-500/20 via-emerald-500/20 to-teal-500/20 hover:from-teal-500/30 hover:to-emerald-500/30 text-teal-300 border border-teal-500/40 hover:scale-[1.02] active:scale-[0.98]'
                                }`}
                                title="Deteksi kata Inggris dengan AI, tambahkan otomatis ke kamus fonetik, dan generate ulang suara & subtitle video"
                              >
                                {isProcessingThis ? (
                                  <>
                                    <RefreshCw className="w-3 h-3 animate-spin text-teal-400" />
                                    <span>Memproses...</span>
                                  </>
                                ) : (
                                  <>
                                    <Volume2 className="w-3 h-3 text-teal-400" />
                                    <span>Retry TTS</span>
                                  </>
                                )}
                              </button>

                              {/* AUTO RETRY BUTTON FOR COMPLETED JOBS */}
                              {isAutoRetryingThis ? (
                                <button
                                  type="button"
                                  onClick={(e) => handleStopAutoRetry(e, job)}
                                  className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-bold bg-red-500/20 hover:bg-red-500/30 text-red-300 border border-red-500/40 transition-all shadow-sm animate-pulse"
                                  title="Hentikan pencarian Auto Retry untuk produk ini"
                                >
                                  <Square className="w-3 h-3 fill-current text-red-400" />
                                  <span>Stop Auto Retry</span>
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  disabled={isRetryingThis}
                                  onClick={(e) => handleStartAutoRetry(e, job)}
                                  className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-bold bg-gradient-to-r from-amber-500/20 via-orange-500/20 to-amber-500/20 hover:from-amber-500/30 hover:to-orange-500/30 text-amber-300 border border-amber-500/40 transition-all shadow-sm hover:scale-[1.02] active:scale-[0.98]"
                                  title="Auto Retry terus mencari video persis & faceless sampai selesai atau distop"
                                >
                                  <Zap className="w-3 h-3 text-amber-400 fill-amber-400/40" />
                                  <span>Auto Retry</span>
                                </button>
                              )}

                              {/* Single Retry Button */}
                              <button
                                type="button"
                                disabled={isRetryingThis || isAutoRetryingThis}
                                className="flex items-center gap-1 px-2 py-1.5 rounded-lg text-[11px] font-semibold bg-slate-800/80 hover:bg-slate-700 text-slate-300 border border-slate-700/60 transition-all shadow-sm"
                                title="Generate ulang 1x percobaan saja"
                                onClick={(e) => handleRetryJob(e, job)}
                              >
                                <RefreshCw className={`w-3 h-3 ${isRetryingThis ? 'animate-spin text-amber-400' : ''}`} />
                                <span className="hidden xl:inline">{isRetryingThis ? '...' : 'Retry 1x'}</span>
                              </button>
                            </>
                          )}

                          <button
                            className={`flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-bold transition-all ${actionConfig.style}`}
                            onClick={(e) => { e.stopPropagation(); onSelectJob(job); }}
                          >
                            <ActionIcon className="w-3 h-3" />
                            {actionConfig.label}
                          </button>
                        </>
                      )}
                    </div>

                    {/* Delete button */}
                    <button
                      onClick={(e) => handleDelete(e, job.jobId)}
                      disabled={deletingId === job.jobId || isProcessingThis}
                      className="p-1.5 rounded-lg text-slate-600 hover:text-red-400 hover:bg-red-500/10 transition-colors opacity-0 group-hover:opacity-100"
                    >
                      {deletingId === job.jobId
                        ? <RefreshCw className="w-3 h-3 animate-spin" />
                        : <Trash2 className="w-3 h-3" />}
                    </button>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
