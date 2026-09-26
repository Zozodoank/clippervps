import React, { useState, useRef, useEffect } from 'react';
import {
  Upload,
  Music,
  Sparkles,
  CheckCircle2,
  RefreshCw,
  Loader2,
  FileAudio,
  FileText,
  ChevronDown,
  ChevronUp,
  Volume2,
  Check
} from 'lucide-react';

export default function VoiceoverUploader({
  jobId,
  result,
  settings,
  voiceoverScript,
  aiStudioPrompt,
  onUploadSuccess,
  isUploading,
  setIsUploading,
}) {
  const [selectedFile, setSelectedFile] = useState(null);
  const [dragActive, setDragActive] = useState(false);
  const [editableScript, setEditableScript] = useState('');
  const [showManualUpload, setShowManualUpload] = useState(false);
  const [isGeneratingTTS, setIsGeneratingTTS] = useState(false);
  const [ttsSuccessMsg, setTtsSuccessMsg] = useState(false);
  const fileInputRef = useRef(null);

  // Initialize editable script with the exact Speaker 1 dialogue matching Kotak 3
  useEffect(() => {
    let initialText = '';
    if (result?.cleanScript) {
      initialText = result.cleanScript;
    } else if (aiStudioPrompt && typeof aiStudioPrompt === 'string') {
      const match = aiStudioPrompt.match(/(?:Speaker\s*\d*(?:\s*-[^\n\r:]+)?|SPEAKER\s*\d*)[\s\r\n:]+([\s\S]*)$/i);
      if (match && match[1].trim()) {
        initialText = match[1].trim();
      }
    }
    if (!initialText && voiceoverScript) {
      initialText = voiceoverScript;
    }
    if (initialText) {
      setEditableScript(initialText);
    }
  }, [aiStudioPrompt, voiceoverScript, result]);

  const hasAudioAlready = Boolean(result?.voiceoverAudioUrl || result?.hasFinalVideo || result?.stage === 'completed');

  // 1. One-click Automatic Voiceover Generator (Gemini Flash TTS / Edge-TTS)
  const handleAutoGenerateTTS = async () => {
    if (!editableScript || !editableScript.trim()) {
      alert('Naskah voiceover tidak boleh kosong.');
      return;
    }

    setIsGeneratingTTS(true);
    setTtsSuccessMsg(false);

    try {
      const response = await fetch('/api/regenerate-voiceover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jobId,
          customScript: editableScript.trim(),
          ttsProvider: settings?.ttsProvider,
          ttsModel: settings?.ttsModel,
          ttsFallbackModel: settings?.ttsFallbackModel,
          ttsVoice: settings?.ttsVoice,
          apiKey: settings?.geminiApiKey,
        }),
      });

      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.error || 'Gagal menghasilkan voiceover otomatis.');
      }

      setTtsSuccessMsg(true);
      setTimeout(() => setTtsSuccessMsg(false), 4000);
      onUploadSuccess(data);
    } catch (err) {
      console.error('TTS Generation failed:', err);
      alert(`Gagal membuat voiceover otomatis: ${err.message}`);
    } finally {
      setIsGeneratingTTS(false);
    }
  };

  // 2. Manual Audio File Upload
  const handleDrag = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setDragActive(true);
    } else if (e.type === 'dragleave') {
      setDragActive(false);
    }
  };

  const handleDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      const file = e.dataTransfer.files[0];
      if (file.type.includes('audio') || file.name.match(/\.(mp3|wav|m4a|aac|ogg)$/i)) {
        setSelectedFile(file);
      } else {
        alert('Format audio harus .mp3, .wav, atau .m4a');
      }
    }
  };

  const handleFileSelect = (e) => {
    if (e.target.files && e.target.files[0]) {
      const file = e.target.files[0];
      if (file.type.includes('audio') || file.name.match(/\.(mp3|wav|m4a|aac|ogg)$/i)) {
        setSelectedFile(file);
      } else {
        alert('Format audio harus .mp3, .wav, atau .m4a');
      }
    }
  };

  const handleUploadAudio = async () => {
    if (!selectedFile) return;

    setIsUploading(true);
    const formData = new FormData();
    formData.append('voiceover', selectedFile);
    formData.append('jobId', jobId);
    if (editableScript.trim()) {
      formData.append('customScript', editableScript.trim());
    }

    try {
      const response = await fetch('/api/upload-voiceover', {
        method: 'POST',
        body: formData,
      });

      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.error || 'Failed to merge voiceover audio.');
      }

      onUploadSuccess(data);
    } catch (err) {
      console.error('Upload failed:', err);
      alert(`Gagal memproses voiceover: ${err.message}`);
    } finally {
      setIsUploading(false);
    }
  };

  const activeTtsProvider = result?.ttsProvider || settings?.ttsProvider || 'gemini_tts';
  const isGemini = activeTtsProvider === 'gemini_tts';
  const displayVoice = result?.ttsVoice || settings?.ttsVoice || (isGemini ? 'Despina (Gemini Flash)' : 'Gadis (Edge-TTS Neural)');
  const providerBadge = isGemini ? 'Gemini Flash TTS' : 'Edge-TTS Neural';

  return (
    <div className="glass-panel-glow rounded-2xl p-6 shadow-xl border-emerald-500/30 relative overflow-hidden">
      {/* Decorative Blur */}
      <div className="absolute top-0 right-0 -mr-16 -mt-16 w-40 h-40 bg-emerald-500/10 rounded-full blur-3xl pointer-events-none" />

      {/* Header */}
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <div className="flex items-center gap-2.5">
          <div className={`w-8 h-8 rounded-lg flex items-center justify-center border ${
            isGemini ? 'bg-blue-500/20 border-blue-500/30 text-blue-400' : 'bg-emerald-500/20 border-emerald-500/30 text-emerald-400'
          }`}>
            <Volume2 className="w-4 h-4" />
          </div>
          <div>
            <h3 className="text-base font-bold text-white flex items-center gap-2">
              <span>Voiceover AI Otomatis</span>
              <span className={`text-[10px] uppercase font-bold px-2 py-0.5 rounded-full border ${
                isGemini
                  ? 'bg-blue-500/20 text-blue-300 border-blue-500/30'
                  : 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30'
              }`}>
                {providerBadge}
              </span>
            </h3>
            <p className="text-xs text-slate-400">
              {hasAudioAlready
                ? `Suara narasi ${displayVoice} sudah otomatis terpasang & subtitle tersinkron.`
                : `Suara narasi ${displayVoice} otomatis disintesis via ${providerBadge} & disinkronkan ke video 9:16.`}
            </p>
          </div>
        </div>

        {hasAudioAlready && (
          <div className="flex items-center gap-1 text-xs font-semibold text-emerald-400 bg-emerald-950/40 px-3 py-1.5 rounded-lg border border-emerald-800/60">
            <CheckCircle2 className="w-3.5 h-3.5" />
            <span>Voiceover Aktif</span>
          </div>
        )}
      </div>

      {/* Audio Player Preview if Audio Exists */}
      {result?.voiceoverAudioUrl && (
        <div className="mb-4 p-3.5 rounded-xl bg-slate-900/90 border border-slate-800 space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="font-semibold text-slate-300 flex items-center gap-1.5">
              <Music className="w-3.5 h-3.5 text-emerald-400" />
              <span>Preview Suara: <strong className={isGemini ? 'text-blue-300' : 'text-emerald-300'}>{displayVoice}</strong></span>
            </span>
            <span className="text-[11px] text-slate-500 font-mono">Audio Sinkron 9:16</span>
          </div>
          <audio
            controls
            src={result.voiceoverAudioUrl}
            className="w-full h-8 rounded-lg outline-none"
          />
        </div>
      )}

      {/* Editable Naskah Section */}
      <div className="mb-4 rounded-xl bg-slate-950/80 border border-slate-800 p-3.5 space-y-2">
        <label className="block text-xs font-semibold text-slate-300 flex items-center justify-between">
          <span className="flex items-center gap-1.5">
            <FileText className="w-3.5 h-3.5 text-indigo-400" />
            <span>Naskah Narasi Suara (Speaker 1):</span>
          </span>
          <span className="text-[11px] font-normal text-slate-400">
            Edit kata-kata jika ingin penyesuaian
          </span>
        </label>
        <textarea
          value={editableScript}
          onChange={(e) => setEditableScript(e.target.value)}
          rows={3}
          placeholder="Naskah narasi Indonesia..."
          className="w-full bg-slate-900 border border-slate-800 rounded-lg p-3 text-xs text-slate-100 font-sans leading-relaxed focus:outline-none focus:ring-1 focus:ring-emerald-500/50 resize-y"
        />

        {/* Action Button: Regenerate / Generate TTS */}
        <button
          type="button"
          onClick={handleAutoGenerateTTS}
          disabled={isGeneratingTTS || isUploading}
          className={`w-full py-3 rounded-xl font-bold text-xs sm:text-sm flex items-center justify-center gap-2 transition-all shadow-lg ${
            isGeneratingTTS || isUploading
              ? 'bg-slate-800 text-slate-500 cursor-not-allowed border border-slate-700'
              : isGemini
              ? 'bg-gradient-to-r from-blue-600 via-indigo-600 to-blue-500 hover:from-blue-500 hover:to-indigo-400 text-white shadow-blue-500/20 hover:scale-[1.01] active:scale-[0.99]'
              : 'bg-gradient-to-r from-emerald-600 via-teal-600 to-emerald-500 hover:from-emerald-500 hover:to-teal-400 text-white shadow-emerald-500/20 hover:scale-[1.01] active:scale-[0.99]'
          }`}
        >
          {isGeneratingTTS ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              <span>Menghasilkan Voiceover ({providerBadge})...</span>
            </>
          ) : (
            <>
              <Sparkles className="w-4 h-4" />
              <span>Generate Ulang Suara ({displayVoice}) &amp; Render Video</span>
            </>
          )}
        </button>

        {ttsSuccessMsg && (
          <div className="flex items-center justify-center gap-1.5 text-xs text-emerald-400 font-medium py-1">
            <Check className="w-3.5 h-3.5" />
            <span>Voiceover & Subtitle berhasil diperbarui otomatis!</span>
          </div>
        )}
      </div>

      {/* Accordion: Optional Manual Audio Upload */}
      <div className="pt-1 border-t border-slate-800/80">
        <button
          type="button"
          onClick={() => setShowManualUpload(!showManualUpload)}
          className="w-full flex items-center justify-between text-xs text-slate-400 hover:text-slate-300 py-1 transition-colors"
        >
          <span className="flex items-center gap-1.5">
            <Upload className="w-3.5 h-3.5" />
            <span>Opsi Tambahan: Upload File Audio Sendiri (.mp3/.wav)</span>
          </span>
          {showManualUpload ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
        </button>

        {showManualUpload && (
          <div className="mt-3 space-y-3">
            <div
              onDragEnter={handleDrag}
              onDragLeave={handleDrag}
              onDragOver={handleDrag}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              className={`p-5 rounded-xl border-2 border-dashed cursor-pointer transition-all text-center flex flex-col items-center justify-center ${
                dragActive
                  ? 'border-emerald-500 bg-emerald-500/10'
                  : selectedFile
                  ? 'border-emerald-500/60 bg-emerald-950/20'
                  : 'border-slate-800 hover:border-slate-700 bg-slate-950/60'
              }`}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept="audio/*,.mp3,.wav,.m4a"
                onChange={handleChange}
                className="hidden"
              />

              {selectedFile ? (
                <div className="flex items-center gap-3 text-emerald-300">
                  <FileAudio className="w-7 h-7 text-emerald-400 flex-shrink-0" />
                  <div className="text-left">
                    <p className="font-bold text-xs text-white">{selectedFile.name}</p>
                    <p className="text-[10px] text-slate-400">
                      {(selectedFile.size / 1024 / 1024).toFixed(2)} MB &bull; Siap digabungkan
                    </p>
                  </div>
                </div>
              ) : (
                <div>
                  <Upload className="w-6 h-6 text-slate-500 mx-auto mb-1.5" />
                  <p className="text-xs font-medium text-slate-300">
                    Klik atau drag & drop audio custom Anda
                  </p>
                  <p className="text-[10px] text-slate-500 mt-0.5">
                    Hanya gunakan jika Anda tidak ingin menggunakan suara AI bawaan
                  </p>
                </div>
              )}
            </div>

            {selectedFile && (
              <button
                type="button"
                onClick={handleManualUpload}
                disabled={isUploading}
                className="w-full py-2.5 rounded-xl font-bold text-xs bg-slate-800 hover:bg-slate-700 text-white border border-slate-700 transition-all flex items-center justify-center gap-2"
              >
                {isUploading ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    <span>Membakar Audio Manual...</span>
                  </>
                ) : (
                  <>
                    <Sparkles className="w-3.5 h-3.5" />
                    <span>Gunakan Audio Manual Ini</span>
                  </>
                )}
              </button>
            )}
          </div>
        )}
      </div>

    </div>
  );
}
