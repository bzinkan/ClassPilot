declare module "redis" {
  export type RedisClientType = any;
  export function createClient(options?: any): RedisClientType;
}
