// lobby-server/src/gameServers.ts
// NEW ARCHITECTURE: game servers connect TO the lobby-server on startup.
// The lobby-server no longer initiates outbound connections to sleeping Render services,
// which eliminates the 429 rate-limiting issue entirely.
import 'dotenv/config';
import { randomUUID } from 'crypto';

// ── Game server URLs (used by /warmup proxy endpoint only) ────────────────────

export const GAME_SERVER_URLS: Record<string, string> = {
    uno:        process.env.UNO_SERVER_URL        ?? 'http://localhost:10001',
    quiz:       process.env.QUIZ_SERVER_URL       ?? 'http://localhost:10002',
    taboo:      process.env.TABOO_SERVER_URL      ?? 'http://localhost:10003',
    skyjow:     process.env.SKYJOW_SERVER_URL     ?? 'http://localhost:10004',
    yahtzee:    process.env.YAHTZEE_SERVER_URL    ?? 'http://localhost:10005',
    puissance4: process.env.PUISSANCE4_SERVER_URL ?? 'http://localhost:10006',
    just_one:   process.env.JUSTONE_SERVER_URL ?? process.env.JUST_ONE_SERVER_URL ?? 'http://localhost:10007',
    battleship: process.env.BATTLESHIP_SERVER_URL ?? 'http://localhost:10008',
    diamant:    process.env.DIAMANT_SERVER_URL    ?? 'http://localhost:10009',
    impostor:   process.env.IMPOSTOR_SERVER_URL   ?? 'http://localhost:10010',
};

// ── Inbound game server connections ───────────────────────────────────────────
// Each game server connects here on startup with { token, gameType } auth.

export const gameServerConnections = new Map<string, any>(); // gameType → Socket

// Resolvers from ensureConnected() waiting for a game server to appear
const pendingResolvers = new Map<string, () => void>();
const connectingPromises = new Map<string, Promise<void>>();

// Called from index.ts when a game server socket is identified
export function registerGameServer(gameType: string, socket: any, lobbies: Map<string, any>): void {
    const prev = gameServerConnections.get(gameType);
    if (prev && prev !== socket) { prev.disconnect(true); }
    gameServerConnections.set(gameType, socket);
    console.log(`[GAME] ${gameType}: connected (${socket.id})`);

    // Resolve any waiting ensureConnected promise
    const resolver = pendingResolvers.get(gameType);
    if (resolver) { pendingResolvers.delete(gameType); resolver(); }

    socket.on('disconnect', (reason: string) => {
        console.log(`[GAME] ${gameType}: disconnected: ${reason}`);
        if (gameServerConnections.get(gameType) === socket) gameServerConnections.delete(gameType);
    });

    // Reconnect: resend configure for all in-progress lobbies of this game type
    for (const [lobbyId, lobby] of lobbies) {
        if (lobby.status === 'PLAYING' && (lobby.gameType ?? 'quiz') === gameType) {
            console.log(`[GAME] ${gameType}: resending configure for lobby ${lobbyId}`);
            sendConfigure(gameType, lobbyId, lobby);
        }
    }
}

// ── Wait for a game server to connect ─────────────────────────────────────────

export async function ensureConnected(gameType: string): Promise<void> {
    if (gameServerConnections.has(gameType)) { console.log(`[CONN] ${gameType}: already connected`); return; }

    const existing = connectingPromises.get(gameType);
    if (existing) { console.log(`[CONN] ${gameType}: waiting for game server...`); return existing; }

    console.log(`[CONN] ${gameType}: waiting for game server to connect...`);

    const promise = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
            connectingPromises.delete(gameType);
            pendingResolvers.delete(gameType);
            console.log(`[CONN] ${gameType}: timeout — game server did not connect within 120s`);
            reject(new Error(`socket_timeout:${gameType}`));
        }, 120_000);

        pendingResolvers.set(gameType, () => {
            clearTimeout(timeout);
            connectingPromises.delete(gameType);
            console.log(`[CONN] ${gameType}: game server is ready`);
            resolve();
        });
    });

    connectingPromises.set(gameType, promise);
    return promise;
}

export function preWarm(gameType: string): void {
    // Game servers connect TO us when they wake — nothing to initiate from here.
    // Just register interest so ensureConnected resolves quickly on lobby:start.
    if (gameServerConnections.has(gameType)) return;
    ensureConnected(gameType).catch(() => { /* best-effort */ });
}

// ── Configure senders ─────────────────────────────────────────────────────────

export function sendConfigure(gameType: string, lobbyId: string, lobby: any, onAck?: () => void): void {
    const sock = gameServerConnections.get(gameType);
    if (!sock) { console.log(`[CONF] ${gameType}: no connected game server`); return; }

    switch (gameType) {
        case 'uno': {
            const opts = lobby.unoOptions ?? { stackable: false, jumpIn: false, teamMode: 'none', teamWinMode: 'one' };
            sock.emit('uno:configure', { lobbyId, options: opts, expectedCount: lobby.players.size, preAssignedTeams: lobby.teams ? Object.fromEntries(lobby.teams) : null, botCount: lobby.bots ?? 0 }, onAck);
            break;
        }
        case 'taboo': {
            const opts = lobby.tabooOptions ?? { turnDuration: 120, totalRounds: 3, trapWordCount: 5, maxAttempts: 10, trapDuration: 90 };
            sock.emit('taboo:configure', { lobbyId, options: opts, teams: lobby.teams ? Object.fromEntries(lobby.teams) : null, orators: lobby.orators ?? { '0': null, '1': null }, hostId: lobby.hostId }, onAck);
            break;
        }
        case 'skyjow': {
            const botsToSpawn = lobby.bots ?? 0;
            const humanPlayers = Array.from<any>(lobby.players.values());
            const botPlayers = Array.from({ length: botsToSpawn }, (_, i) => ({ userId: `bot-skyjow-${randomUUID()}`, username: botsToSpawn === 1 ? '🤖 Bot 1' : `🤖 Bot ${i + 1}` }));
            sock.emit('skyjow:configure', { lobbyId, players: [...humanPlayers, ...botPlayers], options: lobby.skyjowOptions ?? { eliminateRows: false } }, onAck);
            break;
        }
        case 'yahtzee': {
            const botsToSpawn = lobby.bots ?? 0;
            const humanPlayers = Array.from<any>(lobby.players.values());
            const botPlayers = Array.from({ length: botsToSpawn }, (_, i) => ({ userId: `bot-yahtzee-${randomUUID()}`, username: `🤖 Bot ${i + 1}` }));
            sock.emit('yahtzee:configure', { lobbyId, players: [...humanPlayers, ...botPlayers] }, onAck);
            break;
        }
        case 'puissance4': {
            const botName = (lobby.bots ?? 0) > 0 ? '🤖 Bot 1' : undefined;
            sock.emit('p4:configure', { lobbyId, botName }, onAck);
            break;
        }
        case 'just_one': {
            sock.emit('just_one:configure', { lobbyId, players: Array.from<any>(lobby.players.values()) }, onAck);
            break;
        }
        case 'battleship': {
            const botName = (lobby.bots ?? 0) > 0 ? '🤖 Bot 1' : undefined;
            sock.emit('battleship:configure', { lobbyId, options: lobby.battleshipOptions ?? {}, botName }, onAck);
            break;
        }
        case 'diamant': {
            const botsToSpawn = lobby.bots ?? 0;
            const humanPlayers = Array.from(lobby.players.values());
            const botPlayers = Array.from({ length: botsToSpawn }, (_, i) => ({ userId: `bot-diamant-${randomUUID()}`, username: `🤖 Bot ${i + 1}` }));
            sock.emit('diamant:configure', { lobbyId, players: [...humanPlayers, ...botPlayers], options: lobby.diamantOptions ?? { roundCount: 5 } }, onAck);
            break;
        }
        case 'impostor': {
            sock.emit('impostor:configure', { lobbyId, players: Array.from<any>(lobby.players.values()), expectedCount: lobby.players.size, options: lobby.impostorOptions ?? { rounds: 1 } }, onAck);
            break;
        }
        default: { // quiz
            sock.emit('quiz:configure', { lobbyId, quizId: lobby.quizId, players: Array.from<any>(lobby.players.values()), expectedCount: lobby.players.size, timeMode: lobby.timeMode, timePerQuestion: lobby.timePerQuestion }, onAck);
            break;
        }
    }
}
