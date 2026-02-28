import HTML from "./index.html";

async function handleErrors(request, func) {
  try {
    return await func();
  } catch (err) {
    if (request.headers.get("Upgrade") == "websocket") {
      let pair = new WebSocketPair();
      pair[1].accept();
      pair[1].send(JSON.stringify({ error: err.stack }));
      pair[1].close(1011, "Uncaught exception during session setup");
      return new Response(null, { status: 101, webSocket: pair[0] });
    } else {
      return new Response(err.stack, { status: 500 });
    }
  }
}

export default {
  async fetch(request, env) {
    return await handleErrors(request, async () => {
      let url = new URL(request.url);
      let path = url.pathname.slice(1).split("/");

      if (!path[0]) {
        return new Response(HTML, {
          headers: { "Content-Type": "text/html;charset=UTF-8" },
        });
      }

      switch (path[0]) {
        case "api":
          return handleApiRequest(path.slice(1), request, env);
        default:
          return new Response("Not found", { status: 404 });
      }
    });
  },
};

// ===== FUNGSI BANTU =====
function generateHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36).substring(0, 4);
}

function emailToUsername(email) {
  // ambil bagian sebelum @, bersihkan, potong
  let local = email.split('@')[0].replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  if (local.length > 8) local = local.substring(0, 8);
  
  // tambah hash pendek dari email
  const hash = generateHash(email);
  return `@${local}_${hash}`; // @johndoe_a1b2
}

function validateRoomName(name) {
  return /^[a-z0-9_]{1,12}$/.test(name);
}

async function getUserFromEmail(email, env) {
  const identitas = await env.READTALK_KV.get(`email:${email}`);
  if (!identitas) return null;
  
  const userData = await env.READTALK_KV.get(`user:${identitas}`);
  return userData ? JSON.parse(userData) : null;
}

async function getUserFromCode(code, env) {
  const identitas = await env.READTALK_KV.get(`code:${code}`);
  if (!identitas) return null;
  
  const userData = await env.READTALK_KV.get(`user:${identitas}`);
  return userData ? JSON.parse(userData) : null;
}

// ===== API HANDLER =====
async function handleApiRequest(path, request, env) {
  const url = new URL(request.url);
  const email = url.searchParams.get("email");
  const code = url.searchParams.get("code");
  
  // ===== ROOMS ENDPOINTS (PUBLIC ROOM) =====
  if (path[0] === "rooms" && request.method === "GET") {
    try {
      const { results } = await env.READTALK_DB.prepare(`
        SELECT * FROM rooms 
        WHERE type = 'public'
        ORDER BY last_active DESC
      `).all();
      
      return new Response(JSON.stringify(results), {
        headers: { "Content-Type": "application/json" }
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), { status: 500 });
    }
  }

  // CREATE PUBLIC ROOM
  if (path[0] === "rooms" && request.method === "POST") {
    try {
      const { name } = await request.json();
      
      // VALIDASI: hanya huruf kecil, angka, underscore, max 12
      if (!validateRoomName(name)) {
        return new Response(JSON.stringify({ 
          error: "Nama room hanya huruf kecil, angka, underscore, max 12 karakter" 
        }), { status: 400 });
      }
      
      // CEK UNIK
      const existing = await env.READTALK_DB.prepare(
        "SELECT id FROM rooms WHERE name = ?"
      ).bind(name).first();
      
      if (existing) {
        return new Response(JSON.stringify({ 
          error: "Nama room sudah digunakan" 
        }), { status: 409 });
      }
      
      // Buat room di Durable Object
      let roomId = env.rooms.idFromName(name);
      
      // Simpan ke D1
      const { results } = await env.READTALK_DB.prepare(`
        INSERT INTO rooms (name, type, display_name) 
        VALUES (?, 'public', ?) RETURNING id
      `).bind(name, `#${name}`).run();
      
      return new Response(JSON.stringify({
        id: results[0].id,
        name: name,
        display: `#${name}`,
        type: "public"
      }), {
        headers: { "Content-Type": "application/json" }
      });
      
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), { status: 500 });
    }
  }

  // ===== CHECK ROOM AVAILABILITY =====
  if (path[0] === "check-room" && request.method === "GET") {
    const roomName = url.searchParams.get("name");
    
    if (!roomName || !validateRoomName(roomName)) {
      return new Response(JSON.stringify({ 
        valid: false,
        message: "Format tidak sesuai" 
      }), { headers: { "Content-Type": "application/json" } });
    }
    
    const existing = await env.READTALK_DB.prepare(
      "SELECT id FROM rooms WHERE name = ?"
    ).bind(roomName).first();
    
    return new Response(JSON.stringify({
      available: !existing,
      name: roomName,
      display: `#${roomName}`
    }), {
      headers: { "Content-Type": "application/json" }
    });
  }

  // ===== USER API =====
  if (path[0] === "user") {
    // GET USER DATA
    if (request.method === "GET") {
      try {
        let user = null;
        
        if (email) {
          user = await getUserFromEmail(email, env);
        } else if (code) {
          user = await getUserFromCode(code, env);
        }
        
        if (!user) {
          return new Response(JSON.stringify({ exists: false }), {
            headers: { "Content-Type": "application/json" }
          });
        }
        
        // Ambil riwayat ganti username
        const usernameHistory = await env.READTALK_KV.get(`history:${user.identitas}`);
        
        return new Response(JSON.stringify({
          ...user,
          usernameHistory: usernameHistory ? JSON.parse(usernameHistory) : []
        }), {
          headers: { "Content-Type": "application/json" }
        });
        
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500 });
      }
    }
    
    // REGISTER USER BARU
    if (request.method === "POST") {
      if (!email || !code) {
        return new Response(JSON.stringify({ 
          error: "Email dan code required" 
        }), { status: 400 });
      }
      
      try {
        const { name } = await request.json();
        
        if (!name || name.length > 20) {
          return new Response(JSON.stringify({ 
            error: "Nama harus 1-20 karakter" 
          }), { status: 400 });
        }
        
        // Cek email sudah terdaftar
        const existing = await env.READTALK_KV.get(`email:${email}`);
        if (existing) {
          return new Response(JSON.stringify({ 
            error: "Email sudah terdaftar" 
          }), { status: 409 });
        }
        
        // Buat identitas unik dari email
        const identitas = emailToUsername(email); // @johndoe_a1b2
        
        // Simpan user
        const userData = {
          identitas: identitas,
          email: email,
          name: name,
          username: identitas, // default = identitas
          usernameLastChanged: null,
          avatar: "",
          about: "",
          createdAt: Date.now()
        };
        
        // Simpan mapping
        await env.READTALK_KV.put(`email:${email}`, identitas, {
          expirationTtl: 60 * 60 * 24 * 365
        });
        
        await env.READTALK_KV.put(`code:${code}`, identitas, {
          expirationTtl: 60 * 60 * 24 * 90
        });
        
        await env.READTALK_KV.put(`user:${identitas}`, JSON.stringify(userData), {
          expirationTtl: 60 * 60 * 24 * 365
        });
        
        // Riwayat username
        await env.READTALK_KV.put(`history:${identitas}`, JSON.stringify([{
          username: identitas,
          changedAt: Date.now()
        }]), {
          expirationTtl: 60 * 60 * 24 * 365
        });
        
        return new Response(JSON.stringify({
          success: true,
          user: userData
        }), {
          headers: { "Content-Type": "application/json" }
        });
        
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500 });
      }
    }
    
    // UPDATE USER (NAME ATAU USERNAME)
    if (request.method === "PUT") {
      if (!email && !code) {
        return new Response(JSON.stringify({ 
          error: "Email atau code required" 
        }), { status: 400 });
      }
      
      try {
        const { name, username } = await request.json();
        
        // Cari user
        let user = null;
        let identitas = null;
        
        if (email) {
          identitas = await env.READTALK_KV.get(`email:${email}`);
        } else if (code) {
          identitas = await env.READTALK_KV.get(`code:${code}`);
        }
        
        if (!identitas) {
          return new Response(JSON.stringify({ error: "User not found" }), { 
            status: 404 
          });
        }
        
        const userData = await env.READTALK_KV.get(`user:${identitas}`);
        user = JSON.parse(userData);
        
        // UPDATE NAME (bebas kapanpun)
        if (name && name !== user.name) {
          if (name.length > 20) {
            return new Response(JSON.stringify({ 
              error: "Nama maksimal 20 karakter" 
            }), { status: 400 });
          }
          user.name = name;
        }
        
        // UPDATE USERNAME (1x per 90 hari)
        if (username && username !== user.username) {
          // Validasi format username (harus @...)
          if (!username.startsWith('@') || username.length < 3 || username.length > 20) {
            return new Response(JSON.stringify({ 
              error: "Username harus dimulai dengan @ dan 3-20 karakter" 
            }), { status: 400 });
          }
          
          // Cek 90 hari
          const now = Date.now();
          const daysSinceLastChange = user.usernameLastChanged ? 
            (now - user.usernameLastChanged) / (1000 * 60 * 60 * 24) : 91;
          
          if (daysSinceLastChange < 90) {
            const daysLeft = Math.ceil(90 - daysSinceLastChange);
            return new Response(JSON.stringify({ 
              error: `Username bisa diganti lagi ${daysLeft} hari lagi` 
            }), { status: 403 });
          }
          
          // Cek apakah username sudah dipakai
          // TODO: cek ke database
          
          // Update username
          user.username = username;
          user.usernameLastChanged = now;
          
          // Catat riwayat
          const history = await env.READTALK_KV.get(`history:${identitas}`);
          const historyData = history ? JSON.parse(history) : [];
          historyData.push({
            username: username,
            changedAt: now
          });
          await env.READTALK_KV.put(`history:${identitas}`, JSON.stringify(historyData), {
            expirationTtl: 60 * 60 * 24 * 365
          });
        }
        
        // Simpan kembali
        await env.READTALK_KV.put(`user:${identitas}`, JSON.stringify(user), {
          expirationTtl: 60 * 60 * 24 * 365
        });
        
        return new Response(JSON.stringify({
          success: true,
          user: user
        }), {
          headers: { "Content-Type": "application/json" }
        });
        
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500 });
      }
    }
  }

  // ===== ROOM ENDPOINTS =====
  switch (path[0]) {
    case "room": {
      if (!path[1]) {
        if (request.method == "POST") {
          // CREATE PRIVATE ROOM (hash)
          let id = env.rooms.newUniqueId();
          
          try {
            await env.READTALK_DB.prepare(
              "INSERT INTO rooms (name, type, is_private) VALUES (?, 'private', ?)"
            ).bind(id.toString(), 1).run();
          } catch (e) {}
          
          return new Response(JSON.stringify({
            roomId: id.toString(),
            type: "private",
            display: id.toString().substring(0, 8) + "..."
          }), {
            headers: { "Content-Type": "application/json" }
          });
        }
        return new Response("Method not allowed", { status: 405 });
      }

      let roomName = path[1];
      let roomId;
      
      // Cek apakah ini hash atau nama public
      if (roomName.match(/^[0-9a-f]{64}$/)) {
        // PRIVATE ROOM (hash)
        roomId = env.rooms.idFromString(roomName);
      } else if (validateRoomName(roomName)) {
        // PUBLIC ROOM (nama)
        roomId = env.rooms.idFromName(roomName);
      } else {
        return new Response("Invalid room name", { status: 404 });
      }

      let roomObject = env.rooms.get(roomId);
      let newUrl = new URL(request.url);
      newUrl.pathname = "/" + path.slice(2).join("/");
      return roomObject.fetch(newUrl, request);
    }

    default:
      return new Response("Not found", { status: 404 });
  }
}

export class ChatRoom {
  constructor(state, env) {
    this.state = state;
    this.storage = state.storage;
    this.env = env;
    this.sessions = new Map();
    this.lastTimestamp = 0;
    this.roomName = this.getRoomNameFromId(state.id.toString());

    this.state.getWebSockets().forEach((webSocket) => {
      let meta = webSocket.deserializeAttachment();
      let limiterId = this.env.limiters.idFromString(meta.limiterId);
      let limiter = new RateLimiterClient(
        () => this.env.limiters.get(limiterId),
        (err) => webSocket.close(1011, err.stack)
      );
      let blockedMessages = [];
      this.sessions.set(webSocket, { ...meta, limiter, blockedMessages });
    });
  }

  getRoomNameFromId(id) {
    // Coba cek di database
    return id; // sementara
  }

  async fetch(request) {
    return await handleErrors(request, async () => {
      let url = new URL(request.url);

      switch (url.pathname) {
        case "/websocket": {
          if (request.headers.get("Upgrade") != "websocket") {
            return new Response("expected websocket", { status: 400 });
          }

          const code = url.searchParams.get("code");
          const email = url.searchParams.get("email");
          
          let ip = request.headers.get("CF-Connecting-IP");
          let pair = new WebSocketPair();
          await this.handleSession(pair[1], ip, { code, email });
          return new Response(null, { status: 101, webSocket: pair[0] });
        }

        default:
          return new Response("Not found", { status: 404 });
      }
    });
  }

  async handleSession(webSocket, ip, auth = {}) {
    this.state.acceptWebSocket(webSocket);

    let limiterId = this.env.limiters.idFromName(ip);
    let limiter = new RateLimiterClient(
      () => this.env.limiters.get(limiterId),
      (err) => webSocket.close(1011, err.stack)
    );

    // Simpan data auth sementara
    let session = { 
      limiterId, 
      limiter, 
      blockedMessages: [],
      authCode: auth.code,
      authEmail: auth.email
    };
    
    webSocket.serializeAttachment({ 
      limiterId: limiterId.toString() 
    });
    this.sessions.set(webSocket, session);

    // Kirim backlog messages
    let storage = await this.storage.list({ reverse: true, limit: 100 });
    let backlog = [...storage.values()].reverse();
    backlog.forEach((value) => {
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
          error: "Rate limited, please try again later."
        }));
        return;
      }

      let data = JSON.parse(msg);

      // PESAN PERTAMA: SETUP USER
      if (!session.name) {
        // Validasi user dari email/code
        let user = null;
        
        if (session.authEmail) {
          user = await getUserFromEmail(session.authEmail, this.env);
        } else if (session.authCode) {
          user = await getUserFromCode(session.authCode, this.env);
        }
        
        if (!user && (session.authEmail || session.authCode)) {
          // User belum register, minta register dulu
          webSocket.send(JSON.stringify({ 
            error: "Silakan register dulu",
            needRegister: true,
            email: session.authEmail
          }));
          webSocket.close(1008, "Need registration");
          return;
        }
        
        // Set user data
        session.name = data.name || (user ? user.name : "anonymous");
        session.email = user ? user.email : session.authEmail;
        session.identitas = user ? user.identitas : `anon_${Date.now()}`;
        session.username = user ? user.username : session.identitas;
        
        // Validasi name length (max 20)
        if (session.name.length > 20) {
          webSocket.send(JSON.stringify({ 
            error: "Nama maksimal 20 karakter" 
          }));
          webSocket.close(1009, "Name too long");
          return;
        }
        
        webSocket.serializeAttachment({
          ...webSocket.deserializeAttachment(),
          name: session.name,
          identitas: session.identitas,
          email: session.email,
          username: session.username
        });

        // Kirim backlog
        session.blockedMessages.forEach(m => webSocket.send(m));
        delete session.blockedMessages;

        // Broadcast join
        this.broadcast({ 
          type: "join",
          name: session.name,
          identitas: session.identitas,
          username: session.username,
          room: `#${this.roomName}`
        });

        // Kirim ready dengan data user
        webSocket.send(JSON.stringify({ 
          type: "ready",
          user: {
            name: session.name,
            identitas: session.identitas,
            username: session.username,
            email: session.email
          },
          room: `#${this.roomName}`
        }));
        
        return;
      }

      // PESAN CHAT BIASA
      if (data.message) {
        if (data.message.length > 256) {
          webSocket.send(JSON.stringify({ error: "Message too long" }));
          return;
        }

        let messageData = {
          type: "message",
          name: session.name,
          identitas: session.identitas,
          username: session.username,
          message: data.message,
          timestamp: Date.now()
        };

        // Broadcast ke semua
        this.broadcast(messageData);

        // Simpan ke storage
        let key = new Date(messageData.timestamp).toISOString();
        await this.storage.put(key, JSON.stringify(messageData));
      }
      
    } catch (err) {
      webSocket.send(JSON.stringify({ error: err.message }));
    }
  }

  async closeOrErrorHandler(webSocket) {
    let session = this.sessions.get(webSocket) || {};
    session.quit = true;
    this.sessions.delete(webSocket);
    
    if (session.name) {
      this.broadcast({ 
        type: "leave",
        name: session.name,
        identitas: session.identitas,
        username: session.username
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
    let messageStr = typeof message === "string" ? message : JSON.stringify(message);
    
    this.sessions.forEach((session, webSocket) => {
      if (session.name && !session.quit) {
        try {
          webSocket.send(messageStr);
        } catch (err) {
          session.quit = true;
          this.sessions.delete(webSocket);
        }
      } else if (!session.name) {
        session.blockedMessages.push(messageStr);
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
        response = await this.limiter.fetch("https://dummy-url", {
          method: "POST",
        });
      } catch (err) {
        this.limiter = this.getLimiterStub();
        response = await this.limiter.fetch("https://dummy-url", {
          method: "POST",
        });
      }

      let cooldown = +(await response.text());
      await new Promise((resolve) => setTimeout(resolve, cooldown * 1000));
      this.inCooldown = false;
    } catch (err) {
      this.reportError(err);
    }
  }
}
