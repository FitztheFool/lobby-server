// lobby-server/src/handlers.ts
import { randomUUID } from 'crypto';
import { Server, Socket } from 'socket.io';
import { gameServerConnections, ensureConnected, preWarm, sendConfigure, GAME_SERVER_URLS } from './gameServers';
import { emitLobbyState, broadcastLobbies, removePlayerAndMaybeTransferHost, autoFillBotTeams } from './lobbyHelpers';

const BOT_SUPPORTED_GAMES = new Set(['puissance4', 'yahtzee', 'diamant', 'battleship', 'uno', 'skyjow', 'ludo']);

const VALID_GAME_TYPES = ['quiz', 'uno', 'taboo', 'skyjow', 'yahtzee', 'puissance4', 'just_one', 'battleship', 'diamant', 'impostor', 'ludo'];

const DEFAULT_MAX_PLAYERS: Record<string, number> = {
    quiz: 30, puissance4: 2, battleship: 2, diamant: 8, impostor: 8, just_one: 7, ludo: 4,
};

function canStart(lobby: any): boolean {
    const g = lobby.gameType ?? 'quiz';
    const total = lobby.players.size + (lobby.bots ?? 0);
    if (g === 'quiz' && (!lobby.quizId || lobby.players.size < 1)) return false;
    if (g === 'uno' && total < 2) return false;
    if (g === 'skyjow' && (total < 2 || total > 8)) return false;
    if ((g === 'puissance4' || g === 'battleship') && total !== 2) return false;
    if (g === 'yahtzee' && (lobby.players.size < 1 || total < 2 || total > 8)) return false;
    if (g === 'just_one' && lobby.players.size < 3) return false;
    if (g === 'diamant' && (lobby.players.size < 1 || total < 2 || total > 8)) return false;
    if (g === 'impostor' && lobby.players.size < 4) return false;
    if (g === 'ludo' && (lobby.players.size < 1 || total < 2 || total > 4)) return false;
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
    if (g === 'ludo') {
        if (total < 2 || total > 4) return false;
        if (lobby.ludoOptions?.teamMode === '2v2') {
            if (total !== 4) return false;
            if (!lobby.teams || lobby.teams.size !== 4) return false;
            const t0 = Array.from<number>(lobby.teams.values()).filter(t => t === 0).length;
            const t1 = Array.from<number>(lobby.teams.values()).filter(t => t === 1).length;
            if (t0 !== 2 || t1 !== 2) return false;
        }
    }
    return true;
}

export function registerHandlers(io: Server, socket: Socket, lobbies: Map<string, any>): void {

    socket.on('lobby:join', ({ lobbyId, title, description, maxPlayers, isPublic, gameType }) => {
        const { userId, username } = socket.data;
        if (!lobbyId || !userId || !username) return;

        const existing = lobbies.get(lobbyId);
        // Lobbies privés : pendant qu'une partie est en cours, seuls les membres déjà
        // enregistrés peuvent rejoindre (anti-intrusion mid-game). Les nouveaux peuvent
        // toujours rejoindre via l'URL tant que le lobby est en WAITING.
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
                ludoOptions: { pawnExit: '6', bonusOn6: 'unlimited', winMode: 'first_done', teamMode: 'none' },
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

        // Ensure defaults on older lobby objects
        lobby.hostId            ||= userId;
        lobby.resultViewers     ||= new Set();
        lobby.members           ||= new Set<string>();
        lobby.teams             ||= null;
        lobby.botSlots          ||= [];

        // Trace persistante de l'appartenance — survit aux disconnect/reconnect.
        lobby.members.add(userId);
        lobby.orators           ||= { '0': null, '1': null };
        lobby.unoOptions        ||= { stackable: false, jumpIn: false, teamMode: 'none', teamWinMode: 'one' };
        lobby.tabooOptions      ||= { turnDuration: 120, totalRounds: 3, trapWordCount: 5, maxAttempts: 10, trapDuration: 90 };
        lobby.skyjowOptions     ||= { eliminateRows: false };
        lobby.battleshipOptions ||= { gridSize: 10, ships: [5, 4, 3, 3, 2] };
        lobby.impostorOptions   ||= { rounds: 1, timePerRound: 60 };
        lobby.ludoOptions       ||= { pawnExit: '6', bonusOn6: 'unlimited', winMode: 'first_done', teamMode: 'none' };

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
        const { lobbyId, userId } = socket.data || {};
        if (!lobbyId || !userId) return;
        const lobby = lobbies.get(lobbyId);
        if (!lobby) return;
        socket.leave(`lobby:${lobbyId}:team:0`);
        socket.leave(`lobby:${lobbyId}:team:1`);
        if (team !== 0 && team !== 1) return;
        // Empêche un membre du lobby de subscribe au chat d'une équipe à laquelle il n'appartient pas.
        if (lobby.teams?.get(userId) !== team) return;
        socket.join(`lobby:${lobbyId}:team:${team}`);
    });

    // ── Lobby management ──────────────────────────────────────────────────────

    socket.on('lobby:setMeta', ({ title, description, maxPlayers, isPublic }) => {
        const { lobbyId, userId } = socket.data || {};
        if (!lobbyId || !userId) return;
        const lobby = lobbies.get(lobbyId);
        if (!lobby || lobby.hostId !== userId) return;
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
        const { lobbyId, userId } = socket.data || {};
        if (!lobbyId || !userId) return;
        const lobby = lobbies.get(lobbyId);
        // Départ explicite → retire aussi des members (ne pourra rejoindre que via réinvitation/public).
        lobby?.members?.delete(userId);
        removePlayerAndMaybeTransferHost(io, lobbies, lobbyId, userId);
    });

    socket.on('lobby:kick', ({ targetUserId }) => {
        const { lobbyId, userId } = socket.data || {};
        if (!lobbyId || !userId || !targetUserId) return;
        const lobby = lobbies.get(lobbyId);
        if (!lobby || lobby.hostId !== userId || targetUserId === userId) return;
        if (!lobby.players.has(targetUserId)) return;
        for (const [, s] of io.of('/').sockets) {
            if (s.data?.userId === targetUserId && s.data?.lobbyId === lobbyId) {
                s.emit('lobby:kicked'); s.leave(`lobby:${lobbyId}`); s.data = {}; break;
            }
        }
        lobby.players.delete(targetUserId);
        lobby.members?.delete(targetUserId);
        if (lobby.teams) lobby.teams.delete(targetUserId);
        if (lobby.players.size === 0) { lobbies.delete(lobbyId); return; }
        emitLobbyState(io, lobbyId, lobby);
        broadcastLobbies(io, lobbies);
    });

    socket.on('lobby:transferHost', ({ targetUserId }) => {
        const { lobbyId, userId } = socket.data || {};
        if (!lobbyId || !userId || !targetUserId) return;
        const lobby = lobbies.get(lobbyId);
        if (!lobby || lobby.hostId !== userId || targetUserId === userId) return;
        if (!lobby.players.has(targetUserId)) return;
        lobby.hostId = targetUserId;
        emitLobbyState(io, lobbyId, lobby);
        broadcastLobbies(io, lobbies);
    });

    socket.on('lobby:claimHost', async () => {
        const { lobbyId, userId } = socket.data || {};
        if (!lobbyId || !userId) return;
        const lobby = lobbies.get(lobbyId);
        if (!lobby || !lobby.players.has(userId)) return;
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
        const { lobbyId, userId } = socket.data || {};
        if (!lobbyId || !userId) return;
        const lobby = lobbies.get(lobbyId);
        if (!lobby || lobby.hostId !== userId) return;
        if (!VALID_GAME_TYPES.includes(gameType)) return;
        lobby.gameType = gameType;
        lobby.bots = 0;
        lobby.botSlots = [];
        if (gameType !== 'quiz') lobby.quizId = null;
        lobby.maxPlayers = DEFAULT_MAX_PLAYERS[gameType] ?? 8;
        if (gameType === 'uno' && lobby.unoOptions?.teamMode === '2v2') lobby.maxPlayers = 4;
        if (gameType === 'ludo' && lobby.ludoOptions?.teamMode === '2v2') lobby.maxPlayers = 4;
        emitLobbyState(io, lobbyId, lobby);
        broadcastLobbies(io, lobbies);
    });

    socket.on('lobby:addBot', () => {
        const { lobbyId, userId } = socket.data || {};
        if (!lobbyId || !userId) return;
        const lobby = lobbies.get(lobbyId);
        if (!lobby || lobby.hostId !== userId) return;
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
        const { lobbyId, userId } = socket.data || {};
        if (!lobbyId || !userId) return;
        const lobby = lobbies.get(lobbyId);
        if (!lobby || lobby.hostId !== userId) return;
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
        const { lobbyId, userId } = socket.data || {};
        if (!lobbyId || !userId) return;
        const lobby = lobbies.get(lobbyId);
        if (!lobby || lobby.hostId !== userId) return;
        lobby.quizId = quizId ?? null;
        emitLobbyState(io, lobbyId, lobby);
    });

    socket.on('lobby:setQuizOptions', ({ timeMode, timePerQuestion }) => {
        const { lobbyId, userId } = socket.data || {};
        if (!lobbyId || !userId) return;
        const lobby = lobbies.get(lobbyId);
        if (!lobby || lobby.hostId !== userId) return;
        if (timeMode !== undefined) {
            const normalized = timeMode === 'quiz:per_question' ? 'per_question' : timeMode;
            if (['per_question', 'total', 'none'].includes(normalized)) lobby.timeMode = normalized;
        }
        if (timePerQuestion !== undefined) {
            const t = Number(timePerQuestion);
            if (Number.isFinite(t) && t >= 5 && t <= 3600) lobby.timePerQuestion = t;
        }
        emitLobbyState(io, lobbyId, lobby);
    });

    socket.on('lobby:setUnoOptions', ({ stackable, jumpIn, teamMode, teamWinMode }) => {
        const { lobbyId, userId } = socket.data || {};
        if (!lobbyId || !userId) return;
        const lobby = lobbies.get(lobbyId);
        if (!lobby || lobby.hostId !== userId) return;
        lobby.unoOptions ||= { stackable: false, jumpIn: false, teamMode: 'none', teamWinMode: 'one' };
        if (typeof stackable === 'boolean') lobby.unoOptions.stackable = stackable;
        if (typeof jumpIn === 'boolean') lobby.unoOptions.jumpIn = jumpIn;
        if (teamMode === 'none' || teamMode === '2v2') {
            lobby.unoOptions.teamMode = teamMode;
            lobby.teams = teamMode === '2v2' ? new Map() : null;
        }
        if (teamWinMode === 'one' || teamWinMode === 'both') lobby.unoOptions.teamWinMode = teamWinMode;
        emitLobbyState(io, lobbyId, lobby);
    });

    socket.on('lobby:setTabooOptions', ({ turnDuration, totalRounds, trapWordCount, maxAttempts, trapDuration }) => {
        const { lobbyId, userId } = socket.data || {};
        if (!lobbyId || !userId) return;
        const lobby = lobbies.get(lobbyId);
        if (!lobby || lobby.hostId !== userId) return;
        lobby.tabooOptions ||= { turnDuration: 120, totalRounds: 3, trapWordCount: 5, maxAttempts: 10, trapDuration: 90 };
        const td = Number(turnDuration); if (Number.isFinite(td) && td >= 15 && td <= 300) lobby.tabooOptions.turnDuration = td;
        const tr = Number(totalRounds);  if (Number.isFinite(tr) && tr >= 1  && tr <= 10)  lobby.tabooOptions.totalRounds  = tr;
        const tw = Number(trapWordCount); if (Number.isFinite(tw) && tw >= 1 && tw <= 10) lobby.tabooOptions.trapWordCount  = tw;
        const ma = Number(maxAttempts);  if (Number.isFinite(ma) && ma >= 1  && ma <= 30)  lobby.tabooOptions.maxAttempts   = ma;
        const tp = Number(trapDuration); if (Number.isFinite(tp) && tp >= 15 && tp <= 300) lobby.tabooOptions.trapDuration  = tp;
        emitLobbyState(io, lobbyId, lobby);
    });

    socket.on('lobby:setSkyjowOptions', ({ eliminateRows }) => {
        const { lobbyId, userId } = socket.data || {};
        if (!lobbyId || !userId) return;
        const lobby = lobbies.get(lobbyId);
        if (!lobby || lobby.hostId !== userId) return;
        lobby.skyjowOptions ||= { eliminateRows: false };
        if (typeof eliminateRows === 'boolean') lobby.skyjowOptions.eliminateRows = eliminateRows;
        emitLobbyState(io, lobbyId, lobby);
    });

    socket.on('lobby:setBattleshipOptions', ({ gridSize, turnTime }) => {
        const { lobbyId, userId } = socket.data || {};
        if (!lobbyId || !userId) return;
        const lobby = lobbies.get(lobbyId);
        if (!lobby || lobby.hostId !== userId) return;
        lobby.battleshipOptions ||= { gridSize: 10, ships: [5, 4, 3, 3, 2] };
        const g = Number(gridSize); if (Number.isFinite(g) && g >= 8 && g <= 15) lobby.battleshipOptions.gridSize = g;
        const t = Number(turnTime); if (Number.isFinite(t) && t >= 10 && t <= 120) lobby.battleshipOptions.turnTime = t;
        emitLobbyState(io, lobbyId, lobby);
    });

    socket.on('lobby:setLudoOptions', ({ pawnExit, bonusOn6, winMode, teamMode }) => {
        const { lobbyId, userId } = socket.data || {};
        if (!lobbyId || !userId) return;
        const lobby = lobbies.get(lobbyId);
        if (!lobby || lobby.hostId !== userId) return;
        lobby.ludoOptions ||= { pawnExit: '6', bonusOn6: 'unlimited', winMode: 'first_done', teamMode: 'none' };
        if (pawnExit === '6' || pawnExit === '6_or_1' || pawnExit === 'any') lobby.ludoOptions.pawnExit = pawnExit;
        if (bonusOn6 === 'unlimited' || bonusOn6 === 'triple_lose' || bonusOn6 === 'none') lobby.ludoOptions.bonusOn6 = bonusOn6;
        if (winMode === 'first_done' || winMode === 'full_ranking') lobby.ludoOptions.winMode = winMode;
        if (teamMode === 'none' || teamMode === '2v2') {
            lobby.ludoOptions.teamMode = teamMode;
            lobby.teams = teamMode === '2v2' ? new Map() : null;
            if (lobby.gameType === 'ludo') lobby.maxPlayers = 4;
        }
        emitLobbyState(io, lobbyId, lobby);
    });

    socket.on('lobby:setImpostorOptions', ({ rounds, timePerRound, misterWhite }) => {
        const { lobbyId, userId } = socket.data || {};
        if (!lobbyId || !userId) return;
        const lobby = lobbies.get(lobbyId);
        if (!lobby || lobby.hostId !== userId) return;
        lobby.impostorOptions ||= { rounds: 1, timePerRound: 60, misterWhite: false };
        const r = Number(rounds);      if (Number.isFinite(r) && r >= 1  && r <= 5)   lobby.impostorOptions.rounds      = r;
        const t = Number(timePerRound); if (Number.isFinite(t) && t >= 30 && t <= 120) lobby.impostorOptions.timePerRound = t;
        if (typeof misterWhite === 'boolean') lobby.impostorOptions.misterWhite = misterWhite;
        emitLobbyState(io, lobbyId, lobby);
    });

    socket.on('lobby:setTeam', ({ team }) => {
        const { lobbyId, userId } = socket.data || {};
        if (!lobbyId || !userId) return;
        const lobby = lobbies.get(lobbyId);
        const teamNum = Number(team);
        if (!lobby || (teamNum !== 0 && teamNum !== 1)) return;
        if (!lobby.teams) lobby.teams = new Map();
        if (lobby.teams.get(userId) === teamNum) lobby.teams.delete(userId);
        else lobby.teams.set(userId, teamNum);
        autoFillBotTeams(lobby);
        emitLobbyState(io, lobbyId, lobby);
    });

    socket.on('lobby:shuffleTeams', () => {
        const { lobbyId, userId } = socket.data || {};
        if (!lobbyId || !userId) return;
        const lobby = lobbies.get(lobbyId);
        if (!lobby || lobby.hostId !== userId) return;
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
            // Fire-and-forget: wake the Render service (one HTTP request is enough to trigger cold start)
            const gsUrl = GAME_SERVER_URLS[gameType];
            if (gsUrl) fetch(`${gsUrl}/health`, { signal: AbortSignal.timeout(5_000) }).catch(() => {});
            await ensureConnected(gameType);
        };

        // Step 1: wait for game server to connect (it self-connects when it starts up)
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
        };

        // Step 2: send configure; if ack doesn't arrive in 8s, game server may have
        // disconnected just after connecting — wait for it to reconnect and retry
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
            });
        }, 8_000);

        sendConfigure(gameType, lobbyId, lobby, () => {
            if (done) return;
            done = true;
            clearTimeout(ackTimer);
            if (gameType === 'quiz') startGame({ gameType: 'quiz', quizId: lobby.quizId });
            else startGame({ gameType, lobbyId });
        });
    });

    // ── Lobby list ────────────────────────────────────────────────────────────

    socket.on('get:lobbies', () => {
        const lobbyList = Array.from(lobbies.entries())
            .filter(([, lobby]) => lobby.isPublic !== false)
            .map(([id, lobby]) => ({
                id,
                title:          lobby.title ?? `Lobby de ${Array.from<any>(lobby.players.values())[0]?.username ?? '?'}`,
                description:    lobby.description ?? '',
                gameType:       lobby.gameType ?? 'quiz',
                maxPlayers:     lobby.maxPlayers ?? 8,
                currentPlayers: lobby.players.size + (lobby.bots ?? 0),
                status:         lobby.status === 'WAITING' ? 'waiting' : 'in-progress',
                host:           Array.from<any>(lobby.players.values()).find((p: any) => p.userId === lobby.hostId)?.username ?? '?',
                playerNames:    [
                    ...Array.from<any>(lobby.players.values()).map((p: any) => p.username),
                    ...(lobby.botSlots ?? []).map((b: any) => b.username),
                ],
            }));
        socket.emit('lobbies', lobbyList);
    });

    // ── Disconnect ────────────────────────────────────────────────────────────

    socket.on('disconnect', () => {
        const { lobbyId, userId } = socket.data || {};
        if (!lobbyId || !userId) return;
        removePlayerAndMaybeTransferHost(io, lobbies, lobbyId, userId);
    });
}
