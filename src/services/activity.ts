import { ulid } from "ulidx";
import type Database from "better-sqlite3";
import type { Activity, PaginatedResult } from "../types";

export class ActivityService {
  constructor(private db: Database.Database) {}

  log(params: {
    action: string;
    entity_type: string;
    entity_id: string;
    summary?: string;
    agent_name?: string;
  }): Activity {
    const id = ulid();
    const created_at = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO activity_log (id, action, entity_type, entity_id, summary, agent_name, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        params.action,
        params.entity_type,
        params.entity_id,
        params.summary ?? null,
        params.agent_name ?? null,
        created_at,
      );

    return {
      id,
      action: params.action,
      entity_type: params.entity_type,
      entity_id: params.entity_id,
      summary: params.summary ?? null,
      agent_name: params.agent_name ?? null,
      created_at,
    };
  }

  list(params: {
    limit: number;
    offset: number;
    agent_name?: string;
  }): PaginatedResult<Activity> {
    const { limit, offset, agent_name } = params;

    const conditions: string[] = [];
    const bindings: unknown[] = [];

    if (agent_name !== undefined) {
      conditions.push("agent_name = ? COLLATE NOCASE");
      bindings.push(agent_name);
    }

    const where =
      conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
    const dataQuery = `SELECT * FROM activity_log${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`;
    const countQuery = `SELECT COUNT(*) as total FROM activity_log${where}`;

    const data = this.db
      .prepare(dataQuery)
      .all(...bindings, limit, offset) as Activity[];

    const countRow = this.db
      .prepare(countQuery)
      .get(...bindings) as { total: number } | undefined;

    const total = countRow?.total ?? 0;

    return {
      data,
      has_more: offset + data.length < total,
      total,
      limit,
      offset,
    };
  }

  rotate(retentionDays: number): number {
    const cutoff = new Date(
      Date.now() - retentionDays * 24 * 60 * 60 * 1000,
    ).toISOString();
    const result = this.db
      .prepare("DELETE FROM activity_log WHERE created_at < ?")
      .run(cutoff);
    return result.changes;
  }

  rotateMessages(retentionDays: number): number {
    const cutoff = new Date(
      Date.now() - retentionDays * 24 * 60 * 60 * 1000,
    ).toISOString();
    const result = this.db
      .prepare("DELETE FROM messages WHERE created_at < ?")
      .run(cutoff);
    return result.changes;
  }

  logAsync(params: {
    action: string;
    entity_type: string;
    entity_id: string;
    summary?: string;
    agent_name?: string;
  }): void {
    try {
      this.log(params);
    } catch {
      // fire-and-forget: silently catch errors
    }
  }
}
