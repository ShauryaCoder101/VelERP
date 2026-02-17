"use client";

import { useState } from "react";

export default function TppLoginPage() {
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
    if (data?.role !== "PHOTOGRAPHER") {
      setError("Access restricted to photographers.");
      return;
    }

    window.location.href = "/tpp-login/upload";
  };

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="brand">
          <img className="logo-image" src="/velocity-logo.png" alt="Velocity Logo" />
        </div>
        <h1>Photographer Uploads</h1>
        <p className="muted">Sign in to upload event photos.</p>
        <form onSubmit={handleSubmit} className="auth-form">
          <label className="auth-label" htmlFor="email">
            Email
          </label>
          <input
            id="email"
            className="input"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="upload@velocityindia.net"
            required
          />
          <label className="auth-label" htmlFor="password">
            Password
          </label>
          <input
            id="password"
            className="input"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="••••••••"
            required
          />
          {error ? <div className="auth-error">{error}</div> : null}
          <button className="btn-primary" type="submit">
            Login
          </button>
        </form>
      </div>
    </div>
  );
}
