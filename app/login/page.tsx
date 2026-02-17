"use client";

import { useState } from "react";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");
    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password })
    });

    if (!response.ok) {
      setError("Invalid email or password.");
      return;
    }

    const data = await response.json();
    const role = typeof data?.role === "string" ? data.role : "";
    if (role === "ACCOUNTANT") {
      window.location.href = "/accountant";
      return;
    }
    if (role === "PHOTOGRAPHER") {
      window.location.href = "/tpp-login/upload";
      return;
    }
    window.location.href = "/";
  };

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-brand">
          <img className="logo-image" src="/velocity-logo.png" alt="Velocity Logo" />
        </div>
        <h1>Sign in</h1>
        <p className="muted">Use your work email to access the ERP.</p>

        <form className="auth-form" onSubmit={handleSubmit}>
          <label className="auth-label" htmlFor="email">
            Email
          </label>
          <input
            id="email"
            className="input"
            type="email"
            placeholder="name@company.com"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />

          <label className="auth-label" htmlFor="password">
            Password
          </label>
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

          <button className="btn-primary auth-submit" type="submit">
            Sign in
          </button>
        </form>

        {error ? <p className="auth-error">{error}</p> : null}

        <button className="link-button hover-text" type="button">
          Forgot password?
        </button>
      </div>
    </div>
  );
}
