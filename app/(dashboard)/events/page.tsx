"use client";

import { useEffect, useMemo, useState } from "react";
import type { EventItem } from "../../../lib/events";

type VendorSummary = {
  id: string;
  companyName: string;
};

type ArtistSummary = {
  id: string;
  name: string;
};

const PHASES = ["Ideation", "Pitching", "Bidding", "Preparation", "Ongoing", "Finished"] as const;

const normalizePhase = (phase: string) => {
  const upper = phase.toUpperCase();
  switch (upper) {
    case "IDEATION":
      return "Ideation";
    case "PITCHING":
      return "Pitching";
    case "BIDDING":
      return "Bidding";
    case "PREPARATION":
      return "Preparation";
    case "ONGOING":
      return "Ongoing";
    case "FINISHED":
      return "Finished";
    default:
      return "Ideation";
  }
};

export default function EventsPage() {
  const [events, setEvents] = useState<EventItem[]>([]);
  const [vendors, setVendors] = useState<VendorSummary[]>([]);
  const [artists, setArtists] = useState<ArtistSummary[]>([]);
  const [vendorsEventId, setVendorsEventId] = useState<string | null>(null);
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [editEventId, setEditEventId] = useState<string | null>(null);
  const [vendorInput, setVendorInput] = useState("");
  const [finishOpen, setFinishOpen] = useState(false);
  const [finishArtistIds, setFinishArtistIds] = useState<string[]>([]);
  const [finishVendorIds, setFinishVendorIds] = useState<string[]>([]);
  const [newEvent, setNewEvent] = useState<EventItem>({
    id: "",
    companyName: "",
    eventName: "",
    pocName: "",
    pocPhone: "",
    phase: "Ideation",
    fromDate: "",
    toDate: "",
    vendorIds: [],
    artistIds: []
  });

  useEffect(() => {
    const loadData = async () => {
      const [eventsRes, vendorsRes, artistsRes] = await Promise.all([
        fetch("/api/events"),
        fetch("/api/vendors"),
        fetch("/api/artists")
      ]);
      if (eventsRes.ok) {
        const data = await eventsRes.json();
        setEvents(
          data.map((eventItem: any) => ({
            id: eventItem.id,
            companyName: eventItem.companyName,
            eventName: eventItem.eventName,
            pocName: eventItem.pocName,
            pocPhone: eventItem.pocPhone,
            phase: normalizePhase(eventItem.phase),
            fromDate: eventItem.fromDate.slice(0, 10),
            toDate: eventItem.toDate.slice(0, 10),
            vendorIds: (eventItem.vendors ?? []).map((ev: any) => ev.vendorId),
            artistIds: (eventItem.artists ?? []).map((ea: any) => ea.artistId)
          }))
        );
      }
      if (vendorsRes.ok) {
        const data = await vendorsRes.json();
        setVendors(
          data.map((vendor: any) => ({
            id: vendor.id,
            companyName: vendor.companyName
          }))
        );
      }
      if (artistsRes.ok) {
        const data = await artistsRes.json();
        setArtists(
          data.map((artist: any) => ({
            id: artist.id,
            name: artist.name
          }))
        );
      }
    };
    loadData();
  }, []);

  const sortedEvents = useMemo(() => {
    const phaseIndex = (phase: EventItem["phase"]) => PHASES.indexOf(phase);
    return [...events].sort((a, b) => phaseIndex(a.phase) - phaseIndex(b.phase));
  }, [events]);

  const vendorsForEvent = useMemo(() => {
    const target = events.find((eventItem) => eventItem.id === vendorsEventId);
    if (!target) return [];
    return vendors.filter((vendor) => target.vendorIds.includes(vendor.id));
  }, [vendorsEventId, events, vendors]);

  const handleAddEvent = () => {
    setIsAddOpen(true);
    setIsEditOpen(false);
    setEditEventId(null);
    setNewEvent({
      id: "",
      companyName: "",
      eventName: "",
      pocName: "",
      pocPhone: "",
      phase: "Ideation",
      fromDate: "",
      toDate: "",
      vendorIds: [],
      artistIds: []
    });
    setVendorInput("");
    setFinishArtistIds([]);
    setFinishVendorIds([]);
  };

  const handleEditEvent = (eventItem: EventItem) => {
    setIsEditOpen(true);
    setIsAddOpen(false);
    setEditEventId(eventItem.id);
    setNewEvent({ ...eventItem });
    const vendorNames = vendors
      .filter((vendor) => eventItem.vendorIds.includes(vendor.id))
      .map((vendor) => vendor.companyName)
      .join(", ");
    setVendorInput(vendorNames);
    if (eventItem.phase === "Finished") {
      setFinishOpen(true);
      setFinishVendorIds(eventItem.vendorIds);
      setFinishArtistIds(eventItem.artistIds ?? []);
    }
  };

  const handleCreateEvent = async () => {
    const vendorNames = vendorInput
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean);
    const selectedVendorIds = vendors
      .filter((vendor) => vendorNames.includes(vendor.companyName))
      .map((vendor) => vendor.id);
    const vendorIds =
      newEvent.phase === "Finished" && finishVendorIds.length > 0 ? finishVendorIds : selectedVendorIds;
    const artistIds = newEvent.phase === "Finished" ? finishArtistIds : [];
    const response = await fetch("/api/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        companyName: newEvent.companyName,
        eventName: newEvent.eventName,
        pocName: newEvent.pocName,
        pocPhone: newEvent.pocPhone,
        phase: newEvent.phase.toUpperCase(),
        fromDate: newEvent.fromDate,
        toDate: newEvent.toDate,
        vendorIds,
        artistIds
      })
    });
    if (!response.ok) return;
    const created = await response.json();
    setEvents((prev) => [
      {
        id: created.id,
        companyName: created.companyName,
        eventName: created.eventName,
        pocName: created.pocName,
        pocPhone: created.pocPhone,
        phase: normalizePhase(created.phase),
        fromDate: created.fromDate.slice(0, 10),
        toDate: created.toDate.slice(0, 10),
        vendorIds,
        artistIds
      },
      ...prev
    ]);
    setIsAddOpen(false);
    setVendorInput("");
    setFinishOpen(false);
    setFinishArtistIds([]);
    setFinishVendorIds([]);
  };

  const handleUpdateEvent = async () => {
    if (editEventId === null) return;
    const vendorNames = vendorInput
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean);
    const selectedVendorIds = vendors
      .filter((vendor) => vendorNames.includes(vendor.companyName))
      .map((vendor) => vendor.id);
    const vendorIds =
      newEvent.phase === "Finished" && finishVendorIds.length > 0 ? finishVendorIds : selectedVendorIds;
    const artistIds = newEvent.phase === "Finished" ? finishArtistIds : [];

    const response = await fetch(`/api/events/${editEventId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        companyName: newEvent.companyName,
        eventName: newEvent.eventName,
        pocName: newEvent.pocName,
        pocPhone: newEvent.pocPhone,
        phase: newEvent.phase.toUpperCase(),
        fromDate: newEvent.fromDate,
        toDate: newEvent.toDate,
        vendorIds,
        artistIds
      })
    });
    if (!response.ok) return;
    setEvents((prev) =>
      prev.map((eventItem) =>
        eventItem.id === editEventId
          ? { ...newEvent, id: editEventId, vendorIds, artistIds }
          : eventItem
      )
    );
    setIsEditOpen(false);
    setEditEventId(null);
    setVendorInput("");
    setFinishOpen(false);
    setFinishArtistIds([]);
    setFinishVendorIds([]);
  };

  return (
    <>
      <section className="page-header">
        <div>
          <h1>Events</h1>
          <p>Track all events with active ones on top.</p>
        </div>
      </section>

      <section className="panel">
        <div className="panel-header claims-header">
          <div>
            <h2>All Events</h2>
            <p className="muted">Active events are listed first.</p>
          </div>
          <div className="claims-actions">
            <button className="btn-outline hover-text" type="button" onClick={handleAddEvent}>
              Add Event
            </button>
          </div>
        </div>
        <div className="panel-body">
          <div className="table-wrap">
            <table className="events-table">
              <thead>
                <tr>
                  <th>S.No</th>
                  <th>Company Name</th>
                  <th>Event Name</th>
                  <th>POC Name</th>
                  <th>POC Ph No</th>
                  <th>Phase</th>
                  <th>From Date</th>
                  <th>To Date</th>
                  <th>Vendors Involved</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {sortedEvents.map((eventItem, index) => (
                  <tr key={eventItem.id}>
                    <td>{index + 1}</td>
                    <td>{eventItem.companyName}</td>
                    <td>{eventItem.eventName}</td>
                    <td>{eventItem.pocName}</td>
                    <td>{eventItem.pocPhone}</td>
                    <td>
                      <span className="phase-pill">{eventItem.phase}</span>
                    </td>
                    <td>{eventItem.fromDate}</td>
                    <td>{eventItem.toDate}</td>
                    <td>
                      <button
                        className="btn-outline hover-text"
                        type="button"
                        onClick={() => setVendorsEventId(eventItem.id)}
                      >
                        View Vendors
                      </button>
                    </td>
                    <td>
                      <button
                        className="btn-outline hover-text"
                        type="button"
                        onClick={() => handleEditEvent(eventItem)}
                      >
                        Edit
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {vendorsEventId ? (
        <div className="modal-overlay" role="dialog" aria-modal="true">
          <div className="modal-card">
            <h3>Vendors Involved</h3>
            <div className="history-list">
              {vendorsForEvent.length === 0 ? (
                <p className="muted">No vendors linked yet.</p>
              ) : (
                vendorsForEvent.map((vendor) => (
                  <div key={vendor.id} className="history-item">
                    {vendor.companyName}
                  </div>
                ))
              )}
            </div>
            <div className="modal-actions">
              <button className="btn-outline hover-text" type="button" onClick={() => setVendorsEventId(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {finishOpen ? (
        <div className="modal-overlay" role="dialog" aria-modal="true">
          <div className="modal-card">
            <h3>Finished Event Details</h3>
            <label className="auth-label" htmlFor="finish-artists">
              Artist Names (if any)
            </label>
            <select
              id="finish-artists"
              className="input select"
              multiple
              value={finishArtistIds}
              onChange={(event) => {
                const values = Array.from(event.target.selectedOptions).map((opt) => opt.value);
                setFinishArtistIds(values);
              }}
            >
              {artists.map((artist) => (
                <option key={artist.id} value={artist.id}>
                  {artist.name}
                </option>
              ))}
            </select>
            <label className="auth-label" htmlFor="finish-vendors">
              Vendor Names (if any)
            </label>
            <select
              id="finish-vendors"
              className="input select"
              multiple
              value={finishVendorIds}
              onChange={(event) => {
                const values = Array.from(event.target.selectedOptions).map((opt) => opt.value);
                setFinishVendorIds(values);
              }}
            >
              {vendors.map((vendor) => (
                <option key={vendor.id} value={vendor.id}>
                  {vendor.companyName}
                </option>
              ))}
            </select>
            <div className="modal-actions">
              <button className="btn-outline hover-text" type="button" onClick={() => setFinishOpen(false)}>
                Done
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {isAddOpen ? (
        <div className="modal-overlay" role="dialog" aria-modal="true">
          <div className="modal-card">
            <h3>Add Event</h3>
            <label className="auth-label" htmlFor="event-company">
              Company Name
            </label>
            <input
              id="event-company"
              className="input"
              value={newEvent.companyName}
              onChange={(event) => setNewEvent((prev) => ({ ...prev, companyName: event.target.value }))}
              placeholder="Company"
            />
            <label className="auth-label" htmlFor="event-name">
              Event Name
            </label>
            <input
              id="event-name"
              className="input"
              value={newEvent.eventName}
              onChange={(event) => setNewEvent((prev) => ({ ...prev, eventName: event.target.value }))}
              placeholder="Event"
            />
            <label className="auth-label" htmlFor="event-poc-name">
              POC Name
            </label>
            <input
              id="event-poc-name"
              className="input"
              value={newEvent.pocName}
              onChange={(event) => setNewEvent((prev) => ({ ...prev, pocName: event.target.value }))}
              placeholder="POC name"
            />
            <label className="auth-label" htmlFor="event-poc-phone">
              POC Ph No
            </label>
            <input
              id="event-poc-phone"
              className="input"
              value={newEvent.pocPhone}
              onChange={(event) => setNewEvent((prev) => ({ ...prev, pocPhone: event.target.value }))}
              placeholder="+91"
            />
            <label className="auth-label" htmlFor="event-phase">
              Phase
            </label>
            <select
              id="event-phase"
              className="input select"
              value={newEvent.phase}
              onChange={(event) => {
                const phase = event.target.value as EventItem["phase"];
                setNewEvent((prev) => ({ ...prev, phase }));
                if (phase === "Finished") {
                  setFinishOpen(true);
                } else {
                  setFinishOpen(false);
                  setFinishArtistIds([]);
                  setFinishVendorIds([]);
                }
              }}
            >
              {PHASES.map((phase) => (
                <option key={phase} value={phase}>
                  {phase}
                </option>
              ))}
            </select>
            <label className="auth-label" htmlFor="event-from">
              From Date
            </label>
            <input
              id="event-from"
              className="input"
              type="date"
              value={newEvent.fromDate}
              onChange={(event) => setNewEvent((prev) => ({ ...prev, fromDate: event.target.value }))}
            />
            <label className="auth-label" htmlFor="event-to">
              To Date
            </label>
            <input
              id="event-to"
              className="input"
              type="date"
              value={newEvent.toDate}
              onChange={(event) => setNewEvent((prev) => ({ ...prev, toDate: event.target.value }))}
            />
            <label className="auth-label" htmlFor="event-vendors">
              Vendors Involved
            </label>
            <input
              id="event-vendors"
              className="input"
              list="vendor-options"
              value={vendorInput}
              onChange={(event) => setVendorInput(event.target.value)}
              placeholder="Type vendor names, separated by commas"
            />
            <datalist id="vendor-options">
              {vendors.map((vendor) => (
                <option key={vendor.id} value={vendor.companyName} />
              ))}
            </datalist>
            <div className="modal-actions">
              <button className="btn-outline hover-text" type="button" onClick={() => setIsAddOpen(false)}>
                Cancel
              </button>
              <button className="btn-primary" type="button" onClick={handleCreateEvent}>
                Save Event
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {isEditOpen ? (
        <div className="modal-overlay" role="dialog" aria-modal="true">
          <div className="modal-card">
            <h3>Edit Event</h3>
            <label className="auth-label" htmlFor="edit-event-company">
              Company Name
            </label>
            <input
              id="edit-event-company"
              className="input"
              value={newEvent.companyName}
              onChange={(event) => setNewEvent((prev) => ({ ...prev, companyName: event.target.value }))}
              placeholder="Company"
            />
            <label className="auth-label" htmlFor="edit-event-name">
              Event Name
            </label>
            <input
              id="edit-event-name"
              className="input"
              value={newEvent.eventName}
              onChange={(event) => setNewEvent((prev) => ({ ...prev, eventName: event.target.value }))}
              placeholder="Event"
            />
            <label className="auth-label" htmlFor="edit-event-poc-name">
              POC Name
            </label>
            <input
              id="edit-event-poc-name"
              className="input"
              value={newEvent.pocName}
              onChange={(event) => setNewEvent((prev) => ({ ...prev, pocName: event.target.value }))}
              placeholder="POC name"
            />
            <label className="auth-label" htmlFor="edit-event-poc-phone">
              POC Ph No
            </label>
            <input
              id="edit-event-poc-phone"
              className="input"
              value={newEvent.pocPhone}
              onChange={(event) => setNewEvent((prev) => ({ ...prev, pocPhone: event.target.value }))}
              placeholder="+91"
            />
            <label className="auth-label" htmlFor="edit-event-phase">
              Phase
            </label>
            <select
              id="edit-event-phase"
              className="input select"
              value={newEvent.phase}
              onChange={(event) => {
                const phase = event.target.value as EventItem["phase"];
                setNewEvent((prev) => ({ ...prev, phase }));
                if (phase === "Finished") {
                  setFinishOpen(true);
                } else {
                  setFinishOpen(false);
                  setFinishArtistIds([]);
                  setFinishVendorIds([]);
                }
              }}
            >
              {PHASES.map((phase) => (
                <option key={phase} value={phase}>
                  {phase}
                </option>
              ))}
            </select>
            <label className="auth-label" htmlFor="edit-event-from">
              From Date
            </label>
            <input
              id="edit-event-from"
              className="input"
              type="date"
              value={newEvent.fromDate}
              onChange={(event) => setNewEvent((prev) => ({ ...prev, fromDate: event.target.value }))}
            />
            <label className="auth-label" htmlFor="edit-event-to">
              To Date
            </label>
            <input
              id="edit-event-to"
              className="input"
              type="date"
              value={newEvent.toDate}
              onChange={(event) => setNewEvent((prev) => ({ ...prev, toDate: event.target.value }))}
            />
            <label className="auth-label" htmlFor="edit-event-vendors">
              Vendors Involved
            </label>
            <input
              id="edit-event-vendors"
              className="input"
              list="vendor-options"
              value={vendorInput}
              onChange={(event) => setVendorInput(event.target.value)}
              placeholder="Type vendor names, separated by commas"
            />
            <div className="modal-actions">
              <button className="btn-outline hover-text" type="button" onClick={() => setIsEditOpen(false)}>
                Cancel
              </button>
              <button className="btn-primary" type="button" onClick={handleUpdateEvent}>
                Update Event
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
