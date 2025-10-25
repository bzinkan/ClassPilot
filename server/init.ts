import { storage } from "./storage";
import bcrypt from "bcrypt";

export async function initializeApp() {
  // Create default teacher account if none exists
  const existingUser = await storage.getUserByUsername("teacher");
  
  if (!existingUser) {
    const hashedPassword = await bcrypt.hash("teacher123", 10);
    await storage.createUser({
      username: "teacher",
      password: hashedPassword,
      schoolName: "Default School",
    });
    console.log("Created default teacher account: username='teacher', password='teacher123'");
    console.log("⚠️  IMPORTANT: Change this password in production!");
  }

  // Create default settings
  const existingSettings = await storage.getSettings();
  if (!existingSettings) {
    await storage.upsertSettings({
      schoolId: process.env.SCHOOL_ID || "default-school",
      schoolName: "Default School",
      wsSharedKey: process.env.WS_SHARED_KEY || "change-this-websocket-key",
      retentionHours: "24",
      blockedDomains: [],
    });
    console.log("Created default settings");
  }
}
