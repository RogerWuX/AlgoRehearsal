const { test } = require('node:test');
const assert = require('node:assert/strict');
const load = require('./helpers/loadTypeScript.cjs');
const { plain, flush, deferred, sampleProblem, config, memoryStorage, harness, formatDiscussionMessage } = require('./helpers/fixtures.cjs');

test('session follows prepared startup policy, accepts selection metadata, and skips the selector on retry', async () => {
  for (const [initialStatus, timeout] of [['selecting', 300000], ['connecting', 20000]]) {
    const { InterviewSession } = load('src/features/interview/session/InterviewSession.ts');
    const pending = deferred(), timers = [], connections = [], preparations = [];
    let acquisitions = 0;
    const session = new InterviewSession({
      formatDiscussionMessage,
      judgment: { isRunning: () => false, cancel() {}, run: async () => {} },
      selection: {
        getBankInfo: () => ({ storedProblemCount: 2, questionImportWarning: 'Bank warning' }),
        prepare(configuration) {
          preparations.push(configuration);
          return { initialStatus, logContext: { source: 'agent', saveSearchedProblems: false, storedProblemCount: 0 },
            getProblem: () => { acquisitions++; return pending.promise; } };
        },
      },
      createAudio: () => ({ resume: async () => {}, stopMicrophone: () => false, close() {} }),
      createTransport: (_live, problem, events) => { connections.push({ problem, events }); return { close() {} }; },
      clock: { setTimeout: (callback, ms) => { const timer = { callback, ms }; timers.push(timer); return timer; }, clearTimeout() {} },
    });
    try {
      assert.equal(session.getSnapshot().storedProblemCount, 2);
      assert.equal(session.getSnapshot().questionImportWarning, 'Bank warning');
      const task = session.connect(config);
      await flush();
      assert.equal(session.getSnapshot().status, initialStatus);
      assert.equal(timers[0].ms, timeout);
      assert.equal(connections.length, 0);
      pending.resolve({ problem: sampleProblem, problemStorageStatus: 'unavailable', storedProblemCount: 3 });
      await task;
      assert.deepEqual(plain(preparations[0]), config);
      assert.equal(session.getSnapshot().problemStorageStatus, 'unavailable');
      assert.equal(session.getSnapshot().storedProblemCount, 3);
      assert.equal(timers.at(-1).ms, 20000);
      connections[0].events.error('Live failed');
      await session.retry({ ...config, problemSource: 'stored' });
      assert.equal(preparations.length, 1);
      assert.equal(acquisitions, 1);
      assert.equal(connections.length, 2);
      assert.deepEqual(plain(connections[1].problem), sampleProblem);
    } finally { session.disconnect(); }
  }
});

test('failed instruction loading never starts selection and releases audio', async () => {
  const h = harness({ loadInstructions: async () => { throw new Error('Selection instructions unavailable'); } });
  await h.session.connect(config);
  assert.equal(h.selections.length, 0); assert.equal(h.liveSessions.length, 0);
  assert.equal(h.snapshot.status, 'disconnected'); assert.match(h.snapshot.error, /instructions/);
  assert.equal(h.contexts[0].closed, true);
});

test('fresh start requires both configurations and retry without a problem reports an error', async () => {
  const h = harness();
  await h.session.connect({ ...config, thinking: { ...config.thinking, apiKey: '' } });
  assert.match(h.snapshot.error, /thinking API key/);
  await h.session.connect({ ...config, live: { ...config.live, credential: '' } });
  assert.match(h.snapshot.error, /Live API credential/);
  await h.session.retry(config);
  assert.match(h.snapshot.error, /No selected problem/);
  assert.equal(h.selections.length, 0); assert.equal(h.contexts.length, 0);
});

test('startup waits for instructions and blocks duplicate starts', async () => {
  const pending = deferred();
  const h = harness({ loadInstructions: () => pending.promise });
  try {
    const task = h.session.connect(config); await flush();
    await h.session.connect(config);
    assert.equal(h.selections.length, 0); assert.equal(h.snapshot.status, 'selecting');
    pending.resolve('My custom rules'); await task;
    assert.equal(h.selections.length, 1);
    assert.deepEqual(plain(h.selections[0][0]), config.thinking);
    assert.equal(h.selections[0][1], 'My custom rules');
    assert.equal(h.liveSessions.length, 1);
  } finally { h.session.disconnect(); }
});

test('startup uses embedded instructions without fetching and hands off only the accepted problem to Live', async () => {
  const pending = deferred(), h = harness({ select: () => pending.promise });
  try {
    const task = h.session.connect({ ...config, saveSearchedProblems: true }); await flush();
    assert.equal(h.liveSessions.length, 0); assert.equal(h.snapshot.messages.length, 0);
    assert.equal(h.selections[0][1], load('src/features/interview/agents/selection/prompts.ts').SELECTION_INSTRUCTIONS);
    pending.resolve(sampleProblem); await task;
    assert.deepEqual(plain(h.snapshot.problem), sampleProblem);
    assert.ok(h.storage.getItem('interview-practice.problem'));
    assert.equal(h.snapshot.status, 'connecting');
    const ws = h.liveSessions[0];
    assert.equal(ws.options.apiKey, 'live-key'); assert.notEqual(ws.options.apiKey, 'thinking-key');
    const setup = ws.parameters.config;
    assert.equal(ws.parameters.model, 'gemini-3.8-live'); assert.equal(setup.tools, undefined);
    assert.equal(setup.thinkingConfig, undefined);
    assert.match(setup.systemInstruction.parts[0].text, /DSA interviewer/);
    await ws.receive({ setupComplete: {} }); await ws.receive({ setupComplete: {} });
    assert.equal(h.snapshot.status, 'connected');
    assert.equal(ws.sent.filter(item => item.clientContent).length, 1);
    assert.match(ws.sent[0].clientContent.turns[0].parts[0].text, /Pair sum/);
    assert.doesNotMatch(JSON.stringify(ws.sent), /thinking-key|Problem selection instructions|DSA problem selection agent/);
    await ws.receive({ serverContent: { outputTranscription: { text: 'Explain your approach.' } } });
    assert.equal(h.snapshot.messages[0].text, 'Explain your approach.');
    await ws.receive({ toolCall: { functionCalls: [{ id: 'random', name: 'gen_random_number', args: { min: 1, max: 1 } }] } });
    assert.match(ws.sent.at(-1).toolResponse.functionResponses[0].response.error.message, /Unknown tool/);
  } finally { h.session.disconnect(); }
});

test('a Live ephemeral token is used only by the interviewer', async () => {
  const h = harness();
  try {
    await h.session.connect({ ...config, live: { ...config.live, credential: 'auth_tokens/session' } });
    assert.equal(h.liveSessions[0].options.apiKey, 'auth_tokens/session');
    assert.equal(h.liveSessions[0].options.httpOptions.apiVersion, 'v1beta');
    assert.equal(h.selections[0][0].apiKey, 'thinking-key');
  } finally { h.session.disconnect(); }
});

test('canceled instruction loading and canceled selection cannot affect a restarted interview', async () => {
  for (const phase of ['instructions', 'selection']) {
    const pending = deferred(); let calls = 0;
    const h = harness(phase === 'instructions'
      ? { loadInstructions: () => calls++ === 0 ? pending.promise : Promise.resolve('New rules') }
      : { select: () => calls++ === 0 ? pending.promise : Promise.resolve(sampleProblem) });
    try {
      const old = h.session.connect(config); await flush();
      const oldSignal = h.selections[0]?.[2];
      h.session.disconnect(); if (oldSignal) assert.equal(oldSignal.aborted, true);
      await h.session.connect(config);
      pending.resolve(phase === 'instructions' ? 'Old rules' : { ...sampleProblem, title: 'Stale problem' });
      await old;
      assert.equal(h.liveSessions.length, 1); assert.equal(h.snapshot.problem.title, 'Pair sum'); assert.equal(h.snapshot.error, '');
    } finally { h.session.disconnect(); }
  }
});

test('fresh selection clears the previous problem immediately, including on failure, and hides credentials in errors', async () => {
  const pending = deferred();
  let shouldFail = false;
  const h = harness({ select: async () => {
    if (shouldFail) return pending.promise;
    return sampleProblem;
  } });
  await h.session.connect(config);
  h.session.disconnect();
  shouldFail = true;
  const starting = h.session.connect(config);
  await flush();
  assert.equal(h.snapshot.status, 'selecting'); assert.equal(h.snapshot.problem, null);
  pending.reject(new Error('Failed for thinking-key and live-key'));
  await starting;
  assert.equal(h.snapshot.status, 'disconnected'); assert.equal(h.snapshot.problem, null);
  assert.equal(h.snapshot.canRetry, false); assert.equal(h.liveSessions.length, 1);
  assert.doesNotMatch(h.snapshot.error, /thinking-key|live-key/); assert.match(h.snapshot.error, /redacted/);
});

test('quit stops an active interview without grading and ignores abandoned callbacks after a fresh start', async () => {
  let microphones = 0, microphoneStops = 0, audioCloses = 0, selections = 0;
  const h = harness({
    select: async () => ({ ...sampleProblem, title: ++selections === 1 ? 'First problem' : 'Next problem' }),
    audioFactory: () => ({
      resume: async () => {}, play() {}, stopPlayback() {},
      startMicrophone: async () => { microphones++; return true; },
      stopMicrophone: () => { if (!microphones) return false; microphones--; microphoneStops++; return true; },
      close: () => { audioCloses++; },
    }),
  });
  try {
    await h.session.connect(config);
    const old = h.liveSessions[0];
    await old.receive({ setupComplete: {} });
    h.session.send('My approach');
    h.session.setDiscussion('Written notes');
    await old.receive({ serverContent: { outputTranscription: { text: 'Explain the complexity.' } } });
    assert.equal(h.snapshot.listening, true);
    assert.equal(h.snapshot.messages.length, 2);
    const send = old.send;
    old.send = () => { throw new Error('Send failed'); };
    assert.equal(h.session.send('Failed message'), false);
    old.send = send;
    assert.match(h.snapshot.error, /could not be sent/);
    h.session.quit();
    h.session.quit();
    assert.equal(old.closed, true);
    assert.equal(audioCloses, 1); assert.equal(microphoneStops, 1);
    assert.equal(h.snapshot.status, 'disconnected'); assert.equal(h.snapshot.problem, null);
    assert.equal(h.snapshot.discussion, ''); assert.equal(h.snapshot.messages.length, 0);
    assert.equal(h.snapshot.judgment.status, 'idle'); assert.equal(h.snapshot.judgment.submission, null);
    assert.equal(h.snapshot.canRetry, false); assert.equal(h.snapshot.canResume, false); assert.equal(h.snapshot.shouldResume, false);
    assert.equal(h.snapshot.listening, false); assert.equal(h.snapshot.audioNeedsInteraction, false);
    assert.equal(h.snapshot.error, ''); assert.equal(h.judgments.length, 0);
    await h.session.retry(config);
    assert.match(h.snapshot.error, /No selected problem/);
    await h.session.connect(config);
    await h.liveSessions[1].receive({ setupComplete: {} });
    await old.receive({ setupComplete: {}, serverContent: { outputTranscription: { text: 'Abandoned message' } } });
    old.fail();
    assert.equal(h.selections.length, 2); assert.equal(h.snapshot.problem.title, 'Next problem');
    assert.equal(h.snapshot.status, 'connected'); assert.equal(h.snapshot.messages.length, 0); assert.equal(h.snapshot.error, '');
    assert.equal(h.judgments.length, 0);
  } finally { h.session.quit(); }
});

test('quit cancels pending selection and a pending Live connection without restoring their problems', async () => {
  for (const phase of ['selection', 'connection']) {
    const pending = deferred(); let selections = 0;
    const h = harness({ select: () => ++selections === 1 && phase === 'selection' ? pending.promise : Promise.resolve(sampleProblem) });
    try {
      const starting = h.session.connect(config);
      await flush();
      const signal = h.selections[0][2], old = h.liveSessions[0];
      assert.equal(h.snapshot.status, phase === 'selection' ? 'selecting' : 'connecting');
      h.session.quit();
      assert.equal(signal.aborted, true);
      assert.equal(h.snapshot.problem, null); assert.equal(h.snapshot.canRetry, false);
      await h.session.connect(config);
      const current = h.liveSessions.at(-1);
      await current.receive({ setupComplete: {} });
      if (old) await old.receive({ setupComplete: {} });
      else pending.resolve({ ...sampleProblem, title: 'Abandoned problem' });
      await starting;
      assert.equal(h.snapshot.status, 'connected'); assert.equal(h.snapshot.problem.title, sampleProblem.title);
      assert.equal(h.snapshot.messages.length, 0); assert.equal(h.snapshot.error, '');
      assert.equal(h.judgments.length, 0);
      if (old) assert.equal(old.closed, true);
    } finally { h.session.quit(); }
  }
});

test('saved questions leave the workspace empty; every fresh start selects a new problem', async () => {
  const storage = memoryStorage(); load('src/features/interview/storage/problemStorage.ts').writeProblem(storage, sampleProblem);
  const h = harness({ storage });
  try {
    assert.equal(h.snapshot.problem, null); assert.equal(h.snapshot.storedProblemCount, 1); assert.equal(h.liveSessions.length, 0);
    await h.session.connect(config); h.session.disconnect();
    await h.session.connect({ ...config, thinking: { ...config.thinking, model: 'antigravity-preview-09-2026' } });
    assert.equal(h.selections.length, 2); assert.equal(h.selections[1][0].model, 'antigravity-preview-09-2026');
  } finally { h.session.disconnect(); }
});

test('blocked storage retains the selected problem and still starts interviewer', async () => {
  const h = harness({ storage: { getItem: () => { throw new Error('Blocked'); }, setItem: () => { throw new Error('Blocked'); } } });
  try {
    await h.session.connect({ ...config, saveSearchedProblems: true });
    assert.equal(h.snapshot.problemStorageStatus, 'unavailable'); assert.deepEqual(plain(h.snapshot.problem), sampleProblem); assert.equal(h.liveSessions.length, 1);
  } finally { h.session.disconnect(); }
});

test('unchecked searches stay retryable in memory without changing saved records or appearing after reload', async () => {
  const { createProblemRepository, PROBLEM_STORAGE_KEY, PROBLEM_BANK_STORAGE_KEY } = load('src/features/interview/storage/problemStorage.ts');
  const newProblem = { ...sampleProblem, title: 'New problem', sourceUrl: 'https://example.test/problems/new' };
  const updatedProblem = { ...sampleProblem, description: 'Updated description that must not be saved' };
  for (const [seed, selected] of [[false, newProblem], [true, newProblem], [true, updatedProblem]]) {
    for (const preference of [{}, { saveSearchedProblems: false }]) {
      const storage = memoryStorage();
      if (seed) createProblemRepository(() => storage).write(sampleProblem);
      const h = harness({ storage, select: async () => selected });
      const previousActive = storage.getItem(PROBLEM_STORAGE_KEY), previousBank = storage.getItem(PROBLEM_BANK_STORAGE_KEY);
      let writes = 0;
      const originalWrite = storage.setItem;
      storage.setItem = (...args) => { writes++; originalWrite(...args); };
      try {
        await h.session.connect({ ...config, ...preference });
        assert.deepEqual(plain(h.snapshot.problem), selected);
        assert.equal(h.snapshot.problemStorageStatus, 'session');
        assert.equal(h.snapshot.storedProblemCount, seed ? 1 : 0);
        h.liveSessions[0].fail();
        assert.equal(h.snapshot.canRetry, true);
        await h.session.retry(config);
        await h.liveSessions[1].receive({ setupComplete: {} });
        assert.match(h.liveSessions[1].sent[0].clientContent.turns[0].parts[0].text, new RegExp(selected.title));
        assert.equal(h.selections.length, 1);
        assert.equal(writes, 0);
        assert.equal(storage.getItem(PROBLEM_STORAGE_KEY), previousActive);
        assert.equal(storage.getItem(PROBLEM_BANK_STORAGE_KEY), previousBank);
        const reloaded = createProblemRepository(() => storage);
        assert.deepEqual(plain(reloaded.list()), seed ? [sampleProblem] : []);
        assert.deepEqual(plain(reloaded.read().problem), seed ? sampleProblem : null);
      } finally { h.session.disconnect(); }
    }
  }
});

test('checked searches save the active problem and update matching bank entries', async () => {
  const { createProblemRepository } = load('src/features/interview/storage/problemStorage.ts');
  let selected = sampleProblem;
  const h = harness({ select: async () => selected });
  try {
    for (const description of [sampleProblem.description, 'Updated saved description']) {
      selected = { ...sampleProblem, description };
      await h.session.connect({ ...config, saveSearchedProblems: true });
      assert.equal(h.snapshot.problemStorageStatus, 'saved');
      assert.equal(h.snapshot.storedProblemCount, 1);
      const reloaded = createProblemRepository(() => h.storage);
      assert.deepEqual(plain(reloaded.list()), [selected]);
      assert.deepEqual(plain(reloaded.read().problem), selected);
      h.session.disconnect();
    }
  } finally { h.session.disconnect(); }
});

test('interviewer retry requires both configurations and reuses the selected problem', async () => {
  let instructionLoads = 0;
  const h = harness({ loadInstructions: async () => { instructionLoads++; return 'Rules'; } });
  try {
    await h.session.connect(config);
    const old = h.liveSessions[0]; old.fail();
    assert.equal(h.snapshot.canRetry, true);
    await h.session.retry({ ...config, thinking: { ...config.thinking, apiKey: '' } });
    assert.match(h.snapshot.error, /standard thinking API key/);
    assert.equal(h.liveSessions.length, 1);
    await h.session.retry({ ...config, live: { credential: 'new-live-key', model: 'gemini-3.8-live' } });
    assert.equal(instructionLoads, 1); assert.equal(h.selections.length, 1); assert.equal(h.liveSessions.length, 2);
    const retry = h.liveSessions[1];
    assert.equal(retry.options.apiKey, 'new-live-key'); assert.equal(retry.parameters.config.tools, undefined);
    await old.receive({ setupComplete: {} }); assert.equal(h.snapshot.status, 'connecting');
    await retry.receive({ setupComplete: {} }); assert.match(retry.sent[0].clientContent.turns[0].parts[0].text, /Pair sum/);
  } finally { h.session.disconnect(); }
});

test('selection and connection timeouts abort work and ignore late results', async () => {
  const pending = deferred(), timers = [];
  const clocks = { setTimeout: (callback, ms) => { const timer = { callback, ms }; timers.push(timer); return timer; }, clearTimeout: timer => { timer.cleared = true; } };
  let selections = 0;
  const h = harness({ clocks, select: () => selections++ === 0 ? pending.promise : Promise.resolve(sampleProblem) });
  try {
    const task = h.session.connect(config); await flush();
    assert.equal(timers[0].ms, 300000); timers[0].callback();
    assert.equal(h.selections[0][2].aborted, true); assert.equal(h.snapshot.status, 'disconnected'); assert.match(h.snapshot.error, /selection timed out/);
    pending.resolve(sampleProblem); await task; assert.equal(h.liveSessions.length, 0); assert.equal(h.snapshot.problem, null);
    await h.session.connect(config);
    assert.equal(timers.at(-1).ms, 20000); assert.equal(timers[1].cleared, true);
    timers.at(-1).callback(); assert.equal(h.snapshot.canRetry, true); assert.match(h.snapshot.error, /Interviewer connection timed out/);
  } finally { h.session.disconnect(); }
});

test('interviewer session skips canceled calls and starts exactly once', () => {
  const sent = [], { GeminiProtocolSession } = load('src/features/interview/adapters/live/gemini/protocolSession.ts');
  const session = new GeminiProtocolSession({ sendClientContent: value => sent.push({ clientContent: plain(value) }), sendToolResponse: value => sent.push({ toolResponse: plain(value) }) }, [{ role: 'user', text: 'Prepared Pair sum opening' }]);
  session.handle({ setupComplete: {} }); session.handle({ setupComplete: {} });
  session.handle({ toolCallCancellation: { ids: ['canceled'] } });
  session.handle({ toolCall: { functionCalls: [{ id: 'canceled', name: 'gen_random_number' }, { id: 'unknown', name: 'unknown' }] } });
  assert.equal(sent.length, 2); assert.match(sent[0].clientContent.turns[0].parts[0].text, /Pair sum/);
  assert.equal(sent[1].toolResponse.functionResponses.length, 1); assert.equal(sent[1].toolResponse.functionResponses[0].id, 'unknown');
});


async function connected(h) {
  await h.session.connect(config);
  const socket = h.liveSessions.at(-1);
  await socket.receive({ setupComplete: {} });
  return socket;
}

test('text sending reads current connection state, trims input, and reports send failures', async () => {
  const h = harness();
  try {
    assert.equal(h.session.send('before connection'), false);
    const socket = await connected(h);
    assert.equal(h.session.send('   '), false);
    assert.equal(h.session.send('  My approach  '), true);
    assert.deepEqual(socket.sent.at(-1), { realtimeInput: { text: 'My approach' } });
    assert.equal(h.snapshot.messages.at(-1).text, 'My approach');
    socket.send = () => { throw new Error('Socket unavailable'); };
    assert.equal(h.session.send('lost message'), false);
    assert.match(h.snapshot.error, /could not be sent/);
    assert.equal(h.snapshot.messages.length, 1);
    h.session.disconnect();
    assert.equal(h.session.send('after disconnect'), false);
  } finally { h.session.disconnect(); }
});

test('discussion sending retains notes and records the full sent text separately from chat and voice', async () => {
  const h = harness();
  const options = { kind: 'discussion' };
  const notes = '  Use a map.\nCheck duplicates 😀\n';
  h.session.setDiscussion(notes);
  assert.equal(h.session.send(notes, options), false);
  try {
    const socket = await connected(h);
    h.session.setDiscussion(notes);
    const before = socket.sent.length;
    assert.equal(h.session.send(' \n ', options), false);
    assert.equal(socket.sent.length, before);
    assert.equal(h.session.send(h.snapshot.discussion, options), true);
    assert.equal(socket.sent.length, before + 1);
    assert.deepEqual(socket.sent.at(-1), { realtimeInput: { text: `[Discussion notes]\n${notes.trim()}` } });
    assert.deepEqual(plain(h.snapshot.messages[0]), { id: 1, role: 'user', text: notes.trim(), kind: 'discussion' });
    assert.equal(h.snapshot.discussion, notes);
    h.session.setDiscussion('Edited after sending');
    assert.equal(h.snapshot.messages[0].text, notes.trim());
    await socket.receive({ serverContent: { inputTranscription: { text: 'Spoken answer' } } });
    assert.equal(h.snapshot.messages[1].text, 'Spoken answer');
    assert.equal(h.snapshot.messages[1].kind, undefined);
    h.session.send('Chat answer');
    assert.deepEqual(socket.sent.at(-1), { realtimeInput: { text: 'Chat answer' } });
    assert.equal(h.snapshot.messages[2].kind, undefined);
    assert.equal(h.session.send(notes, options), true);
    assert.equal(h.snapshot.messages[3].kind, 'discussion');
    const count = h.snapshot.messages.length;
    socket.send = () => { throw new Error('Socket unavailable'); };
    assert.equal(h.session.send(h.snapshot.discussion, options), false);
    assert.equal(h.snapshot.messages.length, count);
    assert.equal(h.snapshot.discussion, 'Edited after sending');
    assert.match(h.snapshot.error, /could not be sent/);
    h.session.disconnect();
    assert.equal(h.session.send(notes, options), false);
    assert.equal(h.snapshot.messages.length, count);
  } finally { h.session.disconnect(); }
});

test('discussion input leaves microphone capture active and preserves matching speech after distinct speech', async () => {
  let onAudio;
  const audio = fakeAudio(async callback => { onAudio = callback; return true; });
  const h = harness({ audioFactory: () => audio });
  try {
    const socket = await connected(h);
    onAudio({ data: 'before-notes', mimeType: 'audio/pcm;rate=16000' });
    const notes = 'Use a map.';
    assert.equal(h.session.send(notes, { kind: 'discussion' }), true);
    assert.deepEqual(socket.sent.at(-1), { realtimeInput: { text: `[Discussion notes]\n${notes}` } });
    assert.equal(h.snapshot.listening, true);
    onAudio({ data: 'after-notes', mimeType: 'audio/pcm;rate=16000' });
    assert.deepEqual(socket.sent.at(-1), { realtimeInput: { audio: { data: 'after-notes', mimeType: 'audio/pcm;rate=16000' } } });
    await socket.receive({ serverContent: { inputTranscription: { text: 'First, check the input.', finished: true } } });
    await socket.receive({ serverContent: { inputTranscription: { text: notes, finished: true } } });
    assert.deepEqual(plain(h.snapshot.messages).map(({ text, kind }) => ({ text, kind })), [
      { text: notes, kind: 'discussion' }, { text: 'First, check the input.', kind: undefined }, { text: notes, kind: undefined },
    ]);
  } finally { h.session.disconnect(); }
});

test('transcriptions merge by role and reset after completion, interruption, and typed messages', async () => {
  const h = harness();
  try {
    const socket = await connected(h);
    await socket.receive({ serverContent: { inputTranscription: { text: 'I think ' }, outputTranscription: { text: 'Tell me ' } } });
    await socket.receive({ serverContent: { inputTranscription: { text: 'a map.' }, outputTranscription: { text: 'more.' }, turnComplete: true } });
    assert.deepEqual(plain(h.snapshot.messages).map(item => item.text), ['I think a map.', 'Tell me more.']);
    const before = h.snapshot;
    await socket.receive({ serverContent: { outputTranscription: { text: 'Next question' } } });
    await socket.receive({ serverContent: { interrupted: true, outputTranscription: { text: 'New response' } } });
    h.session.send('Typed answer');
    await socket.receive({ serverContent: { inputTranscription: { text: 'Spoken answer' } } });
    assert.deepEqual(plain(h.snapshot.messages).map(item => item.text), ['I think a map.', 'Tell me more.', 'Next question', 'New response', 'Typed answer', 'Spoken answer']);
    assert.equal(before.messages.length, 2);
    assert.equal(new Set(h.snapshot.messages.map(item => item.id)).size, 6);
  } finally { h.session.disconnect(); }
});

test('Extended Thinking keeps streaming after a completed turn while background reasoning continues', async () => {
  const played = [], audio = fakeAudio();
  audio.play = chunk => played.push(plain(chunk));
  const h = harness({ audioFactory: () => audio });
  try {
    await h.session.connect({ ...config, live: { ...config.live, model: 'gemini-3.8-live-extended-thinking' } });
    const socket = h.liveSessions[0];
    assert.equal(socket.parameters.model, 'gemini-3.8-live-extended-thinking');
    assert.equal(socket.parameters.config.tools, undefined);
    assert.deepEqual(plain(socket.parameters.config.thinkingConfig), { thinkingLevel: 'MEDIUM' });
    assert.equal(socket.parameters.config.proactivity, undefined);
    await socket.receive({ setupComplete: {} });
    await socket.receive({ serverContent: { outputTranscription: { text: 'Let me consider that.' }, turnComplete: true, interactionStatus: 'IN_PROGRESS' } });
    assert.equal(h.snapshot.status, 'connected');
    assert.equal(socket.closed, false);
    await socket.receive({ serverContent: { outputTranscription: { text: 'Explain the time complexity.' }, modelTurn: { parts: [
      { inlineData: { data: 'reasoned-audio', mimeType: 'audio/pcm;rate=24000' } },
    ] } } });
    await socket.receive({ serverContent: { turnComplete: true, interactionStatus: 'IDLE' } });
    assert.deepEqual(plain(h.snapshot.messages).map(item => item.text), ['Let me consider that.', 'Explain the time complexity.']);
    assert.deepEqual(played, [{ data: 'reasoned-audio', mimeType: 'audio/pcm;rate=24000' }]);
    assert.equal(h.snapshot.status, 'connected');
    assert.equal(h.snapshot.error, '');
  } finally { h.session.disconnect(); }
});

test('Live setup maps all thinking efforts, defaults older configs, and omits unsupported effort', async () => {
  for (const [model, requested, expected] of [
    ['gemini-3.8-live-extended-thinking', 'low', 'LOW'],
    ['gemini-3.8-live-extended-thinking', 'medium', 'MEDIUM'],
    ['gemini-3.8-live-extended-thinking', 'high', 'HIGH'],
    ['gemini-3.8-live-extended-thinking', undefined, 'MEDIUM'],
    ['gemini-3.8-live-extended-thinking', 'minimal', 'MEDIUM'],
    ['gemini-3.8-live', 'high', undefined],
  ]) {
    const h = harness();
    try {
      await h.session.connect({ ...config, live: { ...config.live, model, thinkingEffort: requested } });
      const socket = h.liveSessions[0];
      assert.equal(socket.parameters.config.thinkingConfig?.thinkingLevel, expected);
      if (expected === undefined) assert.equal('thinkingConfig' in socket.parameters.config, false);
      await socket.receive({ setupComplete: {} });
      assert.equal(h.snapshot.status, 'connected');
    } finally { h.session.disconnect(); }
  }
});

test('Live close reasons are visible and redacted without changing retry or cleanup', async () => {
  for (const [reason, expected, credential = config.live.credential] of [
    ['Thinking level must be specified for this model.', /Thinking level must be specified/],
    ['Rejected live-key and thinking-key', /Rejected \[redacted\] and \[redacted\]/],
    ['Rejected auth_tokens%2Fsession', /Rejected \[redacted\]/, 'auth_tokens/session'],
    ['', /^Gemini disconnected \(1007\)\. Retry the interview\.$/],
  ]) {
    const h = harness();
    try {
      await h.session.connect({ ...config, live: { ...config.live, credential } });
      const socket = h.liveSessions[0];
      socket.parameters.callbacks.onclose({ code: 1007, reason });
      assert.match(h.snapshot.error, expected);
      assert.doesNotMatch(h.snapshot.error, /live-key|thinking-key/);
      assert.doesNotMatch(h.snapshot.error, /auth_tokens(?:\/|%2F)session/);
      assert.equal(h.snapshot.canRetry, true);
      assert.equal(h.snapshot.status, 'disconnected');
      assert.equal(h.contexts[0].closed, true);
      await socket.receive({ setupComplete: {} });
      assert.equal(socket.closed, true);
      assert.match(h.snapshot.error, expected);
    } finally { h.session.disconnect(); }
  }
});

test('snapshot subscriptions are removable and disconnect remains reusable', async () => {
  const h = harness();
  let notifications = 0;
  const unsubscribe = h.session.subscribe(() => { notifications++; });
  assert.equal(h.session.getSnapshot(), h.session.getSnapshot());
  await connected(h);
  assert.ok(notifications > 0);
  unsubscribe();
  const count = notifications;
  h.session.disconnect();
  h.session.disconnect();
  await connected(h);
  assert.equal(notifications, count);
  h.session.disconnect();
});

function fakeAudio(startMicrophone = async () => true) {
  return {
    closed: false, stops: 0,
    resume: async () => {}, play: () => {}, stopPlayback: () => {}, startMicrophone,
    stopMicrophone() { this.stops++; return true; },
    close() { this.closed = true; },
  };
}

test('each connection enables the microphone only after readiness, including retries and manual resumes', async () => {
  let starts = 0;
  const h = harness({ audioFactory: () => fakeAudio(async () => { starts++; return true; }) });
  try {
    for (const action of ['connect', 'retry', 'resume']) {
      await h.session[action](config);
      assert.equal(h.snapshot.status, 'connecting');
      assert.equal(h.snapshot.listening, false);
      const before = starts;
      await h.liveSessions.at(-1).receive({ setupComplete: {} });
      assert.equal(starts, before + 1);
      assert.equal(h.snapshot.listening, true);
      await h.session.toggleMic();
      assert.equal(h.snapshot.listening, false);
      h.session.disconnect();
    }
    assert.equal(starts, 3);
  } finally { h.session.disconnect(); }
});

test('duplicate readiness neither starts a second capture nor overrides a manual disable', async () => {
  let events, starts = 0;
  const h = harness({
    audioFactory: () => fakeAudio(async () => { starts++; return true; }),
    transportFactory: (_config, _problem, callbacks) => {
      events = callbacks;
      return { sendText: () => true, sendAudio() {}, endAudio() {}, close() {} };
    },
  });
  try {
    await h.session.connect(config);
    events.ready(); events.ready();
    await flush();
    assert.equal(starts, 1);
    assert.equal(h.snapshot.listening, true);
    await h.session.toggleMic();
    events.ready();
    await flush();
    assert.equal(starts, 1);
    assert.equal(h.snapshot.listening, false);
    await h.session.toggleMic();
    assert.equal(starts, 2);
    assert.equal(h.snapshot.listening, true);
  } finally { h.session.disconnect(); }
});

test('synchronous readiness starts capture after the transport is assigned', async () => {
  const sent = [];
  const h = harness({
    audioFactory: () => fakeAudio(async onAudio => {
      onAudio({ data: 'first-audio', mimeType: 'audio/pcm;rate=16000' });
      return true;
    }),
    transportFactory: (_config, _problem, events) => {
      events.ready();
      return { sendText: () => true, sendAudio: chunk => sent.push(plain(chunk)), endAudio() {}, close() {} };
    },
  });
  try {
    await h.session.connect(config);
    assert.equal(h.snapshot.listening, true);
    assert.deepEqual(sent, [{ data: 'first-audio', mimeType: 'audio/pcm;rate=16000' }]);
  } finally { h.session.disconnect(); }
});

test('failed default microphone startup leaves text usable and can be retried manually', async () => {
  for (const outcome of ['reject', 'false']) {
    let blocked = true;
    const h = harness({ audioFactory: () => fakeAudio(async () => {
      if (!blocked) return true;
      if (outcome === 'reject') throw new Error('Permission denied');
      return false;
    }) });
    try {
      await connected(h);
      assert.equal(h.snapshot.status, 'connected');
      assert.equal(h.snapshot.listening, false);
      assert.match(h.snapshot.error, /Microphone unavailable/);
      assert.equal(h.session.send('Typed fallback'), true);
      blocked = false;
      await h.session.toggleMic();
      assert.equal(h.snapshot.listening, true);
      assert.equal(h.snapshot.error, '');
    } finally { h.session.disconnect(); }
  }
});

test('successful microphone startup preserves an unrelated send error', async () => {
  const pending = deferred();
  const h = harness({ audioFactory: () => fakeAudio(() => pending.promise) });
  try {
    const socket = await connected(h);
    socket.send = () => { throw new Error('Send failed'); };
    assert.equal(h.session.send('Keep this draft'), false);
    pending.resolve(true);
    await flush();
    assert.equal(h.snapshot.listening, true);
    assert.match(h.snapshot.error, /Message could not be sent/);
  } finally { h.session.disconnect(); }
});

test('a microphone result or failure from an old interview cannot affect a new one', async () => {
  for (const outcome of ['resolve', 'reject']) {
    const pending = deferred(), audios = [];
    const h = harness({ audioFactory: () => {
      const audio = fakeAudio(audios.length === 0 ? () => pending.promise : async () => true);
      audios.push(audio);
      return audio;
    } });
    try {
      await connected(h);
      assert.equal(h.snapshot.listening, true);
      h.session.disconnect();
      await connected(h);
      const stops = audios[1].stops;
      if (outcome === 'resolve') pending.resolve(true);
      else pending.reject(new Error('Old permission failure'));
      await flush();
      assert.equal(h.snapshot.listening, true);
      assert.equal(h.snapshot.error, '');
      assert.equal(audios[1].stops, stops);
      assert.equal(audios[0].closed, true);
    } finally { h.session.disconnect(); }
  }
});

test('pending microphone capture can be stopped and a current failure is reported', async () => {
  const pending = deferred();
  let calls = 0;
  const h = harness({ audioFactory: () => fakeAudio(() => ++calls === 1 ? pending.promise : Promise.reject(new Error('Denied'))) });
  try {
    await connected(h);
    assert.equal(h.snapshot.listening, true);
    await h.session.toggleMic();
    pending.reject(new Error('Old denial'));
    await flush();
    assert.equal(h.snapshot.error, '');
    assert.equal(h.snapshot.listening, false);
    await h.session.toggleMic();
    assert.equal(h.snapshot.listening, false);
    assert.match(h.snapshot.error, /Microphone unavailable/);
  } finally { h.session.disconnect(); }
});

test('disabling pending default capture ignores a late success and its audio', async () => {
  const pending = deferred(); let onAudio;
  const h = harness({ audioFactory: () => fakeAudio(callback => { onAudio = callback; return pending.promise; }) });
  try {
    const socket = await connected(h);
    await h.session.toggleMic();
    const count = socket.sent.length;
    pending.resolve(true);
    await flush();
    onAudio({ data: 'late-audio', mimeType: 'audio/pcm;rate=16000' });
    assert.equal(h.snapshot.listening, false);
    assert.equal(h.snapshot.error, '');
    assert.equal(socket.sent.length, count);
  } finally { h.session.disconnect(); }
});

test('disconnect closes audio even when end-of-stream and socket cleanup throw', async () => {
  const audio = fakeAudio();
  const h = harness({ audioFactory: () => audio });
  const socket = await connected(h);
  socket.send = () => { throw new Error('Send failed'); };
  socket.close = () => { throw new Error('Close failed'); };
  assert.doesNotThrow(() => h.session.disconnect());
  assert.equal(audio.closed, true);
  assert.equal(h.snapshot.status, 'disconnected');
  assert.equal(h.snapshot.listening, false);
});

test('SDK errors disconnect the interviewer and expose retry', async () => {
  const h = harness();
  const socket = await connected(h);
  socket.fail();
  await flush();
  assert.match(h.snapshot.error, /Connection failed/);
  assert.equal(h.snapshot.status, 'disconnected');
  assert.equal(h.snapshot.canRetry, true);
});

test('a transport reporting failure during construction is still closed', async () => {
  let closed = 0;
  const audio = fakeAudio();
  const h = harness({ audioFactory: () => audio, transportFactory: (_config, _problem, events) => {
    events.error('Setup failed');
    return { sendText: () => false, sendAudio() {}, endAudio() {}, close() { closed++; } };
  } });
  await h.session.connect(config);
  assert.equal(h.snapshot.status, 'disconnected');
  assert.equal(h.snapshot.canRetry, true);
  assert.equal(audio.closed, true);
  assert.equal(closed, 1);
});

test('Live buffers SDK callbacks before connection resolution and starts only once', async () => {
  const h = harness();
  try {
    await h.session.connect(config);
    const sdk = h.liveSessions[0];
    sdk.parameters.callbacks.onmessage({ serverContent: { outputTranscription: { text: 'Buffered opening' } } });
    assert.equal(h.snapshot.status, 'connecting'); assert.equal(sdk.sent.length, 0);
    await sdk.receive({ setupComplete: {} });
    await sdk.receive({ setupComplete: {} });
    assert.equal(h.snapshot.status, 'connected');
    assert.equal(h.snapshot.messages[0].text, 'Buffered opening');
    assert.equal(sdk.sent.filter(message => message.clientContent).length, 1);
    assert.deepEqual(plain(sdk.parameters.config.responseModalities), ['AUDIO']);
    assert.deepEqual(plain(sdk.parameters.config.inputAudioTranscription), {});
    assert.deepEqual(plain(sdk.parameters.config.outputAudioTranscription), {});
  } finally { h.session.disconnect(); }
});

test('late Live SDK connection closes after disconnect and cannot affect a restarted interview', async () => {
  const h = harness();
  try {
    await h.session.connect(config);
    const old = h.liveSessions[0];
    h.session.disconnect();
    await h.session.connect(config);
    const current = h.liveSessions[1];
    await old.receive({ setupComplete: {} });
    assert.equal(old.closed, true); assert.equal(old.sent.length, 0);
    assert.equal(h.snapshot.status, 'connecting'); assert.equal(h.snapshot.error, '');
    await current.receive({ setupComplete: {} });
    old.fail();
    await old.receive({ serverContent: { outputTranscription: { text: 'Stale response' } } });
    assert.equal(h.snapshot.status, 'connected'); assert.equal(h.snapshot.messages.length, 0);
    assert.equal(current.sent.length, 1);
  } finally { h.session.disconnect(); }
});

test('rejected Live SDK setup exposes retry and releases audio', async () => {
  const h = harness();
  await h.session.connect(config);
  h.liveSessions[0].pending.reject(new Error('SDK rejected setup'));
  await flush();
  assert.match(h.snapshot.error, /Connection failed/);
  assert.equal(h.snapshot.status, 'disconnected'); assert.equal(h.snapshot.canRetry, true);
  assert.equal(h.contexts[0].closed, true);
});

test('Live forwards audio, end-of-stream, and interruption through SDK methods', async () => {
  let playbackStops = 0;
  const played = [], audio = fakeAudio(async onAudio => {
    onAudio({ data: 'pcm-input', mimeType: 'audio/pcm;rate=16000' });
    return true;
  });
  audio.play = chunk => played.push(plain(chunk));
  audio.stopPlayback = () => playbackStops++;
  const h = harness({ audioFactory: () => audio });
  try {
    const sdk = await connected(h);
    assert.deepEqual(sdk.sent.at(-1), { realtimeInput: { audio: { data: 'pcm-input', mimeType: 'audio/pcm;rate=16000' } } });
    await h.session.toggleMic();
    assert.deepEqual(sdk.sent.at(-1), { realtimeInput: { audioStreamEnd: true } });
    await sdk.receive({ serverContent: { modelTurn: { parts: [
      { inlineData: { data: 'pcm-output', mimeType: 'audio/pcm;rate=24000' } },
      { inlineData: { mimeType: 'audio/pcm' } },
    ] }, interrupted: true } });
    assert.deepEqual(played, [{ data: 'pcm-output', mimeType: 'audio/pcm;rate=24000' }]);
    assert.equal(playbackStops, 1);
  } finally { h.session.disconnect(); }
});

test('Live server error messages fail before setup and redact credentials', async () => {
  const h = harness();
  await h.session.connect(config);
  const sdk = h.liveSessions[0];
  await sdk.receive({ error: { message: 'Rejected live-key' } });
  assert.match(h.snapshot.error, /Rejected \[redacted\]/);
  assert.equal(h.snapshot.canRetry, true); assert.equal(h.snapshot.status, 'disconnected');
  await sdk.receive({ setupComplete: {} });
  assert.equal(sdk.closed, true); assert.equal(sdk.sent.length, 0);
});

test('Live opening send failures release the session without reporting readiness', async () => {
  const h = harness();
  await h.session.connect(config);
  const sdk = h.liveSessions[0];
  sdk.sendClientContent = () => { throw new Error('Could not send opening'); };
  await sdk.receive({ setupComplete: {} });
  assert.equal(h.snapshot.status, 'disconnected'); assert.equal(sdk.closed, true);
  assert.equal(h.snapshot.canRetry, true); assert.equal(h.contexts[0].closed, true);
});


test('startup rejects unknown and wrong-capability models before audio, selection, or transport', async () => {
  for (const change of [
    { live: { ...config.live, model: 'gemini-unknown-live' } },
    { live: { ...config.live, model: config.thinking.model } },
    { thinking: { ...config.thinking, model: 'gemini-unknown-thinking' } },
    { thinking: { ...config.thinking, model: config.live.model } },
    { thinking: { ...config.thinking, provider: 'other' } },
  ]) {
    const h = harness();
    await h.session.connect({ ...config, ...change });
    assert.match(h.snapshot.error, /Unsupported/);
    assert.equal(h.contexts.length, 0);
    assert.equal(h.selections.length, 0);
    assert.equal(h.liveSessions.length, 0);
  }
});
