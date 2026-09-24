import fs from 'fs';

const workerPath = 'server/worker/pipelineWorker.js';
let code = fs.readFileSync(workerPath, 'utf8');

// Add import
code = code.replace(/import \{ activeJobs.*\} from '\.\.\/store\/jobStore\.js';/, (match) => {
  return match + "\nimport { heavyTaskQueue } from './queueManager.js';";
});

// Rename runStage1Pipeline
code = code.replace(/export async function runStage1Pipeline\(\{/g, 'async function _runStage1Pipeline({');

// Add wrapper for runStage1Pipeline at the end
code += `

export function runStage1Pipeline(args) {
  return heavyTaskQueue(() => _runStage1Pipeline(args));
}
`;

// Rename processJobVoiceover
code = code.replace(/export async function processJobVoiceover\(jobId, customScript = null, options = \{\}\) \{/g, 'async function _processJobVoiceover(jobId, customScript = null, options = {}) {');

// Add wrapper for processJobVoiceover at the end
code += `
export function processJobVoiceover(jobId, customScript, options) {
  return heavyTaskQueue(() => _processJobVoiceover(jobId, customScript, options));
}
`;

fs.writeFileSync(workerPath, code);
