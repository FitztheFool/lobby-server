const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { io: socketClient } = require("socket.io-client");

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

const lobbies = new Map();

// ── Lobby helpers ────────────────────────────────────────────────────────────

function emitLobbyState(io, lobbyId, lobby) {
    io.to(`lobby:${lobbyId}`).emit("lobby:state", {
        hostId: lobby.hostId,
        quizId: lobby.quizId,
        status: lobby.status,
        timePerQuestion: lobby.timePerQuestion,
        timeMode: lobby.timeMode,
        players: Array.from(lobby.players.values()),
        gameType: lobby.gameType ?? "quiz",
        unoOptions: lobby.unoOptions ?? { stackable: false, jumpIn: false, teamMode: "none", teamWinMode: "one" },
        tabooOptions: lobby.tabooOptions ?? { turnDuration: 60, totalRounds: 3, trapWordCount: 5, maxAttempts: 10, trapDuration: 60 },
        teams: lobby.teams ? Object.fromEntries(lobby.teams) : null,
        orators: lobby.orators ?? { "0": null, "1": null },
    });
}

function removePlayerAndMaybeTransferHost({ io, lobbyId, userId }) {
    const lobby = lobbies.get(lobbyId);
    if (!lobby) return;
    if (lobby.resultViewers?.has(userId)) { lobby.resultViewers.delete(userId); return; }
    lobby.players.delete(userId);
    if (lobby.teams) lobby.teams.delete(userId);
    if (lobby.players.size === 0) { lobbies.delete(lobbyId); return; }
    if (lobby.hostId === userId) lobby.hostId = Array.from(lobby.players.values())[0].userId;
    emitLobbyState(io, lobbyId, lobby);
}

// ── Socket connections ───────────────────────────────────────────────────────

io.on("connection", (socket) => {
    console.log("nouvelle connexion lobby", socket.id);

    socket.on("lobby:join", ({ lobbyId, userId, username }) => {
        if (!lobbyId || !userId) return;
        socket.data = { lobbyId, userId, username };
        socket.join(`lobby:${lobbyId}`);
        let lobby = lobbies.get(lobbyId);
        if (!lobby) {
            lobby = {
                hostId: userId, quizId: null, status: "WAITING", timePerQuestion: 15, timeMode: "per_question",
                players: new Map(), resultViewers: new Set(), gameType: "quiz",
                unoOptions: { stackable: false, jumpIn: false, teamMode: "none", teamWinMode: "one" },
                tabooOptions: { turnDuration: 60, totalRounds: 3, trapWordCount: 5, maxAttempts: 10, trapDuration: 60 },
                teams: null,
            };
        }
        if (!lobby.hostId) lobby.hostId = userId;
        if (!lobby.resultViewers) lobby.resultViewers = new Set();
        if (!lobby.teams) lobby.teams = null;
        if (!lobby.tabooOptions) lobby.tabooOptions = { turnDuration: 60, totalRounds: 3, trapWordCount: 5, maxAttempts: 10, trapDuration: 60 };
        if (!lobby.orators) lobby.orators = { "0": null, "1": null };
        lobby.players.set(userId, { userId, username });
        lobbies.set(lobbyId, lobby);
        emitLobbyState(io, lobbyId, lobby);
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
    });

    socket.on("lobby:transferHost", ({ targetUserId }) => {
        const { lobbyId, userId } = socket.data || {};
        if (!lobbyId || !userId || !targetUserId) return;
        const lobby = lobbies.get(lobbyId);
        if (!lobby || lobby.hostId !== userId || targetUserId === userId) return;
        if (!lobby.players.has(targetUserId)) return;
        lobby.hostId = targetUserId;
        emitLobbyState(io, lobbyId, lobby);
    });

    socket.on("lobby:setTimeMode", ({ timeMode }) => {
        const { lobbyId, userId } = socket.data || {};
        if (!lobbyId || !userId) return;
        const lobby = lobbies.get(lobbyId);
        if (!lobby || lobby.hostId !== userId) return;
        if (!["per_question", "total", "none"].includes(timeMode)) return;
        lobby.timeMode = timeMode;
        emitLobbyState(io, lobbyId, lobby);
    });

    socket.on("lobby:setTimePerQuestion", ({ timePerQuestion }) => {
        const { lobbyId, userId } = socket.data || {};
        if (!lobbyId || !userId) return;
        const lobby = lobbies.get(lobbyId);
        if (!lobby || lobby.hostId !== userId) return;
        const t = Number(timePerQuestion);
        if (!Number.isFinite(t) || t < 5 || t > 3600) return;
        lobby.timePerQuestion = t;
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
        if (!["quiz", "uno", "taboo"].includes(gameType)) return;
        lobby.gameType = gameType;
        if (gameType === "uno" || gameType === "taboo") lobby.quizId = null;
        emitLobbyState(io, lobbyId, lobby);
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
        if (gameType === "uno") {
            const opts = lobby.unoOptions ?? { stackable: false, jumpIn: false, teamMode: "none", teamWinMode: "one" };
            unoServerSocket.emit("uno:configure", { lobbyId, options: opts, expectedCount: lobby.players.size, preAssignedTeams: lobby.teams ? Object.fromEntries(lobby.teams) : null });
            io.to(`lobby:${lobbyId}`).emit("game:start", { gameType: "uno", lobbyId });
        } else if (gameType === "taboo") {
            const opts = lobby.tabooOptions ?? { turnDuration: 60, totalRounds: 3, trapWordCount: 5, maxAttempts: 10, trapDuration: 60 };
            tabooServerSocket.emit("taboo:configure", {
                lobbyId,
                options: opts,
                teams: lobby.teams ? Object.fromEntries(lobby.teams) : null,
                orators: lobby.orators ?? { "0": null, "1": null },
                hostId: lobby.hostId,
            });
            io.to(`lobby:${lobbyId}`).emit("game:start", { gameType: "taboo", lobbyId });
        } else {
            io.to(`lobby:${lobbyId}`).emit("game:start", { gameType: "quiz", quizId: lobby.quizId, timeMode: lobby.timeMode, timePerQuestion: lobby.timePerQuestion });
        }
    });

    socket.on("chat:send", ({ text }) => {
        const { lobbyId, userId, username } = socket.data || {};
        if (!lobbyId || !userId) return;
        io.to(`lobby:${lobbyId}`).emit("chat:new", { userId, username, text: String(text || "").slice(0, 500), sentAt: Date.now() });
    });

    socket.on("disconnect", () => {
        const { lobbyId, userId } = socket.data || {};
        if (!lobbyId || !userId) return;
        removePlayerAndMaybeTransferHost({ io, lobbyId, userId });
    });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log("lobby-server listening on", PORT));
