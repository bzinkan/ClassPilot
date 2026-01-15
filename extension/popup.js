// Popup script for ClassPilot
// EMAIL-FIRST: No manual registration - auto-detect from Chrome profile

let currentConfig = null;

// Initialize popup
document.addEventListener('DOMContentLoaded', async () => {
  // Get config from background
  chrome.runtime.sendMessage({ type: 'get-config' }, async (response) => {
    const config = response.config;
    currentConfig = config;

    // ALWAYS show main view with auto-detected info (no manual registration)
    showMainView(config);
    updateLicenseBanner();
  });

  // Load and display messages
  loadMessages();

  // Initialize raise hand functionality
  initRaiseHand();
  
  // Listen for storage changes to update messages in real-time
  chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'local' && changes.messages) {
      loadMessages();
    }
    if (namespace === 'local' && (changes.licenseActive || changes.planStatus)) {
      updateLicenseBanner();
    }
  });
});

function showMainView(config) {
  document.getElementById('setup-view').classList.add('hidden');
  document.getElementById('main-view').classList.remove('hidden');
  
  // Update UI with config
  document.getElementById('school-name').textContent = config.schoolId || 'School';
  document.getElementById('student-name-display').textContent = config.studentName || '-';
  document.getElementById('class-id-display').textContent = config.classId || '-';
  
  // Update auto-detected student info
  if (config.studentEmail) {
    document.getElementById('detected-student-name').textContent = config.studentName || 'Auto-detected Student';
    document.getElementById('detected-student-email').textContent = config.studentEmail;
  } else {
    // Fallback if no email detected
    document.getElementById('detected-student-name').textContent = config.studentName || '-';
    document.getElementById('detected-student-email').textContent = 'No email detected';
  }
  
  // Update status
  updateStatus();
  
  // Update status every 5 seconds
  setInterval(updateStatus, 5000);
}

function updateStatus() {
  chrome.action.getBadgeText({}, (text) => {
    const statusDot = document.getElementById('status-dot');
    const statusText = document.getElementById('status-text');
    
    if (text === '●') {
      statusDot.className = 'status-dot online';
      statusText.textContent = 'Connected';
    } else {
      statusDot.className = 'status-dot offline';
      statusText.textContent = 'Disconnected';
    }
  });
  
  // Update last update time
  const now = new Date();
  document.getElementById('last-update').textContent = now.toLocaleTimeString();
}

async function updateLicenseBanner() {
  const stored = await chrome.storage.local.get(['licenseActive', 'planStatus']);
  const bannerTitle = document.getElementById('license-banner-title');
  const bannerText = document.getElementById('license-banner-text');
  if (!bannerTitle || !bannerText) {
    return;
  }

  if (stored.licenseActive === false) {
    const planStatus = stored.planStatus ? ` (planStatus=${stored.planStatus})` : '';
    bannerTitle.textContent = 'Monitoring Disabled';
    bannerText.textContent = `ClassPilot disabled: school license inactive${planStatus}.`;
  } else {
    bannerTitle.textContent = 'Monitoring Active';
    bannerText.textContent = 'Your tab titles and URLs are shared with your teacher as permitted by school policy.';
  }
}

async function loadStudents(deviceId) {
  try {
    const serverUrl = currentConfig.serverUrl || 'https://classpilot.replit.app';
    const response = await fetch(`${serverUrl}/api/device/${deviceId}/students`);
    
    if (!response.ok) {
      throw new Error('Failed to load students');
    }
    
    const data = await response.json();
    const { students, activeStudentId } = data;
    
    const selectElement = document.getElementById('student-select');
    const currentStudentDisplay = document.getElementById('current-student-display');
    const currentStudentName = document.getElementById('current-student-name');
    const noStudentsMessage = document.getElementById('no-students-message');
    
    if (!students || students.length === 0) {
      selectElement.innerHTML = '<option value="">No students assigned</option>';
      selectElement.disabled = true;
      noStudentsMessage.classList.remove('hidden');
      currentStudentDisplay.classList.add('hidden');
      return;
    }
    
    // Populate dropdown
    selectElement.innerHTML = '<option value="">Select your name...</option>';
    students.forEach(student => {
      const option = document.createElement('option');
      option.value = student.id;
      option.textContent = student.studentName;
      selectElement.appendChild(option);
    });
    
    selectElement.disabled = false;
    noStudentsMessage.classList.add('hidden');
    
    // If there's an active student, show it
    if (activeStudentId) {
      const activeStudent = students.find(s => s.id === activeStudentId);
      if (activeStudent) {
        selectElement.value = activeStudentId;
        currentStudentName.textContent = activeStudent.studentName;
        currentStudentDisplay.classList.remove('hidden');
      }
    }
    
  } catch (error) {
    console.error('Error loading students:', error);
    const selectElement = document.getElementById('student-select');
    selectElement.innerHTML = '<option value="">Error loading students</option>';
    selectElement.disabled = true;
  }
}

async function setActiveStudent(studentId) {
  if (!currentConfig || !currentConfig.deviceId) {
    console.error('No device ID available');
    return;
  }
  
  try {
    const serverUrl = currentConfig.serverUrl || 'https://classpilot.replit.app';
    const response = await fetch(`${serverUrl}/api/device/${currentConfig.deviceId}/active-student`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ studentId }),
    });
    
    if (!response.ok) {
      throw new Error('Failed to set active student');
    }
    
    // Save to chrome.storage.local
    await chrome.storage.local.set({ activeStudentId: studentId });
    
    // Notify background to send immediate heartbeat with new studentId
    chrome.runtime.sendMessage({ 
      type: 'student-changed',
      studentId 
    });
    
    console.log('Active student set:', studentId);
    
  } catch (error) {
    console.error('Error setting active student:', error);
    alert('Failed to set active student. Please try again.');
  }
}

async function handleStudentSelection(event) {
  const studentId = event.target.value;
  
  if (!studentId) {
    document.getElementById('current-student-display').classList.add('hidden');
    return;
  }
  
  // Get student name from selected option
  const selectedOption = event.target.options[event.target.selectedIndex];
  const studentName = selectedOption.textContent;
  
  // Update UI immediately
  document.getElementById('current-student-name').textContent = studentName;
  document.getElementById('current-student-display').classList.remove('hidden');
  
  // Call API to set active student
  await setActiveStudent(studentId);
}

async function loadMessages() {
  const stored = await chrome.storage.local.get(['messages']);
  const messages = stored.messages || [];
  
  const container = document.getElementById('messages-container');
  
  if (messages.length === 0) {
    container.innerHTML = `
      <p style="font-size: 12px; color: #94a3b8; text-align: center; padding: 20px;">
        No messages yet
      </p>
    `;
    return;
  }
  
  // Sort messages by timestamp (newest first)
  const sortedMessages = messages.sort((a, b) => b.timestamp - a.timestamp);
  
  // Build HTML for all messages
  let html = '';
  sortedMessages.forEach((msg, index) => {
    const unreadClass = msg.read ? '' : 'unread';
    
    const time = new Date(msg.timestamp).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
    
    html += `
      <div class="message-item ${unreadClass}">
        <div class="message-header">
          <span class="message-title">💬 MESSAGE</span>
          <span class="message-time">${time}</span>
        </div>
        <div class="message-content">${msg.message}</div>
      </div>
    `;
  });
  
  // Add clear button
  html += `
    <button class="clear-messages" id="clear-messages-btn">
      Clear All Messages
    </button>
  `;
  
  container.innerHTML = html;
  
  // Add event listener to clear button
  document.getElementById('clear-messages-btn')?.addEventListener('click', clearMessages);
  
  // Mark all messages as read
  markMessagesAsRead();
}

async function markMessagesAsRead() {
  const stored = await chrome.storage.local.get(['messages']);
  const messages = stored.messages || [];
  
  // Mark all as read
  const updatedMessages = messages.map(msg => ({ ...msg, read: true }));
  
  await chrome.storage.local.set({ messages: updatedMessages });
  
  // Clear badge
  chrome.action.setBadgeText({ text: '' });
}

async function clearMessages() {
  if (confirm('Are you sure you want to clear all messages?')) {
    await chrome.storage.local.set({ messages: [] });
    loadMessages();
  }
}

// Raise hand functionality
let handRaised = false;

async function initRaiseHand() {
  const stored = await chrome.storage.local.get(['handRaised', 'messagingEnabled']);
  handRaised = stored.handRaised || false;

  updateRaiseHandUI(handRaised, stored.messagingEnabled !== false);

  // Add event listeners
  document.getElementById('raise-hand-btn')?.addEventListener('click', raiseHand);
  document.getElementById('lower-hand-btn')?.addEventListener('click', lowerHand);
}

function updateRaiseHandUI(isRaised, messagingEnabled = true) {
  const raiseBtn = document.getElementById('raise-hand-btn');
  const raisedStatus = document.getElementById('hand-raised-status');
  const disabledMsg = document.getElementById('messaging-disabled');

  if (!messagingEnabled) {
    raiseBtn?.classList.add('hidden');
    raisedStatus?.classList.add('hidden');
    disabledMsg?.classList.remove('hidden');
    return;
  }

  disabledMsg?.classList.add('hidden');

  if (isRaised) {
    raiseBtn?.classList.add('hidden');
    raisedStatus?.classList.remove('hidden');
  } else {
    raiseBtn?.classList.remove('hidden');
    raisedStatus?.classList.add('hidden');
  }
}

async function raiseHand() {
  const btn = document.getElementById('raise-hand-btn');
  btn.disabled = true;
  btn.textContent = 'Raising...';

  try {
    // Send to background script
    chrome.runtime.sendMessage({ type: 'raise-hand' }, (response) => {
      if (response?.success) {
        handRaised = true;
        chrome.storage.local.set({ handRaised: true });
        updateRaiseHandUI(true);
      } else {
        btn.disabled = false;
        btn.textContent = '✋ Raise Hand';
        alert(response?.error || 'Failed to raise hand. Please try again.');
      }
    });
  } catch (error) {
    console.error('Error raising hand:', error);
    btn.disabled = false;
    btn.textContent = '✋ Raise Hand';
    alert('Failed to raise hand. Please try again.');
  }
}

async function lowerHand() {
  try {
    chrome.runtime.sendMessage({ type: 'lower-hand' }, (response) => {
      if (response?.success) {
        handRaised = false;
        chrome.storage.local.set({ handRaised: false });
        updateRaiseHandUI(false);
      } else {
        alert(response?.error || 'Failed to lower hand. Please try again.');
      }
    });
  } catch (error) {
    console.error('Error lowering hand:', error);
    alert('Failed to lower hand. Please try again.');
  }
}

function showPrivacyInfo() {
  alert(`What's Being Collected?

✓ Active Tab Title - The title of the webpage you're viewing
✓ Active Tab URL - The web address you're visiting
✓ Timestamps - When you visited each page
✓ Favicon - The small icon from the website

✗ NOT Collected:
- Keystrokes or what you type
- Microphone or camera access
- Private messages or passwords
- Screen captures (unless you opt-in to screen sharing)
- Anything from incognito/private windows

Automatic Monitoring:
- Tab titles and URLs are automatically collected and sent to your teacher
- This happens every 10 seconds while you browse
- This is required by your school policy for classroom management

Screen Sharing (Optional):
- You can optionally share your screen with your teacher
- Click "Share My Screen" to begin
- A red indicator shows when sharing is active
- You can stop sharing at any time

Data Retention:
- Your activity data is automatically deleted after 24 hours
- Your teacher can export reports for educational purposes

This monitoring is required by your school for classroom management. All activity is visible and disclosed to you through this extension.`);
}
