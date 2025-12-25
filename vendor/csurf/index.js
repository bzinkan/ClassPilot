import crypto from "crypto";

const DEFAULT_IGNORE_METHODS = ["GET", "HEAD", "OPTIONS"];
const DEFAULT_SESSION_KEY = "csrfSecret";

function generateSecret() {
  return crypto.randomBytes(32).toString("base64");
}

function generateToken(secret) {
  const salt = crypto.randomBytes(8).toString("base64url");
  const hash = crypto.createHmac("sha256", secret).update(salt).digest("base64url");
  return `${salt}.${hash}`;
}

function verifyToken(secret, token) {
  const [salt, signature] = typeof token === "string" ? token.split(".") : [];
  if (!salt || !signature) {
    return false;
  }
  const expected = crypto.createHmac("sha256", secret).update(salt).digest("base64url");
  const expectedBuffer = Buffer.from(expected);
  const signatureBuffer = Buffer.from(signature);
  if (expectedBuffer.length !== signatureBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(expectedBuffer, signatureBuffer);
}

function extractToken(req, value) {
  if (typeof value === "string" && value) {
    return value;
  }
  if (typeof req.headers["x-csrf-token"] === "string") {
    return req.headers["x-csrf-token"];
  }
  if (typeof req.headers["x-xsrf-token"] === "string") {
    return req.headers["x-xsrf-token"];
  }
  if (req.body && typeof req.body._csrf === "string") {
    return req.body._csrf;
  }
  if (req.query && typeof req.query._csrf === "string") {
    return req.query._csrf;
  }
  return undefined;
}

export default function csurf(options = {}) {
  const ignoreMethods = options.ignoreMethods || DEFAULT_IGNORE_METHODS;
  const sessionKey = options.sessionKey || DEFAULT_SESSION_KEY;

  return function csrfMiddleware(req, _res, next) {
    if (!req.session) {
      const error = new Error("CSRF requires sessions");
      error.code = "EBADCSRFTOKEN";
      return next(error);
    }

    if (!req.session[sessionKey]) {
      req.session[sessionKey] = generateSecret();
    }

    const secret = req.session[sessionKey];
    req.csrfToken = () => generateToken(secret);

    if (ignoreMethods.includes(req.method)) {
      return next();
    }

    const token = extractToken(req, req.headers["csrf-token"]);
    if (!token || !verifyToken(secret, token)) {
      const error = new Error("Invalid CSRF token");
      error.code = "EBADCSRFTOKEN";
      return next(error);
    }

    return next();
  };
}
