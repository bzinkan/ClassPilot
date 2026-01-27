import { useState } from 'react';
import { Link } from "wouter";

export default function PricingPage() {
  const [studentCount, setStudentCount] = useState(500);

  const basePrice = 500;
  const perStudent = 2;
  const annualTotal = basePrice + (studentCount * perStudent);
  const monthlyEquivalent = Math.round(annualTotal / 12);

  // Savings if they skip trial (2 months free)
  const skipTrialSavings = Math.round(annualTotal / 6);
  const skipTrialPrice = annualTotal - skipTrialSavings;

  return (
    <div style={{
      minHeight: '100vh',
      background: '#0f172a',
      fontFamily: "'Inter', -apple-system, sans-serif",
      color: '#f1f5f9',
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Instrument+Serif:ital@0;1&display=swap');

        * { box-sizing: border-box; }

        .serif {
          font-family: 'Instrument Serif', Georgia, serif;
        }

        .nav-link {
          color: #94a3b8;
          text-decoration: none;
          font-size: 15px;
          font-weight: 500;
          transition: color 0.2s;
        }
        .nav-link:hover { color: #f1f5f9; }

        .btn-primary {
          background: #fbbf24;
          color: #0f172a;
          border: none;
          padding: 14px 28px;
          border-radius: 100px;
          font-size: 15px;
          font-weight: 600;
          cursor: pointer;
          transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
          text-decoration: none;
          display: inline-block;
        }
        .btn-primary:hover {
          background: #f59e0b;
          transform: translateY(-2px);
          box-shadow: 0 10px 40px rgba(251, 191, 36, 0.25);
        }

        .btn-secondary {
          background: transparent;
          color: #f1f5f9;
          border: 1.5px solid #334155;
          padding: 14px 28px;
          border-radius: 100px;
          font-size: 15px;
          font-weight: 500;
          cursor: pointer;
          transition: all 0.2s;
          text-decoration: none;
          display: inline-block;
        }
        .btn-secondary:hover {
          border-color: #64748b;
          background: rgba(255,255,255,0.05);
        }

        .slider {
          -webkit-appearance: none;
          width: 100%;
          height: 8px;
          border-radius: 4px;
          background: #334155;
          outline: none;
        }
        .slider::-webkit-slider-thumb {
          -webkit-appearance: none;
          appearance: none;
          width: 24px;
          height: 24px;
          border-radius: 50%;
          background: #fbbf24;
          cursor: pointer;
          box-shadow: 0 2px 10px rgba(251, 191, 36, 0.3);
          transition: transform 0.2s;
        }
        .slider::-webkit-slider-thumb:hover {
          transform: scale(1.1);
        }
        .slider::-moz-range-thumb {
          width: 24px;
          height: 24px;
          border-radius: 50%;
          background: #fbbf24;
          cursor: pointer;
          border: none;
        }

        .pricing-card {
          transition: all 0.3s;
        }
        .pricing-card:hover {
          transform: translateY(-4px);
        }

        .feature-check {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 12px 0;
          border-bottom: 1px solid #1e293b;
        }
        .feature-check:last-child {
          border-bottom: none;
        }

        /* Mobile responsiveness */
        @media (max-width: 900px) {
          .pricing-grid {
            grid-template-columns: 1fr !important;
          }
          .comparison-grid {
            grid-template-columns: 1fr !important;
          }
          .nav-links {
            display: none !important;
          }
          .hero-title {
            font-size: 36px !important;
          }
          .section-title {
            font-size: 32px !important;
          }
          .pricing-section {
            padding: 0 24px 60px !important;
          }
          .comparison-section {
            padding: 60px 24px !important;
          }
          .faq-section {
            padding: 60px 24px !important;
          }
          .cta-section {
            padding: 60px 24px !important;
          }
          .footer-content {
            flex-direction: column !important;
            gap: 16px !important;
            text-align: center !important;
          }
        }
      `}</style>

      {/* Subtle grid pattern */}
      <div style={{
        position: 'fixed',
        inset: 0,
        backgroundImage: `
          linear-gradient(rgba(255,255,255,0.02) 1px, transparent 1px),
          linear-gradient(90deg, rgba(255,255,255,0.02) 1px, transparent 1px)
        `,
        backgroundSize: '60px 60px',
        pointerEvents: 'none',
      }} />

      {/* Navigation */}
      <nav style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '24px 48px',
        position: 'relative',
        zIndex: 100,
      }}>
        <Link href="/" style={{ display: 'flex', alignItems: 'center', gap: '10px', textDecoration: 'none', color: 'inherit' }}>
          <div style={{
            width: '36px',
            height: '36px',
            background: '#fbbf24',
            borderRadius: '10px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#0f172a" strokeWidth="2.5" strokeLinecap="round">
              <rect x="2" y="3" width="20" height="14" rx="2"/>
              <path d="M8 21h8M12 17v4"/>
            </svg>
          </div>
          <span style={{ fontSize: '20px', fontWeight: 600, letterSpacing: '-0.5px' }}>ClassPilot</span>
        </Link>

        <div className="nav-links" style={{ display: 'flex', alignItems: 'center', gap: '40px' }}>
          <Link href="/#features" className="nav-link">Features</Link>
          <Link href="/#how" className="nav-link">How it works</Link>
          <span className="nav-link" style={{ color: '#fbbf24' }}>Pricing</span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <Link href="/login" className="nav-link">Sign in</Link>
          <Link href="/request-trial" className="btn-primary">Start Free Trial</Link>
        </div>
      </nav>

      {/* Hero */}
      <section style={{
        textAlign: 'center',
        padding: '80px 48px 60px',
        position: 'relative',
        zIndex: 10,
      }}>
        <div style={{
          display: 'inline-block',
          background: 'rgba(34, 197, 94, 0.1)',
          color: '#22c55e',
          padding: '8px 16px',
          borderRadius: '100px',
          fontSize: '13px',
          fontWeight: 600,
          marginBottom: '24px',
          border: '1px solid rgba(34, 197, 94, 0.2)',
        }}>
          TRANSPARENT PRICING · NO SALES CALLS
        </div>

        <h1 className="serif hero-title" style={{
          fontSize: '56px',
          fontWeight: 400,
          margin: '0 0 20px 0',
          letterSpacing: '-1px',
        }}>
          Simple pricing that{' '}
          <span style={{ fontStyle: 'italic', color: '#fbbf24' }}>scales with you</span>
        </h1>

        <p style={{
          fontSize: '18px',
          color: '#94a3b8',
          maxWidth: '600px',
          margin: '0 auto',
          lineHeight: 1.7,
        }}>
          One plan. All features included. No per-teacher fees, no hidden costs, no surprise invoices. Just straightforward pricing based on your student count.
        </p>
      </section>

      {/* Pricing Calculator */}
      <section className="pricing-section" style={{
        padding: '0 48px 100px',
        position: 'relative',
        zIndex: 10,
      }}>
        <div className="pricing-grid" style={{
          maxWidth: '1100px',
          margin: '0 auto',
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: '40px',
        }}>
          {/* Left: Calculator */}
          <div className="pricing-card" style={{
            background: '#1e293b',
            borderRadius: '24px',
            padding: '48px',
            border: '1px solid #334155',
          }}>
            <div style={{ marginBottom: '40px' }}>
              <div style={{
                fontSize: '13px',
                fontWeight: 600,
                color: '#fbbf24',
                letterSpacing: '1px',
                marginBottom: '12px',
              }}>
                CALCULATE YOUR PRICE
              </div>
              <h2 style={{
                fontSize: '28px',
                fontWeight: 600,
                margin: 0,
                letterSpacing: '-0.5px',
              }}>
                How many students?
              </h2>
            </div>

            {/* Slider */}
            <div style={{ marginBottom: '40px' }}>
              <div style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'baseline',
                marginBottom: '16px',
              }}>
                <span style={{ fontSize: '48px', fontWeight: 700, color: '#fbbf24' }}>
                  {studentCount.toLocaleString()}
                </span>
                <span style={{ fontSize: '15px', color: '#64748b' }}>students</span>
              </div>
              <input
                type="range"
                min="50"
                max="5000"
                step="50"
                value={studentCount}
                onChange={(e) => setStudentCount(parseInt(e.target.value))}
                className="slider"
              />
              <div style={{
                display: 'flex',
                justifyContent: 'space-between',
                marginTop: '8px',
                fontSize: '13px',
                color: '#64748b',
              }}>
                <span>50</span>
                <span>5,000+</span>
              </div>
            </div>

            {/* Price breakdown */}
            <div style={{
              background: '#0f172a',
              borderRadius: '16px',
              padding: '24px',
              marginBottom: '32px',
            }}>
              <div style={{
                display: 'flex',
                justifyContent: 'space-between',
                marginBottom: '12px',
                fontSize: '15px',
              }}>
                <span style={{ color: '#94a3b8' }}>Base platform fee</span>
                <span>${basePrice}</span>
              </div>
              <div style={{
                display: 'flex',
                justifyContent: 'space-between',
                marginBottom: '16px',
                paddingBottom: '16px',
                borderBottom: '1px solid #334155',
                fontSize: '15px',
              }}>
                <span style={{ color: '#94a3b8' }}>{studentCount.toLocaleString()} students × ${perStudent}</span>
                <span>${(studentCount * perStudent).toLocaleString()}</span>
              </div>
              <div style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'baseline',
              }}>
                <span style={{ fontSize: '15px', color: '#94a3b8' }}>Annual total</span>
                <div style={{ textAlign: 'right' }}>
                  <span style={{ fontSize: '36px', fontWeight: 700 }}>${annualTotal.toLocaleString()}</span>
                  <span style={{ fontSize: '15px', color: '#64748b' }}>/year</span>
                </div>
              </div>
              <div style={{
                textAlign: 'right',
                fontSize: '14px',
                color: '#64748b',
                marginTop: '4px',
              }}>
                That's ${monthlyEquivalent}/month
              </div>
            </div>

            <Link href="/request-trial" className="btn-primary" style={{ width: '100%', padding: '18px', textAlign: 'center' }}>
              Start 30-Day Free Trial →
            </Link>

            <div style={{
              display: 'flex',
              justifyContent: 'center',
              gap: '24px',
              marginTop: '20px',
              fontSize: '13px',
              color: '#64748b',
              flexWrap: 'wrap',
            }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2">
                  <polyline points="20 6 9 17 4 12"/>
                </svg>
                No credit card
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2">
                  <polyline points="20 6 9 17 4 12"/>
                </svg>
                No sales call
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2">
                  <polyline points="20 6 9 17 4 12"/>
                </svg>
                Cancel anytime
              </span>
            </div>
          </div>

          {/* Right: What's included + Skip trial */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
            {/* What's included */}
            <div className="pricing-card" style={{
              background: '#1e293b',
              borderRadius: '24px',
              padding: '36px',
              border: '1px solid #334155',
              flex: 1,
            }}>
              <div style={{
                fontSize: '13px',
                fontWeight: 600,
                color: '#fbbf24',
                letterSpacing: '1px',
                marginBottom: '12px',
              }}>
                EVERYTHING INCLUDED
              </div>
              <h3 style={{
                fontSize: '22px',
                fontWeight: 600,
                margin: '0 0 24px 0',
              }}>
                One plan, all features
              </h3>

              <div>
                {[
                  'Live screen monitoring',
                  'Smart off-task alerts',
                  'Google Classroom sync',
                  'Unlimited teachers',
                  'Chrome extension',
                  'Usage reports & analytics',
                  'Privacy scheduling',
                  'FERPA compliant',
                  'Priority email support',
                ].map((feature, i) => (
                  <div key={i} className="feature-check">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2.5">
                      <polyline points="20 6 9 17 4 12"/>
                    </svg>
                    <span style={{ fontSize: '15px', color: '#e2e8f0' }}>{feature}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Skip trial offer */}
            <div className="pricing-card" style={{
              background: 'linear-gradient(135deg, rgba(251, 191, 36, 0.1) 0%, rgba(251, 191, 36, 0.05) 100%)',
              borderRadius: '24px',
              padding: '32px',
              border: '1px solid rgba(251, 191, 36, 0.2)',
            }}>
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                marginBottom: '12px',
              }}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fbbf24" strokeWidth="2">
                  <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
                </svg>
                <span style={{ fontSize: '13px', fontWeight: 600, color: '#fbbf24', letterSpacing: '1px' }}>
                  READY TO COMMIT?
                </span>
              </div>
              <h3 style={{
                fontSize: '20px',
                fontWeight: 600,
                margin: '0 0 8px 0',
              }}>
                Skip the trial, save on year one
              </h3>
              <p style={{
                fontSize: '14px',
                color: '#94a3b8',
                margin: '0 0 16px 0',
                lineHeight: 1.6,
              }}>
                Commit to an annual plan today and get your <strong style={{ color: '#f8fafc' }}>first 2 months free</strong> — pay just <strong style={{ color: '#f8fafc' }}>${skipTrialPrice.toLocaleString()}</strong> for year one.
              </p>
              <div style={{
                fontSize: '12px',
                color: '#64748b',
                marginBottom: '16px',
              }}>
                Renews at ${annualTotal.toLocaleString()}/year
              </div>
              <a
                href="mailto:info@school-pilot.net?subject=Skip%20Trial%20Offer%20-%20ClassPilot&body=Hi%2C%0A%0AI'm%20interested%20in%20the%20skip%20trial%20offer%20for%20ClassPilot.%0A%0ASchool%20Name%3A%20%0ANumber%20of%20Students%3A%20%0A%0APlease%20contact%20me%20with%20more%20information.%0A%0AThank%20you!"
                className="btn-secondary"
                style={{
                  width: '100%',
                  borderColor: 'rgba(251, 191, 36, 0.3)',
                  color: '#fbbf24',
                  textAlign: 'center',
                }}
              >
                Contact Us to Claim Offer
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* Comparison section */}
      <section className="comparison-section" style={{
        padding: '100px 48px',
        background: '#1e293b',
      }}>
        <div style={{ maxWidth: '900px', margin: '0 auto' }}>
          <div style={{ textAlign: 'center', marginBottom: '60px' }}>
            <div style={{
              fontSize: '13px',
              fontWeight: 600,
              color: '#fbbf24',
              letterSpacing: '1px',
              marginBottom: '12px',
            }}>
              WHY CLASSPILOT
            </div>
            <h2 className="serif section-title" style={{
              fontSize: '40px',
              fontWeight: 400,
              margin: 0,
            }}>
              A better way to buy
            </h2>
          </div>

          <div className="comparison-grid" style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, 1fr)',
            gap: '32px',
          }}>
            {[
              {
                icon: (
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#fbbf24" strokeWidth="1.5">
                    <circle cx="12" cy="12" r="10"/>
                    <path d="M12 6v6l4 2"/>
                  </svg>
                ),
                title: 'Start in minutes',
                desc: 'Sign up with Google, sync your classes, and start monitoring. No waiting for sales calls or demos.',
              },
              {
                icon: (
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#fbbf24" strokeWidth="1.5">
                    <rect x="2" y="3" width="20" height="14" rx="2"/>
                    <path d="M12 17v4M8 21h8"/>
                  </svg>
                ),
                title: 'Transparent pricing',
                desc: 'See your exact cost upfront. No hidden fees, no surprise invoices, no "contact us for pricing."',
              },
              {
                icon: (
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#fbbf24" strokeWidth="1.5">
                    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
                    <circle cx="9" cy="7" r="4"/>
                    <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
                    <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
                  </svg>
                ),
                title: 'Unlimited teachers',
                desc: 'Unlike per-teacher pricing, every educator in your school can use ClassPilot at no extra cost.',
              },
            ].map((item, i) => (
              <div key={i} style={{
                background: '#0f172a',
                borderRadius: '20px',
                padding: '32px',
                border: '1px solid #334155',
              }}>
                <div style={{
                  width: '56px',
                  height: '56px',
                  background: 'rgba(251, 191, 36, 0.1)',
                  borderRadius: '14px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  marginBottom: '20px',
                }}>
                  {item.icon}
                </div>
                <h3 style={{
                  fontSize: '18px',
                  fontWeight: 600,
                  margin: '0 0 10px 0',
                }}>{item.title}</h3>
                <p style={{
                  fontSize: '14px',
                  color: '#94a3b8',
                  margin: 0,
                  lineHeight: 1.6,
                }}>{item.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section className="faq-section" style={{
        padding: '100px 48px',
        background: '#0f172a',
      }}>
        <div style={{ maxWidth: '700px', margin: '0 auto' }}>
          <div style={{ textAlign: 'center', marginBottom: '60px' }}>
            <h2 className="serif section-title" style={{
              fontSize: '40px',
              fontWeight: 400,
              margin: 0,
            }}>
              Questions?
            </h2>
          </div>

          {[
            {
              q: 'What counts as a "student"?',
              a: 'Any student account that has the ClassPilot Chrome extension installed. If a student uses multiple devices, they still count as one student.',
            },
            {
              q: 'Are there any limits on teachers?',
              a: 'No. Every teacher in your school can use ClassPilot at no additional cost. We don\'t charge per-teacher fees.',
            },
            {
              q: 'What happens after the free trial?',
              a: 'If you decide ClassPilot is right for your school, you\'ll enter payment details and your subscription begins. If not, no worries — your account simply expires. We\'ll never charge you without your explicit approval.',
            },
            {
              q: 'Can I change my student count mid-year?',
              a: 'Yes. If your enrollment changes, reach out and we\'ll pro-rate your subscription accordingly.',
            },
            {
              q: 'Do you offer discounts for large districts?',
              a: 'Yes. Districts with 5,000+ students can contact us for volume pricing. We also offer multi-year discounts.',
            },
            {
              q: 'Is there a contract or commitment?',
              a: 'Annual plans are paid upfront for the year. You can cancel anytime, but we don\'t offer refunds for partial years.',
            },
          ].map((item, i) => (
            <div key={i} style={{
              padding: '24px 0',
              borderBottom: i < 5 ? '1px solid #1e293b' : 'none',
            }}>
              <h3 style={{
                fontSize: '17px',
                fontWeight: 600,
                margin: '0 0 10px 0',
              }}>{item.q}</h3>
              <p style={{
                fontSize: '15px',
                color: '#94a3b8',
                margin: 0,
                lineHeight: 1.7,
              }}>{item.a}</p>
            </div>
          ))}
        </div>
      </section>

      {/* CTA */}
      <section className="cta-section" style={{
        padding: '100px 48px',
        background: 'linear-gradient(135deg, #fbbf24 0%, #f59e0b 100%)',
        textAlign: 'center',
      }}>
        <h2 className="serif section-title" style={{
          fontSize: '48px',
          fontWeight: 400,
          margin: '0 0 20px 0',
          color: '#0f172a',
        }}>
          Ready to try ClassPilot?
        </h2>
        <p style={{
          fontSize: '18px',
          color: '#78350f',
          maxWidth: '500px',
          margin: '0 auto 32px',
        }}>
          Start your free 30-day trial. No credit card, no sales pitch, no commitment.
        </p>
        <Link href="/request-trial" style={{
          background: '#0f172a',
          color: '#fbbf24',
          border: 'none',
          padding: '18px 40px',
          borderRadius: '100px',
          fontSize: '16px',
          fontWeight: 600,
          cursor: 'pointer',
          textDecoration: 'none',
          display: 'inline-block',
        }}>
          Start Free Trial →
        </Link>
      </section>

      {/* Footer */}
      <footer style={{
        background: '#020617',
        color: 'white',
        padding: '60px 48px 40px',
      }}>
        <div className="footer-content" style={{
          maxWidth: '1200px',
          margin: '0 auto',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}>
          <Link href="/" style={{ display: 'flex', alignItems: 'center', gap: '10px', textDecoration: 'none', color: 'inherit' }}>
            <div style={{
              width: '32px',
              height: '32px',
              background: '#fbbf24',
              borderRadius: '8px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#0f172a" strokeWidth="2.5">
                <rect x="2" y="3" width="20" height="14" rx="2"/>
                <path d="M8 21h8M12 17v4"/>
              </svg>
            </div>
            <span style={{ fontSize: '18px', fontWeight: 600 }}>ClassPilot</span>
          </Link>

          <div style={{ fontSize: '14px', color: '#64748b' }}>
            Questions? Email us at <a href="mailto:info@school-pilot.net" style={{ color: '#fbbf24', textDecoration: 'none' }}>info@school-pilot.net</a>
          </div>

          <div style={{ fontSize: '14px', color: '#475569' }}>
            © 2025 ClassPilot
          </div>
        </div>
      </footer>
    </div>
  );
}
