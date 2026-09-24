import { activeJobs } from '../store/jobStore.js';

export function getAllUsedYouTubeVideoIds() {
  const used = new Set();
  for (const job of activeJobs.values()) {
    // Only exclude video if the job actually SUCCEEDED or is currently processing
    if (job.stage === 'completed' || job.stage === 'awaiting_voiceover' || job.stage === 'running') {
      if (job.youtubeUrl) {
        const vid = extractVideoId(job.youtubeUrl);
        if (vid) used.add(vid);
      }
      // Multi-video harvesting: capture all candidate video IDs used in the storyboard clips!
      if (Array.isArray(job.highlight?.clips)) {
        for (const clip of job.highlight.clips) {
          const cvid = clip.videoId || extractVideoId(clip.candidateUrl) || clip.candidate?.id;
          if (cvid) used.add(cvid);
        }
      }
      // Also capture all accepted candidates from candidateResults
      if (Array.isArray(job.candidateResults)) {
        for (const c of job.candidateResults) {
          const cvid = c.id || extractVideoId(c.url);
          if (cvid) used.add(cvid);
        }
      }
    }
  }
  return used;
}

export function getAllUsedBrandProductPairsToday() {
  const todayStr = new Date().toISOString().slice(0, 10);
  const usedPairs = new Set();
  for (const job of activeJobs.values()) {
    if (job.stage === 'completed' || job.stage === 'awaiting_voiceover' || job.stage === 'running') {
      const jobDate = (job.createdAt || job.updatedAt || '').slice(0, 10);
      if (jobDate === todayStr || !job.createdAt) {
        const brand = (job.brand || '').toLowerCase().trim();
        const noun = (job.coreProductNoun || '').toLowerCase().trim();
        if (brand && noun) {
          usedPairs.add(`${brand} ${noun}`);
        } else if (noun) {
          usedPairs.add(noun);
        }
        const prodTitle = (job.productTitle || job.cleanProductTitle || '').toLowerCase().trim();
        if (prodTitle) {
          const info = extractCoreProductInfo(prodTitle);
          const infoBrand = (info.brand || '').toLowerCase().trim();
          const infoNoun = (info.coreProductNoun || '').toLowerCase().trim();
          if (infoBrand && infoNoun) {
            usedPairs.add(`${infoBrand} ${infoNoun}`);
          } else if (infoNoun) {
            usedPairs.add(infoNoun);
          }
        }
      }
    }
  }
  return usedPairs;
}

export function getAllUsedProductNounsToday() {
  return getAllUsedBrandProductPairsToday();
}

