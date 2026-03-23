// lobby-server/src/index.ts
import 'dotenv/config';
import express from "express";
import http from "http";
import { Server } from "socket.io";
import { io as socketClient } from "socket.io-client";

const app = express();
app.get("/health", (req, res) => res.status(200).send("ok"));

const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: process.env.FRONTEND_URL,
        methods: ["GET", "POST"],
        credentials: true,
    },
});

const unoServerSocket = socketClient(
    process.env.UNO_SERVER_URL ?? "http://localhost:10001",
    { transports: ["websocket"] }
);

const tabooServerSocket = socketClient(
    process.env.TABOO_SERVER_URL ?? "http://localhost:10003",
    { transports: ["websocket"] }
);

const skyjowServerSocket = socketClient(
    process.env.SKYJOW_SERVER_URL ?? "http://localhost:10004",
    { transports: ["websocket"] }
);

const yahtzeeServerSocket = socketClient(
    process.env.YAHTZEE_SERVER_URL ?? "http://localhost:10005",
    { transports: ["websocket"] }
);

const justOneServerSocket = socketClient(
    process.env.JUST_ONE_SERVER_URL ?? "http://localhost:10007",
    { transports: ["websocket"] }
);

const diamantServerSocket = socketClient(
    process.env.DIAMANT_SERVER_URL ?? "http://localhost:10009",
    { transports: ["websocket"] }
);

const impostorServerSocket = socketClient(
    process.env.IMPOSTOR_SERVER_URL ?? "http://localhost:10010",
    { transports: ["websocket"] }
);

const quizServerSocket = socketClient(
    process.env.QUIZ_SERVER_URL ?? "http://localhost:10002",
    { transports: ["websocket"] }
);

const battleshipServerSocket = socketClient(
    process.env.BATTLESHIP_SERVER_URL ?? "http://localhost:10008",
    { transports: ["websocket"] }
);

const puissance4ServerSocket = socketClient(
    process.env.PUISSANCE4_SERVER_URL ?? "http://localhost:10006",
    { transports: ["websocket"] }
);

const lobbies = new Map<string, any>();

// ── Reconnect handlers: resend configure when a game server restarts ──────────

function sendTabooConfigure(lobbyId: string, lobby: any) {
    const opts = lobby.tabooOptions ?? { turnDuration: 60, totalRounds: 3, trapWordCount: 5, maxAttempts: 10, trapDuration: 60 };
    tabooServerSocket.emit("taboo:configure", { lobbyId, options: opts, teams: lobby.teams ? Object.fromEntries(lobby.teams) : null, orators: lobby.orators ?? { "0": null, "1": null }, hostId: lobby.hostId });
}
function sendUnoConfigure(lobbyId: string, lobby: any) {
    const opts = lobby.unoOptions ?? { stackable: false, jumpIn: false, teamMode: "none", teamWinMode: "one" };
    unoServerSocket.emit("uno:configure", { lobbyId, options: opts, expectedCount: lobby.players.size, preAssignedTeams: lobby.teams ? Object.fromEntries(lobby.teams) : null });
}
function sendSkyjowConfigure(lobbyId: string, lobby: any) {
    skyjowServerSocket.emit("skyjow:configure", { lobbyId, players: Array.from(lobby.players.values()), options: lobby.skyjowOptions ?? { eliminateRows: false } });
}
function sendYahtzeeConfigure(lobbyId: string, lobby: any) {
    yahtzeeServerSocket.emit("yahtzee:configure", { lobbyId, players: Array.from(lobby.players.values()) });
}
function sendJustOneConfigure(lobbyId: string, lobby: any) {
    justOneServerSocket.emit("just_one:configure", { lobbyId, players: Array.from(lobby.players.values()) });
}
function sendDiamantConfigure(lobbyId: string, lobby: any) {
    diamantServerSocket.emit("diamant:configure", { lobbyId, players: Array.from(lobby.players.values()), options: lobby.diamantOptions ?? { roundCount: 5 } });
}
function sendImpostorConfigure(lobbyId: string, lobby: any) {
    impostorServerSocket.emit("impostor:configure", { lobbyId, players: Array.from(lobby.players.values()), expectedCount: lobby.players.size, options: lobby.impostorOptions ?? { rounds: 1 } });
}
function sendQuizConfigure(lobbyId: string, lobby: any) {
    quizServerSocket.emit("quiz:configure", { lobbyId, quizId: lobby.quizId, players: Array.from(lobby.players.values()), expectedCount: lobby.players.size, timeMode: lobby.timeMode, timePerQuestion: lobby.timePerQuestion });
}
function sendBattleshipConfigure(lobbyId: string, lobby: any) {
    battleshipServerSocket.emit("battleship:configure", { lobbyId, options: lobby.battleshipOptions ?? {} });
}
function sendPuissance4Configure(lobbyId: string) {
    puissance4ServerSocket.emit("p4:configure", { lobbyId });
}

const reconnectHandlers: [any, string, (id: string, l: any) => void][] = [
    [tabooServerSocket, "taboo", sendTabooConfigure],
    [unoServerSocket, "uno", sendUnoConfigure],
    [skyjowServerSocket, "skyjow", sendSkyjowConfigure],
    [yahtzeeServerSocket, "yahtzee", sendYahtzeeConfigure],
    [justOneServerSocket, "just_one", sendJustOneConfigure],
    [diamantServerSocket, "diamant", sendDiamantConfigure],
    [impostorServerSocket, "impostor", sendImpostorConfigure],
    [quizServerSocket, "quiz", sendQuizConfigure],
    [battleshipServerSocket, "battleship", sendBattleshipConfigure],
    [puissance4ServerSocket, "puissance4", sendPuissance4Configure],
];

for (const [sock, gameType, sendConfigure] of reconnectHandlers) {
    let isFirstConnect = true;
    sock.on("connect", () => {
        if (isFirstConnect) { isFirstConnect = false; return; }
        // Server restarted: resend configure for all active lobbies of this type
        for (const [lobbyId, lobby] of lobbies) {
            if (lobby.status === "PLAYING" && (lobby.gameType ?? "quiz") === gameType) {
                sendConfigure(lobbyId, lobby);
            }
        }
    });
}

// ── Lobby helpers ────────────────────────────────────────────────────────────

function emitLobbyState(io: Server, lobbyId: string, lobby: any) {
    io.to(`lobby:${lobbyId}`).emit("lobby:state", {
        hostId: lobby.hostId,
        quizId: lobby.quizId,
        status: lobby.status,
        timePerQuestion: lobby.timePerQuestion,
        timeMode: lobby.timeMode,
        players: Array.from<any>(lobby.players.values()),
        gameType: lobby.gameType ?? "quiz",
        unoOptions: lobby.unoOptions ?? { stackable: false, jumpIn: false, teamMode: "none", teamWinMode: "one" },
        tabooOptions: lobby.tabooOptions ?? { turnDuration: 60, totalRounds: 3, trapWordCount: 5, maxAttempts: 10, trapDuration: 60 },
        teams: lobby.teams ? Object.fromEntries(lobby.teams) : null,
        orators: lobby.orators ?? { "0": null, "1": null },
        skyjowOptions: lobby.skyjowOptions ?? { eliminateRows: false },
        impostorOptions: lobby.impostorOptions ?? { rounds: 1 },
        title: lobby.title ?? null,
        description: lobby.description ?? null,
        maxPlayers: lobby.maxPlayers ?? 8,
        isPublic: lobby.isPublic ?? false,
    });
}

function removePlayerAndMaybeTransferHost({ io, lobbyId, userId }: { io: Server; lobbyId: string; userId: string }) {
    const lobby = lobbies.get(lobbyId);
    if (!lobby) return;
    if (lobby.resultViewers?.has(userId)) { lobby.resultViewers.delete(userId); return; }
    lobby.players.delete(userId);
    if (lobby.teams) lobby.teams.delete(userId);
    if (lobby.players.size === 0) { lobbies.delete(lobbyId); broadcastLobbies(io); return; }
    if (lobby.hostId === userId) lobby.hostId = (Array.from<any>(lobby.players.values())[0] as any).userId;
    emitLobbyState(io, lobbyId, lobby);
    broadcastLobbies(io);
}

function broadcastLobbies(io: Server) {
    const lobbyList = Array.from(lobbies.entries())
        .filter(([, lobby]) => lobby.isPublic !== false)
        .map(([id, lobby]) => ({
            id,
            title: lobby.title ?? `Lobby de ${Array.from<any>(lobby.players.values())[0]?.username ?? "?"}`,
            description: lobby.description ?? "",
            gameType: lobby.gameType ?? "quiz",
            maxPlayers: lobby.maxPlayers ?? 8,
            currentPlayers: lobby.players.size,
            status: lobby.status === "WAITING" ? "waiting" : "in-progress",
            host: Array.from<any>(lobby.players.values()).find(p => p.userId === lobby.hostId)?.username ?? "?",
            playerNames: Array.from<any>(lobby.players.values()).map(p => p.username),
        }));
    io.emit("lobbies", lobbyList);
}

// ── Socket connections ───────────────────────────────────────────────────────

io.on("connection", (socket) => {
    console.log("nouvelle connexion lobby", socket.id);

    socket.on("lobby:join", ({ lobbyId, userId, username, title, description, maxPlayers, isPublic, gameType }) => {
        if (!lobbyId || !userId || !username) return;

        socket.data = { lobbyId, userId, username };
        socket.join(`lobby:${lobbyId}`);

        // Récupération ou création du lobby
        let lobby = lobbies.get(lobbyId);
        const defaultMaxPlayers = 8;

        if (!lobby) {
            lobby = {
                isPublic: typeof isPublic === 'boolean' ? isPublic : false,
                hostId: userId,
                quizId: null,
                status: "WAITING",
                timePerQuestion: 15,
                timeMode: "per_question",
                players: new Map(),
                resultViewers: new Set(),
                teams: null,
                title: title ?? null,
                description: description ?? "",
                maxPlayers: (Number.isFinite(Number(maxPlayers)) && Number(maxPlayers) >= 2) ? Number(maxPlayers) : defaultMaxPlayers,
                gameType: gameType ?? "uno",
                // Options par défaut pour les jeux
                unoOptions: { stackable: false, jumpIn: false, teamMode: "none", teamWinMode: "one" },
                tabooOptions: { turnDuration: 60, totalRounds: 3, trapWordCount: 5, maxAttempts: 10, trapDuration: 60 },
                skyjowOptions: { eliminateRows: false },
                battleshipOptions: { gridSize: 10, ships: [5, 4, 3, 3, 2] },
                diamantOptions: { roundCount: 5 },
                impostorOptions: { rounds: 1, timePerRound: 60 },
                orators: { "0": null, "1": null }
            };
        }

        // Vérification limite de joueurs
        if (lobby.players.has(userId)) {
            // Reconnexion : on met à jour le username si besoin
            lobby.players.set(userId, { userId, username });
        } else if (lobby.players.size >= lobby.maxPlayers) {
            // Lobby plein
            socket.emit("lobby:full", { lobbyId });
            return;
        } else {
            // Nouveau joueur
            lobby.players.set(userId, { userId, username });
        }

        // Garantir les champs par défaut
        lobby.hostId ||= userId;
        lobby.resultViewers ||= new Set();
        lobby.teams ||= null;
        lobby.orators ||= { "0": null, "1": null };
        lobby.unoOptions ||= { stackable: false, jumpIn: false, teamMode: "none", teamWinMode: "one" };
        lobby.tabooOptions ||= { turnDuration: 60, totalRounds: 3, trapWordCount: 5, maxAttempts: 10, trapDuration: 60 };
        lobby.skyjowOptions ||= { eliminateRows: false };
        lobby.battleshipOptions ||= { gridSize: 10, ships: [5, 4, 3, 3, 2] };
        lobby.impostorOptions ||= { rounds: 1, timePerRound: 60 };

        // Sauvegarde et émission
        lobbies.set(lobbyId, lobby);
        emitLobbyState(io, lobbyId, lobby);
        broadcastLobbies(io);

    });

    socket.on('chat:send', ({ text, team }) => {
        const { lobbyId, userId, username } = socket.data;
        if (!lobbyId || !text) return;
        const msg = { userId, username, text, sentAt: Date.now() };
        if (team === 0 || team === 1) {
            io.to(`lobby:${lobbyId}:team:${team}`).emit('chat:message:team', msg);
        } else {
            io.to(`lobby:${lobbyId}`).emit('chat:message', msg);
        }
    });

    socket.on('chat:joinTeam', ({ team }) => {
        const { lobbyId } = socket.data || {};
        if (!lobbyId) return;
        // Quitter les anciennes rooms d'équipe
        socket.leave(`lobby:${lobbyId}:team:0`);
        socket.leave(`lobby:${lobbyId}:team:1`);
        if (team === 0 || team === 1) {
            socket.join(`lobby:${lobbyId}:team:${team}`);
        }
    });

    socket.on("lobby:setMeta", ({ title, description, maxPlayers, isPublic }) => {
        const { lobbyId, userId } = socket.data || {};
        if (!lobbyId || !userId) return;
        const lobby = lobbies.get(lobbyId);
        if (!lobby || lobby.hostId !== userId) return;
        if (title && typeof title === "string") lobby.title = title.slice(0, 60);
        if (typeof description === "string") lobby.description = description.slice(0, 200);
        if (Number.isFinite(Number(maxPlayers)) && Number(maxPlayers) >= 2) lobby.maxPlayers = Number(maxPlayers);
        if (typeof isPublic === "boolean") lobby.isPublic = isPublic;
        emitLobbyState(io, lobbyId, lobby);
        broadcastLobbies(io);
    });

    socket.on("lobby:setOrator", ({ targetUserId }) => {
        const { lobbyId, userId } = socket.data || {};
        if (!lobbyId || !userId || !targetUserId) return;
        if (userId !== targetUserId) return;
        const lobby = lobbies.get(lobbyId);
        if (!lobby) return;
        if (!lobby.orators) lobby.orators = { "0": null, "1": null };
        const team = lobby.teams?.get(userId);
        if (team === undefined || team === null) return;
        const teamKey = String(team);
        if (lobby.orators[teamKey] === userId) {
            lobby.orators[teamKey] = null;
        } else if (lobby.orators[teamKey] === null) {
            lobby.orators[teamKey] = userId;
        } else {
            socket.emit("lobby:oratorTaken");
            return;
        }
        emitLobbyState(io, lobbyId, lobby);
    });

    socket.on("lobby:leave", () => {
        const { lobbyId, userId } = socket.data || {};
        if (!lobbyId || !userId) return;
        removePlayerAndMaybeTransferHost({ io, lobbyId, userId });
    });

    socket.on("lobby:kick", ({ targetUserId }) => {
        const { lobbyId, userId } = socket.data || {};
        if (!lobbyId || !userId || !targetUserId) return;
        const lobby = lobbies.get(lobbyId);
        if (!lobby || lobby.hostId !== userId || targetUserId === userId) return;
        if (!lobby.players.has(targetUserId)) return;
        for (const [, s] of io.of("/").sockets) {
            if (s.data?.userId === targetUserId && s.data?.lobbyId === lobbyId) {
                s.emit("lobby:kicked"); s.leave(`lobby:${lobbyId}`); s.data = {}; break;
            }
        }
        lobby.players.delete(targetUserId);
        if (lobby.teams) lobby.teams.delete(targetUserId);
        if (lobby.players.size === 0) { lobbies.delete(lobbyId); return; }
        emitLobbyState(io, lobbyId, lobby);
        broadcastLobbies(io);
    });

    socket.on("lobby:transferHost", ({ targetUserId }) => {
        const { lobbyId, userId } = socket.data || {};
        if (!lobbyId || !userId || !targetUserId) return;
        const lobby = lobbies.get(lobbyId);
        if (!lobby || lobby.hostId !== userId || targetUserId === userId) return;
        if (!lobby.players.has(targetUserId)) return;
        lobby.hostId = targetUserId;
        emitLobbyState(io, lobbyId, lobby);
        broadcastLobbies(io);
    });

    socket.on("lobby:claimHost", async () => {
        const { lobbyId, userId } = socket.data || {};
        if (!lobbyId || !userId) return;
        const lobby = lobbies.get(lobbyId);
        if (!lobby || !lobby.players.has(userId)) return;
        // Verify admin role via frontend API
        const frontendUrl = process.env.FRONTEND_URL;
        const secret = process.env.INTERNAL_API_KEY;
        if (!frontendUrl || !secret) return;
        try {
            const res = await fetch(`${frontendUrl}/api/user/role?userId=${userId}`, {
                headers: { Authorization: `Bearer ${secret}` },
            });
            if (!res.ok) return;
            const { role } = await res.json() as { role: string };
            if (role !== 'ADMIN') return;
        } catch { return; }
        lobby.hostId = userId;
        emitLobbyState(io, lobbyId, lobby);
        broadcastLobbies(io);
    });

    socket.on("lobby:setQuizOptions", ({ timeMode, timePerQuestion }) => {
        const { lobbyId, userId } = socket.data || {};
        if (!lobbyId || !userId) return;
        const lobby = lobbies.get(lobbyId);
        if (!lobby || lobby.hostId !== userId) return;
        if (timeMode !== undefined) {
            if (!["per_question", "total", "none"].includes(timeMode)) return;
            lobby.timeMode = timeMode;
        }
        if (timePerQuestion !== undefined) {
            const t = Number(timePerQuestion);
            if (!Number.isFinite(t) || t < 5 || t > 3600) return;
            lobby.timePerQuestion = t;
        }
        emitLobbyState(io, lobbyId, lobby);
    });

    socket.on("lobby:setQuiz", ({ quizId }) => {
        const { lobbyId, userId } = socket.data || {};
        if (!lobbyId || !userId) return;
        const lobby = lobbies.get(lobbyId);
        if (!lobby || lobby.hostId !== userId) return;
        lobby.quizId = quizId ?? null;
        emitLobbyState(io, lobbyId, lobby);
    });

    socket.on("lobby:setGameType", ({ gameType }) => {
        const { lobbyId, userId } = socket.data || {};
        if (!lobbyId || !userId) return;
        const lobby = lobbies.get(lobbyId);
        if (!lobby || lobby.hostId !== userId) return;
        if (!["quiz", "uno", "taboo", "skyjow", "yahtzee", "puissance4", "just_one", "battleship", "diamant", "impostor"].includes(gameType)) return;
        lobby.gameType = gameType;
        if (gameType !== "quiz") lobby.quizId = null;
        if (gameType === "quiz") lobby.maxPlayers = 30;
        if (gameType === "puissance4") lobby.maxPlayers = 2;
        if (gameType === "battleship") lobby.maxPlayers = 2;
        if (gameType === "diamant") lobby.maxPlayers = 8;
        if (gameType === "impostor") lobby.maxPlayers = 8;
        if (gameType === "uno" && lobby.unoOptions?.teamMode === "2v2") lobby.maxPlayers = 4;
        if (gameType === "just_one") lobby.maxPlayers = 7;
        emitLobbyState(io, lobbyId, lobby);
        broadcastLobbies(io);
    });

    socket.on("lobby:setUnoOptions", ({ stackable, jumpIn, teamMode, teamWinMode }) => {
        const { lobbyId, userId } = socket.data || {};
        if (!lobbyId || !userId) return;
        const lobby = lobbies.get(lobbyId);
        if (!lobby || lobby.hostId !== userId) return;
        if (!lobby.unoOptions) lobby.unoOptions = { stackable: false, jumpIn: false, teamMode: "none", teamWinMode: "one" };
        if (typeof stackable === "boolean") lobby.unoOptions.stackable = stackable;
        if (typeof jumpIn === "boolean") lobby.unoOptions.jumpIn = jumpIn;
        if (teamMode === "none" || teamMode === "2v2") {
            lobby.unoOptions.teamMode = teamMode;
            lobby.teams = teamMode === "2v2" ? new Map() : null;
        }
        if (teamWinMode === "one" || teamWinMode === "both") lobby.unoOptions.teamWinMode = teamWinMode;
        emitLobbyState(io, lobbyId, lobby);
    });

    socket.on("lobby:setTabooOptions", ({ turnDuration, totalRounds, trapWordCount, maxAttempts, trapDuration }) => {
        const { lobbyId, userId } = socket.data || {};
        if (!lobbyId || !userId) return;
        const lobby = lobbies.get(lobbyId);
        if (!lobby || lobby.hostId !== userId) return;
        if (!lobby.tabooOptions) lobby.tabooOptions = { turnDuration: 60, totalRounds: 3, trapWordCount: 5, maxAttempts: 10, trapDuration: 60 };
        const td = Number(turnDuration);
        if (Number.isFinite(td) && td >= 15 && td <= 300) lobby.tabooOptions.turnDuration = td;
        const tr = Number(totalRounds);
        if (Number.isFinite(tr) && tr >= 1 && tr <= 10) lobby.tabooOptions.totalRounds = tr;
        const tw = Number(trapWordCount);
        if (Number.isFinite(tw) && tw >= 1 && tw <= 10) lobby.tabooOptions.trapWordCount = tw;
        const ma = Number(maxAttempts);
        if (Number.isFinite(ma) && ma >= 1 && ma <= 30) lobby.tabooOptions.maxAttempts = ma;
        const trapd = Number(trapDuration);
        if (Number.isFinite(trapd) && trapd >= 15 && trapd <= 300) lobby.tabooOptions.trapDuration = trapd;
        emitLobbyState(io, lobbyId, lobby);
    });

    socket.on("lobby:setTeam", ({ team }) => {
        const { lobbyId, userId } = socket.data || {};
        if (!lobbyId || !userId) return;
        const lobby = lobbies.get(lobbyId);
        const teamNum = Number(team);
        if (!lobby || (teamNum !== 0 && teamNum !== 1)) return;
        if (!lobby.teams) lobby.teams = new Map();
        if (lobby.teams.get(userId) === teamNum) {
            lobby.teams.delete(userId);
        } else {
            lobby.teams.set(userId, teamNum);
        }
        emitLobbyState(io, lobbyId, lobby);
    });

    socket.on("lobby:shuffleTeams", () => {
        const { lobbyId, userId } = socket.data || {};
        if (!lobbyId || !userId) return;
        const lobby = lobbies.get(lobbyId);
        if (!lobby || lobby.hostId !== userId) return;
        const players = Array.from(lobby.players.keys()).sort(() => Math.random() - 0.5);
        const half = Math.floor(players.length / 2);
        if (!lobby.teams) lobby.teams = new Map();
        else lobby.teams.clear();
        players.forEach((id, i) => lobby.teams.set(id, i < half ? 0 : 1));
        if (lobby.gameType === "taboo") {
            if (!lobby.orators) lobby.orators = { "0": null, "1": null };
            const team0Players = players.filter((_, i) => i < half);
            const team1Players = players.filter((_, i) => i >= half);
            lobby.orators["0"] = team0Players[Math.floor(Math.random() * team0Players.length)] ?? null;
            lobby.orators["1"] = team1Players[Math.floor(Math.random() * team1Players.length)] ?? null;
        }
        emitLobbyState(io, lobbyId, lobby);
    });

    socket.on("lobby:start", () => {
        const { lobbyId, userId } = socket.data || {};
        if (!lobbyId || !userId) return;
        const lobby = lobbies.get(lobbyId);
        if (!lobby || lobby.hostId !== userId) return;
        const gameType = lobby.gameType ?? "quiz";
        if (gameType === "quiz" && !lobby.quizId) return;
        if (gameType === "skyjow" && (lobby.players.size < 2 || lobby.players.size > 8)) return;
        if (gameType === "puissance4" && lobby.players.size !== 2) return;
        if (gameType === "yahtzee" && (lobby.players.size < 2 || lobby.players.size > 8)) return;
        if (gameType === "taboo") {
            if (!lobby.teams || lobby.teams.size < 4) return;
            const t0 = Array.from(lobby.teams.values()).filter(t => t === 0).length;
            const t1 = Array.from(lobby.teams.values()).filter(t => t === 1).length;
            if (t0 < 2 || t1 < 2) return;
        }
        if (gameType === "uno" && lobby.unoOptions?.teamMode === "2v2") {
            if (lobby.players.size !== 4) return;
            if (!lobby.teams || lobby.teams.size !== 4) return;
            const t0 = Array.from(lobby.teams.values()).filter(t => t === 0).length;
            const t1 = Array.from(lobby.teams.values()).filter(t => t === 1).length;
            if (t0 !== 2 || t1 !== 2) return;
        }
        lobby.status = "PLAYING";
        emitLobbyState(io, lobbyId, lobby);
        const startGame = (payload: any) => {
            lobby.gameStartPayload = payload;
            io.to(`lobby:${lobbyId}`).emit("game:start", payload);
        };
        if (gameType === "uno") {
            const opts = lobby.unoOptions ?? { stackable: false, jumpIn: false, teamMode: "none", teamWinMode: "one" };
            unoServerSocket.emit("uno:configure", { lobbyId, options: opts, expectedCount: lobby.players.size, preAssignedTeams: lobby.teams ? Object.fromEntries(lobby.teams) : null }, () => startGame({ gameType: "uno", lobbyId }));
        } else if (gameType === "taboo") {
            const opts = lobby.tabooOptions ?? { turnDuration: 60, totalRounds: 3, trapWordCount: 5, maxAttempts: 10, trapDuration: 60 };
            tabooServerSocket.emit("taboo:configure", { lobbyId, options: opts, teams: lobby.teams ? Object.fromEntries(lobby.teams) : null, orators: lobby.orators ?? { "0": null, "1": null }, hostId: lobby.hostId }, () => startGame({ gameType: "taboo", lobbyId }));
        } else if (gameType === "skyjow") {
            const players = Array.from<any>(lobby.players.values());
            const opts = lobby.skyjowOptions ?? { eliminateRows: false };
            skyjowServerSocket.emit("skyjow:configure", { lobbyId, players, options: opts }, () => startGame({ gameType: "skyjow", lobbyId }));
        } else if (gameType === "yahtzee") {
            const players = Array.from<any>(lobby.players.values());
            yahtzeeServerSocket.emit("yahtzee:configure", { lobbyId, players }, () => startGame({ gameType: "yahtzee", lobbyId }));
        } else if (gameType === "puissance4") {
            puissance4ServerSocket.emit("p4:configure", { lobbyId }, () => startGame({ gameType: "puissance4", lobbyId }));
        } else if (gameType === "just_one") {
            const players = Array.from<any>(lobby.players.values());
            justOneServerSocket.emit("just_one:configure", { lobbyId, players }, () => startGame({ gameType: "just_one", lobbyId }));
        } else if (gameType === "battleship") {
            battleshipServerSocket.emit("battleship:configure", { lobbyId, options: lobby.battleshipOptions ?? {} }, () => startGame({ gameType: "battleship", lobbyId }));
        } else if (gameType === "diamant") {
            const players = Array.from(lobby.players.values());
            diamantServerSocket.emit("diamant:configure", { lobbyId, players, options: lobby.diamantOptions ?? { roundCount: 5 } }, () => startGame({ gameType: "diamant", lobbyId }));
        } else if (gameType === "impostor") {
            const players = Array.from<any>(lobby.players.values());
            impostorServerSocket.emit("impostor:configure", { lobbyId, players, expectedCount: lobby.players.size, options: lobby.impostorOptions ?? { rounds: 1 } }, () => startGame({ gameType: "impostor", lobbyId }));
        } else {
            const players = Array.from<any>(lobby.players.values());
            quizServerSocket.emit("quiz:configure", { lobbyId, quizId: lobby.quizId, players, expectedCount: lobby.players.size, timeMode: lobby.timeMode, timePerQuestion: lobby.timePerQuestion }, () => startGame({ gameType: "quiz", quizId: lobby.quizId }));
        }
    });

    socket.on("lobby:setSkyjowOptions", ({ eliminateRows }) => {
        const { lobbyId, userId } = socket.data || {};
        if (!lobbyId || !userId) return;
        const lobby = lobbies.get(lobbyId);
        if (!lobby || lobby.hostId !== userId) return;
        if (!lobby.skyjowOptions) lobby.skyjowOptions = { eliminateRows: false };
        if (typeof eliminateRows === "boolean") lobby.skyjowOptions.eliminateRows = eliminateRows;
        emitLobbyState(io, lobbyId, lobby);
    });

    socket.on("lobby:setImpostorOptions", ({ rounds, timePerRound }) => {
        const { lobbyId, userId } = socket.data || {};
        if (!lobbyId || !userId) return;
        const lobby = lobbies.get(lobbyId);
        if (!lobby || lobby.hostId !== userId) return;
        if (!lobby.impostorOptions) lobby.impostorOptions = { rounds: 1, timePerRound: 60 };
        const r = Number(rounds);
        if (Number.isFinite(r) && r >= 1 && r <= 5) lobby.impostorOptions.rounds = r;
        const t = Number(timePerRound);
        if (Number.isFinite(t) && t >= 30 && t <= 120) lobby.impostorOptions.timePerRound = t;
        emitLobbyState(io, lobbyId, lobby);
    });

    socket.on("get:lobbies", () => {
        const lobbyList = Array.from(lobbies.entries())
            .filter(([, lobby]) => lobby.isPublic !== false)
            .map(([id, lobby]) => ({
                id,
                title: lobby.title ?? `Lobby de ${Array.from<any>(lobby.players.values())[0]?.username ?? "?"}`,
                description: lobby.description ?? "",
                gameType: lobby.gameType ?? "quiz",
                maxPlayers: lobby.maxPlayers ?? 8,
                currentPlayers: lobby.players.size,
                status: lobby.status === "WAITING" ? "waiting" : "in-progress",
                host: Array.from<any>(lobby.players.values()).find(p => p.userId === lobby.hostId)?.username ?? "?",
                playerNames: Array.from<any>(lobby.players.values()).map(p => p.username),
            }));
        socket.emit("lobbies", lobbyList);
    });


    socket.on("disconnect", () => {
        const { lobbyId, userId } = socket.data || {};
        if (!lobbyId || !userId) return;
        removePlayerAndMaybeTransferHost({ io, lobbyId, userId });
    });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log("[LOBBY] realtime listening on", PORT));
