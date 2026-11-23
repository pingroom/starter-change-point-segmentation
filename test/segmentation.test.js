import test from 'node:test';
import assert from 'node:assert/strict';
import { solveSegmentation, segmentationPlan, validateInput, requestFor, previewInput, hash } from '../src/model.js';
import { CONFIG, id } from '../src/mock.js';

const inputFor = (measurements = [-1, 0, 1], penalty = 1) => ({ seriesId: 'sample', title: 'Sample series', context: 'Use the analysis record.', unit: 'ms', measurements,
  profiles: [{ id: 'chosen', label: 'Chosen', reference: 'Analysis guide', penalty }] });
const solve = (values, penalty) => solveSegmentation(inputFor(values, penalty), 'chosen');
const gcd = (a, b) => b === 0n ? (a < 0n ? -a : a) : gcd(b, a % b);
const rational = (n, d = 1n) => { const g = gcd(n, d); return [n / g, d / g]; };
const sum = ([a, b], [c, d]) => rational(a * d + b * c, b * d);
const cmp = ([a, b], [c, d]) => a * d < b * c ? -1 : a * d > b * c ? 1 : 0;
const encoded = ([n, d]) => ({ numerator: String(n), denominator: String(d) });
const decoded = ({ numerator, denominator }) => [BigInt(numerator), BigInt(denominator)];
function oracle(values, penalty) {
  let winner;
  // Enumerate every set of cuts, then calculate residuals directly rather than using prefix sums or DP.
  for (let mask = 0; mask < 2 ** (values.length - 1); mask++) {
    const cuts = [];
    for (let index = 1; index < values.length; index++) if (mask & (1 << (index - 1))) cuts.push(index);
    const endpoints = [0, ...cuts, values.length], segments = [];
    let total = [0n, 1n];
    for (let index = 1; index < endpoints.length; index++) {
      const start = endpoints[index - 1], end = endpoints[index], items = values.slice(start, end).map(BigInt);
      const count = BigInt(items.length), mean = rational(items.reduce((a, b) => a + b, 0n), count);
      const sse = items.reduce((result, value) => {
        const residual = value * mean[1] - mean[0]; return sum(result, rational(residual * residual, mean[1] * mean[1]));
      }, [0n, 1n]);
      total = sum(total, sse); segments.push({ start, end, count: items.length, mean: encoded(mean), sse: encoded(sse) });
    }
    const cost = sum(total, [BigInt(penalty) * BigInt(cuts.length), 1n]);
    let earlier = false;
    if (winner && cuts.length === winner.cuts.length) for (let i = 0; i < cuts.length; i++) {
      if (cuts[i] !== winner.cuts[i]) { earlier = cuts[i] < winner.cuts[i]; break; }
    }
    const comparison = winner ? cmp(cost, winner.cost) : -1;
    if (comparison < 0 || comparison === 0 && (cuts.length < winner.cuts.length || cuts.length === winner.cuts.length && earlier)) winner = { cuts, cost, total, segments };
  }
  return winner;
}
function confirm(values, penalty) {
  const actual = solve(values, penalty), expected = oracle(values, penalty);
  assert.deepEqual(actual.boundaries, expected.cuts); assert.deepEqual(actual.segments, expected.segments);
  assert.deepEqual(actual.objective, encoded(expected.cost)); assert.deepEqual(actual.totalSse, encoded(expected.total));
  assert.equal(actual.sampleCount, values.length); assert.equal(actual.changeCount, actual.segmentCount - 1);
  assert.equal(actual.segmentCount, actual.segments.length); assert.equal(actual.penaltyPerChange, penalty);
  assert.deepEqual(actual.penaltyCost, encoded([BigInt(penalty) * BigInt(actual.changeCount), 1n]));
  assert.deepEqual(actual.objective, encoded(sum(decoded(actual.totalSse), decoded(actual.penaltyCost))));
}

test('exact signed mean and noninteger SSE are reduced fractions', () => {
  const result = solve([-2, 0, 1], 100);
  assert.deepEqual(result.boundaries, []); assert.deepEqual(result.segments[0], { start: 0, end: 3, count: 3, mean: { numerator: '-1', denominator: '3' }, sse: { numerator: '14', denominator: '3' } });
  assert.deepEqual(result.objective, result.totalSse); assert.deepEqual(result.penaltyCost, { numerator: '0', denominator: '1' });
});
test('clear levels create two internal boundaries with nonempty half-open ranges', () => {
  const result = solve([0, 0, 10, 10, -2, -2], 1);
  assert.deepEqual(result.boundaries, [2, 4]); assert.deepEqual(result.segments.map(x => [x.start, x.end]), [[0, 2], [2, 4], [4, 6]]);
  assert.deepEqual(result.objective, { numerator: '2', denominator: '1' });
});
test('equal objective favors fewer segments and then earliest numeric cuts', () => {
  assert.deepEqual(solve([0, 2], 2).boundaries, []);
  assert.deepEqual(solve([0, 1, 2], 1).boundaries, [1]);
  confirm([0, 1, 2], 1);
});
test('zero penalty selects maximal constant runs and constants stay one segment', () => {
  assert.deepEqual(solve([3, 3, -1, -1, 3], 0).boundaries, [2, 4]);
  for (const penalty of [0, 1, 1000000000000]) assert.deepEqual(solve(Array(64).fill(-7), penalty).boundaries, []);
});
test('one sample incurs no change penalty and keeps the signed extreme', () => {
  const result = solve([-1000000], 1000000000000);
  assert.equal(result.segmentCount, 1); assert.equal(result.changeCount, 0); assert.deepEqual(result.objective, { numerator: '0', denominator: '1' });
  assert.deepEqual(result.segments[0].mean, { numerator: '-1000000', denominator: '1' });
});
test('maximum count and magnitudes stay exact, bounded and immutable', () => {
  const input = inputFor(Array.from({ length: 64 }, (_, i) => i % 2 ? -1000000 : 1000000), 0), original = structuredClone(input);
  const result = solveSegmentation(input, 'chosen'); assert.equal(result.segmentCount, 64); assert.equal(result.objective.numerator, '0');
  assert.equal(result.segments.reduce((count, x) => count + x.count, 0), 64); assert.equal(result.boundaries.at(-1), 63);
  assert.deepEqual(input, original); assert.ok(Buffer.byteLength(JSON.stringify(result)) < 65536);
  confirm([-1000000, 1000000, -999999, 999999], 1000000000000);
});
test('all small signed series and penalties agree with an independent exhaustive partition oracle', () => {
  let cases = 0;
  for (let size = 1; size <= 6; size++) for (let code = 0; code < 3 ** size; code++) {
    let digits = code; const values = Array.from({ length: size }, () => { const value = digits % 3 - 1; digits = Math.floor(digits / 3); return value; });
    for (const penalty of [0, 1, 2, 3, 10]) { confirm(values, penalty); cases++; }
  }
  assert.equal(cases, 5460);
});
test('larger index spaces agree with exhaustive cuts', () => {
  confirm([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0], 2);
  assert.deepEqual(solve([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0], 2).boundaries, []);
});
test('high penalty can intentionally collapse distinct levels', () => {
  assert.deepEqual(solve([0, 1, 2, 9, 10, 11], 1000000000000).boundaries, []);
  confirm([0, 1, 2, 9, 10, 11], 1000000000000);
});
test('order and every profile setting remain source-bound without sorting measurements', () => {
  const input = inputFor([-2, 1, 0], 1), original = structuredClone(input), result = solveSegmentation(input, 'chosen');
  assert.deepEqual(input, original); assert.equal(result.sourceHash, hash(validateInput(input)));
  input.measurements.reverse(); assert.notEqual(solveSegmentation(input, 'chosen').sourceHash, result.sourceHash);
  const changed = inputFor([-2, 1, 0], 2); assert.notEqual(solveSegmentation(changed, 'chosen').sourceHash, result.sourceHash);
});
test('malformed sequences, penalty profiles and metadata are refused', () => {
  for (const mutate of [
    x => { x.measurements = []; }, x => { x.measurements = Array(65).fill(0); }, x => { delete x.measurements[0]; },
    x => { x.measurements[0] = 1000001; }, x => { x.measurements[0] = -1000001; }, x => { x.measurements[0] = 0.5; },
    x => { x.measurements[0] = NaN; }, x => { x.measurements[0] = Infinity; }, x => { x.measurements[0] = '1'; },
    x => { x.profiles = []; }, x => { delete x.profiles[0]; }, x => { x.profiles[0].penalty = -1; },
    x => { x.profiles[0].penalty = 1000000000001; }, x => { x.profiles[0].penalty = 0.1; },
    x => { x.profiles.push({ ...x.profiles[0], id: 'other', label: 'Other' }); },
    x => { x.profiles.push({ ...x.profiles[0], penalty: 2 }); }, x => { x.profiles[0].id = 'unknown'; },
    x => { x.profiles[0].label = 'Unknown'; }, x => { x.profiles[0].reference = '\ud800'; },
    x => { x.title = ' leading'; }, x => { x.context = 'line\nnew'; }, x => { x.unit = ''; },
    x => { x.unit = 'x'.repeat(13); }, x => { x.seriesId += '\n'; }, x => { x.extra = true; }, x => { x.profiles[0].extra = true; },
  ]) { const input = inputFor(); mutate(input); assert.throws(() => validateInput(input)); }
});
test('owner sees numeric penalties, document references and squared units, while raw measurements stay local', () => {
  const input = inputFor([-999123, 0], 12), request = requestFor(input, CONFIG, 'profile', id(1));
  assert.match(request.prompt, /Chosen: 12; Analysis guide/); assert.match(request.prompt, /ms squared, per change/);
  assert.ok(!request.prompt.includes('-999123')); assert.equal(request.data.measurements_hash, hash(input.measurements));
  assert.equal(request.target_user_id, CONFIG.participant.id); assert.equal(request.options.at(-1).value, 'unknown');
  assert.deepEqual(previewInput(input, CONFIG).source, validateInput(input));
  assert.throws(() => requestFor(input, CONFIG, 'other', id(1)));
  const large = inputFor(); large.title = 'a'.repeat(40); large.context = 'b'.repeat(80); large.seriesId = 's'.repeat(40); large.unit = 'u'.repeat(12);
  large.profiles = [1, 2, 3].map(n => ({ id: `p${n}`, label: String(n).repeat(24), reference: 'x'.repeat(40), penalty: 1000000000000 - n }));
  assert.throws(() => validateInput(large), /500/);
});
test('Unknown and missing selections withhold segmentation', () => {
  const input = inputFor(); assert.equal(segmentationPlan(input, null).analysis, null); assert.equal(segmentationPlan(input, 'unknown').status, 'unknown');
  assert.equal(segmentationPlan(input, 'chosen').status, 'complete'); assert.throws(() => segmentationPlan(input, 'other')); assert.throws(() => solveSegmentation(input, 'unknown'));
});
