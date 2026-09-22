import { Hono } from "hono";

export const health = new Hono<{ Bindings: Env }>();

health.get("/healthz", (c) => c.json({ status: "ok" }));
