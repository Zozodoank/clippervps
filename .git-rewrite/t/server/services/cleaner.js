import fs from 'fs';
import path from 'path';

/**
 * Safely removes temporary frame directories and intermediate files.
 * @param {Array<string>} filePaths - Specific files to delete
 * @param {Array<string>} dirPaths - Specific directories to delete
 */
export function cleanupTempFiles(filePaths = [], dirPaths = []) {
  for (const filePath of filePaths) {
    try {
      if (filePath && fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        console.log(`[Cleaner] Deleted temp file: ${filePath}`);
      }
    } catch (err) {
      console.warn(`[Cleaner] Could not delete temp file ${filePath}: ${err.message}`);
    }
  }

  for (const dirPath of dirPaths) {
    try {
      if (dirPath && fs.existsSync(dirPath)) {
        fs.rmSync(dirPath, { recursive: true, force: true });
        console.log(`[Cleaner] Deleted temp dir: ${dirPath}`);
      }
    } catch (err) {
      console.warn(`[Cleaner] Could not delete temp dir ${dirPath}: ${err.message}`);
    }
  }
}

export function deleteJobTempDirectory(jobId, tempDir) {
  try {
    const sessionDir = path.join(tempDir, `job_${jobId}`);
    if (fs.existsSync(sessionDir)) {
      fs.rmSync(sessionDir, { recursive: true, force: true });
      console.log(`[Cleaner] Permanently deleted raw video temp dir for job ${jobId}: ${sessionDir}`);
      return true;
    }
  } catch (err) {
    console.warn(`[Cleaner] Could not delete temp dir for job ${jobId}: ${err.message}`);
  }
  return false;
}

/**
 * Permanently deletes specific job output files when a job is deleted from history.
 */
export function deleteJobFiles(jobId, outputDir, tempDir) {
  deleteJobTempDirectory(jobId, tempDir);
  const silentPath = path.join(outputDir, `silent_clip_${jobId}.mp4`);
  const finalPath = path.join(outputDir, `final_clip_${jobId}.mp4`);
  cleanupTempFiles([silentPath, finalPath]);
}

