const bcrypt = require("bcryptjs");
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

const main = async () => {
  const email = "upload@velocityindia.net";
  const password = "ChangeMe123!";
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    console.log("Photographer already exists");
    return;
  }

  const hash = await bcrypt.hash(password, 10);
  await prisma.user.create({
    data: {
      uid: "TPP-001",
      name: "Third Party Photographer",
      email,
      designation: "Photographer",
      role: "PHOTOGRAPHER",
      passwordHash: hash,
      status: "ACTIVE"
    }
  });
  console.log("Photographer user created");
};

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
