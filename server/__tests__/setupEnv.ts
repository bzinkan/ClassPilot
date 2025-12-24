if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = "test";
}

if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = "postgres://postgres:postgres@localhost:5432/postgres";
}
