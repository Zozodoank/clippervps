import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const groups = [
  {
    target: 'worker/pipelineWorker.js',
    elements: [
      'function runStage1Pipeline',
      'function runAutoStage1Worker',
      'function runAutoRetryWorker',
      'function conformExistingJobEditToAudio',
      'function runProfessionalFinalQcWithRepair',
      'function syncVideoToAndroidStorage',
      'function processJobVoiceover'
    ],
    imports: `import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { spawn, execSync, exec } from 'child_process';
import { checkSystemDependencies, getFFmpegPath } from '../services/binaryChecker.js';
import { downloadYouTubeVideo, extractVideoId } from '../services/downloader.js';
import { extractFrames } from '../services/frameExtractor.js';
import {
  selectHighlightWithAI,
  analyzeYouTubeVideoWithGemini,
  analyzeMultipleYouTubeVideosWithGemini,
  generateAdAdvisorScriptWithAI,
  detectPhoneticLexiconWithAI,
  formatEnrichedCaption,
  formatSeconds,
  getDynamicProductHookFallback,
  verifyProductCandidateWithAI,
  verifyFinalRenderedFramesWithAI
} from '../services/aiService.js';
import { generateSrtSubtitles } from '../services/subtitleService.js';
import { loadEnglishDictionary, saveToEnglishDictionary } from '../services/dictionaryService.js';
import {
  renderSilentAntiDetectionVideo,
  mergeVoiceoverAndBurnSubtitles,
  getMediaDurationSec,
  getVideoDimensions
} from '../services/videoRenderer.js';
import {
  generateVoiceoverTTS,
  cleanScriptForTTS,
  DEFAULT_GEMINI_TTS_MODEL,
  DEFAULT_GEMINI_TTS_FALLBACK_MODEL,
  DEFAULT_GEMINI_TTS_VOICE,
  GEMINI_TTS_VOICES
} from '../services/ttsService.js';
import {
  fetchVideoMetadataAndStream,
  checkVideoMetadataCompliance,
  sampleFramesFromStream,
  inspectFramesLocally,
  filterCandidateFramesPerFrame,
  poolMultiCandidateFrames,
  callAIGatekeeperMicroservice,
  sampleDenseClustersAroundCleanFrames
} from '../services/videoFilterService.js';
import { classifyPipelineError, checkYouTubeHealth } from '../services/networkDiagnosticService.js';
import { trackSavedBandwidth } from '../services/bandwidthTracker.js';
import { cleanupTempFiles, deleteJobTempDirectory, deleteJobFiles } from '../services/cleaner.js';
import {
  discoverShopeeProducts,
  discoverBrandedShopeeProduct,
  discoverSingleShopeeProduct,
  discoverYouTubeCandidatesForProduct,
  fetchShopeePageMeta,
  isShopeeProductUrl,
  findMatchingShopeeProductUrl,
  buildShopeeSearchUrl,
  extractShopeeLinkFromText,
  DEFAULT_AUTO_KEYWORDS,
  getAutoKeywords,
  extractCoreProductInfo,
  cleanTitle,
  normalizeText,
  isBulkyOrUnsuitableProduct,
  markKeywordAsUsed,
  loadUsedKeywords,
  isKeywordUsed,
  isProductTitleUsed,
  getUsedKeywordsStats,
  clearUsedKeywords
} from '../services/discoveryService.js';
import { getAllNiches, getNichePreset } from '../config/nichePresets.js';
import {
  buildProductFingerprint,
  buildCreativeShotPlan,
  describeCreativePlan,
  conformClipsToVoiceover,
  choosePreferredCandidateSet
} from '../services/professionalPipelineService.js';
import { runFinalMasterQc } from '../services/finalMasterQcService.js';
import { activeJobs, jobProgress, autoRuns, autoRetryRuns, sanitizeJobForDisk, atomicWriteJsonSync, loadJobsFromDisk, persistJob, deletePersistedJob, updateJobProgress, updateAutoRun } from '../store/jobStore.js';
import { isValidHttpUrl, resolveOutputVideoPath, sanitizeCaptionText, isQuotaErrorMessage } from '../utils/jobHelpers.js';
import { getAllUsedYouTubeVideoIds, getAllUsedBrandProductPairsToday, getAllUsedProductNounsToday } from '../services/antiDupService.js';
import { getDailyOutputVideoLimit, getDailyOutputVideoStats } from '../services/quotaService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const tempDir = path.join(__dirname, '..', 'temp');
const outputDir = path.join(__dirname, '..', 'output');
const rejectedYunetDir = path.join(__dirname, '..', 'rejected_frames', 'yunet');
`
  }
];

function extractGroups() {
  const serverPath = path.join(__dirname, 'server.js');
  let code = fs.readFileSync(serverPath, 'utf8');
  let lines = code.split('\n');
  
  let allExported = [];

  for (const group of groups) {
    let storeCode = group.imports + '\n';
    let exportedElements = [];

    for (const element of group.elements) {
      let startIdx = -1;
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i]) continue;
        if (lines[i].startsWith(element) || lines[i].startsWith('export ' + element) || lines[i].startsWith('export async ' + element) || lines[i].startsWith('async ' + element)) {
          startIdx = i;
          if (startIdx > 0 && lines[startIdx - 1] && lines[startIdx - 1].trim() === '*/') {
            let j = startIdx - 1;
            while (j >= 0 && lines[j] && !lines[j].trim().startsWith('/**')) j--;
            if (j >= 0) startIdx = j;
          }
          break;
        }
      }

      if (startIdx === -1) {
        console.log(`Not found: ${element}`);
        continue;
      }

      let name = '';
      if (element.startsWith('function') || element.startsWith('const') || element.startsWith('let')) {
        const nameMatch = element.match(/(?:function|const|let) (\w+)/);
        if (nameMatch) {
          name = nameMatch[1];
          // ensure it gets exported in the new file
          if (!lines[startIdx].includes('export ')) {
             lines[startIdx] = 'export ' + lines[startIdx];
          }
          exportedElements.push(name);
        }
      }

      let endIdx = -1;
      let bracketCount = 0;
      let hasStarted = false;
      
      for (let i = startIdx; i < lines.length; i++) {
        const line = lines[i];
        for (let c = 0; c < line.length; c++) {
          if (line[c] === '{') { bracketCount++; hasStarted = true; }
          if (line[c] === '}') { bracketCount--; }
        }
        
        if (hasStarted && bracketCount === 0) {
          endIdx = i;
          break;
        }
      }

      if (endIdx !== -1) {
        const elLines = lines.slice(startIdx, endIdx + 1);
        storeCode += elLines.join('\n') + '\n\n';
        for (let i = startIdx; i <= endIdx; i++) {
          lines[i] = null;
        }
      }
    }

    const targetPath = path.join(__dirname, group.target);
    const targetDir = path.dirname(targetPath);
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(targetPath, storeCode);

    if (exportedElements.length > 0) {
      allExported.push(`import { ${exportedElements.join(', ')} } from './${group.target.replace(/\\/g, '/')}';`);
    }
  }

  const finalLines = [];
  let filtered = lines.filter(l => l !== null);
  
  let lastImportIdx = -1;
  for(let i=0; i<filtered.length; i++){
      if(filtered[i].startsWith('import ')) lastImportIdx = i;
  }
  
  if(lastImportIdx !== -1) {
      filtered.splice(lastImportIdx + 1, 0, ...allExported);
  } else {
      filtered.unshift(...allExported);
  }

  fs.writeFileSync(serverPath, filtered.join('\n'));
  console.log('Successfully extracted worker groups.');
}

extractGroups();
