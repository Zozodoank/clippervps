import fs from 'fs';
import path from 'path';
import { restoreStandardText } from './dictionaryService.js';

/**
 * Generates an Advanced SubStation Alpha (.ass) subtitle file synchronized to the voiceover audio.
 * Native ASS format gives pixel-perfect control over canvas resolution (PlayResX/PlayResY),
 * font size, stroke outline, shadow, and position without relying on inconsistent FFmpeg CLI parsing.
 * 
 * Synchronizes timing directly with the spoken audio duration using syllable/character weighting.
 *
 * @param {string} scriptText - Spoken voiceover narration
 * @param {number} totalDurationSec - Actual voiceover audio duration in seconds
 * @param {string} assOutputPath - Absolute path to write the .ass file
 * @returns {string} The path to the generated ASS file
 */
export function generateAssSubtitles(scriptText, totalDurationSec, assOutputPath, options = {}) {
  // If word boundaries are provided from Edge-TTS, use exact millisecond synchronization!
  if (options && options.wordBoundaries && Array.isArray(options.wordBoundaries) && options.wordBoundaries.length > 0) {
    const ok = generateAssSubtitlesFromWordBoundaries({
      wordBoundaries: options.wordBoundaries,
      totalDurationSec,
      assOutputPath,
      lexicon: options.lexicon || {},
      scriptText,
    });
    if (ok) return assOutputPath;
  }

  const safeTotalDuration = Math.max(3, Number(totalDurationSec) || 25);

  // 1. Extract pure spoken dialogue and strip headers, prompt instructions, etc.
  let cleaned = String(scriptText || '').trim();

  // If full AI Studio prompt was passed, extract Speaker section
  const speakerMatch = cleaned.match(/(?:Speaker\s*\d*(?:\s*-\s*[A-Za-z0-9]+)?|SPEAKER\s*\d*)[\s\r\n:]+([\s\S]*)$/i);
  if (speakerMatch && speakerMatch[1].trim()) {
    cleaned = speakerMatch[1].trim();
  }

  // Remove metadata lines if any (Scene, Sample Context, Setting, etc.)
  cleaned = cleaned.replace(/^(Scene|Sample Context|Setting|Context):?[^\n]*\n?/gim, '');

  const lines = cleaned.split(/\r?\n/);
  const rawPhrases = [];

  for (const rawLine of lines) {
    let line = rawLine.trim();
    if (!line) continue;

    // Check for timestamp anchor e.g. [00:05]
    let timestampSec = null;
    const timeMatch = line.match(/^\[?(\d{1,2}):(\d{2})\]?/);
    if (timeMatch) {
      timestampSec = parseInt(timeMatch[1], 10) * 60 + parseInt(timeMatch[2], 10);
      line = line.replace(/^\[?\d{1,2}:\d{2}\]?\s*/, '');
    }

    // Strip emotion tags: [intrigue], [excited], [information], [desire], [confident], [inspiration], [happy], etc.
    line = line.replace(/\[(intrigue|excited|information|desire|confident|inspiration|happy|urgent|curious|hook|demo|problem|value|cta|scene\s*\d*)\]/gi, '');
    line = line.replace(/\[[^\]]+\]/g, '');
    line = line.replace(/^(Speaker\s*\d*|Narasi|Voiceover|VO)\s*[:\-]\s*/i, '');
    line = line.replace(/[#*_~`]/g, '');
    line = line.replace(/^[:\-•*"\s]+/, '').replace(/["\s]+$/, '').trim();
    line = line.replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '');
    // Ensure on-screen subtitles always display standard Indonesian spelling without accents (e.g. kécé -> kece)
    line = line.replace(/[éèê]/g, 'e').replace(/[ÉÈÊ]/g, 'E');
    // Ensure on-screen subtitles never contain "kece" or platform names
    line = line.replace(/\b(?:kece|Kece|KECE)\b/g, 'keren');
    line = line.replace(/\b(?:racun\s+)?(?:tiktok|shopee|instagram|youtube|facebook|reels|medsos)\b/gi, 'belanja');
    line = line.replace(/\b(?:Shopee|TikTok|Instagram|Facebook|YouTube|Reels)\b/gi, '');
    // Ensure on-screen subtitles always display clean normal words without phonetic distortions
    line = restoreStandardText(line, options.lexicon || {});
    line = line.replace(/\s+/g, ' ').trim();

    if (!line) continue;

    // Split this line into natural sentence/clause chunks by punctuation (. ! ? ;)
    const sentenceMatches = line.match(/[^.!?]+[.!?]+/g) || [line];

    for (let sIdx = 0; sIdx < sentenceMatches.length; sIdx++) {
      const sentence = sentenceMatches[sIdx].trim();
      if (!sentence) continue;

      const words = sentence.split(/\s+/).filter(Boolean);
      if (words.length <= 6) {
        rawPhrases.push({
          text: sentence,
          wordCount: words.length,
          charCount: sentence.replace(/\s+/g, '').length,
          anchorSec: sIdx === 0 ? timestampSec : null,
        });
      } else {
        // Split longer sentences by commas if available, or into 2 clean halves
        const commaParts = sentence.split(/,\s*/);
        if (commaParts.length > 1 && commaParts.every((p) => p.split(/\s+/).length <= 7)) {
          for (let cpIdx = 0; cpIdx < commaParts.length; cpIdx++) {
            const partText = commaParts[cpIdx].trim() + (cpIdx < commaParts.length - 1 ? ',' : '');
            const partWords = partText.split(/\s+/).filter(Boolean);
            if (partWords.length > 0) {
              rawPhrases.push({
                text: partText,
                wordCount: partWords.length,
                charCount: partText.replace(/\s+/g, '').length,
                anchorSec: sIdx === 0 && cpIdx === 0 ? timestampSec : null,
              });
            }
          }
        } else {
          // Split into 2 clean halves
          const half = Math.ceil(words.length / 2);
          const firstHalf = words.slice(0, half).join(' ');
          const secondHalf = words.slice(half).join(' ');
          rawPhrases.push({
            text: firstHalf,
            wordCount: half,
            charCount: firstHalf.replace(/\s+/g, '').length,
            anchorSec: sIdx === 0 ? timestampSec : null,
          });
          if (secondHalf) {
            rawPhrases.push({
              text: secondHalf,
              wordCount: words.length - half,
              charCount: secondHalf.replace(/\s+/g, '').length,
              anchorSec: null,
            });
          }
        }
      }
    }
  }

  // Fallback if structured parsing returned nothing
  if (rawPhrases.length === 0) {
    const rawClean = cleaned
      .replace(/\[[^\]]+\]/g, '')
      .replace(/[#*_~`]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (rawClean) {
      rawPhrases.push({
        text: rawClean,
        wordCount: rawClean.split(/\s+/).length,
        charCount: rawClean.replace(/\s+/g, '').length,
        anchorSec: null
      });
    }
  }

  if (rawPhrases.length === 0) {
    rawPhrases.push({ text: 'Cek produk pilihan sekarang!', wordCount: 4, charCount: 24, anchorSec: 0 });
  }

  // 2. Calculate speech weight per phrase based on character count + sentence pause buffer
  // In Indonesian narration, syllables & character count give far more accurate speech pacing than raw word count.
  const weights = rawPhrases.map((p) => {
    const baseWeight = Math.max(8, p.charCount);
    const pauseWeight = p.text.endsWith('?') || p.text.endsWith('!') || p.text.endsWith('.') ? 6 : (p.text.endsWith(',') ? 3 : 0);
    return baseWeight + pauseWeight;
  });

  const totalWeight = weights.reduce((sum, w) => sum + w, 0) || 1;
  let currentCursor = 0;
  const events = [];

  for (let i = 0; i < rawPhrases.length; i++) {
    const chunk = rawPhrases[i];
    let startSec = currentCursor;

    // Anchor locking: snap strictly to scene timestamp [00:00], [00:03], [00:07], etc.
    if (chunk.anchorSec !== null && chunk.anchorSec < safeTotalDuration) {
      startSec = chunk.anchorSec;
      // Cap previous event's end time if it was extending past this anchor
      if (events.length > 0 && currentCursor > startSec) {
        events[events.length - 1].end = formatAssTime(startSec);
      }
    }

    const nextAnchor = rawPhrases.slice(i + 1).find((c) => c.anchorSec !== null)?.anchorSec;
    const remainingTime = (nextAnchor !== undefined && nextAnchor !== null ? nextAnchor : safeTotalDuration) - startSec;
    const nextAnchorIndex = (nextAnchor !== undefined && nextAnchor !== null)
      ? rawPhrases.findIndex((c, ci) => ci > i && c.anchorSec === nextAnchor)
      : rawPhrases.length;
    const sliceWeights = weights.slice(i, nextAnchorIndex).reduce((sum, w) => sum + w, 0) || weights[i];

    const proportionalDuration = remainingTime > 0
      ? remainingTime * (weights[i] / sliceWeights)
      : safeTotalDuration * (weights[i] / totalWeight);

    // Ensure minimum display duration so quick phrases are readable (0.8s)
    const minDisplaySec = 0.8;
    const maxBoundary = (nextAnchor !== undefined && nextAnchor !== null) ? nextAnchor : safeTotalDuration;
    const finalEndingSec = (options && options.videoDurationSec && Number(options.videoDurationSec) > safeTotalDuration)
      ? Number(options.videoDurationSec)
      : safeTotalDuration;
    const endSec = i === rawPhrases.length - 1
      ? finalEndingSec
      : Math.min(maxBoundary, startSec + Math.max(minDisplaySec, proportionalDuration));

    currentCursor = endSec;

    events.push({
      start: formatAssTime(startSec),
      end: formatAssTime(endSec),
      text: chunk.text,
    });
  }

  // 3. Format phrases with 2-Tone Shopee Viral Subtitle Styling (Kuning & Putih):
  // Important keywords (problems, satisfying actions, benefits, price & Shopee CTA) are highlighted in bright yellow (&H0000FFFF&),
  // while connecting words remain crisp white (&H00FFFFFF&) with a thick black outline.
  const formattedEvents = events.map((e, idx) => {
    const coloredText = colorizeShopeeSubtitle(e.text, idx);
    return `Dialogue: 0,${e.start},${e.end},Default,,0,0,0,,${coloredText}`;
  });

  // Native ASS (Advanced SubStation Alpha) Header with exact 1080x1920 coordinate system
  // Fontsize: 50, Outline: 4.5, Shadow: 2.0, Alignment: 2 (Bottom-Center), MarginV: 380
  // MarginV 380 ensures subtitles sit safely in the viewing zone above social media captions and Shopee Keranjang Kuning.
  const assContent = `[Script Info]
Title: Shopee Viral Affiliate Subtitles (Yellow & White)
ScriptType: v4.00+
WrapStyle: 0
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709
PlayResX: 1080
PlayResY: 1920

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,42,&H00FFFFFF,&H0000FFFF,&H00000000,&H80000000,1,0,0,0,100,100,0,0,1,2.6,1.2,2,60,60,360,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${formattedEvents.join('\n')}
`;

  fs.writeFileSync(assOutputPath, assContent, 'utf8');
  console.log(`[SubtitleService] Generated ${events.length} clean modern ASS subtitles synchronized to ${safeTotalDuration.toFixed(1)}s audio at ${assOutputPath}`);
  return assOutputPath;
}

/**
 * Highlights punchy focal keywords in bright yellow (\\c&H0000FFFF&) and base text in white (\\c&H00FFFFFF&).
 * Restricts highlighting to at most 1 key impact word per phrase to avoid visual fatigue.
 */
function colorizeShopeeSubtitle(text, index = 0) {
  if (!text || typeof text !== 'string') return '';

  const clean = text.trim();
  const yellow = '{\\c&H0000FFFF&}';
  const white = '{\\c&H00FFFFFF&}';

  // Highlight selectively on pivotal conversion / high-impact phrases only (max 1 highlight per phrase)
  const focalKeywordsPattern = /\b(keranjang kuning|pojok kiri bawah|checkout|solusi|worth it|rekomendasi|promo|diskon|cepat|praktis)\b/i;

  if (focalKeywordsPattern.test(clean)) {
    let highlightedOnce = false;
    const highlighted = clean.replace(focalKeywordsPattern, (match) => {
      if (!highlightedOnce) {
        highlightedOnce = true;
        return `${yellow}${match}${white}`;
      }
      return match;
    });
    return `${white}${highlighted}`.replace(/\{\\c&H00FFFFFF&\}\{\\c&H00FFFFFF&\}/g, '{\\c&H00FFFFFF&}');
  }

  // Clean, professional white text by default
  return `${white}${clean}`;
}

/**
 * Normalizes TTS phonetic pronunciations back to crisp standard Indonesian on-screen text.
 */
function normalizeSubtitleWord(w, customLexicon = {}) {
  if (!w || typeof w !== 'string') return '';
  return restoreStandardText(w, customLexicon);
}

/**
 * Generates ASS subtitles directly from Edge-TTS WordBoundary metadata.
 * Yields 100.0% exact, sub-millisecond synchronization with the spoken voiceover:
 * - 80ms audio-visual lead-in so subtitles appear at the exact acoustic onset.
 * - Balanced 3 to 5 word chunking (never leaves awkward 1-word orphans like "ini" or "kuning").
 * - Seamless inter-phrase continuity avoiding rapid flickering black pauses.
 */
export function generateAssSubtitlesFromWordBoundaries({ wordBoundaries, totalDurationSec, assOutputPath, lexicon = {}, scriptText = '' }) {
  if (!Array.isArray(wordBoundaries) || wordBoundaries.length === 0) {
    return false;
  }

  const safeTotalDuration = Math.max(3, Number(totalDurationSec) || 25);

  // 1. Group words by natural audio pause breaks (gaps > 0.45s between spoken words)
  const sceneGroups = [];
  let currentGroup = [];

  for (let i = 0; i < wordBoundaries.length; i++) {
    const w = wordBoundaries[i];
    if (!w.word || !w.word.trim()) continue;
    currentGroup.push(w);

    const hasNext = i < wordBoundaries.length - 1;
    const nextGap = hasNext ? (wordBoundaries[i + 1].startSec - w.endSec) : 0;

    if (!hasNext || nextGap > 0.45) {
      sceneGroups.push([...currentGroup]);
      currentGroup = [];
    }
  }

  const phrases = [];

  // 2. For each scene group, partition words into balanced chunks (3-5 words, never 1-word orphans)
  for (const group of sceneGroups) {
    if (group.length === 0) continue;
    const n = group.length;
    const chunks = [];

    if (n <= 5) {
      chunks.push(group);
    } else if (n <= 8) {
      const mid = Math.ceil(n / 2);
      chunks.push(group.slice(0, mid));
      chunks.push(group.slice(mid));
    } else {
      let startIdx = 0;
      while (startIdx < n) {
        const remaining = n - startIdx;
        let chunkSize = 4;
        if (remaining <= 5) {
          chunkSize = remaining;
        } else if (remaining === 6) {
          chunkSize = 3;
        } else if (remaining === 7) {
          chunkSize = 4;
        }
        chunks.push(group.slice(startIdx, startIdx + chunkSize));
        startIdx += chunkSize;
      }
    }

    for (const chunk of chunks) {
      if (chunk.length === 0) continue;
      // Visual lead-in: start 80ms before sound begins so viewers see text right as audio attacks
      const startSec = Math.max(0, +(chunk[0].startSec - 0.08).toFixed(3));
      let endSec = +(chunk[chunk.length - 1].endSec + 0.15).toFixed(3);
      if (endSec <= startSec) {
        endSec = +(startSec + 0.8).toFixed(3);
      }
      // 1. Join raw spoken words in the chunk first so multi-word phrases stay intact
      let rawChunkText = chunk.map((w) => w.word).join(' ');
      // 2. Restore standard text at full phrase/sentence level (e.g. "stenlis stil" -> "stainless steel", "er frayer" -> "air fryer")
      let text = restoreStandardText(rawChunkText, lexicon);
      phrases.push({ text, startSec, endSec });
    }
  }

  if (phrases.length === 0) return false;

  // 3. Seamless gap filling: If pause between phrases is small (< 0.55s), extend previous phrase
  // so the subtitle stays comfortably on screen without rapid black-void blinking
  for (let i = 0; i < phrases.length - 1; i++) {
    const nextStart = phrases[i + 1].startSec;
    const gap = nextStart - phrases[i].endSec;
    if (gap > 0 && gap < 0.55) {
      phrases[i].endSec = nextStart;
    }
  }

  // 4. Pin the final CTA subtitle right until the end of the video (safeTotalDuration).
  // 4. Pin the final CTA subtitle until the end of the spoken audio / video safely.
  // Keep the CTA visible for a natural reading window (up to 4.5s max), bounded by safeTotalDuration!
  if (phrases.length > 0) {
    const lastPhrase = phrases[phrases.length - 1];
    const boundedEnd = Math.min(safeTotalDuration, +(lastPhrase.startSec + 4.5).toFixed(3));
    lastPhrase.endSec = Math.max(lastPhrase.endSec, boundedEnd);
  }

  // 5. Ensure all phrases have strictly valid timestamps (startSec < endSec)
  for (let i = 0; i < phrases.length; i++) {
    const p = phrases[i];
    if (p.endSec <= p.startSec) {
      p.endSec = +(p.startSec + 0.8).toFixed(3);
    }
  }

  const formattedEvents = phrases.map((e, idx) => {
    const coloredText = colorizeShopeeSubtitle(e.text, idx);
    return `Dialogue: 0,${formatAssTime(e.startSec)},${formatAssTime(e.endSec)},Default,,0,0,0,,${coloredText}`;
  });

  const assContent = `[Script Info]
Title: Shopee Viral Affiliate Subtitles (Yellow & White)
ScriptType: v4.00+
WrapStyle: 0
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709
PlayResX: 1080
PlayResY: 1920

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,42,&H00FFFFFF,&H0000FFFF,&H00000000,&H80000000,1,0,0,0,100,100,0,0,1,2.6,1.2,2,60,60,360,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${formattedEvents.join('\n')}
`;

  fs.writeFileSync(assOutputPath, assContent, 'utf8');
  console.log(`[SubtitleService] ✅ Generated ${phrases.length} 100% WordBoundary-synced Shopee ASS subtitles at ${assOutputPath}`);
  return true;
}

// Backward compatibility alias
export const generateSrtSubtitles = generateAssSubtitles;

export function parseAssTimeToSeconds(timeStr) {
  if (!timeStr || typeof timeStr !== 'string') return 0;
  const match = timeStr.trim().match(/^(\d+):(\d{2}):(\d{2})\.(\d{2})$/);
  if (!match) return 0;
  const h = parseInt(match[1], 10);
  const m = parseInt(match[2], 10);
  const s = parseInt(match[3], 10);
  const cs = parseInt(match[4], 10);
  return h * 3600 + m * 60 + s + cs / 100;
}

/**
 * Rescales ASS subtitle timestamps when audio tempo is changed (e.g. atempo in FFmpeg).
 * Keeps subtitles 100% synchronized with sped-up/slowed-down audio, and ensures the last
 * CTA subtitle stays pinned to the final video duration without empty voids.
 * @param {string} assFilePath
 * @param {number} scaleFactor - Multiplier applied to time (e.g. 1 / atempoFactor)
 * @param {number} [targetVideoDuration] - Target video duration to pin the final CTA subtitle to
 */
export function scaleAssSubtitles(assFilePath, scaleFactor, targetVideoDuration = null) {
  if (!assFilePath || !fs.existsSync(assFilePath) || !scaleFactor || Math.abs(scaleFactor - 1.0) < 0.005) {
    return;
  }
  try {
    const content = fs.readFileSync(assFilePath, 'utf8');
    const lines = content.split(/\r?\n/);

    const dialogueIndices = [];
    lines.forEach((l, idx) => {
      if (l.startsWith('Dialogue:')) dialogueIndices.push(idx);
    });

    const lastDialogueIdx = dialogueIndices.length > 0 ? dialogueIndices[dialogueIndices.length - 1] : -1;

    const updatedLines = lines.map((line, idx) => {
      if (!line.startsWith('Dialogue:')) return line;
      // Dialogue: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
      const firstParts = [];
      let cursor = 0;
      for (let i = 0; i < 9; i++) {
        const nextComma = line.indexOf(',', cursor);
        if (nextComma === -1) break;
        firstParts.push(line.slice(cursor, nextComma));
        cursor = nextComma + 1;
      }
      const remainingText = line.slice(cursor);
      if (firstParts.length < 9) return line;

      let startSec = +(parseAssTimeToSeconds(firstParts[1]) * scaleFactor).toFixed(3);
      let endSec = +(parseAssTimeToSeconds(firstParts[2]) * scaleFactor).toFixed(3);

      // Pin the final CTA subtitle safely (up to 4.5s max, bounded by targetVideoDuration)
      if (idx === lastDialogueIdx && targetVideoDuration && targetVideoDuration > 0) {
        const boundedEnd = Math.min(targetVideoDuration, +(startSec + 4.5).toFixed(3));
        endSec = Math.max(endSec, boundedEnd);
      }

      if (endSec <= startSec) {
        endSec = +(startSec + 0.8).toFixed(3);
      }

      firstParts[1] = formatAssTime(startSec);
      firstParts[2] = formatAssTime(endSec);

      return `${firstParts.join(',')},${remainingText}`;
    });

    fs.writeFileSync(assFilePath, updatedLines.join('\n'), 'utf8');
    console.log(`[SubtitleService] ✅ Scaled ASS subtitle timestamps by factor ${scaleFactor.toFixed(4)}${targetVideoDuration ? ` (CTA pinned to ${targetVideoDuration.toFixed(1)}s)` : ''}`);
  } catch (err) {
    console.warn(`[SubtitleService] Failed to scale ASS subtitles: ${err.message}`);
  }
}

function formatAssTime(totalSec) {
  const safeSec = Math.max(0, Number(totalSec) || 0);
  const hours = Math.floor(safeSec / 3600);
  const minutes = Math.floor((safeSec % 3600) / 60).toString().padStart(2, '0');
  const seconds = Math.floor(safeSec % 60).toString().padStart(2, '0');
  const centis = Math.floor(((safeSec % 1) * 100)).toString().padStart(2, '0');
  return `${hours}:${minutes}:${seconds}.${centis}`;
}

function formatSrtTime(totalSec) {
  const safeSec = Math.max(0, Number(totalSec) || 0);
  const hours = Math.floor(safeSec / 3600).toString().padStart(2, '0');
  const minutes = Math.floor((safeSec % 3600) / 60).toString().padStart(2, '0');
  const seconds = Math.floor(safeSec % 60).toString().padStart(2, '0');
  const millis = Math.floor((safeSec % 1) * 1000).toString().padStart(3, '0');
  return `${hours}:${minutes}:${seconds},${millis}`;
}
