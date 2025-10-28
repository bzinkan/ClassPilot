// ClassPilot - Service Worker
// Handles background heartbeat sending and tab monitoring

let CONFIG = {
  serverUrl: 'https://classpilot.replit.app',
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
    };
    
    // Include studentId if available
    if (CONFIG.activeStudentId) {
      heartbeatData.studentId = CONFIG.activeStudentId;
      console.log('Sending heartbeat with studentId:', CONFIG.activeStudentId);
    } else {
      console.log('Sending heartbeat WITHOUT studentId (CONFIG.activeStudentId is null/undefined)');
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

// Stop heartbeat
function stopHeartbeat() {
  chrome.alarms.clear('heartbeat');
  chrome.alarms.clear('heartbeat-retry');
  console.log('Heartbeat stopped');
}

// Alarm listener for heartbeat
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'heartbeat') {
    sendHeartbeat();
    // Reschedule next heartbeat (manual periodic behavior)
    scheduleNextHeartbeat();
  } else if (alarm.name === 'heartbeat-retry') {
    // Retry after backoff
    sendHeartbeat();
    scheduleNextHeartbeat();
  }
});

// Connect to WebSocket for signaling
function connectWebSocket() {
  if (!CONFIG.deviceId) return;
  
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
    } catch (error) {
      console.error('Error processing WebSocket message:', error);
    }
  };
  
  ws.onerror = (error) => {
    console.error('WebSocket error:', error);
  };
  
  ws.onclose = () => {
    console.log('WebSocket disconnected, reconnecting in 5s...');
    ws = null; // Clear the reference
    setTimeout(connectWebSocket, 5000);
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
