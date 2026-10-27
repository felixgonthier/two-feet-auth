# piggylover.com

The marketing page for Piggyback: static HTML, CSS and images, no build step. `index.html` is the page; `assets/` holds copies of `ui/tokens.css` and `ui/controls.css`, the page's own `landing.css`, and WebP copies of the brand art and README screenshots.

**Deploy on Cloudflare** (free, no limit on custom domains, and the domain's DNS is already there): Workers & Pages → Create → Import a repository → this GitHub repo. Project name **`piggylover`** (it must match `name` in `wrangler.jsonc` at the repo root), build command empty, deploy command `npx wrangler deploy`, path `/`. `wrangler.jsonc` tells it to serve this folder; every push to `main` redeploys it.

**Domain:** in the project, Settings → Domains & Routes → Add → Custom domain → `piggylover.com`, then again for `www.piggylover.com`. Cloudflare adds the DNS records itself; if `piggylover.com` already has an `A` or `CNAME` record, delete it first. The certificate is issued in a few minutes.

**Or on Render** (Static Site, publish directory `landing`), if the workspace has a custom domain to spare: Render's free plan includes two, which `feet` and `demo` already use.

**Preview locally:** `python3 -m http.server -d landing 8000`, then open http://localhost:8000.
