import { db } from "../server/db";
import { students } from "../shared/schema";
import { normalizeEmail } from "../shared/utils";
import { eq } from "drizzle-orm";

async function backfillEmails() {
  console.log("Starting email normalization backfill...");
  
  try {
    // Get all students
    const allStudents = await db.select().from(students);
    console.log(`Found ${allStudents.length} students to process`);
    
    let updated = 0;
    let skipped = 0;
    let errors = 0;
    
    for (const student of allStudents) {
      if (!student.studentEmail) {
        skipped++;
        continue;
      }
      
      const normalizedEmail = normalizeEmail(student.studentEmail);
      
      // Check if email is already normalized
      if (normalizedEmail === student.studentEmail) {
        skipped++;
        continue;
      }
      
      try {
        // Update to normalized email
        await db
          .update(students)
          .set({ studentEmail: normalizedEmail })
          .where(eq(students.id, student.id));
        
        console.log(`Updated: ${student.studentEmail} → ${normalizedEmail}`);
        updated++;
      } catch (error) {
        console.error(`Error updating student ${student.id}:`, error);
        errors++;
      }
    }
    
    console.log("\nBackfill complete!");
    console.log(`Updated: ${updated}`);
    console.log(`Skipped (already normalized): ${skipped}`);
    console.log(`Errors: ${errors}`);
    
    process.exit(0);
  } catch (error) {
    console.error("Fatal error during backfill:", error);
    process.exit(1);
  }
}

backfillEmails();
