import React, { useState, useMemo } from 'react';
import {
  Copy,
  Check,
  Tag,
  ShoppingBag
} from 'lucide-react';
import { copyToClipboardSafe } from '../utils/clipboard';

function cleanCaptionText(caption = '') {
  if (!caption || typeof caption !== 'string') return '';
  return caption
    .replace(/(?:🛒\s*)?(?:link\s+(?:produk|shopee|pembelian)?\s*:\s*)?https?:\/\/[^\s]+/gi, '')
    .replace(/(?:🛒\s*)?(?:link\s+(?:produk|shopee|pembelian)?\s*:\s*)?shope\.ee\/[^\s]+/gi, '')
    .replace(/(?:🛒\s*)?(?:cek\s+selengkapnya\s+)?(?:cek\s+)?(?:link\s+)?(?:di\s+)?(?:kolom\s+)?komentar\s+(?:pertama|ke-1|1|pin|bawah)?(?:\s+ya)?(?:\s*[,!?. -]*[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]+)*(?:\s*[,!?. -])*/gi, '')
    .replace(/cek\s+selengkapnya\s+di\s+komentar(?:\s*[,!?.])?/gi, '')
    .replace(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]+/gu, '')
    .replace(/^[ \t]*[,!?. -]+[ \t]*$/gm, '')
    .replace(/^[ \t]*[,!?. -]+(?=\s*#)/gm, '')
    .replace(/,\s*([!?.])/g, '$1')
    .replace(/,\s*,+/g, ',')
    .replace(/[ \t]+([,!?.])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function enrichCaptionForDisplay(caption, result, platform = 'clipper') {
  let text = cleanCaptionText(caption || '');
  const productTitle = result?.productTitle || result?.videoTitle || '';
  const productDescription = result?.productDescription || '';
  const sampleContext = result?.sampleContext || null;
  const scenes = result?.scenes || [];

  const generateHashtags = () => {
    const combined = `${productTitle} ${productDescription} ${text}`.toLowerCase();
    const tags = new Set();
    if (platform === 'ytcliper') {
      tags.add('#youtubeshorts');
      tags.add('#shorts');
      tags.add('#rekomendasiproduk');
      tags.add('#racunbelanja');
      tags.add('#spillracun');
      tags.add('#affiliateindonesia');
      tags.add('#haul');
      tags.add('#unboxing');
    } else {
      tags.add('#racunshopee');
      tags.add('#shopeehaul');
      tags.add('#spillracun');
      tags.add('#racuntiktok');
      tags.add('#racunbelanja');
      tags.add('#reelsviral');
      tags.add('#affiliateindonesia');
      tags.add('#fyp');
    }
    if (/sabun|piring|dapur|kitchen|parut|chopper|pisau|wajan|panci|masak|spatula|blender|dispenser|botol|spons/i.test(combined)) {
      tags.add('#alatdapur');
      tags.add('#perabotandapur');
      tags.add('#dapurminimalis');
      tags.add('#dapurrapi');
    }
    if (/sapu|pel|sikat|bersih|clean|lap|debu|kain|kemoceng|vacuum/i.test(combined)) {
      tags.add('#alatkebersihan');
      tags.add('#rumahrapi');
      tags.add('#peralatanrumahtangga');
    }
    if (/rak|wadah|organizer|kotak|storage|gantungan/i.test(combined)) {
      tags.add('#organizer');
      tags.add('#rumahminimalis');
      tags.add('#dekorasirumah');
    }
    if (/baju|celana|gamis|dress|rok|tas|sepatu|kaos|hijab|dompet/i.test(combined)) {
      tags.add('#ootd');
      tags.add('#fashionhaul');
      tags.add('#spilloutfit');
    }
    if (/hp|charger|kabel|holder|tws|headset|speaker|elektronik|lampu|kipas/i.test(combined)) {
      tags.add('#gadgetunik');
      tags.add('#elektronikmurah');
    }
    tags.add('#barangunik');
    tags.add('#viral');
    return Array.from(tags).join(' ');
  };

  const defaultCta = platform === 'ytcliper'
    ? '🛒 Link pembelian produk resmi ada di deskripsi video ya!'
    : '🛒 Cek produk di bio / keranjang kuning sekarang sebelum kehabisan ya!';

  const defaultUrgency = 'Buruan checkout sekarang mumpung lagi diskon spesial & promo gratis ongkir! 🔥';

  const paragraphs = text ? text.split(/\n\s*\n/).filter(p => p.trim()) : [];
  const hasHashtags = /#\w+/.test(text);
  const isTooShort = !text || text.length < 100 || paragraphs.length < 3 || !hasHashtags;

  if (!isTooShort) {
    let enriched = text;
    if (!/keranjang|bio|deskripsi|checkout|beli|pesan|cek\s+produk/i.test(enriched)) {
      enriched += `\n\n${defaultUrgency}\n\n${defaultCta}`;
    }
    if (!/#\w+/.test(enriched)) {
      enriched += `\n\n${generateHashtags()}`;
    }
    return enriched.trim();
  }

  const cleanTitle = (productTitle || sampleContext?.productName || '').replace(/[\[\(\{\]\)\}].*$/g, '').trim();

  let hook = text;
  if (!hook || hook.length < 15) {
    hook = cleanTitle
      ? `🔥 Mau urusan rumah jadi 2x lebih cepat & praktis? Kenalin ${cleanTitle}! ✨`
      : `🔥 Masih repot pakai cara lama yang bikin boros & berantakan? Kenalin solusinya! 🧼✨`;
  }

  let solutionDesc = '';
  if (productDescription && productDescription.trim().length > 15) {
    const cleanDesc = productDescription.replace(/\s+/g, ' ').slice(0, 160).trim();
    solutionDesc = `Hadir dengan inovasi terbaru yang bikin kegiatan harian jauh lebih praktis, hemat waktu, dan hasil maksimal. ${cleanDesc.endsWith('.') ? cleanDesc : cleanDesc + '.'} 😍`;
  } else if (sampleContext?.coreProblem) {
    solutionDesc = `Solusi praktis buat kamu yang gak mau ribet mengatasi ${sampleContext.coreProblem.toLowerCase()}! Sangat praktis, efisien, dan bikin ruangan makin rapi estetik 😍`;
  } else {
    solutionDesc = `Bikin urusan harian jadi 2x lebih cepat, hemat tenaga, dan ruangan tetap rapi estetik tanpa ribet! Wajib banget punya buat kamu yang suka serba sat-set 😍`;
  }

  let bulletPoints = [];
  if (Array.isArray(sampleContext?.keyFeatures) && sampleContext.keyFeatures.length > 0) {
    bulletPoints = sampleContext.keyFeatures.slice(0, 4).map(f => `✅ ${f.trim()}`);
  } else if (Array.isArray(scenes) && scenes.length >= 3) {
    bulletPoints = [
      `✅ Desain ergonomis, praktis, dan sangat mudah digunakan`,
      `✅ Kualitas bahan premium, awet, dan tahan lama`,
      `✅ Hemat waktu dan tenaga sehari-hari`,
      `✅ Bikin tampilan ruangan makin bersih, rapi, dan modern`
    ];
  } else {
    bulletPoints = [
      `✅ Sangat praktis dan mudah digunakan siapa saja`,
      `✅ Kualitas bahan pilihan yang awet dan tahan lama`,
      `✅ Desain modern, fungsional, dan estetik`,
      `✅ Hemat waktu & bikin aktivitas harian makin simpel`
    ];
  }
  const benefitsSection = `Keunggulan Utama:\n${bulletPoints.join('\n')}`;

  const assembled = [
    hook,
    solutionDesc,
    benefitsSection,
    `${defaultUrgency}\n\n${defaultCta}`,
    generateHashtags()
  ].join('\n\n');

  return assembled.trim();
}

export default function CaptionCard({ result }) {
  const [copiedField, setCopiedField] = useState(null);
  const [userEditedCaption, setUserEditedCaption] = useState(null);

  const enrichedCaption = useMemo(() => enrichCaptionForDisplay(result?.caption || '', result, 'clipper'), [result]);
  const activeCaption = userEditedCaption !== null ? userEditedCaption : enrichedCaption;

  if (!result) return null;

  const copyToClipboard = async (text, fieldName) => {
    await copyToClipboardSafe(text);
    setCopiedField(fieldName);
    setTimeout(() => {
      setCopiedField(null);
    }, 2000);
  };

  return (
    <div className="glass-panel rounded-2xl p-6 shadow-xl flex flex-col h-full">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-bold text-slate-200 flex items-center gap-2">
           <Tag className="w-4 h-4 text-emerald-400" />
           Caption & Hashtags
        </h3>
        <div className="flex items-center gap-2">
           {userEditedCaption !== null && (
             <button
               onClick={() => setUserEditedCaption(null)}
               className="text-rose-400 hover:text-rose-300 underline text-[11px]"
             >
               Reset ke Asli
             </button>
           )}
           <button
              onClick={() => copyToClipboard(activeCaption, 'caption_text')}
              className="px-3 py-1.5 rounded-lg text-xs font-bold bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-400 transition-all border border-emerald-500/30 flex items-center gap-1.5"
            >
              {copiedField === 'caption_text' ? (
                <>
                  <Check className="w-3.5 h-3.5 text-emerald-400" />
                  <span>Tersalin!</span>
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5" />
                  <span>Copy Caption</span>
                </>
              )}
            </button>
        </div>
      </div>
      
      <div className="relative flex-1 flex flex-col space-y-2">
        <textarea
          value={activeCaption}
          onChange={(e) => setUserEditedCaption(e.target.value)}
          rows={13}
          placeholder="Ketik atau edit caption di sini..."
          className="w-full flex-1 min-h-[280px] bg-slate-950/90 border border-slate-800 rounded-xl p-4 text-xs text-slate-200 font-sans leading-relaxed focus:outline-none focus:ring-1 focus:ring-emerald-500/50 resize-none"
        />
      </div>

      {result.shopeeLink && (
        <div className="mt-4 pt-3 border-t border-slate-800/80 flex items-center justify-between text-xs">
          <div className="flex items-center gap-2 text-slate-400 truncate max-w-[70%]">
            <ShoppingBag className="w-3.5 h-3.5 text-shopee-500 flex-shrink-0" />
            <span className="truncate font-mono">{result.shopeeLink}</span>
          </div>

          <button
            onClick={() => copyToClipboard(result.shopeeLink, 'shopee')}
            className="text-[11px] text-shopee-400 hover:text-shopee-300 font-semibold flex items-center gap-1"
          >
            {copiedField === 'shopee' ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
            <span>{copiedField === 'shopee' ? 'Link Copied' : 'Copy Link'}</span>
          </button>
        </div>
      )}
    </div>
  );
}
