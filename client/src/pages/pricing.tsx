import { useState } from "react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Check, Monitor, Calculator } from "lucide-react";

export default function PricingPage() {
  const [studentCount, setStudentCount] = useState(100);

  const calculatePrice = (students: number) => {
    return 500 + (students * 1);
  };

  const totalPrice = calculatePrice(studentCount);

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-white">
      {/* Navigation */}
      <nav className="border-b bg-white/80 backdrop-blur-sm sticky top-0 z-50 shadow-sm">
        <div className="container mx-auto px-4 py-4 flex justify-between items-center">
          <Link href="/">
            <div className="flex items-center gap-3 cursor-pointer">
              <div className="w-10 h-10 bg-amber-500 rounded-lg flex items-center justify-center shadow-lg">
                <Monitor className="w-6 h-6 text-slate-900" />
              </div>
              <span className="text-2xl font-bold text-slate-900">ClassPilot</span>
            </div>
          </Link>
          <div className="flex gap-4 items-center">
            <Link href="/">
              <Button variant="ghost">Back to Home</Button>
            </Link>
            <Link href="/login">
              <Button variant="ghost">Sign In</Button>
            </Link>
            <Link href="/login">
              <Button className="bg-amber-500 hover:bg-amber-600 text-slate-900 font-semibold">
                Get Started Free
              </Button>
            </Link>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="container mx-auto px-4 py-16 text-center">
        <div className="max-w-3xl mx-auto">
          <h1 className="text-5xl md:text-6xl font-bold text-slate-900 mb-6">
            Simple, Transparent
            <span className="text-amber-600"> Annual Pricing</span>
          </h1>
          <p className="text-xl text-slate-600 mb-8">
            Pay once per year. No monthly fees, no hidden costs, no surprises.
            Just straightforward pricing that scales with your school.
          </p>
        </div>
      </section>

      {/* Pricing Calculator */}
      <section className="container mx-auto px-4 pb-12">
        <div className="max-w-4xl mx-auto">
          <Card className="border-2 border-amber-400 shadow-2xl bg-white">
            <CardHeader className="bg-gradient-to-r from-amber-50 to-orange-50 border-b-2 border-amber-200">
              <div className="flex items-center gap-3 mb-2">
                <Calculator className="w-8 h-8 text-amber-600" />
                <CardTitle className="text-3xl">Calculate Your Annual Cost</CardTitle>
              </div>
              <CardDescription className="text-base">
                Our pricing is simple: $500 base fee + $1 per student per year
              </CardDescription>
            </CardHeader>
            <CardContent className="p-8">
              <div className="space-y-6">
                <div>
                  <Label htmlFor="students" className="text-lg font-semibold text-slate-700 mb-2 block">
                    How many students will use ClassPilot?
                  </Label>
                  <Input
                    id="students"
                    type="number"
                    min="1"
                    max="10000"
                    value={studentCount}
                    onChange={(e) => setStudentCount(Math.max(1, parseInt(e.target.value) || 1))}
                    className="text-2xl p-6 text-center font-bold border-2 border-slate-300 focus:border-amber-500"
                  />
                  <p className="text-sm text-slate-500 mt-2 text-center">
                    Typical school: 100-500 students • Large school: 500-2000 students
                  </p>
                </div>

                <div className="bg-slate-50 rounded-lg p-8 border-2 border-slate-200">
                  <div className="space-y-4">
                    <div className="flex justify-between items-center text-lg">
                      <span className="text-slate-700">Base Platform Fee</span>
                      <span className="font-semibold">$500.00</span>
                    </div>
                    <div className="flex justify-between items-center text-lg">
                      <span className="text-slate-700">{studentCount.toLocaleString()} Students × $1</span>
                      <span className="font-semibold">${studentCount.toLocaleString()}.00</span>
                    </div>
                    <div className="border-t-2 border-slate-300 pt-4">
                      <div className="flex justify-between items-center">
                        <span className="text-2xl font-bold text-slate-900">Total Annual Cost</span>
                        <span className="text-4xl font-bold text-amber-600">
                          ${totalPrice.toLocaleString()}
                        </span>
                      </div>
                      <p className="text-sm text-slate-500 mt-2 text-right">
                        That's just ${(totalPrice / 12).toFixed(2)}/month if paid annually
                      </p>
                    </div>
                  </div>
                </div>

                <div className="text-center pt-4">
                  <Link href="/login">
                    <Button size="lg" className="bg-amber-500 hover:bg-amber-600 text-slate-900 font-bold text-xl px-12 py-6">
                      Start 30-Day Free Trial
                    </Button>
                  </Link>
                  <p className="text-sm text-slate-500 mt-3">
                    No credit card required • Full access during trial • Cancel anytime
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </section>

      {/* Pricing Examples */}
      <section className="container mx-auto px-4 py-16">
        <h2 className="text-3xl font-bold text-center mb-12 text-slate-900">
          Example School Pricing
        </h2>
        <div className="grid md:grid-cols-3 gap-8 max-w-6xl mx-auto">
          {/* Small School */}
          <Card className="border-2 border-slate-200 hover:border-amber-400 hover:shadow-lg transition-all">
            <CardHeader>
              <CardTitle className="text-2xl">Small School</CardTitle>
              <CardDescription className="text-base">Elementary or charter school</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="mb-6">
                <div className="text-4xl font-bold text-slate-900 mb-2">$600</div>
                <div className="text-slate-600">per year</div>
                <div className="text-sm text-slate-500 mt-1">100 students</div>
              </div>
              <ul className="space-y-3 text-sm">
                <li className="flex items-start gap-2">
                  <Check className="w-5 h-5 text-green-600 mt-0.5 flex-shrink-0" />
                  <span>Real-time monitoring for all students</span>
                </li>
                <li className="flex items-start gap-2">
                  <Check className="w-5 h-5 text-green-600 mt-0.5 flex-shrink-0" />
                  <span>Google Classroom integration</span>
                </li>
                <li className="flex items-start gap-2">
                  <Check className="w-5 h-5 text-green-600 mt-0.5 flex-shrink-0" />
                  <span>Unlimited teachers</span>
                </li>
                <li className="flex items-start gap-2">
                  <Check className="w-5 h-5 text-green-600 mt-0.5 flex-shrink-0" />
                  <span>Usage reports & analytics</span>
                </li>
                <li className="flex items-start gap-2">
                  <Check className="w-5 h-5 text-green-600 mt-0.5 flex-shrink-0" />
                  <span>Email support</span>
                </li>
              </ul>
            </CardContent>
          </Card>

          {/* Medium School */}
          <Card className="border-2 border-amber-400 shadow-lg relative">
            <div className="absolute -top-4 left-1/2 -translate-x-1/2 bg-amber-500 text-white px-4 py-1 rounded-full text-sm font-semibold">
              Most Common
            </div>
            <CardHeader>
              <CardTitle className="text-2xl">Medium School</CardTitle>
              <CardDescription className="text-base">Middle or high school</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="mb-6">
                <div className="text-4xl font-bold text-slate-900 mb-2">$1,000</div>
                <div className="text-slate-600">per year</div>
                <div className="text-sm text-slate-500 mt-1">500 students</div>
              </div>
              <ul className="space-y-3 text-sm">
                <li className="flex items-start gap-2">
                  <Check className="w-5 h-5 text-green-600 mt-0.5 flex-shrink-0" />
                  <span>Everything in Small School</span>
                </li>
                <li className="flex items-start gap-2">
                  <Check className="w-5 h-5 text-green-600 mt-0.5 flex-shrink-0" />
                  <span>Multi-class monitoring</span>
                </li>
                <li className="flex items-start gap-2">
                  <Check className="w-5 h-5 text-green-600 mt-0.5 flex-shrink-0" />
                  <span>Student groups & organization</span>
                </li>
                <li className="flex items-start gap-2">
                  <Check className="w-5 h-5 text-green-600 mt-0.5 flex-shrink-0" />
                  <span>Advanced analytics</span>
                </li>
                <li className="flex items-start gap-2">
                  <Check className="w-5 h-5 text-green-600 mt-0.5 flex-shrink-0" />
                  <span>Priority support</span>
                </li>
              </ul>
            </CardContent>
          </Card>

          {/* Large School */}
          <Card className="border-2 border-slate-200 hover:border-amber-400 hover:shadow-lg transition-all">
            <CardHeader>
              <CardTitle className="text-2xl">Large School</CardTitle>
              <CardDescription className="text-base">Large high school or campus</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="mb-6">
                <div className="text-4xl font-bold text-slate-900 mb-2">$2,000</div>
                <div className="text-slate-600">per year</div>
                <div className="text-sm text-slate-500 mt-1">1,500 students</div>
              </div>
              <ul className="space-y-3 text-sm">
                <li className="flex items-start gap-2">
                  <Check className="w-5 h-5 text-green-600 mt-0.5 flex-shrink-0" />
                  <span>Everything in Medium School</span>
                </li>
                <li className="flex items-start gap-2">
                  <Check className="w-5 h-5 text-green-600 mt-0.5 flex-shrink-0" />
                  <span>Department-level organization</span>
                </li>
                <li className="flex items-start gap-2">
                  <Check className="w-5 h-5 text-green-600 mt-0.5 flex-shrink-0" />
                  <span>Custom reporting</span>
                </li>
                <li className="flex items-start gap-2">
                  <Check className="w-5 h-5 text-green-600 mt-0.5 flex-shrink-0" />
                  <span>Dedicated support contact</span>
                </li>
                <li className="flex items-start gap-2">
                  <Check className="w-5 h-5 text-green-600 mt-0.5 flex-shrink-0" />
                  <span>Training sessions available</span>
                </li>
              </ul>
            </CardContent>
          </Card>
        </div>
      </section>

      {/* District Pricing */}
      <section className="bg-slate-50 py-16 border-t-2 border-slate-200">
        <div className="container mx-auto px-4">
          <div className="max-w-4xl mx-auto">
            <Card className="border-2 border-slate-300 bg-white">
              <CardHeader className="text-center">
                <CardTitle className="text-3xl mb-2">School District Pricing</CardTitle>
                <CardDescription className="text-lg">
                  Multiple schools? We have special pricing for districts.
                </CardDescription>
              </CardHeader>
              <CardContent className="text-center pb-8">
                <p className="text-slate-700 mb-6 text-lg">
                  Districts with 3+ schools receive volume discounts and dedicated support.
                  We'll work with your procurement team to create a custom quote that fits your budget.
                </p>
                <div className="grid md:grid-cols-3 gap-6 mb-8 text-left">
                  <div className="flex items-start gap-3">
                    <Check className="w-6 h-6 text-green-600 mt-1 flex-shrink-0" />
                    <div>
                      <div className="font-semibold text-slate-900">Volume Discounts</div>
                      <div className="text-sm text-slate-600">Lower per-student rates for districts</div>
                    </div>
                  </div>
                  <div className="flex items-start gap-3">
                    <Check className="w-6 h-6 text-green-600 mt-1 flex-shrink-0" />
                    <div>
                      <div className="font-semibold text-slate-900">Flexible Payment</div>
                      <div className="text-sm text-slate-600">Net-30 terms & PO acceptance</div>
                    </div>
                  </div>
                  <div className="flex items-start gap-3">
                    <Check className="w-6 h-6 text-green-600 mt-1 flex-shrink-0" />
                    <div>
                      <div className="font-semibold text-slate-900">Dedicated Support</div>
                      <div className="text-sm text-slate-600">Account manager & training</div>
                    </div>
                  </div>
                </div>
                <Button size="lg" variant="outline" className="text-lg px-8 border-2 border-slate-300 hover:bg-slate-50">
                  Contact Sales for District Quote
                </Button>
              </CardContent>
            </Card>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="bg-gradient-to-r from-slate-800 to-slate-900 text-white py-20">
        <div className="container mx-auto px-4 text-center">
          <h2 className="text-4xl md:text-5xl font-bold mb-6">
            Ready to Get Started?
          </h2>
          <p className="text-xl text-slate-300 mb-8 max-w-2xl mx-auto">
            Start your free 30-day trial today. No credit card, no commitment, no risk.
          </p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <Link href="/login">
              <Button size="lg" className="bg-amber-500 hover:bg-amber-600 text-slate-900 font-semibold text-xl px-12 py-7">
                Start Free Trial
              </Button>
            </Link>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="bg-slate-950 text-slate-400 py-12">
        <div className="container mx-auto px-4 text-center">
          <div className="flex items-center justify-center gap-3 mb-4">
            <div className="w-10 h-10 bg-amber-500 rounded-lg flex items-center justify-center">
              <Monitor className="w-6 h-6 text-slate-900" />
            </div>
            <span className="text-xl font-bold text-white">ClassPilot</span>
          </div>
          <p className="text-sm">&copy; 2025 ClassPilot. All rights reserved.</p>
        </div>
      </footer>
    </div>
  );
}
