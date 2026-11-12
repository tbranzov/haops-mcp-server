import type { MemoryLogEntry } from './types/entities.js';

/** Hint printed under the lazy log headers. Kept here so the text is tested, not copied. */
export const LAZY_LOG_HINT =
  '(headers only, no bodies. For the bodies call haops_read_memory(projectSlug, entityType, entityId, full:true) — full:true returns them even without mode:"eager")';

/**
 * One header line of the lazy memory index:
 * `- [timestamp] [tag] by author · id <entryId> · "title"` (title only when present).
 */
export function formatLazyLogHeader(entry: MemoryLogEntry): string {
  const parts = [`- [${entry.timestamp}] [${entry.tag}] by ${entry.author}`];
  if (entry.id) parts.push(`id ${entry.id}`);
  const title = typeof entry.title === 'string' ? entry.title.trim() : '';
  if (title) parts.push(`"${title.length > 100 ? `${title.slice(0, 100)}…` : title}"`);
  return parts.join(' · ');
}
