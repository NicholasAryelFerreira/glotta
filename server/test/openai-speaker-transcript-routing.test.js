import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionManager } from '../src/sessionManager.js';

function fakeSocket() {
  return {
    OPEN: 1,
    readyState: 1,
    sent: [],
    send(payload) { this.sent.push(JSON.parse(payload)); },
    close() { this.readyState = 3; },
  };
}

test('OpenAI keeps a dedicated transcription stream for speaker captions', async (context) => {
  const manager = new SessionManager({
    gemini: 'gemini-test-key',
    openai: 'openai-test-key',
  });
  const translators = [];
  const makeFakeStream = (_provider, options) => {
    const translator = {
      options,
      ready: true,
      sentAudio: [],
      closed: false,
      async connect() {},
      sendAudio(chunk) { this.sentAudio.push(chunk); },
      close() {
        this.closed = true;
        this.ready = false;
        return Promise.resolve();
      },
    };
    translators.push(translator);
    return translator;
  };
  manager.createTranslator = makeFakeStream;
  manager.createTranscriptStream = makeFakeStream;

  const session = manager.create({ id: 'ROUTE1', provider: 'openai' });
  context.after(async () => {
    if (manager.get(session.id)) await session.end('test cleanup');
  });
  const speaker = fakeSocket();
  const listener = fakeSocket();
  session.addSpeakerSocket(speaker);
  session.claimSpeaker(speaker);

  session.pushAudio('before-listener');
  const dedicated = translators.find(({ options }) => options.streamKind === 'speaker-transcript');
  assert.equal(dedicated.options.streamMode, 'transcription');
  assert.deepEqual(dedicated.sentAudio, ['before-listener']);

  await session.addListener(listener, 'pt');
  const portuguese = translators.find(({ options }) => (
    options.streamKind === 'listener' && options.targetLanguage === 'pt'
  ));
  assert.equal(dedicated.closed, false);
  assert.equal(session.speakerTranscriptTranslator, dedicated);

  session.pushAudio('with-listener');
  assert.deepEqual(portuguese.sentAudio, ['with-listener']);
  assert.equal(
    translators.filter(({ options }) => options.streamKind === 'speaker-transcript').length,
    1,
  );

  dedicated.options.onTranscript('input', 'English source words');
  assert.deepEqual(
    speaker.sent.filter(({ type }) => type === 'transcript'),
    [{ type: 'transcript', kind: 'input', text: 'English source words' }],
  );

  session.removeListener(listener, 'pt');
  session.pushAudio('after-listener');
  const dedicatedStreams = translators.filter(({ options }) => (
    options.streamKind === 'speaker-transcript'
  ));
  assert.equal(dedicatedStreams.length, 1);
  assert.deepEqual(dedicatedStreams[0].sentAudio, [
    'before-listener',
    'with-listener',
    'after-listener',
  ]);

  // Listener translation streams do not own the speaker caption path.
  portuguese.options.onTranscript('input', 'Should not be mirrored');
  assert.deepEqual(
    speaker.sent.filter(({ type }) => type === 'transcript'),
    [{ type: 'transcript', kind: 'input', text: 'English source words' }],
  );

  await session.end('test complete');
});

test('Gemini keeps its dedicated speaker transcript stream while listeners are active', async (context) => {
  const manager = new SessionManager('gemini-test-key');
  const translators = [];
  manager.createTranscriptStream = (_provider, options) => {
    const translator = {
      options,
      ready: true,
      closed: false,
      async connect() {},
      sendAudio() {},
      close() {
        this.closed = true;
        return Promise.resolve();
      },
    };
    translators.push(translator);
    return translator;
  };
  manager.createTranslator = manager.createTranscriptStream;

  const session = manager.create({ id: 'ROUTE2', provider: 'gemini' });
  context.after(async () => {
    if (manager.get(session.id)) await session.end('test cleanup');
  });
  session.pushAudio('before-listener');
  const dedicated = translators.find(({ options }) => options.streamKind === 'speaker-transcript');

  await session.addListener(fakeSocket(), 'pt-BR');
  session.pushAudio('with-listener');

  assert.equal(dedicated.closed, false);
  assert.equal(session.speakerTranscriptTranslator, dedicated);
  await session.end('test complete');
});
