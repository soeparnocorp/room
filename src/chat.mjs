// Edge Chat Demo — Durable Objects based chat worker
// Compatible with chat.html (no contract change)

import HTML from "./chat.html";

// ===============================
// Utility: error wrapper
// ===============================
async function handleErrors(request, func) {
  try {
    return await func();
  } catch (err) {
    if (request.headers.get("Upgrade") === "websocket") {
      let pair = new WebSocketPair();
      pair[1].accept();
      pair[1].send(JSON.stringify({ error: err.stack }));
      pair[1].close(1011, "Uncaught exception");
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    return new Response(err.stack, { status: 500 });
  }
}

// ===============================
// Main Worker
// ===============================
export default {
  async fetch(request, env) {
    return handleErrors(request, async () => {
      const url = new URL(request.url);
      const path = url.pathname.slice(1).split("/");

      if (!path[0]) {
        return new Response(HTML, {
          headers: { "Content-Type": "text/html;charset=UTF-8" }
        });
      }

      if (path[0] === "api") {
        return handleApi(path.slice(1), request, env);
      }

      return new Response("Not found", { status: 404 });
    });
  }
};

// ===============================
// API router
// ===============================
async function handleApi(path, request, env) {
  if (path[0] !== "room") {
    return new Response("Not found", { status: 404 });
  }

  // POST /api/room  → generate private room
  if (!path[1]) {
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }
    const id = env.rooms.newUniqueId();
    return new Response(id.toString(), {
      headers: { "Access-Control-Allow-Origin": "*" }
    });
  }

  const name = path[1];
  let id;

  if (/^[0-9a-f]{64}$/.test(name)) {
    id = env.rooms.idFromString(name);
  } else if (name.length <= 32) {
    id = env.rooms.idFromName(name);
  } else {
    return new Response("Name too long", { status: 404 });
  }

  const room = env.rooms.get(id);

  const newUrl = new URL(request.url);
  newUrl.pathname = "/" + path.slice(2).join("/");

  return room.fetch(newUrl, request);
}

// ===============================
// Durable Object: ChatRoom
// ===============================
export class ChatRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.storage = state.storage;
    this.sessions = new Map();
    this.lastTimestamp = 0;

    for (const ws of this.state.getWebSockets()) {
      const meta = ws.deserializeAttachment();
      const limiterId = env.limiters.idFromString(meta.limiterId);
      const limiter = new RateLimiterClient(
        () => env.limiters.get(limiterId),
        err => ws.close(1011, err.stack)
      );
      this.sessions.set(ws, { ...meta, limiter, blockedMessages: [] });
    }
  }

  async fetch(request) {
    return handleErrors(request, async () => {
      const url = new URL(request.url);

      if (url.pathname === "/websocket") {
        if (request.headers.get("Upgrade") !== "websocket") {
          return new Response("Expected websocket", { status: 400 });
        }

        const ip = request.headers.get("CF-Connecting-IP");
        const pair = new WebSocketPair();
        await this.handleSession(pair[1], ip);
        return new Response(null, { status: 101, webSocket: pair[0] });
      }

      return new Response("Not found", { status: 404 });
    });
  }

  async handleSession(ws, ip) {
    this.state.acceptWebSocket(ws);

    const limiterId = this.env.limiters.idFromName(ip);
    const limiter = new RateLimiterClient(
      () => this.env.limiters.get(limiterId),
      err => ws.close(1011, err.stack)
    );

    const session = { limiterId, limiter, blockedMessages: [] };
    ws.serializeAttachment({ limiterId: limiterId.toString() });
    this.sessions.set(ws, session);

    for (const s of this.sessions.values()) {
      if (s.name) {
        session.blockedMessages.push(JSON.stringify({ joined: s.name }));
      }
    }

    const history = await this.storage.list({ reverse: true, limit: 100 });
    [...history.values()].reverse().forEach(v => {
      session.blockedMessages.push(v);
    });
  }

  async webSocketMessage(ws, msg) {
    const session = this.sessions.get(ws);
    if (!session || session.quit) return;

    if (!session.limiter.checkLimit()) {
      ws.send(JSON.stringify({ error: "Rate limited" }));
      return;
    }

    const data = JSON.parse(msg);

    if (!session.name) {
      session.name = String(data.name || "anonymous").slice(0, 32);
      ws.serializeAttachment({ ...ws.deserializeAttachment(), name: session.name });

      session.blockedMessages.forEach(m => ws.send(m));
      delete session.blockedMessages;

      this.broadcast({ joined: session.name });
      ws.send(JSON.stringify({ ready: true }));
      return;
    }

    const message = String(data.message || "");
    if (message.length > 256) return;

    const timestamp = Math.max(Date.now(), this.lastTimestamp + 1);
    this.lastTimestamp = timestamp;

    const payload = JSON.stringify({
      name: session.name,
      message,
      timestamp
    });

    this.broadcast(payload);
    await this.storage.put(new Date(timestamp).toISOString(), payload);
  }

  async webSocketClose(ws) {
    this.cleanup(ws);
  }

  async webSocketError(ws) {
    this.cleanup(ws);
  }

  cleanup(ws) {
    const session = this.sessions.get(ws);
    if (!session) return;
    this.sessions.delete(ws);
    if (session.name) {
      this.broadcast({ quit: session.name });
    }
  }

  broadcast(msg) {
    const data = typeof msg === "string" ? msg : JSON.stringify(msg);

    for (const [ws, session] of this.sessions) {
      try {
        if (session.name) {
          ws.send(data);
        } else {
          session.blockedMessages.push(data);
        }
      } catch {
        this.cleanup(ws);
      }
    }
  }
}

// ===============================
// Durable Object: RateLimiter
// ===============================
export class RateLimiter {
  constructor() {
    this.nextAllowed = 0;
  }

  async fetch(request) {
    return handleErrors(request, async () => {
      const now = Date.now() / 1000;
      this.nextAllowed = Math.max(now, this.nextAllowed);

      if (request.method === "POST") {
        this.nextAllowed += 5;
      }

      const cooldown = Math.max(0, this.nextAllowed - now - 20);
      return new Response(String(cooldown));
    });
  }
}

// ===============================
// Client-side limiter helper
// ===============================
class RateLimiterClient {
  constructor(getStub, onError) {
    this.getStub = getStub;
    this.onError = onError;
    this.stub = getStub();
    this.cooldown = false;
  }

  checkLimit() {
    if (this.cooldown) return false;
    this.cooldown = true;
    this.call();
    return true;
  }

  async call() {
    try {
      const res = await this.stub.fetch("https://limiter", { method: "POST" });
      const wait = Number(await res.text());
      await new Promise(r => setTimeout(r, wait * 1000));
      this.cooldown = false;
    } catch (e) {
      this.onError(e);
    }
  }
}
