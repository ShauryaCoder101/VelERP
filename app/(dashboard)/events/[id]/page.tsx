"use client";

import { useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";

type UploadItem = {
  id: string;
  fileUrl: string;
  fileType: string;
  createdAt: string;
  user: { id: string; name: string };
};

type EventDetail = {
  id: string;
  companyName: string;
  eventName: string;
  pocName: string;
  pocPhone: string;
  phase: string;
  fromDate: string;
  toDate: string;
  vendors: { vendor: { id: string; companyName: string; phone: string; work: string; location?: string; gstin?: string } }[];
  artists: { artist: { id: string; name: string; phone: string; category: string; location?: string; socialLink?: string } }[];
  teamMembers: { user: { id: string; name: string; designation: string; email: string } }[];
  uploads: UploadItem[];
};

const phaseLabel = (p: string) => {
  const map: Record<string, string> = {
    IDEATION: "Ideation", PITCHING: "Pitching", BIDDING: "Bidding",
    PREPARATION: "Preparation", ONGOING: "Ongoing", FINISHED: "Finished"
  };
  return map[p] ?? p;
};

const phaseColor = (p: string): string => {
  const upper = (typeof p === "string" ? p : "").toUpperCase();
  switch (upper) {
    case "ONGOING": return "#16b65f";
    case "PREPARATION": return "#e89b0c";
    case "BIDDING": return "#3b82f6";
    case "PITCHING": return "#8b5cf6";
    case "FINISHED": return "#6b7280";
    default: return "#e1162a";
  }
};

const fmt = (iso: string) => {
  try { return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }); }
  catch { return iso; }
};

const isImage = (type: string) => type.startsWith("image/");

export default function EventDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);

  const [ev, setEv] = useState<EventDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState("");
  const [lightbox, setLightbox] = useState<string | null>(null);

  const loadEvent = () => {
    fetch(`/api/events/${id}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { setEv(d); setLoading(false); })
      .catch(() => setLoading(false));
  };

  useEffect(() => { loadEvent(); }, [id]);

  const handleUpload = async (files: FileList) => {
    if (!files.length || !ev) return;
    setUploading(true);
    const total = files.length;

    for (let i = 0; i < total; i++) {
      const file = files[i];
      setUploadProgress(`Uploading ${i + 1} of ${total}: ${file.name}`);

      try {
        const presignRes = await fetch("/api/uploads/presign", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fileName: file.name, fileType: file.type, eventId: ev.id })
        });
        if (!presignRes.ok) { setUploadProgress(`Failed to get upload URL for ${file.name}`); continue; }
        const { uploadUrl, fileUrl } = await presignRes.json();

        await fetch(uploadUrl, { method: "PUT", headers: { "Content-Type": file.type }, body: file });

        await fetch("/api/uploads", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ eventId: ev.id, fileUrl, fileType: file.type })
        });
      } catch {
        setUploadProgress(`Error uploading ${file.name}`);
      }
    }

    setUploading(false);
    setUploadProgress("");
    if (fileRef.current) fileRef.current.value = "";
    loadEvent();
  };

  if (loading) return <p style={{ padding: 32 }}>Loading...</p>;
  if (!ev) return <p style={{ padding: 32 }}>Event not found.</p>;

  const phase = phaseLabel(ev.phase);
  const color = phaseColor(ev.phase);
  const photos = ev.uploads.filter((u) => isImage(u.fileType));
  const otherFiles = ev.uploads.filter((u) => !isImage(u.fileType));

  return (
    <>
      <section className="page-header">
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button className="btn-outline hover-text" type="button" onClick={() => router.push("/events")} style={{ padding: "6px 14px" }}>
            ← Back
          </button>
          <div>
            <h1>{ev.eventName}</h1>
            <p>{ev.companyName}</p>
          </div>
          <span className="phase-pill" style={{ background: `${color}18`, color, marginLeft: "auto" }}>{phase}</span>
        </div>
      </section>

      <div className="event-detail-grid">
        <section className="panel">
          <div className="panel-header"><h2>Event Info</h2></div>
          <div className="panel-body">
            <dl className="detail-dl">
              <div><dt>Company</dt><dd>{ev.companyName}</dd></div>
              <div><dt>Event Name</dt><dd>{ev.eventName}</dd></div>
              <div><dt>POC Name</dt><dd>{ev.pocName}</dd></div>
              <div><dt>POC Phone</dt><dd>{ev.pocPhone}</dd></div>
              <div><dt>Start Date</dt><dd>{fmt(ev.fromDate)}</dd></div>
              <div><dt>End Date</dt><dd>{fmt(ev.toDate)}</dd></div>
              <div><dt>Phase</dt><dd><span className="phase-pill" style={{ background: `${color}18`, color }}>{phase}</span></dd></div>
            </dl>
          </div>
        </section>

        <section className="panel">
          <div className="panel-header"><h2>Velocity Team Members</h2></div>
          <div className="panel-body">
            {ev.teamMembers.length === 0 ? (
              <p className="muted">No team members linked.</p>
            ) : (
              <div className="detail-people-list">
                {ev.teamMembers.map((tm) => (
                  <div key={tm.user.id} className="detail-person-card">
                    <div className="avatar" style={{ width: 36, height: 36, fontSize: 14 }}>{tm.user.name.charAt(0)}</div>
                    <div>
                      <strong>{tm.user.name}</strong>
                      <span className="muted">{tm.user.designation}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>

        <section className="panel">
          <div className="panel-header"><h2>Vendors Involved</h2></div>
          <div className="panel-body">
            {ev.vendors.length === 0 ? (
              <p className="muted">No vendors linked.</p>
            ) : (
              <div className="detail-people-list">
                {ev.vendors.map((v) => (
                  <div key={v.vendor.id} className="detail-person-card">
                    <div className="avatar" style={{ width: 36, height: 36, fontSize: 14, background: "#3b82f6" }}>{v.vendor.companyName.charAt(0)}</div>
                    <div>
                      <strong>{v.vendor.companyName}</strong>
                      <span className="muted">{v.vendor.work}{v.vendor.location ? ` · ${v.vendor.location}` : ""}</span>
                      {v.vendor.phone && <span className="muted">{v.vendor.phone}</span>}
                      {v.vendor.gstin && <span className="muted">GSTIN: {v.vendor.gstin}</span>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>

        <section className="panel">
          <div className="panel-header"><h2>Artists Involved</h2></div>
          <div className="panel-body">
            {ev.artists.length === 0 ? (
              <p className="muted">No artists linked.</p>
            ) : (
              <div className="detail-people-list">
                {ev.artists.map((a) => (
                  <div key={a.artist.id} className="detail-person-card">
                    <div className="avatar" style={{ width: 36, height: 36, fontSize: 14, background: "#8b5cf6" }}>{a.artist.name.charAt(0)}</div>
                    <div>
                      <strong>{a.artist.name}</strong>
                      <span className="muted">{a.artist.category}{a.artist.location ? ` · ${a.artist.location}` : ""}</span>
                      {a.artist.phone && <span className="muted">{a.artist.phone}</span>}
                      {a.artist.socialLink && <Link href={a.artist.socialLink} target="_blank" className="muted hover-text">{a.artist.socialLink}</Link>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
      </div>

      {/* Upload & Photos section - full width */}
      <section className="panel" style={{ marginTop: 16 }}>
        <div className="panel-header claims-header">
          <h2>Event Photos & Files</h2>
          <div className="claims-actions" style={{ gap: 10 }}>
            {uploadProgress && <span className="muted">{uploadProgress}</span>}
            <input
              ref={fileRef}
              type="file"
              multiple
              accept="image/*,video/*,.pdf,.doc,.docx,.xls,.xlsx"
              style={{ display: "none" }}
              onChange={(e) => e.target.files && handleUpload(e.target.files)}
            />
            <button
              className="btn-primary"
              type="button"
              disabled={uploading}
              onClick={() => fileRef.current?.click()}
            >
              {uploading ? "Uploading…" : "Upload Photos"}
            </button>
          </div>
        </div>
        <div className="panel-body">
          {ev.uploads.length === 0 ? (
            <div className="empty-state">No photos or files uploaded yet.</div>
          ) : (
            <>
              {photos.length > 0 && (
                <div className="photo-gallery">
                  {photos.map((p) => (
                    <button key={p.id} type="button" className="photo-thumb" onClick={() => setLightbox(p.fileUrl)}>
                      <img src={p.fileUrl} alt="Event photo" loading="lazy" />
                      <div className="photo-thumb-info">
                        <span className="muted">{p.user.name}</span>
                        <span className="muted">{fmt(p.createdAt)}</span>
                      </div>
                    </button>
                  ))}
                </div>
              )}

              {otherFiles.length > 0 && (
                <div style={{ marginTop: photos.length > 0 ? 16 : 0 }}>
                  <h4 style={{ marginBottom: 8 }}>Other Files</h4>
                  <div className="detail-people-list">
                    {otherFiles.map((f) => (
                      <a key={f.id} href={f.fileUrl} target="_blank" rel="noopener noreferrer" className="detail-person-card hover-text">
                        <div className="avatar" style={{ width: 36, height: 36, fontSize: 14, background: "#6b7280" }}>
                          {f.fileType.split("/")[1]?.slice(0, 3).toUpperCase() ?? "FILE"}
                        </div>
                        <div>
                          <strong>{f.fileUrl.split("/").pop()}</strong>
                          <span className="muted">{f.user.name} · {fmt(f.createdAt)}</span>
                        </div>
                      </a>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </section>

      {lightbox && (
        <div className="modal-overlay" role="dialog" aria-modal="true" onClick={() => setLightbox(null)}>
          <div className="lightbox-container" onClick={(e) => e.stopPropagation()}>
            <button className="lightbox-close" type="button" onClick={() => setLightbox(null)}>×</button>
            <img src={lightbox} alt="Full size" className="lightbox-img" />
          </div>
        </div>
      )}
    </>
  );
}
