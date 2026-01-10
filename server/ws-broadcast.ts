import { WebSocket } from "ws";

export type WsRole = "teacher" | "school_admin" | "super_admin" | "student";

export type WSClient = {
  ws: WebSocket;
  role: WsRole;
  deviceId?: string;
  userId?: string;
  schoolId?: string;
  authenticated: boolean;
};

const wsClients = new Map<WebSocket, WSClient>();
const teacherSocketsBySchool = new Map<string, Set<WebSocket>>();
const studentSocketsBySchool = new Map<string, Set<WebSocket>>();

function addSocket(map: Map<string, Set<WebSocket>>, schoolId: string, ws: WebSocket) {
  const existing = map.get(schoolId);
  if (existing) {
    existing.add(ws);
    return;
  }
  map.set(schoolId, new Set([ws]));
}

function removeSocket(map: Map<string, Set<WebSocket>>, schoolId: string, ws: WebSocket) {
  const existing = map.get(schoolId);
  if (!existing) {
    return;
  }
  existing.delete(ws);
  if (existing.size === 0) {
    map.delete(schoolId);
  }
}

function isStaffRole(role: WsRole): boolean {
  return role === "teacher" || role === "school_admin" || role === "super_admin";
}

export function registerWsClient(ws: WebSocket): WSClient {
  const client: WSClient = {
    ws,
    role: "student",
    authenticated: false,
  };
  wsClients.set(ws, client);
  return client;
}

export function getWsClient(ws: WebSocket): WSClient | undefined {
  return wsClients.get(ws);
}

export function authenticateWsClient(
  ws: WebSocket,
  auth: {
    role: WsRole;
    schoolId: string;
    deviceId?: string;
    userId?: string;
  }
): WSClient | undefined {
  const client = wsClients.get(ws);
  if (!client) {
    return undefined;
  }
  if (client.schoolId) {
    const map = client.role === "student" ? studentSocketsBySchool : teacherSocketsBySchool;
    removeSocket(map, client.schoolId, ws);
  }
  client.role = auth.role;
  client.schoolId = auth.schoolId;
  client.deviceId = auth.deviceId;
  client.userId = auth.userId;
  client.authenticated = true;

  if (auth.role === "student") {
    addSocket(studentSocketsBySchool, auth.schoolId, ws);
  } else {
    addSocket(teacherSocketsBySchool, auth.schoolId, ws);
  }

  return client;
}

export function removeWsClient(ws: WebSocket) {
  const client = wsClients.get(ws);
  if (client?.schoolId) {
    const map = client.role === "student" ? studentSocketsBySchool : teacherSocketsBySchool;
    removeSocket(map, client.schoolId, ws);
  }
  wsClients.delete(ws);
}

export function broadcastToTeachersLocal(schoolId: string, message: unknown): number {
  const sockets = teacherSocketsBySchool.get(schoolId);
  if (!sockets) {
    return 0;
  }
  const messageStr = JSON.stringify(message);
  let sentCount = 0;
  sockets.forEach((ws) => {
    const client = wsClients.get(ws);
    if (!client || !client.authenticated || !isStaffRole(client.role)) {
      return;
    }
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(messageStr);
      sentCount++;
    }
  });
  return sentCount;
}

export function broadcastToStudentsLocal(
  schoolId: string,
  message: unknown,
  filterFn?: (client: WSClient) => boolean,
  targetDeviceIds?: string[]
): number {
  const sockets = studentSocketsBySchool.get(schoolId);
  if (!sockets) {
    return 0;
  }
  const messageStr = JSON.stringify(message);
  let sentCount = 0;
  sockets.forEach((ws) => {
    const client = wsClients.get(ws);
    if (!client || client.role !== "student" || !client.authenticated) {
      return;
    }
    if (targetDeviceIds && targetDeviceIds.length > 0 && !targetDeviceIds.includes(client.deviceId ?? "")) {
      return;
    }
    if (!filterFn || filterFn(client)) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(messageStr);
        sentCount++;
      }
    }
  });
  return sentCount;
}

export function sendToDeviceLocal(schoolId: string, deviceId: string, message: unknown) {
  const sockets = studentSocketsBySchool.get(schoolId);
  const msgType = (message as { type?: string })?.type ?? 'unknown';
  if (!sockets) {
    console.log(`[WS-Local] No sockets for school ${schoolId} to deliver ${msgType} to ${deviceId}`);
    return;
  }
  const messageStr = JSON.stringify(message);
  let sent = false;
  sockets.forEach((ws) => {
    const client = wsClients.get(ws);
    if (!client || !client.authenticated || client.deviceId !== deviceId) {
      return;
    }
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(messageStr);
      sent = true;
      console.log(`[WS-Local] Sent ${msgType} to device ${deviceId}`);
    }
  });
  if (!sent) {
    console.log(`[WS-Local] Device ${deviceId} not found locally for ${msgType}`);
  }
}

export function sendToRoleLocal(schoolId: string, role: WsRole, message: unknown) {
  const sockets = role === "student" ? studentSocketsBySchool.get(schoolId) : teacherSocketsBySchool.get(schoolId);
  if (!sockets) {
    return;
  }
  const messageStr = JSON.stringify(message);
  sockets.forEach((ws) => {
    const client = wsClients.get(ws);
    if (!client || client.role !== role || !client.authenticated) {
      return;
    }
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(messageStr);
    }
  });
}

export function closeSocketsForSchool(schoolId: string) {
  const teacherSockets = teacherSocketsBySchool.get(schoolId);
  if (teacherSockets) {
    teacherSockets.forEach((ws) => ws.close());
    teacherSocketsBySchool.delete(schoolId);
  }
  const studentSockets = studentSocketsBySchool.get(schoolId);
  if (studentSockets) {
    studentSockets.forEach((ws) => ws.close());
    studentSocketsBySchool.delete(schoolId);
  }
}

export function resetWsState() {
  wsClients.clear();
  teacherSocketsBySchool.clear();
  studentSocketsBySchool.clear();
}
