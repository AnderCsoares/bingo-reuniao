// Servidor do Bingo da Reunião: guarda o jogo, os participantes e a senha do moderador.
// Sem dependências externas. No Render: Build "npm install", Start "npm start",
// variável de ambiente MOD_PASSWORD com a senha do moderador.
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const PASSWORD = process.env.MOD_PASSWORD || "";
const TOTAL_PHRASES = 50;
const ONLINE_MS = 35000; // sem sinal do celular por 35 s = offline

// Mesmas regras de código usadas na página (index.html).
const ALPH = "ACDEFHJKMNPRTWXY34679";
function hash(str) { let h = 2166136261; for (const c of str) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
function checkChar(salt, base) { return ALPH[hash(salt + base) % ALPH.length]; }
function randomChars(n) { return Array.from(crypto.randomBytes(n), b => ALPH[b % ALPH.length]).join(""); }
function validCode(c) { return typeof c === "string" && c.length === 4 && [...c].every(ch => ALPH.includes(ch)); }
function gameCheck(b) { return checkChar("jogo:", b) + checkChar("jogo2:", b); }
function newGameCode() { const b = randomChars(2); return b + gameCheck(b); }
function validGame(c) { return validCode(c) && c.slice(2) === gameCheck(c.slice(0, 2)); }
function newCardCode(game) { const b = randomChars(3); return b + checkChar("cartela:" + game + ":", b); }
function validCard(game, c) { return validCode(c) && c[3] === checkChar("cartela:" + game + ":", c.slice(0, 3)); }

// Estado em memória. "fresh" = servidor acabou de ligar e ainda não recebeu nada.
let state = { game: newGameCode(), count: 0, players: new Map(), fresh: true };
// Sessão do moderador assinada com a senha: continua valendo se o servidor reiniciar.
function sign(id) { return crypto.createHmac("sha256", "bingo-mod:" + PASSWORD).update(id).digest("hex"); }
function newToken() { const id = crypto.randomBytes(16).toString("hex"); return id + "." + sign(id); }
function tokenOk(t) {
  if (!PASSWORD || typeof t !== "string") return false;
  const [id, sig] = t.split(".");
  if (!id || !sig || sig.length !== 64) return false;
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(sign(id)));
}

const cleanName = n => (typeof n === "string" ? n.replace(/\s+/g, " ").trim().slice(0, 30) : "");
const started = () => state.count > 0;
function publicState() { return { game: state.game, count: state.count, started: started() }; }
function modState() {
  const t = Date.now();
  const players = [...state.players.values()]
    .sort((a, b) => a.joined - b.joined)
    .map(p => ({ name: p.name, code: p.code, online: t - p.seen < ONLINE_MS }));
  return { ...publicState(), players, total: players.length, online: players.filter(p => p.online).length };
}
function uniqueCardCode() {
  for (let i = 0; i < 200; i++) { const c = newCardCode(state.game); if (!state.players.has(c)) return c; }
  throw new Error("Não foi possível gerar uma cartela nova.");
}
function passwordOk(given) {
  const a = crypto.createHash("sha256").update(String(given || "")).digest();
  const b = crypto.createHash("sha256").update(PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}

function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(data));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", chunk => { raw += chunk; if (raw.length > 10000) { reject(new Error("too big")); req.destroy(); } });
    req.on("end", () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { resolve({}); } });
    req.on("error", reject);
  });
}

const routes = {
  "GET /api/state": () => [200, publicState()],

  "POST /api/join": body => {
    const name = cleanName(body.name);
    if (!name) return [400, { error: "Digite seu nome." }];
    const code = uniqueCardCode();
    state.players.set(code, { name, code, joined: Date.now(), seen: Date.now() });
    state.fresh = false;
    return [200, { game: state.game, code, started: started() }];
  },

  "POST /api/swap": body => {
    if (body.game !== state.game) return [410, { ended: true, error: "Este jogo terminou." }];
    if (started()) return [409, { started: true, error: "O sorteio já começou. Não dá mais para trocar a cartela." }];
    const old = state.players.get(body.code);
    if (!old) return [404, { error: "Cartela não encontrada." }];
    state.players.delete(body.code);
    const code = uniqueCardCode();
    state.players.set(code, { ...old, code, seen: Date.now() });
    return [200, { code }];
  },

  "POST /api/ping": body => {
    // Se o servidor reiniciou, adota o jogo que os celulares já estavam jogando.
    if (state.fresh && validGame(body.game) && body.game !== state.game) { state.game = body.game; state.fresh = false; }
    if (body.game !== state.game) return [200, { ended: true }];
    if (!validCard(state.game, body.code)) return [400, { error: "Cartela inválida." }];
    const p = state.players.get(body.code) || { name: cleanName(body.name) || "Sem nome", code: body.code, joined: Date.now() };
    p.seen = Date.now();
    state.players.set(p.code, p);
    state.fresh = false;
    return [200, { started: started(), count: state.count }];
  },

  "POST /api/login": async body => {
    if (!PASSWORD) return [503, { error: "A senha do moderador não foi configurada no Render (variável MOD_PASSWORD)." }];
    if (!passwordOk(body.password)) { await new Promise(r => setTimeout(r, 700)); return [401, { error: "Senha incorreta." }]; }
    return [200, { token: newToken() }];
  },

  "GET /api/mod/state": () => [200, modState()],
  "POST /api/mod/draw": () => { if (state.count < TOTAL_PHRASES) state.count++; state.fresh = false; return [200, modState()]; },
  "POST /api/mod/undo": () => { if (state.count > 0) state.count--; return [200, modState()]; },
  "POST /api/mod/reset": () => { state.count = 0; return [200, modState()]; },
  "POST /api/mod/newgame": () => { state = { game: newGameCode(), count: 0, players: new Map(), fresh: false }; return [200, modState()]; },
  // Depois de um reinício do servidor, o navegador do moderador devolve o jogo e o número de sorteios.
  "POST /api/mod/restore": body => {
    const count = Math.max(0, Math.min(TOTAL_PHRASES, Number(body.count) || 0));
    if (validGame(body.game) && state.count === 0 && (state.fresh || state.game === body.game)) {
      if (state.game !== body.game) { state.game = body.game; state.players = new Map(); }
      state.count = count; state.fresh = false;
    }
    return [200, modState()];
  }
};

const indexPath = path.join(__dirname, "index.html");

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
      return fs.createReadStream(indexPath).pipe(res);
    }
    if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { ok: true });
    const handler = routes[req.method + " " + url.pathname];
    if (!handler) return send(res, 404, { error: "Não encontrado." });
    if (url.pathname.startsWith("/api/mod/")) {
      const auth = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
      if (!tokenOk(auth)) return send(res, 401, { error: "Entre com a senha do moderador." });
    }
    const body = req.method === "POST" ? await readBody(req) : {};
    const [status, data] = await handler(body);
    send(res, status, data);
  } catch (e) {
    console.error(e);
    send(res, 500, { error: "Erro no servidor." });
  }
});

server.listen(PORT, () => console.log("Bingo da Reunião rodando na porta " + PORT + (PASSWORD ? "" : " (ATENÇÃO: MOD_PASSWORD não definida)")));
