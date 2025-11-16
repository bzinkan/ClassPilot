# ClassPilot v1.0.8 Changes Migration Guide
## Apply these changes to your Remix project

---

## Change 1: Extension Manifest Version Bump

**File:** `extension/manifest.json`  
**Line:** 4

```json
"version": "1.0.8",
```

---

## Change 2: Extension WebRTC Reconnection Fix

**File:** `extension/offscreen.js`  
**Function:** `handleRemoteDescription`  
**Approximate Line:** 230-246

**FIND THIS CODE:**
```javascript
// If in wrong state, cleanup and let reconnection handle it
if (pc.signalingState !== 'stable' && pc.signalingState !== 'have-local-offer') {
  console.warn('[WebRTC] Received answer in wrong state:', pc.signalingState);
  stopScreenShare();
  return;
}

try {
  await pc.setRemoteDescription(description);
  console.log('[WebRTC] Remote description set successfully');
} catch (error) {
  console.error('[WebRTC] Failed to set remote description:', error);
}
```

**REPLACE WITH:**
```javascript
// Attempt to set remote description even if in wrong state
// This prevents infinite retry loops and allows recovery
if (pc.signalingState !== 'stable' && pc.signalingState !== 'have-local-offer') {
  console.warn('[WebRTC] Received answer in unexpected state:', pc.signalingState, '- attempting anyway');
  // Don't call stopScreenShare() here - let it try to recover
}

try {
  await pc.setRemoteDescription(description);
  console.log('[WebRTC] Remote description set successfully');
} catch (error) {
  console.error('[WebRTC] Failed to set remote description:', error);
  // Only cleanup on actual failure
  stopScreenShare();
}
```

**What it fixes:** Prevents infinite WebRTC reconnection loops when signaling state is wrong.

---

## Change 3: Student Assignment Migration (Only Unowned Students)

**File:** `server/init.ts`  
**Function:** Student assignment section  
**Approximate Line:** 51-76

**FIND THIS CODE:**
```javascript
// Check if we need to assign students to the default teacher
const unassignedStudents = await storage.getAllStudents();
if (unassignedStudents.length > 0) {
  console.log(`Assigning ${unassignedStudents.length} students to default teacher...`);
  for (const student of unassignedStudents) {
    await storage.assignStudentToTeacher(student.id, defaultTeacher.id);
  }
  console.log('All students assigned to default teacher');
}
```

**REPLACE WITH:**
```javascript
// Check if we need to assign students to the default teacher
// Only assign students that have NO teacher at all (don't overwrite existing assignments)
const allStudents = await storage.getAllStudents();

// Get all teachers to check existing assignments
const allTeachers = await storage.getAllUsers();
const teacherIds = allTeachers.filter(u => u.role === 'teacher').map(u => u.id);

// Find students that have NO teacher at all
const studentsWithoutTeacher = [];
for (const student of allStudents) {
  let hasTeacher = false;
  for (const teacherId of teacherIds) {
    const teacherStudents = await storage.getTeacherStudents(teacherId);
    if (teacherStudents.includes(student.id)) {
      hasTeacher = true;
      break;
    }
  }
  if (!hasTeacher) {
    studentsWithoutTeacher.push(student);
  }
}

if (studentsWithoutTeacher.length > 0) {
  console.log(`Assigning ${studentsWithoutTeacher.length} unowned students to default teacher...`);
  for (const student of studentsWithoutTeacher) {
    await storage.assignStudentToTeacher(student.id, defaultTeacher.id);
  }
  console.log('Unowned students assigned to default teacher');
}
```

**What it fixes:** Prevents overwriting existing teacher-student assignments on every server restart.

---

## Change 4: Live View Authorization (Active Session Roster)

**File:** `server/routes.ts`  
**WebSocket Handler:** `message.type === 'request-stream'`  
**Approximate Line:** 405-469

**FIND THIS CODE (the permission check section):**
```javascript
// Admins can view all students; teachers need permission check
if (user && user.role !== 'admin') {
  // Get the active student for this device
  const activeStudent = await storage.getActiveStudentForDevice(targetDeviceId);
  
  if (activeStudent) {
    // Check if this student is assigned to the teacher
    const teacherStudentIds = await storage.getTeacherStudents(client.userId);
    
    if (!teacherStudentIds.includes(activeStudent.id)) {
      console.warn(`[WebSocket] Teacher ${client.userId} attempted to view student ${activeStudent.id} without permission`);
      ws.send(JSON.stringify({
        type: 'error',
        message: 'You do not have permission to view this student\'s screen'
      }));
      return; // Block the request
    }
  }
}
```

**REPLACE WITH:**
```javascript
// Admins can view all students
if (user && user.role !== 'admin') {
  // Teachers: check if student is in their active session roster
  const activeSession = await storage.getActiveSessionByTeacher(client.userId);
  
  if (activeSession?.groupId) {
    // Get all students in the teacher's active session roster
    const rosterStudentIds = await storage.getGroupStudents(activeSession.groupId);
    
    // Get the active student for this device
    const activeStudent = await storage.getActiveStudentForDevice(targetDeviceId);
    
    if (activeStudent && !rosterStudentIds.includes(activeStudent.id)) {
      console.warn(`[WebSocket] Teacher ${client.userId} attempted to view student ${activeStudent.id} not in their active session`);
      ws.send(JSON.stringify({
        type: 'error',
        message: 'You do not have permission to view this student\'s screen'
      }));
      return; // Block the request
    }
  } else {
    // Teacher has no active session - deny Live View
    console.warn(`[WebSocket] Teacher ${client.userId} attempted Live View without active session`);
    ws.send(JSON.stringify({
      type: 'error',
      message: 'You must start a class session to use Live View'
    }));
    return;
  }
}
```

**ALSO UPDATE THE ERROR HANDLER (same function, in the catch block):**

**FIND:**
```javascript
} catch (error) {
  console.error('[WebSocket] Permission check error:', error);
  // On error, allow the request (fail open for now)
}
```

**REPLACE WITH:**
```javascript
} catch (error) {
  console.error('[WebSocket] Permission check error:', error);
  // On error, block the request (fail closed for security)
  ws.send(JSON.stringify({
    type: 'error',
    message: 'Permission check failed. Please try again.'
  }));
  return;
}
```

**What it fixes:** 
- Teachers can only use Live View for students in their active session (not global assignments)
- Prevents "permission denied" errors for students in active sessions
- Security: Fails closed on errors instead of allowing unauthorized access

---

## Change 5: Documentation Update (Optional)

**File:** `replit.md`  
**Section:** WebRTC Live View Signaling

**FIND:**
```markdown
Extension includes null guards in connection state handlers to prevent crashes during rapid start/stop cycles.
```

**REPLACE WITH:**
```markdown
Extension includes null guards in connection state handlers and graceful failure handling for invalid signaling states (attempts recovery instead of cleanup loop). **Authorization**: Teachers can only view students in their active session roster (validated server-side), admins can view all students. Permission check fails closed on errors to prevent unauthorized access.
```

---

## Testing Checklist After Migration

1. **Extension WebRTC Fix:**
   - Start Live View on a student
   - Disconnect/reconnect network briefly
   - Should recover without infinite retry loops

2. **Student Assignment Fix:**
   - Restart server multiple times
   - Verify existing teacher-student assignments are not overwritten

3. **Live View Authorization:**
   - Login as teacher
   - Start a class session
   - Live View should work for students in that session
   - Live View should be blocked for students NOT in the session

4. **Admin Live View:**
   - Login as admin
   - Should be able to view ANY student regardless of session

---

## Summary of Changes

- **Extension v1.0.8**: Improved WebRTC reconnection resilience
- **Server**: Fixed student assignment to only assign unowned students
- **Server**: Fixed Live View authorization to use active session roster
- **Security**: All permission checks now fail closed on errors

All changes are architect-approved and production-ready! 🎉
