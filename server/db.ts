import { Pool as NeonPool, neonConfig } from '@neondatabase/serverless';
import { drizzle as neonDrizzle } from 'drizzle-orm/neon-serverless';
import ws from "ws";
import * as schema from "@shared/schema";

neonConfig.webSocketConstructor = ws;

const isTest = process.env.NODE_ENV === "test";

if (!process.env.DATABASE_URL && !isTest) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

type PoolLike = {
  query: (query: string, params?: any[]) => Promise<{ rows?: any[] }>;
};

type DbClient = ReturnType<typeof neonDrizzle>;

let pool: PoolLike | NeonPool;
let db: DbClient;

if (isTest) {
  pool = createTestSessionPool();
  db = {} as DbClient;
} else {
  pool = new NeonPool({ connectionString: process.env.DATABASE_URL });
  db = neonDrizzle(pool, { schema });
}

export { pool, db };

function createTestSessionPool(): PoolLike {
  const sessions = new Map<string, { sess: unknown; expire: number }>();
  let tableExists = false;

  return {
    async query(query, params = []) {
      const normalized = query.trim().toLowerCase();

      if (normalized.startsWith("select to_regclass")) {
        return { rows: [{ to_regclass: tableExists ? "session" : null }] };
      }

      if (normalized.startsWith("create table")) {
        tableExists = true;
        return { rows: [] };
      }

      if (normalized.startsWith("select sess from")) {
        const [sid, currentTimestamp] = params;
        const record = sessions.get(String(sid));
        if (!record || record.expire < Number(currentTimestamp)) {
          return { rows: [] };
        }
        return { rows: [{ sess: record.sess }] };
      }

      if (normalized.startsWith("insert into")) {
        const [sess, expire, sid] = params;
        sessions.set(String(sid), { sess, expire: Number(expire) });
        return { rows: [{ sid }] };
      }

      if (normalized.startsWith("update")) {
        const [expire, sid] = params;
        const record = sessions.get(String(sid));
        if (record) {
          record.expire = Number(expire);
        }
        return { rows: [{ sid }] };
      }

      if (normalized.startsWith("delete from")) {
        if (normalized.includes("where sid")) {
          const [sid] = params;
          sessions.delete(String(sid));
        } else {
          const [timestamp] = params;
          const cutoff = Number(timestamp);
          sessions.forEach((record, sid) => {
            if (record.expire < cutoff) {
              sessions.delete(sid);
            }
          });
        }
        return { rows: [] };
      }

      return { rows: [] };
    },
  };
}
