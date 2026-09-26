import React, { useState } from 'react';
import {
  Search,
  RefreshCw,
  Copy,
  Check,
  Film,
  ExternalLink,
  ChevronDown,
  Wand2,
  ShoppingBag,
  Sparkles,
} from 'lucide-react';

function formatDuration(sec) {
  const s = Number(sec) || 0;
  if (s <= 0) return '';
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

/**
 * ProductFinder — kotak pencarian bantuan untuk MODE MANUAL.
 * Menelusuri merk + nama produk NYATA lewat backend (/api/find-products),
 * lalu bisa menarik daftar videonya (/api/find-videos). Setiap hasil dapat
 * disalin atau langsung "dipakai" untuk mengisi form manual.
 */
export default function ProductFinder({ formData, setFormData }) {
  const [open, setOpen] = useState(false);
  const [keyword, setKeyword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [products, setProducts] = useState([]);
  const [searched, setSearched] = useState(false);
  const [videoState, setVideoState] = useState({}); // url -> { loading, error, items }
  const [expanded, setExpanded] = useState(null); // product url whose videos are shown
  const [copiedKey, setCopiedKey] = useState(null);

  const doCopy = (text, key) => {
    const val = String(text || '');
    if (!val) return;
    try {
      navigator.clipboard?.writeText(val);
    } catch {
      /* clipboard mungkin diblokir browser; teks tetap tampil di layar untuk disalin manual */
    }
    setCopiedKey(key);
    setTimeout(() => setCopiedKey((k) => (k === key ? null : k)), 1400);
  };

  const runSearch = async (q) => {
    const query = String(q ?? keyword).trim();
    if (!query) {
      setError('Ketik kata kunci dulu, misalnya "blender mini" atau "spons cuci piring".');
      return;
    }
    setLoading(true);
    setError('');
    setVideoState({});
    setExpanded(null);
    try {
      const res = await fetch('/api/find-products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, limit: 10 }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.success === false) {
        throw new Error(data?.error || `Gagal mencari (HTTP ${res.status}).`);
      }
      setProducts(Array.isArray(data.products) ? data.products : []);
      setSearched(true);
      if (!data.products?.length) {
        setError('Tidak ada hasil. Ubah kata kunci atau tekan "Cari Lagi".');
      }
    } catch (err) {
      setError(err.message || 'Terjadi kesalahan saat mencari produk.');
      setProducts([]);
    } finally {
      setLoading(false);
    }
  };

  const loadVideos = async (product) => {
    const key = product.url;
    setExpanded(key);
    if (videoState[key]?.items) return;
    setVideoState((s) => ({ ...s, [key]: { loading: true, error: '', items: [] } }));
    try {
      const res = await fetch('/api/find-videos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productTitle: product.title, limit: 10 }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.success === false) {
        throw new Error(data?.error || `Gagal mencari video (HTTP ${res.status}).`);
      }
      setVideoState((s) => ({ ...s, [key]: { loading: false, error: '', items: data.videos || [] } }));
    } catch (err) {
      setVideoState((s) => ({ ...s, [key]: { loading: false, error: err.message || 'Gagal.', items: [] } }));
    }
  };

  const useProduct = (p) => {
    setFormData({
      ...formData,
      productTitle: p.title,
      productDescription: formData.productDescription || p.snippet || '',
      shopeeLink: formData.shopeeLink || p.url || '',
    });
    setCopiedKey(`use:${p.url}`);
    setTimeout(() => setCopiedKey((k) => (k === `use:${p.url}` ? null : k)), 1400);
  };

  const useVideo = (v) => {
    const next = { ...formData };
    if (!String(next.youtubeUrl || '').trim()) {
      next.youtubeUrl = v.url;
    } else {
      const oem = Array.isArray(next.oemUrls) ? [...next.oemUrls] : [''];
      const idx = oem.findIndex((u) => !String(u || '').trim());
      if (idx >= 0) oem[idx] = v.url;
      else if (oem.length < 2) oem.push(v.url);
      else next.youtubeUrl = v.url;
      next.oemUrls = oem.slice(0, 2);
    }
    setFormData(next);
    setCopiedKey(`vid:${v.id || v.url}`);
    setTimeout(() => setCopiedKey((k) => (k === `vid:${v.id || v.url}` ? null : k)), 1400);
  };

  const btnBase = 'px-2.5 py-1 rounded-lg text-[11px] font-semibold border transition-colors flex items-center gap-1';

  return (
    <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/[0.04] overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-3.5 py-2.5 hover:bg-emerald-500/10 transition-colors"
      >
        <span className="flex items-center gap-2 text-sm font-bold text-emerald-300">
          <Search className="w-4 h-4" />
          Cari Produk &amp; Video (Bantu Manual)
          <span className="text-[10px] font-normal text-slate-400">— merk + nama dari backend, tinggal salin / pakai</span>
        </span>
        <ChevronDown className={`w-4 h-4 text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="px-3.5 pb-3.5 space-y-3">
          {/* Baris pencarian */}
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  runSearch();
                }
              }}
              placeholder="Ketik kata kunci produk, mis. blender mini, rak piring…"
              className="flex-1 bg-slate-900/90 border border-slate-700 rounded-xl px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/50 focus:border-emerald-500"
            />
            <button
              type="button"
              onClick={() => runSearch()}
              disabled={loading}
              className={`${btnBase} ${btnBase.includes('px-2.5') ? '' : ''} bg-emerald-500/20 border-emerald-500/40 text-emerald-200 hover:bg-emerald-500/30 disabled:opacity-50 py-2 px-3 text-xs`}
            >
              {loading ? (
                <><RefreshCw className="w-3.5 h-3.5 animate-spin" /> Mencari…</>
              ) : (
                <><Sparkles className="w-3.5 h-3.5" /> Cari</>
              )}
            </button>
          </div>

          {error && (
            <p className="text-[11px] text-amber-300 bg-amber-500/10 border border-amber-500/25 rounded-lg px-3 py-1.5">{error}</p>
          )}

          {searched && products.length > 0 && (
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-slate-400">{products.length} produk ditemukan. Tidak cocok? tekan <b className="text-emerald-300">Cari Lagi</b>.</span>
              <button
                type="button"
                onClick={() => runSearch()}
                disabled={loading}
                className={`${btnBase} bg-slate-800 border-slate-700 text-slate-200 hover:border-emerald-500/50 disabled:opacity-50`}
              >
                <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> Cari Lagi
              </button>
            </div>
          )}

          {/* Daftar produk */}
          {products.length > 0 && (
            <div className="space-y-2 max-h-[22rem] overflow-y-auto pr-1">
              {products.map((p) => {
                const vs = videoState[p.url];
                const isOpen = expanded === p.url;
                return (
                  <div key={p.url} className="rounded-xl border border-slate-700/70 bg-slate-900/60 p-3">
                    <div className="flex flex-wrap items-center gap-1.5 mb-1">
                      {p.brand && (
                        <span className="text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded bg-orange-500/15 border border-orange-500/30 text-orange-300">
                          {p.brand}{p.model ? ` · ${p.model}` : ''}
                        </span>
                      )}
                      {p.productType && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 border border-slate-700 text-slate-300">{p.productType}</span>
                      )}
                    </div>
                    <p className="text-xs text-slate-100 leading-snug mb-2">{p.title}</p>

                    <div className="flex flex-wrap items-center gap-1.5">
                      <button type="button" onClick={() => useProduct(p)} className={`${btnBase} bg-emerald-500/20 border-emerald-500/40 text-emerald-200 hover:bg-emerald-500/30`}>
                        {copiedKey === `use:${p.url}` ? <Check className="w-3.5 h-3.5" /> : <Wand2 className="w-3.5 h-3.5" />} Pakai
                      </button>
                      <button type="button" onClick={() => doCopy(p.title, `t:${p.url}`)} className={`${btnBase} bg-slate-800 border-slate-700 text-slate-200 hover:border-slate-600`}>
                        {copiedKey === `t:${p.url}` ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />} Judul
                      </button>
                      <button type="button" onClick={() => doCopy(p.url, `u:${p.url}`)} className={`${btnBase} bg-slate-800 border-slate-700 text-slate-200 hover:border-slate-600`}>
                        {copiedKey === `u:${p.url}` ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <ShoppingBag className="w-3.5 h-3.5" />} Link Shopee
                      </button>
                      <a href={p.url} target="_blank" rel="noreferrer" className={`${btnBase} bg-slate-800 border-slate-700 text-slate-300 hover:border-slate-600`}>
                        <ExternalLink className="w-3.5 h-3.5" /> Buka
                      </a>
                      <button type="button" onClick={() => (isOpen ? setExpanded(null) : loadVideos(p))} className={`${btnBase} ml-auto bg-red-500/15 border-red-500/30 text-red-200 hover:bg-red-500/25`}>
                        <Film className="w-3.5 h-3.5" /> {isOpen ? 'Tutup Video' : 'Cari Video'}
                      </button>
                    </div>

                    {/* Daftar video produk ini */}
                    {isOpen && (
                      <div className="mt-2.5 pt-2.5 border-t border-slate-700/60 space-y-1.5">
                        {vs?.loading && <p className="text-[11px] text-slate-400 flex items-center gap-1.5"><RefreshCw className="w-3.5 h-3.5 animate-spin" /> Mencari video…</p>}
                        {vs?.error && <p className="text-[11px] text-amber-300">{vs.error}</p>}
                        {vs && !vs.loading && !vs.error && (!vs.items || vs.items.length === 0) && (
                          <p className="text-[11px] text-slate-500">Tidak ada video untuk produk ini. Coba produk lain / Cari Lagi.</p>
                        )}
                        {vs?.items?.map((v) => (
                          <div key={v.id || v.url} className="rounded-lg bg-slate-950/50 border border-slate-700/50 px-2.5 py-1.5">
                            <div className="flex items-start gap-2">
                              <div className="min-w-0 flex-1">
                                <p className="text-[11px] text-slate-200 leading-snug truncate" title={v.title}>{v.title || v.url}</p>
                                <p className="text-[10px] text-slate-500 font-mono truncate">{v.url}{v.duration ? ` · ${formatDuration(v.duration)}` : ''}</p>
                              </div>
                              <div className="flex items-center gap-1 flex-shrink-0">
                                <button type="button" onClick={() => doCopy(v.url, `v:${v.id || v.url}`)} className={`${btnBase} bg-slate-800 border-slate-700 text-slate-200 hover:border-slate-600`}>
                                  {copiedKey === `v:${v.id || v.url}` ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                                </button>
                                <button type="button" onClick={() => useVideo(v)} className={`${btnBase} bg-red-500/15 border-red-500/30 text-red-200 hover:bg-red-500/25`}>
                                  {copiedKey === `vid:${v.id || v.url}` ? <Check className="w-3.5 h-3.5" /> : <Wand2 className="w-3.5 h-3.5" />} Pakai
                                </button>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
