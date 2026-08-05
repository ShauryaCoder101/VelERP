"use client";

export default function SignOutButton() {
  const handleLogout = async () => {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    window.location.href = "/tpp-login";
  };

  return (
    <button className="link-button" type="button" onClick={handleLogout}>
      Sign out
    </button>
  );
}
