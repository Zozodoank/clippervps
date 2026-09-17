import crypto from 'crypto';

/**
 * ─── Keamanan API ClipperVPS ────────────────────────────────────────────────
 * 1. requireApiToken : Middleware autentikasi token opsional (API_ACCESS_TOKEN)
 * 2. buildCorsOptions: Batasi origin CORS (localhost, LAN, *.trycloudflare.com)
 * 3. isSafeExternalUrl: Cegah SSRF ke IP internal/metadata dari input user
 *
 * Jika API_ACCESS_TOKEN TIDAK diisi di .env, semua endpoint berjalan seperti
 * biasa (kompatibel dengan alur lama), hanya muncul peringatan di log server.
 * Jika DIISI, semua endpoint sensitif (generate, restart, upload, dsb.)
 * mewajibkan header `x-api-token`, query `?api_token=`, atau Bearer token.
 */

const API_TOKEN_ENV_KEYS = ['API_ACCESS_TOKEN', 'CLIPPER_API_TOKEN'];

let lastMissingTokenWarning = 0;

export function getApiAccessToken() {
  for (const key of API_TOKEN_ENV_KEYS) {
    const raw = (process.env[key] || '').trim();
    if (raw && !raw.startsWith('your_') && !raw.endsWith('_here') && raw.length >= 8) {
      return raw;
    }
  }
  return '';
}

function extractRequestToken(req) {
  const headerToken = String(req.headers['x-api-token'] || '').trim();
  if (headerToken) return headerToken;

  const authHeader = String(req.headers['authorization'] || '').trim();
  if (authHeader.toLowerCase().startsWith('bearer ')) {
    return authHeader.slice(7).trim();
  }

  const queryToken = String(req.query?.api_token || '').trim();
  if (queryToken) return queryToken;

  return '';
}

function timingSafeEqualStr(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) {
    // Tetap bandingkan agar waktu eksekusi tidak membocorkan panjang token
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Middleware Express: proteksi token untuk endpoint sensitif/destruktif.
 * - Tanpa API_ACCESS_TOKEN di .env → request diizinkan (mode lama) + warning log.
 * - Dengan API_ACCESS_TOKEN → 401 jika token tidak cocok.
 */
export function requireApiToken(req, res, next) {
  const expected = getApiAccessToken();
  if (!expected) {
    const now = Date.now();
    if (now - lastMissingTokenWarning > 30 * 60 * 1000) {
      lastMissingTokenWarning = now;
      console.warn(
        '[Security] ⚠️  API_ACCESS_TOKEN belum diatur di server/.env. ' +
        'Aplikasi berjalan TANPA autentikasi. Karena API terekspos via Cloudflare Tunnel publik, ' +
        'siapa pun yang mengetahui URL dapat mengontrol server (restart, upload, generate). ' +
        'Isi API_ACCESS_TOKEN=<token-acak-panjang> di server/.env untuk mengaktifkan kunci akses.'
      );
    }
    return next();
  }

  const provided = extractRequestToken(req);
  if (provided && timingSafeEqualStr(provided, expected)) {
    return next();
  }

  return res.status(401).json({
    success: false,
    error: 'Akses ditolak: token API tidak valid. Masukkan API Access Token yang benar (tombol gembok di kanan atas).',
    code: 'API_TOKEN_REQUIRED',
  });
}

/**
 * Konfigurasi CORS yang aman: hanya izinkan origin tepercaya.
 * UI normal (Vite proxy / Cloudflare Tunnel) bersifat same-origin sehingga
 * tidak butuh CORS sama sekali — aturan ini hanya melindungi akses lintas
 * origin yang tidak dikenal. Tambahkan origin ekstra via CORS_ALLOWED_ORIGINS.
 */
function isAllowedCorsOrigin(origin) {
  if (!origin) return true; // Permintaan same-origin / non-browser (curl, yt-dlp)
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();

    if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]') return true;
    if (host.endsWith('.trycloudflare.com')) return true;

    // LAN pribadi (akses HP/PC di Wi-Fi yang sama)
    if (/^10(\.\d+){3}$/.test(host) || /^192\.168(\.\d+){2}$/.test(host) || /^172\.(1[6-9]|2\d|3[01])(\.\d+){2}$/.test(host)) {
      return true;
    }

    // Origin tambahan dari .env (dipisah koma)
    const extra = String(process.env.CORS_ALLOWED_ORIGINS || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (extra.includes(parsed.origin.toLowerCase())) return true;

    return false;
  } catch {
    return false;
  }
}

export function buildCorsOptions() {
  return {
    origin(origin, callback) {
      if (isAllowedCorsOrigin(origin)) return callback(null, true);
      console.warn(`[Security] 🚫 CORS ditolak untuk origin: ${origin}`);
      return callback(null, false);
    },
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  };
}

/**
 * Validasi URL eksternal dari input user (mencegah SSRF ke jaringan internal).
 * Blokir: non-http(s), localhost, IP private/loopback/link-local, metadata cloud.
 * Catatan: proteksi DNS-rebinding (hostname publik yang resolve ke IP private)
 * membutuhkan resolusi DNS saat runtime dan berada di luar cakupan helper ini.
 */
export function isSafeExternalUrl(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || ''));
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;

    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (!host) return false;

    if (host === 'localhost' || host.endsWith('.localhost') || host === '0.0.0.0' || host === '::1') return false;
    if (/^127(\.\d+){3}$/.test(host)) return false;
    if (/^10(\.\d+){3}$/.test(host) || /^192\.168(\.\d+){2}$/.test(host)) return false;
    if (/^172\.(1[6-9]|2\d|3[01])(\.\d+){2}$/.test(host)) return false;
    if (host.startsWith('169.254.') || host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) return false;
    if (host.endsWith('.internal') || host.endsWith('.local') || host.endsWith('.home.arpa')) return false;

    return true;
  } catch {
    return false;
  }
}
