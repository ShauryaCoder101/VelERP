"use client";

import { useEffect, useMemo, useState } from "react";

type EventOption = {
  id: string;
  eventName: string;
  companyName: string;
  phase: string;
};

type VendorOption = {
  id: string;
  companyName: string;
  gstin?: string | null;
};

type EventBill = {
  id: string;
  eventName: string;
  companyName: string;
  vendorName: string;
  vendorGstin?: string | null;
  date: string;
  work: string;
  amountPaid: number;
};

const VALID_PHASES = ["Preparation", "Ongoing", "Finished"];

export default function EventBillsPage() {
  const [events, setEvents] = useState<EventOption[]>([]);
  const [vendors, setVendors] = useState<VendorOption[]>([]);
  const [bills, setBills] = useState<EventBill[]>([]);
  const [isAddOpen, setIsAddOpen] = useState(false);

  const [eventId, setEventId] = useState("");
  const [vendorNameInput, setVendorNameInput] = useState("");
  const [vendorId, setVendorId] = useState("");
  const [vendorGstin, setVendorGstin] = useState("");
  const [date, setDate] = useState("");
  const [work, setWork] = useState("");
  const [amountPaid, setAmountPaid] = useState("");

  useEffect(() => {
    const loadData = async () => {
      const [eventsRes, vendorsRes, billsRes] = await Promise.all([
        fetch("/api/events"),
        fetch("/api/vendors"),
        fetch("/api/event-bills")
      ]);

      if (eventsRes.ok) {
        const data = await eventsRes.json();
        setEvents(
          data
            .map((eventItem: any) => ({
              id: eventItem.id,
              eventName: eventItem.eventName,
              companyName: eventItem.companyName,
              phase: eventItem.phase
            }))
            .filter((eventItem: EventOption) =>
              VALID_PHASES.includes(eventItem.phase.charAt(0) + eventItem.phase.slice(1).toLowerCase())
            )
        );
      }
      if (vendorsRes.ok) {
        const data = await vendorsRes.json();
        setVendors(
          data.map((vendor: any) => ({
            id: vendor.id,
            companyName: vendor.companyName,
            gstin: vendor.gstin
          }))
        );
      }
      if (billsRes.ok) {
        const data = await billsRes.json();
        setBills(
          data.map((bill: any) => ({
            id: bill.id,
            eventName: bill.event.eventName,
            companyName: bill.event.companyName,
            vendorName: bill.vendor.companyName,
            vendorGstin: bill.vendorGstin,
            date: bill.date,
            work: bill.work,
            amountPaid: bill.amountPaid
          }))
        );
      }
    };
    loadData();
  }, []);

  const filteredEvents = useMemo(() => {
    return events.filter((eventItem) =>
      VALID_PHASES.includes(eventItem.phase.charAt(0) + eventItem.phase.slice(1).toLowerCase())
    );
  }, [events]);

  const handleVendorInput = (value: string) => {
    setVendorNameInput(value);
    const vendor = vendors.find((item) => item.companyName === value);
    if (vendor) {
      setVendorId(vendor.id);
      setVendorGstin(vendor.gstin ?? "");
    }
  };

  const handleCreateBill = async () => {
    const response = await fetch("/api/event-bills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        eventId,
        vendorId,
        vendorGstin,
        date,
        work,
        amountPaid
      })
    });
    if (!response.ok) return;
    const created = await response.json();
    const event = events.find((eventItem) => eventItem.id === created.eventId);
    const vendor = vendors.find((item) => item.id === created.vendorId);
    setBills((prev) => [
      {
        id: created.id,
        eventName: event?.eventName ?? "",
        companyName: event?.companyName ?? "",
        vendorName: vendor?.companyName ?? "",
        vendorGstin: created.vendorGstin ?? "",
        date: created.date,
        work: created.work,
        amountPaid: created.amountPaid
      },
      ...prev
    ]);
    setIsAddOpen(false);
    setEventId("");
    setVendorNameInput("");
    setVendorId("");
    setVendorGstin("");
    setDate("");
    setWork("");
    setAmountPaid("");
  };

  return (
    <>
      <section className="page-header">
        <div>
          <h1>Event Bills</h1>
          <p>File bills for preparation, ongoing, and finished events.</p>
        </div>
      </section>

      <section className="panel">
        <div className="panel-header claims-header">
          <div>
            <h2>Event Bills</h2>
          </div>
          <div className="claims-actions">
            <button className="btn-outline hover-text" type="button" onClick={() => setIsAddOpen(true)}>
              Add Bill
            </button>
          </div>
        </div>
        <div className="panel-body">
          <div className="table-wrap">
            <table className="uploads-table">
              <thead>
                <tr>
                  <th>S.No</th>
                  <th>Event Name</th>
                  <th>Company</th>
                  <th>Vendor</th>
                  <th>GSTIN</th>
                  <th>Date</th>
                  <th>Work</th>
                  <th>Amount Paid</th>
                </tr>
              </thead>
              <tbody>
                {bills.length === 0 ? (
                  <tr>
                    <td colSpan={8}>
                      <div className="empty-state">No bills available.</div>
                    </td>
                  </tr>
                ) : (
                  bills.map((bill, index) => (
                    <tr key={bill.id}>
                      <td>{index + 1}</td>
                      <td>{bill.eventName}</td>
                      <td>{bill.companyName}</td>
                      <td>{bill.vendorName}</td>
                      <td>{bill.vendorGstin || "—"}</td>
                      <td>{new Date(bill.date).toLocaleDateString()}</td>
                      <td>{bill.work}</td>
                      <td>{bill.amountPaid.toFixed(2)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {isAddOpen ? (
        <div className="modal-overlay" role="dialog" aria-modal="true">
          <div className="modal-card">
            <h3>Add Bill</h3>
            <label className="auth-label" htmlFor="bill-event">
              Event Name
            </label>
            <select
              id="bill-event"
              className="input select"
              value={eventId}
              onChange={(event) => setEventId(event.target.value)}
            >
              <option value="">Select event</option>
              {filteredEvents.map((eventItem) => (
                <option key={eventItem.id} value={eventItem.id}>
                  {eventItem.eventName}
                </option>
              ))}
            </select>

            <label className="auth-label" htmlFor="bill-vendor">
              Vendor Name
            </label>
            <input
              id="bill-vendor"
              className="input"
              list="vendor-bill-options"
              value={vendorNameInput}
              onChange={(event) => handleVendorInput(event.target.value)}
              placeholder="Search vendor"
            />
            <datalist id="vendor-bill-options">
              {vendors.map((vendor) => (
                <option key={vendor.id} value={vendor.companyName} />
              ))}
            </datalist>

            <label className="auth-label" htmlFor="bill-gstin">
              Vendor GSTIN
            </label>
            <input id="bill-gstin" className="input" value={vendorGstin} readOnly />

            <label className="auth-label" htmlFor="bill-date">
              Date
            </label>
            <input id="bill-date" className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />

            <label className="auth-label" htmlFor="bill-work">
              Work
            </label>
            <input id="bill-work" className="input" value={work} onChange={(e) => setWork(e.target.value)} />

            <label className="auth-label" htmlFor="bill-amount">
              Amount Paid
            </label>
            <input
              id="bill-amount"
              className="input"
              type="number"
              min="0"
              value={amountPaid}
              onChange={(e) => setAmountPaid(e.target.value)}
            />

            <div className="modal-actions">
              <button className="btn-outline hover-text" type="button" onClick={() => setIsAddOpen(false)}>
                Cancel
              </button>
              <button className="btn-primary" type="button" onClick={handleCreateBill}>
                Save Bill
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
