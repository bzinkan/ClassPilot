import type { RequestHandler } from "express";

interface CsurfOptions {
  ignoreMethods?: string[];
  sessionKey?: string;
}

declare function csurf(options?: CsurfOptions): RequestHandler;

declare module "express-serve-static-core" {
  interface Request {
    csrfToken(): string;
  }
}

export default csurf;
