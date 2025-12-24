import { describe, expect, it } from "vitest";
import { parseCsv } from "../util/csv";

describe("parseCsv", () => {
  const options = {
    requiredHeaders: ["Email", "Name"],
    optionalHeaders: ["Grade", "Class"],
  };

  it("parses valid CSV with required headers", () => {
    const csv = "Email,Name,Grade,Class\n student@school.edu , Jane Doe ,7, 7th Math ";
    const records = parseCsv(csv, options);
    expect(records).toHaveLength(1);
    expect(records[0]).toEqual({
      Email: "student@school.edu",
      Name: "Jane Doe",
      Grade: "7",
      Class: "7th Math",
    });
  });

  it("rejects unknown headers", () => {
    const csv = "Email,Name,Nickname\nstudent@school.edu,Jane Doe,JD";
    expect(() => parseCsv(csv, options)).toThrow("unknown header");
  });

  it("enforces row limits", () => {
    const csv = "Email,Name\nstudent1@school.edu,Jane\nstudent2@school.edu,John";
    expect(() => parseCsv(csv, { ...options, maxRows: 1 })).toThrow("row limit");
  });
});
