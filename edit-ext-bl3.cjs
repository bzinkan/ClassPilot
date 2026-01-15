const fs = require('fs');
let content = fs.readFileSync('extension/service-worker.js', 'utf8');

// Normalize line endings
const hasWindowsLineEndings = content.includes('\r\n');
content = content.replace(/\r\n/g, '\n');

// 1. Add teacherBlockListState to storage keys
const oldStorageKeys = `    'globalBlockedDomains',
  ]);`;

const newStorageKeys = `    'globalBlockedDomains',
    'teacherBlockListState',
  ]);`;

if (!content.includes(oldStorageKeys)) {
  console.log('Storage keys pattern not found!');
  process.exit(1);
}
content = content.replace(oldStorageKeys, newStorageKeys);
console.log('Added teacherBlockListState to storage keys');

// 2. Add restoration of teacher block list state
const oldStateLog = `  console.log('[Service Worker] State restored:', { 
    deviceId: CONFIG.deviceId, 
    studentEmail: CONFIG.studentEmail,
    flightPathActive: allowedDomains.length > 0,
    screenLocked: screenLocked,
    globalBlockedDomains: globalBlockedDomains.length
  });`;

const newStateLog = `  // Restore teacher block list state
  if (stored.teacherBlockListState) {
    teacherBlockedDomains = stored.teacherBlockListState.blockedDomains || [];
    activeBlockListName = stored.teacherBlockListState.blockListName || null;
    if (teacherBlockedDomains.length > 0) {
      await updateTeacherBlockListRules(teacherBlockedDomains);
      console.log('[Service Worker] Teacher block list rules re-applied:', teacherBlockedDomains);
    }
  }

  console.log('[Service Worker] State restored:', { 
    deviceId: CONFIG.deviceId, 
    studentEmail: CONFIG.studentEmail,
    flightPathActive: allowedDomains.length > 0,
    screenLocked: screenLocked,
    globalBlockedDomains: globalBlockedDomains.length,
    teacherBlockedDomains: teacherBlockedDomains.length
  });`;

if (!content.includes(oldStateLog)) {
  console.log('State log pattern not found!');
  process.exit(1);
}
content = content.replace(oldStateLog, newStateLog);
console.log('Added teacher block list restoration');

// 3. Update onBeforeNavigate to check teacher blocked domains too
const oldBlacklistCheck = `  // Check global blacklist first (school-wide blocked domains)
  if (globalBlockedDomains.length > 0) {
    const isBlacklisted = globalBlockedDomains.some(blockedDomain => {
      const normalizedBlocked = blockedDomain.replace(/^www\./, '');
      return targetDomain === normalizedBlocked || targetDomain.endsWith('.' + normalizedBlocked);
    });
    
    if (isBlacklisted) {
      console.log('[Blacklist] Blocked navigation to:', details.url);
      
      // Go back or close the tab
      chrome.tabs.goBack(details.tabId).catch(() => {
        // If can't go back, try to navigate to a safe page
        chrome.tabs.update(details.tabId, { url: 'about:blank' });
      });
      
      // Show notification
      safeNotify({
        title: 'Website Blocked',
        message: \`Access to \${targetDomain} is blocked by your school.\`,
        priority: 2,
      });
      return;
    }
  }
  
  // Check screen lock`;

const newBlacklistCheck = `  // Check global blacklist first (school-wide blocked domains)
  if (globalBlockedDomains.length > 0) {
    const isBlacklisted = globalBlockedDomains.some(blockedDomain => {
      const normalizedBlocked = blockedDomain.replace(/^www\./, '');
      return targetDomain === normalizedBlocked || targetDomain.endsWith('.' + normalizedBlocked);
    });
    
    if (isBlacklisted) {
      console.log('[Blacklist] Blocked navigation to:', details.url);
      
      // Go back or close the tab
      chrome.tabs.goBack(details.tabId).catch(() => {
        // If can't go back, try to navigate to a safe page
        chrome.tabs.update(details.tabId, { url: 'about:blank' });
      });
      
      // Show notification
      safeNotify({
        title: 'Website Blocked',
        message: \`Access to \${targetDomain} is blocked by your school.\`,
        priority: 2,
      });
      return;
    }
  }

  // Check teacher block list (session-based)
  if (teacherBlockedDomains.length > 0) {
    const isTeacherBlocked = teacherBlockedDomains.some(blockedDomain => {
      const normalizedBlocked = blockedDomain.replace(/^www\./, '');
      return targetDomain === normalizedBlocked || targetDomain.endsWith('.' + normalizedBlocked);
    });
    
    if (isTeacherBlocked) {
      console.log('[Teacher Block List] Blocked navigation to:', details.url);
      
      chrome.tabs.goBack(details.tabId).catch(() => {
        chrome.tabs.update(details.tabId, { url: 'about:blank' });
      });
      
      safeNotify({
        title: 'Website Blocked',
        message: \`Access to \${targetDomain} is blocked by your teacher.\`,
        priority: 2,
      });
      return;
    }
  }
  
  // Check screen lock`;

if (!content.includes(oldBlacklistCheck)) {
  console.log('Blacklist check pattern not found!');
  process.exit(1);
}
content = content.replace(oldBlacklistCheck, newBlacklistCheck);
console.log('Added teacher block list check to onBeforeNavigate');

// Restore Windows line endings if originally present
if (hasWindowsLineEndings) {
  content = content.replace(/\n/g, '\r\n');
}

fs.writeFileSync('extension/service-worker.js', content);
console.log('Done!');
