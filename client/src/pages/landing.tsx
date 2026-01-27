import { useState, useEffect } from 'react';
import { Link } from "wouter";

export default function LandingPage() {
  const [loaded, setLoaded] = useState(false);
  const [activeFeature, setActiveFeature] = useState(0);
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });

  useEffect(() => {
    setLoaded(true);
    const handleMouse = (e: MouseEvent) => {
      setMousePos({ x: e.clientX, y: e.clientY });
    };
    window.addEventListener('mousemove', handleMouse);
    return () => window.removeEventListener('mousemove', handleMouse);
  }, []);

  const students = [
    { name: 'Student 1', initials: 'AJ', status: 'on-task', site: 'Google Docs', color: '#22c55e' },
    { name: 'Student 2', initials: 'BK', status: 'on-task', site: 'Khan Academy', color: '#22c55e' },
    { name: 'Student 3', initials: 'CM', status: 'warning', site: 'YouTube', color: '#eab308' },
    { name: 'Student 4', initials: 'DN', status: 'on-task', site: 'Google Slides', color: '#22c55e' },
    { name: 'Student 5', initials: 'EP', status: 'on-task', site: 'Desmos', color: '#22c55e' },
    { name: 'Student 6', initials: 'FQ', status: 'off-task', site: 'Reddit', color: '#ef4444' },
  ];

  const features = [
    {
      title: 'Live Screen View',
      desc: 'See every student screen in real-time. Click to expand. Instant visibility across your entire classroom.',
      icon: (
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <rect x="2" y="3" width="20" height="14" rx="2"/>
          <path d="M8 21h8M12 17v4"/>
        </svg>
      ),
    },
    {
      title: 'Smart Alerts',
      desc: 'Get notified when students go off-task. Automatic detection of non-educational sites during class time.',
      icon: (
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
          <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
        </svg>
      ),
    },
    {
      title: 'Google Classroom Sync',
      desc: 'Import your rosters automatically. Classes, students, and groups sync with zero manual setup.',
      icon: (
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
          <circle cx="9" cy="7" r="4"/>
          <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
          <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
        </svg>
      ),
    },
    {
      title: 'Privacy-First Design',
      desc: 'Monitoring only during school hours. Automatic privacy mode respects student time outside class.',
      icon: (
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
          <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
        </svg>
      ),
    },
  ];

  const steps = [
    { num: '01', title: 'Create Account', desc: 'Sign up with Google. Your Classroom rosters sync automatically.' },
    { num: '02', title: 'Deploy Extension', desc: 'School Admin deploys the Chrome extension via Google Workspace for Education.' },
    { num: '03', title: 'Start Teaching', desc: 'Open dashboard. See every screen. Keep everyone on track.' },
  ];

  return (
    <div style={{
      minHeight: '100vh',
      background: '#0f172a',
      fontFamily: "'Inter', -apple-system, sans-serif",
      color: '#f1f5f9',
      overflow: 'hidden',
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Instrument+Serif:ital@0;1&display=swap');

        * { box-sizing: border-box; }

        @keyframes fadeUp {
          from { opacity: 0; transform: translateY(40px); }
          to { opacity: 1; transform: translateY(0); }
        }

        @keyframes fadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }

        @keyframes float {
          0%, 100% { transform: translateY(0) rotate(0deg); }
          50% { transform: translateY(-8px) rotate(1deg); }
        }

        @keyframes pulse-ring {
          0% { transform: scale(1); opacity: 1; }
          100% { transform: scale(1.5); opacity: 0; }
        }

        .loaded .fade-1 { animation: fadeUp 1s cubic-bezier(0.16, 1, 0.3, 1) forwards; }
        .loaded .fade-2 { animation: fadeUp 1s cubic-bezier(0.16, 1, 0.3, 1) 0.1s forwards; opacity: 0; }
        .loaded .fade-3 { animation: fadeUp 1s cubic-bezier(0.16, 1, 0.3, 1) 0.2s forwards; opacity: 0; }
        .loaded .fade-4 { animation: fadeUp 1s cubic-bezier(0.16, 1, 0.3, 1) 0.3s forwards; opacity: 0; }
        .loaded .fade-5 { animation: fadeIn 1.2s cubic-bezier(0.16, 1, 0.3, 1) 0.5s forwards; opacity: 0; }

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

        .feature-card {
          cursor: pointer;
          transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
        }
        .feature-card:hover {
          transform: translateX(8px);
        }

        .student-card {
          transition: all 0.2s;
        }
        .student-card:hover {
          transform: scale(1.03);
        }

        .serif {
          font-family: 'Instrument Serif', Georgia, serif;
        }

        .step-card {
          transition: all 0.3s;
        }
        .step-card:hover {
          transform: translateY(-4px);
        }

        @media (max-width: 768px) {
          .hero-grid {
            grid-template-columns: 1fr !important;
            gap: 40px !important;
          }
          .hero-title {
            font-size: 48px !important;
          }
          .nav-links {
            display: none !important;
          }
          .features-grid {
            grid-template-columns: 1fr !important;
          }
          .steps-grid {
            grid-template-columns: 1fr !important;
          }
          .footer-grid {
            grid-template-columns: 1fr !important;
            gap: 32px !important;
          }
        }
      `}</style>

      {/* Subtle gradient follow */}
      <div style={{
        position: 'fixed',
        inset: 0,
        backgroundImage: `radial-gradient(circle at ${mousePos.x}px ${mousePos.y}px, rgba(251, 191, 36, 0.04) 0%, transparent 50%)`,
        pointerEvents: 'none',
        transition: 'background 0.3s',
      }} />

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
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
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
        </div>

        <div className="nav-links" style={{ display: 'flex', alignItems: 'center', gap: '40px' }}>
          <a href="#features" className="nav-link">Features</a>
          <a href="#how" className="nav-link">How it works</a>
          <Link href="/pricing" className="nav-link">Pricing</Link>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <Link href="/login" className="nav-link">Sign in</Link>
          <Link href="/request-trial" className="btn-primary">Start Free Trial</Link>
        </div>
      </nav>

      {/* Hero Section */}
      <section className={loaded ? 'loaded' : ''} style={{
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        minHeight: 'calc(100vh - 100px)',
        padding: '0 48px 80px',
        gap: '80px',
        alignItems: 'center',
      }} >
        {/* Left: Copy */}
        <div style={{ maxWidth: '560px' }}>
          <div className="fade-1" style={{
            display: 'inline-block',
            background: 'rgba(251, 191, 36, 0.1)',
            color: '#fbbf24',
            padding: '8px 16px',
            borderRadius: '100px',
            fontSize: '13px',
            fontWeight: 600,
            marginBottom: '32px',
            letterSpacing: '0.5px',
            border: '1px solid rgba(251, 191, 36, 0.2)',
          }}>
            FERPA COMPLIANT · PRIVACY-FIRST
          </div>

          <h1 className="fade-2 serif hero-title" style={{
            fontSize: '72px',
            fontWeight: 400,
            lineHeight: 1.05,
            margin: '0 0 28px 0',
            letterSpacing: '-2px',
            color: '#f8fafc',
          }}>
            See every screen,{' '}
            <span style={{ fontStyle: 'italic', color: '#fbbf24' }}>keep every student</span>{' '}
            focused
          </h1>

          <p className="fade-3" style={{
            fontSize: '18px',
            lineHeight: 1.7,
            color: '#94a3b8',
            margin: '0 0 40px 0',
          }}>
            Real-time classroom monitoring built for education. Know what your students are doing on their devices — and gently guide them back when they drift.
          </p>

          <div className="fade-4" style={{ display: 'flex', gap: '16px', marginBottom: '48px', flexWrap: 'wrap' }}>
            <Link href="/request-trial" className="btn-primary" style={{ padding: '18px 36px', fontSize: '16px' }}>
              Start Free Trial →
            </Link>
            <Link href="/pricing" className="btn-secondary" style={{ padding: '18px 36px', fontSize: '16px' }}>
              View Pricing
            </Link>
          </div>

          <div className="fade-4" style={{
            display: 'flex',
            gap: '40px',
            paddingTop: '32px',
            borderTop: '1px solid #1e293b',
            flexWrap: 'wrap',
          }}>
            <div>
              <div style={{ fontSize: '28px', fontWeight: 600, letterSpacing: '-1px', color: '#f8fafc' }}>30 days</div>
              <div style={{ fontSize: '14px', color: '#64748b' }}>free trial</div>
            </div>
            <div>
              <div style={{ fontSize: '28px', fontWeight: 600, letterSpacing: '-1px', color: '#f8fafc' }}>10 min</div>
              <div style={{ fontSize: '14px', color: '#64748b' }}>setup time</div>
            </div>
            <div>
              <div style={{ fontSize: '28px', fontWeight: 600, letterSpacing: '-1px', color: '#f8fafc' }}>$0</div>
              <div style={{ fontSize: '14px', color: '#64748b' }}>to get started</div>
            </div>
          </div>
        </div>

        {/* Right: Product Preview */}
        <div className="fade-5" style={{
          position: 'relative',
          perspective: '1000px',
        }}>
          {/* Main dashboard card */}
          <div style={{
            background: '#1e293b',
            borderRadius: '24px',
            boxShadow: '0 0 0 1px rgba(255,255,255,0.05), 0 40px 80px rgba(0,0,0,0.4)',
            overflow: 'hidden',
            transform: 'rotateY(-5deg) rotateX(2deg)',
            animation: 'float 6s ease-in-out infinite',
          }}>
            {/* Dashboard header */}
            <div style={{
              padding: '20px 24px',
              borderBottom: '1px solid #334155',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <div style={{
                  width: '10px',
                  height: '10px',
                  background: '#22c55e',
                  borderRadius: '50%',
                  position: 'relative',
                }}>
                  <div style={{
                    position: 'absolute',
                    inset: '-4px',
                    border: '2px solid #22c55e',
                    borderRadius: '50%',
                    animation: 'pulse-ring 2s infinite',
                  }} />
                </div>
                <span style={{ fontSize: '14px', fontWeight: 600, color: '#f1f5f9' }}>Live — Period 3</span>
                <span style={{ fontSize: '13px', color: '#64748b' }}>Algebra II</span>
              </div>
              <div style={{ fontSize: '13px', color: '#64748b' }}>24 students</div>
            </div>

            {/* Student grid */}
            <div style={{
              padding: '20px',
              display: 'grid',
              gridTemplateColumns: 'repeat(3, 1fr)',
              gap: '12px',
            }}>
              {students.map((student, i) => (
                <div key={i} className="student-card" style={{
                  background: '#0f172a',
                  borderRadius: '12px',
                  padding: '12px',
                  border: `1px solid ${student.status === 'off-task' ? 'rgba(239, 68, 68, 0.3)' : student.status === 'warning' ? 'rgba(234, 179, 8, 0.3)' : '#1e293b'}`,
                }}>
                  <div style={{
                    aspectRatio: '16/10',
                    background: student.status === 'off-task'
                      ? 'linear-gradient(135deg, rgba(239, 68, 68, 0.1) 0%, rgba(239, 68, 68, 0.05) 100%)'
                      : student.status === 'warning'
                      ? '#ef4444'
                      : 'linear-gradient(135deg, #334155 0%, #1e293b 100%)',
                    borderRadius: '8px',
                    marginBottom: '10px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    overflow: 'hidden',
                    position: 'relative',
                  }}>
                    {student.status === 'off-task' && (
                      <span style={{ fontSize: '10px', color: '#ef4444', fontWeight: 500 }}>Off-task</span>
                    )}
                    {student.status === 'warning' && (
                      <div style={{
                        width: '40px',
                        height: '28px',
                        background: 'white',
                        borderRadius: '6px',
                      }} />
                    )}
                    {student.status === 'on-task' && (
                      <div style={{ padding: '8px', width: '100%' }}>
                        <div style={{ height: '6px', background: '#475569', borderRadius: '3px', marginBottom: '4px', width: '70%' }} />
                        <div style={{ height: '4px', background: '#334155', borderRadius: '2px', width: '90%' }} />
                      </div>
                    )}
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <div style={{
                        width: '24px',
                        height: '24px',
                        background: '#334155',
                        borderRadius: '6px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: '10px',
                        fontWeight: 600,
                        color: '#94a3b8',
                      }}>{student.initials}</div>
                      <span style={{ fontSize: '12px', color: '#94a3b8' }}>{student.site}</span>
                    </div>
                    <div style={{
                      width: '8px',
                      height: '8px',
                      borderRadius: '50%',
                      background: student.color,
                    }} />
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Floating alert card */}
          <div style={{
            position: 'absolute',
            bottom: '40px',
            left: '-60px',
            background: '#1e293b',
            borderRadius: '16px',
            padding: '16px 20px',
            boxShadow: '0 20px 60px rgba(0,0,0,0.4)',
            display: 'flex',
            alignItems: 'center',
            gap: '14px',
            animation: 'float 5s ease-in-out infinite',
            animationDelay: '-2s',
            border: '1px solid rgba(239, 68, 68, 0.3)',
          }}>
            <div style={{
              width: '40px',
              height: '40px',
              background: 'rgba(239, 68, 68, 0.1)',
              borderRadius: '10px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2">
                <circle cx="12" cy="12" r="10"/>
                <line x1="12" y1="8" x2="12" y2="12"/>
                <line x1="12" y1="16" x2="12.01" y2="16"/>
              </svg>
            </div>
            <div>
              <div style={{ fontSize: '14px', fontWeight: 600, color: '#f1f5f9' }}>Off-task detected</div>
              <div style={{ fontSize: '12px', color: '#64748b' }}>Student 6 · Reddit</div>
            </div>
          </div>

          {/* Stats badge */}
          <div style={{
            position: 'absolute',
            top: '40px',
            right: '-40px',
            background: '#fbbf24',
            color: '#0f172a',
            borderRadius: '12px',
            padding: '14px 20px',
            boxShadow: '0 20px 60px rgba(251, 191, 36, 0.2)',
            animation: 'float 4s ease-in-out infinite',
            animationDelay: '-1s',
          }}>
            <div style={{ fontSize: '24px', fontWeight: 600 }}>92%</div>
            <div style={{ fontSize: '12px', opacity: 0.7 }}>on-task rate</div>
          </div>
        </div>
      </section>

      {/* Features Section */}
      <section id="features" style={{
        background: '#1e293b',
        padding: '120px 48px',
      }}>
        <div style={{
          maxWidth: '1200px',
          margin: '0 auto',
          display: 'grid',
          gridTemplateColumns: '1fr 1.2fr',
          gap: '100px',
          alignItems: 'center',
        }} className="features-grid">
          {/* Left: Feature list */}
          <div>
            <div style={{
              fontSize: '13px',
              fontWeight: 600,
              color: '#fbbf24',
              letterSpacing: '1px',
              marginBottom: '20px',
            }}>FEATURES</div>
            <h2 className="serif" style={{
              fontSize: '48px',
              fontWeight: 400,
              lineHeight: 1.15,
              margin: '0 0 48px 0',
              letterSpacing: '-1px',
              color: '#f8fafc',
            }}>
              Everything you need,{' '}
              <span style={{ fontStyle: 'italic', color: '#94a3b8' }}>nothing you don't</span>
            </h2>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {features.map((feature, i) => (
                <div
                  key={i}
                  className="feature-card"
                  onClick={() => setActiveFeature(i)}
                  style={{
                    padding: '20px 24px',
                    borderRadius: '16px',
                    background: activeFeature === i ? 'rgba(251, 191, 36, 0.05)' : 'transparent',
                    border: `1px solid ${activeFeature === i ? 'rgba(251, 191, 36, 0.2)' : 'transparent'}`,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginBottom: activeFeature === i ? '12px' : 0 }}>
                    <div style={{ color: activeFeature === i ? '#fbbf24' : '#64748b' }}>
                      {feature.icon}
                    </div>
                    <span style={{
                      fontSize: '18px',
                      fontWeight: 500,
                      color: activeFeature === i ? '#f8fafc' : '#94a3b8',
                    }}>{feature.title}</span>
                  </div>
                  {activeFeature === i && (
                    <p style={{
                      fontSize: '15px',
                      color: '#94a3b8',
                      margin: 0,
                      paddingLeft: '44px',
                      lineHeight: 1.6,
                    }}>{feature.desc}</p>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Right: Feature visual */}
          <div style={{
            background: '#0f172a',
            borderRadius: '24px',
            padding: '40px',
            border: '1px solid #334155',
          }}>
            {activeFeature === 0 && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '12px' }}>
                {[
                  { initials: 'AJ', status: 'on-task', site: 'Google Docs' },
                  { initials: 'BK', status: 'on-task', site: 'Khan Academy' },
                  { initials: 'CM', status: 'warning', site: 'YouTube' },
                  { initials: 'DN', status: 'on-task', site: 'Desmos' },
                  { initials: 'EP', status: 'off-task', site: 'Reddit' },
                  { initials: 'FQ', status: 'on-task', site: 'Google Slides' },
                  { initials: 'GR', status: 'on-task', site: 'Canva' },
                  { initials: 'HS', status: 'on-task', site: 'Google Docs' },
                  { initials: 'IT', status: 'on-task', site: 'Quizlet' },
                ].map((student, i) => (
                  <div key={i} style={{
                    background: '#1e293b',
                    borderRadius: '10px',
                    padding: '10px',
                    border: `1px solid ${student.status === 'off-task' ? 'rgba(239, 68, 68, 0.4)' : student.status === 'warning' ? 'rgba(234, 179, 8, 0.4)' : '#334155'}`,
                  }}>
                    <div style={{
                      aspectRatio: '16/10',
                      background: student.status === 'off-task'
                        ? 'linear-gradient(135deg, rgba(239, 68, 68, 0.15) 0%, rgba(239, 68, 68, 0.05) 100%)'
                        : student.status === 'warning'
                        ? '#ef4444'
                        : 'linear-gradient(135deg, #334155 0%, #1e293b 100%)',
                      borderRadius: '6px',
                      marginBottom: '8px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      overflow: 'hidden',
                    }}>
                      {student.status === 'off-task' && (
                        <span style={{ fontSize: '9px', color: '#ef4444', fontWeight: 600 }}>OFF-TASK</span>
                      )}
                      {student.status === 'warning' && (
                        <div style={{
                          width: '32px',
                          height: '22px',
                          background: 'white',
                          borderRadius: '4px',
                        }} />
                      )}
                      {student.status === 'on-task' && (
                        <div style={{ padding: '6px', width: '100%' }}>
                          <div style={{ height: '4px', background: '#475569', borderRadius: '2px', marginBottom: '3px', width: '65%' }} />
                          <div style={{ height: '3px', background: '#334155', borderRadius: '2px', width: '85%' }} />
                        </div>
                      )}
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <div style={{
                          width: '18px',
                          height: '18px',
                          background: '#334155',
                          borderRadius: '4px',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          fontSize: '8px',
                          fontWeight: 600,
                          color: '#94a3b8',
                        }}>{student.initials}</div>
                        <span style={{ fontSize: '9px', color: '#64748b' }}>{student.site}</span>
                      </div>
                      <div style={{
                        width: '6px',
                        height: '6px',
                        borderRadius: '50%',
                        background: student.status === 'off-task' ? '#ef4444' : student.status === 'warning' ? '#eab308' : '#22c55e',
                      }} />
                    </div>
                  </div>
                ))}
              </div>
            )}
            {activeFeature === 1 && (
              <div style={{ textAlign: 'center', padding: '60px 0' }}>
                <div style={{
                  width: '80px',
                  height: '80px',
                  background: 'rgba(239, 68, 68, 0.1)',
                  borderRadius: '20px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  margin: '0 auto 24px',
                }}>
                  <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="1.5">
                    <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
                    <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
                  </svg>
                </div>
                <div style={{ fontSize: '20px', fontWeight: 500, marginBottom: '8px', color: '#f8fafc' }}>Off-task Alert</div>
                <div style={{ fontSize: '15px', color: '#64748b' }}>Student browsing non-educational site</div>
              </div>
            )}
            {activeFeature === 2 && (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '40px 0', gap: '40px', flexWrap: 'wrap' }}>
                <div style={{
                  width: '80px',
                  height: '80px',
                  background: '#1e293b',
                  borderRadius: '16px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  border: '1px solid #334155',
                }}>
                  <svg width="40" height="40" viewBox="0 0 24 24" fill="none">
                    <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
                    <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                    <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
                    <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
                  </svg>
                </div>
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#fbbf24" strokeWidth="1.5">
                  <path d="M5 12h14M12 5l7 7-7 7"/>
                </svg>
                <div style={{
                  width: '80px',
                  height: '80px',
                  background: '#fbbf24',
                  borderRadius: '16px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}>
                  <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#0f172a" strokeWidth="2">
                    <rect x="2" y="3" width="20" height="14" rx="2"/>
                    <path d="M8 21h8M12 17v4"/>
                  </svg>
                </div>
              </div>
            )}
            {activeFeature === 3 && (
              <div style={{ textAlign: 'center', padding: '40px 0' }}>
                <div style={{
                  display: 'flex',
                  justifyContent: 'center',
                  gap: '24px',
                  marginBottom: '32px',
                  flexWrap: 'wrap',
                }}>
                  <div style={{ textAlign: 'center' }}>
                    <div style={{
                      width: '60px',
                      height: '60px',
                      background: 'rgba(34, 197, 94, 0.1)',
                      borderRadius: '12px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      margin: '0 auto 8px',
                    }}>
                      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2">
                        <circle cx="12" cy="12" r="10"/>
                        <path d="M12 6v6l4 2"/>
                      </svg>
                    </div>
                    <div style={{ fontSize: '12px', color: '#64748b' }}>School hours</div>
                    <div style={{ fontSize: '14px', fontWeight: 500, color: '#22c55e' }}>Active</div>
                  </div>
                  <div style={{ textAlign: 'center' }}>
                    <div style={{
                      width: '60px',
                      height: '60px',
                      background: '#1e293b',
                      borderRadius: '12px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      margin: '0 auto 8px',
                      border: '1px solid #334155',
                    }}>
                      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#64748b" strokeWidth="2">
                        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
                        <circle cx="9" cy="7" r="4"/>
                        <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
                        <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
                      </svg>
                    </div>
                    <div style={{ fontSize: '12px', color: '#64748b' }}>After hours</div>
                    <div style={{ fontSize: '14px', fontWeight: 500, color: '#f8fafc' }}>Private</div>
                  </div>
                </div>
                <div style={{ fontSize: '14px', color: '#94a3b8', maxWidth: '280px', margin: '0 auto' }}>
                  Student privacy is automatically protected outside of class time
                </div>
              </div>
            )}
          </div>
        </div>
      </section>

      {/* How it works */}
      <section id="how" style={{
        padding: '120px 48px',
        background: '#0f172a',
      }}>
        <div style={{ maxWidth: '1000px', margin: '0 auto' }}>
          <div style={{ textAlign: 'center', marginBottom: '80px' }}>
            <div style={{
              fontSize: '13px',
              fontWeight: 600,
              color: '#fbbf24',
              letterSpacing: '1px',
              marginBottom: '20px',
            }}>HOW IT WORKS</div>
            <h2 className="serif" style={{
              fontSize: '48px',
              fontWeight: 400,
              margin: 0,
              letterSpacing: '-1px',
              color: '#f8fafc',
            }}>
              Up and running in <span style={{ fontStyle: 'italic', color: '#94a3b8' }}>minutes</span>
            </h2>
          </div>

          <div className="steps-grid" style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, 1fr)',
            gap: '32px',
          }}>
            {steps.map((step, i) => (
              <div key={i} className="step-card" style={{
                background: '#1e293b',
                borderRadius: '20px',
                padding: '40px 32px',
                border: '1px solid #334155',
              }}>
                <div style={{
                  fontSize: '48px',
                  fontWeight: 600,
                  color: '#fbbf24',
                  marginBottom: '24px',
                  letterSpacing: '-2px',
                }}>{step.num}</div>
                <div style={{
                  fontSize: '20px',
                  fontWeight: 600,
                  marginBottom: '12px',
                  color: '#f8fafc',
                }}>{step.title}</div>
                <p style={{
                  fontSize: '15px',
                  color: '#94a3b8',
                  lineHeight: 1.6,
                  margin: 0,
                }}>{step.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA Section */}
      <section style={{
        padding: '120px 48px',
        background: 'linear-gradient(135deg, #fbbf24 0%, #f59e0b 100%)',
        textAlign: 'center',
      }}>
        <h2 className="serif" style={{
          fontSize: '56px',
          fontWeight: 400,
          margin: '0 0 24px 0',
          letterSpacing: '-1px',
          color: '#0f172a',
        }}>
          Ready to see every screen?
        </h2>
        <p style={{
          fontSize: '18px',
          color: '#78350f',
          marginBottom: '40px',
          maxWidth: '500px',
          margin: '0 auto 40px',
        }}>
          Start your free 30-day trial. No credit card required. Setup takes less than 10 minutes.
        </p>
        <Link href="/request-trial" style={{
          background: '#0f172a',
          color: '#fbbf24',
          border: 'none',
          padding: '20px 48px',
          borderRadius: '100px',
          fontSize: '17px',
          fontWeight: 600,
          cursor: 'pointer',
          transition: 'all 0.3s',
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
        padding: '80px 48px 40px',
      }}>
        <div className="footer-grid" style={{
          maxWidth: '1200px',
          margin: '0 auto',
          display: 'grid',
          gridTemplateColumns: '2fr 1fr 1fr 1fr',
          gap: '60px',
          paddingBottom: '60px',
          borderBottom: '1px solid #1e293b',
        }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '20px' }}>
              <div style={{
                width: '36px',
                height: '36px',
                background: '#fbbf24',
                borderRadius: '10px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#0f172a" strokeWidth="2.5">
                  <rect x="2" y="3" width="20" height="14" rx="2"/>
                  <path d="M8 21h8M12 17v4"/>
                </svg>
              </div>
              <span style={{ fontSize: '20px', fontWeight: 600 }}>ClassPilot</span>
            </div>
            <p style={{ fontSize: '14px', color: '#64748b', lineHeight: 1.7, maxWidth: '280px' }}>
              Real-time classroom monitoring for modern education. Simple, secure, and privacy-first.
            </p>
          </div>

          <div>
            <div style={{ fontSize: '13px', fontWeight: 600, marginBottom: '20px', letterSpacing: '0.5px', color: '#f8fafc' }}>Product</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <Link href="/pricing" style={{ color: '#64748b', textDecoration: 'none', fontSize: '14px' }}>Pricing</Link>
              <Link href="/privacy" style={{ color: '#64748b', textDecoration: 'none', fontSize: '14px' }}>Security</Link>
            </div>
          </div>

          <div>
            <div style={{ fontSize: '13px', fontWeight: 600, marginBottom: '20px', letterSpacing: '0.5px', color: '#f8fafc' }}>Resources</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <Link href="/help" style={{ color: '#64748b', textDecoration: 'none', fontSize: '14px' }}>Help Center</Link>
              <Link href="/guides" style={{ color: '#64748b', textDecoration: 'none', fontSize: '14px' }}>Teacher Guides</Link>
              <a href="mailto:info@school-pilot.net" style={{ color: '#64748b', textDecoration: 'none', fontSize: '14px' }}>Contact Us</a>
            </div>
          </div>

          <div>
            <div style={{ fontSize: '13px', fontWeight: 600, marginBottom: '20px', letterSpacing: '0.5px', color: '#f8fafc' }}>Legal</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <Link href="/privacy" style={{ color: '#64748b', textDecoration: 'none', fontSize: '14px' }}>Privacy Policy</Link>
              <Link href="/terms" style={{ color: '#64748b', textDecoration: 'none', fontSize: '14px' }}>Terms of Service</Link>
            </div>
          </div>
        </div>

        <div style={{
          maxWidth: '1200px',
          margin: '0 auto',
          paddingTop: '32px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '16px',
        }}>
          <div style={{ fontSize: '14px', color: '#475569' }}>© 2025 ClassPilot. All rights reserved.</div>
          <div style={{ fontSize: '14px', color: '#475569' }}>info@school-pilot.net</div>
        </div>
      </footer>
    </div>
  );
}
