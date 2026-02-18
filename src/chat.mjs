// This is the Edge Chat Demo Worker, built using Durable Objects!
// BINDINGS: READTALK_KV, READTALK_DB, READTALK_R2, OPENAUTH (service binding)

import HTML from "./chat.html";

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

      // Root → serve HTML
      if (!path[0]) {
        return new Response(HTML, {headers: {"Content-Type": "text/html;charset=UTF-8"}});
      }

      // 🔥 API routes
      switch (path[0]) {
        case "api":
          return handleApiRequest(path.slice(1), request, env);
        case "auth":
          return handleAuthRequest(path.slice(1), request, env);
        default:
          return new Response("Not found", {status: 404});
      }
    });
  }
}

// ===== 🔥 HANDLE AUTH RELATED ENDPOINTS =====
async function handleAuthRequest(path, request, env) {
  switch (path[0]) {
    case "exchange": {
      // POST /auth/exchange - tukar code dengan token
      if (request.method !== "POST") {
        return new Response("Method not allowed", {status: 405});
      }
      
      const { code } = await request.json();
      
      // Panggil OpenAuth untuk tukar code dengan token
      const tokenRes = await env.OPENAUTH.fetch("https://openauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "authorization_code",
          code: code,
          redirect_uri: "https://room.soeparnocorp.workers.dev",
          client_id: "readtalk-client"
        })
      });
      
      if (!tokenRes.ok) {
        return new Response("Failed to exchange code", {status: 400});
      }
      
      const tokenData = await tokenRes.json();
      
      // Simpan token di KV (opsional)
      // await env.READTALK_KV.put(`session:${tokenData.access_token}`, JSON.stringify(tokenData), {expirationTtl: 86400});
      
      return new Response(JSON.stringify({
        token: tokenData.access_token,
        user: tokenData.user
      }), {
        headers: { "Content-Type": "application/json" }
      });
    }
    
    default:
      return new Response("Not found", {status: 404});
  }
}

async function handleApiRequest(path, request, env) {
  switch (path[0]) {
    case "room": {
      if (!path[1]) {
        if (request.method == "POST") {
          let id = env.rooms.newUniqueId();
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

export class ChatRoom {
  constructor(state, env) {
    this.state = state;
    this.storage = state.storage;
    this.env = env;
    this.sessions = new Map();  // WebSocket -> session data
    this.userSessions = new Map(); // userId -> WebSocket (untuk 1 user 1 DO nanti)
    this.lastTimestamp = 0;

    // Restore from hibernation
    this.state.getWebSockets().forEach((webSocket) => {
      let meta = webSocket.deserializeAttachment();
      let limiterId = this.env.limiters.idFromString(meta.limiterId);
      let limiter = new RateLimiterClient(
        () => this.env.limiters.get(limiterId),
        err => webSocket.close(1011, err.stack)
      );
      let blockedMessages = [];
      this.sessions.set(webSocket, { ...meta, limiter, blockedMessages });
      
      // 🔥 Kalo ada userId, simpan juga di userSessions
      if (meta.userId) {
        this.userSessions.set(meta.userId, webSocket);
      }
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

          // 🔥 CEK TOKEN DARI QUERY PARAMETER
          const token = url.searchParams.get("token");
          
          if (!token) {
            return new Response("Unauthorized: No token", {status: 401});
          }
          
          // 🔥 Verifikasi token ke OpenAuth
          const user = await verifyToken(token, this.env);
          if (!user) {
            return new Response("Unauthorized: Invalid token", {status: 401});
          }

          let ip = request.headers.get("CF-Connecting-IP");
          let pair = new WebSocketPair();
          
          // 🔥 Kirim user info ke handleSession
          await this.handleSession(pair[1], ip, user);
          
          return new Response(null, { status: 101, webSocket: pair[0] });
        }

        default:
          return new Response("Not found", {status: 404});
      }
    });
  }

  // 🔥 MODIFIED: terima user dari token
  async handleSession(webSocket, ip, user) {
    this.state.acceptWebSocket(webSocket);

    let limiterId = this.env.limiters.idFromName(ip);
    let limiter = new RateLimiterClient(
      () => this.env.limiters.get(limiterId),
      err => webSocket.close(1011, err.stack)
    );

    let session = { 
      limiterId, 
      limiter, 
      blockedMessages: [],
      userId: user.id,
      name: user.email?.split('@')[0] || user.id.slice(0, 8) // fallback name
    };
    
    webSocket.serializeAttachment({ 
      limiterId: limiterId.toString(),
      userId: user.id
    });
    
    this.sessions.set(webSocket, session);
    this.userSessions.set(user.id, webSocket); // 🔥 Simpan mapping userId -> WebSocket

    // Kirim daftar user online ke client baru
    let onlineUsers = [];
    for (let [ws, s] of this.sessions) {
      if (s.name && ws !== webSocket) {
        onlineUsers.push({
          id: s.userId,
          name: s.name,
          status: 'online'
        });
      }
    }
    
    if (onlineUsers.length > 0) {
      session.blockedMessages.push(JSON.stringify({
        type: 'user_list',
        online: onlineUsers
      }));
    }

    // Load backlog messages
    let storage = await this.storage.list({reverse: true, limit: 100});
    let backlog = [...storage.values()];
    backlog.reverse();
    backlog.forEach(value => {
      session.blockedMessages.push(value);
    });
    
    // Kasih tau user lain bahwa ada user baru join
    this.broadcast({
      type: 'user_joined',
      user: {
        id: user.id,
        name: session.name,
        status: 'online'
      }
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

      // Handle different message types
      if (data.type === 'update_status') {
        // Update user status
        session.status = data.status;
        this.broadcast({
          type: 'status_update',
          userId: session.userId,
          status: data.status
        });
        return;
      }
      
      if (data.type === 'update_profile') {
        // Update profile (name, about, dll)
        if (data.name) session.name = data.name;
        if (data.about) session.about = data.about;
        
        // Simpan ke storage (opsional)
        await this.storage.put(`profile:${session.userId}`, JSON.stringify({
          name: session.name,
          about: session.about
        }));
        
        this.broadcast({
          type: 'profile_update',
          userId: session.userId,
          name: session.name,
          about: session.about
        });
        return;
      }

      // Regular chat message
      if (data.message) {
        let messageData = { 
          type: 'message',
          userId: session.userId,
          name: session.name, 
          message: "" + data.message 
        };

        if (messageData.message.length > 256) {
          webSocket.send(JSON.stringify({error: "Message too long."}));
          return;
        }

        messageData.timestamp = Math.max(Date.now(), this.lastTimestamp + 1);
        this.lastTimestamp = messageData.timestamp;

        let dataStr = JSON.stringify(messageData);
        this.broadcast(dataStr);

        // Save to storage
        let key = new Date(messageData.timestamp).toISOString();
        await this.storage.put(key, dataStr);
      }
      
    } catch (err) {
      webSocket.send(JSON.stringify({error: err.stack}));
    }
  }

  async closeOrErrorHandler(webSocket) {
    let session = this.sessions.get(webSocket) || {};
    session.quit = true;
    this.sessions.delete(webSocket);
    
    // 🔥 Hapus dari userSessions
    if (session.userId) {
      this.userSessions.delete(session.userId);
    }
    
    if (session.name) {
      this.broadcast({
        type: 'user_left',
        userId: session.userId,
        name: session.name
      });
    }
  }

  async webSocketClose(webSocket, code, reason, wasClean) {
    this.closeOrErrorHandler(webSocket);
  }

  async webSocketError(webSocket, error) {
    this.closeOrErrorHandler(webSocket);
  }

  broadcast(message) {
    if (typeof message !== "string") {
      message = JSON.stringify(message);
    }

    let quitters = [];
    this.sessions.forEach((session, webSocket) => {
      if (session.name) {
        try {
          webSocket.send(message);
        } catch (err) {
          session.quit = true;
          quitters.push(session);
          this.sessions.delete(webSocket);
          if (session.userId) {
            this.userSessions.delete(session.userId);
          }
        }
      } else {
        session.blockedMessages.push(message);
      }
    });

    // Notify about quitters
    quitters.forEach(quitter => {
      if (quitter.name) {
        this.broadcast({
          type: 'user_left',
          userId: quitter.userId,
          name: quitter.name
        });
      }
    });
  }
}

// ===== 🔥 HELPER: VERIFY TOKEN DENGAN OPENAUTH =====
async function verifyToken(token, env) {
  try {
    const res = await env.OPENAUTH.fetch("https://openauth/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token })
    });
    
    if (!res.ok) return null;
    
    const data = await res.json();
    return data.user; // { id, email }
  } catch (err) {
    console.error("Verify token failed:", err);
    return null;
  }
}

// ===== RateLimiter (tidak berubah) =====
export class RateLimiter {
  constructor(state, env) {
    this.nextAllowedTime = 0;
  }

  async fetch(request) {
    return await handleErrors(request, async () => {
      let now = Date.now() / 1000;
      this.nextAllowedTime = Math.max(now, this.nextAllowedTime);
      if (request.method == "POST") {
        this.nextAllowedTime += 5;
      }
      let cooldown = Math.max(0, this.nextAllowedTime - now - 20);
      return new Response(cooldown);
    });
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
    if (this.inCooldown) return false;
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
      await new Promise(resolve => setTimeout(resolve, cooldown * 1000));
      this.inCooldown = false;
    } catch (err) {
      this.reportError(err);
    }
  }
}
