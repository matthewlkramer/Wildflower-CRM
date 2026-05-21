import { Router, type IRouter, type Request, type Response } from "express";
import healthRouter from "./health";

const router: IRouter = Router();

router.use(healthRouter);

router.all("/{*splat}", (_req: Request, res: Response) => {
  res.status(503).json({
    error: "rebuilding",
    message:
      "The CRM API is being rebuilt to match the new Airtable-aligned data model. Endpoints will return after Stage 2 (API rewrite).",
  });
});

export default router;
