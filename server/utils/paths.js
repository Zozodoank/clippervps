import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const serverRoot = path.join(__dirname, '..');
export const outputDir = path.join(serverRoot, 'output');
export const tempDir = path.join(serverRoot, 'temp');
export const uploadsDir = path.join(tempDir, 'uploads');
