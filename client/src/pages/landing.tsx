import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Monitor, BookOpen, Clock, Users, BarChart3, Shield } from "lucide-react";

export default function LandingPage() {
  return (
    <div className="min-h-screen">
      {/* Classroom-inspired Hero with chalkboard aesthetic */}
      <section className="relative bg-gradient-to-br from-slate-700 via-slate-800 to-slate-900 text-white overflow-hidden">
        {/* Subtle texture overlay */}
        <div className="absolute inset-0 opacity-10" style={{
          backgroundImage: `url("data:image/svg+xml,%3Csvg width='60' height='60' viewBox='0 0 60 60' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' fill-rule='evenodd'%3E%3Cg fill='%23ffffff' fill-opacity='0.4'%3E%3Cpath d='M36 34v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zm0-30V0h-2v4h-4v2h4v4h2V6h4V4h-4zM6 34v-4H4v4H0v2h4v4h2v-4h4v-2H6zM6 4V0H4v4H0v2h4v4h2V6h4V4H6z'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E")`
        }}></div>

        {/* Navigation */}
        <nav className="relative border-b border-white/10 bg-black/20 backdrop-blur-sm sticky top-0 z-50">
          <div className="container mx-auto px-4 py-4 flex justify-between items-center">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-amber-500 rounded-lg flex items-center justify-center shadow-lg">
                <Monitor className="w-6 h-6 text-slate-900" />
              </div>
              <span className="text-2xl font-bold text-white">ClassPilot</span>
            </div>
            <div className="flex gap-4 items-center">
              <Link href="/pricing">
                <Button variant="ghost" className="text-white hover:bg-white/10">Pricing</Button>
              </Link>
              <Link href="/login">
                <Button variant="ghost" className="text-white hover:bg-white/10">Sign In</Button>
              </Link>
              <Link href="/login">
                <Button className="bg-amber-500 hover:bg-amber-600 text-slate-900 font-semibold">
                  Get Started Free
                </Button>
              </Link>
            </div>
          </div>
        </nav>

        {/* Hero Content - Classroom Welcome */}
        <div className="relative container mx-auto px-4 py-12 pb-0">
          <div className="max-w-4xl mx-auto text-center mb-8">
            {/* Chalk-style heading */}
            <div className="mb-8">
              <p className="text-amber-400 text-lg font-medium mb-4 tracking-wide">
                Welcome to Your Digital Classroom
              </p>
              <h1 className="text-5xl md:text-7xl font-bold mb-6 leading-tight">
                See Every Screen.
                <br />
                <span className="text-amber-400">Keep Every Student Focused.</span>
              </h1>
            </div>

            <p className="text-xl md:text-2xl text-slate-300 mb-10 max-w-3xl mx-auto leading-relaxed">
              Real-time classroom monitoring that helps teachers maintain focus and
              engagement across all student devices. Simple, secure, and built for education.
            </p>

            <div className="flex flex-col sm:flex-row gap-4 justify-center items-center mb-8">
              <Link href="/login">
                <Button size="lg" className="bg-amber-500 hover:bg-amber-600 text-slate-900 font-semibold text-lg px-10 py-6 shadow-xl">
                  Start Free Trial
                </Button>
              </Link>
              <Link href="/pricing">
                <Button size="lg" variant="outline" className="text-white border-white/30 hover:bg-white/10 text-lg px-10 py-6">
                  View Pricing
                </Button>
              </Link>
            </div>

            <p className="text-sm text-slate-400">
              ✓ No credit card required  •  ✓ 30-day free trial  •  ✓ Setup in 10 minutes
            </p>
          </div>
        </div>

        {/* Desk row separator */}
        <div className="absolute bottom-0 left-0 right-0 h-8 bg-amber-700"></div>
        <div className="absolute bottom-0 left-0 right-0 h-2 bg-amber-900"></div>
      </section>

      {/* Features - Classroom Layout */}
      <section className="bg-gradient-to-b from-amber-50 to-white py-20">
        <div className="container mx-auto px-4">
          <div className="text-center mb-16">
            <h2 className="text-4xl md:text-5xl font-bold text-slate-900 mb-4">
              Everything You Need in One Dashboard
            </h2>
            <p className="text-xl text-slate-600 max-w-2xl mx-auto">
              Designed by teachers, for teachers. Monitor, manage, and maintain classroom focus effortlessly.
            </p>
          </div>

          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-8 max-w-6xl mx-auto">
            {/* Feature Cards */}
            <Card className="border-2 border-slate-200 hover:border-amber-400 hover:shadow-xl transition-all duration-300 bg-white">
              <CardHeader>
                <div className="w-14 h-14 bg-amber-100 rounded-lg flex items-center justify-center mb-4">
                  <Monitor className="w-8 h-8 text-amber-600" />
                </div>
                <CardTitle className="text-2xl">Live Screen View</CardTitle>
                <CardDescription className="text-base">
                  See what every student is viewing in real-time. Click any screen to view full-size.
                  Instant visibility across your entire classroom.
                </CardDescription>
              </CardHeader>
            </Card>

            <Card className="border-2 border-slate-200 hover:border-amber-400 hover:shadow-xl transition-all duration-300 bg-white">
              <CardHeader>
                <div className="w-14 h-14 bg-blue-100 rounded-lg flex items-center justify-center mb-4">
                  <BookOpen className="w-8 h-8 text-blue-600" />
                </div>
                <CardTitle className="text-2xl">Google Classroom Sync</CardTitle>
                <CardDescription className="text-base">
                  Automatic roster import from Google Classroom. Your classes, students,
                  and groups sync automatically. Zero manual setup.
                </CardDescription>
              </CardHeader>
            </Card>

            <Card className="border-2 border-slate-200 hover:border-amber-400 hover:shadow-xl transition-all duration-300 bg-white">
              <CardHeader>
                <div className="w-14 h-14 bg-green-100 rounded-lg flex items-center justify-center mb-4">
                  <Clock className="w-8 h-8 text-green-600" />
                </div>
                <CardTitle className="text-2xl">Smart Scheduling</CardTitle>
                <CardDescription className="text-base">
                  Monitoring only happens during school hours. Automatic after-hours privacy mode
                  respects student time outside the classroom.
                </CardDescription>
              </CardHeader>
            </Card>

            <Card className="border-2 border-slate-200 hover:border-amber-400 hover:shadow-xl transition-all duration-300 bg-white">
              <CardHeader>
                <div className="w-14 h-14 bg-purple-100 rounded-lg flex items-center justify-center mb-4">
                  <Users className="w-8 h-8 text-purple-600" />
                </div>
                <CardTitle className="text-2xl">Multi-Class Management</CardTitle>
                <CardDescription className="text-base">
                  Monitor multiple classes simultaneously. Switch between periods with one click.
                  Perfect for teachers with back-to-back classes.
                </CardDescription>
              </CardHeader>
            </Card>

            <Card className="border-2 border-slate-200 hover:border-amber-400 hover:shadow-xl transition-all duration-300 bg-white">
              <CardHeader>
                <div className="w-14 h-14 bg-rose-100 rounded-lg flex items-center justify-center mb-4">
                  <BarChart3 className="w-8 h-8 text-rose-600" />
                </div>
                <CardTitle className="text-2xl">Usage Reports</CardTitle>
                <CardDescription className="text-base">
                  Track browsing patterns, time on task, and generate detailed reports.
                  Data-driven insights for better classroom management.
                </CardDescription>
              </CardHeader>
            </Card>

            <Card className="border-2 border-slate-200 hover:border-amber-400 hover:shadow-xl transition-all duration-300 bg-white">
              <CardHeader>
                <div className="w-14 h-14 bg-indigo-100 rounded-lg flex items-center justify-center mb-4">
                  <Shield className="w-8 h-8 text-indigo-600" />
                </div>
                <CardTitle className="text-2xl">FERPA Compliant</CardTitle>
                <CardDescription className="text-base">
                  Bank-level encryption, secure data storage, and full FERPA compliance.
                  Your students' privacy is our top priority.
                </CardDescription>
              </CardHeader>
            </Card>
          </div>
        </div>
      </section>

      {/* How It Works - Classroom Steps */}
      <section className="bg-slate-50 py-20 border-t-4 border-amber-500">
        <div className="container mx-auto px-4">
          <div className="text-center mb-16">
            <h2 className="text-4xl md:text-5xl font-bold text-slate-900 mb-4">
              Setup Takes 10 Minutes
            </h2>
            <p className="text-xl text-slate-600">
              Three simple steps to transform your classroom monitoring
            </p>
          </div>

          <div className="max-w-5xl mx-auto">
            <div className="grid md:grid-cols-3 gap-12">
              {/* Step 1 */}
              <div className="text-center">
                <div className="w-20 h-20 bg-amber-500 text-white rounded-full flex items-center justify-center text-3xl font-bold mx-auto mb-6 shadow-lg">
                  1
                </div>
                <div className="bg-white rounded-lg p-6 shadow-md border-2 border-slate-200">
                  <h3 className="text-2xl font-bold mb-3 text-slate-900">Sign Up</h3>
                  <p className="text-slate-600 text-lg">
                    Create your account with Google. Sync your Google Classroom rosters automatically.
                  </p>
                </div>
              </div>

              {/* Step 2 */}
              <div className="text-center">
                <div className="w-20 h-20 bg-amber-500 text-white rounded-full flex items-center justify-center text-3xl font-bold mx-auto mb-6 shadow-lg">
                  2
                </div>
                <div className="bg-white rounded-lg p-6 shadow-md border-2 border-slate-200">
                  <h3 className="text-2xl font-bold mb-3 text-slate-900">Install Extension</h3>
                  <p className="text-slate-600 text-lg">
                    Students install the Chrome extension. Devices auto-register with their school email.
                  </p>
                </div>
              </div>

              {/* Step 3 */}
              <div className="text-center">
                <div className="w-20 h-20 bg-amber-500 text-white rounded-full flex items-center justify-center text-3xl font-bold mx-auto mb-6 shadow-lg">
                  3
                </div>
                <div className="bg-white rounded-lg p-6 shadow-md border-2 border-slate-200">
                  <h3 className="text-2xl font-bold mb-3 text-slate-900">Start Monitoring</h3>
                  <p className="text-slate-600 text-lg">
                    Open your dashboard and see live screens instantly. Full classroom visibility in real-time.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* CTA Section - Classroom Door */}
      <section className="relative bg-gradient-to-br from-slate-800 via-slate-900 to-black text-white py-24 overflow-hidden">
        <div className="absolute inset-0 opacity-5" style={{
          backgroundImage: `url("data:image/svg+xml,%3Csvg width='60' height='60' viewBox='0 0 60 60' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' fill-rule='evenodd'%3E%3Cg fill='%23ffffff' fill-opacity='0.4'%3E%3Cpath d='M36 34v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zm0-30V0h-2v4h-4v2h4v4h2V6h4V4h-4zM6 34v-4H4v4H0v2h4v4h2v-4h4v-2H6zM6 4V0H4v4H0v2h4v4h2V6h4V4H6z'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E")`
        }}></div>

        <div className="relative container mx-auto px-4 text-center">
          <h2 className="text-4xl md:text-6xl font-bold mb-6">
            Ready to Enter Your Digital Classroom?
          </h2>
          <p className="text-xl md:text-2xl text-slate-300 mb-10 max-w-3xl mx-auto">
            Join schools using ClassPilot to maintain focus and engagement. Start your free 30-day trial today.
          </p>

          <div className="flex flex-col sm:flex-row gap-4 justify-center items-center">
            <Link href="/login">
              <Button size="lg" className="bg-amber-500 hover:bg-amber-600 text-slate-900 font-semibold text-xl px-12 py-7 shadow-2xl">
                Start Free Trial
              </Button>
            </Link>
            <Link href="/pricing">
              <Button size="lg" variant="outline" className="text-white border-white/30 hover:bg-white/10 text-xl px-12 py-7">
                View Pricing Details
              </Button>
            </Link>
          </div>

          <p className="text-slate-400 mt-8 text-lg">
            Questions? Email us at support@classpilot.com
          </p>
        </div>
      </section>

      {/* Footer */}
      <footer className="bg-slate-950 text-slate-400 py-12 border-t-4 border-amber-600">
        <div className="container mx-auto px-4">
          <div className="grid md:grid-cols-4 gap-8">
            <div>
              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 bg-amber-500 rounded-lg flex items-center justify-center">
                  <Monitor className="w-6 h-6 text-slate-900" />
                </div>
                <span className="text-xl font-bold text-white">ClassPilot</span>
              </div>
              <p className="text-sm text-slate-400">
                Real-time classroom monitoring for modern education.
              </p>
            </div>
            <div>
              <h3 className="text-white font-semibold mb-4">Product</h3>
              <ul className="space-y-2 text-sm">
                <li><a href="#" className="hover:text-amber-400 transition-colors">Features</a></li>
                <li><Link href="/pricing" className="hover:text-amber-400 transition-colors">Pricing</Link></li>
                <li><a href="#" className="hover:text-amber-400 transition-colors">Security</a></li>
                <li><a href="#" className="hover:text-amber-400 transition-colors">Chrome Extension</a></li>
              </ul>
            </div>
            <div>
              <h3 className="text-white font-semibold mb-4">Resources</h3>
              <ul className="space-y-2 text-sm">
                <li><a href="#" className="hover:text-amber-400 transition-colors">Help Center</a></li>
                <li><a href="#" className="hover:text-amber-400 transition-colors">Teacher Guides</a></li>
                <li><a href="#" className="hover:text-amber-400 transition-colors">Case Studies</a></li>
                <li><a href="#" className="hover:text-amber-400 transition-colors">Contact Us</a></li>
              </ul>
            </div>
            <div>
              <h3 className="text-white font-semibold mb-4">Legal</h3>
              <ul className="space-y-2 text-sm">
                <li><Link href="/privacy" className="hover:text-amber-400 transition-colors">Privacy Policy</Link></li>
                <li><Link href="/terms" className="hover:text-amber-400 transition-colors">Terms of Service</Link></li>
                <li><a href="#" className="hover:text-amber-400 transition-colors">FERPA Compliance</a></li>
                <li><a href="#" className="hover:text-amber-400 transition-colors">Data Security</a></li>
              </ul>
            </div>
          </div>
          <div className="border-t border-slate-800 mt-8 pt-8 text-center text-sm">
            <p>&copy; 2025 ClassPilot. All rights reserved.</p>
          </div>
        </div>
      </footer>
    </div>
  );
}
