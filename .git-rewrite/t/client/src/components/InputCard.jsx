import React from 'react';
import { Youtube, ShoppingBag, Key, Sparkles, Shield, Sliders, Zap, Tag, AlignLeft } from 'lucide-react';

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
  onOpenSettings
}) {
  const selectedProvider = settings?.aiProvider || engineStatus?.activeAiEngine || 'gemini';
  const isGemini = selectedProvider === 'gemini';
  const selectedProviderReady = isGemini
    ? Boolean(engineStatus?.geminiKeyConfigured)
    : Boolean(engineStatus?.openRouterKeyConfigured);
  const selectedProviderLabel = isGemini
    ? `Gemini Direct (Flash): ${selectedProviderReady ? '.env Active' : 'Missing in .env'}`
    : `OpenRouter: ${selectedProviderReady ? '.env Active' : 'Missing in .env'}`;

  const detectedNoun = getDetectedProductNoun(formData.productTitle);

  const handleSubmit = (e) => {
    e.preventDefault();
    onGenerate();
  };

  return (
    <div className="glass-panel rounded-2xl p-6 shadow-xl relative overflow-hidden">
      {/* Decorative gradient blur */}
      <div className="absolute top-0 right-0 -mr-16 -mt-16 w-48 h-48 bg-orange-500/10 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute bottom-0 left-0 -ml-16 -mb-16 w-48 h-48 bg-indigo-500/10 rounded-full blur-3xl pointer-events-none" />

      <form onSubmit={handleSubmit} className="relative z-10 space-y-4">
        
        {/* Section Header */}
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold text-white flex items-center gap-2">
              <Zap className="w-5 h-5 text-shopee-500" />
              Source Video & Informasi Produk
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Masukkan detail produk agar AI menghasilkan naskah yang akurat dan persuasif.
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

        {/* 1. Judul / Nama Produk */}
        <div>
          <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5 flex items-center justify-between">
            <span className="flex items-center gap-1.5">
              <Tag className="w-4 h-4 text-amber-400" />
              Judul / Nama Produk <span className="text-shopee-500">*</span>
            </span>
            <span className="text-[11px] font-normal text-amber-300">Konteks Utama AI</span>
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
              <span className="text-slate-400">Target Produk AI:</span>
              <span className="font-semibold text-white">"{detectedNoun}"</span>
              <span className="text-[10px] text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded border border-emerald-500/20 ml-auto">
                Clean Noun
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
            <span className="text-[11px] font-normal text-slate-400">Poin penting naskah</span>
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
            <span className="text-[11px] font-normal text-slate-400">Faceless AI Highlight</span>
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

        {/* 4. Shopee Affiliate Link Input */}
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
              Active Formula:
            </span>
            <span className="px-2 py-0.5 rounded bg-amber-500/15 border border-amber-500/30 font-mono text-amber-300 font-bold">
              Pacing: {settings.sceneDuration || 3.3}s (Shopee FYP)
            </span>
            <span className="px-2 py-0.5 rounded bg-slate-800/80 border border-slate-700/60 font-mono text-slate-200">
              Subtitle: Kuning &amp; Putih
            </span>
            <span className="px-2 py-0.5 rounded bg-emerald-500/15 border border-emerald-500/30 font-mono text-emerald-300 font-bold">
              Framing: {(settings.renderMode || 'stage_80') === 'stage_80' ? 'Stage 80% (Blur)' : (settings.renderMode || 'stage_80') === 'fit_canvas' ? 'Fit 16:9' : (settings.renderMode || 'stage_80') === 'vertical_crop' ? 'Full 9:16' : 'Stage 1:1'}
            </span>
            <span className="px-2 py-0.5 rounded bg-slate-800/80 border border-slate-700/60 font-mono text-slate-300">
              9:16 (1080x1920)
            </span>
            <span className="px-2 py-0.5 rounded bg-slate-800/80 border border-slate-700/60 font-mono text-slate-300">
              Speed: {settings.speedMultiplier}x
            </span>
            {settings.hflip && (
              <span className="px-2 py-0.5 rounded bg-slate-800/80 border border-slate-700/60 font-mono text-slate-300">
                H-Flip: ON
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

        {/* Generate Button */}
        <div className="pt-2">
          <button
            type="submit"
            disabled={isLoading}
            className={`w-full py-4 rounded-xl font-bold text-base flex items-center justify-center gap-2.5 transition-all shadow-lg ${
              isLoading
                ? 'bg-slate-800 text-slate-400 cursor-not-allowed border border-slate-700'
                : 'bg-gradient-to-r from-shopee-500 via-orange-500 to-amber-500 text-white hover:from-shopee-600 hover:to-amber-600 shadow-orange-500/25 hover:shadow-orange-500/40 hover:scale-[1.01] active:scale-[0.99]'
            }`}
          >
            {isLoading ? (
              <>
                <div className="w-5 h-5 border-2 border-slate-400 border-t-transparent rounded-full animate-spin" />
                <span>Memproses Tahap 1 (Clipping & Scripting)...</span>
              </>
            ) : (
              <>
                <Sparkles className="w-5 h-5 fill-current" />
                <span>Generate Kotak Scene & Video 9:16</span>
              </>
            )}
          </button>
        </div>

      </form>
    </div>
  );
}
