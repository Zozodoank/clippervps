const fs = require('fs');
const code = fs.readFileSync('server/services/aiService.js', 'utf8').split('\n');

const newCode = code.map((l, i) => {
  if (l.includes('productHook,')) return l + '\n  whisperSegments = [],';
  if (l.includes('const userPrompt = isGadget')) {
    return `
  const transcriptText = whisperSegments.length > 0 
    ? whisperSegments.map(s => \`[\${(s.sourceStartSec||0).toFixed(1)}s - \${(s.sourceEndSec||0).toFixed(1)}s]: \${s.text}\`).join('\\n') 
    : 'Tidak ada transkrip tersedia';

  ` + l;
  }
  
  if (l.includes('The Product Title is:')) {
    return l + `\n\nTRANSKRIP AUDIO ASLI DARI VIDEO (SEBAGAI KONTEKS UCAPAN/NARRASI): \n\${transcriptText}\n\n`;
  }
  
  if (l.includes('HINDARI KATA SLANG')) {
    return l + `\n- PENTING: Gunakan transkrip audio asli sebagai inspirasi utama, perbaiki menjadi bahasa Indonesia yang lebih natural dan relevan dengan produk.`;
  }

  return l;
}).join('\n');

fs.writeFileSync('server/services/aiService.js', newCode);
console.log('Modified aiService.js');
