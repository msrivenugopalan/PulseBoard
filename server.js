"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { promisify } = require("node:util");

const scrypt = promisify(crypto.scrypt);
const SESSION_COOKIE = "pulseboard_session";
const SESSION_TTL = 1000 * 60 * 60 * 24 * 7;
const SESSION_SECRET = process.env.SESSION_SECRET || "pulseboard-demo-secret-change-this-in-vercel";
const MAX_BODY_BYTES = 1024 * 1024;
const ROLES = new Set(["ADMIN", "MEMBER", "VIEWER"]);

function sendJson(response, status, payload, headers = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers
  });
  response.end(JSON.stringify(payload));
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function encodeSession(session) {
  const payload = Buffer.from(JSON.stringify(session)).toString("base64url");
  const signature = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function cookieHeader(token, request, maxAge = SESSION_TTL / 1000) {
  const secure = process.env.VERCEL || request.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure}`;
}

function cleanProject(project) {
  if (!project || !Array.isArray(project.tasks) || !Array.isArray(project.members) || !Array.isArray(project.activity)) {
    throw new Error("Project data is malformed.");
  }
  const tasks = project.tasks.map(task => {
    if (!task || !Number.isInteger(Number(task.id)) || !String(task.name || "").trim()) {
      throw new Error("Every task needs an ID and name.");
    }
    return {
      id: Number(task.id),
      name: String(task.name).trim().slice(0, 160),
      w: Math.max(1, Math.min(1000, Number(task.w) || 1)),
      who: String(task.who || "Unassigned").slice(0, 80),
      deps: Array.isArray(task.deps) ? task.deps.map(Number).filter(Number.isInteger) : [],
      status: ["todo", "in_progress", "done"].includes(task.status) ? task.status : "todo",
      start: Number(task.start) || 0,
      dur: Math.max(1, Math.min(365, Number(task.dur) || 1)),
      delay: Math.max(0, Math.min(365, Number(task.delay) || 0)),
      ...(task.descoped === true ? { descoped: true } : {}),
      comments: Array.isArray(task.comments) ? task.comments.slice(-100).map(comment => ({
        user: String(comment.user || "Member").slice(0, 80),
        text: String(comment.text || "").slice(0, 1000),
        at: String(comment.at || new Date().toISOString())
      })) : [],
      ...(task.float ? { float: Number(task.float) } : {}),
      ...(task.sped ? { sped: true } : {})
    };
  });
  if (new Set(tasks.map(task => task.id)).size !== tasks.length) throw new Error("Task IDs must be unique.");

  const members = project.members.map(member => {
    if (!member || !String(member.name || "").trim()) throw new Error("Every member needs a name.");
    return {
      name: String(member.name).trim().slice(0, 80),
      cap: Math.max(1, Math.min(168, Number(member.cap) || 1)),
      color: /^#[0-9a-f]{6}$/i.test(member.color || "") ? member.color : "#64748b"
    };
  });
  if (new Set(members.map(member => member.name)).size !== members.length) throw new Error("Member names must be unique.");

  const activity = project.activity.slice(0, 300).map(item => ({
    at: String(item.at || new Date().toISOString()),
    user: String(item.user || "System").slice(0, 80),
    text: String(item.text || "").slice(0, 500),
    ...(Number.isInteger(Number(item.taskId)) ? { taskId: Number(item.taskId) } : {})
  }));
  return { tasks, members, activity, deadline: Math.max(1, Math.min(365, Number(project.deadline) || 16)) };
}

function stable(value) {
  return JSON.stringify(value);
}

function descopeDescendants(project) {
  const tasks = project.tasks.map(task => ({ ...task, deps: [...task.deps] }));
  const children = new Map(tasks.map(task => [task.id, []]));
  tasks.forEach(task => task.deps.forEach(id => children.get(id)?.push(task.id)));
  const byId = new Map(tasks.map(task => [task.id, task]));
  const queue = tasks.filter(task => task.descoped).map(task => task.id);
  const visited = new Set(queue);
  for (let index = 0; index < queue.length; index += 1) {
    for (const childId of children.get(queue[index]) || []) {
      if (visited.has(childId)) continue;
      visited.add(childId);
      byId.get(childId).descoped = true;
      queue.push(childId);
    }
  }
  return { ...project, tasks };
}

function triangularSample(minimum, mode, maximum, random = Math.random) {
  const low = Math.max(0.1, minimum);
  const peak = Math.max(low, Math.min(mode, maximum));
  const high = Math.max(peak, maximum);
  if (high === low) return low;
  const split = (peak - low) / (high - low);
  const value = random();
  return value < split
    ? low + Math.sqrt(value * (high - low) * (peak - low))
    : high - Math.sqrt((1 - value) * (high - low) * (high - peak));
}

function scheduleCompletion(project, sampledDurations, today) {
  const tasks = project.tasks.filter(task => !task.descoped);
  const taskMap = new Map(tasks.map(task => [task.id, task]));
  const endMemo = new Map();
  const visiting = new Set();
  function endOf(id) {
    if (endMemo.has(id)) return endMemo.get(id);
    const task = taskMap.get(id);
    if (!task) return today;
    if (visiting.has(id)) return task.start + (task.status === "done" ? task.dur : sampledDurations.get(id));
    visiting.add(id);
    let earliest = task.deps.length ? 0 : task.start;
    for (const dependencyId of task.deps) {
      if (taskMap.has(dependencyId)) earliest = Math.max(earliest, endOf(dependencyId) - (task.float || 0));
    }
    const start = Math.max(earliest, task.start);
    const duration = task.status === "done" ? task.dur : sampledDurations.get(id);
    const end = start + duration;
    visiting.delete(id);
    endMemo.set(id, end);
    return end;
  }
  return Math.max(today, ...tasks.map(task => endOf(task.id)));
}

function criticalPathIds(project) {
  const tasks = project.tasks.filter(task => !task.descoped);
  const byId = new Map(tasks.map(task => [task.id, task]));
  const children = new Map(tasks.map(task => [task.id, []]));
  tasks.forEach(task => task.deps.forEach(id => children.get(id)?.push(task.id)));
  const memo = new Map();
  function longestFrom(id, path = new Set()) {
    if (memo.has(id)) return memo.get(id);
    const task = byId.get(id);
    if (!task || path.has(id)) return { days: 0, ids: [] };
    path.add(id);
    let tailDays = -1;
    let tailIds = [];
    for (const childId of children.get(id) || []) {
      const candidate = longestFrom(childId, path);
      if (candidate.days > tailDays) {
        tailDays = candidate.days;
        tailIds = candidate.ids;
      } else if (candidate.days === tailDays) {
        tailIds = [...new Set([...tailIds, ...candidate.ids])];
      }
    }
    path.delete(id);
    const result = { days: (task.status === "done" ? task.dur : task.dur + task.delay) + Math.max(0, tailDays), ids: [id, ...tailIds] };
    memo.set(id, result);
    return result;
  }
  let criticalDays = -1;
  let criticalIds = [];
  for (const task of tasks) {
    const candidate = longestFrom(task.id);
    if (candidate.days > criticalDays) {
      criticalDays = candidate.days;
      criticalIds = candidate.ids;
    } else if (candidate.days === criticalDays) {
      criticalIds = [...new Set([...criticalIds, ...candidate.ids])];
    }
  }
  return criticalIds;
}

function formatForecastDay(day) {
  return `Oct ${Math.floor(day) + 1}`;
}

function runForecast(inputProject, options = {}) {
  const iterations = 1000;
  const today = options.today ?? 3;
  const random = options.random || Math.random;
  const project = descopeDescendants(cleanProject(inputProject));
  const samples = new Array(iterations);
  const durations = new Map();
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    durations.clear();
    for (const task of project.tasks) {
      if (task.descoped || task.status === "done") continue;
      const minimum = task.dur * 0.7;
      const mode = task.dur + task.delay;
      const maximum = Math.max(task.dur * 1.6, mode);
      durations.set(task.id, Math.max(1, Math.round(triangularSample(minimum, mode, maximum, random))));
    }
    samples[iteration] = scheduleCompletion(project, durations, today);
  }
  samples.sort((left, right) => left - right);
  const onTimeCount = samples.filter(day => day <= project.deadline).length;
  const minimumDay = samples[0];
  const maximumDay = samples[samples.length - 1];
  const histogram = Array.from({ length: 10 }, (_, index) => ({
    index,
    count: 0,
    onTimeCount: 0,
    lateCount: 0,
    firstDay: null,
    lastDay: null
  }));
  const range = Math.max(1, maximumDay - minimumDay + 1);
  for (const day of samples) {
    const index = Math.min(9, Math.floor(((day - minimumDay) / range) * 10));
    const bucket = histogram[index];
    bucket.count += 1;
    if (day <= project.deadline) bucket.onTimeCount += 1;
    else bucket.lateCount += 1;
    bucket.firstDay = bucket.firstDay === null ? day : Math.min(bucket.firstDay, day);
    bucket.lastDay = bucket.lastDay === null ? day : Math.max(bucket.lastDay, day);
  }
  histogram.forEach(bucket => {
    bucket.probability = bucket.count / iterations * 100;
    bucket.firstDay = bucket.firstDay ?? minimumDay;
    bucket.lastDay = bucket.lastDay ?? minimumDay;
  });
  const p50Day = samples[Math.ceil(iterations * 0.5) - 1];
  const p90Day = samples[Math.ceil(iterations * 0.9) - 1];
  return {
    iterations,
    onTimeProbability: Math.round(onTimeCount / iterations * 100),
    p50: formatForecastDay(p50Day),
    p50Day,
    p90: formatForecastDay(p90Day),
    p90Day,
    deadline: project.deadline,
    scheduledTaskIds: project.tasks.filter(task => !task.descoped).map(task => task.id),
    descopedTaskIds: project.tasks.filter(task => task.descoped).map(task => task.id),
    criticalPathIds: criticalPathIds(project),
    histogram
  };
}

function withoutDerivedTaskFields(task) {
  const { _es, _ee, _crit, ...clean } = task;
  return clean;
}

function createApp(options = {}) {
  const root = __dirname;
  const dataDirectory = options.dataDirectory || process.env.PULSEBOARD_DATA_DIR ||
    (process.env.VERCEL ? path.join("/tmp", "pulseboard-data") : path.join(root, ".pulseboard-data"));
  const seedPath = path.join(root, "data", "seed.json");
  const usersPath = path.join(dataDirectory, "users.json");
  const projectPath = path.join(dataDirectory, "project.json");
  const suppliedSeed = options.seedData || null;
  const eventStreams = new Set();
  let revision = 1;
  let project;
  let users;

  function readJson(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, "utf8")); }
    catch (error) {
      if (fs.existsSync(file)) {
        try { fs.copyFileSync(file, `${file}.bak`); } catch { /* preserve the fallback even if backup fails */ }
        console.warn(`PulseBoard: invalid JSON in ${path.basename(file)}; using fallback data.`);
      }
      return fallback;
    }
  }

  function writeJsonAtomic(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.${crypto.randomBytes(5).toString("hex")}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2), "utf8");
    fs.renameSync(temporary, file);
  }

  async function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
    const derived = await scrypt(password, salt, 64);
    return { salt, hash: derived.toString("hex") };
  }

  async function initialize() {
    fs.mkdirSync(dataDirectory, { recursive: true });
    const seed = suppliedSeed || readJson(seedPath, null);
    if (!seed) throw new Error(`Could not read the seed data at ${seedPath}`);
    const rawProject = readJson(projectPath, null);
    try {
      project = rawProject ? cleanProject(rawProject) : cleanProject(seed.project);
      if (!rawProject) {
        if (fs.existsSync(projectPath)) {
          try { fs.copyFileSync(projectPath, `${projectPath}.bak`); } catch { /* reseed regardless */ }
          console.warn("PulseBoard: invalid project.json; project data was reseeded.");
        }
        writeJsonAtomic(projectPath, project);
      }
    } catch {
      if (fs.existsSync(projectPath)) {
        try { fs.copyFileSync(projectPath, `${projectPath}.bak`); } catch { /* reseed regardless */ }
        console.warn("PulseBoard: invalid project.json; project data was reseeded.");
      }
      project = cleanProject(seed.project);
      writeJsonAtomic(projectPath, project);
    }

    const storedUsers = readJson(usersPath, null);
    const usersAreValid = Array.isArray(storedUsers) && storedUsers.length > 0 && storedUsers.every(user =>
      user && typeof user.name === "string" && typeof user.email === "string" &&
      typeof user.passwordHash === "string" && typeof (user.passwordSalt || user.salt) === "string" && ROLES.has(user.role)
    );
    if (usersAreValid) {
      users = storedUsers;
    } else {
      const demoUsers = [
        { name: "Admin", email: "admin@pulseboard.dev", password: "admin123", role: "ADMIN" },
        { name: "Sarah", email: "sarah@pulseboard.dev", password: "demo1234", role: "MEMBER" },
        { name: "Guest", email: "guest@pulseboard.dev", password: "view1234", role: "VIEWER" }
      ];
      users = await Promise.all(demoUsers.map(async user => {
        const passwordHash = await hashPassword(user.password);
        return { name: user.name, email: user.email, role: user.role, passwordSalt: passwordHash.salt, passwordHash: passwordHash.hash };
      }));
      if (fs.existsSync(usersPath)) {
        try { fs.copyFileSync(usersPath, `${usersPath}.bak`); } catch { /* reseed regardless */ }
        console.warn("PulseBoard: invalid users.json; demo accounts were reseeded.");
      }
      writeJsonAtomic(usersPath, users);
    }
    const revisionPath = path.join(dataDirectory, "revision.json");
    const storedRevision = readJson(revisionPath, null);
    revision = storedRevision && Number.isInteger(storedRevision.revision) && storedRevision.revision > 0 ? storedRevision.revision : 1;
    if (!storedRevision || !Number.isInteger(storedRevision.revision) || storedRevision.revision < 1) {
      if (fs.existsSync(revisionPath)) {
        try { fs.copyFileSync(revisionPath, `${revisionPath}.bak`); } catch { /* reset revision regardless */ }
        console.warn("PulseBoard: invalid revision.json; revision was reset.");
      }
      writeJsonAtomic(revisionPath, { revision });
    }
  }

  function getSession(request) {
    const cookie = request.headers.cookie || "";
    const match = cookie.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
    if (!match) return null;
    const [payload, signature] = match[1].split(".");
    if (!payload || !signature) return null;
    const expected = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
    if (!safeEqual(signature, expected)) return null;
    try {
      const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
      if (!session || session.expiresAt < Date.now() || !ROLES.has(session.role) || !session.csrfToken) return null;
      return session;
    } catch { return null; }
  }

  function requireSession(request, response) {
    const session = getSession(request);
    if (!session) sendJson(response, 401, { error: "Sign in to continue." });
    return session;
  }

  function requireRole(session, response, allowedRoles) {
    if (!allowedRoles.includes(session.role)) {
      sendJson(response, 403, { error: "Your role cannot perform this action." });
      return false;
    }
    return true;
  }

  function requireCsrf(request, response, session) {
    const origin = request.headers.origin;
    if (origin && origin !== `http://${request.headers.host}` && origin !== `https://${request.headers.host}`) {
      sendJson(response, 403, { error: "Cross-origin request rejected." });
      return false;
    }
    if (!safeEqual(request.headers["x-csrf-token"] || "", session.csrfToken)) {
      sendJson(response, 403, { error: "Refresh the page and try again." });
      return false;
    }
    return true;
  }

  async function readBody(request) {
    if (request.body !== undefined) {
      try {
        const parsed = request.body;
        if (parsed && typeof parsed === "object" && !Buffer.isBuffer(parsed) && !Array.isArray(parsed)) return parsed;
        const text = Buffer.isBuffer(parsed) ? parsed.toString("utf8") : String(parsed || "{}");
        const value = JSON.parse(text);
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("JSON object required.");
        return value;
      } catch {
        throw Object.assign(new Error("Request body must be valid JSON."), { statusCode: 400 });
      }
    }
    const chunks = [];
    let bytes = 0;
    for await (const chunk of request) {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) throw Object.assign(new Error("Request is too large."), { statusCode: 413 });
      chunks.push(chunk);
    }
    try {
      const value = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("JSON object required.");
      return value;
    }
    catch { throw Object.assign(new Error("Request body must be valid JSON."), { statusCode: 400 }); }
  }

  function broadcastProjectChange() {
    const message = `event: project\ndata: ${JSON.stringify({ revision })}\n\n`;
    for (const response of eventStreams) response.write(message);
  }

  function memberChangesAreAllowed(session, candidate) {
    if (candidate.deadline !== project.deadline || stable(candidate.members) !== stable(project.members)) return false;
    if (candidate.tasks.length !== project.tasks.length) return false;
    const oldById = new Map(project.tasks.map(task => [task.id, task]));
    for (const candidateTask of candidate.tasks) {
      const oldTask = oldById.get(candidateTask.id);
      if (!oldTask) return false;
      const oldBase = withoutDerivedTaskFields(oldTask);
      const nextBase = withoutDerivedTaskFields(candidateTask);
      for (const key of Object.keys(oldBase)) {
        if (["status", "delay", "comments"].includes(key)) continue;
        if (stable(oldBase[key]) !== stable(nextBase[key])) return false;
      }
      if (candidateTask.delay < oldTask.delay) return false;
      if (candidateTask.comments.length < oldTask.comments.length) return false;
      const appended = candidateTask.comments.slice(oldTask.comments.length);
      if (appended.some(comment => comment.user !== session.name || !comment.text.trim())) return false;
      if (stable(candidateTask.comments.slice(0, oldTask.comments.length)) !== stable(oldTask.comments)) return false;
    }
    if (candidate.activity.length < project.activity.length) return false;
    if (stable(candidate.activity.slice(candidate.activity.length - project.activity.length)) !== stable(project.activity)) return false;
    const addedActivity = candidate.activity.slice(0, candidate.activity.length - project.activity.length);
    return addedActivity.every(item => item.user === session.name);
  }

  function saveProject(candidate, session, response) {
    if (!candidate.project || typeof candidate.project !== "object" || !Number.isInteger(candidate.revision)) {
      sendJson(response, 400, { error: "A project object and integer revision are required." });
      return;
    }
    if (revision !== Number(candidate.revision)) {
      sendJson(response, 409, { error: "Project changed in another session.", project, revision });
      return;
    }
    let cleaned;
    try { cleaned = cleanProject(candidate.project); }
    catch (error) { sendJson(response, 400, { error: error.message }); return; }
    if (session.role === "VIEWER") { sendJson(response, 403, { error: "Viewers cannot change project data." }); return; }
    if (session.role === "MEMBER" && !memberChangesAreAllowed(session, cleaned)) {
      sendJson(response, 403, { error: "Members can update task status, delays, and their own comments only." });
      return;
    }
    project = cleaned;
    revision += 1;
    writeJsonAtomic(projectPath, project);
    writeJsonAtomic(path.join(dataDirectory, "revision.json"), { revision });
    broadcastProjectChange();
    sendJson(response, 200, { project, revision });
  }

  function sessionUser(session) {
    return { name: session.name, email: session.email, role: session.role, csrfToken: session.csrfToken };
  }

  async function handle(request, response) {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    const pathname = url.pathname;
    try {
      if (request.method === "GET" && pathname === "/api/health") {
        sendJson(response, 200, { ok: true, service: "PulseBoard API" });
        return;
      }
      if (request.method === "GET" && pathname === "/api/seed") {
        const seed = suppliedSeed || readJson(seedPath, null);
        sendJson(response, 200, seed);
        return;
      }
      if (request.method === "POST" && pathname === "/api/auth/login") {
        const body = await readBody(request);
        if (typeof body.email !== "string" || typeof body.password !== "string" ||
            !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email) || body.password.length < 1 || body.password.length > 200) {
          sendJson(response, 400, { error: "Enter a valid email and password." });
          return;
        }
        const email = String(body.email || "").trim().toLowerCase();
        const user = users.find(item => item.email.toLowerCase() === email);
        if (!user || !await (async () => {
          const candidate = await scrypt(String(body.password || ""), user.passwordSalt || user.salt, 64);
          return safeEqual(candidate.toString("hex"), user.passwordHash);
        })()) {
          sendJson(response, 401, { error: "Email or password is incorrect." });
          return;
        }
        const session = { name: user.name, email: user.email, role: user.role, csrfToken: crypto.randomBytes(24).toString("hex"), expiresAt: Date.now() + SESSION_TTL };
        sendJson(response, 200, { user: sessionUser(session) }, { "Set-Cookie": cookieHeader(encodeSession(session), request) });
        return;
      }
      if (request.method === "POST" && pathname === "/api/auth/register") {
        const body = await readBody(request);
        if (typeof body.name !== "string" || typeof body.email !== "string" || typeof body.password !== "string") {
          sendJson(response, 400, { error: "Name, email, and password must be text values." });
          return;
        }
        const name = String(body.name || "").trim().slice(0, 80);
        const email = String(body.email || "").trim().toLowerCase();
        const password = String(body.password || "");
        if (name.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 8 || password.length > 200) {
          sendJson(response, 400, { error: "Enter a name, valid email, and password with at least 8 characters." });
          return;
        }
        if (users.some(user => user.email.toLowerCase() === email)) {
          sendJson(response, 409, { error: "An account with this email already exists." });
          return;
        }
        const passwordHash = await hashPassword(password);
        const user = { name, email, role: "MEMBER", passwordSalt: passwordHash.salt, passwordHash: passwordHash.hash };
        users.push(user);
        writeJsonAtomic(usersPath, users);
        const session = { name, email, role: "MEMBER", csrfToken: crypto.randomBytes(24).toString("hex"), expiresAt: Date.now() + SESSION_TTL };
        sendJson(response, 201, { user: sessionUser(session) }, { "Set-Cookie": cookieHeader(encodeSession(session), request) });
        return;
      }
      if (request.method === "GET" && pathname === "/api/auth/me") {
        const session = getSession(request);
        sendJson(response, 200, { user: session ? sessionUser(session) : null });
        return;
      }
      if (request.method === "POST" && pathname === "/api/auth/logout") {
        const session = requireSession(request, response);
        if (!session || !requireCsrf(request, response, session)) return;
        await readBody(request);
        sendJson(response, 200, { ok: true }, { "Set-Cookie": cookieHeader("", request, 0) });
        return;
      }
      if (request.method === "GET" && pathname === "/api/project") {
        const session = requireSession(request, response);
        if (session) sendJson(response, 200, { project, revision });
        return;
      }
      if (request.method === "PUT" && pathname === "/api/project") {
        const session = requireSession(request, response);
        if (!session || !requireCsrf(request, response, session)) return;
        const body = await readBody(request);
        saveProject(body, session, response);
        return;
      }
      if (request.method === "POST" && pathname === "/api/forecast") {
        const session = requireSession(request, response);
        if (!session) return;
        const body = await readBody(request);
        const candidate = body.project ?? body;
        if (!candidate || typeof candidate !== "object" || !Array.isArray(candidate.tasks) ||
            !Array.isArray(candidate.members) || !Array.isArray(candidate.activity)) {
          sendJson(response, 400, { error: "A valid project payload is required." });
          return;
        }
        const seed = suppliedSeed || readJson(seedPath, null);
        const today = body.today ?? seed?.today;
        if (!Number.isInteger(today) || today < 0 || today > 365) {
          sendJson(response, 400, { error: "Forecast day must be an integer from 0 to 365." });
          return;
        }
        try {
          sendJson(response, 200, runForecast(candidate, { today }));
        } catch (error) {
          sendJson(response, 400, { error: error.message });
        }
        return;
      }
      if (request.method === "POST" && pathname === "/api/scenario/commit") {
        const session = requireSession(request, response);
        if (!session || !requireCsrf(request, response, session)) return;
        const body = await readBody(request);
        if (!requireRole(session, response, ["ADMIN"])) return;
        if (!body.project || typeof body.project !== "object" || !Number.isInteger(body.revision) ||
            typeof body.summary !== "string" || !body.summary.trim() || body.summary.length > 500) {
          sendJson(response, 400, { error: "A project, revision, and concise scenario summary are required." });
          return;
        }
        if (revision !== body.revision) {
          sendJson(response, 409, { error: "Project changed in another session.", project, revision });
          return;
        }
        let committed;
        try { committed = descopeDescendants(cleanProject(body.project)); }
        catch (error) { sendJson(response, 400, { error: error.message }); return; }
        committed.activity.unshift({ at: new Date().toISOString(), user: session.name, text: `Scenario committed: ${body.summary.trim()}` });
        committed.activity = committed.activity.slice(0, 300);
        project = committed;
        revision += 1;
        writeJsonAtomic(projectPath, project);
        writeJsonAtomic(path.join(dataDirectory, "revision.json"), { revision });
        broadcastProjectChange();
        sendJson(response, 200, { project, revision });
        return;
      }
      if (request.method === "GET" && pathname === "/api/events") {
        const session = requireSession(request, response);
        if (!session) return;
        response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
        response.write(`event: ready\ndata: ${JSON.stringify({ revision })}\n\n`);
        eventStreams.add(response);
        const keepAlive = setInterval(() => response.write(": keepalive\n\n"), 25000);
        request.on("close", () => { clearInterval(keepAlive); eventStreams.delete(response); });
        return;
      }
      if (request.method === "GET" && pathname === "/") {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" });
        fs.createReadStream(path.join(root, "index.html")).pipe(response);
        return;
      }
      if (request.method === "GET" && (pathname === "/favicon.ico" || pathname === "/favicon.png")) {
        response.writeHead(204, { "Cache-Control": "public, max-age=86400" });
        response.end();
        return;
      }
      sendJson(response, 404, { error: "Not found." });
    } catch (error) {
      if (!response.headersSent) sendJson(response, error.statusCode || 500, { error: error.statusCode ? error.message : "The server could not complete this request." });
      else response.destroy(error);
    }
  }

  const server = http.createServer((request, response) => { void handle(request, response); });
  server.initialize = initialize;
  server.closeApp = () => {
    for (const stream of eventStreams) stream.end();
    eventStreams.clear();
  };
  return server;
}

if (require.main === module) {
  const server = createApp();
  server.initialize().then(() => {
    const port = Number(process.env.PORT || 3000);
    const host = process.env.HOST || "127.0.0.1";
    server.listen(port, host, () => console.log(`PulseBoard is ready at http://${host}:${port}`));
  }).catch(error => {
    console.error("PulseBoard could not start:", error.message);
    process.exitCode = 1;
  });
}

function createVercelHandler(options = {}) {
  let appPromise;
  return async function vercelHandler(request, response) {
    try {
      const rewrittenPath = request.query && request.query.__path;
      if (typeof rewrittenPath === "string" && rewrittenPath.startsWith("/")) {
        const incoming = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
        incoming.searchParams.delete("__path");
        const query = incoming.searchParams.toString();
        request.url = `${rewrittenPath}${query ? `?${query}` : ""}`;
      }
      if (!appPromise) {
        const app = createApp(options);
        appPromise = app.initialize().then(() => app);
      }
      const app = await appPromise;
      const listener = app.listeners("request")[0];
      listener(request, response);
    } catch (error) {
      if (!response.headersSent) {
        response.writeHead(500, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        response.end(JSON.stringify({ error: "PulseBoard could not initialize." }));
      } else response.destroy(error);
    }
  };
}

const vercelHandler = createVercelHandler();

module.exports = vercelHandler;
module.exports.createApp = createApp;
module.exports.runForecast = runForecast;
module.exports.descopeDescendants = descopeDescendants;
module.exports.createVercelHandler = createVercelHandler;