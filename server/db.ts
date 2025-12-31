import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@shared/schema";

const { Pool } = pg;

const isTest = process.env.NODE_ENV === "test";

if (!process.env.DATABASE_URL && !isTest) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

type PoolLike = {
  query: (query: string, params?: any[]) => Promise<{ rows?: any[] }>;
};

let pool: InstanceType<typeof Pool> | PoolLike;
let db: ReturnType<typeof drizzle>;

if (isTest) {
  pool = createTestSessionPool();
  db = {} as ReturnType<typeof drizzle>;
} else {
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  db = drizzle(pool, { schema });
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
