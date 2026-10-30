import { cookies } from "next/headers";
import { projectWorkspace } from "@/core/workspace-snapshot";
import { AccessError, getStore } from "@/data/store";
import { ownerFromToken, sessionCookie } from "@/core/security";

export const runtime = "nodejs";

/**
 * Versioned, read-only frontend integration surface. The engine still owns
 * state and all mutations continue through the authenticated turn endpoints.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const token = (await cookies()).get(sessionCookie)?.value;

  if (!token) {
    return Response.json({ error: "Session required." }, { status: 401 });
  }

  try {
    const { id } = await context.params;
    const owner = ownerFromToken(token);
    const store = getStore();
    store.recoverExpiredTurns(id, owner);
    const task = store.load(id, owner);

    return Response.json(projectWorkspace(task), {
      headers: {
        "Cache-Control": "private, no-store",
        "X-Igor-Contract-Version": "1",
      },
    });
  } catch (error) {
    if (error instanceof AccessError) {
      return Response.json({ error: "Workspace not found." }, { status: 404 });
    }

    throw error;
  }
}
