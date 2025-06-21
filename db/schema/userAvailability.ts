import { relations } from "drizzle-orm";
import { bigint, index, jsonb, pgEnum, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { withTimestamps } from "../lib/with-timestamps";

export const availabilityStatusEnum = pgEnum("availability_status", ["online", "busy", "away", "offline"]);

export const userAvailability = pgTable(
  "user_availability",
  {
    ...withTimestamps,
    id: bigint({ mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
    userId: text("user_id").notNull(),
    mailboxId: bigint({ mode: "number" }).notNull(),
    status: availabilityStatusEnum("status").notNull().default("offline"),
    customMessage: text("custom_message"),
    lastActivityAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    lastStatusChangeAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    autoAwayAt: timestamp({ withTimezone: true }),
    scheduledReturnAt: timestamp({ withTimezone: true }),
    businessHours: jsonb("business_hours").$type<{
      timezone: string;
      schedule: Record<string, { start: string; end: string } | null>; // "monday": { start: "09:00", end: "17:00" }
    }>(),
    metadata: jsonb("metadata").$type<{
      lastSeenIp?: string;
      userAgent?: string;
      autoStatusReason?: string;
    }>(),
  },
  (table) => [
    index("user_availability_user_id_idx").on(table.userId),
    index("user_availability_mailbox_id_idx").on(table.mailboxId),
    index("user_availability_status_idx").on(table.status),
    index("user_availability_last_activity_idx").on(table.lastActivityAt),
  ],
).enableRLS();

export const availabilityHistory = pgTable(
  "availability_history",
  {
    ...withTimestamps,
    id: bigint({ mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
    userId: text("user_id").notNull(),
    mailboxId: bigint({ mode: "number" }).notNull(),
    fromStatus: availabilityStatusEnum("from_status").notNull(),
    toStatus: availabilityStatusEnum("to_status").notNull(),
    durationSeconds: bigint({ mode: "number" }),
    changeReason: text("change_reason").$type<
      "manual" | "auto_activity" | "auto_inactivity" | "business_hours" | "scheduled"
    >(),
    sessionData: jsonb("session_data").$type<{
      conversationsHandled?: number;
      messagesReplied?: number;
      averageResponseTime?: number;
    }>(),
  },
  (table) => [
    index("availability_history_user_id_idx").on(table.userId),
    index("availability_history_mailbox_id_idx").on(table.mailboxId),
    index("availability_history_created_at_idx").on(table.createdAt),
    index("availability_history_from_status_idx").on(table.fromStatus),
    index("availability_history_to_status_idx").on(table.toStatus),
  ],
).enableRLS();

export const userAvailabilityRelations = relations(userAvailability, ({ many }) => ({
  history: many(availabilityHistory),
}));

export const availabilityHistoryRelations = relations(availabilityHistory, ({ one }) => ({
  availability: one(userAvailability, {
    fields: [availabilityHistory.userId, availabilityHistory.mailboxId],
    references: [userAvailability.userId, userAvailability.mailboxId],
  }),
}));
