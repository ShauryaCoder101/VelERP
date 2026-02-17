const bcrypt = require("bcryptjs");
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

const main = async () => {
  const email = "ajay.b@velocityindia.net";
  const password = "ChangeMe123!";
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    console.log("Accountant already exists");
    return;
  }

  const hash = await bcrypt.hash(password, 10);
  await prisma.user.create({
    data: {
      uid: "ACC-001",
      name: "Ajay B",
      email,
      designation: "Accountant",
      role: "ACCOUNTANT",
      passwordHash: hash,
      status: "ACTIVE"
    }
  });
  console.log("Accountant user created");
};

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
