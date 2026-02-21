const cards = ["Total Claims", "Pending Claims", "Active Vendors", "Upcoming Payouts"];

export default function AccountantDashboardPage() {
  return (
    <>
      <section className="page-header">
        <div>
          <h1>Accountant Dashboard</h1>
          <p>Financial overview for claims and vendor management.</p>
        </div>
      </section>

      <section className="stats-grid">
        {cards.map((title) => (
          <div key={title} className="stat-card">
            <div className="stat-icon" aria-hidden="true" />
            <div className="stat-content">
              <div className="stat-value">—</div>
              <div className="stat-label">{title}</div>
            </div>
            <div className="stat-trend">—</div>
          </div>
        ))}
      </section>

      <section className="grid-two">
        <div className="panel">
          <div className="panel-header">
            <h2>Recent Claims</h2>
          </div>
          <div className="panel-body" />
        </div>
        <div className="panel">
          <div className="panel-header">
            <h2>Upcoming Payouts</h2>
          </div>
          <div className="panel-body" />
        </div>
      </section>
    </>
  );
}
