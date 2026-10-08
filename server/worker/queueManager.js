import pLimit from 'p-limit';

// Limit max concurrency for heavy AI & FFmpeg tasks.
// 1 = safe for 2 CPU Cores (FFmpeg sampling and rendering share the available CPU).
export const heavyTaskQueue = pLimit(1);
