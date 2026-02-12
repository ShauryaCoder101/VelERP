const statsCards = [
  { title: "Total Events" },
  { title: "Active Vendors" },
  { title: "Pending Claims" },
  { title: "Team Members" }
];

const activityItems = [
  "Activity item",
  "Activity item",
  "Activity item",
  "Activity item",
  "Activity item"
];

const quickActions = ["Create Event", "Add Vendor", "File Claim", "Upload Files"];

export default function DashboardPage() {
  return (
    <>
      <section className="page-header">
        <div>
          <h1>My Dashboard</h1>
          <p>Welcome back. Here&apos;s your overview.</p>
        </div>
      </section>

      <section className="stats-grid">
        {statsCards.map((card) => (
          <div key={card.title} className="stat-card">
            <div className="stat-icon" aria-hidden="true" />
            <div className="stat-content">
              <div className="stat-value">—</div>
              <div className="stat-label">{card.title}</div>
            </div>
            <div className="stat-trend">—</div>
          </div>
        ))}
      </section>

      <section className="grid-two">
        <div className="panel">
          <div className="panel-header">
            <h2>Recent Activity</h2>
          </div>
          <div className="panel-body">
            <ul className="activity-list">
              {activityItems.map((item, index) => (
                <li key={`${item}-${index}`} className="activity-item">
                  <span className="hover-text">{item}</span>
                  <span className="activity-time">Time</span>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="panel">
          <div className="panel-header">
            <h2>Quick Actions</h2>
          </div>
          <div className="panel-body">
            <div className="actions-grid">
              {quickActions.map((action) => (
                <button key={action} className="action-card hover-text" type="button">
                  <span className="action-icon" aria-hidden="true" />
                  <span>{action}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
