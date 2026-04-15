# ScribeAI — Deployment Guide
## Frontend → Netlify · Backend → AWS Elastic Beanstalk

---

## Architecture

```
Browser
  │  loads React app
  ▼
Netlify CDN  (frontend — dist/)
  │  API calls (HTTPS) + WebSocket (WSS)
  ▼
AWS Elastic Beanstalk  (backend — Docker)
  │  reads/writes meetings
  ▼
Firestore (Firebase)
  └─ Groq API  (transcription + summarization)
```

---

## Prerequisites

| Tool | Install |
|---|---|
| Node 20+ | https://nodejs.org |
| AWS CLI | `pip install awscli` then `aws configure` |
| EB CLI | `pip install awsebcli` |
| Docker Desktop | https://docker.com (for local testing) |
| Netlify CLI (optional) | `npm i -g netlify-cli` |

---

## Part 1 — Deploy Backend to AWS Elastic Beanstalk

### Step 1 — Prepare environment variables

```bash
cd backend
cp .env.production.example .env.production
```

Open `.env.production` and fill in every value:

```
GROQ_API_KEY=gsk_...
GEMINI_API_KEY=AIza...
FIREBASE_SERVICE_ACCOUNT_JSON={"type":"service_account","project_id":"..."}
PORT=3001
FRONTEND_URL=https://YOUR-SITE.netlify.app
NODE_ENV=production
```

> **FIREBASE_SERVICE_ACCOUNT_JSON**: open `backend/serviceAccountKey.json`, copy the entire
> JSON, and paste it as a single line (no newlines) for this variable.

---

### Step 2 — Test locally with Docker

```bash
# From project root
docker-compose up --build
```

- Frontend → http://localhost  
- Backend health → http://localhost:3001/health  

Stop with `Ctrl+C` when satisfied.

---

### Step 3 — Initialise Elastic Beanstalk (first time only)

```bash
cd backend
eb init scribeai-backend --platform docker --region ap-south-1
```

Choose:
- Application name: `scribeai-backend`
- Platform: **Docker**
- Use CodeCommit: **No**
- Set up SSH: **Yes** (needed for bot-profile setup in Step 6)

---

### Step 4 — Create the EB environment

```bash
eb create scribeai-backend-prod \
  --instance-type t3.medium \
  --single-instance
```

> `--single-instance` avoids a load balancer, which simplifies WebSocket routing.
> Use `t3.medium` or larger — Playwright needs ≥ 2 GB RAM.

Wait for the environment to turn green (~5 min).

---

### Step 5 — Set environment variables on EB

```bash
eb setenv \
  NODE_ENV=production \
  PORT=3001 \
  GROQ_API_KEY="gsk_..." \
  GEMINI_API_KEY="AIza..." \
  "FIREBASE_SERVICE_ACCOUNT_JSON={\"type\":\"service_account\",...}" \
  FRONTEND_URL="https://YOUR-SITE.netlify.app"
```

> Wrap `FIREBASE_SERVICE_ACCOUNT_JSON` in quotes and escape inner quotes with `\"`.

---

### Step 6 — Deploy the backend

```bash
eb deploy
```

Get your backend URL:
```bash
eb status | grep CNAME
# → scribeai-backend-prod.ap-south-1.elasticbeanstalk.com
```

Test it:
```bash
curl http://scribeai-backend-prod.ap-south-1.elasticbeanstalk.com/health
# → {"status":"ok","ts":1234567890}
```

---

### Step 7 — Set up the bot's Google session (one-time)

The Playwright bot needs a real Google account logged-in in `bot-profile/`.
SSH into the EC2 and run it once:

```bash
eb ssh scribeai-backend-prod

# Inside the EC2:
cd /var/app/bot-profile    # ← the host-mounted volume
ls                          # should be empty first time
exit

# On your local machine — copy your local bot-profile to EC2:
scp -i ~/.ssh/your-key.pem -r backend/bot-profile/ \
    ec2-user@<EC2_PUBLIC_IP>:/var/app/bot-profile/
```

Or regenerate it on the server:
```bash
eb ssh scribeai-backend-prod
# Inside EC2 (the container has node):
docker exec -it $(docker ps -q) node generate-auth.js
```

The profile is mounted from `/var/app/bot-profile` on the host → `/app/bot-profile`
in the container (see `Dockerrun.aws.json`), so it survives redeployments.

---

## Part 2 — Deploy Frontend to Netlify

### Step 1 — Connect your repo to Netlify

1. Push your project to GitHub / GitLab / Bitbucket.
2. Go to [app.netlify.com](https://app.netlify.com) → **Add new site** → **Import from Git**.
3. Select your repository.

### Step 2 — Configure build settings in Netlify UI

Netlify will auto-detect `netlify.toml`. Verify these settings:

| Setting | Value |
|---|---|
| Base directory | *(leave blank — root of repo)* |
| Build command | `npm run build` |
| Publish directory | `dist` |

### Step 3 — Set environment variables in Netlify

Go to **Site settings → Environment variables → Add variable**:

| Key | Value |
|---|---|
| `VITE_BACKEND_URL` | `http://scribeai-backend-prod.ap-south-1.elasticbeanstalk.com` |

> Note: use `http://` (not `https://`) unless you add an SSL certificate to your EB
> environment via ACM + ALB. With `--single-instance` EB doesn't include HTTPS by default.

### Step 4 — Deploy

Click **Deploy site**. Netlify will:
1. Clone your repo
2. Run `npm run build` with `VITE_BACKEND_URL` baked in
3. Publish `dist/` to the global CDN

Your site URL will be `https://random-name-xyz.netlify.app`.

### Step 5 — Update FRONTEND_URL on AWS

Now that you have the Netlify URL, update `FRONTEND_URL` on EB so CORS works:

```bash
cd backend
eb setenv FRONTEND_URL="https://random-name-xyz.netlify.app"
eb deploy
```

---

## Part 3 — (Optional) Custom Domains

### Netlify custom domain
Site settings → Domain management → Add custom domain.
Netlify provisions a free TLS certificate via Let's Encrypt automatically.

### AWS EB HTTPS
To add HTTPS to EB you need an **Application Load Balancer** + **ACM certificate**:

```bash
# Recreate the environment with a load balancer (instead of --single-instance):
eb terminate scribeai-backend-prod
eb create scribeai-backend-prod \
  --instance-type t3.medium \
  --elb-type application
```

Then attach an ACM certificate via the AWS Console:
EC2 → Load Balancers → your ALB → Listeners → Add HTTPS (443).

ALB natively supports WebSocket upgrades — no extra config needed.

---

## Updating the App

### Frontend update
```bash
# Push to Git — Netlify auto-deploys on every push to main
git push origin main
```

Or manually:
```bash
npm run build
netlify deploy --prod --dir=dist
```

### Backend update
```bash
cd backend
eb deploy
```

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| CORS error in browser | Make sure `FRONTEND_URL` on EB exactly matches your Netlify URL (no trailing slash) |
| WebSocket fails to connect | With `--single-instance`, WebSocket works. With ALB, ensure listener allows `HTTP → HTTPS` and `WSS` upgrade |
| Bot fails — "bot-profile not found" | Complete Step 7 (copy bot-profile to EC2) |
| Captions not captured | Google Meet may have changed its caption DOM. Check `tmp/bot-error-*.png` on the EC2 |
| EB deploy times out | Playwright browser install is slow — increase `eb create` timeout with `--timeout 30` |
| Netlify build fails | Check that `vite-plugin-singlefile` is removed from `vite.config.ts` (it's incompatible with multi-file Netlify hosting) |
