import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export let loadedEnvFiles = [];

export function cleanEnvValue(value) {
  let cleaned = String(value || '').trim();
  if ((cleaned.startsWith('"') && cleaned.endsWith('"')) || (cleaned.startsWith("'") && cleaned.endsWith("'"))) {
    cleaned = cleaned.slice(1, -1).trim();
  }
  return cleaned;
}

export function isPlaceholderEnvValue(value) {
  return PLACEHOLDER_ENV_VALUES.has(cleanEnvValue(value).toLowerCase());
}

export function reloadEnvironment() {
  const loaded = [];
  for (const envPath of envCandidates) {
    if (fs.existsSync(envPath)) {
      try {
        const raw = fs.readFileSync(envPath, 'utf8').replace(/^\uFEFF/, '');
        const parsed = dotenv.parse(raw);
        for (const [key, value] of Object.entries(parsed)) {
          const cleaned = cleanEnvValue(value);
          if (isPlaceholderEnvValue(cleaned)) continue;
          process.env[key] = cleaned;
          process.env[key.toUpperCase()] = cleaned;
        }
        const lines = raw.split(/\r?\n/);
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) continue;
          const eqIdx = trimmed.indexOf('=');
          if (eqIdx > 0) {
            const k = trimmed.slice(0, eqIdx).replace(/^\uFEFF/, '').trim();
            const v = cleanEnvValue(trimmed.slice(eqIdx + 1));
            if (v && !isPlaceholderEnvValue(v)) {
              process.env[k] = v;
              process.env[k.toUpperCase()] = v;
            }
          }
        }
        loaded.push(envPath);
      } catch (err) {
        console.warn(`[Env] Could not load ${envPath}:`, err.message);
      }
    }
  }
  loadedEnvFiles = [...new Set(loaded)];
  return loadedEnvFiles;
}

