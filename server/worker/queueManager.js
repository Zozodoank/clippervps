import pLimit from 'p-limit';

// Limit max concurrency for heavy AI & FFmpeg tasks.
// 1 = safe for 2 CPU Cores (gatekeeper takes up to 100% CPU during frame evaluation).
export const heavyTaskQueue = pLimit(1);
