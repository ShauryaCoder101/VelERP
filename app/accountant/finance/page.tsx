"use client";

import { useEffect, useMemo, useState } from "react";

type Claim = {
  id: string;
  userName: string;
  submittedAt: string;
  totalAmount: number;
};

type FinanceEvent = {
  id: string;
  eventName: string;
  claims: Claim[];
};

export default function FinancePage() {
  const [events, setEvents] = useState<FinanceEvent[]>([]);
  const [activeEventId, setActiveEventId] = useState<string | null>(null);

  useEffect(() => {
    const loadData = async () => {
      const response = await fetch("/api/finance/events");
      if (!response.ok) return;
      const data = await response.json();
      setEvents(
        data.map((eventItem: any) => ({
          id: eventItem.id,
          eventName: eventItem.eventName,
          claims: (eventItem.claims ?? []).map((claim: any) => ({
            id: claim.id,
            userName: claim.user?.name ?? "",
            submittedAt: claim.submittedAt,
            totalAmount: (claim.items ?? []).reduce(
              (sum: number, item: any) => sum + Number(item.amount),
              0
            )
          }))
        }))
      );
    };
    loadData();
  }, []);

  const selectedEvent = useMemo(
    () => events.find((eventItem) => eventItem.id === activeEventId) ?? null,
    [events, activeEventId]
  );

  const totalClaims = (eventItem: FinanceEvent) =>
    eventItem.claims.reduce((sum, claim) => sum + claim.totalAmount, 0);

  return (
    <>
      <section className="page-header">
        <div>
          <h1>Finance</h1>
          <p>Completed events with cost and profitability.</p>
        </div>
      </section>

      <section className="finance-grid">
        {events.map((eventItem) => (
          <button
            key={eventItem.id}
            className="finance-card"
            type="button"
            onClick={() => setActiveEventId(eventItem.id)}
          >
            <h3>{eventItem.eventName}</h3>
            <p className="muted">Claims: {eventItem.claims.length}</p>
            <p className="muted">Total Amount: {totalClaims(eventItem).toFixed(2)}</p>
          </button>
        ))}
      </section>

      {selectedEvent ? (
        <section className="panel">
          <div className="panel-header">
            <h2>{selectedEvent.eventName} Details</h2>
          </div>
          <div className="panel-body">
            <div className="grid-two">
              <div className="panel">
                <div className="panel-header">
                  <h3>Expense Claims</h3>
                </div>
                <div className="panel-body">
                  {selectedEvent.claims.length === 0 ? (
                    <div className="empty-state">No claims filed.</div>
                  ) : (
                    <table className="uploads-table">
                      <thead>
                        <tr>
                          <th>Employee</th>
                          <th>Submitted</th>
                          <th>Total Amount</th>
                        </tr>
                      </thead>
                      <tbody>
                        {selectedEvent.claims.map((claim) => (
                          <tr key={claim.id}>
                            <td>{claim.userName}</td>
                            <td>{new Date(claim.submittedAt).toLocaleDateString()}</td>
                            <td>{claim.totalAmount.toFixed(2)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </div>
            </div>
          </div>
        </section>
      ) : null}
    </>
  );
}
