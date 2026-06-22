import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { useKeepAwake } from 'expo-keep-awake';
import {
  useAudioStream,
  setAudioModeAsync,
  requestRecordingPermissionsAsync,
} from 'expo-audio';
import { DEFAULT_SERVER_URL } from './src/config';
import { arrayBufferToBase64 } from './src/base64';

// Gemini Live Translate expects raw 16-bit PCM, 16 kHz, mono.
const SAMPLE_RATE = 16000;

function toWsUrl(httpUrl) {
  return httpUrl.replace(/^http/, 'ws').replace(/\/+$/, '');
}

export default function App() {
  useKeepAwake(); // don't let the screen sleep while preaching

  const [screen, setScreen] = useState('setup'); // 'setup' | 'live'
  const [serverUrl, setServerUrl] = useState(DEFAULT_SERVER_URL);
  const [title, setTitle] = useState('');
  const [password, setPassword] = useState('');
  const [creating, setCreating] = useState(false);

  const [session, setSession] = useState(null); // { sessionId, joinUrl, title }
  const [speaking, setSpeaking] = useState(false);
  const [connected, setConnected] = useState(false);
  const [stats, setStats] = useState({ total: 0, listeners: {} });
  const [transcript, setTranscript] = useState('');

  const wsRef = useRef(null);
  const wsSeqRef = useRef(0);
  const speakingRef = useRef(false);

  // One audio stream, created once. onBuffer reads the live WebSocket from a
  // ref so we always send to the current connection.
  const { stream } = useAudioStream({
    sampleRate: SAMPLE_RATE,
    channels: 1,
    encoding: 'int16',
    onBuffer: (buf) => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'audio', data: arrayBufferToBase64(buf.data) }));
      }
    },
  });

  const createSession = useCallback(async () => {
    const base = serverUrl.trim().replace(/\/+$/, '');
    if (!base) {
      Alert.alert('Server address required', 'Enter the address of your Glotta server.');
      return;
    }
    setCreating(true);
    try {
      const res = await fetch(`${base}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: title.trim(), password }),
      });
      if (res.status === 401) throw new Error('Incorrect speaker password');
      if (!res.ok) throw new Error(`Server responded ${res.status}`);
      const data = await res.json();
      setSession(data);
      setScreen('live');
    } catch (err) {
      Alert.alert(
        'Could not reach the server',
        `${err.message}\n\nCheck that the server is running and that this phone is on the same network. Address tried:\n${base}`,
      );
    } finally {
      setCreating(false);
    }
  }, [serverUrl, title, password]);

  const reviveSession = useCallback(async () => {
    if (!session) return false;
    const base = serverUrl.trim().replace(/\/+$/, '');
    try {
      const res = await fetch(`${base}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: session.title || title.trim(),
          password,
          sessionId: session.sessionId,
        }),
      });
      if (!res.ok) return false;
      const data = await res.json();
      setSession(data);
      return true;
    } catch {
      return false;
    }
  }, [session, serverUrl, title, password]);

  const connectWs = useCallback(() => {
    if (!session) return;
    const existing = wsRef.current;
    if (existing && (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)) return;
    const url = `${toWsUrl(serverUrl.trim())}/ws/speaker/${session.sessionId}`;
    const ws = new WebSocket(url);
    const seq = ++wsSeqRef.current;
    wsRef.current = ws;
    ws.onopen = () => {
      if (wsRef.current !== ws || wsSeqRef.current !== seq) return;
      setConnected(true);
    };
    ws.onmessage = (ev) => {
      if (wsRef.current !== ws || wsSeqRef.current !== seq) return;
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.type === 'stats') {
        setStats({ total: msg.total, listeners: msg.listeners });
      } else if (msg.type === 'transcript' && msg.kind === 'input') {
        setTranscript((t) => (t + msg.text).slice(-2000));
      } else if (msg.type === 'error') {
        if (/not found/i.test(msg.message || '')) {
          reviveSession().then((ok) => {
            if (ok) return;
            speakingRef.current = false;
            setSpeaking(false);
            setConnected(false);
            try {
              stream.stop();
            } catch {
              // not streaming
            }
            Alert.alert('Session ended', 'This session has ended. Create a new one from setup.');
          });
        } else {
          Alert.alert('Translation error', msg.message);
        }
      }
    };
    ws.onclose = () => {
      if (wsRef.current !== ws || wsSeqRef.current !== seq) return;
      wsRef.current = null;
      setConnected(false);
      // Auto-reconnect while the speaker still intends to be live.
      if (speakingRef.current) setTimeout(() => { if (speakingRef.current) connectWs(); }, 1500);
    };
    ws.onerror = () => {};
  }, [session, serverUrl, reviveSession, stream]);

  const stopSpeaking = useCallback(() => {
    speakingRef.current = false;
    wsSeqRef.current += 1;
    setSpeaking(false);
    try {
      stream.stop();
    } catch {
      // not streaming
    }
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    setConnected(false);
  }, [stream]);

  const startSpeaking = useCallback(async () => {
    const perm = await requestRecordingPermissionsAsync();
    if (!perm.granted) {
      Alert.alert('Microphone needed', 'Allow microphone access to translate your voice.');
      return;
    }
    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
    speakingRef.current = true;
    setSpeaking(true);
    connectWs();
    try {
      await stream.start();
    } catch (err) {
      Alert.alert('Microphone error', String(err?.message ?? err));
      stopSpeaking();
    }
  }, [connectWs, stream, stopSpeaking]);

  const endSession = useCallback(() => {
    Alert.alert('End session?', 'This stops translation for everyone listening.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'End session',
        style: 'destructive',
        onPress: () => {
          if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({ type: 'end' }));
          }
          stopSpeaking();
          setSession(null);
          setTranscript('');
          setStats({ total: 0, listeners: {} });
          setScreen('setup');
        },
      },
    ]);
  }, [stopSpeaking]);

  useEffect(() => () => stopSpeaking(), [stopSpeaking]);

  if (screen === 'setup') {
    return (
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <StatusBar style="auto" />
        <View style={styles.center}>
          <Text style={styles.brand}>Glotta</Text>
          <Text style={styles.subtitle}>Live sermon translation</Text>

          <Text style={styles.label}>Session title</Text>
          <TextInput
            style={styles.input}
            placeholder="Sunday Service"
            value={title}
            onChangeText={setTitle}
            returnKeyType="done"
          />

          <Text style={styles.label}>Server address</Text>
          <TextInput
            style={styles.input}
            placeholder="http://192.168.1.36:8080"
            value={serverUrl}
            onChangeText={setServerUrl}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
          />

          <Text style={styles.label}>Speaker password</Text>
          <TextInput
            style={styles.input}
            placeholder="Enter password"
            value={password}
            onChangeText={setPassword}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
          />

          <Pressable
            style={[styles.button, creating && styles.buttonDisabled]}
            onPress={createSession}
            disabled={creating}
          >
            {creating ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.buttonText}>Start a session</Text>
            )}
          </Pressable>
          <Text style={styles.hint}>
            Listeners join by scanning the QR code on the next screen — no app needed.
          </Text>
        </View>
      </KeyboardAvoidingView>
    );
  }

  // Live screen
  const qrUri = `${serverUrl.trim().replace(/\/+$/, '')}/api/sessions/${session.sessionId}/qr.png`;
  const listenerLines = Object.entries(stats.listeners);

  return (
    <ScrollView contentContainerStyle={styles.liveContainer}>
      <StatusBar style="auto" />
      <Text style={styles.liveTitle}>{session.title || 'Live translation'}</Text>
      <Text style={styles.code}>{session.sessionId}</Text>

      <Image source={{ uri: qrUri }} style={styles.qr} resizeMode="contain" />
      <Text style={styles.joinUrl}>{session.joinUrl}</Text>

      <Pressable
        style={[styles.button, speaking ? styles.buttonLive : styles.buttonGo]}
        onPress={speaking ? stopSpeaking : startSpeaking}
      >
        <Text style={styles.buttonText}>{speaking ? 'Pause microphone' : 'Start speaking'}</Text>
      </Pressable>

      <Text style={styles.statusLine}>
        {speaking ? (connected ? '● Live' : 'Connecting…') : 'Microphone paused'}
      </Text>

      <Text style={styles.statsLine}>
        {stats.total === 0
          ? 'No listeners yet'
          : `${stats.total} listening` +
            (listenerLines.length ? ` — ${listenerLines.map(([l, n]) => `${l}: ${n}`).join(', ')}` : '')}
      </Text>

      <View style={styles.transcriptBox}>
        <Text style={styles.transcriptLabel}>What the model hears</Text>
        <Text style={styles.transcriptText}>
          {transcript || 'The live transcript appears here once Gemini hears audio.'}
        </Text>
      </View>

      <Pressable style={styles.endButton} onPress={endSession}>
        <Text style={styles.endButtonText}>End session</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  center: { flex: 1, justifyContent: 'center', paddingHorizontal: 28, gap: 8 },
  brand: { fontSize: 38, fontWeight: '800', textAlign: 'center', color: '#2b2b40' },
  subtitle: { fontSize: 16, color: '#888', textAlign: 'center', marginBottom: 20 },
  label: { fontSize: 13, color: '#666', marginTop: 12, marginBottom: 4, fontWeight: '600' },
  input: {
    borderWidth: 1,
    borderColor: '#d0d0d8',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 14,
    fontSize: 17,
  },
  button: {
    backgroundColor: '#4a5fc1',
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: 22,
  },
  buttonGo: { backgroundColor: '#2e9e5b' },
  buttonLive: { backgroundColor: '#c23b3b' },
  buttonDisabled: { opacity: 0.6 },
  buttonText: { color: '#fff', fontSize: 18, fontWeight: '700' },
  hint: { fontSize: 13, color: '#999', textAlign: 'center', marginTop: 16 },

  liveContainer: { padding: 24, paddingTop: 64, alignItems: 'center', gap: 12, backgroundColor: '#fff' },
  liveTitle: { fontSize: 22, fontWeight: '700', textAlign: 'center', color: '#2b2b40' },
  code: { fontSize: 34, fontWeight: '800', letterSpacing: 8, color: '#4a5fc1' },
  qr: { width: 240, height: 240, backgroundColor: '#fff' },
  joinUrl: { fontSize: 13, color: '#999', textAlign: 'center' },
  statusLine: { fontSize: 15, color: '#444', fontWeight: '600' },
  statsLine: { fontSize: 15, color: '#888', textAlign: 'center' },
  transcriptBox: {
    width: '100%',
    backgroundColor: '#f4f4f7',
    borderRadius: 12,
    padding: 14,
    minHeight: 90,
  },
  transcriptLabel: { fontSize: 12, color: '#999', marginBottom: 6, fontWeight: '600' },
  transcriptText: { fontSize: 15, color: '#333', lineHeight: 21 },
  endButton: { paddingVertical: 14, marginTop: 4 },
  endButtonText: { color: '#c23b3b', fontSize: 16, fontWeight: '600' },
});
