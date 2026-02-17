export const ROLE_LEVELS = {
  "Managing Director": 1,
  "Head of Operations": 2,
  "Head of Special Projects": 2,
  "Growth Partner": 2,
  "Operations Team Member": 3,
  "Research and Development Team Member": 3,
  Accountant: 3,
  Photographer: 4,
  Intern: 4,
  Assistant: 4,
  Freelancer: 4
} as const;

export type Role = keyof typeof ROLE_LEVELS;

export const ROLE_DB_MAP: Record<string, Role> = {
  MANAGING_DIRECTOR: "Managing Director",
  HEAD_OF_OPERATIONS: "Head of Operations",
  HEAD_OF_SPECIAL_PROJECTS: "Head of Special Projects",
  GROWTH_PARTNER: "Growth Partner",
  OPERATIONS_TEAM_MEMBER: "Operations Team Member",
  RESEARCH_AND_DEVELOPMENT_TEAM_MEMBER: "Research and Development Team Member",
  ACCOUNTANT: "Accountant",
  PHOTOGRAPHER: "Photographer",
  INTERN: "Intern",
  ASSISTANT: "Assistant",
  FREELANCER: "Freelancer"
};

export const normalizeRole = (role: string): Role => ROLE_DB_MAP[role] ?? (role as Role);

export const ROLE_LEVEL_GROUPS: Record<number, Role[]> = {
  1: ["Managing Director"],
  2: ["Head of Operations", "Head of Special Projects", "Growth Partner"],
  3: ["Operations Team Member", "Research and Development Team Member", "Accountant"],
  4: ["Intern", "Assistant", "Freelancer", "Photographer"]
};

export const getRoleLevel = (role: Role) => ROLE_LEVELS[role];

export const hasAccess = (role: Role, minLevel: number) => getRoleLevel(role) <= minLevel;
