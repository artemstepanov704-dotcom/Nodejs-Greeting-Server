import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import {
  AlertTriangle,
  Copy,
  MapPin,
  Mic,
  Radio,
  RadioTower,
  ShieldAlert,
  Users,
  Wifi,
} from 'lucide-react';
import L from 'leaflet';
import {
  Route,
  Switch,
  useLocation,
  Router as WouterRouter,
} from 'wouter';
import { type ReactNode } from 'react';

type ConnectionState = 'connecting' | 'connected' | 'disconnected';
type Position = { latitude: number; longitude: number; updatedAt?: number };
type WireMessage = Record<string, unknown> & { type?: string };
type PlaybackStream = {
  mediaSource: MediaSource;
  sourceBuffer?: SourceBuffer;
  audio: HTMLAudioElement;
  queue: ArrayBuffer[];
  mimeType: string;
};

const queryClient = new QueryClient();
const AUDIO_FRAME_LIMIT = 64 * 1024 - 64;
const DEFAULT_CENTER: L.LatLngExpression = [39.0997, -94.5786];

function MapView({ positions }: { positions: Record<string, Position> }) {
  const mapElement = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markersRef = useRef<L.LayerGroup | null>(null);
  const didCenterOnPosition = useRef(false);

  useEffect(() => {
    if (!mapElement.current || mapRef.current) return;
    const map = L.map(mapElement.current, {
      center: DEFAULT_CENTER,
      zoom: 4,
      zoomControl: false,
      scrollWheelZoom: true,
    });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);
    L.control.zoom({ position: 'bottomright' }).addTo(map);
    markersRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;
    const timer = window.setTimeout(() => map.invalidateSize(), 60);
    return () => {
      window.clearTimeout(timer);
      map.remove();
      mapRef.current = null;
      markersRef.current = null;
      didCenterOnPosition.current = false;
    };
  }, []);

  useEffect(() => {
    const group = markersRef.current;
    const map = mapRef.current;
    if (!group || !map) return;
    group.clearLayers();
    const entries = Object.entries(positions);
    entries.forEach(([id, position]) => {
      const self = id.startsWith('self:');
      const label = self ? 'YOU' : id.slice(0, 2).toUpperCase();
      const icon = L.divIcon({
        className: '',
        html: `<div class="driver-marker${self ? ' self' : ''}"><span>${label}</span></div>`,
        iconSize: [34, 34],
        iconAnchor: [17, 30],
      });
      L.marker([position.latitude, position.longitude], { icon })
        .bindTooltip(self ? 'Your position' : `Driver ${id.slice(0, 8)}`, {
          direction: 'top',
          offset: [0, -22],
        })
        .addTo(group);
      if (self && !didCenterOnPosition.current) {
        didCenterOnPosition.current = true;
        map.setView([position.latitude, position.longitude], 8, { animate: true });
      }
    });
    if (entries.length === 0) didCenterOnPosition.current = false;
  }, [positions]);

  return <div className="map-canvas" ref={mapElement} aria-label="Interactive live driver map" data-testid="map-live" />;
}

function Home() {
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [userId, setUserId] = useState('');
  const [roomId, setRoomId] = useState('');
  const [roomInput, setRoomInput] = useState('');
  const [members, setMembers] = useState<string[]>([]);
  const [positions, setPositions] = useState<Record<string, Position>>({});
  const [sharingLocation, setSharingLocation] = useState(false);
  const [locationError, setLocationError] = useState('');
  const [error, setError] = useState('');
  const [talking, setTalking] = useState(false);
  const [micError, setMicError] = useState('');
  const [codecError, setCodecError] = useState('');
  const [copied, setCopied] = useState(false);
  const [connectVersion, setConnectVersion] = useState(0);
  const socketRef = useRef<WebSocket | null>(null);
  const userRef = useRef('');
  const roomRef = useRef('');
  const sharingRef = useRef(false);
  const watchIdRef = useRef<number | null>(null);
  const locationTimerRef = useRef<number | null>(null);
  const pendingPositionRef = useRef<GeolocationPosition | null>(null);
  const lastLocationSentRef = useRef(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const pressRef = useRef(false);
  const playbackRef = useRef(new Map<string, PlaybackStream>());
  const audioTypeRef = useRef('');

  const supportsAudio = useMemo(() => {
    if (typeof MediaRecorder === 'undefined' || typeof MediaSource === 'undefined') return false;
    const candidates = [
      'audio/webm;codecs=opus',
      'audio/ogg;codecs=opus',
      'audio/mp4;codecs=mp4a.40.2',
    ];
    const supported = candidates.find((type) =>
      MediaRecorder.isTypeSupported(type) && MediaSource.isTypeSupported(type),
    );
    audioTypeRef.current = supported ?? '';
    return Boolean(supported);
  }, []);

  const cleanupPlayback = useCallback(() => {
    playbackRef.current.forEach((stream) => {
      stream.audio.pause();
      stream.audio.src = '';
      if (stream.audio.srcObject) stream.audio.srcObject = null;
      const url = stream.audio.dataset.objectUrl;
      if (url) URL.revokeObjectURL(url);
    });
    playbackRef.current.clear();
  }, []);

  const stopTalking = useCallback(() => {
    pressRef.current = false;
    setTalking(false);
    const recorder = recorderRef.current;
    recorderRef.current = null;
    if (recorder && recorder.state !== 'inactive') {
      try { recorder.stop(); } catch { /* The stream may have ended between events. */ }
    }
    micStreamRef.current?.getTracks().forEach((track) => track.stop());
    micStreamRef.current = null;
  }, []);

  const stopLocationWatch = useCallback(() => {
    if (watchIdRef.current !== null && navigator.geolocation) {
      navigator.geolocation.clearWatch(watchIdRef.current);
    }
    watchIdRef.current = null;
    if (locationTimerRef.current !== null) window.clearTimeout(locationTimerRef.current);
    locationTimerRef.current = null;
    pendingPositionRef.current = null;
    setPositions((current) => {
      const next = { ...current };
      delete next[`self:${userRef.current}`];
      return next;
    });
  }, []);

  const sendLocation = useCallback((position: GeolocationPosition) => {
    const send = () => {
      const socket = socketRef.current;
      const currentRoom = roomRef.current;
      if (!sharingRef.current || !currentRoom || !socket || socket.readyState !== WebSocket.OPEN) return;
      const latitude = position.coords.latitude;
      const longitude = position.coords.longitude;
      socket.send(JSON.stringify({ type: 'location', latitude, longitude }));
      const now = Date.now();
      lastLocationSentRef.current = now;
      setPositions((current) => ({
        ...current,
        [`self:${userRef.current}`]: { latitude, longitude, updatedAt: now },
      }));
    };
    const wait = 1000 - (Date.now() - lastLocationSentRef.current);
    if (wait <= 0) {
      send();
    } else {
      pendingPositionRef.current = position;
      if (locationTimerRef.current === null) {
        locationTimerRef.current = window.setTimeout(() => {
          locationTimerRef.current = null;
          const pending = pendingPositionRef.current;
          pendingPositionRef.current = null;
          if (pending) sendLocation(pending);
        }, wait);
      }
    }
  }, []);

  const startLocationWatch = useCallback(() => {
    if (!sharingRef.current || !roomRef.current || !navigator.geolocation || watchIdRef.current !== null) return;
    setLocationError('');
    watchIdRef.current = navigator.geolocation.watchPosition(
      sendLocation,
      (reason) => {
        setLocationError(
          reason.code === reason.PERMISSION_DENIED
            ? 'Location permission was denied. Allow it in browser settings to share your position.'
            : 'Your position is not available right now. Location sharing will keep trying.',
        );
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 },
    );
  }, [sendLocation]);

  const stopEverything = useCallback(() => {
    stopTalking();
    stopLocationWatch();
    cleanupPlayback();
  }, [cleanupPlayback, stopLocationWatch, stopTalking]);

  const onWireMessage = useCallback((message: WireMessage) => {
    switch (message.type) {
      case 'connected': {
        const id = String(message.userId ?? '');
        userRef.current = id;
        setUserId(id);
        setConnection('connected');
        setError('');
        break;
      }
      case 'room_created': {
        const id = String(message.roomId ?? '');
        const self = String(message.userId ?? userRef.current);
        roomRef.current = id;
        userRef.current = self;
        setUserId(self);
        setRoomId(id);
        setRoomInput(id);
        setMembers(self ? [self] : []);
        setPositions({});
        setError('');
        if (sharingRef.current) startLocationWatch();
        break;
      }
      case 'room_joined': {
        const id = String(message.roomId ?? '');
        const self = String(message.userId ?? userRef.current);
        const joinedMembers = Array.isArray(message.members)
          ? message.members.filter((member): member is string => typeof member === 'string')
          : [];
        roomRef.current = id;
        userRef.current = self;
        setUserId(self);
        setRoomId(id);
        setRoomInput(id);
        setMembers([...new Set([...joinedMembers, self].filter(Boolean))]);
        setPositions({});
        setError('');
        if (sharingRef.current) startLocationWatch();
        break;
      }
      case 'room_left':
        roomRef.current = '';
        setRoomId('');
        setMembers([]);
        setPositions({});
        stopLocationWatch();
        stopTalking();
        break;
      case 'member_joined': {
        const id = String(message.userId ?? '');
        if (id) setMembers((current) => current.includes(id) ? current : [...current, id]);
        break;
      }
      case 'member_left': {
        const id = String(message.userId ?? '');
        setMembers((current) => current.filter((member) => member !== id));
        setPositions((current) => {
          const next = { ...current };
          delete next[id];
          return next;
        });
        break;
      }
      case 'location': {
        const id = String(message.userId ?? '');
        const latitude = Number(message.latitude);
        const longitude = Number(message.longitude);
        if (!id || !Number.isFinite(latitude) || !Number.isFinite(longitude)) break;
        setPositions((current) => ({
          ...current,
          [id]: {
            latitude,
            longitude,
            updatedAt: Number(message.updatedAt) || Date.now(),
          },
        }));
        break;
      }
      case 'error':
        setError(String(message.message ?? 'The radio server returned an error.'));
        break;
    }
  }, [startLocationWatch, stopLocationWatch, stopTalking]);

  useEffect(() => {
    setConnection('connecting');
    setError('');
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${protocol}//${window.location.host}/ws`);
    socket.binaryType = 'arraybuffer';
    socketRef.current = socket;
    socket.onopen = () => setConnection('connected');
    socket.onmessage = (event) => {
      if (typeof event.data === 'string') {
        try {
          onWireMessage(JSON.parse(event.data) as WireMessage);
        } catch {
          setError('Received an unreadable message from the radio server.');
        }
      } else {
        void receiveAudio(event.data);
      }
    };
    socket.onerror = () => {
      setError('Radio connection interrupted. Check your network and reconnect.');
    };
    socket.onclose = () => {
      socketRef.current = null;
      setConnection('disconnected');
      roomRef.current = '';
      setRoomId('');
      setMembers([]);
      setPositions({});
      sharingRef.current = false;
      setSharingLocation(false);
      stopEverything();
      setError((current) => current || 'Connection closed. Reconnect to start or rejoin a room.');
    };

    async function receiveAudio(raw: ArrayBuffer | Blob) {
      try {
        const bytes = raw instanceof Blob ? new Uint8Array(await raw.arrayBuffer()) : new Uint8Array(raw);
        const delimiter = bytes.indexOf(10);
        if (delimiter <= 0 || delimiter >= bytes.length - 1) return;
        const sender = new TextDecoder().decode(bytes.subarray(0, delimiter));
        if (!sender || sender === userRef.current) return;
        const mimeDelimiter = bytes.indexOf(10, delimiter + 1);
        if (mimeDelimiter < 0 || mimeDelimiter === delimiter + 1) return;
        const mimeType = new TextDecoder().decode(bytes.subarray(delimiter + 1, mimeDelimiter));
        if (typeof MediaSource === 'undefined' || !MediaSource.isTypeSupported(mimeType)) {
          setCodecError(`This browser cannot play ${mimeType} radio audio.`);
          return;
        }
        const payload = bytes.slice(mimeDelimiter + 1);
        if (!payload.length) return;
        let player = playbackRef.current.get(sender);
        if (!player) {
          if (typeof MediaSource === 'undefined') {
            setCodecError('This browser cannot play the radio audio format.');
            return;
          }
          const mediaSource = new MediaSource();
          const audio = new Audio();
          audio.autoplay = true;
          const url = URL.createObjectURL(mediaSource);
          audio.dataset.objectUrl = url;
          audio.src = url;
          player = { mediaSource, audio, queue: [], mimeType };
          playbackRef.current.set(sender, player);
          mediaSource.addEventListener('sourceopen', () => {
            const active = playbackRef.current.get(sender);
            if (!active || active.mediaSource.readyState !== 'open') return;
            try {
              active.sourceBuffer = active.mediaSource.addSourceBuffer(active.mimeType);
              active.sourceBuffer.mode = 'sequence';
              active.sourceBuffer.addEventListener('updateend', () => flushPlayback(sender));
              flushPlayback(sender);
            } catch {
              setCodecError('Unable to decode incoming radio audio in this browser.');
            }
          }, { once: true });
        }
        player.queue.push(payload.buffer as ArrayBuffer);
        flushPlayback(sender);
        void player.audio.play().catch(() => {
          setCodecError('Tap or click once to enable incoming radio audio playback.');
        });
      } catch {
        setCodecError('Incoming audio could not be decoded by this browser.');
      }
    }
    function flushPlayback(sender: string) {
      const player = playbackRef.current.get(sender);
      if (!player?.sourceBuffer || player.sourceBuffer.updating || !player.queue.length) return;
      if (player.mediaSource.readyState !== 'open') return;
      try {
        player.sourceBuffer.appendBuffer(player.queue.shift()!);
      } catch {
        player.queue = [];
        setCodecError('Radio audio format is unsupported or the connection dropped a frame.');
      }
    }

    return () => {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      if (socket.readyState < WebSocket.CLOSING) socket.close();
      if (socketRef.current === socket) socketRef.current = null;
      stopEverything();
    };
  }, [connectVersion, onWireMessage, stopEverything]);

  useEffect(() => {
    sharingRef.current = sharingLocation;
    if (sharingLocation) startLocationWatch();
    else stopLocationWatch();
  }, [sharingLocation, startLocationWatch, stopLocationWatch]);

  useEffect(() => {
    const handleBlur = () => stopTalking();
    const handleVisibility = () => {
      if (document.visibilityState !== 'visible') stopTalking();
    };
    window.addEventListener('blur', handleBlur);
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      window.removeEventListener('blur', handleBlur);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [stopTalking]);

  const createRoom = () => {
    setError('');
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'create_room' }));
  };
  const joinRoom = () => {
    const code = roomInput.trim();
    if (!code) {
      setError('Enter a room code before joining.');
      return;
    }
    setError('');
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'join_room', roomId: code }));
    }
  };
  const leaveRoom = () => {
    stopEverything();
    setSharingLocation(false);
    sharingRef.current = false;
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'leave_room' }));
  };
  const toggleLocation = (checked: boolean) => {
    if (checked && !roomRef.current) {
      setLocationError('Join a room before sharing your position.');
      return;
    }
    setLocationError('');
    sharingRef.current = checked;
    setSharingLocation(checked);
  };

  const startTalking = async () => {
    if (pressRef.current) return;
    if (!roomRef.current || connection !== 'connected' || socketRef.current?.readyState !== WebSocket.OPEN) {
      setMicError('Join a connected room before transmitting.');
      return;
    }
    if (!supportsAudio || !audioTypeRef.current) {
      setMicError('This browser does not support a compatible radio audio codec.');
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setMicError('Microphone capture is not supported in this browser.');
      return;
    }
    pressRef.current = true;
    setMicError('');
    setCodecError('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!pressRef.current || socketRef.current?.readyState !== WebSocket.OPEN || !roomRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      micStreamRef.current = stream;
      const recorder = new MediaRecorder(stream, { mimeType: audioTypeRef.current });
      recorderRef.current = recorder;
      recorder.ondataavailable = async (event) => {
        if (!event.data.size) return;
        const socket = socketRef.current;
        if (!pressRef.current || socket?.readyState !== WebSocket.OPEN || !roomRef.current) return;
        if (event.data.size > AUDIO_FRAME_LIMIT) {
          setMicError('Audio chunk exceeded the radio frame limit and was not sent.');
          return;
        }
        try {
          const audioBytes = new Uint8Array(await event.data.arrayBuffer());
          const mimeBytes = new TextEncoder().encode(`${recorder.mimeType}\n`);
          const frame = new Uint8Array(mimeBytes.length + audioBytes.length);
          frame.set(mimeBytes);
          frame.set(audioBytes, mimeBytes.length);
          socket.send(frame);
        } catch {
          setMicError('Could not send microphone audio. Check the connection.');
        }
      };
      recorder.onerror = () => setMicError('Microphone recording stopped unexpectedly.');
      recorder.start(200);
      setTalking(true);
    } catch (reason) {
      pressRef.current = false;
      const permissionDenied = reason instanceof DOMException &&
        (reason.name === 'NotAllowedError' || reason.name === 'PermissionDeniedError');
      setMicError(permissionDenied
        ? 'Microphone access was denied. Allow microphone access in your browser settings.'
        : 'Microphone could not be started. Check that it is connected and available.');
      stopTalking();
    }
  };

  const copyRoom = async () => {
    if (!roomId) return;
    try {
      await navigator.clipboard.writeText(roomId);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setError('Clipboard access is unavailable. Select and copy the room code instead.');
    }
  };

  const visiblePositions = useMemo(() => {
    const current = { ...positions };
    const own = current[`self:${userId}`];
    if (own) current[`self:${userId}`] = own;
    return current;
  }, [positions, userId]);
  const connectionText = connection === 'connected'
    ? 'Radio connected'
    : connection === 'connecting' ? 'Connecting to radio' : 'Radio disconnected';
  const joined = Boolean(roomId);

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark"><Radio size={22} strokeWidth={2.2} /></div>
          <div>
            <div className="brand-title">Road Radio</div>
            <div className="brand-sub">A shared channel for the miles ahead</div>
          </div>
        </div>
        <div className={`connection ${connection}`} data-testid="status-connection">
          <span className="connection-dot" />
          {connectionText}
        </div>
      </header>

      <div className="dashboard">
        <section className="map-panel" aria-label="Driver locations">
          <div className="map-head">
            <span className="map-live" />
            <strong>Live road view</strong>
            <span>{Object.keys(visiblePositions).length} positions</span>
          </div>
          <MapView positions={visiblePositions} />
          {Object.keys(visiblePositions).length === 0 && (
            <div className="map-empty">
              <div className="empty-symbol"><MapPin size={18} /></div>
              <strong>No live positions yet</strong>
              <p>Drivers appear here only after they join this room and choose to share location.</p>
            </div>
          )}
        </section>

        <aside className="side-panel">
          <section className="panel-card room-card">
            <div className="card-kicker"><RadioTower size={14} /> Channel setup</div>
            <h1 className="card-title">{joined ? 'You’re on the channel' : 'Find your crew'}</h1>
            <p className="card-copy">{joined ? 'Share this private room code with the drivers you want to reach.' : 'Create a private room or enter a code from another driver.'}</p>
            <div className="room-label">
              <span>Room code</span>
              <span className={`room-state ${joined ? 'active' : ''}`}>{joined ? 'Live channel' : 'Not joined'}</span>
            </div>
            {joined ? (
              <div className="room-code-row">
                <input aria-label="Room code" className="room-code" value={roomId} readOnly data-testid="input-room-code" />
                <button className="copy-button" type="button" onClick={copyRoom} aria-label="Copy room code" data-testid="button-copy-room">
                  <Copy size={16} />
                </button>
              </div>
            ) : (
              <input
                aria-label="Enter room code"
                className="room-code"
                value={roomInput}
                onChange={(event) => setRoomInput(event.target.value)}
                placeholder="Paste a 32-character room code"
                data-testid="input-join-room"
              />
            )}
            <div className="room-actions">
              {joined ? (
                <button type="button" className="action-button" onClick={leaveRoom} data-testid="button-leave-room">
                  Leave room
                </button>
              ) : (
                <>
                  <button type="button" className="action-button primary" onClick={createRoom} disabled={connection !== 'connected'} data-testid="button-create-room">
                    Create room
                  </button>
                  <button type="button" className="action-button" onClick={joinRoom} disabled={connection !== 'connected'} data-testid="button-join-room">
                    Join room
                  </button>
                </>
              )}
            </div>
            {joined && copied && <div className="card-copy" role="status" data-testid="status-copy">Room code copied.</div>}
            <div className="identity-row">
              <span>Your radio ID</span>
              <span className="identity-value" title={userId} data-testid="text-user-id">{userId || 'Waiting for connection'}</span>
            </div>
            {connection === 'disconnected' && (
              <button type="button" className="action-button" style={{ width: '100%', marginTop: 10 }} onClick={() => setConnectVersion((value) => value + 1)} data-testid="button-reconnect">
                <Wifi size={14} /> Reconnect
              </button>
            )}
          </section>

          <section className="panel-card roster-card">
            <div className="roster-head">
              <h2>On this channel</h2>
              <span className="count-pill" data-testid="text-member-count">{members.length}</span>
            </div>
            {members.length > 0 ? (
              <div className="member-list">
                {members.map((member) => {
                  const isSelf = member === userId;
                  return (
                    <div className={`member-row${isSelf ? ' self' : ''}`} key={member} data-testid={`member-${member}`}>
                      <span className="member-initial">{isSelf ? 'ME' : member.slice(0, 2).toUpperCase()}</span>
                      <span className="member-name">{member}</span>
                      {isSelf && <span className="member-you">You</span>}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="roster-empty"><Users size={18} style={{ marginBottom: 7 }} /><br />Join a room to see the drivers sharing your channel.</div>
            )}
          </section>

          <section className="panel-card location-card">
            <label className="location-toggle">
              <input
                className="toggle-box"
                type="checkbox"
                checked={sharingLocation}
                disabled={!joined || connection !== 'connected'}
                onChange={(event) => toggleLocation(event.target.checked)}
                data-testid="input-location-sharing"
              />
              <span>
                <span className="location-label">Share my live location</span>
                <span className="location-note">Your position is sent only while opted in and connected to this room.</span>
              </span>
            </label>
            {locationError && <div className="location-warning" role="status" data-testid="status-location">{locationError}</div>}
          </section>

          <section className="talk-card">
            <p className="talk-hint">{talking ? 'Transmitting to channel' : joined ? 'Hold to talk' : 'Join a channel to talk'}</p>
            <button
              type="button"
              className={`ptt-button${talking ? ' talking' : ''}`}
              disabled={!joined || connection !== 'connected' || !supportsAudio}
              onPointerDown={(event) => { event.preventDefault(); void startTalking(); }}
              onPointerUp={stopTalking}
              onPointerCancel={stopTalking}
              onPointerLeave={stopTalking}
              onKeyDown={(event) => {
                if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) {
                  event.preventDefault();
                  void startTalking();
                }
              }}
              onKeyUp={(event) => {
                if (event.key === ' ' || event.key === 'Enter') stopTalking();
              }}
              aria-label="Hold to transmit voice"
              aria-pressed={talking}
              data-testid="button-push-to-talk"
            >
              <Mic size={28} strokeWidth={2} />
              <span>{talking ? 'ON AIR' : 'PRESS & HOLD'}</span>
            </button>
            <p className="ptt-caption">{supportsAudio ? 'Release to stop transmitting' : 'Voice codec is not supported in this browser'}</p>
          </section>
          {(error || micError || codecError) && (
            <div className="alert" role="alert" data-testid="status-alert">
              <AlertTriangle size={14} style={{ verticalAlign: 'middle', marginRight: 6 }} />
              {error || micError || codecError}
            </div>
          )}
        </aside>
      </div>

      <footer className="safety"><ShieldAlert size={15} /> Use while parked. Do not interact while driving.</footer>
    </main>
  );
}

function Router() {
  return (
    <RoutedErrorBoundary>
      <Switch>
        <Route path="/" component={Home} />
        <Route component={NotFound} />
      </Switch>
    </RoutedErrorBoundary>
  );
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
