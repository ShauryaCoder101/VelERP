"use client";

import { useState } from "react";
import Link from "next/link";
import Wordmark from "../components/Wordmark";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");
    setBusy(true);

    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password })
    }).catch(() => null);

    if (!response) {
      setError("Could not reach the server. Check your connection and try again.");
      setBusy(false);
      return;
    }

    if (!response.ok) {
      setError("That email and password don't match an account.");
      setBusy(false);
      return;
    }

    window.location.href = "/";
  };

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-brand">
          <Wordmark />
        </div>

        <h1>Sign in</h1>
        <p className="muted">Use your Velocity work email.</p>

        <form className="auth-form" onSubmit={handleSubmit}>
          <label className="auth-label" htmlFor="email">Email</label>
          <input
            id="email"
            className="input"
            type="email"
            placeholder="name@velocityindia.net"
            autoComplete="email"
            autoFocus
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />

          <label className="auth-label" htmlFor="password">Password</label>
          <input
            id="password"
            className="input"
            type="password"
            placeholder="Enter your password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />

          {error ? <p className="auth-error" role="alert">{error}</p> : null}

          <button className="btn-primary auth-submit" type="submit" disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>

        <div className="auth-foot">
          <Link href="/forgot-password" className="link-button">Forgot password?</Link>
          <Link href="/tpp-login" className="link-button">Photographer upload</Link>
        </div>
      </div>
    </div>
  );
}
