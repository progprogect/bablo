import { runMigrations } from "./runMigrations.js";

async function main() {
  console.log("Running migrations...");
  await runMigrations();
  console.log("Migrations complete.");
}

main().catch((error) => {
  console.error("Migration failed:", error);
  process.exit(1);
});
