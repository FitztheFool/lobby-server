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
    return socketClient(url, { transports: ['websocket'], auth: serverAuth });
}

// ── Socket instances ──────────────────────────────────────────────────────────

export const unoServerSocket      = createGameSocket(process.env.UNO_SERVER_URL        ?? 'http://localhost:10001');
export const quizServerSocket     = createGameSocket(process.env.QUIZ_SERVER_URL       ?? 'http://localhost:10002');
export const tabooServerSocket    = createGameSocket(process.env.TABOO_SERVER_URL      ?? 'http://localhost:10003');
export const skyjowServerSocket   = createGameSocket(process.env.SKYJOW_SERVER_URL     ?? 'http://localhost:10004');
export const yahtzeeServerSocket  = createGameSocket(process.env.YAHTZEE_SERVER_URL    ?? 'http://localhost:10005');
export const puissance4ServerSocket = createGameSocket(process.env.PUISSANCE4_SERVER_URL ?? 'http://localhost:10006');
export const justOneServerSocket  = createGameSocket(process.env.JUSTONE_SERVER_URL ?? process.env.JUST_ONE_SERVER_URL   ?? 'http://localhost:10007');
export const battleshipServerSocket = createGameSocket(process.env.BATTLESHIP_SERVER_URL ?? 'http://localhost:10008');
export const diamantServerSocket  = createGameSocket(process.env.DIAMANT_SERVER_URL    ?? 'http://localhost:10009');
export const impostorServerSocket = createGameSocket(process.env.IMPOSTOR_SERVER_URL   ?? 'http://localhost:10010');

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

async function wakeGameServer(gameType: string): Promise<void> {
    const url = GAME_SERVER_URLS[gameType];
    if (!url) return;
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
        try {
            const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(5_000) });
            if (res.ok) return;
        } catch { /* still sleeping */ }
        await new Promise(r => setTimeout(r, 3_000));
    }
    throw new Error(`wake_timeout:${gameType}`);
}

export async function ensureConnected(gameType: string): Promise<void> {
    const sock = GAME_SOCKETS[gameType];
    if (!sock || sock.connected) return;
    await wakeGameServer(gameType);
    if (sock.connected) return; // may have reconnected during wake polling
    sock.connect(); // force immediate reconnect, bypasses exponential backoff
    await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`socket_timeout:${gameType}`)), 90_000);
        sock.once('connect', () => { clearTimeout(timeout); resolve(); });
    });
}

export function preWarm(gameType: string): void {
    const sock = GAME_SOCKETS[gameType];
    if (sock?.connected) return;
    wakeGameServer(gameType).catch(() => { /* best-effort */ });
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
