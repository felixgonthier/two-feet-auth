# Deploying Piggyback

Run your own Piggyback with https, then connect your app or your identity platform to it. It's self-hosted the way most auth servers are: a Docker image and a `docker compose up`, or plain Node.js on any Linux server.

## What you'll run

| Address | What | Needed? |
|---|---|---|
| `feet.example.com` | **The Piggyback service**: API, hosted scan page, phone page, OpenID Connect | Yes |
| `demo.example.com` | "Piggy Bank", an example app with password + feet | Optional, for trying it end to end |

Every address needs https: browsers only open the camera on https, and phones have to reach the service to continue a sign-in started on a computer.

**You need:** a Linux server (1 CPU and 1 GB of memory is plenty), a domain with an `A` record for `feet.example.com` pointing at it, and ports 80 and 443 open. Replace `example.com` with your domain everywhere below.

## Option A: Docker Compose (easiest)

The image is `ghcr.io/felixgonthier/two-feet-auth`, and the compose file puts [Caddy](https://caddyserver.com) in front for automatic https.

```bash
git clone https://github.com/felixgonthier/two-feet-auth.git piggyback && cd piggyback
cp .env.example .env
openssl rand -base64 32          # paste into PIGGYBACK_DATA_KEY, and keep a copy somewhere safe
nano .env                        # set PIGGYBACK_DOMAIN=feet.example.com
docker compose up -d
curl https://feet.example.com/health      # {"ok":true}
```

Register each app that will use it (the secret is shown once):

```bash
docker compose exec piggyback piggyback add-client --name "Your app" --redirect-uri https://your.app/mfa/callback
```

**The example app:** register it with `--redirect-uri https://demo.example.com/mfa/callback`. In `.env`, fill in `DEMO_DOMAIN`, `DEMO_CLIENT_ID` and `DEMO_CLIENT_SECRET` and uncomment `CADDYFILE`. Then run `docker compose --profile demo up -d`. Skip to [Try it](#try-it).

| Task | How |
|---|---|
| Update | `docker compose pull && docker compose up -d` |
| Logs | `docker compose logs -f piggyback` |
| Admin commands | `docker compose exec piggyback piggyback list-clients` (also `add-client`, `delete-user`) |
| Back up | the `piggyback-data` volume, and `PIGGYBACK_DATA_KEY` kept apart |
| Without Caddy | `docker run -d -p 8787:8787 -v piggyback-data:/data -e PUBLIC_URL=https://feet.example.com -e PIGGYBACK_DATA_KEY=… ghcr.io/felixgonthier/two-feet-auth`, behind your own https proxy |

## Option B: a hosting platform (no server to manage)

Platforms that run a Docker image with a lasting disk work too. On [Render](https://render.com):

1. **New → Web Service → Existing Image**: `ghcr.io/felixgonthier/two-feet-auth:latest`. Pick a paid instance; disks need one.
2. **Environment**: `PUBLIC_URL=https://feet.example.com` and `PIGGYBACK_DATA_KEY` (from `openssl rand -base64 32`; keep a copy). Render sets `PORT` itself and Piggyback follows it.
3. **Advanced → Add Disk**: mount path `/data`, 1 GB. **Health Check Path**: `/health`.
4. **Deploy**, then **Settings → Custom Domains → Add**: `feet.example.com`, and add the `CNAME` record Render shows (pointing at your `onrender.com` address) at your DNS provider. Render issues the https certificate once it verifies.
5. Register apps from the service's **Shell** tab: `piggyback add-client --name "Your app" --redirect-uri https://your.app/mfa/callback`
6. To update, use **Manual Deploy → Deploy latest reference**. Image services don't redeploy by themselves when `latest` changes.

A service with a disk runs as one instance and is briefly unavailable during each deploy. Railway and Fly.io work the same way: the image, the two settings, a disk at `/data`.

## Option C: a plain Linux server

Piggyback has no dependencies, so Node.js and Caddy are all it takes. These steps are for Ubuntu 24.04 or Debian 12, with systemd keeping it running. The ready-made files are in [`deploy/`](../deploy).

### 1. Point the domain at the server

Add `A` records (and `AAAA` if the server has IPv6) for `feet`, plus `demo` and the bare domain if you want them, all to the server's IP address. Check with `dig +short feet.example.com`.

### 2. Install Node.js and Caddy

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs caddy git
node --version    # 20 or later
```

On other systems, see [Node.js downloads](https://nodejs.org/en/download) and [Caddy's install guide](https://caddyserver.com/docs/install).

### 3. Get the code

```bash
sudo useradd --system --create-home --home-dir /opt/piggyback --shell /usr/sbin/nologin piggyback
sudo -u piggyback git clone https://github.com/felixgonthier/two-feet-auth.git /opt/piggyback/app
sudo install -d -o piggyback -g piggyback -m 700 /var/lib/piggyback
sudo install -d -m 750 -g piggyback /etc/piggyback
```

There's nothing to `npm install`: the service has no dependencies.

### 4. Configure the service

```bash
sudo install -m 640 -g piggyback /opt/piggyback/app/deploy/piggyback.env.example /etc/piggyback/piggyback.env
openssl rand -base64 32          # the template encryption key
sudo nano /etc/piggyback/piggyback.env
```

Set `PUBLIC_URL=https://feet.example.com` and paste the key into `PIGGYBACK_DATA_KEY`. **Keep a copy of that key somewhere safe** (a password manager or your secret store): without it, nobody's enrolled feet can be read and everyone has to enroll again. Every setting is explained in the file.

### 5. Start it

```bash
sudo cp /opt/piggyback/app/deploy/piggyback.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now piggyback
systemctl status piggyback       # active (running)
```

### 6. Turn on https

```bash
sudo cp /opt/piggyback/app/deploy/Caddyfile /etc/caddy/Caddyfile
sudo nano /etc/caddy/Caddyfile   # replace example.com; delete the blocks you don't need
sudo systemctl reload caddy
curl https://feet.example.com/health      # {"ok":true}
```

Caddy gets and renews the certificates by itself. If `curl` fails, give it a minute and check `journalctl -u caddy`.

### 7. Optional: the example app

Register it with the service. The secret is shown only once:

```bash
sudo -u piggyback /opt/piggyback/app/deploy/pb add-client --name "Piggy Bank" --redirect-uri https://demo.example.com/mfa/callback
```

Then put the client ID and secret into its settings and start it:

```bash
sudo install -m 640 -g piggyback /opt/piggyback/app/deploy/demo-app.env.example /etc/piggyback/demo-app.env
sudo nano /etc/piggyback/demo-app.env
sudo cp /opt/piggyback/app/deploy/demo-app.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now demo-app
```

For the no-server demo page as well: `cd /opt/piggyback/app && sudo -u piggyback npm run build:demo`.

### Running it on a plain server

| Task | How |
|---|---|
| Update | `cd /opt/piggyback/app && sudo -u piggyback git pull && sudo systemctl restart piggyback demo-app` |
| Logs | `journalctl -u piggyback -f` |
| Health check | `GET https://feet.example.com/health` → `{"ok":true}` |
| List registered apps | `sudo -u piggyback /opt/piggyback/app/deploy/pb list-clients` |
| Delete someone's feet | `sudo -u piggyback /opt/piggyback/app/deploy/pb delete-user --client pb_… --user alice@example.com`, or `DELETE /v1/users/:id` from your backend |
| Back up | `/var/lib/piggyback` (signing keys, registered apps, encrypted templates) and your `PIGGYBACK_DATA_KEY`, kept apart |
| More than one instance | Set `PIGGYBACK_REDIS_URL` on every instance and give them the same `DATA_DIR` (shared storage) |

Losing `keys.json` invalidates every token issued so far; losing `PIGGYBACK_DATA_KEY` makes stored feet unreadable. Back up both, separately.

## Try it

1. On a computer, open `https://demo.example.com` and sign in with any name and the password `demo`.
2. Click **Use my phone** and scan the QR code with your phone's camera.
3. On the phone, tap **Scan my feet** and enroll the top of each foot, checking each one before moving on. Then tap **Continue** for the first login.
4. The computer lands on the Piggy Bank dashboard by itself, showing what Piggyback verified.

No feet handy? Add `?sample=you` to the address for drawn sample feet.

## Connect your own app

1. Register it, and keep the client ID and secret for your backend:
   - Docker: `docker compose exec piggyback piggyback add-client --name "Your app" --redirect-uri https://your.app/mfa/callback`
   - Plain server: `sudo -u piggyback /opt/piggyback/app/deploy/pb add-client --name "Your app" --redirect-uri https://your.app/mfa/callback`
2. From your backend, create a session after the password step, send the user to `hosted_url` (or embed `<piggyback-auth>`), then swap the returned code for a signed result token.

The [integration guide](INTEGRATION.md) has the code, the token checks and the API reference.

**Okta, Entra ID, Ping, Keycloak or Auth0:** register the platform as a client with its callback URL, then point it at `https://feet.example.com/.well-known/openid-configuration`. The [identity platform section](INTEGRATION.md#c-behind-an-identity-platform-openid-connect) has the settings for each.

## When something's off

| Symptom | Likely cause |
|---|---|
| The camera doesn't find the foot | Add `?debug` to the hosted page's address to see the outline it finds. A floor lighter or darker than the skin, even light and the whole foot in the frame help most. |
| "The camera isn't available" | The page isn't on https, or the browser blocked the camera. Check the address bar. |
| The QR code opens the wrong address, or nothing | `PUBLIC_URL` doesn't match the public https address. Fix it and restart the service. |
| The phone says "This code has expired" | Codes last 2 minutes and work once. Show a new one on the computer. |
| `invalid_client` from the API | Wrong client ID or secret, or the secret has a typo. Register again to get a new one. |
| `invalid_redirect_uri` | The app's callback isn't exactly the `--redirect-uri` it was registered with. |
| A 502 from Caddy | The service isn't running: `docker compose ps` and `docker compose logs piggyback`, or `systemctl status piggyback` and `journalctl -u piggyback`. |

## Before real people use it

Foot templates are biometric data. Before you let the public scan:

- Tell people what's stored and why, get their consent, and delete on request (`delete-user` or `DELETE /v1/users/:id`).
- Check the law where your users are. In Canada that's PIPEDA, and Quebec's Law 25 requires notifying the CAI before deploying biometric verification; Illinois has BIPA.
- For a public demo, point people at **Sample feet**, or keep the link private.
- Keep another way in (passkey, authenticator app) for people who can't or won't use their feet.

The rest of the production checklist, covering accuracy and liveness limits and key rotation, is in [Before production](INTEGRATION.md#before-production).
