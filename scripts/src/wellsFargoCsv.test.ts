import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mergeWellsFargoTransactions,
  parseWellsFargoCsv,
  wellsFargoId,
} from "./wellsFargoCsv";

test("normalizes both Wells Fargo header formats", () => {
  const batchA = parseWellsFargoCsv(
    [
      "Date,Check No.,Bank description,Spent,Received,From/To,Donor,Match/Categorize",
      '"05/22/2026","","VANGRD","","$1,600,000.00","","Arthur Rock","4000.1 Donations"',
    ].join("\n"),
    "Wells_Fargo_2.csv",
  );
  const batchB = parseWellsFargoCsv(
    [
      "date,Bank description,Spent,Received,From/To,Transaction Posted",
      '"05/22/2026","STRIPE TRANSFER","","$593.23","Stripe","Added to: Deposit: Split income"',
    ].join("\n"),
    "Wells_Fargo_5.csv",
  );

  assert.deepEqual(batchA[0], {
    file: "Wells_Fargo_2.csv",
    date: "05/22/2026",
    checkNo: "",
    description: "VANGRD",
    spent: "",
    received: "$1,600,000.00",
    fromTo: "",
    donor: "Arthur Rock",
    qbPosting: "4000.1 Donations",
  });
  assert.equal(batchB[0].qbPosting, "Added to: Deposit: Split income");
  assert.equal(batchB[0].donor, "");
});

test("keeps legitimate same-key occurrences and gives them stable ids", () => {
  const first = parseWellsFargoCsv(
    [
      "date,Bank description,Spent,Received,From/To,Transaction Posted",
      '"01/01/2020","ATM CHECK DEPOSIT","","$10.00","A",""',
      '"01/01/2020","ATM CHECK DEPOSIT","","$10.00","A",""',
    ].join("\n"),
    "Wells_Fargo_5.csv",
  );
  const second = first.map((row) => ({ ...row, file: "Wells_Fargo_6.csv" }));
  const merged = mergeWellsFargoTransactions([...first, ...second]);

  assert.equal(merged.length, 2);
  assert.deepEqual(
    merged.map((row) => row.occurrence),
    [0, 1],
  );
  assert.equal(
    wellsFargoId(merged[0].dedupKey, 0),
    wellsFargoId(merged[0].dedupKey, 0),
  );
  assert.notEqual(
    wellsFargoId(merged[0].dedupKey, 0),
    wellsFargoId(merged[0].dedupKey, 1),
  );
});
