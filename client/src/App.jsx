import React, { useState, useEffect, useRef } from 'react';
import Navbar from './components/Navbar';
import DependenciesStatus from './components/DependenciesStatus';
import InputCard from './components/InputCard';
import ProgressCard from './components/ProgressCard';
import VideoPlayer from './components/VideoPlayer';
import CaptionCard from './components/CaptionCard';
import VoiceoverUploader from './components/VoiceoverUploader';
import SettingsModal from './components/SettingsModal';
import JobHistoryPanel from './components/JobHistoryPanel';
import AutoModePanel from './components/AutoModePanel';
import ErrorBoundary from './components/ErrorBoundary';
import { Sparkles, Clapperboard } from 'lucide-react';
import toast, { Toaster } from 'react-hot-toast';
import { withAuthQuery } from './utils/auth.js';

export default function App() {
  const [formData, setFormData] = useState(() => ({
    youtubeUrl: '',
    shopeeLink: '',
    productTitle: '',
    productDescription: '',
    oemUrls: [''],
    niche: (() => { try { return localStorage.getItem('clipper_niche') || 'kitchen_tools'; } catch { return 'kitchen_tools'; } })(),
  }));

  const [settings, setSettings] = useState({
    aiProvider: 'gemini',
    ttsProvider: 'gemini_tts',
    ttsModel: 'gemini-3.1-flash-tts-preview',
    ttsFallbackModel: 'gemini-2.5-flash-preview-tts',
    ttsVoice: 'Despina',
    sceneDuration: 3.3,
    renderMode: 'stage_80',
    hflip: false,
    speedMultiplier: 1,
    enableSubtitles: true,
    voice: 'Despina',
  });

  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isUploading, setIsUploading] = useState(false);

  const [progressState, setProgressState] = useState({
    step: 'idle', message: '', progress: 0, status: 'idle',
    error: null, isQuotaError: false, canRetry: false,
  });

  const [result, setResult] = useState(null);
  const [engineStatus, setEngineStatus] = useState(null);
  const [checkingEngine, setCheckingEngine] = useState(false);
  const [historyRefreshSignal, setHistoryRefreshSignal] = useState(0);
  
  // Navigation State
  const [activeView, setActiveView] = useState('studio'); // 'studio' | 'auto' | 'history'

  // Draft / Offline Queue State
  const [drafts, setDrafts] = useState([]);
  const [isAutoRunningDrafts, setIsAutoRunningDrafts] = useState(false);

  const lastJobIdRef = useRef(null);
  const lastFormDataRef = useRef(null);
  const eventSourceRef = useRef(null);

  const fetchEngineHealth = async () => {
    setCheckingEngine(true);
    try {
      const res = await fetch('/api/health');
      if (res.ok) {
        const data = await res.json();
        setEngineStatus(data);
        setSettings((prev) => ({
          ...prev,
          ...(data.activeAiEngine && data.activeAiEngine !== 'none' ? { aiProvider: prev.aiProvider || data.activeAiEngine } : {}),
          ...(data.tts ? {
            ttsProvider: prev.ttsProvider || data.tts.provider || 'gemini_tts',
            ttsModel: prev.ttsModel || data.tts.model || 'gemini-3.1-flash-tts-preview',
            ttsFallbackModel: prev.ttsFallbackModel || data.tts.fallbackModel || 'gemini-2.5-flash-preview-tts',
            ttsVoice: prev.ttsVoice || data.tts.voice || 'Despina',
          } : {})
        }));
      }
    } catch (err) {
      console.warn('Could not fetch backend health:', err.message);
    } finally {
      setCheckingEngine(false);
    }
  };

  const fetchDrafts = async () => {
    try {
      const res = await fetch('/api/drafts');
      if (res.ok) {
        const data = await res.json();
        setDrafts(data.drafts || []);
      }
    } catch (err) {}
  };

  useEffect(() => { 
    fetchEngineHealth(); 
    fetchDrafts();
  }, []);

  // Memulai pemrosesan seluruh draft secara berurutan
  const handleRunAllDrafts = async () => {
    if (drafts.length === 0) return;
    setIsAutoRunningDrafts(true);
    // Draft pertama di-set, form disiapkan, lalu trigger jalankan
    const nextDraft = drafts[0];
    setFormData(nextDraft);
    lastFormDataRef.current = nextDraft;
    
    // Hapus draft ini dari server (dan state) karena akan diproses
    await handleDeleteDraft(nextDraft.id);
    
    // Jalankan pipeline (jangan ditunggu agar state tidak mem-block)
    setTimeout(() => {
      runGeneratePipeline(null, nextDraft);
    }, 500);
  };

  const handleSaveDraft = async (draftData) => {
    if (!draftData.productTitle) return toast.error('Judul produk tidak boleh kosong.');
    if (!draftData.youtubeUrl) return toast.error('YouTube URL tidak boleh kosong.');
    if (!draftData.shopeeLink) return toast.error('Link Affiliate tidak boleh kosong.');

    try {
      const res = await fetch('/api/drafts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draftData)
      });
      if (res.ok) {
        toast.success('Draft berhasil disimpan (Bisa diproses saat online/ada waktu).');
        fetchDrafts();
        // Reset form setelah simpan
        setFormData({
          youtubeUrl: '', shopeeLink: '', productTitle: '', productDescription: '', oemUrls: [''],
          niche: formData.niche || 'kitchen_tools',
        });
      }
    } catch (err) {
      toast.error('Gagal menyimpan draft.');
    }
  };

  const handleDeleteDraft = async (id) => {
    try {
      await fetch(`/api/drafts/${id}`, { method: 'DELETE' });
      setDrafts(prev => prev.filter(d => d.id !== id));
    } catch (err) {
      console.warn('Gagal menghapus draft', err);
    }
  };

  const processNextDraftQueue = async () => {
    // Jika tidak sedang mode run-all atau draft sudah habis
    if (drafts.length === 0) {
      if (isAutoRunningDrafts) {
        setIsAutoRunningDrafts(false);
        toast.success('Semua antrean draft telah selesai diproses!');
      }
      return;
    }
    
    if (isAutoRunningDrafts) {
      const nextDraft = drafts[0];
      setFormData(nextDraft);
      lastFormDataRef.current = nextDraft;
      await handleDeleteDraft(nextDraft.id);
      
      setTimeout(() => {
        runGeneratePipeline(null, nextDraft);
      }, 1500); // Jeda antar proses agar server bernafas
    }
  };

  // Core pipeline runner (used by fresh runs, retries, and history resumes)
  const runGeneratePipeline = async (overrideJobId = null, overrideFormData = null) => {
    const isRetrying = Boolean(overrideJobId);
    const currentForm = overrideFormData || lastFormDataRef.current || formData;
    const jobId = overrideJobId || Math.random().toString(36).substring(2, 10);
    lastJobIdRef.current = jobId;

    setIsLoading(true);
    setResult(null);

    const activeEngineName = (settings.aiProvider === 'gemini' || engineStatus?.activeAiEngine === 'gemini')
      ? 'Gemini File API + Gemini'
      : 'FFmpeg + OpenRouter';

    setProgressState({
      step: 'start',
      message: isRetrying
        ? `Mencoba ulang dari tahap yang terhenti (Retry)...`
        : `Memulai Tahap 1: Analisis AI (${activeEngineName})...`,
      progress: 5, status: 'running', error: null, isQuotaError: false, canRetry: false,
    });

    if (eventSourceRef.current) eventSourceRef.current.close();

    const sse = new EventSource(withAuthQuery(`/api/progress/${jobId}`));
    eventSourceRef.current = sse;

    sse.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        setProgressState((prev) => ({
          ...prev,
          step: data.step || prev.step,
          message: data.message || prev.message,
          progress: data.progress !== undefined ? data.progress : prev.progress,
          status: data.status || prev.status,
          error: data.error || null,
          isQuotaError: data.isQuotaError || false,
          canRetry: data.canRetry || false,
          coreProductNoun: data.coreProductNoun || prev.coreProductNoun,
        }));
        if ((data.status === 'awaiting_voiceover' || data.status === 'completed') && data.result) {
          setResult(data.result);
          setIsLoading(false);
          sse.close();
          // Lanjut ke draft berikutnya jika dalam mode isAutoRunningDrafts
          setTimeout(() => processNextDraftQueue(), 1000);
        } else if (data.status === 'error') {
          setIsLoading(false);
          sse.close();
          // Jika error, lewati dan lanjut ke draft berikutnya
          setTimeout(() => processNextDraftQueue(), 1000);
        }
      } catch (e) {
        console.error('Error parsing SSE event:', e);
      }
    };
    sse.onerror = () => sse.close();

    try {
      const response = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jobId,
          youtubeUrl: currentForm.youtubeUrl,
          shopeeLink: currentForm.shopeeLink,
          productTitle: currentForm.productTitle,
          productDescription: currentForm.productDescription,
          oemUrls: (Array.isArray(currentForm.oemUrls) ? currentForm.oemUrls : []).map((url) => String(url || '').trim()).filter(Boolean),
          aiProvider: settings.aiProvider || engineStatus?.activeAiEngine || 'gemini',
          niche: currentForm.niche || 'kitchen_tools',
          options: {
            ...settings,
            aiProvider: settings.aiProvider || engineStatus?.activeAiEngine || 'gemini',
            niche: currentForm.niche || 'kitchen_tools',
          },
        }),
      });

      const rawText = await response.text();
      let data;
      try {
        data = JSON.parse(rawText);
      } catch {
        throw new Error(
          response.ok
            ? `Respon server tidak valid: ${rawText.slice(0, 200)}`
            : `Server Backend Error (${response.status}): Pastikan 'npm run dev' berjalan.`
        );
      }

      if (!response.ok || !data.jobId) throw new Error(data.error || 'Gagal memproses Tahap 1.');

      setResult(data);
      setProgressState((prev) => ({
        ...prev, step: 'awaiting_voiceover',
        message: 'Tahap 1 Selesai! Upload voiceover dari AI Studio untuk finalisasi.',
        progress: 100, status: 'awaiting_voiceover', error: null, canRetry: false,
      }));
    } catch (err) {
      const isQuotaError = ['saldo', 'insufficient', 'balance', 'quota', 'credit'].some(k =>
        err.message.toLowerCase().includes(k)
      );
      setProgressState((prev) => ({
        ...prev, step: 'error', message: err.message || 'Proses gagal.',
        progress: prev.progress, status: 'error', error: err.message, isQuotaError, canRetry: true,
      }));
      // Jika error pada tahap request awal, lanjut ke antrean draft jika aktif
      setTimeout(() => processNextDraftQueue(), 1000);
    } finally {
      setIsLoading(false);
      if (eventSourceRef.current) eventSourceRef.current.close();
    }
  };

  // Fresh generate
  const handleGenerate = async () => {
    if (!formData.productTitle) return toast.error('Silakan masukkan Judul / Nama Produk.');
    if (!formData.youtubeUrl) return toast.error('Silakan masukkan YouTube Video URL.');
    if (!formData.shopeeLink) return toast.error('Silakan masukkan link Shopee Affiliate Anda.');
    lastFormDataRef.current = { ...formData };
    await runGeneratePipeline(null);
  };

  // Retry with same jobId (server reuses cached video)
  const handleRetry = async () => {
    await runGeneratePipeline(lastJobIdRef.current);
  };

  // Select a job from Job History Panel (retry / resume / view)
  const handleSelectJob = (job) => {
    lastJobIdRef.current = job.jobId;

    // Restore form data from persisted job
    const restoredForm = {
      ...formData,
      youtubeUrl: job.youtubeUrl || formData.youtubeUrl,
      shopeeLink: job.shopeeLink || formData.shopeeLink,
      productTitle: job.productTitle || formData.productTitle,
      productDescription: job.productDescription || formData.productDescription,
      oemUrls: Array.isArray(job.oemUrls) ? job.oemUrls : (formData.oemUrls || ['']),
      niche: job.niche || formData.niche || 'kitchen_tools',
    };
    setFormData(restoredForm);
    lastFormDataRef.current = restoredForm;
    setActiveView('studio');

    // If job is currently running or auto-retrying, connect to live progress SSE
    if (job.isAutoRetrying || job.stage === 'running') {
      setIsLoading(true);
      setResult(null);
      setProgressState({
        step: 'auto_retry',
        message: `Memantau pencarian video cocok persis untuk "${job.productTitle || job.jobId}"...`,
        progress: 10,
        status: 'running',
        error: null,
        isAutoRetrying: true,
      });

      if (eventSourceRef.current) eventSourceRef.current.close();
      const sse = new EventSource(withAuthQuery(`/api/progress/${job.jobId}`));
      eventSourceRef.current = sse;

      sse.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          setProgressState((prev) => ({
            ...prev,
            step: data.step || prev.step,
            message: data.message || prev.message,
            progress: data.progress !== undefined ? data.progress : prev.progress,
            status: data.status || prev.status,
            error: data.error || null,
            isQuotaError: data.isQuotaError || false,
            canRetry: data.canRetry || false,
            isAutoRetrying: data.isAutoRetrying !== undefined ? data.isAutoRetrying : prev.isAutoRetrying,
            attemptCount: data.attemptCount || prev.attemptCount,
          }));

          if ((data.status === 'awaiting_voiceover' || data.status === 'completed') && data.result) {
            setResult(data.result);
            setIsLoading(false);
            sse.close();
            setHistoryRefreshSignal((v) => v + 1);
          } else if (data.status === 'error') {
            setIsLoading(false);
            sse.close();
            setHistoryRefreshSignal((v) => v + 1);
          }
        } catch (e) {
          console.error('Error parsing SSE in handleSelectJob:', e);
        }
      };
      sse.onerror = () => sse.close();
      return;
    }

    // If job is already done or has clips/scenes, restore all data directly
    const hasFinal = job.stage === 'completed' || Boolean(job.hasFinalVideo);
    const hasSilent = job.stage === 'awaiting_voiceover' || Boolean(job.hasSilentVideo);
    const hasContent = hasFinal || hasSilent || (Array.isArray(job.scenes) && job.scenes.length > 0);

    if (hasContent) {
      const activeStage = hasFinal ? 'completed' : 'awaiting_voiceover';
      setResult({
        ...job,
        stage: activeStage,
        videoUrl: job.videoUrl || job.finalVideoUrl || (hasFinal ? `/api/video/final_clip_${job.jobId}.mp4` : null),
        downloadUrl: job.downloadUrl || job.finalVideoUrl || (hasFinal ? `/api/download/final_clip_${job.jobId}.mp4` : null),
        silentVideoUrl: job.silentVideoUrl || `/api/video/silent_clip_${job.jobId}.mp4`,
        finalLocalPath: job.finalLocalPath || `server/output/final_clip_${job.jobId}.mp4`,
        silentLocalPath: job.silentLocalPath || `server/output/silent_clip_${job.jobId}.mp4`,
      });
      setProgressState({
        step: activeStage,
        message: hasFinal
          ? 'Video Final & seluruh data pemasaran siap digunakan untuk Reels.'
          : 'Kotak Scene & Naskah tersedia. Upload voiceover untuk finalisasi.',
        progress: 100,
        status: activeStage,
        error: null,
        canRetry: false,
        isAutoRetrying: false,
      });
      return;
    }

    if (job.stage === 'error' || job.stage === 'interrupted') {
      setResult(null);
      setProgressState({
        step: 'error',
        message: job.lastError || `Job sebelumnya terhenti (${job.stage}). Klik tombol Retry untuk mencoba lagi.`,
        progress: 100,
        status: 'error',
        error: job.lastError || `Job terhenti pada tahap: ${job.stage}`,
        canRetry: true,
        isAutoRetrying: false,
      });
      return;
    }

    // Otherwise retry the pipeline
    runGeneratePipeline(job.jobId, restoredForm);
  };

  const handleStopCurrentAutoRetry = async () => {
    const jobId = lastJobIdRef.current;
    if (!jobId) return;
    try {
      await fetch(`/api/jobs/${jobId}/auto-retry/stop`, { method: 'POST' });
      setProgressState((prev) => ({
        ...prev,
        isAutoRetrying: false,
        message: 'Menghentikan Auto Retry...',
      }));
      setHistoryRefreshSignal((v) => v + 1);
    } catch (err) {
      console.warn('Could not stop auto retry:', err);
    }
  };

  const handleRetryJob = async (job) => {
    const isCompleted = job.stage === 'completed';
    const confirmMsg = isCompleted
      ? `Generate ulang job "${job.productTitle || job.jobId}"?\n\nVideo lama dan voiceover yang kualitasnya kurang baik akan dihapus dan diganti secara otomatis dengan video source 1080p baru & voiceover baru.`
      : `Generate ulang job "${job.productTitle || job.jobId}" dari awal?`;

    if (!window.confirm(confirmMsg)) return;

    lastJobIdRef.current = job.jobId;

    const restoredForm = {
      ...formData,
      youtubeUrl: job.youtubeUrl || formData.youtubeUrl,
      shopeeLink: job.shopeeLink || formData.shopeeLink,
      productTitle: job.productTitle || formData.productTitle,
      productDescription: job.productDescription || formData.productDescription,
    };
    setFormData(restoredForm);
    lastFormDataRef.current = restoredForm;
    setActiveView('studio'); // Pindah ke tab studio otomatis saat di-retry

    setIsLoading(true);
    setResult(null);

    setProgressState({
      step: 'retry_start',
      message: `Menyiapkan generate ulang untuk "${job.productTitle || job.jobId}" (Source 1080p & Voiceover Baru)...`,
      progress: 5,
      status: 'running',
      error: null,
      isQuotaError: false,
      canRetry: false,
    });

    if (eventSourceRef.current) eventSourceRef.current.close();

    const sse = new EventSource(withAuthQuery(`/api/progress/${job.jobId}`));
    eventSourceRef.current = sse;

    sse.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        setProgressState((prev) => ({
          ...prev,
          step: data.step || prev.step,
          message: data.message || prev.message,
          progress: data.progress !== undefined ? data.progress : prev.progress,
          status: data.status || prev.status,
          error: data.error || null,
          isQuotaError: data.isQuotaError || false,
          canRetry: data.canRetry || false,
          coreProductNoun: data.coreProductNoun || prev.coreProductNoun,
        }));

        if ((data.status === 'awaiting_voiceover' || data.status === 'completed') && data.result) {
          setResult(data.result);
          setIsLoading(false);
          sse.close();
          setHistoryRefreshSignal((v) => v + 1);
        } else if (data.status === 'error') {
          setIsLoading(false);
          sse.close();
          setHistoryRefreshSignal((v) => v + 1);
        }
      } catch (e) {
        console.error('Error parsing SSE event in handleRetryJob:', e);
      }
    };
    sse.onerror = () => sse.close();

    try {
      const res = await fetch(`/api/jobs/${job.jobId}/retry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ forceNewCandidate: true }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Gagal memulai retry pada server.');
      }
    } catch (err) {
      setProgressState((prev) => ({
        ...prev,
        step: 'error',
        message: err.message || 'Gagal generate ulang.',
        status: 'error',
        error: err.message,
        canRetry: true,
      }));
      setIsLoading(false);
      if (eventSourceRef.current) eventSourceRef.current.close();
    }
  };

  const handleVoiceoverUploadSuccess = (finalData) => {
    setResult(finalData);
    setProgressState({
      step: 'completed', message: 'Tahap 2 Selesai! Video Final siap diunduh.',
      progress: 100, status: 'completed', error: null, canRetry: false,
    });
  };

  const isGenerating = isLoading || progressState.status !== 'idle';
  const hasResult = !!result;
  const isCompleted = hasResult && progressState.status === 'completed';
  
  const activeStep = isCompleted ? 3 : (isGenerating || hasResult) ? 2 : 1;

  return (
    <div className="min-h-screen flex flex-col bg-[#080d1a] text-slate-100 pb-safe">
      <Toaster position="top-center" toastOptions={{
        style: { background: '#1e293b', color: '#f1f5f9', border: '1px solid #334155' }
      }} />
      <Navbar onOpenSettings={() => setIsSettingsOpen(true)} engineStatus={engineStatus} />

      <main className="flex-1 max-w-6xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-8">
        <DependenciesStatus status={engineStatus} onRefresh={fetchEngineHealth} loading={checkingEngine} />

        {/* Tab Navigation Menu */}
        <div className="flex justify-center mb-8">
          <div className="flex bg-slate-900/60 p-1.5 rounded-2xl border border-slate-800 shadow-lg shadow-black/20">
            <button
              onClick={() => setActiveView('studio')}
              className={`px-6 py-2.5 rounded-xl text-sm font-semibold transition-all ${activeView === 'studio' ? 'bg-shopee-500 text-white shadow-md shadow-shopee-500/25' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'}`}
            >
              Studio Video
            </button>
            <button
              onClick={() => setActiveView('auto')}
              className={`px-6 py-2.5 rounded-xl text-sm font-semibold transition-all ${activeView === 'auto' ? 'bg-shopee-500 text-white shadow-md shadow-shopee-500/25' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'}`}
            >
              Mode Otomatis
            </button>
            <button
              onClick={() => setActiveView('history')}
              className={`px-6 py-2.5 rounded-xl text-sm font-semibold transition-all ${activeView === 'history' ? 'bg-shopee-500 text-white shadow-md shadow-shopee-500/25' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'}`}
            >
              Riwayat Video
            </button>
          </div>
        </div>

        {activeView === 'studio' && (
          <div className="space-y-8 animate-in fade-in duration-300">
            {/* Stepper Navigation */}
            <div className="flex items-center justify-between max-w-2xl mx-auto mb-8 px-4">
              <div className={`flex flex-col items-center gap-2 ${activeStep >= 1 ? 'text-shopee-500' : 'text-slate-500'}`}>
                <div className={`w-8 h-8 rounded-full flex items-center justify-center font-bold transition-all ${activeStep >= 1 ? 'bg-shopee-500 text-white shadow-lg shadow-shopee-500/30' : 'bg-slate-800 text-slate-500'}`}>1</div>
                <span className="text-xs font-semibold">Sumber Video</span>
              </div>
              <div className={`h-1 flex-1 mx-4 rounded-full transition-all ${activeStep >= 2 ? 'bg-shopee-500/50' : 'bg-slate-800'}`}></div>
              <div className={`flex flex-col items-center gap-2 ${activeStep >= 2 ? 'text-shopee-500' : 'text-slate-500'}`}>
                <div className={`w-8 h-8 rounded-full flex items-center justify-center font-bold transition-all ${activeStep >= 2 ? 'bg-shopee-500 text-white shadow-lg shadow-shopee-500/30' : 'bg-slate-800 text-slate-500'}`}>2</div>
                <span className="text-xs font-semibold">Proses AI</span>
              </div>
              <div className={`h-1 flex-1 mx-4 rounded-full transition-all ${activeStep >= 3 ? 'bg-shopee-500/50' : 'bg-slate-800'}`}></div>
              <div className={`flex flex-col items-center gap-2 ${activeStep >= 3 ? 'text-shopee-500' : 'text-slate-500'}`}>
                <div className={`w-8 h-8 rounded-full flex items-center justify-center font-bold transition-all ${activeStep >= 3 ? 'bg-shopee-500 text-white shadow-lg shadow-shopee-500/30' : 'bg-slate-800 text-slate-500'}`}>3</div>
                <span className="text-xs font-semibold">Hasil Akhir</span>
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
              
              {/* Main Working Area (Left Column on Desktop) */}
              <div className="lg:col-span-7 space-y-6">
                
                {activeStep === 1 && (
                  <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
                    <InputCard
                      formData={formData}
                      setFormData={setFormData}
                      onGenerate={handleGenerate}
                      isLoading={isLoading || isAutoRunningDrafts}
                      settings={settings}
                      engineStatus={engineStatus}
                      onOpenSettings={() => setIsSettingsOpen(true)}
                      drafts={drafts}
                      onSaveDraft={() => handleSaveDraft(formData)}
                      onDeleteDraft={handleDeleteDraft}
                      onRunAllDrafts={handleRunAllDrafts}
                      onRunSingleDraft={async (draft) => {
                        setFormData(draft);
                        lastFormDataRef.current = draft;
                        await handleDeleteDraft(draft.id);
                        runGeneratePipeline(null, draft);
                      }}
                      isAutoRunningDrafts={isAutoRunningDrafts}
                    />
                  </div>
                )}

                {activeStep >= 2 && (
                  <div className="animate-in fade-in zoom-in-95 duration-500 space-y-6">
                    <ProgressCard
                      progressState={progressState}
                      onRetry={handleRetry}
                      onStopAutoRetry={handleStopCurrentAutoRetry}
                      isLoading={isLoading}
                    />

                    {result && result.jobId && !isCompleted && (
                      <ErrorBoundary>
                        <VoiceoverUploader
                          jobId={result.jobId}
                          result={result}
                          settings={settings}
                          voiceoverScript={result.voiceoverScript}
                          aiStudioPrompt={result.aiStudioPrompt}
                          onUploadSuccess={handleVoiceoverUploadSuccess}
                          isUploading={isUploading}
                          setIsUploading={setIsUploading}
                        />
                      </ErrorBoundary>
                    )}
                  </div>
                )}
              </div>

              {/* Right Column (Preview & Result) */}
              <div className="lg:col-span-5 space-y-6">
                <ErrorBoundary>
                  {result && activeStep >= 2 ? (
                    <div className="space-y-6 animate-in fade-in slide-in-from-right-8 duration-700">
                      <VideoPlayer result={result} />
                      {isCompleted && <CaptionCard result={result} />}
                    </div>
                  ) : (
                    <div className="glass-panel rounded-2xl p-8 text-center flex flex-col items-center justify-center min-h-[480px] border-dashed border-slate-800 opacity-60">
                      <div className="w-16 h-16 rounded-2xl bg-gradient-to-tr from-shopee-500/20 via-orange-500/20 to-amber-500/20 border border-shopee-500/30 flex items-center justify-center text-shopee-500 mb-4 shadow-xl">
                        <Clapperboard className="w-8 h-8 stroke-[1.75]" />
                      </div>
                      <h3 className="text-lg font-bold text-white mb-2">Area Pratinjau Video</h3>
                      <p className="text-xs text-slate-400 max-w-sm leading-relaxed mb-6">
                        Mulai proses di sebelah kiri. Video hasil potongan AI dan subtitle akan muncul di sini setelah selesai.
                      </p>
                    </div>
                  )}
                </ErrorBoundary>
              </div>

            </div>
          </div>
        )}

        {activeView === 'auto' && (
          <div className="max-w-5xl mx-auto animate-in fade-in slide-in-from-bottom-4 duration-300">
            <AutoModePanel
              settings={settings}
              onHistoryRefresh={() => setHistoryRefreshSignal((value) => value + 1)}
            />
          </div>
        )}

        {activeView === 'history' && (
          <div className="max-w-6xl mx-auto animate-in fade-in slide-in-from-bottom-4 duration-300">
            <JobHistoryPanel
              onSelectJob={handleSelectJob}
              onRetryJob={handleRetryJob}
              currentJobId={lastJobIdRef.current}
              refreshSignal={historyRefreshSignal}
              settings={settings}
            />
          </div>
        )}
      </main>

      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        settings={settings}
        setSettings={setSettings}
        engineStatus={engineStatus}
      />

      <footer className="border-t border-slate-800/60 py-4 bg-slate-950/40 text-center text-xs text-slate-500">
        <p>Local AI Affiliate Clipper &bull; React + Node.js + FFmpeg &bull; Qwen & Gemini (Manual Switch) &bull; 2-Stage Ad Advisor Pipeline</p>
      </footer>
    </div>
  );
}
