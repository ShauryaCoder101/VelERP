/* Seed the research sources from sources/research-sources.json.
 *
 *   node scripts/research-seed-sources.js
 *
 * Re-running is safe: rows are matched on (kind, identifier) and an existing row
 * keeps its `enabled` flag, its `lastPolledAt` and any backoff. Only the label
 * and poll interval are refreshed, so editing this file never silently switches
 * a live source back on - flip `enabled` through the API or the database for
 * that. Pass --force-enable to also restore the file's enabled flag.
 */

const fs = require("fs");
const path = require("path");
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();
const FILE = path.join(__dirname, "..", "sources", "research-sources.json");

const main = async () => {
  const forceEnable = process.argv.includes("--force-enable");
  const entries = JSON.parse(fs.readFileSync(FILE, "utf8"));

  let created = 0;
  let updated = 0;
  for (const entry of entries) {
    if (!entry.kind || !entry.identifier) continue;
    const where = { kind_identifier: { kind: entry.kind, identifier: entry.identifier } };
    const existing = await prisma.researchSource.findUnique({ where });

    if (!existing) {
      await prisma.researchSource.create({
        data: {
          kind: entry.kind,
          identifier: entry.identifier,
          label: entry.label ?? entry.identifier,
          enabled: entry.enabled !== false,
          pollIntervalMin: entry.pollIntervalMin ?? 60,
          settings: entry.settings ?? undefined
        }
      });
      created += 1;
      continue;
    }

    await prisma.researchSource.update({
      where,
      data: {
        label: entry.label ?? existing.label,
        pollIntervalMin: entry.pollIntervalMin ?? existing.pollIntervalMin,
        settings: entry.settings ?? existing.settings ?? undefined,
        ...(forceEnable ? { enabled: entry.enabled !== false } : {})
      }
    });
    updated += 1;
  }

  const total = await prisma.researchSource.count();
  console.log(`Research sources: ${created} created, ${updated} refreshed, ${total} in total.`);
};

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
