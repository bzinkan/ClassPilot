import { useState } from "react";
import { useLocation, Link } from "wouter";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

const loginSchema = z.object({
  email: z.string().email("Invalid email address"),
  password: z.string().min(1, "Password is required"),
});

type LoginForm = z.infer<typeof loginSchema>;

export default function Login() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [showEmailLogin, setShowEmailLogin] = useState(false);

  const form = useForm<LoginForm>({
    resolver: zodResolver(loginSchema),
    defaultValues: {
      email: "",
      password: "",
    },
  });

  const loginMutation = useMutation({
    mutationFn: async (data: LoginForm) => {
      const response = await apiRequest("POST", "/api/login", data);
      const result = await response.json();
      return result;
    },
    onSuccess: (data: any) => {
      toast({
        title: "Login successful",
        description: "Welcome to ClassPilot",
      });

      const role = data.user?.role;
      if (role === 'super_admin') {
        setLocation("/super-admin/schools");
      } else if (role === 'school_admin') {
        setLocation("/admin");
      } else {
        setLocation("/dashboard");
      }
    },
    onError: (error: any) => {
      toast({
        variant: "destructive",
        title: "Login failed",
        description: error.message || "Invalid email or password",
      });
    },
  });

  const onSubmit = (data: LoginForm) => {
    loginMutation.mutate(data);
  };

  return (
    <div style={{
      minHeight: '100vh',
      background: 'linear-gradient(135deg, #0f172a 0%, #1e293b 50%, #0f172a 100%)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '20px',
      fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
      position: 'relative',
      overflow: 'hidden',
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
        input::placeholder { color: #64748b; }
        input:focus { outline: none; border-color: #fbbf24 !important; }
        button:hover { transform: translateY(-1px); }
        .email-form {
          max-height: 0;
          overflow: hidden;
          transition: max-height 0.3s ease-out, opacity 0.3s ease-out;
          opacity: 0;
        }
        .email-form.show {
          max-height: 400px;
          opacity: 1;
        }
      `}</style>

      {/* Background grid pattern */}
      <div style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundImage: 'radial-gradient(circle at 1px 1px, #334155 1px, transparent 0)',
        backgroundSize: '40px 40px',
        opacity: 0.4,
      }} />

      {/* Decorative gradient orbs */}
      <div style={{
        position: 'absolute',
        top: '-20%',
        right: '-10%',
        width: '600px',
        height: '600px',
        background: 'radial-gradient(circle, rgba(251, 191, 36, 0.1) 0%, transparent 70%)',
        borderRadius: '50%',
      }} />
      <div style={{
        position: 'absolute',
        bottom: '-20%',
        left: '-10%',
        width: '500px',
        height: '500px',
        background: 'radial-gradient(circle, rgba(59, 130, 246, 0.08) 0%, transparent 70%)',
        borderRadius: '50%',
      }} />

      {/* Login card */}
      <div style={{
        background: 'rgba(30, 41, 59, 0.8)',
        backdropFilter: 'blur(20px)',
        borderRadius: '24px',
        padding: '48px 40px',
        width: '100%',
        maxWidth: '420px',
        border: '1px solid rgba(71, 85, 105, 0.5)',
        position: 'relative',
        zIndex: 1,
        boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5)',
      }}>

        {/* Logo */}
        <div style={{ textAlign: 'center', marginBottom: '32px' }}>
          <img
            src="/logo.png"
            alt="ClassPilot"
            style={{
              width: '64px',
              height: '64px',
              borderRadius: '16px',
              marginBottom: '16px',
              boxShadow: '0 10px 30px rgba(251, 191, 36, 0.3)',
            }}
          />
          <h1 style={{
            fontSize: '28px',
            fontWeight: 700,
            color: '#f1f5f9',
            letterSpacing: '-0.5px',
            marginBottom: '8px',
          }}>
            ClassPilot
          </h1>
          <p style={{
            fontSize: '14px',
            color: '#94a3b8',
          }}>
            Sign in to your classroom dashboard
          </p>
        </div>

        {/* Main actions */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>

          {/* Google sign in - PRIMARY */}
          <button
            onClick={() => window.location.href = '/auth/google'}
            data-testid="button-google-login"
            style={{
              width: '100%',
              padding: '16px',
              fontSize: '16px',
              fontWeight: 600,
              borderRadius: '12px',
              border: 'none',
              background: '#fbbf24',
              color: '#0f172a',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '12px',
              transition: 'all 0.2s',
              boxShadow: '0 4px 14px rgba(251, 191, 36, 0.3)',
            }}
          >
            <svg width="20" height="20" viewBox="0 0 24 24">
              <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
              <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
              <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
              <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
            </svg>
            Sign in with Google
          </button>

          {/* Email login toggle link */}
          <button
            onClick={() => setShowEmailLogin(!showEmailLogin)}
            style={{
              background: 'none',
              border: 'none',
              color: '#64748b',
              fontSize: '13px',
              cursor: 'pointer',
              padding: '8px',
              transition: 'color 0.2s',
            }}
            onMouseOver={(e) => e.currentTarget.style.color = '#94a3b8'}
            onMouseOut={(e) => e.currentTarget.style.color = '#64748b'}
          >
            {showEmailLogin ? 'Hide email login' : 'Sign in with email instead'}
          </button>

          {/* Collapsible email/password form */}
          <div className={`email-form ${showEmailLogin ? 'show' : ''}`}>
            <form onSubmit={form.handleSubmit(onSubmit)} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>

              {/* Divider */}
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: '16px',
                margin: '4px 0',
              }}>
                <div style={{ flex: 1, height: '1px', background: '#475569' }} />
                <span style={{ fontSize: '12px', color: '#64748b' }}>email login</span>
                <div style={{ flex: 1, height: '1px', background: '#475569' }} />
              </div>

              {/* Email field */}
              <div>
                <label style={{
                  display: 'block',
                  fontSize: '14px',
                  fontWeight: 500,
                  color: '#e2e8f0',
                  marginBottom: '8px',
                }}>
                  Email
                </label>
                <input
                  type="email"
                  data-testid="input-email"
                  placeholder="you@school.edu"
                  {...form.register("email")}
                  style={{
                    width: '100%',
                    padding: '14px 16px',
                    fontSize: '15px',
                    borderRadius: '12px',
                    border: '1px solid #475569',
                    background: 'rgba(15, 23, 42, 0.6)',
                    color: '#f1f5f9',
                    transition: 'border-color 0.2s',
                  }}
                />
                {form.formState.errors.email && (
                  <p style={{ color: '#ef4444', fontSize: '13px', marginTop: '6px' }}>
                    {form.formState.errors.email.message}
                  </p>
                )}
              </div>

              {/* Password field */}
              <div>
                <label style={{
                  display: 'block',
                  fontSize: '14px',
                  fontWeight: 500,
                  color: '#e2e8f0',
                  marginBottom: '8px',
                }}>
                  Password
                </label>
                <input
                  type="password"
                  data-testid="input-password"
                  placeholder="Enter your password"
                  {...form.register("password")}
                  style={{
                    width: '100%',
                    padding: '14px 16px',
                    fontSize: '15px',
                    borderRadius: '12px',
                    border: '1px solid #475569',
                    background: 'rgba(15, 23, 42, 0.6)',
                    color: '#f1f5f9',
                    transition: 'border-color 0.2s',
                  }}
                />
                {form.formState.errors.password && (
                  <p style={{ color: '#ef4444', fontSize: '13px', marginTop: '6px' }}>
                    {form.formState.errors.password.message}
                  </p>
                )}
              </div>

              {/* Sign in button */}
              <button
                type="submit"
                data-testid="button-login"
                disabled={loginMutation.isPending}
                style={{
                  width: '100%',
                  padding: '14px',
                  fontSize: '15px',
                  fontWeight: 600,
                  borderRadius: '12px',
                  border: '1px solid #475569',
                  background: 'transparent',
                  color: '#f1f5f9',
                  cursor: loginMutation.isPending ? 'not-allowed' : 'pointer',
                  transition: 'all 0.2s',
                  opacity: loginMutation.isPending ? 0.7 : 1,
                }}
              >
                {loginMutation.isPending ? "Signing in..." : "Sign In with Email"}
              </button>
            </form>
          </div>
        </div>

        {/* Privacy note */}
        <div style={{
          marginTop: '28px',
          padding: '16px',
          background: 'rgba(15, 23, 42, 0.5)',
          borderRadius: '12px',
          border: '1px solid rgba(71, 85, 105, 0.3)',
        }}>
          <p style={{
            fontSize: '12px',
            color: '#94a3b8',
            textAlign: 'center',
            lineHeight: 1.5,
          }}>
            Privacy-aware classroom monitoring. All student monitoring is visible and disclosed.
          </p>
        </div>

        {/* Sign up link */}
        <p style={{
          marginTop: '24px',
          textAlign: 'center',
          fontSize: '14px',
          color: '#94a3b8',
        }}>
          Don't have an account?{' '}
          <Link href="/request-trial" style={{ color: '#fbbf24', textDecoration: 'none', fontWeight: 500 }}>
            Start free trial
          </Link>
        </p>
      </div>
    </div>
  );
}
