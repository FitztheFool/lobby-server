// lobby-server/src/gameServers.ts
import 'dotenv/config';
import { randomUUID } from 'crypto';
import { SignJWT } from 'jose';
import { io as socketClient } from 'socket.io-client';

// ── Auth ──────────────────────────────────────────────────────────────────────

let SOCKET_SECRET: Uint8Array;

export function initGameServers(secret: Uint8Array) {
    SOCKET_SECRET = secret;
}

async function makeServerToken(): Promise<string> {
    return new SignJWT({ username: 'lobby-server' })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject('lobby-server')
        .sign(SOCKET_SECRET);
}

function serverAuth(cb: (data: object) => void) {
    makeServerToken().then(token => cb({ token }));
}

function createGameSocket(url: string) {
    return socketClient(url, {
        transports: ['polling', 'websocket'], // polling fallback for server-to-server on Render
        auth: serverAuth,
        autoConnect: false,   // connect only on demand (ensureConnected / preWarm)
        reconnection: false,  // no auto-retry — we retry manually to avoid Render IP rate-limiting
    });
}

// ── Socket instances ──────────────────────────────────────────────────────────

function createLoggingGameSocket(name: string, url: string) {
    const sock = createGameSocket(url);
    sock.on('connect',            () => console.log(`[SOCK] ${name} connected`));
    sock.on('disconnect', (reason) => console.log(`[SOCK] ${name} disconnected:`, reason));
    sock.on('connect_error', (err: any) => console.log(`[SOCK] ${name} connect_error:`, err.message, err.description?.status ?? err.description?.message ?? err.description ?? ''));
    return sock;
}

export const unoServerSocket      = createLoggingGameSocket('uno',        process.env.UNO_SERVER_URL        ?? 'http://localhost:10001');
export const quizServerSocket     = createLoggingGameSocket('quiz',       process.env.QUIZ_SERVER_URL       ?? 'http://localhost:10002');
export const tabooServerSocket    = createLoggingGameSocket('taboo',      process.env.TABOO_SERVER_URL      ?? 'http://localhost:10003');
export const skyjowServerSocket   = createLoggingGameSocket('skyjow',     process.env.SKYJOW_SERVER_URL     ?? 'http://localhost:10004');
export const yahtzeeServerSocket  = createLoggingGameSocket('yahtzee',    process.env.YAHTZEE_SERVER_URL    ?? 'http://localhost:10005');
export const puissance4ServerSocket = createLoggingGameSocket('puissance4', process.env.PUISSANCE4_SERVER_URL ?? 'http://localhost:10006');
export const justOneServerSocket  = createLoggingGameSocket('just_one',   process.env.JUSTONE_SERVER_URL ?? process.env.JUST_ONE_SERVER_URL   ?? 'http://localhost:10007');
export const battleshipServerSocket = createLoggingGameSocket('battleship', process.env.BATTLESHIP_SERVER_URL ?? 'http://localhost:10008');
export const diamantServerSocket  = createLoggingGameSocket('diamant',    process.env.DIAMANT_SERVER_URL    ?? 'http://localhost:10009');
export const impostorServerSocket = createLoggingGameSocket('impostor',   process.env.IMPOSTOR_SERVER_URL   ?? 'http://localhost:10010');

export const GAME_SERVER_URLS: Record<string, string> = {
    uno:        process.env.UNO_SERVER_URL        ?? 'http://localhost:10001',
    quiz:       process.env.QUIZ_SERVER_URL       ?? 'http://localhost:10002',
    taboo:      process.env.TABOO_SERVER_URL      ?? 'http://localhost:10003',
    skyjow:     process.env.SKYJOW_SERVER_URL     ?? 'http://localhost:10004',
    yahtzee:    process.env.YAHTZEE_SERVER_URL    ?? 'http://localhost:10005',
    puissance4: process.env.PUISSANCE4_SERVER_URL ?? 'http://localhost:10006',
    just_one:   process.env.JUSTONE_SERVER_URL ?? process.env.JUST_ONE_SERVER_URL   ?? 'http://localhost:10007',
    battleship: process.env.BATTLESHIP_SERVER_URL ?? 'http://localhost:10008',
    diamant:    process.env.DIAMANT_SERVER_URL    ?? 'http://localhost:10009',
    impostor:   process.env.IMPOSTOR_SERVER_URL   ?? 'http://localhost:10010',
};

export const GAME_SOCKETS: Record<string, ReturnType<typeof createGameSocket>> = {
    uno:        unoServerSocket,
    quiz:       quizServerSocket,
    taboo:      tabooServerSocket,
    skyjow:     skyjowServerSocket,
    yahtzee:    yahtzeeServerSocket,
    puissance4: puissance4ServerSocket,
    just_one:   justOneServerSocket,
    battleship: battleshipServerSocket,
    diamant:    diamantServerSocket,
    impostor:   impostorServerSocket,
};

// ── Wake-on-demand (Render free tier) ─────────────────────────────────────────
// Strategy: poll /health every 20s (5-6 requests over 120s, well below Render's rate limit),
// then connect the socket ONLY once the HTTP layer confirms the server is alive.
// Attempting socket connections to a sleeping server triggers Socket.IO polling (GET requests)
// which Render rate-limits (429) aggressively from the same IP.

// Dedup: if ensureConnected is already running for a game type, share the same promise.
const connectingPromises = new Map<string, Promise<void>>();

// Poll /health until the game server responds 200, or until deadline.
// Exits early if the socket is already connected (notifyGameServerReady beat us to it).
async function waitForHealth(gameType: string, sock: ReturnType<typeof createGameSocket>, deadlineMs: number): Promise<void> {
    const url = GAME_SERVER_URLS[gameType];
    if (!url) return;
    const start = Date.now();
    let attempt = 0;
    while (Date.now() - start < deadlineMs) {
        if (sock.connected) return; // socket already up (notifyGameServerReady connected it)
        attempt++;
        try {
            const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(4_000) });
            console.log(`[HEALTH] ${gameType} attempt ${attempt}: status ${r.status}`);
            if (r.ok) return;
        } catch (e: any) {
            console.log(`[HEALTH] ${gameType} attempt ${attempt}: ${e.message}`);
        }
        if (sock.connected) return;
        const remaining = deadlineMs - (Date.now() - start);
        if (remaining <= 0) break;
        await new Promise(r => setTimeout(r, Math.min(20_000, remaining)));
    }
    if (sock.connected) return;
    throw new Error(`health_timeout:${gameType}`);
}

export async function ensureConnected(gameType: string): Promise<void> {
    const sock = GAME_SOCKETS[gameType];
    if (!sock || sock.connected) { console.log(`[CONN] ${gameType}: already connected`); return; }

    const existing = connectingPromises.get(gameType);
    if (existing) { console.log(`[CONN] ${gameType}: joining existing connect attempt`); return existing; }

    console.log(`[CONN] ${gameType}: waiting for server to be healthy...`);

    const promise = (async () => {
        try {
            // Phase 1: poll /health until alive (wakes the sleeping Render service via HTTP)
            await waitForHealth(gameType, sock, 105_000);

            // Phase 2: server is alive — attempt socket connection once.
            // Check sock.connected first: notifyGameServerReady may have already connected.
            console.log(`[CONN] ${gameType}: server healthy, connecting socket...`);
            await new Promise<void>((resolve, reject) => {
                if (sock.connected) { resolve(); return; }
                const t = setTimeout(() => reject(new Error(`socket_connect_timeout:${gameType}`)), 15_000);
                sock.once('connect', () => { clearTimeout(t); console.log(`[CONN] ${gameType}: socket connected`); resolve(); });
                sock.connect();
            });
        } finally {
            connectingPromises.delete(gameType);
        }
    })();

    connectingPromises.set(gameType, promise);
    return promise;
}

export function preWarm(gameType: string): void {
    const sock = GAME_SOCKETS[gameType];
    if (sock?.connected) return;
    ensureConnected(gameType).catch(() => { /* best-effort pre-warm */ });
}

// Called when the browser (different IP, not rate-limited) confirms the game server is awake.
// Kick off a socket connection immediately instead of waiting for the next /health poll.
export function notifyGameServerReady(gameType: string): void {
    const sock = GAME_SOCKETS[gameType];
    if (!sock || sock.connected) { console.log(`[CONN] ${gameType}: gameServerReady ignored (already connected)`); return; }
    if (!connectingPromises.has(gameType)) { console.log(`[CONN] ${gameType}: gameServerReady ignored (no active wait)`); return; }
    console.log(`[CONN] ${gameType}: browser confirmed awake, attempting socket connection now`);
    sock.disconnect();
    sock.connect();
}

// ── Configure senders (used on lobby:start + reconnect) ───────────────────────

export function sendConfigure(gameType: string, lobbyId: string, lobby: any, onAck?: () => void): void {
    switch (gameType) {
        case 'uno': {
            const opts = lobby.unoOptions ?? { stackable: false, jumpIn: false, teamMode: 'none', teamWinMode: 'one' };
            unoServerSocket.emit('uno:configure', { lobbyId, options: opts, expectedCount: lobby.players.size, preAssignedTeams: lobby.teams ? Object.fromEntries(lobby.teams) : null, botCount: lobby.bots ?? 0 }, onAck);
            break;
        }
        case 'taboo': {
            const opts = lobby.tabooOptions ?? { turnDuration: 60, totalRounds: 3, trapWordCount: 5, maxAttempts: 10, trapDuration: 60 };
            tabooServerSocket.emit('taboo:configure', { lobbyId, options: opts, teams: lobby.teams ? Object.fromEntries(lobby.teams) : null, orators: lobby.orators ?? { '0': null, '1': null }, hostId: lobby.hostId }, onAck);
            break;
        }
        case 'skyjow': {
            const botsToSpawn = lobby.bots ?? 0;
            const humanPlayers = Array.from<any>(lobby.players.values());
            const botPlayers = Array.from({ length: botsToSpawn }, (_, i) => ({ userId: `bot-skyjow-${randomUUID()}`, username: botsToSpawn === 1 ? '🤖 Bot 1' : `🤖 Bot ${i + 1}` }));
            skyjowServerSocket.emit('skyjow:configure', { lobbyId, players: [...humanPlayers, ...botPlayers], options: lobby.skyjowOptions ?? { eliminateRows: false } }, onAck);
            break;
        }
        case 'yahtzee': {
            const botsToSpawn = lobby.bots ?? 0;
            const humanPlayers = Array.from<any>(lobby.players.values());
            const botPlayers = Array.from({ length: botsToSpawn }, (_, i) => ({ userId: `bot-yahtzee-${randomUUID()}`, username: `🤖 Bot ${i + 1}` }));
            yahtzeeServerSocket.emit('yahtzee:configure', { lobbyId, players: [...humanPlayers, ...botPlayers] }, onAck);
            break;
        }
        case 'puissance4': {
            const botName = (lobby.bots ?? 0) > 0 ? '🤖 Bot 1' : undefined;
            puissance4ServerSocket.emit('p4:configure', { lobbyId, botName }, onAck);
            break;
        }
        case 'just_one': {
            justOneServerSocket.emit('just_one:configure', { lobbyId, players: Array.from<any>(lobby.players.values()) }, onAck);
            break;
        }
        case 'battleship': {
            const botName = (lobby.bots ?? 0) > 0 ? '🤖 Bot 1' : undefined;
            battleshipServerSocket.emit('battleship:configure', { lobbyId, options: lobby.battleshipOptions ?? {}, botName }, onAck);
            break;
        }
        case 'diamant': {
            const botsToSpawn = lobby.bots ?? 0;
            const humanPlayers = Array.from(lobby.players.values());
            const botPlayers = Array.from({ length: botsToSpawn }, (_, i) => ({ userId: `bot-diamant-${randomUUID()}`, username: `🤖 Bot ${i + 1}` }));
            diamantServerSocket.emit('diamant:configure', { lobbyId, players: [...humanPlayers, ...botPlayers], options: lobby.diamantOptions ?? { roundCount: 5 } }, onAck);
            break;
        }
        case 'impostor': {
            impostorServerSocket.emit('impostor:configure', { lobbyId, players: Array.from<any>(lobby.players.values()), expectedCount: lobby.players.size, options: lobby.impostorOptions ?? { rounds: 1 } }, onAck);
            break;
        }
        default: { // quiz
            quizServerSocket.emit('quiz:configure', { lobbyId, quizId: lobby.quizId, players: Array.from<any>(lobby.players.values()), expectedCount: lobby.players.size, timeMode: lobby.timeMode, timePerQuestion: lobby.timePerQuestion }, onAck);
            break;
        }
    }
}

// ── Reconnect handlers: resend configure when a game server restarts ──────────

export function setupReconnectHandlers(lobbies: Map<string, any>): void {
    for (const [gameType, sock] of Object.entries(GAME_SOCKETS)) {
        let isFirstConnect = true;
        sock.on('connect', () => {
            if (isFirstConnect) { isFirstConnect = false; return; }
            for (const [lobbyId, lobby] of lobbies) {
                if (lobby.status === 'PLAYING' && (lobby.gameType ?? 'quiz') === gameType) {
                    sendConfigure(gameType, lobbyId, lobby);
                }
            }
        });
    }
}
