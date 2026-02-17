"use client";

import { useEffect, useMemo, useState } from "react";
import { currentUser } from "../../../lib/auth";

type RatingEntry = {
  id?: string;
  rating: number;
  remarks: string;
  by: string;
  date: string;
};

type Artist = {
  id: string;
  name: string;
  phone: string;
  category: string;
  location: string;
  socialLink: string;
  status: "Active" | "Inactive";
  currentEvent: string;
  lastEvent: string;
  onboardedAt: string;
  onboardedBy: string;
  ratings: RatingEntry[];
};

const createArtist = (): Artist => ({
  id: "",
  name: "",
  phone: "",
  category: "",
  location: "",
  socialLink: "",
  status: "Inactive",
  currentEvent: "",
  lastEvent: "",
  onboardedAt: new Date().toLocaleString(),
  onboardedBy: currentUser.name,
  ratings: []
});

export default function ArtistOnboardingPage() {
  const [artists, setArtists] = useState<Artist[]>([]);
  const [ratingArtistId, setRatingArtistId] = useState<string | null>(null);
  const [historyArtistId, setHistoryArtistId] = useState<string | null>(null);
  const [ratingValue, setRatingValue] = useState("5");
  const [ratingRemarks, setRatingRemarks] = useState("");
  const [deleteArtistId, setDeleteArtistId] = useState<string | null>(null);
  const [deleteConfirmText, setDeleteConfirmText] = useState("");
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [newArtist, setNewArtist] = useState<Artist>(createArtist());

  useEffect(() => {
    const loadArtists = async () => {
      const response = await fetch("/api/artists");
      if (!response.ok) return;
      const data = await response.json();
      const mapped = data.map((artist: any) => ({
        id: artist.id,
        name: artist.name,
        phone: artist.phone,
        category: artist.category,
        location: artist.location ?? "",
        socialLink: artist.socialLink ?? "",
        status: artist.status === "ACTIVE" ? "Active" : "Inactive",
        currentEvent: artist.currentEvent ?? "",
        lastEvent: artist.lastEvent ?? "",
        onboardedAt: new Date(artist.onboardedAt).toLocaleString(),
        onboardedBy: artist.onboardedByUser?.name ?? artist.onboardedBy,
        ratings: (artist.ratings ?? []).map((rating: any) => ({
          id: rating.id,
          rating: rating.rating,
          remarks: rating.remarks ?? "",
          by: rating.userId,
          date: new Date(rating.createdAt).toLocaleString()
        }))
      }));
      setArtists(mapped);
    };
    loadArtists();
  }, []);

  const ratingTarget = useMemo(
    () => artists.find((artist) => artist.id === ratingArtistId) ?? null,
    [ratingArtistId, artists]
  );

  const historyTarget = useMemo(
    () => artists.find((artist) => artist.id === historyArtistId) ?? null,
    [historyArtistId, artists]
  );

  const deleteTarget = useMemo(
    () => artists.find((artist) => artist.id === deleteArtistId) ?? null,
    [deleteArtistId, artists]
  );

  const getAverageRating = (ratings: RatingEntry[]) => {
    if (ratings.length === 0) return "—";
    const total = ratings.reduce((sum, entry) => sum + entry.rating, 0);
    return (total / ratings.length).toFixed(1);
  };

  const handleAddArtist = () => {
    setIsAddOpen(true);
    setNewArtist(createArtist());
  };

  const handleCreateArtist = async () => {
    const response = await fetch("/api/artists", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: newArtist.name,
        phone: newArtist.phone,
        category: newArtist.category,
        location: newArtist.location,
        socialLink: newArtist.socialLink,
        status: newArtist.status === "Active" ? "ACTIVE" : "INACTIVE",
        currentEvent: newArtist.currentEvent,
        lastEvent: newArtist.lastEvent
      })
    });
    if (!response.ok) return;
    const created = await response.json();
    setArtists((prev) => [
      {
        id: created.id,
        name: created.name,
        phone: created.phone,
        category: created.category,
        location: created.location ?? "",
        socialLink: created.socialLink ?? "",
        status: created.status === "ACTIVE" ? "Active" : "Inactive",
        currentEvent: created.currentEvent ?? "",
        lastEvent: created.lastEvent ?? "",
        onboardedAt: new Date(created.onboardedAt).toLocaleString(),
        onboardedBy: currentUser.name,
        ratings: []
      },
      ...prev
    ]);
    setIsAddOpen(false);
  };

  const handleRemoveArtist = async (id: string) => {
    const response = await fetch(`/api/artists/${id}`, { method: "DELETE" });
    if (!response.ok) return;
    setArtists((prev) => prev.filter((artist) => artist.id !== id));
  };

  const handleSubmitRating = async () => {
    if (!ratingTarget) return;
    const response = await fetch(`/api/artists/${ratingTarget.id}/ratings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rating: ratingValue, remarks: ratingRemarks })
    });
    if (!response.ok) return;
    const entry = await response.json();
    setArtists((prev) =>
      prev.map((artist) =>
        artist.id === ratingTarget.id
          ? {
              ...artist,
              ratings: [
                {
                  id: entry.id,
                  rating: entry.rating,
                  remarks: entry.remarks ?? "",
                  by: currentUser.name,
                  date: new Date(entry.createdAt).toLocaleString()
                },
                ...artist.ratings
              ]
            }
          : artist
      )
    );
    setRatingArtistId(null);
    setRatingRemarks("");
    setRatingValue("5");
  };

  useEffect(() => {
    const loadHistory = async () => {
      if (!historyTarget) return;
      const response = await fetch(`/api/artists/${historyTarget.id}/ratings`);
      if (!response.ok) return;
      const data = await response.json();
      setArtists((prev) =>
        prev.map((artist) =>
          artist.id === historyTarget.id
            ? {
                ...artist,
                ratings: data.map((entry: any) => ({
                  id: entry.id,
                  rating: entry.rating,
                  remarks: entry.remarks ?? "",
                  by: entry.user?.name ?? entry.userId,
                  date: new Date(entry.createdAt).toLocaleString()
                }))
              }
            : artist
        )
      );
    };
    loadHistory();
  }, [historyTarget]);

  return (
    <>
      <section className="page-header">
        <div>
          <h1>Artist Onboarding</h1>
          <p>Track artist onboarding, status, and ratings.</p>
        </div>
      </section>

      <section className="panel">
        <div className="panel-header claims-header">
          <div>
            <h2>Artists</h2>
            <p className="muted">Onboarded by: {currentUser.name}</p>
          </div>
          <div className="claims-actions">
            <button className="btn-outline hover-text" type="button" onClick={handleAddArtist}>
              Add Artist
            </button>
          </div>
        </div>
        <div className="panel-body">
          <div className="table-wrap">
            <table className="vendor-table">
              <thead>
                <tr>
                  <th>S.No</th>
                  <th>Artist Name</th>
                  <th>Ph No</th>
                  <th>Category</th>
                  <th>Location</th>
                  <th>Social Link</th>
                  <th>Status</th>
                  <th>Last Event</th>
                  <th>Rating</th>
                  <th>History</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {artists.length === 0 ? (
                  <tr>
                    <td colSpan={10}>
                      <div className="empty-state">No onboarded artists yet.</div>
                    </td>
                  </tr>
                ) : (
                  artists.map((artist, index) => (
                    <tr key={artist.id}>
                      <td>{index + 1}</td>
                      <td>{artist.name || "—"}</td>
                      <td>{artist.phone || "—"}</td>
                      <td>{artist.category || "—"}</td>
                      <td>{artist.location || "—"}</td>
                      <td>{artist.socialLink || "—"}</td>
                      <td>
                        <span className={`status-pill ${artist.status === "Active" ? "active" : "inactive"}`}>
                          {artist.status}
                        </span>
                        {artist.status === "Active" && artist.currentEvent ? (
                          <div className="cell-meta">Event: {artist.currentEvent}</div>
                        ) : null}
                        <div className="cell-meta">
                          Onboarded {artist.onboardedAt} by {artist.onboardedBy}
                        </div>
                      </td>
                      <td>{artist.lastEvent || "—"}</td>
                      <td>
                        <button
                          className="rating-button hover-text"
                          type="button"
                          onClick={() => setRatingArtistId(artist.id)}
                        >
                          {getAverageRating(artist.ratings)}
                        </button>
                      </td>
                      <td>
                        <button
                          className="link-button hover-text"
                          type="button"
                          onClick={() => setHistoryArtistId(artist.id)}
                        >
                          View
                        </button>
                      </td>
                      <td>
                        <button
                          className="row-remove"
                          type="button"
                          aria-label="Delete artist"
                          onClick={() => {
                            setDeleteArtistId(artist.id);
                            setDeleteConfirmText("");
                          }}
                        >
                          ×
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {ratingTarget ? (
        <div className="modal-overlay" role="dialog" aria-modal="true">
          <div className="modal-card">
            <h3>Rate Artist</h3>
            <p className="muted">{ratingTarget.name || "Artist"}</p>
            <label className="auth-label" htmlFor="rating">
              Rating (out of 5)
            </label>
            <select
              id="rating"
              className="input select"
              value={ratingValue}
              onChange={(event) => setRatingValue(event.target.value)}
            >
              {["5", "4", "3", "2", "1"].map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
            <label className="auth-label" htmlFor="remarks">
              Remarks
            </label>
            <textarea
              id="remarks"
              className="input textarea"
              rows={3}
              value={ratingRemarks}
              onChange={(event) => setRatingRemarks(event.target.value)}
              placeholder="Add remarks"
            />
            <div className="modal-actions">
              <button className="btn-outline hover-text" type="button" onClick={() => setRatingArtistId(null)}>
                Cancel
              </button>
              <button className="btn-primary" type="button" onClick={handleSubmitRating}>
                Save Rating
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {historyTarget ? (
        <div className="modal-overlay" role="dialog" aria-modal="true">
          <div className="modal-card">
            <h3>Rating History</h3>
            <p className="muted">{historyTarget.name || "Artist"}</p>
            <div className="history-list">
              {historyTarget.ratings.length === 0 ? (
                <p className="muted">No ratings yet.</p>
              ) : (
                historyTarget.ratings.map((entry, index) => (
                  <div key={`${entry.by}-${entry.date}-${index}`} className="history-item">
                    <div>
                      <strong>{entry.rating}/5</strong> by {entry.by}
                    </div>
                    <div className="muted">{entry.date}</div>
                    {entry.remarks ? <div>{entry.remarks}</div> : null}
                  </div>
                ))
              )}
            </div>
            <div className="modal-actions">
              <button className="btn-outline hover-text" type="button" onClick={() => setHistoryArtistId(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {deleteTarget ? (
        <div className="modal-overlay" role="dialog" aria-modal="true">
          <div className="modal-card">
            <h3>Delete Artist</h3>
            <p className="muted">
              Are you sure you want to delete <strong>{deleteTarget.name || "this artist"}</strong>?
            </p>
            <label className="auth-label" htmlFor="delete-confirm">
              Type DELETE to confirm
            </label>
            <input
              id="delete-confirm"
              className="input"
              value={deleteConfirmText}
              onChange={(event) => setDeleteConfirmText(event.target.value)}
              placeholder="DELETE"
            />
            <div className="modal-actions">
              <button
                className="btn-outline hover-text"
                type="button"
                onClick={() => setDeleteArtistId(null)}
              >
                Cancel
              </button>
              <button
                className="btn-primary"
                type="button"
                disabled={deleteConfirmText !== "DELETE"}
                onClick={() => {
                  if (!deleteTarget || deleteConfirmText !== "DELETE") return;
                  handleRemoveArtist(deleteTarget.id);
                  setDeleteArtistId(null);
                  setDeleteConfirmText("");
                }}
              >
                Delete Artist
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {isAddOpen ? (
        <div className="modal-overlay" role="dialog" aria-modal="true">
          <div className="modal-card">
            <h3>Add Artist</h3>
            <label className="auth-label" htmlFor="artist-name">
              Artist Name
            </label>
            <input
              id="artist-name"
              className="input"
              value={newArtist.name}
              onChange={(event) => setNewArtist((prev) => ({ ...prev, name: event.target.value }))}
              placeholder="Artist name"
            />
            <label className="auth-label" htmlFor="artist-phone">
              Phone
            </label>
            <input
              id="artist-phone"
              className="input"
              value={newArtist.phone}
              onChange={(event) => setNewArtist((prev) => ({ ...prev, phone: event.target.value }))}
              placeholder="Phone"
            />
            <label className="auth-label" htmlFor="artist-category">
              Category
            </label>
            <input
              id="artist-category"
              className="input"
              value={newArtist.category}
              onChange={(event) => setNewArtist((prev) => ({ ...prev, category: event.target.value }))}
              placeholder="Singer, DJ, Host..."
            />
            <label className="auth-label" htmlFor="artist-location">
              Location
            </label>
            <input
              id="artist-location"
              className="input"
              value={newArtist.location}
              onChange={(event) => setNewArtist((prev) => ({ ...prev, location: event.target.value }))}
              placeholder="City"
            />
            <label className="auth-label" htmlFor="artist-social">
              Social Media Link
            </label>
            <input
              id="artist-social"
              className="input"
              value={newArtist.socialLink}
              onChange={(event) => setNewArtist((prev) => ({ ...prev, socialLink: event.target.value }))}
              placeholder="https://"
            />
            <label className="auth-label" htmlFor="artist-status">
              Status
            </label>
            <select
              id="artist-status"
              className="input select"
              value={newArtist.status}
              onChange={(event) =>
                setNewArtist((prev) => ({ ...prev, status: event.target.value as Artist["status"] }))
              }
            >
              <option value="Active">Active</option>
              <option value="Inactive">Inactive</option>
            </select>
            {newArtist.status === "Active" ? (
              <>
                <label className="auth-label" htmlFor="artist-event">
                  Current Event
                </label>
                <input
                  id="artist-event"
                  className="input"
                  value={newArtist.currentEvent}
                  onChange={(event) => setNewArtist((prev) => ({ ...prev, currentEvent: event.target.value }))}
                  placeholder="Event name"
                />
              </>
            ) : null}
            <label className="auth-label" htmlFor="artist-last-event">
              Last Event
            </label>
            <input
              id="artist-last-event"
              className="input"
              value={newArtist.lastEvent}
              onChange={(event) => setNewArtist((prev) => ({ ...prev, lastEvent: event.target.value }))}
              placeholder="Previous event name"
            />
            <div className="modal-actions">
              <button className="btn-outline hover-text" type="button" onClick={() => setIsAddOpen(false)}>
                Cancel
              </button>
              <button className="btn-primary" type="button" onClick={handleCreateArtist}>
                Save Artist
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
