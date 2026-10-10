import { createHash } from "node:crypto";
import * as XLSX from "xlsx";
import { organizationNamesEquivalent } from "./organizationNameMatching";

export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
export type ColumnMapping = {
  name: number;
  organization?: number;
  title?: number;
  email?: number;
};
export type ImportDocument = {
  csvText?: string;
  fileBase64?: string;
  filename?: string | null;
  sheet?: string;
  headerRow?: number;
};
export type DirectoryPerson = {
  id: string;
  name: string;
  emails: string[];
  organizationIds: string[];
};
export type DirectoryOrganization = {
  id: string;
  name: string;
  historicalNames: string[] | null;
};

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let closed = false;
  const push = () => {
    row.push(cell);
    cell = "";
    closed = false;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
        closed = true;
      } else cell += c;
    } else if (c === '"') {
      if (cell || closed) throw new Error("Invalid CSV quote.");
      quoted = true;
    } else if (c === ",") push();
    else if (c === "\r" || c === "\n") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      push();
      rows.push(row);
      row = [];
    } else {
      if (closed && c.trim())
        throw new Error("Unexpected text after a quoted CSV cell.");
      if (!closed) cell += c;
    }
  }
  if (quoted) throw new Error("Unclosed CSV quote.");
  if (cell || row.length || closed) {
    push();
    rows.push(row);
  }
  return rows;
}

/** Bound XLSX expansion before SheetJS parses untrusted ZIP members. */
function validateXlsxZip(bytes: Buffer) {
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error("Invalid XLSX archive.");
  const count = bytes.readUInt16LE(end + 10);
  let pos = bytes.readUInt32LE(end + 16);
  let expanded = 0;
  if (count > 2000 || !count)
    throw new Error("XLSX has too many archive entries.");
  for (let i = 0; i < count; i++) {
    if (pos + 46 > bytes.length || bytes.readUInt32LE(pos) !== 0x02014b50)
      throw new Error("Invalid XLSX directory.");
    const size = bytes.readUInt32LE(pos + 24);
    expanded += size;
    if (
      expanded > 20 * 1024 * 1024 ||
      size === 0xffffffff ||
      bytes.readUInt16LE(pos + 8) & 1
    )
      throw new Error("XLSX expansion exceeds 20 MiB or archive is encrypted.");
    const nameLength = bytes.readUInt16LE(pos + 28);
    const name = bytes.toString("utf8", pos + 46, pos + 46 + nameLength);
    if (/vbaProject|externalLinks/i.test(name))
      throw new Error("Macros and external workbook links are not supported.");
    pos +=
      46 +
      nameLength +
      bytes.readUInt16LE(pos + 30) +
      bytes.readUInt16LE(pos + 32);
  }
}

export function readImportDocument(input: ImportDocument) {
  if (!!input.csvText === !!input.fileBase64)
    throw new Error("Supply one CSV text or uploaded file.");
  if (
    input.fileBase64 &&
    (!/^[A-Za-z0-9+/]*={0,2}$/.test(input.fileBase64) ||
      input.fileBase64.length > Math.ceil(MAX_IMPORT_BYTES / 3) * 4)
  )
    throw new Error("Invalid file encoding or file exceeds 2 MiB.");
  const bytes = input.fileBase64
    ? Buffer.from(input.fileBase64, "base64")
    : Buffer.from(input.csvText!, "utf8");
  if (!bytes.length || bytes.length > MAX_IMPORT_BYTES)
    throw new Error("File must be between 1 byte and 2 MiB.");
  const ext = input.filename?.toLowerCase().split(".").pop() ?? "csv";
  let matrix: string[][];
  let sheets: string[] = [];
  if (ext === "xlsx") {
    validateXlsxZip(bytes);
    const workbook = XLSX.read(bytes, {
      type: "buffer",
      cellFormula: false,
      cellHTML: false,
      sheetRows: 5002,
    });
    sheets = workbook.SheetNames;
    const sheet = workbook.Sheets[input.sheet ?? sheets[0]];
    if (!sheet) throw new Error("Select a worksheet from this workbook.");
    const range = XLSX.utils.decode_range(
      sheet["!fullref"] ?? sheet["!ref"] ?? "A1",
    );
    if (range.e.r >= 5001 || range.e.c >= 100)
      throw new Error("Maximum 5,000 data rows and 100 columns.");
    matrix = XLSX.utils.sheet_to_json<string[]>(sheet, {
      header: 1,
      raw: false,
      defval: "",
      blankrows: true,
      range: 0,
    });
  } else if (ext === "csv") {
    const text = new TextDecoder("utf-8", { fatal: true })
      .decode(bytes)
      .replace(/^\uFEFF/, "");
    if (text.includes("\0")) throw new Error("CSV must contain UTF-8 text.");
    matrix = parseCsv(text);
  } else throw new Error("Only CSV and XLSX files are supported.");
  if (
    matrix.length > 5001 ||
    matrix.some((r) => r.length > 100 || r.some((c) => c.length > 10000))
  )
    throw new Error(
      "Maximum 5,000 data rows, 100 columns and 10,000 characters per cell.",
    );
  const headerRow = input.headerRow ?? 1;
  if (
    !Number.isInteger(headerRow) ||
    headerRow < 1 ||
    headerRow > matrix.length
  )
    throw new Error("Header row is outside this document.");
  const headers = matrix[headerRow - 1];
  if (!headers?.length) throw new Error("The header row is empty.");
  const rows = matrix
    .slice(headerRow)
    .map((cells, i) => ({ rowNumber: headerRow + i + 1, cells }))
    .filter((r) => r.cells.some((c) => c.trim()));
  if (!rows.length) throw new Error("No data rows found.");
  return {
    headers,
    rows,
    sheets,
    hash: createHash("sha256").update(bytes).digest("hex"),
  };
}

export function mapDocument(
  document: ReturnType<typeof readImportDocument>,
  mapping?: ColumnMapping,
) {
  const headers = document.headers.map((h) =>
    h.toLowerCase().replace(/[\s_-]/g, ""),
  );
  const name = headers.findIndex((h) => ["name", "fullname"].includes(h));
  const auto = (options: string[]) => {
    const i = headers.findIndex((h) => options.includes(h));
    return i < 0 ? undefined : i;
  };
  const columns = mapping ?? {
    name,
    organization: auto(["organization", "org", "company"]),
    title: auto(["title", "jobtitle"]),
    email: auto(["email"]),
  };
  for (const index of Object.values(columns))
    if (
      index !== undefined &&
      (!Number.isInteger(index) || index < 0 || index >= headers.length)
    )
      throw new Error("Select valid columns, including a name column.");
  const selected = Object.values(columns).filter((i) => i !== undefined);
  if (new Set(selected).size !== selected.length)
    throw new Error(
      "Each mapped field must use a different column. Leave combined title/organization text unmapped until reviewed.",
    );
  return document.rows.map(({ rowNumber, cells }) => ({
    rowNumber,
    rawCells: cells,
    rawName: cells[columns.name] ?? "",
    rawOrganization:
      columns.organization === undefined
        ? null
        : (cells[columns.organization] ?? null),
    rawTitle:
      columns.title === undefined ? null : (cells[columns.title] ?? null),
    rawEmail:
      columns.email === undefined ? null : (cells[columns.email] ?? null),
  }));
}

export function normalizePersonName(value: string) {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en")
    .trim()
    .replace(/\s+/g, " ");
}
export function classifyImportRow(
  row: {
    rawName: string | null;
    rawEmail: string | null;
    rawOrganization: string | null;
  },
  people: DirectoryPerson[],
  organizations: DirectoryOrganization[],
) {
  const name = normalizePersonName(row.rawName ?? "");
  const email = row.rawEmail?.trim().toLowerCase();
  const orgMatches = organizations.filter((o) =>
    [o.name, ...(o.historicalNames ?? [])].some((n) =>
      organizationNamesEquivalent(n, row.rawOrganization),
    ),
  );
  const emails = email
    ? people.filter((p) =>
        p.emails.some((e) => e.trim().toLowerCase() === email),
      )
    : [];
  const names = name
    ? people.filter((p) => normalizePersonName(p.name) === name)
    : [];
  const corroborated =
    orgMatches.length === 1
      ? names.filter((p) => p.organizationIds.includes(orgMatches[0].id))
      : [];
  const candidates = emails.length ? emails : names;
  const reliable =
    emails.length === 1 &&
    (!name || normalizePersonName(emails[0].name) === name)
      ? emails[0]
      : !emails.length && orgMatches.length === 1 && corroborated.length === 1
        ? corroborated[0]
        : undefined;
  const invalid = !name
    ? "Missing name."
    : email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
      ? "Invalid email."
      : null;
  const category = invalid
    ? "error"
    : reliable
      ? "reliable"
      : candidates.length || orgMatches.length > 1
        ? "ambiguous"
        : orgMatches.length === 1
          ? "new_person_existing_org"
          : "other_unmatched";
  const reason =
    invalid ??
    (reliable
      ? emails.length
        ? "Unique email and consistent name."
        : "Exact full name corroborated by a unique current CRM organization."
      : category === "ambiguous"
        ? "Identity or organization requires a choice; no record selected."
        : category === "new_person_existing_org"
          ? "No person match; unique primary or historical organization name."
          : "No reliable CRM match. Foundation status requires explicit reviewer evidence.");
  return {
    category,
    matchStatus:
      reliable && !invalid
        ? "exact"
        : category === "ambiguous"
          ? "ambiguous"
          : "unmatched",
    matchedPersonId: invalid ? null : (reliable?.id ?? null),
    matchedOrganizationId: orgMatches.length === 1 ? orgMatches[0].id : null,
    matchEvidence: reason,
    matchConfidence: reliable && !invalid ? "high" : "low",
    candidatePersonIds: candidates.map((p) => p.id),
    reviewError: invalid,
  };
}
