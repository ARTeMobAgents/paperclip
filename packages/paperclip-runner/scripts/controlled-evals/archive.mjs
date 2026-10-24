import { constants } from 'node:fs';
import { lstat, open, readdir, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { bindRequest, canonical, fields, readJson, requestBindingSha256, sha256, units, usd, validateManifest } from './manifest.mjs';
import { attemptDirectory } from './run.mjs';
import { summarizeControlledCampaign } from './report.mjs';

const MiB = 1_048_576;
const MAX_RAW_BYTES = 64 * MiB;
const MAX_ARCHIVE_BYTES = 96 * MiB;
const FILE_LIMITS = new Map([
  ['admission.json', MiB], ['request.json', 8 * MiB], ['gateway.json', 8192],
  ['ledger.jsonl', 16 * MiB], ['result.json', MiB], ['provider-artifact.json', 16 * MiB],
  ['stdout.log', MiB], ['stderr.log', MiB],
]);
const RECEIPT = /^receipts\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.json$/;
const limitFor = name => FILE_LIMITS.get(name) ?? (RECEIPT.test(name) ? MiB : 0);

function secretValues({ environment = process.env, secrets = [] } = {}) {
  return [...new Set([...secrets, ...Object.entries(environment)
    .filter(([name]) => /(?:API_KEY|TOKEN|SECRET|PASSWORD|ACCESS_KEY_ID)$/.test(name))
    .map(([, value]) => value)].filter(value => typeof value === 'string' && value.length > 0))];
}
function excludeSecrets(bytes, secrets) {
  if (secrets.some(secret => bytes.includes(Buffer.from(secret)))) throw new Error('Controller evidence contains a configured credential');
}
async function readRegularFile(path, maximum) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maximum) throw new Error('Controller evidence is not a bounded regular file');
    const bytes = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length !== stat.size) throw new Error('Controller evidence changed while being read');
    return bytes.subarray(0, length);
  } finally { await handle.close(); }
}
async function realDirectory(path) {
  try {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Controller evidence directory is not a real directory');
    return true;
  } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

export async function packControlledAttempt({ manifest: value, attemptId, ...options }) {
  const { manifest, manifestSha256 } = validateManifest(value, Date.now(), { admission: false });
  const allocation = manifest.attempts.find(attempt => attempt.attemptId === attemptId);
  if (!allocation) throw new Error('Attempt is absent from the controller manifest');
  const secrets = secretValues(options);
  const manifestBytes = Buffer.from(canonical(manifest));
  if (manifestBytes.length > MiB) throw new Error('Controller manifest exceeds its archive limit');
  excludeSecrets(manifestBytes, secrets);
  const root = attemptDirectory(manifest, attemptId), files = {};
  let total = manifestBytes.length;
  if (await realDirectory(root)) {
    const names = [...FILE_LIMITS.keys()];
    if (await realDirectory(join(root, 'receipts'))) {
      for (const name of await readdir(join(root, 'receipts'))) {
        if (RECEIPT.test(`receipts/${name.replace(/\.tmp$/, '')}`) && name.endsWith('.tmp')) continue;
        if (!RECEIPT.test(`receipts/${name}`)) throw new Error('Unexpected controller receipt path');
        names.push(`receipts/${name}`);
      }
    }
    if (names.length > allocation.maxRequests + FILE_LIMITS.size) throw new Error('Too many controller receipts');
    for (const name of names.sort()) {
      let bytes;
      try { bytes = await readRegularFile(join(root, name), limitFor(name)); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      total += bytes.length;
      if (total > MAX_RAW_BYTES) throw new Error('Controller evidence exceeds its archive limit');
      excludeSecrets(bytes, secrets);
      files[name] = { sizeBytes: bytes.length, sha256: sha256(bytes), base64: bytes.toString('base64') };
    }
  }
  return { schema: 'paperclip.runner-eval.control-evidence/v1', manifest, manifestSha256, attemptId, files };
}

export function decodeControlledEvidence(value, options) {
  fields(value, ['schema', 'manifest', 'manifestSha256', 'attemptId', 'files']);
  const { manifest, manifestSha256 } = validateManifest(value.manifest, Date.now(), { admission: false });
  const allocation = manifest.attempts.find(attempt => attempt.attemptId === value.attemptId);
  if (value.schema !== 'paperclip.runner-eval.control-evidence/v1' || value.manifestSha256 !== manifestSha256 || !allocation) throw new Error('Controller archive identity mismatch');
  fields(value.files, Object.keys(value.files ?? {}));
  const entries = Object.entries(value.files);
  if (entries.length > allocation.maxRequests + FILE_LIMITS.size) throw new Error('Too many controller evidence files');
  const secrets = secretValues(options), manifestBytes = Buffer.from(canonical(manifest));
  if (manifestBytes.length > MiB) throw new Error('Controller manifest exceeds its archive limit');
  excludeSecrets(manifestBytes, secrets);
  let total = manifestBytes.length;
  const files = new Map();
  for (const [name, file] of entries) {
    const limit = limitFor(name);
    fields(file, ['sizeBytes', 'sha256', 'base64']);
    if (!limit || !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 0 || file.sizeBytes > limit
        || typeof file.base64 !== 'string' || file.base64.length !== 4 * Math.ceil(file.sizeBytes / 3)
        || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('Invalid controller evidence file');
    total += file.sizeBytes;
    if (total > MAX_RAW_BYTES) throw new Error('Controller evidence exceeds its archive limit');
    const bytes = Buffer.from(file.base64, 'base64');
    if (bytes.length !== file.sizeBytes || bytes.toString('base64') !== file.base64 || sha256(bytes) !== file.sha256) throw new Error('Controller evidence digest mismatch');
    excludeSecrets(bytes, secrets);
    files.set(name, bytes);
  }
  return { manifest, manifestSha256, attemptId: value.attemptId, files };
}

export async function readControlledEvidence(path, options) {
  const value = JSON.parse((await readRegularFile(path, MAX_ARCHIVE_BYTES)).toString('utf8'));
  decodeControlledEvidence(value, options);
  return value;
}

export async function readAttemptControlledEvidence(directory, options) {
  const bundle = await readControlledEvidence(join(directory, 'controller-evidence.json'), options);
  const artifact = JSON.parse((await readRegularFile(join(directory, 'artifact.json'), 16 * MiB)).toString('utf8'));
  const request = JSON.parse((await readRegularFile(join(directory, 'request.json'), 8 * MiB)).toString('utf8'));
  const allocation = bundle.manifest.attempts.find(attempt => attempt.attemptId === bundle.attemptId);
  if (basename(resolve(directory)) !== bundle.attemptId || artifact.attemptId !== bundle.attemptId
      || requestBindingSha256(request) !== allocation.requestSha256
      || artifact.controllerAccounting && artifact.controllerAccounting.manifestSha256 !== bundle.manifestSha256) {
    throw new Error('Immutable attempt does not match its controller archive');
  }
  return bundle;
}

export async function summarizeControlledEvidence(bundles, options) {
  if (!Array.isArray(bundles) || !bundles.length) throw new Error('No controller evidence supplied');
  const groups = new Map();
  for (const bundle of bundles) {
    const decoded = decodeControlledEvidence(bundle, options);
    let group = groups.get(decoded.manifest.campaignId);
    if (group && group.manifestSha256 !== decoded.manifestSha256) throw new Error('Conflicting controller campaign manifests');
    if (!group) {
      group = { ...decoded, filesByAttempt: new Map(), digests: new Map() };
      groups.set(decoded.manifest.campaignId, group);
    }
    const digest = sha256(canonical(bundle));
    if (group.digests.has(decoded.attemptId) && group.digests.get(decoded.attemptId) !== digest) throw new Error('Conflicting controller attempt archives');
    group.digests.set(decoded.attemptId, digest);
    group.filesByAttempt.set(decoded.attemptId, decoded.files);
  }
  const campaigns = [];
  for (const group of [...groups.values()].sort((a, b) => a.manifest.campaignId.localeCompare(b.manifest.campaignId))) {
    campaigns.push(await summarizeControlledCampaign(group.manifest, { filesByAttempt: group.filesByAttempt }));
  }
  const sum = field => usd(campaigns.reduce((total, campaign) => total + units(campaign[field]), 0n));
  return { schema: 'paperclip.runner-eval.control-history/v1', costStatus: campaigns.some(c => c.costStatus === 'incomplete') ? 'incomplete' : 'provisional',
    knownUsd: sum('knownUsd'), heldUsd: sum('heldUsd'), committedUsd: sum('committedUsd'), operatingHeldUsd: sum('operatingHeldUsd'),
    incompleteAttempts: campaigns.reduce((total, c) => total + c.incompleteAttempts, 0), overBudget: campaigns.some(c => c.overBudget), campaigns };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'verify' && args.length === 2) {
    const { manifest } = validateManifest(await readJson(args[0]));
    bindRequest(manifest, await readJson(args[1], 8 * MiB));
  } else if (command === 'pack' && args.length === 3) {
    const bundle = await packControlledAttempt({ manifest: await readJson(args[0]), attemptId: args[1] });
    await writeFile(args[2], JSON.stringify(bundle) + '\n', { flag: 'wx', mode: 0o600 });
  } else if (['report', 'report-attempts'].includes(command) && args.length) {
    const read = command === 'report' ? readControlledEvidence : readAttemptControlledEvidence;
    const result = await summarizeControlledEvidence(await Promise.all(args.map(path => read(path))));
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    if (result.costStatus === 'incomplete') process.exitCode = 2;
  } else throw new Error('Usage: archive.mjs verify <manifest.json> <request.json> | pack <manifest.json> <attempt-id> <output.json> | report <evidence.json>... | report-attempts <attempt-directory>...');
}
