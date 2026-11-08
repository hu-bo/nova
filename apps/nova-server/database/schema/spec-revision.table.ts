import { integer, jsonb, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { specs } from "./spec.table.js";

export type SpecTaskCheck = {
  key: string;
  criterionIds: string[];
  label: string;
  method: { kind: "manual" } | { kind: "command"; command: string; args: string[]; cwd?: string | undefined };
};
export type SpecTask = {
  key: string;
  title: string;
  objective: string;
  dependsOn: string[];
  checks: SpecTaskCheck[];
};
export type SpecReview = { revision: number; sourceRevision?: number; reviewerId: string; reviewedAt: string };
export type SpecEvidence = {
  id: string;
  taskKey: string;
  checkKey: string;
  passed: boolean;
  source: "automatic" | "manual" | "carried";
  attemptId?: string;
  toolOperationId?: string;
  fromRevision?: number;
  reviewedBy?: string;
  note?: string;
  createdBy: string;
  createdAt: string;
};
export const specRevisions = pgTable(
  "spec_revisions",
  {
    specId: uuid("spec_id").notNull().references(() => specs.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    requirementsMd: text("requirements_md").notNull().default(""),
    designMd: text("design_md"),
    taskPlan: jsonb("task_plan").$type<SpecTask[]>().notNull().default([]),
    reviews: jsonb("reviews").$type<Partial<Record<"requirements" | "design" | "tasks", SpecReview>>>().notNull().default({}),
    evidence: jsonb("evidence").$type<SpecEvidence[]>().notNull().default([]),
    acceptance: jsonb("acceptance").$type<{ reviewerId: string; acceptedAt: string; evidenceIds: string[] } | null>(),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.specId, table.revision] })],
);
