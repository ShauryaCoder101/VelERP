import type { Role } from "./rbac";

export type TeamMember = {
  id: number;
  name: string;
  role: Role;
  designation: string;
  team?: string;
  email: string;
  status: "Active" | "Inactive";
};

export const teamMembers: TeamMember[] = [
  {
    id: 1,
    name: "Aril Sharma",
    role: "Managing Director",
    designation: "Managing Director",
    email: "arils@velocityindia.net",
    status: "Active"
  },
  {
    id: 2,
    name: "Shaurya Sharma",
    role: "Operations Team Member",
    designation: "Operations Team Member",
    team: "Ops Team",
    email: "shaurya@velocityindia.net",
    status: "Active"
  },
  {
    id: 3,
    name: "Priya Nair",
    role: "Head of Operations",
    designation: "Head of Operations",
    email: "priya.nair@velocityindia.net",
    status: "Active"
  },
  {
    id: 4,
    name: "Rohan Mehta",
    role: "Intern",
    designation: "Event Intern",
    team: "Ops Team",
    email: "rohan.mehta@gmail.com",
    status: "Active"
  }
];
