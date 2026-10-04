"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createApp, createVercelHandler, runForecast } = require("../server");

function seededRandom(seed) {
  let value = seed >>> 0;
  return () => {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    return value / 4294967296;
  };
}

test("authentication, permissions, persistence, revision conflicts, and live events", async t => {
  const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "pulseboard-test-"));
  const server = createApp({ dataDirectory });
  await server.initialize();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeApp();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dataDirectory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  async function request(route, options = {}) {
    const response = await fetch(base + route, options);
    const body = await response.json();
    return { response, body };
  }
  async function login(email, password) {
    const { response, body } = await request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password })
    });
    return {
      status: response.status,
      body,
      cookie: response.headers.get("set-cookie")?.split(";")[0]
    };
  }

  assert.equal((await request("/api/health")).body.ok, true);
  const anonymousSession = await request("/api/auth/me");
  assert.equal(anonymousSession.response.status, 200);
  assert.equal(anonymousSession.body.user, null);
  assert.equal((await login("admin@pulseboard.dev", "wrong-password")).status, 401);

  const registration = await request("/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "New Member", email: "new-member@example.test", password: "long-demo-pass" })
  });
  assert.equal(registration.response.status, 201);
  assert.equal(registration.body.user.role, "MEMBER");
  const duplicateRegistration = await request("/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "New Member", email: "new-member@example.test", password: "long-demo-pass" })
  });
  assert.equal(duplicateRegistration.response.status, 409);

  const member = await login("sarah@pulseboard.dev", "demo1234");
  assert.equal(member.status, 200);
  assert.equal(member.body.user.role, "MEMBER");
  const csrf = member.body.user.csrfToken;
  const authHeaders = { Cookie: member.cookie, "X-CSRF-Token": csrf, "Content-Type": "application/json" };
  const initial = await request("/api/project", { headers: { Cookie: member.cookie } });
  assert.equal(initial.response.status, 200);
  const staleRevision = initial.body.revision;

  const untouchedProject = JSON.stringify(initial.body.project);
  const forecastStarted = performance.now();
  const forecast = await request("/api/forecast", {
    method: "POST",
    headers: { Cookie: member.cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ project: initial.body.project, today: 3 })
  });
  const forecastRuntime = performance.now() - forecastStarted;
  assert.equal(forecast.response.status, 200);
  assert.equal(forecast.body.iterations, 1000);
  assert.equal(forecast.body.histogram.length, 10);
  assert(forecast.body.criticalPathIds.includes(7));
  assert(forecast.body.onTimeProbability >= 0 && forecast.body.onTimeProbability <= 100);
  assert.match(forecast.body.p50, /^Oct \d+$/);
  assert.match(forecast.body.p90, /^Oct \d+$/);
  assert(forecastRuntime < 1000, `forecast took ${forecastRuntime.toFixed(1)}ms`);
  assert.equal(JSON.stringify(initial.body.project), untouchedProject);

  const baselineConfidence = runForecast(initial.body.project, { today: 3, random: seededRandom(42) }).onTimeProbability;
  const delayedProject = structuredClone(initial.body.project);
  delayedProject.tasks.find(task => task.id === 5).delay = 3;
  const delayedConfidence = runForecast(delayedProject, { today: 3, random: seededRandom(42) }).onTimeProbability;
  assert(delayedConfidence < baselineConfidence, `expected confidence to fall from ${baselineConfidence}%`);

  const malformedForecast = await request("/api/forecast", {
    method: "POST",
    headers: { Cookie: member.cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ project: { tasks: [] }, today: 3 })
  });
  assert.equal(malformedForecast.response.status, 400);

  const descopeProject = structuredClone(initial.body.project);
  descopeProject.tasks.find(task => task.id === 7).descoped = true;
  const descopeForecast = await request("/api/forecast", {
    method: "POST",
    headers: { Cookie: member.cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ project: descopeProject, today: 3 })
  });
  assert.equal(descopeForecast.response.status, 200);
  assert(descopeForecast.body.descopedTaskIds.includes(7));
  assert(descopeForecast.body.descopedTaskIds.includes(8));
  assert(descopeForecast.body.descopedTaskIds.includes(17));
  assert(!descopeForecast.body.scheduledTaskIds.includes(7));
  assert(!descopeForecast.body.criticalPathIds.includes(7));

  const projectUpdate = structuredClone(initial.body.project);
  const coreTask = projectUpdate.tasks.find(task => task.id === 5);
  coreTask.delay = 3;
  coreTask.comments.push({ user: "Sarah", text: "Backend persisted this comment.", at: new Date().toISOString() });
  projectUpdate.activity.unshift({ user: "Sarah", text: "Delayed Core API integration by 3 days.", at: new Date().toISOString(), taskId: 5 });

  const eventResponse = await fetch(base + "/api/events", { headers: { Cookie: member.cookie } });
  const reader = eventResponse.body.getReader();
  const readyEvent = new TextDecoder().decode((await reader.read()).value);
  assert.match(readyEvent, /event: ready/);

  const saved = await request("/api/project", {
    method: "PUT",
    headers: authHeaders,
    body: JSON.stringify({ project: projectUpdate, revision: staleRevision })
  });
  assert.equal(saved.response.status, 200);
  assert.equal(saved.body.project.tasks.find(task => task.id === 5).delay, 3);
  assert.equal(saved.body.revision, staleRevision + 1);
  const liveEvent = new TextDecoder().decode((await reader.read()).value);
  assert.match(liveEvent, /event: project/);
  await reader.cancel();

  const stale = await request("/api/project", {
    method: "PUT",
    headers: authHeaders,
    body: JSON.stringify({ project: projectUpdate, revision: staleRevision })
  });
  assert.equal(stale.response.status, 409);

  const forbiddenUpdate = structuredClone(saved.body.project);
  forbiddenUpdate.deadline += 1;
  const forbidden = await request("/api/project", {
    method: "PUT",
    headers: authHeaders,
    body: JSON.stringify({ project: forbiddenUpdate, revision: saved.body.revision })
  });
  assert.equal(forbidden.response.status, 403);

  const viewer = await login("guest@pulseboard.dev", "view1234");
  assert.equal(viewer.body.user.role, "VIEWER");
  const viewerWrite = await request("/api/project", {
    method: "PUT",
    headers: { Cookie: viewer.cookie, "X-CSRF-Token": viewer.body.user.csrfToken, "Content-Type": "application/json" },
    body: JSON.stringify({ project: saved.body.project, revision: saved.body.revision })
  });
  assert.equal(viewerWrite.response.status, 403);

  const admin = await login("admin@pulseboard.dev", "admin123");
  assert.equal(admin.status, 200);
  const persisted = await request("/api/project", { headers: { Cookie: admin.cookie } });
  assert.equal(persisted.body.project.tasks.find(task => task.id === 5).delay, 3);

  const adminHeaders = { Cookie: admin.cookie, "X-CSRF-Token": admin.body.user.csrfToken, "Content-Type": "application/json" };
  const scenario = structuredClone(persisted.body.project);
  scenario.tasks.find(task => task.id === 7).descoped = true;
  const committed = await request("/api/scenario/commit", {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({ project: scenario, revision: persisted.body.revision, summary: "Descope Dashboard UI branch" })
  });
  assert.equal(committed.response.status, 200);
  assert.match(committed.body.project.activity[0].text, /^Scenario committed: Descope Dashboard UI branch$/);
  assert.deepEqual([7, 8, 17].map(id => committed.body.project.tasks.find(task => task.id === id).descoped), [true, true, true]);
  const diskProject = JSON.parse(fs.readFileSync(path.join(dataDirectory, "project.json"), "utf8"));
  assert.match(diskProject.activity[0].text, /^Scenario committed:/);
  assert.equal(diskProject.tasks.find(task => task.id === 8).descoped, true);

  const memberCommit = await request("/api/scenario/commit", {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ project: scenario, revision: committed.body.revision, summary: "Member commit attempt" })
  });
  assert.equal(memberCommit.response.status, 403);
  const viewerCommit = await request("/api/scenario/commit", {
    method: "POST",
    headers: { Cookie: viewer.cookie, "X-CSRF-Token": viewer.body.user.csrfToken, "Content-Type": "application/json" },
    body: JSON.stringify({ project: scenario, revision: committed.body.revision, summary: "Viewer commit attempt" })
  });
  assert.equal(viewerCommit.response.status, 403);
});

test("corrupt runtime JSON is backed up and reseeded", async () => {
  const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "pulseboard-corrupt-test-"));
  try {
    for (const file of ["project.json", "users.json", "revision.json"]) {
      fs.writeFileSync(path.join(dataDirectory, file), "{not valid JSON", "utf8");
    }
    const server = createApp({ dataDirectory });
    await server.initialize();
    const project = JSON.parse(fs.readFileSync(path.join(dataDirectory, "project.json"), "utf8"));
    const users = JSON.parse(fs.readFileSync(path.join(dataDirectory, "users.json"), "utf8"));
    const revision = JSON.parse(fs.readFileSync(path.join(dataDirectory, "revision.json"), "utf8"));
    assert.equal(project.tasks.length, 17);
    assert.deepEqual(users.map(user => user.role), ["ADMIN", "MEMBER", "VIEWER"]);
    assert.equal(revision.revision, 1);
    for (const file of ["project.json", "users.json", "revision.json"]) {
      assert(fs.existsSync(path.join(dataDirectory, `${file}.bak`)), `${file} backup should exist`);
    }
    server.closeApp();
  } finally {
    fs.rmSync(dataDirectory, { recursive: true, force: true });
  }
});

test("Vercel adapter exports a handler and restores rewritten API and root paths", async t => {
  const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "pulseboard-vercel-test-"));
  const handler = createVercelHandler({ dataDirectory });
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    request.query = { __path: url.searchParams.get("__path") };
    void handler(request, response);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dataDirectory, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${server.address().port}`;
  const health = await fetch(`${base}/api/index?__path=%2Fapi%2Fhealth`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);
  const home = await fetch(`${base}/api/index?__path=%2F`);
  assert.equal(home.status, 200);
  assert.match(await home.text(), /PulseBoard/);
  assert.equal((await fetch(`${base}/api/index?__path=%2Ffavicon.ico`)).status, 204);
  assert.equal((await fetch(`${base}/api/index?__path=%2Ffavicon.png`)).status, 204);
  assert.equal(typeof require("../api"), "function");
  assert.equal(typeof require("../server"), "function");
});