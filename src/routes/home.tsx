import { Hono } from "hono";
import { Layout } from "../views/layout";

export const home = new Hono<{ Bindings: Env }>();

home.get("/", (c) =>
  c.html(
    <Layout>
      <h1>Tally</h1>
      <p>A family budget. Coming soon.</p>
    </Layout>,
  ),
);
