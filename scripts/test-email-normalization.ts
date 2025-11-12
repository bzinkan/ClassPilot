import { db } from "../server/db";
import { students, devices } from "../shared/schema";
import { normalizeEmail } from "../shared/utils";
import { DatabaseStorage } from "../server/storage";
import { eq } from "drizzle-orm";

async function testEmailNormalization() {
  console.log("Testing email normalization...\n");
  
  const storage = new DatabaseStorage();
  let testsPassed = 0;
  let testsFailed = 0;
  
  // Clean up any existing test data
  console.log("Cleaning up test data...");
  await db.delete(students).where(eq(students.studentName, "Test Student"));
  await db.delete(devices).where(eq(devices.deviceId, "test-device-001"));
  
  try {
    // Test 1: normalizeEmail helper works correctly
    console.log("Test 1: normalizeEmail helper");
    const email1 = normalizeEmail("Lucy.Garcia@District.org");
    const email2 = normalizeEmail("  LUCY.garcia@DISTRICT.ORG  ");
    const email3 = normalizeEmail("lucy.garcia@district.org");
    
    if (email1 === email2 && email2 === email3 && email1 === "lucy.garcia@district.org") {
      console.log("✓ PASS: normalizeEmail works correctly");
      console.log(`  All variations normalize to: ${email1}\n`);
      testsPassed++;
    } else {
      console.log("✗ FAIL: normalizeEmail not working");
      console.log(`  Results: ${email1}, ${email2}, ${email3}\n`);
      testsFailed++;
    }
    
    // Test 2: Create student with mixed-case email
    console.log("Test 2: Create student with mixed-case email");
    
    // First create a device for the student
    const device = await storage.registerDevice({
      deviceId: "test-device-001",
      deviceName: "Test Device",
      classId: "test-class",
      schoolId: "test-school",
    });
    
    const student1 = await storage.createStudent({
      deviceId: "test-device-001",
      studentName: "Test Student",
      studentEmail: "Test.Student@Example.com",
      gradeLevel: "7",
    });
    
    if (student1.studentEmail === "test.student@example.com") {
      console.log("✓ PASS: Email was normalized during creation");
      console.log(`  Stored as: ${student1.studentEmail}\n`);
      testsPassed++;
    } else {
      console.log("✗ FAIL: Email was not normalized");
      console.log(`  Stored as: ${student1.studentEmail}\n`);
      testsFailed++;
    }
    
    // Test 3: getStudentByEmail is case-insensitive
    console.log("Test 3: getStudentByEmail case-insensitive lookup");
    
    const foundStudent1 = await storage.getStudentByEmail("test.student@example.com");
    const foundStudent2 = await storage.getStudentByEmail("TEST.STUDENT@EXAMPLE.COM");
    const foundStudent3 = await storage.getStudentByEmail("  Test.Student@Example.Com  ");
    
    if (foundStudent1 && foundStudent2 && foundStudent3 &&
        foundStudent1.id === student1.id &&
        foundStudent2.id === student1.id &&
        foundStudent3.id === student1.id) {
      console.log("✓ PASS: Case-insensitive lookup works");
      console.log("  All variations found the same student\n");
      testsPassed++;
    } else {
      console.log("✗ FAIL: Case-insensitive lookup failed");
      console.log(`  Results: ${foundStudent1?.id}, ${foundStudent2?.id}, ${foundStudent3?.id}\n`);
      testsFailed++;
    }
    
    // Test 4: Attempt to create duplicate with different case (should find existing)
    console.log("Test 4: Duplicate prevention");
    
    // This should find the existing student
    const existingStudent = await storage.getStudentByEmail("TEST.STUDENT@EXAMPLE.COM");
    
    if (existingStudent && existingStudent.id === student1.id) {
      console.log("✓ PASS: Duplicate prevention works");
      console.log("  System would detect existing student before creating duplicate\n");
      testsPassed++;
    } else {
      console.log("✗ FAIL: Duplicate prevention failed\n");
      testsFailed++;
    }
    
    // Test 5: Update student email normalizes it
    console.log("Test 5: Update student email normalization");
    
    const updatedStudent = await storage.updateStudent(student1.id, {
      studentEmail: "UPDATED.EMAIL@EXAMPLE.COM",
    });
    
    if (updatedStudent && updatedStudent.studentEmail === "updated.email@example.com") {
      console.log("✓ PASS: Email update is normalized");
      console.log(`  Updated to: ${updatedStudent.studentEmail}\n`);
      testsPassed++;
    } else {
      console.log("✗ FAIL: Email update not normalized");
      console.log(`  Updated to: ${updatedStudent?.studentEmail}\n`);
      testsFailed++;
    }
    
  } catch (error) {
    console.error("Error during testing:", error);
    testsFailed++;
  } finally {
    // Clean up test data
    console.log("Cleaning up test data...");
    await db.delete(students).where(eq(students.studentName, "Test Student"));
    await db.delete(devices).where(eq(devices.deviceId, "test-device-001"));
  }
  
  console.log("\n" + "=".repeat(50));
  console.log(`Tests Passed: ${testsPassed}`);
  console.log(`Tests Failed: ${testsFailed}`);
  console.log("=".repeat(50));
  
  process.exit(testsFailed > 0 ? 1 : 0);
}

testEmailNormalization();
