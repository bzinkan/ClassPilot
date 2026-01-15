const fs = require('fs');
let content = fs.readFileSync('extension/service-worker.js', 'utf8');

// Normalize line endings
const hasWindowsLineEndings = content.includes('\r\n');
content = content.replace(/\r\n/g, '\n');

// 1. Add state variables for teacher block list
const oldStateVars = `let currentMaxTabs = null;
let globalBlockedDomains = []; // School-wide blacklist (e.g., ["lens.google.com", "chat.openai.com"])

// Helper function to extract domain from URL`;

const newStateVars = `let currentMaxTabs = null;
let globalBlockedDomains = []; // School-wide blacklist (e.g., ["lens.google.com", "chat.openai.com"])
let teacherBlockedDomains = []; // Teacher-applied session blacklist
let activeBlockListName = null; // Name of the currently active teacher block list

// Helper function to extract domain from URL`;

if (!content.includes(oldStateVars)) {
  console.log('State vars pattern not found!');
  process.exit(1);
}
content = content.replace(oldStateVars, newStateVars);
console.log('Added teacher block list state variables');

// 2. Add case handlers for apply-block-list and remove-block-list
const oldLimitTabs = `      case 'limit-tabs':
        currentMaxTabs = command.data.maxTabs;`;

const newLimitTabs = `      case 'apply-block-list':
        teacherBlockedDomains = command.data.blockedDomains || [];
        activeBlockListName = command.data.blockListName || null;
        
        // Persist teacher block list state
        await chrome.storage.local.set({
          teacherBlockListState: {
            blockedDomains: teacherBlockedDomains,
            blockListName: activeBlockListName,
            timestamp: Date.now()
          }
        });
        
        // Update blocking rules (merges with global blacklist)
        await updateTeacherBlockListRules(teacherBlockedDomains);
        
        if (teacherBlockedDomains.length > 0) {
          safeNotify({
            title: 'Block List Applied',
            message: \`Your teacher has blocked: \${teacherBlockedDomains.slice(0, 3).join(', ')}\${teacherBlockedDomains.length > 3 ? '...' : ''}\`,
            priority: 1,
          });
        }
        
        console.log('[Block List] Teacher block list applied:', activeBlockListName, teacherBlockedDomains);
        break;
        
      case 'remove-block-list':
        teacherBlockedDomains = [];
        activeBlockListName = null;
        
        // Clear persisted teacher block list state
        await chrome.storage.local.remove('teacherBlockListState');
        
        // Clear teacher block list rules (keeps global blacklist)
        await clearTeacherBlockListRules();
        
        safeNotify({
          title: 'Block List Removed',
          message: 'Your teacher has removed the block list.',
          priority: 1,
        });
        
        console.log('[Block List] Teacher block list removed');
        break;
        
      case 'limit-tabs':
        currentMaxTabs = command.data.maxTabs;`;

if (!content.includes(oldLimitTabs)) {
  console.log('limit-tabs pattern not found!');
  process.exit(1);
}
content = content.replace(oldLimitTabs, newLimitTabs);
console.log('Added apply-block-list and remove-block-list handlers');

// Restore Windows line endings if originally present
if (hasWindowsLineEndings) {
  content = content.replace(/\n/g, '\r\n');
}

fs.writeFileSync('extension/service-worker.js', content);
console.log('Done!');
