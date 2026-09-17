/**
 * ─── API Access Token (Kunci Akses) ─────────────────────────────────────────
 * Jika server mengaktifkan API_ACCESS_TOKEN di server/.env, seluruh request
 * sensitif wajib membawa token. Util ini:
 * 1. Menyimpan token di localStorage (kunci 'clipper_api_token').
 * 2. Mem-patch window.fetch agar otomatis menyertakan header x-api-token.
 * 3. Membangun URL SSE (EventSource tidak bisa mengirim header) dengan query
 *    ?api_token=... .
 * 4. Membroadcast event 'clipper:unauthorized' saat server membalas 401 agar
 *    UI bisa menampilkan dialog input token.
 */

const TOKEN_KEY = 'clipper_api_token';

export function getApiToken() {
  try {
    return (localStorage.getItem(TOKEN_KEY) || '').trim();
  } catch {
    return '';
  }
}

export function setApiToken(token) {
  try {
    const cleaned = String(token || '').trim();
    if (cleaned) localStorage.setItem(TOKEN_KEY, cleaned);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {}
}

export function clearApiToken() {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {}
}

/**
 * Tambahkan token ke URL relatif (untuk EventSource / tag media).
 * Mengembalikan path relatif + query string agar tetap same-origin.
 */
export function withApiToken(url) {
  const token = getApiToken();
  if (!token) return url;
  try {
    const u = new URL(url, window.location.origin);
    u.searchParams.set('api_token', token);
    return u.pathname + u.search + u.hash;
  } catch {
    return url;
  }
}

let lastUnauthorizedEventAt = 0;

/**
 * Pasang interceptor global pada window.fetch (dipanggil sekali di main.jsx).
 * Header x-api-token hanya ditambahkan bila token tersimpan di localStorage.
 */
export function installFetchInterceptor() {
  if (typeof window === 'undefined' || window.__clipperFetchPatched) return;
  window.__clipperFetchPatched = true;

  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const token = getApiToken();
    let finalInit = init;

    if (token && !(input instanceof Request)) {
      const headers = new Headers(init.headers || {});
      if (!headers.has('x-api-token')) headers.set('x-api-token', token);
      finalInit = { ...init, headers };
    }

    const response = await originalFetch(input, finalInit);

    if (response && response.status === 401) {
      const now = Date.now();
      if (now - lastUnauthorizedEventAt > 5000) {
        lastUnauthorizedEventAt = now;
        window.dispatchEvent(new CustomEvent('clipper:unauthorized', {
          detail: { url: typeof input === 'string' ? input : String(input) },
        }));
      }
    }
    return response;
  };
}
