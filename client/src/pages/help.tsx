import { useState } from 'react';
import { Link } from "wouter";
import { ChevronDown, ChevronUp, Monitor, Users, Shield, Settings, MessageSquare, AlertTriangle, BookOpen, Mail } from "lucide-react";

interface FAQItem {
  question: string;
  answer: string;
}

interface FAQSection {
  title: string;
  icon: React.ReactNode;
  items: FAQItem[];
}

function FAQAccordion({ item, isOpen, onClick }: { item: FAQItem; isOpen: boolean; onClick: () => void }) {
  return (
    <div style={{
      borderBottom: '1px solid #1e293b',
    }}>
      <button
        onClick={onClick}
        style={{
          width: '100%',
          padding: '20px 0',
          background: 'transparent',
          border: 'none',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          cursor: 'pointer',
          textAlign: 'left',
        }}
      >
        <span style={{ fontSize: '16px', fontWeight: 500, color: '#f1f5f9', paddingRight: '16px' }}>
          {item.question}
        </span>
        {isOpen ? (
          <ChevronUp style={{ color: '#fbbf24', flexShrink: 0 }} size={20} />
        ) : (
          <ChevronDown style={{ color: '#64748b', flexShrink: 0 }} size={20} />
        )}
      </button>
      {isOpen && (
        <div style={{
          paddingBottom: '20px',
          color: '#94a3b8',
          fontSize: '15px',
          lineHeight: 1.7,
        }}>
          {item.answer}
        </div>
      )}
    </div>
  );
}

export default function HelpCenter() {
  const [openItems, setOpenItems] = useState<Set<string>>(new Set());
  const [activeSection, setActiveSection] = useState<string>('getting-started');

  const toggleItem = (id: string) => {
    const newOpenItems = new Set(openItems);
    if (newOpenItems.has(id)) {
      newOpenItems.delete(id);
    } else {
      newOpenItems.add(id);
    }
    setOpenItems(newOpenItems);
  };

  const faqSections: Record<string, FAQSection> = {
    'getting-started': {
      title: 'Getting Started',
      icon: <Monitor size={20} />,
      items: [
        {
          question: 'How do I create a ClassPilot account?',
          answer: 'Click "Start Free Trial" to register your school. School Admins can sign up their school domain, sync with Google Classroom, and import students from Google Workspace for Education. You can also create an account with your email and password.',
        },
        {
          question: 'How is the Chrome extension installed?',
          answer: 'School Admins deploy the ClassPilot extension through Google Workspace for Education admin console. This allows force-installation across all managed Chromebooks — no action required from students or teachers.',
        },
        {
          question: 'How long does setup take?',
          answer: 'Most schools are up and running in under 10 minutes. Register your school, deploy the extension via Google Workspace, and you\'re ready to monitor. Google Classroom sync makes roster import instant.',
        },
        {
          question: 'What devices are supported?',
          answer: 'ClassPilot works on any device running Google Chrome or Chromium-based browsers (Edge, Brave). It\'s optimized for Chromebooks, which are commonly used in K-12 education.',
        },
        {
          question: 'Is there a free trial?',
          answer: 'Yes! Every school gets a free 30-day trial with full access to all features. No credit card required to start.',
        },
      ],
    },
    'teachers': {
      title: 'For Teachers',
      icon: <Users size={20} />,
      items: [
        {
          question: 'How do I start monitoring my class?',
          answer: 'Log in to your dashboard and click "Start Session". Select the class or group you want to monitor. Students with the extension installed will appear in your dashboard within seconds.',
        },
        {
          question: 'What is a Flight Path?',
          answer: 'A Flight Path is a list of allowed websites. The first domain you enter becomes the starting point — students will be navigated there automatically. From there, they can only visit other websites on the list. Everything else is blocked. Great for keeping students focused on specific resources during assignments.',
        },
        {
          question: 'What is a Block List?',
          answer: 'A Block List is the opposite of a Flight Path — it\'s a list of websites that are blocked. Students can visit any site EXCEPT those on the Block List. Useful for blocking specific distractions like social media.',
        },
        {
          question: 'How do I send a message to students?',
          answer: 'Select one or more students in your dashboard, then click the message icon. Type your message and send. Students will see a notification popup on their screen immediately.',
        },
        {
          question: 'Can I see what tabs students have open?',
          answer: 'Yes! Select a student and click the "Tabs" button to see all their open tabs. You\'ll see their current active tab plus a list of all open tabs. You can also view their browsing history for the session.',
        },
        {
          question: 'How do I lock a student\'s screen?',
          answer: 'Select the student(s) you want to lock, then click "Lock Screen" from the toolbar. This restricts them to only the current website they\'re viewing. Click "Unlock" to restore normal browsing.',
        },
        {
          question: 'What does "Attention Mode" do?',
          answer: 'Attention Mode displays a full-screen overlay on student devices with a message like "Please look up!" It\'s perfect for getting everyone\'s attention before giving instructions.',
        },
        {
          question: 'How do I close tabs on student devices?',
          answer: 'Select a student and click the "Tabs" button to view their open tabs. From there, you can select a specific tab to close or use "Close All" to close all tabs at once.',
        },
      ],
    },
    'admins': {
      title: 'For Administrators',
      icon: <Settings size={20} />,
      items: [
        {
          question: 'How do I add teachers to my school?',
          answer: 'Go to the Admin dashboard and click "Add Staff". Enter the teacher\'s email address to add them to your school. Teachers simply log in with their school email address — no invitation emails are sent.',
        },
        {
          question: 'How do I import student rosters?',
          answer: 'The easiest way is to import students directly from Google Workspace for Education. ClassPilot also supports Google Classroom sync for automatic roster import. Alternatively, you can upload a CSV file with student names and emails.',
        },
        {
          question: 'Can I see what all teachers are doing?',
          answer: 'Yes! As an admin, you can view all active sessions across your school. You can observe any teacher\'s session to see their dashboard view without interfering with their class.',
        },
        {
          question: 'How do I set up a school-wide block list?',
          answer: 'In Settings, go to "Global Blacklist". Add domains you want blocked school-wide. These blocks apply to all students regardless of which teacher is monitoring them.',
        },
        {
          question: 'What does 24/7 monitoring cost?',
          answer: 'ClassPilot includes all core monitoring features in the base subscription. For schools that need around-the-clock monitoring outside school hours, 24/7 monitoring is available at an additional cost. Contact us for pricing details.',
        },
      ],
    },
    'privacy': {
      title: 'Privacy & Security',
      icon: <Shield size={20} />,
      items: [
        {
          question: 'Is ClassPilot FERPA compliant?',
          answer: 'Yes. ClassPilot is fully FERPA compliant. We only collect data necessary for classroom management, store it securely, and never share or sell student data to third parties.',
        },
        {
          question: 'What data does ClassPilot collect?',
          answer: 'ClassPilot collects: active tab title and URL, list of open tabs, and timestamps. We do NOT collect: keystrokes, passwords, form data, camera/microphone, or any content from the pages students visit.',
        },
        {
          question: 'Is monitoring active outside school hours?',
          answer: 'No. ClassPilot respects student privacy by only monitoring during configured school hours. The default is 7 AM - 5 PM, but this can be changed upon request. Outside these hours, no data is collected.',
        },
        {
          question: 'How long is student data retained?',
          answer: 'Browsing activity (heartbeats) is automatically deleted after 24 hours. This keeps your dashboard responsive while respecting student privacy. Session summaries may be retained longer for reporting.',
        },
        {
          question: 'Is data encrypted?',
          answer: 'Yes. All data is encrypted in transit using TLS 1.3 and at rest using AES-256 encryption. We use AWS infrastructure with SOC 2 compliance.',
        },
        {
          question: 'Can students see when they\'re being monitored?',
          answer: 'Yes. The ClassPilot extension shows a green indicator when monitoring is active. We believe in transparency — students should know when their activity is visible to teachers.',
        },
      ],
    },
    'troubleshooting': {
      title: 'Troubleshooting',
      icon: <AlertTriangle size={20} />,
      items: [
        {
          question: 'Students aren\'t appearing in my dashboard',
          answer: 'Check that: 1) Students have the extension installed, 2) They\'re logged into Chrome with their school email, 3) You\'ve started an active session, 4) The extension shows a green "connected" indicator. If issues persist, have students reload the extension.',
        },
        {
          question: 'The extension shows "Disconnected"',
          answer: 'This usually means the student\'s device lost internet connection or the extension needs to be refreshed. Try: 1) Check internet connection, 2) Click the extension icon and wait for reconnection, 3) Reload the browser if needed.',
        },
        {
          question: 'Flight Path isn\'t blocking websites',
          answer: 'Ensure the Flight Path is actively applied (check the toolbar shows it as active). Verify the allowed domains are spelled correctly. Students may need to refresh their browser after a Flight Path is applied.',
        },
        {
          question: 'I can\'t see student screenshots',
          answer: 'Screenshot thumbnails must be enabled in your session settings. Also ensure students have granted the necessary permissions to the extension.',
        },
        {
          question: 'Google Classroom sync isn\'t working',
          answer: 'Make sure you\'ve authorized ClassPilot to access your Google Classroom. Go to Settings > Integrations > Google Classroom and click "Reconnect". You may need to grant permissions again.',
        },
        {
          question: 'How do I contact support?',
          answer: 'Email us at info@school-pilot.net. For urgent issues during school hours, we typically respond within 2 hours. You can also check our Teacher Guides for detailed walkthroughs.',
        },
      ],
    },
  };

  return (
    <div style={{
      minHeight: '100vh',
      background: '#0f172a',
      fontFamily: "'Inter', -apple-system, sans-serif",
      color: '#f1f5f9',
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
        * { box-sizing: border-box; }
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
          text-decoration: none;
          display: inline-block;
          transition: all 0.2s;
        }
        .btn-primary:hover {
          background: #f59e0b;
        }
        .section-btn {
          width: 100%;
          padding: 16px 20px;
          background: transparent;
          border: none;
          border-radius: 12px;
          display: flex;
          align-items: center;
          gap: 12px;
          cursor: pointer;
          transition: all 0.2s;
          text-align: left;
        }
        .section-btn:hover {
          background: rgba(255,255,255,0.05);
        }
        .section-btn.active {
          background: rgba(251, 191, 36, 0.1);
          border: 1px solid rgba(251, 191, 36, 0.2);
        }
        @media (max-width: 768px) {
          .help-grid {
            grid-template-columns: 1fr !important;
          }
          .sidebar {
            display: none !important;
          }
        }
      `}</style>

      {/* Navigation */}
      <nav style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '24px 48px',
        borderBottom: '1px solid #1e293b',
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

        <div style={{ display: 'flex', alignItems: 'center', gap: '24px' }}>
          <Link href="/guides" className="nav-link">Teacher Guides</Link>
          <Link href="/login" className="btn-primary">Sign In</Link>
        </div>
      </nav>

      {/* Header */}
      <div style={{
        textAlign: 'center',
        padding: '80px 48px 60px',
        borderBottom: '1px solid #1e293b',
      }}>
        <h1 style={{
          fontSize: '48px',
          fontWeight: 700,
          margin: '0 0 16px 0',
          letterSpacing: '-1px',
        }}>
          Help Center
        </h1>
        <p style={{
          fontSize: '18px',
          color: '#94a3b8',
          maxWidth: '600px',
          margin: '0 auto',
        }}>
          Find answers to common questions about ClassPilot. Can't find what you're looking for?{' '}
          <a href="mailto:info@school-pilot.net" style={{ color: '#fbbf24' }}>Contact support</a>
        </p>
      </div>

      {/* Content */}
      <div className="help-grid" style={{
        display: 'grid',
        gridTemplateColumns: '280px 1fr',
        maxWidth: '1200px',
        margin: '0 auto',
        padding: '48px',
        gap: '48px',
      }}>
        {/* Sidebar */}
        <div className="sidebar" style={{
          position: 'sticky',
          top: '48px',
          height: 'fit-content',
        }}>
          <div style={{
            background: '#1e293b',
            borderRadius: '16px',
            padding: '16px',
            border: '1px solid #334155',
          }}>
            {Object.entries(faqSections).map(([key, section]) => (
              <button
                key={key}
                className={`section-btn ${activeSection === key ? 'active' : ''}`}
                onClick={() => setActiveSection(key)}
              >
                <span style={{ color: activeSection === key ? '#fbbf24' : '#64748b' }}>
                  {section.icon}
                </span>
                <span style={{
                  fontSize: '14px',
                  fontWeight: 500,
                  color: activeSection === key ? '#f8fafc' : '#94a3b8',
                }}>
                  {section.title}
                </span>
              </button>
            ))}
          </div>

          {/* Quick Links */}
          <div style={{
            marginTop: '24px',
            padding: '24px',
            background: '#1e293b',
            borderRadius: '16px',
            border: '1px solid #334155',
          }}>
            <h3 style={{ fontSize: '14px', fontWeight: 600, marginBottom: '16px', color: '#f8fafc' }}>
              Quick Links
            </h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <Link href="/guides" style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#94a3b8', textDecoration: 'none', fontSize: '14px' }}>
                <BookOpen size={16} />
                Teacher Guides
              </Link>
              <a href="mailto:info@school-pilot.net" style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#94a3b8', textDecoration: 'none', fontSize: '14px' }}>
                <Mail size={16} />
                Contact Support
              </a>
            </div>
          </div>
        </div>

        {/* FAQ Content */}
        <div>
          <div style={{
            background: '#1e293b',
            borderRadius: '16px',
            padding: '32px',
            border: '1px solid #334155',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '32px' }}>
              <span style={{ color: '#fbbf24' }}>
                {faqSections[activeSection].icon}
              </span>
              <h2 style={{ fontSize: '24px', fontWeight: 600, margin: 0 }}>
                {faqSections[activeSection].title}
              </h2>
            </div>

            <div>
              {faqSections[activeSection].items.map((item, index) => (
                <FAQAccordion
                  key={`${activeSection}-${index}`}
                  item={item}
                  isOpen={openItems.has(`${activeSection}-${index}`)}
                  onClick={() => toggleItem(`${activeSection}-${index}`)}
                />
              ))}
            </div>
          </div>

          {/* Mobile Section Tabs */}
          <div style={{
            display: 'none',
            flexWrap: 'wrap',
            gap: '8px',
            marginBottom: '24px',
          }} className="mobile-tabs">
            {Object.entries(faqSections).map(([key, section]) => (
              <button
                key={key}
                onClick={() => setActiveSection(key)}
                style={{
                  padding: '8px 16px',
                  borderRadius: '100px',
                  border: 'none',
                  background: activeSection === key ? '#fbbf24' : '#1e293b',
                  color: activeSection === key ? '#0f172a' : '#94a3b8',
                  fontSize: '13px',
                  fontWeight: 500,
                  cursor: 'pointer',
                }}
              >
                {section.title}
              </button>
            ))}
          </div>

          {/* Still need help? */}
          <div style={{
            marginTop: '32px',
            padding: '32px',
            background: 'linear-gradient(135deg, rgba(251, 191, 36, 0.1) 0%, rgba(251, 191, 36, 0.05) 100%)',
            borderRadius: '16px',
            border: '1px solid rgba(251, 191, 36, 0.2)',
            textAlign: 'center',
          }}>
            <MessageSquare size={32} style={{ color: '#fbbf24', marginBottom: '16px' }} />
            <h3 style={{ fontSize: '20px', fontWeight: 600, marginBottom: '8px' }}>
              Still need help?
            </h3>
            <p style={{ color: '#94a3b8', marginBottom: '24px' }}>
              Our support team is here to help you get the most out of ClassPilot.
            </p>
            <a href="mailto:info@school-pilot.net" className="btn-primary">
              Contact Support
            </a>
          </div>
        </div>
      </div>

      {/* Footer */}
      <footer style={{
        borderTop: '1px solid #1e293b',
        padding: '40px 48px',
        textAlign: 'center',
      }}>
        <div style={{ fontSize: '14px', color: '#64748b' }}>
          © 2025 ClassPilot. All rights reserved.
        </div>
      </footer>
    </div>
  );
}
