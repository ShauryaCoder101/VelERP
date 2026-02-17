const bcrypt = require("bcryptjs");
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

const main = async () => {
  const email = "arils@velocityindia.net";
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    console.log("User already exists");
    return;
  }

  const hash = await bcrypt.hash("ArilERP123", 10);
  await prisma.user.create({
    data: {
      uid: "MD-001",
      name: "Aril Sharma",
      email,
      designation: "Managing Director",
      role: "MANAGING_DIRECTOR",
      passwordHash: hash,
      status: "ACTIVE"
    }
  });
  console.log("User created");
};

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
