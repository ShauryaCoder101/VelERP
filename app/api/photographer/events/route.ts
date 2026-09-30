import { getUploader } from "../../../../lib/rbac-server";
import { grantedEvents, quotaSummary } from "../../../../lib/photographers";

/* The whole of the ERP that a third-party photographer can see: the events an
   employee has handed them, and how much of their allowance is left.
 *
 * Employees are refused rather than served, so nobody wires an employee screen
 * to this and quietly makes it the source of truth for "my events". */
export async function GET(request: Request) {
  const uploader = await getUploader(request);
  if (!uploader) return new Response("Forbidden", { status: 403 });
  if (!uploader.isPhotographer) {
    return Response.json({ error: "This is for photographer accounts" }, { status: 403 });
  }

  const [events, quota] = await Promise.all([grantedEvents(uploader.id), quotaSummary(uploader.id)]);
  return Response.json({ events, quota });
}
