import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonical, costRuntime, readJson, sha256, units, usd, validateManifest } from './manifest.mjs';
import { attemptDirectory } from './run.mjs';

export async function summarizeControlledCampaign(value) {
  const { manifest, manifestSha256, allocatedUsd, overheadUsd } = validateManifest(value, Date.now(), { admission: false });
  let known = 0n, committed = units(overheadUsd);
  const attempts = [];
  for (const allocation of manifest.attempts) {
    const root = attemptDirectory(manifest, allocation.attemptId);
    let snapshot, report, verified = false;
    try {
      const admission = await readJson(join(root, 'admission.json'));
      const ledgerBytes = await readFile(join(root, 'ledger.jsonl'));
      const ledger = await costRuntime.readEvalCostLedger(join(root, 'ledger.jsonl'));
      const candidateSnapshot = ledger.state.snapshot();
      const started = Date.parse(admission.startedAt);
      const expectedLimits = { campaignId: manifest.campaignId, maxUsd: allocation.maxUsd,
        deadlineAt: new Date(Math.min(Date.parse(manifest.deadlineAt), started + allocation.timeoutMs)).toISOString(),
        maxRequests: allocation.maxRequests, maxConcurrent: allocation.maxConcurrent, maxAttemptsPerExecution: 1 };
      if (admission.schema !== 'paperclip.runner-eval.admission/v1' || admission.manifestSha256 !== manifestSha256
          || admission.campaignId !== manifest.campaignId || canonical(admission.attempt) !== canonical(allocation)
          || canonical(admission.limits) !== canonical(expectedLimits) || canonical(ledger.state.limits) !== canonical(expectedLimits)
          || canonical(candidateSnapshot.admittedAttempts) !== canonical([{ executionId: allocation.executionId, attemptId: allocation.attemptId }])
          || candidateSnapshot.requests.some(request => request.executionId !== allocation.executionId || request.attemptId !== allocation.attemptId || request.phase !== 'agent')) throw new Error('Ledger does not match its allocation');
      snapshot = candidateSnapshot;
      report = await readJson(join(root, 'result.json'));
      const artifactBytes = await readFile(join(root, 'provider-artifact.json'));
      const artifact = JSON.parse(artifactBytes.toString('utf8'));
      const descriptorBytes = await readFile(join(root, 'gateway.json'));
      const descriptor = JSON.parse(descriptorBytes.toString('utf8'));
      if (report.schema !== 'paperclip.runner-eval.control-result/v1' || report.manifestSha256 !== manifestSha256
          || report.campaignId !== manifest.campaignId || report.executionId !== allocation.executionId || report.attemptId !== allocation.attemptId
          || report.requestSha256 !== allocation.requestSha256 || report.ledgerSha256 !== sha256(ledgerBytes)
          || report.providerArtifactSha256 !== sha256(artifactBytes) || canonical(report.accounting) !== canonical(snapshot)
          || report.status !== 'closed' || report.cleanupVerified !== true || report.secretExcluded !== true || report.failure !== null
          || report.startedAt !== admission.startedAt || !Number.isFinite(Date.parse(report.finishedAt)) || Date.parse(report.finishedAt) < started
          || !report.child || report.child.stopped !== null || artifact.snapshot?.status !== 'closed' || artifact.snapshot?.process?.runnerExited !== true
          || descriptor.schema !== 'paperclip.runner-eval.gateway/v1' || descriptor.provider !== (allocation.provider === 'codex' ? 'openai' : 'anthropic')
          || descriptor.model !== allocation.model || descriptor.upstreamRoute !== manifest.route
          || descriptor.campaignId !== manifest.campaignId || descriptor.executionId !== allocation.executionId || descriptor.attemptId !== allocation.attemptId
          || canonical(artifact.requestRouting) !== canonical({ mode: 'controller_gateway', provider: descriptor.provider, declaredUpstreamRoute: manifest.route,
            campaignId: manifest.campaignId, executionId: allocation.executionId, attemptId: allocation.attemptId, descriptorSha256: sha256(descriptorBytes) })
          || artifact.attemptId !== allocation.attemptId || artifact.requestedModel !== allocation.model
          || snapshot.inflight || snapshot.conflictingRequests || snapshot.overBudget
          || snapshot.unknownRequests !== snapshot.boundedUnresolvedRequests) throw new Error('Incomplete controller evidence');
      verified = true;
    } catch {}
    const cost = snapshot ? units(snapshot.knownUsd) : 0n;
    const observedCommitment = snapshot ? units(snapshot.committedUsd) : 0n;
    const commitment = verified ? observedCommitment : observedCommitment > units(allocation.maxUsd) ? observedCommitment : units(allocation.maxUsd);
    known += cost; committed += commitment;
    attempts.push({ executionId: allocation.executionId, attemptId: allocation.attemptId, status: verified ? 'retained' : 'incomplete',
      allocationUsd: allocation.maxUsd, knownUsd: usd(cost), heldUsd: usd(commitment - cost), committedUsd: usd(commitment),
      unknownRequests: snapshot?.unknownRequests ?? null, boundedUnresolvedRequests: snapshot?.boundedUnresolvedRequests ?? null });
  }
  return { schema: 'paperclip.runner-eval.control-campaign/v1', campaignId: manifest.campaignId, manifestSha256,
    limitUsd: manifest.maxUsd, allocatedUsd, operatingHeldUsd: overheadUsd, knownUsd: usd(known), heldUsd: usd(committed - known),
    committedUsd: usd(committed), overBudget: committed > units(manifest.maxUsd), incompleteAttempts: attempts.filter(attempt => attempt.status === 'incomplete').length,
    costStatus: attempts.some(attempt => attempt.status === 'incomplete') || committed > units(manifest.maxUsd) ? 'incomplete' : 'provisional', attempts };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) throw new Error('Usage: report.mjs <controller-manifest.json>');
  const result = await summarizeControlledCampaign(await readJson(process.argv[2]));
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (result.incompleteAttempts || result.overBudget) process.exitCode = 2;
}
