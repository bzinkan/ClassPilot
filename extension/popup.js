// Popup script for ClassPilot

let currentConfig = null;

// Initialize popup
document.addEventListener('DOMContentLoaded', async () => {
  // Get config from background
  chrome.runtime.sendMessage({ type: 'get-config' }, async (response) => {
    const config = response.config;
    currentConfig = config;
    
    if (config.studentName && config.deviceId) {
      // Already registered, show main view
      showMainView(config);
    } else {
      // Check for auto-detected student info
      const stored = await chrome.storage.local.get(['studentEmail', 'studentName']);
      if (stored.studentEmail) {
        // Show main view with auto-detected info
        showMainView({
          studentName: stored.studentName || 'Auto-detected Student',
          studentEmail: stored.studentEmail,
          classId: config.classId || 'default-class',
          deviceId: config.deviceId || 'Registering...',
        });
      } else {
        // Need to register
        showSetupView();
      }
    }
  });
  
  // Setup form submission
  document.getElementById('setup-submit').addEventListener('click', handleSetup);
  
  // Load and display messages
  loadMessages();
  
  // Listen for storage changes to update messages in real-time
  chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'local' && changes.messages) {
      loadMessages();
    }
  });
});

function showSetupView() {
  document.getElementById('setup-view').classList.remove('hidden');
  document.getElementById('main-view').classList.add('hidden');
}

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

async function handleSetup() {
  const deviceId = document.getElementById('device-id').value.trim();
  const deviceNumber = document.getElementById('chromebook-number').value.trim();
  const classroomLocation = document.getElementById('classroom-location').value.trim();
  
  if (!deviceId || !deviceNumber || !classroomLocation) {
    alert('Please fill in all fields');
    return;
  }
  
  // Create device name from device number and classroom location
  const deviceName = `${deviceNumber} - ${classroomLocation}`;
  
  const button = document.getElementById('setup-submit');
  button.disabled = true;
  button.textContent = 'Registering...';
  
  // Send registration to background
  chrome.runtime.sendMessage({
    type: 'register',
    deviceId,
    deviceName,
    classId: classroomLocation, // Use classroom location as classId for now
  }, (response) => {
    if (response.success) {
      showMainView({
        studentName: deviceName, // Display device name until teacher assigns student
        classId: classroomLocation,
        deviceId: deviceId,
      });
    } else {
      alert('Registration failed: ' + response.error);
      button.disabled = false;
      button.textContent = 'Register Chromebook';
    }
  });
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
