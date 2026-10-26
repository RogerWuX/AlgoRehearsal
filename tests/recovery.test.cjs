const { test } = require('node:test');
const assert = require('node:assert/strict');
const load = require('./helpers/loadTypeScript.cjs');
const { plain, config, sampleProblem, memoryStorage, harness, deferred, flush, assessment } = require('./helpers/fixtures.cjs');
const { INTERVIEW_STORAGE_KEY, createInterviewStateRepository } = load('src/features/interview/storage/interviewStateStorage.ts');
const { PROBLEM_STORAGE_KEY, PROBLEM_BANK_STORAGE_KEY } = load('src/features/interview/storage/problemStorage.ts');
const recoveryConfig = { ...config, saveInterviewState: true };

function interview(storage = memoryStorage(), options = {}) {
  return harness({ ...options, storage, interviewState: createInterviewStateRepository(() => storage) });
}
async function connected(h, settings = recoveryConfig) {
  await h.session.connect(settings);
  const sdk = h.liveSessions.at(-1);
  await sdk.receive({ setupComplete: {} });
  return sdk;
}
async function savedDiscussion(storage = memoryStorage()) {
  const h = interview(storage);
  const sdk = await connected(h);
  h.session.send('I would use a map.');
  h.session.setDiscussion('  Written mindset\r\nUse a map 😀');
  await sdk.receive({ serverContent: { outputTranscription: { text: 'What is the complexity?' }, turnComplete: true },
    sessionResumptionUpdate: { resumable: true, newHandle: 'checkpoint-handle' } });
  h.session.releaseResources();
  return { storage, h };
}

test('restored pending notes expire and matching speech survives recovery, replay, grading, and ordinary messages without a discussion kind', async () => {
  const storage = memoryStorage(), h = interview(storage);
  const notes = '  Sent approach\n😀\n';
  h.session.configureRecovery(true);
  await connected(h);
  h.session.setDiscussion(notes);
  h.session.send(notes, { kind: 'discussion' });
  h.session.setDiscussion('Later notes');
  h.session.releaseResources();
  const restored = interview(storage);
  restored.session.configureRecovery(true);
  try {
    assert.equal(restored.snapshot.messages[0].kind, 'discussion');
    assert.equal(restored.snapshot.messages[0].text, notes.trim());
    assert.equal(restored.snapshot.discussion, 'Later notes');
    await restored.session.resume(recoveryConfig);
    const sdk = restored.liveSessions[0];
    await sdk.receive({ setupComplete: {} });
    const turns = sdk.sent[0].clientContent.turns;
    assert.ok(turns.some(turn => turn.role === 'user' && turn.parts[0].text === `[Discussion notes]\n${notes.trim()}`));
    assert.doesNotMatch(JSON.stringify(turns), /Discussion sent/);
    await sdk.receive({ serverContent: { turnComplete: true } });
    await sdk.receive({ serverContent: { turnComplete: true } });
    await sdk.receive({ serverContent: { inputTranscription: { text: 'Sent ', finished: false } } });
    assert.equal(restored.snapshot.messages.length, 2);
    assert.equal(restored.snapshot.messages[1].text, 'Sent ');
    await sdk.receive({ serverContent: { inputTranscription: { text: 'approach\n😀', finished: true } } });
    assert.equal(restored.snapshot.messages.length, 2);
    assert.equal(restored.snapshot.messages[1].text, notes.trim());
    assert.equal(restored.snapshot.messages[1].kind, undefined);
    await restored.session.endInterview({ code: '', language: 'C++' }, recoveryConfig.thinking);
    const request = restored.judgments.find(call => call[1].kind === 'interview')[1];
    assert.equal(request.messages[0].text, notes.trim());
    assert.equal(request.messages[0].kind, 'discussion');
    assert.equal(request.messages[1].text, notes.trim());
    assert.equal(request.messages[1].kind, undefined);
    assert.equal(request.discussion, 'Later notes');
    const saved = JSON.parse(storage.getItem(INTERVIEW_STORAGE_KEY));
    const repository = createInterviewStateRepository(() => storage);
    assert.equal(repository.read().value.judgment.submission.messages[0].kind, 'discussion');
    assert.equal(repository.read().value.judgment.submission.messages[1].text, notes.trim());
    for (const target of ['messages', 'submission']) {
      for (const malformed of [{ kind: 'unknown' }, { kind: null }, { kind: 'discussion', role: 'model' }]) {
        const invalid = plain(saved);
        const messages = target === 'messages' ? invalid.messages : invalid.judgment.submission.messages;
        Object.assign(messages[0], malformed);
        storage.setItem(INTERVIEW_STORAGE_KEY, JSON.stringify(invalid));
        assert.equal(repository.read().value, null);
      }
    }
    delete saved.messages[0].kind;
    delete saved.judgment.submission.messages[0].kind;
    storage.setItem(INTERVIEW_STORAGE_KEY, JSON.stringify(saved));
    const ordinary = repository.read().value;
    assert.equal(ordinary.version, 1);
    assert.equal(ordinary.messages[0].kind, undefined);
    assert.equal(ordinary.messages[0].text, notes.trim());
    assert.equal(ordinary.judgment.submission.messages[0].kind, undefined);
  } finally { restored.session.disconnect(); }
});

test('speech released by note expiry is saved immediately and restored for grading', async () => {
  const storage = memoryStorage(), h = interview(storage);
  const notes = 'Use a map to find duplicates.';
  try {
    const sdk = await connected(h);
    h.session.send(notes, { kind: 'discussion' });
    await sdk.receive({ serverContent: { inputTranscription: { text: 'Use a map', finished: false } } });
    await sdk.receive({ serverContent: { turnComplete: true } });
    assert.equal(JSON.parse(storage.getItem(INTERVIEW_STORAGE_KEY)).messages.length, 1);
    await sdk.receive({ serverContent: { turnComplete: true }, sessionResumptionUpdate: { resumable: true, newHandle: 'safe-checkpoint' } });
    const saved = JSON.parse(storage.getItem(INTERVIEW_STORAGE_KEY));
    assert.deepEqual(saved.messages.map(({ text, kind }) => ({ text, kind })), [
      { text: notes, kind: 'discussion' }, { text: 'Use a map', kind: undefined },
    ]);
    h.session.releaseResources();
    const restored = interview(storage);
    restored.session.configureRecovery(true);
    try {
      assert.equal(restored.snapshot.messages[1].text, 'Use a map');
      await restored.session.resume(recoveryConfig);
      await restored.liveSessions[0].receive({ setupComplete: {} });
      await restored.session.endInterview({ code: '', language: 'C++' }, recoveryConfig.thinking);
      const request = restored.judgments.find(call => call[1].kind === 'interview')[1];
      assert.equal(request.messages[1].text, 'Use a map');
      assert.equal(request.messages[1].kind, undefined);
    } finally { restored.session.disconnect(); }
  } finally { h.session.disconnect(); }
});

test('restored notes still filter raw and marked echoes arriving one turn late', async () => {
  for (const marked of [false, true]) {
    const storage = memoryStorage(), h = interview(storage);
    const notes = 'Use a map.\nCheck duplicates 😀';
    await connected(h);
    h.session.send(notes, { kind: 'discussion' });
    h.session.releaseResources();
    const restored = interview(storage);
    restored.session.configureRecovery(true);
    try {
      await restored.session.resume(recoveryConfig);
      const sdk = restored.liveSessions[0];
      await sdk.receive({ setupComplete: {} });
      await sdk.receive({ serverContent: { turnComplete: true } });
      const echo = `${marked ? '[Discussion notes]\n' : ''}${notes}`;
      await sdk.receive({ serverContent: { inputTranscription: { text: echo.slice(0, 9), finished: false } } });
      await sdk.receive({ serverContent: { inputTranscription: { text: echo.slice(9), finished: true } } });
      assert.equal(restored.snapshot.messages.length, 1);
      assert.equal(restored.snapshot.messages[0].kind, 'discussion');
      await sdk.receive({ serverContent: { inputTranscription: { text: notes, finished: true } } });
      assert.equal(restored.snapshot.messages[1].text, notes);
      assert.equal(restored.snapshot.messages[1].kind, undefined);
    } finally { restored.session.disconnect(); }
  }
});

test('interview saving defaults off and disabling deletes only the interview snapshot', async () => {
  const storage = memoryStorage(), h = interview(storage);
  try {
    const sdk = await connected(h, config);
    h.session.send('Unsaved discussion');
    h.session.setDiscussion('Unsaved written notes');
    assert.equal(storage.getItem(INTERVIEW_STORAGE_KEY), null);
    assert.equal(sdk.parameters.config.sessionResumption, undefined);
    h.session.configureRecovery(true);
    assert.equal(JSON.parse(storage.getItem(INTERVIEW_STORAGE_KEY)).messages.length, 1);
    assert.equal(JSON.parse(storage.getItem(INTERVIEW_STORAGE_KEY)).discussion, 'Unsaved written notes');
    storage.setItem('interview-practice.editor.text', 'existing code');
    const before = storage.getItem(PROBLEM_BANK_STORAGE_KEY);
    h.session.configureRecovery(false);
    assert.equal(storage.getItem(INTERVIEW_STORAGE_KEY), null);
    assert.equal(storage.getItem('interview-practice.editor.text'), 'existing code');
    assert.equal(storage.getItem(PROBLEM_BANK_STORAGE_KEY), before);
    assert.equal(h.snapshot.messages[0].text, 'Unsaved discussion');
    assert.equal(h.snapshot.discussion, 'Unsaved written notes');
  } finally { h.session.disconnect(); }
});

test('reload restores discussion independently of the question bank and resumes without another opening', async () => {
  const { storage, h: original } = await savedDiscussion();
  assert.equal(storage.getItem(PROBLEM_STORAGE_KEY), null);
  assert.equal(storage.getItem(PROBLEM_BANK_STORAGE_KEY), null);
  assert.equal(JSON.parse(storage.getItem(INTERVIEW_STORAGE_KEY)).lifecycle, 'active');
  const h = interview(storage);
  h.session.configureRecovery(true);
  try {
    assert.deepEqual(plain(h.snapshot.problem), sampleProblem);
    assert.deepEqual(plain(h.snapshot.messages), plain(original.snapshot.messages));
    assert.equal(h.snapshot.discussion, '  Written mindset\r\nUse a map 😀');
    assert.equal(h.snapshot.canResume, true);
    assert.equal(h.snapshot.shouldResume, true);
    assert.equal(h.snapshot.listening, false);
    assert.equal(h.snapshot.storedProblemCount, 0);
    assert.equal(h.liveSessions.length, 0);
    await h.session.resume(recoveryConfig, true);
    const sdk = h.liveSessions[0];
    assert.deepEqual(plain(sdk.parameters.config.sessionResumption), { handle: 'checkpoint-handle' });
    await sdk.receive({ setupComplete: {} });
    assert.equal(sdk.sent.length, 0);
    assert.equal(h.selections.length, 0);
    assert.equal(h.snapshot.messages.length, 2);
    assert.equal(h.snapshot.discussion, original.snapshot.discussion);
    h.session.setDiscussion('Updated notes');
    assert.equal(JSON.parse(storage.getItem(INTERVIEW_STORAGE_KEY)).discussion, 'Updated notes');
    h.session.send('Linear time.');
    await sdk.receive({ serverContent: { outputTranscription: { text: 'And space?' }, turnComplete: true } });
    assert.deepEqual(plain(h.snapshot.messages).map(message => message.id), [1, 2, 3, 4]);
    assert.equal(JSON.parse(storage.getItem(INTERVIEW_STORAGE_KEY)).resumptionHandle, null);
  } finally { h.session.disconnect(); }
});

test('reload with recovery disabled clears the selected problem, discussion, and results but retains saved questions', async () => {
  const storage = memoryStorage(), h = interview(storage);
  await connected(h, { ...recoveryConfig, saveSearchedProblems: true });
  h.session.send('Use a map.');
  h.session.setDiscussion('Written notes');
  await h.session.endInterview({ code: 'solution', language: 'JavaScript' }, recoveryConfig.thinking);
  assert.equal(h.snapshot.judgment.status, 'completed');
  assert.equal(h.snapshot.discussion, 'Written notes');
  const bank = storage.getItem(PROBLEM_BANK_STORAGE_KEY);
  h.session.configureRecovery(false);
  assert.deepEqual(plain(h.snapshot.problem), sampleProblem);
  assert.equal(h.snapshot.judgment.status, 'completed');
  const reloaded = interview(storage);
  reloaded.session.configureRecovery(false);
  assert.equal(reloaded.snapshot.problem, null);
  assert.equal(reloaded.snapshot.messages.length, 0);
  assert.equal(reloaded.snapshot.discussion, '');
  assert.equal(reloaded.snapshot.judgment.status, 'idle');
  assert.equal(reloaded.snapshot.judgment.submission, null);
  assert.equal(reloaded.snapshot.shouldResume, false);
  assert.equal(reloaded.snapshot.canResume, false);
  assert.equal(reloaded.snapshot.storedProblemCount, 1);
  assert.equal(storage.getItem(PROBLEM_BANK_STORAGE_KEY), bank);
  assert.equal(reloaded.liveSessions.length, 0);
});

test('recovery never restores the selected problem from the question bank without a valid interview snapshot', () => {
  for (const raw of [null, '{broken']) {
    const storage = memoryStorage();
    storage.setItem(PROBLEM_STORAGE_KEY, JSON.stringify(sampleProblem));
    if (raw !== null) storage.setItem(INTERVIEW_STORAGE_KEY, raw);
    const h = interview(storage);
    h.session.configureRecovery(true);
    assert.equal(h.snapshot.problem, null);
    assert.equal(h.snapshot.judgment.status, 'idle');
    assert.equal(h.snapshot.messages.length, 0);
    assert.equal(h.snapshot.storedProblemCount, 1);
    assert.equal(h.snapshot.canResume, false);
    assert.equal(h.liveSessions.length, 0);
  }
});

test('resumption checkpoints are replaced, cleared when unsafe, and tied to the original model', async () => {
  const storage = memoryStorage(), h = interview(storage);
  const settings = { ...recoveryConfig, live: { ...config.live, model: 'gemini-3.8-live-extended-thinking', thinkingEffort: 'high' } };
  const sdk = await connected(h, settings);
  await sdk.receive({ sessionResumptionUpdate: { resumable: true, newHandle: 'first' } });
  await sdk.receive({ sessionResumptionUpdate: { resumable: true, newHandle: 'second' } });
  assert.equal(JSON.parse(storage.getItem(INTERVIEW_STORAGE_KEY)).resumptionHandle, 'second');
  await sdk.receive({ sessionResumptionUpdate: { resumable: false } });
  assert.equal(JSON.parse(storage.getItem(INTERVIEW_STORAGE_KEY)).resumptionHandle, null);
  h.session.releaseResources();
  const restored = interview(storage);
  restored.session.configureRecovery(true);
  try {
    await restored.session.resume(recoveryConfig, true);
    const next = restored.liveSessions[0];
    assert.equal(next.parameters.model, settings.live.model);
    assert.deepEqual(plain(next.parameters.config.thinkingConfig), { thinkingLevel: 'HIGH' });
    await next.receive({ setupComplete: {} });
    assert.match(next.sent[0].clientContent.turns.at(-1).parts[0].text, /Continue this interview/);
  } finally { restored.session.disconnect(); }
});

test('an expired handle falls back once with the complete discussion and ignores late callbacks', async () => {
  const { storage } = await savedDiscussion();
  const h = interview(storage);
  h.session.configureRecovery(true);
  try {
    await h.session.resume(recoveryConfig, true);
    const old = h.liveSessions[0];
    old.fail();
    assert.equal(h.liveSessions.length, 2);
    const fresh = h.liveSessions[1];
    assert.deepEqual(plain(fresh.parameters.config.sessionResumption), {});
    await old.receive({ setupComplete: {} });
    await old.receive({ serverContent: { outputTranscription: { text: 'stale' } } });
    assert.equal(h.snapshot.status, 'connecting');
    await fresh.receive({ setupComplete: {} });
    const turns = fresh.sent[0].clientContent.turns;
    assert.deepEqual(turns.slice(1, -1).map(turn => turn.parts[0].text), ['I would use a map.', 'What is the complexity?']);
    assert.equal(h.snapshot.messages.length, 2);
    assert.match(h.snapshot.recoveryNotice, /recreated/);
    fresh.fail();
    assert.equal(h.liveSessions.length, 2);
    assert.equal(h.snapshot.status, 'disconnected');
    assert.equal(h.snapshot.canResume, true);
    assert.equal(h.snapshot.shouldResume, false);
    assert.equal(h.snapshot.messages.length, 2);
  } finally { h.session.disconnect(); }
});

test('explicit disconnect stays paused on reload while cleanup allows Strict Mode recovery', async () => {
  const { storage } = await savedDiscussion();
  const h = interview(storage);
  h.session.configureRecovery(true);
  try {
    await h.session.resume(recoveryConfig, true);
    const pending = h.liveSessions[0];
    h.session.releaseResources();
    assert.equal(h.snapshot.shouldResume, true);
    await h.session.resume(recoveryConfig, true);
    await h.liveSessions[1].receive({ setupComplete: {} });
    await pending.receive({ setupComplete: {} });
    assert.equal(h.snapshot.status, 'connected');
    assert.equal(h.snapshot.messages.length, 2);
    h.session.disconnect();
    const reloaded = interview(storage);
    reloaded.session.configureRecovery(true);
    assert.equal(reloaded.snapshot.shouldResume, false);
    assert.equal(reloaded.snapshot.canResume, true);
    assert.equal(reloaded.snapshot.messages.length, 2);
  } finally { h.session.disconnect(); }
});

test('quit persists an empty idle interview across reload and retains saved questions', async () => {
  const storage = memoryStorage(), h = interview(storage);
  const sdk = await connected(h, { ...recoveryConfig, saveSearchedProblems: true });
  h.session.send('Use a map');
  h.session.setDiscussion('Written notes');
  await sdk.receive({ sessionResumptionUpdate: { resumable: true, newHandle: 'abandoned-handle' } });
  const bank = storage.getItem(PROBLEM_BANK_STORAGE_KEY);
  assert.ok(bank);
  h.session.quit();
  h.session.releaseResources();
  const saved = JSON.parse(storage.getItem(INTERVIEW_STORAGE_KEY));
  assert.equal(saved.lifecycle, 'idle'); assert.equal(saved.problem, null);
  assert.equal(saved.live, null); assert.equal(saved.resumptionHandle, null);
  assert.deepEqual(saved.messages, []); assert.equal(saved.discussion, '');
  assert.equal(saved.judgment.status, 'idle'); assert.equal(saved.judgment.submission, null);
  const restored = interview(storage);
  restored.session.configureRecovery(true);
  assert.equal(restored.snapshot.problem, null); assert.equal(restored.snapshot.messages.length, 0);
  assert.equal(restored.snapshot.discussion, ''); assert.equal(restored.snapshot.judgment.status, 'idle');
  assert.equal(restored.snapshot.canResume, false); assert.equal(restored.snapshot.shouldResume, false);
  assert.equal(restored.snapshot.storedProblemCount, 1); assert.equal(storage.getItem(PROBLEM_BANK_STORAGE_KEY), bank);
  assert.equal(h.judgments.length, 0);
});

test('quit resets the current interview even when saving the reset fails', async () => {
  const storage = memoryStorage(), h = interview(storage);
  await connected(h);
  h.session.send('Approach'); h.session.setDiscussion('Notes');
  storage.setItem = () => { throw new Error('Blocked'); };
  assert.doesNotThrow(() => h.session.quit());
  assert.equal(h.snapshot.problem, null); assert.equal(h.snapshot.messages.length, 0);
  assert.equal(h.snapshot.discussion, ''); assert.equal(h.snapshot.canResume, false);
  assert.equal(h.snapshot.shouldResume, false); assert.equal(h.snapshot.status, 'disconnected');
  assert.equal(h.snapshot.interviewStorageStatus, 'unavailable'); assert.match(h.snapshot.recoveryWarning, /could not be saved/);
  assert.equal(h.judgments.length, 0);
});

test('automatic recovery starts the microphone without waiting for playback activation and drops playback until enabled', async () => {
  const { storage } = await savedDiscussion();
  let activations = 0, played = 0, microphones = 0;
  const h = interview(storage, { audioFactory: () => ({
    resume: async () => { activations++; }, play: () => { played++; }, stopPlayback() {},
    startMicrophone: async () => { microphones++; return true; }, stopMicrophone: () => false, close() {},
  }) });
  h.session.configureRecovery(true);
  try {
    await h.session.resume(recoveryConfig, true);
    const sdk = h.liveSessions[0];
    await sdk.receive({ setupComplete: {} });
    const audio = { serverContent: { modelTurn: { parts: [{ inlineData: { data: 'audio', mimeType: 'audio/pcm' } }] } } };
    await sdk.receive(audio);
    assert.equal(activations, 0);
    assert.equal(played, 0);
    assert.equal(microphones, 1);
    assert.equal(h.snapshot.listening, true);
    assert.equal(h.snapshot.audioNeedsInteraction, true);
    await h.session.enableAudio();
    await sdk.receive(audio);
    assert.equal(activations, 1);
    assert.equal(played, 1);
    assert.equal(h.snapshot.audioNeedsInteraction, false);
    assert.equal(h.snapshot.listening, true);
  } finally { h.session.disconnect(); }
});

test('manual microphone activation does not wait for a pending playback unlock', async () => {
  const { storage } = await savedDiscussion();
  const playback = deferred(); let microphones = 0, activations = 0;
  const h = interview(storage, { audioFactory: () => ({
    resume: () => { activations++; return playback.promise; }, play() {}, stopPlayback() {},
    startMicrophone: async () => { microphones++; return true; }, stopMicrophone: () => true, close() {},
  }) });
  h.session.configureRecovery(true);
  try {
    await h.session.resume(recoveryConfig, true);
    await h.liveSessions[0].receive({ setupComplete: {} });
    assert.equal(microphones, 1);
    await h.session.toggleMic();
    await h.session.toggleMic();
    assert.equal(activations, 1);
    assert.equal(microphones, 2);
    assert.equal(h.snapshot.listening, true);
    assert.equal(h.snapshot.audioNeedsInteraction, true);
    playback.resolve();
    await flush();
    assert.equal(h.snapshot.audioNeedsInteraction, false);
    assert.equal(h.snapshot.listening, true);
  } finally { playback.resolve(); h.session.disconnect(); }
});

test('successful playback activation does not clear a microphone failure', async () => {
  const { storage } = await savedDiscussion();
  const h = interview(storage, { audioFactory: () => ({
    resume: async () => {}, play() {}, stopPlayback() {},
    startMicrophone: async () => { throw new Error('Denied'); }, stopMicrophone: () => false, close() {},
  }) });
  h.session.configureRecovery(true);
  try {
    await h.session.resume(recoveryConfig, true);
    await h.liveSessions[0].receive({ setupComplete: {} });
    assert.equal(h.snapshot.listening, false);
    assert.match(h.snapshot.error, /Microphone unavailable/);
    await h.session.enableAudio();
    assert.equal(h.snapshot.audioNeedsInteraction, false);
    assert.match(h.snapshot.error, /Microphone unavailable/);
    assert.equal(h.session.send('Typed fallback'), true);
  } finally { h.session.disconnect(); }
});

test('successful capture does not clear a playback failure and playback can be retried', async () => {
  const { storage } = await savedDiscussion();
  const microphone = deferred(); let playbackBlocked = true;
  const h = interview(storage, { audioFactory: () => ({
    resume: async () => { if (playbackBlocked) throw new Error('Blocked'); }, play() {}, stopPlayback() {},
    startMicrophone: () => microphone.promise, stopMicrophone: () => true, close() {},
  }) });
  h.session.configureRecovery(true);
  try {
    await h.session.resume(recoveryConfig, true);
    await h.liveSessions[0].receive({ setupComplete: {} });
    await h.session.enableAudio();
    microphone.resolve(true);
    await flush();
    assert.equal(h.snapshot.listening, true);
    assert.equal(h.snapshot.audioNeedsInteraction, true);
    assert.match(h.snapshot.error, /Audio could not be enabled/);
    playbackBlocked = false;
    await h.session.enableAudio();
    assert.equal(h.snapshot.audioNeedsInteraction, false);
    assert.equal(h.snapshot.error, '');
  } finally { microphone.resolve(false); h.session.disconnect(); }
});

test('a fresh interview replaces the restored discussion and selects a new problem', async () => {
  const { storage } = await savedDiscussion();
  const h = interview(storage, { select: async () => ({ ...sampleProblem, title: 'New problem' }) });
  h.session.configureRecovery(true);
  try {
    await h.session.connect(recoveryConfig);
    await h.liveSessions[0].receive({ setupComplete: {} });
    assert.equal(h.selections.length, 1);
    assert.equal(h.snapshot.problem.title, 'New problem');
    assert.equal(h.snapshot.messages.length, 0);
    assert.equal(h.snapshot.discussion, '');
    assert.equal(JSON.parse(storage.getItem(INTERVIEW_STORAGE_KEY)).messages.length, 0);
    assert.equal(JSON.parse(storage.getItem(INTERVIEW_STORAGE_KEY)).discussion, '');
    assert.match(h.liveSessions[0].sent[0].clientContent.turns[0].parts[0].text, /Begin the interview/);
  } finally { h.session.disconnect(); }
});

test('a fresh stored-question start saves an empty selection snapshot while waiting for audio', async () => {
  const { storage } = await savedDiscussion();
  load('src/features/interview/storage/problemStorage.ts').createProblemRepository(() => storage).write(sampleProblem);
  const pending = deferred();
  const h = interview(storage, { audioFactory: () => ({ resume: () => pending.promise, stopMicrophone: () => false, close() {} }) });
  h.session.configureRecovery(true);
  assert.equal(h.snapshot.problem.title, sampleProblem.title);
  const starting = h.session.connect({ ...recoveryConfig, problemSource: 'stored' });
  assert.equal(h.snapshot.status, 'connecting'); assert.equal(h.snapshot.problem, null);
  assert.equal(h.snapshot.recoveryWarning, ''); assert.equal(h.snapshot.interviewStorageStatus, 'saved');
  const saved = JSON.parse(storage.getItem(INTERVIEW_STORAGE_KEY));
  assert.equal(saved.lifecycle, 'selecting'); assert.equal(saved.problem, null);
  assert.equal(saved.discussion, ''); assert.deepEqual(saved.messages, []);
  const restored = interview(storage);
  restored.session.configureRecovery(true);
  assert.equal(restored.snapshot.problem, null); assert.equal(restored.snapshot.canResume, false);
  h.session.quit();
  pending.resolve(); await starting;
  assert.equal(h.liveSessions.length, 0); assert.equal(h.snapshot.problem, null);
});

test('selection interrupted by reload does not resume a previously stored problem', async () => {
  const storage = memoryStorage();
  storage.setItem(PROBLEM_STORAGE_KEY, JSON.stringify(sampleProblem));
  const pending = deferred(), h = interview(storage, { select: () => pending.promise });
  const task = h.session.connect(recoveryConfig);
  await flush();
  assert.equal(h.snapshot.status, 'selecting');
  h.session.releaseResources();
  const reloaded = interview(storage);
  reloaded.session.configureRecovery(true);
  assert.equal(reloaded.snapshot.shouldResume, false);
  assert.equal(reloaded.snapshot.canResume, false);
  assert.equal(reloaded.snapshot.problem, null);
  assert.match(reloaded.snapshot.recoveryNotice, /selection was interrupted/);
  pending.resolve(sampleProblem);
  await task;
  assert.equal(h.liveSessions.length, 0);
});

test('completed results restore without Live and interrupted grading retries only missing feedback', async () => {
  const storage = memoryStorage(), pending = deferred();
  const h = interview(storage, { judge: async (_config, request) => request.kind === 'code' ? assessment('code') : pending.promise });
  await connected(h);
  h.session.setDiscussion('  Captured approach\n😀');
  const ending = h.session.endInterview({ code: 'exact code', language: 'C++' }, recoveryConfig.thinking);
  h.session.setDiscussion('Edited after submission');
  await flush();
  assert.equal(h.snapshot.judgment.code.summary, 'code feedback');
  assert.equal(h.snapshot.judgment.status, 'running');
  // A new instance reads the last saved state as if the app had abruptly closed.
  const restored = interview(storage);
  restored.session.configureRecovery(true);
  assert.equal(restored.snapshot.judgment.status, 'canceled');
  assert.equal(restored.snapshot.shouldResume, false);
  assert.equal(restored.snapshot.canResume, false);
  assert.equal(restored.snapshot.judgment.submission.code, 'exact code');
  assert.equal(restored.snapshot.discussion, 'Edited after submission');
  assert.equal(restored.snapshot.judgment.submission.discussion, '  Captured approach\n😀');
  assert.match(restored.snapshot.judgment.errors.interview, /interrupted/);
  h.session.releaseResources();
  await ending;
  await restored.session.retryJudgment(recoveryConfig.thinking);
  assert.deepEqual(restored.judgments.map(call => call[1].kind), ['interview']);
  assert.equal(restored.judgments[0][1].discussion, '  Captured approach\n😀');
  assert.equal(restored.snapshot.judgment.status, 'completed');
  const final = interview(storage);
  final.session.configureRecovery(true);
  assert.equal(final.snapshot.judgment.status, 'completed');
  assert.equal(final.snapshot.judgment.submission.discussion, '  Captured approach\n😀');
  assert.equal(final.liveSessions.length, 0);
  assert.equal(final.snapshot.shouldResume, false);
});

test('corrupt snapshots, unknown versions, duplicate IDs, and storage failures never prevent interviews', async () => {
  const { storage } = await savedDiscussion();
  const valid = JSON.parse(storage.getItem(INTERVIEW_STORAGE_KEY));
  for (const raw of ['{broken', 'null', JSON.stringify({ ...valid, version: 2 }),
    JSON.stringify({ ...valid, discussion: 42 }),
    JSON.stringify({ ...valid, messages: [valid.messages[0], valid.messages[0]] }),
    JSON.stringify({ ...valid, judgment: { ...valid.judgment, code: {} } })]) {
    storage.setItem(INTERVIEW_STORAGE_KEY, raw);
    const h = interview(storage);
    h.session.configureRecovery(true);
    assert.equal(h.snapshot.shouldResume, false);
    assert.equal(h.snapshot.messages.length, 0);
    assert.match(h.snapshot.recoveryWarning, /could not be restored/);
  }
  const repository = createInterviewStateRepository(() => { throw new Error('Blocked'); });
  assert.equal(repository.read().storageStatus, 'unavailable');
  const h = harness({ interviewState: repository });
  try {
    await connected(h);
    h.session.send('Still works');
    h.session.setDiscussion('Notes still work');
    assert.equal(h.snapshot.status, 'connected');
    assert.equal(h.snapshot.interviewStorageStatus, 'unavailable');
    assert.equal(h.snapshot.messages[0].text, 'Still works');
    assert.equal(h.snapshot.discussion, 'Notes still work');
  } finally { h.session.disconnect(); }
});

test('snapshot writes exclude credential fields even if future configuration includes them', async () => {
  const { storage } = await savedDiscussion();
  const repository = createInterviewStateRepository(() => storage);
  const saved = repository.read().value;
  repository.write({ ...saved, apiKey: 'extra-secret', live: { ...saved.live, credential: config.live.credential, apiKey: config.thinking.apiKey } });
  const raw = storage.getItem(INTERVIEW_STORAGE_KEY);
  assert.doesNotMatch(raw, /extra-secret|live-key|thinking-key|credential|apiKey/);
});

test('snapshots require discussion strings in both interview state and grading submissions', async () => {
  const storage = memoryStorage(), h = interview(storage);
  await connected(h);
  h.session.setDiscussion('Original notes');
  await h.session.endInterview({ code: '', language: 'C++' }, recoveryConfig.thinking);
  const saved = JSON.parse(storage.getItem(INTERVIEW_STORAGE_KEY));
  const repository = createInterviewStateRepository(() => storage);
  assert.equal(repository.read().value.discussion, 'Original notes');
  assert.equal(repository.read().value.judgment.submission.discussion, 'Original notes');
  for (const target of ['interview', 'submission']) {
    for (const value of [undefined, null, 42, {}]) {
      const invalid = plain(saved);
      const entry = target === 'interview' ? invalid : invalid.judgment.submission;
      entry.discussion = value;
      const raw = JSON.stringify(invalid);
      storage.setItem(INTERVIEW_STORAGE_KEY, raw);
      const result = repository.read();
      assert.equal(result.value, null);
      assert.match(result.warning, /could not be restored/);
      assert.equal(storage.getItem(INTERVIEW_STORAGE_KEY), raw);
      const restored = interview(storage);
      restored.session.configureRecovery(true);
      assert.equal(restored.snapshot.problem, null);
      assert.equal(restored.snapshot.discussion, '');
      assert.equal(restored.snapshot.judgment.status, 'idle');
      assert.match(restored.snapshot.recoveryWarning, /could not be restored/);
      restored.session.releaseResources();
    }
  }
});

test('retrying the selected problem preserves discussion without sending it to Live', async () => {
  const h = interview();
  await connected(h);
  h.session.setDiscussion('Private written approach');
  h.session.disconnect();
  try {
    await h.session.retry(recoveryConfig);
    const sdk = h.liveSessions.at(-1);
    await sdk.receive({ setupComplete: {} });
    assert.equal(h.snapshot.discussion, 'Private written approach');
    assert.doesNotMatch(JSON.stringify(sdk.sent), /Private written approach/);
  } finally { h.session.disconnect(); }
});

test('disabling recovery reports failed deletion and still stops saving and restoration', async () => {
  const { storage } = await savedDiscussion();
  const before = storage.getItem(INTERVIEW_STORAGE_KEY);
  const blockedClear = { ...storage, removeItem: () => { throw new Error('Blocked'); } };
  const h = interview(blockedClear);
  h.session.configureRecovery(true);
  h.session.configureRecovery(false);
  assert.equal(h.snapshot.shouldResume, false);
  assert.equal(h.snapshot.canResume, false);
  assert.equal(h.snapshot.interviewStorageStatus, 'unavailable');
  assert.match(h.snapshot.recoveryWarning, /could not be cleared/);
  h.session.disconnect();
  assert.equal(storage.getItem(INTERVIEW_STORAGE_KEY), before);
});
