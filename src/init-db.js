import { initSchema, closeDb } from "./db.js";

async function main() {
  await initSchema();
  console.log("Database schema initialized.");
  await closeDb();
}

main().catch(async (err) => {
  console.error("Failed to initialize schema:", err);
  await closeDb().catch(() => {});
  process.exit(1);
});
