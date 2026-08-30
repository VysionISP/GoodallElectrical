import type { Request, Response, NextFunction } from "express";
import { getDb } from "../db/connection.js";

/**
 * Server-side approval firewall (section 16 of the product brief -- "NO
 * QUOTE MAY BE SENT WITHOUT OWNER APPROVAL" / "NO INVOICE MAY BE SENT
 * WITHOUT OWNER APPROVAL", enforced server-side, not merely by hiding a
 * button). Mount on any route that performs a consequential send/execute
 * action. Looks for the most recent approvals row for (entityType,
 * entityId, action); if its status isn't 'approved', the request is
 * rejected before the route handler runs.
 */
export function requireApproval(entityType: string, action: string, notApprovedCode: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const entityId = req.params.id;
    const db = getDb();
    const approval = db
      .prepare(
        `SELECT * FROM approvals WHERE entity_type = ? AND entity_id = ? AND action = ? ORDER BY created_at DESC LIMIT 1`
      )
      .get(entityType, entityId, action) as { status: string } | undefined;

    if (!approval || approval.status !== "approved") {
      return res.status(403).json({
        error: notApprovedCode,
        message: `This ${entityType} has not been approved by the owner for "${action}". Request approval first.`,
      });
    }
    next();
  };
}
