declare module "helmet" {
  import type { RequestHandler } from "express";

  type HelmetOptions = Record<string, unknown>;
  const helmet: (options?: HelmetOptions) => RequestHandler;
  export default helmet;
}
