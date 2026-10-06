/**
 * Bytes as a person reads them: "1.4 GB", "820 MB".
 *
 * Its own module, with no imports, because both the server (the quota's
 * refusal message) and the browser (the group page) need it, and a server
 * module that touches the database must never reach a client bundle.
 */
export function formatBytes(bytes: number): string {
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${Math.round(gb * 10) / 10} GB`;
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}
