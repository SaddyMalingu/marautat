import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { createKernelRouter } from "./api/router.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const port = Number(process.env.KERNEL_PORT || 4310);

export function createKernelServer() {
  const app = express();

  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as express.Request & { rawBody?: string }).rawBody = buf.toString("utf8");
      },
    }),
  );

  // Prefer compiled static assets in dist; fallback to src when running TS directly.
  const staticPath = join(__dirname, "api/static");
  const srcStaticPath = join(__dirname, "../src/api/static");
  app.use(express.static(staticPath));
  app.use(express.static(srcStaticPath));

  const pagePath = (fileName: string) =>
    existsSync(join(staticPath, fileName))
      ? join(staticPath, fileName)
      : join(srcStaticPath, fileName);

  app.use("/kernel", createKernelRouter());

  // Serve demo/admin pages without requiring file extensions.
  app.get("/", (_req, res) => {
    res.sendFile(pagePath("demo.html"));
  });

  app.get("/demo", (_req, res) => {
    res.sendFile(pagePath("demo.html"));
  });

  app.get("/admin", (_req, res) => {
    res.sendFile(pagePath("admin.html"));
  });

  return app;
}

if (process.env.NODE_ENV !== "test") {
  const app = createKernelServer();
  app.listen(port, () => {
    console.log(`[kernel] listening on :${port}`);
  });
}
