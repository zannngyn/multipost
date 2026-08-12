import { timestamp } from "drizzle-orm/pg-core";

/** Timestamps shared by every table. `updated_at` is bumped by drizzle on update. */
export const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};
