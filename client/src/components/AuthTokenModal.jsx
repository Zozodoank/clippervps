import React, { useState, useEffect } from 'react';
import { KeyRound, X, Check, Shield, AlertTriangle } from 'lucide-react';
import { getApiToken, setApiToken } from '../utils/auth.js';

export default function AuthTokenModal({ isOpen, onClose }) {
  const [tokenInput, setTokenInput] = useState('');
  const [savedSuccess, setSavedSuccess] = useState(false);
  const [isUnauthorized, setIsUnauthorized] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setTokenInput(getApiToken());
      setSavedSuccess(false);
    }
  }, [isOpen]);

  useEffect(() => {
    const handleUnauthorized = () => {
      setIsUnauthorized(true);
    };
    window.addEventListener('clipper-auth-unauthorized', handleUnauthorized);
    return () => window.removeEventListener('clipper-auth-unauthorized', handleUnauthorized);
  }, []);

  if (!isOpen && !isUnauthorized) return null;

  const handleSave = (e) => {
    e?.preventDefault();
    setApiToken(tokenInput);
    setSavedSuccess(true);
    setIsUnauthorized(false);
    setTimeout(() => {
      setSavedSuccess(false);
      if (onClose) onClose();
      window.location.reload();
    }, 600);
  };

  const handleClear = () => {
    setApiToken('');
    setTokenInput('');
    setSavedSuccess(true);
    setTimeout(() => {
      setSavedSuccess(false);
      if (onClose) onClose();
      window.location.reload();
    }, 600);
  };

  const handleModalClose = () => {
    setIsUnauthorized(false);
    if (onClose) onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/90 animate-fadeIn">
      <div className="relative w-full max-w-md bg-slate-900 border border-slate-700/80 rounded-2xl shadow-2xl p-6 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between pb-4 border-b border-slate-800">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-400">
              <KeyRound className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-lg font-bold text-white">API Access Token</h3>
              <p className="text-xs text-slate-400">Autentikasi Cloudflare Tunnel / Akses Publik</p>
            </div>
          </div>
          <button
            onClick={handleModalClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Unauthorized Warning Banner */}
        {isUnauthorized && (
          <div className="mt-4 p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 flex items-start gap-2 text-rose-300 text-xs">
            <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
            <span>Akses Ditolak (401). Server VPS Anda diproteksi token. Silakan masukkan API Access Token yang terdaftar di <code>server/.env</code>.</span>
          </div>
        )}

        <form onSubmit={handleSave} className="mt-5 space-y-4">
          <div>
            <label className="block text-xs font-semibold text-slate-300 mb-1.5">
              Secret Token (Opsional)
            </label>
            <input
              type="password"
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              placeholder="Masukkan token dari .env (kosongkan jika tanpa proteksi)"
              className="w-full px-3.5 py-2.5 bg-slate-950 border border-slate-700 rounded-xl text-sm text-white placeholder-slate-500 focus:outline-none focus:border-amber-500 focus:ring-1 focus:ring-amber-500 transition"
            />
            <p className="mt-1.5 text-[11px] text-slate-400 flex items-center gap-1.5">
              <Shield className="w-3.5 h-3.5 text-slate-500" />
              Tersimpan aman di browser Anda (LocalStorage) untuk request API & EventSource.
            </p>
          </div>

          <div className="flex items-center justify-between pt-3 border-t border-slate-800 gap-2">
            <button
              type="button"
              onClick={handleClear}
              className="px-3 py-2 text-xs font-medium text-slate-400 hover:text-rose-400 hover:bg-rose-500/10 rounded-xl transition"
            >
              Hapus Token
            </button>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleModalClose}
                className="px-4 py-2 text-xs font-medium text-slate-300 hover:bg-slate-800 rounded-xl transition"
              >
                Batal
              </button>
              <button
                type="submit"
                className="px-4 py-2 text-xs font-semibold text-slate-900 bg-amber-400 hover:bg-amber-300 rounded-xl transition flex items-center gap-1.5"
              >
                {savedSuccess ? (
                  <>
                    <Check className="w-4 h-4 text-emerald-800" />
                    Tersimpan!
                  </>
                ) : (
                  'Simpan & Terapkan'
                )}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
