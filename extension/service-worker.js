// ClassPilot - Service Worker
// Handles background heartbeat sending and tab monitoring

// Production server URL - can be overridden in extension settings
const DEFAULT_SERVER_URL = 'https://classpilot.replit.app';

let CONFIG = {
  serverUrl: DEFAULT_SERVER_URL,
  heartbeatInterval: 10000, // 10 seconds
  schoolId: 'default-school',
  deviceId: null,
  studentName: null,
  studentEmail: null,
  classId: null,
  isSharing: false,
  activeStudentId: null,
};

let ws = null;
let backoffMs = 0; // Exponential backoff for heartbeat failures

// Get logged-in Chromebook user info using Chrome Identity API
async function getLoggedInUserInfo() {
  try {
    const userInfo = await chrome.identity.getProfileUserInfo({ accountStatus: 'ANY' });
    console.log('Logged-in user info:', userInfo);
    return {
      email: userInfo.email || null,
      id: userInfo.id || null,
    };
  } catch (error) {
    console.error('Error getting logged-in user info:', error);
    return { email: null, id: null };
  }
}

// Auto-detect and register student based on Chromebook login
async function autoDetectAndRegister() {
  const userInfo = await getLoggedInUserInfo();
  
  if (userInfo.email) {
    console.log('Auto-detected student email:', userInfo.email);
    
    // Extract name from email (e.g., john.smith@school.edu -> john.smith)
    const emailName = userInfo.email.split('@')[0];
    const displayName = emailName.replace(/\./g, ' ').replace(/\b\w/g, l => l.toUpperCase());
    
    CONFIG.studentEmail = userInfo.email;
    CONFIG.studentName = displayName;
    
    await chrome.storage.local.set({ 
      studentEmail: userInfo.email,
      studentName: displayName,
    });
    
    // Auto-register if not already registered
    const stored = await chrome.storage.local.get(['registered']);
    if (!stored.registered) {
      try {
        // Get or create device ID
        const deviceId = await getOrCreateDeviceId();
        
        // Register with auto-detected info
        await registerDeviceWithStudent(deviceId, null, 'default-class', userInfo.email, displayName);
        console.log('Auto-registered student:', userInfo.email);
      } catch (error) {
        console.error('Auto-registration failed:', error);
      }
    }
  } else {
    console.warn('Could not detect logged-in user email - manual registration required');
  }
}

// Load config from storage on startup
chrome.storage.local.get(['config', 'activeStudentId', 'studentEmail'], async (result) => {
  if (result.config) {
    CONFIG = { ...CONFIG, ...result.config };
    console.log('Loaded config:', CONFIG);
  }
  
  // Ensure serverUrl is set (use stored config, or fall back to default production URL)
  if (!CONFIG.serverUrl) {
    CONFIG.serverUrl = DEFAULT_SERVER_URL;
  }
  console.log('Using server URL:', CONFIG.serverUrl);
  
  // Load active student ID
  if (result.activeStudentId) {
    CONFIG.activeStudentId = result.activeStudentId;
    console.log('Loaded active student ID:', CONFIG.activeStudentId);
  }
  
  // Load student email
  if (result.studentEmail) {
    CONFIG.studentEmail = result.studentEmail;
  }
  
  // Auto-detect logged-in user and register
  await autoDetectAndRegister();
  
  // Start heartbeat if configured
  if (CONFIG.deviceId) {
    startHeartbeat();
    connectWebSocket();
  }
});

// Generate unique device ID if not exists
async function getOrCreateDeviceId() {
  const stored = await chrome.storage.local.get(['deviceId']);
  if (stored.deviceId) {
    return stored.deviceId;
  }
  
  const deviceId = 'device-' + Math.random().toString(36).substring(2, 15);
  await chrome.storage.local.set({ deviceId });
  return deviceId;
}

// Register device with server
async function registerDevice(deviceId, deviceName, classId) {
  // Use provided deviceId or generate new one
  if (!deviceId) {
    deviceId = await getOrCreateDeviceId();
  } else {
    // Save the provided deviceId
    await chrome.storage.local.set({ deviceId });
  }
  
  try {
    const response = await fetch(`${CONFIG.serverUrl}/api/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceId,
        deviceName, // Device name instead of student name
        schoolId: CONFIG.schoolId,
        classId,
      }),
    });
    
    if (!response.ok) throw new Error('Registration failed');
    
    const data = await response.json();
    console.log('Device registered:', data);
    
    // Save config (using deviceName as studentName for now)
    CONFIG.deviceId = deviceId;
    CONFIG.studentName = deviceName; // Display device name until teacher assigns student
    CONFIG.classId = classId;
    
    await chrome.storage.local.set({ 
      config: CONFIG,
      registered: true,
    });
    
    return data;
  } catch (error) {
    console.error('Registration error:', error);
    throw error;
  }
}

// Register device with student email auto-detection
async function registerDeviceWithStudent(deviceId, deviceName, classId, studentEmail, studentName) {
  // Use provided deviceId or generate new one
  if (!deviceId) {
    deviceId = await getOrCreateDeviceId();
  } else {
    // Save the provided deviceId
    await chrome.storage.local.set({ deviceId });
  }
  
  try {
    const response = await fetch(`${CONFIG.serverUrl}/api/register-student`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceId,
        deviceName,
        schoolId: CONFIG.schoolId,
        classId,
        studentEmail,
        studentName,
      }),
    });
    
    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.message || 'Student registration failed');
    }
    
    const data = await response.json();
    console.log('Student auto-registered:', data);
    
    // Save config with student info
    CONFIG.deviceId = deviceId;
    CONFIG.studentName = studentName;
    CONFIG.studentEmail = studentEmail;
    CONFIG.classId = classId;
    CONFIG.activeStudentId = data.student?.id || null;
    
    await chrome.storage.local.set({ 
      config: CONFIG,
      registered: true,
      activeStudentId: data.student?.id || null,
    });
    
    // Start heartbeat and WebSocket
    startHeartbeat();
    connectWebSocket();
    
    return data;
  } catch (error) {
    console.error('Student registration error:', error);
    throw error;
  }
}

// Send heartbeat with current tab info
async function sendHeartbeat() {
  if (!CONFIG.deviceId) {
    console.log('Skipping heartbeat - no deviceId');
    return;
  }
  
  try {
    // Get active tab
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const activeTab = tabs[0];
    
    if (!activeTab) {
      console.log('Skipping heartbeat - no active tab');
      return;
    }
    
    const heartbeatData = {
      deviceId: CONFIG.deviceId,
      activeTabTitle: activeTab.title || 'No title',
      activeTabUrl: activeTab.url || 'No URL',
      favicon: activeTab.favIconUrl || null,
      screenLocked: screenLocked,
    };
    
    // Include studentId if available
    if (CONFIG.activeStudentId) {
      heartbeatData.studentId = CONFIG.activeStudentId;
      console.log('Sending heartbeat with studentId:', CONFIG.activeStudentId, '| screenLocked:', screenLocked);
    } else {
      console.log('Sending heartbeat WITHOUT studentId (CONFIG.activeStudentId is null/undefined) | screenLocked:', screenLocked);
    }
    
    const response = await fetch(`${CONFIG.serverUrl}/api/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(heartbeatData),
    });
    
    if (response.status >= 500) {
      // Server error - use exponential backoff
      backoffMs = Math.min(60000, (backoffMs || 5000) * 2);
      console.error('Heartbeat server error:', response.status, 'backing off', backoffMs, 'ms');
      
      // Schedule retry with backoff
      chrome.alarms.create('heartbeat-retry', {
        when: Date.now() + backoffMs + Math.floor(Math.random() * 1500),
      });
      
      chrome.action.setBadgeBackgroundColor({ color: '#f59e0b' });
      chrome.action.setBadgeText({ text: '!' });
    } else if (response.ok) {
      // Success - reset backoff
      backoffMs = 0;
      chrome.action.setBadgeBackgroundColor({ color: '#22c55e' });
      chrome.action.setBadgeText({ text: '●' });
    } else {
      // Client error (400s) - log but don't retry
      console.error('Heartbeat client error:', response.status);
      chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
      chrome.action.setBadgeText({ text: '!' });
    }
    
  } catch (error) {
    console.error('Heartbeat network error:', error);
    // Network error - use backoff
    backoffMs = Math.min(60000, (backoffMs || 5000) * 2);
    chrome.alarms.create('heartbeat-retry', {
      when: Date.now() + backoffMs + Math.floor(Math.random() * 1500),
    });
    chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
    chrome.action.setBadgeText({ text: '!' });
  }
}

// Start periodic heartbeat using chrome.alarms (reliable in MV3 service workers)
function startHeartbeat() {
  // Clear any existing alarms
  chrome.alarms.clear('heartbeat');
  chrome.alarms.clear('heartbeat-retry');
  
  // Send immediate heartbeat
  sendHeartbeat();
  
  // Schedule next heartbeat using 'when' (in milliseconds from epoch)
  // Chrome alarms have a 1-minute minimum for periodInMinutes, so we use 'when' instead
  scheduleNextHeartbeat();
  console.log('Heartbeat started with chrome.alarms');
}

// Schedule next heartbeat
function scheduleNextHeartbeat() {
  chrome.alarms.create('heartbeat', {
    when: Date.now() + CONFIG.heartbeatInterval,
  });
}

// Stop heartbeat and WebSocket
function stopHeartbeat() {
  chrome.alarms.clear('heartbeat');
  chrome.alarms.clear('heartbeat-retry');
  chrome.alarms.clear('ws-reconnect'); // Also clear WebSocket reconnection alarm
  console.log('Heartbeat stopped');
}

// Alarm listener for heartbeat and WebSocket reconnection
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'heartbeat') {
    sendHeartbeat();
    // Reschedule next heartbeat (manual periodic behavior)
    scheduleNextHeartbeat();
  } else if (alarm.name === 'heartbeat-retry') {
    // Retry after backoff
    sendHeartbeat();
    scheduleNextHeartbeat();
  } else if (alarm.name === 'ws-reconnect') {
    // WebSocket reconnection alarm - reliable even if service worker was terminated
    console.log('WebSocket reconnection alarm triggered');
    connectWebSocket();
  }
});

// Remote Control Handlers (Phase 1: GoGuardian-style features)
let screenLocked = false;
let lockedUrl = null;
let lockedDomain = null; // Domain to lock to (e.g., "ixl.com")
let currentMaxTabs = null;

// Helper function to extract domain from URL
function extractDomain(url) {
  try {
    const urlObj = new URL(url);
    // Remove 'www.' prefix for consistent matching
    return urlObj.hostname.replace(/^www\./, '');
  } catch (error) {
    console.error('Invalid URL:', url, error);
    return null;
  }
}

// Helper function to check if URL is on the same domain
function isOnSameDomain(url, domain) {
  if (!url || !domain) return false;
  const urlDomain = extractDomain(url);
  return urlDomain === domain;
}

async function handleRemoteControl(command) {
  console.log('Remote control command received:', command);
  
  try {
    switch (command.type) {
      case 'open-tab':
        if (command.data.url) {
          await chrome.tabs.create({ url: command.data.url, active: true });
          console.log('Opened tab:', command.data.url);
        }
        break;
        
      case 'close-tab':
        if (command.data.closeAll) {
          // Close all tabs except new tab page and allowed domains
          const tabs = await chrome.tabs.query({});
          const allowedDomains = command.data.allowedDomains || [];
          
          for (const tab of tabs) {
            const url = new URL(tab.url || 'about:blank');
            const domain = url.hostname;
            
            // Don't close if it's an allowed domain or new tab page
            if (!allowedDomains.some(allowed => domain.includes(allowed)) && 
                !tab.url.startsWith('chrome://')) {
              await chrome.tabs.remove(tab.id);
            }
          }
          console.log('Closed all non-allowed tabs');
        } else if (command.data.pattern) {
          // Close tabs matching pattern
          const tabs = await chrome.tabs.query({});
          for (const tab of tabs) {
            if (tab.url && tab.url.includes(command.data.pattern)) {
              await chrome.tabs.remove(tab.id);
              console.log('Closed tab matching pattern:', tab.url);
            }
          }
        }
        break;
        
      case 'lock-screen':
        screenLocked = true;
        lockedUrl = command.data.url;
        lockedDomain = extractDomain(lockedUrl); // Extract domain for domain-based locking
        
        if (lockedUrl) {
          // Open the locked URL in current tab
          const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
          if (tabs[0]) {
            await chrome.tabs.update(tabs[0].id, { url: lockedUrl });
          } else {
            await chrome.tabs.create({ url: lockedUrl, active: true });
          }
        }
        
        // Show notification with domain
        chrome.notifications.create({
          type: 'basic',
          iconUrl: 'icons/icon48.png',
          title: 'Screen Locked',
          message: `Your teacher has locked your browsing to ${lockedDomain}. You can navigate within this site but cannot leave it.`,
          priority: 2,
        });
        
        console.log('Screen locked to domain:', lockedDomain, '(from URL:', lockedUrl + ')');
        break;
        
      case 'unlock-screen':
        screenLocked = false;
        lockedUrl = null;
        lockedDomain = null;
        
        chrome.notifications.create({
          type: 'basic',
          iconUrl: 'icons/icon48.png',
          title: 'Screen Unlocked',
          message: 'Your screen has been unlocked. You can now browse freely.',
          priority: 1,
        });
        
        console.log('Screen unlocked');
        break;
        
      case 'limit-tabs':
        currentMaxTabs = command.data.maxTabs;
        
        // Close excess tabs if over limit
        if (currentMaxTabs) {
          const tabs = await chrome.tabs.query({});
          if (tabs.length > currentMaxTabs) {
            // Close oldest tabs first (keep most recent)
            const tabsToClose = tabs.slice(0, tabs.length - currentMaxTabs);
            for (const tab of tabsToClose) {
              if (!tab.url.startsWith('chrome://')) {
                await chrome.tabs.remove(tab.id);
              }
            }
          }
        }
        
        console.log('Tab limit set to:', currentMaxTabs);
        break;
    }
  } catch (error) {
    console.error('Error handling remote control command:', error);
  }
}

// Helper function to ensure content script is injected
async function ensureContentScriptInjected(tabId) {
  try {
    // Try to ping the content script
    await chrome.tabs.sendMessage(tabId, { type: 'ping-test' });
  } catch (error) {
    // Content script not loaded, inject it
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tabId },
        files: ['content.js']
      });
      console.log('Content script injected into tab:', tabId);
    } catch (injectError) {
      console.log('Could not inject content script into tab:', tabId, injectError);
      throw injectError;
    }
  }
}

// Chat/Message Handlers (Phase 2)
async function handleChatMessage(message) {
  console.log('Chat message received:', message);
  
  // Show full-screen modal on all active tabs
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    // Skip chrome:// URLs and extension pages
    if (tab.url && !tab.url.startsWith('chrome://') && !tab.url.startsWith('chrome-extension://')) {
      try {
        // Ensure content script is injected before sending message
        await ensureContentScriptInjected(tab.id);
        
        await chrome.tabs.sendMessage(tab.id, {
          type: 'show-message',
          data: {
            message: message.message,
            fromName: message.fromName || 'Teacher',
            timestamp: message.timestamp || Date.now(),
          },
        });
      } catch (error) {
        console.log('Could not send message to tab:', tab.id, error);
      }
    }
  }
  
  // Also show browser notification as backup
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icons/icon48.png',
    title: `Message from ${message.fromName || 'Teacher'}`,
    message: message.message,
    priority: 2,
    requireInteraction: false,
  });
  
  // Store message in local storage for popup to display
  const stored = await chrome.storage.local.get(['messages']);
  const messages = stored.messages || [];
  messages.push({
    ...message,
    timestamp: Date.now(),
    read: false,
  });
  
  // Keep only last 50 messages
  if (messages.length > 50) {
    messages.shift();
  }
  
  await chrome.storage.local.set({ messages });
  
  // Update badge to show unread count
  const unreadCount = messages.filter(m => !m.read).length;
  chrome.action.setBadgeText({ text: unreadCount > 0 ? String(unreadCount) : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#3b82f6' }); // Blue for messages
}

// Check-in Request Handler (Phase 3)
async function handleCheckInRequest(request) {
  console.log('Check-in request received:', request);
  
  // Show notification with check-in question
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icons/icon48.png',
    title: 'Teacher Check-in',
    message: request.question,
    priority: 2,
    requireInteraction: true,
  });
  
  // Store check-in request for popup to display
  await chrome.storage.local.set({
    pendingCheckIn: {
      question: request.question,
      options: request.options,
      timestamp: Date.now(),
    },
  });
}

// Prevent navigation when screen is locked (domain-based blocking)
chrome.webNavigation.onBeforeNavigate.addListener(async (details) => {
  // Only check main frame navigations
  if (details.frameId !== 0) return;
  
  // Allow chrome:// URLs
  if (details.url.startsWith('chrome://') || details.url.startsWith('about:')) {
    return;
  }
  
  const targetDomain = extractDomain(details.url);
  if (!targetDomain) return;
  
  // Check screen lock
  if (screenLocked && lockedDomain) {
    // Check if navigating to a different domain
    if (!isOnSameDomain(details.url, lockedDomain)) {
      // Redirect back to locked URL (students trying to leave the domain)
      console.log('Blocked navigation to:', details.url, '- locked to domain:', lockedDomain);
      chrome.tabs.update(details.tabId, { url: lockedUrl });
      
      // Show warning notification
      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon48.png',
        title: 'Navigation Blocked',
        message: `You can only browse within ${lockedDomain}`,
        priority: 1,
      });
      return;
    }
  }
});

// Enforce tab limit
chrome.tabs.onCreated.addListener(async (tab) => {
  if (currentMaxTabs) {
    const tabs = await chrome.tabs.query({});
    if (tabs.length > currentMaxTabs) {
      // Close the newly created tab if over limit
      chrome.tabs.remove(tab.id);
      
      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon48.png',
        title: 'Tab Limit Reached',
        message: `You can only have ${currentMaxTabs} tabs open at a time.`,
        priority: 1,
      });
    }
  }
});

// Connect to WebSocket for signaling
function connectWebSocket() {
  if (!CONFIG.deviceId) return;
  
  // Clear any pending reconnection alarm since we're connecting now
  chrome.alarms.clear('ws-reconnect');
  
  const protocol = CONFIG.serverUrl.startsWith('https') ? 'wss' : 'ws';
  const wsUrl = `${protocol}://${new URL(CONFIG.serverUrl).host}/ws`;
  
  ws = new WebSocket(wsUrl);
  
  ws.onopen = () => {
    console.log('WebSocket connected');
    // Authenticate as student with proper state checking
    try {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'auth',
          role: 'student',
          deviceId: CONFIG.deviceId,
        }));
      } else {
        console.warn('WebSocket not ready yet, will retry on next connection');
      }
    } catch (error) {
      console.error('Failed to send auth message:', error);
    }
  };
  
  ws.onmessage = (event) => {
    try {
      const message = JSON.parse(event.data);
      console.log('WebSocket message:', message);
      
      // Handle WebRTC signaling
      if (message.type === 'signal') {
        chrome.runtime.sendMessage({
          type: 'webrtc-signal',
          data: message.data,
        });
      }
      
      // Handle ping notifications
      if (message.type === 'ping') {
        const { message: pingMessage } = message.data;
        
        // Show browser notification
        chrome.notifications.create({
          type: 'basic',
          iconUrl: 'icons/icon48.png',
          title: 'Teacher Notification',
          message: pingMessage || 'Your teacher is requesting your attention',
          priority: 2,
          requireInteraction: true, // Keeps notification visible until user dismisses
        });
        
        // Also play a sound (beep)
        // Note: Service workers cannot play audio directly, but the notification will make a sound
      }
      
      // Handle remote control commands (Phase 1: GoGuardian-style features)
      if (message.type === 'remote-control') {
        handleRemoteControl(message.command);
      }
      
      // Handle chat messages (Phase 2)
      if (message.type === 'chat') {
        handleChatMessage(message);
      }
      
      // Handle check-in requests (Phase 3)
      if (message.type === 'check-in-request') {
        handleCheckInRequest(message);
      }
    } catch (error) {
      console.error('Error processing WebSocket message:', error);
    }
  };
  
  ws.onerror = (error) => {
    console.error('WebSocket error:', error);
  };
  
  ws.onclose = () => {
    console.log('WebSocket disconnected, will reconnect in 5s...');
    ws = null; // Clear the reference
    
    // Use chrome.alarms instead of setTimeout to ensure reconnection happens
    // even if service worker is terminated
    chrome.alarms.create('ws-reconnect', {
      when: Date.now() + 5000, // 5 seconds from now
    });
  };
}

// Tab change listener - send immediate heartbeat
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  // Log tab change event
  if (CONFIG.deviceId) {
    await sendHeartbeat();
    
    // Log the event
    try {
      await fetch(`${CONFIG.serverUrl}/api/event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deviceId: CONFIG.deviceId,
          eventType: 'tab_change',
          metadata: { tabId: activeInfo.tabId },
        }),
      });
    } catch (error) {
      console.error('Event logging error:', error);
    }
  }
});

// Tab update listener - send heartbeat on URL/title change
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (CONFIG.deviceId && tab.active && (changeInfo.url || changeInfo.title)) {
    await sendHeartbeat();
    
    // Log URL change event
    if (changeInfo.url) {
      try {
        await fetch(`${CONFIG.serverUrl}/api/event`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            deviceId: CONFIG.deviceId,
            eventType: 'url_change',
            metadata: { 
              url: changeInfo.url,
              title: tab.title || 'No title',
            },
          }),
        });
      } catch (error) {
        console.error('Event logging error:', error);
      }
    }
  }
});

// Web Navigation listener - track all navigation events (including clicks)
chrome.webNavigation.onCommitted.addListener(async (details) => {
  if (!CONFIG.deviceId) return;
  
  // Only log main frame navigations (not iframes)
  if (details.frameId !== 0) return;
  
  // Log navigation event with transition type
  try {
    await fetch(`${CONFIG.serverUrl}/api/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceId: CONFIG.deviceId,
        eventType: 'navigation',
        metadata: { 
          url: details.url,
          transitionType: details.transitionType,
          transitionQualifiers: details.transitionQualifiers,
          timestamp: details.timeStamp,
        },
      }),
    });
  } catch (error) {
    console.error('Navigation event logging error:', error);
  }
});

// Listen for messages from popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'register') {
    registerDevice(message.deviceId, message.deviceName, message.classId)
      .then(async (data) => {
        startHeartbeat();
        connectWebSocket();
        
        // Refresh the current page to apply privacy banner
        try {
          const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
          if (tabs[0]?.id) {
            chrome.tabs.reload(tabs[0].id);
          }
        } catch (error) {
          console.error('Failed to refresh tab:', error);
        }
        
        sendResponse({ success: true, data });
      })
      .catch((error) => {
        sendResponse({ success: false, error: error.message });
      });
    return true; // Will respond asynchronously
  }
  
  if (message.type === 'get-config') {
    sendResponse({ config: CONFIG });
    return true;
  }
  
  if (message.type === 'update-server-url') {
    const newServerUrl = message.serverUrl;
    if (newServerUrl) {
      CONFIG.serverUrl = newServerUrl;
      chrome.storage.local.set({ config: CONFIG }, () => {
        console.log('Server URL updated to:', newServerUrl);
        // Restart heartbeat with new server URL
        stopHeartbeat();
        startHeartbeat();
        sendResponse({ success: true });
      });
    } else {
      sendResponse({ success: false, error: 'Invalid server URL' });
    }
    return true;
  }
  
  if (message.type === 'sharing-started') {
    CONFIG.isSharing = true;
    chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
    chrome.action.setBadgeText({ text: '◉' });
    
    // Log consent granted event
    fetch(`${CONFIG.serverUrl}/api/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceId: CONFIG.deviceId,
        eventType: 'consent_granted',
        metadata: { timestamp: new Date().toISOString() },
      }),
    });
    
    sendResponse({ success: true });
    return true;
  }
  
  if (message.type === 'sharing-stopped') {
    CONFIG.isSharing = false;
    chrome.action.setBadgeBackgroundColor({ color: '#22c55e' });
    chrome.action.setBadgeText({ text: '●' });
    
    // Log consent revoked event
    fetch(`${CONFIG.serverUrl}/api/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceId: CONFIG.deviceId,
        eventType: 'consent_revoked',
        metadata: { timestamp: new Date().toISOString() },
      }),
    });
    
    sendResponse({ success: true });
    return true;
  }
  
  if (message.type === 'webrtc-send-signal') {
    // Send WebRTC signal via WebSocket
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'signal',
        data: message.signal,
      }));
      sendResponse({ success: true });
    } else {
      sendResponse({ success: false, error: 'WebSocket not connected' });
    }
    return true;
  }
  
  if (message.type === 'student-changed') {
    // Update active student ID
    const previousStudentId = CONFIG.activeStudentId;
    CONFIG.activeStudentId = message.studentId;
    
    console.log('Student changed:', previousStudentId, '->', message.studentId);
    
    // Send immediate heartbeat with new studentId
    sendHeartbeat();
    
    // Log student_switched event
    if (CONFIG.deviceId) {
      fetch(`${CONFIG.serverUrl}/api/event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deviceId: CONFIG.deviceId,
          eventType: 'student_switched',
          metadata: { 
            previousStudentId,
            newStudentId: message.studentId,
            timestamp: new Date().toISOString(),
          },
        }),
      }).catch(error => {
        console.error('Error logging student_switched event:', error);
      });
    }
    
    sendResponse({ success: true });
    return true;
  }
});

console.log('ClassPilot service worker loaded');
