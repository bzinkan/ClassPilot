import "express";

declare module "express" {
  interface Request {
    rateLimit?: {
      limit: number;
      remaining: number;
      resetTime?: Date;
    };
  }
}

export {};
