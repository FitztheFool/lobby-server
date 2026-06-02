// lobby-server/src/index.ts
import 'dotenv/config';
import { timingSafeEqual } from 'crypto';
import express from 'express';
import cors from 'cors';
import http from 'http';
import { Server } from 'socket.io';
import { corsConfig, setupSocketAuth } from '@kwizar/shared';
import { registerGameServer, GAME_SERVER_URLS } from './gameServers';
import { registerHandlers } from './handlers';

const app = express();
app.get('/health', cors(), (_req, res) => res.status(200).send('ok'));

// ── Internal push: let the Next app deliver realtime events to a user ───────────
// Used by the DM API to push `dm:message` to a recipient's personal room.
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY;
const EMIT_EVENT_ALLOWLIST = new Set(['dm:message', 'dm:read', 'lobby:invited']);

function authorizedInternal(authHeader: string): boolean {
    if (!INTERNAL_API_KEY) return false;
    const expected = `Bearer ${INTERNAL_API_KEY}`;
    if (authHeader.length !== expected.length) return false;
    return timingSafeEqual(Buffer.from(authHeader), Buffer.from(expected));
}

app.post('/internal/emit', express.json({ limit: '64kb' }), (req, res) => {
    if (!authorizedInternal(req.headers.authorization ?? '')) {
        res.status(401).json({ error: 'unauthorized' });
        return;
    }
    const { room, event, payload } = req.body ?? {};
    if (typeof room !== 'string' || !room.startsWith('user:') || !EMIT_EVENT_ALLOWLIST.has(event)) {
        res.status(400).json({ error: 'bad_request' });
        return;
    }
    io.to(room).emit(event, payload);
    res.json({ ok: true });
});

// Proxy health check so the browser (not lobby-server) wakes the game server, avoiding IP-based rate limiting
app.get('/warmup/:gameType', cors(), async (req, res) => {
    const url = GAME_SERVER_URLS[req.params.gameType];
    if (!url) { res.status(404).json({ status: 'unknown' }); return; }
    try {
        const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(5_000) });
        res.status(r.ok ? 200 : 202).json({ status: r.ok ? 'ready' : 'starting', code: r.status, gameServerUrl: url });
    } catch {
        res.status(202).json({ status: 'sleeping', gameServerUrl: url });
    }
});

const server = http.createServer(app);
server.setMaxListeners(50);
const io = new Server(server, { cors: corsConfig, maxHttpBufferSize: 1e5 });

const SOCKET_USER_SECRET = new TextEncoder().encode((process.env.SOCKET_USER_SECRET ?? process.env.INTERNAL_API_KEY)!);
const SOCKET_SERVICE_SECRET = new TextEncoder().encode(process.env.INTERNAL_API_KEY!);

const lobbies = new Map<string, any>();

setupSocketAuth(io, { user: SOCKET_USER_SECRET, service: SOCKET_SERVICE_SECRET } as any);

io.on('connection', (socket) => {
    // Game servers connect here on startup with { token, gameType } in auth
    const authGameType = socket.handshake.auth?.gameType as string | undefined;
    if (authGameType && authGameType in GAME_SERVER_URLS) {
        if (socket.data.authKind !== 'service') {
            socket.disconnect(true);
            return;
        }
        registerGameServer(authGameType, socket, lobbies);
        return;
    }
    // Regular client connection
    console.log('nouvelle connexion lobby', socket.id);
    registerHandlers(io, socket, lobbies);
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log('[LOBBY] realtime listening on', PORT));

const shutdown = () => {
    io.close(() => {
        server.close(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 3000).unref();
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
