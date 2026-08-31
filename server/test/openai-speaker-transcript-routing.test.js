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

test('OpenAI mirrors source transcript from an active listener translation stream', async (context) => {
  const manager = new SessionManager({
    gemini: 'gemini-test-key',
    openai: 'openai-test-key',
  });
  const translators = [];
  manager.createTranslator = (_provider, options) => {
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
  assert.deepEqual(dedicated.sentAudio, ['before-listener']);

  await session.addListener(listener, 'pt');
  const portuguese = translators.find(({ options }) => (
    options.streamKind === 'listener' && options.targetLanguage === 'pt'
  ));
  assert.equal(dedicated.closed, true);
  assert.equal(session.speakerTranscriptTranslator, null);

  session.pushAudio('with-listener');
  assert.deepEqual(portuguese.sentAudio, ['with-listener']);
  assert.equal(
    translators.filter(({ options }) => options.streamKind === 'speaker-transcript').length,
    1,
  );

  portuguese.options.onTranscript('input', 'English source words');
  assert.deepEqual(
    speaker.sent.filter(({ type }) => type === 'transcript'),
    [{ type: 'transcript', kind: 'input', text: 'English source words' }],
  );

  session.removeListener(listener, 'pt');
  session.pushAudio('after-listener');
  const dedicatedStreams = translators.filter(({ options }) => (
    options.streamKind === 'speaker-transcript'
  ));
  assert.equal(dedicatedStreams.length, 2);
  assert.deepEqual(dedicatedStreams[1].sentAudio, ['after-listener']);

  await session.end('test complete');
});

test('Gemini keeps its dedicated speaker transcript stream while listeners are active', async (context) => {
  const manager = new SessionManager('gemini-test-key');
  const translators = [];
  manager.createTranslator = (_provider, options) => {
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
