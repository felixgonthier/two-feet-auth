// Starts the service. Configure with environment variables:
//   PORT          port to listen on (default 8787)
//   PUBLIC_URL    the https origin users and apps reach it at (default http://localhost:PORT)
//   DATA_DIR      where clients, keys and encrypted templates live (default ./data)
//   PIGGYBACK_DATA_KEY  base64 32-byte key for template encryption, from your secret store (default: generated into DATA_DIR)
//   PIGGYBACK_REDIS_URL redis://… to share sessions, codes and phone links between instances (default: in memory, one instance)
//   PIGGYBACK_TESTER    "off" to refuse tester-mode scans (default: kept, encrypted, for 30 days)
//   PIGGYBACK_ADMIN_KEY a long random string; lets GET /v1/admin/tester-scans export the tester scans (default: no export)
import { createApp } from "./app.js";

const port = Number(process.env.PORT || 8787);
const publicUrl = process.env.PUBLIC_URL || `http://localhost:${port}`;
const { server } = createApp({
  dataDir: process.env.DATA_DIR || "data",
  publicUrl,
  dataKey: process.env.PIGGYBACK_DATA_KEY,
  redisUrl: process.env.PIGGYBACK_REDIS_URL || null,
  // Lets OIDC requests ask for drawn sample feet (pb_sample=you). Demos and tests only; never in production.
  allowSample: process.env.PIGGYBACK_ALLOW_SAMPLE === "1",
  tester: process.env.PIGGYBACK_TESTER !== "off",
  adminKey: process.env.PIGGYBACK_ADMIN_KEY || null,
  log: msg => console.log(new Date().toISOString(), msg),
});
server.listen(port, () => console.log(`Piggyback listening on ${publicUrl}`));
