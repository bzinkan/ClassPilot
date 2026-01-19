import passport from "passport";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import type { Express } from "express";
import { storage } from "./storage";
import { getBaseUrl } from "./config/baseUrl";
import { isSchoolLicenseActive } from "./middleware/authz";

export function setupGoogleAuth(app: Express) {
  // ⛔ Skip Google OAuth entirely during tests/CI (prevents missing clientID crashes)
  if (process.env.NODE_ENV === "test" || process.env.VITEST) {
    return;
  }

  // Read required env vars safely (no non-null assertions)
  const clientID = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  // Construct full callback URL for Google OAuth
  const baseUrl = getBaseUrl();
  const callbackURL = `${baseUrl}/auth/google/callback`;

  const classroomScopes = [
    "profile",
    "email",
    "https://www.googleapis.com/auth/classroom.courses.readonly",
    "https://www.googleapis.com/auth/classroom.rosters.readonly",
    "https://www.googleapis.com/auth/classroom.profile.emails",
    "https://www.googleapis.com/auth/admin.directory.user.readonly",
    "https://www.googleapis.com/auth/admin.directory.orgunit.readonly",
  ];

  // ⛔ If not configured (local dev / misconfigured env), skip setup instead of crashing
  if (!clientID || !clientSecret || !callbackURL) {
    console.warn(
      "[googleAuth] Missing GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET or callback URL; skipping Google OAuth setup."
    );
    return;
  }

  console.log("Google OAuth callback URL:", callbackURL);

  // Google OAuth Strategy
  passport.use(
    new GoogleStrategy(
      {
        clientID,
        clientSecret,
        callbackURL,
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
            const updatedUser = await storage.updateUser(user.id, {
              googleId,
              profileImageUrl,
              displayName: displayName || user.displayName,
            });

            if (!updatedUser) {
              return done(new Error("Failed to update user from Google profile"));
            }

            user = updatedUser;

            if (refreshToken) {
              await storage.upsertGoogleOAuthTokens(user.id, {
                refreshToken,
                scope: classroomScopes.join(" "),
                tokenType: "Bearer",
              });
            }

            return done(null, user);
          }

          // User does not exist - REJECT auto-provisioning for security
          // Only pre-created users (by school admin/super admin) can log in
          return done(
            new Error(
              `Your account isn't set up yet. Ask your school administrator to create your account first, then sign in with Google.`
            )
          );
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
      scope: classroomScopes,
      accessType: "offline",
      prompt: "consent",
    })
  );

  app.get(
    "/auth/google/callback",
    passport.authenticate("google", {
      failureRedirect: "/login?error=google_auth_failed",
    }),
    async (req, res) => {
      // Successful authentication - hydrate session with role and schoolId
      const user = req.user as any;

      if (user && req.session) {
        req.session.userId = user.id;
        req.session.role = user.role;
        req.session.schoolId = user.schoolId;

        if (user.schoolId) {
          const school = await storage.getSchool(user.schoolId);
          if (!school || !isSchoolLicenseActive(school)) {
            return req.session.destroy(() => {
              res.redirect("/login?error=school_inactive");
            });
          }
          req.session.schoolSessionVersion = school.schoolSessionVersion;
        }
      }

      // Role-based redirect
      if (user.role === "super_admin") {
        res.redirect("/super-admin/schools");
      } else if (user.role === "school_admin") {
        res.redirect("/admin");
      } else {
        res.redirect("/dashboard");
      }
    }
  );
}
