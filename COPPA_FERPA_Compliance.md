# ClassPilot — COPPA & FERPA Compliance Documentation

**Prepared by:** SchoolPilot, Inc.
**Product:** ClassPilot — Real-Time Classroom Monitoring & Management Platform
**Document Version:** 1.0
**Last Updated:** January 29, 2026
**Contact:** privacy@classpilot.net | legal@classpilot.net

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [FERPA Compliance](#2-ferpa-compliance)
3. [COPPA Compliance](#3-coppa-compliance)
4. [Data Inventory & Classification](#4-data-inventory--classification)
5. [Data Collection Practices](#5-data-collection-practices)
6. [Data Use & Purpose Limitation](#6-data-use--purpose-limitation)
7. [Data Sharing & Third-Party Sub-Processors](#7-data-sharing--third-party-sub-processors)
8. [Data Storage & Security](#8-data-storage--security)
9. [Data Retention & Deletion](#9-data-retention--deletion)
10. [Access Controls & Authentication](#10-access-controls--authentication)
11. [Incident Response & Breach Notification](#11-incident-response--breach-notification)
12. [Rights of Parents, Students, & Schools](#12-rights-of-parents-students--schools)
13. [Audit & Accountability](#13-audit--accountability)
14. [Data Processing Agreement (DPA) Summary](#14-data-processing-agreement-dpa-summary)
15. [Student Data Privacy Consortium Alignment](#15-student-data-privacy-consortium-alignment)
16. [Frequently Asked Questions for District IT](#16-frequently-asked-questions-for-district-it)
17. [Contact & Governance](#17-contact--governance)

---

## 1. Executive Summary

ClassPilot is a web-based classroom monitoring and management platform designed for K-12 schools. It enables teachers to view real-time student browsing activity on school-issued Chromebooks, manage classroom focus through content filtering and screen controls, and communicate with students during instructional time.

**ClassPilot is designed from the ground up to comply with:**
- **FERPA** (Family Educational Rights and Privacy Act, 20 U.S.C. § 1232g)
- **COPPA** (Children's Online Privacy Protection Act, 15 U.S.C. §§ 6501–6506)
- **PPRA** (Protection of Pupil Rights Amendment)
- **State Student Privacy Laws** (including but not limited to SOPIPA, NY Education Law 2-d, Illinois SOPPA, and comparable state statutes)

ClassPilot operates under the **"school official" exception** to FERPA (34 CFR § 99.31(a)(1)) and the **"school consent" exception** to COPPA (16 CFR § 312.5(c)(3)). ClassPilot does not independently collect personal information from children. All student data is provided by, and under the direction of, the contracting school or district.

---

## 2. FERPA Compliance

### 2.1 School Official Designation

ClassPilot meets the criteria for designation as a "school official" with a "legitimate educational interest" under FERPA (34 CFR § 99.31(a)(1)(i)(B)):

- **Performs an institutional service or function:** ClassPilot provides classroom monitoring and management services that the school would otherwise perform with its own employees.
- **Under direct control of the school:** Schools control which students are enrolled, which teachers have access, what content filtering rules apply, and how long data is retained.
- **Subject to FERPA requirements:** ClassPilot uses education records solely for the purposes for which the disclosure was made and does not re-disclose personally identifiable information (PII) from education records without authorization.
- **Meets criteria in the school's annual FERPA notification:** Schools designate ClassPilot as a school official in their annual FERPA notification to parents.

### 2.2 Education Records

ClassPilot may receive or generate the following data that constitutes "education records" under FERPA:

| Data Element | FERPA Classification | Purpose |
|---|---|---|
| Student name | Directly identifying PII | Display in teacher dashboard |
| Student email | Directly identifying PII | Authentication, identification |
| Grade level | Education record | Classroom grouping |
| Browsing activity (tab titles, URLs) | Education record | Real-time classroom monitoring |
| Session logs (login/logout times) | Education record | Attendance and engagement |
| Check-in responses (mood, messages) | Education record | Student well-being monitoring |
| Poll responses | Education record | Formative assessment |

### 2.3 FERPA-Required Safeguards

| Requirement | ClassPilot Implementation |
|---|---|
| **Limit use to authorized purposes** | Data used exclusively for classroom monitoring and management. No advertising, profiling, or commercial use. |
| **No re-disclosure without consent** | ClassPilot does not share, sell, rent, or disclose student PII to any third party except as required to operate the service (see Section 7). |
| **Maintain security** | AES-256-GCM encryption for sensitive tokens, bcrypt password hashing, TLS in transit, role-based access controls (see Section 8). |
| **Destruction upon request** | Schools may request complete data deletion at any time. Soft-delete and hard-delete capabilities exist at the school, user, and student level (see Section 9). |
| **Parental access rights** | Schools facilitate parental access to student education records. ClassPilot supports data export requests through the school administrator. |

### 2.4 Directory Information

ClassPilot does **not** treat any student data as "directory information." All student PII is treated as protected education records regardless of the school's directory information designations.

### 2.5 De-Identified and Aggregate Data

ClassPilot does not create or use de-identified or aggregate data sets derived from student education records for any purpose outside the contracted service. Internal analytics dashboards display data only to authorized users within the same school tenant.

---

## 3. COPPA Compliance

### 3.1 Applicability

COPPA applies to ClassPilot because the platform may be used by students under the age of 13. ClassPilot operates under the **school consent exception** (16 CFR § 312.5(c)(3)), which permits schools to consent on behalf of parents for the collection of student personal information, provided the information is used solely for an educational purpose.

### 3.2 School Consent Exception

Under the COPPA school consent exception:

- **Schools provide consent on behalf of parents.** ClassPilot does not collect personal information directly from children. All student accounts are created by school administrators or synced from the school's Google Workspace for Education directory.
- **Information is used solely for educational purposes.** Student browsing activity is collected exclusively for classroom monitoring and management during school hours.
- **No commercial exploitation.** ClassPilot does not use student data for advertising, marketing, behavioral profiling, or any non-educational purpose.
- **Schools are responsible for parental notification.** The contracting school or district is responsible for providing notice to parents about ClassPilot's data practices and obtaining any additional consent required by their policies or applicable state law.

### 3.3 COPPA-Required Disclosures

| COPPA Requirement | ClassPilot Practice |
|---|---|
| **What information is collected** | Student name, email, grade level, browsing activity (tab titles, URLs), device identifiers, session times, check-in responses, poll answers. |
| **How information is collected** | Via school administrator input, Google Workspace sync, and the ClassPilot Chrome Extension installed on school-managed Chromebooks. |
| **How information is used** | Exclusively for real-time classroom monitoring, content filtering, screen management, student-teacher communication, and session tracking. |
| **Whether information is disclosed to third parties** | Student PII is not sold, rented, or disclosed to third parties. Sub-processors (Sentry, Stripe) receive only the minimum data necessary and are contractually bound (see Section 7). |
| **Parental rights** | Parents may request to review their child's data, request deletion, and refuse further collection by contacting the school, which will coordinate with ClassPilot. |
| **Operator contact** | SchoolPilot, Inc. — privacy@classpilot.net |

### 3.4 No Direct Collection from Children

ClassPilot does **not**:
- Operate a website or app directed at children under 13 for direct use
- Require children to provide personal information to use the service
- Collect personal information from children through online forms, registration, or user input (all accounts are provisioned by school administrators)
- Use persistent identifiers (cookies, device IDs) to track children across websites or services for non-educational purposes

The Chrome Extension collects browsing activity data from school-managed devices, under the school's authority and for the school's educational purposes.

### 3.5 No Behavioral Advertising or Profiling

ClassPilot does **not**:
- Display advertisements of any kind
- Build behavioral profiles of students
- Use student data for targeted advertising or marketing
- Share student data with advertisers or data brokers
- Use student data to train machine learning models

---

## 4. Data Inventory & Classification

### 4.1 Student Data Elements

| Data Element | Data Type | Collection Method | Storage | Retention |
|---|---|---|---|---|
| Student full name | PII | Admin entry / Google Sync | PostgreSQL | Until school requests deletion |
| Student email | PII | Admin entry / Google Sync | PostgreSQL | Until school requests deletion |
| Grade level | Demographic | Admin entry | PostgreSQL | Until school requests deletion |
| Google User ID | Identifier | Google OAuth | PostgreSQL | Until school requests deletion |
| Device ID | Identifier | Chrome Extension | PostgreSQL | Until school requests deletion |
| Active tab title | Browsing activity | Chrome Extension heartbeat | PostgreSQL | Configurable; default 24 hours |
| Active tab URL | Browsing activity | Chrome Extension heartbeat | PostgreSQL | Configurable; default 24 hours |
| Screen lock status | Device state | Chrome Extension | In-memory only | Not persisted |
| Open tab list | Browsing activity | Chrome Extension | In-memory only | Not persisted; real-time only |
| Session start/end times | Session metadata | Chrome Extension | PostgreSQL | Configurable retention |
| Mood check-in | Student input | Voluntary student action | PostgreSQL | Configurable retention |
| Poll responses | Student input | Teacher-initiated poll | PostgreSQL | Configurable retention |
| Screen share stream | Video data | Voluntary student consent | WebRTC peer-to-peer | Not recorded or stored |

### 4.2 Teacher/Administrator Data Elements

| Data Element | Data Type | Storage |
|---|---|---|
| Name | PII | PostgreSQL |
| Email | PII | PostgreSQL |
| Password hash | Credential (bcrypt) | PostgreSQL |
| Google OAuth tokens | Credential (AES-256-GCM encrypted) | PostgreSQL |
| Role (teacher/admin/super-admin) | Authorization | PostgreSQL |
| Audit log entries | Activity record | PostgreSQL |

### 4.3 Data NOT Collected

ClassPilot does **not** collect:
- Social Security numbers
- Financial information from students or parents
- Biometric data
- Geolocation data (GPS coordinates)
- Contents of student files, documents, or email
- Keystrokes or typed content
- Photos or video recordings of students
- Student health records
- Student disciplinary records
- Parent/guardian personal information

---

## 5. Data Collection Practices

### 5.1 Minimum Necessary Collection

ClassPilot collects only the data necessary to provide the contracted classroom monitoring service. Data collection follows the principle of data minimization:

- **Student identifiers** (name, email): Required to associate browsing activity with the correct student for display in the teacher dashboard.
- **Browsing activity** (tab title, URL): The core function of the monitoring service. Collected only during active school sessions.
- **Device identifiers**: Required to link Chrome Extension instances to student accounts on school-managed Chromebooks.

### 5.2 Collection Mechanisms

1. **School Administrator Input:** Administrators manually create student accounts or import rosters via CSV upload.
2. **Google Workspace Sync:** Student roster data (name, email, grade) is synced from Google Classroom using Google Workspace for Education APIs. This requires explicit administrator authorization via OAuth.
3. **Chrome Extension Heartbeat:** The ClassPilot Chrome Extension, installed on school-managed Chromebooks via Google Admin Console, sends periodic "heartbeat" data (active tab title, URL, device status) to the ClassPilot server. This occurs only on school-managed devices within the school's Google Workspace domain.

### 5.3 No Passive or Background Collection

- The Chrome Extension only sends data when the student is actively using a school-managed Chromebook.
- Browsing activity is only collected during configured school tracking hours (e.g., 7:00 AM – 4:00 PM in the school's local timezone).
- Schools configure tracking hours per their policies. Outside these hours, no data is collected.
- The extension does not operate on personal devices.

---

## 6. Data Use & Purpose Limitation

### 6.1 Permitted Uses

Student data collected by ClassPilot is used **exclusively** for:

1. **Real-time classroom monitoring** — Displaying student browsing activity to their assigned teacher during class sessions.
2. **Content filtering** — Enforcing domain allow/block lists ("Flight Paths") configured by teachers or administrators.
3. **Classroom management** — Screen locking, tab management, and URL distribution.
4. **Student-teacher communication** — Messaging, announcements, mood check-ins, and polls.
5. **Session tracking** — Recording student login/logout times for engagement and attendance purposes.
6. **Administrative analytics** — Aggregate usage statistics for school administrators (e.g., number of active sessions, most visited domains).
7. **Technical support and troubleshooting** — Diagnosing connectivity or software issues reported by schools.

### 6.2 Prohibited Uses

ClassPilot **never** uses student data for:

- Advertising or marketing of any kind
- Behavioral profiling or psychographic analysis
- Sale, rent, or trade to any third party
- Training of artificial intelligence or machine learning models
- Building profiles for non-educational purposes
- Commercial product development unrelated to the contracted service
- Any purpose not authorized by the contracting school or district

---

## 7. Data Sharing & Third-Party Sub-Processors

### 7.1 No Sale of Student Data

**ClassPilot does not sell, rent, lease, trade, or otherwise commercially exploit student personal information.** This prohibition is absolute and contractual.

### 7.2 Sub-Processors

ClassPilot uses a limited number of sub-processors to operate the service. Each sub-processor is bound by data processing agreements that require FERPA/COPPA-compliant handling of any data they may access.

| Sub-Processor | Purpose | Student PII Exposure | Data Processing Agreement |
|---|---|---|---|
| **Amazon Web Services (AWS)** | Cloud infrastructure (EC2, RDS, ALB, ECS) | Encrypted at rest and in transit; AWS acts as infrastructure provider only | AWS DPA, FERPA-eligible service |
| **Sentry** | Application error monitoring | **No student PII.** All PII is scrubbed before transmission. `sendDefaultPii: false`. Emails, URLs, student names, and sensitive keys are redacted. | Sentry DPA |
| **Stripe** | Subscription billing for schools | **No student PII.** Stripe processes only school-level billing information (school admin payment details). | Stripe DPA |
| **Xirsys** | WebRTC TURN relay for optional screen sharing | **No student PII.** Xirsys handles only WebRTC signaling/relay; no student content is accessible. | Xirsys Terms of Service |
| **SendGrid** | Transactional email delivery | **Minimal.** Email addresses for password resets and admin notifications only. No student emails sent via SendGrid. | Twilio/SendGrid DPA |

### 7.3 PII Scrubbing for Error Monitoring

ClassPilot implements aggressive PII scrubbing before any data is sent to Sentry:

- Student names, email addresses, and URLs are redacted from error reports
- Cookies, HTTP headers, and query strings are stripped
- API keys and tokens are filtered
- `sendDefaultPii` is explicitly set to `false`
- Custom scrubbing logic runs on both server-side and Chrome Extension error reports

### 7.4 No Other Data Sharing

ClassPilot does not share student data with:
- Other schools or districts
- Government agencies (unless required by law with proper legal process)
- Researchers or academic institutions
- Partners, affiliates, or parent company products

---

## 8. Data Storage & Security

### 8.1 Infrastructure

| Component | Detail |
|---|---|
| **Hosting** | Amazon Web Services (AWS), US-East-1 region (Northern Virginia) |
| **Database** | Amazon RDS PostgreSQL (managed relational database) |
| **Application** | AWS ECS (Elastic Container Service) with Docker containers |
| **Load Balancer** | AWS Application Load Balancer with TLS termination |
| **DNS** | AWS Route 53 |
| **Data Residency** | All student data is stored and processed exclusively within the United States |

### 8.2 Encryption

| Layer | Method |
|---|---|
| **Data in Transit** | TLS 1.2+ encryption for all HTTP/HTTPS and WebSocket connections. HSTS headers enforced. |
| **Data at Rest (Database)** | AWS RDS encryption at rest using AES-256 (AWS-managed keys). |
| **OAuth Tokens** | AES-256-GCM encryption with unique initialization vectors and authentication tags. Encryption keys stored separately from encrypted data. |
| **Passwords** | bcrypt hashing with 10 salt rounds. Passwords are never stored in plaintext. |
| **Session Tokens** | Signed JWTs with server-side secrets (minimum 32 bytes). |

### 8.3 Network Security

- Application runs within a Virtual Private Cloud (VPC) with private subnets
- Database is not publicly accessible; accessible only from application servers within the VPC
- Security groups restrict inbound traffic to necessary ports only
- All administrative access requires authentication and is logged

### 8.4 Application Security

| Control | Implementation |
|---|---|
| **Content Security Policy (CSP)** | Helmet middleware with strict CSP headers restricting script sources, object sources, and frame ancestors |
| **CSRF Protection** | csurf middleware with token-based CSRF prevention |
| **HTTP Security Headers** | X-Frame-Options, X-Content-Type-Options (nosniff), Referrer-Policy, Strict-Transport-Security |
| **CORS** | Origin allowlist validation; cross-origin requests restricted to authorized domains |
| **Input Validation** | Zod schema validation on all API inputs; parameterized database queries via Drizzle ORM (prevents SQL injection) |
| **Rate Limiting** | Applied to authentication endpoints to prevent brute-force attacks |

### 8.5 Multi-Tenant Data Isolation

ClassPilot uses a multi-tenant architecture where each school is a separate logical tenant:

- All database queries are scoped by `schoolId` — teachers and administrators can only access data belonging to their own school
- Role-based access control enforces separation: teachers see only their assigned students; school admins see only their school's data
- Super-admin access is restricted to SchoolPilot operations staff for platform management
- Cross-tenant data access is architecturally prevented at the query layer

---

## 9. Data Retention & Deletion

### 9.1 Retention Periods

| Data Category | Default Retention | Configurable | Notes |
|---|---|---|---|
| Student browsing activity (heartbeats) | 24 hours | Yes — school admin configurable | Automatic cleanup job runs on schedule |
| Session logs | 90 days | Yes | Login/logout timestamps |
| Student account data | Duration of contract | N/A | Retained while school's account is active |
| Audit logs | 1 year | No | Required for compliance accountability |
| Screen share streams | Not stored | N/A | WebRTC peer-to-peer; no server recording |
| Real-time status data | Not persisted | N/A | In-memory only; lost on session end |

### 9.2 Automatic Data Cleanup

- Browsing activity (heartbeat) records are automatically purged based on the school's configured retention period (default: 24 hours).
- The cleanup process runs automatically without manual intervention.
- Schools can adjust their retention period through the school settings dashboard.

### 9.3 Data Deletion Requests

**School-Level Deletion:**
- Schools may request complete deletion of all school data, including all student records, teacher accounts, browsing activity, session logs, and configuration data.
- Deletion requests are processed within 30 days.
- Contact: privacy@classpilot.net

**Individual Student Deletion:**
- Schools may request deletion of individual student records at any time.
- School administrators can directly delete individual student accounts through the admin dashboard.
- Deletion removes the student's account, associated browsing activity, session logs, and any other linked data.

**Post-Contract Deletion:**
- Upon termination of a school's contract, all school data is deleted within 60 days unless the school requests an earlier deletion or a data export.
- Schools may request a data export in standard formats (CSV) prior to deletion.

### 9.4 Data Portability

Schools may request an export of their data in machine-readable format (CSV). Export requests are processed by contacting privacy@classpilot.net.

---

## 10. Access Controls & Authentication

### 10.1 Role-Based Access Control (RBAC)

| Role | Access Level |
|---|---|
| **Student** | No login to web dashboard. Chrome Extension runs on school-managed device under school authority. Students can participate in check-ins, polls, and screen sharing (with consent). |
| **Teacher** | View real-time browsing activity for assigned students only. Manage classroom controls (lock screens, filter content, send messages). Cannot access other teachers' students or school-wide admin settings. |
| **School Administrator** | Manage all teachers and students within their school. Configure school settings (tracking hours, data retention, domain filters). View school-level analytics. Cannot access other schools' data. |
| **Super Administrator** | SchoolPilot platform operations staff. Manage school accounts, billing, and platform-level configuration. Access scoped to platform management only. |

### 10.2 Authentication Methods

**Google OAuth 2.0 (Primary):**
- Teachers and administrators authenticate via their school's Google Workspace account.
- OAuth scopes are limited to the minimum necessary: profile, email, classroom rosters, and directory information.
- OAuth tokens are encrypted with AES-256-GCM before storage.
- Token refresh handled automatically; tokens are revocable by the school's Google Workspace admin at any time.

**Password Authentication (Optional Fallback):**
- Available as a secondary authentication method for administrators.
- Passwords are hashed with bcrypt (10 salt rounds) and never stored in plaintext.
- Minimum password length enforced (6+ characters).

**Student Authentication:**
- Students do not log in to a website or application.
- The Chrome Extension authenticates via the school's Google Workspace identity on the managed Chromebook.
- JWT tokens are used for Extension-to-server communication, scoped to the specific student and device.

### 10.3 Session Security

- HTTP-only, secure cookies with SameSite=Lax attribute
- Server-side session storage in PostgreSQL (not client-side)
- Session invalidation on logout
- Session versioning to force re-authentication when school settings change

---

## 11. Incident Response & Breach Notification

### 11.1 Incident Response Plan

SchoolPilot maintains an incident response plan covering:

1. **Detection:** Automated monitoring, audit log review, and Sentry error alerting (with PII scrubbed).
2. **Containment:** Immediate isolation of affected systems, revocation of compromised credentials, and suspension of affected accounts.
3. **Assessment:** Determination of scope, affected data, and affected schools/individuals.
4. **Notification:** Timely notification to affected schools and, through the school, to affected parents/students.
5. **Remediation:** Root cause analysis, patching, and preventive measures.
6. **Documentation:** Complete incident record maintained for compliance and audit purposes.

### 11.2 Breach Notification Timeline

| Obligation | Timeline |
|---|---|
| **Notification to affected schools** | Within 72 hours of confirming a breach involving student PII |
| **Cooperation with school's notification obligations** | Immediate and ongoing |
| **State breach notification laws** | Compliance with applicable state-specific timelines (e.g., 60 days in many states) |
| **FERPA reporting** | Support school's obligation to report to the U.S. Department of Education if applicable |

### 11.3 Breach Notification Content

Breach notifications to schools will include:
- Date and nature of the incident
- Categories of data affected
- Number of individuals potentially affected
- Steps taken to contain and remediate the incident
- Recommended steps for the school and affected individuals
- Point of contact for questions

---

## 12. Rights of Parents, Students, & Schools

### 12.1 Parental Rights Under FERPA

Parents (or eligible students age 18+) have the right to:

1. **Inspect and review** their child's education records maintained by ClassPilot, by submitting a request through their school.
2. **Request correction** of records they believe to be inaccurate or misleading.
3. **Consent to disclosures** — ClassPilot does not disclose student PII outside the school official exception without written parental consent (obtained by the school).
4. **File complaints** with the U.S. Department of Education (Family Policy Compliance Office) regarding alleged FERPA violations.

### 12.2 Parental Rights Under COPPA

Parents have the right to:

1. **Review personal information** collected from their child by contacting their school, which will coordinate with ClassPilot.
2. **Request deletion** of their child's personal information.
3. **Refuse further collection** of their child's personal information (the school may need to remove the student from ClassPilot).
4. **Not be required** to consent to unnecessary collection as a condition of the child's participation in school activities.

### 12.3 How to Exercise These Rights

All requests are coordinated through the contracting school or district:

1. **Parent contacts the school** to request access, correction, or deletion.
2. **School contacts ClassPilot** at privacy@classpilot.net with the specific request.
3. **ClassPilot processes the request** within 30 days and confirms completion to the school.
4. **School notifies the parent** of the outcome.

---

## 13. Audit & Accountability

### 13.1 Audit Logging

ClassPilot maintains comprehensive audit logs that record:

| Event | Details Logged |
|---|---|
| User login/logout | User ID, email, timestamp, IP address |
| Student account creation/deletion | Administrator who performed the action, student details, timestamp |
| Settings changes | Previous and new values, administrator who made the change |
| Data access events | Which teacher viewed which students' data |
| Administrative actions | School creation, user role changes, configuration updates |
| Data deletion requests | Requestor, scope of deletion, completion timestamp |

### 13.2 Audit Log Access

- Audit logs are accessible to school administrators for their own school's activity.
- Audit logs are indexed by school, action type, user, and timestamp for efficient compliance queries.
- Logs are retained for a minimum of 1 year.

### 13.3 Compliance Reviews

SchoolPilot conducts:
- **Annual internal review** of data collection practices against FERPA/COPPA requirements
- **Sub-processor review** to verify ongoing compliance of third-party service providers
- **Access control review** to verify principle of least privilege is maintained
- **Security assessment** of application and infrastructure controls

---

## 14. Data Processing Agreement (DPA) Summary

ClassPilot offers a Data Processing Agreement (DPA) to all contracting schools and districts. The DPA includes:

| DPA Provision | Summary |
|---|---|
| **Scope of processing** | Data processed solely for classroom monitoring and management services |
| **Data ownership** | The school/district owns all student data; ClassPilot is a data processor acting on behalf of the school |
| **Purpose limitation** | Data used only for contracted educational purposes |
| **Sub-processor disclosure** | Complete list of sub-processors with descriptions (see Section 7) |
| **Security obligations** | Encryption, access controls, audit logging, and incident response as described in this document |
| **Breach notification** | Within 72 hours of confirmed breach |
| **Data return/deletion** | Upon contract termination, data deleted within 60 days or exported upon request |
| **Audit rights** | Schools may request evidence of compliance practices |
| **Indemnification** | ClassPilot indemnifies schools for breaches caused by ClassPilot's failure to comply with the DPA |
| **Governing law** | As specified in the DPA |

To request a DPA, contact: legal@classpilot.net

---

## 15. Student Data Privacy Consortium Alignment

ClassPilot's practices align with the following frameworks and pledges:

### 15.1 Student Privacy Pledge (Future of Privacy Forum / SIIA)

ClassPilot's practices are consistent with the Student Privacy Pledge commitments:

- ✅ Not sell student personal information
- ✅ Not behaviorally target advertising to students
- ✅ Use data only for authorized educational purposes
- ✅ Not change privacy policies without notice and choice
- ✅ Enforce strict limits on data retention
- ✅ Support school compliance with FERPA
- ✅ Provide comprehensive data security
- ✅ Be transparent about data collection and use
- ✅ Not use student data for non-educational purposes
- ✅ Not retain data beyond the period needed for educational purposes

### 15.2 State Student Privacy Laws

ClassPilot is designed to comply with state-level student privacy statutes including:

| State Law | Compliance Status |
|---|---|
| **California SOPIPA** (Student Online Personal Information Protection Act) | Compliant — no advertising, no profiling, no sale of data |
| **New York Education Law 2-d** | Compliant — DPA available, data security plan, breach notification, parent bill of rights support |
| **Illinois SOPPA** (Student Online Personal Protection Act) | Compliant — DPA with required provisions, data governance |
| **Colorado Student Data Transparency and Security Act** | Compliant — transparency, security, data governance |
| **Connecticut PA 16-189** | Compliant — no targeted advertising, no sale, no profiling |
| **Virginia SDPA** | Compliant — operator obligations met |

---

## 16. Frequently Asked Questions for District IT

### Q: Does ClassPilot collect data on personal devices?
**A:** No. The ClassPilot Chrome Extension is deployed via Google Admin Console to school-managed Chromebooks only. It cannot be installed on personal devices, and it does not collect any data outside the school's managed device fleet.

### Q: Does ClassPilot record student screens?
**A:** No. The optional screen-sharing feature uses real-time WebRTC streaming. No recordings are made or stored. Screen sharing requires active student consent via an in-extension prompt and can be ended by the student at any time.

### Q: Can teachers see student activity outside school hours?
**A:** No. Schools configure tracking hours (e.g., 7:00 AM – 4:00 PM). The extension does not transmit browsing data outside these configured hours. Schools set their tracking window based on their local timezone, which is auto-detected from the school's zip code.

### Q: How long is browsing data retained?
**A:** By default, browsing activity (heartbeat data) is retained for 24 hours and then automatically purged. School administrators can adjust the retention period. Real-time status data (which student is online, open tabs list) exists only in memory and is not persisted to any database.

### Q: Does ClassPilot use AI or machine learning on student data?
**A:** No. ClassPilot does not use artificial intelligence, machine learning, or automated decision-making on student data.

### Q: Is student data shared with the parent company's other products?
**A:** No. Student data collected by ClassPilot is siloed within ClassPilot's systems. No data is shared with other SchoolPilot products (PassPilot, GoPilot) or any other entity.

### Q: What happens to student data when a school's contract ends?
**A:** All school data, including all student records, is deleted within 60 days of contract termination. Schools may request a data export before deletion.

### Q: Can ClassPilot see the contents of student Google Docs, emails, or files?
**A:** No. ClassPilot can see only the title and URL of the active browser tab. It cannot access the contents of documents, emails, files, or any data within websites or applications.

### Q: Does ClassPilot use cookies to track students across the web?
**A:** No. ClassPilot does not use cookies on student devices. The Chrome Extension uses a server-issued JWT token scoped to the school's domain for authentication purposes only.

### Q: Is ClassPilot compliant with our state's student privacy law?
**A:** ClassPilot is designed to comply with all major state student privacy laws (see Section 15.2). Contact legal@classpilot.net for a state-specific compliance assessment or to request a DPA that includes your state's required provisions.

### Q: Can we audit ClassPilot's practices?
**A:** Yes. Schools and districts may request evidence of ClassPilot's security and privacy practices, including access to audit logs for their school's data, documentation of security controls, and DPA compliance verification. Contact legal@classpilot.net to arrange a compliance review.

### Q: What Google API scopes does ClassPilot request?
**A:** ClassPilot requests the minimum OAuth scopes necessary: `profile`, `email`, `classroom.courses.readonly`, `classroom.rosters.readonly`, `classroom.profile.emails`, `admin.directory.user.readonly`, and `admin.directory.orgunit.readonly`. All scopes are read-only. ClassPilot does not modify any data in Google Workspace.

### Q: Where is student data stored geographically?
**A:** All data is stored exclusively in AWS US-East-1 (Northern Virginia, United States). No student data is stored or processed outside the United States.

---

## 17. Contact & Governance

### Data Protection Contact

**SchoolPilot, Inc.**
Email: privacy@classpilot.net
Legal: legal@classpilot.net

### For Parents

If you have questions about your child's data in ClassPilot, please contact your child's school first. The school can coordinate with ClassPilot to address your concerns. You may also contact ClassPilot directly at privacy@classpilot.net.

### For Schools and Districts

To request a Data Processing Agreement, compliance documentation, or to report a concern:
Email: legal@classpilot.net

### Regulatory Contacts

**FERPA Complaints:**
Family Policy Compliance Office
U.S. Department of Education
400 Maryland Avenue, SW
Washington, DC 20202

**COPPA Complaints:**
Federal Trade Commission
600 Pennsylvania Avenue, NW
Washington, DC 20580
https://www.ftc.gov/complaint

---

*This document is reviewed and updated at least annually or when material changes occur to ClassPilot's data practices. Schools will be notified of material changes prior to implementation.*

*© 2026 SchoolPilot, Inc. All rights reserved.*
