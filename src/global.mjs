import HTML from "./index.html";

async function handleErrors(request, func) {
  try {
    return await func();
  } catch (err) {
    if (request.headers.get("Upgrade") == "websocket") {
      let pair = new WebSocketPair();
      pair[1].accept();
      pair[1].send(JSON.stringify({error: err.stack}));
      pair[1].close(1011, "Uncaught exception during session setup");
      return new Response(null, { status: 101, webSocket: pair[0] });
    } else {
      return new Response(err.stack, {status: 500});
    }
  }
}

export default {
  async fetch(request, env) {
    return await handleErrors(request, async () => {
      let url = new URL(request.url);
      let path = url.pathname.slice(1).split('/');

      if (!path[0]) {
        return new Response(HTML, {headers: {"Content-Type": "text/html;charset=UTF-8"}});
      }

      switch (path[0]) {
        case "api":
          return handleApiRequest(path.slice(1), request, env);
        default:
          return new Response("Not found", {status: 404});
      }
    });
  }
}

async function handleApiRequest(path, request, env) {
  // ===== TURN CREDENTIALS ENDPOINT (NEW) =====
  if (path[0] === "turn" && path[1] === "credentials" && request.method === "POST") {
    return await handleTURNRequest(request, env);
  }
  
  // ===== SFU PROXY ENDPOINTS (NEW) =====
  if (path[0] === "sfu") {
    return await handleSFURequest(path.slice(1), request, env);
  }

  // ===== D1 ENDPOINTS =====
  if (path[0] === "rooms" && request.method === "GET") {
    try {
      const { results } = await env.READTALK_DB.prepare(
        "SELECT * FROM rooms ORDER BY created_at DESC"
      ).all();
      return new Response(JSON.stringify(results), {
        headers: { "Content-Type": "application/json" }
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), { status: 500 });
    }
  }

  if (path[0] === "rooms" && request.method === "POST") {
    try {
      const { name, description } = await request.json();
      const deviceId = request.headers.get("CF-Connecting-IP") || "anonymous";
      
      const { results } = await env.READTALK_DB.prepare(
        "INSERT INTO rooms (name, description, created_by) VALUES (?, ?, ?) RETURNING id"
      ).bind(name, description, deviceId).run();
      
      return new Response(JSON.stringify(results[0]), {
        headers: { "Content-Type": "application/json" }
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), { status: 500 });
    }
  }

  // ===== KV ENDPOINTS =====
  if (path[0] === "cache" && request.method === "GET") {
    try {
      const cached = await env.READTALK_KV.get("public_rooms");
      if (cached) {
        return new Response(cached, {
          headers: { "Content-Type": "application/json" }
        });
      }
      return new Response(JSON.stringify({ cached: false }), { status: 404 });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), { status: 500 });
    }
  }

  if (path[0] === "cache" && request.method === "POST") {
    try {
      const { key, value, ttl } = await request.json();
      await env.READTALK_KV.put(key, JSON.stringify(value), { expirationTtl: ttl || 60 });
      return new Response(JSON.stringify({ success: true }), {
        headers: { "Content-Type": "application/json" }
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), { status: 500 });
    }
  }

  // ===== R2 ENDPOINTS =====
  if (path[0] === "upload" && request.method === "POST") {
    try {
      const formData = await request.formData();
      const file = formData.get("file");
      const key = formData.get("key") || `upload_${Date.now()}`;
      
      await env.READTALK_R2.put(key, file);
      
      return new Response(JSON.stringify({ key: key, success: true }), {
        headers: { "Content-Type": "application/json" }
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), { status: 500 });
    }
  }

  if (path[0] === "download" && request.method === "GET") {
    try {
      const url = new URL(request.url);
      const key = url.searchParams.get("key");
      
      const object = await env.READTALK_R2.get(key);
      if (!object) {
        return new Response("Not found", { status: 404 });
      }
      
      return new Response(object.body, {
        headers: {
          "Content-Type": object.httpMetadata?.contentType || "application/octet-stream"
        }
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), { status: 500 });
    }
  }

  // ===== ORIGINAL ROOM ENDPOINTS =====
  switch (path[0]) {
    case "room": {
      if (!path[1]) {
        if (request.method == "POST") {
          let id = env.rooms.newUniqueId();
          
          // Simpan ke D1 untuk tracking
          try {
            await env.READTALK_DB.prepare(
              "INSERT INTO rooms (name, is_private) VALUES (?, ?)"
            ).bind(id.toString(), 1).run();
          } catch (e) {
            // Abaikan error, tetap return ID
          }
          
          return new Response(id.toString(), {headers: {"Access-Control-Allow-Origin": "*"}});
        } else {
          return new Response("Method not allowed", {status: 405});
        }
      }

      let name = path[1];
      let id;
      if (name.match(/^[0-9a-f]{64}$/)) {
        id = env.rooms.idFromString(name);
      } else if (name.length <= 32) {
        id = env.rooms.idFromName(name);
        
        // Simpan public room ke D1
        try {
          await env.READTALK_DB.prepare(
            "INSERT OR IGNORE INTO rooms (name, is_private) VALUES (?, ?)"
          ).bind(name, 0).run();
        } catch (e) {
          // Abaikan error
        }
        
      } else {
        return new Response("Name too long", {status: 404});
      }

      let roomObject = env.rooms.get(id);
      let newUrl = new URL(request.url);
      newUrl.pathname = "/" + path.slice(2).join("/");
      return roomObject.fetch(newUrl, request);
    }

    default:
      return new Response("Not found", {status: 404});
  }
}

// ===== NEW: TURN CREDENTIALS HANDLER =====
async function handleTURNRequest(request, env) {
  // Only allow POST
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  try {
    // Get TTL from request body (optional, default 86400 = 24 jam)
    const { ttl = 86400 } = await request.json().catch(() => ({ ttl: 86400 }));
    
    // Validate TTL (max 7 days)
    const validTtl = Math.min(ttl, 604800);
    
    // Check if App ID and Secret are configured
    if (!env.ACCOUNT_APP_ID || !env.ACCOUNT_APP_SECRET) {
      console.error('Missing ACCOUNT_APP_ID or ACCOUNT_APP_SECRET');
      
      // Fallback to STUN only if credentials not configured
      return new Response(JSON.stringify({
        iceServers: [
          {
            urls: [
              "stun:stun.cloudflare.com:3478"
            ]
          }
        ]
      }), {
        headers: { 
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        }
      });
    }

    // Call Cloudflare TURN API
    const turnResponse = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${env.ACCOUNT_APP_ID}/credentials/generate-ice-servers`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.ACCOUNT_APP_SECRET}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ ttl: validTtl })
      }
    );

    if (!turnResponse.ok) {
      const errorText = await turnResponse.text();
      console.error('TURN API error:', turnResponse.status, errorText);
      
      // Fallback to STUN only on error
      return new Response(JSON.stringify({
        iceServers: [
          {
            urls: [
              "stun:stun.cloudflare.com:3478"
            ]
          }
        ]
      }), {
        headers: { 
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        }
      });
    }

    const turnData = await turnResponse.json();
    
    // Add CORS headers
    return new Response(JSON.stringify(turnData), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type"
      }
    });

  } catch (err) {
    console.error('TURN handler error:', err);
    
    // Fallback to STUN only on error
    return new Response(JSON.stringify({
      iceServers: [
        {
          urls: [
            "stun:stun.cloudflare.com:3478"
          ]
        }
      ],
      error: err.message
    }), {
      headers: { 
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*"
      }
    });
  }
}

// ===== NEW: SFU PROXY HANDLER =====
async function handleSFURequest(path, request, env) {
  // Handle OPTIONS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "86400"
      }
    });
  }

  try {
    // Check if App ID and Secret are configured
    if (!env.ACCOUNT_APP_ID || !env.ACCOUNT_APP_SECRET) {
      return new Response(JSON.stringify({ 
        error: "SFU not configured - missing credentials" 
      }), { 
        status: 501,
        headers: { 
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        }
      });
    }

    // Construct path
    const pathStr = path.join('/');
    const targetUrl = `https://rtc.live.cloudflare.com/v1/apps/${env.ACCOUNT_APP_ID}/${pathStr}`;
    
    // Get request body for non-GET requests
    let body = null;
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      body = await request.text();
    }

    // Forward request to Cloudflare SFU
    const sfuResponse = await fetch(targetUrl, {
      method: request.method,
      headers: {
        'Authorization': `Bearer ${env.ACCOUNT_APP_SECRET}`,
        'Content-Type': 'application/json'
      },
      body: body
    });

    // Get response data
    const responseData = await sfuResponse.text();

    // Return with CORS headers
    return new Response(responseData, {
      status: sfuResponse.status,
      headers: {
        "Content-Type": sfuResponse.headers.get("Content-Type") || "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type"
      }
    });

  } catch (err) {
    console.error('SFU proxy error:', err);
    return new Response(JSON.stringify({ error: err.message }), { 
      status: 500,
      headers: { 
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*"
      }
    });
  }
}

export class ChatRoom {
  constructor(state, env) {
    this.state = state;
    this.storage = state.storage;
    this.env = env;
    this.sessions = new Map();
    this.lastTimestamp = 0;

    this.state.getWebSockets().forEach((webSocket) => {
      let meta = webSocket.deserializeAttachment();
      let limiterId = this.env.limiters.idFromString(meta.limiterId);
      let limiter = new RateLimiterClient(
        () => this.env.limiters.get(limiterId),
        err => webSocket.close(1011, err.stack));
      let blockedMessages = [];
      this.sessions.set(webSocket, { ...meta, limiter, blockedMessages });
    });
  }

  async fetch(request) {
    return await handleErrors(request, async () => {
      let url = new URL(request.url);

      switch (url.pathname) {
        case "/websocket": {
          if (request.headers.get("Upgrade") != "websocket") {
            return new Response("expected websocket", {status: 400});
          }

          let ip = request.headers.get("CF-Connecting-IP");
          let pair = new WebSocketPair();
          await this.handleSession(pair[1], ip);
          return new Response(null, { status: 101, webSocket: pair[0] });
        }

        default:
          return new Response("Not found", {status: 404});
      }
    });
  }

  async handleSession(webSocket, ip) {
    this.state.acceptWebSocket(webSocket);

    let limiterId = this.env.limiters.idFromName(ip);
    let limiter = new RateLimiterClient(
        () => this.env.limiters.get(limiterId),
        err => webSocket.close(1011, err.stack));

    let session = { limiterId, limiter, blockedMessages: [] };
    webSocket.serializeAttachment({ ...webSocket.deserializeAttachment(), limiterId: limiterId.toString() });
    this.sessions.set(webSocket, session);

    for (let otherSession of this.sessions.values()) {
      if (otherSession.name) {
        session.blockedMessages.push(JSON.stringify({joined: otherSession.name}));
      }
    }

    let storage = await this.storage.list({reverse: true, limit: 100});
    let backlog = [...storage.values()];
    backlog.reverse();
    backlog.forEach(value => {
      session.blockedMessages.push(value);
    });
  }

  async webSocketMessage(webSocket, msg) {
    try {
      let session = this.sessions.get(webSocket);
      if (session.quit) {
        webSocket.close(1011, "WebSocket broken.");
        return;
      }

      if (!session.limiter.checkLimit()) {
        webSocket.send(JSON.stringify({
          error: "Your IP is being rate-limited, please try again later."
        }));
        return;
      }

      let data = JSON.parse(msg);

      // Handle call signaling messages - NEW
      if (data.type === 'call-signal') {
        // Forward call signal to target user
        let targetName = data.signal?.target;
        if (targetName) {
          // Add sender info to signal
          data.signal.from = session.name;
          
          // Send to target session
          let sent = false;
          for (let [ws, sess] of this.sessions) {
            if (sess.name === targetName && ws.readyState === 1) { // WebSocket.OPEN = 1
              ws.send(JSON.stringify({
                type: 'call-signal',
                signal: data.signal,
                from: session.name
              }));
              sent = true;
              break;
            }
          }
          
          if (!sent) {
            webSocket.send(JSON.stringify({
              type: 'call-signal',
              signal: {
                type: 'error',
                message: `${targetName} is offline or not available`
              }
            }));
          }
        }
        return;
      }

      if (!session.name) {
        session.name = "" + (data.name || "anonymous");
        webSocket.serializeAttachment({ ...webSocket.deserializeAttachment(), name: session.name });

        if (session.name.length > 32) {
          webSocket.send(JSON.stringify({error: "Name too long."}));
          webSocket.close(1009, "Name too long.");
          return;
        }

        session.blockedMessages.forEach(queued => {
          webSocket.send(queued);
        });
        delete session.blockedMessages;

        this.broadcast({joined: session.name});
        webSocket.send(JSON.stringify({ready: true}));
        return;
      }

      data = { name: session.name, message: "" + data.message };

      if (data.message.length > 256) {
        webSocket.send(JSON.stringify({error: "Message too long."}));
        return;
      }

      data.timestamp = Math.max(Date.now(), this.lastTimestamp + 1);
      this.lastTimestamp = data.timestamp;

      let dataStr = JSON.stringify(data);
      this.broadcast(dataStr);

      let key = new Date(data.timestamp).toISOString();
      await this.storage.put(key, dataStr);
      
      // Simpan ke D1 untuk history panjang (opsional)
      try {
        let roomId = this.state.id.toString();
        await this.env.READTALK_DB.prepare(
          "INSERT INTO messages (room_id, user, message, timestamp) VALUES (?, ?, ?, ?)"
        ).bind(roomId, data.name, data.message, data.timestamp).run();
      } catch (e) {
        // Abaikan error, tetap lan tetap lanjut
      }
      
   jut
      }
      
    } catchjut
      }
      
    } catch (err) {
      webSocket.send } catch (err) {
      webSocket.send(JSON (err) {
      webSocket.send(JSON.stringify({error: err.stack}));
    }
(JSON.stringify({error: err.stack}));
    }
.stringify({error: err.stack}));
    }
  }

  async closeOrErrorHandler(webSocket) {
    let session = this.sessions.get(  }

  async closeOrErrorHandler(webSocket) {
    let session = this.sessions.get(  }

  async closeOrErrorHandler(webSocket) {
    let session = this.sessions.get(webSocketwebSocket) || {};
    session.quit = true;
    this.sessions.delete(webSocket);
    if (session.name) {
      thiswebSocket) || {};
    session.quit = true;
    this.sessions.delete(webSocket);
    if (session.name) {
) || {};
    session.quit = true;
    this.sessions.delete(webSocket);
    if (session.name) {
      this.broadcast({quit:.broadcast({quit:      this.broadcast({quit: session.name});
      
      // Update status online di KV
      try {
        let roomId = this.state session.name});
      
      // Update status online di KV
      try {
        let roomId = this.state session.name});
      
      // Update status online di KV
      try {
        let roomId = this.state.id.toString();
        let count = await this.env.READTALK_KV.get(`online:${roomId}`) ||.id.toString();
        let count = await this.env.READTALK_KV.get(`online:${roomId}`.id.toString();
        let count = await this.env.READTALK_KV.get(`online:${roomId}`) || 0;
        await this.env.READTALK_KV.put(`online:${roomId}`, (parse) || 0;
        await this.env.READTALK_KV.put(`online:${roomId}`, (parse 0;
        await this.env.READTALK_KV.put(`online:${roomId}`, (parseInt(count) - 1).toString());
      } catch (eInt(count) - 1).toString());
      } catch (eInt(count) - 1).toString());
      } catch (e) {
        // Abaikan error
      }
    }
  }

  async webSocketClose(webSocket,) {
        // Abaikan error
      }
    }
  }

  async webSocketClose(webSocket, code,) {
        // Abaikan error
      }
    }
  }

  async webSocketClose(webSocket, code, reason, wasClean) {
    this.closeOrErrorHandler(webSocket)
 code, reason, wasClean) {
    this.closeOrErrorHandler(webSocket)
 reason, wasClean) {
    this.closeOrErrorHandler(webSocket)
  }

  async webSocketError(webSocket, error) {
    this.closeOrErrorHandler(webSocket)
  }

  async webSocketError(webSocket, error) {
    this.closeOrErrorHandler(webSocket)
  }

  }

  async webSocketError(webSocket, error) {
    this.closeOrErrorHandler(webSocket)
  }

  broadcast(message) {
    if (typeof message !== "string") {
      message = JSON.stringify(message);
    }

  broadcast(message) {
    if (typeof message !== "string") {
      message = JSON.stringify(message);
    }

    let  }

  broadcast(message) {
    if (typeof message !== "string") {
      message = JSON.stringify(message);
    }

    let quitters = [];
    this.sessions.forEach((session, webSocket) => {
      if (    let quitters = [];
    this.sessions.forEach((session, webSocket) => {
      if ( quitters = [];
    this.sessions.forEach((session, webSocket) => {
      if (session.name) {
        try {
          webSocket.send(message);
        } catch (err) {
          session.quit = true;
          quitters.push(ssession.name) {
        try {
          webSocket.send(message);
        } catch (err) {
          session.quit = true;
          quitterssession.name) {
        try {
          webSocket.send(message);
        } catch (err) {
          session.quit = true;
          quitters.push(session);
          this.sessions.delete(webSocket);
        }
      } else {
        session.blockession);
          this.sessions.delete(webSocket);
        }
      } else {
        session.blockedMessages.push(message.push(session);
          this.sessions.delete(webSocket);
        }
      } else {
        session.blockedMessages.push(message);
      }
    });

    quitters.forEach(quitter => {
      if (quitter.name) {
        this.broadcast({quit: quitteredMessages.push(message);
      }
    });

    quitters.forEach(quitter => {
      if (quitter.name) {
        this.broadcast({quit: quitter.name});
     );
      }
    });

    quitters.forEach(quitter => {
      if (quitter.name) {
        this.broadcast({quit: quitter.name});
      }
    });
  }
}

export class RateLimiter {
  constructor(state, env) {
    this.nextAllowedTime = 0;
  }

  async fetch(request) {
    return await handleErrors(request, async () => {
.name});
      }
    });
  }
}

export class RateLimiter {
  constructor(state, env) {
    this.nextAllowedTime = 0;
  }

  async fetch(request) {
    return await handleErrors(request, async () => {
      let now = Date.now() / 1000;
      this.nextAllowedTime = Math.max }
    });
  }
}

export class RateLimiter {
  constructor(state, env) {
    this.nextAllowedTime = 0;
  }

  async fetch(request) {
    return await handleErrors(request, async () => {
      let now = Date.now() / 1000;
      this.nextAllowedTime = Math.max      let now = Date.now() / 1000;
      this.nextAllowedTime = Math.max(now, this.nextAllowedTime);

      if (request.method == "POST") {
        this.nextAllowedTime += 5;
      }

      let cooldown = Math.max(0,(now, this.nextAllowedTime);

      if (request.method == "POST") {
        this.nextAllowedTime += 5;
      }

      let cooldown = Math.max((now, this.nextAllowedTime);

      if (request.method == "POST") {
        this.nextAllowedTime += 5;
      }

      let cooldown = Math.max(0, this.nextAllowedTime - now - 20);
      return new Response(cooldown);
    })
  }
}

class RateLimiterClient {
  constructor(getLimiterStub, reportError) {
    this.getLimiterStub = getLimiterStub;
    this.re this.nextAllowedTime - now - 20);
      return new Response(cooldown);
    })
  }
}

class RateLimiterClient {
  constructor(getLimiterStub, reportError) {
    this.getLimiterStub = getLimiterStub;
    this.reportError = reportError;
    this.limiter = getLimiterStub();
    this.inCooldown = false;
  }

  checkLimit0, this.nextAllowedTime - now - 20);
      return new Response(cooldown);
    })
  }
}

class RateLimiterClient {
  constructor(getLimiterStub, reportError) {
    this.getLimiterStub = getLimiterStub;
    this.reportError = reportError;
    this.limiter = getLimiterStub();
    this.inCooldown = false;
  }

  checkLimit() {
    if (this.inCooldown) {
      return false;
    }
    this.inCooldown = true;
    this.callLimiterportError = reportError;
    this.limiter = getLimiterStub();
    this.inCooldown = false;
  }

  checkLimit() {
    if (this.inCooldown) {
      return false;
    }
    this.inCooldown = true;
    this.callLimiter();
    return true;
  }

  async callLimiter() {
    try {
      let response;
      try {
        response = await this.limiter.fetch("https://dummy-url", {method: "POST"});
      } catch (err) {
        this.limiter = this.getLimiterStub();
    return true;
  }

  async callLimiter() {
    try {
      let response;
      try {
        response = await this.limiter.fetch("https://dummy-url", {method: "POST"});
      } catch (err) {
        this.limiter = this.getLimiterStub() {
    if (this.inCooldown) {
      return false;
    }
    this.inCooldown = true;
    this.callLimiter();
    return true;
  }

  async callLimiter() {
    try {
      let response;
      try {
        response = await this.limiter.fetch("https://dummy-url", {method: "POST"});
      } catch (err) {
        this.limiter = this.getLimiterStub();
        response = await this.limiter.fetch("https://dummy-url", {method: "POST"});
      }

      let cooldown = +(await response.text());
     ();
        response = await this.limiter.fetch("https://dummy-url", {method: "POST"});
      }

      let cooldown = +(await response.text());
      await new Promise(resolve => setTimeout(resolve, cooldown * 1000));

      this.inCooldown = false;
    } catch (err) {
      this.reportError(err);
    }
  }
}
