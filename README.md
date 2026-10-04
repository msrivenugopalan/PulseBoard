# PulseBoard

PulseBoard helps a delivery team see schedule risk early, understand the dependency chain behind it, and compare recovery options before changing the live plan.

## Product features

- Role-based workspaces for Admin, Member, and Viewer, with server-side authorization.
- A dependency-aware task list, critical path, delay propagation, workload capacity, weighted progress, and plain-language health reasons.
- A Monte Carlo deadline forecast using 1,000 triangular-duration samples, with on-time probability, P50/P90 dates, and a ten-bucket completion distribution.
- A what-if playground for delays, reassignment, duration reduction, and transitive descoping. Descoping a task also drops all of its downstream descendants from the schedule and weighted progress. Preview changes are isolated until an Admin commits them.
- Live updates across sessions using server-sent events, plus revision conflicts to prevent silently overwriting newer project changes.

## Architecture

```text
Browser (index.html, vanilla JavaScript)
	| same-origin JSON API + EventSource
	v
Node HTTP server (server.js)
	|                       |
	v                       v
JSON files               data/seed.json
.pulseboard-data/        first-run project and members
  project.json
  users.json
  revision.json
```

The browser owns presentation and the existing interactive risk engine. The server owns authentication, role enforcement, Monte Carlo simulation, commit validation, persistence, and event broadcast. The seed file is the single source for first-run task and member data.

## Run locally

Requires Node.js 18 or newer. PulseBoard uses only Node built-ins; there are no runtime package dependencies.

```sh
npm install
npm start
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000). Run the integration suite with:

```sh
npm test
```

## Judge accounts

- Admin: `admin@pulseboard.dev` / `admin123`
- Member: `sarah@pulseboard.dev` / `demo1234`
- Viewer: `guest@pulseboard.dev` / `view1234`

Passwords are stored as salted scrypt hashes. Accounts created in the UI receive Member access.

## Two-minute demo

1. Sign in as Admin and show the baseline forecast: Oct 18 projected against the Oct 17 deadline, risk 40/yellow.
2. In the Board, delay **Core API integration** by three days. Show the dependency cascade, Oct 20 forecast, and red risk score.
3. Apply the Health recommendation to pair up the critical task. Confirm the forecast returns to Oct 16/green.
4. Open **Forecast** and run the 1,000-iteration forecast. Point out the confidence gauge, distribution, and P50/P90 dates.
5. Toggle the **Delay Core API integration by +3 days** scenario tile. Compare date, risk, and confidence without changing the Board.
6. Untoggle it and add a duration-reduction or descope option. Commit a selected scenario as Admin; check Activity and the updated Board/Timeline.
7. Sign in as Member or Viewer to show scenario exploration remains available while commit stays Admin-only.

## Seed and runtime data

Edit `data/seed.json` to customize the first-run project. Runtime project state, users, and revision live in `.pulseboard-data/`; malformed files are backed up as `.bak` before the affected data is reseeded. Remove that directory to restore the original demo accounts and seed project.

The server binds to `127.0.0.1` by default. Set `HOST=0.0.0.0` and `PORT` when running behind a TLS-terminating proxy.

## Future work

- Move JSON persistence and in-memory sessions to a transactional database and shared session store for multi-process hosting.
- Support project-specific calendars, holidays, and time zones in the forecast model.
- Add saved scenario history, comparison links, and confidence calibration from completed project data.
- Add rate limiting, password reset, account verification, and operational monitoring before public production use.

## Deployment scope

This is a single-process hackathon deployment. Locally, JSON writes use atomic replacement under `.pulseboard-data/`. Vercel uses `/tmp/pulseboard-data`, which is writable but ephemeral and isolated per serverless instance; project updates can be lost on cold starts and are not shared across scaled instances. Sessions use signed, HttpOnly cookies and require the same `SESSION_SECRET` across deployments. SSE reconnects when a function instance closes, but cross-instance live updates and durable project storage require shared services. Use a database/object store plus shared pub/sub before relying on a public multi-instance deployment.

## Deploy to Vercel

The root `server.js` and `api/index.js` both expose callable Node handlers. `vercel.json` explicitly builds `api/index.js` as a Node function and `index.html` as a static asset; this avoids Vercel treating the root server module as a function with an invalid export. The adapter imports the canonical seed JSON into the function bundle.

Import this repository into Vercel, set the Framework Preset to **Other**, add a high-entropy `SESSION_SECRET` for Preview and Production, and deploy. Do not use the default demo secret for a public deployment. To reproduce the tested build locally and deploy its output:

```sh
vercel build --project pulse-board --yes
vercel deploy --prebuilt --prod --project pulse-board
```

The explicit `builds` setting takes precedence over Vercel dashboard Build/Development settings. Use the repository's `vercel.json` routing/build configuration.