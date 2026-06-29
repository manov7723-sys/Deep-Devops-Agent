import { v7 as uuidv7 } from "uuid";

/**
 * Generate a UUID v7 — time-ordered, sortable, RFC 9562 compliant.
 *
 * Used for ALL database IDs. Time-ordering keeps B-tree indexes
 * sequential which is much better than v4 for write performance.
 */
export function newId(): string {
  return uuidv7();
}
