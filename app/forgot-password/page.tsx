"use client";

import { useState } from "react";
import Link from "next/link";

type Step = "email" | "otp" | "done";

export default function ForgotPasswordPage() {
  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleRequestOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    const res = await fetch("/api/auth/forgot-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email })
    });

    setLoading(false);
    if (res.ok) {
      setStep("otp");
    } else {
      setError("Something went wrong. Please try again.");
    }
  };

  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (newPassword !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }
    if (newPassword.length < 6) {
      setError("Password must be at least 6 characters.");
      return;
    }

    setLoading(true);
    const res = await fetch("/api/auth/reset-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, otp, newPassword })
    });

    setLoading(false);
    if (res.ok) {
      setStep("done");
    } else {
      const data = await res.json().catch(() => ({}));
      setError(data.error || "Invalid or expired OTP. Please try again.");
    }
  };

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-brand">
          <img className="logo-image" src="/velocity-logo.png" alt="Velocity Logo" />
        </div>

        {step === "email" && (
          <>
            <h1>Forgot Password</h1>
            <p className="muted">Enter your email and we'll send you a one-time code to reset your password.</p>
            <form className="auth-form" onSubmit={handleRequestOtp}>
              <label className="auth-label" htmlFor="fp-email">Email</label>
              <input
                id="fp-email"
                className="input"
                type="email"
                placeholder="name@company.com"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              <button className="btn-primary auth-submit" type="submit" disabled={loading}>
                {loading ? "Sending…" : "Send OTP"}
              </button>
            </form>
          </>
        )}

        {step === "otp" && (
          <>
            <h1>Enter OTP</h1>
            <p className="muted">We sent a 6-digit code to <strong>{email}</strong>. Enter it below along with your new password.</p>
            <form className="auth-form" onSubmit={handleResetPassword}>
              <label className="auth-label" htmlFor="fp-otp">OTP Code</label>
              <input
                id="fp-otp"
                className="input"
                type="text"
                inputMode="numeric"
                maxLength={6}
                placeholder="123456"
                required
                value={otp}
                onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))}
                style={{ letterSpacing: "8px", fontSize: "20px", textAlign: "center", fontWeight: 700 }}
              />

              <label className="auth-label" htmlFor="fp-pw">New Password</label>
              <input
                id="fp-pw"
                className="input"
                type="password"
                placeholder="At least 6 characters"
                required
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
              />

              <label className="auth-label" htmlFor="fp-cpw">Confirm Password</label>
              <input
                id="fp-cpw"
                className="input"
                type="password"
                placeholder="Re-enter password"
                required
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
              />

              <button className="btn-primary auth-submit" type="submit" disabled={loading}>
                {loading ? "Resetting…" : "Reset Password"}
              </button>
            </form>
            <button className="link-button hover-text" type="button" onClick={() => { setStep("email"); setError(""); }}>
              ← Change email
            </button>
          </>
        )}

        {step === "done" && (
          <>
            <h1>Password Reset</h1>
            <p className="muted" style={{ marginBottom: 16 }}>Your password has been reset successfully. You can now sign in with your new password.</p>
            <Link href="/login" className="btn-primary auth-submit" style={{ display: "block", textAlign: "center", textDecoration: "none" }}>
              Back to Sign In
            </Link>
          </>
        )}

        {error && <p className="auth-error">{error}</p>}

        {step !== "done" && (
          <Link href="/login" className="link-button hover-text" style={{ marginTop: 8, display: "inline-block" }}>
            ← Back to Sign In
          </Link>
        )}
      </div>
    </div>
  );
}
