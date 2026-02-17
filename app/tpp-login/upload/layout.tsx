import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getSessionUser } from "../../../lib/session";

type UploadLayoutProps = {
  children: ReactNode;
};

export default async function UploadLayout({ children }: UploadLayoutProps) {
  const cookieStore = await cookies();
  const session = cookieStore.get("velocity_session");
  if (!session) {
    redirect("/tpp-login");
  }

  const user = await getSessionUser(
    new Request("http://localhost", {
      headers: { cookie: cookieStore.toString() }
    })
  );
  if (!user || user.role !== "Photographer") {
    redirect("/tpp-login");
  }

  return (
    <div className="auth-page">
      <div className="auth-card upload-card">{children}</div>
    </div>
  );
}
