import { createHash } from 'node:crypto';

export const TTL = 900;
export const CLOCK_SKEW_MS = 60000;
export const TOKEN = /^[^\s\x00-\x1f\x7f]{1,8192}(?![\s\S])/;
export const ROOM = /^[A-Z0-9]{12}$(?![\s\S])/;
export const isId = (value) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$(?![\s\S])/.test(value);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, expected) => {
  if (!record(value)) return false;
  const actual = Object.keys(value).sort(), wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
};
const word = (value) => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,39}$(?![\s\S])/.test(value);
const line = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && value.isWellFormed()
  && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value) && value.trim() === value;
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : record(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
export const hash = (value) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

export function iso(raw) {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$(?![\s\S])/.test(raw)) throw new Error('Expected a UTC timestamp.');
  const time = Date.parse(raw);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 19) !== raw.slice(0, 19)) throw new Error('Invalid UTC timestamp.');
  return new Date(time).toISOString();
}



const safeId = value => word(value) && value.length <= 12 && !['constructor', 'prototype', '__proto__', 'unknown'].includes(value);
export const POLICY = Object.freeze({ name: 'exact-change-point-segmentation-v1',
  objective: 'sum of within-segment squared deviations from each segment mean, plus penalty times (segment count minus one)',
  segments: 'nonempty contiguous half-open ranges cover the ordered sequence exactly once',
  arithmetic: 'exact BigInt rational arithmetic; exported fractions are reduced with a positive denominator',
  ties: 'minimum objective, then fewest segments, then lexicographically earliest numeric internal boundary indices',
  selection: 'one owner selects a documented penalty profile; Unknown withholds the result',
  excluded: 'causes, anomaly labels, confidence estimates, statistical significance and future predictions' });
export const POLICY_HASH = hash(POLICY);
const promptFor = input => `${input.title}\n${input.context}\nWhich documented penalty applies to ${input.seriesId}?\n${input.profiles.map(p => `${p.label}: ${p.penalty}; ${p.reference}`).join('\n')}\nPenalty units: ${input.unit} squared, per change. Choose Unknown if unverified. Measurements stay local.`;

export function validateInput(input) {
  if (!keys(input, ['seriesId', 'title', 'context', 'unit', 'measurements', 'profiles']) || !word(input.seriesId)
    || !line(input.title, 40) || !line(input.context, 80) || !line(input.unit, 12)
    || !Array.isArray(input.measurements) || input.measurements.length < 1 || input.measurements.length > 64
    || !Array.isArray(input.profiles) || input.profiles.length < 1 || input.profiles.length > 3) throw new Error('Supply series metadata, a unit, one to 64 integer measurements and one to three documented penalty profiles.');
  const measurements = Array.from(input.measurements, value => {
    if (!Number.isSafeInteger(value) || Math.abs(value) > 1000000) throw new Error('Measurements must be integers from -1000000 to 1000000.');
    return value === 0 ? 0 : value;
  });
  const ids = new Set(), labels = new Set(), penalties = new Set();
  const profiles = Array.from(input.profiles, profile => {
    if (!keys(profile, ['id', 'label', 'reference', 'penalty']) || !safeId(profile.id) || ids.has(profile.id)
      || !line(profile.label, 24) || labels.has(profile.label) || profile.label.toLowerCase() === 'unknown'
      || !line(profile.reference, 40) || !Number.isSafeInteger(profile.penalty) || profile.penalty < 0 || profile.penalty > 1000000000000
      || penalties.has(profile.penalty)) throw new Error('Profiles need unique IDs, labels and integer penalties from 0 to 1000000000000, plus a document reference.');
    ids.add(profile.id); labels.add(profile.label); penalties.add(profile.penalty);
    return { ...profile, penalty: profile.penalty === 0 ? 0 : profile.penalty };
  });
  const result = { seriesId: input.seriesId, title: input.title, context: input.context, unit: input.unit, measurements, profiles };
  if (promptFor(result).length > 500) throw new Error('Penalty-profile Question exceeds 500 UTF-16 units; shorten metadata or profile descriptions.');
  return result;
}
export function validateConfig(config) {
  if (!keys(config, ['participant']) || !keys(config.participant, ['id', 'label']) || !isId(config.participant.id) || !line(config.participant.label, 60)) throw new Error('Config requires an exact series owner UUID and label.');
  return structuredClone(config);
}
export const itemsFor = input => { validateInput(input); return [{ id: 'profile' }]; };
export function requestFor(rawInput, config, itemId, attemptId) {
  const input = validateInput(rawInput); validateConfig(config);
  if (itemId !== 'profile' || !isId(attemptId)) throw new Error('Invalid penalty-profile selection or attempt.');
  const key = `segmentation-${attemptId}`;
  return { prompt: promptFor(input), context: `To ${config.participant.id}`,
    options: [...input.profiles.map(profile => ({ value: profile.id, label: profile.label, style: 'default' })), { value: 'unknown', label: 'Unknown', style: 'default' }],
    responder_scope: 'direct', target_user_id: config.participant.id, ttl: TTL, correlation_id: key,
    data: { input_hash: hash(input), measurements_hash: hash(input.measurements), policy_hash: POLICY_HASH, item_id: itemId, attempt_id: attemptId }, idempotencyKey: key };
}
export function previewInput(rawInput, config) {
  const input = validateInput(rawInput), request = requestFor(input, config, 'profile', '01990000-0000-7000-8000-000000000001');
  const { correlation_id, idempotencyKey, data, ...question } = request;
  return { source: input, sourceHash: hash(input), policy: POLICY, policyHash: POLICY_HASH, question,
    note: 'The attempt UUID, correlation ID and input/measurements/policy hashes are added when the session creates its Question.' };
}

const gcd = (a, b) => { a = a < 0n ? -a : a; while (b !== 0n) [a, b] = [b, a % b]; return a; };
const fraction = (numerator, denominator = 1n) => { const factor = gcd(numerator, denominator); return { n: numerator / factor, d: denominator / factor }; };
const add = (a, b) => fraction(a.n * b.d + b.n * a.d, a.d * b.d);
const compare = (a, b) => { const difference = a.n * b.d - b.n * a.d; return difference < 0n ? -1 : difference > 0n ? 1 : 0; };
const serialize = value => ({ numerator: String(value.n), denominator: String(value.d) });

/** Exact optimal partition of an ordered series; no inference about the meaning of its changes. */
export function solveSegmentation(rawInput, profileId) {
  const input = validateInput(rawInput), profile = input.profiles.find(item => item.id === profileId);
  if (!profile) throw new Error('Select a declared penalty profile before segmenting.');
  const values = input.measurements.map(BigInt), count = values.length, penalty = BigInt(profile.penalty);
  const sums = [0n], squares = [0n];
  for (const value of values) { sums.push(sums.at(-1) + value); squares.push(squares.at(-1) + value * value); }
  const segment = (start, end) => {
    const length = BigInt(end - start), sum = sums[end] - sums[start], square = squares[end] - squares[start];
    return { mean: fraction(sum, length), sse: fraction(square * length - sum * sum, length) };
  };
  const best = [{ objective: fraction(0n), segmentCount: 0, cuts: 0n }];
  for (let end = 1; end <= count; end++) {
    let winner;
    for (let start = 0; start < end; start++) {
      const previous = best[start], cost = segment(start, end).sse;
      const candidate = { objective: add(previous.objective, add(cost, fraction(start === 0 ? 0n : penalty))),
        segmentCount: previous.segmentCount + 1, cuts: previous.cuts | (start === 0 ? 0n : 1n << BigInt(count - start)) };
      const comparison = winner === undefined ? -1 : compare(candidate.objective, winner.objective);
      // Earlier cuts have higher bits. With equal counts, a larger mask is the lexicographically earlier list.
      if (comparison < 0 || comparison === 0 && (candidate.segmentCount < winner.segmentCount
        || candidate.segmentCount === winner.segmentCount && candidate.cuts > winner.cuts)) winner = candidate;
    }
    best.push(winner);
  }
  const optimum = best[count], boundaries = [];
  for (let index = 1; index < count; index++) if (optimum.cuts & (1n << BigInt(count - index))) boundaries.push(index);
  const endpoints = [0, ...boundaries, count]; let total = fraction(0n);
  const segments = endpoints.slice(1).map((end, index) => {
    const start = endpoints[index], { mean, sse } = segment(start, end); total = add(total, sse);
    return { start, end, count: end - start, mean: serialize(mean), sse: serialize(sse) };
  });
  const penaltyCost = fraction(penalty * BigInt(boundaries.length)), objective = add(total, penaltyCost);
  if (compare(objective, optimum.objective) !== 0 || segments.length !== optimum.segmentCount) throw new Error('Segmentation objective did not reconcile.');
  return { profile, unit: input.unit, sampleCount: count, segmentCount: segments.length, changeCount: boundaries.length,
    boundaries, segments, totalSse: serialize(total), penaltyPerChange: profile.penalty, penaltyCost: serialize(penaltyCost), objective: serialize(objective),
    sourceHash: hash(input), policyHash: POLICY_HASH,
    note: 'This is the exact minimum of the declared penalized squared-error objective for the fixed series; changes have no assigned cause or confidence.' };
}
export function segmentationPlan(rawInput, choice) {
  const input = validateInput(rawInput);
  if (choice !== null && choice !== 'unknown' && !input.profiles.some(profile => profile.id === choice)) throw new Error('Supply a declared profile, Unknown or a missing selection.');
  return { status: choice === null ? 'incomplete' : choice === 'unknown' ? 'unknown' : 'complete', analysis: choice === null || choice === 'unknown' ? null : solveSegmentation(input, choice) };
}

export function validateState(state, rawInput) {
  const input = validateInput(rawInput);
  if (!keys(state, ['version', 'inputHash', 'config', 'room', 'credentialHash', 'startedAt', 'attempts']) || state.version !== 1
    || state.inputHash !== hash(input) || typeof state.room !== 'string' || !ROOM.test(state.room)
    || typeof state.credentialHash !== 'string' || !/^[0-9a-f]{64}$(?![\s\S])/.test(state.credentialHash)
    || !Array.isArray(state.attempts) || state.attempts.length > itemsFor(input).length || iso(state.startedAt) !== state.startedAt) throw new Error('Invalid state or changed measurement series. Restore the original input and configuration.');
  validateConfig(state.config);
  const items = itemsFor(input), ids = new Set(), questionIds = new Set(); let previous = state.startedAt, askerId;
  for (const [index, attempt] of state.attempts.entries()) {
    if (!keys(attempt, ['id', 'itemId', 'createdAt', 'request', 'questionId', 'status', 'observation']) || !isId(attempt.id) || ids.has(attempt.id)
      || attempt.itemId !== items[index].id || iso(attempt.createdAt) !== attempt.createdAt || attempt.createdAt < previous
      || hash(attempt.request) !== hash(requestFor(input, state.config, attempt.itemId, attempt.id))
      || !['creating', 'pending', 'answered', 'expired', 'cancelled', 'invalid_answer'].includes(attempt.status)) throw new Error('Invalid saved penalty-profile selection or order.');
    ids.add(attempt.id); previous = attempt.createdAt;
    if (attempt.status === 'creating') {
      if (attempt.questionId !== null || attempt.observation !== null) throw new Error('Invalid uncertain creation state.');
    } else {
      if (!isId(attempt.questionId) || questionIds.has(attempt.questionId)) throw new Error('Invalid or repeated Question ID.');
      questionIds.add(attempt.questionId); validateObservation(attempt.observation, attempt.status, attempt.request);
      if (attempt.observation.checkedAt < attempt.createdAt) throw new Error('Observation predates its saved creation intent.');
      previous = attempt.observation.checkedAt;
      if (Date.parse(attempt.observation.createdAt) < Date.parse(attempt.createdAt) - CLOCK_SKEW_MS) throw new Error('Question predates its saved creation intent.');
      if (askerId !== undefined && attempt.observation.askerId !== askerId) throw new Error('Questions belong to different asking registrations.');
      askerId = attempt.observation.askerId;
    }
    if (['creating', 'pending'].includes(attempt.status) && index !== state.attempts.length - 1) throw new Error('Only the last confirmation may have an active Question.');
  }
  return state;
}




export function report(state, rawInput) {
  const input = validateInput(rawInput); validateState(state, input);
  const attempt = state.attempts[0], answer = attempt?.observation?.answer;
  const answers = [{ itemId: 'profile', status: attempt?.status === 'creating' ? 'create_unknown' : attempt?.status ?? 'unasked',
    choice: answer?.value ?? null, label: answer?.label ?? null, questionId: attempt?.questionId ?? null, attemptId: attempt?.id ?? null,
    responderId: answer?.responderId ?? null, answeredAt: answer?.answeredAt ?? null, askerId: attempt?.observation?.askerId ?? null, observedAt: attempt?.observation?.checkedAt ?? null }];
  const calculation = segmentationPlan(input, answers[0].choice);
  const status = ['create_unknown', 'pending'].includes(answers[0].status) ? answers[0].status : answers[0].status === 'unasked' ? 'ready' : calculation.status;
  return { version: 1, seriesId: input.seriesId, sourceHash: hash(input), source: input, policy: POLICY, policyHash: POLICY_HASH,
    participant: state.config.participant, room: state.room, configHash: hash(state.config), answers, ...calculation, status };
}

function validateObservation(observation, status, request) {
  if (!keys(observation, ['createdAt', 'expiresAt', 'checkedAt', 'askerId', 'resolvedAt', 'answer']) || !isId(observation.askerId)) throw new Error('Invalid saved observation.');
  for (const key of ['createdAt', 'expiresAt', 'checkedAt']) if (iso(observation[key]) !== observation[key]) throw new Error('Invalid saved timestamp.');
  const duration = Date.parse(observation.expiresAt) - Date.parse(observation.createdAt);
  if (duration < TTL * 1000 - 1000 || duration > TTL * 1000 + 1000) throw new Error('Question lifetime differs from the saved request.');
  const latest = Date.parse(observation.checkedAt) + CLOCK_SKEW_MS;
  if (Date.parse(observation.createdAt) > latest) throw new Error('Question creation is implausibly in the future. Check the local clock.');
  if (status === 'pending') {
    if (observation.resolvedAt !== null) throw new Error('Pending Question has a resolution timestamp.');
  } else if (iso(observation.resolvedAt) !== observation.resolvedAt || observation.resolvedAt < observation.createdAt
    || Date.parse(observation.resolvedAt) > latest
    || (status === 'expired' ? observation.resolvedAt < observation.expiresAt : observation.resolvedAt > observation.expiresAt)) throw new Error('Invalid Question resolution time.');
  if (status === 'answered') {
    const answer = observation.answer;
    if (!keys(answer, ['value', 'label', 'responderId', 'answeredAt']) || answer.responderId !== request.target_user_id
      || !request.options.some((option) => option.value === answer.value && option.label === answer.label)
      || iso(answer.answeredAt) !== answer.answeredAt || answer.answeredAt !== observation.resolvedAt
      || answer.answeredAt < observation.createdAt || answer.answeredAt > observation.expiresAt) throw new Error('Invalid saved penalty-profile selection evidence.');
  } else if (observation.answer !== null) throw new Error('Unanswered penalty-profile selections must not contain penalty-profile selection evidence.');
}

export function observeQuestion(q, request, questionId, room, checkedAt) {
  if (!isId(questionId) || q?.id !== questionId || q.kind !== 'question' || (q.is_handoff !== undefined && q.is_handoff !== false)
    || q.asker?.type !== 'agent' || !isId(q.asker?.id) || q.prompt !== request.prompt || q.context !== request.context
    || q.responder_scope !== 'direct' || q.target_user_id !== request.target_user_id || q.resolution_policy !== 'first'
    || (q.results !== undefined && q.results !== null) || q.text_input !== null || q.correlation_id !== request.correlation_id || q.reply_to !== null || hash(q.data) !== hash(request.data)
    || (q.room_code ?? q.room?.code) !== room || q.room_code !== undefined && q.room_code !== room
    || q.room !== undefined && q.room?.code !== room || !['pending', 'answered', 'expired', 'cancelled'].includes(q.state)
    || !Array.isArray(q.options) || q.options.length !== request.options.length
    || Array.from(q.options).some((option, index) => option?.value !== request.options[index].value || option?.label !== request.options[index].label
      || (option?.primary !== undefined && option.primary !== false) || (option?.destructive !== undefined && option.destructive !== false))) throw new Error('Question does not match the saved configuration, room, or reviewer.');
  const observation = { createdAt: iso(q.created_at), expiresAt: iso(q.expires_at), checkedAt: iso(checkedAt), askerId: q.asker.id,
    resolvedAt: q.resolved_at === null ? null : iso(q.resolved_at), answer: null };
  let status = q.state === 'answered' ? 'invalid_answer' : q.state;
  if (q.state !== 'answered' && q.answer !== null) throw new Error('Unresolved Question includes an unexpected answer.');
  if (q.state === 'answered') {
    const answer = q.answer;
    try {
      if (!answer || answer.text !== null || answer.responder?.id !== request.target_user_id
        || !request.options.some((option) => option.value === answer.value && option.label === answer.label)) throw new Error('Invalid answer.');
      observation.answer = { value: answer.value, label: answer.label, responderId: answer.responder.id, answeredAt: iso(answer.answered_at) };
      validateObservation(observation, 'answered', request); status = 'answered';
    } catch { observation.answer = null; }
  }
  validateObservation(observation, status, request);
  return { status, observation };
}

export function assertParticipantRoom(rooms, room, participantId) {
  if (!Array.isArray(rooms) || rooms.length > 1000) throw new Error('Invalid room inventory.');
  const matches = rooms.filter((item) => item?.invite_code === room), selected = matches[0];
  if (matches.length !== 1 || selected.type !== 'standard' || selected.is_public !== false || !Array.isArray(selected.members)
    || selected.members.length > 1000 || !selected.members.some((member) => member?.user_id === participantId)) throw new Error('Use a granted standard private room containing the named participant.');
}
