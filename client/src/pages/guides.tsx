import { Link } from "wouter";
import { Download, Monitor, Users, Route, ShieldBan, MessageSquare, Clock, BarChart3, Settings, ChevronRight, FileText, Video } from "lucide-react";

interface Guide {
  id: string;
  title: string;
  description: string;
  icon: React.ReactNode;
  duration: string;
  sections: string[];
}

const guides: Guide[] = [
  {
    id: 'getting-started',
    title: 'Getting Started Guide',
    description: 'Everything you need to know to set up ClassPilot and start monitoring your first class.',
    icon: <Monitor size={24} />,
    duration: '5 min read',
    sections: [
      'Creating your account',
      'Navigating the dashboard',
      'Starting your first session',
      'Understanding student tiles',
    ],
  },
  {
    id: 'student-monitoring',
    title: 'Student Monitoring',
    description: 'Learn how to effectively monitor student activity and maintain classroom focus.',
    icon: <Users size={24} />,
    duration: '8 min read',
    sections: [
      'Viewing student screens',
      'Opening student detail panel',
      'Understanding status indicators',
      'Viewing browsing history',
    ],
  },
  {
    id: 'flight-paths',
    title: 'Using Flight Paths',
    description: 'Restrict student browsing to specific websites during focused work time.',
    icon: <Route size={24} />,
    duration: '6 min read',
    sections: [
      'Creating a Flight Path',
      'Adding allowed websites',
      'Applying to students',
      'Managing multiple Flight Paths',
    ],
  },
  {
    id: 'block-lists',
    title: 'Using Block Lists',
    description: 'Block specific distracting websites while allowing everything else.',
    icon: <ShieldBan size={24} />,
    duration: '5 min read',
    sections: [
      'Creating a Block List',
      'Adding blocked websites',
      'Applying during sessions',
      'Global vs session block lists',
    ],
  },
  {
    id: 'messaging',
    title: 'Student Communication',
    description: 'Send messages, get attention, and communicate with your class effectively.',
    icon: <MessageSquare size={24} />,
    duration: '4 min read',
    sections: [
      'Sending individual messages',
      'Broadcasting to all students',
      'Using Attention Mode',
      'Student hand raises',
    ],
  },
  {
    id: 'remote-control',
    title: 'Remote Control Features',
    description: 'Lock screens, close tabs, and manage student devices remotely.',
    icon: <Settings size={24} />,
    duration: '7 min read',
    sections: [
      'Locking student screens',
      'Closing tabs remotely',
      'Opening websites on devices',
      'Screen unlock options',
    ],
  },
];

function GuideCard({ guide }: { guide: Guide }) {
  return (
    <div style={{
      background: '#1e293b',
      borderRadius: '16px',
      padding: '28px',
      border: '1px solid #334155',
      transition: 'all 0.2s',
      cursor: 'pointer',
    }}
    onMouseEnter={(e) => {
      e.currentTarget.style.borderColor = 'rgba(251, 191, 36, 0.3)';
      e.currentTarget.style.transform = 'translateY(-2px)';
    }}
    onMouseLeave={(e) => {
      e.currentTarget.style.borderColor = '#334155';
      e.currentTarget.style.transform = 'translateY(0)';
    }}
    >
      <div style={{
        width: '48px',
        height: '48px',
        background: 'rgba(251, 191, 36, 0.1)',
        borderRadius: '12px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: '20px',
        color: '#fbbf24',
      }}>
        {guide.icon}
      </div>

      <h3 style={{
        fontSize: '18px',
        fontWeight: 600,
        marginBottom: '8px',
        color: '#f8fafc',
      }}>
        {guide.title}
      </h3>

      <p style={{
        fontSize: '14px',
        color: '#94a3b8',
        marginBottom: '20px',
        lineHeight: 1.6,
      }}>
        {guide.description}
      </p>

      <div style={{
        fontSize: '12px',
        color: '#64748b',
        marginBottom: '20px',
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
      }}>
        <Clock size={14} />
        {guide.duration}
      </div>

      <div style={{
        borderTop: '1px solid #334155',
        paddingTop: '16px',
      }}>
        <div style={{ fontSize: '12px', fontWeight: 600, color: '#64748b', marginBottom: '12px' }}>
          WHAT YOU'LL LEARN
        </div>
        <ul style={{
          margin: 0,
          padding: 0,
          listStyle: 'none',
        }}>
          {guide.sections.map((section, i) => (
            <li key={i} style={{
              fontSize: '13px',
              color: '#94a3b8',
              padding: '6px 0',
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
            }}>
              <ChevronRight size={14} style={{ color: '#fbbf24' }} />
              {section}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export default function TeacherGuides() {
  const handleDownloadPDF = () => {
    // Create PDF content
    const pdfContent = generatePDFContent();

    // Create blob and download
    const blob = new Blob([pdfContent], { type: 'text/html' });
    const url = URL.createObjectURL(blob);

    // Create a link and trigger download
    const a = document.createElement('a');
    a.href = url;
    a.download = 'ClassPilot-Teacher-Guide.html';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
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
          display: inline-flex;
          align-items: center;
          gap: 8px;
          transition: all 0.2s;
        }
        .btn-primary:hover {
          background: #f59e0b;
          transform: translateY(-1px);
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
          text-decoration: none;
          display: inline-flex;
          align-items: center;
          gap: 8px;
          transition: all 0.2s;
        }
        .btn-secondary:hover {
          border-color: #64748b;
          background: rgba(255,255,255,0.05);
        }
        .guides-grid {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 24px;
        }
        @media (max-width: 1024px) {
          .guides-grid {
            grid-template-columns: repeat(2, 1fr);
          }
        }
        @media (max-width: 640px) {
          .guides-grid {
            grid-template-columns: 1fr;
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
          <Link href="/help" className="nav-link">Help Center</Link>
          <Link href="/login" className="btn-primary">Sign In</Link>
        </div>
      </nav>

      {/* Header */}
      <div style={{
        textAlign: 'center',
        padding: '80px 48px',
        borderBottom: '1px solid #1e293b',
        background: 'linear-gradient(180deg, rgba(251, 191, 36, 0.03) 0%, transparent 100%)',
      }}>
        <div style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '8px',
          background: 'rgba(251, 191, 36, 0.1)',
          color: '#fbbf24',
          padding: '8px 16px',
          borderRadius: '100px',
          fontSize: '13px',
          fontWeight: 600,
          marginBottom: '24px',
          border: '1px solid rgba(251, 191, 36, 0.2)',
        }}>
          <FileText size={16} />
          TEACHER RESOURCES
        </div>

        <h1 style={{
          fontSize: '48px',
          fontWeight: 700,
          margin: '0 0 16px 0',
          letterSpacing: '-1px',
        }}>
          Teacher Guides
        </h1>
        <p style={{
          fontSize: '18px',
          color: '#94a3b8',
          maxWidth: '600px',
          margin: '0 auto 32px',
        }}>
          Step-by-step guides to help you get the most out of ClassPilot.
          From basic monitoring to advanced features.
        </p>

        <div style={{ display: 'flex', gap: '16px', justifyContent: 'center', flexWrap: 'wrap' }}>
          <button onClick={handleDownloadPDF} className="btn-primary">
            <Download size={18} />
            Download Complete Guide
          </button>
          <Link href="/help" className="btn-secondary">
            <MessageSquare size={18} />
            Visit Help Center
          </Link>
        </div>
      </div>

      {/* Guides Grid */}
      <div style={{
        maxWidth: '1200px',
        margin: '0 auto',
        padding: '64px 48px',
      }}>
        <div className="guides-grid">
          {guides.map((guide) => (
            <GuideCard key={guide.id} guide={guide} />
          ))}
        </div>
      </div>

      {/* Quick Start Section */}
      <div style={{
        background: '#1e293b',
        padding: '80px 48px',
      }}>
        <div style={{
          maxWidth: '1000px',
          margin: '0 auto',
          textAlign: 'center',
        }}>
          <h2 style={{
            fontSize: '32px',
            fontWeight: 700,
            marginBottom: '16px',
          }}>
            Quick Start Checklist
          </h2>
          <p style={{
            fontSize: '16px',
            color: '#94a3b8',
            marginBottom: '48px',
          }}>
            Get your classroom up and running in 10 minutes or less
          </p>

          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
            gap: '24px',
            textAlign: 'left',
          }}>
            {[
              { step: '1', title: 'School Registration', desc: 'Admin registers school domain and syncs with Google Workspace' },
              { step: '2', title: 'Set Up Classes', desc: 'Import from Google Classroom or create manually' },
              { step: '3', title: 'Deploy Extension', desc: 'Admin deploys extension via Google Workspace for Education' },
              { step: '4', title: 'Start Monitoring', desc: 'Click "Start Session" and see all screens live' },
            ].map((item) => (
              <div key={item.step} style={{
                background: '#0f172a',
                borderRadius: '12px',
                padding: '24px',
                display: 'flex',
                gap: '16px',
                alignItems: 'flex-start',
              }}>
                <div style={{
                  width: '32px',
                  height: '32px',
                  background: '#fbbf24',
                  borderRadius: '8px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontWeight: 700,
                  color: '#0f172a',
                  flexShrink: 0,
                }}>
                  {item.step}
                </div>
                <div>
                  <div style={{ fontWeight: 600, marginBottom: '4px', color: '#f8fafc' }}>{item.title}</div>
                  <div style={{ fontSize: '14px', color: '#94a3b8' }}>{item.desc}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* CTA */}
      <div style={{
        padding: '80px 48px',
        textAlign: 'center',
        background: 'linear-gradient(135deg, rgba(251, 191, 36, 0.1) 0%, transparent 100%)',
      }}>
        <h2 style={{ fontSize: '32px', fontWeight: 700, marginBottom: '16px' }}>
          Need more help?
        </h2>
        <p style={{ color: '#94a3b8', marginBottom: '32px' }}>
          Visit our Help Center for answers to common questions or contact support.
        </p>
        <Link href="/help" className="btn-primary">
          Visit Help Center
        </Link>
      </div>

      {/* Footer */}
      <footer style={{
        borderTop: '1px solid #1e293b',
        padding: '40px 48px',
        textAlign: 'center',
      }}>
        <div style={{ fontSize: '14px', color: '#64748b' }}>
          © 2025 ClassPilot. All rights reserved. |{' '}
          <a href="mailto:info@school-pilot.net" style={{ color: '#94a3b8' }}>info@school-pilot.net</a>
        </div>
      </footer>
    </div>
  );
}

// Generate downloadable HTML content for the PDF
function generatePDFContent(): string {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>ClassPilot Teacher Guide</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #1e293b; max-width: 800px; margin: 0 auto; padding: 40px 20px; }
    h1 { font-size: 32px; margin-bottom: 8px; color: #0f172a; }
    h2 { font-size: 24px; margin: 40px 0 16px; color: #0f172a; border-bottom: 2px solid #fbbf24; padding-bottom: 8px; }
    h3 { font-size: 18px; margin: 24px 0 12px; color: #334155; }
    p { margin-bottom: 16px; color: #475569; }
    ul, ol { margin: 0 0 16px 24px; color: #475569; }
    li { margin-bottom: 8px; }
    .header { text-align: center; margin-bottom: 48px; padding-bottom: 32px; border-bottom: 1px solid #e2e8f0; }
    .logo { width: 60px; height: 60px; background: #fbbf24; border-radius: 12px; margin: 0 auto 16px; display: flex; align-items: center; justify-content: center; }
    .subtitle { color: #64748b; font-size: 16px; }
    .section { margin-bottom: 32px; page-break-inside: avoid; }
    .tip { background: #fef3c7; border-left: 4px solid #fbbf24; padding: 16px; margin: 16px 0; border-radius: 0 8px 8px 0; }
    .tip-title { font-weight: 600; color: #92400e; margin-bottom: 4px; }
    .warning { background: #fee2e2; border-left: 4px solid #ef4444; padding: 16px; margin: 16px 0; border-radius: 0 8px 8px 0; }
    .footer { margin-top: 48px; padding-top: 24px; border-top: 1px solid #e2e8f0; text-align: center; color: #64748b; font-size: 14px; }
    @media print { body { padding: 20px; } h2 { page-break-before: always; } h2:first-of-type { page-break-before: auto; } }
  </style>
</head>
<body>
  <div class="header">
    <div class="logo">
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#0f172a" stroke-width="2.5" stroke-linecap="round">
        <rect x="2" y="3" width="20" height="14" rx="2"/>
        <path d="M8 21h8M12 17v4"/>
      </svg>
    </div>
    <h1>ClassPilot Teacher Guide</h1>
    <p class="subtitle">Complete guide to classroom monitoring and management</p>
  </div>

  <h2>1. Getting Started</h2>

  <div class="section">
    <h3>Creating Your Account</h3>
    <p>Your School Administrator will register your school with ClassPilot. Once registered:</p>
    <ol>
      <li>Visit <strong>classpilot.net</strong> and click "Sign In"</li>
      <li>Sign in with your school Google account</li>
      <li>Your account will be automatically linked to your school</li>
      <li>You'll be taken to your teacher dashboard</li>
    </ol>

    <div class="tip">
      <div class="tip-title">Google Classroom Sync</div>
      Using Google sign-in automatically syncs your Google Classroom rosters, saving you time on setup.
    </div>
  </div>

  <div class="section">
    <h3>Understanding the Dashboard</h3>
    <p>Your dashboard is the command center for classroom monitoring. Here's what you'll see:</p>
    <ul>
      <li><strong>Student Grid:</strong> Live tiles showing each student's current screen</li>
      <li><strong>Status Bar:</strong> Shows session status, connected students count</li>
      <li><strong>Toolbar:</strong> Quick actions like Lock Screen, Flight Path, Messages</li>
      <li><strong>Side Panel:</strong> Detailed view of selected student's activity</li>
    </ul>
  </div>

  <h2>2. Extension Deployment</h2>

  <div class="section">
    <h3>How the Chrome Extension is Installed</h3>
    <p>School Administrators deploy the ClassPilot extension through Google Workspace for Education:</p>
    <ol>
      <li>School Admin accesses the Google Admin Console</li>
      <li>The extension is force-installed across all managed Chromebooks</li>
      <li>The extension auto-detects student school email from their Chromebook login</li>
      <li>Students will appear in your dashboard automatically when you start a session</li>
    </ol>

    <div class="tip">
      <div class="tip-title">No Student Action Required</div>
      Students do not need to install anything. The extension is deployed automatically by your School Administrator through Google Workspace for Education.
    </div>
  </div>

  <h2>3. Starting a Monitoring Session</h2>

  <div class="section">
    <h3>Beginning Your Session</h3>
    <ol>
      <li>Log into your ClassPilot dashboard</li>
      <li>Click <strong>"Start Session"</strong> in the top right</li>
      <li>Select the class or group you want to monitor</li>
      <li>Students with the extension will appear within seconds</li>
    </ol>

    <h3>Understanding Student Tiles</h3>
    <p>Each student tile shows:</p>
    <ul>
      <li><strong>Green dot:</strong> Student is on-task (educational site)</li>
      <li><strong>Yellow dot:</strong> Student may be off-task (potentially distracting site)</li>
      <li><strong>Red dot:</strong> Student is off-task (blocked/flagged site)</li>
      <li><strong>Gray dot:</strong> Student is offline or extension not active</li>
    </ul>
  </div>

  <h2>4. Using Flight Paths</h2>

  <div class="section">
    <h3>What is a Flight Path?</h3>
    <p>A Flight Path is a whitelist of allowed websites. When active, students can ONLY visit sites on the list - everything else is blocked.</p>

    <h3>Creating a Flight Path</h3>
    <ol>
      <li>Go to <strong>Settings → Flight Paths</strong></li>
      <li>Click <strong>"Create Flight Path"</strong></li>
      <li>Give it a descriptive name (e.g., "Math Resources")</li>
      <li>Add allowed domains (e.g., khanacademy.org, desmos.com)</li>
      <li>Save your Flight Path</li>
    </ol>

    <h3>Applying a Flight Path</h3>
    <ol>
      <li>Select students (or click "Select All")</li>
      <li>Click the <strong>Flight Path</strong> button in the toolbar</li>
      <li>Choose which Flight Path to apply</li>
      <li>Students will be restricted immediately</li>
    </ol>

    <div class="warning">
      <strong>Important:</strong> Make sure to include all necessary domains. If students need Google Docs, add docs.google.com AND drive.google.com.
    </div>
  </div>

  <h2>5. Using Block Lists</h2>

  <div class="section">
    <h3>What is a Block List?</h3>
    <p>A Block List is the opposite of a Flight Path - it blocks specific sites while allowing everything else.</p>

    <h3>Creating a Block List</h3>
    <ol>
      <li>Go to <strong>Settings → Block Lists</strong></li>
      <li>Click <strong>"Create Block List"</strong></li>
      <li>Name it (e.g., "Social Media Block")</li>
      <li>Add domains to block (e.g., instagram.com, tiktok.com)</li>
      <li>Save your Block List</li>
    </ol>

    <div class="tip">
      <div class="tip-title">Global vs Session Block Lists</div>
      Your school admin can set up global block lists that apply school-wide. Session block lists only apply when you activate them during your class.
    </div>
  </div>

  <h2>6. Communication Tools</h2>

  <div class="section">
    <h3>Sending Messages</h3>
    <ol>
      <li>Select one or more students</li>
      <li>Click the <strong>Message</strong> icon in the toolbar</li>
      <li>Type your message</li>
      <li>Click Send - students see an instant popup notification</li>
    </ol>

    <h3>Using Attention Mode</h3>
    <p>Attention Mode displays a full-screen overlay on all student devices:</p>
    <ol>
      <li>Click <strong>"Attention"</strong> in the toolbar</li>
      <li>Enter your message (default: "Please look up!")</li>
      <li>Click Activate - all screens show your message</li>
      <li>Click Deactivate when ready to resume</li>
    </ol>

    <h3>Responding to Hand Raises</h3>
    <p>Students can "raise their hand" through the extension. You'll see a hand icon on their tile. Click to acknowledge and the hand lowers.</p>
  </div>

  <h2>7. Remote Control Features</h2>

  <div class="section">
    <h3>Lock Screen</h3>
    <p>Restricts students to their current website:</p>
    <ol>
      <li>Select students to lock</li>
      <li>Click <strong>"Lock Screen"</strong></li>
      <li>Students can only navigate within their current site</li>
      <li>Click "Unlock" to restore full browsing</li>
    </ol>

    <h3>Close Tabs</h3>
    <p>Remotely close distracting tabs:</p>
    <ol>
      <li>Select the student</li>
      <li>Open their detail panel (click their tile)</li>
      <li>View all open tabs</li>
      <li>Click the X next to tabs you want to close</li>
    </ol>

    <h3>Open Website</h3>
    <p>Push a website to student devices:</p>
    <ol>
      <li>Select students</li>
      <li>Click <strong>"Open Tab"</strong></li>
      <li>Enter the URL you want to open</li>
      <li>The site opens in a new tab on all selected devices</li>
    </ol>
  </div>

  <h2>8. Best Practices</h2>

  <div class="section">
    <h3>Effective Monitoring</h3>
    <ul>
      <li><strong>Start sessions at the beginning of class</strong> - Students know monitoring is active</li>
      <li><strong>Use Flight Paths for focused work</strong> - Reduces distractions during assignments</li>
      <li><strong>Address off-task behavior privately</strong> - Use individual messages first</li>
      <li><strong>Create reusable Flight Paths</strong> - Build a library for different activities</li>
    </ul>

    <h3>Privacy Considerations</h3>
    <ul>
      <li>ClassPilot only monitors during configured school hours</li>
      <li>Students see a green indicator when monitoring is active</li>
      <li>No data is collected outside school hours</li>
      <li>Activity data is automatically deleted after 24 hours</li>
    </ul>
  </div>

  <h2>9. Troubleshooting</h2>

  <div class="section">
    <h3>Students Not Appearing</h3>
    <ul>
      <li>Verify the extension is installed (check chrome://extensions)</li>
      <li>Ensure students are logged into Chrome with school email</li>
      <li>Have students refresh their browser</li>
      <li>Check that you have an active session running</li>
    </ul>

    <h3>Extension Shows Disconnected</h3>
    <ul>
      <li>Check student's internet connection</li>
      <li>Click the extension icon to manually reconnect</li>
      <li>Refresh the browser if issues persist</li>
    </ul>

    <h3>Need More Help?</h3>
    <p>Contact our support team at <strong>info@school-pilot.net</strong> or visit the Help Center at classpilot.net/help</p>
  </div>

  <div class="footer">
    <p>© 2025 ClassPilot. All rights reserved.</p>
    <p>info@school-pilot.net | classpilot.net</p>
  </div>
</body>
</html>
`;
}
