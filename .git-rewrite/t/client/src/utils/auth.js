// Authentication helper for optional API_ACCESS_TOKEN via Cloudflare Tunnel
const TOKEN_STORAGE_KEY = 'clipper_api_token';

export function getApiToken() {
  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

export function setApiToken(token) {
  try {
    if (token && token.trim()) {
      localStorage.setItem(TOKEN_STORAGE_KEY, token.trim());
    } else {
      localStorage.removeItem(TOKEN_STORAGE_KEY);
    }
  } catch {}
}

export function withAuthQuery(url) {
  const token = getApiToken();
  if (!token) return url;
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}api_token=${encodeURIComponent(token)}`;
}

export function setupGlobalFetchAuth() {
  if (typeof window === 'undefined' || window.__clipper_fetch_patched) return;
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const token = getApiToken();
    let modifiedInit = { ...init };
    if (token) {
      const headers = new Headers(modifiedInit.headers || {});
      if (!headers.has('x-api-token') && !headers.has('Authorization')) {
        headers.set('x-api-token', token);
      }
      modifiedInit.headers = headers;
    }
    const response = await originalFetch(input, modifiedInit);
    if (response.status === 401) {
      window.dispatchEvent(new CustomEvent('clipper-auth-unauthorized'));
    }
    return response;
  };
  window.__clipper_fetch_patched = true;
}
