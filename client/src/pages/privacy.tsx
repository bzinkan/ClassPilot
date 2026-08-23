import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Monitor, ArrowLeft } from "lucide-react";

export default function PrivacyPage() {
  return (
    <div className="min-h-screen bg-slate-50">
      {/* Navigation */}
      <nav className="bg-slate-900 border-b border-slate-800">
        <div className="container mx-auto px-4 py-4 flex justify-between items-center">
          <Link href="/">
            <div className="flex items-center gap-3 cursor-pointer">
              <div className="w-10 h-10 bg-amber-500 rounded-lg flex items-center justify-center shadow-lg">
                <Monitor className="w-6 h-6 text-slate-900" />
              </div>
              <span className="text-2xl font-bold text-white">ClassPilot</span>
            </div>
          </Link>
          <Link href="/">
            <Button variant="ghost" className="text-white hover:bg-white/10">
              <ArrowLeft className="w-4 h-4 mr-2" />
              Back to Home
            </Button>
          </Link>
        </div>
      </nav>

      {/* Content */}
      <div className="container mx-auto px-4 py-12 max-w-4xl">
        <h1 className="text-4xl font-bold text-slate-900 mb-8">Privacy Policy</h1>
        <p className="text-slate-600 mb-8">Last updated: August 23, 2026</p>

        <div className="prose prose-slate max-w-none space-y-8">
          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-4">1. Introduction</h2>
            <p className="text-slate-700 leading-relaxed">
              ClassPilot ("we," "our," or "us") is committed to protecting the privacy of students, teachers,
              and school administrators who use our classroom monitoring platform. This Privacy Policy explains
              how we collect, use, disclose, and safeguard your information when you use our service.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-4">2. Information We Collect</h2>

            <h3 className="text-xl font-medium text-slate-800 mb-3">2.1 Account Information</h3>
            <p className="text-slate-700 leading-relaxed mb-4">
              When you create an account, we collect:
            </p>
            <ul className="list-disc pl-6 text-slate-700 space-y-2 mb-4">
              <li>Name and email address (via Google OAuth)</li>
              <li>School affiliation</li>
              <li>Role (teacher, administrator, or student)</li>
              <li>Profile picture (if provided by Google)</li>
            </ul>

            <h3 className="text-xl font-medium text-slate-800 mb-3">2.2 Classroom Data</h3>
            <p className="text-slate-700 leading-relaxed mb-4">
              To provide our monitoring service, we collect:
            </p>
            <ul className="list-disc pl-6 text-slate-700 space-y-2 mb-4">
              <li>Google Classroom roster information (class names, student enrollments)</li>
              <li>Screen capture thumbnails during active monitoring sessions</li>
              <li>Exact safety/evidence screenshots when an authorized safety action requests one</li>
              <li>Current tab URLs and titles during monitoring</li>
              <li>Device connection status</li>
              <li>Student-teacher ClassPilot communications and session-report activity</li>
              <li>Temporary authorized Live View media; the extension and SchoolPilot servers do not record it, but an authorized teacher can explicitly save a local recording or still image</li>
            </ul>

            <h3 className="text-xl font-medium text-slate-800 mb-3">2.3 Technical Data</h3>
            <p className="text-slate-700 leading-relaxed">
              We automatically collect certain technical information including browser type, device information,
              IP address, and usage logs to maintain and improve our service.
            </p>
            <p className="text-slate-700 leading-relaxed mt-4">
              During an explicit authorized managed-kiosk launch, the extension first performs a non-sensitive
              capability preflight. Only after SchoolPilot accepts the protected V2 flow may the extension read
              and send the raw Chrome directory device identifier to that exact SchoolPilot origin. The server
              immediately converts it to a school-scoped opaque identifier and never stores or logs the raw value
              or places it in a URL. PIN or signed-token kiosk authorization remains required.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-4">3. How We Use Your Information</h2>
            <p className="text-slate-700 leading-relaxed mb-4">
              We use the collected information to:
            </p>
            <ul className="list-disc pl-6 text-slate-700 space-y-2">
              <li>Provide real-time classroom monitoring capabilities to teachers</li>
              <li>Sync classroom rosters from Google Classroom</li>
              <li>Display student screens to authorized teachers during class sessions</li>
              <li>Generate usage reports for teachers and administrators</li>
              <li>Classify monitored URL/domain signals and generate automated safety alerts for authorized human review</li>
              <li>Maintain and improve our service</li>
              <li>Communicate important updates about the service</li>
              <li>Ensure compliance with school policies and legal requirements</li>
            </ul>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-4">4. Data Retention and Deletion</h2>
            <p className="text-slate-700 leading-relaxed mb-4">
              We retain data only as long as necessary to provide our services:
            </p>
            <ul className="list-disc pl-6 text-slate-700 space-y-2">
              <li><strong>Ambient thumbnails:</strong> Held in a short-lived operational cache, normally 60–120 seconds</li>
              <li><strong>Safety/evidence image content:</strong> Uses a separate deployment policy, currently 30 days by default; bounded review metadata may remain</li>
              <li><strong>Heartbeat history and session-report detail:</strong> Uses the school's selected whole-number period from 1 through 365 days, default 30, and is purged or redacted by an hourly scheduled job</li>
              <li><strong>Account, audit, communication, and teacher-downloaded files:</strong> Follow separate documented or contractual policies and are not governed by the heartbeat-retention setting</li>
            </ul>
            <p className="text-slate-700 leading-relaxed mt-4">
              Schools may submit a verified deletion request at any time by contacting us at privacy@classpilot.net.
              Current roster and school controls deactivate access and are not proof of permanent destruction;
              SchoolPilot confirms the approved deletion scope and completion under the applicable agreement and law.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-4">5. FERPA Compliance</h2>
            <p className="text-slate-700 leading-relaxed mb-4">
              ClassPilot is designed to comply with the Family Educational Rights and Privacy Act (FERPA).
              We act as a "school official" under FERPA, meaning:
            </p>
            <ul className="list-disc pl-6 text-slate-700 space-y-2">
              <li>We use education records only for legitimate educational purposes</li>
              <li>We are under direct control of the school regarding data use</li>
              <li>We do not sell or rent student information; contracted service providers process purpose-limited data needed to operate enabled features under applicable agreements</li>
              <li>We maintain appropriate security measures to protect student data</li>
            </ul>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-4">6. COPPA Compliance</h2>
            <p className="text-slate-700 leading-relaxed">
              ClassPilot may collect the documented browsing activity, screenshots, and intentional classroom
              inputs of students under 13 only under the direction and authorization of the contracting school
              for an educational purpose. There is no independent child signup or collection outside school
              direction. The school remains responsible for the notices and any additional consent its policies
              or applicable law require, including use of COPPA's school-consent exception where available.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-4">7. Data Security</h2>
            <p className="text-slate-700 leading-relaxed mb-4">
              We implement industry-standard security measures to protect your data:
            </p>
            <ul className="list-disc pl-6 text-slate-700 space-y-2">
              <li>All data transmitted using TLS/SSL encryption</li>
              <li>Data stored in encrypted databases</li>
              <li>Regular security audits and vulnerability assessments</li>
              <li>Role-based access controls</li>
              <li>Secure authentication via Google OAuth</li>
            </ul>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-4">8. Data Sharing</h2>
            <p className="text-slate-700 leading-relaxed mb-4">
              We do not sell, trade, or rent personal information. We may share data only:
            </p>
            <ul className="list-disc pl-6 text-slate-700 space-y-2">
              <li>With authorized school personnel within your institution</li>
              <li>With contracted service providers that operate enabled features, including AWS infrastructure and TURN, Twilio SendGrid email, Google identity/roster services, Sentry error monitoring, and Stripe billing</li>
              <li>With Anthropic's API for fallback classification of a monitored full URL and page title; those values can themselves contain identifying or user-entered content even though no separate student identity field is added</li>
              <li>When required by law or to protect rights and safety</li>
              <li>With your explicit consent</li>
            </ul>
            <p className="text-slate-700 leading-relaxed mt-4">
              The current provider purposes and data exposure are published in SchoolPilot's{' '}
              <a href="https://school-pilot.net/subprocessors" className="text-amber-600 hover:text-amber-700 underline">
                Subprocessors notice
              </a>.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-4">9. Monitoring Limitations</h2>
            <p className="text-slate-700 leading-relaxed mb-4">
              ClassPilot is designed with student privacy in mind:
            </p>
            <ul className="list-disc pl-6 text-slate-700 space-y-2">
              <li>Monitoring occurs only during designated school hours</li>
              <li>Students receive clear visual indicators when monitoring is active</li>
              <li>Teachers can only monitor students in their assigned classes</li>
              <li>Personal devices are not monitored outside of school-managed contexts</li>
            </ul>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-4">10. Your Rights</h2>
            <p className="text-slate-700 leading-relaxed mb-4">
              Parents, students (where applicable), and school personnel have the right to:
            </p>
            <ul className="list-disc pl-6 text-slate-700 space-y-2">
              <li>Access personal information we hold</li>
              <li>Request correction of inaccurate data</li>
              <li>Request deletion of data (subject to legal requirements)</li>
              <li>Opt out of non-essential communications</li>
            </ul>
            <p className="text-slate-700 leading-relaxed mt-4">
              To exercise these rights, contact your school administrator or email us at privacy@classpilot.net.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-4">11. Changes to This Policy</h2>
            <p className="text-slate-700 leading-relaxed">
              We may update this Privacy Policy from time to time. We will notify schools of significant
              changes via email and update the "Last updated" date at the top of this page. Continued use
              of our service after changes constitutes acceptance of the updated policy.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-4">12. Contact Us</h2>
            <p className="text-slate-700 leading-relaxed">
              If you have questions about this Privacy Policy or our data practices, please contact us:
            </p>
            <div className="mt-4 p-4 bg-slate-100 rounded-lg">
              <p className="text-slate-700">
                <strong>Email:</strong> privacy@classpilot.net<br />
                <strong>Support:</strong> support@classpilot.net
              </p>
            </div>
          </section>
        </div>
      </div>

      {/* Footer */}
      <footer className="bg-slate-950 text-slate-400 py-8 mt-12">
        <div className="container mx-auto px-4 text-center">
          <p className="text-sm">&copy; 2025 ClassPilot. All rights reserved.</p>
          <div className="mt-4 space-x-4 text-sm">
            <Link href="/privacy" className="hover:text-amber-400 transition-colors">Privacy Policy</Link>
            <Link href="/terms" className="hover:text-amber-400 transition-colors">Terms of Service</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
