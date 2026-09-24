import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const serverRoot = path.join(__dirname, '..');
export const outputDir = path.join(serverRoot, 'output');
export const tempDir = path.join(serverRoot, 'temp');
export const uploadsDir = path.join(tempDir, 'uploads');
export const rejectedYunetDir = path.join(serverRoot, 'rejected_frames', 'yunet');
export const cookiesPath = path.join(serverRoot, 'cookies.txt');
export const envCandidates = [
  path.join(serverRoot, '.env'),
  path.join(serverRoot, '.env.txt'),
  path.join(serverRoot, '..', '.env'),
  path.join(serverRoot, '..', '.env.txt'),
  path.join(process.cwd(), '.env'),
  path.join(process.cwd(), '.env.txt'),
];
