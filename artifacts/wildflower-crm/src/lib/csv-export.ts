// Client helper for the server-side CSV list exports.
//
// The export endpoints accept the SAME filter query params as the JSON list
// endpoints (they share the server-side filter builder), plus an optional
// comma-separated `fields` param of column keys. `limit`/`page` are ignored
// by the server, so we strip them here for tidy URLs.

/** Serialize list params + optional fields into an export query string. */
export function buildExportQuery(
  params: Record<string, unknown>,
  fields?: string[],
): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (key === "limit" || key === "page") continue;
    if (value == null || value === "") continue;
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      // Comma-form: matches how the server's normalizeArrayQuery splits
      // array params sent as a single string.
      qs.set(key, value.map(String).join(","));
    } else {
      qs.set(key, String(value));
    }
  }
  if (fields && fields.length > 0) qs.set("fields", fields.join(","));
  return qs.toString();
}

/** Extract the filename from a Content-Disposition header, if present. */
export function filenameFromDisposition(header: string | null): string | null {
  if (!header) return null;
  const m = /filename="?([^";]+)"?/i.exec(header);
  return m ? m[1] : null;
}

/**
 * Fetch the CSV export and trigger a browser download. Throws on any
 * non-2xx response so callers can surface a toast.
 */
export async function downloadCsvExport(
  entityPath: string,
  params: Record<string, unknown>,
  fields: string[] | undefined,
  fallbackFilename: string,
): Promise<void> {
  const query = buildExportQuery(params, fields);
  const url = `/api/${entityPath}/export.csv${query ? `?${query}` : ""}`;
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) throw new Error(`Export failed (${res.status})`);
  const blob = await res.blob();
  const filename =
    filenameFromDisposition(res.headers.get("Content-Disposition")) ??
    fallbackFilename;
  const objectUrl = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
