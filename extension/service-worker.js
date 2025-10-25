// Classroom Screen Awareness - Service Worker
// Handles background heartbeat sending and tab monitoring

let CONFIG = {
  serverUrl: 'https://62d255e0-27ab-4c9e-9d3c-da535ded49b0-00-3n6xv61n40v9i.riker.replit.dev',
  heartbeatInterval: 10000, // 10 seconds
  schoolId: 'default-school',
  deviceId: null,
  studentName: null,
  classId: null,
  isSharing: false,
};

let heartbeatTimer = null;
let ws = null;

// Load config from storage on startup
chrome.storage.local.get(['config'], (result) => {
  if (result.config) {
    CONFIG = { ...CONFIG, ...result.config };
    console.log('Loaded config:', CONFIG);
  }
  
  // Start heartbeat if configured
  if (CONFIG.deviceId && CONFIG.studentName) {
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
async function registerDevice(studentName, classId) {
  const deviceId = await getOrCreateDeviceId();
  
  try {
    const response = await fetch(`${CONFIG.serverUrl}/api/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceId,
        studentName,
        schoolId: CONFIG.schoolId,
        classId,
      }),
    });
    
    if (!response.ok) throw new Error('Registration failed');
    
    const data = await response.json();
    console.log('Device registered:', data);
    
    // Save config
    CONFIG.deviceId = deviceId;
    CONFIG.studentName = studentName;
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

// Send heartbeat with current tab info
async function sendHeartbeat() {
  if (!CONFIG.deviceId) return;
  
  try {
    // Get active tab
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const activeTab = tabs[0];
    
    if (!activeTab) return;
    
    const heartbeatData = {
      deviceId: CONFIG.deviceId,
      activeTabTitle: activeTab.title || 'No title',
      activeTabUrl: activeTab.url || 'No URL',
      favicon: activeTab.favIconUrl || null,
    };
    
    const response = await fetch(`${CONFIG.serverUrl}/api/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(heartbeatData),
    });
    
    if (!response.ok) {
      console.error('Heartbeat failed:', response.status);
    }
    
    // Update badge to show online status
    chrome.action.setBadgeBackgroundColor({ color: '#22c55e' });
    chrome.action.setBadgeText({ text: '●' });
    
  } catch (error) {
    console.error('Heartbeat error:', error);
    chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
    chrome.action.setBadgeText({ text: '!' });
  }
}

// Start periodic heartbeat
function startHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  
  // Send immediate heartbeat
  sendHeartbeat();
  
  // Then send periodically
  heartbeatTimer = setInterval(sendHeartbeat, CONFIG.heartbeatInterval);
  console.log('Heartbeat started');
}

// Stop heartbeat
function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  console.log('Heartbeat stopped');
}

// Connect to WebSocket for signaling
function connectWebSocket() {
  if (!CONFIG.deviceId) return;
  
  const protocol = CONFIG.serverUrl.startsWith('https') ? 'wss' : 'ws';
  const wsUrl = `${protocol}://${new URL(CONFIG.serverUrl).host}/ws`;
  
  ws = new WebSocket(wsUrl);
  
  ws.onopen = () => {
    console.log('WebSocket connected');
    // Authenticate as student
    ws.send(JSON.stringify({
      type: 'auth',
      role: 'student',
      deviceId: CONFIG.deviceId,
    }));
  };
  
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    console.log('WebSocket message:', message);
    
    // Handle WebRTC signaling
    if (message.type === 'signal') {
      chrome.runtime.sendMessage({
        type: 'webrtc-signal',
        data: message.data,
      });
    }
  };
  
  ws.onerror = (error) => {
    console.error('WebSocket error:', error);
  };
  
  ws.onclose = () => {
    console.log('WebSocket disconnected, reconnecting in 5s...');
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
  }
});

// Listen for messages from popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'register') {
    registerDevice(message.studentName, message.classId)
      .then((data) => {
        startHeartbeat();
        connectWebSocket();
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
});

console.log('Classroom Screen Awareness service worker loaded');
