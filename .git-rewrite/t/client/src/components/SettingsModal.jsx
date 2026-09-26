import React from 'react';
import { X, Shield, Sliders, Volume2, Film, RefreshCw, Check, Bot, Sparkles, Layers } from 'lucide-react';

export default function SettingsModal({ isOpen, onClose, settings, setSettings, engineStatus }) {
  if (!isOpen) return null;

  const currentProvider = settings.aiProvider || engineStatus?.activeAiEngine || 'gemini';

  const resetDefaults = () => {
    setSettings({
      aiProvider: engineStatus?.activeAiEngine || 'gemini',
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
  };

  const isGeminiReady = Boolean(engineStatus?.geminiKeyConfigured);
  const isOpenRouterReady = Boolean(engineStatus?.openRouterKeyConfigured);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-in fade-in duration-200">
      
      <div className="bg-slate-900 border border-slate-700/80 rounded-2xl max-w-lg w-full shadow-2xl overflow-hidden">
        
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Sliders className="w-5 h-5 text-shopee-500" />
            <h3 className="font-bold text-white text-base">Pipeline &amp; AI Engine Settings</h3>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-5 text-sm max-h-[80vh] overflow-y-auto">
          
          {/* AI Engine Selection */}
          <div className="p-4 rounded-xl bg-slate-950/70 border border-slate-800 space-y-3">
            <div className="flex items-center justify-between">
              <span className="font-semibold text-slate-200 flex items-center gap-1.5 text-sm">
                <Bot className="w-4 h-4 text-emerald-400" />
                <span>Mesin AI Vision &amp; Scripting</span>
              </span>
              <span className="text-[10px] text-emerald-400 font-mono bg-emerald-500/10 px-2 py-0.5 rounded-full border border-emerald-500/20">
                Pilih Engine Aktif
              </span>
            </div>

            <div className="grid grid-cols-1 gap-2.5 pt-1">
              
              {/* Option 1: Pola Gemini File API + Gemini (DEFAULT) */}
              <div
                onClick={() => setSettings({ ...settings, aiProvider: 'gemini' })}
                className={`p-3.5 rounded-xl border text-left cursor-pointer transition-all relative ${
                  currentProvider === 'gemini'
                    ? 'bg-blue-950/40 border-blue-500 text-white shadow-lg shadow-blue-950/50 ring-1 ring-blue-500/50'
                    : 'bg-slate-900/60 border-slate-800 text-slate-300 hover:border-slate-700 hover:bg-slate-850'
                }`}
              >
                <div className="flex items-center justify-between mb-1.5">
                  <span className="font-bold text-xs flex items-center gap-1.5 text-blue-300">
                    <Sparkles className="w-3.5 h-3.5 text-blue-400" />
                    Pola Gemini File API + Gemini
                  </span>
                  <div className="flex items-center gap-1">
                    <span className="text-[9px] font-bold px-1.5 py-0.5 rounded border bg-blue-500/20 text-blue-300 border-blue-500/40">
                      DEFAULT
                    </span>
                    <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded border ${
                      isGeminiReady
                        ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30'
                        : 'bg-amber-500/20 text-amber-300 border-amber-500/30'
                    }`}>
                      {isGeminiReady ? 'READY IN .ENV' : 'MISSING KEY'}
                    </span>
                    {currentProvider === 'gemini' && (
                      <span className="text-[9px] font-bold px-1.5 py-0.5 rounded border bg-emerald-500/20 text-emerald-300 border-emerald-500/30 flex items-center gap-0.5">
                        <Check className="w-2.5 h-2.5" /> ACTIVE
                      </span>
                    )}
                  </div>
                </div>
                <div className="text-[11px] font-mono font-semibold mb-1 text-blue-200/90">
                  Gemini File API (Analisa Video) + Gemini Direct (Script, Caption &amp; Hashtag)
                </div>
                <p className="text-[10px] leading-relaxed text-slate-400">
                  Analisa video langsung menggunakan Google Gemini File API (stream/file) dan pembuatan naskah voiceover, caption, serta hashtag via model Gemini Direct. Pilihan default utama: cepat, akurat, hemat bandwidth, dan tanpa cross-fallback.
                </p>
                {currentProvider === 'gemini' && (
                  <div className="absolute top-2 right-2 w-2 h-2 rounded-full bg-blue-400 animate-ping" />
                )}
              </div>

              {/* Option 2: Pola FFmpeg + OpenRouter (Manual - BUKAN Fallback) */}
              <div
                onClick={() => setSettings({ ...settings, aiProvider: 'openrouter' })}
                className={`p-3.5 rounded-xl border text-left cursor-pointer transition-all relative ${
                  currentProvider === 'openrouter'
                    ? 'bg-emerald-950/40 border-emerald-500 text-white shadow-lg shadow-emerald-950/50 ring-1 ring-emerald-500/50'
                    : 'bg-slate-900/60 border-slate-800 text-slate-300 hover:border-slate-700 hover:bg-slate-850'
                }`}
              >
                <div className="flex items-center justify-between mb-1.5">
                  <span className="font-bold text-xs flex items-center gap-1.5 text-emerald-300">
                    <Sparkles className="w-3.5 h-3.5 text-emerald-400" />
                    Pola FFmpeg + OpenRouter
                  </span>
                  <div className="flex items-center gap-1">
                    <span className="text-[9px] font-bold px-1.5 py-0.5 rounded border bg-slate-800 text-slate-300 border-slate-700">
                      MANUAL (BUKAN FALLBACK)
                    </span>
                    <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded border ${
                      isOpenRouterReady
                        ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30'
                        : 'bg-amber-500/20 text-amber-300 border-amber-500/30'
                    }`}>
                      {isOpenRouterReady ? 'READY IN .ENV' : 'MISSING KEY'}
                    </span>
                    {currentProvider === 'openrouter' && (
                      <span className="text-[9px] font-bold px-1.5 py-0.5 rounded border bg-emerald-500/20 text-emerald-300 border-emerald-500/30 flex items-center gap-0.5">
                        <Check className="w-2.5 h-2.5" /> ACTIVE
                      </span>
                    )}
                  </div>
                </div>
                <div className="text-[11px] font-mono font-semibold mb-1 text-emerald-200/90">
                  FFmpeg Frame Extraction (Analisa Video) + OpenRouter Free (Script, Caption &amp; Hashtag)
                </div>
                <p className="text-[10px] leading-relaxed text-slate-400">
                  Analisa video melalui ekstraksi frame berkala via FFmpeg dan pembuatan naskah voiceover, caption, serta hashtag via model OpenRouter Free (:free). Hanya aktif jika Anda pilih secara manual (bukan fallback otomatis).
                </p>
                {currentProvider === 'openrouter' && (
                  <div className="absolute top-2 right-2 w-2 h-2 rounded-full bg-emerald-400 animate-ping" />
                )}
              </div>

            </div>

            <p className="text-[11px] text-slate-400 pt-1">
              💡 <em>Kunci API dapat disetel di berkas <code className="text-slate-300 font-mono">server/.env</code> (<code className="text-slate-300">GEMINI_API_KEY</code> atau <code className="text-slate-300">OPENROUTER_API_KEY</code>).</em>
            </p>
          </div>

          {/* Voiceover TTS Engine Configuration */}
          <div className="p-4 rounded-xl bg-slate-950/70 border border-slate-800 space-y-4">
            <div className="flex items-center justify-between">
              <span className="font-semibold text-slate-200 flex items-center gap-1.5 text-sm">
                <Volume2 className="w-4 h-4 text-emerald-400" />
                <span>Mesin Voiceover (Text-to-Speech)</span>
              </span>
              <span className={`text-[10px] font-mono px-2 py-0.5 rounded-full border ${
                (settings.ttsProvider || 'gemini_tts') === 'gemini_tts'
                  ? 'text-blue-400 bg-blue-500/10 border-blue-500/30'
                  : 'text-emerald-400 bg-emerald-500/10 border-emerald-500/30'
              }`}>
                {(settings.ttsProvider || 'gemini_tts') === 'gemini_tts' ? 'Gemini Flash TTS' : 'Edge-TTS'}
              </span>
            </div>

            {/* Provider Options */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              {/* Option 1: Google Gemini Flash TTS (Default) */}
              <div
                onClick={() => setSettings({ ...settings, ttsProvider: 'gemini_tts' })}
                className={`p-3 rounded-xl border text-left cursor-pointer transition-all relative ${
                  (settings.ttsProvider || 'gemini_tts') === 'gemini_tts'
                    ? 'bg-blue-950/40 border-blue-500 text-white shadow-lg shadow-blue-950/50 ring-1 ring-blue-500/50'
                    : 'bg-slate-900/60 border-slate-800 text-slate-300 hover:border-slate-700 hover:bg-slate-850'
                }`}
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="font-bold text-xs flex items-center gap-1.5">
                    <Sparkles className="w-3.5 h-3.5 text-blue-400" />
                    Google Gemini TTS
                  </span>
                  <span className="text-[9px] font-bold px-1.5 py-0.5 rounded border bg-blue-500/20 text-blue-300 border-blue-500/30">
                    DEFAULT
                  </span>
                </div>
                <div className="text-[11px] font-mono font-semibold mb-1 text-blue-300">
                  {settings.ttsModel || 'gemini-3.1-flash-tts-preview'}
                </div>
                <p className="text-[10px] leading-tight text-slate-400">
                  Free Tier (10 RPD) dengan suara natural studio Google. Fallback otomatis ke model Gemini cadangan (bukan Edge TTS).
                </p>
                {(settings.ttsProvider || 'gemini_tts') === 'gemini_tts' && (
                  <div className="absolute top-2 right-2 w-2 h-2 rounded-full bg-blue-400 animate-ping" />
                )}
              </div>

              {/* Option 2: Microsoft Edge TTS */}
              <div
                onClick={() => setSettings({ ...settings, ttsProvider: 'edge_tts' })}
                className={`p-3 rounded-xl border text-left cursor-pointer transition-all relative ${
                  (settings.ttsProvider || 'gemini_tts') === 'edge_tts'
                    ? 'bg-emerald-950/40 border-emerald-500 text-white shadow-lg shadow-emerald-950/50 ring-1 ring-emerald-500/50'
                    : 'bg-slate-900/60 border-slate-800 text-slate-300 hover:border-slate-700 hover:bg-slate-850'
                }`}
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="font-bold text-xs flex items-center gap-1.5">
                    <Volume2 className="w-3.5 h-3.5 text-emerald-400" />
                    Microsoft Edge TTS
                  </span>
                  <span className="text-[9px] font-bold px-1.5 py-0.5 rounded border bg-emerald-500/20 text-emerald-300 border-emerald-500/30">
                    MANUAL ONLY
                  </span>
                </div>
                <div className="text-[11px] font-mono font-semibold mb-1 text-emerald-300">
                  id-ID-GadisNeural
                </div>
                <p className="text-[10px] leading-tight text-slate-400">
                  Bebas batas kuota harian (unmetered). Hanya aktif bila Anda memilih opsi ini (bukan fallback otomatis).
                </p>
                {(settings.ttsProvider || 'gemini_tts') === 'edge_tts' && (
                  <div className="absolute top-2 right-2 w-2 h-2 rounded-full bg-emerald-400 animate-ping" />
                )}
              </div>
            </div>

            {/* Detailed Gemini TTS Controls */}
            {(settings.ttsProvider || 'gemini_tts') === 'gemini_tts' && (
              <div className="p-3 bg-slate-900/80 border border-slate-800 rounded-xl space-y-3">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {/* Primary Model */}
                  <div>
                    <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                      Model Utama (Primary):
                    </label>
                    <select
                      value={settings.ttsModel || 'gemini-3.1-flash-tts-preview'}
                      onChange={(e) => setSettings({ ...settings, ttsModel: e.target.value })}
                      className="w-full bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-white focus:border-blue-500 focus:outline-none"
                    >
                      <option value="gemini-3.1-flash-tts-preview">gemini-3.1-flash-tts-preview (Default)</option>
                      <option value="gemini-2.5-flash-preview-tts">gemini-2.5-flash-preview-tts</option>
                    </select>
                  </div>

                  {/* Fallback Model */}
                  <div>
                    <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                      Model Cadangan (Fallback):
                    </label>
                    <select
                      value={settings.ttsFallbackModel || 'gemini-2.5-flash-preview-tts'}
                      onChange={(e) => setSettings({ ...settings, ttsFallbackModel: e.target.value })}
                      className="w-full bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-white focus:border-blue-500 focus:outline-none"
                    >
                      <option value="gemini-2.5-flash-preview-tts">gemini-2.5-flash-preview-tts (Default Fallback)</option>
                      <option value="gemini-3.1-flash-tts-preview">gemini-3.1-flash-tts-preview</option>
                    </select>
                  </div>
                </div>

                {/* Voice Selector */}
                <div>
                  <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                    Karakter Suara Gemini (Voice ID):
                  </label>
                  <div className="flex items-center justify-between p-2.5 bg-slate-950 border border-blue-500/50 rounded-lg">
                    <div className="flex items-center gap-2">
                      <span className="w-2.5 h-2.5 rounded-full bg-blue-400 animate-pulse" />
                      <span className="font-bold text-xs text-white">Despina</span>
                    </div>
                    <span className="text-[10px] text-blue-300 bg-blue-500/20 px-2 py-0.5 rounded border border-blue-500/30 font-medium">
                      Female • Suara Utama Gemini Flash TTS
                    </span>
                  </div>
                  <p className="text-[10px] text-slate-400 mt-1">
                    Karakter suara Gemini Flash TTS yang digunakan adalah <strong>Despina</strong> (Natural &amp; Jernih).
                  </p>
                </div>

                <div className="p-2 bg-blue-950/30 border border-blue-800/40 rounded-lg text-[10px] text-blue-300/90 leading-relaxed">
                  🛡️ <strong>Info Kuota Free Tier:</strong> Google Gemini Flash TTS dibatasi <strong>10 RPD</strong> per API key. Sesuai preferensi Anda, jika kuota harian habis, sistem <em>tidak akan</em> mengalihkan (fallback) secara otomatis ke Edge TTS.
                </div>
              </div>
            )}

            {/* Edge TTS Notice */}
            {(settings.ttsProvider || 'gemini_tts') === 'edge_tts' && (
              <div className="p-2.5 bg-emerald-950/30 border border-emerald-800/40 rounded-lg text-[11px] text-emerald-300/90 leading-relaxed">
                🎙️ <strong>Edge TTS Aktif:</strong> Menggunakan suara <code className="text-white font-bold">id-ID-GadisNeural</code>. Bebas kuota harian. Opsi ini aktif karena dipilih secara eksplisit.
              </div>
            )}
          </div>

          {/* Scene Duration / Pacing - Shopee FYP Formula */}
          <div className="p-3.5 rounded-xl bg-slate-950/60 border border-slate-800 space-y-2.5">
            <div className="flex items-center justify-between">
              <span className="font-semibold text-slate-200 flex items-center gap-1.5">
                <Sparkles className="w-4 h-4 text-amber-400" />
                <span>Pacing Adegan (Shopee FYP Formula)</span>
              </span>
              <span className="font-mono text-xs font-bold text-amber-400 px-2 py-0.5 bg-slate-800 rounded">
                {(settings.sceneDuration || 3.3)}s / scene
              </span>
            </div>
            <p className="text-xs text-slate-400">
              Tempo cepat 3 - 3.5 detik per scene memaksimalkan retensi (completion rate) audiens Shopee untuk menembus batas 200 views.
            </p>
            <div className="grid grid-cols-3 gap-2 pt-1">
              {[
                { value: 3.3, label: '3.3s (FYP Formula)', badge: 'Recommended' },
                { value: 3.0, label: '3.0s (Ultra Fast)', badge: '~21s' },
                { value: 5.0, label: '5.0s (Klasik)', badge: '~35s' }
              ].map((item) => {
                const isSelected = (settings.sceneDuration || 3.3) === item.value;
                return (
                  <button
                    key={item.value}
                    type="button"
                    onClick={() => setSettings({ ...settings, sceneDuration: item.value })}
                    className={`py-2 px-2.5 rounded-xl text-left border transition-all flex flex-col justify-between ${
                      isSelected
                        ? 'bg-shopee-500/20 border-shopee-500 text-white shadow-md shadow-shopee-500/20 ring-1 ring-shopee-500/50'
                        : 'bg-slate-900 border-slate-800 text-slate-300 hover:bg-slate-800'
                    }`}
                  >
                    <span className="text-xs font-bold">{item.label}</span>
                    <span className="text-[10px] text-amber-400 font-mono mt-0.5">{item.badge}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Video Framing & Anti-Crop Mode */}
          <div className="p-3.5 rounded-xl bg-slate-950/60 border border-slate-800 space-y-2.5">
            <div className="flex items-center justify-between">
              <span className="font-semibold text-slate-200 flex items-center gap-1.5">
                <Layers className="w-4 h-4 text-emerald-400" />
                <span>Format Framing Video (Anti-Crop & Watermark)</span>
              </span>
              <span className="font-mono text-xs font-bold text-emerald-400 px-2 py-0.5 bg-slate-800 rounded">
                {(settings.renderMode || 'stage_80') === 'stage_80'
                  ? 'Stage 80% (Blur)'
                  : (settings.renderMode || 'stage_80') === 'fit_canvas'
                  ? 'Fit 16:9'
                  : (settings.renderMode || 'stage_80') === 'vertical_crop'
                  ? 'Full 9:16'
                  : 'Stage 1:1'}
              </span>
            </div>
            <p className="text-xs text-slate-400">
              Mengontrol rasio video. <strong>Stage 80%</strong> memperluas bidang crop dengan blur atas-bawah dan memotong bersih watermark pojok kreator tanpa memotong produk.
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-1">
              {[
                { value: 'stage_80', label: 'Stage 80%', badge: 'Blur Atas Bawah (Rekomendasi)' },
                { value: 'square_stage', label: 'Stage 1:1', badge: 'Square Blur' },
                { value: 'fit_canvas', label: 'Fit 16:9 Utuh', badge: 'No Crop' },
                { value: 'vertical_crop', label: 'Full 9:16', badge: 'Zoom Crop' }
              ].map((item) => {
                const isSelected = (settings.renderMode || 'stage_80') === item.value;
                return (
                  <button
                    key={item.value}
                    type="button"
                    onClick={() => setSettings({ ...settings, renderMode: item.value })}
                    className={`py-2 px-2.5 rounded-xl text-left border transition-all flex flex-col justify-between ${
                      isSelected
                        ? 'bg-emerald-500/20 border-emerald-500 text-white shadow-md shadow-emerald-500/20 ring-1 ring-emerald-500/50'
                        : 'bg-slate-900 border-slate-800 text-slate-300 hover:bg-slate-800'
                    }`}
                  >
                    <span className="text-xs font-bold">{item.label}</span>
                    <span className="text-[10px] text-emerald-400 font-mono mt-0.5">{item.badge}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Horizontal Flip Filter */}
          <div className="flex items-center justify-between p-3.5 rounded-xl bg-slate-950/60 border border-slate-800">
            <div>
              <div className="font-semibold text-slate-200 flex items-center gap-1.5">
                <Film className="w-4 h-4 text-shopee-500" />
                <span>Horizontal Flip (hflip)</span>
              </div>
              <p className="text-xs text-slate-400 mt-0.5">
                Reverses frame orientation for anti-detection. (Otomatis dinonaktifkan AI jika produk memiliki merek/logo).
              </p>
            </div>
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                checked={settings.hflip}
                onChange={(e) => setSettings({ ...settings, hflip: e.target.checked })}
                className="sr-only peer"
              />
              <div className="w-11 h-6 bg-slate-800 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-shopee-500"></div>
            </label>
          </div>

          {/* Speed Multiplier */}
          <div className="p-3.5 rounded-xl bg-slate-950/60 border border-slate-800 space-y-2">
            <div className="flex items-center justify-between">
              <span className="font-semibold text-slate-200">Video Speed Multiplier</span>
              <span className="font-mono text-xs font-bold text-amber-400 px-2 py-0.5 bg-slate-800 rounded">
                {settings.speedMultiplier}x ({Math.round((1 / settings.speedMultiplier) * 100) / 100} PTS)
              </span>
            </div>
            <p className="text-xs text-slate-400">
              Keep 1.00x for precise product shots. Higher speeds are optional.
            </p>
            <div className="grid grid-cols-4 gap-2 pt-1">
              {[1.00, 1.03, 1.05, 1.08].map((spd) => (
                <button
                  key={spd}
                  type="button"
                  onClick={() => setSettings({ ...settings, speedMultiplier: spd })}
                  className={`py-1.5 rounded-lg text-xs font-mono font-semibold border transition-all ${
                    settings.speedMultiplier === spd
                      ? 'bg-shopee-500 border-shopee-500 text-white shadow-md shadow-shopee-500/20'
                      : 'bg-slate-900 border-slate-700 text-slate-300 hover:bg-slate-800'
                  }`}
                >
                  {spd.toFixed(2)}x
                </button>
              ))}
            </div>
          </div>

          {/* Optional Burn Subtitles */}
          <div className="flex items-center justify-between p-3.5 rounded-xl bg-slate-950/60 border border-slate-800">
            <div>
              <div className="font-semibold text-slate-200 flex items-center gap-1.5">
                <span>Burn Subtitles 2-Warna (Kuning &amp; Putih)</span>
              </div>
              <p className="text-xs text-slate-400 mt-0.5">
                Membakar subtitle kontras tinggi (kuning Shopee &amp; putih) dengan outline tebal agar video tetap menjual saat ditonton tanpa suara (mute mode).
              </p>
            </div>
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                checked={settings.enableSubtitles}
                onChange={(e) => setSettings({ ...settings, enableSubtitles: e.target.checked })}
                className="sr-only peer"
              />
              <div className="w-11 h-6 bg-slate-800 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-shopee-500"></div>
            </label>
          </div>

        </div>

        {/* Footer */}
        <div className="px-6 py-4 bg-slate-950/80 border-t border-slate-800 flex items-center justify-between">
          <button
            type="button"
            onClick={resetDefaults}
            className="text-xs text-slate-400 hover:text-slate-200 flex items-center gap-1 transition-colors"
          >
            <RefreshCw className="w-3 h-3" />
            <span>Reset to Defaults</span>
          </button>

          <button
            type="button"
            onClick={onClose}
            className="px-5 py-2 rounded-xl bg-shopee-500 hover:bg-shopee-600 text-white font-bold text-xs transition-colors shadow-md shadow-shopee-500/25"
          >
            Save &amp; Close
          </button>
        </div>

      </div>
    </div>
  );
}
