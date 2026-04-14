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
        autoConnect: false,         // connect only on demand (ensureConnected / preWarm)
        reconnectionDelay: 2_000,   // retry every 2s initially — catches the Render cold-start window
        reconnectionDelayMax: 10_000,
    });
}

// ── Socket instances ──────────────────────────────────────────────────────────

function createLoggingGameSocket(name: string, url: string) {
    const sock = createGameSocket(url);
    sock.on('connect',            () => console.log(`[SOCK] ${name} connected`));
    sock.on('disconnect', (reason) => console.log(`[SOCK] ${name} disconnected:`, reason));
    sock.on('connect_error', (err) => console.log(`[SOCK] ${name} connect_error:`, err.message, (err as any).cause?.message ?? ''));
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
// The socket connection attempt itself is an inbound request that wakes the Render service.
// HTTP health-check polling caused 429 rate-limiting, so we rely on Socket.IO reconnects instead.

// Dedup: if ensureConnected is already running for a game type, share the same promise.
const connectingPromises = new Map<string, Promise<void>>();

export async function ensureConnected(gameType: string): Promise<void> {
    const sock = GAME_SOCKETS[gameType];
    if (!sock || sock.connected) { console.log(`[CONN] ${gameType}: already connected`); return; }

    // Return the in-progress promise if a connection attempt is already underway
    const existing = connectingPromises.get(gameType);
    if (existing) { console.log(`[CONN] ${gameType}: joining existing connect attempt`); return existing; }

    console.log(`[CONN] ${gameType}: connecting (socket connect wakes Render)...`);

    const promise = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
            connectingPromises.delete(gameType);
            console.log(`[CONN] ${gameType}: timeout after 120s`);
            reject(new Error(`socket_timeout:${gameType}`));
        }, 120_000);
        sock.once('connect', () => {
            clearTimeout(timeout);
            connectingPromises.delete(gameType);
            console.log(`[CONN] ${gameType}: connected`);
            resolve();
        });
    });

    connectingPromises.set(gameType, promise);
    sock.connect(); // the HTTP handshake is an inbound request → wakes Render; retries every 3–15s
    return promise;
}

export function preWarm(gameType: string): void {
    const sock = GAME_SOCKETS[gameType];
    if (sock?.connected) return;
    ensureConnected(gameType).catch(() => { /* best-effort pre-warm */ });
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
