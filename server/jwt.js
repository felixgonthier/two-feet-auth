// JSON Web Tokens with node:crypto. ES256 for Piggyback result tokens, RS256 for OpenID Connect id_tokens
// (Okta, Entra ID and most brokers expect RS256). Relying parties verify both against /.well-known/jwks.json.
import crypto from "node:crypto";

const enc = obj => Buffer.from(JSON.stringify(obj)).toString("base64url");
const ALGS = { ES256: { dsaEncoding: "ieee-p1363" }, RS256: {} };

export function signJwt(claims, { privateKey, kid, alg = "ES256" }) {
  if (!ALGS[alg]) throw new Error(`unsupported alg ${alg}`);
  const input = `${enc({ alg, typ: "JWT", kid })}.${enc(claims)}`;
  const sig = crypto.sign("sha256", Buffer.from(input), { key: privateKey, ...ALGS[alg] });
  return `${input}.${sig.toString("base64url")}`;
}

export function decodeJwt(token) {
  const [h, p, s] = String(token).split(".");
  if (!h || !p || !s) throw new Error("malformed token");
  try {
    return { header: JSON.parse(Buffer.from(h, "base64url")), claims: JSON.parse(Buffer.from(p, "base64url")) };
  } catch {
    throw new Error("malformed token");
  }
}

// Checks the signature against a JWKS and the standard claims. Returns the claims or throws.
export function verifyJwt(token, jwks, { issuer, audience, now = Math.floor(Date.now() / 1000) } = {}) {
  const { header, claims } = decodeJwt(token);
  if (!ALGS[header.alg]) throw new Error("unexpected alg");
  const jwk = (jwks.keys || []).find(k => k.kid === header.kid) || (jwks.keys?.length === 1 && !header.kid ? jwks.keys[0] : null);
  if (!jwk) throw new Error("unknown kid");
  const key = crypto.createPublicKey({ key: jwk, format: "jwk" });
  const [h, p, s] = String(token).split(".");
  const ok = crypto.verify("sha256", Buffer.from(`${h}.${p}`), { key, ...ALGS[header.alg] }, Buffer.from(s, "base64url"));
  if (!ok) throw new Error("bad signature");
  if (issuer && claims.iss !== issuer) throw new Error("wrong issuer");
  if (audience) {
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(audience)) throw new Error("wrong audience");
  }
  if (typeof claims.exp !== "number" || claims.exp < now - 30) throw new Error("expired");
  return claims;
}
