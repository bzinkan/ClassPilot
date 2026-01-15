const fs = require('fs');
let content = fs.readFileSync('extension/service-worker.js', 'utf8');

// Normalize line endings
const hasWindowsLineEndings = content.includes('\r\n');
content = content.replace(/\r\n/g, '\n');

// Add teacher block list functions after global blacklist function
const oldGetLoggedIn = `// Get logged-in Chromebook user info using Chrome Identity API
async function getLoggedInUserInfo() {`;

const newGetLoggedIn = `// Teacher Block List - blocks specific domains during teacher session
// Uses rule IDs starting from 2000 to avoid conflicts with global blacklist (1000+) and Flight Path (1)
const TEACHER_BLOCKLIST_RULE_START_ID = 2000;

async function updateTeacherBlockListRules(blockedDomains) {
  try {
    // Get all existing rules to find teacher blocklist rules (IDs >= 2000)
    const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
    const teacherRuleIds = existingRules
      .filter(rule => rule.id >= TEACHER_BLOCKLIST_RULE_START_ID)
      .map(rule => rule.id);
    
    // Remove existing teacher blocklist rules
    if (teacherRuleIds.length > 0) {
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: teacherRuleIds
      });
    }
    
    // If no blocked domains, we're done
    if (!blockedDomains || blockedDomains.length === 0) {
      console.log('[Teacher Block List] Cleared - no domains blocked');
      return;
    }
    
    // Create blocking rules for each domain
    const rules = blockedDomains.map((domain, index) => ({
      id: TEACHER_BLOCKLIST_RULE_START_ID + index,
      priority: 15, // Higher priority than global blacklist (10) and Flight Path (1)
      action: {
        type: "block"
      },
      condition: {
        resourceTypes: ["main_frame"],
        requestDomains: [domain.replace(/^https?:\/\//, '').replace(/\/$/, '')]
      }
    }));
    
    await chrome.declarativeNetRequest.updateDynamicRules({
      addRules: rules
    });
    
    console.log('[Teacher Block List] Updated. Blocked domains:', blockedDomains);
  } catch (error) {
    console.error('[Teacher Block List] Error updating rules:', error.message);
  }
}

async function clearTeacherBlockListRules() {
  await updateTeacherBlockListRules([]);
}

// Get logged-in Chromebook user info using Chrome Identity API
async function getLoggedInUserInfo() {`;

if (!content.includes(oldGetLoggedIn)) {
  console.log('getLoggedInUserInfo pattern not found!');
  process.exit(1);
}
content = content.replace(oldGetLoggedIn, newGetLoggedIn);
console.log('Added teacher block list functions');

// Restore Windows line endings if originally present
if (hasWindowsLineEndings) {
  content = content.replace(/\n/g, '\r\n');
}

fs.writeFileSync('extension/service-worker.js', content);
console.log('Done!');
