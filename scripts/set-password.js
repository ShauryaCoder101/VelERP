/*
 * Set a password for one or more users.
 *
 * The password is passed in at run time and is never written to this file, so
 * it does not end up in git history.
 *
 *   node scripts/set-password.js "<password>" a@x.net b@x.net           # dry run
 *   node scripts/set-password.js "<password>" a@x.net b@x.net --commit
 *
 * Note that giving several people the same password removes any ability to
 * tell their actions apart in the audit trail — uploads, claims and edits are
 * all recorded against whoever's account was used. Prefer having each person
 * set their own via "Forgot password" once they are in.
 */

const bcrypt = require("bcryptjs");
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();
const args = process.argv.slice(2);
const COMMIT = args.includes("--commit");
const [password, ...emails] = args.filter((a) => a !== "--commit");

const main = async () => {
  if (!password || emails.length === 0) {
    console.log('usage: node scripts/set-password.js "<password>" <email> [<email>...] [--commit]');
    process.exitCode = 1;
    return;
  }

  console.log(COMMIT ? "MODE: commit\n" : "MODE: dry run (pass --commit to write)\n");

  const hash = COMMIT ? await bcrypt.hash(password, 10) : null;
  let changed = 0;
  let missing = 0;

  for (const email of emails) {
    const user = await prisma.user.findFirst({
      where: { email },
      select: { id: true, uid: true, name: true, email: true }
    });

    if (!user) {
      console.log(`not found  ${email}`);
      missing++;
      continue;
    }

    if (!COMMIT) {
      console.log(`would set  ${user.uid}  ${user.name.padEnd(10)} ${user.email}`);
      changed++;
      continue;
    }

    await prisma.user.update({ where: { id: user.id }, data: { passwordHash: hash } });
    console.log(`set        ${user.uid}  ${user.name.padEnd(10)} ${user.email}`);
    changed++;
  }

  console.log(`\n${changed} updated, ${missing} not found`);
};

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
