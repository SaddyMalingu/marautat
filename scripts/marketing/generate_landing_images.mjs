import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import Replicate from "replicate";

const token = process.env.REPLICATE_API_TOKEN;
if (!token) {
  console.error("REPLICATE_API_TOKEN is missing. Set it in your environment and retry.");
  process.exit(1);
}

const replicate = new Replicate({ auth: token });

const outputDir = path.resolve(process.cwd(), "public", "images", "site");
await mkdir(outputDir, { recursive: true });

const jobs = [
  {
    fileName: "commerce-scan-pay.png",
    prompt:
      "High-end fintech hero illustration for African commerce: merchant accepting scan-to-pay on smartphone, dynamic QR checkout interface, subtle M-Pesa inspired payment context, premium lighting, realistic, modern UI overlays, ultra sharp, cinematic",
  },
  {
    fileName: "writers-flow-content-studio.png",
    prompt:
      "Professional AI content studio scene with marketing strategist and multi-screen dashboard generating WhatsApp campaign copy and product content, premium brand colors, clear typography overlays, photoreal, high detail",
  },
  {
    fileName: "multi-tenant-operations-dashboard.png",
    prompt:
      "Enterprise SaaS control room dashboard showing multi-tenant operations, lead funnel, revenue analytics, campaign health, modern dark glass UI, high-value B2B aesthetic, photoreal with clean composition",
  },
  {
    fileName: "supply-chain-analytics-visual.png",
    prompt:
      "Healthcare supply chain analytics visualization with African context, forecasting charts, route and inventory network, data intelligence center aesthetic, clean high-end infographics style, crisp and professional",
  },
  {
    fileName: "interactive-poster-scan-portal.png",
    prompt:
      "Interactive smart poster in retail environment, customer scanning poster QR code to enter branded portal on phone, conversion journey visualization, premium commercial ad-tech look, realistic, high quality",
  },
];

for (const job of jobs) {
  console.log(`Generating ${job.fileName} ...`);

  const input = {
    prompt: job.prompt,
    aspect_ratio: "16:9",
    output_format: "png",
  };

  const output = await replicate.run("google/nano-banana-pro", { input });
  const filePath = path.join(outputDir, job.fileName);
  await writeFile(filePath, output);
  console.log(`WROTE=${filePath}`);
}

console.log("DONE=YES");
