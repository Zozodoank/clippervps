const fs = require('fs');
let code = fs.readFileSync('server/services/videoRenderer.js', 'utf8');

// 1. Add isAutoModeFallback = true to renderSilentAntiDetectionVideo args
code = code.replace(
  '  onProgress = () => {}\n}) {',
  '  onProgress = () => {},\n  isAutoModeFallback = true\n}) {'
);

// 2. Pass it to normalizeRenderClips
code = code.replace(
  'const selectedClips = normalizeRenderClips(clips, startTime, endTime, reframe);',
  'const selectedClips = normalizeRenderClips(clips, startTime, endTime, reframe, isAutoModeFallback);'
);

// 3. Add isAutoModeFallback = true to normalizeRenderClips args
code = code.replace(
  'export function normalizeRenderClips(clips, fallbackStartTime, fallbackEndTime, fallbackReframe = {}) {',
  'export function normalizeRenderClips(clips, fallbackStartTime, fallbackEndTime, fallbackReframe = {}, isAutoModeFallback = true) {'
);

// 4. Update the throw durationErr block
const oldThrow = '      throw durationErr;\n    } else {';
const newThrow = '      if (isAutoModeFallback) {\n        throw durationErr;\n      } else {\n        console.warn(`[normalizeRenderClips] ⚠️ ${durationErr.message} (Melanjutkan render karena mode manual)`);\n      }\n    } else {';
code = code.replace(oldThrow, newThrow);

fs.writeFileSync('server/services/videoRenderer.js', code, 'utf8');
console.log('videoRenderer.js patched!');
