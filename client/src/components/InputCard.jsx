import React, { useEffect, useState } from 'react';
import { Youtube, ShoppingBag, Key, Sparkles, Shield, Sliders, Zap, Tag, AlignLeft, Plus, Minus, Link2, CheckCircle2 } from 'lucide-react';
import ProductFinder from './ProductFinder.jsx';

const DEFAULT_MANUAL_NICHES = [
  { id: 'kitchen_tools', name: 'Alat Dapur & Kebutuhan Rumah', shortName: 'Alat Dapur', icon: '🍳', badgeColor: '#10b981' },
  { id: 'gadget_smartphone', name: 'Smartphone & Gadget Viral', shortName: 'Smartphone', icon: '📱', badgeColor: '#3b82f6' },
];

const CLIENT_PRODUCT_ANCHORS = [
  { pattern: /\b(?:chopper|blender\s+mini|food\s+chopper)\b/i, noun: 'Chopper Mini Elektrik' },
  { pattern: /\b(?:gunting\s+dapur|gunting\s+sk5|gunting\s+tulang)\b/i, noun: 'Gunting Dapur SK5' },
  { pattern: /\b(?:mandoline|parutan\s+multifungsi|pemotong\s+sayur)\b/i, noun: 'Pemotong Sayur Multifungsi' },
  { pattern: /\b(?:pengupas\s+buah|peeler)\b/i, noun: 'Alat Pengupas Buah Praktis' },
  { pattern: /\b(?:pemeras\s+jeruk|citrus\s+squeezer)\b/i, noun: 'Alat Pemeras Jeruk Manual' },
  { pattern: /\b(?:pemotong\s+semangka|watermelon\s+slicer)\b/i, noun: 'Pemotong Semangka Praktis' },
  { pattern: /\b(?:pelumat\s+bawang|garlic\s+press)\b/i, noun: 'Alat Pelumat Bawang Putih' },
  { pattern: /\b(?:cetakan\s+bakso|meatball\s+maker)\b/i, noun: 'Cetakan Bakso Manual' },
  { pattern: /\b(?:sealer\s+plastik|mini\s+sealer)\b/i, noun: 'Sealer Plastik Mini Portable' },
  { pattern: /\b(?:pengasah\s+pisau|knife\s+sharpener)\b/i, noun: 'Alat Pengasah Pisau Praktis' },
  { pattern: /\b(?:timbangan\s+digital|kitchen\s+scale)\b/i, noun: 'Timbangan Dapur Digital' },
  { pattern: /\b(?:frother|pengocok\s+susu|milk\s+frother)\b/i, noun: 'Frother Pengocok Susu Mini' },
  { pattern: /\b(?:panci\s+listrik|electric\s+pot|electric\s+cooker)\b/i, noun: 'Panci Listrik Mini Serbaguna' },
  { pattern: /\b(?:wajan\s+telur|frypan\s+mini|pan\s+4\s+lubang)\b/i, noun: 'Wajan Mini Telur 4 Lubang' },
  { pattern: /\b(?:tamagoyaki|telur\s+gulung|egg\s+roll\s+pan)\b/i, noun: 'Wajan Tamagoyaki Mini' },
  { pattern: /\b(?:pembuat\s+waffle|waffle\s+maker)\b/i, noun: 'Alat Pembuat Waffle Mini' },
  { pattern: /\b(?:sutil\s+silikon|spatula\s+silikon)\b/i, noun: 'Sutil Silikon Set Tahan Panas' },
  { pattern: /\b(?:cetakan\s+es\s+batu|ice\s+cube)\b/i, noun: 'Cetakan Es Batu Silikon' },
  { pattern: /\b(?:pemanggang\s+sandwich|sandwich\s+maker)\b/i, noun: 'Pemanggang Sandwich Mini' },
  { pattern: /\b(?:botol\s+minyak|oil\s+dispenser)\b/i, noun: 'Botol Minyak Kuas Silikon' },
  { pattern: /\b(?:tempat\s+bumbu\s+putar|wadah\s+bumbu\s+4\s*sekat)\b/i, noun: 'Tempat Bumbu Putar Dapur' },
  { pattern: /\b(?:dispenser\s+beras|rice\s+dispenser)\b/i, noun: 'Dispenser Beras Mini Otomatis' },
  { pattern: /\b(?:wadah\s+telur|rolling\s+egg)\b/i, noun: 'Wadah Telur Kulkas Praktis' },
  { pattern: /\b(?:tirisan\s+beras|wadah\s+cuci\s+beras)\b/i, noun: 'Wadah Tirisan Cuci Beras Sayur' },
  { pattern: /\b(?:wadah\s+minyak\s+jelantah|saringan\s+minyak)\b/i, noun: 'Wadah Saringan Minyak Jelantah' },
  { pattern: /\b(?:dispenser\s+sabun\s+cuci\s+piring|soap\s+pump\s+sponge)\b/i, noun: 'Dispenser Sabun Cuci Piring Sponge' },
  { pattern: /\b(?:spons\s+nano|spons\s+cuci\s+piring|magic\s+sponge)\b/i, noun: 'Spons Nano Cuci Piring Magic' },
  { pattern: /\b(?:pemotong\s+kentang|potato\s+cutter|french\s+fries)\b/i, noun: 'Alat Pemotong Kentang Praktis' },
  { pattern: /\b(?:pisau\s+dapur|chef\s+knife)\b/i, noun: 'Pisau Dapur Stainless' },
];

function getDetectedProductNoun(rawTitle = '') {
  if (!rawTitle || rawTitle.trim().length < 3) return null;
  const cleaned = rawTitle
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\([^)]*(?:cod|promo|murah|diskon|ori)[^)]*\)/gi, ' ')
    .replace(/\b(?:cod|bisa cod|promo|diskon|murah|termurah|terlaris|terbaru|terlengkap|original|ori|asli|import|impor|viral|gratis ongkir)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  for (const anchor of CLIENT_PRODUCT_ANCHORS) {
    if (anchor.pattern.test(cleaned)) return anchor.noun;
  }
  const words = cleaned.split(/\s+/).filter(w => w.length >= 3 && !['dan','yang','untuk','dengan','dari','bisa'].includes(w.toLowerCase()));
  if (words.length > 0) {
    return words.slice(0, 3).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
  }
  return null;
}

export default function InputCard({
  formData,
  setFormData,
  onGenerate,
  isLoading,
  settings,
  engineStatus,
  onOpenSettings,
  drafts = [],
  onSaveDraft,
  onDeleteDraft,
  onRunAllDrafts,
  onRunSingleDraft,
  isAutoRunningDrafts
}) {
  const selectedProvider = settings?.aiProvider || engineStatus?.activeAiEngine || 'gemini';
  const isGemini = selectedProvider === 'gemini';
  const selectedProviderReady = isGemini
    ? Boolean(engineStatus?.geminiKeyConfigured)
    : Boolean(engineStatus?.openRouterKeyConfigured);
  const selectedProviderLabel = isGemini
    ? `Gemini Direct (Flash): ${selectedProviderReady ? '.env Active' : 'Missing in .env'}`
    : `OpenRouter: ${selectedProviderReady ? '.env Active' : 'Missing in .env'}`;

  // Pemilih Niche untuk MODE MANUAL (sama seperti mode auto: Alat Dapur & Smartphone/Gadget).
  const [nicheOptions, setNicheOptions] = useState(DEFAULT_MANUAL_NICHES);
  useEffect(() => {
    fetch('/api/niches')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (Array.isArray(data?.niches) && data.niches.length > 0) setNicheOptions(data.niches);
      })
      .catch(() => {});
  }, []);
  const activeNiche = formData.niche || 'kitchen_tools';
  const setNiche = (id) => {
    try { localStorage.setItem('clipper_niche', id); } catch {}
    setFormData({ ...formData, niche: id });
  };

  const detectedNoun = getDetectedProductNoun(formData.productTitle);
  const oemUrls = Array.isArray(formData.oemUrls) ? formData.oemUrls : [''];

  const updateOemUrl = (index, value) => {
    const next = [...oemUrls];
    next[index] = value;
    setFormData({ ...formData, oemUrls: next });
  };

  const addOemUrl = () => {
    if (oemUrls.length >= 2) return;
    setFormData({ ...formData, oemUrls: [...oemUrls, ''] });
  };

  const removeOemUrl = (index) => {
    const next = oemUrls.filter((_, i) => i !== index);
    setFormData({ ...formData, oemUrls: next.length ? next : [''] });
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    onGenerate();
  };

  return (
    <div className="glass-panel rounded-2xl p-6 shadow-xl relative overflow-hidden">

      <form onSubmit={handleSubmit} className="relative z-10 space-y-4">
        
        {/* Section Header */}
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold text-white flex items-center gap-2">
              <Zap className="w-5 h-5 text-shopee-500" />
              Pilih Sumber Video
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Masukkan detail produk untuk mendapatkan naskah dan video yang akurat.
            </p>
          </div>

          <button
            type="button"
            onClick={onOpenSettings}
            className="text-xs text-slate-400 hover:text-slate-200 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-slate-800/80 border border-slate-700/70 transition-colors"
          >
            <Sliders className="w-3.5 h-3.5 text-shopee-500" />
            <span>Settings</span>
          </button>
        </div>

        {/* Pembantu: cari merk + nama produk & video dari backend (bisa disalin / langsung dipakai) */}
        <ProductFinder formData={formData} setFormData={setFormData} />

        {/* 0. Niche / Kategori Produk (manual mode) */}
        <div>
          <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
            Niche / Kategori Produk
          </label>
          <div className="flex flex-wrap gap-2">
            {nicheOptions.map((n) => {
              const active = activeNiche === n.id;
              return (
                <button
                  type="button"
                  key={n.id}
                  onClick={() => setNiche(n.id)}
                  className={`flex-1 min-w-[150px] flex items-center gap-2 px-3 py-2 rounded-xl border text-left transition-all ${
                    active
                      ? 'bg-slate-800 border-cyan-500/60 ring-1 ring-cyan-500/40'
                      : 'bg-slate-900/60 border-slate-700 hover:border-slate-600'
                  }`}
                >
                  <span className="text-lg leading-none flex-shrink-0">{n.icon || '🏷️'}</span>
                  <span className="min-w-0">
                    <span className="block text-xs font-bold text-slate-100 truncate">{n.shortName || n.name}</span>
                    <span className="block text-[10px] text-slate-400 truncate">{n.name || ''}</span>
                  </span>
                  {active && <CheckCircle2 className="w-4 h-4 text-cyan-400 ml-auto flex-shrink-0" />}
                </button>
              );
            })}
          </div>
        </div>

        {/* 1. Judul / Nama Produk */}
        <div>
          <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5 flex items-center justify-between">
            <span className="flex items-center gap-1.5">
              <Tag className="w-4 h-4 text-amber-400" />
              Judul / Nama Produk <span className="text-shopee-500">*</span>
            </span>
            <span className="text-[11px] font-normal text-amber-300">Wajib diisi</span>
          </label>
          <input
            type="text"
            required
            placeholder="Contoh: Mini Portable Blender USB 350ml Rechargeable"
            value={formData.productTitle || ''}
            onChange={(e) => setFormData({ ...formData, productTitle: e.target.value })}
            className="w-full bg-slate-900/90 border border-slate-700 rounded-xl px-4 py-2.5 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-amber-500/50 focus:border-amber-500 transition-all font-sans"
          />
          {detectedNoun && (
            <div className="mt-2 px-3 py-1.5 rounded-lg bg-amber-500/10 border border-amber-500/30 flex items-center gap-2 text-xs text-amber-300 animate-in fade-in">
              <Sparkles className="w-3.5 h-3.5 text-amber-400 flex-shrink-0" />
              <span className="text-slate-400">Produk Terdeteksi:</span>
              <span className="font-semibold text-white">"{detectedNoun}"</span>
              <span className="text-xs text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded border border-emerald-500/20 ml-auto">
                Sesuai
              </span>
            </div>
          )}
        </div>

        {/* 2. Deskripsi & Keunggulan Produk */}
        <div>
          <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5 flex items-center justify-between">
            <span className="flex items-center gap-1.5">
              <AlignLeft className="w-4 h-4 text-indigo-400" />
              Deskripsi & Spesifikasi Produk (Opsional / Rekomendasi)
            </span>
            <span className="text-[11px] font-normal text-slate-400">Bahan untuk naskah suara AI</span>
          </label>
          <textarea
            rows={3}
            placeholder="Contoh: Kapasitas 350ml, 4 mata pisau stainless steel, baterai tahan 15x pemakaian, waterproof, praktis buat jus & smoothie, mudah dicuci."
            value={formData.productDescription || ''}
            onChange={(e) => setFormData({ ...formData, productDescription: e.target.value })}
            className="w-full bg-slate-900/90 border border-slate-700 rounded-xl px-4 py-2 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500 transition-all font-sans resize-none"
          />
        </div>

        {/* 3. YouTube Video URL Input */}
        <div>
          <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5 flex items-center justify-between">
            <span className="flex items-center gap-1.5">
              <Youtube className="w-4 h-4 text-red-500" />
              YouTube Video URL <span className="text-shopee-500">*</span>
            </span>
            <span className="text-[11px] font-normal text-slate-400">AI akan otomatis mencari adegan produk</span>
          </label>
          <input
            type="url"
            required
            placeholder="https://www.youtube.com/watch?v=..."
            value={formData.youtubeUrl}
            onChange={(e) => setFormData({ ...formData, youtubeUrl: e.target.value })}
            className="w-full bg-slate-900/90 border border-slate-700 rounded-xl px-4 py-2.5 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-shopee-500/50 focus:border-shopee-500 transition-all font-mono"
          />
        </div>

        {/* 4. URL OEM / Video Tambahan */}
        <div>
          <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5 flex items-center justify-between">
            <span className="flex items-center gap-1.5">
              <Link2 className="w-4 h-4 text-cyan-400" />
              URL OEM / Video Tambahan
              <span className="text-[10px] font-normal normal-case text-slate-500">(opsional)</span>
            </span>
            <span className="text-[11px] font-normal text-cyan-300">Video langsung digabung (tanpa filter AI)</span>
          </label>
          <div className="space-y-2">
            {oemUrls.map((url, index) => (
              <div key={index} className="flex items-center gap-2">
                <span className="w-7 h-9 flex items-center justify-center rounded-lg bg-slate-800 border border-slate-700 text-[10px] font-bold text-slate-400">
                  {index + 1}
                </span>
                <input
                  type="url"
                  placeholder={`https://www.youtube.com/watch?v=... (OEM ${index + 1})`}
                  value={url}
                  onChange={(e) => updateOemUrl(index, e.target.value)}
                  className="flex-1 bg-slate-900/90 border border-slate-700 rounded-xl px-4 py-2.5 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/50 focus:border-cyan-500 transition-all font-mono"
                />
                {oemUrls.length > 1 && (
                  <button type="button" onClick={() => removeOemUrl(index)}
                    className="w-9 h-9 flex-shrink-0 rounded-lg bg-slate-800 border border-slate-700 text-slate-400 hover:text-red-300 hover:border-red-500/50 transition-colors"
                    title={`Hapus URL OEM ${index + 1}`} aria-label={`Hapus URL OEM ${index + 1}`}>
                    <Minus className="w-4 h-4 mx-auto" />
                  </button>
                )}
                {index === oemUrls.length - 1 && oemUrls.length < 2 && (
                  <button type="button" onClick={addOemUrl}
                    className="w-9 h-9 flex-shrink-0 rounded-lg bg-cyan-500/10 border border-cyan-500/40 text-cyan-300 hover:bg-cyan-500/20 hover:border-cyan-400 transition-colors"
                    title="Tambah URL OEM" aria-label="Tambah URL OEM">
                    <Plus className="w-4 h-4 mx-auto" />
                  </button>
                )}
              </div>
            ))}
          </div>
          <p className="mt-1.5 text-xs text-slate-500">
            Tambahkan sampai 2 URL OEM jika video utama kurang panjang. Video dari link OEM akan digabungkan secara langsung.
          </p>
        </div>

        {/* 5. Shopee Affiliate Link Input */}
        <div>
          <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5 flex items-center justify-between">
            <span className="flex items-center gap-1.5">
              <ShoppingBag className="w-4 h-4 text-shopee-500" />
              Shopee Affiliate Link <span className="text-shopee-500">*</span>
            </span>
            <span className="text-[11px] font-normal text-slate-400">Tersimpan untuk referensi produk & script.txt</span>
          </label>
          <input
            type="text"
            required
            placeholder="https://shope.ee/abcdef..."
            value={formData.shopeeLink}
            onChange={(e) => setFormData({ ...formData, shopeeLink: e.target.value })}
            className="w-full bg-slate-900/90 border border-slate-700 rounded-xl px-4 py-2.5 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-shopee-500/50 focus:border-shopee-500 transition-all font-mono"
          />
        </div>

        {/* Applied Filters & .env Status Strip */}
        <div className="pt-1 flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-400">
          <div className="flex flex-wrap items-center gap-2">
            <span className="flex items-center gap-1 text-slate-300 font-medium">
              <Shield className="w-3.5 h-3.5 text-emerald-400" />
              Pengaturan Video:
            </span>
            <span className="px-2 py-0.5 rounded bg-amber-500/15 border border-amber-500/30 font-mono text-amber-300 font-bold">
              Potong tiap {settings.sceneDuration || 3.3} detik
            </span>
            <span className="px-2 py-0.5 rounded bg-emerald-500/15 border border-emerald-500/30 font-mono text-emerald-300 font-bold">
              {(settings.renderMode || 'stage_80') === 'stage_80' ? 'Blur Latar (Vertikal)' : (settings.renderMode || 'stage_80') === 'fit_canvas' ? 'Sesuai Layar' : (settings.renderMode || 'stage_80') === 'vertical_crop' ? 'Potong Vertikal' : 'Kotak 1:1'}
            </span>
            <span className="px-2 py-0.5 rounded bg-slate-800/80 border border-slate-700/60 font-mono text-slate-300">
              Format HP (9:16)
            </span>
            {settings.speedMultiplier !== 1 && (
              <span className="px-2 py-0.5 rounded bg-slate-800/80 border border-slate-700/60 font-mono text-slate-300">
                Kecepatan: {settings.speedMultiplier}x
              </span>
            )}
            {settings.hflip && (
              <span className="px-2 py-0.5 rounded bg-slate-800/80 border border-slate-700/60 font-mono text-slate-300">
                Balik Kanan-Kiri
              </span>
            )}
          </div>

          <div className={`flex items-center gap-1 px-2.5 py-0.5 rounded-full border font-medium text-[10px] ${
            selectedProviderReady
              ? (isGemini ? 'bg-blue-500/10 border-blue-500/20 text-blue-400' : 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400')
              : 'bg-amber-500/10 border-amber-500/20 text-amber-300'
          }`}>
            <Key className="w-3 h-3" />
            <span>{selectedProviderLabel}</span>
          </div>
        </div>

        {/* Generate & Save Buttons */}
        <div className="pt-2 flex gap-3">
          <button
            type="button"
            onClick={onSaveDraft}
            disabled={isLoading}
            className={`flex-1 py-3.5 rounded-xl font-bold text-sm flex items-center justify-center gap-2.5 transition-all shadow-lg ${
              isLoading
                ? 'bg-slate-800 text-slate-400 cursor-not-allowed border border-slate-700'
                : 'bg-emerald-600/90 text-white hover:bg-emerald-500 shadow-emerald-500/20 hover:shadow-emerald-500/40 border border-emerald-500/50 hover:scale-[1.02] active:scale-[0.98]'
            }`}
          >
            <div className="w-5 h-5 bg-white/20 rounded-md flex items-center justify-center">💾</div>
            <span>Simpan Draft</span>
          </button>

          <button
            type="submit"
            disabled={isLoading}
            className={`flex-1 py-3.5 rounded-xl font-bold text-sm flex items-center justify-center gap-2.5 transition-all shadow-lg ${
              isLoading
                ? 'bg-slate-800 text-slate-400 cursor-not-allowed border border-slate-700'
                : 'bg-shopee-500 text-white hover:bg-shopee-600 shadow-shopee-500/25 hover:shadow-shopee-500/40 hover:scale-[1.02] active:scale-[0.98]'
            }`}
          >
            {isLoading ? (
              <>
                <div className="w-4 h-4 border-2 border-slate-400 border-t-transparent rounded-full animate-spin" />
                <span>Memproses...</span>
              </>
            ) : (
              <>
                <Sparkles className="w-4 h-4 fill-current" />
                <span>Proses Sekarang</span>
              </>
            )}
          </button>
        </div>

      </form>

      {/* Drafts Section */}
      {(drafts.length > 0 || isAutoRunningDrafts) && (
        <div className="mt-8 pt-6 border-t border-slate-700/60 relative z-10 animate-in fade-in slide-in-from-bottom-4">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-bold text-white flex items-center gap-2">
              <div className="w-6 h-6 rounded-lg bg-emerald-500/20 border border-emerald-500/30 flex items-center justify-center text-emerald-400">
                💾
              </div>
              Daftar Antrean Draft ({drafts.length})
            </h3>
            <button
              type="button"
              onClick={onRunAllDrafts}
              disabled={isAutoRunningDrafts || drafts.length === 0}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all shadow flex items-center gap-1.5 ${
                isAutoRunningDrafts || drafts.length === 0
                  ? 'bg-slate-800 text-slate-500 cursor-not-allowed border border-slate-700'
                  : 'bg-gradient-to-r from-emerald-500 to-teal-400 text-white shadow-emerald-500/25 hover:scale-105 active:scale-95 border border-emerald-400/50'
              }`}
            >
              <Zap className="w-3.5 h-3.5 fill-current" />
              {isAutoRunningDrafts ? 'Sedang Jalan Berurutan...' : 'Jalankan Semua'}
            </button>
          </div>

          <div className="space-y-3 max-h-[300px] overflow-y-auto pr-1">
            {drafts.map((draft, idx) => (
              <div key={draft.id} className="p-3 rounded-xl bg-slate-900/60 border border-slate-700/50 flex flex-col sm:flex-row gap-3 items-start sm:items-center justify-between group hover:border-slate-600 transition-colors">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="px-1.5 py-0.5 rounded bg-slate-800 text-[10px] text-slate-400 font-mono">#{idx + 1}</span>
                    <h4 className="text-xs font-bold text-slate-200 truncate" title={draft.productTitle}>
                      {draft.productTitle || '(Tanpa Judul)'}
                    </h4>
                  </div>
                  <div className="flex items-center gap-3 text-[10px] text-slate-500 font-mono">
                    <span className="truncate max-w-[120px] sm:max-w-[150px]" title={draft.youtubeUrl}>
                      YT: {draft.youtubeUrl || '-'}
                    </span>
                    <span className="truncate max-w-[120px] sm:max-w-[150px]" title={draft.shopeeLink}>
                      Aff: {draft.shopeeLink || '-'}
                    </span>
                  </div>
                </div>

                <div className="flex items-center gap-2 flex-shrink-0 w-full sm:w-auto">
                  <button
                    type="button"
                    onClick={() => onDeleteDraft(draft.id)}
                    disabled={isAutoRunningDrafts}
                    className="flex-1 sm:flex-none px-2.5 py-1.5 rounded-lg border border-red-500/30 bg-red-500/10 text-red-400 text-xs font-semibold hover:bg-red-500/20 transition-colors disabled:opacity-50"
                  >
                    Hapus
                  </button>
                  <button
                    type="button"
                    onClick={() => onRunSingleDraft(draft)}
                    disabled={isAutoRunningDrafts}
                    className="flex-1 sm:flex-none px-3 py-1.5 rounded-lg bg-shopee-500 text-white text-xs font-bold shadow-md shadow-shopee-500/20 hover:bg-shopee-600 transition-colors disabled:opacity-50 flex items-center justify-center gap-1.5"
                  >
                    <Sparkles className="w-3.5 h-3.5" />
                    Proses
                  </button>
                </div>
              </div>
            ))}
            
            {drafts.length === 0 && isAutoRunningDrafts && (
              <div className="p-6 text-center text-slate-400 text-xs flex flex-col items-center justify-center border border-dashed border-slate-700/50 rounded-xl bg-slate-900/30">
                <div className="w-8 h-8 rounded-full border-2 border-emerald-500 border-t-transparent animate-spin mb-3"></div>
                <p>Sedang memproses antrean...</p>
              </div>
            )}
          </div>
        </div>
      )}

    </div>
  );
}
