/*
 * Adds the Client Servicing management trainees who report to Meera (GP-001).
 *
 * Strictly additive and idempotent: an existing email is reported and skipped,
 * never overwritten. Each account is created with a random password that is
 * never printed or stored anywhere — the trainee sets their own via
 * "Forgot password" on the login screen, which emails them a one-time code.
 *
 *   node scripts/seed-client-servicing.js          # dry run, changes nothing
 *   node scripts/seed-client-servicing.js --commit # actually writes
 */

const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();
const COMMIT = process.argv.includes("--commit");

const TRAINEES = [
  { uid: "MT-001", name: "Kavya", email: "kavya@velocityindia.net" },
  { uid: "MT-002", name: "Kartick", email: "kartick@velocityindia.net" },
  { uid: "MT-003", name: "Aditi", email: "aditi@velocityindia.net" }
];

const SHARED = {
  designation: "Management Trainee",
  role: "OPERATIONS_TEAM_MEMBER",
  team: "Client Servicing",
  status: "ACTIVE"
};

const main = async () => {
  console.log(COMMIT ? "MODE: commit\n" : "MODE: dry run (pass --commit to write)\n");

  for (const trainee of TRAINEES) {
    const existing = await prisma.user.findFirst({
      where: { OR: [{ email: trainee.email }, { uid: trainee.uid }] }
    });

    if (existing) {
      console.log(`skip   ${trainee.email} — already exists as ${existing.uid} (${existing.name})`);
      continue;
    }

    if (!COMMIT) {
      console.log(`would add ${trainee.uid} ${trainee.name} <${trainee.email}> — ${SHARED.designation}, ${SHARED.team}`);
      continue;
    }

    // Unguessable and immediately discarded; the trainee resets via OTP.
    const passwordHash = await bcrypt.hash(crypto.randomBytes(24).toString("base64url"), 10);

    await prisma.user.create({ data: { ...trainee, ...SHARED, passwordHash } });
    console.log(`added  ${trainee.uid} ${trainee.name} <${trainee.email}>`);
  }

  const team = await prisma.user.findMany({
    where: { team: "Client Servicing" },
    select: { uid: true, name: true, email: true, designation: true, role: true },
    orderBy: { uid: "asc" }
  });
  console.log(`\nClient Servicing roster (${team.length}):`);
  for (const u of team) console.log(`  ${u.uid}  ${u.name.padEnd(10)} ${u.email.padEnd(32)} ${u.designation}`);

  if (COMMIT && team.length > 0) {
    console.log('\nEach new account has no usable password yet.');
    console.log('Ask them to use "Forgot password" on the login page to set one.');
  }
};

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
