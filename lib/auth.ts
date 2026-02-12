import type { Role } from "./rbac";

export type User = {
  name: string;
  role: Role;
  uid: string;
  designation: string;
  email: string;
  team?: string;
};

export const currentUser: User = {
  name: "Aril Sharma",
  role: "Managing Director",
  uid: "MD-001",
  designation: "Managing Director",
  email: "arils@velocityindia.net"
};

export const teamMembers: User[] = [
  currentUser,
  {
    name: "Shaurya Sharma",
    role: "Operations Team Member",
    uid: "OPS-001",
    designation: "Operations Team Member",
    team: "Ops Team",
    email: "shaurya@velocityindia.net"
  }
];
