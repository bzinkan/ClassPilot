// Content script for Classroom Screen Awareness
// Runs on all pages to monitor tab changes

console.log('Classroom Screen Awareness content script loaded');

// This content script is intentionally minimal
// Most functionality is handled by the service worker
// Content scripts can be extended in the future for:
// - Detecting blocked domains
// - Page-specific monitoring
// - Custom UI injections if needed

// Listen for messages from service worker
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'check-blocked-domain') {
    const currentDomain = window.location.hostname;
    sendResponse({ domain: currentDomain });
  }
  return true;
});
