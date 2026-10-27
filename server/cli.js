// Admin commands.
//   node server/cli.js add-client --name "Piggy Bank" --redirect-uri https://your.app/mfa/feet/callback
//   node server/cli.js add-client --name "Okta" --redirect-uri https://yourcompany.okta.com/oauth2/v1/authorize/callback
//   node server/cli.js add-client --name "Entra ID" --redirect-uri <redirect URI from Microsoft's External Authentication Methods docs> \
//        --hint-issuer <issuer of Entra's id_token_hint>=<its jwks_uri> --amr <value Entra accepts> --acr <value Entra asks for>
//   node server/cli.js list-clients
//   node server/cli.js delete-user --client pb_xxx --user alice@example.com
//
// Login options for add-client:
//   --verify-views n      how many of the two views a login asks for, picked at random (1-2, default 1)
// OpenID Connect options for add-client:
//   --amr a,b             amr values in id_tokens (default feet,mfa)
//   --acr value           acr value in id_tokens (default urn:piggyback:mfa)
//   --hint-issuer iss=jwks_uri   trust signed id_token_hint tokens from this issuer (repeatable)
//   --username-prompt     ask for the account name when no hint is sent
//   --no-enroll           refuse users who haven't enrolled instead of enrolling them on first use
import fs from "node:fs";
import path from "node:path";
import { Store } from "./store.js";

const [cmd, ...rest] = process.argv.slice(2);
const opts = {};
for (let i = 0; i < rest.length; i++) {
  const k = rest[i].replace(/^--/, "");
  const v = rest[i + 1] && !rest[i + 1].startsWith("--") ? rest[++i] : true;
  (opts[k] ||= []).push(v);
}
const store = new Store(process.env.DATA_DIR || "data", { dataKey: process.env.PIGGYBACK_DATA_KEY });

if (cmd === "add-client") {
  if (!opts.name) throw new Error("--name is required");
  const oidc = {};
  if (opts.amr) oidc.amr = String(opts.amr[0]).split(",");
  if (opts.acr) oidc.acr = String(opts.acr[0]);
  if (opts["hint-issuer"]) {
    oidc.hint_issuers = opts["hint-issuer"].map(v => {
      const at = String(v).lastIndexOf("=https");
      return { issuer: v.slice(0, at), jwks_uri: v.slice(at + 1) };
    });
  }
  if (opts["username-prompt"]) oidc.username_prompt = true;
  if (opts["no-enroll"]) oidc.enroll_on_first_use = false;
  const verify_views = opts["verify-views"] ? Number(opts["verify-views"][0]) : 1;
  const { client_id, client_secret } = store.addClient({ name: opts.name[0], redirect_uris: opts["redirect-uri"] || [], allowed_origins: opts.origin || [], oidc, verify_views });
  console.log(JSON.stringify({ client_id, client_secret }, null, 2));
  console.error("Store the secret now; it can't be shown again.");
} else if (cmd === "list-clients") {
  for (const c of store.clients()) console.log(`${c.client_id}  ${c.name}  ${c.redirect_uris.join(" ")}`);
} else if (cmd === "delete-user") {
  console.log(store.deleteUser(opts.client[0], opts.user[0]) ? "deleted" : "not found");
} else if (cmd === "export-tester-scans") {
  // One JSON file per tester scan, decrypted, into --out (default ./tester-scans).
  const out = opts.out?.[0] || "tester-scans";
  fs.mkdirSync(out, { recursive: true });
  let n = 0;
  for (const { name, scan } of store.testerScans()) { fs.writeFileSync(path.join(out, name.replace(/\.bin$/, ".json")), JSON.stringify(scan)); n++; }
  console.log(`${n} scans written to ${out}`);
} else if (cmd === "delete-tester-scans") {
  console.log(`${store.deleteTesterScans()} scans deleted`);
} else {
  console.log("Commands: add-client --name N [--redirect-uri U ...] [OIDC options] | list-clients | delete-user --client C --user U | export-tester-scans [--out DIR] | delete-tester-scans");
  process.exitCode = 1;
}
