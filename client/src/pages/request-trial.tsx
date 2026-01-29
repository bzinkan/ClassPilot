import { useState } from "react";
import { Link } from "wouter";

export default function RequestTrial() {
  const [formData, setFormData] = useState({
    schoolName: "",
    schoolDomain: "",
    adminFirstName: "",
    adminLastName: "",
    adminEmail: "",
    adminPhone: "",
    zipCode: "",
    estimatedStudents: "",
    estimatedTeachers: "",
    message: "",
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSubmitted, setIsSubmitted] = useState(false);
  const [error, setError] = useState("");

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setError("");

    try {
      const response = await fetch("/api/trial-requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(formData),
      });

      if (!response.ok) {
        throw new Error("Failed to submit request");
      }

      setIsSubmitted(true);
    } catch (err) {
      setError("There was an error submitting your request. Please try again or email us directly at info@school-pilot.net");
    } finally {
      setIsSubmitting(false);
    }
  };

  const styles = {
    page: {
      minHeight: "100vh",
      backgroundColor: "#0f172a",
      fontFamily: "'Inter', sans-serif",
    },
    header: {
      padding: "1.5rem 2rem",
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      maxWidth: "1200px",
      margin: "0 auto",
    },
    logo: {
      display: "flex",
      alignItems: "center",
      gap: "0.75rem",
      textDecoration: "none",
    },
    logoIcon: {
      width: "40px",
      height: "40px",
      backgroundColor: "#fbbf24",
      borderRadius: "10px",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      fontSize: "1.25rem",
    },
    logoText: {
      fontSize: "1.5rem",
      fontWeight: "700",
      color: "white",
      fontFamily: "'Instrument Serif', serif",
    },
    main: {
      maxWidth: "700px",
      margin: "0 auto",
      padding: "2rem 2rem 4rem",
    },
    heroSection: {
      textAlign: "center" as const,
      marginBottom: "3rem",
    },
    title: {
      fontSize: "2.5rem",
      fontWeight: "700",
      color: "white",
      marginBottom: "1rem",
      fontFamily: "'Instrument Serif', serif",
    },
    subtitle: {
      fontSize: "1.125rem",
      color: "#94a3b8",
      lineHeight: "1.7",
      maxWidth: "600px",
      margin: "0 auto",
    },
    formCard: {
      backgroundColor: "#1e293b",
      borderRadius: "16px",
      padding: "2.5rem",
      border: "1px solid #334155",
    },
    formGroup: {
      marginBottom: "1.5rem",
    },
    label: {
      display: "block",
      color: "#e2e8f0",
      fontSize: "0.875rem",
      fontWeight: "500",
      marginBottom: "0.5rem",
    },
    required: {
      color: "#fbbf24",
      marginLeft: "0.25rem",
    },
    input: {
      width: "100%",
      padding: "0.875rem 1rem",
      backgroundColor: "#0f172a",
      border: "1px solid #334155",
      borderRadius: "8px",
      color: "white",
      fontSize: "1rem",
      outline: "none",
      transition: "border-color 0.2s",
      boxSizing: "border-box" as const,
    },
    inputFocus: {
      borderColor: "#fbbf24",
    },
    row: {
      display: "grid",
      gridTemplateColumns: "1fr 1fr",
      gap: "1rem",
    },
    select: {
      width: "100%",
      padding: "0.875rem 1rem",
      backgroundColor: "#0f172a",
      border: "1px solid #334155",
      borderRadius: "8px",
      color: "white",
      fontSize: "1rem",
      outline: "none",
      cursor: "pointer",
      boxSizing: "border-box" as const,
    },
    textarea: {
      width: "100%",
      padding: "0.875rem 1rem",
      backgroundColor: "#0f172a",
      border: "1px solid #334155",
      borderRadius: "8px",
      color: "white",
      fontSize: "1rem",
      outline: "none",
      minHeight: "120px",
      resize: "vertical" as const,
      fontFamily: "'Inter', sans-serif",
      boxSizing: "border-box" as const,
    },
    submitButton: {
      width: "100%",
      padding: "1rem 2rem",
      backgroundColor: "#fbbf24",
      color: "#0f172a",
      border: "none",
      borderRadius: "8px",
      fontSize: "1rem",
      fontWeight: "600",
      cursor: "pointer",
      transition: "all 0.2s",
      marginTop: "1rem",
    },
    submitButtonDisabled: {
      opacity: 0.7,
      cursor: "not-allowed",
    },
    error: {
      backgroundColor: "#7f1d1d",
      color: "#fecaca",
      padding: "1rem",
      borderRadius: "8px",
      marginBottom: "1.5rem",
      fontSize: "0.875rem",
    },
    successCard: {
      backgroundColor: "#1e293b",
      borderRadius: "16px",
      padding: "3rem",
      border: "1px solid #334155",
      textAlign: "center" as const,
    },
    successIcon: {
      width: "80px",
      height: "80px",
      backgroundColor: "#166534",
      borderRadius: "50%",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      margin: "0 auto 1.5rem",
      fontSize: "2.5rem",
    },
    successTitle: {
      fontSize: "1.75rem",
      fontWeight: "700",
      color: "white",
      marginBottom: "1rem",
      fontFamily: "'Instrument Serif', serif",
    },
    successText: {
      color: "#94a3b8",
      fontSize: "1rem",
      lineHeight: "1.7",
      marginBottom: "2rem",
    },
    backLink: {
      display: "inline-block",
      padding: "0.875rem 2rem",
      backgroundColor: "#fbbf24",
      color: "#0f172a",
      textDecoration: "none",
      borderRadius: "8px",
      fontWeight: "600",
      transition: "all 0.2s",
    },
    sectionTitle: {
      fontSize: "1.125rem",
      fontWeight: "600",
      color: "#fbbf24",
      marginBottom: "1.25rem",
      paddingBottom: "0.75rem",
      borderBottom: "1px solid #334155",
    },
    hint: {
      fontSize: "0.75rem",
      color: "#64748b",
      marginTop: "0.375rem",
    },
    loginLink: {
      textAlign: "center" as const,
      marginTop: "1.5rem",
      color: "#94a3b8",
      fontSize: "0.875rem",
    },
    link: {
      color: "#fbbf24",
      textDecoration: "none",
    },
  };

  if (isSubmitted) {
    return (
      <div style={styles.page}>
        <link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />

        <header style={styles.header}>
          <Link href="/" style={styles.logo}>
            <div style={styles.logoIcon}>✈️</div>
            <span style={styles.logoText}>ClassPilot</span>
          </Link>
        </header>

        <main style={styles.main}>
          <div style={styles.successCard}>
            <div style={styles.successIcon}>✓</div>
            <h1 style={styles.successTitle}>Request Submitted!</h1>
            <p style={styles.successText}>
              Thank you for your interest in ClassPilot. We've received your trial request and will review it shortly.
              <br /><br />
              A member of our team will reach out to <strong style={{ color: "white" }}>{formData.adminEmail}</strong> within 1-2 business days to set up your school's trial account.
            </p>
            <Link href="/" style={styles.backLink}>
              Back to Home
            </Link>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div style={styles.page}>
      <link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />

      <header style={styles.header}>
        <Link href="/" style={styles.logo}>
          <div style={styles.logoIcon}>✈️</div>
          <span style={styles.logoText}>ClassPilot</span>
        </Link>
        <Link href="/login" style={{ color: "#94a3b8", textDecoration: "none", fontSize: "0.875rem" }}>
          Already have an account? <span style={{ color: "#fbbf24" }}>Sign in</span>
        </Link>
      </header>

      <main style={styles.main}>
        <div style={styles.heroSection}>
          <h1 style={styles.title}>Start Your Free Trial</h1>
          <p style={styles.subtitle}>
            Complete the form below and our team will set up your school's trial account within 1-2 business days. No credit card required.
          </p>
        </div>

        <div style={styles.formCard}>
          {error && <div style={styles.error}>{error}</div>}

          <form onSubmit={handleSubmit}>
            {/* School Information */}
            <h3 style={styles.sectionTitle}>School Information</h3>

            <div style={styles.formGroup}>
              <label style={styles.label}>
                School Name<span style={styles.required}>*</span>
              </label>
              <input
                type="text"
                name="schoolName"
                value={formData.schoolName}
                onChange={handleChange}
                placeholder="Lincoln High School"
                required
                style={styles.input}
              />
            </div>

            <div style={styles.formGroup}>
              <label style={styles.label}>
                School Email Domain<span style={styles.required}>*</span>
              </label>
              <input
                type="text"
                name="schoolDomain"
                value={formData.schoolDomain}
                onChange={handleChange}
                placeholder="lincolnhs.edu"
                required
                style={styles.input}
              />
              <p style={styles.hint}>The email domain used by your students (e.g., students@lincolnhs.edu)</p>
            </div>

            <div style={styles.formGroup}>
              <label style={styles.label}>
                School Zip Code<span style={styles.required}>*</span>
              </label>
              <input
                type="text"
                name="zipCode"
                value={formData.zipCode}
                onChange={handleChange}
                placeholder="90210"
                required
                maxLength={5}
                pattern="[0-9]{5}"
                style={{ ...styles.input, maxWidth: "160px" }}
              />
              <p style={styles.hint}>Used to set your school's timezone for tracking hours</p>
            </div>

            <div style={styles.row}>
              <div style={styles.formGroup}>
                <label style={styles.label}>Estimated Students</label>
                <select
                  name="estimatedStudents"
                  value={formData.estimatedStudents}
                  onChange={handleChange}
                  style={styles.select}
                >
                  <option value="">Select range</option>
                  <option value="1-100">1-100</option>
                  <option value="101-300">101-300</option>
                  <option value="301-500">301-500</option>
                  <option value="501-1000">501-1,000</option>
                  <option value="1001+">1,001+</option>
                </select>
              </div>
              <div style={styles.formGroup}>
                <label style={styles.label}>Estimated Teachers</label>
                <select
                  name="estimatedTeachers"
                  value={formData.estimatedTeachers}
                  onChange={handleChange}
                  style={styles.select}
                >
                  <option value="">Select range</option>
                  <option value="1-10">1-10</option>
                  <option value="11-25">11-25</option>
                  <option value="26-50">26-50</option>
                  <option value="51-100">51-100</option>
                  <option value="101+">101+</option>
                </select>
              </div>
            </div>

            {/* Admin Contact */}
            <h3 style={{ ...styles.sectionTitle, marginTop: "2rem" }}>Administrator Contact</h3>

            <div style={styles.row}>
              <div style={styles.formGroup}>
                <label style={styles.label}>
                  First Name<span style={styles.required}>*</span>
                </label>
                <input
                  type="text"
                  name="adminFirstName"
                  value={formData.adminFirstName}
                  onChange={handleChange}
                  placeholder="John"
                  required
                  style={styles.input}
                />
              </div>
              <div style={styles.formGroup}>
                <label style={styles.label}>
                  Last Name<span style={styles.required}>*</span>
                </label>
                <input
                  type="text"
                  name="adminLastName"
                  value={formData.adminLastName}
                  onChange={handleChange}
                  placeholder="Smith"
                  required
                  style={styles.input}
                />
              </div>
            </div>

            <div style={styles.formGroup}>
              <label style={styles.label}>
                Email Address<span style={styles.required}>*</span>
              </label>
              <input
                type="email"
                name="adminEmail"
                value={formData.adminEmail}
                onChange={handleChange}
                placeholder="jsmith@lincolnhs.edu"
                required
                style={styles.input}
              />
              <p style={styles.hint}>We'll send your trial account details to this email</p>
            </div>

            <div style={styles.formGroup}>
              <label style={styles.label}>Phone Number</label>
              <input
                type="tel"
                name="adminPhone"
                value={formData.adminPhone}
                onChange={handleChange}
                placeholder="(555) 123-4567"
                style={styles.input}
              />
            </div>

            {/* Additional Information */}
            <h3 style={{ ...styles.sectionTitle, marginTop: "2rem" }}>Additional Information</h3>

            <div style={styles.formGroup}>
              <label style={styles.label}>Message (Optional)</label>
              <textarea
                name="message"
                value={formData.message}
                onChange={handleChange}
                placeholder="Tell us about your school's needs, any questions, or specific features you're interested in..."
                style={styles.textarea}
              />
            </div>

            <button
              type="submit"
              disabled={isSubmitting}
              style={{
                ...styles.submitButton,
                ...(isSubmitting ? styles.submitButtonDisabled : {}),
              }}
            >
              {isSubmitting ? "Submitting..." : "Submit Trial Request"}
            </button>
          </form>

          <p style={styles.loginLink}>
            Already have an account?{" "}
            <Link href="/login" style={styles.link}>
              Sign in here
            </Link>
          </p>
        </div>
      </main>
    </div>
  );
}
