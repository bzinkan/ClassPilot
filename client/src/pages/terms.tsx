import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Monitor, ArrowLeft } from "lucide-react";

export default function TermsPage() {
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
        <h1 className="text-4xl font-bold text-slate-900 mb-8">Terms of Service</h1>
        <p className="text-slate-600 mb-8">Last updated: January 6, 2025</p>

        <div className="prose prose-slate max-w-none space-y-8">
          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-4">1. Acceptance of Terms</h2>
            <p className="text-slate-700 leading-relaxed">
              By accessing or using ClassPilot ("Service"), you agree to be bound by these Terms of Service
              ("Terms"). If you do not agree to these Terms, you may not use the Service. These Terms apply
              to all users, including teachers, school administrators, students, and any other visitors.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-4">2. Description of Service</h2>
            <p className="text-slate-700 leading-relaxed">
              ClassPilot is a classroom management platform that enables teachers to monitor student device
              activity during instructional time. The Service includes real-time screen viewing, Google
              Classroom integration, and classroom management tools designed for K-12 educational environments.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-4">3. Eligibility and Account Registration</h2>
            <p className="text-slate-700 leading-relaxed mb-4">
              The Service is intended for use by:
            </p>
            <ul className="list-disc pl-6 text-slate-700 space-y-2">
              <li>Schools and educational institutions</li>
              <li>Teachers and educators authorized by their school</li>
              <li>School administrators</li>
              <li>Students whose schools have adopted the Service</li>
            </ul>
            <p className="text-slate-700 leading-relaxed mt-4">
              Individual accounts must be created by school administrators. Users must provide accurate
              information and maintain the security of their account credentials.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-4">4. Acceptable Use</h2>
            <p className="text-slate-700 leading-relaxed mb-4">
              You agree to use the Service only for lawful educational purposes. You may not:
            </p>
            <ul className="list-disc pl-6 text-slate-700 space-y-2">
              <li>Use the Service to monitor students outside of designated school hours or educational contexts</li>
              <li>Share, distribute, or publicly display student screen captures</li>
              <li>Attempt to access accounts or data belonging to other schools or users</li>
              <li>Use the Service to harass, intimidate, or discriminate against students</li>
              <li>Reverse engineer, decompile, or attempt to extract the source code of the Service</li>
              <li>Use the Service in violation of any applicable laws or regulations</li>
            </ul>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-4">5. School Responsibilities</h2>
            <p className="text-slate-700 leading-relaxed mb-4">
              Schools using ClassPilot are responsible for:
            </p>
            <ul className="list-disc pl-6 text-slate-700 space-y-2">
              <li>Obtaining any required parental consent for student monitoring</li>
              <li>Notifying students and parents about the use of classroom monitoring software</li>
              <li>Ensuring the Service is used in compliance with school policies and applicable laws</li>
              <li>Managing user accounts and access permissions appropriately</li>
              <li>Training staff on appropriate use of monitoring capabilities</li>
            </ul>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-4">6. Student Privacy</h2>
            <p className="text-slate-700 leading-relaxed">
              ClassPilot is designed with student privacy as a priority. Monitoring occurs only during
              designated school hours, students receive visual indicators when monitoring is active,
              and screen captures are automatically deleted after a short retention period. For full
              details on how we handle student data, please review our{" "}
              <Link href="/privacy" className="text-amber-600 hover:text-amber-700 underline">
                Privacy Policy
              </Link>.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-4">7. Subscription and Payment</h2>
            <p className="text-slate-700 leading-relaxed mb-4">
              ClassPilot offers subscription-based pricing for schools. By subscribing, you agree to:
            </p>
            <ul className="list-disc pl-6 text-slate-700 space-y-2">
              <li>Pay all applicable fees according to your selected plan</li>
              <li>Provide accurate billing information</li>
              <li>Automatic renewal unless cancelled before the renewal date</li>
            </ul>
            <p className="text-slate-700 leading-relaxed mt-4">
              Pricing and plan details are available on our pricing page. We reserve the right to
              modify pricing with 30 days notice.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-4">8. Intellectual Property</h2>
            <p className="text-slate-700 leading-relaxed">
              ClassPilot and its original content, features, and functionality are owned by ClassPilot
              and are protected by international copyright, trademark, and other intellectual property
              laws. You may not copy, modify, distribute, or create derivative works based on our
              Service without express written permission.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-4">9. Third-Party Services</h2>
            <p className="text-slate-700 leading-relaxed">
              ClassPilot integrates with third-party services including Google Classroom and Google
              Workspace for Education. Your use of these integrations is subject to the respective
              third-party terms of service. We are not responsible for the practices or content of
              third-party services.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-4">10. Service Availability</h2>
            <p className="text-slate-700 leading-relaxed">
              We strive to maintain high availability of the Service but do not guarantee uninterrupted
              access. The Service may be temporarily unavailable due to maintenance, updates, or
              circumstances beyond our control. We will make reasonable efforts to provide advance
              notice of scheduled maintenance.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-4">11. Disclaimer of Warranties</h2>
            <p className="text-slate-700 leading-relaxed">
              THE SERVICE IS PROVIDED "AS IS" AND "AS AVAILABLE" WITHOUT WARRANTIES OF ANY KIND,
              EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO IMPLIED WARRANTIES OF
              MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND NON-INFRINGEMENT. WE DO NOT
              WARRANT THAT THE SERVICE WILL BE ERROR-FREE OR UNINTERRUPTED.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-4">12. Limitation of Liability</h2>
            <p className="text-slate-700 leading-relaxed">
              TO THE MAXIMUM EXTENT PERMITTED BY LAW, CLASSPILOT SHALL NOT BE LIABLE FOR ANY INDIRECT,
              INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES, OR ANY LOSS OF PROFITS OR
              REVENUES, WHETHER INCURRED DIRECTLY OR INDIRECTLY, OR ANY LOSS OF DATA, USE, GOODWILL,
              OR OTHER INTANGIBLE LOSSES RESULTING FROM YOUR USE OF THE SERVICE.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-4">13. Indemnification</h2>
            <p className="text-slate-700 leading-relaxed">
              You agree to indemnify and hold harmless ClassPilot and its officers, directors, employees,
              and agents from any claims, damages, losses, liabilities, and expenses (including legal
              fees) arising from your use of the Service or violation of these Terms.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-4">14. Termination</h2>
            <p className="text-slate-700 leading-relaxed">
              We may terminate or suspend your access to the Service immediately, without prior notice,
              for conduct that we believe violates these Terms or is harmful to other users, us, or
              third parties, or for any other reason at our sole discretion. Upon termination, your
              right to use the Service will immediately cease.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-4">15. Changes to Terms</h2>
            <p className="text-slate-700 leading-relaxed">
              We reserve the right to modify these Terms at any time. We will notify users of material
              changes by posting the updated Terms on our website and updating the "Last updated" date.
              Your continued use of the Service after changes become effective constitutes acceptance
              of the revised Terms.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-4">16. Governing Law</h2>
            <p className="text-slate-700 leading-relaxed">
              These Terms shall be governed by and construed in accordance with the laws of the
              United States, without regard to its conflict of law provisions.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold text-slate-900 mb-4">17. Contact Us</h2>
            <p className="text-slate-700 leading-relaxed">
              If you have questions about these Terms of Service, please contact us:
            </p>
            <div className="mt-4 p-4 bg-slate-100 rounded-lg">
              <p className="text-slate-700">
                <strong>Email:</strong> legal@classpilot.net<br />
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
