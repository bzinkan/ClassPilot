import { Link } from "wouter";

export default function CheckoutSuccess() {
  return (
    <div style={{
      minHeight: '100vh',
      background: '#0f172a',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontFamily: "'Inter', -apple-system, sans-serif",
      color: '#f8fafc',
      padding: '48px',
    }}>
      <div style={{
        maxWidth: '520px',
        textAlign: 'center',
      }}>
        <div style={{
          width: '80px',
          height: '80px',
          borderRadius: '50%',
          background: 'rgba(34, 197, 94, 0.15)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          margin: '0 auto 24px',
          fontSize: '36px',
        }}>
          ✓
        </div>
        <h1 style={{ fontSize: '32px', fontWeight: 700, marginBottom: '16px' }}>
          Payment Successful!
        </h1>
        <p style={{ color: '#94a3b8', fontSize: '16px', lineHeight: 1.6, marginBottom: '32px' }}>
          Thank you for choosing ClassPilot. Your annual plan is now active.
          We'll send a confirmation email with your receipt shortly.
        </p>
        <p style={{ color: '#64748b', fontSize: '14px', marginBottom: '32px' }}>
          Our team will set up your school account and reach out with next steps within 1 business day.
        </p>
        <div style={{ display: 'flex', gap: '16px', justifyContent: 'center' }}>
          <Link href="/" style={{
            padding: '14px 28px',
            borderRadius: '100px',
            background: '#fbbf24',
            color: '#0f172a',
            fontWeight: 600,
            textDecoration: 'none',
            fontSize: '14px',
          }}>
            Go to Dashboard
          </Link>
          <Link href="/guides" style={{
            padding: '14px 28px',
            borderRadius: '100px',
            border: '1px solid #334155',
            color: '#f8fafc',
            fontWeight: 600,
            textDecoration: 'none',
            fontSize: '14px',
          }}>
            View Setup Guides
          </Link>
        </div>
      </div>
    </div>
  );
}
