import passport from "passport";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import type { Express } from "express";
import { storage } from "./storage";

export function setupGoogleAuth(app: Express) {
  // Construct full callback URL for Google OAuth
  const baseUrl = process.env.REPLIT_DEV_DOMAIN 
    ? `https://${process.env.REPLIT_DEV_DOMAIN}` 
    : 'http://localhost:5000';
  const callbackURL = `${baseUrl}/auth/google/callback`;
  
  console.log("Google OAuth callback URL:", callbackURL);
  
  // Google OAuth Strategy
  passport.use(
    new GoogleStrategy(
      {
        clientID: process.env.GOOGLE_CLIENT_ID!,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
        callbackURL: callbackURL,
      },
      async (accessToken, refreshToken, profile, done) => {
        try {
          const email = profile.emails?.[0]?.value;
          const googleId = profile.id;
          const displayName = profile.displayName;
          const profileImageUrl = profile.photos?.[0]?.value;

          if (!email) {
            return done(new Error("No email found in Google profile"));
          }

          // Look up user by email
          let user = await storage.getUserByEmail(email);

          if (user) {
            // Always update Google ID and profile info to keep data fresh
            user = await storage.updateUser(user.id, {
              googleId,
              profileImageUrl,
              displayName: displayName || user.displayName,
            });
            return done(null, user);
          }

          // User does not exist - REJECT auto-provisioning for security
          // Only pre-created users (by school admin/super admin) can log in
          return done(new Error(`Your account isn't set up yet. Ask your school administrator to create your account first, then sign in with Google.`));
        } catch (error) {
          console.error("Google OAuth error:", error);
          return done(error as Error);
        }
      }
    )
  );

  // Serialize user to session
  passport.serializeUser((user: any, done) => {
    done(null, user.id);
  });

  // Deserialize user from session
  passport.deserializeUser(async (id: string, done) => {
    try {
      const user = await storage.getUser(id);
      done(null, user);
    } catch (error) {
      done(error);
    }
  });

  // Initialize passport
  app.use(passport.initialize());
  app.use(passport.session());

  // Google OAuth routes
  app.get(
    "/auth/google",
    passport.authenticate("google", {
      scope: ["profile", "email"],
    })
  );

  app.get(
    "/auth/google/callback",
    passport.authenticate("google", {
      failureRedirect: "/login?error=google_auth_failed",
    }),
    (req, res) => {
      // Successful authentication - hydrate session with role and schoolId
      const user = req.user as any;
      if (user && req.session) {
        req.session.userId = user.id;
        req.session.role = user.role;
        req.session.schoolId = user.schoolId;
      }
      
      // Role-based redirect
      if (user.role === 'super_admin') {
        res.redirect("/super-admin/schools");
      } else if (user.role === 'school_admin') {
        res.redirect("/admin");
      } else {
        res.redirect("/dashboard");
      }
    }
  );
}
