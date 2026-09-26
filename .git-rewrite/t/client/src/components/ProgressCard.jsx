import React from 'react';
import { Download, Film, Sparkles, Clapperboard, Layers, CheckCircle2, AlertCircle, Loader2, Music, RefreshCw, ExternalLink, Key, CreditCard, Zap, Square } from 'lucide-react';

export default function ProgressCard({ progressState, onRetry, onStopAutoRetry, isLoading }) {
  const { step, message, progress = 0, status, error, isQuotaError } = progressState;

  const steps = [
    { id: 'download', label: '1. Download 1080p Video', icon: Download, desc: 'yt-dlp engine fetching max 1080p' },
    { id: 'gemini_vision', label: '2. Faceless AI Highlight', icon: Sparkles, desc: 'Avoids creator face, finds product focus' },
    { id: 'render_silent', label: '3. Faceless 9:16 Render', icon: Layers, desc: 'Product/hands crop without black bars' },
    { id: 'gpt_scripting', label: '4. AI Scripting & Kotak Scene', icon: Clapperboard, desc: 'Kotak Scene, Context & Naskah' },
    { id: 'awaiting_voiceover', label: '5. Ready for Voiceover', icon: Music, desc: 'Paste naskah to AI Studio & upload' },
  ];

  const getStepStatus = (stepId, index) => {
    if (status === 'error') {
      if (step === stepId) return 'error';
    }
    if (status === 'completed' || status === 'awaiting_voiceover') {
      if (stepId === 'awaiting_voiceover') return 'completed';
    }

    const stepOrder = ['start', 'download', 'frames_raw', 'gemini_vision', 'render_silent', 'frames_trimmed', 'gpt_scripting', 'awaiting_voiceover', 'completed'];
    const currentIndex = stepOrder.indexOf(step);
    const thisIndex = stepOrder.indexOf(stepId);

    if (thisIndex < currentIndex) return 'completed';
    if (thisIndex === currentIndex || (stepId === 'gemini_vision' && step === 'frames_raw') || (stepId === 'gpt_scripting' && step === 'frames_trimmed')) return 'current';
    return 'pending';
  };

  const detectedQuotaError = isQuotaError ||
    (error && (
      error.toLowerCase().includes('saldo') ||
      error.toLowerCase().includes('insufficient') ||
      error.toLowerCase().includes('balance') ||
      error.toLowerCase().includes('quota') ||
      error.toLowerCase().includes('credit')
    ));

  return (
    <div className={`glass-panel-glow rounded-2xl p-6 shadow-2xl relative overflow-hidden transition-all duration-300 ${
      status === 'error' ? 'border-red-500/40 shadow-red-500/10' : ''
    }`}>
      
      {/* Header & Percentage */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          {status === 'error' ? (
            <div className="w-9 h-9 rounded-xl bg-red-500/20 border border-red-500/30 flex items-center justify-center text-red-400">
              <AlertCircle className="w-5 h-5" />
            </div>
          ) : status === 'completed' || status === 'awaiting_voiceover' ? (
            <div className="w-9 h-9 rounded-xl bg-emerald-500/20 border border-emerald-500/30 flex items-center justify-center text-emerald-400">
              <CheckCircle2 className="w-5 h-5" />
            </div>
          ) : (
            <div className="w-9 h-9 rounded-xl bg-shopee-500/20 border border-shopee-500/30 flex items-center justify-center text-shopee-500">
              <Loader2 className="w-5 h-5 animate-spin" />
            </div>
          )}

          <div>
            <h3 className="text-base font-bold text-white flex items-center gap-2">
              <span>
                {status === 'completed' || status === 'awaiting_voiceover'
                  ? 'Tahap 1 Selesai!'
                  : status === 'error'
                  ? 'Proses Berhenti (Dapat Diulang)'
                  : 'Pipeline Video Sedang Berjalan'}
              </span>
              {status === 'error' && (
                <span className="text-[10px] uppercase font-bold bg-red-500/20 text-red-300 px-2 py-0.5 rounded-full border border-red-500/30">
                  Gagal
                </span>
              )}
            </h3>
            <p className="text-xs text-slate-400 font-mono truncate max-w-md">
              {message || 'Menjalankan ekstraksi dan analisis AI...'}
            </p>
          </div>
        </div>

        <div className="text-right">
          <span className="text-2xl font-black text-white font-mono">{progress}%</span>
        </div>
      </div>

      {/* Target Product Badge */}
      {progressState.coreProductNoun && (
        <div className="mb-4 px-3 py-1.5 rounded-xl bg-slate-900/90 border border-slate-700/70 flex items-center justify-between text-xs animate-in fade-in">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-amber-400 font-bold flex items-center gap-1 flex-shrink-0">
              <Sparkles className="w-3.5 h-3.5" />
              Target Produk:
            </span>
            <span className="font-semibold text-white truncate">"{progressState.coreProductNoun}"</span>
          </div>
          <span className="text-[10px] text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded-full border border-emerald-500/20 font-mono flex-shrink-0 ml-2">
            Policy Filter Aktif
          </span>
        </div>
      )}

      {/* Auto Retry Active Banner */}
      {progressState.isAutoRetrying && (
        <div className="mb-4 p-3 rounded-xl bg-gradient-to-r from-amber-950/60 via-slate-900/80 to-amber-950/60 border border-amber-500/40 flex items-center justify-between gap-3 text-xs text-amber-200 shadow-lg shadow-amber-950/30 animate-in fade-in">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="p-1.5 rounded-lg bg-amber-500/20 text-amber-400 flex-shrink-0 animate-pulse">
              <Zap className="w-4 h-4 fill-current" />
            </div>
            <div className="min-w-0">
              <div className="font-bold text-white flex items-center gap-1.5 flex-wrap">
                <span>Auto Retry Mode Aktif</span>
                {progressState.attemptCount ? (
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/40 font-mono">
                    Percobaan ke-{progressState.attemptCount}
                  </span>
                ) : null}
              </div>
              <p className="text-[11px] text-amber-200/80 truncate">
                Mencari video YouTube yang cocok persis &amp; 100% bebas wajah/manusia...
              </p>
            </div>
          </div>
          {onStopAutoRetry && (
            <button
              type="button"
              onClick={onStopAutoRetry}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold bg-red-500/20 hover:bg-red-500/30 text-red-300 border border-red-500/40 transition-all shadow-sm flex-shrink-0 hover:scale-[1.02] active:scale-[0.98]"
              title="Hentikan pencarian otomatis"
            >
              <Square className="w-3.5 h-3.5 fill-current text-red-400" />
              <span>Stop</span>
            </button>
          )}
        </div>
      )}

      {/* Main Progress Bar */}
      <div className="w-full h-2.5 bg-slate-800 rounded-full overflow-hidden mb-6 p-0.5 border border-slate-700/50">
        <div
          className={`h-full rounded-full transition-all duration-500 ${
            status === 'error'
              ? 'bg-red-500'
              : status === 'completed' || status === 'awaiting_voiceover'
              ? 'bg-emerald-500'
              : 'bg-gradient-to-r from-shopee-500 via-orange-500 to-amber-400 animate-pulse'
          }`}
          style={{ width: `${progress}%` }}
        />
      </div>

      {/* Grid of Steps */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {steps.map((s, idx) => {
          const stepStatus = getStepStatus(s.id, idx);
          const Icon = s.icon;

          return (
            <div
              key={s.id}
              className={`p-3 rounded-xl border transition-all flex items-start gap-3 ${
                stepStatus === 'completed'
                  ? 'bg-slate-900/90 border-emerald-500/30 text-slate-200'
                  : stepStatus === 'current'
                  ? 'bg-slate-900/90 border-shopee-500/60 shadow-lg shadow-shopee-500/10 text-white ring-1 ring-shopee-500/40'
                  : stepStatus === 'error'
                  ? 'bg-red-950/30 border-red-500/40 text-red-200'
                  : 'bg-slate-900/40 border-slate-800/80 text-slate-500'
              }`}
            >
              <div
                className={`p-2 rounded-lg mt-0.5 ${
                  stepStatus === 'completed'
                    ? 'bg-emerald-500/20 text-emerald-400'
                    : stepStatus === 'current'
                    ? 'bg-shopee-500/20 text-shopee-400 animate-bounce'
                    : stepStatus === 'error'
                    ? 'bg-red-500/20 text-red-400'
                    : 'bg-slate-800/60 text-slate-600'
                }`}
              >
                <Icon className="w-4 h-4" />
              </div>

              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold truncate">{s.label}</span>
                  {stepStatus === 'completed' && (
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 flex-shrink-0" />
                  )}
                  {stepStatus === 'current' && (
                    <Loader2 className="w-3.5 h-3.5 text-shopee-400 animate-spin flex-shrink-0" />
                  )}
                </div>
                <p className="text-[11px] text-slate-400 truncate mt-0.5">{s.desc}</p>
              </div>
            </div>
          );
        })}
      </div>

      {/* Error Box & Retry Options */}
      {status === 'error' && (
        <div className="mt-5 space-y-3 animate-in fade-in duration-300">
          
          {/* Quota / Balance Specific Banner */}
          {detectedQuotaError ? (
            <div className="p-4 rounded-xl bg-amber-950/40 border border-amber-500/40 text-amber-200 text-xs">
              <div className="font-bold flex items-center justify-between text-amber-300 mb-1.5">
                <span className="flex items-center gap-1.5">
                  <CreditCard className="w-4 h-4 text-amber-400" />
                  Batas Kuota AI Tercapai (LLM / API Provider)
                </span>
                <span className="text-[10px] font-mono bg-amber-500/20 text-amber-300 px-2 py-0.5 rounded border border-amber-500/30">
                  Dapat Di-Retry Besok
                </span>
              </div>
              <p className="text-[11px] text-slate-300 leading-relaxed mb-2">
                Panggilan AI berhenti karena limit kuota provider tercapai. Data formulir dan video yang sudah dipotong <strong>tidak hilang dan tersimpan aman</strong>.
                Anda cukup menekan tombol <strong>"Coba Lagi (Retry Job)"</strong> saat kuota provider sudah direset kembali.
              </p>
              {error && (
                <div className="p-2 rounded bg-black/30 text-amber-200/90 font-mono text-[10px] break-all border border-amber-500/20">
                  {error}
                </div>
              )}
            </div>
          ) : (
            <div className="p-4 rounded-xl bg-red-950/40 border border-red-500/40 text-red-200 text-xs font-mono">
              <div className="font-bold flex items-center gap-1.5 mb-1 text-red-400">
                <AlertCircle className="w-4 h-4" />
                Detail Error:
              </div>
              <p className="break-all whitespace-pre-wrap">{error || 'Terjadi kendala pada server backend.'}</p>
            </div>
          )}

          {/* Retry Action Button Bar */}
          <div className="flex items-center gap-3 pt-1">
            <button
              type="button"
              onClick={onRetry}
              disabled={isLoading}
              className="flex-1 py-3 px-4 rounded-xl bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-600 hover:to-amber-600 text-white font-bold text-xs flex items-center justify-center gap-2 transition-all shadow-lg shadow-orange-500/20 hover:scale-[1.01] active:scale-[0.99]"
            >
              <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
              <span>Coba Lagi (Retry Job)</span>
            </button>
          </div>

        </div>
      )}

    </div>
  );
}
