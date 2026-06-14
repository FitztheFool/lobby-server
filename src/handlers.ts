// lobby-server/src/handlers.ts
import { randomUUID } from 'crypto';
import { Server, Socket } from 'socket.io';
import { gameServerConnections, ensureConnected, preWarm, sendConfigure, GAME_SERVER_URLS } from './gameServers';
import { emitLobbyState, broadcastLobbies, buildLobbyList, removePlayerAndMaybeTransferHost, autoFillBotTeams, purgeLobbyInvites } from './lobbyHelpers';

const BOT_SUPPORTED_GAMES = new Set(['puissance4', 'yahtzee', 'diamant', 'battleship', 'uno', 'skyjow', 'ludo', 'perudo', 'cant_stop', 'mille_bornes', 'atlantide', 'abalone', 'blokus']);

const VALID_GAME_TYPES = ['quiz', 'uno', 'taboo', 'skyjow', 'yahtzee', 'puissance4', 'just_one', 'battleship', 'diamant', 'impostor', 'ludo', 'perudo', 'cant_stop', 'mille_bornes', 'spyfall', 'atlantide', 'abalone', 'blokus'];

const DEFAULT_MAX_PLAYERS: Record<string, number> = {
    quiz: 30, puissance4: 2, battleship: 2, diamant: 8, impostor: 8, just_one: 7, ludo: 4, perudo: 6, cant_stop: 4, mille_bornes: 4, spyfall: 8, atlantide: 4, abalone: 2, blokus: 4,
};

function canStart(lobby: any): boolean {
    const g = lobby.gameType ?? 'quiz';
    const total = lobby.players.size + (lobby.bots ?? 0);
    if (g === 'quiz' && (!lobby.quizId || lobby.players.size < 1)) return false;
    if (g === 'uno' && total < 2) return false;
    if (g === 'skyjow' && (total < 2 || total > 8)) return false;
    if ((g === 'puissance4' || g === 'battleship' || g === 'abalone') && total !== 2) return false;
    if (g === 'yahtzee' && (lobby.players.size < 1 || total < 2 || total > 8)) return false;
    if (g === 'just_one' && lobby.players.size < 3) return false;
    if (g === 'diamant' && (lobby.players.size < 1 || total < 2 || total > 8)) return false;
    if (g === 'impostor' && lobby.players.size < 4) return false;
    if (g === 'spyfall' && (lobby.players.size < 3 || lobby.players.size > 8)) return false;
    if (g === 'ludo' && (lobby.players.size < 1 || total < 2 || total > 4)) return false;
    if (g === 'perudo' && (lobby.players.size < 1 || total < 2 || total > 6)) return false;
    if (g === 'cant_stop' && (lobby.players.size < 1 || total < 2 || total > 4)) return false;
    if (g === 'mille_bornes' && (lobby.players.size < 1 || total < 2 || total > 4)) return false;
    if (g === 'atlantide' && (lobby.players.size < 1 || total < 2 || total > 4)) return false;
    if (g === 'blokus' && (lobby.players.size < 1 || total < 2 || total > 4)) return false;
    if (g === 'taboo') {
        if (!lobby.teams || lobby.teams.size < 4) return false;
        const t0 = Array.from<number>(lobby.teams.values()).filter(t => t === 0).length;
        const t1 = Array.from<number>(lobby.teams.values()).filter(t => t === 1).length;
        if (t0 < 2 || t1 < 2) return false;
    }
    if (g === 'uno' && lobby.unoOptions?.teamMode === '2v2') {
        if (total !== 4) return false;
        if (!lobby.teams || lobby.teams.size !== 4) return false;
        const t0 = Array.from<number>(lobby.teams.values()).filter(t => t === 0).length;
        const t1 = Array.from<number>(lobby.teams.values()).filter(t => t === 1).length;
        if (t0 !== 2 || t1 !== 2) return false;
    }
    if (g === 'ludo' && lobby.ludoOptions?.teamMode === '2v2') {
        if (total !== 4) return false;
        if (!lobby.teams || lobby.teams.size !== 4) return false;
        const t0 = Array.from<number>(lobby.teams.values()).filter(t => t === 0).length;
        const t1 = Array.from<number>(lobby.teams.values()).filter(t => t === 1).length;
        if (t0 !== 2 || t1 !== 2) return false;
    }
    if (g === 'mille_bornes' && lobby.mbOptions?.teamMode === '2v2') {
        if (total !== 4) return false;
        if (!lobby.teams || lobby.teams.size !== 4) return false;
        const t0 = Array.from<number>(lobby.teams.values()).filter(t => t === 0).length;
        const t1 = Array.from<number>(lobby.teams.values()).filter(t => t === 1).length;
        if (t0 !== 2 || t1 !== 2) return false;
    }
    return true;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getLobby(socket: Socket, lobbies: Map<string, any>): { lobbyId: string; userId: string; lobby: any } | null {
    const { lobbyId, userId } = socket.data || {};
    if (!lobbyId || !userId) return null;
    const lobby = lobbies.get(lobbyId);
    if (!lobby) return null;
    return { lobbyId, userId, lobby };
}

function getHostLobby(socket: Socket, lobbies: Map<string, any>): { lobbyId: string; userId: string; lobby: any } | null {
    const ctx = getLobby(socket, lobbies);
    if (!ctx || ctx.lobby.hostId !== ctx.userId) return null;
    return ctx;
}

// Validate and return a numeric value within [min, max], or undefined if invalid
function numOpt(v: unknown, min: number, max: number): number | undefined {
    const n = Number(v);
    return Number.isFinite(n) && n >= min && n <= max ? n : undefined;
}

// Apply a team-mode change to lobby (shared between uno and ludo)
function applyTeamMode(lobby: any, optionsKey: string, teamMode: unknown): void {
    if (teamMode !== 'none' && teamMode !== '2v2') return;
    lobby[optionsKey].teamMode = teamMode;
    lobby.teams = teamMode === '2v2' ? new Map() : null;
}

// ── Register handlers ─────────────────────────────────────────────────────────

// Per-user invite throttle: at most one invite to the same target every 5s.
const lastInviteAt = new Map<string, number>();
const INVITE_COOLDOWN_MS = 5_000;

export function registerHandlers(io: Server, socket: Socket, lobbies: Map<string, any>): void {

    // Stable personal room used to push invites / DMs to every tab of this user.
    if (socket.data?.userId) socket.join(`user:${socket.data.userId}`);

    // ── Lobby invites (any member) ──────────────────────────────────────────────
    socket.on('lobby:invite', ({ toUserId }) => {
        const ctx = getLobby(socket, lobbies);
        if (!ctx) return; // not in a lobby
        if (typeof toUserId !== 'string' || !toUserId || toUserId === ctx.userId) return;

        const key = `${ctx.userId}:${toUserId}`;
        const now = Date.now();
        if (now - (lastInviteAt.get(key) ?? 0) < INVITE_COOLDOWN_MS) return;
        lastInviteAt.set(key, now);

        io.to(`user:${toUserId}`).emit('lobby:invited', {
            lobbyId: ctx.lobbyId,
            gameType: ctx.lobby.gameType ?? 'quiz',
            fromUserId: ctx.userId,
            fromUsername: socket.data.username,
        });
        socket.emit('lobby:inviteSent', { toUserId });
    });

    socket.on('lobby:join', ({ lobbyId, title, description, maxPlayers, isPublic, gameType }) => {
        const { userId, username } = socket.data;
        if (!lobbyId || !userId || !username) return;

        const existing = lobbies.get(lobbyId);
        if (existing && existing.isPublic === false && existing.status !== 'WAITING' && !existing.members?.has(userId)) {
            socket.emit('lobby:accessDenied', { lobbyId });
            return;
        }

        socket.data.lobbyId = lobbyId;
        socket.join(`lobby:${lobbyId}`);

        let lobby = existing;
        if (!lobby) {
            const gt = VALID_GAME_TYPES.includes(gameType) ? gameType : 'uno';
            lobby = {
                isPublic: typeof isPublic === 'boolean' ? isPublic : false,
                hostId: userId,
                quizId: null,
                status: 'WAITING',
                timePerQuestion: 15,
                timeMode: 'none',
                players: new Map(),
                resultViewers: new Set(),
                teams: null,
                title: title ?? null,
                description: description ?? '',
                maxPlayers: (Number.isFinite(Number(maxPlayers)) && Number(maxPlayers) >= 2) ? Number(maxPlayers) : 8,
                gameType: gt,
                members: new Set<string>(),
                unoOptions:      { stackable: false, jumpIn: false, teamMode: 'none', teamWinMode: 'one' },
                tabooOptions:    { turnDuration: 120, totalRounds: 3, trapWordCount: 5, maxAttempts: 10, trapDuration: 90 },
                skyjowOptions:   { eliminateRows: false },
                battleshipOptions: { gridSize: 10, ships: [5, 4, 3, 3, 2] },
                diamantOptions:  { roundCount: 5 },
                impostorOptions: { rounds: 1, timePerRound: 60 },
                spyfallOptions: { exchangesPerPlayer: 2, turnTime: 60 },
                ludoOptions: { pawnExit: '6', bonusOn6: 'unlimited', winMode: 'first_done', teamMode: 'none' },
                perudoOptions: { initialDice: 5 },
                cantStopOptions: { columnsToWin: 3 },
                mbOptions: { target: 1000, teamMode: 'none', teamDistance: 'individual' },
                orators: { '0': null, '1': null },
            };
        }

        if (lobby.players.has(userId)) {
            lobby.players.set(userId, { userId, username }); // reconnect
        } else if (lobby.players.size >= lobby.maxPlayers) {
            socket.emit('lobby:full', { lobbyId }); return;
        } else {
            lobby.players.set(userId, { userId, username });
        }

        lobby.hostId            ||= userId;
        lobby.resultViewers     ||= new Set();
        lobby.members           ||= new Set<string>();
        lobby.teams             ||= null;
        lobby.botSlots          ||= [];
        lobby.members.add(userId);
        lobby.orators           ||= { '0': null, '1': null };
        lobby.unoOptions        ||= { stackable: false, jumpIn: false, teamMode: 'none', teamWinMode: 'one' };
        lobby.tabooOptions      ||= { turnDuration: 120, totalRounds: 3, trapWordCount: 5, maxAttempts: 10, trapDuration: 90 };
        lobby.skyjowOptions     ||= { eliminateRows: false };
        lobby.battleshipOptions ||= { gridSize: 10, ships: [5, 4, 3, 3, 2] };
        lobby.impostorOptions   ||= { rounds: 1, timePerRound: 60 };
        lobby.spyfallOptions    ||= { exchangesPerPlayer: 2, turnTime: 40 };
        lobby.ludoOptions       ||= { pawnExit: '6', bonusOn6: 'unlimited', winMode: 'first_done', teamMode: 'none' };
        lobby.perudoOptions     ||= { initialDice: 5 };
        lobby.cantStopOptions   ||= { columnsToWin: 3 };
        lobby.mbOptions         ||= { target: 1000, teamMode: 'none', teamDistance: 'individual' };

        lobbies.set(lobbyId, lobby);
        emitLobbyState(io, lobbyId, lobby);
        broadcastLobbies(io, lobbies);
        preWarm(lobby.gameType ?? 'quiz');
    });

    // ── Chat ──────────────────────────────────────────────────────────────────

    socket.on('chat:send', ({ text, team }) => {
        const { lobbyId, userId, username } = socket.data;
        if (!lobbyId || !text || typeof text !== 'string') return;
        const safeText = text.trim().slice(0, 500);
        if (!safeText) return;
        const msg = { userId, username, text: safeText, sentAt: Date.now() };
        if (team === 0 || team === 1) {
            io.to(`lobby:${lobbyId}:team:${team}`).emit('chat:message:team', msg);
        } else {
            io.to(`lobby:${lobbyId}`).emit('chat:message', msg);
        }
    });

    socket.on('chat:joinTeam', ({ team }) => {
        const ctx = getLobby(socket, lobbies);
        if (!ctx) return;
        socket.leave(`lobby:${ctx.lobbyId}:team:0`);
        socket.leave(`lobby:${ctx.lobbyId}:team:1`);
        if (team !== 0 && team !== 1) return;
        if (ctx.lobby.teams?.get(ctx.userId) !== team) return;
        socket.join(`lobby:${ctx.lobbyId}:team:${team}`);
    });

    // ── Lobby management ──────────────────────────────────────────────────────

    socket.on('lobby:setMeta', ({ title, description, maxPlayers, isPublic }) => {
        const ctx = getHostLobby(socket, lobbies);
        if (!ctx) return;
        const { lobbyId, lobby } = ctx;
        if (title && typeof title === 'string') lobby.title = title.slice(0, 60);
        if (typeof description === 'string') lobby.description = description.slice(0, 200);
        if (Number.isFinite(Number(maxPlayers)) && Number(maxPlayers) >= 2) lobby.maxPlayers = Number(maxPlayers);
        if (typeof isPublic === 'boolean') lobby.isPublic = isPublic;
        emitLobbyState(io, lobbyId, lobby);
        broadcastLobbies(io, lobbies);
    });

    socket.on('lobby:setOrator', ({ targetUserId }) => {
        const { lobbyId, userId } = socket.data || {};
        if (!lobbyId || !userId || !targetUserId || userId !== targetUserId) return;
        const lobby = lobbies.get(lobbyId);
        if (!lobby) return;
        if (!lobby.orators) lobby.orators = { '0': null, '1': null };
        const team = lobby.teams?.get(userId);
        if (team === undefined || team === null) return;
        const key = String(team);
        if (lobby.orators[key] === userId) lobby.orators[key] = null;
        else if (lobby.orators[key] === null) lobby.orators[key] = userId;
        else { socket.emit('lobby:oratorTaken'); return; }
        emitLobbyState(io, lobbyId, lobby);
    });

    socket.on('lobby:leave', () => {
        const ctx = getLobby(socket, lobbies);
        if (!ctx) return;
        ctx.lobby.members?.delete(ctx.userId);
        removePlayerAndMaybeTransferHost(io, lobbies, ctx.lobbyId, ctx.userId);
    });

    socket.on('lobby:kick', ({ targetUserId }) => {
        const ctx = getHostLobby(socket, lobbies);
        if (!ctx || !targetUserId || targetUserId === ctx.userId) return;
        const { lobbyId, lobby } = ctx;
        if (!lobby.players.has(targetUserId)) return;
        for (const [, s] of io.of('/').sockets) {
            if (s.data?.userId === targetUserId && s.data?.lobbyId === lobbyId) {
                s.emit('lobby:kicked'); s.leave(`lobby:${lobbyId}`); s.data = {}; break;
            }
        }
        lobby.players.delete(targetUserId);
        lobby.members?.delete(targetUserId);
        if (lobby.teams) lobby.teams.delete(targetUserId);
        if (lobby.players.size === 0) { lobbies.delete(lobbyId); void purgeLobbyInvites(lobbyId); return; }
        emitLobbyState(io, lobbyId, lobby);
        broadcastLobbies(io, lobbies);
    });

    socket.on('lobby:transferHost', ({ targetUserId }) => {
        const ctx = getHostLobby(socket, lobbies);
        if (!ctx || !targetUserId || targetUserId === ctx.userId) return;
        const { lobbyId, lobby } = ctx;
        if (!lobby.players.has(targetUserId)) return;
        lobby.hostId = targetUserId;
        emitLobbyState(io, lobbyId, lobby);
        broadcastLobbies(io, lobbies);
    });

    socket.on('lobby:claimHost', async () => {
        const ctx = getLobby(socket, lobbies);
        if (!ctx || !ctx.lobby.players.has(ctx.userId)) return;
        const { lobbyId, userId, lobby } = ctx;
        const frontendUrl = process.env.FRONTEND_URL;
        const secret = process.env.INTERNAL_API_KEY;
        if (!frontendUrl || !secret) return;
        try {
            const res = await fetch(`${frontendUrl}/api/user/role?userId=${userId}`, { headers: { Authorization: `Bearer ${secret}` } });
            if (!res.ok) return;
            const { role } = await res.json() as { role: string };
            if (role !== 'ADMIN') return;
        } catch { return; }
        lobby.hostId = userId;
        emitLobbyState(io, lobbyId, lobby);
        broadcastLobbies(io, lobbies);
    });

    // ── Game options ──────────────────────────────────────────────────────────

    socket.on('lobby:setGameType', ({ gameType }) => {
        const ctx = getHostLobby(socket, lobbies);
        if (!ctx) return;
        const { lobbyId, lobby } = ctx;
        if (!VALID_GAME_TYPES.includes(gameType)) return;
        lobby.gameType = gameType;
        lobby.bots = 0;
        lobby.botSlots = [];
        if (gameType !== 'quiz') lobby.quizId = null;
        lobby.maxPlayers = DEFAULT_MAX_PLAYERS[gameType] ?? 8;
        if (gameType === 'uno' && lobby.unoOptions?.teamMode === '2v2') lobby.maxPlayers = 4;
        if (gameType === 'ludo' && lobby.ludoOptions?.teamMode === '2v2') lobby.maxPlayers = 4;
        if (gameType === 'mille_bornes' && lobby.mbOptions?.teamMode === '2v2') lobby.maxPlayers = 4;
        emitLobbyState(io, lobbyId, lobby);
        broadcastLobbies(io, lobbies);
    });

    socket.on('lobby:addBot', () => {
        const ctx = getHostLobby(socket, lobbies);
        if (!ctx) return;
        const { lobbyId, lobby } = ctx;
        if (!BOT_SUPPORTED_GAMES.has(lobby.gameType)) return;
        lobby.botSlots ||= [];
        if (lobby.players.size + lobby.botSlots.length >= (lobby.maxPlayers ?? 2)) return;
        const slotNumber = lobby.botSlots.length + 1;
        lobby.botSlots.push({ userId: `bot-${lobby.gameType}-${randomUUID()}`, username: `🤖 Bot ${slotNumber}` });
        lobby.bots = lobby.botSlots.length;
        autoFillBotTeams(lobby);
        emitLobbyState(io, lobbyId, lobby);
        broadcastLobbies(io, lobbies);
    });

    socket.on('lobby:removeBot', () => {
        const ctx = getHostLobby(socket, lobbies);
        if (!ctx) return;
        const { lobbyId, lobby } = ctx;
        lobby.botSlots ||= [];
        if (lobby.botSlots.length === 0) return;
        const removed = lobby.botSlots.pop();
        if (removed && lobby.teams) lobby.teams.delete(removed.userId);
        lobby.bots = lobby.botSlots.length;
        autoFillBotTeams(lobby);
        emitLobbyState(io, lobbyId, lobby);
        broadcastLobbies(io, lobbies);
    });

    socket.on('lobby:setQuiz', ({ quizId }) => {
        const ctx = getHostLobby(socket, lobbies);
        if (!ctx) return;
        ctx.lobby.quizId = quizId ?? null;
        emitLobbyState(io, ctx.lobbyId, ctx.lobby);
    });

    socket.on('lobby:setQuizOptions', ({ timeMode, timePerQuestion }) => {
        const ctx = getHostLobby(socket, lobbies);
        if (!ctx) return;
        const { lobbyId, lobby } = ctx;
        if (timeMode !== undefined) {
            const normalized = timeMode === 'quiz:per_question' ? 'per_question' : timeMode;
            if (['per_question', 'total', 'none'].includes(normalized)) lobby.timeMode = normalized;
        }
        const t = numOpt(timePerQuestion, 5, 3600);
        if (t !== undefined) lobby.timePerQuestion = t;
        emitLobbyState(io, lobbyId, lobby);
    });

    socket.on('lobby:setUnoOptions', ({ stackable, jumpIn, teamMode, teamWinMode }) => {
        const ctx = getHostLobby(socket, lobbies);
        if (!ctx) return;
        const { lobbyId, lobby } = ctx;
        lobby.unoOptions ||= { stackable: false, jumpIn: false, teamMode: 'none', teamWinMode: 'one' };
        if (typeof stackable === 'boolean') lobby.unoOptions.stackable = stackable;
        if (typeof jumpIn === 'boolean') lobby.unoOptions.jumpIn = jumpIn;
        if (teamWinMode === 'one' || teamWinMode === 'both') lobby.unoOptions.teamWinMode = teamWinMode;
        applyTeamMode(lobby, 'unoOptions', teamMode);
        emitLobbyState(io, lobbyId, lobby);
    });

    socket.on('lobby:setTabooOptions', ({ turnDuration, totalRounds, trapWordCount, maxAttempts, trapDuration }) => {
        const ctx = getHostLobby(socket, lobbies);
        if (!ctx) return;
        const { lobbyId, lobby } = ctx;
        lobby.tabooOptions ||= { turnDuration: 120, totalRounds: 3, trapWordCount: 5, maxAttempts: 10, trapDuration: 90 };
        const td = numOpt(turnDuration,  15, 300); if (td !== undefined) lobby.tabooOptions.turnDuration  = td;
        const tr = numOpt(totalRounds,    1,  10); if (tr !== undefined) lobby.tabooOptions.totalRounds   = tr;
        const tw = numOpt(trapWordCount,  1,  10); if (tw !== undefined) lobby.tabooOptions.trapWordCount  = tw;
        const ma = numOpt(maxAttempts,    1,  30); if (ma !== undefined) lobby.tabooOptions.maxAttempts   = ma;
        const tp = numOpt(trapDuration,  15, 300); if (tp !== undefined) lobby.tabooOptions.trapDuration  = tp;
        emitLobbyState(io, lobbyId, lobby);
    });

    socket.on('lobby:setSkyjowOptions', ({ eliminateRows }) => {
        const ctx = getHostLobby(socket, lobbies);
        if (!ctx) return;
        const { lobbyId, lobby } = ctx;
        lobby.skyjowOptions ||= { eliminateRows: false };
        if (typeof eliminateRows === 'boolean') lobby.skyjowOptions.eliminateRows = eliminateRows;
        emitLobbyState(io, lobbyId, lobby);
    });

    socket.on('lobby:setBattleshipOptions', ({ gridSize, turnTime }) => {
        const ctx = getHostLobby(socket, lobbies);
        if (!ctx) return;
        const { lobbyId, lobby } = ctx;
        lobby.battleshipOptions ||= { gridSize: 10, ships: [5, 4, 3, 3, 2] };
        const g = numOpt(gridSize,  8, 15); if (g !== undefined) lobby.battleshipOptions.gridSize  = g;
        const t = numOpt(turnTime, 10, 120); if (t !== undefined) lobby.battleshipOptions.turnTime = t;
        emitLobbyState(io, lobbyId, lobby);
    });

    socket.on('lobby:setLudoOptions', ({ pawnExit, bonusOn6, winMode, teamMode }) => {
        const ctx = getHostLobby(socket, lobbies);
        if (!ctx) return;
        const { lobbyId, lobby } = ctx;
        lobby.ludoOptions ||= { pawnExit: '6', bonusOn6: 'unlimited', winMode: 'first_done', teamMode: 'none' };
        if (pawnExit === '6' || pawnExit === '6_or_1' || pawnExit === 'any') lobby.ludoOptions.pawnExit = pawnExit;
        if (bonusOn6 === 'unlimited' || bonusOn6 === 'triple_lose' || bonusOn6 === 'none') lobby.ludoOptions.bonusOn6 = bonusOn6;
        if (winMode === 'first_done' || winMode === 'full_ranking') lobby.ludoOptions.winMode = winMode;
        applyTeamMode(lobby, 'ludoOptions', teamMode);
        lobby.maxPlayers = 4; // ludo is always capped at 4
        emitLobbyState(io, lobbyId, lobby);
    });

    socket.on('lobby:setPerudoOptions', ({ initialDice }) => {
        const ctx = getHostLobby(socket, lobbies);
        if (!ctx) return;
        const { lobbyId, lobby } = ctx;
        lobby.perudoOptions ||= { initialDice: 5 };
        const d = numOpt(initialDice, 3, 6);
        if (d !== undefined) lobby.perudoOptions.initialDice = d;
        emitLobbyState(io, lobbyId, lobby);
    });

    socket.on('lobby:setCantStopOptions', ({ columnsToWin }) => {
        const ctx = getHostLobby(socket, lobbies);
        if (!ctx) return;
        const { lobbyId, lobby } = ctx;
        lobby.cantStopOptions ||= { columnsToWin: 3 };
        const c = numOpt(columnsToWin, 2, 4);
        if (c !== undefined) lobby.cantStopOptions.columnsToWin = c;
        emitLobbyState(io, lobbyId, lobby);
    });

    socket.on('lobby:setMilleBornesOptions', ({ target, teamMode, teamDistance }) => {
        const ctx = getHostLobby(socket, lobbies);
        if (!ctx) return;
        const { lobbyId, lobby } = ctx;
        lobby.mbOptions ||= { target: 1000, teamMode: 'none', teamDistance: 'individual' };
        if (target === 700 || target === 1000) lobby.mbOptions.target = target;
        if (teamDistance === 'individual' || teamDistance === 'shared') lobby.mbOptions.teamDistance = teamDistance;
        if (teamMode === 'none' || teamMode === '2v2') {
            applyTeamMode(lobby, 'mbOptions', teamMode);
            lobby.maxPlayers = teamMode === '2v2' ? 4 : lobby.maxPlayers;
        }
        emitLobbyState(io, lobbyId, lobby);
    });

    socket.on('lobby:setImpostorOptions', ({ rounds, timePerRound, misterWhite }) => {
        const ctx = getHostLobby(socket, lobbies);
        if (!ctx) return;
        const { lobbyId, lobby } = ctx;
        lobby.impostorOptions ||= { rounds: 1, timePerRound: 60, misterWhite: false };
        const r = numOpt(rounds,      1,   5); if (r !== undefined) lobby.impostorOptions.rounds      = r;
        const t = numOpt(timePerRound, 30, 120); if (t !== undefined) lobby.impostorOptions.timePerRound = t;
        if (typeof misterWhite === 'boolean') lobby.impostorOptions.misterWhite = misterWhite;
        emitLobbyState(io, lobbyId, lobby);
    });

    socket.on('lobby:setSpyfallOptions', ({ exchangesPerPlayer, turnTime }) => {
        const ctx = getHostLobby(socket, lobbies);
        if (!ctx) return;
        const { lobbyId, lobby } = ctx;
        lobby.spyfallOptions ||= { exchangesPerPlayer: 2, turnTime: 40 };
        const e = numOpt(exchangesPerPlayer, 1,   3); if (e !== undefined) lobby.spyfallOptions.exchangesPerPlayer = e;
        const t = numOpt(turnTime,          30, 120); if (t !== undefined) lobby.spyfallOptions.turnTime          = t;
        emitLobbyState(io, lobbyId, lobby);
    });

    socket.on('lobby:setTeam', ({ team }) => {
        const ctx = getLobby(socket, lobbies);
        if (!ctx) return;
        const { lobbyId, userId, lobby } = ctx;
        const teamNum = Number(team);
        if (teamNum !== 0 && teamNum !== 1) return;
        if (!lobby.teams) lobby.teams = new Map();
        if (lobby.teams.get(userId) === teamNum) lobby.teams.delete(userId);
        else lobby.teams.set(userId, teamNum);
        autoFillBotTeams(lobby);
        emitLobbyState(io, lobbyId, lobby);
    });

    socket.on('lobby:shuffleTeams', () => {
        const ctx = getHostLobby(socket, lobbies);
        if (!ctx) return;
        const { lobbyId, lobby } = ctx;
        const humanIds = Array.from(lobby.players.keys());
        const botIds = (lobby.botSlots ?? []).map((b: { userId: string }) => b.userId);
        const ids = [...humanIds, ...botIds].sort(() => Math.random() - 0.5);
        const half = Math.floor(ids.length / 2);
        lobby.teams = new Map();
        ids.forEach((id, i) => lobby.teams.set(id, i < half ? 0 : 1));
        if (lobby.gameType === 'taboo') {
            lobby.orators ||= { '0': null, '1': null };
            const t0 = ids.filter((_, i) => i < half);
            const t1 = ids.filter((_, i) => i >= half);
            lobby.orators['0'] = t0[Math.floor(Math.random() * t0.length)] ?? null;
            lobby.orators['1'] = t1[Math.floor(Math.random() * t1.length)] ?? null;
        }
        emitLobbyState(io, lobbyId, lobby);
    });

    // ── Start game ────────────────────────────────────────────────────────────

    socket.on('lobby:start', async () => {
        const { lobbyId, userId } = socket.data || {};
        if (!lobbyId || !userId) { console.log('[START] abort: no lobbyId/userId on socket'); return; }
        const lobby = lobbies.get(lobbyId);
        if (!lobby) { console.log(`[START] abort: lobby ${lobbyId} not found (server may have restarted)`); return; }
        if (lobby.hostId !== userId) { console.log(`[START] abort: ${userId} is not host of ${lobbyId}`); return; }
        if (!canStart(lobby)) { console.log(`[START] abort: canStart=false for ${lobbyId} (${lobby.gameType}, ${lobby.players.size} players)`); return; }

        const gameType = lobby.gameType ?? 'quiz';

        const doWake = async () => {
            io.to(`lobby:${lobbyId}`).emit('lobby:server_warming', { estimatedSeconds: 60 });
            const gsUrl = GAME_SERVER_URLS[gameType];
            if (gsUrl) fetch(`${gsUrl}/health`, { signal: AbortSignal.timeout(5_000) }).catch(() => {});
            await ensureConnected(gameType);
        };

        if (!gameServerConnections.has(gameType)) {
            try {
                await doWake();
            } catch {
                io.to(`lobby:${lobbyId}`).emit('lobby:server_error');
                lobby.status = 'WAITING';
                emitLobbyState(io, lobbyId, lobby);
                return;
            }
        }

        lobby.status = 'PLAYING';
        emitLobbyState(io, lobbyId, lobby);
        const gameId = randomUUID();
        const startGame = (payload: any) => {
            const fullPayload = { ...payload, gameId };
            lobby.gameStartPayload = fullPayload;
            io.to(`lobby:${lobbyId}`).emit('game:start', fullPayload);
            void purgeLobbyInvites(lobbyId);
        };

        let done = false;
        const ackTimer = setTimeout(async () => {
            if (done) return;
            done = true;
            lobby.status = 'WAITING';
            emitLobbyState(io, lobbyId, lobby);
            try {
                await doWake();
            } catch {
                io.to(`lobby:${lobbyId}`).emit('lobby:server_error');
                return;
            }
            lobby.status = 'PLAYING';
            emitLobbyState(io, lobbyId, lobby);
            sendConfigure(gameType, lobbyId, lobby, () => {
                if (gameType === 'quiz') startGame({ gameType: 'quiz', quizId: lobby.quizId });
                else startGame({ gameType, lobbyId });
            }, { fresh: true });
        }, 8_000);

        sendConfigure(gameType, lobbyId, lobby, () => {
            if (done) return;
            done = true;
            clearTimeout(ackTimer);
            if (gameType === 'quiz') startGame({ gameType: 'quiz', quizId: lobby.quizId });
            else startGame({ gameType, lobbyId });
        }, { fresh: true });
    });

    // ── Lobby list ────────────────────────────────────────────────────────────

    socket.on('get:lobbies', () => {
        socket.emit('lobbies', buildLobbyList(lobbies));
    });

    // ── Disconnect ────────────────────────────────────────────────────────────

    socket.on('disconnect', () => {
        const ctx = getLobby(socket, lobbies);
        if (!ctx) return;
        removePlayerAndMaybeTransferHost(io, lobbies, ctx.lobbyId, ctx.userId);
    });
}
