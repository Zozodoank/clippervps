// Prompt contract consumed by Oracle lokal Qwen (VPS); no local vision inference lives here.
export function buildVlmPrompt(niche = 'kitchen_tools', facePolicy = 'strict', { productName = '', requireRanking = false } = {}) {
  const faceRule = facePolicy === 'presenter_only'
    ? 'Camera-sample policy: people appearing inside photos or video footage captured by the reviewed phone are allowed, including portraits and bystanders. REJECT only a reviewer/vlogger/presenter who is filming themselves and speaking directly to the camera. A face inside the phone camera sample is not a presenter.'
    : 'REJECT if any human face is visible.';
  const lines = [
    'Inspect ALL frames below for this short scene.',
    'REJECT the scene if ANY frame contains:',
    '- a burned-in subtitle or on-screen text overlay',
    '- a watermark or channel logo / identity',
    '- a graphic overlay (arrows, circles, stickers, banners)',
    '- an unboxing / paperwork / manual document',
    `Face policy: ${faceRule}`,
    'Hands and product demonstration are allowed.',
    ...(niche === 'gadget_smartphone' && facePolicy === 'presenter_only' ? ['For smartphone camera-review scenes, evaluate the captured sample footage as the phone camera result; do not classify its human subjects as a vlogger.'] : []),
  ];
  if (requireRanking) {
    const core = oneLineForPrompt(productName, 120);
    lines.push(`PRODUCT UNDER TEST: "${core}".`);
    lines.push('Set productMatch=true ONLY if the frames clearly show that product (same kind of item), not just any gadget in the same category.');
    lines.push('matchScore = 0-100 confidence that the PRODUCT UNDER TEST is shown being used as intended (0 = wrong or unrelated product, 100 = unmistakably that product doing its job).');
    lines.push('apparentQuality = 0-100 estimate of the SOURCE video picture quality visible in these frames (100 = sharp and clean, 0 = heavily blurred, blocky, pixelated or double-compressed). Judge ONLY what is visible in the frames; NEVER guess an exact pixel resolution.');
    lines.push('Answer with ONLY a compact JSON object, no prose:');
    lines.push('{"safe":true|false,"face":true|false,"text":true|false,"watermark":true|false,"graphic":true|false,"productMatch":true|false,"matchScore":0-100,"apparentQuality":0-100,"reason":"very short"}');
  } else {
    lines.push('Answer with ONLY a compact JSON object, no prose:');
    lines.push('{"safe":true|false,"face":true|false,"text":true|false,"watermark":true|false,"graphic":true|false,"reason":"very short"}');
  }
  return lines.join('\n');
}


function oneLineForPrompt(value, max = 120) {
  const s = String(value == null ? '' : value)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/["`]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  return s.slice(0, max);
}
