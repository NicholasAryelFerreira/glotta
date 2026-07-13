import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { WebSocketServer } from 'ws';
import { Translator } from '../src/translator.js';

test('GoAway performs a graceful, resumed rollover before server abort', async () => {
  const server = new WebSocketServer({ port: 0 });
  await once(server, 'listening');
  const address = server.address();
  const setups = [];
  const serverCloses = [];
  let connectionCount = 0;

  server.on('connection', (socket) => {
    connectionCount += 1;
    const connectionNumber = connectionCount;
    socket.once('message', (raw) => {
      setups.push(JSON.parse(raw.toString()));
      socket.send(JSON.stringify({ setupComplete: {} }));
      if (connectionNumber === 1) {
        setTimeout(() => {
          socket.send(JSON.stringify({
            sessionResumptionUpdate: { resumable: true, newHandle: 'resume-handle-1' },
          }));
        }, 5);
        setTimeout(() => {
          socket.send(JSON.stringify({ goAway: { timeLeft: '10s' } }));
        }, 10);
      }
    });
    socket.on('close', (code, reason) => {
      serverCloses.push({ code, reason: reason.toString() });
    });
  });

  let translator;
  let timeout;
  const resumed = new Promise((resolve, reject) => {
    timeout = setTimeout(() => reject(new Error('translator did not resume in time')), 2_500);
    translator = new Translator({
      apiKey: 'test-key',
      targetLanguage: 'es',
      wsBase: `ws://127.0.0.1:${address.port}`,
      onAudio: () => {},
      onTranscript: () => {},
      onError: reject,
      onStatus: (state) => {
        if (state === 'translator-online' && translator.connectionNumber === 2) resolve();
      },
    });
  });

  try {
    await translator.connect();
    await resumed;
    assert.equal(setups.length, 2);
    assert.equal(setups[1].setup.sessionResumption.handle, 'resume-handle-1');
    assert.ok(serverCloses.some(({ code, reason }) => (
      code === 1000 && reason === 'graceful GoAway rollover'
    )));
  } finally {
    clearTimeout(timeout);
    translator.close();
    for (const client of server.clients) client.terminate();
    await new Promise((resolve) => server.close(resolve));
  }
});
