export default function LoginPage() {
  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-brand">
          <span className="logo-badge">E</span>
          <span className="brand-name">ERPSuite</span>
        </div>
        <h1>Sign in</h1>
        <p className="muted">Use your work email to access the ERP.</p>

        <form className="auth-form">
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
          />

          <button className="btn-primary auth-submit" type="submit">
            Sign in
          </button>
        </form>

        <button className="link-button hover-text" type="button">
          Forgot password?
        </button>
      </div>
    </div>
  );
}
"use client";

export default function LoginPage() {
  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-header">
          <span className="logo-badge">E</span>
          <div>
            <h1>Welcome Back</h1>
            <p>Sign in to your ERPSuite account.</p>
          </div>
        </div>

        <form className="auth-form">
          <label className="auth-label" htmlFor="email">
            Email
          </label>
          <input
            id="email"
            className="input"
            type="email"
            placeholder="name@company.com"
            required
          />

          <label className="auth-label" htmlFor="password">
            Password
          </label>
          <input
            id="password"
            className="input"
            type="password"
            placeholder="Enter your password"
            required
          />

          <button className="btn-primary auth-submit" type="submit">
            Sign In
          </button>
          <button className="link-button hover-text" type="button">
            Forgot password?
          </button>
        </form>
      </div>
    </div>
  );
}
