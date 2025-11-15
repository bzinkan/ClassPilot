import passport from "passport";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import type { Express } from "express";
import { storage } from "./storage";

export function setupGoogleAuth(app: Express) {
  // Google OAuth Strategy
  passport.use(
    new GoogleStrategy(
      {
        clientID: process.env.GOOGLE_CLIENT_ID!,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
        callbackURL: "/auth/google/callback",
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
            // Update Google ID and profile info if missing
            if (!user.googleId) {
              user = await storage.updateUser(user.id, {
                googleId,
                profileImageUrl,
              });
            }
            return done(null, user);
          }

          // User does not exist - parse domain and attempt auto-creation
          const emailDomain = email.split("@")[1]?.toLowerCase();
          if (!emailDomain) {
            return done(new Error("Invalid email format"));
          }

          // Try to find school by domain
          const school = await storage.getSchoolByDomain(emailDomain);
          
          if (!school) {
            // No school found for this domain - show clear error
            return done(new Error(`Your account isn't set up yet. No school configured for domain: ${emailDomain}. Ask your school admin to invite you.`));
          }

          // Auto-create user as teacher in the matched school
          const newUser = await storage.createUser({
            email,
            googleId,
            displayName,
            profileImageUrl,
            role: "teacher",
            schoolId: school.id,
          });

          return done(null, newUser);
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
      // Successful authentication - redirect to dashboard
      res.redirect("/");
    }
  );
}
