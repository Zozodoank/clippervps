const fs = require('fs');
let code = fs.readFileSync('server/services/videoFilterService.js', 'utf8');

const targetLoopStart = '  const executing = [];\n  for (const point of samplePoints) {';
const replacement = '  const executing = [];\n  let framesProcessed = 0;\n  for (const point of samplePoints) {';

code = code.replace(targetLoopStart, replacement);

const targetResolve = 'proc.on(\'error\', () => { if (!finished) { finished = true; clearTimeout(timer); resolve(); } });\n    });';
const resolveRepl = targetResolve + '\n\n    p.then(() => {\n      framesProcessed++;\n      if (framesProcessed % 10 === 0 || framesProcessed === samplePoints.length) {\n        console.log(`[VideoFilterService] ⏳ Dense sampling progress: ${framesProcessed}/${samplePoints.length} frames...`);\n      }\n    });';

code = code.replace(targetResolve, resolveRepl);

fs.writeFileSync('server/services/videoFilterService.js', code, 'utf8');
console.log('Added progress logs to videoFilterService.js');
