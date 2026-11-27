import { Router } from "express";
import { currentSessionHash, rateLimit, requireUser } from "../auth.ts";
import { HttpError, pid } from "../http.ts";
import { atLeast, isTrashed, roleOn } from "../access.ts";
import { tunnelBoard } from "../tunnels.ts";
import { issueTicket } from "../tunnelSessions.ts";
import { isTunnelId } from "../validate.ts";
import { config } from "../config.ts";

export const tunnelsApi = Router();
tunnelsApi.use(requireUser);

// Subdomain mode: one-time ticket that the tunnel's own origin swaps for a cookie session (see
// tunnelSessions.ts). It carries no content, only "this account may reach this tunnel".
tunnelsApi.post("/:id/ticket", (req, res) => {
  const user = req.user!;
  if (!rateLimit(`ticket:${user.id}`, 60)) throw new HttpError(429, "Trop de demandes, réessaie dans une minute");
  const id = pid(req);
  const boardId = config.tunnel.domain && isTunnelId(id) ? tunnelBoard(id) : undefined;
  const session = currentSessionHash(req);
  if (!boardId || !session || !atLeast(roleOn(user.id, boardId), "viewer") || isTrashed(boardId)) throw new HttpError(404, "Tunnel introuvable");
  res.set("Cache-Control", "no-store").json({ ticket: issueTicket(id, user.id, session) });
});
