import { Router } from "express";
import { db } from "@workspace/db";
import {
  contactEmails,
  contactPhones,
  contactAddresses,
} from "@workspace/db/schema";
import { eq, and } from "drizzle-orm";
import { requireAuth } from "../middlewares/requireAuth";
import { newId } from "../lib/helpers";

const router = Router();
router.use(requireAuth);

// ─── Emails ──────────────────────────────────────────────────────────────────
router.get("/emails", async (req, res, next) => {
  try {
    const { ownerType, ownerId } = req.query as Record<string, string>;
    const conditions: any[] = [];
    if (ownerType) conditions.push(eq(contactEmails.ownerType, ownerType as any));
    if (ownerId) conditions.push(eq(contactEmails.ownerId, ownerId));
    const rows = await db
      .select()
      .from(contactEmails)
      .where(conditions.length ? and(...conditions) : undefined);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.post("/emails", async (req, res, next) => {
  try {
    const [created] = await db
      .insert(contactEmails)
      .values({ id: newId(), ...req.body })
      .returning();
    res.status(201).json(created);
  } catch (err) {
    next(err);
  }
});

router.patch("/emails/:id", async (req, res, next) => {
  try {
    const [updated] = await db
      .update(contactEmails)
      .set({ ...req.body, updatedAt: new Date() })
      .where(eq(contactEmails.id, req.params.id))
      .returning();
    if (!updated) { res.status(404).json({ error: "Not found" }); return; }
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

router.delete("/emails/:id", async (req, res, next) => {
  try {
    await db.delete(contactEmails).where(eq(contactEmails.id, req.params.id));
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// ─── Phones ──────────────────────────────────────────────────────────────────
router.get("/phones", async (req, res, next) => {
  try {
    const { ownerType, ownerId } = req.query as Record<string, string>;
    const conditions: any[] = [];
    if (ownerType) conditions.push(eq(contactPhones.ownerType, ownerType as any));
    if (ownerId) conditions.push(eq(contactPhones.ownerId, ownerId));
    const rows = await db
      .select()
      .from(contactPhones)
      .where(conditions.length ? and(...conditions) : undefined);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.post("/phones", async (req, res, next) => {
  try {
    const [created] = await db
      .insert(contactPhones)
      .values({ id: newId(), ...req.body })
      .returning();
    res.status(201).json(created);
  } catch (err) {
    next(err);
  }
});

router.patch("/phones/:id", async (req, res, next) => {
  try {
    const [updated] = await db
      .update(contactPhones)
      .set({ ...req.body, updatedAt: new Date() })
      .where(eq(contactPhones.id, req.params.id))
      .returning();
    if (!updated) { res.status(404).json({ error: "Not found" }); return; }
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

router.delete("/phones/:id", async (req, res, next) => {
  try {
    await db.delete(contactPhones).where(eq(contactPhones.id, req.params.id));
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// ─── Addresses ───────────────────────────────────────────────────────────────
router.get("/addresses", async (req, res, next) => {
  try {
    const { ownerType, ownerId } = req.query as Record<string, string>;
    const conditions: any[] = [];
    if (ownerType) conditions.push(eq(contactAddresses.ownerType, ownerType as any));
    if (ownerId) conditions.push(eq(contactAddresses.ownerId, ownerId));
    const rows = await db
      .select()
      .from(contactAddresses)
      .where(conditions.length ? and(...conditions) : undefined);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.post("/addresses", async (req, res, next) => {
  try {
    const [created] = await db
      .insert(contactAddresses)
      .values({ id: newId(), ...req.body })
      .returning();
    res.status(201).json(created);
  } catch (err) {
    next(err);
  }
});

router.patch("/addresses/:id", async (req, res, next) => {
  try {
    const [updated] = await db
      .update(contactAddresses)
      .set({ ...req.body, updatedAt: new Date() })
      .where(eq(contactAddresses.id, req.params.id))
      .returning();
    if (!updated) { res.status(404).json({ error: "Not found" }); return; }
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

router.delete("/addresses/:id", async (req, res, next) => {
  try {
    await db.delete(contactAddresses).where(eq(contactAddresses.id, req.params.id));
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

export default router;
