import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";

const PORT = Number(process.env.PORT ?? 3000);
const WS_PATH = "/ws";
const MAX_AUDIO_FRAME_BYTES = 64 * 1024;
const MAX_BUFFERED_BYTES = 1024 * 1024;
const MAX_ROOM_MEMBERS = 20;
const MAX_ROOMS = 1_000;
const CONTROL_MESSAGES_PER_SECOND = 20;
const AUDIO_FRAMES_PER_SECOND = 80;

const rooms = new Map();
const clientState = new Map();
const allowedOrigins = new Set(
  (process.env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
);

const httpServer = createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Walkie-talkie server is running.\n");
    return;
  }

  response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  response.end("Not found\n");
});

const webSocketServer = new WebSocketServer({
  noServer: true,
  maxPayload: MAX_AUDIO_FRAME_BYTES,
  perMessageDeflate: false,
});

httpServer.on("upgrade", (request, socket, head) => {
  let requestUrl;
  try {
    requestUrl = new URL(request.url ?? "/", `http://${request.headers.host}`);
  } catch {
    socket.destroy();
    return;
  }

  if (requestUrl.pathname !== WS_PATH) {
    socket.destroy();
    return;
  }

  const origin = request.headers.origin;
  if (origin && allowedOrigins.size > 0 && !allowedOrigins.has(origin)) {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }

  webSocketServer.handleUpgrade(request, socket, head, (client) => {
    webSocketServer.emit("connection", client, request);
  });
});

function sendJson(client, message) {
  if (client.readyState === WebSocket.OPEN) {
    client.send(JSON.stringify(message));
  }
}

function sendError(client, message) {
  sendJson(client, { type: "error", message });
}

function broadcastJson(roomId, message, exceptClient) {
  const room = rooms.get(roomId);
  if (!room) return;

  for (const client of room) {
    if (client === exceptClient || client.readyState !== WebSocket.OPEN) continue;

    if (client.bufferedAmount > MAX_BUFFERED_BYTES) {
      client.close(1013, "Slow connection");
      continue;
    }

    sendJson(client, message);
  }
}

function leaveRoom(client) {
  const state = clientState.get(client);
  if (!state?.roomId) return;

  const roomId = state.roomId;
  const room = rooms.get(roomId);
  state.roomId = null;

  if (!room) return;
  room.delete(client);
  broadcastJson(roomId, { type: "member_left", userId: state.userId });

  if (room.size === 0) {
    rooms.delete(roomId);
  }
}

function joinRoom(client, roomId) {
  const state = clientState.get(client);
  const room = rooms.get(roomId);

  if (!room) {
    sendError(client, "That room does not exist or has already closed.");
    return;
  }
  if (state.roomId) {
    sendError(client, "Leave your current room before joining another.");
    return;
  }
  if (room.size >= MAX_ROOM_MEMBERS) {
    sendError(client, "That room is full.");
    return;
  }

  const members = [...room]
    .map((member) => clientState.get(member)?.userId)
    .filter(Boolean);
  room.add(client);
  state.roomId = roomId;

  sendJson(client, { type: "room_joined", roomId, userId: state.userId, members });
  broadcastJson(
    roomId,
    { type: "member_joined", userId: state.userId },
    client,
  );
}

function allowControlMessage(client) {
  const state = clientState.get(client);
  const now = Date.now();

  if (now - state.controlWindowStartedAt >= 1_000) {
    state.controlWindowStartedAt = now;
    state.controlMessages = 0;
  }

  state.controlMessages += 1;
  return state.controlMessages <= CONTROL_MESSAGES_PER_SECOND;
}

function allowAudioFrame(client) {
  const state = clientState.get(client);
  const now = Date.now();

  if (now - state.audioWindowStartedAt >= 1_000) {
    state.audioWindowStartedAt = now;
    state.audioFrames = 0;
  }

  state.audioFrames += 1;
  return state.audioFrames <= AUDIO_FRAMES_PER_SECOND;
}

function handleControlMessage(client, rawMessage) {
  const state = clientState.get(client);
  if (!allowControlMessage(client)) {
    sendError(client, "Too many messages. Slow down and try again.");
    return;
  }

  let message;
  try {
    message = JSON.parse(rawMessage.toString());
  } catch {
    sendError(client, "Send a valid JSON control message.");
    return;
  }

  if (!message || typeof message !== "object" || Array.isArray(message)) {
    sendError(client, "Control messages must be JSON objects.");
    return;
  }

  switch (message.type) {
    case "create_room": {
      if (state.roomId) {
        sendError(client, "Leave your current room before creating another.");
        return;
      }
      if (rooms.size >= MAX_ROOMS) {
        sendError(client, "The server is at its room limit. Try again later.");
        return;
      }

      const roomId = randomBytes(24).toString("base64url");
      rooms.set(roomId, new Set([client]));
      state.roomId = roomId;
      sendJson(client, {
        type: "room_created",
        roomId,
        userId: state.userId,
      });
      return;
    }

    case "join_room": {
      if (
        typeof message.roomId !== "string" ||
        !/^[A-Za-z0-9_-]{32}$/.test(message.roomId)
      ) {
        sendError(client, "roomId must be a valid room code.");
        return;
      }
      joinRoom(client, message.roomId);
      return;
    }

    case "leave_room":
      leaveRoom(client);
      sendJson(client, { type: "room_left", userId: state.userId });
      return;

    case "location": {
      if (!state.roomId) {
        sendError(client, "Join a room before sharing your location.");
        return;
      }
      const { latitude, longitude } = message;
      if (
        typeof latitude !== "number" ||
        typeof longitude !== "number" ||
        !Number.isFinite(latitude) ||
        !Number.isFinite(longitude) ||
        latitude < -90 ||
        latitude > 90 ||
        longitude < -180 ||
        longitude > 180
      ) {
        sendError(client, "Provide valid latitude and longitude values.");
        return;
      }
      if (Date.now() - state.lastLocationAt < 1_000) {
        sendError(client, "Location updates are limited to one per second.");
        return;
      }

      state.lastLocationAt = Date.now();
      broadcastJson(
        state.roomId,
        {
          type: "location",
          userId: state.userId,
          latitude,
          longitude,
          updatedAt: state.lastLocationAt,
        },
        client,
      );
      return;
    }

    default:
      sendError(
        client,
        "Unknown message type. Use create_room, join_room, leave_room, or location.",
      );
  }
}

webSocketServer.on("connection", (client) => {
  clientState.set(client, {
    userId: randomUUID(),
    roomId: null,
    lastLocationAt: 0,
    controlWindowStartedAt: Date.now(),
    controlMessages: 0,
    audioWindowStartedAt: Date.now(),
    audioFrames: 0,
  });

  client.on("message", (data, isBinary) => {
    const state = clientState.get(client);
    if (!state) return;

    if (!isBinary) {
      handleControlMessage(client, data);
      return;
    }

    if (!state.roomId) {
      sendError(client, "Join a room before sending audio.");
      return;
    }
    if (!allowAudioFrame(client)) {
      sendError(client, "Audio frame limit reached. Slow down and try again.");
      return;
    }
    if (data.length > MAX_AUDIO_FRAME_BYTES) {
      sendError(client, "Audio frame is too large.");
      return;
    }

    const room = rooms.get(state.roomId);
    if (!room) return;

    // Binary frame format: UTF-8 userId, newline, then the original audio bytes.
    const audioFrame = Buffer.concat([Buffer.from(`${state.userId}\n`), data]);
    for (const recipient of room) {
      if (recipient === client || recipient.readyState !== WebSocket.OPEN) continue;

      if (recipient.bufferedAmount > MAX_BUFFERED_BYTES) {
        recipient.close(1013, "Slow connection");
        continue;
      }

      recipient.send(audioFrame, { binary: true });
    }
  });

  client.on("close", () => {
    leaveRoom(client);
    clientState.delete(client);
  });

  client.on("error", () => {
    leaveRoom(client);
    clientState.delete(client);
  });

  sendJson(client, {
    type: "connected",
    userId: clientState.get(client).userId,
    websocketPath: WS_PATH,
    audioFrameFormat: "UTF-8 userId, newline, then audio bytes",
  });
});

httpServer.listen(PORT, "0.0.0.0", () => {
  console.info(`Walkie-talkie server listening on port ${PORT}`);
});
