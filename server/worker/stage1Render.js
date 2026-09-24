import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { spawn, execSync, exec } from 'child_process';
import { checkSystemDependencies, getFFmpegPath } from '../services/binaryChecker.js';
import { downloadYouTubeVideo, extractVideoId } from '../services/downloader.js';
import { extractFrames } from '../services/frameExtractor.js';
async function _runStage1Pipeline({
  jobId,
  youtubeUrl,
  targetCandidates = null,
  shopeeLink,
  productTitle,
  productDescription,
  apiKey,
  options = {},
  extraJobMeta = {},
  requireCleanGeminiPlan = true,
  onProgress = null,
}

export function runStage1Pipeline(args) {
  return heavyTaskQueue(() => _runStage1Pipeline(args));
}

