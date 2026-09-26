import React, { useState, useMemo } from 'react';
import {
  Copy,
  Check,
  Clapperboard,
  FileText,
  MessageSquare,
  Sparkles,
  Layers,
  HelpCircle,
  ShoppingBag,
  ExternalLink,
  Tag,
  Target,
  Lightbulb,
  Terminal,
  Volume2,
  Clock,
  Bot
} from 'lucide-react';
import { copyToClipboardSafe } from '../utils/clipboard';

/**
 * Parse Google AI Studio prompt into 3 separate sections:
 * 1. Scene Setting
 * 2. Sample Context (Style & Pacing & Voiceover Duration)
 * 3. Speaker / Dialogue (Voiceover with emotion tags)
 */
function parseAiStudioSections(promptText, sampleContext, voiceoverScript, videoDuration) {
  let scene = 'Studio dapur modern yang bersih dengan presenter Indonesia bersuara ramah dan energik.';
  let context = '';
  let speaker = voiceoverScript || '';

  if (typeof promptText === 'string' && promptText.trim().length > 0) {
    const text = promptText.trim();

    // Match Scene section
    const sceneMatch = text.match(/(?:Scene|SCENE)[\s\r\n:]+([\s\S]*?)(?=(?:Sample Context|SAMPLE CONTEXT|Context|Speaker|SPEAKER|$))/i);
    if (sceneMatch && sceneMatch[1].trim()) {
      scene = sceneMatch[1].trim();
    }

    // Match Sample Context section
    const contextMatch = text.match(/(?:Sample Context|SAMPLE CONTEXT|Context)[\s\r\n:]+([\s\S]*?)(?=(?:Speaker|SPEAKER|$))/i);
    if (contextMatch && contextMatch[1].trim()) {
      context = contextMatch[1].trim();
    }

    // Match Speaker section (Speaker 1, Speaker 1 - Orus, etc.)
    const speakerMatch = text.match(/(?:Speaker\s*\d*(?:\s*-\s*[A-Za-z0-9]+)?|SPEAKER\s*\d*)[\s\r\n:]+([\s\S]*)$/i);
    if (speakerMatch && speakerMatch[1].trim()) {
      speaker = speakerMatch[1].trim();
    } else if (!sceneMatch && !contextMatch) {
      speaker = text;
    }
  }

  // Fallback speaker if empty
  if (!speaker && voiceoverScript) {
    speaker = voiceoverScript;
  }

  // Clean any accidental leftover header lines from speaker text
  speaker = speaker.replace(/^Speaker\s*\d*(?:\s*-\s*[A-Za-z0-9]+)?[\s\r\n:]+/i, '').trim();

  // Extract the last timestamp from Speaker 1 (e.g. [00:30] -> 30s)
  const timestampMatches = [...(speaker || '').matchAll(/\[(\d{1,2}):(\d{2})\]/g)];
  let effectiveDuration = null;
  if (timestampMatches.length > 0) {
    const lastMatch = timestampMatches[timestampMatches.length - 1];
    const minutes = parseInt(lastMatch[1], 10);
    const seconds = parseInt(lastMatch[2], 10);
    effectiveDuration = minutes * 60 + seconds;
  }

  if (effectiveDuration === null || effectiveDuration <= 0) {
    effectiveDuration = videoDuration || (sampleContext?.videoDuration ? parseInt(sampleContext.videoDuration, 10) : 30);
  }

  const defaultDurationPrefix = `Durasi voice over ${effectiveDuration} detik. `;

  if (!context) {
    context = `${defaultDurationPrefix}Iklan affiliate viral. Dimulai dengan hook yang menarik perhatian, membangun ke demonstrasi produk, diakhiri CTA yang meyakinkan. Nada suara hangat, antusias, dan persuasif.`;
  } else {
    // Replace existing "Durasi video XX detik" or "Durasi voice over XX detik" or "Durasi XX detik"
    if (/durasi\s+(?:video|voice\s+over)?\s*\d+\s*detik/i.test(context)) {
      context = context.replace(/durasi\s+(?:video|voice\s+over)?\s*\d+\s*detik/i, `Durasi voice over ${effectiveDuration} detik`);
    } else {
      context = `${defaultDurationPrefix}${context}`;
    }
    // Also replace any leftover "durasi video" with "durasi voice over"
    context = context.replace(/durasi\s+video/gi, 'durasi voice over');
  }

  return { scene, context, speaker };
}

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
  const [activeTab, setActiveTab] = useState('scenes');
  const [copiedField, setCopiedField] = useState(null);
  const [userEditedCaption, setUserEditedCaption] = useState(null);

  const enrichedCaption = useMemo(() => enrichCaptionForDisplay(result?.caption || '', result, 'clipper'), [result]);
  const activeCaption = userEditedCaption !== null ? userEditedCaption : enrichedCaption;

  if (!result) return null;
  const videoDuration = result.highlight?.duration || (result.sampleContext?.videoDuration ? parseInt(result.sampleContext.videoDuration, 10) : (Array.isArray(result.scenes) && result.scenes.length > 0 ? Math.round(result.scenes.length * 3.3) : 24));
  const formattedDuration = result.sampleContext?.videoDuration || `${typeof videoDuration === 'number' ? videoDuration.toFixed(1) : videoDuration} detik`;

  const copyToClipboard = async (text, fieldName) => {
    await copyToClipboardSafe(text);
    setCopiedField(fieldName);
    setTimeout(() => {
      setCopiedField(null);
    }, 2000);
  };

  const scenesText = Array.isArray(result.scenes)
    ? result.scenes
        .map(
          (s) =>
            `[SCENE ${s.sceneNumber} (${s.timeRange})]\nVisual: ${s.visualDescription}\nVoiceover: "${s.voiceover}"\nNotes: ${s.adAdvisorNotes || '-'}`
        )
        .join('\n\n')
    : '';

  const contextText = result.sampleContext
    ? `Produk: ${result.sampleContext.productName || result.videoTitle}\nDurasi Video: ${formattedDuration}\nTarget Audiens: ${result.sampleContext.targetAudience || '-'}\nMasalah Utama: ${result.sampleContext.coreProblem || '-'}\nKeunggulan Utama:\n${(Array.isArray(result.sampleContext.keyFeatures) ? result.sampleContext.keyFeatures : []).map((f) => `- ${f}`).join('\n')}\nTrigger Pembelian: ${result.sampleContext.buyingTrigger || '-'}`
    : '';

  const aiStudioSections = parseAiStudioSections(result.aiStudioPrompt, result.sampleContext, result.voiceoverScript, videoDuration);
  const fullAiStudioPrompt = `Scene\n${aiStudioSections.scene}\n\nSample Context\n${aiStudioSections.context}\n\nSpeaker 1\n${aiStudioSections.speaker}`;

  const getSceneBeatBadge = (sceneNum, totalScenes) => {
    if (sceneNum === 1) return { label: '🔥 Hook Masalah (0-3s)', color: 'bg-red-500/20 text-red-300 border-red-500/30' };
    if (sceneNum === 2) return { label: '💡 Hero Solution', color: 'bg-indigo-500/20 text-indigo-300 border-indigo-500/30' };
    if (sceneNum === totalScenes) return { label: '🛒 CTA Keranjang Bawah', color: 'bg-amber-500/20 text-amber-300 border-amber-500/30' };
    if (sceneNum === totalScenes - 1) return { label: '💰 Psikologi Harga', color: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30' };
    return { label: '✨ Satisfying Demo', color: 'bg-sky-500/20 text-sky-300 border-sky-500/30' };
  };

  return (
    <div className="glass-panel rounded-2xl p-6 shadow-xl flex flex-col h-full">
      
      {/* Tab Navigation Header */}
      <div className="flex items-center justify-between border-b border-slate-800 pb-3.5 mb-4 flex-wrap gap-2">
        <div className="flex items-center gap-1.5 flex-wrap">
          
          <button
            onClick={() => setActiveTab('scenes')}
            className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center gap-1.5 ${
              activeTab === 'scenes'
                ? 'bg-shopee-500 text-white shadow-md shadow-shopee-500/25'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
            }`}
          >
            <Clapperboard className="w-3.5 h-3.5" />
            <span>Kotak Scene</span>
          </button>

          <button
            onClick={() => setActiveTab('script')}
            className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center gap-1.5 ${
              activeTab === 'script'
                ? 'bg-indigo-600 text-white shadow-md shadow-indigo-600/25'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
            }`}
          >
            <FileText className="w-3.5 h-3.5" />
            <span>Naskah Voiceover (ID)</span>
          </button>

          <button
            onClick={() => setActiveTab('context')}
            className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center gap-1.5 ${
              activeTab === 'context'
                ? 'bg-amber-600 text-white shadow-md shadow-amber-600/25'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
            }`}
          >
            <Sparkles className="w-3.5 h-3.5" />
            <span>Sample Context</span>
          </button>

          <button
            onClick={() => setActiveTab('aistudio')}
            className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center gap-1.5 ${
              activeTab === 'aistudio'
                ? 'bg-purple-600 text-white shadow-md shadow-purple-600/25'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
            }`}
          >
            <Bot className="w-3.5 h-3.5" />
            <span>Prompt Google AI Studio</span>
          </button>

          <button
            onClick={() => setActiveTab('caption')}
            className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center gap-1.5 ${
              activeTab === 'caption'
                ? 'bg-emerald-600 text-white shadow-md shadow-emerald-600/25'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
            }`}
          >
            <Tag className="w-3.5 h-3.5" />
            <span>Reels Caption</span>
          </button>
        </div>

        <button
          onClick={() => {
            if (activeTab === 'scenes') copyToClipboard(scenesText, 'tab_scenes');
            else if (activeTab === 'script') copyToClipboard(result.voiceoverScript || '', 'tab_script');
            else if (activeTab === 'context') copyToClipboard(contextText, 'tab_context');
            else if (activeTab === 'aistudio') copyToClipboard(fullAiStudioPrompt, 'tab_aistudio');
            else if (activeTab === 'caption') copyToClipboard(activeCaption, 'tab_caption');
          }}
          className="px-3 py-1.5 rounded-lg text-xs font-bold bg-slate-800 hover:bg-slate-700 text-slate-200 transition-all border border-slate-700 flex items-center gap-1.5"
        >
          {copiedField?.startsWith('tab_') ? (
            <>
              <Check className="w-3.5 h-3.5 text-emerald-400" />
              <span className="text-emerald-400">Copied Tab!</span>
            </>
          ) : (
            <>
              <Copy className="w-3.5 h-3.5 text-slate-400" />
              <span>Copy Active Tab</span>
            </>
          )}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto pr-1">
        
        {/* 1. KOTAK SCENE (TIMELINE BREAKDOWN) */}
        {activeTab === 'scenes' && (
          <div className="space-y-3">
            {Array.isArray(result.scenes) && result.scenes.length > 0 ? (
              result.scenes.map((scene) => {
                const beat = getSceneBeatBadge(scene.sceneNumber, result.scenes.length);
                return (
                  <div
                    key={scene.sceneNumber || Math.random()}
                    className="p-3.5 rounded-xl bg-slate-950/70 border border-slate-800/80 hover:border-slate-700 transition-all flex flex-col gap-2 relative group"
                  >
                    <div className="flex items-center justify-between flex-wrap gap-2">
                      <div className="flex items-center gap-2">
                        <span className="px-2 py-0.5 rounded bg-shopee-500/20 text-shopee-400 font-bold text-[11px] border border-shopee-500/30">
                          SCENE {scene.sceneNumber}
                        </span>
                        <span className="text-[11px] font-mono text-slate-400">{scene.timeRange}</span>
                        <span className={`px-2 py-0.5 rounded text-[10px] font-bold border ${beat.color}`}>
                          {beat.label}
                        </span>
                      </div>

                      <button
                        onClick={() =>
                          copyToClipboard(
                            `[SCENE ${scene.sceneNumber} (${scene.timeRange})]\nVisual: ${scene.visualDescription}\nVoiceover: "${scene.voiceover}"\nNotes: ${scene.adAdvisorNotes || '-'}`,
                            `scene_${scene.sceneNumber}`
                          )
                        }
                        className="opacity-0 group-hover:opacity-100 transition-opacity text-[10px] text-slate-400 hover:text-white flex items-center gap-1 bg-slate-800 px-2 py-0.5 rounded border border-slate-700"
                      >
                        {copiedField === `scene_${scene.sceneNumber}` ? (
                          <Check className="w-3 h-3 text-emerald-400" />
                        ) : (
                          <Copy className="w-3 h-3" />
                        )}
                        <span>Copy</span>
                      </button>
                    </div>

                    <div className="space-y-1.5 text-xs">
                      <div>
                        <span className="text-slate-400 font-semibold">Visual Shot: </span>
                        <span className="text-slate-200">{scene.visualDescription}</span>
                      </div>

                      <div className="p-2 rounded-lg bg-slate-900/90 border border-indigo-950/60">
                        <span className="text-indigo-400 font-semibold block mb-0.5">Voiceover Narasi:</span>
                        <p className="text-indigo-100 italic">"{scene.voiceover}"</p>
                      </div>

                      {scene.adAdvisorNotes && (
                        <div className="text-[11px] text-amber-300/90 flex items-start gap-1">
                          <span className="font-semibold text-amber-400">💡 Notes:</span>
                          <span>{scene.adAdvisorNotes}</span>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })
            ) : (
              <p className="text-xs text-slate-400">Tidak ada data kotak scene.</p>
            )}
          </div>
        )}

        {/* 2. VOICEOVER SCRIPT (AD ADVISOR FORMAT) */}
        {activeTab === 'script' && (
          <div className="relative flex-1 flex flex-col">
            <div className="mb-2 text-[11px] text-slate-400 flex items-center gap-1 flex-wrap">
              <span>Formula Shopee FYP:</span>
              <span className="text-amber-300 font-bold">[HOOK MASALAH 0-3s]</span>
              <span>→</span>
              <span className="text-indigo-300 font-bold">[HERO SOLUTION]</span>
              <span>→</span>
              <span className="text-sky-300 font-bold">[DEMO SATISFYING]</span>
              <span>→</span>
              <span className="text-emerald-300 font-bold">[HARGA &amp; CTA KERANJANG]</span>
            </div>
            <textarea
              readOnly
              value={result.voiceoverScript}
              rows={13}
              className="w-full flex-1 min-h-[280px] bg-slate-950/90 border border-slate-800 rounded-xl p-4 text-xs text-slate-200 font-mono leading-relaxed focus:outline-none focus:ring-1 focus:ring-indigo-500/50 resize-none select-all"
            />
          </div>
        )}

        {/* 3. SAMPLE CONTEXT */}
        {activeTab === 'context' && (
          <div className="p-4 rounded-xl bg-slate-950/80 border border-slate-800 space-y-3.5 text-xs">
            <div className="flex items-start justify-between gap-2 flex-wrap">
              <div>
                <span className="text-slate-400 font-semibold block mb-1">Nama Produk:</span>
                <p className="text-slate-100 font-bold text-sm">
                  {result.sampleContext?.productName || result.videoTitle}
                </p>
              </div>
              <div className="px-3 py-1.5 rounded-lg bg-indigo-950/40 border border-indigo-500/30 flex items-center gap-1.5 text-indigo-300">
                <Clock className="w-3.5 h-3.5 text-indigo-400" />
                <span className="font-semibold text-xs">Durasi: {formattedDuration}</span>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="p-3 rounded-lg bg-slate-900 border border-slate-800">
                <span className="text-slate-400 font-semibold block mb-1 flex items-center gap-1">
                  <Target className="w-3.5 h-3.5 text-amber-400" />
                  Target Audiens:
                </span>
                <p className="text-slate-200">{result.sampleContext?.targetAudience || '-'}</p>
              </div>

              <div className="p-3 rounded-lg bg-slate-900 border border-slate-800">
                <span className="text-slate-400 font-semibold block mb-1 flex items-center gap-1">
                  <HelpCircle className="w-3.5 h-3.5 text-rose-400" />
                  Masalah Utama (Pain Point):
                </span>
                <p className="text-slate-200">{result.sampleContext?.coreProblem || '-'}</p>
              </div>
            </div>

            {Array.isArray(result.sampleContext?.keyFeatures) && (
              <div>
                <span className="text-slate-400 font-semibold block mb-1.5">Keunggulan Utama (USPs):</span>
                <div className="flex flex-wrap gap-1.5">
                  {result.sampleContext.keyFeatures.map((feat, i) => (
                    <span
                      key={i}
                      className="px-2.5 py-1 rounded-md bg-slate-900 border border-slate-700 text-slate-200 text-xs font-medium"
                    >
                      ✓ {feat}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {result.sampleContext?.buyingTrigger && (
              <div className="p-3 rounded-lg bg-emerald-950/30 border border-emerald-500/30 text-emerald-300">
                <span className="font-bold block mb-0.5">Trigger Pembelian (Psychological Hook):</span>
                <span>{result.sampleContext.buyingTrigger}</span>
              </div>
            )}
          </div>
        )}

        {/* 4. AI STUDIO / GEMINI PROMPT TEMPLATE (3 KOTAK TERPISAH) */}
        {activeTab === 'aistudio' && (
          <div className="flex-1 flex flex-col space-y-3.5">
            {/* Header Toolbar */}
            <div className="flex items-center justify-between text-[11px] text-slate-400 bg-slate-900/70 p-2.5 rounded-xl border border-slate-800 flex-wrap gap-2">
              <span className="flex items-center gap-1.5 text-slate-300 font-medium">
                <Sparkles className="w-3.5 h-3.5 text-amber-400" />
                <span>Format 3 Blok Google AI Studio (Audio Generation):</span>
              </span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => copyToClipboard(fullAiStudioPrompt, 'aistudio_all')}
                  className="px-2.5 py-1 rounded-md bg-slate-800 hover:bg-slate-700 text-slate-200 text-[10px] font-semibold flex items-center gap-1 border border-slate-700 transition-colors"
                >
                  {copiedField === 'aistudio_all' ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                  <span>{copiedField === 'aistudio_all' ? 'Tersalin Semua!' : 'Copy Semua'}</span>
                </button>
                <a
                  href="https://aistudio.google.com"
                  target="_blank"
                  rel="noreferrer"
                  className="px-2.5 py-1 rounded-md bg-emerald-950/40 hover:bg-emerald-900/50 text-emerald-400 text-[10px] font-semibold flex items-center gap-1 border border-emerald-500/30 transition-colors"
                >
                  <span>Buka AI Studio</span>
                  <ExternalLink className="w-3 h-3" />
                </a>
              </div>
            </div>

            {/* KOTAK 1: SCENE */}
            <div className="rounded-xl bg-slate-950/90 border border-indigo-900/40 p-3.5 flex flex-col space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-indigo-300 flex items-center gap-1.5">
                  <span className="w-4 h-4 rounded-full bg-indigo-500/20 text-indigo-300 text-[10px] flex items-center justify-center font-bold">1</span>
                  <span>Scene (Latar Belakang & Suasana)</span>
                </span>
                <button
                  onClick={() => copyToClipboard(aiStudioSections.scene, 'aistudio_scene')}
                  className="px-2.5 py-1 rounded-md bg-slate-900 hover:bg-indigo-600/30 text-indigo-300 hover:text-indigo-200 border border-indigo-500/30 text-[10px] font-semibold flex items-center gap-1 transition-all"
                >
                  {copiedField === 'aistudio_scene' ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                  <span>{copiedField === 'aistudio_scene' ? 'Tersalin!' : 'Copy Scene'}</span>
                </button>
              </div>
              <textarea
                readOnly
                value={aiStudioSections.scene}
                rows={2}
                className="w-full bg-slate-900/70 border border-slate-800 rounded-lg p-2.5 text-xs text-slate-200 font-mono leading-relaxed focus:outline-none focus:ring-1 focus:ring-indigo-500/40 resize-none select-all"
              />
            </div>

            {/* KOTAK 2: SAMPLE CONTEXT */}
            <div className="rounded-xl bg-slate-950/90 border border-amber-900/40 p-3.5 flex flex-col space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-amber-300 flex items-center gap-1.5">
                  <span className="w-4 h-4 rounded-full bg-amber-500/20 text-amber-300 text-[10px] flex items-center justify-center font-bold">2</span>
                  <span>Sample Context (Gaya Bicara, Pacing & Nada Iklan)</span>
                </span>
                <button
                  onClick={() => copyToClipboard(aiStudioSections.context, 'aistudio_context')}
                  className="px-2.5 py-1 rounded-md bg-slate-900 hover:bg-amber-600/30 text-amber-300 hover:text-amber-200 border border-amber-500/30 text-[10px] font-semibold flex items-center gap-1 transition-all"
                >
                  {copiedField === 'aistudio_context' ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                  <span>{copiedField === 'aistudio_context' ? 'Tersalin!' : 'Copy Context'}</span>
                </button>
              </div>
              <textarea
                readOnly
                value={aiStudioSections.context}
                rows={2}
                className="w-full bg-slate-900/70 border border-slate-800 rounded-lg p-2.5 text-xs text-slate-200 font-mono leading-relaxed focus:outline-none focus:ring-1 focus:ring-amber-500/40 resize-none select-all"
              />
            </div>

            {/* KOTAK 3: SPEAKER 1 */}
            <div className="rounded-xl bg-slate-950/90 border border-emerald-900/40 p-3.5 flex flex-col space-y-2 flex-1">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-emerald-300 flex items-center gap-1.5">
                  <span className="w-4 h-4 rounded-full bg-emerald-500/20 text-emerald-300 text-[10px] flex items-center justify-center font-bold">3</span>
                  <Volume2 className="w-3.5 h-3.5 text-emerald-400" />
                  <span>Speaker 1 (Naskah Narasi dengan Timestamp & Emotion Tags)</span>
                </span>
                <button
                  onClick={() => copyToClipboard(aiStudioSections.speaker, 'aistudio_speaker')}
                  className="px-2.5 py-1 rounded-md bg-slate-900 hover:bg-emerald-600/30 text-emerald-300 hover:text-emerald-200 border border-emerald-500/30 text-[10px] font-semibold flex items-center gap-1 transition-all"
                >
                  {copiedField === 'aistudio_speaker' ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                  <span>{copiedField === 'aistudio_speaker' ? 'Tersalin!' : 'Copy Speaker 1'}</span>
                </button>
              </div>
              <textarea
                readOnly
                value={aiStudioSections.speaker}
                rows={6}
                className="w-full flex-1 min-h-[140px] bg-slate-900/70 border border-slate-800 rounded-lg p-2.5 text-xs text-emerald-200 font-mono leading-relaxed focus:outline-none focus:ring-1 focus:ring-emerald-500/40 resize-none select-all"
              />
            </div>
          </div>
        )}

        {/* 5. REELS CAPTION & HASHTAGS */}
        {activeTab === 'caption' && (
          <div className="relative flex-1 flex flex-col space-y-2">
            <div className="flex items-center justify-between text-[11px] text-slate-400 px-1">
              <span>Siap posting ke Reels / TikTok / Shopee Video</span>
              {userEditedCaption !== null && (
                <button
                  onClick={() => setUserEditedCaption(null)}
                  className="text-rose-400 hover:text-rose-300 underline text-[11px]"
                >
                  Reset ke Asli
                </button>
              )}
            </div>
            <textarea
              value={activeCaption}
              onChange={(e) => setUserEditedCaption(e.target.value)}
              rows={13}
              placeholder="Ketik atau edit caption di sini..."
              className="w-full flex-1 min-h-[280px] bg-slate-950/90 border border-slate-800 rounded-xl p-4 text-xs text-slate-200 font-sans leading-relaxed focus:outline-none focus:ring-1 focus:ring-emerald-500/50 resize-none"
            />
          </div>
        )}

      </div>

      {/* Embedded Shopee Link Quick Access */}
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
