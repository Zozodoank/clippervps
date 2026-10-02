const fs = require('fs');
let code = fs.readFileSync('server/.env.example', 'utf8');
code += `
# -------------------------------------------------------------------
# WHISPER-FIRST PIPELINE SETTINGS
# -------------------------------------------------------------------
PIPELINE_MODE=whisper_first
QUICK_PREVIEW_DURATION_SEC=10
WHISPER_CONTEXT_DURATION_SEC=35
WHISPER_NARRATION_MIN_COVERAGE=0.30
BEST_WINDOW_DURATION_SEC=25
RENDER_DOWNLOAD_SECTIONS=1
RENDER_NO_FULL_DOWNLOAD=1
`;
fs.writeFileSync('server/.env.example', code);
console.log('Appended to .env.example');
