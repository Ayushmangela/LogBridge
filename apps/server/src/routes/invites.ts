// Invite endpoints — issuing, listing, revoking, and redeeming a code.
//
// Every route here answers the same question the rest of the server never
// asked: is the caller allowed to touch THIS project? Before invites existed
// there was nothing to enforce, because everybody was a member of everything.
import type { FastifyInstance } from "fastify";
import type { RouteDeps } from "./types.js";
import { tokenFromRequest, userForToken } from "../sessions.js";
import { getUserProjectRole } from "../db.js";
import {
  createInvite, listInvites, revokeInvite, redeemInvite, getInvite,
  inviteProblem, REDEEM_MESSAGES,
} from "../invites.js";

export function registerInviteRoutes(app: FastifyInstance, deps: RouteDeps) {
  const { db, broadcastView } = deps;

  const caller = (req: any) => userForToken(db, tokenFromRequest(req));

  /** Only an owner or admin may hand out access to a floor. */
  const requireManager = (req: any, reply: any, projectId: string) => {
    const me = caller(req);
    if (!me) { reply.code(401).send({ ok: false, error: "Sign in first." }); return null; }
    if (!db.prepare("SELECT id FROM projects WHERE id = ?").get(projectId)) {
      reply.code(404).send({ ok: false, error: "No such project." }); return null;
    }
    const role = getUserProjectRole(db, projectId, me.id);
    if (role !== "owner" && role !== "admin") {
      // 404-shaped rather than 403 for a non-member: whether a given project
      // id exists is not something a stranger should be able to probe.
      reply.code(role ? 403 : 404).send({
        ok: false,
        error: role ? "Only an owner or admin can manage invites." : "No such project.",
      });
      return null;
    }
    return me;
  };

  app.post<{ Params: { id: string }; Body: { role?: string; maxUses?: number; ttlHours?: number | null } }>(
    "/api/projects/:id/invites",
    async (req, reply) => {
      const projectId = req.params.id;
      const me = requireManager(req, reply, projectId);
      if (!me) return;

      const invite = createInvite(db, {
        projectId,
        createdBy: me.id,
        role: req.body?.role === "admin" ? "admin" : "member",
        maxUses: req.body?.maxUses,
        ttlHours: req.body?.ttlHours,
      });
      // The code is returned exactly once here and then only ever listed in
      // full to a manager of the same project.
      return { ok: true, invite };
    }
  );

  app.get<{ Params: { id: string } }>("/api/projects/:id/invites", async (req, reply) => {
    const projectId = req.params.id;
    if (!requireManager(req, reply, projectId)) return;
    return { ok: true, invites: listInvites(db, projectId) };
  });

  app.delete<{ Params: { id: string; code: string } }>(
    "/api/projects/:id/invites/:code",
    async (req, reply) => {
      const projectId = req.params.id;
      if (!requireManager(req, reply, projectId)) return;
      const invite = getInvite(db, req.params.code);
      if (!invite || invite.projectId !== projectId) {
        return reply.code(404).send({ ok: false, error: "No such invite." });
      }
      return { ok: true, revoked: revokeInvite(db, req.params.code) };
    }
  );

  /** Check a code without spending it — so the sign-up form can say "this
   *  invite expired" before the person types a password. */
  app.get<{ Params: { code: string } }>("/api/invites/:code", async (req, reply) => {
    const problem = inviteProblem(db, req.params.code);
    if (problem) return reply.code(404).send({ ok: false, error: REDEEM_MESSAGES[problem] });
    const invite = getInvite(db, req.params.code)!;
    const project = db.prepare("SELECT name FROM projects WHERE id = ?").get(invite.projectId) as any;
    // Deliberately thin: an unauthenticated caller holding a valid code learns
    // the project's name and nothing about its agents, members or machines.
    return { ok: true, projectName: project?.name ?? invite.projectId, role: invite.role };
  });

  app.post<{ Params: { code: string } }>("/api/invites/:code/redeem", async (req, reply) => {
    const me = caller(req);
    if (!me) return reply.code(401).send({ ok: false, error: "Sign in first." });

    const result = redeemInvite(db, req.params.code, me.id);
    if (!result.ok) return reply.code(400).send({ ok: false, error: REDEEM_MESSAGES[result.reason] });

    broadcastView();
    const project = db.prepare("SELECT name FROM projects WHERE id = ?").get(result.projectId) as any;
    return { ok: true, projectId: result.projectId, projectName: project?.name ?? result.projectId, role: result.role };
  });

  // Member listing and removal already exist in routes/governance.ts — this
  // file deliberately does not duplicate them.
}
