import nodemailer from "nodemailer";

// Email configuration - uses environment variables
// For production, use a real SMTP service (AWS SES, SendGrid, etc.)
// For development, set SMTP_HOST to empty to skip sending

const transporter = process.env.SMTP_HOST
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || "587"),
      secure: process.env.SMTP_SECURE === "true",
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    })
  : null;

const FROM_EMAIL = process.env.SMTP_FROM || "noreply@school-pilot.net";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "bzinkan@school-pilot.net";

interface TrialRequestEmailData {
  schoolName: string;
  schoolDomain: string;
  adminFirstName: string;
  adminLastName: string;
  adminEmail: string;
  adminPhone?: string | null;
  estimatedStudents?: string | null;
  estimatedTeachers?: string | null;
  message?: string | null;
}

export async function sendTrialRequestNotification(data: TrialRequestEmailData): Promise<boolean> {
  const subject = `New Trial Request: ${data.schoolName}`;

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: #0f172a; padding: 24px; text-align: center;">
        <h1 style="color: #fbbf24; margin: 0; font-size: 24px;">ClassPilot</h1>
        <p style="color: #94a3b8; margin: 8px 0 0;">New Trial Request</p>
      </div>

      <div style="padding: 32px; background: #f8fafc;">
        <h2 style="color: #0f172a; margin: 0 0 24px; font-size: 20px;">School Information</h2>

        <table style="width: 100%; border-collapse: collapse;">
          <tr>
            <td style="padding: 8px 0; color: #64748b; width: 140px;">School Name:</td>
            <td style="padding: 8px 0; color: #0f172a; font-weight: 500;">${escapeHtml(data.schoolName)}</td>
          </tr>
          <tr>
            <td style="padding: 8px 0; color: #64748b;">Domain:</td>
            <td style="padding: 8px 0; color: #0f172a;">${escapeHtml(data.schoolDomain)}</td>
          </tr>
          <tr>
            <td style="padding: 8px 0; color: #64748b;">Est. Students:</td>
            <td style="padding: 8px 0; color: #0f172a;">${data.estimatedStudents || "Not specified"}</td>
          </tr>
          <tr>
            <td style="padding: 8px 0; color: #64748b;">Est. Teachers:</td>
            <td style="padding: 8px 0; color: #0f172a;">${data.estimatedTeachers || "Not specified"}</td>
          </tr>
        </table>

        <h2 style="color: #0f172a; margin: 32px 0 24px; font-size: 20px;">Administrator Contact</h2>

        <table style="width: 100%; border-collapse: collapse;">
          <tr>
            <td style="padding: 8px 0; color: #64748b; width: 140px;">Name:</td>
            <td style="padding: 8px 0; color: #0f172a; font-weight: 500;">${escapeHtml(data.adminFirstName)} ${escapeHtml(data.adminLastName)}</td>
          </tr>
          <tr>
            <td style="padding: 8px 0; color: #64748b;">Email:</td>
            <td style="padding: 8px 0;">
              <a href="mailto:${escapeHtml(data.adminEmail)}" style="color: #2563eb;">${escapeHtml(data.adminEmail)}</a>
            </td>
          </tr>
          ${data.adminPhone ? `
          <tr>
            <td style="padding: 8px 0; color: #64748b;">Phone:</td>
            <td style="padding: 8px 0; color: #0f172a;">${escapeHtml(data.adminPhone)}</td>
          </tr>
          ` : ""}
        </table>

        ${data.message ? `
        <h2 style="color: #0f172a; margin: 32px 0 16px; font-size: 20px;">Message</h2>
        <div style="background: white; padding: 16px; border-radius: 8px; border: 1px solid #e2e8f0;">
          <p style="margin: 0; color: #475569; white-space: pre-wrap;">${escapeHtml(data.message)}</p>
        </div>
        ` : ""}

        <div style="margin-top: 32px; padding-top: 24px; border-top: 1px solid #e2e8f0;">
          <p style="color: #64748b; margin: 0; font-size: 14px;">
            Log in to the Super Admin dashboard to set up this school's trial account.
          </p>
        </div>
      </div>

      <div style="background: #0f172a; padding: 16px; text-align: center;">
        <p style="color: #64748b; margin: 0; font-size: 12px;">
          © ${new Date().getFullYear()} ClassPilot. All rights reserved.
        </p>
      </div>
    </div>
  `;

  const text = `
New Trial Request for ClassPilot

SCHOOL INFORMATION
------------------
School Name: ${data.schoolName}
Domain: ${data.schoolDomain}
Est. Students: ${data.estimatedStudents || "Not specified"}
Est. Teachers: ${data.estimatedTeachers || "Not specified"}

ADMINISTRATOR CONTACT
--------------------
Name: ${data.adminFirstName} ${data.adminLastName}
Email: ${data.adminEmail}
${data.adminPhone ? `Phone: ${data.adminPhone}` : ""}

${data.message ? `MESSAGE\n-------\n${data.message}` : ""}

Log in to the Super Admin dashboard to set up this school's trial account.
  `.trim();

  // If no SMTP configured, log and return
  if (!transporter) {
    console.log(`[Email] SMTP not configured. Would have sent to ${ADMIN_EMAIL}:`);
    console.log(`[Email] Subject: ${subject}`);
    console.log(`[Email] Content:\n${text}`);
    return true; // Return true so the flow continues
  }

  try {
    await transporter.sendMail({
      from: FROM_EMAIL,
      to: ADMIN_EMAIL,
      subject,
      text,
      html,
    });
    console.log(`[Email] Trial request notification sent to ${ADMIN_EMAIL}`);
    return true;
  } catch (error) {
    console.error("[Email] Failed to send trial request notification:", error);
    return false;
  }
}

function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  };
  return text.replace(/[&<>"']/g, (char) => map[char]);
}

interface BroadcastEmailData {
  subject: string;
  message: string;
  recipients: Array<{ email: string; name?: string | null; schoolName?: string }>;
}

export async function sendBroadcastEmail(data: BroadcastEmailData): Promise<{ sent: number; failed: number; errors: string[] }> {
  const result = { sent: 0, failed: 0, errors: [] as string[] };

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: #0f172a; padding: 24px; text-align: center;">
        <h1 style="color: #fbbf24; margin: 0; font-size: 24px;">ClassPilot</h1>
        <p style="color: #94a3b8; margin: 8px 0 0;">Important Notice</p>
      </div>

      <div style="padding: 32px; background: #f8fafc;">
        <div style="background: white; padding: 24px; border-radius: 8px; border: 1px solid #e2e8f0;">
          <p style="margin: 0; color: #0f172a; white-space: pre-wrap; line-height: 1.6;">${escapeHtml(data.message)}</p>
        </div>

        <div style="margin-top: 32px; padding-top: 24px; border-top: 1px solid #e2e8f0;">
          <p style="color: #64748b; margin: 0; font-size: 14px;">
            This message was sent to all ClassPilot school administrators.
          </p>
        </div>
      </div>

      <div style="background: #0f172a; padding: 16px; text-align: center;">
        <p style="color: #64748b; margin: 0; font-size: 12px;">
          © ${new Date().getFullYear()} ClassPilot. All rights reserved.
        </p>
      </div>
    </div>
  `;

  const text = `
${data.message}

---
This message was sent to all ClassPilot school administrators.
© ${new Date().getFullYear()} ClassPilot
  `.trim();

  // If no SMTP configured, log and return
  if (!transporter) {
    console.log(`[Email] SMTP not configured. Would have sent broadcast to ${data.recipients.length} recipients:`);
    console.log(`[Email] Subject: ${data.subject}`);
    console.log(`[Email] Recipients: ${data.recipients.map(r => r.email).join(", ")}`);
    console.log(`[Email] Content:\n${text}`);
    return { sent: data.recipients.length, failed: 0, errors: [] };
  }

  // Send to each recipient individually (better deliverability than BCC)
  for (const recipient of data.recipients) {
    try {
      await transporter.sendMail({
        from: FROM_EMAIL,
        to: recipient.email,
        subject: data.subject,
        text,
        html,
      });
      result.sent++;
    } catch (error: any) {
      result.failed++;
      result.errors.push(`${recipient.email}: ${error.message || "Unknown error"}`);
      console.error(`[Email] Failed to send broadcast to ${recipient.email}:`, error);
    }
  }

  console.log(`[Email] Broadcast complete: ${result.sent} sent, ${result.failed} failed`);
  return result;
}

interface OnboardingEmailData {
  schoolName: string;
  adminEmail: string;
  adminName: string;
  loginUrl: string;
  customSubject?: string;
  customMessage?: string;
}

export async function sendOnboardingEmail(data: OnboardingEmailData): Promise<boolean> {
  const subject = data.customSubject || `Welcome to ClassPilot, ${data.schoolName}!`;
  const extensionUrl = "https://chromewebstore.google.com/detail/classpilot/iggbfegfcjkfieoemeolfmfnapepalca";
  const extensionId = "iggbfegfcjkfieoemeolfmfnapepalca";
  const guidesUrl = "https://school-pilot.net/guides";

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: #0f172a; padding: 24px; text-align: center;">
        <h1 style="color: #fbbf24; margin: 0; font-size: 24px;">ClassPilot</h1>
        <p style="color: #94a3b8; margin: 8px 0 0;">Welcome Aboard!</p>
      </div>

      <div style="padding: 32px; background: #f8fafc;">
        ${data.customMessage ? `
        <div style="color: #475569; font-size: 15px; line-height: 1.6; white-space: pre-wrap;">${escapeHtml(data.customMessage)}</div>
        ` : `
        <p style="color: #0f172a; font-size: 16px; line-height: 1.6;">
          Hi ${escapeHtml(data.adminName)},
        </p>
        <p style="color: #475569; font-size: 15px; line-height: 1.6;">
          Your school, <strong>${escapeHtml(data.schoolName)}</strong>, is now set up on ClassPilot!
          Here's everything you need to get started.
        </p>
        `}

        <h2 style="color: #0f172a; margin: 28px 0 12px; font-size: 18px;">1. Log In</h2>
        <p style="color: #475569; font-size: 15px; line-height: 1.6;">
          Sign in to your admin dashboard using your email address:
        </p>
        <div style="text-align: center; margin: 16px 0;">
          <a href="${escapeHtml(data.loginUrl)}" style="display: inline-block; background: #2563eb; color: white; padding: 12px 32px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 15px;">Log In to ClassPilot</a>
        </div>

        <h2 style="color: #0f172a; margin: 28px 0 12px; font-size: 18px;">2. Install the Chrome Extension</h2>
        <p style="color: #475569; font-size: 15px; line-height: 1.6;">
          Students need the ClassPilot Chrome extension installed on their managed Chromebooks.
        </p>
        <div style="text-align: center; margin: 16px 0;">
          <a href="${extensionUrl}" style="display: inline-block; background: #0f172a; color: #fbbf24; padding: 12px 32px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 15px;">View in Chrome Web Store</a>
        </div>

        <div style="background: white; padding: 20px; border-radius: 8px; border: 1px solid #e2e8f0; margin: 16px 0;">
          <h3 style="color: #0f172a; margin: 0 0 12px; font-size: 15px;">Force-Install via Google Admin Console</h3>
          <ol style="color: #475569; font-size: 14px; line-height: 1.8; margin: 0; padding-left: 20px;">
            <li>Go to <strong>Google Admin Console</strong> &gt; Devices &gt; Chrome &gt; Apps &amp; extensions</li>
            <li>Select the organizational unit for your students</li>
            <li>Click the <strong>+</strong> icon &gt; Add Chrome app or extension by ID</li>
            <li>Enter the extension ID: <code style="background: #f1f5f9; padding: 2px 6px; border-radius: 4px; font-size: 13px;">${extensionId}</code></li>
            <li>Set the installation policy to <strong>Force install</strong></li>
            <li>Click <strong>Save</strong></li>
          </ol>
        </div>

        <h2 style="color: #0f172a; margin: 28px 0 12px; font-size: 18px;">3. Getting Started Guides</h2>
        <p style="color: #475569; font-size: 15px; line-height: 1.6;">
          Visit our guides for step-by-step instructions on setting up classes, adding teachers, and using ClassPilot features:
        </p>
        <div style="text-align: center; margin: 16px 0;">
          <a href="${guidesUrl}" style="display: inline-block; background: white; color: #2563eb; padding: 12px 32px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 15px; border: 2px solid #2563eb;">View Guides</a>
        </div>

        <div style="margin-top: 32px; padding-top: 24px; border-top: 1px solid #e2e8f0;">
          <p style="color: #64748b; margin: 0; font-size: 14px;">
            Need help? Reply to this email or contact us at <a href="mailto:support@school-pilot.net" style="color: #2563eb;">support@school-pilot.net</a>
          </p>
        </div>
      </div>

      <div style="background: #0f172a; padding: 16px; text-align: center;">
        <p style="color: #64748b; margin: 0; font-size: 12px;">
          &copy; ${new Date().getFullYear()} ClassPilot. All rights reserved.
        </p>
      </div>
    </div>
  `;

  const text = `
${data.customMessage || `Welcome to ClassPilot, ${data.schoolName}!

Hi ${data.adminName},

Your school, ${data.schoolName}, is now set up on ClassPilot! Here's everything you need to get started.`}

1. LOG IN
---------
Sign in to your admin dashboard: ${data.loginUrl}

2. INSTALL THE CHROME EXTENSION
-------------------------------
Students need the ClassPilot Chrome extension on their managed Chromebooks.

Chrome Web Store: ${extensionUrl}

Force-Install via Google Admin Console:
  1. Go to Google Admin Console > Devices > Chrome > Apps & extensions
  2. Select the organizational unit for your students
  3. Click the + icon > Add Chrome app or extension by ID
  4. Enter the extension ID: ${extensionId}
  5. Set the installation policy to Force install
  6. Click Save

3. GETTING STARTED GUIDES
--------------------------
Visit our guides for step-by-step instructions: ${guidesUrl}

Need help? Contact us at support@school-pilot.net
  `.trim();

  if (!transporter) {
    console.log(`[Email] SMTP not configured. Would have sent onboarding email to ${data.adminEmail}:`);
    console.log(`[Email] Subject: ${subject}`);
    console.log(`[Email] Content:\n${text}`);
    return true;
  }

  try {
    await transporter.sendMail({
      from: FROM_EMAIL,
      to: data.adminEmail,
      subject,
      text,
      html,
    });
    console.log(`[Email] Onboarding email sent to ${data.adminEmail}`);
    return true;
  } catch (error) {
    console.error(`[Email] Failed to send onboarding email to ${data.adminEmail}:`, error);
    return false;
  }
}
