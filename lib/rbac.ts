export const ROLE_LEVELS = {
  "Managing Director": 1,
  "Head of Operations": 2,
  "Head of Special Projects": 2,
  "Growth Partner": 2,
  "Operations Team Member": 3,
  "Research and Development Team Member": 3,
  Intern: 4,
  Assistant: 4,
  Freelancer: 4
} as const;

export type Role = keyof typeof ROLE_LEVELS;

export const ROLE_LEVEL_GROUPS: Record<number, Role[]> = {
  1: ["Managing Director"],
  2: ["Head of Operations", "Head of Special Projects", "Growth Partner"],
  3: ["Operations Team Member", "Research and Development Team Member"],
  4: ["Intern", "Assistant", "Freelancer"]
};

export const getRoleLevel = (role: Role) => ROLE_LEVELS[role];

export const hasAccess = (role: Role, minLevel: number) => getRoleLevel(role) <= minLevel;
