// Vitest globalSetup that points the PG-backed benchmarks/tests at an
// already-running local PostgreSQL cluster (configured with
// wal_level=logical), instead of spinning up a testcontainer. Used in
// environments that have a real Postgres but no container runtime.
//
// Override the connection string with PG_LOCAL_URI if needed.
const URI =
  process.env.PG_LOCAL_URI ?? 'postgresql://postgres@127.0.0.1:5439/postgres';

export default ({provide}: {provide: (k: string, v: string) => void}) => {
  provide('pgConnectionString', URI);
  provide('pgImage', 'local-postgres-16');
  provide('pgTimezone', 'UTC');
};
