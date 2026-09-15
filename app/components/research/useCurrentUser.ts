"use client";

import { useEffect, useState } from "react";
import { getRoleLevel, normalizeRole, type Role } from "../../../lib/rbac";

/* Who is looking at the Research module?

   Six research screens each render the tab bar, and the Admin tab is only for
   the Managing Director, so every one of them needs the answer. The fetch is
   cached in module scope as a promise: the first screen to ask starts the
   request, every later screen (and every remount during a session) reuses it.
   A failed lookup is not cached, so a network blip does not permanently pin
   the module to "unknown". */

export type CurrentUser = {
  id: string;
  name: string;
  email: string;
  role: Role;
  level: number;
};

let cached: Promise<CurrentUser | null> | null = null;

const fetchCurrentUser = async (): Promise<CurrentUser | null> => {
  const response = await fetch("/api/auth/me");
  if (!response.ok) return null;
  const payload = (await response.json()) as {
    id?: string;
    name?: string;
    email?: string;
    role?: string;
  };
  const role = normalizeRole(String(payload.role ?? ""));
  return {
    id: String(payload.id ?? ""),
    name: String(payload.name ?? ""),
    email: String(payload.email ?? ""),
    role,
    /* An unrecognised role is treated as the lowest level, never as level 1. */
    level: getRoleLevel(role) ?? 4
  };
};

const loadCurrentUser = (): Promise<CurrentUser | null> => {
  if (!cached) {
    cached = fetchCurrentUser().catch(() => {
      cached = null;
      return null;
    });
  }
  return cached;
};

/** The signed-in user, or null once the lookup has failed. `loading` stays true
    until the answer is in — callers should assume no privilege while it is. */
export function useCurrentUser(): { user: CurrentUser | null; loading: boolean } {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    void loadCurrentUser().then((result) => {
      if (!alive) return;
      setUser(result);
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, []);

  return { user, loading };
}

export default useCurrentUser;
