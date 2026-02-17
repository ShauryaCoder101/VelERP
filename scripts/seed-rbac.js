const bcrypt = require("bcryptjs");
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

const USERS = [
  {
    uid: "MD-001",
    name: "Aril Sharma",
    email: "arils@velocityindia.net",
    designation: "Managing Director",
    role: "MANAGING_DIRECTOR"
  },
  {
    uid: "HO-001",
    name: "Mohit Khera",
    email: "mohit@velocityindia.net",
    designation: "Head of Operations",
    role: "HEAD_OF_OPERATIONS"
  },
  {
    uid: "GP-001",
    name: "Meera",
    email: "meera.d@velocityindia.net",
    designation: "Growth Partner",
    role: "GROWTH_PARTNER"
  },
  {
    uid: "GP-002",
    name: "Vidyadhar Hegde",
    email: "vidyadhar@velocityindia.net",
    designation: "Growth Partner",
    role: "GROWTH_PARTNER"
  },
  {
    uid: "HSP-001",
    name: "Nikhil Shukla",
    email: "nikhil@velocityindia.net",
    designation: "Head of Special Projects",
    role: "HEAD_OF_SPECIAL_PROJECTS"
  },
  {
    uid: "OPS-001",
    name: "Shaurya Sharma",
    email: "shaurya@velocityindia.net",
    designation: "Operations Team Member",
    role: "OPERATIONS_TEAM_MEMBER"
  },
  {
    uid: "INT-001",
    name: "Pihu Jain",
    email: "pihu@gmail.com",
    designation: "Intern",
    role: "INTERN"
  }
];

const main = async () => {
  const defaultPassword = "ChangeMe123!";
  const hash = await bcrypt.hash(defaultPassword, 10);

  for (const user of USERS) {
    await prisma.user.upsert({
      where: { email: user.email },
      update: {
        uid: user.uid,
        name: user.name,
        designation: user.designation,
        role: user.role,
        status: "ACTIVE"
      },
      create: {
        uid: user.uid,
        name: user.name,
        email: user.email,
        designation: user.designation,
        role: user.role,
        passwordHash: hash,
        status: "ACTIVE"
      }
    });
  }

  console.log("RBAC users seeded.");
  console.log(`Default password for new users: ${defaultPassword}`);
};

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
