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

const lobbies = new Map();

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
        // teams : { userId -> 0|1 } sérialisé en objet
        teams: lobby.teams ? Object.fromEntries(lobby.teams) : null,
    });
}

function removePlayerAndMaybeTransferHost({ io, lobbyId, userId }) {
    const lobby = lobbies.get(lobbyId);
    if (!lobby) return;

    if (lobby.resultViewers?.has(userId)) {
        lobby.resultViewers.delete(userId);
        return;
    }

    lobby.players.delete(userId);

    // Retirer des équipes si présent
    if (lobby.teams) lobby.teams.delete(userId);

    if (lobby.players.size === 0) {
        lobbies.delete(lobbyId);
        return;
    }

    if (lobby.hostId === userId) {
        lobby.hostId = Array.from(lobby.players.values())[0].userId;
    }

    emitLobbyState(io, lobbyId, lobby);
}

io.on("connection", (socket) => {

    socket.on("lobby:join", ({ lobbyId, userId, username }) => {
        if (!lobbyId || !userId) return;
        socket.data = { lobbyId, userId, username };
        socket.join(`lobby:${lobbyId}`);

        let lobby = lobbies.get(lobbyId);
        if (!lobby) {
            lobby = {
                hostId: userId,
                quizId: null,
                status: "WAITING",
                timePerQuestion: 15,
                timeMode: "per_question",
                players: new Map(),
                resultViewers: new Set(),
                gameType: "quiz",
                unoOptions: { stackable: false, jumpIn: false, teamMode: "none", teamWinMode: "one" },
                teams: null, // Map<userId, 0|1> — null si pas en mode 2v2
            };
        }
        if (!lobby.hostId) lobby.hostId = userId;
        if (!lobby.resultViewers) lobby.resultViewers = new Set();
        if (!lobby.teams) lobby.teams = null;

        lobby.players.set(userId, { userId, username });
        lobbies.set(lobbyId, lobby);

        emitLobbyState(io, lobbyId, lobby);
    });

    socket.on("lobby:leave", () => {
        const { lobbyId, userId } = socket.data || {};
        if (!lobbyId || !userId) return;
        removePlayerAndMaybeTransferHost({ io, lobbyId, userId });
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
        if (!["quiz", "uno"].includes(gameType)) return;
        lobby.gameType = gameType;
        if (gameType === "uno") lobby.quizId = null;
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
            // Réinitialiser les équipes quand on change de mode
            lobby.teams = teamMode === "2v2" ? new Map() : null;
        }
        if (teamWinMode === "one" || teamWinMode === "both") lobby.unoOptions.teamWinMode = teamWinMode;
        emitLobbyState(io, lobbyId, lobby);
    });

    // ── Choix d'équipe par un joueur ──────────────────────────────────────────
    socket.on("lobby:setTeam", ({ team }) => {
        const { lobbyId, userId } = socket.data || {};
        if (!lobbyId || !userId) return;
        const lobby = lobbies.get(lobbyId);
        if (!lobby) return;
        if (lobby.unoOptions?.teamMode !== "2v2") return;
        if (team !== 0 && team !== 1) return;

        // Vérifier que l'équipe choisie n'a pas déjà 2 joueurs
        if (!lobby.teams) lobby.teams = new Map();
        const teamCount = Array.from(lobby.teams.values()).filter(t => t === team).length;
        // Si le joueur est déjà dans cette équipe, on le retire (toggle)
        if (lobby.teams.get(userId) === team) {
            lobby.teams.delete(userId);
        } else if (teamCount >= 2) {
            // Équipe pleine, refuser
            socket.emit("lobby:teamFull", { team });
            return;
        } else {
            lobby.teams.set(userId, team);
        }

        emitLobbyState(io, lobbyId, lobby);
    });

    // ── Mélange aléatoire des équipes (host uniquement) ───────────────────────
    socket.on("lobby:shuffleTeams", () => {
        const { lobbyId, userId } = socket.data || {};
        if (!lobbyId || !userId) return;
        const lobby = lobbies.get(lobbyId);
        if (!lobby || lobby.hostId !== userId) return;
        if (lobby.unoOptions?.teamMode !== "2v2") return;

        const players = Array.from(lobby.players.keys());
        const shuffled = players.sort(() => Math.random() - 0.5);
        lobby.teams = new Map();
        shuffled.forEach((id, i) => lobby.teams.set(id, i < 2 ? 0 : 1));

        emitLobbyState(io, lobbyId, lobby);
    });

    socket.on("lobby:start", () => {
        const { lobbyId, userId } = socket.data || {};
        if (!lobbyId || !userId) return;
        const lobby = lobbies.get(lobbyId);
        if (!lobby || lobby.hostId !== userId) return;

        const gameType = lobby.gameType ?? "quiz";
        if (gameType === "quiz" && !lobby.quizId) return;

        // Validation 2v2 : 4 joueurs avec 2 par équipe
        if (gameType === "uno" && lobby.unoOptions?.teamMode === "2v2") {
            if (lobby.players.size !== 4) return;
            if (!lobby.teams || lobby.teams.size !== 4) return;
            const team0 = Array.from(lobby.teams.values()).filter(t => t === 0).length;
            const team1 = Array.from(lobby.teams.values()).filter(t => t === 1).length;
            if (team0 !== 2 || team1 !== 2) return;
        }

        lobby.status = "PLAYING";
        emitLobbyState(io, lobbyId, lobby);

        if (gameType === "uno") {
            const opts = lobby.unoOptions ?? { stackable: false, jumpIn: false, teamMode: "none", teamWinMode: "one" };

            // Passer les équipes pré-assignées au serveur UNO
            const preAssignedTeams = lobby.teams
                ? Object.fromEntries(lobby.teams)
                : null;

            unoServerSocket.emit("uno:configure", {
                lobbyId,
                options: opts,
                expectedCount: lobby.players.size,
                preAssignedTeams,
            });
            io.to(`lobby:${lobbyId}`).emit("game:start", {
                gameType: "uno",
                lobbyId,
            });
        } else {
            io.to(`lobby:${lobbyId}`).emit("game:start", {
                gameType: "quiz",
                quizId: lobby.quizId,
                timeMode: lobby.timeMode,
                timePerQuestion: lobby.timePerQuestion,
            });
        }
    });

    socket.on("chat:send", ({ text }) => {
        const { lobbyId, userId, username } = socket.data || {};
        if (!lobbyId || !userId) return;
        io.to(`lobby:${lobbyId}`).emit("chat:new", {
            userId, username,
            text: String(text || "").slice(0, 500),
            sentAt: Date.now(),
        });
    });

    socket.on("disconnect", () => {
        const { lobbyId, userId } = socket.data || {};
        if (!lobbyId || !userId) return;
        removePlayerAndMaybeTransferHost({ io, lobbyId, userId });
    });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log("lobby-server listening on", PORT));
