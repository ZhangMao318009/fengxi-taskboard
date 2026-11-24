import type { TaskStatus } from "./types";

export const MAIN_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "done",
] as const satisfies readonly TaskStatus[];

export const SECONDARY_STATUSES = [
  "blocked",
  "canceled",
] as const satisfies readonly TaskStatus[];

export type OtherTaskTab = TaskStatus | "archived";
