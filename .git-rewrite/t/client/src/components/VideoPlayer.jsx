import React, { useRef, useState } from 'react';
import { Download, Play, Pause, Volume2, VolumeX, Maximize2, Sparkles, Clock, Check, Folder, FolderOpen, Loader2, CheckCircle2 } from 'lucide-react';
import { copyToClipboardSafe } from '../utils/clipboard';

export default function VideoPlayer({ result }) {
  const videoRef = useRef(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [isCopiedPath, setIsCopiedPath] = useState(false);
  const [isOpeningFolder, setIsOpeningFolder] = useState(false);
  const [openFolderSuccess, setOpenFolderSuccess] = useState(false);

  if (!result) return null;

  const isFinal = result.stage === 'completed' || result.hasFinalVideo || !!result.finalFileName;
  const currentVideoUrl = result.videoUrl || result.finalVideoUrl || result.silentVideoUrl;
  const currentDownloadUrl = result.downloadUrl || result.finalVideoUrl || result.videoUrl || result.silentVideoUrl;
  const currentLocalPath = result.finalLocalPath || result.silentLocalPath || result.localPath;
  const currentFilename = result.finalFileName || result.silentFileName || result.filename || 'affiliate_clip.mp4';
  const highlightClips = Array.isArray(result.highlight?.clips) ? result.highlight.clips : [];

  const togglePlay = () => {
    if (!videoRef.current) return;
    if (videoRef.current.paused) {
      videoRef.current.play();
      setIsPlaying(true);
    } else {
      videoRef.current.pause();
      setIsPlaying(false);
    }
  };

  const toggleMute = () => {
    if (!videoRef.current) return;
    videoRef.current.muted = !videoRef.current.muted;
    setIsMuted(videoRef.current.muted);
  };

  const toggleFullscreen = () => {
    if (!videoRef.current) return;
    if (videoRef.current.requestFullscreen) {
      videoRef.current.requestFullscreen();
    }
  };

  const copyLocalPath = async () => {
    if (currentLocalPath) {
      await copyToClipboardSafe(currentLocalPath);
      setIsCopiedPath(true);
      setTimeout(() => setIsCopiedPath(false), 2000);
    }
  };

  const handleOpenFolder = async () => {
    setIsOpeningFolder(true);
    try {
      const res = await fetch('/api/open-folder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: currentFilename }),
      });
      if (res.ok) {
        setOpenFolderSuccess(true);
        setTimeout(() => setOpenFolderSuccess(false), 3000);
      } else {
        const data = await res.json();
        alert(`Tidak dapat membuka folder: ${data.error || 'Terjadi kesalahan'}`);
      }
    } catch (err) {
      console.warn('Error opening folder:', err);
      alert(`Gagal membuka folder di file explorer: ${err.message}`);
    } finally {
      setIsOpeningFolder(false);
    }
  };

  return (
    <div className="glass-panel rounded-2xl p-6 shadow-xl flex flex-col items-center">
      
      {/* Header */}
      <div className="w-full flex items-center justify-between mb-4 flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${
            isFinal
              ? 'bg-emerald-500/20 border border-emerald-500/30 text-emerald-400'
              : 'bg-orange-500/20 border border-orange-500/30 text-orange-400'
          }`}>
            {isFinal ? <CheckCircle2 className="w-4 h-4" /> : <Sparkles className="w-4 h-4" />}
          </div>
          <div>
            <h3 className="text-base font-bold text-white flex items-center gap-2">
              <span>{isFinal ? 'Video Final Siap Upload' : 'Preview 9:16 (Tanpa Suara)'}</span>
              <span className={`text-[10px] uppercase font-bold px-2 py-0.5 rounded-full ${
                isFinal
                  ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                  : 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
              }`}>
                {isFinal ? 'Subtitles Burned' : 'Stage 1 Output'}
              </span>
            </h3>
            <p className="text-xs text-slate-400 font-mono">
              {isFinal ? 'Voiceover + Subtitle aktif' : 'Menunggu upload voiceover di Tahap 2'}
            </p>
          </div>
        </div>

        {/* Timestamps & Brand badges */}
        {result.highlight && (
          <div className="flex flex-wrap items-center gap-1.5 ml-auto">
            {(result.hasProductBrand || result.highlight?.hasProductBrand) && (
              <span className="px-2.5 py-1 rounded-full bg-blue-500/20 border border-blue-500/30 text-blue-300 font-sans text-xs font-medium">
                🏷️ Merek: {result.detectedBrand && result.detectedBrand !== 'none' ? result.detectedBrand : (result.highlight?.detectedBrand && result.highlight?.detectedBrand !== 'none' ? result.highlight.detectedBrand : 'Terdeteksi')} (No Mirror)
              </span>
            )}
            <div className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-slate-800 border border-slate-700 text-xs font-mono text-amber-400">
              <Clock className="w-3.5 h-3.5" />
              <span>
                {highlightClips.length
                  ? `${highlightClips.length} x 5s`
                  : `${result.highlight.startTime} - ${result.highlight.endTime}`}
              </span>
              <span className="text-slate-500">({result.highlight.duration}s)</span>
            </div>
          </div>
        )}
      </div>

      {/* Video Container in 9:16 Portrait Frame */}
      <div className="relative w-full max-w-[320px] aspect-[9/16] bg-black rounded-3xl overflow-hidden border-4 border-slate-800 shadow-2xl shadow-black/80 group">
        
        <video
          key={currentVideoUrl}
          ref={videoRef}
          src={currentVideoUrl}
          playsInline
          loop
          onPlay={() => setIsPlaying(true)}
          onPause={() => setIsPlaying(false)}
          className="w-full h-full object-cover cursor-pointer"
          onClick={togglePlay}
        />

        {/* Play / Pause Center Overlay Button */}
        {!isPlaying && (
          <button
            onClick={togglePlay}
            className="absolute inset-0 m-auto w-16 h-16 rounded-full bg-black/60 backdrop-blur-sm border border-white/20 flex items-center justify-center text-white hover:scale-110 hover:bg-shopee-500 transition-all shadow-xl"
          >
            <Play className="w-7 h-7 fill-white translate-x-0.5" />
          </button>
        )}

        {/* Bottom Video Controls Bar */}
        <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/90 via-black/40 to-transparent p-4 flex items-center justify-between opacity-0 group-hover:opacity-100 transition-opacity">
          <div className="flex items-center gap-3">
            <button onClick={togglePlay} className="text-white hover:text-shopee-400 transition-colors">
              {isPlaying ? <Pause className="w-5 h-5" /> : <Play className="w-5 h-5" />}
            </button>
            <button onClick={toggleMute} className="text-white hover:text-shopee-400 transition-colors">
              {isMuted ? <VolumeX className="w-5 h-5" /> : <Volume2 className="w-5 h-5" />}
            </button>
          </div>

          <button onClick={toggleFullscreen} className="text-white hover:text-shopee-400 transition-colors">
            <Maximize2 className="w-4 h-4" />
          </button>
        </div>

        {/* Stage Status Badge Overlay */}
        <div className="absolute top-3 left-3 bg-slate-950/80 backdrop-blur-md border border-slate-700/60 text-slate-200 text-[10px] font-bold px-2.5 py-0.5 rounded-full flex items-center gap-1.5">
          <span className={`w-1.5 h-1.5 rounded-full ${isFinal ? 'bg-emerald-400 animate-pulse' : 'bg-amber-400'}`}></span>
          <span>{isFinal ? '9:16 Subtitled Reel' : '9:16 Muted Clip'}</span>
        </div>
      </div>

      {/* Action Buttons */}
      <div className="w-full mt-5 space-y-2.5">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {/* Download Button */}
          <a
            href={currentDownloadUrl}
            download={currentFilename}
            className={`py-3 px-4 rounded-xl font-bold text-xs flex items-center justify-center gap-2 transition-all shadow-lg hover:scale-[1.01] active:scale-[0.99] ${
              isFinal
                ? 'bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white shadow-emerald-600/25'
                : 'bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700'
            }`}
          >
            <Download className="w-4 h-4 flex-shrink-0" />
            <span>Download .mp4 {isFinal ? '(Final)' : '(Preview)'}</span>
          </a>

          {/* Open Output Folder Button */}
          <button
            onClick={handleOpenFolder}
            disabled={isOpeningFolder}
            className="py-3 px-4 rounded-xl font-bold text-xs flex items-center justify-center gap-2 transition-all bg-slate-800/90 hover:bg-slate-700/90 border border-slate-700 text-amber-300 hover:text-amber-200 hover:border-amber-500/40 shadow-lg hover:scale-[1.01] active:scale-[0.99]"
            title="Buka folder video output di Windows Explorer / File Manager"
          >
            {isOpeningFolder ? (
              <Loader2 className="w-4 h-4 animate-spin flex-shrink-0 text-amber-400" />
            ) : openFolderSuccess ? (
              <Check className="w-4 h-4 text-emerald-400 flex-shrink-0" />
            ) : (
              <FolderOpen className="w-4 h-4 flex-shrink-0 text-amber-400" />
            )}
            <span>{openFolderSuccess ? 'Folder Terbuka!' : 'Buka Folder Output'}</span>
          </button>
        </div>

        {/* Local disk path info & copy */}
        {currentLocalPath && (
          <button
            onClick={copyLocalPath}
            className="w-full py-2 px-3 rounded-lg bg-slate-900/80 hover:bg-slate-800/80 border border-slate-800 text-[11px] text-slate-400 hover:text-slate-200 font-mono flex items-center justify-between transition-colors text-left"
            title="Klik untuk salin alamat file lokal di komputer"
          >
            <span className="truncate flex items-center gap-1.5 max-w-[85%]">
              <Folder className="w-3 h-3 text-slate-500 flex-shrink-0" />
              <span className="truncate">{currentLocalPath}</span>
            </span>
            <span className="text-[10px] text-shopee-400 font-sans flex items-center gap-1">
              {isCopiedPath ? <Check className="w-3 h-3 text-emerald-400" /> : 'Copy Path'}
            </span>
          </button>
        )}
      </div>

    </div>
  );
}
