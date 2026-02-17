"use client";

import { useEffect, useMemo, useState } from "react";
import { getRoleLevel, normalizeRole } from "../../../lib/rbac";

type TeamMember = {
  id: string;
  name: string;
  role: string;
  designation: string;
  team?: string | null;
  email: string;
  status: "Active" | "Inactive";
};

type SessionUser = {
  id: string;
  role: string;
  name: string;
  email: string;
};

export default function TeamPage() {
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [sessionUser, setSessionUser] = useState<SessionUser | null>(null);
  const [assignMemberId, setAssignMemberId] = useState<string | null>(null);
  const [taskTitle, setTaskTitle] = useState("");
  const [taskNotes, setTaskNotes] = useState("");
  const [taskDue, setTaskDue] = useState("");

  useEffect(() => {
    const loadTeam = async () => {
      const response = await fetch("/api/team");
      if (!response.ok) return;
      const data = await response.json();
      setMembers(
        data.map((member: any) => ({
          id: member.id,
          name: member.name,
          role: normalizeRole(member.role),
          designation: member.designation,
          team: member.team,
          email: member.email,
          status: member.status === "ACTIVE" ? "Active" : "Inactive"
        }))
      );
    };
    const loadSession = async () => {
      const response = await fetch("/api/auth/me");
      if (!response.ok) return;
      const session = await response.json();
      setSessionUser({
        ...session,
        role: normalizeRole(session.role)
      });
    };
    loadTeam();
    loadSession();
  }, []);

  const currentUserLevel = useMemo(() => {
    if (!sessionUser) return 4;
    return getRoleLevel(sessionUser.role as any);
  }, [sessionUser]);
  const assignTarget = useMemo(
    () => members.find((member) => member.id === assignMemberId) ?? null,
    [assignMemberId, members]
  );

  const canAssignTo = (targetRole: string) => currentUserLevel < getRoleLevel(targetRole as any);

  const handleAssign = () => {
    if (!assignTarget) return;
    // Placeholder for API call to create task assigned to assignTarget.id
    // eslint-disable-next-line no-console
    fetch("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        assignedTo: assignTarget.id,
        title: taskTitle,
        notes: taskNotes,
        dueDate: taskDue
      })
    }).catch(() => null);
    setAssignMemberId(null);
    setTaskTitle("");
    setTaskNotes("");
    setTaskDue("");
  };

  return (
    <>
      <section className="page-header">
        <div>
          <h1>Team</h1>
          <p>All active Velocity team members and interns.</p>
        </div>
      </section>

      <section className="panel">
        <div className="panel-header claims-header">
          <div>
            <h2>Team Directory</h2>
            <p className="muted">
              Velocity staff use @velocityindia.net emails. Interns can use personal emails.
            </p>
          </div>
        </div>
        <div className="panel-body">
          <div className="table-wrap">
            <table className="team-table">
              <thead>
                <tr>
                  <th>S.No</th>
                  <th>Name</th>
                  <th>Role</th>
                  <th>Designation</th>
                  <th>Team</th>
                  <th>Email</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {members.map((member, index) => (
                  <tr key={member.id}>
                    <td>{index + 1}</td>
                    <td>{member.name}</td>
                    <td>{member.role}</td>
                    <td>{member.designation}</td>
                    <td>{member.team ?? "—"}</td>
                    <td>
                      <span className={member.email.endsWith("@velocityindia.net") ? "" : "email-pill"}>
                        {member.email}
                      </span>
                    </td>
                    <td>
                      <span className={`status-pill ${member.status === "Active" ? "active" : "inactive"}`}>
                        {member.status}
                      </span>
                    </td>
                    <td>
                      {canAssignTo(member.role) ? (
                        <button
                          className="btn-outline hover-text"
                          type="button"
                          onClick={() => setAssignMemberId(member.id)}
                        >
                          Assign Task
                        </button>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {assignTarget ? (
        <div className="modal-overlay" role="dialog" aria-modal="true">
          <div className="modal-card">
            <h3>Assign Task</h3>
            <p className="muted">
              Assigning to {assignTarget.name} ({assignTarget.role})
            </p>
            <label className="auth-label" htmlFor="task-title">
              Task Title
            </label>
            <input
              id="task-title"
              className="input"
              value={taskTitle}
              onChange={(event) => setTaskTitle(event.target.value)}
              placeholder="Enter task title"
            />
            <label className="auth-label" htmlFor="task-notes">
              Notes
            </label>
            <textarea
              id="task-notes"
              className="input textarea"
              rows={3}
              value={taskNotes}
              onChange={(event) => setTaskNotes(event.target.value)}
              placeholder="Add details"
            />
            <label className="auth-label" htmlFor="task-due">
              Due Date
            </label>
            <input
              id="task-due"
              className="input"
              type="date"
              value={taskDue}
              onChange={(event) => setTaskDue(event.target.value)}
            />
            <div className="modal-actions">
              <button className="btn-outline hover-text" type="button" onClick={() => setAssignMemberId(null)}>
                Cancel
              </button>
              <button className="btn-primary" type="button" onClick={handleAssign}>
                Assign
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
