/**
 * Safely copy text to clipboard with automatic fallback for non-secure contexts (HTTP IP addresses).
 * Modern browsers block navigator.clipboard on plain HTTP IP addresses (e.g. http://192.168.1.2:3000).
 * This function seamlessly falls back to document.execCommand('copy').
 */
export async function copyToClipboardSafe(text) {
  const content = typeof text === 'object' ? JSON.stringify(text, null, 2) : String(text || '');

  // 1. Try modern navigator.clipboard if available in secure context
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(content);
      return true;
    } catch (err) {
      console.warn('[Clipboard] navigator.clipboard failed, attempting fallback...', err);
    }
  }

  // 2. Universal Fallback: Temporary textarea with document.execCommand('copy')
  try {
    const textArea = document.createElement('textarea');
    textArea.value = content;

    // Prevent scrolling to bottom of page in mobile / desktop
    textArea.style.position = 'fixed';
    textArea.style.left = '-999999px';
    textArea.style.top = '-999999px';
    textArea.setAttribute('readonly', '');
    document.body.appendChild(textArea);

    textArea.focus();
    textArea.select();

    // For iOS / Mobile touch devices
    textArea.setSelectionRange(0, content.length);

    const successful = document.execCommand('copy');
    document.body.removeChild(textArea);
    return successful;
  } catch (err) {
    console.error('[Clipboard] document.execCommand fallback failed:', err);
    return false;
  }
}
